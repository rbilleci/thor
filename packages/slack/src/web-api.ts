import { z } from "zod";

import {
  SlackApiError,
  slackChannelIdSchema,
  slackMessageMetadataSchema,
  slackMessageSchema,
  slackPermalinkSchema,
  slackTimestampSchema,
  slackUserIdSchema,
  type PostSlackMessageInput,
  type SlackApi,
  type SlackChannelId,
  type SlackConversation,
  type SlackHistoryInput,
  type SlackMessage,
  type SlackPage,
  type SlackRepliesInput,
  type SlackStreamReference,
  type SlackUserGroupId,
  type SlackUserId,
  type StartSlackStreamInput,
  type UpdateSlackMessageInput,
} from "./types.js";

export type SlackFetch = (
  input: string,
  init: {
    method: "POST";
    headers: Readonly<Record<string, string>>;
    body: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export type SlackWebApiClientOptions = {
  baseUrl?: string;
  fetch?: SlackFetch;
};

const responseEnvelopeSchema = z.looseObject({
  ok: z.boolean(),
  error: z.string().optional(),
});

const externalMetadataSchema = z.object({
  event_type: z.string(),
  event_payload: z.record(z.string(), z.string()),
});

const externalMessageSchema = z
  .object({
    ts: slackTimestampSchema,
    thread_ts: slackTimestampSchema.optional(),
    text: z.string().default(""),
    metadata: externalMetadataSchema.optional(),
    user: slackUserIdSchema.optional(),
    bot_id: z.string().min(1).optional(),
    reply_count: z.number().int().nonnegative().default(0),
    latest_reply: slackTimestampSchema.optional(),
  })
  .loose();

const externalConversationSchema = z
  .object({
    id: slackChannelIdSchema,
    name: z.string().min(1),
    is_private: z.boolean().default(false),
    is_archived: z.boolean().default(false),
    creator: slackUserIdSchema.optional(),
    topic: z.object({ value: z.string().default("") }).default({ value: "" }),
  })
  .loose();

const cursorSchema = z
  .object({
    response_metadata: z.object({ next_cursor: z.string().default("") }).optional(),
  })
  .loose();

export class SlackWebApiClient implements SlackApi {
  private readonly baseUrl: string;
  private readonly fetch: SlackFetch;

  public constructor(
    private readonly token: string,
    options: SlackWebApiClientOptions = {},
  ) {
    if (token.trim().length === 0) throw new Error("Slack bot token is required");
    this.baseUrl = (options.baseUrl ?? "https://slack.com/api").replace(/\/$/, "");
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  public async postMessage(input: PostSlackMessageInput): Promise<SlackMessage> {
    const raw = await this.call("chat.postMessage", {
      channel: input.channelId,
      text: input.text,
      ...(input.threadTs === undefined ? {} : { thread_ts: input.threadTs }),
      ...(input.metadata === undefined ? {} : { metadata: externalMetadata(input.metadata) }),
      ...(input.blocks === undefined ? {} : { blocks: externalBlocks(input.blocks) }),
    });
    const parsed = z
      .object({
        channel: slackChannelIdSchema.optional(),
        ts: slackTimestampSchema,
        message: externalMessageSchema.optional(),
      })
      .parse(raw);
    return normalizeMessage(input.channelId, parsed.message ?? { ts: parsed.ts, text: input.text });
  }

  public async updateMessage(input: UpdateSlackMessageInput): Promise<SlackMessage> {
    const raw = await this.call("chat.update", {
      channel: input.channelId,
      ts: input.messageTs,
      text: input.text,
      ...(input.metadata === undefined ? {} : { metadata: externalMetadata(input.metadata) }),
      ...(input.blocks === undefined ? {} : { blocks: externalBlocks(input.blocks) }),
    });
    const parsed = z
      .object({ ts: slackTimestampSchema, message: externalMessageSchema.optional() })
      .parse(raw);
    return normalizeMessage(input.channelId, parsed.message ?? { ts: parsed.ts, text: input.text });
  }

  public async startStream(input: StartSlackStreamInput): Promise<SlackStreamReference> {
    const raw = await this.call("chat.startStream", {
      channel: input.channelId,
      thread_ts: input.threadTs,
      recipient_user_id: input.recipientUserId,
      recipient_team_id: input.recipientTeamId,
      ...(input.text === undefined ? {} : { markdown_text: input.text }),
    });
    const parsed = z.object({ ts: slackTimestampSchema }).parse(raw);
    return { channelId: input.channelId, messageTs: parsed.ts };
  }

  public async appendStream(input: SlackStreamReference & { text: string }): Promise<void> {
    await this.call("chat.appendStream", {
      channel: input.channelId,
      ts: input.messageTs,
      markdown_text: input.text,
    });
  }

  public async stopStream(input: SlackStreamReference & { text?: string }): Promise<void> {
    await this.call("chat.stopStream", {
      channel: input.channelId,
      ts: input.messageTs,
      ...(input.text === undefined ? {} : { markdown_text: input.text }),
    });
  }

  public async getPermalink(channelId: SlackChannelId, messageTs: string) {
    const raw = await this.call("chat.getPermalink", { channel: channelId, message_ts: messageTs });
    return slackPermalinkSchema.parse(z.object({ permalink: z.string() }).parse(raw).permalink);
  }

  public async createConversation(name: string, isPrivate: boolean): Promise<SlackConversation> {
    const raw = await this.call("conversations.create", { name, is_private: isPrivate });
    const channel = z.object({ channel: externalConversationSchema }).parse(raw).channel;
    return normalizeConversation(channel);
  }

  public async getConversation(channelId: SlackChannelId): Promise<SlackConversation> {
    const raw = await this.call("conversations.info", { channel: channelId });
    const channel = z.object({ channel: externalConversationSchema }).parse(raw).channel;
    return normalizeConversation(channel);
  }

  public async listConversations(cursor?: string): Promise<SlackPage<SlackConversation>> {
    const raw = await this.call("conversations.list", {
      types: "public_channel,private_channel",
      exclude_archived: false,
      limit: 200,
      ...(cursor === undefined || cursor.length === 0 ? {} : { cursor }),
    });
    const parsed = z
      .object({ channels: z.array(externalConversationSchema) })
      .and(cursorSchema)
      .parse(raw);
    const nextCursor = parsed.response_metadata?.next_cursor;
    return {
      values: parsed.channels.map(normalizeConversation),
      ...(nextCursor === undefined || nextCursor.length === 0 ? {} : { nextCursor }),
    };
  }

  public async getConversationMembers(channelId: SlackChannelId): Promise<SlackUserId[]> {
    const members: SlackUserId[] = [];
    let cursor: string | undefined;
    do {
      const raw = await this.call("conversations.members", {
        channel: channelId,
        limit: 200,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const parsed = z
        .object({ members: z.array(slackUserIdSchema) })
        .and(cursorSchema)
        .parse(raw);
      members.push(...parsed.members);
      const next = parsed.response_metadata?.next_cursor;
      cursor = next === undefined || next.length === 0 ? undefined : next;
    } while (cursor !== undefined);
    return [...new Set(members)].sort();
  }

  public async setConversationTopic(channelId: SlackChannelId, topic: string): Promise<void> {
    await this.call("conversations.setTopic", { channel: channelId, topic });
  }

  public async inviteUsers(channelId: SlackChannelId, userIds: SlackUserId[]): Promise<void> {
    if (userIds.length === 0) return;
    await this.call("conversations.invite", { channel: channelId, users: userIds.join(",") });
  }

  public async archiveConversation(channelId: SlackChannelId): Promise<void> {
    await this.call("conversations.archive", { channel: channelId });
  }

  public async unarchiveConversation(channelId: SlackChannelId): Promise<void> {
    await this.call("conversations.unarchive", { channel: channelId });
  }

  public history(input: SlackHistoryInput): Promise<SlackPage<SlackMessage>> {
    return this.messageHistory("conversations.history", input);
  }

  public replies(input: SlackRepliesInput): Promise<SlackPage<SlackMessage>> {
    return this.messageHistory("conversations.replies", input, { ts: input.threadTs });
  }

  public async getUserGroupMembers(userGroupId: SlackUserGroupId): Promise<SlackUserId[]> {
    const raw = await this.call("usergroups.users.list", { usergroup: userGroupId });
    return z.object({ users: z.array(slackUserIdSchema) }).parse(raw).users;
  }

  private async messageHistory(
    method: "conversations.history" | "conversations.replies",
    input: SlackHistoryInput,
    extra: Readonly<Record<string, unknown>> = {},
  ): Promise<SlackPage<SlackMessage>> {
    const raw = await this.call(method, {
      channel: input.channelId,
      ...extra,
      ...(input.oldest === undefined ? {} : { oldest: input.oldest }),
      ...(input.inclusive === undefined ? {} : { inclusive: input.inclusive }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    });
    const parsed = z
      .object({ messages: z.array(externalMessageSchema) })
      .and(cursorSchema)
      .parse(raw);
    const nextCursor = parsed.response_metadata?.next_cursor;
    return {
      values: parsed.messages.map((message) => normalizeMessage(input.channelId, message)),
      ...(nextCursor === undefined || nextCursor.length === 0 ? {} : { nextCursor }),
    };
  }

  private async call(method: string, body: Readonly<Record<string, unknown>>): Promise<unknown> {
    let response: Awaited<ReturnType<SlackFetch>>;
    try {
      response = await this.fetch(`${this.baseUrl}/${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new SlackApiError("Slack request failed", "network_error", true, undefined, {
        cause: error,
      });
    }
    const retryAfterMs = retryAfter(response.headers.get("retry-after"));
    if (!response.ok) {
      throw new SlackApiError(
        `Slack ${method} returned HTTP ${response.status.toString()}`,
        response.status === 429 ? "rate_limited" : "http_error",
        response.status === 429 || response.status >= 500,
        retryAfterMs,
      );
    }
    let raw: unknown;
    try {
      raw = await response.json();
    } catch (error) {
      throw new SlackApiError("Slack returned invalid JSON", "invalid_response", true, undefined, {
        cause: error,
      });
    }
    const envelope = responseEnvelopeSchema.parse(raw);
    if (!envelope.ok) {
      const code = envelope.error ?? "unknown_error";
      throw new SlackApiError(
        `Slack ${method} failed: ${code}`,
        code,
        retryableSlackCode(code),
        retryAfterMs,
      );
    }
    return raw;
  }
}

function externalMetadata(metadata: {
  eventType: string;
  eventPayload: Record<string, string>;
}): Record<string, unknown> {
  return { event_type: metadata.eventType, event_payload: metadata.eventPayload };
}

function externalBlocks(
  blocks: NonNullable<PostSlackMessageInput["blocks"]>,
): Record<string, unknown>[] {
  return blocks.map((block) =>
    block.type === "section"
      ? { type: "section", text: { type: "mrkdwn", text: block.markdown } }
      : {
          type: "actions",
          elements: block.elements.map((element) => ({
            type: "button",
            text: { type: "plain_text", text: element.text },
            action_id: element.actionId,
            ...(element.value === undefined ? {} : { value: element.value }),
            ...(element.style === undefined ? {} : { style: element.style }),
          })),
        },
  );
}

function normalizeMessage(channelId: SlackChannelId, message: unknown): SlackMessage {
  const parsed = externalMessageSchema.parse(message);
  return slackMessageSchema.parse({
    channelId,
    timestamp: parsed.ts,
    ...(parsed.thread_ts === undefined ? {} : { threadTimestamp: parsed.thread_ts }),
    text: parsed.text,
    ...(parsed.metadata === undefined
      ? {}
      : {
          metadata: slackMessageMetadataSchema.parse({
            eventType: parsed.metadata.event_type,
            eventPayload: parsed.metadata.event_payload,
          }),
        }),
    ...(parsed.user === undefined ? {} : { userId: parsed.user }),
    ...(parsed.bot_id === undefined ? {} : { botId: parsed.bot_id }),
    replyCount: parsed.reply_count,
    ...(parsed.latest_reply === undefined ? {} : { latestReply: parsed.latest_reply }),
  });
}

function normalizeConversation(
  channel: z.infer<typeof externalConversationSchema>,
): SlackConversation {
  return {
    id: channel.id,
    name: channel.name,
    isPrivate: channel.is_private,
    isArchived: channel.is_archived,
    ...(channel.creator === undefined ? {} : { creatorId: channel.creator }),
    topic: channel.topic.value,
    memberIds: [],
  };
}

function retryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : undefined;
}

function retryableSlackCode(code: string): boolean {
  return new Set([
    "fatal_error",
    "internal_error",
    "rate_limited",
    "request_timeout",
    "service_unavailable",
  ]).has(code);
}
