import { fileURLToPath } from "node:url";

import { Client } from "@temporalio/client";
import { Worker } from "@temporalio/worker";
import { ClaudeHarness, CodexHarness, ExecutionPackageBuilder, HarnessRouter } from "@thor/agent";
import {
  createGitHubGateway,
  createClientConnection,
  createWorkerConnection,
  isRetryableGitHubFailure,
  loadRuntimeConfiguration,
  log,
  mapDeferredProjectFields,
  retryInfrastructureOperation,
} from "@thor/runtime";
import { SlackSurfaceManager, SlackWebApiClient, slackUserIdSchema } from "@thor/slack";
import {
  createSlackRouterActivities,
  createTicketActivities,
  FileExecutionCheckpointStore,
  GitWorkspaceManager,
} from "@thor/workflows";

import { TemporalSlackWorkflowRegistrationGateway } from "./slack-workflows.js";

const workflowsPath = fileURLToPath(
  new URL("../../../packages/workflows/src/workflows.ts", import.meta.url),
);

async function main(): Promise<void> {
  const shutdown = shutdownSignal();
  const configuration = await retryInfrastructureOperation(() => loadRuntimeConfiguration(), {
    signal: shutdown.signal,
    shouldRetry: isRetryableGitHubFailure,
    onFailedAttempt: ({ error, attemptNumber, retryDelay }) => {
      log("warn", "worker_configuration_load_failed", {
        attempt: attemptNumber,
        retryDelayMs: retryDelay,
        error: error.message,
      });
    },
  });
  const github = createGitHubGateway(configuration);
  const harnesses = new HarnessRouter();
  harnesses.register(new ClaudeHarness());
  harnesses.register(new CodexHarness());
  const clientConnection =
    configuration.slack === undefined ? undefined : await createClientConnection(configuration);
  const temporalClient =
    clientConnection === undefined
      ? undefined
      : new Client({ connection: clientConnection, namespace: configuration.temporal.namespace });
  const slackApi =
    configuration.slack === undefined
      ? undefined
      : new SlackWebApiClient(configuration.slack.botToken);
  const ticketActivities = createTicketActivities({
    github,
    harnesses,
    packageBuilder: new ExecutionPackageBuilder(configuration.paths.resourceRoot),
    workspaces: new GitWorkspaceManager({
      sourceRoot: configuration.paths.sourceRoot,
      worktreeRoot: configuration.paths.worktreeRoot,
    }),
    checkpoints: new FileExecutionCheckpointStore(configuration.paths.executionRoot),
    ...(configuration.slack === undefined || slackApi === undefined || temporalClient === undefined
      ? {}
      : {
          slack: {
            api: slackApi,
            botUserId: configuration.slack.botUserId,
            surfaces: new SlackSurfaceManager(slackApi, {
              botUserId: slackUserIdSchema.parse(configuration.slack.botUserId),
            }),
            workflows: new TemporalSlackWorkflowRegistrationGateway(
              temporalClient,
              configuration.temporal.taskQueue,
            ),
            ...(configuration.slack.gatewayUrl === undefined ||
            configuration.slack.controlToken === undefined
              ? {}
              : {
                  control: {
                    gatewayUrl: configuration.slack.gatewayUrl,
                    serviceToken: configuration.slack.controlToken,
                  },
                }),
          },
        }),
    deferredProjectFields: (finding, ticket) =>
      mapDeferredProjectFields(configuration.binding, finding, ticket),
  });
  const activities = {
    ...ticketActivities,
    ...(configuration.slack === undefined || slackApi === undefined
      ? {}
      : createSlackRouterActivities({
          slack: slackApi,
          botUserId: slackUserIdSchema.parse(configuration.slack.botUserId),
        })),
  };
  const connection = await createWorkerConnection(configuration);
  try {
    const worker = await Worker.create({
      connection,
      namespace: configuration.temporal.namespace,
      taskQueue: configuration.temporal.taskQueue,
      workflowsPath,
      activities,
      maxHeartbeatThrottleInterval: "10 seconds",
    });
    log("info", "worker_started", {
      namespace: configuration.temporal.namespace,
      taskQueue: configuration.temporal.taskQueue,
    });
    await worker.run();
  } finally {
    await connection.close();
    await clientConnection?.close();
  }
}

function shutdownSignal(): AbortController {
  const controller = new AbortController();
  const shutdown = (): void => controller.abort(new Error("worker shutdown requested"));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return controller;
}

main().catch((error: unknown) => {
  log("error", "worker_failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
