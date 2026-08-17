import { fileURLToPath } from "node:url";

import { ApplicationFailure } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { issueIdSchema, projectItemIdSchema } from "@thor/domain";
import { afterEach, describe, expect, it } from "vitest";

import {
  projectSynchronizerWorkflow,
  stopProjectSynchronizerSignal,
  type ProjectSynchronizerActivities,
} from "./project-synchronizer.js";

const workflowsPath = fileURLToPath(new URL("./workflows.ts", import.meta.url));
const workflowId = "github-project:PVT_retry_test:synchronizer";

describe("projectSynchronizerWorkflow", () => {
  let environment: TestWorkflowEnvironment | undefined;

  afterEach(async () => {
    await environment?.teardown();
    environment = undefined;
  });

  it("recovers from a transient GitHub outage through Temporal Activity retries", async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
    let scanAttempts = 0;
    const dispatched: string[] = [];
    const activities: ProjectSynchronizerActivities = {
      initializeProjectPolling: () => Promise.resolve([]),
      scanProjectItems: () => {
        scanAttempts += 1;
        if (scanAttempts < 3) {
          throw ApplicationFailure.retryable("GitHub unavailable", "github_unavailable");
        }
        return Promise.resolve([present("PVTI_recovered")]);
      },
      dispatchProjectObservation: async ({ observation }) => {
        dispatched.push(observation.projectItemId);
        await environment?.client.workflow
          .getHandle(workflowId)
          .signal(stopProjectSynchronizerSignal);
      },
    };
    const result = await execute(environment, activities);

    expect(result.completedPolls).toBe(1);
    expect(scanAttempts).toBe(3);
    expect(dispatched).toEqual(["PVTI_recovered"]);
  });

  it("does not retry terminal GitHub failures", async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
    let scanAttempts = 0;
    const activities: ProjectSynchronizerActivities = {
      initializeProjectPolling: () => Promise.resolve([]),
      scanProjectItems: () => {
        scanAttempts += 1;
        throw ApplicationFailure.nonRetryable("bad credentials", "github_authentication");
      },
      dispatchProjectObservation: () => Promise.resolve(),
    };
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: "thor-project-sync-test",
      workflowsPath,
      activities,
    });

    await expect(
      worker.runUntil(
        environment.client.workflow.execute(projectSynchronizerWorkflow, {
          workflowId,
          taskQueue: "thor-project-sync-test",
          args: [workflowInput()],
        }),
      ),
    ).rejects.toThrow("Workflow execution failed");
    expect(scanAttempts).toBe(1);
  });

  it("isolates a terminal dispatch failure from other Project items", async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
    const dispatched: string[] = [];
    const activities: ProjectSynchronizerActivities = {
      initializeProjectPolling: () => Promise.resolve([]),
      scanProjectItems: () => Promise.resolve([present("PVTI_bad"), present("PVTI_good")]),
      dispatchProjectObservation: async ({ observation }) => {
        dispatched.push(observation.projectItemId);
        if (observation.projectItemId === "PVTI_bad") {
          throw ApplicationFailure.nonRetryable("invalid dispatch", "dispatch_invalid");
        }
        await environment?.client.workflow
          .getHandle(workflowId)
          .signal(stopProjectSynchronizerSignal);
      },
    };
    const result = await execute(environment, activities);

    expect(result.completedPolls).toBe(1);
    expect(result.dispatchFailures).toBe(1);
    expect(dispatched).toEqual(expect.arrayContaining(["PVTI_bad", "PVTI_good"]));
  });
});

async function execute(
  environment: TestWorkflowEnvironment,
  activities: ProjectSynchronizerActivities,
) {
  const worker = await Worker.create({
    connection: environment.nativeConnection,
    taskQueue: "thor-project-sync-test",
    workflowsPath,
    activities,
  });
  return worker.runUntil(
    environment.client.workflow.execute(projectSynchronizerWorkflow, {
      workflowId,
      taskQueue: "thor-project-sync-test",
      args: [workflowInput()],
    }),
  );
}

function workflowInput() {
  return {
    projectId: "PVT_retry_test",
    pollIntervalMs: 30_000,
    unreadableAfterConsecutivePolls: 2,
  };
}

function present(id: string) {
  const projectItemId = projectItemIdSchema.parse(id);
  return {
    kind: "present" as const,
    projectItemId,
    snapshot: {
      projectItemId,
      projectId: "PVT_retry_test",
      updatedAt: "2026-08-17T12:00:00Z",
      status: "ready",
      ticket: {
        projectItemId,
        issueId: issueIdSchema.parse(`I_${id}`),
        repository: { owner: "example", name: "service" },
        issueNumber: 1,
        title: "Retry test",
        body: "",
        workType: "task" as const,
        priority: "P2" as const,
        acceptanceCriteria: ["The retry test completes"],
        dependencies: [],
        policy: {
          executionMode: "agent" as const,
          planningDepth: "full" as const,
          approvalPolicy: "autonomous" as const,
          agentPolicy: "preferred" as const,
          autonomousRepairBudget: 2,
        },
      },
    },
  };
}
