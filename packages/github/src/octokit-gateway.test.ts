import { createServer, type Server } from "node:http";
import path from "node:path";

import {
  compileProjectBinding,
  type CompiledProjectBinding,
  type DeliveryProjectDeclaration,
  type DiscoveredProject,
  type DiscoveredProjectField,
  type ProjectFieldsDeclaration,
  type ResolvedProjectFields,
} from "@thor/config";
import { loadDeliveryProjectDeclaration } from "@thor/config/node";
import { issueIdSchema, projectItemIdSchema } from "@thor/domain";
import { describe, expect, it } from "vitest";

import {
  loadProjectItemsIndependently,
  createOctokit,
  GITHUB_MAX_RETRY_DELAY_MS,
  githubRetryAfterMs,
  mapProjectItem,
  normalizeGitHubError,
  type GitHubProjectConfiguration,
} from "./octokit-gateway.js";
import { GitHubError } from "./types.js";

describe("compiled GitHub Project item mapping", () => {
  it.each([
    ["default-delivery.json", "design_blueprint", "feature", "P1", "full"],
    ["compact-delivery.json", "active", "bug", "P3", "light"],
  ])(
    "maps semantic values by field and option ID for %s",
    async (template, status, workType, priority, planningDepth) => {
      const declaration = await loadDeliveryProjectDeclaration(
        path.resolve("config/templates", template),
      );
      const binding = compileProjectBinding(declaration, discoveredFrom(declaration));
      const configuration = gatewayConfiguration(binding);
      const item = projectItem(binding, {
        status,
        workType,
        priority,
        planningDepth,
      });

      const snapshot = mapProjectItem(item, configuration);
      expect(snapshot.status).toBe(status);
      expect(snapshot.ticket).toMatchObject({
        workType,
        priority,
        policy: { planningDepth },
      });
      expect(snapshot.ticket.repository).toEqual({ owner: "example", name: "service" });
      expect(snapshot.ticket.issueId).toBe("issue-node-id");
    },
  );

  it("rejects a missing configured required policy field instead of applying a silent default", async () => {
    const declaration = await loadDeliveryProjectDeclaration(
      path.resolve("config/templates/default-delivery.json"),
    );
    const binding = compileProjectBinding(declaration, discoveredFrom(declaration));
    const item = projectItem(binding, {
      status: "ready",
      workType: "task",
      priority: "P2",
      planningDepth: "full",
    });
    const approvalFieldId = binding.fields.approvalPolicy?.fieldId;
    if (approvalFieldId === undefined) throw new Error("fixture omitted approval policy binding");
    item.fieldValues.nodes = item.fieldValues.nodes.filter(
      (value) => value?.field?.id !== approvalFieldId,
    );

    expect(() => mapProjectItem(item, gatewayConfiguration(binding))).toThrow(
      "GitHub Project item is missing required approval policy configuration",
    );
  });

  it("rejects option IDs absent from the immutable binding", async () => {
    const declaration = await loadDeliveryProjectDeclaration(
      path.resolve("config/templates/compact-delivery.json"),
    );
    const binding = compileProjectBinding(declaration, discoveredFrom(declaration));
    const item = projectItem(binding, {
      status: "active",
      workType: "bug",
      priority: "P3",
      planningDepth: "light",
    });
    const lifecycleId = binding.fields.lifecycle.fieldId;
    const lifecycle = item.fieldValues.nodes.find((value) => value?.field?.id === lifecycleId);
    if (lifecycle === undefined || lifecycle === null) {
      throw new Error("fixture omitted lifecycle value");
    }
    lifecycle.optionId = "option-created-after-workflow-start";

    expect(() => mapProjectItem(item, gatewayConfiguration(binding))).toThrow(
      "is not present in the compiled binding",
    );
  });

  it("classifies deleted underlying Issue content as removal", async () => {
    const declaration = await loadDeliveryProjectDeclaration(
      path.resolve("config/templates/default-delivery.json"),
    );
    const binding = compileProjectBinding(declaration, discoveredFrom(declaration));
    const item = projectItem(binding, {
      status: "ready",
      workType: "task",
      priority: "P2",
      planningDepth: "full",
    });
    item.content = null;

    expect(() => mapProjectItem(item, gatewayConfiguration(binding))).toThrow(
      "no longer has GitHub Issue content",
    );
  });

  it("applies configured issue and managed-Project dependency completion semantics", async () => {
    const declaration = await loadDeliveryProjectDeclaration(
      path.resolve("config/templates/default-delivery.json"),
    );
    const binding = compileProjectBinding(declaration, discoveredFrom(declaration));
    const item = projectItem(binding, {
      status: "ready",
      workType: "task",
      priority: "P2",
      planningDepth: "full",
    });
    if (item.content === null) throw new Error("fixture omitted Issue content");
    item.content.blockedBy.nodes = [dependencyNode("OPEN")];
    const dependencyDone = new Map([["I_dependency", true]]);

    expect(
      mapProjectItem(item, gatewayConfiguration(binding), dependencyDone).ticket.dependencies,
    ).toEqual([{ issueId: "I_dependency", complete: false }]);
    expect(
      mapProjectItem(
        item,
        {
          ...gatewayConfiguration(binding),
          dependencyCompletion: "issue_closed_or_project_done",
        },
        dependencyDone,
      ).ticket.dependencies,
    ).toEqual([{ issueId: "I_dependency", complete: true }]);
    expect(
      mapProjectItem(item, {
        ...gatewayConfiguration(binding),
        dependencyCompletion: "issue_closed",
      }).ticket.dependencies,
    ).toEqual([{ issueId: "I_dependency", complete: false }]);

    item.content.blockedBy.nodes = [dependencyNode("CLOSED")];
    expect(
      mapProjectItem(item, gatewayConfiguration(binding), new Map([["I_dependency", false]])).ticket
        .dependencies,
    ).toEqual([{ issueId: "I_dependency", complete: false }]);
    expect(mapProjectItem(item, gatewayConfiguration(binding)).ticket.dependencies).toEqual([
      { issueId: "I_dependency", complete: true },
    ]);
  });

  it("keeps valid Project items when another item is deleted or malformed", async () => {
    const presentId = projectItemIdSchema.parse("PVTI_present");
    const removedId = projectItemIdSchema.parse("PVTI_removed");
    const malformedId = projectItemIdSchema.parse("PVTI_malformed");
    const presentSnapshot = {
      projectItemId: presentId,
      projectId: "PVT_project",
      updatedAt: "1",
      status: "ready" as const,
      ticket: {
        projectItemId: presentId,
        issueId: issueIdSchema.parse("I_present"),
        repository: { owner: "example", name: "service" },
        issueNumber: 7,
        title: "valid",
        body: "body",
        workType: "task" as const,
        priority: "P2" as const,
        acceptanceCriteria: ["done"],
        dependencies: [],
        policy: {
          executionMode: "agent" as const,
          planningDepth: "full" as const,
          approvalPolicy: "autonomous" as const,
          agentPolicy: "preferred" as const,
          autonomousRepairBudget: 2,
        },
      },
    };

    const observations = await loadProjectItemsIndependently(
      [removedId, presentId, malformedId],
      (id) => {
        if (id === removedId) {
          return Promise.reject(new GitHubError("deleted", false, "not_found"));
        }
        if (id === malformedId) {
          return Promise.reject(new GitHubError("bad content", false, "invalid_response"));
        }
        return Promise.resolve(presentSnapshot);
      },
    );

    expect(observations).toEqual([
      { kind: "removed", projectItemId: removedId, reason: "deleted" },
      { kind: "present", projectItemId: presentId, snapshot: presentSnapshot },
      {
        kind: "unreadable",
        projectItemId: malformedId,
        reason: "bad content",
        retryable: false,
      },
    ]);
  });

  it("classifies free-account and primary GraphQL exhaustion as retryable rate limiting", () => {
    const normalized = normalizeGitHubError(
      Object.assign(new Error("API rate limit already exceeded for user ID 7469913"), {
        status: 403,
      }),
    );

    expect(normalized).toMatchObject({ code: "rate_limited", retryable: true });
  });

  it("honors GitHub retry headers while capping any single delay at five minutes", () => {
    const now = Date.parse("2026-08-17T12:00:00Z");
    const error = Object.assign(new Error("API rate limit exceeded"), {
      status: 403,
      response: {
        headers: {
          "retry-after": "3600",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": ((now + 60 * 60 * 1_000) / 1_000).toString(),
        },
      },
    });
    const normalized = normalizeGitHubError(error);

    expect(githubRetryAfterMs(error, now)).toBe(GITHUB_MAX_RETRY_DELAY_MS);
    expect(normalized).toMatchObject({
      code: "rate_limited",
      retryable: true,
      retryAfterMs: GITHUB_MAX_RETRY_DELAY_MS,
    });
  });

  it("does not mistake ordinary rate-budget headers on an authentication error for exhaustion", () => {
    const normalized = normalizeGitHubError(
      Object.assign(new Error("Bad credentials"), {
        status: 401,
        response: {
          headers: {
            "x-ratelimit-remaining": "4999",
            "x-ratelimit-reset": "1786968000",
          },
        },
      }),
    );

    expect(normalized).toMatchObject({ code: "authentication", retryable: false });
    expect(normalized.retryAfterMs).toBeUndefined();
  });

  it("bounds full-scan item reads to avoid secondary-limit bursts", async () => {
    const ids = Array.from({ length: 9 }, (_, index) =>
      projectItemIdSchema.parse(`PVTI_bounded_${index.toString()}`),
    );
    let active = 0;
    let maximumActive = 0;

    const observations = await loadProjectItemsIndependently(ids, async (projectItemId) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return snapshotFor(projectItemId);
    });

    expect(maximumActive).toBe(4);
    expect(observations.map((observation) => observation.projectItemId)).toEqual(ids);
  });
});

describe("resilient Octokit transport", () => {
  it("retries transient server failures with the official retry plugin", async () => {
    let attempts = 0;
    const server = createServer((_request, response) => {
      attempts += 1;
      response.setHeader("content-type", "application/json");
      if (attempts < 3) {
        response.statusCode = 503;
        response.end(JSON.stringify({ message: "Service Unavailable" }));
        return;
      }
      response.end(JSON.stringify({ recovered: true }));
    });
    const apiUrl = await listen(server);
    try {
      const octokit = createOctokit({
        auth: { kind: "token", token: "test-token" },
        apiUrl,
        resilience: {
          requestRetries: 2,
          retryAfterBaseValueMs: 1,
          throttleEnabled: false,
        },
      });

      const response = await octokit.request("GET /retry-test");

      expect(response.data).toEqual({ recovered: true });
      expect(attempts).toBe(3);
    } finally {
      await close(server);
    }
  });

  it("does not retry authentication failures", async () => {
    let attempts = 0;
    const server = createServer((_request, response) => {
      attempts += 1;
      response.statusCode = 401;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ message: "Bad credentials" }));
    });
    const apiUrl = await listen(server);
    try {
      const octokit = createOctokit({
        auth: { kind: "token", token: "test-token" },
        apiUrl,
        resilience: {
          requestRetries: 3,
          retryAfterBaseValueMs: 1,
          throttleEnabled: false,
        },
      });

      await expect(octokit.request("GET /authentication-test")).rejects.toMatchObject({
        status: 401,
      });
      expect(attempts).toBe(1);
    } finally {
      await close(server);
    }
  });
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server has no port");
  return `http://127.0.0.1:${address.port.toString()}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function gatewayConfiguration(binding: CompiledProjectBinding): GitHubProjectConfiguration {
  return {
    projectId: binding.project.id,
    fields: binding.fields,
    ticketDefaults: binding.ticketDefaults,
    dependencyCompletion: binding.delivery.workflow.dependencies.completion,
    doneOptionId:
      binding.fields.lifecycle.options[binding.delivery.workflow.board.states.done] ?? "",
  };
}

function snapshotFor(projectItemId: ReturnType<typeof projectItemIdSchema.parse>) {
  return {
    projectItemId,
    projectId: "PVT_project",
    updatedAt: "2026-08-17T12:00:00Z",
    status: "ready" as const,
    ticket: {
      projectItemId,
      issueId: issueIdSchema.parse(`I_${projectItemId}`),
      repository: { owner: "example", name: "service" },
      issueNumber: 7,
      title: "valid",
      body: "body",
      workType: "task" as const,
      priority: "P2" as const,
      acceptanceCriteria: ["done"],
      dependencies: [],
      policy: {
        executionMode: "agent" as const,
        planningDepth: "full" as const,
        approvalPolicy: "autonomous" as const,
        agentPolicy: "preferred" as const,
        autonomousRepairBudget: 2,
      },
    },
  };
}

function dependencyNode(
  state: string,
): NonNullable<
  NonNullable<Parameters<typeof mapProjectItem>[0]["content"]>["blockedBy"]["nodes"][number]
> {
  return { id: "I_dependency", state };
}

function projectItem(
  binding: CompiledProjectBinding,
  values: { status: string; workType: string; priority: string; planningDepth: string },
): Parameters<typeof mapProjectItem>[0] {
  const fieldValues: Parameters<typeof mapProjectItem>[0]["fieldValues"]["nodes"] = [];
  addSelect(fieldValues, binding.fields.lifecycle, values.status);
  addSelect(fieldValues, binding.fields.workType, values.workType);
  addSelect(fieldValues, binding.fields.priority, values.priority);
  addText(fieldValues, binding.fields.component, "payments");
  addSelect(fieldValues, binding.fields.executionMode, "agent");
  addSelect(fieldValues, binding.fields.planningDepth, values.planningDepth);
  addSelect(fieldValues, binding.fields.approvalPolicy, "autonomous");
  addSelect(fieldValues, binding.fields.agentPolicy, "preferred");
  return {
    id: projectItemIdSchema.parse("PVTI_compiled_mapper"),
    updatedAt: "2026-08-17T12:00:00Z",
    project: { id: binding.project.id },
    fieldValues: { nodes: fieldValues },
    content: {
      id: "issue-node-id",
      number: 42,
      title: "Deliver configured behavior",
      body: "- [ ] Works with the declared Project schema",
      repository: { name: "service", owner: { login: "example" } },
      blockedBy: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    },
  };
}

type FieldValue = NonNullable<Parameters<typeof mapProjectItem>[0]["fieldValues"]["nodes"][number]>;

function addSelect(
  values: (FieldValue | null)[],
  field: ResolvedProjectFields["lifecycle"] | undefined,
  semanticValue: string,
): void {
  if (field === undefined) return;
  const optionId = field.options[semanticValue];
  if (optionId === undefined) return;
  values.push({
    name: "display-name-is-not-authoritative",
    optionId,
    field: { id: field.fieldId, name: "physical-name-is-not-authoritative" },
  });
}

function addText(
  values: (FieldValue | null)[],
  field: ResolvedProjectFields["component"],
  text: string,
): void {
  if (field === undefined) return;
  values.push({
    text,
    field: { id: field.fieldId, name: "physical-name-is-not-authoritative" },
  });
}

function discoveredFrom(declaration: DeliveryProjectDeclaration): DiscoveredProject {
  return {
    id: `project-${declaration.metadata.name}`,
    owner: declaration.github.owner,
    number: declaration.github.projectNumber ?? 1,
    title: declaration.github.title,
    shortDescription: declaration.github.shortDescription ?? null,
    readme: null,
    public: declaration.github.visibility === "public",
    url: `https://github.example/projects/${(declaration.github.projectNumber ?? 1).toString()}`,
    repositories: declaration.github.repositories.map((repository) => ({
      id: `repository-${repository.owner}-${repository.name}`,
      owner: repository.owner,
      name: repository.name,
    })),
    views: Object.entries(declaration.github.views).map(([semanticView, view], index) => ({
      id: `view-${semanticView}`,
      number: index + 1,
      name: view.name,
      layout: view.layout,
      filter: view.filter ?? null,
      visibleFieldIds: view.visibleFields.map((fieldKey) => `field-${fieldKey}`),
    })),
    fields: Object.entries(declaration.github.fields).flatMap(([semanticName, field]) =>
      field === undefined ? [] : [discoveredField(semanticName, field)],
    ),
  };
}

function discoveredField(
  semanticName: string,
  field: NonNullable<ProjectFieldsDeclaration[keyof ProjectFieldsDeclaration]>,
): DiscoveredProjectField {
  if (field.type === "text") {
    return { id: `field-${semanticName}`, name: field.name, type: "text" };
  }
  return {
    id: `field-${semanticName}`,
    name: field.name,
    type: "single_select",
    options: Object.entries(field.options).map(([semanticValue, option]) => ({
      id: `option-${semanticName}-${semanticValue}`,
      name: option.name,
      description: option.description ?? null,
      color: option.color,
    })),
  };
}
