import { z } from "zod";

import {
  deferredIssueIdSchema,
  executionIdSchema,
  findingIdSchema,
  projectItemIdSchema,
  issueIdSchema,
  reviewRunIdSchema,
} from "./ids.js";

export const ticketStatuses = [
  "backlog",
  "discovery",
  "design_blueprint",
  "awaiting_blueprint_approval",
  "ready",
  "in_progress",
  "ready_for_review",
  "in_review",
  "repairing",
  "re_review",
  "automated_review_passed",
  "awaiting_human_merge_review",
  "materializing_deferrals",
  "ready_to_merge",
  "merging",
  "done",
  "blocked",
  "cancelled",
  "orphaned",
] as const;
export const ticketStatusSchema = z.enum(ticketStatuses);
export type TicketStatus = z.infer<typeof ticketStatusSchema>;

export const projectableTicketStatuses = ticketStatuses.filter(
  (status): status is Exclude<TicketStatus, "orphaned"> => status !== "orphaned",
);
export const projectableTicketStatusSchema = z.enum(projectableTicketStatuses);
export type ProjectableTicketStatus = z.infer<typeof projectableTicketStatusSchema>;

export const workTypeSchema = z.enum(["feature", "bug", "task", "spike", "chore", "documentation"]);
export type WorkType = z.infer<typeof workTypeSchema>;
export const prioritySchema = z.enum(["P0", "P1", "P2", "P3"]);
export type Priority = z.infer<typeof prioritySchema>;
export const executionModeSchema = z.enum(["human", "agent", "human_and_agent", "disabled"]);
export type ExecutionMode = z.infer<typeof executionModeSchema>;
export const planningDepthSchema = z.enum(["none", "light", "full", "architecture_review"]);
export type PlanningDepth = z.infer<typeof planningDepthSchema>;
export const approvalPolicySchema = z.enum([
  "autonomous",
  "blueprint_review",
  "pre_merge_review",
  "blueprint_and_pre_merge_review",
]);
export type ApprovalPolicy = z.infer<typeof approvalPolicySchema>;
export const approvalStateSchema = z.enum([
  "not_required",
  "pending",
  "approved",
  "changes_requested",
]);
export type ApprovalState = z.infer<typeof approvalStateSchema>;
export const agentPolicySchema = z.enum(["disabled", "allowed", "preferred", "required"]);
export type AgentPolicy = z.infer<typeof agentPolicySchema>;

export const ticketPolicySchema = z.object({
  executionMode: executionModeSchema.default("agent"),
  planningDepth: planningDepthSchema.default("full"),
  approvalPolicy: approvalPolicySchema.default("autonomous"),
  agentPolicy: agentPolicySchema.default("preferred"),
  autonomousRepairBudget: z.number().int().min(0).max(20).default(3),
});
export type TicketPolicy = z.infer<typeof ticketPolicySchema>;

export const repositoryRefSchema = z.object({
  owner: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/, "invalid GitHub owner"),
  name: z
    .string()
    .trim()
    .regex(/^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/, "invalid GitHub repository name"),
});
export type RepositoryRef = z.infer<typeof repositoryRefSchema>;

export const dependencySchema = z.object({
  issueId: z.string().trim().min(1),
  complete: z.boolean(),
});
export type Dependency = z.infer<typeof dependencySchema>;

export const ticketContextSchema = z.object({
  projectItemId: projectItemIdSchema,
  issueId: issueIdSchema,
  repository: repositoryRefSchema,
  issueNumber: z.number().int().positive(),
  title: z.string().trim().min(1),
  body: z.string(),
  workType: workTypeSchema,
  priority: prioritySchema,
  component: z.string().trim().min(1).optional(),
  acceptanceCriteria: z.array(z.string().trim().min(1)).min(1),
  dependencies: z.array(dependencySchema),
  policy: ticketPolicySchema,
});
export type TicketContext = z.infer<typeof ticketContextSchema>;

export const ticketContextChangeKinds = [
  "none",
  "identity",
  "intent",
  "dependencies",
  "policy",
] as const;
export type TicketContextChangeKind = (typeof ticketContextChangeKinds)[number];

/**
 * Compares execution-relevant ticket intent without depending on object insertion order or the
 * order returned by GitHub's dependency connection.
 */
export function classifyTicketContextChange(
  current: TicketContext,
  incoming: TicketContext,
): TicketContextChangeKind {
  if (
    current.projectItemId !== incoming.projectItemId ||
    current.issueId !== incoming.issueId ||
    current.issueNumber !== incoming.issueNumber ||
    current.repository.owner !== incoming.repository.owner ||
    current.repository.name !== incoming.repository.name
  ) {
    return "identity";
  }
  if (
    stableJson({
      title: current.title,
      body: current.body,
      workType: current.workType,
      priority: current.priority,
      component: current.component,
      acceptanceCriteria: current.acceptanceCriteria,
    }) !==
    stableJson({
      title: incoming.title,
      body: incoming.body,
      workType: incoming.workType,
      priority: incoming.priority,
      component: incoming.component,
      acceptanceCriteria: incoming.acceptanceCriteria,
    })
  ) {
    return "intent";
  }
  // Ticket intent and policy both use the safer ticket-change policy. Check them before
  // dependencies so a simultaneous dependency edit cannot downgrade a required replan to the
  // dependency-only `resume` behavior.
  if (stableJson(current.policy) !== stableJson(incoming.policy)) return "policy";
  if (stableJson(normalizeDependencies(current)) !== stableJson(normalizeDependencies(incoming))) {
    return "dependencies";
  }
  return "none";
}

export function ticketContextsEqual(current: TicketContext, incoming: TicketContext): boolean {
  return classifyTicketContextChange(current, incoming) === "none";
}

function normalizeDependencies(ticket: TicketContext): TicketContext["dependencies"] {
  return [...ticket.dependencies].sort(
    (left, right) =>
      left.issueId.localeCompare(right.issueId) || Number(left.complete) - Number(right.complete),
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

export const blueprintSchema = z.object({
  objective: z.string().trim().min(1),
  constraints: z.array(z.string()),
  architecture: z.string(),
  proposedDesign: z.string().trim().min(1),
  affectedAreas: z.array(z.string()),
  implementationPlan: z.array(z.string().trim().min(1)).min(1),
  testingPlan: z.array(z.string().trim().min(1)).min(1),
  rolloutPlan: z.array(z.string()),
  risks: z.array(z.string()),
  unresolvedBlockingQuestions: z.array(z.string()),
  acceptanceCriteria: z.array(z.string().trim().min(1)).min(1),
});
export type Blueprint = z.infer<typeof blueprintSchema>;

export const harnessKindSchema = z.enum(["claude", "codex"]);
export type HarnessKind = z.infer<typeof harnessKindSchema>;
export const reviewerKinds = [
  "correctness",
  "architecture",
  "security",
  "performance",
  "testing",
  "api_compatibility",
  "data_migration",
  "observability",
  "maintainability",
  "product_specification",
] as const;
export const reviewerKindSchema = z.enum(reviewerKinds);
export type ReviewerKind = z.infer<typeof reviewerKindSchema>;

export const executionPurposeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("blueprint") }),
  z.object({ kind: z.literal("implementation") }),
  z.object({ kind: z.literal("review"), reviewer: reviewerKindSchema }),
  z.object({ kind: z.literal("synthesis") }),
  z.object({ kind: z.literal("repair") }),
]);
export type ExecutionPurpose = z.infer<typeof executionPurposeSchema>;

export const skillRefSchema = z.object({
  name: z.string().trim().min(1),
  version: z.string().trim().min(1),
  path: z.string().trim().min(1),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  content: z.string().min(1),
  selectionReason: z.string().min(1),
});
export type SkillRef = z.infer<typeof skillRefSchema>;

export const executionPackageSchema = z.object({
  executionId: executionIdSchema,
  agentProfile: z.string().trim().min(1),
  agentProfileDigest: z.string().regex(/^[a-f0-9]{64}$/),
  harness: harnessKindSchema,
  purpose: executionPurposeSchema,
  prompt: z.string().min(1),
  promptDigest: z.string().regex(/^[a-f0-9]{64}$/),
  agentsMd: z.string().min(1),
  agentsMdDigest: z.string().regex(/^[a-f0-9]{64}$/),
  skills: z.array(skillRefSchema).min(1),
  configuration: z.record(z.string(), z.string()),
  configurationDigest: z.string().regex(/^[a-f0-9]{64}$/),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ExecutionPackage = z.infer<typeof executionPackageSchema>;

export const riskFlagSchema = z.enum([
  "destructive_migration",
  "security_sensitive",
  "architectural_deviation",
  "ambiguous_requirements",
  "dependency_change",
  "large_change_surface",
  "unresolved_test_failure",
  "policy_violation",
  "low_confidence",
]);
export type RiskFlag = z.infer<typeof riskFlagSchema>;

export const implementationResultSchema = z.object({
  branch: z.string().min(1),
  commitSha: z.string().min(1),
  pullRequestNumber: z.number().int().positive(),
  changedFiles: z.array(z.string()).transform((files) => [...new Set(files)].sort()),
  testsPassed: z.boolean(),
  riskFlags: z.array(riskFlagSchema).transform((flags) => [...new Set(flags)].sort()),
});
export type ImplementationResult = z.infer<typeof implementationResultSchema>;

export const severitySchema = z.enum(["info", "low", "medium", "high", "critical"]);
export type Severity = z.infer<typeof severitySchema>;
export const findingDispositionSchema = z.enum([
  "blocking",
  "non_blocking_fix_now",
  "defer_candidate",
  "rejected",
]);
export type FindingDisposition = z.infer<typeof findingDispositionSchema>;

export const reviewFindingSchema = z.object({
  findingId: findingIdSchema,
  reviewRunId: reviewRunIdSchema,
  reviewer: reviewerKindSchema,
  severity: severitySchema,
  category: z.string().min(1),
  summary: z.string().min(1),
  evidence: z.array(z.string()).min(1),
  affectedFiles: z.array(z.string()).transform((files) => [...new Set(files)].sort()),
  recommendedFix: z.string().min(1),
  blocking: z.boolean(),
  deferrable: z.boolean(),
  confidence: z.number().min(0).max(1),
});
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;

export const reviewerResultSchema = z.object({
  reviewRunId: reviewRunIdSchema,
  reviewer: reviewerKindSchema,
  findings: z.array(reviewFindingSchema),
  passed: z.boolean(),
});
export type ReviewerResult = z.infer<typeof reviewerResultSchema>;

export const normalizedFindingSchema = z.object({
  findingId: findingIdSchema,
  sourceFindingIds: z.array(findingIdSchema),
  reviewers: z.array(reviewerKindSchema),
  severity: severitySchema,
  category: z.string().min(1),
  summary: z.string().min(1),
  evidence: z.array(z.string()).min(1),
  affectedFiles: z.array(z.string()),
  recommendedFix: z.string().min(1),
  disposition: findingDispositionSchema,
  confidence: z.number().min(0).max(1),
});
export type NormalizedFinding = z.infer<typeof normalizedFindingSchema>;

export const failureScopeSchema = z.enum(["repair", "implementation", "blueprint"]);
export type FailureScope = z.infer<typeof failureScopeSchema>;
export const reviewSynthesisSchema = z.object({
  reviewRunId: reviewRunIdSchema,
  findings: z.array(normalizedFindingSchema),
  failureScope: failureScopeSchema,
  fullReReview: z.boolean(),
});
export type ReviewSynthesis = z.infer<typeof reviewSynthesisSchema>;

export const deferredFindingStateSchema = z.enum([
  "open",
  "fix_now",
  "repaired",
  "defer_proposed",
  "defer_approved",
  "defer_materialized",
  "rejected",
]);
export type DeferredFindingState = z.infer<typeof deferredFindingStateSchema>;
export const deferredFindingSchema = z.object({
  findingId: findingIdSchema,
  state: deferredFindingStateSchema,
  issueId: deferredIssueIdSchema.optional(),
});
export type DeferredFinding = z.infer<typeof deferredFindingSchema>;

export const repairResultSchema = z.object({
  commitSha: z.string().min(1),
  repairedFindings: z.array(findingIdSchema),
  changedFiles: z.array(z.string()),
  testsPassed: z.boolean(),
});
export type RepairResult = z.infer<typeof repairResultSchema>;

export const mergeGateInputSchema = z.object({
  unresolvedBlockingFindings: z.number().int().nonnegative(),
  testsPassed: z.boolean(),
  reviewersPassed: z.boolean(),
  humanApprovalsSatisfied: z.boolean(),
  deferralsMaterialized: z.boolean(),
  githubMergeable: z.boolean(),
});
export type MergeGateInput = z.infer<typeof mergeGateInputSchema>;

export function approvalRequiresBlueprint(policy: ApprovalPolicy): boolean {
  return policy === "blueprint_review" || policy === "blueprint_and_pre_merge_review";
}

export function approvalRequiresMerge(policy: ApprovalPolicy): boolean {
  return policy === "pre_merge_review" || policy === "blueprint_and_pre_merge_review";
}

export function policyAllowsAgent(policy: TicketPolicy): boolean {
  return (
    (policy.executionMode === "agent" || policy.executionMode === "human_and_agent") &&
    policy.agentPolicy !== "disabled"
  );
}

export function blueprintIsComplete(blueprint: Blueprint): boolean {
  return (
    blueprintSchema.safeParse(blueprint).success &&
    blueprint.unresolvedBlockingQuestions.length === 0
  );
}

export function mergeAllowed(gate: MergeGateInput): boolean {
  return (
    gate.unresolvedBlockingFindings === 0 &&
    gate.testsPassed &&
    gate.reviewersPassed &&
    gate.humanApprovalsSatisfied &&
    gate.deferralsMaterialized &&
    gate.githubMergeable
  );
}
