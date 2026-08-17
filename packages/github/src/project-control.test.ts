import path from "node:path";

import {
  parseDeliveryProjectDeclaration,
  ProjectConfigurationError,
  type DeliveryProjectDeclaration,
  type DiscoveredProject,
  type ProjectMetadataChanges,
  type ProjectRepository,
  type ProjectViewChanges,
  type SelectOptionInput,
} from "@thor/config";
import { loadDeliveryProjectDeclaration } from "@thor/config/node";
import { describe, expect, it } from "vitest";

import {
  ProjectConfigurationManager,
  type ProjectAdministrationGateway,
  type ProjectFieldCreateInput,
  type ProjectViewCreateInput,
} from "./project-control.js";

const templatePath = path.resolve("config/templates/default-delivery.json");

describe("ProjectConfigurationManager", () => {
  it("converges a new Project, publishes a binding, and makes the second apply a no-op", async () => {
    const template = await loadDeliveryProjectDeclaration(templatePath);
    const declaration = withoutProjectNumber(template);
    const github = new FakeProjectAdministrationGateway();
    const manager = new ProjectConfigurationManager(github);

    const first = await manager.apply(declaration);
    expect(first.applied[0]?.kind).toBe("create_project");
    expect(first.applied.filter((action) => action.kind === "create_field")).toHaveLength(9);
    expect(first.applied.filter((action) => action.kind === "create_view")).toHaveLength(2);
    expect(first.binding.project.number).toBe(73);
    expect(first.binding.fields.lifecycle.options.design_blueprint).toBe(
      "option-lifecycle-design_blueprint",
    );
    expect(first.binding.repositories).toEqual(declaration.github.repositories);

    const second = await manager.apply(declaration);
    expect(second.applied).toEqual([]);
    expect(second.binding).toEqual(first.binding);
  });

  it("refuses destructive drift before issuing a mutation", async () => {
    const declaration = await loadDeliveryProjectDeclaration(templatePath);
    const github = new FakeProjectAdministrationGateway(discoveredFrom(declaration));
    const lifecycle = github.project?.fields.find((field) => field.name === "Thor Status");
    if (lifecycle?.type !== "single_select") {
      throw new Error("test fixture omitted lifecycle field");
    }
    const done = lifecycle.options.find((option) => option.name === "Done");
    if (done === undefined) throw new Error("test fixture omitted Done option");
    done.color = "RED";
    const manager = new ProjectConfigurationManager(github);

    const error = await configurationError(manager.apply(declaration));
    expect(error.issues).toEqual(expect.arrayContaining([expect.stringContaining("options.done")]));
    expect(github.mutations).toBe(0);
  });

  it("adopts an unnumbered exact-title Project by pinning its assigned number", async () => {
    const template = await loadDeliveryProjectDeclaration(templatePath);
    const declaration = withoutProjectNumber(template);
    const project = discoveredFrom(declaration);
    project.number = 91;
    const manager = new ProjectConfigurationManager(new FakeProjectAdministrationGateway(project));

    const adopted = await manager.adopt(declaration);
    expect(adopted.declaration.github.projectNumber).toBe(91);
    expect(adopted.binding.project.number).toBe(91);
  });

  it("resumes safely after a partial apply failure", async () => {
    const template = await loadDeliveryProjectDeclaration(templatePath);
    const declaration = withoutProjectNumber(template);
    const github = new FakeProjectAdministrationGateway();
    github.failOnceOnField = "priority";
    const manager = new ProjectConfigurationManager(github);

    await expect(manager.apply(declaration)).rejects.toThrow("injected priority failure");
    expect(github.project).toBeDefined();

    const resumed = await manager.apply(declaration);
    expect(resumed.binding.project.number).toBe(73);
    expect(resumed.binding.fields.priority?.options.P2).toBe("option-priority-P2");
    expect((await manager.plan(declaration)).actions).toEqual([]);
  });
});

class FakeProjectAdministrationGateway implements ProjectAdministrationGateway {
  public mutations = 0;
  public failOnceOnField: ProjectFieldCreateInput["semanticField"] | undefined;

  public constructor(public project?: DiscoveredProject) {}

  public discoverProject(
    declaration: DeliveryProjectDeclaration,
  ): Promise<DiscoveredProject | undefined> {
    if (this.project === undefined) return Promise.resolve(undefined);
    if (declaration.github.projectNumber !== undefined) {
      return Promise.resolve(
        this.project.number === declaration.github.projectNumber ? this.project : undefined,
      );
    }
    return Promise.resolve(
      this.project.title === declaration.github.title ? this.project : undefined,
    );
  }

  public createProject(declaration: DeliveryProjectDeclaration): Promise<void> {
    this.mutations += 1;
    if (this.project !== undefined) return Promise.resolve();
    this.project = {
      id: "project-created",
      owner: declaration.github.owner,
      number: 73,
      title: declaration.github.title,
      shortDescription: null,
      readme: null,
      public: false,
      url: "https://github.example/projects/73",
      repositories: [],
      fields: [],
      views: [],
    };
    return Promise.resolve();
  }

  public updateProject(_projectId: string, changes: ProjectMetadataChanges): Promise<void> {
    this.mutations += 1;
    const project = this.requireProject();
    if (changes.title !== undefined) project.title = changes.title;
    if (changes.public !== undefined) project.public = changes.public;
    if (changes.shortDescription !== undefined) {
      project.shortDescription = changes.shortDescription;
    }
    return Promise.resolve();
  }

  public createField(_projectId: string, input: ProjectFieldCreateInput): Promise<void> {
    if (this.failOnceOnField === input.semanticField) {
      this.failOnceOnField = undefined;
      return Promise.reject(new Error(`injected ${input.semanticField} failure`));
    }
    this.mutations += 1;
    const project = this.requireProject();
    if (project.fields.some((field) => field.name === input.field.name)) {
      return Promise.resolve();
    }
    if (input.field.type === "text") {
      project.fields.push({
        id: `field-${input.semanticField}`,
        name: input.field.name,
        type: "text",
      });
    } else {
      project.fields.push({
        id: `field-${input.semanticField}`,
        name: input.field.name,
        type: "single_select",
        options: Object.entries(input.field.options).map(([semanticValue, option]) => ({
          id: `option-${input.semanticField}-${semanticValue}`,
          name: option.name,
          description: option.description ?? null,
          color: option.color,
        })),
      });
    }
    return Promise.resolve();
  }

  public updateSelectOptions(fieldId: string, options: SelectOptionInput[]): Promise<void> {
    this.mutations += 1;
    const field = this.requireProject().fields.find((candidate) => candidate.id === fieldId);
    if (field?.type !== "single_select") {
      return Promise.reject(new Error(`missing select field ${fieldId}`));
    }
    field.options = options.map((option, index) => ({
      id: option.id ?? `option-added-${index.toString()}`,
      name: option.name,
      description: option.description,
      color: option.color,
    }));
    return Promise.resolve();
  }

  public linkRepository(_projectId: string, repository: ProjectRepository): Promise<void> {
    this.mutations += 1;
    const project = this.requireProject();
    if (
      project.repositories.some(
        (candidate) =>
          candidate.owner.toLowerCase() === repository.owner.toLowerCase() &&
          candidate.name.toLowerCase() === repository.name.toLowerCase(),
      )
    ) {
      return Promise.resolve();
    }
    project.repositories.push({
      id: `repository-${repository.owner}-${repository.name}`,
      owner: repository.owner,
      name: repository.name,
    });
    return Promise.resolve();
  }

  public createView(_projectId: string, input: ProjectViewCreateInput): Promise<void> {
    this.mutations += 1;
    const project = this.requireProject();
    if (project.views.some((view) => view.name === input.view.name)) return Promise.resolve();
    project.views.push({
      id: `view-${input.semanticView}`,
      number: project.views.length + 1,
      name: input.view.name,
      layout: input.view.layout,
      filter: null,
      visibleFieldIds: input.visibleFieldIds,
    });
    return Promise.resolve();
  }

  public updateView(viewId: string, changes: ProjectViewChanges): Promise<void> {
    this.mutations += 1;
    const view = this.requireProject().views.find((candidate) => candidate.id === viewId);
    if (view === undefined) return Promise.reject(new Error(`missing view ${viewId}`));
    if (changes.name !== undefined) view.name = changes.name;
    if (changes.layout !== undefined) view.layout = changes.layout;
    if (changes.filter !== undefined) view.filter = changes.filter;
    if (changes.visibleFieldIds !== undefined) view.visibleFieldIds = changes.visibleFieldIds;
    return Promise.resolve();
  }

  private requireProject(): DiscoveredProject {
    if (this.project === undefined) throw new Error("fake Project does not exist");
    return this.project;
  }
}

function withoutProjectNumber(declaration: DeliveryProjectDeclaration): DeliveryProjectDeclaration {
  const github = structuredClone(declaration.github);
  delete github.projectNumber;
  return parseDeliveryProjectDeclaration({ ...declaration, github });
}

function discoveredFrom(declaration: DeliveryProjectDeclaration): DiscoveredProject {
  const project: DiscoveredProject = {
    id: "project-existing",
    owner: declaration.github.owner,
    number: declaration.github.projectNumber ?? 73,
    title: declaration.github.title,
    shortDescription: declaration.github.shortDescription ?? null,
    readme: null,
    public: declaration.github.visibility === "public",
    url: "https://github.example/projects/existing",
    repositories: declaration.github.repositories.map((repository) => ({
      id: `repository-${repository.owner}-${repository.name}`,
      owner: repository.owner,
      name: repository.name,
    })),
    fields: [],
    views: Object.entries(declaration.github.views).map(([semanticView, view], index) => ({
      id: `view-${semanticView}`,
      number: index + 1,
      name: view.name,
      layout: view.layout,
      filter: view.filter ?? null,
      visibleFieldIds: view.visibleFields.map((fieldKey) => `field-${fieldKey}`),
    })),
  };
  const fake = new FakeProjectAdministrationGateway(project);
  for (const [semanticField, field] of declarationFields(declaration)) {
    void fake.createField(project.id, { semanticField, field });
  }
  fake.mutations = 0;
  return project;
}

function declarationFields(
  declaration: DeliveryProjectDeclaration,
): [ProjectFieldCreateInput["semanticField"], ProjectFieldCreateInput["field"]][] {
  const fields = declaration.github.fields;
  const result: [ProjectFieldCreateInput["semanticField"], ProjectFieldCreateInput["field"]][] = [
    ["lifecycle", fields.lifecycle],
  ];
  appendField(result, "workType", fields.workType);
  appendField(result, "priority", fields.priority);
  appendField(result, "component", fields.component);
  appendField(result, "executionMode", fields.executionMode);
  appendField(result, "planningDepth", fields.planningDepth);
  appendField(result, "approvalPolicy", fields.approvalPolicy);
  appendField(result, "agentPolicy", fields.agentPolicy);
  appendField(result, "severity", fields.severity);
  return result;
}

function appendField(
  target: [ProjectFieldCreateInput["semanticField"], ProjectFieldCreateInput["field"]][],
  semanticField: ProjectFieldCreateInput["semanticField"],
  field: ProjectFieldCreateInput["field"] | undefined,
): void {
  if (field !== undefined) target.push([semanticField, field]);
}

async function configurationError(result: Promise<unknown>): Promise<ProjectConfigurationError> {
  try {
    await result;
  } catch (error) {
    if (error instanceof ProjectConfigurationError) return error;
    throw error;
  }
  throw new Error("expected ProjectConfigurationError");
}
