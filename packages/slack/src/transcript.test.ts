import { describe, expect, it } from "vitest";

import { FakeSlackApi } from "./fake.js";
import { SlackTranscriptSink } from "./transcript.js";
import {
  SlackApiError,
  slackChannelIdSchema,
  slackTaskSurfaceSchema,
  slackTimestampSchema,
  slackUserIdSchema,
  type PostSlackMessageInput,
  type SlackMessage,
  type SlackTimestamp,
} from "./types.js";

describe("SlackTranscriptSink", () => {
  it("coalesces autonomous updates into one bot-owned phase message", async () => {
    const slack = new FakeSlackApi();
    slack.seedConversation({
      id: slackChannelIdSchema.parse("CPROJECT"),
      name: "project",
      isPrivate: true,
      isArchived: false,
      topic: "",
    });
    const root = await slack.postMessage({
      channelId: slackChannelIdSchema.parse("CPROJECT"),
      text: "root",
    });
    const sink = new SlackTranscriptSink({
      slack,
      surface: slackTaskSurfaceSchema.parse({
        mode: "thread_per_ticket",
        workspaceId: "TWORKSPACE",
        channelId: "CPROJECT",
        threadTs: root.timestamp,
        headerTs: root.timestamp,
        permalink: "https://fake.slack.com/root",
      }),
      executionId: "execution-1",
      label: "Implementation · Codex",
      flushIntervalMilliseconds: 1_000,
    });

    await sink.publish({ kind: "turn_started", turn: 1 });
    await sink.publish({ kind: "assistant_delta", itemId: "message", text: "hello " });
    await sink.publish({ kind: "assistant_delta", itemId: "message", text: "world" });
    await sink.publish({ kind: "assistant_completed", itemId: "message", text: "hello world" });
    await sink.publish({ kind: "turn_completed", turn: 1 });
    await sink.close();

    const replies = await slack.replies({
      channelId: slackChannelIdSchema.parse("CPROJECT"),
      threadTs: root.timestamp,
    });
    expect(replies.values).toHaveLength(2);
    expect(replies.values[1]?.text).toContain("hello world");
    expect(replies.values[1]?.text).toContain("Turn 1 · completed");
    expect(replies.values[1]?.metadata?.eventType).toBe("thor_agent_execution");
  });

  it("uses native Slack streaming when responding to an explicit user command", async () => {
    const slack = new FakeSlackApi();
    slack.seedConversation({
      id: slackChannelIdSchema.parse("CTICKET"),
      name: "ticket",
      isPrivate: true,
      isArchived: false,
      topic: "",
    });
    const commandTs = slackTimestampSchema.parse("1700000000.123456");
    const surface = slackTaskSurfaceSchema.parse({
      mode: "channel_per_ticket",
      workspaceId: "TWORKSPACE",
      channelId: "CTICKET",
      headerTs: "1700000000.000001",
      permalink: "https://fake.slack.com/ticket",
    });
    const sink = new SlackTranscriptSink({
      slack,
      surface,
      executionId: "execution-2",
      label: "Repair · Claude",
      flushIntervalMilliseconds: 100,
      responseTo: {
        threadTs: commandTs,
        recipientUserId: slackUserIdSchema.parse("UONE"),
        recipientTeamId: "TWORKSPACE",
      },
    });

    await sink.publish({ kind: "assistant_delta", itemId: "message", text: "working" });
    await sink.publish({ kind: "turn_completed", turn: 1 });
    await sink.close();

    expect(slack.calls.some((call) => call.kind === "start_stream")).toBe(true);
    expect(slack.calls.some((call) => call.kind === "stop_stream")).toBe(true);
  });

  it("continues a verified checkpointed phase message after an Activity retry", async () => {
    const slack = seededSlack();
    const existing = await slack.postMessage({
      channelId: channelId(),
      threadTs: threadTs(),
      text: "*Implementation · Codex*\nTurn 1 · running",
      metadata: {
        eventType: "thor_agent_execution",
        eventPayload: { executionId: "execution-1" },
      },
    });
    slack.calls.length = 0;
    const checkpoints: SlackTimestamp[] = [];
    const sink = new SlackTranscriptSink({
      slack,
      surface: threadSurface(),
      executionId: "execution-1",
      label: "Implementation · Codex · recovery",
      flushIntervalMilliseconds: 1,
      initialMessage: { messageTs: existing.timestamp, text: existing.text },
      checkpoint: (checkpoint) => {
        if (checkpoint.messageTs !== undefined) checkpoints.push(checkpoint.messageTs);
      },
    });

    await sink.publish({ kind: "turn_started", turn: 2 });
    await sink.close();

    expect(slack.calls.filter((call) => call.kind === "post_message")).toHaveLength(0);
    expect(slack.calls.filter((call) => call.kind === "update_message")).toHaveLength(1);
    expect(checkpoints).toContain(existing.timestamp);
    const replies = await slack.replies({ channelId: channelId(), threadTs: threadTs() });
    expect(
      replies.values.find((message) => message.timestamp === existing.timestamp)?.text,
    ).toContain("Turn 2 · running");
  });

  it("retries a rate-limited final flush without restarting the agent", async () => {
    const slack = new RateLimitedSlackApi();
    slack.seedConversation({
      id: slackChannelIdSchema.parse("CPROJECT"),
      name: "project",
      isPrivate: true,
      isArchived: false,
      topic: "",
    });
    const root = slack.seedMessage({
      channelId: slackChannelIdSchema.parse("CPROJECT"),
      text: "root",
      botId: "BTHOR",
    });
    const sink = new SlackTranscriptSink({
      slack,
      surface: slackTaskSurfaceSchema.parse({
        mode: "thread_per_ticket",
        workspaceId: "TWORKSPACE",
        channelId: "CPROJECT",
        threadTs: root.timestamp,
        headerTs: root.timestamp,
        permalink: "https://fake.slack.com/root",
      }),
      executionId: "execution-rate-limit",
      label: "Implementation · Codex",
      flushIntervalMilliseconds: 1_000,
    });

    await sink.publish({ kind: "assistant_completed", itemId: "message", text: "complete" });
    const result = await sink.close();

    expect(slack.attempts).toBe(2);
    expect(result.degraded).toBe(false);
  });

  it("redacts secrets and retains terminal updates when its buffer is bounded", async () => {
    const slack = seededSlack();
    const sink = new SlackTranscriptSink({
      slack,
      surface: threadSurface(),
      executionId: "execution-bounded",
      label: "Implementation · Codex",
      flushIntervalMilliseconds: 1_000,
      maxCharacters: 240,
    });

    await sink.publish({
      kind: "assistant_delta",
      itemId: "large-delta",
      text: `temporary ${"x".repeat(500)}`,
    });
    await sink.publish({
      kind: "tool_updated",
      itemId: "terminal-tool",
      tool: "verification",
      status: "completed",
      summary: "token ghp_abcdefghijklmnopqrstuvwxyz123456",
    });
    await sink.publish({ kind: "turn_completed", turn: 1 });
    await sink.close();

    const replies = await slack.replies({ channelId: channelId(), threadTs: threadTs() });
    const transcript =
      replies.values.find(
        (message) => message.metadata?.eventPayload.executionId === "execution-bounded",
      )?.text ?? "";
    expect(transcript).toContain("verification · completed");
    expect(transcript).toContain("[REDACTED]");
    expect(transcript).not.toContain("ghp_");
    expect(transcript.length).toBeLessThanOrEqual(240);
  });

  it("falls back to a bot-owned reply when native streaming is unavailable", async () => {
    const slack = new NativeStreamingUnavailableSlackApi();
    slack.seedConversation({
      id: slackChannelIdSchema.parse("CTICKET"),
      name: "ticket",
      isPrivate: true,
      isArchived: false,
      topic: "",
    });
    const commandTs = slackTimestampSchema.parse("1700000000.123456");
    slack.seedMessage({
      channelId: slackChannelIdSchema.parse("CTICKET"),
      timestamp: commandTs,
      text: "command",
      userId: slackUserIdSchema.parse("UONE"),
    });
    const sink = new SlackTranscriptSink({
      slack,
      surface: slackTaskSurfaceSchema.parse({
        mode: "channel_per_ticket",
        workspaceId: "TWORKSPACE",
        channelId: "CTICKET",
        headerTs: "1700000000.000001",
        permalink: "https://fake.slack.com/ticket",
      }),
      executionId: "execution-native-fallback",
      label: "Repair · Claude",
      flushIntervalMilliseconds: 100,
      responseTo: {
        threadTs: commandTs,
        recipientUserId: slackUserIdSchema.parse("UONE"),
        recipientTeamId: "TWORKSPACE",
      },
    });

    await sink.publish({ kind: "assistant_completed", itemId: "message", text: "done" });
    await sink.publish({ kind: "turn_completed", turn: 1 });
    const result = await sink.close();

    expect(result.degraded).toBe(false);
    expect(slack.calls.filter((call) => call.kind === "start_stream")).toHaveLength(1);
    const replies = await slack.replies({
      channelId: slackChannelIdSchema.parse("CTICKET"),
      threadTs: commandTs,
    });
    expect(
      replies.values.find(
        (message) => message.metadata?.eventPayload.executionId === "execution-native-fallback",
      )?.text,
    ).toContain("done");
  });
});

class RateLimitedSlackApi extends FakeSlackApi {
  public attempts = 0;

  public override postMessage(input: PostSlackMessageInput): Promise<SlackMessage> {
    this.attempts += 1;
    if (this.attempts === 1) {
      return Promise.reject(new SlackApiError("rate limited", "rate_limited", true, 1));
    }
    return super.postMessage(input);
  }
}

class NativeStreamingUnavailableSlackApi extends FakeSlackApi {
  public override startStream(): Promise<never> {
    this.calls.push({
      kind: "start_stream",
      input: {
        channelId: slackChannelIdSchema.parse("CTICKET"),
        threadTs: slackTimestampSchema.parse("1700000000.123456"),
        recipientUserId: slackUserIdSchema.parse("UONE"),
        recipientTeamId: "TWORKSPACE",
      },
    });
    return Promise.reject(
      new SlackApiError("streaming unavailable", "method_not_supported", false),
    );
  }
}

function channelId() {
  return slackChannelIdSchema.parse("CPROJECT");
}

function threadTs() {
  return slackTimestampSchema.parse("1700000000.000001");
}

function seededSlack(): FakeSlackApi {
  const slack = new FakeSlackApi();
  slack.seedConversation({
    id: channelId(),
    name: "project",
    isPrivate: true,
    isArchived: false,
    topic: "",
  });
  slack.seedMessage({
    channelId: channelId(),
    text: "root",
    botId: "BTHOR",
  });
  return slack;
}

function threadSurface() {
  return slackTaskSurfaceSchema.parse({
    mode: "thread_per_ticket",
    workspaceId: "TWORKSPACE",
    channelId: channelId(),
    threadTs: threadTs(),
    headerTs: threadTs(),
    permalink: "https://fake.slack.com/root",
  });
}
