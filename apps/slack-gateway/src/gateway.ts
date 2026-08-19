import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  parseSlackCommand,
  slackChannelIdSchema,
  slackCommandDigest,
  slackCommandReferenceSchema,
  slackCommandContainsSecret,
  slackTaskSurfaceSchema,
  slackTimestampSchema,
  slackUserIdSchema,
  slackWorkspaceIdSchema,
  verifySlackControlCredential,
  type SlackApi,
  type SlackCommandReference,
  type SlackUserGroupId,
} from "@thor/slack";
import { z } from "zod";

import { SlackControlHub } from "./control-hub.js";
import { verifySlackSignature } from "./signature.js";

export type SlackGatewayTemporal = {
  acceptCommand(reference: SlackCommandReference): Promise<void>;
  acknowledgeApplied(input: {
    workflowId: string;
    executionId: string;
    commandId: string;
  }): Promise<void>;
};

export type SlackGatewayOptions = {
  signingSecret: string;
  serviceToken: string;
  botUserId: string;
  workspaceId: string;
  allowedUserGroupIds: string[];
  defaultMode: "queue" | "redirect";
};

const eventEnvelopeSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("url_verification"), challenge: z.string() }),
  z
    .object({
      type: z.literal("event_callback"),
      team_id: slackWorkspaceIdSchema,
      event_id: z.string().min(1),
      event: z
        .object({
          type: z.literal("app_mention"),
          channel: slackChannelIdSchema,
          ts: slackTimestampSchema,
          thread_ts: slackTimestampSchema.optional(),
          user: slackUserIdSchema,
          text: z.string(),
          bot_id: z.string().optional(),
        })
        .loose(),
    })
    .loose(),
]);

const pollSchema = z.strictObject({
  workflowId: z.string().min(1),
  executionId: z.string().min(1),
  surface: slackTaskSurfaceSchema,
  timeoutMilliseconds: z.number().int().min(100).max(30_000),
});
const appliedSchema = z.strictObject({
  workflowId: z.string().min(1),
  executionId: z.string().min(1),
  commandId: z.string().min(1),
});
const interactionSchema = z
  .object({
    type: z.literal("block_actions"),
    team: z.object({ id: slackWorkspaceIdSchema }),
    user: z.object({ id: slackUserIdSchema }),
    channel: z.object({ id: slackChannelIdSchema }),
    message: z.object({
      ts: slackTimestampSchema,
      thread_ts: slackTimestampSchema.optional(),
    }),
    actions: z
      .array(
        z.object({
          action_id: z.literal("thor_cancel"),
          action_ts: slackTimestampSchema,
        }),
      )
      .min(1),
  })
  .loose();

export class SlackAuthorizationCache {
  private members = new Set<string>();

  public constructor(
    private readonly slack: SlackApi,
    private readonly groupIds: SlackUserGroupId[],
  ) {}

  public async refresh(): Promise<void> {
    const next = new Set<string>();
    for (const groupId of this.groupIds) {
      for (const userId of await this.slack.getUserGroupMembers(groupId)) next.add(userId);
    }
    this.members = next;
  }

  public allows(userId: string): boolean {
    return this.members.has(userId);
  }
}

export function createSlackGatewayHandler(dependencies: {
  temporal: SlackGatewayTemporal;
  hub: SlackControlHub;
  authorization: SlackAuthorizationCache;
  options: SlackGatewayOptions;
}): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    void handle(request, response, dependencies).catch(() => {
      if (!response.headersSent) json(response, 500, { error: "internal_error" });
      else response.end();
    });
  };
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: {
    temporal: SlackGatewayTemporal;
    hub: SlackControlHub;
    authorization: SlackAuthorizationCache;
    options: SlackGatewayOptions;
  },
): Promise<void> {
  if (request.method !== "POST") {
    json(response, 404, { error: "not_found" });
    return;
  }
  const rawBody = await readBody(request);
  if (request.url === "/slack/events" || request.url === "/slack/interactions") {
    if (
      !verifySlackSignature({
        signingSecret: dependencies.options.signingSecret,
        timestamp: header(request, "x-slack-request-timestamp"),
        signature: header(request, "x-slack-signature"),
        rawBody,
      })
    ) {
      json(response, 401, { error: "invalid_signature" });
      return;
    }
  }
  if (request.url === "/slack/interactions") {
    const rawPayload = new URLSearchParams(rawBody).get("payload");
    if (rawPayload === null) {
      json(response, 400, { error: "missing_payload" });
      return;
    }
    const interaction = interactionSchema.parse(JSON.parse(rawPayload));
    if (
      interaction.team.id !== dependencies.options.workspaceId ||
      !dependencies.authorization.allows(interaction.user.id)
    ) {
      json(response, 200, { ok: true, ignored: "not_authorized" });
      return;
    }
    const action = interaction.actions[0];
    if (action === undefined) {
      json(response, 400, { error: "missing_action" });
      return;
    }
    const eventId = `interaction:${interaction.team.id}:${action.action_ts}`;
    const text = "cancel requested through Block Kit";
    const reference = slackCommandReferenceSchema.parse({
      commandId: commandId(eventId, interaction.message.ts),
      eventId,
      workspaceId: interaction.team.id,
      channelId: interaction.channel.id,
      threadTs: interaction.message.thread_ts ?? interaction.message.ts,
      messageTs: interaction.message.ts,
      actorId: interaction.user.id,
      mode: "cancel",
      contentDigest: slackCommandDigest(text),
    });
    await dependencies.temporal.acceptCommand(reference);
    json(response, 200, { ok: true });
    return;
  }
  if (request.url === "/slack/events") {
    const envelope = eventEnvelopeSchema.parse(JSON.parse(rawBody));
    if (envelope.type === "url_verification") {
      json(response, 200, { challenge: envelope.challenge });
      return;
    }
    if (
      envelope.team_id !== dependencies.options.workspaceId ||
      envelope.event.bot_id !== undefined ||
      envelope.event.user === dependencies.options.botUserId
    ) {
      json(response, 200, { ok: true });
      return;
    }
    const parsed = parseSlackCommand(
      envelope.event.text,
      dependencies.options.botUserId,
      dependencies.options.defaultMode,
    );
    if (parsed === undefined) {
      json(response, 200, { ok: true });
      return;
    }
    if (slackCommandContainsSecret(parsed.text)) {
      json(response, 200, { ok: true, ignored: "sensitive_command_rejected" });
      return;
    }
    if (!dependencies.authorization.allows(envelope.event.user)) {
      json(response, 200, { ok: true, ignored: "not_authorized" });
      return;
    }
    const reference = slackCommandReferenceSchema.parse({
      commandId: commandId(envelope.event_id, envelope.event.ts),
      eventId: envelope.event_id,
      workspaceId: envelope.team_id,
      channelId: envelope.event.channel,
      ...(envelope.event.thread_ts === undefined ? {} : { threadTs: envelope.event.thread_ts }),
      messageTs: envelope.event.ts,
      actorId: envelope.event.user,
      mode: parsed.mode,
      contentDigest: slackCommandDigest(parsed.text),
    });
    await dependencies.temporal.acceptCommand(reference);
    if (reference.mode !== "cancel") {
      dependencies.hub.publish({ ...reference, text: parsed.text });
    }
    json(response, 200, { ok: true });
    return;
  }

  if (request.url === "/internal/control/poll") {
    const poll = pollSchema.parse(JSON.parse(rawBody));
    if (!validControlCredential(request, dependencies.options.serviceToken, poll)) {
      json(response, 401, { error: "unauthorized" });
      return;
    }
    const command = await dependencies.hub.poll(poll);
    json(response, 200, { command });
    return;
  }
  if (request.url === "/internal/control/applied") {
    const applied = appliedSchema.parse(JSON.parse(rawBody));
    if (!validControlCredential(request, dependencies.options.serviceToken, applied)) {
      json(response, 401, { error: "unauthorized" });
      return;
    }
    await dependencies.temporal.acknowledgeApplied(applied);
    json(response, 200, { ok: true });
    return;
  }
  json(response, 404, { error: "not_found" });
}

function commandId(eventId: string, timestamp: string): string {
  return `slack:${createHash("sha256").update(`${eventId}:${timestamp}`).digest("hex").slice(0, 20)}`;
}

function validControlCredential(
  request: IncomingMessage,
  secret: string,
  identity: { workflowId: string; executionId: string },
): boolean {
  const authorization = header(request, "authorization");
  return verifySlackControlCredential({
    credential: authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined,
    secret,
    workflowId: identity.workflowId,
    executionId: identity.executionId,
  });
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as Uint8Array);
    size += chunk.length;
    if (size > 1_000_000) throw new Error("request body is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}
