import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  createSlackControlCredential,
  FakeSlackApi,
  slackUserIdSchema,
  type SlackCommandReference,
} from "@thor/slack";
import { afterEach, describe, expect, it } from "vitest";

import { SlackControlHub } from "./control-hub.js";
import {
  SlackAuthorizationCache,
  createSlackGatewayHandler,
  type SlackGatewayTemporal,
} from "./gateway.js";
import { verifySlackSignature } from "./signature.js";

describe("Slack request verification", () => {
  it("accepts a current valid signature and rejects replayed timestamps", () => {
    const rawBody = '{"type":"test"}';
    const timestamp = "1800000000";
    const signature = sign("secret", timestamp, rawBody);

    expect(
      verifySlackSignature({
        signingSecret: "secret",
        timestamp,
        signature,
        rawBody,
        nowMilliseconds: 1_800_000_000_000,
      }),
    ).toBe(true);
    expect(
      verifySlackSignature({
        signingSecret: "secret",
        timestamp,
        signature,
        rawBody,
        nowMilliseconds: 1_800_000_400_000,
      }),
    ).toBe(false);
  });
});

describe("Slack gateway", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server !== undefined) {
      await new Promise<void>((resolve, reject) =>
        server?.close((error) => (error === undefined ? resolve() : reject(error))),
      );
      server = undefined;
    }
  });

  it("durably accepts a signed command before delivering it to a live Activity poll", async () => {
    const slack = new FakeSlackApi();
    slack.seedUserGroup("SENGINEERS", [slackUserIdSchema.parse("UACTOR")]);
    const authorization = new SlackAuthorizationCache(slack, ["SENGINEERS"]);
    await authorization.refresh();
    const temporal = new RecordingTemporal();
    const hub = new SlackControlHub();
    server = createServer(
      createSlackGatewayHandler({
        temporal,
        hub,
        authorization,
        options: {
          signingSecret: "signing-secret",
          serviceToken: "service-token-with-at-least-thirty-two-characters",
          botUserId: "UTHOR",
          workspaceId: "TWORKSPACE",
          allowedUserGroupIds: ["SENGINEERS"],
          defaultMode: "redirect",
        },
      }),
    );
    const baseUrl = await listen(server);
    const poll = fetch(`${baseUrl}/internal/control/poll`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${createSlackControlCredential({
          secret: "service-token-with-at-least-thirty-two-characters",
          workflowId: "workflow-42",
          executionId: "execution-1",
        })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workflowId: "workflow-42",
        executionId: "execution-1",
        surface: {
          mode: "channel_per_ticket",
          workspaceId: "TWORKSPACE",
          channelId: "CTICKET",
          headerTs: "1700000000.000001",
          permalink: "https://fake.slack.com/ticket",
        },
        timeoutMilliseconds: 5_000,
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const event = {
      type: "event_callback",
      team_id: "TWORKSPACE",
      event_id: "Ev001",
      event: {
        type: "app_mention",
        channel: "CTICKET",
        ts: "1700000000.100001",
        user: "UACTOR",
        text: "<@UTHOR> steer: inspect the retry helper",
      },
    };
    const rawBody = JSON.stringify(event);
    const timestamp = Math.floor(Date.now() / 1_000).toString();
    const response = await fetch(`${baseUrl}/slack/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": sign("signing-secret", timestamp, rawBody),
      },
      body: rawBody,
    });

    expect(response.status).toBe(200);
    expect(temporal.accepted).toHaveLength(1);
    expect(await poll.then((value) => value.json())).toEqual({
      command: {
        kind: "redirect",
        commandId: temporal.accepted[0]?.commandId,
        text: "inspect the retry helper",
        responseContext: {
          actorId: "UACTOR",
          workspaceId: "TWORKSPACE",
          threadId: "1700000000.100001",
        },
        sourceReference: {
          commandId: temporal.accepted[0]?.commandId,
          eventId: "Ev001",
          workspaceId: "TWORKSPACE",
          channelId: "CTICKET",
          messageTs: "1700000000.100001",
          actorId: "UACTOR",
          mode: "redirect",
          contentDigest: temporal.accepted[0]?.contentDigest,
        },
      },
    });
  });

  it("returns a retryable HTTP failure when Temporal cannot accept the command", async () => {
    const slack = new FakeSlackApi();
    slack.seedUserGroup("SENGINEERS", [slackUserIdSchema.parse("UACTOR")]);
    const authorization = new SlackAuthorizationCache(slack, ["SENGINEERS"]);
    await authorization.refresh();
    server = createServer(
      createSlackGatewayHandler({
        temporal: {
          acceptCommand: () => Promise.reject(new Error("Temporal unavailable")),
          acknowledgeApplied: () => Promise.resolve(),
        },
        hub: new SlackControlHub(),
        authorization,
        options: {
          signingSecret: "signing-secret",
          serviceToken: "service-token-with-at-least-thirty-two-characters",
          botUserId: "UTHOR",
          workspaceId: "TWORKSPACE",
          allowedUserGroupIds: ["SENGINEERS"],
          defaultMode: "redirect",
        },
      }),
    );
    const baseUrl = await listen(server);
    const rawBody = JSON.stringify({
      type: "event_callback",
      team_id: "TWORKSPACE",
      event_id: "Ev002",
      event: {
        type: "app_mention",
        channel: "CTICKET",
        ts: "1700000000.100002",
        user: "UACTOR",
        text: "<@UTHOR> queue: run integration tests",
      },
    });
    const timestamp = Math.floor(Date.now() / 1_000).toString();

    const response = await fetch(`${baseUrl}/slack/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": sign("signing-secret", timestamp, rawBody),
      },
      body: rawBody,
    });

    expect(response.status).toBe(500);
  });

  it("acknowledges rejected commands without asking Slack to redeliver them", async () => {
    const slack = new FakeSlackApi();
    const authorization = new SlackAuthorizationCache(slack, ["SENGINEERS"]);
    await authorization.refresh();
    const temporal = new RecordingTemporal();
    server = createServer(
      createSlackGatewayHandler({
        temporal,
        hub: new SlackControlHub(),
        authorization,
        options: {
          signingSecret: "signing-secret",
          serviceToken: "service-token-with-at-least-thirty-two-characters",
          botUserId: "UTHOR",
          workspaceId: "TWORKSPACE",
          allowedUserGroupIds: ["SENGINEERS"],
          defaultMode: "redirect",
        },
      }),
    );
    const baseUrl = await listen(server);

    const response = await postSlackEvent(baseUrl, {
      type: "event_callback",
      team_id: "TWORKSPACE",
      event_id: "Ev-rejected",
      event: {
        type: "app_mention",
        channel: "CTICKET",
        ts: "1700000000.100003",
        user: "UUNAUTHORIZED",
        text: "<@UTHOR> queue: run tests",
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ignored: "not_authorized" });
    expect(temporal.accepted).toHaveLength(0);
  });

  it("accepts an authorized Block Kit cancel action", async () => {
    const slack = new FakeSlackApi();
    slack.seedUserGroup("SENGINEERS", [slackUserIdSchema.parse("UACTOR")]);
    const authorization = new SlackAuthorizationCache(slack, ["SENGINEERS"]);
    await authorization.refresh();
    const temporal = new RecordingTemporal();
    server = createServer(
      createSlackGatewayHandler({
        temporal,
        hub: new SlackControlHub(),
        authorization,
        options: {
          signingSecret: "signing-secret",
          serviceToken: "service-token-with-at-least-thirty-two-characters",
          botUserId: "UTHOR",
          workspaceId: "TWORKSPACE",
          allowedUserGroupIds: ["SENGINEERS"],
          defaultMode: "redirect",
        },
      }),
    );
    const baseUrl = await listen(server);
    const payload = JSON.stringify({
      type: "block_actions",
      team: { id: "TWORKSPACE" },
      user: { id: "UACTOR" },
      channel: { id: "CTICKET" },
      message: { ts: "1700000000.000001" },
      actions: [{ action_id: "thor_cancel", action_ts: "1700000000.200001" }],
    });
    const rawBody = new URLSearchParams({ payload }).toString();
    const timestamp = Math.floor(Date.now() / 1_000).toString();

    const response = await fetch(`${baseUrl}/slack/interactions`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": sign("signing-secret", timestamp, rawBody),
      },
      body: rawBody,
    });

    expect(response.status).toBe(200);
    expect(temporal.accepted[0]).toMatchObject({
      mode: "cancel",
      actorId: "UACTOR",
      eventId: "interaction:TWORKSPACE:1700000000.200001",
      threadTs: "1700000000.000001",
    });
  });
});

class RecordingTemporal implements SlackGatewayTemporal {
  public readonly accepted: SlackCommandReference[] = [];

  public acceptCommand(reference: SlackCommandReference): Promise<void> {
    this.accepted.push(reference);
    return Promise.resolve();
  }

  public acknowledgeApplied(): Promise<void> {
    return Promise.resolve();
  }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port.toString()}`;
}

function sign(secret: string, timestamp: string, rawBody: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
}

function postSlackEvent(baseUrl: string, event: unknown): Promise<Response> {
  const rawBody = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1_000).toString();
  return fetch(`${baseUrl}/slack/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": sign("signing-secret", timestamp, rawBody),
    },
    body: rawBody,
  });
}
