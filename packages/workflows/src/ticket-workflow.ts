import {
  CancellationScope,
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
  sleep,
  isCancellation,
} from "@temporalio/workflow";
import type {
  AgentProfileSnapshot,
  BoardProjection,
  InterventionPolicy,
  RuntimeDeliveryProfile,
  WorkflowAgentRoles,
} from "@thor/config/schema";
import {
  applyHumanStatus,
  approveDeferrals,
  completeMerge,
  classifyTicketContextChange,
  createTicketRun,
  decideBlueprint,
  decideMerge,
  executionIdSchema,
  finishDeferralMaterialization,
  mergeGateInput,
  nextAction,
  orphanTicket,
  policyAllowsAgent,
  recordBlueprint,
  recordImplementation,
  recordMaterializedDeferral,
  recordRepair,
  recordSynthesis,
  startImplementation,
  startMerge,
  startReview,
  ticketContextsEqual,
  type ExecutionId,
  type Blueprint,
  type TicketRun,
  type TicketContextChangeKind,
  type TicketStatus,
} from "@thor/domain";
import type { ProjectItemSnapshot } from "@thor/github";

import {
  approvalDecisionEventSchema,
  operatorEventSchema,
  projectChangeEventSchema,
  ticketWorkflowInputSchema,
  type ApprovalDecisionEvent,
  type ExecutionAuditRecord,
  type OperatorEvent,
  type ProjectChangeEvent,
  type TicketActivities,
  type TicketWorkflowInput,
  type TicketWorkflowResult,
  type TicketWorkflowState,
} from "./contracts.js";

const githubActivities = proxyActivities<
  Pick<
    TicketActivities,
    | "loadProjectItem"
    | "transitionProjectStatus"
    | "publishBlueprint"
    | "materializeDeferredFinding"
    | "getMergeReadiness"
    | "merge"
    | "closeSourceIssue"
    | "publishRunSummary"
  >
>({
  startToCloseTimeout: "10 minutes",
  retry: {
    initialInterval: "1 second",
    backoffCoefficient: 2,
    maximumInterval: "5 minutes",
    nonRetryableErrorTypes: [
      "github_authentication",
      "github_conflict",
      "github_invalid_response",
      "github_not_found",
    ],
  },
});

const agentActivities = proxyActivities<
  Pick<TicketActivities, "createBlueprint" | "implement" | "review" | "synthesize" | "repair">
>({
  startToCloseTimeout: "4 hours",
  heartbeatTimeout: "2 minutes",
  cancellationType: "WAIT_CANCELLATION_COMPLETED",
  retry: {
    initialInterval: "10 seconds",
    backoffCoefficient: 2,
    maximumInterval: "5 minutes",
    maximumAttempts: 4,
    nonRetryableErrorTypes: [
      "agent_authentication",
      "agent_cancelled",
      "agent_invalid_request",
      "agent_invalid_response",
      "package_invalid",
      "structured_output_invalid",
    ],
  },
});

export const projectChangedSignal = defineSignal<[ProjectChangeEvent]>("projectChanged");
export const blueprintDecisionSignal = defineSignal<[ApprovalDecisionEvent]>("blueprintDecision");
export const mergeDecisionSignal = defineSignal<[ApprovalDecisionEvent]>("mergeDecision");
export const cancelTicketSignal = defineSignal<[OperatorEvent]>("cancelTicket");
export const ticketStateQuery = defineQuery<TicketWorkflowState>("ticketState");

export async function ticketWorkflow(rawInput: TicketWorkflowInput): Promise<TicketWorkflowResult> {
  const input = ticketWorkflowInputSchema.parse(rawInput);
  const delivery = input.delivery;
  const auditTrail: ExecutionAuditRecord[] = [];
  const queryState: { run?: TicketRun } = {};
  let latestProjectSnapshot: ProjectItemSnapshot | undefined;
  let projectItemAvailability: "present" | "unreadable" | "removed" = "present";
  const activeExecutionIds = new Set<ExecutionId>();
  const activeScopes = new Set<CancellationScope>();
  const interventionCancelledScopes = new Set<CancellationScope>();
  let executionSequence = 0;
  const queuedProjectChanges: ProjectChangeEvent[] = [];
  const queuedBlueprintDecisions: ApprovalDecisionEvent[] = [];
  const queuedMergeDecisions: ApprovalDecisionEvent[] = [];
  const queuedCancellations: OperatorEvent[] = [];

  setHandler(ticketStateQuery, () => ({
    ...(queryState.run === undefined ? {} : { run: queryState.run }),
    ...(latestProjectSnapshot === undefined ? {} : { latestProjectSnapshot }),
    projectItemAvailability,
    auditTrail: [...auditTrail],
    activeExecutionIds: [...activeExecutionIds].sort(),
  }));
  setHandler(projectChangedSignal, (event) => {
    const parsed = projectChangeEventSchema.parse(event);
    if (queryState.run !== undefined && runIsTerminal(queryState.run)) return;
    if (parsed.kind !== "present") {
      queuedProjectChanges.push(parsed);
      projectItemAvailability = parsed.kind;
      if (queryState.run !== undefined) {
        applyUnavailableObservation(queryState.run, parsed, delivery.workflow.interventions);
      }
      cancelActiveExecutions();
      return;
    }
    if (
      projectItemAvailability === "present" &&
      latestProjectSnapshot !== undefined &&
      snapshotIsStale(
        parsed.snapshot,
        latestProjectSnapshot,
        queryState.run?.status,
        delivery.workflow.board,
      )
    ) {
      return;
    }
    queuedProjectChanges.push(parsed);
    projectItemAvailability = "present";
    latestProjectSnapshot = parsed.snapshot;
    const statusBefore = queryState.run?.status;
    if (
      parsed.snapshot.status === delivery.workflow.board.controls.blocked ||
      parsed.snapshot.status === delivery.workflow.board.controls.cancelled
    ) {
      if (queryState.run !== undefined) {
        applyBoardControl(
          queryState.run,
          parsed.snapshot.status,
          delivery.workflow.board,
          parsed.reason,
        );
      }
      cancelActiveExecutions();
    } else if (
      statusBefore !== undefined &&
      (projectStatusConflicts(statusBefore, parsed.snapshot.status, delivery.workflow.board) ||
        (queryState.run !== undefined && ticketContextChanged(queryState.run, parsed.snapshot)))
    ) {
      cancelActiveExecutions();
    }
  });
  setHandler(blueprintDecisionSignal, (event) => {
    if (queryState.run?.status === "awaiting_blueprint_approval") {
      queuedBlueprintDecisions.push(approvalDecisionEventSchema.parse(event));
    }
  });
  setHandler(mergeDecisionSignal, (event) => {
    if (
      queryState.run?.status === "automated_review_passed" ||
      queryState.run?.status === "awaiting_human_merge_review"
    ) {
      queuedMergeDecisions.push(approvalDecisionEventSchema.parse(event));
    }
  });
  setHandler(cancelTicketSignal, (event) => {
    const parsed = operatorEventSchema.parse(event);
    if (queryState.run !== undefined && runIsTerminal(queryState.run)) return;
    queuedCancellations.push(parsed);
    if (queryState.run !== undefined) {
      applyHumanStatus(
        queryState.run,
        "cancelled",
        parsed.reason ?? `cancelled by ${parsed.actor}`,
      );
    }
    cancelActiveExecutions();
  });

  latestProjectSnapshot = await githubActivities.loadProjectItem(input.projectItemId);
  projectItemAvailability = "present";
  const run = createTicketRun(latestProjectSnapshot.ticket);
  queryState.run = run;
  reconcileProjectChange(
    run,
    {
      kind: "present",
      snapshot: latestProjectSnapshot,
      reason: "initial GitHub Project state",
    },
    delivery.workflow.board,
    delivery.workflow.interventions,
  );
  applyQueuedEvents();
  if (!executionShouldStop(run)) {
    if (
      !delivery.workflow.board.entrypoints.implementation.includes(latestProjectSnapshot.status)
    ) {
      await synchronizeStatus("design_blueprint");
    }
  }

  let mergeCommitSha: string | undefined;
  while (nextAction(run, delivery.workflow.reviewers).kind !== "complete") {
    applyQueuedEvents();
    const action = nextAction(run, delivery.workflow.reviewers);
    switch (action.kind) {
      case "blueprint": {
        if (run.ticket.policy.planningDepth === "none") {
          const blueprint = ticketPlan(run);
          recordBlueprint(run, blueprint);
          await githubActivities.publishBlueprint({
            ticket: run.ticket,
            workflowId: run.workflowId,
            blueprint,
          });
          await synchronizeStatus(run.status);
          break;
        }
        const result = await runAgentActivity("blueprint", (executionId) =>
          agentActivities.createBlueprint({
            executionId,
            ...agentActivityContext("blueprint"),
            ticket: run.ticket,
            baseBranch: input.baseBranch,
            ...(run.blueprint === undefined ? {} : { priorBlueprint: run.blueprint }),
            ...(run.implementation === undefined
              ? {}
              : { priorImplementation: run.implementation }),
            ...(run.externalReason === undefined ? {} : { humanFeedback: run.externalReason }),
            ...(run.lastSynthesis === undefined ? {} : { reviewSynthesis: run.lastSynthesis }),
          }),
        );
        if (result === undefined || executionShouldStop(run)) break;
        recordBlueprint(run, result.value);
        auditTrail.push(result.audit);
        await githubActivities.publishBlueprint({
          ticket: run.ticket,
          workflowId: run.workflowId,
          blueprint: result.value,
          audit: result.audit,
        });
        await synchronizeStatus(run.status);
        break;
      }
      case "wait_blueprint_approval":
        await synchronizeStatus("awaiting_blueprint_approval");
        await condition(
          () =>
            queuedBlueprintDecisions.length > 0 ||
            queuedProjectChanges.length > 0 ||
            run.status !== "awaiting_blueprint_approval",
        );
        break;
      case "implement": {
        const blueprint = run.blueprint;
        if (blueprint === undefined) throw new Error("implementation requires a blueprint");
        await synchronizeStatus("in_progress");
        if (executionShouldStop(run)) break;
        startImplementation(run);
        const result = await runAgentActivity("implementation", (executionId) =>
          agentActivities.implement({
            executionId,
            ...agentActivityContext("implementation"),
            ticket: run.ticket,
            blueprint,
            baseBranch: input.baseBranch,
            ...(run.implementation === undefined
              ? {}
              : { priorImplementation: run.implementation }),
            ...(run.lastSynthesis === undefined ? {} : { reviewSynthesis: run.lastSynthesis }),
          }),
        );
        if (result === undefined || executionShouldStop(run)) break;
        recordImplementation(run, result.value);
        auditTrail.push(result.audit);
        await synchronizeStatus(run.status);
        break;
      }
      case "review": {
        const blueprint = run.blueprint;
        const implementation = run.implementation;
        if (blueprint === undefined || implementation === undefined) {
          throw new Error("review requires blueprint and implementation results");
        }
        await synchronizeStatus("in_review");
        if (executionShouldStop(run)) break;
        const reviewRunId = startReview(run);
        const results = await Promise.all(
          action.reviewers.map(async (reviewer) => {
            const result = await runAgentActivity(`review-${reviewer}`, (executionId) =>
              agentActivities.review({
                executionId,
                ...agentActivityContext("review"),
                ticket: run.ticket,
                blueprint,
                implementation,
                reviewer,
                reviewRunId,
              }),
            );
            return result;
          }),
        );
        if (results.some((result) => result === undefined) || executionShouldStop(run)) break;
        const completedReviews = results.filter(
          (result): result is NonNullable<typeof result> => result !== undefined,
        );
        auditTrail.push(...completedReviews.map((result) => result.audit));
        const synthesis = await runAgentActivity("synthesis", (executionId) =>
          agentActivities.synthesize({
            executionId,
            ...agentActivityContext("synthesis"),
            ticket: run.ticket,
            blueprint,
            implementation,
            reviewRunId,
            reviewerResults: completedReviews.map((result) => result.value),
          }),
        );
        if (synthesis === undefined || executionShouldStop(run)) break;
        auditTrail.push(synthesis.audit);
        recordSynthesis(run, synthesis.value);
        await synchronizeStatus(run.status);
        break;
      }
      case "repair": {
        const blueprint = run.blueprint;
        const implementation = run.implementation;
        const repairSynthesis = run.lastSynthesis;
        if (
          blueprint === undefined ||
          implementation === undefined ||
          repairSynthesis === undefined
        ) {
          throw new Error("repair requires blueprint, implementation, and synthesis results");
        }
        await synchronizeStatus("repairing");
        if (executionShouldStop(run)) break;
        const result = await runAgentActivity(`repair-${run.repairPass + 1}`, (executionId) =>
          agentActivities.repair({
            executionId,
            ...agentActivityContext("repair"),
            ticket: run.ticket,
            blueprint,
            implementation,
            synthesis: repairSynthesis,
            findingIds: action.findingIds,
            repairPass: run.repairPass + 1,
            ...(run.externalReason === undefined ? {} : { humanFeedback: run.externalReason }),
          }),
        );
        if (result === undefined || executionShouldStop(run)) break;
        auditTrail.push(result.audit);
        recordRepair(run, result.value);
        await synchronizeStatus(run.status);
        break;
      }
      case "wait_merge_approval":
        await synchronizeStatus("awaiting_human_merge_review");
        await condition(
          () =>
            queuedMergeDecisions.length > 0 ||
            queuedProjectChanges.length > 0 ||
            run.status !== "automated_review_passed",
        );
        break;
      case "materialize_deferrals": {
        approveDeferrals(run);
        await synchronizeStatus("materializing_deferrals");
        for (const findingId of run.deferrals
          .filter((deferral) => deferral.state === "defer_approved")
          .map((deferral) => deferral.findingId)) {
          const finding = run.findings.find((candidate) => candidate.findingId === findingId);
          if (finding === undefined) throw new Error(`missing normalized finding ${findingId}`);
          if (run.implementation === undefined || run.lastSynthesis === undefined) {
            throw new Error(
              "deferral materialization requires implementation and review synthesis",
            );
          }
          const issue = await githubActivities.materializeDeferredFinding({
            ticket: run.ticket,
            implementation: run.implementation,
            workflowId: run.workflowId,
            reviewRunId: run.lastSynthesis.reviewRunId,
            finding,
          });
          if (executionShouldStop(run)) break;
          recordMaterializedDeferral(run, findingId, issue.issueId);
        }
        if (run.status === "materializing_deferrals") finishDeferralMaterialization(run);
        await synchronizeStatus(run.status);
        break;
      }
      case "merge": {
        if (run.implementation === undefined) throw new Error("merge requires implementation");
        const mergeInput = {
          ticket: run.ticket,
          implementation: run.implementation,
        };
        const readiness = await githubActivities.getMergeReadiness(mergeInput);
        if (executionShouldStop(run)) break;
        const gate = mergeGateInput(run, readiness.mergeable || readiness.merged);
        if (!readiness.mergeable && !readiness.merged) {
          await sleep("1 minute");
          break;
        }
        startMerge(run, gate);
        await synchronizeStatus("merging");
        if (executionShouldStop(run)) break;
        mergeCommitSha = await githubActivities.merge(mergeInput);
        if (executionShouldStop(run)) break;
        completeMerge(run);
        await synchronizeStatus("done");
        if (delivery.workflow.dependencies.closeIssueAfterMerge) {
          await githubActivities.closeSourceIssue({ ticket: run.ticket });
        }
        break;
      }
      case "wait":
        if (run.status === "blocked") await synchronizeStatus("blocked");
        await condition(
          () =>
            queuedProjectChanges.length > 0 ||
            queuedBlueprintDecisions.length > 0 ||
            queuedMergeDecisions.length > 0 ||
            runIsTerminal(run),
        );
        break;
      case "complete":
        break;
    }
  }

  await githubActivities.publishRunSummary({
    ticket: run.ticket,
    run,
    auditTrail,
    ...(mergeCommitSha === undefined ? {} : { mergeCommitSha }),
  });
  return { run, auditTrail, ...(mergeCommitSha === undefined ? {} : { mergeCommitSha }) };

  function applyQueuedEvents(): void {
    while (queuedCancellations.length > 0) {
      const cancellation = queuedCancellations.shift();
      if (cancellation !== undefined) {
        applyHumanStatus(
          run,
          "cancelled",
          cancellation.reason ?? `cancelled by ${cancellation.actor}`,
        );
      }
    }
    while (queuedProjectChanges.length > 0) {
      const change = queuedProjectChanges.shift();
      if (change === undefined) break;
      if (change.kind === "present") {
        latestProjectSnapshot = change.snapshot;
        projectItemAvailability = "present";
      } else {
        projectItemAvailability = change.kind;
      }
      reconcileProjectChange(run, change, delivery.workflow.board, delivery.workflow.interventions);
    }
    if (run.status !== "awaiting_blueprint_approval") queuedBlueprintDecisions.length = 0;
    if (queuedBlueprintDecisions.length > 0 && run.status === "awaiting_blueprint_approval") {
      const decision = queuedBlueprintDecisions.shift();
      if (decision !== undefined) decideBlueprint(run, decision.decision, decision.reason);
      queuedBlueprintDecisions.length = 0;
    }
    if (run.status !== "automated_review_passed" && run.status !== "awaiting_human_merge_review") {
      queuedMergeDecisions.length = 0;
    }
    if (
      queuedMergeDecisions.length > 0 &&
      (run.status === "automated_review_passed" || run.status === "awaiting_human_merge_review")
    ) {
      const decision = queuedMergeDecisions.shift();
      if (decision !== undefined) decideMerge(run, decision.decision, decision.reason);
      queuedMergeDecisions.length = 0;
    }
  }

  async function synchronizeStatus(targetStatus: TicketStatus): Promise<void> {
    if (
      latestProjectSnapshot === undefined ||
      projectItemAvailability !== "present" ||
      targetStatus === "orphaned"
    ) {
      return;
    }
    const targetBoardState = delivery.workflow.board.states[targetStatus];
    if (latestProjectSnapshot.status === targetBoardState) return;
    if (
      latestProjectSnapshot.status === delivery.workflow.board.controls.blocked ||
      latestProjectSnapshot.status === delivery.workflow.board.controls.cancelled
    ) {
      applyBoardControl(
        run,
        latestProjectSnapshot.status,
        delivery.workflow.board,
        "authoritative GitHub status",
      );
      return;
    }
    const result = await githubActivities.transitionProjectStatus({
      projectItemId: input.projectItemId,
      expectedStatus: latestProjectSnapshot.status,
      expectedUpdatedAt: latestProjectSnapshot.updatedAt,
      expectedTicket: latestProjectSnapshot.ticket,
      targetStatus: targetBoardState,
    });
    latestProjectSnapshot = result.snapshot;
    if (result.kind === "conflict") {
      if (
        result.snapshot.status === targetBoardState &&
        !ticketContextChanged(run, result.snapshot)
      ) {
        return;
      }
      reconcileProjectChange(
        run,
        { kind: "present", snapshot: result.snapshot, reason: result.reason },
        delivery.workflow.board,
        delivery.workflow.interventions,
      );
      if (!executionShouldStop(run)) {
        applyHumanStatus(run, "blocked", result.reason);
      }
    } else if (result.snapshot.status !== targetBoardState) {
      reconcileProjectChange(
        run,
        {
          kind: "present",
          snapshot: result.snapshot,
          reason: `GitHub changed while Thor was transitioning to ${targetBoardState}`,
        },
        delivery.workflow.board,
        delivery.workflow.interventions,
      );
    }
  }

  function agentActivityContext(phase: keyof WorkflowAgentRoles): {
    agent: AgentProfileSnapshot;
    skillSelectors: RuntimeDeliveryProfile["skillSelectors"];
    declarationDigest: string;
    workflowProfile: string;
  } {
    const agentId = delivery.workflow.agents[phase];
    const agent = delivery.agents[agentId];
    if (agent === undefined) {
      throw new Error(`Workflow phase ${phase} references missing agent profile ${agentId}`);
    }
    return {
      agent,
      skillSelectors: delivery.skillSelectors,
      declarationDigest: delivery.declarationDigest,
      workflowProfile: `${delivery.workflow.id}@${delivery.workflow.version}`,
    };
  }

  async function runAgentActivity<Value>(
    phase: string,
    execute: (executionId: ExecutionId) => Promise<{ value: Value; audit: ExecutionAuditRecord }>,
  ): Promise<{ value: Value; audit: ExecutionAuditRecord } | undefined> {
    executionSequence += 1;
    const executionId = executionIdSchema.parse(
      `${run.workflowId}:${executionSequence.toString().padStart(4, "0")}:${phase}`,
    );
    activeExecutionIds.add(executionId);
    const scope = new CancellationScope();
    activeScopes.add(scope);
    try {
      return await scope.run(() => execute(executionId));
    } catch (error) {
      applyQueuedEvents();
      if (isCancellation(error) && interventionCancelledScopes.has(scope)) {
        return undefined;
      }
      throw error;
    } finally {
      interventionCancelledScopes.delete(scope);
      activeScopes.delete(scope);
      activeExecutionIds.delete(executionId);
    }
  }

  function cancelActiveExecutions(): void {
    for (const scope of activeScopes) {
      interventionCancelledScopes.add(scope);
      scope.cancel();
    }
  }
}

function reconcileProjectChange(
  run: TicketRun,
  change: ProjectChangeEvent,
  board: BoardProjection,
  interventions: InterventionPolicy,
): void {
  if (runIsTerminal(run)) return;
  if (change.kind !== "present") {
    applyUnavailableObservation(run, change, interventions);
    return;
  }
  const contextChange = classifyTicketContextChange(run.ticket, change.snapshot.ticket);
  if (contextChange !== "none") {
    applyTicketContextChange(run, change, contextChange, interventions);
    return;
  }
  if (!run.ticket.dependencies.every((dependency) => dependency.complete)) {
    applyHumanStatus(
      run,
      "blocked",
      change.reason ?? "one or more blocking GitHub issue dependencies are incomplete",
    );
    return;
  }
  if (!policyAllowsAgent(run.ticket.policy)) {
    applyHumanStatus(
      run,
      "blocked",
      change.reason ?? "GitHub ticket policy no longer permits agent execution",
    );
    return;
  }
  const status = change.snapshot.status;
  if (run.status === "awaiting_blueprint_approval") {
    if (status === board.approvals.blueprint.approved) {
      decideBlueprint(run, "approved", change.reason);
      return;
    }
    if (status === board.approvals.blueprint.changesRequested) {
      decideBlueprint(run, "changes_requested", change.reason);
      return;
    }
  }
  if (run.status === "automated_review_passed" || run.status === "awaiting_human_merge_review") {
    if (status === board.approvals.merge.approved) {
      decideMerge(run, "approved", change.reason);
      return;
    }
    if (status === board.approvals.merge.changesRequested) {
      decideMerge(run, "changes_requested", change.reason);
      return;
    }
  }
  if (status === board.controls.blocked || status === board.controls.cancelled) {
    applyBoardControl(run, status, board, change.reason);
    return;
  }
  if (run.status === "blocked") {
    const suspended = run.suspendedStatus ?? "design_blueprint";
    if (suspended !== "orphaned" && status === board.states[suspended]) {
      applyHumanStatus(run, suspended, change.reason);
    }
    return;
  }
  if (projectStatusConflicts(run.status, status, board)) {
    const projectedRunStatus =
      run.status === "orphaned" ? "internal Orphaned" : board.states[run.status];
    const reason =
      change.reason ??
      `GitHub moved unexpectedly from ${projectedRunStatus} to ${status} while Thor was ${run.status}`;
    if (interventions.unexpectedStatuses === "cancel") {
      applyHumanStatus(run, "cancelled", reason);
    } else {
      applyHumanStatus(run, "blocked", reason);
    }
  }
}

function ticketContextChanged(run: TicketRun, snapshot: ProjectItemSnapshot): boolean {
  return !ticketContextsEqual(run.ticket, snapshot.ticket);
}

function applyTicketContextChange(
  run: TicketRun,
  change: Extract<ProjectChangeEvent, { kind: "present" }>,
  changeKind: Exclude<TicketContextChangeKind, "none">,
  interventions: InterventionPolicy,
): void {
  const reason =
    change.reason ??
    (changeKind === "dependencies"
      ? "GitHub blocking dependencies changed during automated work"
      : "GitHub ticket intent or execution policy changed during automated work");
  if (changeKind === "identity") {
    applyHumanStatus(run, "cancelled", `GitHub ticket identity changed: ${reason}`);
    return;
  }
  const action =
    changeKind === "dependencies" ? interventions.dependencyChanges : interventions.ticketChanges;
  run.ticket = change.snapshot.ticket;
  if (action === "cancel") {
    applyHumanStatus(run, "cancelled", reason);
    return;
  }
  if (action === "replan") {
    run.suspendedStatus = "design_blueprint";
  } else if (run.status !== "blocked") {
    run.suspendedStatus = run.status;
  }
  run.status = "blocked";
  run.externalReason = reason;
}

function applyUnavailableObservation(
  run: TicketRun,
  change: Extract<ProjectChangeEvent, { kind: "removed" | "unreadable" }>,
  interventions: InterventionPolicy,
): void {
  if (runIsTerminal(run)) return;
  const reason =
    change.reason ??
    (change.kind === "removed"
      ? "GitHub Project item was removed"
      : "GitHub Project item could not be read reliably");
  if (change.kind === "removed") {
    if (interventions.removedItems === "orphan") orphanTicket(run, reason);
    else applyHumanStatus(run, "cancelled", reason);
    return;
  }
  if (interventions.unreadableItems.action === "cancel") {
    applyHumanStatus(run, "cancelled", reason);
  } else {
    applyHumanStatus(run, "blocked", reason);
  }
}

function snapshotIsStale(
  incoming: ProjectItemSnapshot,
  current: ProjectItemSnapshot,
  runStatus: TicketStatus | undefined,
  board: BoardProjection,
): boolean {
  if (incoming.updatedAt === current.updatedAt) {
    if (!ticketContextsEqual(incoming.ticket, current.ticket)) return false;
    if (incoming.status === current.status) return true;
    if (
      incoming.status === board.controls.blocked ||
      incoming.status === board.controls.cancelled
    ) {
      return false;
    }
    if (
      runStatus === "awaiting_blueprint_approval" &&
      (incoming.status === board.approvals.blueprint.approved ||
        incoming.status === board.approvals.blueprint.changesRequested)
    ) {
      return false;
    }
    if (
      (runStatus === "automated_review_passed" || runStatus === "awaiting_human_merge_review") &&
      (incoming.status === board.approvals.merge.approved ||
        incoming.status === board.approvals.merge.changesRequested)
    ) {
      return false;
    }
    return true;
  }
  const incomingTime = Date.parse(incoming.updatedAt);
  const currentTime = Date.parse(current.updatedAt);
  return (
    Number.isFinite(incomingTime) && Number.isFinite(currentTime) && incomingTime < currentTime
  );
}

function projectStatusConflicts(
  runStatus: TicketStatus,
  projectStatus: string,
  board: BoardProjection,
): boolean {
  if (runStatus === "orphaned") return false;
  if (board.states[runStatus] === projectStatus) return false;
  if (
    runStatus === "design_blueprint" &&
    board.entrypoints.implementation.includes(projectStatus)
  ) {
    return false;
  }
  if (
    runStatus === "awaiting_blueprint_approval" &&
    (projectStatus === board.approvals.blueprint.approved ||
      projectStatus === board.approvals.blueprint.changesRequested)
  ) {
    return false;
  }
  if (
    (runStatus === "automated_review_passed" || runStatus === "awaiting_human_merge_review") &&
    (projectStatus === board.states.awaiting_human_merge_review ||
      projectStatus === board.approvals.merge.approved ||
      projectStatus === board.approvals.merge.changesRequested)
  ) {
    return false;
  }
  if (runStatus === "blocked" && projectStatus !== board.controls.cancelled) return false;
  return true;
}

function runIsTerminal(run: TicketRun): boolean {
  return run.status === "done" || run.status === "cancelled" || run.status === "orphaned";
}

function executionShouldStop(run: TicketRun): boolean {
  return run.status === "blocked" || runIsTerminal(run);
}

function applyBoardControl(
  run: TicketRun,
  boardState: string,
  board: BoardProjection,
  reason?: string,
): void {
  if (boardState === board.controls.cancelled) {
    applyHumanStatus(run, "cancelled", reason);
  } else if (boardState === board.controls.blocked) {
    applyHumanStatus(run, "blocked", reason);
  } else {
    applyHumanStatus(run, "design_blueprint", reason);
  }
}

function ticketPlan(run: TicketRun): Blueprint {
  const affectedAreas = run.ticket.component === undefined ? [] : [run.ticket.component];
  return {
    objective: run.ticket.title,
    constraints: ["Planning depth is None; keep the implementation narrowly scoped to the ticket."],
    architecture: "No dedicated architecture analysis is required by ticket policy.",
    proposedDesign: run.ticket.body.trim().length === 0 ? run.ticket.title : run.ticket.body,
    affectedAreas,
    implementationPlan: ["Implement the ticket acceptance criteria with the smallest safe change."],
    testingPlan: run.ticket.acceptanceCriteria.map(
      (criterion) => `Verify acceptance criterion: ${criterion}`,
    ),
    rolloutPlan: [],
    risks: [],
    unresolvedBlockingQuestions: [],
    acceptanceCriteria: [...run.ticket.acceptanceCriteria],
  };
}
