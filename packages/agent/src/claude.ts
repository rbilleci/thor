import {
  query,
  type Options,
  type PermissionMode,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { normalizeProviderError, parseStructuredResponse } from "./errors.js";
import { assembledUserPrompt } from "./prompt.js";
import type {
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentHarness,
  AgentUsage,
} from "./types.js";

export type ClaudeHarnessOptions = {
  environment?: Readonly<Record<string, string | undefined>>;
  pathToClaudeCodeExecutable?: string;
};

export class ClaudeHarness implements AgentHarness {
  public readonly kind = "claude" as const;

  public constructor(private readonly harnessOptions: ClaudeHarnessOptions = {}) {}

  public async execute(
    request: AgentExecutionRequest,
    signal: AbortSignal,
  ): Promise<AgentExecutionResult> {
    const abortController = new AbortController();
    const abort = (): void => abortController.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      let terminal: SDKResultMessage | undefined;
      for await (const message of query({
        prompt: assembledUserPrompt(request.package),
        options: claudeOptions(request, abortController, this.harnessOptions),
      })) {
        if (message.type === "result") terminal = message;
      }
      if (terminal === undefined) {
        throw new Error("Claude Agent SDK ended without a result message");
      }
      if (terminal.subtype !== "success") {
        throw new Error(`Claude Agent SDK failed: ${terminal.errors.join("; ")}`);
      }
      const structuredOutput = parseStructuredResponse(
        terminal.structured_output,
        terminal.result,
        request.outputSchema !== undefined,
      );
      return {
        executionId: request.package.executionId,
        harness: this.kind,
        finalResponse: terminal.result,
        ...(structuredOutput === undefined ? {} : { structuredOutput }),
        sessionId: terminal.session_id,
        packageDigest: request.package.digest,
        usage: claudeUsage(terminal),
      };
    } catch (error) {
      throw normalizeProviderError(error, signal);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
}

function claudeOptions(
  request: AgentExecutionRequest,
  abortController: AbortController,
  harnessOptions: ClaudeHarnessOptions,
): Options {
  const config = request.package.configuration;
  const permissionMode = phasePermissionMode(request, config.permissionMode);
  const maxTurns = parsePositiveInteger(config.maxTurns, 80);
  return {
    abortController,
    cwd: request.workspace,
    maxTurns,
    permissionMode,
    // Project/user settings are excluded so every instruction source is in the audited package.
    settingSources: [],
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: request.package.agentsMd,
    },
    ...(config.model === undefined || config.model === "null" ? {} : { model: config.model }),
    ...(request.resumeSessionId === undefined ? {} : { resume: request.resumeSessionId }),
    ...(request.outputSchema === undefined
      ? {}
      : { outputFormat: { type: "json_schema" as const, schema: request.outputSchema } }),
    ...(harnessOptions.environment === undefined ? {} : { env: { ...harnessOptions.environment } }),
    ...(harnessOptions.pathToClaudeCodeExecutable === undefined
      ? {}
      : { pathToClaudeCodeExecutable: harnessOptions.pathToClaudeCodeExecutable }),
  };
}

function phasePermissionMode(
  request: AgentExecutionRequest,
  configured: string | undefined,
): PermissionMode {
  if (
    request.package.purpose.kind === "blueprint" ||
    request.package.purpose.kind === "review" ||
    request.package.purpose.kind === "synthesis"
  ) {
    return "plan";
  }
  const supported: PermissionMode[] = ["default", "acceptEdits", "plan", "dontAsk"];
  return supported.find((mode) => mode === configured) ?? "acceptEdits";
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function claudeUsage(result: Extract<SDKResultMessage, { subtype: "success" }>): AgentUsage {
  return {
    inputTokens: result.usage.input_tokens,
    outputTokens: result.usage.output_tokens,
    cachedInputTokens: result.usage.cache_read_input_tokens,
    estimatedCostUsd: result.total_cost_usd,
  };
}
