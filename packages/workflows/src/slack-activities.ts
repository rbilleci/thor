import { createHash } from "node:crypto";

import { ApplicationFailure } from "@temporalio/common";
import {
  parseSlackCommand,
  SlackApiError,
  slackCommandDigest,
  slackCommandContainsSecret,
  slackCommandReferenceSchema,
  slackSurfaceKey,
  slackSurfaceKeyString,
  type SlackApi,
  type SlackCommandReference,
  type SlackMessage,
  type SlackTaskSurface,
  type SlackTimestamp,
  type SlackUserId,
} from "@thor/slack";

import {
  acceptedSlackCommandSchema,
  type ReconcileSlackCommandsInput,
  type ReconcileSlackCommandsResult,
  type SlackRouterActivities,
  type SlackRouterRegistration,
} from "./slack-contracts.js";

export type SlackRouterActivityDependencies = {
  slack: SlackApi;
  botUserId: SlackUserId;
};

export function createSlackRouterActivities(
  dependencies: SlackRouterActivityDependencies,
): SlackRouterActivities {
  const implementation: SlackRouterActivities = {
    async materializeSlackCommand(input) {
      const existing = await findReceipt(
        dependencies.slack,
        input.registration.surface,
        input.reference.commandId,
      );
      if (
        existing !== undefined &&
        existing.metadata?.eventPayload.contentDigest === input.reference.contentDigest
      ) {
        return acceptedSlackCommandSchema.parse({
          reference: input.reference,
          receiptTs: existing.timestamp,
        });
      }
      const message = await findSourceMessage(
        dependencies.slack,
        input.registration.surface,
        input.reference,
      );
      const blockAction = input.reference.eventId.startsWith("interaction:");
      if (!blockAction && message.userId !== input.reference.actorId) {
        throw ApplicationFailure.nonRetryable(
          "Slack command actor does not match the source message",
          "slack_invalid_command",
        );
      }
      if (
        blockAction &&
        (message.botId === undefined ||
          (message.metadata?.eventType !== "thor_ticket_surface" &&
            message.metadata?.eventType !== "thor_agent_execution"))
      ) {
        throw ApplicationFailure.nonRetryable(
          "Slack Block Kit action did not originate from a Thor message",
          "slack_invalid_command",
        );
      }
      if (!(await isAuthorized(dependencies.slack, input.registration, input.reference.actorId))) {
        throw ApplicationFailure.nonRetryable(
          "Slack actor is not authorized to steer this ticket",
          "slack_unauthorized",
        );
      }
      const parsed = blockAction
        ? { mode: "cancel" as const, text: "cancel requested through Block Kit" }
        : parseSlackCommand(message.text, dependencies.botUserId, input.registration.defaultMode);
      if (
        parsed?.mode !== input.reference.mode ||
        slackCommandContainsSecret(parsed.text) ||
        slackCommandDigest(parsed.text) !== input.reference.contentDigest
      ) {
        throw ApplicationFailure.nonRetryable(
          "Slack command content or mode does not match its accepted reference",
          "slack_invalid_command",
        );
      }

      const receipt = await dependencies.slack.postMessage({
        channelId: input.registration.surface.channelId,
        ...(input.registration.surface.mode === "thread_per_ticket"
          ? { threadTs: input.registration.surface.threadTs }
          : {}),
        text: [
          `Command from <@${input.reference.actorId}> accepted as *${parsed.mode}* · \`${input.reference.commandId}\``,
          "",
          "```",
          parsed.text.slice(0, 3_000),
          "```",
        ].join("\n"),
        metadata: {
          eventType: "thor_command_receipt",
          eventPayload: {
            commandId: input.reference.commandId,
            sourceMessageTs: input.reference.messageTs,
            contentDigest: input.reference.contentDigest,
          },
        },
      });
      return acceptedSlackCommandSchema.parse({
        reference: input.reference,
        receiptTs: receipt.timestamp,
      });
    },

    async replyClosedSlackSession(input) {
      const existing = (
        await surfaceMessages(dependencies.slack, input.registration.surface, 500)
      ).messages.find(
        (message) =>
          message.botId !== undefined &&
          message.metadata?.eventType === "thor_closed_session" &&
          message.metadata.eventPayload.commandId === input.reference.commandId,
      );
      if (existing !== undefined) return;
      if (!(await isAuthorized(dependencies.slack, input.registration, input.reference.actorId))) {
        throw ApplicationFailure.nonRetryable(
          "Slack actor is not authorized to steer this ticket",
          "slack_unauthorized",
        );
      }
      await dependencies.slack.postMessage({
        channelId: input.registration.surface.channelId,
        ...(input.registration.surface.mode === "thread_per_ticket"
          ? { threadTs: input.registration.surface.threadTs }
          : {}),
        text: `This Thor session is closed; update the GitHub ticket to start or resume delivery. · \`${input.reference.commandId}\``,
        metadata: {
          eventType: "thor_closed_session",
          eventPayload: { commandId: input.reference.commandId },
        },
      });
    },

    async archiveSlackTicketChannel(input) {
      if (input.registration.surface.mode !== "channel_per_ticket") return;
      const conversation = await dependencies.slack.getConversation(
        input.registration.surface.channelId,
      );
      if (!conversation.isArchived) {
        await dependencies.slack.archiveConversation(input.registration.surface.channelId);
      }
    },

    async unarchiveSlackTicketChannel(input) {
      if (input.registration.surface.mode !== "channel_per_ticket") return;
      const conversation = await dependencies.slack.getConversation(
        input.registration.surface.channelId,
      );
      if (conversation.isArchived) {
        await dependencies.slack.unarchiveConversation(input.registration.surface.channelId);
      }
    },

    async reconcileSlackCommands(input) {
      return reconcileCommands(dependencies, input);
    },
  };
  return {
    materializeSlackCommand: (input) =>
      withSlackFailure(() => implementation.materializeSlackCommand(input)),
    replyClosedSlackSession: (input) =>
      withSlackFailure(() => implementation.replyClosedSlackSession(input)),
    archiveSlackTicketChannel: (input) =>
      withSlackFailure(() => implementation.archiveSlackTicketChannel(input)),
    unarchiveSlackTicketChannel: (input) =>
      withSlackFailure(() => implementation.unarchiveSlackTicketChannel(input)),
    reconcileSlackCommands: (input) =>
      withSlackFailure(() => implementation.reconcileSlackCommands(input)),
  };
}

async function withSlackFailure<Value>(operation: () => Promise<Value>): Promise<Value> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SlackApiError) {
      throw ApplicationFailure.create({
        message: error.message,
        type: `slack_${error.code}`,
        nonRetryable: !error.retryable,
        ...(error.retryAfterMs === undefined ? {} : { nextRetryDelay: error.retryAfterMs }),
      });
    }
    throw error;
  }
}

async function reconcileCommands(
  dependencies: SlackRouterActivityDependencies,
  input: ReconcileSlackCommandsInput,
): Promise<ReconcileSlackCommandsResult> {
  const seen = new Set(input.seenEventIds);
  const result: SlackCommandReference[] = [];
  const highWatermarks = { ...input.highWatermarks };
  for (const registration of input.registrations) {
    const key = slackSurfaceKeyString(slackSurfaceKey(registration.surface));
    const scan = await surfaceMessages(
      dependencies.slack,
      registration.surface,
      input.limit,
      highWatermarks[key],
    );
    if (scan.highWatermark !== undefined) highWatermarks[key] = scan.highWatermark;
    for (const message of scan.messages) {
      if (
        result.length >= input.limit ||
        message.userId === undefined ||
        message.botId !== undefined
      ) {
        continue;
      }
      const eventId = reconciliationEventId(message);
      if (seen.has(eventId)) continue;
      const parsed = parseSlackCommand(
        message.text,
        dependencies.botUserId,
        registration.defaultMode,
      );
      if (
        parsed === undefined ||
        !(await isAuthorized(dependencies.slack, registration, message.userId))
      ) {
        continue;
      }
      result.push(
        slackCommandReferenceSchema.parse({
          commandId: commandId(eventId, message.timestamp),
          eventId,
          workspaceId: registration.surface.workspaceId,
          channelId: registration.surface.channelId,
          ...(message.threadTimestamp === undefined
            ? registration.surface.mode === "thread_per_ticket"
              ? { threadTs: registration.surface.threadTs }
              : {}
            : { threadTs: message.threadTimestamp }),
          messageTs: message.timestamp,
          actorId: message.userId,
          mode: parsed.mode,
          contentDigest: slackCommandDigest(parsed.text),
        }),
      );
    }
  }
  return { references: result, highWatermarks };
}

async function surfaceMessages(
  slack: SlackApi,
  surface: SlackTaskSurface,
  limit: number,
  oldest?: SlackTimestamp,
): Promise<{ messages: SlackMessage[]; highWatermark?: SlackTimestamp }> {
  if (surface.mode === "thread_per_ticket") {
    const messages = await collectPages(
      (cursor) =>
        slack.replies({
          channelId: surface.channelId,
          threadTs: surface.threadTs,
          ...(oldest === undefined ? {} : { oldest }),
          limit: Math.min(limit, 100),
          ...(cursor === undefined ? {} : { cursor }),
        }),
      limit,
    );
    return { messages, ...withHighWatermark(messages, oldest) };
  }
  const roots = await collectPages(
    (cursor) =>
      slack.history({
        channelId: surface.channelId,
        limit: Math.min(limit, 100),
        ...(cursor === undefined ? {} : { cursor }),
      }),
    limit,
  );
  const changedRoots = roots.filter(
    (message) =>
      oldest === undefined ||
      message.timestamp > oldest ||
      (message.latestReply !== undefined && message.latestReply > oldest),
  );
  const messages = changedRoots.filter(
    (message) => oldest === undefined || message.timestamp > oldest,
  );
  for (const root of changedRoots.filter((message) => message.replyCount > 0).slice(0, 20)) {
    messages.push(
      ...(await collectPages(
        (cursor) =>
          slack.replies({
            channelId: surface.channelId,
            threadTs: root.timestamp,
            ...(oldest === undefined ? {} : { oldest }),
            limit: Math.min(limit, 100),
            ...(cursor === undefined ? {} : { cursor }),
          }),
        limit,
      )),
    );
    if (messages.length >= limit) break;
  }
  const observedTimestamps = [
    ...messages.map((message) => message.timestamp),
    ...changedRoots.flatMap((root) => (root.latestReply === undefined ? [] : [root.latestReply])),
  ];
  return {
    messages: uniqueMessages(messages).slice(0, limit),
    ...highWatermarkFromTimestamps(observedTimestamps, oldest),
  };
}

async function collectPages(
  load: (cursor?: string) => Promise<{ values: SlackMessage[]; nextCursor?: string }>,
  limit: number,
): Promise<SlackMessage[]> {
  const messages: SlackMessage[] = [];
  let cursor: string | undefined;
  do {
    const page = await load(cursor);
    messages.push(...page.values);
    cursor = page.nextCursor;
  } while (cursor !== undefined && messages.length < limit);
  return messages.slice(0, limit);
}

function withHighWatermark(
  messages: SlackMessage[],
  previous?: SlackTimestamp,
): { highWatermark?: SlackTimestamp } {
  return highWatermarkFromTimestamps(
    messages.map((message) => message.timestamp),
    previous,
  );
}

function highWatermarkFromTimestamps(
  timestamps: SlackTimestamp[],
  previous?: SlackTimestamp,
): { highWatermark?: SlackTimestamp } {
  const candidates = previous === undefined ? [...timestamps] : [...timestamps, previous];
  const highWatermark = candidates.sort().at(-1);
  return highWatermark === undefined ? {} : { highWatermark };
}

async function findSourceMessage(
  slack: SlackApi,
  surface: SlackTaskSurface,
  reference: SlackCommandReference,
): Promise<SlackMessage> {
  const { messages } = await surfaceMessages(slack, surface, 500);
  const message = messages.find((candidate) => candidate.timestamp === reference.messageTs);
  if (message === undefined) {
    throw ApplicationFailure.nonRetryable(
      `Slack command source ${reference.messageTs} is unavailable`,
      "slack_invalid_command",
    );
  }
  return message;
}

async function findReceipt(
  slack: SlackApi,
  surface: SlackTaskSurface,
  commandIdValue: string,
): Promise<SlackMessage | undefined> {
  return (await surfaceMessages(slack, surface, 500)).messages.find(
    (message) =>
      message.botId !== undefined &&
      message.metadata?.eventType === "thor_command_receipt" &&
      message.metadata.eventPayload.commandId === commandIdValue,
  );
}

async function isAuthorized(
  slack: SlackApi,
  registration: SlackRouterRegistration,
  actorId: SlackUserId | undefined,
): Promise<boolean> {
  if (actorId === undefined) return false;
  for (const groupId of registration.allowedUserGroupIds) {
    if ((await slack.getUserGroupMembers(groupId)).includes(actorId)) return true;
  }
  return false;
}

function reconciliationEventId(message: SlackMessage): string {
  return `reconcile:${message.channelId}:${message.timestamp}`;
}

function commandId(eventId: string, messageTs: string): string {
  return `slack:${createHash("sha256").update(`${eventId}:${messageTs}`).digest("hex").slice(0, 20)}`;
}

function uniqueMessages(messages: SlackMessage[]): SlackMessage[] {
  const result = new Map<string, SlackMessage>();
  for (const message of messages) result.set(message.timestamp, message);
  return [...result.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}
