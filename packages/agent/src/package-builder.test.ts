import path from "node:path";

import type { AgentProfileSnapshot, SkillSelector } from "@thor/config/schema";
import {
  executionIdSchema,
  issueIdSchema,
  projectItemIdSchema,
  type TicketContext,
} from "@thor/domain";
import { describe, expect, it } from "vitest";

import {
  ExecutionPackageBuilder,
  PackageBuildError,
  redactKnownSecrets,
} from "./package-builder.js";
import { assembledUserPrompt } from "./prompt.js";
import { FakeHarness, HarnessRouter } from "./router.js";
import { discardAgentEvents, noAgentControls } from "./types.js";

const resources = path.resolve(import.meta.dirname, "../../../resources");
const skillSelectors: SkillSelector[] = [
  {
    skill: "security",
    reason: "security context",
    match: { keywords: ["auth", "secure", "security", "secret", "permission"] },
  },
  {
    skill: "data-migration",
    reason: "data context",
    match: { keywords: ["database", "schema", "migration", "data"] },
  },
  {
    skill: "api-compatibility",
    reason: "API context",
    match: { keywords: ["api", "compatibility", "endpoint", "protocol"] },
  },
  {
    skill: "regression-testing",
    reason: "regression context",
    match: { workTypes: ["bug"], keywords: ["test", "regression", "flaky"] },
  },
];

function agent(
  id: string,
  harness: AgentProfileSnapshot["harness"],
  configuration: Record<string, string> = {},
): AgentProfileSnapshot {
  return { id, harness, resourceProfile: "default", configuration, digest: "a".repeat(64) };
}

function ticket(): TicketContext {
  return {
    projectItemId: projectItemIdSchema.parse("PVTI_agent"),
    issueId: issueIdSchema.parse("I_agent"),
    repository: { owner: "example", name: "repo" },
    issueNumber: 7,
    title: "Fix secure API migration regression",
    body: "Protect the token and add tests",
    workType: "bug",
    priority: "P1",
    component: "data",
    acceptanceCriteria: ["migration is backward compatible"],
    dependencies: [],
    policy: {
      executionMode: "agent",
      planningDepth: "full",
      approvalPolicy: "autonomous",
      agentPolicy: "preferred",
      autonomousRepairBudget: 3,
    },
  };
}

describe("ExecutionPackageBuilder", () => {
  it("builds deterministic, provider-specific, ticket-routed packages", async () => {
    const builder = new ExecutionPackageBuilder(resources);
    const base = {
      executionId: executionIdSchema.parse("execution-1"),
      purpose: { kind: "implementation" as const },
      ticket: ticket(),
      payload: { blueprint: "approved" },
      skillSelectors,
    };
    const claude = await builder.build({ ...base, agent: agent("planner", "claude") });
    const codex = await builder.build({ ...base, agent: agent("builder", "codex") });
    expect(claude.agentsMd).not.toBe(codex.agentsMd);
    expect(claude.digest).not.toBe(codex.digest);
    expect(claude.promptDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(claude.agentsMdDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(claude.configurationDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(claude.skills.map((skill) => skill.name)).toEqual([
      "implementation",
      "security",
      "data-migration",
      "api-compatibility",
      "regression-testing",
    ]);
    expect(assembledUserPrompt(claude)).toContain(claude.agentsMd);
    expect(assembledUserPrompt(codex)).toContain(codex.agentsMd);
    expect((await builder.build({ ...base, agent: agent("planner", "claude") })).digest).toBe(
      claude.digest,
    );
  });

  it("rejects secret-bearing configuration keys", async () => {
    const builder = new ExecutionPackageBuilder(resources);
    await expect(
      builder.build({
        executionId: executionIdSchema.parse("execution-2"),
        agent: agent("unsafe", "codex", { apiKey: "do-not-store" }),
        purpose: { kind: "blueprint" },
        ticket: ticket(),
        payload: {},
        skillSelectors,
      }),
    ).rejects.toMatchObject({ code: "secret_configuration" } satisfies Partial<PackageBuildError>);
  });

  it("selects custom skills from blueprint and risk context", async () => {
    const builder = new ExecutionPackageBuilder(resources);
    const contextTicket: TicketContext = {
      ...ticket(),
      title: "Update component",
      body: "Implement the approved change",
      workType: "feature",
      component: "core",
      acceptanceCriteria: ["behavior remains correct"],
    };
    const executionPackage = await builder.build({
      executionId: executionIdSchema.parse("execution-context-skills"),
      agent: agent("builder", "codex"),
      purpose: { kind: "implementation" },
      ticket: contextTicket,
      payload: {
        blueprint: { affectedAreas: ["database schema"] },
        riskFlags: ["security_sensitive"],
      },
      skillSelectors,
    });

    expect(executionPackage.skills.map((skill) => skill.name)).toEqual([
      "implementation",
      "security",
      "data-migration",
    ]);
  });

  it("redacts common credential shapes", () => {
    const redacted = redactKnownSecrets(
      "api_key=abcdefghijklmnop ghp_abcdefghijklmnopqrstuvwxyz sk-abcdefghijklmnop",
    );
    expect(redacted).not.toContain("abcdefghijklmnop");
    expect(redacted).not.toContain("ghp_");
  });
});

describe("HarnessRouter", () => {
  it("routes provider-neutral requests and preserves package correlation", async () => {
    const builder = new ExecutionPackageBuilder(resources);
    const executionPackage = await builder.build({
      executionId: executionIdSchema.parse("execution-router"),
      agent: agent("builder", "codex"),
      purpose: { kind: "blueprint" },
      ticket: ticket(),
      payload: {},
      skillSelectors,
    });
    const fake = new FakeHarness("codex", {
      finalResponse: "done",
      sessionId: "session-1",
      usage: {},
    });
    const router = new HarnessRouter();
    router.register(fake);
    const result = await router.execute(
      { package: executionPackage, workspace: "/tmp/repo" },
      discardAgentEvents,
      noAgentControls(),
      new AbortController().signal,
    );
    expect(result.packageDigest).toBe(executionPackage.digest);
    expect(fake.calls).toHaveLength(1);
  });

  it("rejects a provider result with mismatched execution correlation", async () => {
    const builder = new ExecutionPackageBuilder(resources);
    const executionPackage = await builder.build({
      executionId: executionIdSchema.parse("execution-correlation"),
      agent: agent("builder", "codex"),
      purpose: { kind: "blueprint" },
      ticket: ticket(),
      payload: {},
      skillSelectors,
    });
    const router = new HarnessRouter();
    router.register({
      kind: "codex",
      execute: (request) =>
        Promise.resolve({
          executionId: request.package.executionId,
          harness: "claude",
          finalResponse: "done",
          packageDigest: request.package.digest,
          usage: {},
        }),
    });

    await expect(
      router.execute(
        { package: executionPackage, workspace: "/tmp/repository" },
        discardAgentEvents,
        noAgentControls(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "invalid_response", retryable: false });
  });
});
