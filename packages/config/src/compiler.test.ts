import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  compileProjectBinding,
  parseDeliveryProjectDeclaration,
  ProjectConfigurationError,
} from "./compiler.js";
import { loadDeliveryProjectDeclaration } from "./node.js";
import type {
  DeliveryProjectDeclaration,
  DiscoveredProject,
  DiscoveredProjectField,
  ProjectFieldsDeclaration,
} from "./schema.js";

const templates = path.resolve(process.cwd(), "config/templates");

describe("Delivery Project configuration compiler", () => {
  it("compiles the detailed declaration into stable semantic-to-ID bindings", async () => {
    const declaration = await loadDeliveryProjectDeclaration(
      path.join(templates, "default-delivery.json"),
    );
    const project = discoveredFrom(declaration);

    const first = compileProjectBinding(declaration, project);
    const second = compileProjectBinding(declaration, project);

    expect(second).toEqual(first);
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.delivery.declarationDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.fields.lifecycle.options.design_blueprint).toBe(
      "option-lifecycle-design_blueprint",
    );
    expect(first.fields.workType?.options.bug).toBe("option-workType-bug");
    expect(first.delivery.agents["planning-primary"]).toMatchObject({
      harness: "claude",
      resourceProfile: "default",
    });
    expect(first.delivery.workflow.interventions).toEqual({
      ticketChanges: "replan",
      dependencyChanges: "replan",
      unexpectedStatuses: "block",
      unreadableItems: { action: "block", afterConsecutivePolls: 3 },
      removedItems: "orphan",
    });
    expect(first.delivery.workflow.dependencies).toEqual({
      completion: "issue_closed_and_project_done",
      closeIssueAfterMerge: true,
    });
    expect(first.delivery.collaboration.slack).toEqual({ enabled: false });
  });

  it("compiles both Slack messaging modes with stable defaults", async () => {
    const declaration = await loadDeliveryProjectDeclaration(
      path.join(templates, "compact-delivery.json"),
    );
    const threadMode = {
      ...declaration,
      collaboration: {
        slack: {
          enabled: true,
          workspaceId: "T012345",
          messaging: { mode: "thread_per_ticket", projectChannelId: "C012345" },
          steering: { allowedUserGroupIds: ["S012345"] },
        },
      },
    };
    const channelMode = {
      ...declaration,
      collaboration: {
        slack: {
          enabled: true,
          workspaceId: "T012345",
          messaging: {
            mode: "channel_per_ticket",
            projectIndexChannelId: "C045678",
            ticketChannels: {
              namePrefix: "thor-compact",
              memberUserGroupIds: ["S012345"],
            },
          },
          steering: { allowedUserGroupIds: ["S012345"], defaultMode: "queue" },
        },
      },
    };

    expect(
      compileProjectBinding(threadMode, discoveredFrom(declaration)).delivery.collaboration,
    ).toMatchObject({
      slack: {
        enabled: true,
        messaging: { mode: "thread_per_ticket", projectChannelId: "C012345" },
        eventReconciliationIntervalSeconds: 30,
        streamFlushIntervalMilliseconds: 1000,
        controlDeliveryTimeoutSeconds: 5,
        steering: { defaultMode: "redirect" },
      },
    });
    expect(
      compileProjectBinding(channelMode, discoveredFrom(declaration)).delivery.collaboration,
    ).toMatchObject({
      slack: {
        enabled: true,
        messaging: {
          mode: "channel_per_ticket",
          ticketChannels: { isPrivate: true, archiveDelayDays: 7 },
        },
        steering: { defaultMode: "queue" },
      },
    });
  });

  it("rejects incomplete Slack channel-per-ticket declarations", async () => {
    const declaration = await loadDeliveryProjectDeclaration(
      path.join(templates, "compact-delivery.json"),
    );
    const invalid = {
      ...declaration,
      collaboration: {
        slack: {
          enabled: true,
          workspaceId: "T012345",
          messaging: {
            mode: "channel_per_ticket",
            ticketChannels: { namePrefix: "Thor Invalid", memberUserGroupIds: [] },
          },
          steering: { allowedUserGroupIds: ["S012345"] },
        },
      },
    };

    expect(() => compileProjectBinding(invalid, discoveredFrom(declaration))).toThrow();
  });

  it("supports renamed fields, compact board projection, explicit defaults, and swapped agents", async () => {
    const declaration = await loadDeliveryProjectDeclaration(
      path.join(templates, "compact-delivery.json"),
    );
    const binding = compileProjectBinding(declaration, discoveredFrom(declaration));

    expect(binding.fields.lifecycle.options.active).toBe("option-lifecycle-active");
    expect(binding.fields.workType?.options.bug).toBe("option-workType-bug");
    expect(binding.fields.component).toBeUndefined();
    expect(binding.fields.planningDepth).toBeUndefined();
    expect(binding.ticketDefaults.planningDepth).toBe("light");
    expect(binding.delivery.workflow.board.states.ready_for_review).toBe("active");
    expect(binding.delivery.workflow.board.states.automated_review_passed).toBe("review");
    expect(binding.delivery.workflow.reviewers).toEqual([
      "correctness",
      "security",
      "testing",
      "product_specification",
    ]);
    expect(binding.delivery.agents["compact-planner"]?.harness).toBe("codex");
    expect(binding.delivery.agents["compact-builder"]?.harness).toBe("claude");
    expect(binding.repositories[0]?.baseBranch).toBe("trunk");
    expect(binding.delivery.workflow.interventions.dependencyChanges).toBe("resume");
    expect(binding.delivery.workflow.interventions.unreadableItems.afterConsecutivePolls).toBe(2);
    expect(binding.delivery.workflow.dependencies.completion).toBe("issue_closed_or_project_done");
  });

  it("reports schema drift instead of silently applying ticket-policy defaults", async () => {
    const declaration = await loadDeliveryProjectDeclaration(
      path.join(templates, "default-delivery.json"),
    );
    const project = discoveredFrom(declaration);
    project.fields = project.fields.filter((field) => field.name !== "Approval Policy");

    const error = configurationError(() => compileProjectBinding(declaration, project));
    expect(error.issues).toEqual(
      expect.arrayContaining([expect.stringContaining("missing approvalPolicy field")]),
    );
    expect(error.message).toContain("missing approvalPolicy field");
  });

  it("rejects workflow references to undeclared board states and agent profiles", async () => {
    const declaration = await loadDeliveryProjectDeclaration(
      path.join(templates, "compact-delivery.json"),
    );
    const invalid = structuredClone(declaration) as unknown as Record<string, unknown>;
    const workflow = invalid.workflow as Record<string, unknown>;
    const board = workflow.board as Record<string, unknown>;
    const controls = board.controls as Record<string, unknown>;
    controls.blocked = "not_declared";
    const agents = workflow.agents as Record<string, unknown>;
    agents.repair = "missing-agent";

    const error = configurationError(() =>
      compileProjectBinding(invalid, discoveredFrom(declaration)),
    );
    expect(error.issues).toEqual(
      expect.arrayContaining([
        "workflow references undeclared board state not_declared",
        "workflow phase repair references undeclared agent profile missing-agent",
      ]),
    );
  });

  it("rejects unknown declaration and workflow implementation versions", async () => {
    const declaration = await loadDeliveryProjectDeclaration(
      path.join(templates, "default-delivery.json"),
    );
    const unknownApi = { ...declaration, apiVersion: "thor.dev/v2" };
    const unknownWorkflow = {
      ...declaration,
      workflow: { ...declaration.workflow, implementation: "ticket-delivery/v2" },
    };

    expect(() => parseDeliveryProjectDeclaration(unknownApi)).toThrow();
    expect(() => parseDeliveryProjectDeclaration(unknownWorkflow)).toThrow();
  });

  it("reports saved-view drift in layout, filter, and visible fields", async () => {
    const declaration = await loadDeliveryProjectDeclaration(
      path.join(templates, "default-delivery.json"),
    );
    const project = discoveredFrom(declaration);
    const view = project.views.find((candidate) => candidate.name === "Delivery board");
    if (view === undefined) throw new Error("test fixture omitted Delivery board view");
    view.layout = "TABLE_LAYOUT";
    view.filter = "status:blocked";
    view.visibleFieldIds = ["field-lifecycle"];

    const error = configurationError(() => compileProjectBinding(declaration, project));
    expect(error.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("layout"),
        expect.stringContaining("filter"),
        expect.stringContaining("visible fields"),
      ]),
    );
  });
});

function configurationError(action: () => unknown): ProjectConfigurationError {
  try {
    action();
  } catch (error) {
    if (error instanceof ProjectConfigurationError) return error;
    throw error;
  }
  throw new Error("expected ProjectConfigurationError");
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
    url: `https://github.com/orgs/${declaration.github.owner}/projects/${(declaration.github.projectNumber ?? 1).toString()}`,
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
