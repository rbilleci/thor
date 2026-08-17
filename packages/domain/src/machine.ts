import { z } from "zod";

import { reviewRunIdFor, workflowIdFor } from "./ids.js";
import type { DeferredIssueId, FindingId, ReviewRunId, WorkflowId } from "./ids.js";
import {
  approvalRequiresBlueprint,
  approvalRequiresMerge,
  blueprintIsComplete,
  mergeAllowed,
  policyAllowsAgent,
  reviewerKinds,
} from "./model.js";
import type {
  ApprovalState,
  Blueprint,
  DeferredFinding,
  ImplementationResult,
  MergeGateInput,
  NormalizedFinding,
  RepairResult,
  ReviewerKind,
  ReviewSynthesis,
  TicketContext,
  TicketStatus,
} from "./model.js";

export type TicketRun = {
  ticket: TicketContext;
  workflowId: WorkflowId;
  status: TicketStatus;
  blueprint?: Blueprint;
  blueprintApproval: ApprovalState;
  mergeApproval: ApprovalState;
  implementation?: ImplementationResult;
  reviewPass: number;
  repairPass: number;
  findings: NormalizedFinding[];
  lastSynthesis?: ReviewSynthesis;
  deferrals: DeferredFinding[];
  blockingHistory: number[];
  reviewersPassed: boolean;
  testsPassed: boolean;
  externalReason?: string;
  suspendedStatus?: TicketStatus;
};

export type NextAction =
  | { kind: "blueprint" }
  | { kind: "wait_blueprint_approval" }
  | { kind: "implement" }
  | { kind: "review"; reviewers: ReviewerKind[] }
  | { kind: "repair"; findingIds: FindingId[] }
  | { kind: "wait_merge_approval" }
  | { kind: "materialize_deferrals"; findingIds: FindingId[] }
  | { kind: "merge" }
  | { kind: "wait" }
  | { kind: "complete" };

export class TransitionError extends Error {
  public constructor(
    message: string,
    public readonly code:
      | "invalid_state"
      | "incomplete_blueprint"
      | "agent_disallowed"
      | "dependency_blocked"
      | "merge_gate_rejected"
      | "deferral_not_approved",
  ) {
    super(message);
    this.name = "TransitionError";
  }
}

export function createTicketRun(ticket: TicketContext): TicketRun {
  const blueprintReview = approvalRequiresBlueprint(ticket.policy.approvalPolicy);
  const mergeReview = approvalRequiresMerge(ticket.policy.approvalPolicy);
  return {
    ticket,
    workflowId: workflowIdFor(ticket.projectItemId),
    status: "design_blueprint",
    blueprintApproval: blueprintReview ? "pending" : "not_required",
    mergeApproval: mergeReview ? "pending" : "not_required",
    reviewPass: 0,
    repairPass: 0,
    findings: [],
    deferrals: [],
    blockingHistory: [],
    reviewersPassed: false,
    testsPassed: false,
  };
}

export function nextAction(
  run: TicketRun,
  configuredReviewers: readonly ReviewerKind[] = reviewerKinds,
): NextAction {
  switch (run.status) {
    case "design_blueprint":
      return { kind: "blueprint" };
    case "awaiting_blueprint_approval":
      return { kind: "wait_blueprint_approval" };
    case "ready":
    case "in_progress":
      return { kind: "implement" };
    case "ready_for_review":
    case "in_review":
      return { kind: "review", reviewers: [...configuredReviewers] };
    case "repairing":
      return {
        kind: "repair",
        findingIds: run.findings.filter(requiresRepair).map((finding) => finding.findingId),
      };
    case "re_review":
      return { kind: "review", reviewers: impactReviewers(run, configuredReviewers) };
    case "automated_review_passed":
      if (mergeApprovalRequired(run) && run.mergeApproval !== "approved") {
        return { kind: "wait_merge_approval" };
      }
      return { kind: "materialize_deferrals", findingIds: approvedDeferrals(run) };
    case "materializing_deferrals":
      return { kind: "materialize_deferrals", findingIds: approvedDeferrals(run) };
    case "ready_to_merge":
    case "merging":
      return { kind: "merge" };
    case "backlog":
    case "discovery":
    case "awaiting_human_merge_review":
    case "blocked":
      return { kind: "wait" };
    case "done":
    case "cancelled":
    case "orphaned":
      return { kind: "complete" };
  }
}

export function recordBlueprint(run: TicketRun, blueprint: Blueprint): void {
  requireStatus(run, "recordBlueprint", ["design_blueprint"]);
  if (!blueprintIsComplete(blueprint)) {
    throw new TransitionError("blueprint does not satisfy the Ready gate", "incomplete_blueprint");
  }
  if (!policyAllowsAgent(run.ticket.policy)) {
    throw new TransitionError("ticket policy does not allow agent execution", "agent_disallowed");
  }
  if (!run.ticket.dependencies.every((dependency) => dependency.complete)) {
    throw new TransitionError("blocking dependencies are incomplete", "dependency_blocked");
  }
  run.blueprint = blueprint;
  delete run.externalReason;
  run.status = approvalRequiresBlueprint(run.ticket.policy.approvalPolicy)
    ? "awaiting_blueprint_approval"
    : "ready";
}

export function decideBlueprint(run: TicketRun, decision: ApprovalState, reason?: string): void {
  requireStatus(run, "decideBlueprint", ["awaiting_blueprint_approval"]);
  run.blueprintApproval = decision;
  if (decision === "approved") {
    delete run.externalReason;
    run.status = "ready";
  } else if (decision === "changes_requested") {
    if (reason === undefined) delete run.externalReason;
    else run.externalReason = reason;
    run.status = "design_blueprint";
  }
}

export function startImplementation(run: TicketRun): void {
  requireStatus(run, "startImplementation", ["ready", "in_progress"]);
  run.status = "in_progress";
}

export function recordImplementation(run: TicketRun, result: ImplementationResult): void {
  requireStatus(run, "recordImplementation", ["in_progress"]);
  const prior = run.implementation;
  run.implementation =
    prior === undefined
      ? result
      : {
          ...result,
          changedFiles: [...new Set([...prior.changedFiles, ...result.changedFiles])].sort(),
          riskFlags: [...new Set([...prior.riskFlags, ...result.riskFlags])].sort(),
        };
  run.testsPassed = result.testsPassed;
  if (run.implementation.riskFlags.length > 0) run.mergeApproval = "pending";
  run.status = "ready_for_review";
}

export function startReview(run: TicketRun): ReviewRunId {
  requireStatus(run, "startReview", ["ready_for_review", "re_review"]);
  run.reviewPass += 1;
  run.status = "in_review";
  return reviewRunIdFor(run.ticket.projectItemId, run.reviewPass);
}

export function recordSynthesis(run: TicketRun, synthesis: ReviewSynthesis): void {
  requireStatus(run, "recordSynthesis", ["in_review"]);
  if (
    synthesis.findings.some(
      (finding) =>
        finding.disposition === "defer_candidate" &&
        (finding.severity === "high" || finding.severity === "critical"),
    )
  ) {
    throw new TransitionError(
      "high-severity findings cannot be accepted as deferred work",
      "deferral_not_approved",
    );
  }
  const blockingCount = synthesis.findings.filter(requiresRepair).length;
  run.blockingHistory.push(blockingCount);
  run.reviewersPassed = blockingCount === 0;
  run.findings = synthesis.findings;
  run.lastSynthesis = synthesis;
  run.deferrals = synthesis.findings.map((finding) => ({
    findingId: finding.findingId,
    state:
      finding.disposition === "defer_candidate"
        ? "defer_proposed"
        : finding.disposition === "rejected"
          ? "rejected"
          : "fix_now",
  }));

  if (blockingCount === 0) run.status = "automated_review_passed";
  else if (synthesis.failureScope === "implementation") run.status = "in_progress";
  else if (synthesis.failureScope === "blueprint") run.status = "design_blueprint";
  else if (canRepairAgain(run)) run.status = "repairing";
  else run.status = "awaiting_human_merge_review";
}

export function recordRepair(run: TicketRun, repair: RepairResult): void {
  requireStatus(run, "recordRepair", ["repairing"]);
  run.repairPass += 1;
  run.testsPassed = repair.testsPassed;
  if (run.implementation !== undefined) {
    run.implementation = {
      ...run.implementation,
      commitSha: repair.commitSha,
      changedFiles: [
        ...new Set([...run.implementation.changedFiles, ...repair.changedFiles]),
      ].sort(),
      testsPassed: repair.testsPassed,
    };
  }
  const repaired = new Set(repair.repairedFindings);
  run.deferrals = run.deferrals.map((deferral) =>
    repaired.has(deferral.findingId) ? { ...deferral, state: "repaired" } : deferral,
  );
  delete run.externalReason;
  run.status = "re_review";
}

export function decideMerge(run: TicketRun, decision: ApprovalState, reason?: string): void {
  requireStatus(run, "decideMerge", ["automated_review_passed", "awaiting_human_merge_review"]);
  if (
    decision === "approved" &&
    (!run.testsPassed || run.findings.some((finding) => requiresRepair(finding)))
  ) {
    run.mergeApproval = "pending";
    run.externalReason = "merge approval cannot override failed tests or unresolved repair work";
    run.status = "awaiting_human_merge_review";
    return;
  }
  run.mergeApproval = decision;
  if (decision === "approved") {
    delete run.externalReason;
    run.status = "materializing_deferrals";
  } else if (decision === "changes_requested") {
    if (reason === undefined) delete run.externalReason;
    else run.externalReason = reason;
    run.status = "repairing";
  } else {
    run.status = "awaiting_human_merge_review";
  }
}

export function approveDeferrals(run: TicketRun): void {
  requireStatus(run, "approveDeferrals", ["automated_review_passed", "materializing_deferrals"]);
  run.deferrals = run.deferrals.map((deferral) =>
    deferral.state === "defer_proposed" ? { ...deferral, state: "defer_approved" } : deferral,
  );
  run.status = "materializing_deferrals";
}

export function recordMaterializedDeferral(
  run: TicketRun,
  findingId: FindingId,
  issueId: DeferredIssueId,
): void {
  const index = run.deferrals.findIndex((deferral) => deferral.findingId === findingId);
  const deferral = run.deferrals[index];
  if (index < 0 || deferral?.state !== "defer_approved") {
    throw new TransitionError(
      `finding ${findingId} is not an approved deferral`,
      "deferral_not_approved",
    );
  }
  run.deferrals[index] = { ...deferral, state: "defer_materialized", issueId };
  finishDeferralMaterialization(run);
}

export function finishDeferralMaterialization(run: TicketRun): void {
  if (run.status === "ready_to_merge") return;
  requireStatus(run, "finishDeferralMaterialization", [
    "automated_review_passed",
    "materializing_deferrals",
  ]);
  if (approvedDeferrals(run).length === 0) run.status = "ready_to_merge";
}

export function mergeGateInput(run: TicketRun, githubMergeable: boolean): MergeGateInput {
  return {
    unresolvedBlockingFindings: run.findings.filter(requiresRepair).length,
    testsPassed: run.testsPassed,
    reviewersPassed: run.reviewersPassed,
    humanApprovalsSatisfied: !mergeApprovalRequired(run) || run.mergeApproval === "approved",
    deferralsMaterialized: run.deferrals.every(
      (deferral) => deferral.state !== "defer_approved" && deferral.state !== "defer_proposed",
    ),
    githubMergeable,
  };
}

function mergeApprovalRequired(run: TicketRun): boolean {
  return (
    approvalRequiresMerge(run.ticket.policy.approvalPolicy) ||
    (run.implementation?.riskFlags.length ?? 0) > 0 ||
    !run.testsPassed
  );
}

export function startMerge(run: TicketRun, gate: MergeGateInput): void {
  requireStatus(run, "startMerge", ["ready_to_merge"]);
  if (!mergeAllowed(gate)) {
    throw new TransitionError("merge gate is not satisfied", "merge_gate_rejected");
  }
  run.status = "merging";
}

export function completeMerge(run: TicketRun): void {
  requireStatus(run, "completeMerge", ["merging"]);
  run.status = "done";
}

export function applyHumanStatus(run: TicketRun, status: TicketStatus, reason?: string): void {
  if (status === "cancelled") {
    run.status = status;
    delete run.suspendedStatus;
    if (reason === undefined) delete run.externalReason;
    else run.externalReason = reason;
  } else if (status === "blocked") {
    if (run.status !== "blocked") run.suspendedStatus = run.status;
    run.status = "blocked";
    if (reason === undefined) delete run.externalReason;
    else run.externalReason = reason;
  } else if (run.status === "blocked") {
    run.status = run.suspendedStatus ?? status;
    delete run.suspendedStatus;
    delete run.externalReason;
  }
}

export function orphanTicket(run: TicketRun, reason?: string): void {
  run.status = "orphaned";
  delete run.suspendedStatus;
  if (reason === undefined) delete run.externalReason;
  else run.externalReason = reason;
}

function requiresRepair(finding: NormalizedFinding): boolean {
  return finding.disposition === "blocking" || finding.disposition === "non_blocking_fix_now";
}

function canRepairAgain(run: TicketRun): boolean {
  const history = run.blockingHistory;
  const latest = history.at(-1);
  const previous = history.at(-2);
  return (
    run.repairPass < run.ticket.policy.autonomousRepairBudget &&
    latest !== undefined &&
    (previous === undefined || latest < previous)
  );
}

function approvedDeferrals(run: TicketRun): FindingId[] {
  return run.deferrals
    .filter((deferral) => deferral.state === "defer_approved")
    .map((deferral) => deferral.findingId);
}

function impactReviewers(
  run: TicketRun,
  configuredReviewers: readonly ReviewerKind[],
): ReviewerKind[] {
  if (run.lastSynthesis?.fullReReview === true) return [...configuredReviewers];
  const reviewers = new Set<ReviewerKind>(["correctness", "testing"]);
  for (const finding of run.findings) {
    finding.reviewers.forEach((reviewer) => reviewers.add(reviewer));
    const category = finding.category.toLowerCase();
    if (category.includes("security")) reviewers.add("security");
    if (category.includes("architecture")) reviewers.add("architecture");
    if (category.includes("performance")) reviewers.add("performance");
    if (category.includes("migration") || category.includes("data"))
      reviewers.add("data_migration");
    if (category.includes("api") || category.includes("compat")) reviewers.add("api_compatibility");
  }
  return configuredReviewers.filter((reviewer) => reviewers.has(reviewer));
}

function requireStatus(run: TicketRun, operation: string, allowed: TicketStatus[]): void {
  if (!allowed.includes(run.status)) {
    throw new TransitionError(
      `${operation} is invalid while ticket is ${run.status}`,
      "invalid_state",
    );
  }
}

export const serializedTicketRunSchema = z.custom<TicketRun>((value) => {
  if (typeof value !== "object" || value === null) return false;
  return "workflowId" in value && "status" in value && "ticket" in value;
});
