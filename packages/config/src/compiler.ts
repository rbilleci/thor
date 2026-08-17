import { createHash } from "node:crypto";

import type { z } from "zod";

import {
  compiledProjectBindingSchema,
  deliveryProjectDeclarationSchema,
  discoveredProjectSchema,
  type AgentProfileSnapshot,
  type CompiledProjectBinding,
  type DeliveryProjectDeclaration,
  type DiscoveredProject,
  type DiscoveredProjectField,
  type ProjectFieldsDeclaration,
  type ResolvedProjectFields,
  type RuntimeDeliveryProfile,
} from "./schema.js";

export class ProjectConfigurationError extends Error {
  public constructor(
    message: string,
    public readonly issues: readonly string[],
  ) {
    super(issues.length === 0 ? message : `${message}:\n- ${issues.join("\n- ")}`);
    this.name = "ProjectConfigurationError";
  }
}

export function parseDeliveryProjectDeclaration(value: unknown): DeliveryProjectDeclaration {
  const declaration = deliveryProjectDeclarationSchema.parse(value);
  validateDeclarationReferences(declaration);
  return declaration;
}

export function compileProjectBinding(
  rawDeclaration: unknown,
  rawProject: unknown,
): CompiledProjectBinding {
  const declaration = parseDeliveryProjectDeclaration(rawDeclaration);
  const project = discoveredProjectSchema.parse(rawProject);
  const issues = validateProjectTarget(declaration, project);
  const fields = resolveFields(declaration.github.fields, project, issues);
  validateProjectViews(declaration, project, fields, issues);
  if (issues.length > 0) {
    throw new ProjectConfigurationError(
      `GitHub Project does not satisfy declaration ${declaration.metadata.name}`,
      issues,
    );
  }
  const delivery = compileRuntimeDeliveryProfile(declaration);
  const withoutDigest = {
    apiVersion: "thor.dev/binding-v1alpha1" as const,
    project: {
      id: project.id,
      owner: project.owner,
      number: project.number,
      title: project.title,
      url: project.url,
    },
    repositories: declaration.github.repositories,
    fields,
    ticketDefaults: declaration.ticketDefaults,
    delivery,
  };
  return compiledProjectBindingSchema.parse({
    ...withoutDigest,
    digest: sha256(withoutDigest),
  });
}

export function compileRuntimeDeliveryProfile(rawDeclaration: unknown): RuntimeDeliveryProfile {
  const declaration = parseDeliveryProjectDeclaration(rawDeclaration);
  return {
    declarationName: declaration.metadata.name,
    declarationVersion: declaration.metadata.version,
    declarationDigest: sha256(declaration),
    workflow: declaration.workflow,
    agents: resolveAgents(declaration),
    skillSelectors: declaration.skillSelectors,
  };
}

export function declarationDigest(declaration: DeliveryProjectDeclaration): string {
  return sha256(parseDeliveryProjectDeclaration(declaration));
}

function validateDeclarationReferences(declaration: DeliveryProjectDeclaration): void {
  const issues: string[] = [];
  const lifecycleStates = new Set(Object.keys(declaration.github.fields.lifecycle.options));
  const referencedStates = new Set([
    ...Object.values(declaration.workflow.board.states),
    ...declaration.workflow.board.entrypoints.blueprint,
    ...declaration.workflow.board.entrypoints.implementation,
    declaration.workflow.board.controls.blocked,
    declaration.workflow.board.controls.cancelled,
    declaration.workflow.board.approvals.blueprint.approved,
    declaration.workflow.board.approvals.blueprint.changesRequested,
    declaration.workflow.board.approvals.merge.approved,
    declaration.workflow.board.approvals.merge.changesRequested,
  ]);
  for (const state of referencedStates) {
    if (!lifecycleStates.has(state))
      issues.push(`workflow references undeclared board state ${state}`);
  }
  const roles = declaration.workflow.agents;
  for (const [phase, agentId] of Object.entries(roles)) {
    if (declaration.agents[agentId] === undefined) {
      issues.push(`workflow phase ${phase} references undeclared agent profile ${agentId}`);
    }
  }
  const repositoryKeys = new Set<string>();
  for (const repository of declaration.github.repositories) {
    const key = `${repository.owner.toLowerCase()}/${repository.name.toLowerCase()}`;
    if (repositoryKeys.has(key))
      issues.push(`duplicate repository ${repository.owner}/${repository.name}`);
    repositoryKeys.add(key);
  }
  const fieldNames = new Set<string>();
  for (const [semanticField, field] of Object.entries(declaration.github.fields)) {
    if (field === undefined) continue;
    const normalizedName = field.name.toLowerCase();
    if (fieldNames.has(normalizedName)) {
      issues.push(`duplicate physical Project field name ${field.name}`);
    }
    fieldNames.add(normalizedName);
    if (field.type === "single_select") {
      const optionNames = new Set<string>();
      for (const option of Object.values(field.options)) {
        const normalizedOption = option.name.toLowerCase();
        if (optionNames.has(normalizedOption)) {
          issues.push(
            `${semanticField} field contains duplicate physical option name ${option.name}`,
          );
        }
        optionNames.add(normalizedOption);
      }
    }
  }
  const viewNames = new Set<string>();
  for (const [viewKey, view] of Object.entries(declaration.github.views)) {
    const normalizedName = view.name.toLowerCase();
    if (viewNames.has(normalizedName)) {
      issues.push(`duplicate physical Project view name ${view.name}`);
    }
    viewNames.add(normalizedName);
    for (const fieldKey of view.visibleFields) {
      if (declaration.github.fields[fieldKey] === undefined) {
        issues.push(`Project view ${viewKey} references undeclared field ${fieldKey}`);
      }
    }
  }
  for (const selector of declaration.skillSelectors) {
    const components = selector.match.components;
    if (
      components !== undefined &&
      new Set(components.map((value) => value.toLowerCase())).size !== components.length
    ) {
      issues.push(`skill selector ${selector.skill} contains duplicate components`);
    }
  }
  if (issues.length > 0) {
    throw new ProjectConfigurationError(
      `Delivery Project declaration ${declaration.metadata.name} is invalid`,
      issues,
    );
  }
}

function validateProjectTarget(
  declaration: DeliveryProjectDeclaration,
  project: DiscoveredProject,
): string[] {
  const issues: string[] = [];
  if (project.owner.toLowerCase() !== declaration.github.owner.toLowerCase()) {
    issues.push(`Project owner ${project.owner} does not match ${declaration.github.owner}`);
  }
  if (
    declaration.github.projectNumber !== undefined &&
    project.number !== declaration.github.projectNumber
  ) {
    issues.push(
      `Project number ${project.number.toString()} does not match ${declaration.github.projectNumber.toString()}`,
    );
  }
  if (project.title !== declaration.github.title) {
    issues.push(
      `Project title ${JSON.stringify(project.title)} does not match ${JSON.stringify(declaration.github.title)}`,
    );
  }
  if (project.public !== (declaration.github.visibility === "public")) {
    issues.push(`Project visibility does not match ${declaration.github.visibility}`);
  }
  const linkedRepositories = new Set(
    project.repositories.map(
      (repository) => `${repository.owner.toLowerCase()}/${repository.name.toLowerCase()}`,
    ),
  );
  for (const repository of declaration.github.repositories) {
    const key = `${repository.owner.toLowerCase()}/${repository.name.toLowerCase()}`;
    if (!linkedRepositories.has(key)) {
      issues.push(`Project is not linked to repository ${repository.owner}/${repository.name}`);
    }
  }
  return issues;
}

function resolveFields(
  declaration: ProjectFieldsDeclaration,
  project: DiscoveredProject,
  issues: string[],
): ResolvedProjectFields {
  const fields = new Map(project.fields.map((field) => [field.name, field] as const));
  return {
    lifecycle: resolveSelect("lifecycle", declaration.lifecycle, fields, issues),
    ...resolveOptionalSelect("workType", declaration.workType, fields, issues),
    ...resolveOptionalSelect("priority", declaration.priority, fields, issues),
    ...resolveOptionalText("component", declaration.component, fields, issues),
    ...resolveOptionalSelect("executionMode", declaration.executionMode, fields, issues),
    ...resolveOptionalSelect("planningDepth", declaration.planningDepth, fields, issues),
    ...resolveOptionalSelect("approvalPolicy", declaration.approvalPolicy, fields, issues),
    ...resolveOptionalSelect("agentPolicy", declaration.agentPolicy, fields, issues),
    ...resolveOptionalSelect("severity", declaration.severity, fields, issues),
  };
}

function validateProjectViews(
  declaration: DeliveryProjectDeclaration,
  project: DiscoveredProject,
  fields: ResolvedProjectFields,
  issues: string[],
): void {
  const viewsByName = new Map(project.views.map((view) => [view.name, view] as const));
  for (const [viewKey, desired] of Object.entries(declaration.github.views)) {
    const view = viewsByName.get(desired.name);
    if (view === undefined) {
      issues.push(`missing Project view ${JSON.stringify(desired.name)} for ${viewKey}`);
      continue;
    }
    if (view.layout !== desired.layout) {
      issues.push(
        `Project view ${desired.name} layout is ${view.layout}, expected ${desired.layout}`,
      );
    }
    if ((view.filter ?? "") !== (desired.filter ?? "")) {
      issues.push(`Project view ${desired.name} filter does not match the declaration`);
    }
    const desiredFieldIds = desired.visibleFields.flatMap((fieldKey) => {
      const field = fields[fieldKey];
      return field === undefined ? [] : [field.fieldId];
    });
    if (JSON.stringify(view.visibleFieldIds) !== JSON.stringify(desiredFieldIds)) {
      issues.push(`Project view ${desired.name} visible fields do not match the declaration`);
    }
  }
}

type SelectDeclaration = Extract<
  ProjectFieldsDeclaration[keyof ProjectFieldsDeclaration],
  { type: "single_select" }
>;

function resolveOptionalSelect<Key extends keyof ResolvedProjectFields>(
  key: Key,
  declaration: SelectDeclaration | undefined,
  fields: ReadonlyMap<string, DiscoveredProjectField>,
  issues: string[],
): Partial<Pick<ResolvedProjectFields, Key>> {
  if (declaration === undefined) return {};
  return { [key]: resolveSelect(key, declaration, fields, issues) } as Partial<
    Pick<ResolvedProjectFields, Key>
  >;
}

function resolveSelect(
  semanticName: string,
  declaration: SelectDeclaration,
  fields: ReadonlyMap<string, DiscoveredProjectField>,
  issues: string[],
): z.infer<typeof compiledProjectBindingSchema>["fields"]["lifecycle"] {
  const field = fields.get(declaration.name);
  if (field === undefined) {
    issues.push(`missing ${semanticName} field ${JSON.stringify(declaration.name)}`);
    return {
      type: "single_select",
      fieldId: `missing:${semanticName}`,
      requiredOnItems: declaration.requiredOnItems,
      options: {},
    };
  }
  if (field.type !== "single_select") {
    issues.push(
      `${semanticName} field ${JSON.stringify(declaration.name)} is ${field.type}, expected single_select`,
    );
    return {
      type: "single_select",
      fieldId: field.id,
      requiredOnItems: declaration.requiredOnItems,
      options: {},
    };
  }
  const optionsByName = new Map(field.options.map((option) => [option.name, option.id] as const));
  const options: Record<string, string> = {};
  for (const [semanticValue, desired] of Object.entries(declaration.options)) {
    const optionId = optionsByName.get(desired.name);
    if (optionId === undefined) {
      issues.push(
        `missing ${semanticName} option ${JSON.stringify(desired.name)} for ${semanticValue}`,
      );
    } else {
      options[semanticValue] = optionId;
    }
  }
  return {
    type: "single_select",
    fieldId: field.id,
    requiredOnItems: declaration.requiredOnItems,
    options,
  };
}

function resolveOptionalText<Key extends keyof ResolvedProjectFields>(
  key: Key,
  declaration: { type: "text"; name: string; requiredOnItems: boolean } | undefined,
  fields: ReadonlyMap<string, DiscoveredProjectField>,
  issues: string[],
): Partial<Pick<ResolvedProjectFields, Key>> {
  if (declaration === undefined) return {};
  const field = fields.get(declaration.name);
  if (field === undefined) {
    issues.push(`missing ${key} field ${JSON.stringify(declaration.name)}`);
    return {};
  }
  if (field.type !== "text") {
    issues.push(`${key} field ${JSON.stringify(declaration.name)} is ${field.type}, expected text`);
    return {};
  }
  return {
    [key]: {
      type: "text",
      fieldId: field.id,
      requiredOnItems: declaration.requiredOnItems,
    },
  } as Partial<Pick<ResolvedProjectFields, Key>>;
}

function resolveAgents(
  declaration: DeliveryProjectDeclaration,
): Record<string, AgentProfileSnapshot> {
  return Object.fromEntries(
    Object.entries(declaration.agents).map(([id, profile]) => [
      id,
      { id, ...profile, digest: sha256({ id, ...profile }) },
    ]),
  );
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortValue(child)]),
  );
}
