import {
  slackChannelIdSchema,
  slackConversationSchema,
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
  type SlackPermalink,
  type SlackRepliesInput,
  type SlackStreamReference,
  type SlackTimestamp,
  type SlackUserGroupId,
  type SlackUserId,
  type StartSlackStreamInput,
  type UpdateSlackMessageInput,
} from "./types.js";

type MutableConversation = {
  id: SlackChannelId;
  name: string;
  isPrivate: boolean;
  isArchived: boolean;
  creatorId?: SlackUserId;
  topic: string;
  memberIds: Set<SlackUserId>;
  messages: SlackMessage[];
};

export type FakeSlackCall =
  | { kind: "post_message"; input: PostSlackMessageInput }
  | { kind: "update_message"; input: UpdateSlackMessageInput }
  | { kind: "start_stream"; input: StartSlackStreamInput }
  | { kind: "append_stream"; input: SlackStreamReference & { text: string } }
  | { kind: "stop_stream"; input: SlackStreamReference & { text?: string } }
  | { kind: "create_conversation"; name: string; isPrivate: boolean }
  | { kind: "set_topic"; channelId: SlackChannelId; topic: string }
  | { kind: "invite_users"; channelId: SlackChannelId; userIds: SlackUserId[] }
  | { kind: "archive_conversation"; channelId: SlackChannelId }
  | { kind: "unarchive_conversation"; channelId: SlackChannelId };

export class FakeSlackApi implements SlackApi {
  public readonly calls: FakeSlackCall[] = [];
  private readonly conversations = new Map<SlackChannelId, MutableConversation>();
  private readonly userGroups = new Map<SlackUserGroupId, SlackUserId[]>();
  private nextChannel = 1;
  private nextMessage = 1;

  public constructor(private readonly botUserId: SlackUserId = slackUserIdSchema.parse("UTHOR")) {}

  public seedConversation(
    input: Omit<SlackConversation, "memberIds"> & { memberIds?: SlackUserId[] },
  ): void {
    const parsed = slackConversationSchema.parse({ ...input, memberIds: input.memberIds ?? [] });
    this.conversations.set(parsed.id, {
      id: parsed.id,
      name: parsed.name,
      isPrivate: parsed.isPrivate,
      isArchived: parsed.isArchived,
      ...(parsed.creatorId === undefined ? {} : { creatorId: parsed.creatorId }),
      topic: parsed.topic,
      memberIds: new Set(parsed.memberIds),
      messages: [],
    });
  }

  public seedUserGroup(userGroupId: SlackUserGroupId, members: SlackUserId[]): void {
    this.userGroups.set(userGroupId, [...members]);
  }

  public seedMessage(
    input: Omit<SlackMessage, "timestamp" | "replyCount"> & {
      timestamp?: SlackTimestamp;
      replyCount?: number;
    },
  ): SlackMessage {
    const conversation = this.requireConversation(input.channelId);
    const message = slackMessageSchema.parse({
      ...input,
      timestamp: input.timestamp ?? this.timestamp(),
      replyCount: input.replyCount ?? 0,
    });
    conversation.messages.push(message);
    if (message.threadTimestamp !== undefined) {
      this.incrementReplyCount(conversation, message.threadTimestamp);
    }
    return structuredClone(message);
  }

  public postMessage(input: PostSlackMessageInput): Promise<SlackMessage> {
    this.calls.push({ kind: "post_message", input });
    const conversation = this.requireConversation(input.channelId);
    const message = slackMessageSchema.parse({
      channelId: input.channelId,
      timestamp: this.timestamp(),
      ...(input.threadTs === undefined ? {} : { threadTimestamp: input.threadTs }),
      text: input.text,
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      botId: "BTHOR",
      replyCount: 0,
    });
    conversation.messages.push(message);
    if (input.threadTs !== undefined) this.incrementReplyCount(conversation, input.threadTs);
    return Promise.resolve(structuredClone(message));
  }

  public updateMessage(input: UpdateSlackMessageInput): Promise<SlackMessage> {
    this.calls.push({ kind: "update_message", input });
    const conversation = this.requireConversation(input.channelId);
    const index = conversation.messages.findIndex(
      (message) => message.timestamp === input.messageTs,
    );
    if (index < 0) throw new Error(`unknown Slack message ${input.messageTs}`);
    const current = conversation.messages[index];
    if (current === undefined) throw new Error(`unknown Slack message ${input.messageTs}`);
    const updated = slackMessageSchema.parse({
      ...current,
      text: input.text,
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    });
    conversation.messages[index] = updated;
    return Promise.resolve(structuredClone(updated));
  }

  public async startStream(input: StartSlackStreamInput): Promise<SlackStreamReference> {
    this.calls.push({ kind: "start_stream", input });
    const message = await this.postMessage({
      channelId: input.channelId,
      threadTs: input.threadTs,
      text: input.text ?? "",
    });
    return { channelId: message.channelId, messageTs: message.timestamp };
  }

  public async appendStream(input: SlackStreamReference & { text: string }): Promise<void> {
    this.calls.push({ kind: "append_stream", input });
    const message = this.requireMessage(input.channelId, input.messageTs);
    await this.updateMessage({
      channelId: input.channelId,
      messageTs: input.messageTs,
      text: `${message.text}${input.text}`,
      ...(message.metadata === undefined ? {} : { metadata: message.metadata }),
    });
  }

  public async stopStream(input: SlackStreamReference & { text?: string }): Promise<void> {
    this.calls.push({ kind: "stop_stream", input });
    if (input.text !== undefined) {
      await this.appendStream({ ...input, text: input.text });
    }
  }

  public getPermalink(
    channelId: SlackChannelId,
    messageTs: SlackTimestamp,
  ): Promise<SlackPermalink> {
    this.requireMessage(channelId, messageTs);
    return Promise.resolve(
      slackPermalinkSchema.parse(
        `https://fake.slack.com/archives/${channelId}/p${messageTs.replace(".", "")}`,
      ),
    );
  }

  public createConversation(name: string, isPrivate: boolean): Promise<SlackConversation> {
    this.calls.push({ kind: "create_conversation", name, isPrivate });
    const existing = [...this.conversations.values()].find(
      (conversation) => conversation.name === name,
    );
    if (existing !== undefined) throw new Error("name_taken");
    const prefix = isPrivate ? "G" : "C";
    const id = slackChannelIdSchema.parse(`${prefix}FAKE${this.nextChannel.toString()}`);
    this.nextChannel += 1;
    this.seedConversation({
      id,
      name,
      isPrivate,
      isArchived: false,
      creatorId: this.botUserId,
      topic: "",
    });
    return this.getConversation(id);
  }

  public getConversation(channelId: SlackChannelId): Promise<SlackConversation> {
    return Promise.resolve(this.snapshotConversation(this.requireConversation(channelId)));
  }

  public listConversations(cursor?: string): Promise<SlackPage<SlackConversation>> {
    const start = cursor === undefined ? 0 : Number(cursor);
    const values = [...this.conversations.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(start, start + 100)
      .map((conversation) => this.snapshotConversation(conversation));
    const next = start + values.length;
    return Promise.resolve({
      values,
      ...(next < this.conversations.size ? { nextCursor: String(next) } : {}),
    });
  }

  public getConversationMembers(channelId: SlackChannelId): Promise<SlackUserId[]> {
    return Promise.resolve([...this.requireConversation(channelId).memberIds].sort());
  }

  public setConversationTopic(channelId: SlackChannelId, topic: string): Promise<void> {
    this.calls.push({ kind: "set_topic", channelId, topic });
    this.requireConversation(channelId).topic = topic;
    return Promise.resolve();
  }

  public inviteUsers(channelId: SlackChannelId, userIds: SlackUserId[]): Promise<void> {
    this.calls.push({ kind: "invite_users", channelId, userIds: [...userIds] });
    const conversation = this.requireConversation(channelId);
    for (const userId of userIds) conversation.memberIds.add(userId);
    return Promise.resolve();
  }

  public archiveConversation(channelId: SlackChannelId): Promise<void> {
    this.calls.push({ kind: "archive_conversation", channelId });
    this.requireConversation(channelId).isArchived = true;
    return Promise.resolve();
  }

  public unarchiveConversation(channelId: SlackChannelId): Promise<void> {
    this.calls.push({ kind: "unarchive_conversation", channelId });
    this.requireConversation(channelId).isArchived = false;
    return Promise.resolve();
  }

  public history(input: SlackHistoryInput): Promise<SlackPage<SlackMessage>> {
    const messages = this.requireConversation(input.channelId).messages.filter(
      (message) => message.threadTimestamp === undefined && this.afterOldest(message, input),
    );
    return Promise.resolve(this.messagePage(messages, input));
  }

  public replies(input: SlackRepliesInput): Promise<SlackPage<SlackMessage>> {
    const messages = this.requireConversation(input.channelId).messages.filter(
      (message) =>
        (message.timestamp === input.threadTs || message.threadTimestamp === input.threadTs) &&
        this.afterOldest(message, input),
    );
    return Promise.resolve(this.messagePage(messages, input));
  }

  public getUserGroupMembers(userGroupId: SlackUserGroupId): Promise<SlackUserId[]> {
    return Promise.resolve([...(this.userGroups.get(userGroupId) ?? [])]);
  }

  private requireConversation(channelId: SlackChannelId): MutableConversation {
    const conversation = this.conversations.get(channelId);
    if (conversation === undefined) throw new Error(`unknown Slack conversation ${channelId}`);
    return conversation;
  }

  private requireMessage(channelId: SlackChannelId, messageTs: SlackTimestamp): SlackMessage {
    const message = this.requireConversation(channelId).messages.find(
      (candidate) => candidate.timestamp === messageTs,
    );
    if (message === undefined) throw new Error(`unknown Slack message ${messageTs}`);
    return message;
  }

  private snapshotConversation(conversation: MutableConversation): SlackConversation {
    return slackConversationSchema.parse({
      id: conversation.id,
      name: conversation.name,
      isPrivate: conversation.isPrivate,
      isArchived: conversation.isArchived,
      ...(conversation.creatorId === undefined ? {} : { creatorId: conversation.creatorId }),
      topic: conversation.topic,
      memberIds: [...conversation.memberIds].sort(),
    });
  }

  private timestamp(): SlackTimestamp {
    const timestamp = slackTimestampSchema.parse(
      `1700000000.${this.nextMessage.toString().padStart(6, "0")}`,
    );
    this.nextMessage += 1;
    return timestamp;
  }

  private incrementReplyCount(conversation: MutableConversation, threadTs: SlackTimestamp): void {
    const index = conversation.messages.findIndex((message) => message.timestamp === threadTs);
    if (index < 0) return;
    const root = conversation.messages[index];
    if (root === undefined) return;
    const reply = conversation.messages.at(-1);
    conversation.messages[index] = {
      ...root,
      replyCount: root.replyCount + 1,
      ...(reply === undefined ? {} : { latestReply: reply.timestamp }),
    };
  }

  private afterOldest(message: SlackMessage, input: SlackHistoryInput): boolean {
    if (input.oldest === undefined) return true;
    return input.inclusive === true
      ? message.timestamp >= input.oldest
      : message.timestamp > input.oldest;
  }

  private messagePage(messages: SlackMessage[], input: SlackHistoryInput): SlackPage<SlackMessage> {
    const start = input.cursor === undefined ? 0 : Number(input.cursor);
    const limit = input.limit ?? 100;
    const values = messages
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
      .slice(start, start + limit)
      .map((message) => structuredClone(message));
    const next = start + values.length;
    return { values, ...(next < messages.length ? { nextCursor: String(next) } : {}) };
  }
}
