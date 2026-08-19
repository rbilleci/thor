import type { AgentControl } from "@thor/agent";
import {
  slackSurfaceKey,
  slackSurfaceKeyString,
  type SlackCommand,
  type SlackTaskSurface,
} from "@thor/slack";

export type ControlPoll = {
  workflowId: string;
  executionId: string;
  surface: SlackTaskSurface;
  timeoutMilliseconds: number;
};

type Waiter = {
  poll: ControlPoll;
  resolve(command: AgentControl | null): void;
  timer: ReturnType<typeof setTimeout>;
};

type QueuedCommand = {
  command: SlackCommand;
  expiresAt: number;
};

export class SlackControlHub {
  private readonly waiters = new Set<Waiter>();
  private readonly queued = new Map<string, QueuedCommand[]>();

  public poll(input: ControlPoll): Promise<AgentControl | null> {
    const key = slackSurfaceKeyString(slackSurfaceKey(input.surface));
    this.prune();
    const existing = this.queued.get(key)?.shift();
    if (existing !== undefined) return Promise.resolve(toControl(existing.command));
    return new Promise((resolve) => {
      const waiter: Waiter = {
        poll: input,
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          resolve(null);
        }, input.timeoutMilliseconds),
      };
      this.waiters.add(waiter);
    });
  }

  public publish(command: SlackCommand): boolean {
    this.prune();
    const matching = [...this.waiters]
      .filter((waiter) => surfaceMatches(waiter.poll.surface, command))
      .sort((left, right) => left.poll.executionId.localeCompare(right.poll.executionId));
    const waiter = matching[0];
    if (waiter !== undefined) {
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(toControl(command));
      return true;
    }
    const key =
      command.threadTs === undefined
        ? `channel:${command.channelId}`
        : `thread:${command.channelId}:${command.threadTs}`;
    const values = this.queued.get(key) ?? [];
    values.push({ command, expiresAt: Date.now() + 30_000 });
    this.queued.set(key, values.slice(-100));
    return false;
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, values] of this.queued) {
      const current = values.filter((value) => value.expiresAt > now);
      if (current.length === 0) this.queued.delete(key);
      else this.queued.set(key, current);
    }
  }
}

function surfaceMatches(surface: SlackTaskSurface, command: SlackCommand): boolean {
  if (surface.channelId !== command.channelId) return false;
  return surface.mode === "channel_per_ticket" || surface.threadTs === command.threadTs;
}

function toControl(command: SlackCommand): AgentControl {
  const responseContext = {
    actorId: command.actorId,
    workspaceId: command.workspaceId,
    threadId: command.threadTs ?? command.messageTs,
  };
  const sourceReference = {
    commandId: command.commandId,
    eventId: command.eventId,
    workspaceId: command.workspaceId,
    channelId: command.channelId,
    ...(command.threadTs === undefined ? {} : { threadTs: command.threadTs }),
    messageTs: command.messageTs,
    actorId: command.actorId,
    mode: command.mode,
    contentDigest: command.contentDigest,
  };
  return command.mode === "cancel"
    ? {
        kind: "cancel",
        commandId: command.commandId,
        reason: command.text,
        responseContext,
        sourceReference,
      }
    : {
        kind: command.mode,
        commandId: command.commandId,
        text: command.text,
        responseContext,
        sourceReference,
      };
}
