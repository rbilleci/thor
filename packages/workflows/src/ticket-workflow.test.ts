import { fileURLToPath } from "node:url";

import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import {
  projectItemIdSchema,
  findingIdSchema,
  type ExecutionId,
  type HarnessKind,
  type TicketPolicy,
  type TicketStatus,
} from "@thor/domain";
import { afterEach, describe, expect, test } from "vitest";

import {
  blueprintDecisionSignal,
  cancelTicketSignal,
  mergeDecisionSignal,
  projectChangedSignal,
  ticketStateQuery,
  ticketWorkflow,
} from "./ticket-workflow.js";
import type {
  Audited,
  ExecutionAuditRecord,
  TicketActivities,
  TicketWorkflowInput,
} from "./contracts.js";

const workflowsPath = fileURLToPath(new URL("./workflows.ts", import.meta.url));
const projectItemId = projectItemIdSchema.parse("PVTI_test_1");

describe("ticketWorkflow", () => {
  let environment: TestWorkflowEnvironment | undefined;

  afterEach(async () => {
    await environment?.teardown();
    environment = undefined;
  });

  test("runs blueprint, implementation, ten reviewers, synthesis, and merge", async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
    const fake = createActivities(policy("autonomous"));
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: "thor-happy-path",
      workflowsPath,
      activities: fake.activities,
    });
    const workflowId = `github-project-item:${projectItemId}`;
    const handle = await environment.client.workflow.start(ticketWorkflow, {
      workflowId,
      taskQueue: "thor-happy-path",
      args: [workflowInput()],
    });
    const result = await worker.runUntil(handle.result());

    expect(result.run.status).toBe("done");
    expect(result.mergeCommitSha).toBe("merge-sha");
    expect(result.auditTrail).toHaveLength(13);
    expect(fake.reviewers).toHaveLength(10);
    expect(fake.statuses).toEqual(
      expect.arrayContaining([
        "design_blueprint",
        "in_progress",
        "in_review",
        "ready_to_merge",
        "merging",
        "done",
      ]),
    );
    expect(fake.summaryPublished).toBe(true);
    await Worker.runReplayHistory({ workflowsPath }, await handle.fetchHistory(), workflowId);
  }, 60_000);

  test("waits durably for configured blueprint and merge approvals", async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
    const fake = createActivities(policy("blueprint_and_pre_merge_review"));
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: "thor-human-gates",
      workflowsPath,
      activities: fake.activities,
    });
    const handle = await environment.client.workflow.start(ticketWorkflow, {
      workflowId: `github-project-item:${projectItemId}:human-gates`,
      taskQueue: "thor-human-gates",
      args: [workflowInput()],
    });

    const workerRun = worker.run();
    let result: Awaited<ReturnType<typeof handle.result>>;
    try {
      await handle.signal(mergeDecisionSignal, {
        decision: "approved",
        actor: "premature-reviewer",
      });
      await waitForStatus(() => handle.query(ticketStateQuery), "awaiting_blueprint_approval");
      await handle.signal(blueprintDecisionSignal, {
        decision: "approved",
        actor: "octocat",
      });
      await waitForStatus(() => handle.query(ticketStateQuery), "automated_review_passed");
      expect((await handle.query(ticketStateQuery)).run?.mergeApproval).toBe("pending");
      await handle.signal(mergeDecisionSignal, {
        decision: "approved",
        actor: "octocat",
      });
      result = await handle.result();
    } finally {
      worker.shutdown();
      await workerRun;
    }

    expect(result.run.blueprintApproval).toBe("approved");
    expect(result.run.mergeApproval).toBe("approved");
    expect(result.run.status).toBe("done");
    expect(fake.statuses).toContain("awaiting_blueprint_approval");
    expect(fake.statuses).toContain("awaiting_human_merge_review");
  }, 60_000);

  test("uses a deterministic ticket plan when planning depth is none", async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
    const fake = createActivities({ ...policy("autonomous"), planningDepth: "none" });
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: "thor-no-planning",
      workflowsPath,
      activities: fake.activities,
    });
    const result = await worker.runUntil(
      environment.client.workflow.execute(ticketWorkflow, {
        workflowId: `github-project-item:${projectItemId}:no-planning`,
        taskQueue: "thor-no-planning",
        args: [workflowInput()],
      }),
    );

    expect(result.run.status).toBe("done");
    expect(result.run.blueprint?.acceptanceCriteria).toEqual(["The workflow completes"]);
    expect(result.auditTrail).toHaveLength(12);
    expect(fake.blueprintExecutions).toBe(0);
    expect(fake.blueprintPublished).toBe(true);
  }, 60_000);

  test("retries a transient agent failure through Temporal policy", async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
    const fake = createActivities(policy("autonomous"));
    const originalActivities = { ...fake.activities };
    let attempts = 0;
    fake.activities.createBlueprint = (input) => {
      attempts += 1;
      if (attempts === 1) {
        throw ApplicationFailure.create({
          message: "temporary provider outage",
          type: "agent_provider_unavailable",
          nonRetryable: false,
        });
      }
      return originalActivities.createBlueprint(input);
    };
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: "thor-retry",
      workflowsPath,
      activities: fake.activities,
    });
    const result = await worker.runUntil(
      environment.client.workflow.execute(ticketWorkflow, {
        workflowId: `github-project-item:${projectItemId}:retry`,
        taskQueue: "thor-retry",
        args: [workflowInput()],
      }),
    );

    expect(result.run.status).toBe("done");
    expect(attempts).toBe(2);
  }, 60_000);

  test("repairs blocking findings and performs impact-based re-review", async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
    const fake = createActivities(policy("autonomous"));
    let synthesisPass = 0;
    fake.activities.synthesize = (input) => {
      synthesisPass += 1;
      const findings =
        synthesisPass === 1
          ? [
              {
                findingId: findingIdSchema.parse("normalized-blocking-finding"),
                sourceFindingIds: [findingIdSchema.parse("source-blocking-finding")],
                reviewers: ["correctness" as const],
                severity: "high" as const,
                category: "correctness",
                summary: "Incorrect behavior",
                evidence: ["failing case"],
                affectedFiles: ["src/index.ts"],
                recommendedFix: "Correct the behavior",
                disposition: "blocking" as const,
                confidence: 1,
              },
            ]
          : [];
      return Promise.resolve(
        audited(input.executionId, input.harness, "synthesis", {
          reviewRunId: input.reviewRunId,
          findings,
          failureScope: "repair" as const,
          fullReReview: false,
        }),
      );
    };
    fake.activities.repair = (input) =>
      Promise.resolve(
        audited(input.executionId, input.harness, "repair", {
          commitSha: "repaired-commit-sha",
          repairedFindings: input.findingIds,
          changedFiles: ["src/index.ts"],
          testsPassed: true,
        }),
      );
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: "thor-repair",
      workflowsPath,
      activities: fake.activities,
    });
    const result = await worker.runUntil(
      environment.client.workflow.execute(ticketWorkflow, {
        workflowId: `github-project-item:${projectItemId}:repair`,
        taskQueue: "thor-repair",
        args: [workflowInput()],
      }),
    );

    expect(result.run.status).toBe("done");
    expect(result.run.repairPass).toBe(1);
    expect(result.run.implementation?.commitSha).toBe("repaired-commit-sha");
    expect(fake.statuses).toContain("repairing");
    expect(fake.statuses).toContain("re_review");
    expect(fake.reviewers).toHaveLength(12);
  }, 60_000);

  test("blocks instead of overwriting an unexpected human Project transition", async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
    const fake = createActivities(policy("autonomous"));
    fake.activities.createBlueprint = async (): Promise<never> => {
      const context = Context.current();
      const heartbeatTimer = setInterval(() => context.heartbeat({ phase: "authority_test" }), 10);
      try {
        return await context.cancelled;
      } finally {
        clearInterval(heartbeatTimer);
      }
    };
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: "thor-human-authority",
      workflowsPath,
      activities: fake.activities,
      maxHeartbeatThrottleInterval: "10ms",
    });
    const handle = await environment.client.workflow.start(ticketWorkflow, {
      workflowId: `github-project-item:${projectItemId}:human-authority`,
      taskQueue: "thor-human-authority",
      args: [workflowInput()],
    });
    const workerRun = worker.run();
    try {
      await waitForActiveExecution(() => handle.query(ticketStateQuery));
      const snapshot = await fake.activities.loadProjectItem(projectItemId);
      await handle.signal(projectChangedSignal, {
        snapshot: { ...snapshot, status: "done", updatedAt: "human-version" },
        reason: "human moved the item",
      });
      await waitForStatus(() => handle.query(ticketStateQuery), "blocked");
      expect(fake.statuses).toContain("blocked");
      await handle.signal(cancelTicketSignal, { actor: "octocat", reason: "test cleanup" });
      expect((await handle.result()).run.status).toBe("cancelled");
    } finally {
      worker.shutdown();
      await workerRun;
    }
  }, 60_000);

  test("cancels an active agent Activity when an operator cancels the ticket", async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
    const fake = createActivities(policy("autonomous"));
    fake.activities.createBlueprint = async (): Promise<never> => {
      const context = Context.current();
      const heartbeatTimer = setInterval(() => context.heartbeat({ phase: "blocked_test" }), 10);
      try {
        return await context.cancelled;
      } finally {
        clearInterval(heartbeatTimer);
      }
    };
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: "thor-cancellation",
      workflowsPath,
      activities: fake.activities,
      maxHeartbeatThrottleInterval: "10ms",
    });
    const handle = await environment.client.workflow.start(ticketWorkflow, {
      workflowId: `github-project-item:${projectItemId}:cancellation`,
      taskQueue: "thor-cancellation",
      args: [workflowInput()],
    });
    const workerRun = worker.run();
    try {
      await waitForActiveExecution(() => handle.query(ticketStateQuery));
      await handle.signal(cancelTicketSignal, {
        actor: "octocat",
        reason: "cancelled by a human",
      });
      await waitForStatus(() => handle.query(ticketStateQuery), "cancelled");
      const result = await handle.result();
      expect(result.run.status).toBe("cancelled");
      expect(fake.summaryPublished).toBe(true);
    } finally {
      worker.shutdown();
      await workerRun;
    }
  }, 60_000);
});

function createActivities(ticketPolicy: TicketPolicy): {
  activities: TicketActivities;
  statuses: string[];
  reviewers: string[];
  summaryPublished: boolean;
  blueprintExecutions: number;
  blueprintPublished: boolean;
} {
  let status: TicketStatus = "design_blueprint";
  let version = 1;
  const statuses: string[] = [status];
  const reviewers: string[] = [];
  const holder = { summaryPublished: false, blueprintExecutions: 0, blueprintPublished: false };
  const ticket = {
    projectItemId,
    repository: { owner: "example", name: "repository" },
    issueNumber: 42,
    title: "Implement durable delivery",
    body: "Ship the requested behavior",
    workType: "feature" as const,
    priority: "P1" as const,
    acceptanceCriteria: ["The workflow completes"],
    dependencies: [],
    policy: ticketPolicy,
  };
  const snapshot = () => ({
    projectItemId,
    projectId: "PVT_project",
    updatedAt: String(version),
    status,
    ticket,
  });
  const activities: TicketActivities = {
    loadProjectItem: () => Promise.resolve(snapshot()),
    transitionProjectStatus: (transition) => {
      status = transition.targetStatus;
      version += 1;
      statuses.push(status);
      return Promise.resolve({ kind: "updated", snapshot: snapshot() });
    },
    createBlueprint: (input) => {
      holder.blueprintExecutions += 1;
      return Promise.resolve(
        audited(input.executionId, input.harness, "blueprint", {
          objective: "Implement durable delivery",
          constraints: [],
          architecture: "Use deterministic workflow orchestration",
          proposedDesign: "Execute all delivery phases through Activities",
          affectedAreas: ["orchestration"],
          implementationPlan: ["Implement the change"],
          testingPlan: ["Run the tests"],
          rolloutPlan: [],
          risks: [],
          unresolvedBlockingQuestions: [],
          acceptanceCriteria: ["The workflow completes"],
        }),
      );
    },
    publishBlueprint: () => {
      holder.blueprintPublished = true;
      return Promise.resolve();
    },
    implement: (input) =>
      Promise.resolve(
        audited(input.executionId, input.harness, "implementation", {
          branch: "thor/test",
          commitSha: "commit-sha",
          pullRequestNumber: 7,
          changedFiles: ["src/index.ts"],
          testsPassed: true,
          riskFlags: [],
        }),
      ),
    review: (input) => {
      reviewers.push(input.reviewer);
      return Promise.resolve(
        audited(input.executionId, input.harness, "review", {
          reviewRunId: input.reviewRunId,
          reviewer: input.reviewer,
          findings: [],
          passed: true,
        }),
      );
    },
    synthesize: (input) =>
      Promise.resolve(
        audited(input.executionId, input.harness, "synthesis", {
          reviewRunId: input.reviewRunId,
          findings: [],
          failureScope: "repair",
          fullReReview: false,
        }),
      ),
    repair: () => Promise.reject(new Error("repair should not run in the happy path")),
    materializeDeferredFinding: () =>
      Promise.reject(new Error("no findings should be deferred in the happy path")),
    getMergeReadiness: () =>
      Promise.resolve({ mergeable: true, headSha: "commit-sha", merged: false }),
    merge: () => Promise.resolve("merge-sha"),
    publishRunSummary: () => {
      holder.summaryPublished = true;
      return Promise.resolve();
    },
  };
  return {
    activities,
    statuses,
    reviewers,
    get summaryPublished() {
      return holder.summaryPublished;
    },
    get blueprintExecutions() {
      return holder.blueprintExecutions;
    },
    get blueprintPublished() {
      return holder.blueprintPublished;
    },
  };
}

function audited<Value>(
  executionId: ExecutionId,
  harness: HarnessKind,
  purpose: string,
  value: Value,
): Audited<Value> {
  const audit: ExecutionAuditRecord = {
    executionId,
    harness,
    purpose,
    packageDigest: "a".repeat(64),
    promptDigest: "b".repeat(64),
    agentsMdDigest: "c".repeat(64),
    configurationDigest: "d".repeat(64),
    skills: [],
    usage: {},
  };
  return { value, audit };
}

function policy(approvalPolicy: TicketPolicy["approvalPolicy"]): TicketPolicy {
  return {
    executionMode: "agent",
    planningDepth: "full",
    approvalPolicy,
    agentPolicy: "preferred",
    autonomousRepairBudget: 3,
  };
}

function workflowInput(): TicketWorkflowInput {
  return { projectItemId, baseBranch: "main" };
}

async function waitForStatus(
  query: () => Promise<{
    run?: { status: string };
    latestProjectSnapshot?: { status: string };
    activeExecutionIds?: string[];
  }>,
  expected: string,
): Promise<void> {
  let lastStatus = "missing";
  let lastProjectStatus = "missing";
  let activeCount = 0;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const state = await query();
    lastStatus = state.run?.status ?? "missing";
    lastProjectStatus = state.latestProjectSnapshot?.status ?? "missing";
    activeCount = state.activeExecutionIds?.length ?? 0;
    if (state.run?.status === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `workflow did not reach ${expected}; run=${lastStatus}, project=${lastProjectStatus}, active=${activeCount}`,
  );
}

async function waitForActiveExecution(
  query: () => Promise<{ activeExecutionIds: string[] }>,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await query()).activeExecutionIds.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("workflow did not start an agent execution");
}
