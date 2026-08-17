import { fileURLToPath } from "node:url";

import { Worker } from "@temporalio/worker";
import { ClaudeHarness, CodexHarness, ExecutionPackageBuilder, HarnessRouter } from "@thor/agent";
import {
  createGitHubGateway,
  createWorkerConnection,
  loadRuntimeConfiguration,
  log,
  mapDeferredProjectFields,
} from "@thor/runtime";
import { createTicketActivities, GitWorkspaceManager } from "@thor/workflows";

const workflowsPath = fileURLToPath(
  new URL("../../../packages/workflows/src/workflows.ts", import.meta.url),
);

async function main(): Promise<void> {
  const configuration = await loadRuntimeConfiguration();
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
      mapDeferredProjectFields(configuration.github.deferredFields, finding, ticket),
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

main().catch((error: unknown) => {
  log("error", "worker_failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
