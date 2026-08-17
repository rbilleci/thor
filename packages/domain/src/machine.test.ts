import { describe, expect, it } from "vitest";

import { deferredIssueIdSchema, findingIdSchema, projectItemIdSchema } from "./ids.js";
import {
  applyHumanStatus,
  approveDeferrals,
  completeMerge,
  createTicketRun,
  decideBlueprint,
  decideMerge,
  finishDeferralMaterialization,
  mergeGateInput,
  nextAction,
  recordBlueprint,
  recordImplementation,
  recordMaterializedDeferral,
  recordRepair,
  recordSynthesis,
  startImplementation,
  startMerge,
  startReview,
} from "./machine.js";
import type {
  ApprovalPolicy,
  Blueprint,
  ImplementationResult,
  NormalizedFinding,
  ReviewSynthesis,
  TicketContext,
} from "./model.js";

function ticket(approvalPolicy: ApprovalPolicy = "autonomous"): TicketContext {
  return {
    projectItemId: projectItemIdSchema.parse("PVTI_test"),
    repository: { owner: "example", name: "repo" },
    issueNumber: 42,
    title: "Build feature",
    body: "Body",
    workType: "feature",
    priority: "P1",
    component: "api",
    acceptanceCriteria: ["works"],
    dependencies: [{ issueId: "I_done", complete: true }],
    policy: {
      executionMode: "agent",
      planningDepth: "full",
      approvalPolicy,
      agentPolicy: "preferred",
      autonomousRepairBudget: 3,
    },
  };
}

const blueprint: Blueprint = {
  objective: "objective",
  constraints: [],
  architecture: "architecture",
  proposedDesign: "design",
  affectedAreas: ["src"],
  implementationPlan: ["implement"],
  testingPlan: ["test"],
  rolloutPlan: [],
  risks: [],
  unresolvedBlockingQuestions: [],
  acceptanceCriteria: ["works"],
};

const implementation: ImplementationResult = {
  branch: "thor/42",
  commitSha: "abc",
  pullRequestNumber: 7,
  changedFiles: ["src/lib.ts"],
  testsPassed: true,
  riskFlags: [],
};

function finding(id: string, disposition: NormalizedFinding["disposition"]): NormalizedFinding {
  const findingId = findingIdSchema.parse(id);
  return {
    findingId,
    sourceFindingIds: [findingId],
    reviewers: ["correctness"],
    severity: "high",
    category: "correctness",
    summary: "summary",
    evidence: ["evidence"],
    affectedFiles: ["src/lib.ts"],
    recommendedFix: "fix",
    disposition,
    confidence: 0.9,
  };
}

function synthesize(
  runId: ReviewSynthesis["reviewRunId"],
  findings: NormalizedFinding[],
): ReviewSynthesis {
  return { reviewRunId: runId, findings, failureScope: "repair", fullReReview: false };
}

describe("TicketRun", () => {
  it("reaches Done through the autonomous happy path", () => {
    const run = createTicketRun(ticket());
    recordBlueprint(run, blueprint);
    startImplementation(run);
    recordImplementation(run, implementation);
    recordSynthesis(run, synthesize(startReview(run), []));
    approveDeferrals(run);
    finishDeferralMaterialization(run);
    const gate = mergeGateInput(run, true);
    expect(gate).toMatchObject({ reviewersPassed: true, deferralsMaterialized: true });
    startMerge(run, gate);
    completeMerge(run);
    expect(run.status).toBe("done");
  });

  it("waits durably at configured human gates", () => {
    const run = createTicketRun(ticket("blueprint_and_pre_merge_review"));
    recordBlueprint(run, blueprint);
    expect(nextAction(run)).toEqual({ kind: "wait_blueprint_approval" });
    decideBlueprint(run, "approved");
    startImplementation(run);
    recordImplementation(run, implementation);
    recordSynthesis(run, synthesize(startReview(run), []));
    expect(nextAction(run)).toEqual({ kind: "wait_merge_approval" });
    decideMerge(run, "approved");
    expect(run.status).toBe("materializing_deferrals");
  });

  it("preserves human change-request feedback until the next corrective result", () => {
    const run = createTicketRun(ticket("blueprint_and_pre_merge_review"));
    recordBlueprint(run, blueprint);
    decideBlueprint(run, "changes_requested", "Use the existing service boundary");
    expect(run).toMatchObject({
      status: "design_blueprint",
      externalReason: "Use the existing service boundary",
    });
    recordBlueprint(run, { ...blueprint, proposedDesign: "Use the existing service boundary" });
    expect(run.externalReason).toBeUndefined();
    decideBlueprint(run, "approved");
    startImplementation(run);
    recordImplementation(run, implementation);
    recordSynthesis(run, synthesize(startReview(run), []));
    decideMerge(run, "changes_requested", "Add release notes");
    expect(run).toMatchObject({ status: "repairing", externalReason: "Add release notes" });
    recordRepair(run, {
      commitSha: "release-notes",
      repairedFindings: [],
      changedFiles: ["CHANGELOG.md"],
      testsPassed: true,
    });
    expect(run.externalReason).toBeUndefined();
  });

  it("does not let human approval override a failed test gate", () => {
    const run = createTicketRun(ticket("pre_merge_review"));
    recordBlueprint(run, blueprint);
    startImplementation(run);
    recordImplementation(run, { ...implementation, testsPassed: false });
    recordSynthesis(run, synthesize(startReview(run), []));
    decideMerge(run, "approved");
    expect(run).toMatchObject({
      status: "awaiting_human_merge_review",
      mergeApproval: "pending",
    });
  });

  it("requires a durable issue for every accepted deferral", () => {
    const run = createTicketRun(ticket());
    recordBlueprint(run, blueprint);
    startImplementation(run);
    recordImplementation(run, implementation);
    recordSynthesis(
      run,
      synthesize(startReview(run), [{ ...finding("F1", "defer_candidate"), severity: "low" }]),
    );
    approveDeferrals(run);
    expect(mergeGateInput(run, true).deferralsMaterialized).toBe(false);
    recordMaterializedDeferral(
      run,
      findingIdSchema.parse("F1"),
      deferredIssueIdSchema.parse("I_99"),
    );
    expect(run.status).toBe("ready_to_merge");
  });

  it("keeps ordinary repair inside the review lifecycle", () => {
    const run = createTicketRun(ticket());
    recordBlueprint(run, blueprint);
    startImplementation(run);
    recordImplementation(run, implementation);
    recordSynthesis(run, synthesize(startReview(run), [finding("F1", "blocking")]));
    expect(run.status).toBe("repairing");
    recordRepair(run, {
      commitSha: "def",
      repairedFindings: [findingIdSchema.parse("F1")],
      changedFiles: ["src/lib.ts"],
      testsPassed: true,
    });
    expect(nextAction(run)).toEqual({
      kind: "review",
      reviewers: ["correctness", "testing"],
    });
  });

  it("honors a synthesis request for full re-review", () => {
    const run = createTicketRun(ticket());
    recordBlueprint(run, blueprint);
    startImplementation(run);
    recordImplementation(run, implementation);
    recordSynthesis(run, {
      ...synthesize(startReview(run), [finding("F-full", "blocking")]),
      fullReReview: true,
    });
    recordRepair(run, {
      commitSha: "full-review-repair",
      repairedFindings: [findingIdSchema.parse("F-full")],
      changedFiles: ["src/lib.ts"],
      testsPassed: true,
    });
    const action = nextAction(run);
    expect(action.kind).toBe("review");
    if (action.kind !== "review") throw new Error("expected re-review action");
    expect(action.reviewers).toContain("security");
    expect(action.reviewers).toContain("architecture");
    expect(action.reviewers).toContain("performance");
  });

  it("treats Blocked and Cancelled as authoritative human states", () => {
    const run = createTicketRun(ticket());
    applyHumanStatus(run, "blocked", "dependency");
    expect(nextAction(run)).toEqual({ kind: "wait" });
    applyHumanStatus(run, "ready");
    expect(nextAction(run)).toEqual({ kind: "blueprint" });
    applyHumanStatus(run, "cancelled", "obsolete");
    expect(nextAction(run)).toEqual({ kind: "complete" });
  });
});
