import { createHash } from "node:crypto";

import { cancellationSignal, heartbeat } from "@temporalio/activity";
import { ApplicationFailure, CancelledFailure } from "@temporalio/common";
import {
  AgentExecutionError,
  ExecutionPackageBuilder,
  HarnessRouter,
  PackageBuildError,
  type AgentExecutionResult,
} from "@thor/agent";
import {
  blueprintSchema,
  findingIdSchema,
  implementationResultSchema,
  normalizedFindingSchema,
  repairResultSchema,
  redactKnownSecrets,
  redactStructuredSecrets,
  reviewerKinds,
  reviewerResultSchema,
  reviewSynthesisSchema,
  ticketContextsEqual,
  type ExecutionPackage,
  type FindingId,
  type NormalizedFinding,
  type ReviewFinding,
  type TicketContext,
} from "@thor/domain";
import { GitHubError, type DeferredProjectField, type GitHubGateway } from "@thor/github";
import { z } from "zod";

import {
  implementationAgentOutputSchema,
  repairAgentOutputSchema,
  stableFindingInputSchema,
  type AgentActivityContext,
  type Audited,
  type BlueprintActivityInput,
  type ExecutionAuditRecord,
  type ImplementationActivityInput,
  type MaterializeDeferredFindingInput,
  type PublishBlueprintInput,
  type RepairActivityInput,
  type ReviewActivityInput,
  type RunSummaryInput,
  type SynthesisActivityInput,
  type TicketActivities,
  type TransitionProjectStatusResult,
} from "./contracts.js";
import { WorkspaceError, type WorkspaceManager } from "./workspace.js";

const synthesisAgentOutputSchema = z.object({
  findings: z.array(
    z.object({
      sourceFindingIds: z.array(z.string().min(1)).min(1),
      reviewers: z.array(
        z.enum([
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
        ]),
      ),
      severity: z.enum(["info", "low", "medium", "high", "critical"]),
      category: z.string().min(1),
      summary: z.string().min(1),
      evidence: z.array(z.string()).min(1),
      affectedFiles: z.array(z.string()),
      recommendedFix: z.string().min(1),
      disposition: z.enum(["blocking", "non_blocking_fix_now", "defer_candidate", "rejected"]),
      confidence: z.number().min(0).max(1),
    }),
  ),
  failureScope: z.enum(["repair", "implementation", "blueprint"]),
  fullReReview: z.boolean(),
});

export type TicketActivityDependencies = {
  github: GitHubGateway;
  harnesses: HarnessRouter;
  packageBuilder: ExecutionPackageBuilder;
  workspaces: WorkspaceManager;
  deferredProjectFields?: (
    finding: NormalizedFinding,
    ticket: TicketContext,
  ) => DeferredProjectField[];
};

export function createTicketActivities(dependencies: TicketActivityDependencies): TicketActivities {
  return {
    async loadProjectItem(projectItemId) {
      return withActivityFailure(() => dependencies.github.getProjectItem(projectItemId));
    },

    async transitionProjectStatus(transition): Promise<TransitionProjectStatusResult> {
      try {
        const snapshot = await dependencies.github.transitionStatus(transition);
        return { kind: "updated", snapshot };
      } catch (error) {
        if (error instanceof GitHubError && error.code === "conflict") {
          const snapshot = await dependencies.github.getProjectItem(transition.projectItemId);
          if (
            snapshot.status === transition.targetStatus &&
            transition.expectedTicket !== undefined &&
            ticketContextsEqual(snapshot.ticket, transition.expectedTicket)
          ) {
            return { kind: "updated", snapshot };
          }
          return { kind: "conflict", snapshot, reason: error.message };
        }
        throw toApplicationFailure(error);
      }
    },

    async createBlueprint(input) {
      return withActivityFailure(async () => {
        const signal = cancellationSignal();
        const workspace =
          input.priorImplementation === undefined
            ? await dependencies.workspaces.readWorkspace(input.ticket, input.baseBranch, signal)
            : await dependencies.workspaces.existingWriteWorkspace(
                input.ticket,
                input.priorImplementation.branch,
                signal,
              );
        return executeAgent(
          dependencies,
          input,
          { kind: "blueprint" },
          workspace,
          {
            ticket: input.ticket,
            ...(input.priorBlueprint === undefined ? {} : { priorBlueprint: input.priorBlueprint }),
            ...(input.priorImplementation === undefined
              ? {}
              : { priorImplementation: input.priorImplementation }),
            ...(input.humanFeedback === undefined ? {} : { humanFeedback: input.humanFeedback }),
            ...(input.reviewSynthesis === undefined
              ? {}
              : { reviewSynthesis: input.reviewSynthesis }),
          },
          blueprintSchema,
          signal,
        );
      });
    },

    async publishBlueprint(input) {
      await withActivityFailure(() =>
        dependencies.github.upsertComment({
          repository: input.ticket.repository,
          issueNumber: input.ticket.issueNumber,
          idempotencyKey: `${input.workflowId}:blueprint`,
          body: blueprintComment(input),
        }),
      );
    },

    async implement(input) {
      return withActivityFailure(async () => {
        const signal = cancellationSignal();
        heartbeat({ phase: "preparing_worktree", executionId: input.executionId });
        const prepared = await dependencies.workspaces.prepareWriteWorkspace(
          input.ticket,
          input.baseBranch,
          signal,
        );
        await dependencies.github.ensureBranch(
          input.ticket.repository,
          prepared.branch,
          prepared.baseSha,
        );
        const agent = await executeAgent(
          dependencies,
          input,
          { kind: "implementation" },
          prepared.path,
          {
            blueprint: input.blueprint,
            branch: prepared.branch,
            baseSha: prepared.baseSha,
            idempotencyKey: input.executionId,
            ...(input.priorImplementation === undefined
              ? {}
              : { priorImplementation: input.priorImplementation }),
            ...(input.reviewSynthesis === undefined
              ? {}
              : { reviewSynthesis: input.reviewSynthesis }),
          },
          implementationAgentOutputSchema,
          signal,
        );
        heartbeat({ phase: "finalizing_git", executionId: input.executionId });
        const finalized = await dependencies.workspaces.finalizeWriteWorkspace(
          prepared.path,
          input.priorImplementation?.commitSha ?? prepared.baseSha,
          `Implement #${input.ticket.issueNumber}: ${input.ticket.title}`,
          prepared.branch,
          signal,
        );
        const pull = await dependencies.github.ensurePullRequest({
          repository: input.ticket.repository,
          branch: prepared.branch,
          base: input.baseBranch,
          title: input.ticket.title,
          body: pullRequestBody(input, agent.audit),
        });
        return {
          value: implementationResultSchema.parse({
            branch: prepared.branch,
            commitSha: finalized.commitSha,
            pullRequestNumber: pull.number,
            changedFiles: finalized.changedFiles,
            testsPassed: agent.value.testsPassed,
            riskFlags: agent.value.riskFlags,
          }),
          audit: agent.audit,
        };
      });
    },

    async review(input) {
      return withActivityFailure(async () => {
        const signal = cancellationSignal();
        const workspace = await dependencies.workspaces.existingWriteWorkspace(
          input.ticket,
          input.implementation.branch,
          signal,
        );
        const agent = await executeAgent(
          dependencies,
          input,
          { kind: "review", reviewer: input.reviewer },
          workspace,
          {
            blueprint: input.blueprint,
            implementation: input.implementation,
            reviewer: input.reviewer,
            reviewRunId: input.reviewRunId,
          },
          stableFindingInputSchema,
          signal,
        );
        const findings = agent.value.findings.map((finding) => ({
          ...finding,
          findingId: stableFindingId(input, finding),
          reviewRunId: input.reviewRunId,
          reviewer: input.reviewer,
        }));
        return {
          value: reviewerResultSchema.parse({
            reviewRunId: input.reviewRunId,
            reviewer: input.reviewer,
            findings,
            passed: agent.value.passed && !findings.some((finding) => finding.blocking),
          }),
          audit: agent.audit,
        };
      });
    },

    async synthesize(input) {
      return withActivityFailure(async () => {
        const signal = cancellationSignal();
        const workspace = await dependencies.workspaces.existingWriteWorkspace(
          input.ticket,
          input.implementation.branch,
          signal,
        );
        const agent = await executeAgent(
          dependencies,
          input,
          { kind: "synthesis" },
          workspace,
          {
            blueprint: input.blueprint,
            implementation: input.implementation,
            reviewRunId: input.reviewRunId,
            reviewerResults: input.reviewerResults,
          },
          synthesisAgentOutputSchema,
          signal,
        );
        const sources = new Map<string, ReviewFinding>(
          input.reviewerResults.flatMap((result) =>
            result.findings.map((finding) => [finding.findingId, finding] as const),
          ),
        );
        const findings = agent.value.findings.map((finding) => {
          if (
            finding.sourceFindingIds.length === 0 ||
            finding.sourceFindingIds.some((findingId) => !sources.has(findingId))
          ) {
            throw ApplicationFailure.nonRetryable(
              "synthesis referenced an unknown source finding",
              "structured_output_invalid",
            );
          }
          const sourceReviewers = new Set(
            finding.sourceFindingIds
              .map((findingId) => sources.get(findingId)?.reviewer)
              .filter(
                (reviewer): reviewer is NonNullable<typeof reviewer> => reviewer !== undefined,
              ),
          );
          const sourceFindings = finding.sourceFindingIds
            .map((findingId) => sources.get(findingId))
            .filter((source): source is NonNullable<typeof source> => source !== undefined);
          if (
            finding.disposition === "defer_candidate" &&
            (finding.severity === "high" ||
              finding.severity === "critical" ||
              sourceFindings.some((source) => source.blocking || !source.deferrable))
          ) {
            throw ApplicationFailure.nonRetryable(
              "synthesis attempted to defer a blocking, high-severity, or non-deferrable finding",
              "structured_output_invalid",
            );
          }
          return normalizedFindingSchema.parse({
            ...finding,
            reviewers: reviewerKinds.filter((reviewer) => sourceReviewers.has(reviewer)),
            findingId: stableNormalizedFindingId(input.reviewRunId, finding),
          });
        });
        const failedRequiredReviewers = input.reviewerResults
          .filter((result) => !result.passed)
          .map((result) => result.reviewer);
        if (
          failedRequiredReviewers.length > 0 &&
          !findings.some(
            (finding) =>
              finding.disposition === "blocking" || finding.disposition === "non_blocking_fix_now",
          )
        ) {
          throw ApplicationFailure.nonRetryable(
            `synthesis omitted repair work for failed required reviewers: ${failedRequiredReviewers.join(", ")}`,
            "structured_output_invalid",
          );
        }
        return {
          value: reviewSynthesisSchema.parse({
            ...agent.value,
            reviewRunId: input.reviewRunId,
            findings,
          }),
          audit: agent.audit,
        };
      });
    },

    async repair(input) {
      return withActivityFailure(async () => {
        const signal = cancellationSignal();
        const workspace = await dependencies.workspaces.existingWriteWorkspace(
          input.ticket,
          input.implementation.branch,
          signal,
        );
        const agent = await executeAgent(
          dependencies,
          input,
          { kind: "repair" },
          workspace,
          {
            blueprint: input.blueprint,
            implementation: input.implementation,
            synthesis: input.synthesis,
            requiredFindingIds: input.findingIds,
            repairPass: input.repairPass,
            ...(input.humanFeedback === undefined ? {} : { humanFeedback: input.humanFeedback }),
          },
          repairAgentOutputSchema,
          signal,
        );
        const repairedFindingIds = z.array(findingIdSchema).parse(agent.value.repairedFindings);
        requireExactRepairs(input.findingIds, repairedFindingIds);
        heartbeat({ phase: "finalizing_repair", executionId: input.executionId });
        const finalized = await dependencies.workspaces.finalizeWriteWorkspace(
          workspace,
          input.implementation.commitSha,
          `Repair review findings for #${input.ticket.issueNumber}`,
          input.implementation.branch,
          signal,
        );
        return {
          value: repairResultSchema.parse({
            commitSha: finalized.commitSha,
            repairedFindings: repairedFindingIds,
            changedFiles: finalized.changedFiles,
            testsPassed: agent.value.testsPassed,
          }),
          audit: agent.audit,
        };
      });
    },

    async materializeDeferredFinding(input) {
      return withActivityFailure(() =>
        dependencies.github.ensureDeferredIssue({
          repository: input.ticket.repository,
          title: `[Deferred] ${input.finding.summary}`,
          body: deferredIssueBody(input),
          labels: ["thor-deferred", input.finding.severity],
          originKey: `${input.workflowId}:${input.finding.findingId}`,
          projectFields: dependencies.deferredProjectFields?.(input.finding, input.ticket) ?? [],
        }),
      );
    },

    async getMergeReadiness(input) {
      return withActivityFailure(() =>
        dependencies.github.getMergeReadiness(
          input.ticket.repository,
          input.implementation.pullRequestNumber,
        ),
      );
    },

    async merge(input) {
      return withActivityFailure(() =>
        dependencies.github.mergePullRequest({
          repository: input.ticket.repository,
          pullRequestNumber: input.implementation.pullRequestNumber,
          expectedHeadSha: input.implementation.commitSha,
          commitTitle: input.ticket.title,
        }),
      );
    },

    async closeSourceIssue(input) {
      await withActivityFailure(() =>
        dependencies.github.closeIssue(input.ticket.repository, input.ticket.issueNumber),
      );
    },

    async publishRunSummary(input) {
      try {
        await dependencies.github.upsertComment({
          repository: input.ticket.repository,
          issueNumber: input.ticket.issueNumber,
          idempotencyKey: `${input.run.workflowId}:final-summary`,
          body: runSummary(input),
        });
      } catch (error) {
        // A deleted source Issue has no place to receive the ancillary final summary. The durable
        // Workflow outcome must still complete; all other GitHub failures retain normal retries.
        if (error instanceof GitHubError && error.code === "not_found") return;
        throw toApplicationFailure(error);
      }
    },
  };
}

async function executeAgent<Output>(
  dependencies: TicketActivityDependencies,
  input:
    | BlueprintActivityInput
    | ImplementationActivityInput
    | ReviewActivityInput
    | SynthesisActivityInput
    | RepairActivityInput,
  purpose:
    | { kind: "blueprint" }
    | { kind: "implementation" }
    | { kind: "review"; reviewer: ReviewActivityInput["reviewer"] }
    | { kind: "synthesis" }
    | { kind: "repair" },
  workspace: string,
  payload: unknown,
  outputSchema: z.ZodType<Output>,
  signal: AbortSignal,
): Promise<Audited<Output>> {
  const executionPackage = await dependencies.packageBuilder.build({
    executionId: input.executionId,
    agent: input.agent,
    purpose,
    ticket: input.ticket,
    payload,
    skillSelectors: input.skillSelectors,
  });
  heartbeat({ phase: "agent_started", executionId: input.executionId, purpose: purpose.kind });
  const heartbeatTimer = setInterval(() => {
    heartbeat({ phase: "agent_running", executionId: input.executionId, purpose: purpose.kind });
  }, 30_000);
  try {
    const result = await dependencies.harnesses.execute(
      {
        package: executionPackage,
        workspace,
        outputSchema: jsonSchema(outputSchema),
      },
      signal,
    );
    const value = outputSchema.parse(redactStructuredSecrets(result.structuredOutput));
    return { value, audit: auditRecord(result, purpose.kind, executionPackage, input) };
  } finally {
    clearInterval(heartbeatTimer);
  }
}

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(z.toJSONSchema(schema));
}

function auditRecord(
  result: AgentExecutionResult,
  purpose: string,
  executionPackage: ExecutionPackage,
  input: AgentActivityContext,
): ExecutionAuditRecord {
  return {
    executionId: result.executionId,
    declarationDigest: input.declarationDigest,
    workflowProfile: input.workflowProfile,
    agentProfile: executionPackage.agentProfile,
    agentProfileDigest: executionPackage.agentProfileDigest,
    harness: result.harness,
    purpose,
    packageDigest: result.packageDigest,
    promptDigest: executionPackage.promptDigest,
    agentsMdDigest: executionPackage.agentsMdDigest,
    configurationDigest: executionPackage.configurationDigest,
    skills: executionPackage.skills.map(({ name, version, digest }) => ({ name, version, digest })),
    ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
    usage: result.usage,
  };
}

function stableFindingId(
  input: ReviewActivityInput,
  finding: z.infer<typeof stableFindingInputSchema>["findings"][number],
): FindingId {
  return findingIdSchema.parse(
    `finding:${input.reviewRunId}:${input.reviewer}:${digest(finding).slice(0, 16)}`,
  );
}

function stableNormalizedFindingId(
  reviewRunId: string,
  finding: { sourceFindingIds: string[]; category: string; summary: string },
): FindingId {
  return findingIdSchema.parse(
    `normalized:${reviewRunId}:${digest({
      sources: [...finding.sourceFindingIds].sort(),
      category: finding.category,
      summary: finding.summary,
    }).slice(0, 16)}`,
  );
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requireExactRepairs(required: FindingId[], actual: FindingId[]): void {
  const expected = new Set(required);
  const returned = new Set(actual);
  if (
    expected.size !== returned.size ||
    [...expected].some((findingId) => !returned.has(findingId))
  ) {
    throw ApplicationFailure.nonRetryable(
      "repair result does not account for the exact required finding set",
      "structured_output_invalid",
    );
  }
}

function pullRequestBody(input: ImplementationActivityInput, audit: ExecutionAuditRecord): string {
  return [
    `Implements #${input.ticket.issueNumber}.`,
    "",
    "Managed by Thor.",
    `Execution: ${audit.executionId}`,
    `Harness: ${audit.harness}`,
    `Execution package: sha256:${audit.packageDigest}`,
  ].join("\n");
}

function blueprintComment(input: PublishBlueprintInput): string {
  return [
    "## Thor blueprint",
    "",
    `Workflow: \`${input.workflowId}\``,
    ...(input.audit === undefined
      ? ["Source: deterministic ticket plan (planning depth: none)"]
      : [
          `Execution: \`${input.audit.executionId}\``,
          `Harness: \`${input.audit.harness}\``,
          `Execution package: \`sha256:${input.audit.packageDigest}\``,
        ]),
    "",
    "```json",
    JSON.stringify(input.blueprint, null, 2),
    "```",
  ].join("\n");
}

function runSummary(input: RunSummaryInput): string {
  const lines = [
    `Thor workflow \`${input.run.workflowId}\` completed with status \`${input.run.status}\`.`,
    ...(input.mergeCommitSha === undefined ? [] : [`Merge commit: \`${input.mergeCommitSha}\`.`]),
    "",
    "Execution audit:",
    ...input.auditTrail.map(
      (entry) =>
        `- ${entry.executionId}: ${entry.harness}/${entry.purpose}, package \`${entry.packageDigest}\``,
    ),
  ];
  return lines.join("\n");
}

function deferredIssueBody(input: MaterializeDeferredFindingInput): string {
  return [
    `Originating ticket: #${input.ticket.issueNumber}`,
    `Originating pull request: #${input.implementation.pullRequestNumber}`,
    `Workflow: ${input.workflowId}`,
    `Review run: ${input.reviewRunId}`,
    `Finding: ${input.finding.findingId}`,
    `Source findings: ${input.finding.sourceFindingIds.join(", ")}`,
    `Reviewers: ${input.finding.reviewers.join(", ")}`,
    `Severity: ${input.finding.severity}`,
    "",
    input.finding.summary,
    "",
    `Evidence: ${input.finding.evidence.join("; ")}`,
    `Recommended remediation: ${input.finding.recommendedFix}`,
    `Affected files: ${input.finding.affectedFiles.join(", ") || "not specified"}`,
  ].join("\n");
}

async function withActivityFailure<Value>(operation: () => Promise<Value>): Promise<Value> {
  try {
    return await operation();
  } catch (error) {
    throw toApplicationFailure(error);
  }
}

export function toApplicationFailure(error: unknown): Error {
  if (error instanceof ApplicationFailure) return error;
  if (error instanceof AgentExecutionError) {
    if (error.code === "cancelled") {
      return new CancelledFailure(redactKnownSecrets(error.message));
    }
    return ApplicationFailure.create({
      message: redactKnownSecrets(error.message),
      type: `agent_${error.code}`,
      nonRetryable: !error.retryable,
    });
  }
  if (error instanceof GitHubError) {
    return ApplicationFailure.create({
      message: redactKnownSecrets(error.message),
      type: `github_${error.code}`,
      nonRetryable: !error.retryable,
      ...(error.retryAfterMs === undefined ? {} : { nextRetryDelay: error.retryAfterMs }),
    });
  }
  if (error instanceof PackageBuildError) {
    return ApplicationFailure.create({
      message: redactKnownSecrets(error.message),
      type: "package_invalid",
      nonRetryable: true,
    });
  }
  if (error instanceof WorkspaceError) {
    return ApplicationFailure.create({
      message: redactKnownSecrets(error.message),
      type: "workspace_failed",
      nonRetryable: !error.retryable,
    });
  }
  if (error instanceof z.ZodError) {
    return ApplicationFailure.nonRetryable(z.prettifyError(error), "structured_output_invalid");
  }
  return ApplicationFailure.create({
    message: redactKnownSecrets(error instanceof Error ? error.message : String(error)),
    type: "activity_failed",
  });
}
