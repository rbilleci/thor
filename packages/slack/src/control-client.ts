import { agentControlSchema, type AgentControl } from "@thor/agent";
import { z } from "zod";

import { createSlackControlCredential } from "./control-auth.js";
import { slackTaskSurfaceSchema, type SlackTaskSurface } from "./types.js";

export type SlackControlClientOptions = {
  gatewayUrl: string;
  serviceToken: string;
  workflowId: string;
  executionId: string;
  surface: SlackTaskSurface;
  signal: AbortSignal;
  pollTimeoutMilliseconds?: number;
  seenCommandIds?: string[];
  fetch?: typeof globalThis.fetch;
};

const pollResponseSchema = z.strictObject({ command: agentControlSchema.nullable() });

export class SlackControlClient implements AsyncIterable<AgentControl> {
  private readonly fetch: typeof globalThis.fetch;
  private readonly gatewayUrl: string;
  private readonly seen: Set<string>;
  private closed = false;
  private iteratorCreated = false;

  public constructor(private readonly options: SlackControlClientOptions) {
    if (options.serviceToken.trim().length === 0)
      throw new Error("Slack control token is required");
    this.gatewayUrl = options.gatewayUrl.replace(/\/$/, "");
    this.fetch = options.fetch ?? globalThis.fetch;
    this.seen = new Set(options.seenCommandIds ?? []);
    slackTaskSurfaceSchema.parse(options.surface);
  }

  public async applied(commandId: string): Promise<void> {
    const response = await this.fetch(`${this.gatewayUrl}/internal/control/applied`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        workflowId: this.options.workflowId,
        executionId: this.options.executionId,
        commandId,
      }),
      signal: this.options.signal,
    });
    if (!response.ok) {
      throw new Error(
        `Slack control acknowledgement failed with HTTP ${response.status.toString()}`,
      );
    }
  }

  public close(): void {
    this.closed = true;
  }

  public [Symbol.asyncIterator](): AsyncIterator<AgentControl> {
    if (this.iteratorCreated) throw new Error("SlackControlClient supports one consumer");
    this.iteratorCreated = true;
    return {
      next: () => this.next(),
      return: () => {
        this.close();
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  }

  private async next(): Promise<IteratorResult<AgentControl>> {
    while (!this.closed && !this.options.signal.aborted) {
      try {
        const response = await this.fetch(`${this.gatewayUrl}/internal/control/poll`, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({
            workflowId: this.options.workflowId,
            executionId: this.options.executionId,
            surface: this.options.surface,
            timeoutMilliseconds: this.options.pollTimeoutMilliseconds ?? 25_000,
          }),
          signal: this.options.signal,
        });
        if (!response.ok) {
          await delay(250, this.options.signal);
          continue;
        }
        const parsed = pollResponseSchema.parse(await response.json());
        if (parsed.command === null || this.seen.has(parsed.command.commandId)) continue;
        this.seen.add(parsed.command.commandId);
        return { done: false, value: parsed.command };
      } catch {
        try {
          await delay(250, this.options.signal);
        } catch {
          return { done: true, value: undefined };
        }
      }
    }
    return { done: true, value: undefined };
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${createSlackControlCredential({
        secret: this.options.serviceToken,
        workflowId: this.options.workflowId,
        executionId: this.options.executionId,
      })}`,
      "content-type": "application/json; charset=utf-8",
    };
  }
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal.reason));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(abortError(signal.reason));
      },
      { once: true },
    );
  });
}

function abortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error("Slack control request aborted");
}
