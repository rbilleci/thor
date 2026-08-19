import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { compileRuntimeDeliveryProfile } from "@thor/config";
import type { BoardStateKey } from "@thor/config/schema";
import {
  issueIdSchema,
  projectItemIdSchema,
  findingIdSchema,
  type ExecutionId,
  type TicketContext,
  type TicketPolicy,
} from "@thor/domain";
import { slackCommandDigest } from "@thor/slack";
import { slackCommandReferenceSchema, slackTaskSurfaceSchema } from "@thor/slack/types";
import { afterEach, describe, expect, test } from "vitest";

import {
  cancelTicketSignal,
  mergeDecisionSignal,
  projectChangedSignal,
  ticketStateQuery,
  ticketWorkflow,
} from "./ticket-workflow.js";
import type {
  Audited,
  AgentActivityContext,
  ExecutionAuditRecord,
  TicketActivities,
  TicketWorkflowInput,
} from "./contracts.js";
import { acceptedSlackCommandSchema } from "./slack-contracts.js";
import { acceptedSlackCommandSignal, appliedSlackCommandSignal } from "./slack-router.js";

const workflowsPath = fileURLToPath(new URL("./workflows.ts", import.meta.url));
const projectItemId = projectItemIdSchema.parse("PVTI_test_1");
const defaultDeclaration: unknown = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../config/templates/default-delivery.json", import.meta.url)),
    "utf8",
  ),
);
const defaultDelivery = compileRuntimeDeliveryProfile(defaultDeclaration);
const compactDeclaration: unknown = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../config/templates/compact-delivery.json", import.meta.url)),
    "utf8",
  ),
);
const compactDelivery = compileRuntimeDeliveryProfile(compactDeclaration);

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
    expect(fake.events.indexOf("status:done")).toBeLessThan(fake.events.indexOf("close-issue"));
    expect(fake.events.indexOf("close-issue")).toBeLessThan(fake.events.indexOf("summary"));
    expect(fake.summaryPublished).toBe(true);
    await Worker.runReplayHistory({ workflowsPath }, await handle.fetchHistory(), workflowId);
  }, 60_000);

  test("leaves the source Issue open when the Workflow profile disables post-merge closure", async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
    const fake = createActivities(policy("autonomous"));
    const delivery = {
      ...defaultDelivery,
      workflow: {
        ...defaultDelivery.workflow,
        dependencies: {
          ...defaultDelivery.workflow.dependencies,
          closeIssueAfterMerge: false,
        },
      },
    };
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: "thor-leave-source-issue-open",
      workflowsPath,
      activities: fake.activities,
    });
    const handle = await environment.client.workflow.start(ticketWorkflow, {
      workflowId: `github-project-item:${projectItemId}:leave-source-open`,
      taskQueue: "thor-leave-source-issue-open",
      args: [workflowInput(delivery)],
    });
    const result = await worker.runUntil(handle.result());

    expect(result.run.status).toBe("done");
    expect(fake.events).not.toContain("close-issue");
  }, 60_000);

  test("runs a compact projected board with its configured reviewers and agent profiles", async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
    const fake = createActivities(policy("autonomous"), "design");
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: "thor-compact-profile",
      workflowsPath,
      activities: fake.activities,
    });
    const workflowId = `github-project-item:${projectItemId}:compact`;
    const handle = await environment.client.workflow.start(ticketWorkflow, {
      workflowId,
      taskQueue: "thor-compact-profile",
      args: [workflowInput(compactDelivery)],
    });
    const result = await worker.runUntil(handle.result());

    expect(result.run.status).toBe("done");
    expect(fake.reviewers).toHaveLength(4);
    expect(fake.reviewers).toEqual(
      expect.arrayContaining(["correctness", "security", "testing", "product_specification"]),
    );
    expect(fake.statuses).toEqual(expect.arrayContaining(["design", "active", "review", "done"]));
    expect(fake.statuses).not.toContain("in_progress");
    expect(result.auditTrail).toHaveLength(7);
    expect(result.auditTrail[0]).toMatchObject({
      agentProfile: "compact-planner",
      harness: "codex",
    });
    expect(result.auditTrail[1]).toMatchObject({
      agentProfile: "compact-builder",
      harness: "claude",
    });
    expect(result.auditTrail[2]).toMatchObject({
      agentProfile: "compact-reviewer",
      harness: "codex",
    });
    expect(result.auditTrail.at(-1)).toMatchObject({
      agentProfile: "compact-synthesizer",
      harness: "claude",
    });
    await Worker.runReplayHistory({ workflowsPath }, await handle.fetchHistory(), workflowId);
  }, 60_000);

  test("accepts a conflicted transition when GitHub already reached the intended status", async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
    const fake = createActivities(policy("autonomous"));
    const transitionProjectStatus = fake.activities.transitionProjectStatus.bind(fake.activities);
    let injectedConflict = false;
    fake.activities.transitionProjectStatus = async (transition) => {
      const result = await transitionProjectStatus(transition);
      if (!injectedConflict && transition.targetStatus === "automated_review_passed") {
        injectedConflict = true;
        return {
          kind: "conflict",
          snapshot: result.snapshot,
          reason: "GitHub returned an eventually consistent pre-transition snapshot",
        };
      }
      return result;
    };
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: "thor-already-transitioned",
      workflowsPath,
      activities: fake.activities,
    });
    const workflowId = `github-project-item:${projectItemId}:already-transitioned`;
    const handle = await environment.client.workflow.start(ticketWorkflow, {
      workflowId,
      taskQueue: "thor-already-transitioned",
      args: [workflowInput()],
    });
    const result = await worker.runUntil(handle.result());

    expect(injectedConflict).toBe(true);
    expect(result.run.status).toBe("done");
    await Worker.runReplayHistory({ workflowsPath }, await handle.fetchHistory(), workflowId);
  }, 60_000);

  test("consumes a human gate decision returned by the transition confirmation read", async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
    const fake = createActivities(policy("pre_merge_review"));
    const transitionProjectStatus = fake.activities.transitionProjectStatus.bind(fake.activities);
    let injectedApproval = false;
    fake.activities.transitionProjectStatus = (transition) => {
      if (!injectedApproval && transition.targetStatus === "awaiting_human_merge_review") {
        injectedApproval = true;
        return transitionProjectStatus({
          ...transition,
          targetStatus: "ready_to_merge",
        });
      }
      return transitionProjectStatus(transition);
    };
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: "thor-concurrent-gate-decision",
      workflowsPath,
      activities: fake.activities,
    });
    const workflowId = `github-project-item:${projectItemId}:concurrent-gate-decision`;
    const handle = await environment.client.workflow.start(ticketWorkflow, {
      workflowId,
      taskQueue: "thor-concurrent-gate-decision",
      args: [workflowInput()],
    });
    const result = await worker.runUntil(handle.result());

    expect(injectedApproval).toBe(true);
    expect(result.run.mergeApproval).toBe("approved");
    expect(result.run.status).toBe("done");
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
      await waitForProjectStatus(
        () => handle.query(ticketStateQuery),
        "awaiting_blueprint_approval",
      );
      const blueprintSnapshot = (await handle.query(ticketStateQuery)).latestProjectSnapshot;
      if (blueprintSnapshot === undefined) throw new Error("missing blueprint Project snapshot");
      await handle.signal(projectChangedSignal, {
        kind: "present",
        snapshot: {
          ...blueprintSnapshot,
          status: "ready",
        },
        reason: "GitHub blueprint approval by octocat",
      });
      await waitForStatus(() => handle.query(ticketStateQuery), "automated_review_passed");
      await waitForProjectStatus(
        () => handle.query(ticketStateQuery),
        "awaiting_human_merge_review",
      );
      expect((await handle.query(ticketStateQuery)).run?.mergeApproval).toBe("pending");
      const mergeSnapshot = (await handle.query(ticketStateQuery)).latestProjectSnapshot;
      if (mergeSnapshot === undefined) throw new Error("missing merge Project snapshot");
      const echoedAt = String(Number(mergeSnapshot.updatedAt) + 1);
      await handle.signal(projectChangedSignal, {
        kind: "present",
        snapshot: {
          ...mergeSnapshot,
          updatedAt: echoedAt,
        },
        reason: "delayed poll echo of Thor's merge gate",
      });
      await waitForProjectUpdatedAt(() => handle.query(ticketStateQuery), echoedAt);
      expect((await handle.query(ticketStateQuery)).run?.status).toBe("automated_review_passed");
      const echoedSnapshot = (await handle.query(ticketStateQuery)).latestProjectSnapshot;
      if (echoedSnapshot === undefined) throw new Error("missing echoed merge Project snapshot");
      await handle.signal(projectChangedSignal, {
        kind: "present",
        snapshot: {
          ...echoedSnapshot,
          status: "ready_to_merge",
        },
        reason: "GitHub merge approval by octocat",
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
        audited(input, "synthesis", {
          reviewRunId: input.reviewRunId,
          findings,
          failureScope: "repair" as const,
          fullReReview: false,
        }),
      );
    };
    fake.activities.repair = (input) =>
      Promise.resolve(
        audited(input, "repair", {
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
    const createBlueprint = fake.activities.createBlueprint.bind(fake.activities);
    let attempts = 0;
    fake.activities.createBlueprint = async (input) => {
      attempts += 1;
      if (attempts > 1) return createBlueprint(input);
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
      const snapshot = fake.humanChange({ status: "done" });
      await handle.signal(projectChangedSignal, {
        kind: "present",
        snapshot,
        reason: "human moved the item",
      });
      await waitForStatus(() => handle.query(ticketStateQuery), "blocked");
      expect(fake.statuses).toContain("blocked");
      await handle.signal(projectChangedSignal, {
        kind: "present",
        snapshot: fake.humanChange({ status: "design_blueprint" }),
        reason: "human restored the suspended blueprint phase",
      });
      const result = await handle.result();
      expect(result.run.status).toBe("done");
      expect(attempts).toBe(2);
      await Worker.runReplayHistory(
        { workflowsPath },
        await handle.fetchHistory(),
        handle.workflowId,
      );
    } finally {
      worker.shutdown();
      await workerRun;
    }
  }, 60_000);

  test("cancels in-flight implementation, replans edited ticket intent, and completes", async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
    const fake = createActivities(policy("autonomous"));
    const implement = fake.activities.implement.bind(fake.activities);
    let implementationAttempts = 0;
    fake.activities.implement = async (input) => {
      implementationAttempts += 1;
      if (implementationAttempts > 1) return implement(input);
      const context = Context.current();
      const heartbeatTimer = setInterval(() => context.heartbeat({ phase: "intent_edit" }), 10);
      try {
        return await context.cancelled;
      } finally {
        clearInterval(heartbeatTimer);
      }
    };
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: "thor-intent-edit-recovery",
      workflowsPath,
      activities: fake.activities,
      maxHeartbeatThrottleInterval: "10ms",
    });
    const workflowId = `github-project-item:${projectItemId}:intent-edit-recovery`;
    const handle = await environment.client.workflow.start(ticketWorkflow, {
      workflowId,
      taskQueue: "thor-intent-edit-recovery",
      args: [workflowInput()],
    });
    const workerRun = worker.run();
    try {
      await waitForStatus(() => handle.query(ticketStateQuery), "in_progress");
      await waitForActiveExecution(() => handle.query(ticketStateQuery));
      const edited = fake.humanChange({
        ticket: (ticket) => ({
          ...ticket,
          body: "Ship the revised human-authored behavior",
          acceptanceCriteria: ["The revised workflow completes"],
        }),
      });
      await handle.signal(projectChangedSignal, {
        kind: "present",
        snapshot: edited,
        reason: "human edited ticket intent during implementation",
      });
      const blocked = await waitForStatusResult(() => handle.query(ticketStateQuery), "blocked");
      expect(blocked.run?.suspendedStatus).toBe("design_blueprint");
      await waitForNoActiveExecution(() => handle.query(ticketStateQuery));
      await handle.signal(projectChangedSignal, {
        kind: "present",
        snapshot: fake.humanChange({ status: "design_blueprint" }),
        reason: "human accepted replanning",
      });
      const result = await handle.result();
      expect(result.run.status).toBe("done");
      expect(result.run.ticket.body).toBe("Ship the revised human-authored behavior");
      expect(fake.blueprintExecutions).toBe(2);
      expect(implementationAttempts).toBe(2);
      await Worker.runReplayHistory({ workflowsPath }, await handle.fetchHistory(), workflowId);
    } finally {
      worker.shutdown();
      await workerRun;
    }
  }, 60_000);

  test("blocks on a dependency regression, replans after recovery, and completes", async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
    const fake = createActivities(policy("autonomous"));
    const implement = fake.activities.implement.bind(fake.activities);
    let implementationAttempts = 0;
    fake.activities.implement = async (input) => {
      implementationAttempts += 1;
      if (implementationAttempts > 1) return implement(input);
      return cancellableActivity("dependency_replan");
    };
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: "thor-dependency-replan",
      workflowsPath,
      activities: fake.activities,
      maxHeartbeatThrottleInterval: "10ms",
    });
    const workflowId = `github-project-item:${projectItemId}:dependency-replan`;
    const handle = await environment.client.workflow.start(ticketWorkflow, {
      workflowId,
      taskQueue: "thor-dependency-replan",
      args: [workflowInput()],
    });
    const workerRun = worker.run();
    try {
      await waitForStatus(() => handle.query(ticketStateQuery), "in_progress");
      await waitForActiveExecution(() => handle.query(ticketStateQuery));
      await handle.signal(projectChangedSignal, {
        kind: "present",
        snapshot: fake.humanChange({
          ticket: (ticket) => ({
            ...ticket,
            dependencies: [{ issueId: "I_dependency", complete: false }],
          }),
        }),
        reason: "a referenced dependency was reopened",
      });
      await waitForStatus(() => handle.query(ticketStateQuery), "blocked");
      await handle.signal(projectChangedSignal, {
        kind: "present",
        snapshot: fake.humanChange({
          ticket: (ticket) => ({
            ...ticket,
            dependencies: [{ issueId: "I_dependency", complete: true }],
          }),
        }),
        reason: "the referenced dependency was completed again",
      });
      await handle.signal(projectChangedSignal, {
        kind: "present",
        snapshot: fake.humanChange({ status: "design_blueprint" }),
        reason: "human cleared the dependency block",
      });
      const result = await handle.result();
      expect(result.run.status).toBe("done");
      expect(result.run.ticket.dependencies).toEqual([{ issueId: "I_dependency", complete: true }]);
      expect(fake.blueprintExecutions).toBe(2);
      expect(implementationAttempts).toBe(2);
      await Worker.runReplayHistory({ workflowsPath }, await handle.fetchHistory(), workflowId);
    } finally {
      worker.shutdown();
      await workerRun;
    }
  }, 60_000);

  test("does not resume while a human-authored execution policy disables agents", async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
    const fake = createActivities(policy("autonomous"));
    const implement = fake.activities.implement.bind(fake.activities);
    let implementationAttempts = 0;
    fake.activities.implement = async (input) => {
      implementationAttempts += 1;
      if (implementationAttempts > 1) return implement(input);
      return cancellableActivity("policy_change");
    };
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: "thor-policy-change",
      workflowsPath,
      activities: fake.activities,
      maxHeartbeatThrottleInterval: "10ms",
    });
    const workflowId = `github-project-item:${projectItemId}:policy-change`;
    const handle = await environment.client.workflow.start(ticketWorkflow, {
      workflowId,
      taskQueue: "thor-policy-change",
      args: [workflowInput()],
    });
    const workerRun = worker.run();
    try {
      await waitForStatus(() => handle.query(ticketStateQuery), "in_progress");
      await waitForActiveExecution(() => handle.query(ticketStateQuery));
      await handle.signal(projectChangedSignal, {
        kind: "present",
        snapshot: fake.humanChange({
          ticket: (ticket) => ({
            ...ticket,
            policy: { ...ticket.policy, executionMode: "human" },
          }),
        }),
        reason: "human took ownership of the ticket",
      });
      await waitForStatus(() => handle.query(ticketStateQuery), "blocked");
      await handle.signal(projectChangedSignal, {
        kind: "present",
        snapshot: fake.humanChange({ status: "design_blueprint" }),
        reason: "attempted resume while agents remain disabled",
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect((await handle.query(ticketStateQuery)).run?.status).toBe("blocked");

      const restored = fake.humanChange({
        ticket: (ticket) => ({
          ...ticket,
          policy: { ...ticket.policy, executionMode: "agent" },
        }),
      });
      await handle.signal(projectChangedSignal, {
        kind: "present",
        snapshot: restored,
        reason: "human returned execution to Thor",
      });
      await handle.signal(projectChangedSignal, {
        kind: "present",
        snapshot: fake.humanChange({ status: "design_blueprint" }),
        reason: "human resumed after restoring agent policy",
      });
      const result = await handle.result();
      expect(result.run.status).toBe("done");
      expect(result.run.ticket.policy.executionMode).toBe("agent");
      expect(fake.blueprintExecutions).toBe(2);
      await Worker.runReplayHistory({ workflowsPath }, await handle.fetchHistory(), workflowId);
    } finally {
      worker.shutdown();
      await workerRun;
    }
  }, 60_000);

  test("uses the configured dependency resume policy without rerunning blueprint", async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
    const fake = createActivities(policy("autonomous"), "design");
    const implement = fake.activities.implement.bind(fake.activities);
    let implementationAttempts = 0;
    fake.activities.implement = async (input) => {
      implementationAttempts += 1;
      if (implementationAttempts > 1) return implement(input);
      return cancellableActivity("dependency_resume");
    };
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: "thor-dependency-resume",
      workflowsPath,
      activities: fake.activities,
      maxHeartbeatThrottleInterval: "10ms",
    });
    const workflowId = `github-project-item:${projectItemId}:dependency-resume`;
    const handle = await environment.client.workflow.start(ticketWorkflow, {
      workflowId,
      taskQueue: "thor-dependency-resume",
      args: [workflowInput(compactDelivery)],
    });
    const workerRun = worker.run();
    try {
      await waitForStatus(() => handle.query(ticketStateQuery), "in_progress");
      await waitForActiveExecution(() => handle.query(ticketStateQuery));
      await handle.signal(projectChangedSignal, {
        kind: "present",
        snapshot: fake.humanChange({
          ticket: (ticket) => ({
            ...ticket,
            dependencies: [{ issueId: "I_dependency", complete: false }],
          }),
        }),
      });
      const blocked = await waitForStatusResult(() => handle.query(ticketStateQuery), "blocked");
      expect(blocked.run?.suspendedStatus).toBe("in_progress");
      await handle.signal(projectChangedSignal, {
        kind: "present",
        snapshot: fake.humanChange({
          ticket: (ticket) => ({
            ...ticket,
            dependencies: [{ issueId: "I_dependency", complete: true }],
          }),
        }),
      });
      await handle.signal(projectChangedSignal, {
        kind: "present",
        snapshot: fake.humanChange({ status: "active" }),
        reason: "human resumed the suspended implementation",
      });
      const result = await handle.result();
      expect(result.run.status).toBe("done");
      expect(fake.blueprintExecutions).toBe(1);
      expect(implementationAttempts).toBe(2);
      await Worker.runReplayHistory({ workflowsPath }, await handle.fetchHistory(), workflowId);
    } finally {
      worker.shutdown();
      await workerRun;
    }
  }, 60_000);

  test("blocks on an unreadable item and resumes from a recovered authoritative snapshot", async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
    const fake = createActivities(policy("autonomous"));
    const createBlueprint = fake.activities.createBlueprint.bind(fake.activities);
    let attempts = 0;
    fake.activities.createBlueprint = async (input) => {
      attempts += 1;
      if (attempts > 1) return createBlueprint(input);
      return cancellableActivity("unreadable_recovery");
    };
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: "thor-unreadable-recovery",
      workflowsPath,
      activities: fake.activities,
      maxHeartbeatThrottleInterval: "10ms",
    });
    const workflowId = `github-project-item:${projectItemId}:unreadable-recovery`;
    const handle = await environment.client.workflow.start(ticketWorkflow, {
      workflowId,
      taskQueue: "thor-unreadable-recovery",
      args: [workflowInput()],
    });
    const workerRun = worker.run();
    try {
      await waitForActiveExecution(() => handle.query(ticketStateQuery));
      await handle.signal(projectChangedSignal, {
        kind: "unreadable",
        projectItemId,
        reason: "GitHub returned malformed content",
      });
      const blocked = await waitForStatusResult(() => handle.query(ticketStateQuery), "blocked");
      expect(blocked.projectItemAvailability).toBe("unreadable");
      await handle.signal(projectChangedSignal, {
        kind: "present",
        snapshot: await fake.activities.loadProjectItem(projectItemId),
        reason: "GitHub item became readable again",
      });
      const result = await handle.result();
      expect(result.run.status).toBe("done");
      expect(attempts).toBe(2);
      await Worker.runReplayHistory({ workflowsPath }, await handle.fetchHistory(), workflowId);
    } finally {
      worker.shutdown();
      await workerRun;
    }
  }, 60_000);

  test("terminates as orphaned when the active Project item is removed", async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
    const fake = createActivities(policy("autonomous"));
    fake.activities.createBlueprint = () => cancellableActivity("item_removal");
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: "thor-item-removal",
      workflowsPath,
      activities: fake.activities,
      maxHeartbeatThrottleInterval: "10ms",
    });
    const workflowId = `github-project-item:${projectItemId}:item-removal`;
    const handle = await environment.client.workflow.start(ticketWorkflow, {
      workflowId,
      taskQueue: "thor-item-removal",
      args: [workflowInput()],
    });
    const workerRun = worker.run();
    try {
      await waitForActiveExecution(() => handle.query(ticketStateQuery));
      await handle.signal(projectChangedSignal, {
        kind: "removed",
        projectItemId,
        reason: "human removed the item from the managed Project",
      });
      const result = await handle.result();
      expect(result.run.status).toBe("orphaned");
      expect(result.run.externalReason).toContain("removed");
      expect(result.auditTrail).toEqual([]);
      await Worker.runReplayHistory({ workflowsPath }, await handle.fetchHistory(), workflowId);
    } finally {
      worker.shutdown();
      await workerRun;
    }
  }, 60_000);

  test("does not reclassify a completed delivery when a late removal signal arrives", async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
    const fake = createActivities(policy("autonomous"));
    let notifySummaryStarted: (() => void) | undefined;
    let releaseSummary: (() => void) | undefined;
    const summaryStarted = new Promise<void>((resolve) => {
      notifySummaryStarted = resolve;
    });
    const summaryReleased = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });
    fake.activities.publishRunSummary = async () => {
      notifySummaryStarted?.();
      await summaryReleased;
    };
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: "thor-late-removal",
      workflowsPath,
      activities: fake.activities,
    });
    const workflowId = `github-project-item:${projectItemId}:late-removal`;
    const handle = await environment.client.workflow.start(ticketWorkflow, {
      workflowId,
      taskQueue: "thor-late-removal",
      args: [workflowInput()],
    });
    const workerRun = worker.run();
    try {
      await summaryStarted;
      await handle.signal(projectChangedSignal, {
        kind: "removed",
        projectItemId,
        reason: "Project automation removed the completed item",
      });
      releaseSummary?.();
      const result = await handle.result();
      expect(result.run.status).toBe("done");
      await Worker.runReplayHistory({ workflowsPath }, await handle.fetchHistory(), workflowId);
    } finally {
      releaseSummary?.();
      worker.shutdown();
      await workerRun;
    }
  }, 60_000);

  test("ignores a stale polling snapshot after loading newer Project state", async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
    const fake = createActivities(policy("autonomous"));
    fake.activities.createBlueprint = async (): Promise<never> => {
      const context = Context.current();
      const heartbeatTimer = setInterval(() => context.heartbeat({ phase: "stale_poll_test" }), 10);
      try {
        return await context.cancelled;
      } finally {
        clearInterval(heartbeatTimer);
      }
    };
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: "thor-stale-poll",
      workflowsPath,
      activities: fake.activities,
      maxHeartbeatThrottleInterval: "10ms",
    });
    const handle = await environment.client.workflow.start(ticketWorkflow, {
      workflowId: `github-project-item:${projectItemId}:stale-poll`,
      taskQueue: "thor-stale-poll",
      args: [workflowInput()],
    });
    const workerRun = worker.run();
    try {
      await waitForActiveExecution(() => handle.query(ticketStateQuery));
      const snapshot = await fake.activities.loadProjectItem(projectItemId);
      await handle.signal(projectChangedSignal, {
        kind: "present",
        snapshot: { ...snapshot, status: "done" },
        reason: "delayed polling result",
      });
      const state = await handle.query(ticketStateQuery);
      expect(state.run?.status).toBe("design_blueprint");
      expect(state.activeExecutionIds).toHaveLength(1);
      await handle.signal(cancelTicketSignal, { actor: "test", reason: "test cleanup" });
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

  test("restarts an agent phase with a durable Slack command after direct delivery times out", async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
    const fake = createActivities(policy("autonomous"));
    const surface = slackTaskSurfaceSchema.parse({
      mode: "thread_per_ticket",
      workspaceId: "TWORKSPACE",
      channelId: "CPROJECT",
      threadTs: "1700000000.000001",
      headerTs: "1700000000.000001",
      permalink: "https://fake.slack.com/root",
    });
    if (surface.mode !== "thread_per_ticket") throw new Error("expected thread surface");
    let attempts = 0;
    let recoveredCommandIds: string[] = [];
    const projectedSlackStatuses: string[] = [];
    fake.activities.ensureTicketSlackSurface = () => Promise.resolve(surface);
    fake.activities.updateTicketSlackSurface = (input) => {
      projectedSlackStatuses.push(input.status);
      return Promise.resolve();
    };
    fake.activities.createBlueprint = async (input) => {
      attempts += 1;
      if (attempts === 1) {
        const context = Context.current();
        const heartbeat = setInterval(() => context.heartbeat(), 10);
        try {
          return await context.cancelled;
        } finally {
          clearInterval(heartbeat);
        }
      }
      recoveredCommandIds =
        input.recoveryCommands?.map((command) => command.reference.commandId) ?? [];
      return audited(input, "blueprint", {
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
      });
    };
    const delivery = {
      ...defaultDelivery,
      collaboration: {
        slack: {
          enabled: true as const,
          workspaceId: "TWORKSPACE",
          messaging: {
            mode: "thread_per_ticket" as const,
            projectChannelId: "CPROJECT",
          },
          eventReconciliationIntervalSeconds: 30,
          streamFlushIntervalMilliseconds: 1_000,
          controlDeliveryTimeoutSeconds: 5,
          steering: {
            allowedUserGroupIds: ["SENGINEERS"],
            defaultMode: "redirect" as const,
          },
        },
      },
    };
    const taskQueue = "thor-slack-fallback";
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath,
      activities: fake.activities,
      maxHeartbeatThrottleInterval: "10ms",
    });
    const handle = await environment.client.workflow.start(ticketWorkflow, {
      workflowId: `github-project-item:${projectItemId}:slack-fallback`,
      taskQueue,
      args: [workflowInput(delivery)],
    });
    const workerRun = worker.run();
    try {
      await waitForActiveExecution(() => handle.query(ticketStateQuery));
      const reference = slackCommandReferenceSchema.parse({
        commandId: "command-fallback",
        eventId: "Ev-fallback",
        workspaceId: "TWORKSPACE",
        channelId: "CPROJECT",
        threadTs: surface.threadTs,
        messageTs: "1700000000.100001",
        actorId: "UACTOR",
        mode: "redirect",
        contentDigest: slackCommandDigest("inspect helper"),
      });
      await handle.signal(
        acceptedSlackCommandSignal,
        acceptedSlackCommandSchema.parse({
          reference,
          receiptTs: "1700000000.100002",
        }),
      );
      const result = await handle.result();

      expect(result.run.status).toBe("done");
      expect(attempts).toBe(2);
      expect(recoveredCommandIds).toEqual(["command-fallback"]);
      expect(projectedSlackStatuses).toContain("in_progress");
      expect(projectedSlackStatuses.at(-1)).toBe("done");
    } finally {
      worker.shutdown();
      await workerRun;
    }
  }, 60_000);

  test("keeps an agent phase running when direct Slack delivery is acknowledged", async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
    const fake = createActivities(policy("autonomous"));
    const surface = slackTaskSurfaceSchema.parse({
      mode: "channel_per_ticket",
      workspaceId: "TWORKSPACE",
      channelId: "CTICKET",
      headerTs: "1700000000.000001",
      permalink: "https://fake.slack.com/ticket",
    });
    let attempts = 0;
    let releaseFirst = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const originalBlueprint = fake.activities.createBlueprint.bind(fake.activities);
    fake.activities.ensureTicketSlackSurface = () => Promise.resolve(surface);
    fake.activities.createBlueprint = async (input) => {
      attempts += 1;
      await released;
      return originalBlueprint(input);
    };
    const delivery = slackEnabledDelivery();
    const taskQueue = "thor-slack-direct-ack";
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath,
      activities: fake.activities,
    });
    const handle = await environment.client.workflow.start(ticketWorkflow, {
      workflowId: `github-project-item:${projectItemId}:slack-direct-ack`,
      taskQueue,
      args: [workflowInput(delivery)],
    });
    const workerRun = worker.run();
    try {
      await waitForActiveExecution(() => handle.query(ticketStateQuery));
      const accepted = acceptedSlackCommandSchema.parse({
        reference: {
          commandId: "command-direct",
          eventId: "Ev-direct",
          workspaceId: "TWORKSPACE",
          channelId: "CTICKET",
          messageTs: "1700000000.200001",
          actorId: "UACTOR",
          mode: "queue",
          contentDigest: slackCommandDigest("run tests"),
        },
        receiptTs: "1700000000.200002",
      });
      await handle.signal(acceptedSlackCommandSignal, accepted);
      const [executionId] = (await handle.query(ticketStateQuery)).activeExecutionIds;
      if (executionId === undefined) throw new Error("missing active execution");
      await handle.signal(appliedSlackCommandSignal, {
        commandId: accepted.reference.commandId,
        executionId,
      });
      releaseFirst();
      const result = await handle.result();

      expect(result.run.status).toBe("done");
      expect(attempts).toBe(1);
    } finally {
      worker.shutdown();
      await workerRun;
    }
  }, 60_000);
});

function createActivities(
  ticketPolicy: TicketPolicy,
  initialStatus: BoardStateKey = "design_blueprint",
): {
  activities: TicketActivities;
  statuses: string[];
  events: string[];
  reviewers: string[];
  summaryPublished: boolean;
  blueprintExecutions: number;
  blueprintPublished: boolean;
  humanChange(input: {
    status?: BoardStateKey;
    ticket?: (ticket: TicketContext) => TicketContext;
  }): Awaited<ReturnType<TicketActivities["loadProjectItem"]>>;
} {
  let status: BoardStateKey = initialStatus;
  let version = 1;
  const statuses: string[] = [status];
  const events: string[] = [];
  const reviewers: string[] = [];
  const holder = { summaryPublished: false, blueprintExecutions: 0, blueprintPublished: false };
  let ticket: TicketContext = {
    projectItemId,
    issueId: issueIdSchema.parse("I_test_42"),
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
    ensureTicketSlackSurface: () => Promise.reject(new Error("Slack is disabled in this test")),
    registerTicketSlackSurface: () => Promise.resolve(),
    publishTicketSlackLink: () => Promise.resolve(),
    updateTicketSlackSurface: () => Promise.resolve(),
    closeTicketSlackSurface: () => Promise.resolve(),
    loadProjectItem: () => Promise.resolve(snapshot()),
    transitionProjectStatus: (transition) => {
      status = transition.targetStatus;
      version += 1;
      statuses.push(status);
      events.push(`status:${status}`);
      return Promise.resolve({ kind: "updated", snapshot: snapshot() });
    },
    createBlueprint: (input) => {
      holder.blueprintExecutions += 1;
      return Promise.resolve(
        audited(input, "blueprint", {
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
        audited(input, "implementation", {
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
        audited(input, "review", {
          reviewRunId: input.reviewRunId,
          reviewer: input.reviewer,
          findings: [],
          passed: true,
        }),
      );
    },
    synthesize: (input) =>
      Promise.resolve(
        audited(input, "synthesis", {
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
    merge: () => {
      events.push("merge");
      return Promise.resolve("merge-sha");
    },
    closeSourceIssue: () => {
      events.push("close-issue");
      return Promise.resolve();
    },
    publishRunSummary: () => {
      events.push("summary");
      holder.summaryPublished = true;
      return Promise.resolve();
    },
  };
  return {
    activities,
    statuses,
    events,
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
    humanChange(input) {
      if (input.status !== undefined) status = input.status;
      if (input.ticket !== undefined) ticket = input.ticket(structuredClone(ticket));
      version += 1;
      return snapshot();
    },
  };
}

function audited<Value>(
  input: AgentActivityContext & { executionId: ExecutionId },
  purpose: string,
  value: Value,
): Audited<Value> {
  const audit: ExecutionAuditRecord = {
    executionId: input.executionId,
    declarationDigest: input.declarationDigest,
    workflowProfile: input.workflowProfile,
    agentProfile: input.agent.id,
    agentProfileDigest: input.agent.digest,
    harness: input.agent.harness,
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

function workflowInput(delivery = defaultDelivery): TicketWorkflowInput {
  return { projectItemId, baseBranch: "main", delivery };
}

function slackEnabledDelivery(): typeof defaultDelivery {
  return {
    ...defaultDelivery,
    collaboration: {
      slack: {
        enabled: true,
        workspaceId: "TWORKSPACE",
        messaging: {
          mode: "channel_per_ticket",
          ticketChannels: {
            namePrefix: "thor-project",
            isPrivate: true,
            memberUserGroupIds: ["SENGINEERS"],
            archiveDelayDays: 7,
          },
        },
        eventReconciliationIntervalSeconds: 30,
        streamFlushIntervalMilliseconds: 1_000,
        controlDeliveryTimeoutSeconds: 5,
        steering: {
          allowedUserGroupIds: ["SENGINEERS"],
          defaultMode: "redirect",
        },
      },
    },
  };
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

async function waitForStatusResult(
  query: () => Promise<{
    run?: { status: string; suspendedStatus?: string };
    projectItemAvailability: "present" | "unreadable" | "removed";
    activeExecutionIds: string[];
  }>,
  expected: string,
): Promise<Awaited<ReturnType<typeof query>>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const state = await query();
    if (state.run?.status === expected) return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`workflow did not reach ${expected}`);
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

async function waitForNoActiveExecution(
  query: () => Promise<{ activeExecutionIds: string[] }>,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await query()).activeExecutionIds.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("workflow did not cancel the active agent execution");
}

async function waitForProjectStatus(
  query: () => Promise<{ latestProjectSnapshot?: { status: string } }>,
  expected: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await query()).latestProjectSnapshot?.status === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Workflow Project snapshot did not reach ${expected}`);
}

async function waitForProjectUpdatedAt(
  query: () => Promise<{ latestProjectSnapshot?: { updatedAt: string } }>,
  expected: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await query()).latestProjectSnapshot?.updatedAt === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Workflow Project snapshot did not reach updatedAt ${expected}`);
}

async function cancellableActivity(phase: string): Promise<never> {
  const context = Context.current();
  const heartbeatTimer = setInterval(() => context.heartbeat({ phase }), 10);
  try {
    return await context.cancelled;
  } finally {
    clearInterval(heartbeatTimer);
  }
}
