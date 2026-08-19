import {
  Codex,
  type CodexOptions,
  type ThreadEvent,
  type ThreadOptions,
  type Usage,
} from "@openai/codex-sdk";

import { normalizeProviderError, parseStructuredResponse } from "./errors.js";
import { assembledUserPrompt } from "./prompt.js";
import {
  AgentExecutionError,
  agentControlSchema,
  agentStreamEventSchema,
  type AgentActionStatus,
  type AgentControl,
  type AgentEventSink,
  type AgentExecutionRequest,
  type AgentExecutionResult,
  type AgentHarness,
  type AgentStreamEvent,
  type AgentUsage,
} from "./types.js";

export type CodexThread = {
  readonly id: string | null;
  runStreamed(
    input: string,
    options?: { outputSchema?: unknown; signal?: AbortSignal },
  ): Promise<{ events: AsyncGenerator<ThreadEvent> }>;
};

export type CodexHarnessOptions = {
  apiKey?: string;
  codexPathOverride?: string;
  environment?: Readonly<Record<string, string>>;
  threadFactory?: (request: AgentExecutionRequest, options: ThreadOptions) => CodexThread;
};

type EventRace =
  | { source: "event"; result: IteratorResult<ThreadEvent> }
  | { source: "event_error"; error: unknown };
type ControlRace =
  | { source: "control"; result: IteratorResult<AgentControl> }
  | { source: "control_error"; error: unknown };

const neverControl = new Promise<ControlRace>(() => undefined);

export class CodexHarness implements AgentHarness {
  public readonly kind = "codex" as const;
  private readonly codex: Codex;
  private readonly threadFactory?: CodexHarnessOptions["threadFactory"];

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
    this.threadFactory = options.threadFactory;
  }

  public async execute(
    request: AgentExecutionRequest,
    events: AgentEventSink,
    controls: AsyncIterable<AgentControl>,
    signal: AbortSignal,
  ): Promise<AgentExecutionResult> {
    const controlIterator = controls[Symbol.asyncIterator]();
    let pendingControl: Promise<ControlRace> = controlResult(controlIterator.next());
    const queued: AgentControl[] = [];
    let redirect: Extract<AgentControl, { kind: "redirect" }> | undefined;
    let turn = 0;
    let finalResponse = "";
    let usage: AgentUsage = {};
    let sessionPublished = false;
    let activeControlCommandIds = (request.recoveryControls ?? []).map(
      (control) => control.commandId,
    );
    try {
      const options = codexThreadOptions(request);
      const thread =
        this.threadFactory === undefined
          ? request.resumeSessionId === undefined
            ? this.codex.startThread(options)
            : this.codex.resumeThread(request.resumeSessionId, options)
          : this.threadFactory(request, options);
      if (request.resumeSessionId !== undefined) {
        await publish(events, {
          kind: "session_started",
          providerSessionId: request.resumeSessionId,
        });
        sessionPublished = true;
      }
      let prompt = assembledUserPrompt(request.package, request.recoveryControls);

      for (;;) {
        turn += 1;
        const turnController = new AbortController();
        const turnSignal = AbortSignal.any([signal, turnController.signal]);
        let turnFailure: string | undefined;
        const assistantText = new Map<string, string>();
        try {
          const streamed = await thread.runStreamed(prompt, {
            signal: turnSignal,
            ...(request.outputSchema === undefined ? {} : { outputSchema: request.outputSchema }),
          });
          const eventIterator = streamed.events[Symbol.asyncIterator]();
          let pendingEvent = eventResult(eventIterator.next());
          let eventStreamDone = false;

          while (!eventStreamDone) {
            const winner = await Promise.race([pendingEvent, pendingControl]);
            switch (winner.source) {
              case "event": {
                if (winner.result.done) {
                  eventStreamDone = true;
                  break;
                }
                const normalized = normalizeCodexEvent(winner.result.value, turn, assistantText);
                for (const event of normalized.events) await publish(events, event);
                if (normalized.finalResponse !== undefined) {
                  finalResponse = normalized.finalResponse;
                }
                if (normalized.usage !== undefined) usage = addUsage(usage, normalized.usage);
                if (normalized.failure !== undefined) turnFailure = normalized.failure;
                if (winner.result.value.type === "thread.started" && !sessionPublished) {
                  sessionPublished = true;
                }
                pendingEvent = eventResult(eventIterator.next());
                break;
              }
              case "event_error":
                if (redirect === undefined && !signal.aborted) throw winner.error;
                eventStreamDone = true;
                break;
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
                  turnController.abort(new Error(control.reason ?? "cancelled by Slack command"));
                  await eventIterator.return(undefined);
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
                  turnController.abort(new Error("Codex turn redirected"));
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
          if (error instanceof AgentExecutionError) throw error;
          if (signal.aborted) throw normalizeProviderError(error, signal);
          if (redirect === undefined) {
            const normalized = normalizeProviderError(error, signal, {
              resumingSession: request.resumeSessionId !== undefined,
            });
            await publish(events, {
              kind: "turn_failed",
              turn,
              retryable: normalized.retryable,
              message: normalized.message,
            });
            throw normalized;
          }
        }

        if (signal.aborted) throw normalizeProviderError(signal.reason, signal);
        if (redirect !== undefined) {
          await publishCompletedControls(events, activeControlCommandIds);
          prompt = guidancePrompt(redirect);
          activeControlCommandIds = [redirect.commandId];
          redirect = undefined;
          continue;
        }
        const next = queued.shift();
        if (next !== undefined && next.kind !== "cancel") {
          await publishCompletedControls(events, activeControlCommandIds);
          prompt = guidancePrompt(next);
          activeControlCommandIds = [next.commandId];
          continue;
        }
        if (turnFailure !== undefined) {
          const failure = normalizeProviderError(new Error(turnFailure), signal, {
            resumingSession: request.resumeSessionId !== undefined,
          });
          await publish(events, {
            kind: "turn_failed",
            turn,
            retryable: failure.retryable,
            message: failure.message,
          });
          throw failure;
        }

        await publishCompletedControls(events, activeControlCommandIds);

        const structuredOutput = parseStructuredResponse(
          undefined,
          finalResponse,
          request.outputSchema !== undefined,
        );
        return {
          executionId: request.package.executionId,
          harness: this.kind,
          finalResponse,
          ...(structuredOutput === undefined ? {} : { structuredOutput }),
          ...(thread.id === null ? {} : { sessionId: thread.id }),
          packageDigest: request.package.digest,
          usage,
        };
      }
    } catch (error) {
      throw error instanceof AgentExecutionError
        ? error
        : normalizeProviderError(error, signal, {
            resumingSession: request.resumeSessionId !== undefined,
          });
    } finally {
      await controlIterator.return?.();
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

function normalizeCodexEvent(
  event: ThreadEvent,
  turn: number,
  assistantText: Map<string, string>,
): {
  events: AgentStreamEvent[];
  finalResponse?: string;
  usage?: AgentUsage;
  failure?: string;
} {
  switch (event.type) {
    case "thread.started":
      return {
        events: [{ kind: "session_started", providerSessionId: event.thread_id }],
      };
    case "turn.started":
      return { events: [{ kind: "turn_started", turn }] };
    case "turn.completed": {
      const usage = codexUsage(event.usage);
      return {
        events: [
          { kind: "usage", usage },
          { kind: "turn_completed", turn },
        ],
        usage,
      };
    }
    case "turn.failed":
      return { events: [], failure: event.error.message };
    case "error":
      return { events: [], failure: event.message };
    case "item.started":
    case "item.updated":
    case "item.completed":
      return normalizeCodexItem(event, assistantText);
  }
}

function normalizeCodexItem(
  event: Extract<ThreadEvent, { type: "item.started" | "item.updated" | "item.completed" }>,
  assistantText: Map<string, string>,
): { events: AgentStreamEvent[]; finalResponse?: string } {
  const item = event.item;
  const completed = event.type === "item.completed";
  switch (item.type) {
    case "agent_message": {
      if (completed) {
        assistantText.set(item.id, item.text);
        return {
          events: [{ kind: "assistant_completed", itemId: item.id, text: item.text }],
          finalResponse: item.text,
        };
      }
      const previous = assistantText.get(item.id) ?? "";
      const delta = item.text.startsWith(previous) ? item.text.slice(previous.length) : item.text;
      assistantText.set(item.id, item.text);
      return {
        events:
          delta.length === 0 ? [] : [{ kind: "assistant_delta", itemId: item.id, text: delta }],
      };
    }
    case "todo_list":
      return {
        events: [
          {
            kind: "plan_updated",
            itemId: item.id,
            items: item.items.map((todo) => ({ text: todo.text, completed: todo.completed })),
          },
        ],
      };
    case "command_execution":
      return {
        events: [
          {
            kind: "command_updated",
            itemId: item.id,
            command: item.command,
            status: actionStatus(item.status),
            ...(item.exit_code === undefined ? {} : { exitCode: item.exit_code }),
          },
        ],
      };
    case "file_change":
      return {
        events: [
          {
            kind: "file_change",
            itemId: item.id,
            changes: item.changes,
            status: item.status === "completed" ? "completed" : "failed",
          },
        ],
      };
    case "mcp_tool_call":
      return {
        events: [
          {
            kind: "tool_updated",
            itemId: item.id,
            tool: `${item.server}/${item.tool}`,
            status: actionStatus(item.status),
            ...(item.error === undefined ? {} : { summary: item.error.message }),
          },
        ],
      };
    case "web_search":
      return {
        events: [
          {
            kind: "web_search_updated",
            itemId: item.id,
            query: item.query,
            status: completed ? "completed" : "running",
          },
        ],
      };
    case "error":
      return {
        events: [
          {
            kind: "tool_updated",
            itemId: item.id,
            tool: "provider",
            status: "failed",
            summary: item.message,
          },
        ],
      };
    case "reasoning":
      return { events: [] };
  }
}

function actionStatus(status: "in_progress" | "completed" | "failed"): AgentActionStatus {
  switch (status) {
    case "in_progress":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
  }
}

function guidancePrompt(control: Exclude<AgentControl, { kind: "cancel" }>): string {
  return [
    `Authorized human guidance (${control.kind}, command ${control.commandId}):`,
    control.text,
    "Continue the existing ticket execution. Preserve the required structured output schema.",
  ].join("\n\n");
}

function eventResult(promise: Promise<IteratorResult<ThreadEvent>>): Promise<EventRace> {
  return promise.then(
    (result) => ({ source: "event", result }),
    (error: unknown) => ({ source: "event_error", error }),
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

function codexUsage(usage: Usage): AgentUsage {
  return {
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.cached_input_tokens,
    outputTokens: usage.output_tokens,
    reasoningOutputTokens: usage.reasoning_output_tokens,
  };
}

function addUsage(left: AgentUsage, right: AgentUsage): AgentUsage {
  return {
    ...addOptional(left, right, "inputTokens"),
    ...addOptional(left, right, "cachedInputTokens"),
    ...addOptional(left, right, "outputTokens"),
    ...addOptional(left, right, "reasoningOutputTokens"),
    ...addOptional(left, right, "estimatedCostUsd"),
  };
}

function addOptional<Key extends keyof AgentUsage>(
  left: AgentUsage,
  right: AgentUsage,
  key: Key,
): Partial<Record<Key, number>> {
  const leftValue = left[key];
  const rightValue = right[key];
  return leftValue === undefined && rightValue === undefined
    ? {}
    : ({ [key]: (leftValue ?? 0) + (rightValue ?? 0) } as Partial<Record<Key, number>>);
}

function parseEnum<const Values extends readonly string[]>(
  value: string | undefined,
  values: Values,
): Values[number] | undefined {
  return values.find((candidate) => candidate === value);
}
