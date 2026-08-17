import {
  blueprintSchema,
  executionIdSchema,
  harnessKindSchema,
  implementationResultSchema,
  projectItemIdSchema,
  repairResultSchema,
  reviewerResultSchema,
  reviewSynthesisSchema,
  ticketContextSchema,
  ticketStatusSchema,
  type Blueprint,
  type ExecutionId,
  type FindingId,
  type HarnessKind,
  type ImplementationResult,
  type NormalizedFinding,
  type ProjectItemId,
  type RepairResult,
  type ReviewerKind,
  type ReviewerResult,
  type ReviewRunId,
  type ReviewSynthesis,
  type TicketRun,
  type WorkflowId,
} from "@thor/domain";
import type {
  DeferredIssueRef,
  MergeReadiness,
  ProjectItemSnapshot,
  StatusTransition,
} from "@thor/github";
import { z } from "zod";

export const harnessRoutingSchema = z.object({
  blueprint: harnessKindSchema.default("claude"),
  implementation: harnessKindSchema.default("codex"),
  review: harnessKindSchema.default("claude"),
  synthesis: harnessKindSchema.default("claude"),
  repair: harnessKindSchema.default("codex"),
});
export type HarnessRouting = z.infer<typeof harnessRoutingSchema>;

export const ticketWorkflowInputSchema = z.object({
  projectItemId: projectItemIdSchema,
  baseBranch: z.string().trim().min(1).default("main"),
  harnesses: harnessRoutingSchema.default({
    blueprint: "claude",
    implementation: "codex",
    review: "claude",
    synthesis: "claude",
    repair: "codex",
  }),
});
export type TicketWorkflowInput = z.input<typeof ticketWorkflowInputSchema>;

export const projectItemSnapshotSchema = z.object({
  projectItemId: projectItemIdSchema,
  projectId: z.string().min(1),
  updatedAt: z.string().min(1),
  status: ticketStatusSchema,
  ticket: ticketContextSchema,
});

export const projectChangeEventSchema = z.object({
  snapshot: projectItemSnapshotSchema,
  reason: z.string().optional(),
});
export type ProjectChangeEvent = z.infer<typeof projectChangeEventSchema>;

export const approvalDecisionEventSchema = z.object({
  decision: z.enum(["approved", "changes_requested"]),
  actor: z.string().trim().min(1),
  reason: z.string().optional(),
});
export type ApprovalDecisionEvent = z.infer<typeof approvalDecisionEventSchema>;

export const operatorEventSchema = z.object({
  actor: z.string().trim().min(1),
  reason: z.string().optional(),
});
export type OperatorEvent = z.infer<typeof operatorEventSchema>;

export const agentUsageAuditSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  reasoningOutputTokens: z.number().int().nonnegative().optional(),
  estimatedCostUsd: z.number().nonnegative().optional(),
});

export const executionAuditRecordSchema = z.object({
  executionId: executionIdSchema,
  harness: harnessKindSchema,
  purpose: z.string().min(1),
  packageDigest: z.string().regex(/^[a-f0-9]{64}$/),
  promptDigest: z.string().regex(/^[a-f0-9]{64}$/),
  agentsMdDigest: z.string().regex(/^[a-f0-9]{64}$/),
  configurationDigest: z.string().regex(/^[a-f0-9]{64}$/),
  skills: z.array(
    z.object({
      name: z.string().min(1),
      version: z.string().min(1),
      digest: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ),
  sessionId: z.string().min(1).optional(),
  usage: agentUsageAuditSchema,
});
export type ExecutionAuditRecord = z.infer<typeof executionAuditRecordSchema>;

export type Audited<Value> = {
  value: Value;
  audit: ExecutionAuditRecord;
};

export type BlueprintActivityInput = {
  executionId: ExecutionId;
  harness: HarnessKind;
  ticket: ProjectItemSnapshot["ticket"];
  baseBranch: string;
  priorBlueprint?: Blueprint;
  priorImplementation?: ImplementationResult;
  humanFeedback?: string;
  reviewSynthesis?: ReviewSynthesis;
};

export type ImplementationActivityInput = {
  executionId: ExecutionId;
  harness: HarnessKind;
  ticket: ProjectItemSnapshot["ticket"];
  blueprint: Blueprint;
  baseBranch: string;
  priorImplementation?: ImplementationResult;
  reviewSynthesis?: ReviewSynthesis;
};

export type ReviewActivityInput = {
  executionId: ExecutionId;
  harness: HarnessKind;
  ticket: ProjectItemSnapshot["ticket"];
  blueprint: Blueprint;
  implementation: ImplementationResult;
  reviewer: ReviewerKind;
  reviewRunId: ReviewRunId;
};

export type SynthesisActivityInput = {
  executionId: ExecutionId;
  harness: HarnessKind;
  ticket: ProjectItemSnapshot["ticket"];
  blueprint: Blueprint;
  implementation: ImplementationResult;
  reviewRunId: ReviewRunId;
  reviewerResults: ReviewerResult[];
};

export type RepairActivityInput = {
  executionId: ExecutionId;
  harness: HarnessKind;
  ticket: ProjectItemSnapshot["ticket"];
  blueprint: Blueprint;
  implementation: ImplementationResult;
  synthesis: ReviewSynthesis;
  findingIds: FindingId[];
  repairPass: number;
  humanFeedback?: string;
};

export type TransitionProjectStatusResult =
  | { kind: "updated"; snapshot: ProjectItemSnapshot }
  | { kind: "conflict"; snapshot: ProjectItemSnapshot; reason: string };

export type MergeActivityInput = {
  ticket: ProjectItemSnapshot["ticket"];
  implementation: ImplementationResult;
};

export type MaterializeDeferredFindingInput = {
  ticket: ProjectItemSnapshot["ticket"];
  implementation: ImplementationResult;
  workflowId: WorkflowId;
  reviewRunId: ReviewRunId;
  finding: NormalizedFinding;
};

export type RunSummaryInput = {
  ticket: ProjectItemSnapshot["ticket"];
  run: TicketRun;
  auditTrail: ExecutionAuditRecord[];
  mergeCommitSha?: string;
};

export type PublishBlueprintInput = {
  ticket: ProjectItemSnapshot["ticket"];
  workflowId: WorkflowId;
  blueprint: Blueprint;
  audit?: ExecutionAuditRecord;
};

export type TicketWorkflowState = {
  run?: TicketRun;
  latestProjectSnapshot?: ProjectItemSnapshot;
  auditTrail: ExecutionAuditRecord[];
  activeExecutionIds: ExecutionId[];
};

export type TicketWorkflowResult = {
  run: TicketRun;
  auditTrail: ExecutionAuditRecord[];
  mergeCommitSha?: string;
};

export type TicketActivities = {
  loadProjectItem(projectItemId: ProjectItemId): Promise<ProjectItemSnapshot>;
  transitionProjectStatus(transition: StatusTransition): Promise<TransitionProjectStatusResult>;
  createBlueprint(input: BlueprintActivityInput): Promise<Audited<Blueprint>>;
  publishBlueprint(input: PublishBlueprintInput): Promise<void>;
  implement(input: ImplementationActivityInput): Promise<Audited<ImplementationResult>>;
  review(input: ReviewActivityInput): Promise<Audited<ReviewerResult>>;
  synthesize(input: SynthesisActivityInput): Promise<Audited<ReviewSynthesis>>;
  repair(input: RepairActivityInput): Promise<Audited<RepairResult>>;
  materializeDeferredFinding(input: MaterializeDeferredFindingInput): Promise<DeferredIssueRef>;
  getMergeReadiness(input: MergeActivityInput): Promise<MergeReadiness>;
  merge(input: MergeActivityInput): Promise<string>;
  publishRunSummary(input: RunSummaryInput): Promise<void>;
};

export const activityResultSchemas = {
  blueprint: blueprintSchema,
  implementation: implementationResultSchema,
  review: reviewerResultSchema,
  synthesis: reviewSynthesisSchema,
  repair: repairResultSchema,
} as const;

export const stableFindingInputSchema = z.object({
  findings: z.array(
    z.object({
      severity: z.enum(["info", "low", "medium", "high", "critical"]),
      category: z.string().min(1),
      summary: z.string().min(1),
      evidence: z.array(z.string()).min(1),
      affectedFiles: z.array(z.string()),
      recommendedFix: z.string().min(1),
      blocking: z.boolean(),
      deferrable: z.boolean(),
      confidence: z.number().min(0).max(1),
    }),
  ),
  passed: z.boolean(),
});

export const implementationAgentOutputSchema = z.object({
  testsPassed: z.boolean(),
  riskFlags: z.array(
    z.enum([
      "destructive_migration",
      "security_sensitive",
      "architectural_deviation",
      "ambiguous_requirements",
      "dependency_change",
      "large_change_surface",
      "unresolved_test_failure",
      "policy_violation",
      "low_confidence",
    ]),
  ),
  summary: z.string().min(1),
  verification: z.array(z.string()),
});

export const repairAgentOutputSchema = z.object({
  repairedFindings: z.array(z.string().min(1)),
  testsPassed: z.boolean(),
  summary: z.string().min(1),
  verification: z.array(z.string()),
});
