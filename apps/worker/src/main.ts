import { fileURLToPath } from "node:url";

import { Worker } from "@temporalio/worker";
import { ClaudeHarness, CodexHarness, ExecutionPackageBuilder, HarnessRouter } from "@thor/agent";
import {
  createGitHubGateway,
  createWorkerConnection,
  isRetryableGitHubFailure,
  loadRuntimeConfiguration,
  log,
  mapDeferredProjectFields,
  retryInfrastructureOperation,
} from "@thor/runtime";
import { createTicketActivities, GitWorkspaceManager } from "@thor/workflows";

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
  const activities = createTicketActivities({
    github,
    harnesses,
    packageBuilder: new ExecutionPackageBuilder(configuration.paths.resourceRoot),
    workspaces: new GitWorkspaceManager({
      sourceRoot: configuration.paths.sourceRoot,
      worktreeRoot: configuration.paths.worktreeRoot,
    }),
    deferredProjectFields: (finding, ticket) =>
      mapDeferredProjectFields(configuration.binding, finding, ticket),
  });
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
