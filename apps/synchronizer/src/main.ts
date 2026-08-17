import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { Client, WorkflowNotFoundError, type WorkflowHandle } from "@temporalio/client";
import {
  policyAllowsAgent,
  redactKnownSecrets,
  workflowIdFor,
  type TicketStatus,
} from "@thor/domain";
import {
  parseProjectWebhook,
  verifyWebhookSignature,
  type GitHubGateway,
  type ProjectItemSnapshot,
} from "@thor/github";
import {
  createClientConnection,
  createGitHubGateway,
  loadRuntimeConfiguration,
  log,
} from "@thor/runtime";
import {
  blueprintDecisionSignal,
  mergeDecisionSignal,
  projectChangedSignal,
  ticketStateQuery,
  ticketWorkflow,
  type TicketWorkflowState,
} from "@thor/workflows";
import { z } from "zod";

const synchronizerEnvironmentSchema = z.object({
  GITHUB_WEBHOOK_SECRET: z.string().min(16),
  THOR_SYNCHRONIZER_HOST: z.string().min(1).default("127.0.0.1"),
  THOR_SYNCHRONIZER_PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  THOR_POLL_INTERVAL_MS: z.coerce.number().int().min(5_000).default(30_000),
});

async function main(): Promise<void> {
  const configuration = await loadRuntimeConfiguration();
  const synchronizer = synchronizerEnvironmentSchema.parse(process.env);
  const github = createGitHubGateway(configuration);
  const connection = await createClientConnection(configuration);
  const client = new Client({
    connection,
    namespace: configuration.temporal.namespace,
  });
  const dispatch = createDispatcher(
    client,
    configuration.temporal.taskQueue,
    configuration.baseBranch,
  );
  // Reconcile the complete Project on startup so downtime cannot create a missed-event gap.
  let pollCursor = "1970-01-01T00:00:00.000Z";
  let polling = false;
  const poll = async (): Promise<void> => {
    if (polling) return;
    polling = true;
    const startedAt = new Date().toISOString();
    try {
      const changes = await github.listProjectItemsUpdatedSince(pollCursor);
      for (const snapshot of changes) await dispatch(snapshot, "github-poller");
      pollCursor = startedAt;
    } catch (error) {
      log("error", "project_poll_failed", { error: errorMessage(error) });
    } finally {
      polling = false;
    }
  };
  const pollTimer = setInterval(() => void poll(), synchronizer.THOR_POLL_INTERVAL_MS);

  const server = createServer((request, response) => {
    void handleRequest(request, response, synchronizer.GITHUB_WEBHOOK_SECRET, github, dispatch);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(
      synchronizer.THOR_SYNCHRONIZER_PORT,
      synchronizer.THOR_SYNCHRONIZER_HOST,
      resolve,
    );
  });
  log("info", "synchronizer_started", {
    host: synchronizer.THOR_SYNCHRONIZER_HOST,
    port: synchronizer.THOR_SYNCHRONIZER_PORT,
    pollIntervalMs: synchronizer.THOR_POLL_INTERVAL_MS,
  });
  void poll();

  await waitForShutdown();
  clearInterval(pollTimer);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  await connection.close();
}

function createDispatcher(
  client: Client,
  taskQueue: string,
  baseBranch: string,
): (snapshot: ProjectItemSnapshot, actor: string) => Promise<void> {
  return async (snapshot, actor) => {
    const workflowId = workflowIdFor(snapshot.projectItemId);
    let handle: WorkflowHandle<typeof ticketWorkflow>;
    const existing = client.workflow.getHandle(workflowId);
    try {
      await existing.describe();
      handle = existing;
    } catch (error) {
      if (!(error instanceof WorkflowNotFoundError)) throw error;
      if (!eligibleToStart(snapshot)) {
        log("debug", "project_change_not_eligible", {
          projectItemId: snapshot.projectItemId,
          status: snapshot.status,
        });
        return;
      }
      handle = await client.workflow.start(ticketWorkflow, {
        workflowId,
        workflowIdConflictPolicy: "USE_EXISTING",
        workflowIdReusePolicy: "REJECT_DUPLICATE",
        taskQueue,
        args: [{ projectItemId: snapshot.projectItemId, baseBranch }],
      });
    }
    try {
      await handle.signal(projectChangedSignal, { snapshot, reason: `GitHub update by ${actor}` });
      const state = await handle.query(ticketStateQuery);
      await signalApprovalTransition(handle, state, snapshot.status, actor);
      log("info", "project_change_dispatched", {
        workflowId,
        projectItemId: snapshot.projectItemId,
        status: snapshot.status,
      });
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) {
        log("info", "completed_workflow_ignored", { workflowId });
        return;
      }
      throw error;
    }
  };
}

async function signalApprovalTransition(
  handle: WorkflowHandle<typeof ticketWorkflow>,
  state: TicketWorkflowState,
  githubStatus: TicketStatus,
  actor: string,
): Promise<void> {
  if (state.run?.status === "awaiting_blueprint_approval") {
    if (githubStatus === "ready") {
      await handle.signal(blueprintDecisionSignal, { decision: "approved", actor });
    } else if (githubStatus === "design_blueprint") {
      await handle.signal(blueprintDecisionSignal, { decision: "changes_requested", actor });
    }
  }
  if (
    state.run?.status === "automated_review_passed" ||
    state.run?.status === "awaiting_human_merge_review"
  ) {
    if (githubStatus === "ready_to_merge") {
      await handle.signal(mergeDecisionSignal, { decision: "approved", actor });
    } else if (githubStatus === "repairing") {
      await handle.signal(mergeDecisionSignal, { decision: "changes_requested", actor });
    }
  }
}

function eligibleToStart(snapshot: ProjectItemSnapshot): boolean {
  return (
    (snapshot.status === "design_blueprint" || snapshot.status === "ready") &&
    policyAllowsAgent(snapshot.ticket.policy) &&
    snapshot.ticket.dependencies.every((dependency) => dependency.complete)
  );
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  webhookSecret: string,
  github: GitHubGateway,
  dispatch: (snapshot: ProjectItemSnapshot, actor: string) => Promise<void>,
): Promise<void> {
  try {
    if (request.method === "GET" && request.url === "/healthz") {
      respond(response, 200, { status: "ok" });
      return;
    }
    if (request.method !== "POST" || request.url !== "/webhooks/github") {
      respond(response, 404, { error: "not_found" });
      return;
    }
    if (request.headers["x-github-event"] !== "projects_v2_item") {
      respond(response, 202, { status: "ignored" });
      return;
    }
    const body = await readBody(request, 1_048_576);
    const signature = singleHeader(request.headers["x-hub-signature-256"]);
    if (!verifyWebhookSignature(webhookSecret, body, signature)) {
      respond(response, 401, { error: "invalid_signature" });
      return;
    }
    const deliveryId = singleHeader(request.headers["x-github-delivery"]);
    if (deliveryId === undefined) {
      respond(response, 400, { error: "missing_delivery_id" });
      return;
    }
    const change = parseProjectWebhook(body, deliveryId);
    const snapshot = await github.getProjectItem(change.projectItemId);
    await dispatch(snapshot, change.actor);
    respond(response, 202, { status: "accepted", deliveryId });
  } catch (error) {
    log("error", "webhook_failed", { error: errorMessage(error) });
    respond(response, 500, { error: "internal_error" });
  }
}

async function readBody(request: IncomingMessage, limit: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    request.on("data", (chunk: unknown) => {
      const bytes =
        typeof chunk === "string"
          ? Buffer.from(chunk)
          : chunk instanceof Uint8Array
            ? chunk
            : undefined;
      if (bytes === undefined) {
        reject(new TypeError("request stream emitted an unsupported chunk"));
        return;
      }
      size += bytes.length;
      if (size > limit) {
        reject(new Error("request body exceeds limit"));
        return;
      }
      chunks.push(bytes);
    });
    request.once("end", () => resolve(Buffer.concat(chunks)));
    request.once("error", reject);
  });
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function respond(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    const shutdown = (): void => resolve();
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

function errorMessage(error: unknown): string {
  return redactKnownSecrets(error instanceof Error ? error.message : String(error));
}

main().catch((error: unknown) => {
  log("error", "synchronizer_failed", { error: errorMessage(error) });
  process.exitCode = 1;
});
