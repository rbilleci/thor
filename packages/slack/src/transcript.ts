import type { AgentEventSink, AgentStreamEvent } from "@thor/agent";
import { redactKnownSecrets } from "@thor/domain";

import {
  SlackApiError,
  type SlackApi,
  type SlackMessageMetadata,
  type SlackStreamReference,
  type SlackTaskSurface,
  type SlackTimestamp,
  type SlackUserId,
  type SlackWorkspaceId,
} from "./types.js";

export type SlackTranscriptSinkOptions = {
  slack: SlackApi;
  surface: SlackTaskSurface;
  executionId: string;
  label: string;
  flushIntervalMilliseconds: number;
  maxCharacters?: number;
  initialMessage?: {
    messageTs: SlackTimestamp;
    text: string;
  };
  responseTo?: {
    threadTs: SlackTimestamp;
    recipientUserId: SlackUserId;
    recipientTeamId: SlackWorkspaceId;
  };
  checkpoint?: (details: SlackTranscriptCheckpoint) => void;
};

export type SlackTranscriptCheckpoint = {
  messageTs?: SlackTimestamp;
  lastItemId?: string;
  degraded: boolean;
};

type TranscriptEntry = { key: string; text: string; terminal: boolean };

export class SlackTranscriptSink implements AgentEventSink {
  private readonly entries = new Map<string, TranscriptEntry>();
  private readonly order: string[] = [];
  private readonly maxCharacters: number;
  private readonly assistantText = new Map<string, string>();
  private messageTs: SlackTimestamp | undefined;
  private stream: SlackStreamReference | undefined;
  private lastRendered = "";
  private readonly priorRendered: string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushPromise: Promise<void> = Promise.resolve();
  private degraded = false;
  private lastDeliveryError: unknown;
  private nativeStreamDisabled = false;
  private retryAfterMilliseconds = 250;
  private closed = false;

  public constructor(private readonly options: SlackTranscriptSinkOptions) {
    this.maxCharacters = options.maxCharacters ?? 36_000;
    this.messageTs = options.initialMessage?.messageTs;
    this.priorRendered = sanitize(options.initialMessage?.text ?? "");
    this.lastRendered = this.priorRendered;
  }

  public async publish(event: AgentStreamEvent): Promise<void> {
    if (this.closed) return;
    this.apply(event);
    this.options.checkpoint?.({
      ...(this.messageTs === undefined ? {} : { messageTs: this.messageTs }),
      ...("itemId" in event ? { lastItemId: event.itemId } : {}),
      degraded: this.degraded,
    });
    if (isTerminal(event)) await this.flush();
    else this.scheduleFlush();
  }

  public async close(): Promise<{ degraded: boolean; messageTs?: SlackTimestamp }> {
    if (this.closed) {
      return {
        degraded: this.degraded,
        ...(this.messageTs === undefined ? {} : { messageTs: this.messageTs }),
      };
    }
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await this.flush();
      if (this.lastRendered === this.render()) break;
      if (attempt < 3) await delay(Math.min(this.retryAfterMilliseconds, 2_000));
    }
    const contentDelivered = this.lastRendered === this.render();
    let streamStopped = true;
    if (this.stream !== undefined) {
      const stream = this.stream;
      streamStopped = false;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        if (await this.deliver(() => this.options.slack.stopStream(stream))) {
          streamStopped = true;
          break;
        }
        if (attempt < 3) await delay(Math.min(this.retryAfterMilliseconds, 2_000));
      }
    }
    this.degraded = !contentDelivered || !streamStopped;
    return {
      degraded: this.degraded,
      ...(this.messageTs === undefined ? {} : { messageTs: this.messageTs }),
    };
  }

  private apply(event: AgentStreamEvent): void {
    switch (event.kind) {
      case "session_started":
        this.set("session", `Session ready · \`${event.providerSessionId}\``, false);
        break;
      case "turn_started":
        this.set(`turn:${event.turn.toString()}`, `Turn ${event.turn.toString()} · running`, false);
        break;
      case "assistant_delta": {
        const next = `${this.assistantText.get(event.itemId) ?? ""}${event.text}`;
        this.assistantText.set(event.itemId, next);
        this.set(`assistant:${event.itemId}`, next, false);
        break;
      }
      case "assistant_completed":
        this.assistantText.set(event.itemId, event.text);
        this.set(`assistant:${event.itemId}`, event.text, true);
        break;
      case "plan_updated":
        this.set(
          `plan:${event.itemId}`,
          event.items.map((item) => `${item.completed ? "☑" : "☐"} ${item.text}`).join("\n"),
          event.items.every((item) => item.completed),
        );
        break;
      case "command_updated":
        this.set(
          `command:${event.itemId}`,
          `\`${event.command}\` · ${event.status}${event.exitCode === undefined ? "" : ` (${event.exitCode.toString()})`}`,
          event.status === "completed" || event.status === "failed",
        );
        break;
      case "file_change":
        this.set(
          `files:${event.itemId}`,
          `${event.status}: ${event.changes.map((change) => `${change.kind} ${change.path}`).join(", ")}`,
          event.status === "completed" || event.status === "failed",
        );
        break;
      case "tool_updated":
        this.set(
          `tool:${event.itemId}`,
          `${event.tool} · ${event.status}${event.summary === undefined ? "" : ` · ${event.summary}`}`,
          event.status === "completed" || event.status === "failed",
        );
        break;
      case "web_search_updated":
        this.set(
          `search:${event.itemId}`,
          `Web search · ${event.status} · ${event.query}`,
          event.status === "completed" || event.status === "failed",
        );
        break;
      case "usage":
        this.set("usage", usageText(event.usage), true);
        break;
      case "recovery":
        this.set(
          "recovery",
          `Recovery · ${event.message}${event.previousSessionId === undefined ? "" : ` · session \`${event.previousSessionId}\``}`,
          true,
        );
        break;
      case "control_applied":
        this.set(
          `control:${event.commandId}`,
          `Human command \`${event.commandId}\` accepted as ${event.mode}`,
          true,
        );
        break;
      case "control_completed":
        this.set(
          `control:${event.commandId}`,
          `Human command \`${event.commandId}\` completed`,
          true,
        );
        break;
      case "turn_interrupted":
        this.set(
          `turn:${event.turn.toString()}`,
          `Turn ${event.turn.toString()} · redirected by \`${event.commandId}\``,
          true,
        );
        break;
      case "turn_completed":
        this.set(
          `turn:${event.turn.toString()}`,
          `Turn ${event.turn.toString()} · completed`,
          true,
        );
        break;
      case "turn_failed":
        this.set(
          `turn:${event.turn.toString()}`,
          `Turn ${event.turn.toString()} · failed${event.retryable ? " (retryable)" : ""}: ${event.message}`,
          true,
        );
        break;
    }
  }

  private set(key: string, text: string, terminal: boolean): void {
    if (!this.entries.has(key)) this.order.push(key);
    this.entries.set(key, { key, text: sanitize(text), terminal });
    this.boundEntries();
  }

  private boundEntries(): void {
    while (this.renderUnbounded().length > this.maxCharacters && this.order.length > 1) {
      const disposableIndex = this.order.findIndex(
        (key) => this.entries.get(key)?.terminal === false,
      );
      const index = disposableIndex >= 0 ? disposableIndex : 0;
      const [removed] = this.order.splice(index, 1);
      if (removed !== undefined) this.entries.delete(removed);
    }
  }

  private render(): string {
    return this.renderUnbounded().slice(0, this.maxCharacters);
  }

  private renderUnbounded(): string {
    const body = this.order
      .map((key) => this.entries.get(key)?.text)
      .filter((text): text is string => text !== undefined && text.length > 0)
      .join("\n\n");
    const current = `*${sanitize(this.options.label)}*\n${body}`;
    return this.priorRendered.length === 0 ? current : `${this.priorRendered}\n\n${current}`;
  }

  private scheduleFlush(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.options.flushIntervalMilliseconds);
  }

  private async flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const rendered = this.render();
    if (rendered === this.lastRendered) return this.flushPromise;
    this.flushPromise = this.flushPromise.then(() => this.write(rendered));
    await this.flushPromise;
  }

  private async write(rendered: string): Promise<void> {
    let delivered = false;
    const responseTo = this.options.responseTo;
    if (responseTo !== undefined && !this.nativeStreamDisabled) {
      if (this.stream === undefined) {
        delivered = await this.deliver(async () => {
          const stream = await this.options.slack.startStream({
            channelId: this.options.surface.channelId,
            threadTs: responseTo.threadTs,
            recipientUserId: responseTo.recipientUserId,
            recipientTeamId: responseTo.recipientTeamId,
            text: rendered,
          });
          this.stream = stream;
          this.messageTs = stream.messageTs;
        });
        if (!delivered && isTerminalSlackFailure(this.lastDeliveryError)) {
          this.nativeStreamDisabled = true;
          this.messageTs = undefined;
        }
      } else {
        const stream = this.stream;
        const delta = rendered.startsWith(this.lastRendered)
          ? rendered.slice(this.lastRendered.length)
          : `\n\n_Update_\n${rendered}`;
        if (delta.length > 0) {
          delivered = await this.deliver(() =>
            this.options.slack.appendStream({ ...stream, text: delta }),
          );
          if (!delivered && isTerminalSlackFailure(this.lastDeliveryError)) {
            this.nativeStreamDisabled = true;
            this.stream = undefined;
            this.messageTs = undefined;
          }
        } else {
          delivered = true;
        }
      }
    }
    if (responseTo === undefined || this.nativeStreamDisabled) {
      if (this.messageTs === undefined) {
        delivered = await this.deliver(async () => {
          const message = await this.options.slack.postMessage({
            channelId: this.options.surface.channelId,
            ...(responseTo === undefined
              ? this.options.surface.mode === "thread_per_ticket"
                ? { threadTs: this.options.surface.threadTs }
                : {}
              : { threadTs: responseTo.threadTs }),
            text: rendered,
            metadata: transcriptMetadata(this.options.executionId),
          });
          this.messageTs = message.timestamp;
        });
      } else {
        const messageTs = this.messageTs;
        delivered = await this.deliver(() =>
          this.options.slack.updateMessage({
            channelId: this.options.surface.channelId,
            messageTs,
            text: rendered,
            metadata: transcriptMetadata(this.options.executionId),
          }),
        );
      }
    }
    if (delivered) {
      this.lastRendered = rendered;
      this.options.checkpoint?.({
        ...(this.messageTs === undefined ? {} : { messageTs: this.messageTs }),
        degraded: false,
      });
    }
  }

  private async deliver(operation: () => Promise<unknown>): Promise<boolean> {
    try {
      await operation();
      this.lastDeliveryError = undefined;
      this.degraded = false;
      this.retryAfterMilliseconds = 250;
      return true;
    } catch (error) {
      this.lastDeliveryError = error;
      this.degraded = true;
      if (error instanceof SlackApiError) {
        this.retryAfterMilliseconds = error.retryAfterMs ?? 1_000;
      }
      if (error instanceof SlackApiError && error.retryable && !this.closed) {
        this.scheduleFlushAfter(error.retryAfterMs ?? 1_000);
      }
      return false;
    }
  }

  private scheduleFlushAfter(milliseconds: number): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, milliseconds);
  }
}

function isTerminalSlackFailure(error: unknown): boolean {
  return error instanceof SlackApiError && !error.retryable;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function transcriptMetadata(executionId: string): SlackMessageMetadata {
  return {
    eventType: "thor_agent_execution",
    eventPayload: { executionId },
  };
}

function sanitize(text: string): string {
  let result = "";
  for (const character of redactKnownSecrets(text)) {
    const code = character.charCodeAt(0);
    if (code === 9 || code === 10 || code === 13 || code > 31) result += character;
  }
  return result;
}

function usageText(usage: {
  inputTokens?: number | undefined;
  cachedInputTokens?: number | undefined;
  outputTokens?: number | undefined;
  reasoningOutputTokens?: number | undefined;
  estimatedCostUsd?: number | undefined;
}): string {
  const parts = [
    usage.inputTokens === undefined ? undefined : `input ${usage.inputTokens.toString()}`,
    usage.cachedInputTokens === undefined
      ? undefined
      : `cached ${usage.cachedInputTokens.toString()}`,
    usage.outputTokens === undefined ? undefined : `output ${usage.outputTokens.toString()}`,
    usage.estimatedCostUsd === undefined ? undefined : `cost $${usage.estimatedCostUsd.toFixed(4)}`,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? "Usage unavailable" : `Usage · ${parts.join(" · ")}`;
}

function isTerminal(event: AgentStreamEvent): boolean {
  return event.kind === "turn_completed" || event.kind === "turn_failed";
}
