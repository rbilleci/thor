import { createHmac } from "node:crypto";

import { issueIdSchema, projectItemIdSchema, type TicketContext } from "@thor/domain";
import { describe, expect, it } from "vitest";

import { FakeGitHubGateway } from "./fake.js";
import { statusTransitionConflicts, transitionSnapshotMayBeStale } from "./octokit-gateway.js";
import type { ProjectItemSnapshot } from "./types.js";
import { parseProjectWebhook, verifyWebhookSignature } from "./webhook.js";

function snapshot(): ProjectItemSnapshot {
  const projectItemId = projectItemIdSchema.parse("PVTI_test");
  const ticket: TicketContext = {
    projectItemId,
    issueId: issueIdSchema.parse("I_test"),
    repository: { owner: "example", name: "repo" },
    issueNumber: 1,
    title: "Ticket",
    body: "Body",
    workType: "task",
    priority: "P2",
    acceptanceCriteria: ["done"],
    dependencies: [],
    policy: {
      executionMode: "agent",
      planningDepth: "full",
      approvalPolicy: "autonomous",
      agentPolicy: "preferred",
      autonomousRepairBudget: 3,
    },
  };
  return { projectItemId, projectId: "PVT_project", updatedAt: "1", status: "ready", ticket };
}

describe("FakeGitHubGateway", () => {
  it("makes retried external mutations idempotent", async () => {
    const gateway = new FakeGitHubGateway([snapshot()]);
    const repository = { owner: "example", name: "repo" };
    await gateway.ensureBranch(repository, "thor/1", "base");
    await gateway.ensureBranch(repository, "thor/1", "base");
    await gateway.ensurePullRequest({
      repository,
      branch: "thor/1",
      base: "main",
      title: "PR",
      body: "body",
    });
    await gateway.ensurePullRequest({
      repository,
      branch: "thor/1",
      base: "main",
      title: "PR",
      body: "body",
    });
    await gateway.upsertComment({
      repository,
      issueNumber: 1,
      idempotencyKey: "review",
      body: "one",
    });
    await gateway.upsertComment({
      repository,
      issueNumber: 1,
      idempotencyKey: "review",
      body: "two",
    });
    await gateway.closeIssue(repository, 1);
    await gateway.closeIssue(repository, 1);
    expect(gateway.mutationCounts).toMatchObject({
      branches: 1,
      pullRequests: 1,
      comments: 1,
      closedIssues: 1,
    });
  });

  it("refuses to overwrite a concurrent human status change", async () => {
    const item = snapshot();
    const gateway = new FakeGitHubGateway([item]);
    gateway.setHumanStatus(item.projectItemId, "blocked");
    await expect(
      gateway.transitionStatus({
        projectItemId: item.projectItemId,
        expectedStatus: "ready",
        expectedUpdatedAt: "1",
        targetStatus: "in_progress",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("does not treat an already-reached target as safe after a concurrent ticket edit", async () => {
    const expected = snapshot();
    const current = {
      ...expected,
      status: "in_progress" as const,
      ticket: { ...expected.ticket, body: "human edited after the first transition attempt" },
    };
    const gateway = new FakeGitHubGateway([current]);

    await expect(
      gateway.transitionStatus({
        projectItemId: current.projectItemId,
        expectedStatus: "ready",
        expectedUpdatedAt: expected.updatedAt,
        expectedTicket: expected.ticket,
        targetStatus: "in_progress",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("materializes each origin key only once", async () => {
    const gateway = new FakeGitHubGateway();
    const draft = {
      repository: { owner: "example", name: "repo" },
      title: "Deferred",
      body: "body",
      labels: ["deferred"],
      originKey: "review:F1",
      projectFields: [],
    };
    expect(await gateway.ensureDeferredIssue(draft)).toEqual(
      await gateway.ensureDeferredIssue(draft),
    );
    expect(gateway.mutationCounts.deferredIssues).toBe(1);
  });
});

describe("GitHub conditional status transitions", () => {
  it("allows unrelated Project metadata changes but rejects status or ticket changes", () => {
    const current = {
      ...snapshot(),
      status: "design_blueprint" as const,
      updatedAt: "2026-08-17T09:00:00Z",
    };
    const { projectItemId } = current;
    const expectedTicket = current.ticket;
    expect(
      statusTransitionConflicts(
        { ...current, updatedAt: "2026-08-17T09:00:01Z" },
        {
          projectItemId,
          expectedStatus: "design_blueprint",
          expectedUpdatedAt: "2026-08-17T09:00:00Z",
          expectedTicket,
          targetStatus: "ready",
        },
      ),
    ).toBe(false);
    expect(
      statusTransitionConflicts(
        {
          ...current,
          updatedAt: "2026-08-17T09:00:01Z",
          ticket: { ...current.ticket, title: "Human changed the ticket" },
        },
        {
          projectItemId,
          expectedStatus: "design_blueprint",
          expectedUpdatedAt: "2026-08-17T09:00:00Z",
          expectedTicket,
          targetStatus: "ready",
        },
      ),
    ).toBe(true);
    expect(
      statusTransitionConflicts(
        { ...current, status: "blocked" },
        {
          projectItemId,
          expectedStatus: "design_blueprint",
          expectedTicket,
          targetStatus: "ready",
        },
      ),
    ).toBe(true);
  });

  it("retries an older or same-timestamp status snapshot only when ticket intent is unchanged", () => {
    const current = {
      ...snapshot(),
      status: "re_review" as const,
      updatedAt: "2026-08-17T09:00:00Z",
    };
    const transition = {
      projectItemId: current.projectItemId,
      expectedStatus: "in_review" as const,
      expectedUpdatedAt: "2026-08-17T09:00:00Z",
      expectedTicket: current.ticket,
      targetStatus: "automated_review_passed" as const,
    };
    expect(transitionSnapshotMayBeStale(current, transition)).toBe(true);
    expect(
      transitionSnapshotMayBeStale(
        { ...current, ticket: { ...current.ticket, title: "Human edit" } },
        transition,
      ),
    ).toBe(false);
    expect(
      transitionSnapshotMayBeStale({ ...current, updatedAt: "2026-08-17T09:00:01Z" }, transition),
    ).toBe(false);
  });

  it("treats GitHub dependency connection ordering as non-material", () => {
    const current = {
      ...snapshot(),
      status: "design_blueprint" as const,
      ticket: {
        ...snapshot().ticket,
        dependencies: [
          { issueId: "I_second", complete: false },
          { issueId: "I_first", complete: true },
        ],
      },
    };
    const expectedTicket = {
      ...current.ticket,
      dependencies: [...current.ticket.dependencies].reverse(),
    };
    expect(
      statusTransitionConflicts(current, {
        projectItemId: current.projectItemId,
        expectedStatus: "design_blueprint",
        expectedUpdatedAt: current.updatedAt,
        expectedTicket,
        targetStatus: "ready",
      }),
    ).toBe(false);
  });

  it("rejects a dependency regression even when the Project item timestamp is unchanged", () => {
    const current = {
      ...snapshot(),
      status: "ready" as const,
      updatedAt: "2026-08-17T09:00:00Z",
    };
    const expectedTicket = {
      ...current.ticket,
      dependencies: [{ issueId: "I_blocker", complete: true }],
    };
    expect(
      statusTransitionConflicts(
        {
          ...current,
          ticket: {
            ...current.ticket,
            dependencies: [{ issueId: "I_blocker", complete: false }],
          },
        },
        {
          projectItemId: current.projectItemId,
          expectedStatus: "ready",
          expectedUpdatedAt: current.updatedAt,
          expectedTicket,
          targetStatus: "in_progress",
        },
      ),
    ).toBe(true);
  });
});

describe("GitHub webhook verification", () => {
  it("verifies the raw body before parsing the Project item", () => {
    const secret = "webhook-secret";
    const body = Buffer.from(
      JSON.stringify({ action: "edited", projects_v2_item: { node_id: "PVTI_test" } }),
    );
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    expect(verifyWebhookSignature(secret, body, signature)).toBe(true);
    expect(parseProjectWebhook(body, "delivery-1")).toMatchObject({
      deliveryId: "delivery-1",
      projectItemId: "PVTI_test",
    });
    expect(verifyWebhookSignature(secret, Buffer.from("tampered"), signature)).toBe(false);
  });
});
