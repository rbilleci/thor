import { z } from "zod";

export const slackWorkspaceIdSchema = z
  .string()
  .regex(/^T[A-Z0-9]+$/, "invalid Slack workspace ID");
export type SlackWorkspaceId = z.infer<typeof slackWorkspaceIdSchema>;

export const slackChannelIdSchema = z.string().regex(/^[CG][A-Z0-9]+$/, "invalid Slack channel ID");
export type SlackChannelId = z.infer<typeof slackChannelIdSchema>;

export const slackUserIdSchema = z.string().regex(/^[UW][A-Z0-9]+$/, "invalid Slack user ID");
export type SlackUserId = z.infer<typeof slackUserIdSchema>;

export const slackUserGroupIdSchema = z
  .string()
  .regex(/^S[A-Z0-9]+$/, "invalid Slack user-group ID");
export type SlackUserGroupId = z.infer<typeof slackUserGroupIdSchema>;

export const slackTimestampSchema = z.string().regex(/^\d{10,}\.\d{6}$/, "invalid Slack timestamp");
export type SlackTimestamp = z.infer<typeof slackTimestampSchema>;

export const slackPermalinkSchema = z.url().refine((value) => {
  const hostname = new URL(value).hostname;
  return hostname === "slack.com" || hostname.endsWith(".slack.com");
}, "invalid Slack permalink");
export type SlackPermalink = z.infer<typeof slackPermalinkSchema>;

export const slackMessageMetadataSchema = z.strictObject({
  eventType: z.string().trim().min(1).max(80),
  eventPayload: z.record(z.string().trim().min(1), z.string().max(3000)),
});
export type SlackMessageMetadata = z.infer<typeof slackMessageMetadataSchema>;

export const slackMessageSchema = z.strictObject({
  channelId: slackChannelIdSchema,
  timestamp: slackTimestampSchema,
  threadTimestamp: slackTimestampSchema.optional(),
  text: z.string(),
  metadata: slackMessageMetadataSchema.optional(),
  userId: slackUserIdSchema.optional(),
  botId: z.string().min(1).optional(),
  replyCount: z.number().int().nonnegative().default(0),
  latestReply: slackTimestampSchema.optional(),
});
export type SlackMessage = z.infer<typeof slackMessageSchema>;

export const slackConversationSchema = z.strictObject({
  id: slackChannelIdSchema,
  name: z.string().min(1),
  isPrivate: z.boolean(),
  isArchived: z.boolean(),
  creatorId: slackUserIdSchema.optional(),
  topic: z.string(),
  memberIds: z.array(slackUserIdSchema),
});
export type SlackConversation = z.infer<typeof slackConversationSchema>;

export const slackTaskSurfaceSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("thread_per_ticket"),
    workspaceId: slackWorkspaceIdSchema,
    channelId: slackChannelIdSchema,
    threadTs: slackTimestampSchema,
    headerTs: slackTimestampSchema,
    permalink: slackPermalinkSchema,
  }),
  z.strictObject({
    mode: z.literal("channel_per_ticket"),
    workspaceId: slackWorkspaceIdSchema,
    channelId: slackChannelIdSchema,
    headerTs: slackTimestampSchema,
    permalink: slackPermalinkSchema,
  }),
]);
export type SlackTaskSurface = z.infer<typeof slackTaskSurfaceSchema>;

export const slackSurfaceKeySchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("thread_per_ticket"),
    channelId: slackChannelIdSchema,
    threadTs: slackTimestampSchema,
  }),
  z.strictObject({
    mode: z.literal("channel_per_ticket"),
    channelId: slackChannelIdSchema,
  }),
]);
export type SlackSurfaceKey = z.infer<typeof slackSurfaceKeySchema>;

export const slackCommandModeSchema = z.enum(["queue", "redirect", "cancel"]);
export type SlackCommandMode = z.infer<typeof slackCommandModeSchema>;

export const slackCommandReferenceSchema = z.strictObject({
  commandId: z.string().min(1),
  eventId: z.string().min(1),
  workspaceId: slackWorkspaceIdSchema,
  channelId: slackChannelIdSchema,
  threadTs: slackTimestampSchema.optional(),
  messageTs: slackTimestampSchema,
  actorId: slackUserIdSchema,
  mode: slackCommandModeSchema,
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type SlackCommandReference = z.infer<typeof slackCommandReferenceSchema>;

export type SlackCommand = SlackCommandReference & { text: string };

export type SlackMessageBlock =
  | { type: "section"; markdown: string }
  | {
      type: "actions";
      elements: {
        type: "button";
        text: string;
        actionId: string;
        value?: string;
        style?: "primary" | "danger";
      }[];
    };

export type PostSlackMessageInput = {
  channelId: SlackChannelId;
  text: string;
  threadTs?: SlackTimestamp;
  metadata?: SlackMessageMetadata;
  blocks?: SlackMessageBlock[];
};

export type UpdateSlackMessageInput = {
  channelId: SlackChannelId;
  messageTs: SlackTimestamp;
  text: string;
  metadata?: SlackMessageMetadata;
  blocks?: SlackMessageBlock[];
};

export type StartSlackStreamInput = {
  channelId: SlackChannelId;
  threadTs: SlackTimestamp;
  recipientUserId: SlackUserId;
  recipientTeamId: SlackWorkspaceId;
  text?: string;
};

export type SlackStreamReference = {
  channelId: SlackChannelId;
  messageTs: SlackTimestamp;
};

export type SlackHistoryInput = {
  channelId: SlackChannelId;
  oldest?: SlackTimestamp;
  inclusive?: boolean;
  limit?: number;
  cursor?: string;
};

export type SlackRepliesInput = SlackHistoryInput & { threadTs: SlackTimestamp };

export type SlackPage<Value> = {
  values: Value[];
  nextCursor?: string;
};

export type SlackApi = {
  postMessage(input: PostSlackMessageInput): Promise<SlackMessage>;
  updateMessage(input: UpdateSlackMessageInput): Promise<SlackMessage>;
  startStream(input: StartSlackStreamInput): Promise<SlackStreamReference>;
  appendStream(input: SlackStreamReference & { text: string }): Promise<void>;
  stopStream(input: SlackStreamReference & { text?: string }): Promise<void>;
  getPermalink(channelId: SlackChannelId, messageTs: SlackTimestamp): Promise<SlackPermalink>;
  createConversation(name: string, isPrivate: boolean): Promise<SlackConversation>;
  getConversation(channelId: SlackChannelId): Promise<SlackConversation>;
  listConversations(cursor?: string): Promise<SlackPage<SlackConversation>>;
  getConversationMembers(channelId: SlackChannelId): Promise<SlackUserId[]>;
  setConversationTopic(channelId: SlackChannelId, topic: string): Promise<void>;
  inviteUsers(channelId: SlackChannelId, userIds: SlackUserId[]): Promise<void>;
  archiveConversation(channelId: SlackChannelId): Promise<void>;
  unarchiveConversation(channelId: SlackChannelId): Promise<void>;
  history(input: SlackHistoryInput): Promise<SlackPage<SlackMessage>>;
  replies(input: SlackRepliesInput): Promise<SlackPage<SlackMessage>>;
  getUserGroupMembers(userGroupId: SlackUserGroupId): Promise<SlackUserId[]>;
};

export class SlackApiError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly retryAfterMs?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SlackApiError";
  }
}

export function slackSurfaceKey(surface: SlackTaskSurface): SlackSurfaceKey {
  return surface.mode === "thread_per_ticket"
    ? { mode: surface.mode, channelId: surface.channelId, threadTs: surface.threadTs }
    : { mode: surface.mode, channelId: surface.channelId };
}

export function slackSurfaceKeyString(key: SlackSurfaceKey): string {
  return key.mode === "thread_per_ticket"
    ? `thread:${key.channelId}:${key.threadTs}`
    : `channel:${key.channelId}`;
}
