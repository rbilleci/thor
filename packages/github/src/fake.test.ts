import { createHmac } from "node:crypto";

import { projectItemIdSchema, type TicketContext } from "@thor/domain";
import { describe, expect, it } from "vitest";

import { FakeGitHubGateway } from "./fake.js";
import type { ProjectItemSnapshot } from "./types.js";
import { parseProjectWebhook, verifyWebhookSignature } from "./webhook.js";

function snapshot(): ProjectItemSnapshot {
  const projectItemId = projectItemIdSchema.parse("PVTI_test");
  const ticket: TicketContext = {
    projectItemId,
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
    expect(gateway.mutationCounts).toMatchObject({ branches: 1, pullRequests: 1, comments: 1 });
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
