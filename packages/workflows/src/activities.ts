import { createHash } from "node:crypto";

import { activityInfo, cancellationSignal, heartbeat } from "@temporalio/activity";
import { ApplicationFailure, CancelledFailure } from "@temporalio/common";
import {
  AgentExecutionError,
  ExecutionPackageBuilder,
  HarnessRouter,
  PackageBuildError,
  agentControlSourceReferenceSchema,
  noAgentControls,
  type AgentControl,
  type AgentControlSourceReference,
  type AgentEventSink,
  type AgentExecutionResult,
  type AgentResponseContext,
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
import {
  SlackApiError,
  SlackControlClient,
  SlackSurfaceManager,
  SlackTranscriptSink,
  parseSlackCommand,
  slackCommandContainsSecret,
  slackCommandDigest,
  slackCommandReferenceSchema,
  slackTimestampSchema,
  slackUserIdSchema,
  slackWorkspaceIdSchema,
  type SlackApi,
  type SlackCommandReference,
  type SlackMessage,
  type SlackTaskSurface,
  type SlackTimestamp,
} from "@thor/slack";
import { z } from "zod";

import {
  implementationAgentOutputSchema,
  repairAgentOutputSchema,
  stableFindingInputSchema,
  type AgentActivityContext,
  type Audited,
  type BlueprintActivityInput,
  type ExecutionAuditRecord,
  type RegisterTicketSlackSurfaceInput,
  type ImplementationActivityInput,
  type MaterializeDeferredFindingInput,
  type PublishBlueprintInput,
  type PublishTicketSlackLinkInput,
  type RepairActivityInput,
  type ReviewActivityInput,
  type RunSummaryInput,
  type SynthesisActivityInput,
  type TicketActivities,
  type TransitionProjectStatusResult,
  type UpdateTicketSlackSurfaceInput,
} from "./contracts.js";
import type { AgentExecutionCheckpoint, ExecutionCheckpointStore } from "./execution-checkpoint.js";
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

const agentActivityHeartbeatSchema = z
  .object({
    executionId: z.string().min(1),
    providerSessionId: z.string().min(1).optional(),
    providerTurn: z.number().int().nonnegative().optional(),
    slackMessageTs: z
      .string()
      .regex(/^\d{10,}\.\d{6}$/)
      .optional(),
    lastItemId: z.string().min(1).optional(),
    appliedCommandIds: z.array(z.string().min(1)).max(100).default([]),
    pendingControlReferences: z.array(agentControlSourceReferenceSchema).max(100).default([]),
  })
  .loose();

export type TicketActivityDependencies = {
  github: GitHubGateway;
  harnesses: HarnessRouter;
  packageBuilder: ExecutionPackageBuilder;
  workspaces: WorkspaceManager;
  checkpoints?: ExecutionCheckpointStore;
  slack?: {
    api: SlackApi;
    botUserId: string;
    surfaces: SlackSurfaceManager;
    workflows: SlackWorkflowRegistrationGateway;
    control?: {
      gatewayUrl: string;
      serviceToken: string;
    };
  };
  deferredProjectFields?: (
    finding: NormalizedFinding,
    ticket: TicketContext,
  ) => DeferredProjectField[];
};

export type SlackWorkflowRegistrationGateway = {
  register(input: RegisterTicketSlackSurfaceInput): Promise<void>;
  close(input: RegisterTicketSlackSurfaceInput): Promise<void>;
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

    async ensureTicketSlackSurface(input) {
      const slack = requireSlack(dependencies);
      return withActivityFailure(() =>
        slack.surfaces.ensure({
          workspaceId: input.slack.workspaceId,
          messaging: input.slack.messaging,
          workflowId: input.workflowId,
          projectItemId: input.projectItemId,
          repository: input.ticket.repository,
          issueNumber: input.ticket.issueNumber,
          ticketTitle: input.ticket.title,
          status: input.status,
          ...(input.pullRequestNumber === undefined
            ? {}
            : { pullRequestNumber: input.pullRequestNumber }),
        }),
      );
    },

    async registerTicketSlackSurface(input) {
      const slack = requireSlack(dependencies);
      await withActivityFailure(() => slack.workflows.register(input));
    },

    async publishTicketSlackLink(input) {
      await withActivityFailure(() =>
        dependencies.github.upsertComment({
          repository: input.ticket.repository,
          issueNumber: input.ticket.issueNumber,
          idempotencyKey: `${input.workflowId}:slack-surface`,
          body: slackLinkComment(input),
        }),
      );
    },

    async updateTicketSlackSurface(input) {
      const slack = requireSlack(dependencies);
      await withActivityFailure(async () => {
        await slack.surfaces.update(input.surface, {
          workspaceId: input.slack.workspaceId,
          messaging: input.slack.messaging,
          workflowId: input.workflowId,
          projectItemId: input.projectItemId,
          repository: input.ticket.repository,
          issueNumber: input.ticket.issueNumber,
          ticketTitle: input.ticket.title,
          status: input.status,
          ...(input.pullRequestNumber === undefined
            ? {}
            : { pullRequestNumber: input.pullRequestNumber }),
        });
        await dependencies.github.upsertComment({
          repository: input.ticket.repository,
          issueNumber: input.ticket.issueNumber,
          idempotencyKey: `${input.workflowId}:slack-surface`,
          body: slackLinkComment(input),
        });
      });
    },

    async closeTicketSlackSurface(input) {
      const slack = requireSlack(dependencies);
      await withActivityFailure(() => slack.workflows.close(input));
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
  const recoveryGuidance = await loadRecoveryGuidance(dependencies, input);
  const packagePayload =
    recoveryGuidance.length === 0
      ? payload
      : {
          ...(isRecord(payload) ? payload : { originalPayload: payload }),
          humanSlackGuidance: recoveryGuidance,
        };
  const executionPackage = await dependencies.packageBuilder.build({
    executionId: input.executionId,
    agent: input.agent,
    purpose,
    ticket: input.ticket,
    payload: packagePayload,
    skillSelectors: input.skillSelectors,
  });
  const info = activityInfo();
  const parsedHeartbeat = agentActivityHeartbeatSchema.safeParse(info.heartbeatDetails);
  const previousHeartbeat =
    parsedHeartbeat.success && parsedHeartbeat.data.executionId === input.executionId
      ? parsedHeartbeat.data
      : undefined;
  const storedCheckpoint = await dependencies.checkpoints?.load(input.executionId);
  const previousCheckpoint =
    storedCheckpoint?.packageDigest === executionPackage.digest ? storedCheckpoint : undefined;
  let providerSessionId =
    previousCheckpoint?.providerSessionId ?? previousHeartbeat?.providerSessionId;
  let providerTurn = previousCheckpoint?.providerTurn ?? previousHeartbeat?.providerTurn;
  let slackMessageTs = previousCheckpoint?.slackMessageTs ?? previousHeartbeat?.slackMessageTs;
  let lastItemId = previousCheckpoint?.lastItemId ?? previousHeartbeat?.lastItemId;
  const appliedCommandIds = new Set([
    ...(previousCheckpoint?.appliedCommandIds ?? []),
    ...(previousHeartbeat?.appliedCommandIds ?? []),
  ]);
  const pendingControlReferences = new Map<string, AgentControlSourceReference>(
    [
      ...(previousCheckpoint?.pendingControlReferences ?? []),
      ...(previousHeartbeat?.pendingControlReferences ?? []),
    ].map((reference) => [reference.commandId, reference]),
  );
  let slackDeliveryDegraded = false;

  const emitHeartbeat = (eventKind?: string): void => {
    heartbeat({
      phase: "agent_running",
      executionId: input.executionId,
      attempt: info.attempt,
      purpose: purpose.kind,
      ...(eventKind === undefined ? {} : { eventKind }),
      ...(providerSessionId === undefined ? {} : { providerSessionId }),
      ...(providerTurn === undefined ? {} : { providerTurn }),
      ...(slackMessageTs === undefined ? {} : { slackMessageTs }),
      ...(lastItemId === undefined ? {} : { lastItemId }),
      appliedCommandIds: [...appliedCommandIds].slice(-100),
      pendingControlReferences: [...pendingControlReferences.values()].slice(-100),
      slackDeliveryDegraded,
    });
  };
  const persistCheckpoint = async (): Promise<void> => {
    if (dependencies.checkpoints === undefined) return;
    const checkpoint: AgentExecutionCheckpoint = {
      version: 1,
      executionId: input.executionId,
      packageDigest: executionPackage.digest,
      ...(providerSessionId === undefined ? {} : { providerSessionId }),
      ...(providerTurn === undefined ? {} : { providerTurn }),
      ...(slackMessageTs === undefined ? {} : { slackMessageTs }),
      ...(lastItemId === undefined ? {} : { lastItemId }),
      appliedCommandIds: [...appliedCommandIds].slice(-100),
      pendingControlReferences: [...pendingControlReferences.values()].slice(-100),
      updatedAt: new Date().toISOString(),
    };
    await dependencies.checkpoints.save(checkpoint);
  };
  emitHeartbeat("agent_started");
  const slack = dependencies.slack;
  const recoveredCheckpointControls = await loadCheckpointControls(
    slack,
    input.slackSession?.surface,
    [...pendingControlReferences.values()],
    input.slackSession?.defaultMode,
  );
  const resumedTranscriptMessage =
    slack === undefined || input.slackSession === undefined || slackMessageTs === undefined
      ? undefined
      : await loadSlackTranscriptMessage(
          slack.api,
          input.slackSession.surface,
          input.executionId,
          slackMessageTs,
        );
  if (slackMessageTs !== undefined && resumedTranscriptMessage === undefined) {
    slackMessageTs = undefined;
  }
  const transcript =
    slack === undefined || input.slackSession === undefined
      ? undefined
      : new SlackTranscriptSink({
          slack: slack.api,
          surface: input.slackSession.surface,
          executionId: input.executionId,
          label: agentLabel(purpose, executionPackage.harness, input.executionId),
          flushIntervalMilliseconds: input.slackSession.flushIntervalMilliseconds,
          ...(resumedTranscriptMessage === undefined
            ? {}
            : { initialMessage: resumedTranscriptMessage }),
          checkpoint: (checkpoint) => {
            slackMessageTs = checkpoint.messageTs ?? slackMessageTs;
            lastItemId = checkpoint.lastItemId ?? lastItemId;
            slackDeliveryDegraded = checkpoint.degraded;
            emitHeartbeat("slack_checkpoint");
          },
        });
  const control =
    slack?.control === undefined || input.slackSession === undefined
      ? undefined
      : new SlackControlClient({
          gatewayUrl: slack.control.gatewayUrl,
          serviceToken: slack.control.serviceToken,
          workflowId: input.slackSession.workflowId,
          executionId: input.executionId,
          surface: input.slackSession.surface,
          signal,
          seenCommandIds: [...appliedCommandIds],
        });
  let pendingResponseContext: AgentResponseContext | undefined =
    input.recoveryCommands === undefined || input.recoveryCommands.length === 0
      ? recoveredCheckpointControls[0]?.responseContext
      : responseContextForReference(input.recoveryCommands[0]?.reference);
  let responseTranscript: SlackTranscriptSink | undefined;
  let responseDeliveryDegraded = false;
  const closeResponseTranscript = async (): Promise<void> => {
    const result = await responseTranscript?.close();
    responseDeliveryDegraded = responseDeliveryDegraded || result?.degraded === true;
    responseTranscript = undefined;
  };
  const eventSink: AgentEventSink = {
    publish: async (event) => {
      if (event.kind === "session_started") providerSessionId = event.providerSessionId;
      if (event.kind === "turn_started") providerTurn = event.turn;
      if ("itemId" in event) lastItemId = event.itemId;
      if (event.kind === "control_applied") {
        appliedCommandIds.add(event.commandId);
        if (event.sourceReference !== undefined) {
          pendingControlReferences.set(event.commandId, event.sourceReference);
        }
        pendingResponseContext = event.responseContext ?? pendingResponseContext;
      }
      if (event.kind === "control_completed") {
        pendingControlReferences.delete(event.commandId);
      }
      if (
        event.kind === "turn_started" &&
        pendingResponseContext !== undefined &&
        slack !== undefined &&
        input.slackSession !== undefined
      ) {
        await closeResponseTranscript();
        const responseContext = pendingResponseContext;
        pendingResponseContext = undefined;
        responseTranscript = new SlackTranscriptSink({
          slack: slack.api,
          surface: input.slackSession.surface,
          executionId: input.executionId,
          label: `Response to <@${responseContext.actorId}> · ${agentLabel(
            purpose,
            executionPackage.harness,
            input.executionId,
          )}`,
          flushIntervalMilliseconds: input.slackSession.flushIntervalMilliseconds,
          responseTo: {
            threadTs: slackTimestampSchema.parse(responseContext.threadId),
            recipientUserId: slackUserIdSchema.parse(responseContext.actorId),
            recipientTeamId: slackWorkspaceIdSchema.parse(responseContext.workspaceId),
          },
        });
      }
      emitHeartbeat(event.kind);
      await transcript?.publish(event);
      await responseTranscript?.publish(event);
      if (event.kind === "turn_completed" || event.kind === "turn_failed") {
        await closeResponseTranscript();
      }
      if (
        event.kind === "session_started" ||
        event.kind === "control_applied" ||
        event.kind === "control_completed" ||
        event.kind === "turn_completed" ||
        event.kind === "turn_failed"
      ) {
        await persistCheckpoint();
      }
      if (event.kind === "control_applied" && control !== undefined) {
        await control.applied(event.commandId).catch(() => undefined);
      }
    },
  };
  const heartbeatTimer = setInterval(() => emitHeartbeat(), 5_000);
  let result: AgentExecutionResult;
  let value: Output;
  let finalSlackDelivery: "delivered" | "degraded" | undefined;
  try {
    if (info.attempt > 1) {
      await eventSink.publish({
        kind: "recovery",
        message:
          providerSessionId === undefined
            ? "Activity retry started; provider session will be recreated"
            : "Activity retry resumed from its execution checkpoint",
        ...(providerSessionId === undefined ? {} : { previousSessionId: providerSessionId }),
      });
    }
    try {
      result = await dependencies.harnesses.execute(
        {
          package: executionPackage,
          workspace,
          ...(providerSessionId === undefined ? {} : { resumeSessionId: providerSessionId }),
          outputSchema: jsonSchema(outputSchema),
          ...(recoveredCheckpointControls.length === 0
            ? {}
            : { recoveryControls: recoveredCheckpointControls }),
        },
        eventSink,
        control ?? noAgentControls(),
        signal,
      );
    } catch (error) {
      if (
        error instanceof AgentExecutionError &&
        error.code === "session_unavailable" &&
        providerSessionId !== undefined
      ) {
        const unavailableSessionId = providerSessionId;
        providerSessionId = undefined;
        providerTurn = undefined;
        lastItemId = undefined;
        await eventSink.publish({
          kind: "recovery",
          message:
            "The checkpointed provider session is unavailable; the next Activity attempt will start a new recovery session",
          previousSessionId: unavailableSessionId,
        });
        emitHeartbeat("provider_session_unavailable");
        await persistCheckpoint();
      }
      throw error;
    }
    value = outputSchema.parse(redactStructuredSecrets(result.structuredOutput));
    providerSessionId = result.sessionId ?? providerSessionId;
    await persistCheckpoint();
  } finally {
    clearInterval(heartbeatTimer);
    control?.close();
    await closeResponseTranscript();
    const transcriptResult = await transcript?.close();
    if (transcriptResult !== undefined) {
      slackMessageTs = transcriptResult.messageTs ?? slackMessageTs;
      slackDeliveryDegraded = transcriptResult.degraded || responseDeliveryDegraded;
      finalSlackDelivery = slackDeliveryDegraded ? "degraded" : "delivered";
      emitHeartbeat("agent_finished");
      await persistCheckpoint();
    }
  }
  return {
    value,
    audit: auditRecord(result, purpose.kind, executionPackage, input, finalSlackDelivery),
  };
}

async function loadRecoveryGuidance(
  dependencies: TicketActivityDependencies,
  input: AgentActivityContext,
): Promise<string[]> {
  if (input.recoveryCommands === undefined || input.recoveryCommands.length === 0) return [];
  if (dependencies.slack === undefined || input.slackSession === undefined) {
    throw new AgentExecutionError(
      "Slack recovery command cannot be loaded without a Slack runtime and task surface",
      true,
      "provider_unavailable",
    );
  }
  const result: string[] = [];
  for (const accepted of input.recoveryCommands) {
    const messages = await relevantSlackMessages(
      dependencies.slack.api,
      input.slackSession.surface,
      accepted.reference.threadTs,
    );
    const source = messages.find((message) => message.timestamp === accepted.reference.messageTs);
    const parsed =
      source === undefined
        ? undefined
        : parseSlackCommand(
            source.text,
            dependencies.slack.botUserId,
            input.slackSession.defaultMode,
          );
    const receipt = messages.find(
      (message) =>
        message.timestamp === accepted.receiptTs &&
        message.metadata?.eventType === "thor_command_receipt",
    );
    const text =
      parsed?.text ?? (receipt === undefined ? undefined : receiptCommandText(receipt.text));
    if (text === undefined || slackCommandDigest(text) !== accepted.reference.contentDigest) {
      throw new AgentExecutionError(
        `Slack recovery command ${accepted.reference.commandId} is unavailable or changed`,
        false,
        "invalid_request",
      );
    }
    result.push(
      redactKnownSecrets(
        `${accepted.reference.mode} command ${accepted.reference.commandId}: ${text}`,
      ),
    );
  }
  return result;
}

async function loadCheckpointControls(
  slack: TicketActivityDependencies["slack"],
  surface: SlackTaskSurface | undefined,
  references: AgentControlSourceReference[],
  defaultMode: "queue" | "redirect" | undefined,
): Promise<AgentControl[]> {
  if (references.length === 0) return [];
  if (slack === undefined || surface === undefined || defaultMode === undefined) {
    throw new AgentExecutionError(
      "Checkpointed Slack controls cannot be recovered without the configured Slack task surface",
      true,
      "provider_unavailable",
    );
  }
  const controls: AgentControl[] = [];
  for (const rawReference of references) {
    const reference = slackCommandReferenceSchema.parse(rawReference);
    const messages = await relevantSlackMessages(slack.api, surface, reference.threadTs);
    const source = messages.find((message) => message.timestamp === reference.messageTs);
    const sourceCommand =
      source?.userId === reference.actorId
        ? parseSlackCommand(source.text, slack.botUserId, defaultMode)
        : undefined;
    const receipt = messages.find(
      (message) =>
        message.botId !== undefined &&
        message.metadata?.eventType === "thor_command_receipt" &&
        message.metadata.eventPayload.commandId === reference.commandId &&
        message.metadata.eventPayload.contentDigest === reference.contentDigest,
    );
    const receiptText = receipt === undefined ? undefined : receiptCommandText(receipt.text);
    const text =
      sourceCommand?.mode === reference.mode &&
      !slackCommandContainsSecret(sourceCommand.text) &&
      slackCommandDigest(sourceCommand.text) === reference.contentDigest
        ? sourceCommand.text
        : receiptText !== undefined &&
            !slackCommandContainsSecret(receiptText) &&
            slackCommandDigest(receiptText) === reference.contentDigest
          ? receiptText
          : undefined;
    if (text === undefined) {
      throw new AgentExecutionError(
        `Checkpointed Slack command ${reference.commandId} is awaiting a valid source or durable receipt`,
        true,
        "provider_unavailable",
      );
    }
    const responseContext = responseContextForReference(reference);
    controls.push(
      reference.mode === "cancel"
        ? {
            kind: "cancel",
            commandId: reference.commandId,
            reason: text,
            ...(responseContext === undefined ? {} : { responseContext }),
            sourceReference: rawReference,
          }
        : {
            kind: reference.mode,
            commandId: reference.commandId,
            text,
            ...(responseContext === undefined ? {} : { responseContext }),
            sourceReference: rawReference,
          },
    );
  }
  return controls;
}

function responseContextForReference(
  reference: SlackCommandReference | undefined,
): AgentResponseContext | undefined {
  return reference === undefined
    ? undefined
    : {
        actorId: reference.actorId,
        workspaceId: reference.workspaceId,
        threadId: reference.threadTs ?? reference.messageTs,
      };
}

async function loadSlackTranscriptMessage(
  slack: SlackApi,
  surface: SlackTaskSurface,
  executionId: string,
  messageTs: SlackTimestamp,
): Promise<{ messageTs: SlackTimestamp; text: string } | undefined> {
  try {
    const messages = await relevantSlackMessages(slack, surface, undefined);
    const message = messages.find((candidate) => candidate.timestamp === messageTs);
    if (
      message?.botId === undefined ||
      message.metadata?.eventType !== "thor_agent_execution" ||
      message.metadata.eventPayload.executionId !== executionId ||
      message.text.length > 18_000
    ) {
      return undefined;
    }
    return { messageTs, text: message.text };
  } catch {
    return undefined;
  }
}

async function relevantSlackMessages(
  slack: SlackApi,
  surface: SlackTaskSurface,
  commandThreadTs: SlackTimestamp | undefined,
): Promise<SlackMessage[]> {
  const messages: SlackMessage[] = [];
  let cursor: string | undefined;
  do {
    const page =
      surface.mode === "thread_per_ticket" || commandThreadTs !== undefined
        ? await slack.replies({
            channelId: surface.channelId,
            threadTs:
              surface.mode === "thread_per_ticket"
                ? surface.threadTs
                : (commandThreadTs ?? surface.headerTs),
            limit: 200,
            ...(cursor === undefined ? {} : { cursor }),
          })
        : await slack.history({
            channelId: surface.channelId,
            limit: 200,
            ...(cursor === undefined ? {} : { cursor }),
          });
    messages.push(...page.values);
    cursor = page.nextCursor;
  } while (cursor !== undefined && messages.length < 1_000);

  if (surface.mode === "channel_per_ticket" && commandThreadTs !== undefined) {
    let historyCursor: string | undefined;
    do {
      const page = await slack.history({
        channelId: surface.channelId,
        limit: 200,
        ...(historyCursor === undefined ? {} : { cursor: historyCursor }),
      });
      messages.push(...page.values);
      historyCursor = page.nextCursor;
    } while (historyCursor !== undefined && messages.length < 1_000);
  }
  return messages;
}

function receiptCommandText(text: string): string | undefined {
  const match = /```\n([\s\S]*?)\n```/.exec(text);
  return match?.[1]?.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireSlack(
  dependencies: TicketActivityDependencies,
): NonNullable<TicketActivityDependencies["slack"]> {
  if (dependencies.slack === undefined) {
    throw ApplicationFailure.nonRetryable(
      "Slack collaboration is enabled but the worker has no Slack runtime",
      "slack_not_configured",
    );
  }
  return dependencies.slack;
}

function agentLabel(
  purpose:
    | { kind: "blueprint" }
    | { kind: "implementation" }
    | { kind: "review"; reviewer: ReviewActivityInput["reviewer"] }
    | { kind: "synthesis" }
    | { kind: "repair" },
  harness: string,
  executionId: string,
): string {
  const phase = purpose.kind === "review" ? `Review: ${purpose.reviewer}` : purpose.kind;
  return `${phase} · ${harness} · ${executionId}`;
}

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(z.toJSONSchema(schema));
}

function auditRecord(
  result: AgentExecutionResult,
  purpose: string,
  executionPackage: ExecutionPackage,
  input: AgentActivityContext,
  slackDelivery?: "delivered" | "degraded",
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
    ...(slackDelivery === undefined ? {} : { slackDelivery }),
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

function slackLinkComment(
  input: PublishTicketSlackLinkInput | UpdateTicketSlackSurfaceInput,
): string {
  const pullRequest =
    input.pullRequestNumber === undefined
      ? undefined
      : `https://github.com/${input.ticket.repository.owner}/${input.ticket.repository.name}/pull/${input.pullRequestNumber.toString()}`;
  return [
    "## Thor execution",
    "",
    `Slack: ${input.surface.permalink}`,
    `Temporal Workflow: \`${input.workflowId}\``,
    `Latest result: \`${input.status}\``,
    ...(pullRequest === undefined ? [] : [`Pull request: ${pullRequest}`]),
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
  if (error instanceof SlackApiError) {
    return ApplicationFailure.create({
      message: redactKnownSecrets(error.message),
      type: `slack_${error.code}`,
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
