import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import {
  SlackAuthorizationCache,
  SlackControlHub,
  TemporalSlackGateway,
  createSlackGatewayHandler,
} from "@thor/slack-gateway";
import {
  FakeSlackApi,
  slackChannelIdSchema,
  slackTaskSurfaceSchema,
  slackTimestampSchema,
  slackUserIdSchema,
  type SlackTaskSurface,
} from "@thor/slack";
import {
  createSlackRouterActivities,
  acceptedSlackCommandSchema,
  type SlackRouterInput,
} from "@thor/workflows";
import { afterEach, describe, expect, test } from "vitest";

const workflowsPath = fileURLToPath(
  new URL("../../packages/workflows/src/slack-router.test-workflows.ts", import.meta.url),
);

describe("Slack control integration", () => {
  let environment: TestWorkflowEnvironment | undefined;
  let server: Server | undefined;

  afterEach(async () => {
    if (server !== undefined) {
      await new Promise<void>((resolve, reject) =>
        server?.close((error) => (error === undefined ? resolve() : reject(error))),
      );
      server = undefined;
    }
    await environment?.teardown();
    environment = undefined;
  });

  test.each(["thread_per_ticket", "channel_per_ticket"] as const)(
    "carries a signed command through Temporal and Slack in %s mode",
    async (mode) => {
      const slack = new FakeSlackApi();
      const actorId = slackUserIdSchema.parse("UACTOR");
      const botUserId = slackUserIdSchema.parse("UTHOR");
      const channelId = slackChannelIdSchema.parse(
        mode === "thread_per_ticket" ? "CPROJECT" : "CTICKET",
      );
      slack.seedConversation({
        id: channelId,
        name: mode === "thread_per_ticket" ? "project" : "ticket",
        isPrivate: true,
        isArchived: false,
        topic: "",
      });
      slack.seedUserGroup("SENGINEERS", [actorId]);
      const header = slack.seedMessage({ channelId, text: "Thor ticket", botId: "BTHOR" });
      const discussionRoot =
        mode === "channel_per_ticket"
          ? slack.seedMessage({ channelId, text: "Discussion", userId: actorId })
          : header;
      const command = slack.seedMessage({
        channelId,
        threadTimestamp: discussionRoot.timestamp,
        text: "<@UTHOR> queue: run the integration suite",
        userId: actorId,
      });
      const surface = surfaceFor(mode, channelId, header.timestamp);
      const workflowId = `ticket-slack-integration-${mode}`;
      const taskQueue = `slack-control-integration-${mode}`;
      const registration = {
        workflowId,
        projectItemId: `PVTI_${mode}`,
        surface,
        allowedUserGroupIds: ["SENGINEERS"],
        defaultMode: "redirect" as const,
        terminal: false,
      };

      environment = await TestWorkflowEnvironment.createTimeSkipping();
      const worker = await Worker.create({
        connection: environment.nativeConnection,
        taskQueue,
        workflowsPath,
        activities: createSlackRouterActivities({ slack, botUserId }),
      });
      const authorization = new SlackAuthorizationCache(slack, ["SENGINEERS"]);
      await authorization.refresh();
      const hub = new SlackControlHub();
      server = createServer(
        createSlackGatewayHandler({
          temporal: new TemporalSlackGateway(environment.client, taskQueue, 30),
          hub,
          authorization,
          options: {
            signingSecret: "integration-signing-secret",
            serviceToken: "integration-control-token-at-least-thirty-two-characters",
            botUserId,
            workspaceId: "TWORKSPACE",
            allowedUserGroupIds: ["SENGINEERS"],
            defaultMode: "redirect",
          },
        }),
      );
      const baseUrl = await listen(server);

      const accepted = await worker.runUntil(async () => {
        const collector = await environment?.client.workflow.start(
          "slackCommandCollectorWorkflow",
          { workflowId, taskQueue },
        );
        if (collector === undefined) throw new Error("Temporal environment is unavailable");
        const routerInput: SlackRouterInput = {
          workspaceId: "TWORKSPACE",
          reconciliationIntervalSeconds: 30,
          registrations: [registration],
        };
        await environment?.client.workflow.start("slackWorkspaceRouterWorkflow", {
          workflowId: "slack-workspace:TWORKSPACE",
          taskQueue,
          args: [routerInput],
        });

        const directControl = hub.poll({
          workflowId,
          executionId: "execution-1",
          surface,
          timeoutMilliseconds: 5_000,
        });
        const response = await signedEvent(baseUrl, {
          type: "event_callback",
          team_id: "TWORKSPACE",
          event_id: `Ev-${mode}`,
          event: {
            type: "app_mention",
            channel: channelId,
            ts: command.timestamp,
            thread_ts: discussionRoot.timestamp,
            user: actorId,
            text: command.text,
          },
        });
        expect(response.status).toBe(200);
        await expect(directControl).resolves.toMatchObject({
          kind: "queue",
          text: "run the integration suite",
        });
        return acceptedSlackCommandSchema.parse(await collector.result());
      });

      expect(accepted.reference).toMatchObject({
        workspaceId: "TWORKSPACE",
        channelId,
        messageTs: command.timestamp,
        actorId,
        mode: "queue",
      });
      const messages =
        mode === "thread_per_ticket"
          ? await slack.replies({ channelId, threadTs: header.timestamp })
          : await slack.history({ channelId });
      expect(
        messages.values.some(
          (message) =>
            message.metadata?.eventType === "thor_command_receipt" &&
            message.metadata.eventPayload.commandId === accepted.reference.commandId,
        ),
      ).toBe(true);
    },
    30_000,
  );
});

function surfaceFor(
  mode: "thread_per_ticket" | "channel_per_ticket",
  channelId: ReturnType<typeof slackChannelIdSchema.parse>,
  headerTs: ReturnType<typeof slackTimestampSchema.parse>,
): SlackTaskSurface {
  return slackTaskSurfaceSchema.parse(
    mode === "thread_per_ticket"
      ? {
          mode,
          workspaceId: "TWORKSPACE",
          channelId,
          threadTs: headerTs,
          headerTs,
          permalink: "https://fake.slack.com/thread",
        }
      : {
          mode,
          workspaceId: "TWORKSPACE",
          channelId,
          headerTs,
          permalink: "https://fake.slack.com/channel",
        },
  );
}

async function listen(value: Server): Promise<string> {
  await new Promise<void>((resolve) => value.listen(0, "127.0.0.1", resolve));
  const address = value.address() as AddressInfo;
  return `http://127.0.0.1:${address.port.toString()}`;
}

function signedEvent(baseUrl: string, event: unknown): Promise<Response> {
  const rawBody = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1_000).toString();
  const signature = createHmac("sha256", "integration-signing-secret")
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex");
  return fetch(`${baseUrl}/slack/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": `v0=${signature}`,
    },
    body: rawBody,
  });
}
