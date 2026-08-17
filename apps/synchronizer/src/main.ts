import { fileURLToPath } from "node:url";

import { Client } from "@temporalio/client";
import { Worker } from "@temporalio/worker";
import { redactKnownSecrets } from "@thor/domain";
import {
  createClientConnection,
  createGitHubGateway,
  createWorkerConnection,
  isRetryableGitHubFailure,
  loadRuntimeConfiguration,
  log,
  retryInfrastructureOperation,
} from "@thor/runtime";
import { projectSynchronizerWorkflow } from "@thor/workflows";
import { z } from "zod";

import { createProjectSynchronizerActivities } from "./activities.js";

const workflowsPath = fileURLToPath(
  new URL("../../../packages/workflows/src/workflows.ts", import.meta.url),
);

const synchronizerEnvironmentSchema = z.object({
  THOR_POLL_INTERVAL_MS: z.coerce.number().int().min(5_000).default(30_000),
});

async function main(): Promise<void> {
  const shutdown = shutdownSignal();
  const synchronizer = synchronizerEnvironmentSchema.parse(process.env);
  const configuration = await retryInfrastructureOperation(() => loadRuntimeConfiguration(), {
    signal: shutdown.signal,
    shouldRetry: isRetryableGitHubFailure,
    onFailedAttempt: ({ error, attemptNumber, retryDelay }) => {
      log("warn", "synchronizer_configuration_load_failed", {
        attempt: attemptNumber,
        retryDelayMs: retryDelay,
        error: errorMessage(error),
      });
    },
  });
  const synchronizerTaskQueue = `${configuration.temporal.taskQueue}-project-synchronizer`;
  const github = createGitHubGateway(configuration);
  const clientConnection = await createClientConnection(configuration);
  let workerConnection: Awaited<ReturnType<typeof createWorkerConnection>>;
  try {
    workerConnection = await createWorkerConnection(configuration);
  } catch (error) {
    await clientConnection.close();
    throw error;
  }
  const client = new Client({
    connection: clientConnection,
    namespace: configuration.temporal.namespace,
  });
  const worker = await Worker.create({
    connection: workerConnection,
    namespace: configuration.temporal.namespace,
    taskQueue: synchronizerTaskQueue,
    workflowsPath,
    activities: createProjectSynchronizerActivities({
      client,
      ticketTaskQueue: configuration.temporal.taskQueue,
      binding: configuration.binding,
      github,
    }),
  });
  const workerRun = worker.run();
  try {
    const workflowId = `github-project:${configuration.binding.project.id}:synchronizer`;
    await client.workflow.start(projectSynchronizerWorkflow, {
      workflowId,
      workflowIdConflictPolicy: "USE_EXISTING",
      workflowIdReusePolicy: "ALLOW_DUPLICATE",
      taskQueue: synchronizerTaskQueue,
      memo: { thorProjectId: configuration.binding.project.id },
      args: [
        {
          projectId: configuration.binding.project.id,
          pollIntervalMs: synchronizer.THOR_POLL_INTERVAL_MS,
          unreadableAfterConsecutivePolls:
            configuration.binding.delivery.workflow.interventions.unreadableItems
              .afterConsecutivePolls,
        },
      ],
    });
    log("info", "synchronizer_started", {
      mode: "temporal-polling-workflow",
      workflowId,
      taskQueue: synchronizerTaskQueue,
      pollIntervalMs: synchronizer.THOR_POLL_INTERVAL_MS,
    });
    await workerRun;
  } finally {
    worker.shutdown();
    await workerRun.catch(() => undefined);
    await Promise.all([clientConnection.close(), workerConnection.close()]);
  }
}

function shutdownSignal(): AbortController {
  const controller = new AbortController();
  const shutdown = (): void => controller.abort(new Error("synchronizer shutdown requested"));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return controller;
}

function errorMessage(error: unknown): string {
  return redactKnownSecrets(error instanceof Error ? error.message : String(error));
}

main().catch((error: unknown) => {
  log("error", "synchronizer_failed", { error: errorMessage(error) });
  process.exitCode = 1;
});
