import { createServer } from "node:http";
import path from "node:path";

import { Client } from "@temporalio/client";
import { loadDeliveryProjectDeclaration } from "@thor/config/node";
import { createClientConnection, loadTemporalConfiguration, log } from "@thor/runtime";
import { SlackWebApiClient, slackUserGroupIdSchema, slackUserIdSchema } from "@thor/slack";
import { z } from "zod";

import { SlackControlHub } from "./control-hub.js";
import { SlackAuthorizationCache, createSlackGatewayHandler } from "./gateway.js";
import { TemporalSlackGateway } from "./temporal.js";

const environmentSchema = z.object({
  SLACK_BOT_TOKEN: z.string().min(1),
  SLACK_SIGNING_SECRET: z.string().min(1),
  SLACK_BOT_USER_ID: slackUserIdSchema,
  THOR_SLACK_CONTROL_TOKEN: z.string().min(32),
  THOR_PROJECT_DECLARATION: z.string().min(1).default("./config/delivery-project.json"),
  THOR_SLACK_GATEWAY_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
});

async function main(): Promise<void> {
  const environment = environmentSchema.parse(process.env);
  const declaration = await loadDeliveryProjectDeclaration(
    path.resolve(process.cwd(), environment.THOR_PROJECT_DECLARATION),
  );
  const slackConfiguration = declaration.collaboration.slack;
  if (!slackConfiguration.enabled) throw new Error("Slack collaboration is disabled");
  const temporalConfiguration = loadTemporalConfiguration();
  const connection = await createClientConnection({ temporal: temporalConfiguration });
  const client = new Client({
    connection,
    namespace: temporalConfiguration.namespace,
  });
  const slack = new SlackWebApiClient(environment.SLACK_BOT_TOKEN);
  const authorization = new SlackAuthorizationCache(
    slack,
    slackConfiguration.steering.allowedUserGroupIds.map((id) => slackUserGroupIdSchema.parse(id)),
  );
  await authorization.refresh();
  const refresh = setInterval(() => {
    void authorization.refresh().catch((error: unknown) =>
      log("warn", "slack_authorization_refresh_failed", {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }, 60_000);
  const server = createServer(
    createSlackGatewayHandler({
      temporal: new TemporalSlackGateway(
        client,
        temporalConfiguration.taskQueue,
        slackConfiguration.eventReconciliationIntervalSeconds,
      ),
      hub: new SlackControlHub(),
      authorization,
      options: {
        signingSecret: environment.SLACK_SIGNING_SECRET,
        serviceToken: environment.THOR_SLACK_CONTROL_TOKEN,
        botUserId: environment.SLACK_BOT_USER_ID,
        workspaceId: slackConfiguration.workspaceId,
        allowedUserGroupIds: slackConfiguration.steering.allowedUserGroupIds,
        defaultMode: slackConfiguration.steering.defaultMode,
      },
    }),
  );
  server.listen(environment.THOR_SLACK_GATEWAY_PORT, () => {
    log("info", "slack_gateway_started", { port: environment.THOR_SLACK_GATEWAY_PORT });
  });
  const shutdown = (): void => {
    clearInterval(refresh);
    server.close(() => void connection.close());
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  log("error", "slack_gateway_failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
