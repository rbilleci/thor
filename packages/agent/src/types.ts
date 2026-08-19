import { z } from "zod";

import { executionIdSchema, executionPackageSchema, harnessKindSchema } from "@thor/domain";

export const agentExecutionRequestSchema = z.object({
  package: executionPackageSchema,
  workspace: z.string().trim().min(1),
  resumeSessionId: z.string().trim().min(1).optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  recoveryControls: z.lazy(() => z.array(agentControlSchema).max(100)).optional(),
});
export type AgentExecutionRequest = z.infer<typeof agentExecutionRequestSchema>;

export const agentUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  reasoningOutputTokens: z.number().int().nonnegative().optional(),
  estimatedCostUsd: z.number().nonnegative().optional(),
});
export type AgentUsage = z.infer<typeof agentUsageSchema>;

export const agentExecutionResultSchema = z.object({
  executionId: executionIdSchema,
  harness: harnessKindSchema,
  finalResponse: z.string(),
  structuredOutput: z.unknown().optional(),
  sessionId: z.string().min(1).optional(),
  packageDigest: z.string().regex(/^[a-f0-9]{64}$/),
  usage: agentUsageSchema,
});
export type AgentExecutionResult = z.infer<typeof agentExecutionResultSchema>;

export const agentActionStatusSchema = z.enum(["started", "running", "completed", "failed"]);
export type AgentActionStatus = z.infer<typeof agentActionStatusSchema>;

export const agentPlanItemSchema = z.strictObject({
  text: z.string(),
  completed: z.boolean(),
});
export type AgentPlanItem = z.infer<typeof agentPlanItemSchema>;

export const agentFileChangeSchema = z.strictObject({
  path: z.string().min(1),
  kind: z.enum(["add", "delete", "update"]),
});
export type AgentFileChange = z.infer<typeof agentFileChangeSchema>;

export const agentResponseContextSchema = z.strictObject({
  actorId: z.string().min(1),
  workspaceId: z.string().min(1),
  threadId: z.string().min(1),
});
export type AgentResponseContext = z.infer<typeof agentResponseContextSchema>;

export const agentControlSourceReferenceSchema = z.strictObject({
  commandId: z.string().min(1),
  eventId: z.string().min(1),
  workspaceId: z.string().min(1),
  channelId: z.string().min(1),
  threadTs: z.string().min(1).optional(),
  messageTs: z.string().min(1),
  actorId: z.string().min(1),
  mode: z.enum(["queue", "redirect", "cancel"]),
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type AgentControlSourceReference = z.infer<typeof agentControlSourceReferenceSchema>;

export const agentStreamEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("session_started"), providerSessionId: z.string().min(1) }),
  z.strictObject({ kind: z.literal("turn_started"), turn: z.number().int().positive() }),
  z.strictObject({
    kind: z.literal("assistant_delta"),
    itemId: z.string().min(1),
    text: z.string(),
  }),
  z.strictObject({
    kind: z.literal("assistant_completed"),
    itemId: z.string().min(1),
    text: z.string(),
  }),
  z.strictObject({
    kind: z.literal("plan_updated"),
    itemId: z.string().min(1),
    items: z.array(agentPlanItemSchema),
  }),
  z.strictObject({
    kind: z.literal("command_updated"),
    itemId: z.string().min(1),
    command: z.string(),
    status: agentActionStatusSchema,
    exitCode: z.number().int().optional(),
  }),
  z.strictObject({
    kind: z.literal("file_change"),
    itemId: z.string().min(1),
    changes: z.array(agentFileChangeSchema),
    status: agentActionStatusSchema,
  }),
  z.strictObject({
    kind: z.literal("tool_updated"),
    itemId: z.string().min(1),
    tool: z.string().min(1),
    status: agentActionStatusSchema,
    summary: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal("web_search_updated"),
    itemId: z.string().min(1),
    query: z.string(),
    status: agentActionStatusSchema,
  }),
  z.strictObject({ kind: z.literal("usage"), usage: agentUsageSchema }),
  z.strictObject({
    kind: z.literal("recovery"),
    message: z.string().trim().min(1),
    previousSessionId: z.string().trim().min(1).optional(),
  }),
  z.strictObject({
    kind: z.literal("control_applied"),
    commandId: z.string().min(1),
    mode: z.enum(["queue", "redirect", "cancel"]),
    responseContext: agentResponseContextSchema.optional(),
    sourceReference: agentControlSourceReferenceSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("control_completed"),
    commandId: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("turn_interrupted"),
    turn: z.number().int().positive(),
    commandId: z.string().min(1),
  }),
  z.strictObject({ kind: z.literal("turn_completed"), turn: z.number().int().positive() }),
  z.strictObject({
    kind: z.literal("turn_failed"),
    turn: z.number().int().positive(),
    retryable: z.boolean(),
    message: z.string(),
  }),
]);
export type AgentStreamEvent = z.infer<typeof agentStreamEventSchema>;

export const agentControlSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("queue"),
    commandId: z.string().min(1),
    text: z.string().trim().min(1).max(3_000),
    responseContext: agentResponseContextSchema.optional(),
    sourceReference: agentControlSourceReferenceSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("redirect"),
    commandId: z.string().min(1),
    text: z.string().trim().min(1).max(3_000),
    responseContext: agentResponseContextSchema.optional(),
    sourceReference: agentControlSourceReferenceSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("cancel"),
    commandId: z.string().min(1),
    reason: z.string().trim().min(1).max(3_000).optional(),
    responseContext: agentResponseContextSchema.optional(),
    sourceReference: agentControlSourceReferenceSchema.optional(),
  }),
]);
export type AgentControl = z.infer<typeof agentControlSchema>;

export type AgentEventSink = {
  publish(event: AgentStreamEvent): Promise<void>;
};

export class AgentExecutionError extends Error {
  public constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly code:
      | "cancelled"
      | "authentication"
      | "invalid_request"
      | "invalid_response"
      | "session_unavailable"
      | "provider_unavailable"
      | "provider_failed",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AgentExecutionError";
  }
}

export type AgentHarness = {
  readonly kind: "claude" | "codex";
  execute(
    request: AgentExecutionRequest,
    events: AgentEventSink,
    controls: AsyncIterable<AgentControl>,
    signal: AbortSignal,
  ): Promise<AgentExecutionResult>;
};

export const discardAgentEvents: AgentEventSink = {
  publish: () => Promise.resolve(),
};

export function noAgentControls(): AsyncIterable<AgentControl> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.resolve({ done: true, value: undefined }),
    }),
  };
}
