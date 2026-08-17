import { Codex, type CodexOptions, type ThreadOptions } from "@openai/codex-sdk";

import { assembledUserPrompt } from "./prompt.js";
import { normalizeProviderError, parseStructuredResponse } from "./errors.js";
import type {
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentHarness,
  AgentUsage,
} from "./types.js";

export type CodexHarnessOptions = {
  apiKey?: string;
  codexPathOverride?: string;
  environment?: Readonly<Record<string, string>>;
};

export class CodexHarness implements AgentHarness {
  public readonly kind = "codex" as const;
  private readonly codex: Codex;

  public constructor(options: CodexHarnessOptions = {}) {
    const codexOptions: CodexOptions = {
      // Thor supplies the audited harness instructions explicitly in every execution package.
      // Disable Codex's additional repository AGENTS.md discovery so those instructions cannot
      // change independently of the recorded package digest.
      config: { project_doc_max_bytes: 0 },
    };
    if (options.apiKey !== undefined) codexOptions.apiKey = options.apiKey;
    if (options.codexPathOverride !== undefined) {
      codexOptions.codexPathOverride = options.codexPathOverride;
    }
    if (options.environment !== undefined) codexOptions.env = { ...options.environment };
    this.codex = new Codex(codexOptions);
  }

  public async execute(
    request: AgentExecutionRequest,
    signal: AbortSignal,
  ): Promise<AgentExecutionResult> {
    try {
      const options = codexThreadOptions(request);
      const thread =
        request.resumeSessionId === undefined
          ? this.codex.startThread(options)
          : this.codex.resumeThread(request.resumeSessionId, options);
      const result = await thread.run(assembledUserPrompt(request.package), {
        signal,
        ...(request.outputSchema === undefined ? {} : { outputSchema: request.outputSchema }),
      });
      const structuredOutput = parseStructuredResponse(
        undefined,
        result.finalResponse,
        request.outputSchema !== undefined,
      );
      return {
        executionId: request.package.executionId,
        harness: this.kind,
        finalResponse: result.finalResponse,
        ...(structuredOutput === undefined ? {} : { structuredOutput }),
        ...(thread.id === null ? {} : { sessionId: thread.id }),
        packageDigest: request.package.digest,
        usage: codexUsage(result.usage),
      };
    } catch (error) {
      throw normalizeProviderError(error, signal);
    }
  }
}

function codexThreadOptions(request: AgentExecutionRequest): ThreadOptions {
  const config = request.package.configuration;
  const model = config.model;
  const configuredSandboxMode = parseEnum(config.sandboxMode, [
    "read-only",
    "workspace-write",
    "danger-full-access",
  ] as const);
  const sandboxMode = isReadOnlyPurpose(request)
    ? "read-only"
    : (configuredSandboxMode ?? "workspace-write");
  const approvalPolicy = parseEnum(config.approvalPolicy, [
    "never",
    "on-request",
    "on-failure",
    "untrusted",
  ] as const);
  return {
    workingDirectory: request.workspace,
    skipGitRepoCheck: false,
    networkAccessEnabled: config.networkAccessEnabled === "true",
    ...(model === undefined || model === "null" ? {} : { model }),
    sandboxMode,
    ...(approvalPolicy === undefined ? {} : { approvalPolicy }),
  };
}

function isReadOnlyPurpose(request: AgentExecutionRequest): boolean {
  return (
    request.package.purpose.kind === "blueprint" ||
    request.package.purpose.kind === "review" ||
    request.package.purpose.kind === "synthesis"
  );
}

function codexUsage(
  usage: {
    input_tokens: number;
    cached_input_tokens: number;
    cache_write_input_tokens: number;
    output_tokens: number;
    reasoning_output_tokens: number;
  } | null,
): AgentUsage {
  if (usage === null) return {};
  return {
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.cached_input_tokens,
    outputTokens: usage.output_tokens,
    reasoningOutputTokens: usage.reasoning_output_tokens,
  };
}

function parseEnum<const Values extends readonly string[]>(
  value: string | undefined,
  values: Values,
): Values[number] | undefined {
  return values.find((candidate) => candidate === value);
}
