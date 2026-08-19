import { describe, expect, it } from "vitest";

import { FakeSlackApi } from "./fake.js";
import {
  slackChannelIdSchema,
  slackTaskSurfaceSchema,
  slackTimestampSchema,
  slackUserGroupIdSchema,
  slackUserIdSchema,
} from "./types.js";

describe("FakeSlackApi", () => {
  it("models root messages, replies, updates, and stable permalinks", async () => {
    const slack = new FakeSlackApi();
    const channelId = slackChannelIdSchema.parse("C012345");
    slack.seedConversation({
      id: channelId,
      name: "thor-project",
      isPrivate: false,
      isArchived: false,
      topic: "",
    });

    const root = await slack.postMessage({
      channelId,
      text: "Ticket #42",
      metadata: {
        eventType: "thor_task_surface",
        eventPayload: { projectItemId: "PVTI_42" },
      },
    });
    const reply = await slack.postMessage({
      channelId,
      threadTs: root.timestamp,
      text: "Implementation started",
    });
    await slack.updateMessage({
      channelId,
      messageTs: reply.timestamp,
      text: "Implementation completed",
    });

    expect((await slack.history({ channelId })).values).toMatchObject([
      { text: "Ticket #42", replyCount: 1 },
    ]);
    expect((await slack.replies({ channelId, threadTs: root.timestamp })).values).toMatchObject([
      { text: "Ticket #42" },
      { text: "Implementation completed" },
    ]);
    expect(await slack.getPermalink(channelId, root.timestamp)).toContain("C012345");
  });

  it("models dedicated channel membership and lifecycle", async () => {
    const slack = new FakeSlackApi();
    const groupId = slackUserGroupIdSchema.parse("S012345");
    const member = slackUserIdSchema.parse("U012345");
    slack.seedUserGroup(groupId, [member]);

    const channel = await slack.createConversation("thor-project-42-a1b2c3", true);
    await slack.inviteUsers(channel.id, await slack.getUserGroupMembers(groupId));
    await slack.setConversationTopic(channel.id, "Thor ticket #42");
    await slack.archiveConversation(channel.id);
    expect(await slack.getConversation(channel.id)).toMatchObject({
      isPrivate: true,
      isArchived: true,
      topic: "Thor ticket #42",
      memberIds: [member],
    });

    await slack.unarchiveConversation(channel.id);
    expect((await slack.getConversation(channel.id)).isArchived).toBe(false);
  });
});

describe("Slack schemas", () => {
  it("distinguishes thread and channel task surfaces", () => {
    const timestamp = slackTimestampSchema.parse("1700000000.000001");
    expect(
      slackTaskSurfaceSchema.parse({
        mode: "thread_per_ticket",
        workspaceId: "T012345",
        channelId: "C012345",
        threadTs: timestamp,
        headerTs: timestamp,
        permalink: "https://example.slack.com/archives/C012345/p1700000000000001",
      }).mode,
    ).toBe("thread_per_ticket");
    expect(
      slackTaskSurfaceSchema.parse({
        mode: "channel_per_ticket",
        workspaceId: "T012345",
        channelId: "G012345",
        headerTs: timestamp,
        permalink: "https://example.slack.com/archives/G012345/p1700000000000001",
      }).mode,
    ).toBe("channel_per_ticket");
  });
});
