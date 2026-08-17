#!/usr/bin/env node

import { Client } from "@temporalio/client";
import { projectItemIdSchema, redactKnownSecrets, workflowIdFor } from "@thor/domain";
import { createClientConnection, loadTemporalConfiguration } from "@thor/runtime";
import {
  blueprintDecisionSignal,
  cancelTicketSignal,
  mergeDecisionSignal,
  ticketStateQuery,
  ticketWorkflow,
} from "@thor/workflows";

async function main(): Promise<void> {
  const [
    command,
    rawProjectItemId,
    rawActor = process.env.USER ?? "thor-operator",
    ...reasonParts
  ] = process.argv.slice(2);
  if (command === undefined || rawProjectItemId === undefined) {
    throw new UsageError(usage());
  }
  const projectItemId = projectItemIdSchema.parse(rawProjectItemId);
  const actor = redactKnownSecrets(rawActor);
  const rawReason = reasonParts.join(" ").trim();
  const reason = rawReason.length === 0 ? undefined : redactKnownSecrets(rawReason);
  const temporal = loadTemporalConfiguration();
  const connection = await createClientConnection({ temporal });
  try {
    const client = new Client({ connection, namespace: temporal.namespace });
    const workflowId = workflowIdFor(projectItemId);
    const handle = client.workflow.getHandle<typeof ticketWorkflow>(workflowId);
    switch (command) {
      case "start": {
        const started = await client.workflow.start(ticketWorkflow, {
          workflowId,
          workflowIdConflictPolicy: "USE_EXISTING",
          workflowIdReusePolicy: "REJECT_DUPLICATE",
          taskQueue: temporal.taskQueue,
          args: [{ projectItemId, baseBranch: process.env.THOR_BASE_BRANCH ?? "main" }],
        });
        writeJson({
          workflowId: started.workflowId,
          firstExecutionRunId: started.firstExecutionRunId,
        });
        break;
      }
      case "status":
        writeJson(await handle.query(ticketStateQuery));
        break;
      case "approve-blueprint":
        await handle.signal(blueprintDecisionSignal, {
          decision: "approved",
          actor,
          ...(reason === undefined ? {} : { reason }),
        });
        writeJson({ workflowId, signal: "blueprintDecision", decision: "approved" });
        break;
      case "request-blueprint-changes":
        await handle.signal(blueprintDecisionSignal, {
          decision: "changes_requested",
          actor,
          ...(reason === undefined ? {} : { reason }),
        });
        writeJson({ workflowId, signal: "blueprintDecision", decision: "changes_requested" });
        break;
      case "approve-merge":
        await handle.signal(mergeDecisionSignal, {
          decision: "approved",
          actor,
          ...(reason === undefined ? {} : { reason }),
        });
        writeJson({ workflowId, signal: "mergeDecision", decision: "approved" });
        break;
      case "request-merge-changes":
        await handle.signal(mergeDecisionSignal, {
          decision: "changes_requested",
          actor,
          ...(reason === undefined ? {} : { reason }),
        });
        writeJson({ workflowId, signal: "mergeDecision", decision: "changes_requested" });
        break;
      case "cancel":
        await handle.signal(cancelTicketSignal, {
          actor,
          ...(reason === undefined ? {} : { reason }),
        });
        writeJson({ workflowId, signal: "cancelTicket", cancellationRequested: true });
        break;
      default:
        throw new UsageError(`unknown command ${command}\n\n${usage()}`);
    }
  } finally {
    await connection.close();
  }
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage(): string {
  return [
    "Usage: thor <command> <project-item-id> [actor] [reason...]",
    "",
    "Commands:",
    "  start",
    "  status",
    "  approve-blueprint",
    "  request-blueprint-changes",
    "  approve-merge",
    "  request-merge-changes",
    "  cancel",
  ].join("\n");
}

class UsageError extends Error {}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
});
