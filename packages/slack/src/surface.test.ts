import { describe, expect, it } from "vitest";

import { FakeSlackApi } from "./fake.js";
import { SlackSurfaceManager, ticketChannelName, type EnsureSlackSurfaceInput } from "./surface.js";
import { slackChannelIdSchema, slackUserIdSchema } from "./types.js";

describe("SlackSurfaceManager", () => {
  it("creates one idempotent task root in thread-per-ticket mode", async () => {
    const slack = new FakeSlackApi();
    slack.seedConversation({
      id: slackChannelIdSchema.parse("CPROJECT"),
      name: "project",
      isPrivate: true,
      isArchived: false,
      topic: "",
    });
    const manager = new SlackSurfaceManager(slack);
    const input = threadInput();

    const first = await manager.ensure(input);
    const second = await manager.ensure({ ...input, status: "in_progress" });

    expect(second).toEqual(first);
    expect(slack.calls.filter((call) => call.kind === "post_message")).toHaveLength(1);
    expect(slack.calls.some((call) => call.kind === "update_message")).toBe(true);
    const history = await slack.history({ channelId: slackChannelIdSchema.parse("CPROJECT") });
    expect(history.values[0]?.text).toContain("in_progress");
    expect(history.values[0]?.metadata?.eventPayload.workflowId).toBe("workflow-42");
    expect(
      slack.calls.some(
        (call) =>
          call.kind === "post_message" &&
          call.input.blocks?.some(
            (block) =>
              block.type === "actions" &&
              block.elements.some((element) => element.actionId === "thor_cancel"),
          ) === true,
      ),
    ).toBe(true);
  });

  it("creates, secures, indexes, unarchives, and reuses a ticket channel", async () => {
    const botUserId = slackUserIdSchema.parse("UTHOR");
    const slack = new FakeSlackApi(botUserId);
    slack.seedConversation({
      id: slackChannelIdSchema.parse("CINDEX"),
      name: "index",
      isPrivate: true,
      isArchived: false,
      topic: "",
    });
    slack.seedUserGroup(
      "SENGINEERS",
      ["UONE", "UTWO"].map((value) => slackUserIdSchema.parse(value)),
    );
    const manager = new SlackSurfaceManager(slack, { botUserId });
    const input = channelInput();

    const first = await manager.ensure(input);
    await slack.archiveConversation(first.channelId);
    const second = await manager.ensure({ ...input, status: "in_review" });
    await manager.update(second, { ...input, status: "repairing" });

    expect(second.channelId).toBe(first.channelId);
    expect(slack.calls.filter((call) => call.kind === "create_conversation")).toHaveLength(1);
    expect(slack.calls.some((call) => call.kind === "unarchive_conversation")).toBe(true);
    expect(await slack.getConversationMembers(first.channelId)).toEqual(["UONE", "UTWO"]);
    const channelMessages = await slack.history({ channelId: first.channelId });
    expect(channelMessages.values).toHaveLength(1);
    expect(channelMessages.values[0]?.text).toContain("repairing");
    const indexMessages = await slack.history({ channelId: slackChannelIdSchema.parse("CINDEX") });
    expect(indexMessages.values).toHaveLength(1);
    expect(indexMessages.values[0]?.text).toContain(first.permalink);
    expect(indexMessages.values[0]?.text).toContain("repairing");
  });

  it("recovers a channel created before its header was posted", async () => {
    const botUserId = slackUserIdSchema.parse("UTHOR");
    const slack = new FakeSlackApi(botUserId);
    const input = channelInput();
    const name = ticketChannelName("thor-project", 42, "PVTI_42");
    slack.seedConversation({
      id: slackChannelIdSchema.parse("CINDEX"),
      name: "index",
      isPrivate: true,
      isArchived: false,
      topic: "",
    });
    slack.seedConversation({
      id: slackChannelIdSchema.parse("GRECOVER"),
      name,
      isPrivate: true,
      isArchived: false,
      creatorId: botUserId,
      topic: "",
    });
    slack.seedUserGroup("SENGINEERS", [slackUserIdSchema.parse("UONE")]);

    const surface = await new SlackSurfaceManager(slack, { botUserId }).ensure(input);

    expect(surface.channelId).toBe("GRECOVER");
    expect(slack.calls.filter((call) => call.kind === "create_conversation")).toHaveLength(0);
  });

  it("refuses to adopt a deterministic-name collision without ownership evidence", async () => {
    const botUserId = slackUserIdSchema.parse("UTHOR");
    const slack = new FakeSlackApi(botUserId);
    const input = channelInput();
    slack.seedConversation({
      id: slackChannelIdSchema.parse("GCONFLICT"),
      name: ticketChannelName("thor-project", 42, "PVTI_42"),
      isPrivate: true,
      isArchived: false,
      creatorId: slackUserIdSchema.parse("UOTHER"),
      topic: "",
    });

    await expect(new SlackSurfaceManager(slack, { botUserId }).ensure(input)).rejects.toThrow(
      "without Thor ownership evidence",
    );
  });
});

function threadInput(): EnsureSlackSurfaceInput {
  return {
    workspaceId: "TWORKSPACE",
    messaging: { mode: "thread_per_ticket", projectChannelId: "CPROJECT" },
    workflowId: "workflow-42",
    projectItemId: "PVTI_42",
    repository: { owner: "example", name: "repository" },
    issueNumber: 42,
    ticketTitle: "Implement Slack",
    status: "design_blueprint",
  };
}

function channelInput(): EnsureSlackSurfaceInput {
  return {
    ...threadInput(),
    messaging: {
      mode: "channel_per_ticket",
      projectIndexChannelId: "CINDEX",
      ticketChannels: {
        namePrefix: "thor-project",
        isPrivate: true,
        memberUserGroupIds: ["SENGINEERS"],
        archiveDelayDays: 7,
      },
    },
  };
}
