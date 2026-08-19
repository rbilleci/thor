import {
  query,
  type Options,
  type PermissionMode,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { normalizeProviderError, parseStructuredResponse } from "./errors.js";
import { assembledUserPrompt } from "./prompt.js";
import {
  AgentExecutionError,
  agentControlSchema,
  agentStreamEventSchema,
  type AgentControl,
  type AgentEventSink,
  type AgentExecutionRequest,
  type AgentExecutionResult,
  type AgentHarness,
  type AgentStreamEvent,
  type AgentUsage,
} from "./types.js";

type ClaudeQueryFactory = (parameters: Parameters<typeof query>[0]) => Query;

export type ClaudeHarnessOptions = {
  environment?: Readonly<Record<string, string | undefined>>;
  pathToClaudeCodeExecutable?: string;
  queryFactory?: ClaudeQueryFactory;
};

type MessageRace =
  | { source: "message"; result: IteratorResult<SDKMessage> }
  | { source: "message_error"; error: unknown };
type ControlRace =
  | { source: "control"; result: IteratorResult<AgentControl> }
  | { source: "control_error"; error: unknown };

const neverControl = new Promise<ControlRace>(() => undefined);

export class ClaudeHarness implements AgentHarness {
  public readonly kind = "claude" as const;
  private readonly queryFactory: ClaudeQueryFactory;

  public constructor(private readonly harnessOptions: ClaudeHarnessOptions = {}) {
    this.queryFactory = harnessOptions.queryFactory ?? query;
  }

  public async execute(
    request: AgentExecutionRequest,
    events: AgentEventSink,
    controls: AsyncIterable<AgentControl>,
    signal: AbortSignal,
  ): Promise<AgentExecutionResult> {
    const abortController = new AbortController();
    const abort = (): void => abortController.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();

    const input = new ClaudeInputQueue();
    input.push(userMessage(assembledUserPrompt(request.package, request.recoveryControls), "next"));
    const controlIterator = controls[Symbol.asyncIterator]();
    let pendingControl: Promise<ControlRace> = controlResult(controlIterator.next());
    let activeQuery: Query | undefined;
    try {
      const claudeQuery = this.queryFactory({
        prompt: input,
        options: claudeOptions(request, abortController, this.harnessOptions),
      });
      activeQuery = claudeQuery;
      const messageIterator = claudeQuery[Symbol.asyncIterator]();
      let pendingMessage = messageResult(messageIterator.next());
      const queued: Extract<AgentControl, { kind: "queue" }>[] = [];
      let redirect: Extract<AgentControl, { kind: "redirect" }> | undefined;
      let turn = 1;
      let sessionId = request.resumeSessionId;
      let sessionPublished = false;
      let activeControlCommandIds = (request.recoveryControls ?? []).map(
        (control) => control.commandId,
      );
      let terminal: Extract<SDKResultMessage, { subtype: "success" }> | undefined;
      const streamState: ClaudeStreamState = { assistantItemId: `claude-turn-${turn}` };

      if (sessionId !== undefined) {
        await publish(events, { kind: "session_started", providerSessionId: sessionId });
        sessionPublished = true;
      }
      await publish(events, { kind: "turn_started", turn });

      for (;;) {
        const winner = await Promise.race([pendingMessage, pendingControl]);
        switch (winner.source) {
          case "message": {
            if (winner.result.done) {
              throw new Error("Claude Agent SDK ended without a result message");
            }
            const message = winner.result.value;
            pendingMessage = messageResult(messageIterator.next());
            if (!sessionPublished && message.session_id !== undefined) {
              sessionId = message.session_id;
              await publish(events, {
                kind: "session_started",
                providerSessionId: message.session_id,
              });
              sessionPublished = true;
            }

            if (message.type !== "result") {
              for (const event of normalizeClaudeMessage(message, streamState)) {
                await publish(events, event);
              }
              break;
            }

            if (redirect !== undefined) {
              const control = redirect;
              redirect = undefined;
              await publishCompletedControls(events, activeControlCommandIds);
              activeControlCommandIds = [control.commandId];
              turn += 1;
              streamState.assistantItemId = `claude-turn-${turn}`;
              await publish(events, { kind: "turn_started", turn });
              input.push(userMessage(guidancePrompt(control), "now"));
              break;
            }

            if (message.subtype !== "success") {
              const messageText = `Claude Agent SDK failed: ${message.errors.join("; ")}`;
              const normalized = normalizeProviderError(new Error(messageText), signal, {
                resumingSession: request.resumeSessionId !== undefined,
              });
              const failure =
                normalized.code === "session_unavailable"
                  ? normalized
                  : new AgentExecutionError(
                      messageText,
                      message.subtype === "error_during_execution",
                      "provider_failed",
                    );
              await publish(events, {
                kind: "turn_failed",
                turn,
                retryable: failure.retryable,
                message: failure.message,
              });
              throw failure;
            }

            terminal = message;
            await publish(events, { kind: "usage", usage: claudeUsage(message) });
            await publish(events, { kind: "turn_completed", turn });
            await publishCompletedControls(events, activeControlCommandIds);
            const next = queued.shift();
            if (next !== undefined) {
              activeControlCommandIds = [next.commandId];
              turn += 1;
              streamState.assistantItemId = `claude-turn-${turn}`;
              await publish(events, { kind: "turn_started", turn });
              input.push(userMessage(guidancePrompt(next), "next"));
              break;
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
              ...(sessionId === undefined ? {} : { sessionId }),
              packageDigest: request.package.digest,
              usage: claudeUsage(terminal),
            };
          }
          case "message_error":
            throw winner.error;
          case "control": {
            if (winner.result.done) {
              pendingControl = neverControl;
              break;
            }
            const control = agentControlSchema.parse(winner.result.value);
            pendingControl = controlResult(controlIterator.next());
            await publish(events, {
              kind: "control_applied",
              commandId: control.commandId,
              mode: control.kind,
              ...(control.responseContext === undefined
                ? {}
                : { responseContext: control.responseContext }),
              ...(control.sourceReference === undefined
                ? {}
                : { sourceReference: control.sourceReference }),
            });
            if (control.kind === "cancel") {
              abortController.abort(new Error(control.reason ?? "cancelled by Slack command"));
              claudeQuery.close();
              throw new AgentExecutionError(
                control.reason ?? "agent execution cancelled by Slack command",
                false,
                "cancelled",
              );
            }
            if (control.kind === "redirect") {
              redirect = control;
              await publish(events, {
                kind: "turn_interrupted",
                turn,
                commandId: control.commandId,
              });
              await claudeQuery.interrupt();
            } else {
              queued.push(control);
            }
            break;
          }
          case "control_error":
            throw winner.error;
        }
      }
    } catch (error) {
      throw error instanceof AgentExecutionError
        ? error
        : normalizeProviderError(error, signal, {
            resumingSession: request.resumeSessionId !== undefined,
          });
    } finally {
      input.close();
      activeQuery?.close();
      await controlIterator.return?.();
      signal.removeEventListener("abort", abort);
    }
  }
}

async function publishCompletedControls(
  events: AgentEventSink,
  commandIds: string[],
): Promise<void> {
  for (const commandId of commandIds) {
    await publish(events, { kind: "control_completed", commandId });
  }
  commandIds.length = 0;
}

type WaitingInput = {
  resolve(result: IteratorResult<SDKUserMessage>): void;
};

class ClaudeInputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly queued: SDKUserMessage[] = [];
  private readonly waiting: WaitingInput[] = [];
  private closed = false;
  private iteratorCreated = false;

  public push(message: SDKUserMessage): void {
    if (this.closed) throw new Error("Claude input stream is closed");
    const consumer = this.waiting.shift();
    if (consumer === undefined) this.queued.push(message);
    else consumer.resolve({ done: false, value: message });
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const consumer of this.waiting.splice(0))
      consumer.resolve({ done: true, value: undefined });
  }

  public [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    if (this.iteratorCreated) throw new Error("ClaudeInputQueue supports one consumer");
    this.iteratorCreated = true;
    return {
      next: () => this.next(),
      return: () => {
        this.close();
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  }

  private next(): Promise<IteratorResult<SDKUserMessage>> {
    const message = this.queued.shift();
    if (message !== undefined) return Promise.resolve({ done: false, value: message });
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.waiting.push({ resolve }));
  }
}

type ClaudeStreamState = {
  assistantItemId: string;
};

function normalizeClaudeMessage(
  message: Exclude<SDKMessage, SDKResultMessage>,
  state: ClaudeStreamState,
): AgentStreamEvent[] {
  if (message.type === "stream_event") {
    if (message.event.type === "message_start") {
      state.assistantItemId = message.event.message.id;
      return [];
    }
    if (message.event.type === "content_block_delta" && message.event.delta.type === "text_delta") {
      return [
        {
          kind: "assistant_delta",
          itemId: state.assistantItemId,
          text: message.event.delta.text,
        },
      ];
    }
    return [];
  }

  if (message.type === "assistant") {
    const result: AgentStreamEvent[] = [];
    const text = message.message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (text.length > 0) {
      result.push({
        kind: "assistant_completed",
        itemId: message.message.id,
        text,
      });
    }
    for (const block of message.message.content) {
      if (block.type === "tool_use") {
        result.push({
          kind: "tool_updated",
          itemId: block.id,
          tool: block.name,
          status: "started",
        });
      }
    }
    return result;
  }

  if (message.type === "tool_progress") {
    return [
      {
        kind: "tool_updated",
        itemId: message.tool_use_id,
        tool: message.tool_name,
        status: "running",
        summary: `${message.elapsed_time_seconds}s elapsed`,
      },
    ];
  }

  if (message.type === "tool_use_summary") {
    return message.preceding_tool_use_ids.map((itemId) => ({
      kind: "tool_updated" as const,
      itemId,
      tool: "tool",
      status: "completed" as const,
      summary: message.summary,
    }));
  }

  if (message.type === "user" && Array.isArray(message.message.content)) {
    return message.message.content.flatMap((block) =>
      block.type === "tool_result"
        ? [
            {
              kind: "tool_updated" as const,
              itemId: block.tool_use_id,
              tool: "tool",
              status: block.is_error === true ? ("failed" as const) : ("completed" as const),
            },
          ]
        : [],
    );
  }

  return [];
}

function userMessage(text: string, priority: "now" | "next"): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    priority,
    origin: { kind: "human" },
  };
}

function guidancePrompt(control: Exclude<AgentControl, { kind: "cancel" }>): string {
  return [
    `Authorized human guidance (${control.kind}, command ${control.commandId}):`,
    control.text,
    "Continue the existing ticket execution. Preserve the required structured output schema.",
  ].join("\n\n");
}

function messageResult(promise: Promise<IteratorResult<SDKMessage>>): Promise<MessageRace> {
  return promise.then(
    (result) => ({ source: "message", result }),
    (error: unknown) => ({ source: "message_error", error }),
  );
}

function controlResult(promise: Promise<IteratorResult<AgentControl>>): Promise<ControlRace> {
  return promise.then(
    (result) => ({ source: "control", result }),
    (error: unknown) => ({ source: "control_error", error }),
  );
}

async function publish(events: AgentEventSink, event: AgentStreamEvent): Promise<void> {
  await events.publish(agentStreamEventSchema.parse(event));
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
    includePartialMessages: true,
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
