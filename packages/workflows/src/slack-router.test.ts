import { fileURLToPath } from "node:url";

import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import {
  slackCommandDigest,
  slackCommandReferenceSchema,
  slackTaskSurfaceSchema,
} from "@thor/slack";
import { afterEach, describe, expect, it } from "vitest";

import { acceptedSlackCommandSchema, type SlackRouterActivities } from "./slack-contracts.js";
import {
  closeSlackSurfaceUpdate,
  registerSlackSurfaceUpdate,
  slackCommandEventSignal,
  slackRouterStateQuery,
  slackWorkspaceRouterWorkflow,
} from "./slack-router.js";

const workflowsPath = fileURLToPath(new URL("./slack-router.test-workflows.ts", import.meta.url));

describe("slackWorkspaceRouterWorkflow", () => {
  let environment: TestWorkflowEnvironment | undefined;

  afterEach(async () => {
    await environment?.teardown();
    environment = undefined;
  });

  it("routes a registered thread once and deduplicates event and message identities", async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
    let materializations = 0;
    const activities: SlackRouterActivities = {
      materializeSlackCommand: (input) => {
        materializations += 1;
        return Promise.resolve(
          acceptedSlackCommandSchema.parse({
            reference: input.reference,
            receiptTs: "1700000000.900001",
          }),
        );
      },
      replyClosedSlackSession: () => Promise.resolve(),
      archiveSlackTicketChannel: () => Promise.resolve(),
      unarchiveSlackTicketChannel: () => Promise.resolve(),
      reconcileSlackCommands: () => Promise.resolve({ references: [], highWatermarks: {} }),
    };
    const taskQueue = "slack-router-thread-test";
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath,
      activities,
    });
    const workerRun = worker.run();
    const collector = await environment.client.workflow.start("slackCommandCollectorWorkflow", {
      workflowId: "ticket-workflow-42",
      taskQueue,
      args: [],
    });
    const router = await environment.client.workflow.start(slackWorkspaceRouterWorkflow, {
      workflowId: "slack-workspace:TWORKSPACE",
      taskQueue,
      args: [{ workspaceId: "TWORKSPACE", reconciliationIntervalSeconds: 30 }],
    });
    await router.executeUpdate(registerSlackSurfaceUpdate, {
      args: [
        {
          workflowId: "ticket-workflow-42",
          projectItemId: "PVTI_42",
          surface: slackTaskSurfaceSchema.parse({
            mode: "thread_per_ticket",
            workspaceId: "TWORKSPACE",
            channelId: "CPROJECT",
            threadTs: "1700000000.000001",
            headerTs: "1700000000.000001",
            permalink: "https://fake.slack.com/root",
          }),
          allowedUserGroupIds: ["SENGINEERS"],
          defaultMode: "redirect",
          terminal: false,
        },
      ],
    });
    const first = slackCommandReferenceSchema.parse({
      commandId: "command-1",
      eventId: "Ev001",
      workspaceId: "TWORKSPACE",
      channelId: "CPROJECT",
      threadTs: "1700000000.000001",
      messageTs: "1700000000.100001",
      actorId: "UACTOR",
      mode: "redirect",
      contentDigest: slackCommandDigest("inspect helper"),
    });
    const duplicateMessage = slackCommandReferenceSchema.parse({
      ...first,
      commandId: "command-duplicate",
      eventId: "Ev002",
    });

    try {
      await router.signal(slackCommandEventSignal, first);
      await router.signal(slackCommandEventSignal, first);
      await router.signal(slackCommandEventSignal, duplicateMessage);
      expect(await collector.result()).toMatchObject({ reference: first });
      await waitForProcessed(router);
      expect(materializations).toBe(1);
      const state = await router.query(slackRouterStateQuery);
      expect(state.processedEvents).toBe(1);
      expect(state.seenEventIds).toContain("reconcile:CPROJECT:1700000000.100001");

      const channelCollector = await environment.client.workflow.start(
        "slackCommandCollectorWorkflow",
        {
          workflowId: "ticket-workflow-channel",
          taskQueue,
          args: [],
        },
      );
      await router.executeUpdate(registerSlackSurfaceUpdate, {
        args: [
          {
            workflowId: "ticket-workflow-channel",
            projectItemId: "PVTI_CHANNEL",
            surface: slackTaskSurfaceSchema.parse({
              mode: "channel_per_ticket",
              workspaceId: "TWORKSPACE",
              channelId: "CTICKET",
              headerTs: "1700000000.000002",
              permalink: "https://fake.slack.com/ticket",
            }),
            allowedUserGroupIds: ["SENGINEERS"],
            defaultMode: "redirect",
            terminal: false,
          },
        ],
      });
      const nestedChannelCommand = slackCommandReferenceSchema.parse({
        commandId: "command-channel",
        eventId: "Ev003",
        workspaceId: "TWORKSPACE",
        channelId: "CTICKET",
        threadTs: "1700000000.200001",
        messageTs: "1700000000.200002",
        actorId: "UACTOR",
        mode: "queue",
        contentDigest: slackCommandDigest("run tests"),
      });
      await router.signal(slackCommandEventSignal, nestedChannelCommand);
      expect(await channelCollector.result()).toMatchObject({ reference: nestedChannelCommand });
      expect(materializations).toBe(2);
    } finally {
      await router.terminate("test complete");
      worker.shutdown();
      await workerRun;
    }
  }, 30_000);

  it("rejects a conflicting owner for an already registered surface", async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
    const taskQueue = "slack-router-conflict-test";
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath,
      activities: {
        materializeSlackCommand: () => Promise.reject(new Error("not expected")),
        replyClosedSlackSession: () => Promise.resolve(),
        archiveSlackTicketChannel: () => Promise.resolve(),
        unarchiveSlackTicketChannel: () => Promise.resolve(),
        reconcileSlackCommands: () => Promise.resolve({ references: [], highWatermarks: {} }),
      } satisfies SlackRouterActivities,
    });
    const workerRun = worker.run();
    const router = await environment.client.workflow.start(slackWorkspaceRouterWorkflow, {
      workflowId: "slack-workspace:TCONFLICT",
      taskQueue,
      args: [{ workspaceId: "TCONFLICT", reconciliationIntervalSeconds: 30 }],
    });
    const surface = slackTaskSurfaceSchema.parse({
      mode: "channel_per_ticket",
      workspaceId: "TCONFLICT",
      channelId: "CTICKET",
      headerTs: "1700000000.000001",
      permalink: "https://fake.slack.com/ticket",
    });
    try {
      await router.executeUpdate(registerSlackSurfaceUpdate, {
        args: [
          {
            workflowId: "ticket-one",
            projectItemId: "PVTI_1",
            surface,
            allowedUserGroupIds: ["SENGINEERS"],
            defaultMode: "redirect",
            terminal: false,
          },
        ],
      });
      await expect(
        router.executeUpdate(registerSlackSurfaceUpdate, {
          args: [
            {
              workflowId: "ticket-two",
              projectItemId: "PVTI_2",
              surface,
              allowedUserGroupIds: ["SENGINEERS"],
              defaultMode: "redirect",
              terminal: false,
            },
          ],
        }),
      ).rejects.toThrow("Workflow Update failed");
      expect((await router.query(slackRouterStateQuery)).registrations).toMatchObject([
        { workflowId: "ticket-one", projectItemId: "PVTI_1" },
      ]);
    } finally {
      await router.terminate("test complete");
      worker.shutdown();
      await workerRun;
    }
  }, 30_000);

  it("keeps a timestamped tombstone and replies to a late command", async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
    let closedReplies = 0;
    let archives = 0;
    const taskQueue = "slack-router-closed-test";
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath,
      activities: {
        materializeSlackCommand: () => Promise.reject(new Error("not expected")),
        replyClosedSlackSession: () => {
          closedReplies += 1;
          return Promise.resolve();
        },
        archiveSlackTicketChannel: () => {
          archives += 1;
          return Promise.resolve();
        },
        unarchiveSlackTicketChannel: () => Promise.resolve(),
        reconcileSlackCommands: () => Promise.resolve({ references: [], highWatermarks: {} }),
      } satisfies SlackRouterActivities,
    });
    const workerRun = worker.run();
    const router = await environment.client.workflow.start(slackWorkspaceRouterWorkflow, {
      workflowId: "slack-workspace:TCLOSED",
      taskQueue,
      args: [
        {
          workspaceId: "TCLOSED",
          reconciliationIntervalSeconds: 30,
          registrations: [
            {
              workflowId: "ticket-closed",
              projectItemId: "PVTI_CLOSED",
              surface: slackTaskSurfaceSchema.parse({
                mode: "channel_per_ticket",
                workspaceId: "TCLOSED",
                channelId: "CCLOSED",
                headerTs: "1700000000.000001",
                permalink: "https://fake.slack.com/closed",
              }),
              allowedUserGroupIds: ["SENGINEERS"],
              defaultMode: "redirect",
              archiveDelayDays: 0,
              terminal: false,
            },
          ],
        },
      ],
    });
    try {
      await router.executeUpdate(closeSlackSurfaceUpdate, { args: ["ticket-closed"] });
      await waitForArchived(router);
      const terminalRegistration = (await router.query(slackRouterStateQuery)).registrations[0];
      expect(terminalRegistration?.terminal).toBe(true);
      expect(typeof terminalRegistration?.terminalAtEpochMilliseconds).toBe("number");
      expect(typeof terminalRegistration?.archivedAtEpochMilliseconds).toBe("number");
      expect(archives).toBe(1);
      await router.signal(
        slackCommandEventSignal,
        slackCommandReferenceSchema.parse({
          commandId: "command-late",
          eventId: "Ev-late",
          workspaceId: "TCLOSED",
          channelId: "CCLOSED",
          messageTs: "1700000000.100001",
          actorId: "UACTOR",
          mode: "queue",
          contentDigest: slackCommandDigest("late guidance"),
        }),
      );
      await waitForProcessed(router);
      expect(closedReplies).toBe(1);
    } finally {
      await router.terminate("test complete");
      worker.shutdown();
      await workerRun;
    }
  }, 30_000);

  it("compensates when a ticket is reopened while delayed archival is in flight", async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
    const archiveStarted = deferred();
    const releaseArchive = deferred();
    let unarchives = 0;
    const taskQueue = "slack-router-archive-race-test";
    const registration = {
      workflowId: "ticket-reopened",
      projectItemId: "PVTI_REOPENED",
      surface: slackTaskSurfaceSchema.parse({
        mode: "channel_per_ticket",
        workspaceId: "TREOPENED",
        channelId: "CREOPENED",
        headerTs: "1700000000.000001",
        permalink: "https://fake.slack.com/reopened",
      }),
      allowedUserGroupIds: ["SENGINEERS"],
      defaultMode: "redirect" as const,
      archiveDelayDays: 0,
      terminal: false,
    };
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath,
      activities: {
        materializeSlackCommand: () => Promise.reject(new Error("not expected")),
        replyClosedSlackSession: () => Promise.resolve(),
        archiveSlackTicketChannel: async () => {
          archiveStarted.resolve();
          await releaseArchive.promise;
        },
        unarchiveSlackTicketChannel: () => {
          unarchives += 1;
          return Promise.resolve();
        },
        reconcileSlackCommands: () => Promise.resolve({ references: [], highWatermarks: {} }),
      } satisfies SlackRouterActivities,
    });
    const workerRun = worker.run();
    const router = await environment.client.workflow.start(slackWorkspaceRouterWorkflow, {
      workflowId: "slack-workspace:TREOPENED",
      taskQueue,
      args: [
        {
          workspaceId: "TREOPENED",
          reconciliationIntervalSeconds: 30,
          registrations: [registration],
        },
      ],
    });
    try {
      await router.executeUpdate(closeSlackSurfaceUpdate, { args: ["ticket-reopened"] });
      await archiveStarted.promise;
      await router.executeUpdate(registerSlackSurfaceUpdate, { args: [registration] });
      releaseArchive.resolve();
      await waitForActiveUnarchived(router, () => unarchives > 0);

      const recovered = (await router.query(slackRouterStateQuery)).registrations[0];
      expect(recovered?.terminal).toBe(false);
      expect(recovered?.archivedAtEpochMilliseconds).toBeUndefined();
      expect(unarchives).toBe(1);
    } finally {
      releaseArchive.resolve();
      await router.terminate("test complete");
      worker.shutdown();
      await workerRun;
    }
  }, 30_000);
});

async function waitForProcessed(
  router: Awaited<ReturnType<TestWorkflowEnvironment["client"]["workflow"]["start"]>>,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const state = await router.query(slackRouterStateQuery);
    if (state.processedEvents >= 1) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("router did not process the Slack command");
}

async function waitForArchived(
  router: Awaited<ReturnType<TestWorkflowEnvironment["client"]["workflow"]["start"]>>,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const registration = (await router.query(slackRouterStateQuery)).registrations[0];
    if (registration?.archivedAtEpochMilliseconds !== undefined) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("router did not archive the ticket channel");
}

async function waitForActiveUnarchived(
  router: Awaited<ReturnType<TestWorkflowEnvironment["client"]["workflow"]["start"]>>,
  compensated: () => boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const registration = (await router.query(slackRouterStateQuery)).registrations[0];
    if (
      compensated() &&
      registration?.terminal === false &&
      registration.archivedAtEpochMilliseconds === undefined
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("router did not compensate the archival race");
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
