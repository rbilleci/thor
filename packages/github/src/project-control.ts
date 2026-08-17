import type { Octokit } from "@octokit/core";
import {
  compileProjectBinding,
  parseDeliveryProjectDeclaration,
  planProjectConfiguration,
  ProjectConfigurationError,
  resolveViewFieldIds,
  type CompiledProjectBinding,
  type DeliveryProjectDeclaration,
  type DiscoveredProject,
  type DiscoveredProjectField,
  type ProjectConfigurationPlan,
  type ProjectFieldKey,
  type ProjectFieldsDeclaration,
  type ProjectMetadataChanges,
  type ProjectRepository,
  type ProjectViewChanges,
  type ProjectViewDeclaration,
  type SelectOptionInput,
} from "@thor/config";
import { projectFieldColorSchema } from "@thor/config/schema";
import { z } from "zod";

import {
  createOctokit,
  normalizeGitHubError,
  type OctokitClientOptions,
} from "./octokit-gateway.js";

type ProjectFieldDeclaration = NonNullable<
  ProjectFieldsDeclaration[keyof ProjectFieldsDeclaration]
>;

export type ProjectFieldCreateInput = {
  semanticField: ProjectFieldKey;
  field: ProjectFieldDeclaration;
};

export type ProjectViewCreateInput = {
  semanticView: string;
  view: ProjectViewDeclaration;
  visibleFieldIds: string[];
};

export type ProjectAdministrationGateway = {
  discoverProject(declaration: DeliveryProjectDeclaration): Promise<DiscoveredProject | undefined>;
  createProject(declaration: DeliveryProjectDeclaration): Promise<void>;
  updateProject(projectId: string, changes: ProjectMetadataChanges): Promise<void>;
  createField(projectId: string, input: ProjectFieldCreateInput): Promise<void>;
  updateSelectOptions(fieldId: string, options: SelectOptionInput[]): Promise<void>;
  linkRepository(projectId: string, repository: ProjectRepository): Promise<void>;
  createView(projectId: string, input: ProjectViewCreateInput): Promise<void>;
  updateView(viewId: string, changes: ProjectViewChanges): Promise<void>;
};

export type ProjectApplyResult = {
  binding: CompiledProjectBinding;
  applied: ProjectConfigurationPlan["actions"];
};

export class ProjectConfigurationManager {
  public constructor(private readonly github: ProjectAdministrationGateway) {}

  public async plan(rawDeclaration: unknown): Promise<ProjectConfigurationPlan> {
    const declaration = parseDeliveryProjectDeclaration(rawDeclaration);
    const project = await this.github.discoverProject(declaration);
    return planProjectConfiguration(declaration, project);
  }

  public async validate(rawDeclaration: unknown): Promise<CompiledProjectBinding> {
    const declaration = parseDeliveryProjectDeclaration(rawDeclaration);
    const project = await this.github.discoverProject(declaration);
    if (project === undefined) {
      throw new ProjectConfigurationError(
        `GitHub Project for declaration ${declaration.metadata.name} was not found`,
        [
          declaration.github.projectNumber === undefined
            ? `no Project titled ${declaration.github.title} exists under ${declaration.github.owner}`
            : `Project ${declaration.github.owner}#${declaration.github.projectNumber.toString()} does not exist`,
        ],
      );
    }
    return compileProjectBinding(declaration, project);
  }

  public async apply(rawDeclaration: unknown): Promise<ProjectApplyResult> {
    const declaration = parseDeliveryProjectDeclaration(rawDeclaration);
    const applied: ProjectConfigurationPlan["actions"] = [];
    for (let pass = 0; pass < 250; pass += 1) {
      const project = await this.github.discoverProject(declaration);
      const plan = planProjectConfiguration(declaration, project);
      if (plan.conflicts.length > 0) throw conflictsError(declaration, plan);
      const action = plan.actions[0];
      if (action === undefined) {
        if (project === undefined) {
          throw new ProjectConfigurationError(
            `Project apply for ${declaration.metadata.name} made no progress`,
            ["Project was not discovered after reconciliation"],
          );
        }
        return { binding: compileProjectBinding(declaration, project), applied };
      }
      await this.applyAction(declaration, project, action);
      applied.push(action);
    }
    throw new ProjectConfigurationError(
      `Project apply for ${declaration.metadata.name} exceeded its convergence limit`,
      ["The Project continued to drift while reconciliation was running"],
    );
  }

  public async adopt(rawDeclaration: unknown): Promise<{
    declaration: DeliveryProjectDeclaration;
    binding: CompiledProjectBinding;
  }> {
    const declaration = parseDeliveryProjectDeclaration(rawDeclaration);
    const project = await this.github.discoverProject(declaration);
    if (project === undefined) {
      throw new ProjectConfigurationError(
        `GitHub Project for declaration ${declaration.metadata.name} was not found`,
        [`no unambiguous Project target could be adopted under ${declaration.github.owner}`],
      );
    }
    const adopted = parseDeliveryProjectDeclaration({
      ...declaration,
      github: { ...declaration.github, projectNumber: project.number },
    });
    return { declaration: adopted, binding: compileProjectBinding(adopted, project) };
  }

  private async applyAction(
    declaration: DeliveryProjectDeclaration,
    project: DiscoveredProject | undefined,
    action: ProjectConfigurationPlan["actions"][number],
  ): Promise<void> {
    switch (action.kind) {
      case "create_project":
        await this.github.createProject(declaration);
        return;
      case "update_project":
        await this.github.updateProject(action.projectId, action.changes);
        return;
      case "create_field": {
        const field = declaration.github.fields[action.semanticField];
        if (field === undefined) throw missingDeclaredField(action.semanticField);
        const projectId = project?.id ?? action.projectId;
        if (projectId === undefined) throw missingProject(action.kind);
        await this.github.createField(projectId, { semanticField: action.semanticField, field });
        return;
      }
      case "extend_select_options":
        await this.github.updateSelectOptions(action.fieldId, action.options);
        return;
      case "link_repository": {
        const projectId = project?.id ?? action.projectId;
        if (projectId === undefined) throw missingProject(action.kind);
        await this.github.linkRepository(projectId, action.repository);
        return;
      }
      case "create_view": {
        const projectId = project?.id ?? action.projectId;
        if (projectId === undefined || project === undefined) throw missingProject(action.kind);
        const visibleFieldIds = resolveViewFieldIds(action.view, declaration, project);
        if (visibleFieldIds === undefined) {
          throw new ProjectConfigurationError(
            `Cannot create Project view ${action.view.name} before its fields exist`,
            ["Re-run project apply so field reconciliation can converge first"],
          );
        }
        await this.github.createView(projectId, {
          semanticView: action.semanticView,
          view: action.view,
          visibleFieldIds,
        });
        return;
      }
      case "update_view":
        await this.github.updateView(action.viewId, action.changes);
        return;
    }
  }
}

export class OctokitProjectAdministrationGateway implements ProjectAdministrationGateway {
  private readonly octokit: Octokit;

  public constructor(options: OctokitClientOptions) {
    this.octokit = createOctokit(options);
  }

  public async discoverProject(
    declaration: DeliveryProjectDeclaration,
  ): Promise<DiscoveredProject | undefined> {
    try {
      const projectId = await this.findProjectId(declaration);
      return projectId === undefined
        ? undefined
        : await this.loadProject(projectId, declaration.github.owner);
    } catch (error) {
      throw normalizeGitHubError(error);
    }
  }

  public async createProject(declaration: DeliveryProjectDeclaration): Promise<void> {
    try {
      if ((await this.findProjectId(declaration)) !== undefined) return;
      const ownerId = await this.ownerId(declaration.github.owner, declaration.github.ownerType);
      await this.octokit.graphql(
        `mutation ThorCreateProject($owner: ID!, $title: String!) {
          createProjectV2(input: {ownerId: $owner, title: $title}) {
            projectV2 { id number }
          }
        }`,
        { owner: ownerId, title: declaration.github.title },
      );
    } catch (error) {
      if ((await this.discoverProject(declaration).catch(() => undefined)) !== undefined) return;
      throw normalizeGitHubError(error);
    }
  }

  public async updateProject(projectId: string, changes: ProjectMetadataChanges): Promise<void> {
    try {
      await this.octokit.graphql(
        `mutation ThorUpdateProject($input: UpdateProjectV2Input!) {
          updateProjectV2(input: $input) { projectV2 { id } }
        }`,
        { input: { projectId, ...changes } },
      );
    } catch (error) {
      throw normalizeGitHubError(error);
    }
  }

  public async createField(projectId: string, input: ProjectFieldCreateInput): Promise<void> {
    try {
      const variables =
        input.field.type === "single_select"
          ? {
              projectId,
              dataType: "SINGLE_SELECT",
              name: input.field.name,
              singleSelectOptions: Object.values(input.field.options).map(optionInput),
            }
          : { projectId, dataType: "TEXT", name: input.field.name };
      await this.octokit.graphql(
        `mutation ThorCreateProjectField($input: CreateProjectV2FieldInput!) {
          createProjectV2Field(input: $input) { projectV2Field { ... on Node { id } } }
        }`,
        { input: variables },
      );
    } catch (error) {
      throw normalizeGitHubError(error);
    }
  }

  public async updateSelectOptions(fieldId: string, options: SelectOptionInput[]): Promise<void> {
    try {
      await this.octokit.graphql(
        `mutation ThorUpdateProjectField($input: UpdateProjectV2FieldInput!) {
          updateProjectV2Field(input: $input) { projectV2Field { ... on Node { id } } }
        }`,
        { input: { fieldId, singleSelectOptions: options } },
      );
    } catch (error) {
      throw normalizeGitHubError(error);
    }
  }

  public async linkRepository(projectId: string, repository: ProjectRepository): Promise<void> {
    try {
      const response: unknown = await this.octokit.graphql(
        `query ThorRepositoryId($owner: String!, $name: String!) {
          repository(owner: $owner, name: $name) { id }
        }`,
        { owner: repository.owner, name: repository.name },
      );
      const repositoryId = z
        .object({ repository: z.object({ id: z.string().min(1) }).nullable() })
        .parse(response).repository?.id;
      if (repositoryId === undefined) {
        throw new ProjectConfigurationError(
          `Repository ${repository.owner}/${repository.name} was not found`,
          ["The authenticated GitHub identity must be able to read the declared repository"],
        );
      }
      await this.octokit.graphql(
        `mutation ThorLinkProjectRepository($project: ID!, $repository: ID!) {
          linkProjectV2ToRepository(input: {projectId: $project, repositoryId: $repository}) {
            repository { id }
          }
        }`,
        { project: projectId, repository: repositoryId },
      );
    } catch (error) {
      throw normalizeGitHubError(error);
    }
  }

  public async createView(projectId: string, input: ProjectViewCreateInput): Promise<void> {
    try {
      await this.octokit.graphql(
        `mutation ThorCreateProjectView($input: CreateProjectV2ViewInput!) {
          createProjectV2View(input: $input) { projectV2View { id } }
        }`,
        {
          input: {
            projectId,
            name: input.view.name,
            layout: input.view.layout,
            configuration: { visibleFieldIds: input.visibleFieldIds },
          },
        },
      );
    } catch (error) {
      throw normalizeGitHubError(error);
    }
  }

  public async updateView(viewId: string, changes: ProjectViewChanges): Promise<void> {
    try {
      const { visibleFieldIds, ...metadata } = changes;
      await this.octokit.graphql(
        `mutation ThorUpdateProjectView($input: UpdateProjectV2ViewInput!) {
          updateProjectV2View(input: $input) { projectV2View { id } }
        }`,
        {
          input: {
            viewId,
            ...metadata,
            ...(visibleFieldIds === undefined ? {} : { configuration: { visibleFieldIds } }),
          },
        },
      );
    } catch (error) {
      throw normalizeGitHubError(error);
    }
  }

  private async ownerId(owner: string, ownerType: "organization" | "user"): Promise<string> {
    const root = ownerType === "organization" ? "organization" : "user";
    const response: unknown = await this.octokit.graphql(
      `query ThorProjectOwner($login: String!) {
        ${root}(login: $login) { id }
      }`,
      { login: owner },
    );
    const parsed = z.record(z.string(), z.object({ id: z.string() }).nullable()).parse(response);
    const id = parsed[root]?.id;
    if (id === undefined) {
      throw new ProjectConfigurationError(`GitHub ${ownerType} ${owner} was not found`, [
        "The authenticated GitHub identity must be able to read the declared Project owner",
      ]);
    }
    return id;
  }

  private async findProjectId(
    declaration: DeliveryProjectDeclaration,
  ): Promise<string | undefined> {
    if (declaration.github.projectNumber !== undefined) {
      return this.projectIdByNumber(declaration);
    }
    const matches = await this.projectIdsByTitle(declaration);
    if (matches.length > 1) {
      throw new ProjectConfigurationError(
        `More than one Project titled ${declaration.github.title} exists under ${declaration.github.owner}`,
        ["Set github.projectNumber in the declaration to select an unambiguous Project"],
      );
    }
    return matches[0];
  }

  private async projectIdByNumber(
    declaration: DeliveryProjectDeclaration,
  ): Promise<string | undefined> {
    const root = declaration.github.ownerType === "organization" ? "organization" : "user";
    const response: unknown = await this.octokit.graphql(
      `query ThorProjectByNumber($login: String!, $number: Int!) {
        ${root}(login: $login) { projectV2(number: $number) { id } }
      }`,
      {
        login: declaration.github.owner,
        number: declaration.github.projectNumber,
      },
    );
    const parsed = ownerProjectResponseSchema.parse(response);
    return parsed[root]?.projectV2?.id ?? undefined;
  }

  private async projectIdsByTitle(declaration: DeliveryProjectDeclaration): Promise<string[]> {
    const root = declaration.github.ownerType === "organization" ? "organization" : "user";
    const matches: string[] = [];
    let cursor: string | undefined;
    do {
      const response: unknown = await this.octokit.graphql(
        `query ThorProjectsByTitle($login: String!, $after: String) {
          ${root}(login: $login) {
            projectsV2(first: 100, after: $after) {
              nodes { id title }
              pageInfo { hasNextPage endCursor }
            }
          }
        }`,
        { login: declaration.github.owner, ...(cursor === undefined ? {} : { after: cursor }) },
      );
      const parsed = ownerProjectsResponseSchema.parse(response);
      const projects = parsed[root]?.projectsV2;
      if (projects === undefined) return matches;
      matches.push(
        ...projects.nodes
          .filter(
            (project): project is NonNullable<typeof project> =>
              project !== null && project.title === declaration.github.title,
          )
          .map((project) => project.id),
      );
      cursor = projects.pageInfo.hasNextPage
        ? (projects.pageInfo.endCursor ?? undefined)
        : undefined;
    } while (cursor !== undefined);
    return matches;
  }

  private async loadProject(projectId: string, owner: string): Promise<DiscoveredProject> {
    const [base, fields, repositories, views] = await Promise.all([
      this.loadProjectBase(projectId),
      this.loadProjectFields(projectId),
      this.loadProjectRepositories(projectId),
      this.loadProjectViews(projectId),
    ]);
    return {
      ...base,
      owner,
      fields,
      repositories,
      views,
    };
  }

  private async loadProjectBase(
    projectId: string,
  ): Promise<Omit<DiscoveredProject, "owner" | "fields" | "repositories" | "views">> {
    const response: unknown = await this.octokit.graphql(
      `query ThorProjectBase($id: ID!) {
        node(id: $id) {
          ... on ProjectV2 {
            id number title shortDescription readme public url
          }
        }
      }`,
      { id: projectId },
    );
    const project = projectBaseResponseSchema.parse(response).node;
    if (project === null) {
      throw new ProjectConfigurationError(`GitHub Project ${projectId} was not found`, [
        "The Project may have been deleted during reconciliation",
      ]);
    }
    return project;
  }

  private async loadProjectFields(projectId: string): Promise<DiscoveredProjectField[]> {
    const fields: DiscoveredProjectField[] = [];
    let cursor: string | undefined;
    do {
      const response: unknown = await this.octokit.graphql(
        `query ThorProjectFields($id: ID!, $after: String) {
          node(id: $id) {
            ... on ProjectV2 {
              fields(first: 100, after: $after) {
                nodes {
                  __typename
                  ... on ProjectV2Field { id name dataType }
                  ... on ProjectV2SingleSelectField {
                    id name dataType
                    options { id name description color }
                  }
                }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }`,
        { id: projectId, ...(cursor === undefined ? {} : { after: cursor }) },
      );
      const connection = projectFieldsResponseSchema.parse(response).node?.fields;
      if (connection === undefined) break;
      for (const field of connection.nodes) {
        if (field === null) continue;
        const textField = projectTextFieldSchema.safeParse(field);
        if (textField.success && textField.data.dataType === "TEXT") {
          fields.push({ id: textField.data.id, name: textField.data.name, type: "text" });
          continue;
        }
        const selectField = projectSelectFieldSchema.safeParse(field);
        if (selectField.success) {
          fields.push({
            id: selectField.data.id,
            name: selectField.data.name,
            type: "single_select",
            options: selectField.data.options,
          });
        }
      }
      cursor = connection.pageInfo.hasNextPage
        ? (connection.pageInfo.endCursor ?? undefined)
        : undefined;
    } while (cursor !== undefined);
    return fields;
  }

  private async loadProjectRepositories(
    projectId: string,
  ): Promise<DiscoveredProject["repositories"]> {
    const repositories: DiscoveredProject["repositories"] = [];
    let cursor: string | undefined;
    do {
      const response: unknown = await this.octokit.graphql(
        `query ThorProjectRepositories($id: ID!, $after: String) {
          node(id: $id) {
            ... on ProjectV2 {
              repositories(first: 100, after: $after) {
                nodes { id name owner { login } }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }`,
        { id: projectId, ...(cursor === undefined ? {} : { after: cursor }) },
      );
      const connection = projectRepositoriesResponseSchema.parse(response).node?.repositories;
      if (connection === undefined) break;
      repositories.push(
        ...connection.nodes
          .filter((repository): repository is NonNullable<typeof repository> => repository !== null)
          .map((repository) => ({
            id: repository.id,
            owner: repository.owner.login,
            name: repository.name,
          })),
      );
      cursor = connection.pageInfo.hasNextPage
        ? (connection.pageInfo.endCursor ?? undefined)
        : undefined;
    } while (cursor !== undefined);
    return repositories;
  }

  private async loadProjectViews(projectId: string): Promise<DiscoveredProject["views"]> {
    const views: DiscoveredProject["views"] = [];
    let cursor: string | undefined;
    do {
      const response: unknown = await this.octokit.graphql(
        `query ThorProjectViews($id: ID!, $after: String) {
          node(id: $id) {
            ... on ProjectV2 {
              views(first: 100, after: $after) {
                nodes {
                  id number name layout filter
                  configuration {
                    visibleFields(first: 100) {
                      nodes { ... on Node { id } }
                      pageInfo { hasNextPage endCursor }
                    }
                  }
                }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }`,
        { id: projectId, ...(cursor === undefined ? {} : { after: cursor }) },
      );
      const connection = projectViewsResponseSchema.parse(response).node?.views;
      if (connection === undefined) break;
      for (const view of connection.nodes) {
        if (view === null) continue;
        if (view.configuration.visibleFields.pageInfo.hasNextPage) {
          throw new ProjectConfigurationError(
            `Project view ${view.name} has more than 100 visible fields`,
            ["Thor refuses to validate an incomplete view configuration"],
          );
        }
        views.push({
          id: view.id,
          number: view.number,
          name: view.name,
          layout: view.layout,
          filter: view.filter,
          visibleFieldIds: view.configuration.visibleFields.nodes.flatMap((field) =>
            field === null ? [] : [field.id],
          ),
        });
      }
      cursor = connection.pageInfo.hasNextPage
        ? (connection.pageInfo.endCursor ?? undefined)
        : undefined;
    } while (cursor !== undefined);
    return views;
  }
}

const pageInfoSchema = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable(),
});

const ownerProjectResponseSchema = z.record(
  z.string(),
  z.object({ projectV2: z.object({ id: z.string() }).nullable() }).nullable(),
);

const ownerProjectsResponseSchema = z.record(
  z.string(),
  z
    .object({
      projectsV2: z.object({
        nodes: z.array(z.object({ id: z.string(), title: z.string() }).nullable()),
        pageInfo: pageInfoSchema,
      }),
    })
    .nullable(),
);

const projectBaseResponseSchema = z.object({
  node: z
    .object({
      id: z.string().min(1),
      number: z.number().int().positive(),
      title: z.string().min(1),
      shortDescription: z.string().nullable().optional(),
      readme: z.string().nullable().optional(),
      public: z.boolean(),
      url: z.url(),
    })
    .nullable(),
});

const projectTextFieldSchema = z.object({
  __typename: z.literal("ProjectV2Field"),
  id: z.string(),
  name: z.string(),
  dataType: z.string(),
});

const projectSelectFieldSchema = z.object({
  __typename: z.literal("ProjectV2SingleSelectField"),
  id: z.string(),
  name: z.string(),
  dataType: z.literal("SINGLE_SELECT"),
  options: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().nullable().optional(),
      color: projectFieldColorSchema,
    }),
  ),
});

const unknownProjectFieldSchema = z.looseObject({ __typename: z.string() });
const projectFieldsResponseSchema = z.object({
  node: z
    .object({
      fields: z.object({
        nodes: z.array(unknownProjectFieldSchema.nullable()),
        pageInfo: pageInfoSchema,
      }),
    })
    .nullable(),
});

const projectRepositoriesResponseSchema = z.object({
  node: z
    .object({
      repositories: z.object({
        nodes: z.array(
          z
            .object({
              id: z.string(),
              name: z.string(),
              owner: z.object({ login: z.string() }),
            })
            .nullable(),
        ),
        pageInfo: pageInfoSchema,
      }),
    })
    .nullable(),
});

const projectViewsResponseSchema = z.object({
  node: z
    .object({
      views: z.object({
        nodes: z.array(
          z
            .object({
              id: z.string(),
              number: z.number().int().positive(),
              name: z.string(),
              layout: z.enum(["BOARD_LAYOUT", "TABLE_LAYOUT", "ROADMAP_LAYOUT"]),
              filter: z.string().nullable().optional(),
              configuration: z.object({
                visibleFields: z.object({
                  nodes: z.array(z.object({ id: z.string() }).nullable()),
                  pageInfo: pageInfoSchema,
                }),
              }),
            })
            .nullable(),
        ),
        pageInfo: pageInfoSchema,
      }),
    })
    .nullable(),
});

function optionInput(option: {
  name: string;
  description?: string | undefined;
  color: z.infer<typeof projectFieldColorSchema>;
}): SelectOptionInput {
  return {
    name: option.name,
    description: option.description ?? "",
    color: option.color,
  };
}

function conflictsError(
  declaration: DeliveryProjectDeclaration,
  plan: ProjectConfigurationPlan,
): ProjectConfigurationError {
  return new ProjectConfigurationError(
    `GitHub Project has destructive or ambiguous drift from ${declaration.metadata.name}`,
    plan.conflicts.map((conflict) => `${conflict.path}: ${conflict.message}`),
  );
}

function missingDeclaredField(field: ProjectFieldKey): ProjectConfigurationError {
  return new ProjectConfigurationError(`Declared Project field ${field} was not found`, [
    "The reconciliation plan no longer matches the validated declaration",
  ]);
}

function missingProject(action: string): ProjectConfigurationError {
  return new ProjectConfigurationError(`Cannot ${action} before the Project exists`, [
    "Re-run project apply so the find-or-create step can converge",
  ]);
}
