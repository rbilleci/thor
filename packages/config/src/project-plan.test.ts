import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadDeliveryProjectDeclaration } from "./node.js";
import { planProjectConfiguration } from "./project-plan.js";
import type {
  DeliveryProjectDeclaration,
  DiscoveredProject,
  DiscoveredProjectField,
  ProjectFieldsDeclaration,
} from "./schema.js";

const templatePath = path.resolve("config/templates/default-delivery.json");

describe("Project configuration planning", () => {
  it("requires an unnumbered declaration for creation and plans every desired resource", async () => {
    const numbered = await loadDeliveryProjectDeclaration(templatePath);
    const numberedPlan = planProjectConfiguration(numbered, undefined);
    expect(numberedPlan.actions).toEqual([]);
    expect(numberedPlan.conflicts).toEqual([
      expect.objectContaining({ path: "github.projectNumber" }),
    ]);

    const declaration = withoutProjectNumber(numbered);
    const plan = planProjectConfiguration(declaration, undefined);
    expect(plan.conflicts).toEqual([]);
    expect(plan.actions[0]).toEqual({
      kind: "create_project",
      owner: declaration.github.owner,
      title: declaration.github.title,
    });
    expect(plan.actions.filter((action) => action.kind === "create_field")).toHaveLength(9);
    expect(plan.actions.filter((action) => action.kind === "link_repository")).toHaveLength(1);
  });

  it("plans only additive and metadata reconciliation and becomes a no-op afterward", async () => {
    const declaration = await loadDeliveryProjectDeclaration(templatePath);
    const project = discoveredFrom(declaration);
    project.title = "Old title";
    project.public = true;
    project.shortDescription = "Old description";
    project.repositories = [];
    project.fields = project.fields.filter((field) => field.name !== "Component / Area");
    const lifecycle = project.fields.find((field) => field.name === "Thor Status");
    if (lifecycle?.type !== "single_select") {
      throw new Error("test fixture omitted lifecycle field");
    }
    lifecycle.options = lifecycle.options.filter((option) => option.name !== "Cancelled");

    const plan = planProjectConfiguration(declaration, project);
    expect(plan.conflicts).toEqual([]);
    expect(plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "update_project" }),
        expect.objectContaining({ kind: "create_field", semanticField: "component" }),
        expect.objectContaining({
          kind: "extend_select_options",
          semanticField: "lifecycle",
          additions: ["Cancelled"],
        }),
        expect.objectContaining({ kind: "link_repository" }),
      ]),
    );

    expect(planProjectConfiguration(declaration, discoveredFrom(declaration))).toMatchObject({
      actions: [],
      conflicts: [],
    });
  });

  it("surfaces destructive type, case-only rename, and existing-option metadata drift", async () => {
    const declaration = await loadDeliveryProjectDeclaration(templatePath);
    const project = discoveredFrom(declaration);
    const priorityIndex = project.fields.findIndex((field) => field.name === "Priority");
    project.fields[priorityIndex] = {
      id: "field-priority-wrong-type",
      name: "Priority",
      type: "text",
    };
    const component = project.fields.find((field) => field.name === "Component / Area");
    if (component === undefined) throw new Error("test fixture omitted component field");
    component.name = "component / area";
    const lifecycle = project.fields.find((field) => field.name === "Thor Status");
    if (lifecycle?.type !== "single_select") {
      throw new Error("test fixture omitted lifecycle field");
    }
    const done = lifecycle.options.find((option) => option.name === "Done");
    if (done === undefined) throw new Error("test fixture omitted Done");
    done.color = "RED";

    const plan = planProjectConfiguration(declaration, project);
    expect(plan.conflicts.map((conflict) => conflict.path)).toEqual(
      expect.arrayContaining([
        "github.fields.priority.type",
        "github.fields.component.name",
        "github.fields.lifecycle.options.done",
      ]),
    );
  });

  it("plans additive saved-view creation and supported view updates", async () => {
    const declaration = await loadDeliveryProjectDeclaration(templatePath);
    const project = discoveredFrom(declaration);
    const deliveryTable = project.views.find((view) => view.name === "Delivery table");
    if (deliveryTable === undefined) throw new Error("test fixture omitted Delivery table view");
    project.views = project.views.filter((view) => view.name !== "Delivery board");
    deliveryTable.filter = "status:blocked";
    deliveryTable.visibleFieldIds = ["field-lifecycle"];

    const plan = planProjectConfiguration(declaration, project);

    expect(plan.conflicts).toEqual([]);
    expect(
      plan.actions.some(
        (action) => action.kind === "create_view" && action.semanticView === "delivery-board",
      ),
    ).toBe(true);
    const update = plan.actions.find(
      (action) => action.kind === "update_view" && action.semanticView === "delivery-table",
    );
    if (update?.kind !== "update_view") throw new Error("plan omitted Delivery table update");
    expect(update.changes.filter).toBe("");
    expect(update.changes.visibleFieldIds).toHaveLength(8);
  });
});

function withoutProjectNumber(declaration: DeliveryProjectDeclaration): DeliveryProjectDeclaration {
  const github = structuredClone(declaration.github);
  delete github.projectNumber;
  return { ...declaration, github };
}

function discoveredFrom(declaration: DeliveryProjectDeclaration): DiscoveredProject {
  return {
    id: `project-${declaration.metadata.name}`,
    owner: declaration.github.owner,
    number: declaration.github.projectNumber ?? 77,
    title: declaration.github.title,
    shortDescription: declaration.github.shortDescription ?? null,
    readme: null,
    public: declaration.github.visibility === "public",
    url: `https://github.example/projects/${(declaration.github.projectNumber ?? 77).toString()}`,
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
    fields: declaredFields(declaration),
  };
}

function declaredFields(declaration: DeliveryProjectDeclaration): DiscoveredProjectField[] {
  return Object.entries(declaration.github.fields).flatMap(([semanticName, field]) =>
    field === undefined ? [] : [discoveredField(semanticName, field)],
  );
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
