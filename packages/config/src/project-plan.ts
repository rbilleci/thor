import type {
  DeliveryProjectDeclaration,
  DiscoveredProject,
  DiscoveredProjectField,
  ProjectFieldColor,
  ProjectFieldKey,
  ProjectFieldsDeclaration,
  ProjectRepository,
  ProjectViewDeclaration,
  ProjectViewLayout,
} from "./schema.js";
import { declarationDigest, parseDeliveryProjectDeclaration } from "./compiler.js";

export type SelectOptionInput = {
  id?: string;
  name: string;
  description: string;
  color: ProjectFieldColor;
};

export type ProjectMetadataChanges = {
  title?: string;
  public?: boolean;
  shortDescription?: string;
};

export type ProjectViewChanges = {
  name?: string;
  layout?: ProjectViewLayout;
  filter?: string;
  visibleFieldIds?: string[];
};

export type ProjectPlanAction =
  | { kind: "create_project"; owner: string; title: string }
  | { kind: "update_project"; projectId: string; changes: ProjectMetadataChanges }
  | {
      kind: "create_field";
      projectId?: string;
      semanticField: ProjectFieldKey;
      name: string;
      fieldType: "single_select" | "text";
    }
  | {
      kind: "extend_select_options";
      fieldId: string;
      semanticField: ProjectFieldKey;
      additions: string[];
      options: SelectOptionInput[];
    }
  | { kind: "link_repository"; projectId?: string; repository: ProjectRepository }
  | {
      kind: "create_view";
      projectId?: string;
      semanticView: string;
      view: ProjectViewDeclaration;
    }
  | {
      kind: "update_view";
      viewId: string;
      semanticView: string;
      changes: ProjectViewChanges;
    };

export type ProjectPlanConflict = {
  path: string;
  message: string;
};

export type ProjectConfigurationPlan = {
  declarationName: string;
  declarationDigest: string;
  project?: {
    id: string;
    number: number;
    title: string;
    url: string;
  };
  actions: ProjectPlanAction[];
  conflicts: ProjectPlanConflict[];
};

export function planProjectConfiguration(
  rawDeclaration: unknown,
  project: DiscoveredProject | undefined,
): ProjectConfigurationPlan {
  const declaration = parseDeliveryProjectDeclaration(rawDeclaration);
  const actions: ProjectPlanAction[] = [];
  const conflicts: ProjectPlanConflict[] = [];

  if (project === undefined) {
    if (declaration.github.projectNumber !== undefined) {
      conflicts.push({
        path: "github.projectNumber",
        message: `declared Project #${declaration.github.projectNumber.toString()} does not exist; correct the number or remove it to create by title and adopt the assigned number`,
      });
      return basePlan(declaration, undefined, actions, conflicts);
    }
    actions.push({
      kind: "create_project",
      owner: declaration.github.owner,
      title: declaration.github.title,
    });
    appendMissingFields(declaration, undefined, actions);
    for (const repository of declaration.github.repositories) {
      actions.push({ kind: "link_repository", repository });
    }
    for (const [semanticView, view] of Object.entries(declaration.github.views)) {
      actions.push({ kind: "create_view", semanticView, view });
    }
    return basePlan(declaration, undefined, actions, conflicts);
  }

  validateTargetIdentity(declaration, project, conflicts);
  const changes: ProjectMetadataChanges = {};
  if (project.title !== declaration.github.title) changes.title = declaration.github.title;
  const desiredPublic = declaration.github.visibility === "public";
  if (project.public !== desiredPublic) changes.public = desiredPublic;
  if (
    declaration.github.shortDescription !== undefined &&
    project.shortDescription !== declaration.github.shortDescription
  ) {
    changes.shortDescription = declaration.github.shortDescription;
  }
  if (Object.keys(changes).length > 0) {
    actions.push({ kind: "update_project", projectId: project.id, changes });
  }

  const fields = indexFields(project.fields, conflicts);
  for (const [semanticField, desired] of declaredFields(declaration)) {
    const existing = fields.exact.get(desired.name);
    if (existing === undefined) {
      const differentlyCased = fields.normalized.get(desired.name.toLowerCase());
      if (differentlyCased !== undefined) {
        conflicts.push({
          path: `github.fields.${semanticField}.name`,
          message: `Project field ${differentlyCased.name} differs only by case from declared ${desired.name}; rename or adopt it explicitly`,
        });
      } else {
        actions.push({
          kind: "create_field",
          projectId: project.id,
          semanticField,
          name: desired.name,
          fieldType: desired.type,
        });
      }
      continue;
    }
    reconcileField(semanticField, desired, existing, actions, conflicts);
  }

  const linked = new Set(
    project.repositories.map(
      (repository) => `${repository.owner.toLowerCase()}/${repository.name.toLowerCase()}`,
    ),
  );
  for (const repository of declaration.github.repositories) {
    const key = `${repository.owner.toLowerCase()}/${repository.name.toLowerCase()}`;
    if (!linked.has(key)) {
      actions.push({ kind: "link_repository", projectId: project.id, repository });
    }
  }
  reconcileViews(declaration, project, actions, conflicts);
  return basePlan(declaration, project, actions, conflicts);
}

function basePlan(
  declaration: DeliveryProjectDeclaration,
  project: DiscoveredProject | undefined,
  actions: ProjectPlanAction[],
  conflicts: ProjectPlanConflict[],
): ProjectConfigurationPlan {
  return {
    declarationName: declaration.metadata.name,
    declarationDigest: declarationDigest(declaration),
    ...(project === undefined
      ? {}
      : {
          project: {
            id: project.id,
            number: project.number,
            title: project.title,
            url: project.url,
          },
        }),
    actions,
    conflicts,
  };
}

function validateTargetIdentity(
  declaration: DeliveryProjectDeclaration,
  project: DiscoveredProject,
  conflicts: ProjectPlanConflict[],
): void {
  if (project.owner.toLowerCase() !== declaration.github.owner.toLowerCase()) {
    conflicts.push({
      path: "github.owner",
      message: `Project owner ${project.owner} does not match ${declaration.github.owner}`,
    });
  }
  if (
    declaration.github.projectNumber !== undefined &&
    project.number !== declaration.github.projectNumber
  ) {
    conflicts.push({
      path: "github.projectNumber",
      message: `Project number ${project.number.toString()} does not match ${declaration.github.projectNumber.toString()}`,
    });
  }
}

function appendMissingFields(
  declaration: DeliveryProjectDeclaration,
  projectId: string | undefined,
  actions: ProjectPlanAction[],
): void {
  for (const [semanticField, field] of declaredFields(declaration)) {
    actions.push({
      kind: "create_field",
      ...(projectId === undefined ? {} : { projectId }),
      semanticField,
      name: field.name,
      fieldType: field.type,
    });
  }
}

function declaredFields(
  declaration: DeliveryProjectDeclaration,
): [ProjectFieldKey, NonNullable<ProjectFieldsDeclaration[keyof ProjectFieldsDeclaration]>][] {
  const fields = declaration.github.fields;
  const declared: [
    ProjectFieldKey,
    NonNullable<ProjectFieldsDeclaration[keyof ProjectFieldsDeclaration]>,
  ][] = [["lifecycle", fields.lifecycle]];
  appendDeclaredField(declared, "workType", fields.workType);
  appendDeclaredField(declared, "priority", fields.priority);
  appendDeclaredField(declared, "component", fields.component);
  appendDeclaredField(declared, "executionMode", fields.executionMode);
  appendDeclaredField(declared, "planningDepth", fields.planningDepth);
  appendDeclaredField(declared, "approvalPolicy", fields.approvalPolicy);
  appendDeclaredField(declared, "agentPolicy", fields.agentPolicy);
  appendDeclaredField(declared, "severity", fields.severity);
  return declared;
}

function appendDeclaredField(
  target: [
    ProjectFieldKey,
    NonNullable<ProjectFieldsDeclaration[keyof ProjectFieldsDeclaration]>,
  ][],
  key: ProjectFieldKey,
  field: ProjectFieldsDeclaration[keyof ProjectFieldsDeclaration],
): void {
  if (field !== undefined) target.push([key, field]);
}

function indexFields(
  fields: DiscoveredProjectField[],
  conflicts: ProjectPlanConflict[],
): {
  exact: ReadonlyMap<string, DiscoveredProjectField>;
  normalized: ReadonlyMap<string, DiscoveredProjectField>;
} {
  const exact = new Map<string, DiscoveredProjectField>();
  const normalized = new Map<string, DiscoveredProjectField>();
  for (const field of fields) {
    if (exact.has(field.name)) {
      conflicts.push({
        path: "github.fields",
        message: `Project contains more than one field named ${field.name}`,
      });
    }
    const normalizedName = field.name.toLowerCase();
    if (normalized.has(normalizedName) && normalized.get(normalizedName)?.name !== field.name) {
      conflicts.push({
        path: "github.fields",
        message: `Project contains case-ambiguous fields named ${normalized.get(normalizedName)?.name ?? "unknown"} and ${field.name}`,
      });
    }
    exact.set(field.name, field);
    normalized.set(normalizedName, field);
  }
  return { exact, normalized };
}

function reconcileField(
  semanticField: ProjectFieldKey,
  desired: NonNullable<ProjectFieldsDeclaration[keyof ProjectFieldsDeclaration]>,
  existing: DiscoveredProjectField,
  actions: ProjectPlanAction[],
  conflicts: ProjectPlanConflict[],
): void {
  if (desired.type !== existing.type) {
    conflicts.push({
      path: `github.fields.${semanticField}.type`,
      message: `Project field ${desired.name} is ${existing.type}, expected ${desired.type}; field replacement requires an explicit migration`,
    });
    return;
  }
  if (desired.type === "text" || existing.type === "text") return;

  const byName = new Map(existing.options.map((option) => [option.name, option] as const));
  const normalized = new Map(
    existing.options.map((option) => [option.name.toLowerCase(), option] as const),
  );
  const additions: SelectOptionInput[] = [];
  for (const [semanticValue, desiredOption] of Object.entries(desired.options)) {
    const existingOption = byName.get(desiredOption.name);
    if (existingOption === undefined) {
      const differentlyCased = normalized.get(desiredOption.name.toLowerCase());
      if (differentlyCased !== undefined) {
        conflicts.push({
          path: `github.fields.${semanticField}.options.${semanticValue}`,
          message: `Project option ${differentlyCased.name} differs only by case from declared ${desiredOption.name}; rename or adopt it explicitly`,
        });
      } else {
        additions.push({
          name: desiredOption.name,
          description: desiredOption.description ?? "",
          color: desiredOption.color,
        });
      }
      continue;
    }
    const descriptionMatches =
      desiredOption.description === undefined ||
      (existingOption.description ?? "") === desiredOption.description;
    if (!descriptionMatches || existingOption.color !== desiredOption.color) {
      conflicts.push({
        path: `github.fields.${semanticField}.options.${semanticValue}`,
        message: `Project option ${desiredOption.name} metadata differs from the declaration; changing an existing option requires an explicit migration`,
      });
    }
  }
  if (additions.length === 0) return;
  actions.push({
    kind: "extend_select_options",
    fieldId: existing.id,
    semanticField,
    additions: additions.map((option) => option.name),
    options: [
      ...existing.options.map((option) => ({
        id: option.id,
        name: option.name,
        description: option.description ?? "",
        color: option.color,
      })),
      ...additions,
    ],
  });
}

function reconcileViews(
  declaration: DeliveryProjectDeclaration,
  project: DiscoveredProject,
  actions: ProjectPlanAction[],
  conflicts: ProjectPlanConflict[],
): void {
  const exact = new Map(project.views.map((view) => [view.name, view] as const));
  const normalized = new Map(project.views.map((view) => [view.name.toLowerCase(), view] as const));
  for (const [semanticView, desired] of Object.entries(declaration.github.views)) {
    const existing = exact.get(desired.name);
    if (existing === undefined) {
      const differentlyCased = normalized.get(desired.name.toLowerCase());
      if (differentlyCased !== undefined) {
        conflicts.push({
          path: `github.views.${semanticView}.name`,
          message: `Project view ${differentlyCased.name} differs only by case from declared ${desired.name}; rename or adopt it explicitly`,
        });
      } else {
        actions.push({
          kind: "create_view",
          projectId: project.id,
          semanticView,
          view: desired,
        });
      }
      continue;
    }
    const visibleFieldIds = resolveViewFieldIds(desired, declaration, project);
    if (visibleFieldIds === undefined) continue;
    const changes: ProjectViewChanges = {};
    if (existing.layout !== desired.layout) changes.layout = desired.layout;
    if ((existing.filter ?? "") !== (desired.filter ?? "")) {
      changes.filter = desired.filter ?? "";
    }
    if (JSON.stringify(existing.visibleFieldIds) !== JSON.stringify(visibleFieldIds)) {
      changes.visibleFieldIds = visibleFieldIds;
    }
    if (Object.keys(changes).length > 0) {
      actions.push({
        kind: "update_view",
        viewId: existing.id,
        semanticView,
        changes,
      });
    }
  }
}

export function resolveViewFieldIds(
  view: ProjectViewDeclaration,
  declaration: DeliveryProjectDeclaration,
  project: DiscoveredProject,
): string[] | undefined {
  const fields = new Map(project.fields.map((field) => [field.name, field.id] as const));
  const ids: string[] = [];
  for (const fieldKey of view.visibleFields) {
    const desiredField = declaration.github.fields[fieldKey];
    if (desiredField === undefined) return undefined;
    const id = fields.get(desiredField.name);
    if (id === undefined) return undefined;
    ids.push(id);
  }
  return ids;
}
