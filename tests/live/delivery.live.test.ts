import type { TicketWorkflowResult } from "@thor/workflows";
import { describe, expect, test } from "vitest";

import { LiveDeliveryRun, runLiveScenario } from "./support/live-run.js";

const liveEnabled = process.env.THOR_LIVE_TESTS === "1";

describe.skipIf(!liveEnabled)("live GitHub and Temporal delivery", () => {
  test("the polling synchronizer completes an autonomous delivery", async () => {
    await runLiveScenario(
      {
        scenario: "happy_path",
        description: "Complete an autonomous delivery",
      },
      async (run) => {
        const result = await run.result();

        expect(result.run.status).toBe("done");
        expect(result.run.reviewPass).toBe(1);
        expect(result.run.repairPass).toBe(0);
        expect(result.run.deferrals).toEqual([]);
        expect(result.auditTrail).toHaveLength(13);
        await assertMergedDelivery(run, result, [run.deliveryFile]);
      },
    );
  }, 600_000);

  test("real Project field changes approve both human gates", async () => {
    await runLiveScenario(
      {
        scenario: "happy_path",
        description: "Approve blueprint and merge gates",
        approvalPolicy: "blueprint_and_pre_merge_review",
      },
      async (run) => {
        const blueprintGate = await run.waitForWorkflowStatus("awaiting_blueprint_approval");
        expect(blueprintGate.run?.blueprintApproval).toBe("pending");
        await run.waitForProjectStatus("awaiting_blueprint_approval");
        await run.setProjectStatus("ready");

        await run.waitForProjectStatus("awaiting_human_merge_review");
        const mergeGate = await run.state();
        expect(mergeGate.run?.status).toBe("automated_review_passed");
        expect(mergeGate.run?.blueprintApproval).toBe("approved");
        expect(mergeGate.run?.mergeApproval).toBe("pending");
        await run.setProjectStatus("ready_to_merge");

        const result = await run.result();
        expect(result.run.status).toBe("done");
        expect(result.run.blueprintApproval).toBe("approved");
        expect(result.run.mergeApproval).toBe("approved");
        await assertMergedDelivery(run, result, [run.deliveryFile]);
      },
    );
  }, 600_000);

  test("review findings are repaired, re-reviewed, and materialized as deferred work", async () => {
    await runLiveScenario(
      {
        scenario: "repair_and_deferral",
        description: "Repair findings and materialize a deferral",
      },
      async (run) => {
        const result = await run.result();

        expect(result.run.status).toBe("done");
        expect(result.run.reviewPass).toBe(2);
        expect(result.run.repairPass).toBe(1);
        expect(result.run.blockingHistory).toEqual([1, 0]);
        expect(result.run.deferrals).toHaveLength(1);
        expect(result.run.deferrals[0]?.state).toBe("defer_materialized");
        const deferredIssueId = result.run.deferrals[0]?.issueId;
        if (deferredIssueId === undefined) {
          throw new Error("live deferral was not associated with a durable issue");
        }
        const relatedIssue = await run.fixtures.relatedIssue(deferredIssueId);
        run.addRelatedIssue(relatedIssue);
        expect(relatedIssue.issueNumber).toBeGreaterThan(0);

        await assertMergedDelivery(run, result, [run.deliveryFile, run.repairFile]);
      },
    );
  }, 600_000);

  test("a real Blocked then Cancelled change stops a long-running Activity", async () => {
    await runLiveScenario(
      {
        scenario: "cancel_during_implementation",
        description: "Cancel an active implementation",
      },
      async (run) => {
        await run.waitForWorkflowStatus("in_progress");
        const active = await run.waitForActiveExecution();
        expect(active.activeExecutionIds).toHaveLength(1);

        await run.setProjectStatus("blocked");
        const blocked = await run.waitForWorkflowStatus("blocked");
        expect(blocked.run?.suspendedStatus).toBe("in_progress");
        await run.waitForProjectStatus("blocked");
        const stopped = await run.waitForNoActiveExecutions();
        expect(stopped.activeExecutionIds).toEqual([]);

        await run.setProjectStatus("cancelled");
        const result = await run.result();
        expect(result.run.status).toBe("cancelled");
        expect(result.run.implementation).toBeUndefined();
        expect(result.mergeCommitSha).toBeUndefined();
        expect(result.auditTrail).toHaveLength(1);
        await run.waitForProjectStatus("cancelled");

        const comments = await run.fixtures.issueComments(run.fixture.issueNumber);
        expect(
          comments.filter((comment) =>
            (comment.body ?? "").includes("completed with status `cancelled`"),
          ),
        ).toHaveLength(1);
      },
    );
  }, 600_000);

  test("a real Blocked then resumed change restarts implementation and completes", async () => {
    await runLiveScenario(
      {
        scenario: "resume_after_block",
        description: "Resume a blocked active implementation",
      },
      async (run) => {
        await run.waitForWorkflowStatus("in_progress");
        await run.waitForActiveExecution();

        await run.setProjectStatus("blocked");
        const blocked = await run.waitForWorkflowStatus("blocked");
        expect(blocked.run?.suspendedStatus).toBe("in_progress");
        await run.waitForNoActiveExecutions();

        await run.setProjectStatus("in_progress");
        const result = await run.result();
        expect(result.run.status).toBe("done");
        expect(result.run.suspendedStatus).toBeUndefined();
        await assertMergedDelivery(run, result, [run.deliveryFile]);
      },
    );
  }, 600_000);

  test("removing an active Project item terminates its Workflow as orphaned", async () => {
    await runLiveScenario(
      {
        scenario: "cancel_during_implementation",
        description: "Remove an active Project item",
      },
      async (run) => {
        await run.waitForWorkflowStatus("in_progress");
        await run.waitForActiveExecution();

        await run.removeProjectItem();
        const result = await run.result();
        expect(result.run.status).toBe("orphaned");
        expect(result.run.externalReason).toContain("disappeared");
        expect(result.run.implementation).toBeUndefined();
        expect(result.mergeCommitSha).toBeUndefined();
        expect(result.auditTrail).toHaveLength(1);

        const comments = await run.fixtures.issueComments(run.fixture.issueNumber);
        expect(
          comments.filter((comment) =>
            (comment.body ?? "").includes("completed with status `orphaned`"),
          ),
        ).toHaveLength(1);
      },
    );
  }, 600_000);

  test("a replacement worker recovers the remote worktree and continues delivery", async () => {
    await runLiveScenario(
      {
        scenario: "restart_recovery",
        description: "Recover delivery on a replacement worker",
        approvalPolicy: "pre_merge_review",
      },
      async (run) => {
        await run.waitForProjectStatus("awaiting_human_merge_review");
        const firstGate = await run.state();
        expect(firstGate.run?.status).toBe("automated_review_passed");
        expect(firstGate.run?.implementation?.branch).toBe(run.branch);
        expect(firstGate.run?.repairPass).toBe(0);

        await run.restartWorker();
        await run.setProjectStatus("repairing");
        const recoveredGate = await run.waitForState(
          "a repaired delivery at the second merge gate",
          (state) =>
            state.run?.status === "automated_review_passed" &&
            state.run.repairPass === 1 &&
            state.latestProjectSnapshot?.status === "awaiting_human_merge_review",
        );
        expect(recoveredGate.run?.reviewPass).toBe(2);
        expect(recoveredGate.run?.implementation?.changedFiles).toContain(run.repairFile);
        await run.waitForProjectStatus("awaiting_human_merge_review");
        await run.setProjectStatus("ready_to_merge");

        const result = await run.result();
        expect(result.run.status).toBe("done");
        expect(result.run.repairPass).toBe(1);
        expect(result.run.reviewPass).toBe(2);
        expect(result.run.mergeApproval).toBe("approved");
        await assertMergedDelivery(run, result, [run.deliveryFile, run.repairFile]);
      },
    );
  }, 600_000);
});

async function assertMergedDelivery(
  run: LiveDeliveryRun,
  result: TicketWorkflowResult,
  expectedFiles: string[],
): Promise<void> {
  expect(result.run.ticket.projectItemId).toBe(run.fixture.projectItemId);
  expect(result.run.implementation?.testsPassed).toBe(true);
  expect(result.run.reviewersPassed).toBe(true);
  expect(new Set(result.auditTrail.map((record) => record.harness))).toEqual(
    new Set(["claude", "codex"]),
  );
  expect(
    result.auditTrail.every(
      (record) =>
        /^[a-f0-9]{64}$/.test(record.packageDigest) &&
        /^[a-f0-9]{64}$/.test(record.promptDigest) &&
        /^[a-f0-9]{64}$/.test(record.agentsMdDigest) &&
        /^[a-f0-9]{64}$/.test(record.configurationDigest),
    ),
  ).toBe(true);

  const implementation = result.run.implementation;
  if (implementation === undefined) throw new Error("live Workflow omitted implementation");
  if (result.mergeCommitSha === undefined) throw new Error("live Workflow omitted merge SHA");
  expect(implementation.branch).toBe(run.branch);
  for (const expectedFile of expectedFiles) {
    expect(implementation.changedFiles).toContain(expectedFile);
  }

  const pull = await run.fixtures.pullRequest(implementation.pullRequestNumber);
  expect(pull.merged).toBe(true);
  expect(pull.state).toBe("closed");
  expect(pull.head.ref).toBe(implementation.branch);
  expect(pull.head.sha).toBe(implementation.commitSha);
  if (pull.merge_commit_sha != null) {
    expect(pull.merge_commit_sha).toBe(result.mergeCommitSha);
  }
  run.recordDelivery({
    branch: implementation.branch,
    pullRequestNumber: implementation.pullRequestNumber,
    pullRequestUrl: pull.html_url,
    mergeCommitSha: result.mergeCommitSha,
  });

  const snapshot = await run.github.getProjectItem(run.fixture.projectItemId);
  expect(snapshot.status).toBe("done");
  const comments = await run.fixtures.issueComments(run.fixture.issueNumber);
  const commentBodies = comments.map((comment) => comment.body ?? "");
  expect(commentBodies.filter((body) => body.includes("## Thor blueprint"))).toHaveLength(1);
  expect(
    commentBodies.filter((body) => body.includes("completed with status `done`")),
  ).toHaveLength(1);

  for (const expectedFile of expectedFiles) {
    expect(await run.readOriginFile(expectedFile)).toBe(run.runId);
  }
}
