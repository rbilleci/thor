import type {
  Query,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ThreadEvent } from "@openai/codex-sdk";
import { executionPackageSchema } from "@thor/domain";
import { describe, expect, it } from "vitest";

import { ClaudeHarness } from "./claude.js";
import { CodexHarness, type CodexThread } from "./codex.js";
import { AgentControlQueue } from "./control-queue.js";
import type {
  AgentControl,
  AgentEventSink,
  AgentExecutionRequest,
  AgentStreamEvent,
} from "./types.js";

describe("CodexHarness streaming", () => {
  it("normalizes visible events and returns the terminal response", async () => {
    const events: AgentStreamEvent[] = [];
    const harness = new CodexHarness({
      threadFactory: () => codexThread([completedCodexTurn("done")]),
    });

    const result = await harness.execute(
      request("codex"),
      collectingSink(events),
      emptyControls(),
      new AbortController().signal,
    );

    expect(result.finalResponse).toBe("done");
    expect(result.sessionId).toBe("codex-session");
    expect(events.map((event) => event.kind)).toEqual([
      "session_started",
      "turn_started",
      "assistant_completed",
      "usage",
      "turn_completed",
    ]);
  });

  it("queues guidance for the next turn on the same thread", async () => {
    const controls = new AgentControlQueue();
    const prompts: string[] = [];
    let queued = false;
    const harness = new CodexHarness({
      threadFactory: () =>
        codexThread([completedCodexTurn("first"), completedCodexTurn("second")], prompts),
    });
    const result = await harness.execute(
      request("codex"),
      {
        publish: (event) => {
          if (event.kind === "turn_started" && !queued) {
            queued = true;
            controls.push({ kind: "queue", commandId: "command-1", text: "run tests" });
          }
          return Promise.resolve();
        },
      },
      controls,
      new AbortController().signal,
    );

    expect(result.finalResponse).toBe("second");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("run tests");
  });

  it("aborts a turn for redirect and continues on the same thread", async () => {
    const controls = new AgentControlQueue();
    const prompts: string[] = [];
    let redirected = false;
    const harness = new CodexHarness({
      threadFactory: () => redirectingCodexThread(prompts),
    });
    const events: AgentStreamEvent[] = [];
    const result = await harness.execute(
      request("codex"),
      {
        publish: (event) => {
          events.push(event);
          if (event.kind === "turn_started" && !redirected) {
            redirected = true;
            controls.push({ kind: "redirect", commandId: "command-2", text: "use helper" });
          }
          return Promise.resolve();
        },
      },
      controls,
      new AbortController().signal,
    );

    expect(result.finalResponse).toBe("redirected");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("use helper");
    expect(events).toContainEqual({ kind: "turn_interrupted", turn: 1, commandId: "command-2" });
  });

  it("cancels the active turn without retrying it", async () => {
    const controls = new AgentControlQueue();
    const harness = new CodexHarness({
      threadFactory: () => redirectingCodexThread([]),
    });
    await expect(
      harness.execute(
        request("codex"),
        {
          publish: (event) => {
            if (event.kind === "turn_started") {
              controls.push({ kind: "cancel", commandId: "command-cancel" });
            }
            return Promise.resolve();
          },
        },
        controls,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "cancelled", retryable: false });
  });

  it("distinguishes an unavailable resumed session from a provider outage", async () => {
    const harness = new CodexHarness({
      threadFactory: () => ({
        id: "stale-codex-session",
        runStreamed: () => Promise.reject(new Error("No rollout found for thread ID stale")),
      }),
    });

    await expect(
      harness.execute(
        { ...request("codex"), resumeSessionId: "stale-codex-session" },
        collectingSink([]),
        emptyControls(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "session_unavailable", retryable: true });
  });

  it("replays and completes a checkpointed control on the recovery turn", async () => {
    const prompts: string[] = [];
    const events: AgentStreamEvent[] = [];
    const harness = new CodexHarness({
      threadFactory: () => codexThread([completedCodexTurn("recovered")], prompts),
    });

    await harness.execute(
      {
        ...request("codex"),
        recoveryControls: [
          { kind: "queue", commandId: "command-recover", text: "run the integration suite" },
        ],
      },
      collectingSink(events),
      emptyControls(),
      new AbortController().signal,
    );

    expect(prompts[0]).toContain("run the integration suite");
    expect(events).toContainEqual({ kind: "control_completed", commandId: "command-recover" });
  });
});

describe("ClaudeHarness streaming", () => {
  it("normalizes assistant output and usage", async () => {
    const events: AgentStreamEvent[] = [];
    const harness = new ClaudeHarness({
      queryFactory: () => claudeQuery(singleClaudeTurn("done")),
    });

    const result = await harness.execute(
      request("claude"),
      collectingSink(events),
      emptyControls(),
      new AbortController().signal,
    );

    expect(result.finalResponse).toBe("done");
    expect(result.sessionId).toBe("claude-session");
    expect(events.map((event) => event.kind)).toEqual([
      "turn_started",
      "session_started",
      "assistant_completed",
      "usage",
      "turn_completed",
    ]);
  });

  it("queues guidance at the next result boundary", async () => {
    const controls = new AgentControlQueue();
    const prompts: string[] = [];
    let queued = false;
    const harness = new ClaudeHarness({
      queryFactory: ({ prompt }) => {
        if (typeof prompt === "string") throw new Error("streaming input was not enabled");
        return claudeQuery(twoClaudeTurns(prompt, prompts));
      },
    });
    const result = await harness.execute(
      request("claude"),
      {
        publish: (event) => {
          if (event.kind === "turn_started" && !queued) {
            queued = true;
            controls.push({ kind: "queue", commandId: "command-3", text: "verify again" });
          }
          return Promise.resolve();
        },
      },
      controls,
      new AbortController().signal,
    );

    expect(result.finalResponse).toBe("second");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("verify again");
  });

  it("interrupts and continues a redirected streaming-input session", async () => {
    const controls = new AgentControlQueue();
    const prompts: string[] = [];
    let interrupt: (() => void) | undefined;
    let redirected = false;
    const harness = new ClaudeHarness({
      queryFactory: ({ prompt }) => {
        if (typeof prompt === "string") throw new Error("streaming input was not enabled");
        const interrupted = deferred();
        interrupt = interrupted.resolve;
        return claudeQuery(redirectedClaudeTurns(prompt, prompts, interrupted.promise), () => {
          interrupted.resolve();
        });
      },
    });
    const events: AgentStreamEvent[] = [];
    const result = await harness.execute(
      request("claude"),
      {
        publish: (event) => {
          events.push(event);
          if (event.kind === "turn_started" && !redirected) {
            redirected = true;
            controls.push({ kind: "redirect", commandId: "command-4", text: "change direction" });
          }
          return Promise.resolve();
        },
      },
      controls,
      new AbortController().signal,
    );

    expect(interrupt).toBeDefined();
    expect(result.finalResponse).toBe("redirected");
    expect(prompts[1]).toContain("change direction");
    expect(events).toContainEqual({ kind: "turn_interrupted", turn: 1, commandId: "command-4" });
  });

  it("closes the query when cancelled", async () => {
    const controls = new AgentControlQueue();
    let closed = false;
    const harness = new ClaudeHarness({
      queryFactory: () =>
        claudeQuery(waitingClaudeTurn(), undefined, () => {
          closed = true;
        }),
    });
    await expect(
      harness.execute(
        request("claude"),
        {
          publish: (event) => {
            if (event.kind === "turn_started") {
              controls.push({ kind: "cancel", commandId: "command-cancel" });
            }
            return Promise.resolve();
          },
        },
        controls,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "cancelled", retryable: false });
    expect(closed).toBe(true);
  });

  it("distinguishes an unavailable resumed session from a provider outage", async () => {
    const harness = new ClaudeHarness({
      queryFactory: () => claudeQuery(failedClaudeTurn(new Error("Session not found for resume"))),
    });

    await expect(
      harness.execute(
        { ...request("claude"), resumeSessionId: "stale-claude-session" },
        collectingSink([]),
        emptyControls(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "session_unavailable", retryable: true });
  });

  it("replays and completes a checkpointed control on the recovery turn", async () => {
    const prompts: string[] = [];
    const events: AgentStreamEvent[] = [];
    const harness = new ClaudeHarness({
      queryFactory: ({ prompt }) => {
        if (typeof prompt === "string") throw new Error("streaming input was not enabled");
        return claudeQuery(captureSingleClaudeTurn(prompt, prompts, "recovered"));
      },
    });

    await harness.execute(
      {
        ...request("claude"),
        recoveryControls: [
          { kind: "redirect", commandId: "command-recover", text: "inspect the retry helper" },
        ],
      },
      collectingSink(events),
      emptyControls(),
      new AbortController().signal,
    );

    expect(prompts[0]).toContain("inspect the retry helper");
    expect(events).toContainEqual({ kind: "control_completed", commandId: "command-recover" });
  });
});

function request(harness: "claude" | "codex"): AgentExecutionRequest {
  const digest = "a".repeat(64);
  return {
    package: executionPackageSchema.parse({
      executionId: `execution-${harness}`,
      agentProfile: "builder",
      agentProfileDigest: digest,
      harness,
      purpose: { kind: "blueprint" },
      prompt: "Complete the ticket",
      promptDigest: digest,
      agentsMd: "Follow the project instructions",
      agentsMdDigest: digest,
      skills: [
        {
          name: "test",
          version: "1",
          path: "/tmp/test-skill",
          digest,
          content: "Test skill",
          selectionReason: "test",
        },
      ],
      configuration: {},
      configurationDigest: digest,
      digest,
    }),
    workspace: "/tmp/repository",
  };
}

function collectingSink(events: AgentStreamEvent[]): AgentEventSink {
  return {
    publish: (event) => {
      events.push(event);
      return Promise.resolve();
    },
  };
}

function emptyControls(): AsyncIterable<AgentControl> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.resolve({ done: true, value: undefined }),
    }),
  };
}

function codexThread(turns: ThreadEvent[][], prompts: string[] = []): CodexThread {
  let index = 0;
  return {
    id: "codex-session",
    runStreamed: (prompt) => {
      prompts.push(prompt);
      const events = turns[index] ?? [];
      index += 1;
      return Promise.resolve({ events: arrayGenerator(events) });
    },
  };
}

function redirectingCodexThread(prompts: string[]): CodexThread {
  let turn = 0;
  return {
    id: "codex-session",
    runStreamed: (prompt, options) => {
      prompts.push(prompt);
      turn += 1;
      if (turn === 1) {
        return Promise.resolve({ events: interruptedCodexTurn(options?.signal) });
      }
      return Promise.resolve({ events: arrayGenerator(completedCodexTurn("redirected")) });
    },
  };
}

function completedCodexTurn(text: string): ThreadEvent[] {
  return [
    { type: "thread.started", thread_id: "codex-session" },
    { type: "turn.started" },
    { type: "item.started", item: { id: "message-1", type: "agent_message", text: "" } },
    { type: "item.completed", item: { id: "message-1", type: "agent_message", text } },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 10,
        cached_input_tokens: 2,
        cache_write_input_tokens: 0,
        output_tokens: 4,
        reasoning_output_tokens: 1,
      },
    },
  ];
}

async function* interruptedCodexTurn(signal: AbortSignal | undefined): AsyncGenerator<ThreadEvent> {
  yield { type: "thread.started", thread_id: "codex-session" };
  yield { type: "turn.started" };
  await waitForAbort(signal);
}

async function* arrayGenerator(values: ThreadEvent[]): AsyncGenerator<ThreadEvent> {
  for (const value of values) {
    yield value;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function claudeQuery(
  messages: AsyncGenerator<SDKMessage>,
  interrupt?: () => void,
  close: () => void = () => undefined,
): Query {
  return Object.assign(messages, {
    interrupt: () => {
      interrupt?.();
      return Promise.resolve(undefined);
    },
    close,
  }) as Query;
}

async function* waitingClaudeTurn(): AsyncGenerator<SDKMessage> {
  await new Promise<void>(() => undefined);
  yield assistantMessage("unreachable");
}

async function* failedClaudeTurn(error: Error): AsyncGenerator<SDKMessage> {
  await Promise.resolve();
  if (error.message.length > 0) throw error;
  yield assistantMessage("unreachable");
}

async function* singleClaudeTurn(text: string): AsyncGenerator<SDKMessage> {
  yield assistantMessage(text);
  await Promise.resolve();
  yield successResult(text);
}

async function* captureSingleClaudeTurn(
  input: AsyncIterable<SDKUserMessage>,
  prompts: string[],
  text: string,
): AsyncGenerator<SDKMessage> {
  const iterator = input[Symbol.asyncIterator]();
  prompts.push(userText(await iterator.next()));
  yield assistantMessage(text);
  yield successResult(text);
}

async function* twoClaudeTurns(
  input: AsyncIterable<SDKUserMessage>,
  prompts: string[],
): AsyncGenerator<SDKMessage> {
  const iterator = input[Symbol.asyncIterator]();
  prompts.push(userText(await iterator.next()));
  yield assistantMessage("first");
  yield successResult("first");
  prompts.push(userText(await iterator.next()));
  yield assistantMessage("second");
  yield successResult("second");
}

async function* redirectedClaudeTurns(
  input: AsyncIterable<SDKUserMessage>,
  prompts: string[],
  interrupted: Promise<void>,
): AsyncGenerator<SDKMessage> {
  const iterator = input[Symbol.asyncIterator]();
  prompts.push(userText(await iterator.next()));
  yield assistantMessage("working");
  await interrupted;
  yield successResult("interrupted");
  prompts.push(userText(await iterator.next()));
  yield assistantMessage("redirected");
  yield successResult("redirected");
}

function assistantMessage(text: string): SDKMessage {
  return {
    type: "assistant",
    message: {
      id: "msg_test",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text, citations: null }],
      model: "claude-test",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    parent_tool_use_id: null,
    uuid: "assistant-uuid",
    session_id: "claude-session",
  } as unknown as SDKMessage;
}

function successResult(text: string): SDKResultMessage {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: text,
    stop_reason: "end_turn",
    total_cost_usd: 0.01,
    usage: {
      input_tokens: 2,
      output_tokens: 3,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 1,
      cache_creation: {},
      fallback_credit: {},
      inference_geo: "test",
      iterations: [],
      output_tokens_details: {},
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      service_tier: "standard",
      speed: "standard",
    },
    modelUsage: {},
    permission_denials: [],
    uuid: "result-uuid",
    session_id: "claude-session",
  } as unknown as SDKResultMessage;
}

function userText(result: IteratorResult<SDKUserMessage>): string {
  if (result.done) throw new Error("Claude input ended unexpectedly");
  const content = result.value.message.content;
  if (typeof content !== "string") throw new Error("expected text Claude input");
  return content;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function waitForAbort(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (signal?.aborted === true) {
      reject(new Error("aborted"));
      return;
    }
    signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}
