import { readFileSync } from "node:fs";
import path from "node:path";

import {
  compileProjectBinding,
  parseDeliveryProjectDeclaration,
  type DeliveryProjectDeclaration,
} from "@thor/config";
import { issueIdSchema, projectItemIdSchema } from "@thor/domain";
import type { ProjectItemSnapshot } from "@thor/github";
import { describe, expect, it } from "vitest";

import { eligibleToStart } from "./eligibility.js";

describe("polling synchronizer eligibility", () => {
  it.each([
    ["default-delivery.json", "design_blueprint", "in_progress"],
    ["compact-delivery.json", "design", "active"],
  ])("uses the declared entrypoints for %s", (template, eligibleStatus, internalProjectionOnly) => {
    const declaration = loadDeclaration(template);
    const binding = compileProjectBinding(declaration, discoveredFrom(declaration));

    expect(eligibleToStart(snapshot(eligibleStatus), binding)).toBe(true);
    expect(eligibleToStart(snapshot(internalProjectionOnly), binding)).toBe(false);
    expect(eligibleToStart(snapshot(eligibleStatus, false), binding)).toBe(false);
  });
});

function snapshot(status: string, dependenciesComplete = true): ProjectItemSnapshot {
  const projectItemId = projectItemIdSchema.parse("PVTI_eligibility");
  return {
    projectItemId,
    projectId: "PVT_eligibility",
    updatedAt: "1",
    status,
    ticket: {
      projectItemId,
      issueId: issueIdSchema.parse("I_eligibility"),
      repository: { owner: "example", name: "service" },
      issueNumber: 1,
      title: "Test declared synchronizer eligibility",
      body: "",
      workType: "task",
      priority: "P2",
      acceptanceCriteria: [],
      dependencies: dependenciesComplete
        ? []
        : [{ issueId: "I_blocked_dependency", complete: false }],
      policy: {
        executionMode: "agent",
        planningDepth: "full",
        approvalPolicy: "autonomous",
        agentPolicy: "preferred",
        autonomousRepairBudget: 2,
      },
    },
  };
}

function loadDeclaration(template: string): DeliveryProjectDeclaration {
  const raw: unknown = JSON.parse(readFileSync(path.resolve("config/templates", template), "utf8"));
  return parseDeliveryProjectDeclaration(raw);
}

function discoveredFrom(declaration: DeliveryProjectDeclaration): unknown {
  return {
    id: `project-${declaration.metadata.name}`,
    owner: declaration.github.owner,
    number: declaration.github.projectNumber ?? 1,
    title: declaration.github.title,
    shortDescription: declaration.github.shortDescription ?? null,
    readme: null,
    public: declaration.github.visibility === "public",
    url: "https://github.example/projects/1",
    repositories: declaration.github.repositories.map((repository) => ({
      id: `repository-${repository.owner}-${repository.name}`,
      owner: repository.owner,
      name: repository.name,
    })),
    fields: Object.entries(declaration.github.fields).flatMap(([semanticField, field]) => {
      if (field === undefined) return [];
      if (field.type === "text") {
        return [{ id: `field-${semanticField}`, name: field.name, type: "text" }];
      }
      return [
        {
          id: `field-${semanticField}`,
          name: field.name,
          type: "single_select",
          options: Object.entries(field.options).map(([semanticOption, option]) => ({
            id: `option-${semanticField}-${semanticOption}`,
            name: option.name,
            description: option.description ?? null,
            color: option.color,
          })),
        },
      ];
    }),
    views: Object.entries(declaration.github.views).map(([semanticView, view], index) => ({
      id: `view-${semanticView}`,
      number: index + 1,
      name: view.name,
      layout: view.layout,
      filter: view.filter ?? null,
      visibleFieldIds: view.visibleFields.map((field) => `field-${field}`),
    })),
  };
}
