import { z } from "zod";

import { executionIdSchema, executionPackageSchema, harnessKindSchema } from "@thor/domain";

export const agentExecutionRequestSchema = z.object({
  package: executionPackageSchema,
  workspace: z.string().trim().min(1),
  resumeSessionId: z.string().trim().min(1).optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
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

export class AgentExecutionError extends Error {
  public constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly code:
      | "cancelled"
      | "authentication"
      | "invalid_request"
      | "invalid_response"
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
  execute(request: AgentExecutionRequest, signal: AbortSignal): Promise<AgentExecutionResult>;
};
