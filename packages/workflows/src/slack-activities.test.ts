import {
  FakeSlackApi,
  SlackApiError,
  slackChannelIdSchema,
  slackCommandDigest,
  slackCommandReferenceSchema,
  slackTaskSurfaceSchema,
  slackUserIdSchema,
  type SlackTaskSurface,
} from "@thor/slack";
import { describe, expect, it } from "vitest";

import { createSlackRouterActivities } from "./slack-activities.js";
import type { SlackRouterRegistration } from "./slack-contracts.js";

describe("Slack router Activities", () => {
  it("revalidates and materializes a command receipt idempotently", async () => {
    const fixture = threadFixture();
    const source = fixture.slack.seedMessage({
      channelId: slackChannelIdSchema.parse("CPROJECT"),
      threadTimestamp: fixture.surface.threadTs,
      text: "<@UTHOR> steer: inspect the retry helper",
      userId: slackUserIdSchema.parse("UACTOR"),
    });
    const reference = slackCommandReferenceSchema.parse({
      commandId: "command-1",
      eventId: "Ev001",
      workspaceId: "TWORKSPACE",
      channelId: "CPROJECT",
      threadTs: fixture.surface.threadTs,
      messageTs: source.timestamp,
      actorId: "UACTOR",
      mode: "redirect",
      contentDigest: slackCommandDigest("inspect the retry helper"),
    });
    const activities = createSlackRouterActivities({
      slack: fixture.slack,
      botUserId: slackUserIdSchema.parse("UTHOR"),
    });

    const first = await activities.materializeSlackCommand({
      registration: fixture.registration,
      reference,
    });
    await fixture.slack.updateMessage({
      channelId: source.channelId,
      messageTs: source.timestamp,
      text: "edited after acceptance",
    });
    const second = await activities.materializeSlackCommand({
      registration: fixture.registration,
      reference,
    });

    expect(second).toEqual(first);
    const replies = await fixture.slack.replies({
      channelId: fixture.surface.channelId,
      threadTs: fixture.surface.threadTs,
    });
    expect(
      replies.values.filter((message) => message.metadata?.eventType === "thor_command_receipt"),
    ).toHaveLength(1);
    expect(replies.values.find((message) => message.timestamp === first.receiptTs)?.text).toContain(
      "inspect the retry helper",
    );
  });

  it("recovers an event omitted by the Events API from thread history", async () => {
    const fixture = threadFixture();
    const source = fixture.slack.seedMessage({
      channelId: slackChannelIdSchema.parse("CPROJECT"),
      threadTimestamp: fixture.surface.threadTs,
      text: "<@UTHOR> queue: run integration tests",
      userId: slackUserIdSchema.parse("UACTOR"),
    });
    const activities = createSlackRouterActivities({
      slack: fixture.slack,
      botUserId: slackUserIdSchema.parse("UTHOR"),
    });

    const commands = await activities.reconcileSlackCommands({
      registrations: [fixture.registration],
      seenEventIds: [],
      highWatermarks: {},
      limit: 100,
    });

    expect(commands.references).toHaveLength(1);
    expect(commands.references[0]).toMatchObject({
      eventId: `reconcile:CPROJECT:${source.timestamp}`,
      mode: "queue",
      actorId: "UACTOR",
    });
    expect(commands.highWatermarks).toMatchObject({
      [`thread:CPROJECT:${fixture.surface.threadTs}`]: source.timestamp,
    });

    const repeated = await activities.reconcileSlackCommands({
      registrations: [fixture.registration],
      seenEventIds: [],
      highWatermarks: commands.highWatermarks,
      limit: 100,
    });
    expect(repeated.references).toEqual([]);
  });

  it("recovers a nested command from a dedicated ticket channel", async () => {
    const slack = new FakeSlackApi();
    slack.seedConversation({
      id: slackChannelIdSchema.parse("CTICKET"),
      name: "thor-ticket",
      isPrivate: true,
      isArchived: false,
      topic: "",
    });
    slack.seedUserGroup("SENGINEERS", [slackUserIdSchema.parse("UACTOR")]);
    const header = slack.seedMessage({
      channelId: slackChannelIdSchema.parse("CTICKET"),
      text: "ticket header",
      botId: "BTHOR",
    });
    const discussion = slack.seedMessage({
      channelId: slackChannelIdSchema.parse("CTICKET"),
      text: "discussion",
      userId: slackUserIdSchema.parse("UACTOR"),
    });
    const source = slack.seedMessage({
      channelId: slackChannelIdSchema.parse("CTICKET"),
      threadTimestamp: discussion.timestamp,
      text: "<@UTHOR> steer: use the retry helper",
      userId: slackUserIdSchema.parse("UACTOR"),
    });
    const surface = slackTaskSurfaceSchema.parse({
      mode: "channel_per_ticket",
      workspaceId: "TWORKSPACE",
      channelId: "CTICKET",
      headerTs: header.timestamp,
      permalink: "https://fake.slack.com/ticket",
    });
    const registration: SlackRouterRegistration = {
      workflowId: "workflow-channel",
      projectItemId: "PVTI_CHANNEL",
      surface,
      allowedUserGroupIds: ["SENGINEERS"],
      defaultMode: "redirect",
      terminal: false,
    };
    const activities = createSlackRouterActivities({
      slack,
      botUserId: slackUserIdSchema.parse("UTHOR"),
    });

    const commands = await activities.reconcileSlackCommands({
      registrations: [registration],
      seenEventIds: [],
      highWatermarks: {},
      limit: 100,
    });

    expect(commands.references).toHaveLength(1);
    expect(commands.references[0]).toMatchObject({
      messageTs: source.timestamp,
      threadTs: discussion.timestamp,
      mode: "redirect",
    });
    expect(commands.highWatermarks["channel:CTICKET"]).toBe(source.timestamp);
  });

  it("rejects a command from an actor outside the configured groups", async () => {
    const fixture = threadFixture();
    const source = fixture.slack.seedMessage({
      channelId: slackChannelIdSchema.parse("CPROJECT"),
      threadTimestamp: fixture.surface.threadTs,
      text: "<@UTHOR> cancel: stop",
      userId: slackUserIdSchema.parse("UOTHER"),
    });
    const activities = createSlackRouterActivities({
      slack: fixture.slack,
      botUserId: slackUserIdSchema.parse("UTHOR"),
    });

    await expect(
      activities.materializeSlackCommand({
        registration: fixture.registration,
        reference: slackCommandReferenceSchema.parse({
          commandId: "command-2",
          eventId: "Ev002",
          workspaceId: "TWORKSPACE",
          channelId: "CPROJECT",
          threadTs: fixture.surface.threadTs,
          messageTs: source.timestamp,
          actorId: "UOTHER",
          mode: "cancel",
          contentDigest: slackCommandDigest("stop"),
        }),
      }),
    ).rejects.toMatchObject({ type: "slack_unauthorized" });
  });

  it("archives a dedicated ticket channel idempotently", async () => {
    const slack = new FakeSlackApi();
    const channelId = slackChannelIdSchema.parse("CTICKET");
    slack.seedConversation({
      id: channelId,
      name: "thor-ticket",
      isPrivate: true,
      isArchived: false,
      topic: "",
    });
    const surface = slackTaskSurfaceSchema.parse({
      mode: "channel_per_ticket",
      workspaceId: "TWORKSPACE",
      channelId,
      headerTs: "1700000000.000001",
      permalink: "https://fake.slack.com/ticket",
    });
    const registration: SlackRouterRegistration = {
      workflowId: "workflow-channel",
      projectItemId: "PVTI_CHANNEL",
      surface,
      allowedUserGroupIds: ["SENGINEERS"],
      defaultMode: "redirect",
      archiveDelayDays: 0,
      terminal: true,
      terminalAtEpochMilliseconds: 1,
    };
    const activities = createSlackRouterActivities({
      slack,
      botUserId: slackUserIdSchema.parse("UTHOR"),
    });

    await activities.archiveSlackTicketChannel({ registration });
    await activities.archiveSlackTicketChannel({ registration });

    expect((await slack.getConversation(channelId)).isArchived).toBe(true);
    expect(slack.calls.filter((call) => call.kind === "archive_conversation")).toHaveLength(1);

    await activities.unarchiveSlackTicketChannel({
      registration: { ...registration, terminal: false, archivedAtEpochMilliseconds: 2 },
    });
    await activities.unarchiveSlackTicketChannel({
      registration: { ...registration, terminal: false, archivedAtEpochMilliseconds: 2 },
    });
    expect((await slack.getConversation(channelId)).isArchived).toBe(false);
    expect(slack.calls.filter((call) => call.kind === "unarchive_conversation")).toHaveLength(1);
  });

  it("preserves Slack retry timing for Temporal", async () => {
    const fixture = threadFixture();
    const activities = createSlackRouterActivities({
      slack: new RateLimitedSlackApi(),
      botUserId: slackUserIdSchema.parse("UTHOR"),
    });

    await expect(
      activities.reconcileSlackCommands({
        registrations: [fixture.registration],
        seenEventIds: [],
        highWatermarks: {},
        limit: 100,
      }),
    ).rejects.toMatchObject({
      type: "slack_rate_limited",
      nonRetryable: false,
      nextRetryDelay: 2_500,
    });
  });
});

class RateLimitedSlackApi extends FakeSlackApi {
  public override history(): Promise<never> {
    return Promise.reject(new SlackApiError("rate limited", "rate_limited", true, 2_500));
  }

  public override replies(): Promise<never> {
    return Promise.reject(new SlackApiError("rate limited", "rate_limited", true, 2_500));
  }
}

function threadFixture(): {
  slack: FakeSlackApi;
  surface: Extract<SlackTaskSurface, { mode: "thread_per_ticket" }>;
  registration: SlackRouterRegistration;
} {
  const slack = new FakeSlackApi();
  slack.seedConversation({
    id: slackChannelIdSchema.parse("CPROJECT"),
    name: "project",
    isPrivate: true,
    isArchived: false,
    topic: "",
  });
  slack.seedUserGroup("SENGINEERS", [slackUserIdSchema.parse("UACTOR")]);
  const root = slack.seedMessage({
    channelId: slackChannelIdSchema.parse("CPROJECT"),
    text: "ticket root",
    botId: "BTHOR",
    metadata: {
      eventType: "thor_ticket_surface",
      eventPayload: { projectItemId: "PVTI_42", workflowId: "workflow-42" },
    },
  });
  const parsedSurface = slackTaskSurfaceSchema.parse({
    mode: "thread_per_ticket",
    workspaceId: "TWORKSPACE",
    channelId: "CPROJECT",
    threadTs: root.timestamp,
    headerTs: root.timestamp,
    permalink: "https://fake.slack.com/root",
  });
  if (parsedSurface.mode !== "thread_per_ticket") throw new Error("expected thread surface");
  const surface = parsedSurface;
  return {
    slack,
    surface,
    registration: {
      workflowId: "workflow-42",
      projectItemId: "PVTI_42",
      surface,
      allowedUserGroupIds: ["SENGINEERS"],
      defaultMode: "redirect",
      terminal: false,
    },
  };
}
