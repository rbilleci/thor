import { createHash } from "node:crypto";

import type { RepositoryRef } from "@thor/domain";

import {
  SlackApiError,
  slackChannelIdSchema,
  slackTaskSurfaceSchema,
  slackUserGroupIdSchema,
  slackWorkspaceIdSchema,
  type SlackApi,
  type SlackChannelId,
  type SlackMessage,
  type SlackMessageMetadata,
  type SlackTaskSurface,
  type SlackUserId,
} from "./types.js";

export type SlackSurfaceMessaging =
  | { mode: "thread_per_ticket"; projectChannelId: string }
  | {
      mode: "channel_per_ticket";
      projectIndexChannelId?: string | undefined;
      ticketChannels: {
        namePrefix: string;
        isPrivate: boolean;
        memberUserGroupIds: string[];
        archiveDelayDays: number;
      };
    };

export type EnsureSlackSurfaceInput = {
  workspaceId: string;
  messaging: SlackSurfaceMessaging;
  workflowId: string;
  projectItemId: string;
  repository: RepositoryRef;
  issueNumber: number;
  ticketTitle: string;
  status: string;
  pullRequestNumber?: number;
};

export type SlackSurfaceManagerOptions = {
  botUserId?: SlackUserId;
};

const surfaceEventType = "thor_ticket_surface";
const indexEventType = "thor_ticket_index";

export class SlackSurfaceManager {
  public constructor(
    private readonly slack: SlackApi,
    private readonly options: SlackSurfaceManagerOptions = {},
  ) {}

  public async ensure(input: EnsureSlackSurfaceInput): Promise<SlackTaskSurface> {
    const workspaceId = slackWorkspaceIdSchema.parse(input.workspaceId);
    if (input.messaging.mode === "thread_per_ticket") {
      const channelId = slackChannelIdSchema.parse(input.messaging.projectChannelId);
      const existing = await findMetadataMessage(
        this.slack,
        channelId,
        surfaceEventType,
        input.projectItemId,
      );
      const header =
        existing ??
        (await this.slack.postMessage({
          channelId,
          text: surfaceHeader(input),
          metadata: surfaceMetadata(input),
          blocks: surfaceBlocks(input),
        }));
      if (existing !== undefined) await this.updateHeader(header, input);
      const permalink = await this.slack.getPermalink(channelId, header.timestamp);
      return slackTaskSurfaceSchema.parse({
        mode: "thread_per_ticket",
        workspaceId,
        channelId,
        threadTs: header.timestamp,
        headerTs: header.timestamp,
        permalink,
      });
    }

    const channel = await this.ensureTicketConversation(input);
    if (channel.isArchived) await this.slack.unarchiveConversation(channel.id);
    await this.applyMembership(channel.id, input.messaging.ticketChannels.memberUserGroupIds);
    await this.slack.setConversationTopic(channel.id, topic(input));

    const existing = await findMetadataMessage(
      this.slack,
      channel.id,
      surfaceEventType,
      input.projectItemId,
    );
    const header =
      existing ??
      (await this.slack.postMessage({
        channelId: channel.id,
        text: surfaceHeader(input),
        metadata: surfaceMetadata(input),
        blocks: surfaceBlocks(input),
      }));
    if (existing !== undefined) await this.updateHeader(header, input);
    const permalink = await this.slack.getPermalink(channel.id, header.timestamp);
    if (input.messaging.projectIndexChannelId !== undefined) {
      await this.upsertIndex(
        slackChannelIdSchema.parse(input.messaging.projectIndexChannelId),
        input,
        permalink,
      );
    }
    return slackTaskSurfaceSchema.parse({
      mode: "channel_per_ticket",
      workspaceId,
      channelId: channel.id,
      headerTs: header.timestamp,
      permalink,
    });
  }

  public async update(surface: SlackTaskSurface, input: EnsureSlackSurfaceInput): Promise<void> {
    await this.slack.updateMessage({
      channelId: surface.channelId,
      messageTs: surface.headerTs,
      text: surfaceHeader(input),
      metadata: surfaceMetadata(input),
      blocks: surfaceBlocks(input),
    });
    if (
      surface.mode === "channel_per_ticket" &&
      input.messaging.mode === "channel_per_ticket" &&
      input.messaging.projectIndexChannelId !== undefined
    ) {
      await this.upsertIndex(
        slackChannelIdSchema.parse(input.messaging.projectIndexChannelId),
        input,
        surface.permalink,
      );
    }
  }

  private async updateHeader(message: SlackMessage, input: EnsureSlackSurfaceInput): Promise<void> {
    await this.slack.updateMessage({
      channelId: message.channelId,
      messageTs: message.timestamp,
      text: surfaceHeader(input),
      metadata: surfaceMetadata(input),
      blocks: surfaceBlocks(input),
    });
  }

  private async ensureTicketConversation(input: EnsureSlackSurfaceInput) {
    if (input.messaging.mode !== "channel_per_ticket") throw new Error("invalid messaging mode");
    const name = ticketChannelName(
      input.messaging.ticketChannels.namePrefix,
      input.issueNumber,
      input.projectItemId,
    );
    let existing = await findConversationByName(this.slack, name);
    if (existing === undefined) {
      try {
        return await this.slack.createConversation(name, input.messaging.ticketChannels.isPrivate);
      } catch (error) {
        if (!(error instanceof SlackApiError) || error.code !== "name_taken") throw error;
        existing = await findConversationByName(this.slack, name);
      }
    }
    if (existing === undefined)
      throw new Error(`Slack channel ${name} was taken but not resolvable`);
    if (existing.isPrivate !== input.messaging.ticketChannels.isPrivate) {
      throw new Error(`Slack channel ${name} has the wrong privacy setting`);
    }
    const header = await findMetadataMessage(
      this.slack,
      existing.id,
      surfaceEventType,
      input.projectItemId,
    );
    const createdByThor =
      this.options.botUserId !== undefined && existing.creatorId === this.options.botUserId;
    if (header === undefined && !createdByThor) {
      throw new Error(`Slack channel ${name} exists without Thor ownership evidence`);
    }
    return existing;
  }

  private async applyMembership(channelId: SlackChannelId, groupIds: string[]): Promise<void> {
    const required = new Set<SlackUserId>();
    for (const rawGroupId of groupIds) {
      const groupId = slackUserGroupIdSchema.parse(rawGroupId);
      for (const member of await this.slack.getUserGroupMembers(groupId)) required.add(member);
    }
    const current = new Set(await this.slack.getConversationMembers(channelId));
    const missing = [...required].filter((userId) => !current.has(userId));
    await this.slack.inviteUsers(channelId, missing);
  }

  private async upsertIndex(
    channelId: SlackChannelId,
    input: EnsureSlackSurfaceInput,
    permalink: string,
  ): Promise<void> {
    const existing = await findMetadataMessage(
      this.slack,
      channelId,
      indexEventType,
      input.projectItemId,
    );
    const text = `#${input.issueNumber.toString()} ${input.ticketTitle} · ${input.status} · ${permalink}`;
    const metadata = indexMetadata(input);
    if (existing === undefined) {
      await this.slack.postMessage({ channelId, text, metadata });
    } else {
      await this.slack.updateMessage({
        channelId,
        messageTs: existing.timestamp,
        text,
        metadata,
      });
    }
  }
}

export function ticketChannelName(
  prefix: string,
  issueNumber: number,
  projectItemId: string,
): string {
  const digest = createHash("sha256").update(projectItemId).digest("hex").slice(0, 8);
  const suffix = `-${issueNumber.toString()}-${digest}`;
  return `${prefix.slice(0, Math.max(1, 80 - suffix.length))}${suffix}`;
}

async function findConversationByName(slack: SlackApi, name: string) {
  let cursor: string | undefined;
  do {
    const page = await slack.listConversations(cursor);
    const match = page.values.find((conversation) => conversation.name === name);
    if (match !== undefined) return match;
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return undefined;
}

async function findMetadataMessage(
  slack: SlackApi,
  channelId: SlackChannelId,
  eventType: string,
  projectItemId: string,
): Promise<SlackMessage | undefined> {
  let cursor: string | undefined;
  do {
    const page = await slack.history({
      channelId,
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const match = page.values.find(
      (message) =>
        message.botId !== undefined &&
        message.metadata?.eventType === eventType &&
        message.metadata.eventPayload.projectItemId === projectItemId,
    );
    if (match !== undefined) return match;
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return undefined;
}

function surfaceMetadata(input: EnsureSlackSurfaceInput): SlackMessageMetadata {
  return {
    eventType: surfaceEventType,
    eventPayload: {
      projectItemId: input.projectItemId,
      workflowId: input.workflowId,
      repository: `${input.repository.owner}/${input.repository.name}`,
      issueNumber: input.issueNumber.toString(),
    },
  };
}

function indexMetadata(input: EnsureSlackSurfaceInput): SlackMessageMetadata {
  return {
    eventType: indexEventType,
    eventPayload: {
      projectItemId: input.projectItemId,
      workflowId: input.workflowId,
    },
  };
}

function surfaceHeader(input: EnsureSlackSurfaceInput): string {
  const issueUrl = `https://github.com/${input.repository.owner}/${input.repository.name}/issues/${input.issueNumber.toString()}`;
  const pullRequestUrl =
    input.pullRequestNumber === undefined
      ? undefined
      : `https://github.com/${input.repository.owner}/${input.repository.name}/pull/${input.pullRequestNumber.toString()}`;
  return [
    `*#${input.issueNumber.toString()} ${input.ticketTitle}*`,
    `<${issueUrl}|GitHub issue> · status: \`${input.status}\``,
    ...(pullRequestUrl === undefined ? [] : [`<${pullRequestUrl}|Pull request>`]),
    `Workflow: \`${input.workflowId}\` · Project item: \`${input.projectItemId}\``,
    terminalStatus(input.status)
      ? "This Thor session is closed."
      : "Commands: `@Thor steer: …`, `@Thor queue: …`, or `@Thor cancel: …`",
  ].join("\n");
}

function surfaceBlocks(input: EnsureSlackSurfaceInput) {
  return [
    { type: "section" as const, markdown: surfaceHeader(input) },
    ...(terminalStatus(input.status)
      ? []
      : [
          {
            type: "actions" as const,
            elements: [
              {
                type: "button" as const,
                text: "Cancel agent",
                actionId: "thor_cancel",
                value: input.workflowId,
                style: "danger" as const,
              },
            ],
          },
        ]),
  ];
}

function terminalStatus(status: string): boolean {
  return status === "done" || status === "cancelled" || status === "orphaned";
}

function topic(input: EnsureSlackSurfaceInput): string {
  return `Thor ticket #${input.issueNumber.toString()} · ${input.repository.owner}/${input.repository.name} · ${input.workflowId}`.slice(
    0,
    250,
  );
}
