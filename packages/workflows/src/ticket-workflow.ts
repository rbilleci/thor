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
import {
  applyHumanStatus,
  approveDeferrals,
  completeMerge,
  createTicketRun,
  decideBlueprint,
  decideMerge,
  executionIdSchema,
  finishDeferralMaterialization,
  mergeGateInput,
  nextAction,
  recordBlueprint,
  recordImplementation,
  recordMaterializedDeferral,
  recordRepair,
  recordSynthesis,
  startImplementation,
  startMerge,
  startReview,
  type ExecutionId,
  type Blueprint,
  type TicketRun,
  type TicketStatus,
} from "@thor/domain";
import type { ProjectItemSnapshot } from "@thor/github";

import {
  approvalDecisionEventSchema,
  harnessRoutingSchema,
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
    | "publishRunSummary"
  >
>({
  startToCloseTimeout: "2 minutes",
  retry: {
    initialInterval: "1 second",
    backoffCoefficient: 2,
    maximumInterval: "30 seconds",
    maximumAttempts: 8,
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
  const harnesses = harnessRoutingSchema.parse(input.harnesses);
  const auditTrail: ExecutionAuditRecord[] = [];
  const queryState: { run?: TicketRun } = {};
  let latestProjectSnapshot: ProjectItemSnapshot | undefined;
  const activeExecutionIds = new Set<ExecutionId>();
  const activeScopes = new Set<CancellationScope>();
  let executionSequence = 0;
  const queuedProjectChanges: ProjectChangeEvent[] = [];
  const queuedBlueprintDecisions: ApprovalDecisionEvent[] = [];
  const queuedMergeDecisions: ApprovalDecisionEvent[] = [];
  const queuedCancellations: OperatorEvent[] = [];

  setHandler(ticketStateQuery, () => ({
    ...(queryState.run === undefined ? {} : { run: queryState.run }),
    ...(latestProjectSnapshot === undefined ? {} : { latestProjectSnapshot }),
    auditTrail: [...auditTrail],
    activeExecutionIds: [...activeExecutionIds].sort(),
  }));
  setHandler(projectChangedSignal, (event) => {
    const parsed = projectChangeEventSchema.parse(event);
    queuedProjectChanges.push(parsed);
    latestProjectSnapshot = parsed.snapshot;
    const statusBefore = queryState.run?.status;
    if (parsed.snapshot.status === "blocked" || parsed.snapshot.status === "cancelled") {
      if (queryState.run !== undefined) {
        applyHumanStatus(queryState.run, parsed.snapshot.status, parsed.reason);
      }
      for (const scope of activeScopes) scope.cancel();
    } else if (
      statusBefore !== undefined &&
      (projectStatusConflicts(statusBefore, parsed.snapshot.status) ||
        (queryState.run !== undefined && ticketContextChanged(queryState.run, parsed.snapshot)))
    ) {
      for (const scope of activeScopes) scope.cancel();
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
    queuedCancellations.push(parsed);
    if (queryState.run !== undefined) {
      applyHumanStatus(
        queryState.run,
        "cancelled",
        parsed.reason ?? `cancelled by ${parsed.actor}`,
      );
    }
    for (const scope of activeScopes) scope.cancel();
  });

  latestProjectSnapshot = await githubActivities.loadProjectItem(input.projectItemId);
  const run = createTicketRun(latestProjectSnapshot.ticket);
  queryState.run = run;
  reconcileProjectChange(run, {
    snapshot: latestProjectSnapshot,
    reason: "initial GitHub Project state",
  });
  applyQueuedEvents();
  if (run.status !== "blocked" && run.status !== "cancelled") {
    if (latestProjectSnapshot.status !== "ready") {
      await synchronizeStatus("design_blueprint");
    }
  }

  let mergeCommitSha: string | undefined;
  while (nextAction(run).kind !== "complete") {
    applyQueuedEvents();
    const action = nextAction(run);
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
            harness: harnesses.blueprint,
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
        if (result === undefined) break;
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
        if (run.status === "blocked" || run.status === "cancelled") break;
        startImplementation(run);
        const result = await runAgentActivity("implementation", (executionId) =>
          agentActivities.implement({
            executionId,
            harness: harnesses.implementation,
            ticket: run.ticket,
            blueprint,
            baseBranch: input.baseBranch,
            ...(run.implementation === undefined
              ? {}
              : { priorImplementation: run.implementation }),
            ...(run.lastSynthesis === undefined ? {} : { reviewSynthesis: run.lastSynthesis }),
          }),
        );
        if (result === undefined) break;
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
        if (run.status === "blocked" || run.status === "cancelled") break;
        const reviewRunId = startReview(run);
        const results = await Promise.all(
          action.reviewers.map(async (reviewer) => {
            const result = await runAgentActivity(`review-${reviewer}`, (executionId) =>
              agentActivities.review({
                executionId,
                harness: harnesses.review,
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
        if (results.some((result) => result === undefined)) break;
        const completedReviews = results.filter(
          (result): result is NonNullable<typeof result> => result !== undefined,
        );
        auditTrail.push(...completedReviews.map((result) => result.audit));
        const synthesis = await runAgentActivity("synthesis", (executionId) =>
          agentActivities.synthesize({
            executionId,
            harness: harnesses.synthesis,
            ticket: run.ticket,
            blueprint,
            implementation,
            reviewRunId,
            reviewerResults: completedReviews.map((result) => result.value),
          }),
        );
        if (synthesis === undefined) break;
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
        if (run.status === "blocked" || run.status === "cancelled") break;
        const result = await runAgentActivity(`repair-${run.repairPass + 1}`, (executionId) =>
          agentActivities.repair({
            executionId,
            harness: harnesses.repair,
            ticket: run.ticket,
            blueprint,
            implementation,
            synthesis: repairSynthesis,
            findingIds: action.findingIds,
            repairPass: run.repairPass + 1,
            ...(run.externalReason === undefined ? {} : { humanFeedback: run.externalReason }),
          }),
        );
        if (result === undefined) break;
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
          recordMaterializedDeferral(run, findingId, issue.issueId);
        }
        finishDeferralMaterialization(run);
        await synchronizeStatus(run.status);
        break;
      }
      case "merge": {
        if (run.implementation === undefined) throw new Error("merge requires implementation");
        const mergeInput = { ticket: run.ticket, implementation: run.implementation };
        const readiness = await githubActivities.getMergeReadiness(mergeInput);
        const gate = mergeGateInput(run, readiness.mergeable || readiness.merged);
        if (!readiness.mergeable && !readiness.merged) {
          await sleep("1 minute");
          break;
        }
        startMerge(run, gate);
        await synchronizeStatus("merging");
        mergeCommitSha = await githubActivities.merge(mergeInput);
        completeMerge(run);
        await synchronizeStatus("done");
        break;
      }
      case "wait":
        if (run.status === "blocked") await synchronizeStatus("blocked");
        await condition(
          () =>
            queuedProjectChanges.length > 0 ||
            queuedBlueprintDecisions.length > 0 ||
            queuedMergeDecisions.length > 0 ||
            run.status === "cancelled",
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
      latestProjectSnapshot = change.snapshot;
      reconcileProjectChange(run, change);
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
    if (latestProjectSnapshot === undefined) return;
    if (latestProjectSnapshot.status === targetStatus) return;
    if (
      latestProjectSnapshot.status === "blocked" ||
      latestProjectSnapshot.status === "cancelled"
    ) {
      applyHumanStatus(run, latestProjectSnapshot.status, "authoritative GitHub status");
      return;
    }
    const result = await githubActivities.transitionProjectStatus({
      projectItemId: input.projectItemId,
      expectedStatus: latestProjectSnapshot.status,
      expectedUpdatedAt: latestProjectSnapshot.updatedAt,
      targetStatus,
    });
    latestProjectSnapshot = result.snapshot;
    if (result.kind === "conflict") {
      reconcileProjectChange(run, { snapshot: result.snapshot, reason: result.reason });
      if (run.status !== "blocked" && run.status !== "cancelled") {
        applyHumanStatus(run, "blocked", result.reason);
      }
    }
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
      if (isCancellation(error) && (run.status === "blocked" || run.status === "cancelled")) {
        return undefined;
      }
      throw error;
    } finally {
      activeScopes.delete(scope);
      activeExecutionIds.delete(executionId);
    }
  }
}

function reconcileProjectChange(run: TicketRun, change: ProjectChangeEvent): void {
  if (run.status === "cancelled") return;
  if (ticketContextChanged(run, change.snapshot)) {
    run.ticket = change.snapshot.ticket;
    run.suspendedStatus = "design_blueprint";
    run.status = "blocked";
    run.externalReason =
      change.reason ?? "GitHub ticket or execution policy changed during automated work";
    return;
  }
  const status = change.snapshot.status;
  if (status === "blocked" || status === "cancelled" || run.status === "blocked") {
    applyHumanStatus(run, status, change.reason);
    return;
  }
  if (projectStatusConflicts(run.status, status)) {
    applyHumanStatus(
      run,
      "blocked",
      change.reason ?? `GitHub moved unexpectedly from ${run.status} to ${status}`,
    );
  }
}

function ticketContextChanged(run: TicketRun, snapshot: ProjectItemSnapshot): boolean {
  return JSON.stringify(run.ticket) !== JSON.stringify(snapshot.ticket);
}

function projectStatusConflicts(runStatus: TicketStatus, projectStatus: TicketStatus): boolean {
  if (runStatus === projectStatus) return false;
  if (runStatus === "design_blueprint" && projectStatus === "ready") return false;
  if (
    runStatus === "awaiting_blueprint_approval" &&
    (projectStatus === "ready" || projectStatus === "design_blueprint")
  ) {
    return false;
  }
  if (
    (runStatus === "automated_review_passed" || runStatus === "awaiting_human_merge_review") &&
    (projectStatus === "ready_to_merge" || projectStatus === "repairing")
  ) {
    return false;
  }
  return true;
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
