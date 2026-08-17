import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { parseDeliveryProjectDeclaration, type DeliveryProjectDeclaration } from "@thor/config";
import { loadDeliveryProjectDeclaration } from "@thor/config/node";
import {
  approvalPolicySchema,
  deferredIssueIdSchema,
  projectItemIdSchema,
  redactKnownSecrets,
  type ApprovalPolicy,
  type DeferredIssueId,
  type ProjectItemId,
  type RepositoryRef,
  type TicketStatus,
} from "@thor/domain";
import {
  createOctokit,
  normalizeGitHubError,
  OctokitProjectAdministrationGateway,
  ProjectConfigurationManager,
  type GitHubProjectConfiguration,
} from "@thor/github";
import { isRetryableGitHubFailure, retryInfrastructureOperation } from "@thor/runtime";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const apiVersion = "2026-03-10";

const emptyToUndefined = (value: unknown): unknown => (value === "" ? undefined : value);
const optionalString = z.preprocess(emptyToUndefined, z.string().trim().min(1).optional());
const liveEnvironmentSchema = z.object({
  THOR_LIVE_REPOSITORY: z
    .string()
    .trim()
    .regex(/^[^/\s]+\/[^/\s]+$/),
  THOR_LIVE_PROJECT_OWNER: optionalString,
  THOR_LIVE_PROJECT_NUMBER: z.coerce.number().int().positive(),
  THOR_LIVE_STATUS_FIELD: z.string().trim().min(1).default("Thor Status"),
  THOR_LIVE_POLL_INTERVAL_MS: z.coerce.number().int().min(5_000).default(5_000),
  THOR_LIVE_TIMEOUT_MS: z.coerce.number().int().min(30_000).default(300_000),
  THOR_LIVE_CLEANUP: z.enum(["success", "always", "never"]).default("success"),
  THOR_LIVE_RUN_ROOT: z.string().trim().min(1).default(".thor-live-runs"),
  GITHUB_TOKEN: optionalString,
});

export type LiveTestConfiguration = {
  repository: RepositoryRef;
  projectOwner: string;
  projectNumber: number;
  statusFieldName: string;
  pollIntervalMs: number;
  timeoutMs: number;
  cleanup: "success" | "always" | "never";
  runRoot: string;
  token: string;
};

export async function loadLiveTestConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<LiveTestConfiguration> {
  const parsed = liveEnvironmentSchema.parse(environment);
  const repository = parseRepository(parsed.THOR_LIVE_REPOSITORY);
  return {
    repository,
    projectOwner: parsed.THOR_LIVE_PROJECT_OWNER ?? repository.owner,
    projectNumber: parsed.THOR_LIVE_PROJECT_NUMBER,
    statusFieldName: parsed.THOR_LIVE_STATUS_FIELD,
    pollIntervalMs: parsed.THOR_LIVE_POLL_INTERVAL_MS,
    timeoutMs: parsed.THOR_LIVE_TIMEOUT_MS,
    cleanup: parsed.THOR_LIVE_CLEANUP,
    runRoot: path.resolve(parsed.THOR_LIVE_RUN_ROOT),
    token: parsed.GITHUB_TOKEN ?? (await githubCliToken()),
  };
}

export function createLiveRunId(): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}

export type LiveProject = {
  id: string;
  number: number;
  title: string;
  url: string;
  declaration: DeliveryProjectDeclaration;
  gateway: GitHubProjectConfiguration;
};

export type LiveFixture = {
  issueId: string;
  issueNumber: number;
  issueUrl: string;
  projectItemId: ProjectItemId;
};

export type LiveRelatedIssue = {
  issueId: DeferredIssueId;
  issueNumber: number;
  issueUrl: string;
  projectItemId: ProjectItemId;
};

export type LiveComment = {
  id: number;
  url: string;
};

const manifestDataSchema = z.object({
  version: z.literal(1),
  runId: z.string().min(1),
  startedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  state: z.enum(["initializing", "provisioned", "running", "passed", "failed", "cleaned"]),
  repository: z.string().min(3),
  projectOwner: z.string().min(1),
  projectNumber: z.number().int().positive(),
  projectId: z.string().min(1).optional(),
  projectUrl: z.url().optional(),
  issueId: z.string().min(1).optional(),
  issueNumber: z.number().int().positive().optional(),
  issueUrl: z.url().optional(),
  projectItemId: projectItemIdSchema.optional(),
  workflowId: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  pullRequestNumber: z.number().int().positive().optional(),
  pullRequestUrl: z.url().optional(),
  mergeCommitSha: z.string().min(1).optional(),
  comments: z.array(z.object({ id: z.number().int().positive(), url: z.url() })).optional(),
  relatedIssues: z
    .array(
      z.object({
        issueId: deferredIssueIdSchema,
        issueNumber: z.number().int().positive(),
        issueUrl: z.url(),
        projectItemId: projectItemIdSchema,
      }),
    )
    .optional(),
  failure: z.string().optional(),
  cleanedAt: z.iso.datetime().optional(),
});

type ManifestData = z.infer<typeof manifestDataSchema>;

export class LiveRunManifest {
  private constructor(
    public readonly filePath: string,
    private readonly data: ManifestData,
  ) {}

  public static async create(
    configuration: LiveTestConfiguration,
    runId: string,
  ): Promise<LiveRunManifest> {
    await mkdir(configuration.runRoot, { recursive: true });
    const now = new Date().toISOString();
    const manifest = new LiveRunManifest(path.join(configuration.runRoot, `${runId}.json`), {
      version: 1,
      runId,
      startedAt: now,
      updatedAt: now,
      state: "initializing",
      repository: `${configuration.repository.owner}/${configuration.repository.name}`,
      projectOwner: configuration.projectOwner,
      projectNumber: configuration.projectNumber,
    });
    await manifest.write();
    return manifest;
  }

  public static async load(filePath: string): Promise<LiveRunManifest> {
    const absolutePath = path.resolve(filePath);
    const raw: unknown = JSON.parse(await readFile(absolutePath, "utf8"));
    return new LiveRunManifest(absolutePath, manifestDataSchema.parse(raw));
  }

  public snapshot(): ManifestData {
    return manifestDataSchema.parse(this.data);
  }

  public async recordProject(project: LiveProject): Promise<void> {
    this.data.projectId = project.id;
    this.data.projectUrl = project.url;
    await this.write();
  }

  public async recordFixture(fixture: LiveFixture): Promise<void> {
    this.data.issueId = fixture.issueId;
    this.data.issueNumber = fixture.issueNumber;
    this.data.issueUrl = fixture.issueUrl;
    this.data.projectItemId = fixture.projectItemId;
    this.data.workflowId = `github-project-item:${fixture.projectItemId}`;
    this.data.state = "provisioned";
    await this.write();
  }

  public async markRunning(): Promise<void> {
    this.data.state = "running";
    await this.write();
  }

  public async recordBranch(branch: string): Promise<void> {
    this.data.branch = branch;
    await this.write();
  }

  public async recordDelivery(input: {
    branch: string;
    pullRequestNumber: number;
    pullRequestUrl: string;
    mergeCommitSha?: string;
  }): Promise<void> {
    this.data.branch = input.branch;
    this.data.pullRequestNumber = input.pullRequestNumber;
    this.data.pullRequestUrl = input.pullRequestUrl;
    if (input.mergeCommitSha !== undefined) this.data.mergeCommitSha = input.mergeCommitSha;
    await this.write();
  }

  public async recordComments(comments: LiveComment[]): Promise<void> {
    this.data.comments = comments;
    await this.write();
  }

  public async recordRelatedIssues(issues: LiveRelatedIssue[]): Promise<void> {
    this.data.relatedIssues = issues;
    await this.write();
  }

  public async markPassed(): Promise<void> {
    this.data.state = "passed";
    await this.write();
  }

  public async markFailed(error: unknown): Promise<void> {
    this.data.state = "failed";
    this.data.failure = redactKnownSecrets(error instanceof Error ? error.message : String(error));
    await this.write();
  }

  public async markCleaned(): Promise<void> {
    this.data.state = "cleaned";
    this.data.cleanedAt = new Date().toISOString();
    await this.write();
  }

  private async write(): Promise<void> {
    this.data.updatedAt = new Date().toISOString();
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.filePath);
  }
}

export class LiveGitHubFixtureManager {
  private readonly api: GitHubApi;
  private project: LiveProject | undefined;

  public constructor(
    private readonly configuration: LiveTestConfiguration,
    private readonly manifest: LiveRunManifest,
  ) {
    this.api = new GitHubApi(configuration.token, configuration.timeoutMs);
  }

  public async prepare(): Promise<LiveProject> {
    const repository = await this.api.rest(
      `/repos/${encodeURIComponent(this.configuration.repository.owner)}/${encodeURIComponent(this.configuration.repository.name)}`,
      { method: "GET" },
      repositorySchema,
    );
    if (!repository.private) {
      throw new Error(`live test repository ${repository.full_name} must be private`);
    }
    if (repository.archived) {
      throw new Error(`live test repository ${repository.full_name} is archived`);
    }
    if (repository.default_branch !== "main") {
      throw new Error(
        `live test repository ${repository.full_name} must use main as its default branch`,
      );
    }

    const response = await this.api.graphql(
      projectQuery,
      {
        owner: this.configuration.projectOwner,
        number: this.configuration.projectNumber,
        statusField: this.configuration.statusFieldName,
      },
      projectQuerySchema,
    );
    const owner = response.repositoryOwner;
    const rawProject = owner?.projectV2;
    if (rawProject === undefined || rawProject === null) {
      throw new Error(
        `GitHub Project ${this.configuration.projectOwner}#${this.configuration.projectNumber} was not found`,
      );
    }
    const ownerType = owner?.__typename === "User" ? "user" : "organization";
    if (rawProject.public) throw new Error(`live test Project ${rawProject.url} must be private`);
    if (rawProject.closed) throw new Error(`live test Project ${rawProject.url} is closed`);
    if (rawProject.items.pageInfo.hasNextPage) {
      throw new Error(
        `live test Project ${rawProject.url} has more than 100 items; refusing an incomplete safety check`,
      );
    }
    const preexistingEligibleItems = rawProject.items.nodes.filter(
      (item) => item?.status?.name === "Design / Blueprint" || item?.status?.name === "Ready",
    );
    if (preexistingEligibleItems.length > 0) {
      throw new Error(
        `live test Project ${rawProject.url} contains ${preexistingEligibleItems.length.toString()} pre-existing eligible item(s); use a dedicated Project or move them out of Design / Blueprint and Ready`,
      );
    }

    const template = await loadDeliveryProjectDeclaration(
      path.resolve("config/templates/default-delivery.json"),
    );
    const declaration = parseDeliveryProjectDeclaration({
      ...template,
      metadata: { ...template.metadata, name: "live-default-delivery" },
      github: {
        ...template.github,
        owner: this.configuration.projectOwner,
        ownerType,
        projectNumber: this.configuration.projectNumber,
        title: rawProject.title,
        repositories: [{ ...this.configuration.repository, baseBranch: "main" }],
        views: {},
        fields: {
          ...template.github.fields,
          lifecycle: {
            ...template.github.fields.lifecycle,
            name: this.configuration.statusFieldName,
          },
        },
      },
    });
    const binding = await new ProjectConfigurationManager(
      new OctokitProjectAdministrationGateway({
        auth: { kind: "token", token: this.configuration.token },
        apiVersion,
      }),
    ).validate(declaration);
    const project: LiveProject = {
      id: rawProject.id,
      number: rawProject.number,
      title: rawProject.title,
      url: rawProject.url,
      declaration,
      gateway: {
        projectId: binding.project.id,
        fields: binding.fields,
        ticketDefaults: binding.ticketDefaults,
        dependencyCompletion: binding.delivery.workflow.dependencies.completion,
        doneOptionId:
          binding.fields.lifecycle.options[binding.delivery.workflow.board.states.done] ?? "",
      },
    };
    this.project = project;
    await this.manifest.recordProject(project);
    return project;
  }

  public async createFixture(
    runId: string,
    filePath: string,
    input: { approvalPolicy?: ApprovalPolicy; scenario?: string } = {},
  ): Promise<LiveFixture> {
    const project = this.requireProject();
    const approvalPolicy = approvalPolicySchema.parse(input.approvalPolicy ?? "autonomous");
    const scenario = input.scenario ?? "autonomous delivery";
    const title = `[Thor live ${runId}] ${scenario}`;
    const body = [
      "This issue is an isolated Thor live end-to-end fixture.",
      "",
      `<!-- thor:live-run:${runId} -->`,
      "",
      "## Acceptance criteria",
      "",
      `- [ ] \`${filePath}\` exists and contains \`${runId}\`.`,
    ].join("\n");
    const issue = await this.ensureFixtureIssue(title, body);
    const projectItemId = await this.ensureProjectItem(project.id, issue.node_id);
    const fixture = {
      issueId: issue.node_id,
      issueNumber: issue.number,
      issueUrl: issue.html_url,
      projectItemId,
    };
    await this.manifest.recordFixture(fixture);

    await this.setSingleSelect(projectItemId, project.gateway.fields.workType, "feature");
    await this.setSingleSelect(projectItemId, project.gateway.fields.priority, "P2");
    await this.setText(projectItemId, project.gateway.fields.component, "live-e2e");
    await this.setSingleSelect(projectItemId, project.gateway.fields.executionMode, "agent");
    await this.setSingleSelect(projectItemId, project.gateway.fields.planningDepth, "full");
    await this.setSingleSelect(
      projectItemId,
      project.gateway.fields.approvalPolicy,
      approvalPolicy,
    );
    await this.setSingleSelect(projectItemId, project.gateway.fields.agentPolicy, "preferred");
    await this.setSingleSelect(projectItemId, project.gateway.fields.lifecycle, "design_blueprint");

    return fixture;
  }

  private async ensureFixtureIssue(
    title: string,
    body: string,
  ): Promise<z.infer<typeof issueSchema>> {
    return retryInfrastructureOperation(async () => {
      const existing = await this.findFixtureIssue(title);
      if (existing !== undefined) return existing;
      try {
        return await this.api.rest(
          `/repos/${encodeURIComponent(this.configuration.repository.owner)}/${encodeURIComponent(this.configuration.repository.name)}/issues`,
          { method: "POST", body: JSON.stringify({ title, body }) },
          issueSchema,
          false,
        );
      } catch (error) {
        const recovered = await this.findFixtureIssue(title);
        if (recovered !== undefined) return recovered;
        throw error;
      }
    }, this.liveRetryOptions());
  }

  private async findFixtureIssue(title: string): Promise<z.infer<typeof issueSchema> | undefined> {
    const issues = await this.api.rest(
      `/repos/${encodeURIComponent(this.configuration.repository.owner)}/${encodeURIComponent(this.configuration.repository.name)}/issues?state=all&per_page=100`,
      { method: "GET" },
      issueListSchema,
    );
    return issues.find((issue) => issue.title === title);
  }

  private async ensureProjectItem(projectId: string, issueId: string): Promise<ProjectItemId> {
    return retryInfrastructureOperation(async () => {
      const existing = await this.api.graphql(issueByIdQuery, { issue: issueId }, issueByIdSchema);
      const existingItem = existing.node?.projectItems.nodes.find(
        (item) => item?.project.id === projectId,
      );
      if (existingItem !== undefined && existingItem !== null) {
        return projectItemIdSchema.parse(existingItem.id);
      }
      try {
        const added = await this.api.graphql(
          addProjectItemMutation,
          { project: projectId, content: issueId },
          addProjectItemSchema,
          false,
        );
        return projectItemIdSchema.parse(added.addProjectV2ItemById.item.id);
      } catch (error) {
        const recovered = await this.api.graphql(
          issueByIdQuery,
          { issue: issueId },
          issueByIdSchema,
        );
        const recoveredItem = recovered.node?.projectItems.nodes.find(
          (item) => item?.project.id === projectId,
        );
        if (recoveredItem !== undefined && recoveredItem !== null) {
          return projectItemIdSchema.parse(recoveredItem.id);
        }
        throw error;
      }
    }, this.liveRetryOptions());
  }

  private liveRetryOptions(): Parameters<typeof retryInfrastructureOperation>[1] {
    return {
      retries: 8,
      maxRetryTimeMs: this.configuration.timeoutMs,
      shouldRetry: isRetryableGitHubFailure,
    };
  }

  public async pullRequest(number: number): Promise<z.infer<typeof pullRequestSchema>> {
    return this.api.rest(
      `/repos/${encodeURIComponent(this.configuration.repository.owner)}/${encodeURIComponent(this.configuration.repository.name)}/pulls/${number}`,
      { method: "GET" },
      pullRequestSchema,
    );
  }

  public async issueComments(issueNumber: number): Promise<z.infer<typeof commentsSchema>> {
    return this.api.rest(
      `/repos/${encodeURIComponent(this.configuration.repository.owner)}/${encodeURIComponent(this.configuration.repository.name)}/issues/${issueNumber}/comments?per_page=100`,
      { method: "GET" },
      commentsSchema,
    );
  }

  public async setStatus(projectItemId: ProjectItemId, status: TicketStatus): Promise<void> {
    await this.setSingleSelect(
      projectItemId,
      this.requireProject().gateway.fields.lifecycle,
      status,
    );
  }

  public async removeProjectItem(projectItemId: ProjectItemId): Promise<void> {
    await this.deleteProjectItem(this.requireProject().id, projectItemId);
  }

  public async relatedIssue(issueId: DeferredIssueId): Promise<LiveRelatedIssue> {
    const project = this.requireProject();
    const response = await this.api.graphql(issueByIdQuery, { issue: issueId }, issueByIdSchema);
    if (response.node === null) throw new Error(`deferred issue ${issueId} was not found`);
    const projectItem = response.node.projectItems.nodes.find(
      (item) => item?.project.id === project.id,
    );
    if (projectItem === undefined || projectItem === null) {
      throw new Error(`deferred issue ${issueId} is not in live Project ${project.url}`);
    }
    return {
      issueId: deferredIssueIdSchema.parse(response.node.id),
      issueNumber: response.node.number,
      issueUrl: response.node.url,
      projectItemId: projectItemIdSchema.parse(projectItem.id),
    };
  }

  public async cleanup(input: {
    fixture: LiveFixture;
    branch?: string;
    pullRequestNumber?: number;
    relatedIssues?: LiveRelatedIssue[];
  }): Promise<void> {
    const project = this.requireProject();
    if (input.pullRequestNumber !== undefined) {
      await this.api.restVoid(
        `/repos/${encodeURIComponent(this.configuration.repository.owner)}/${encodeURIComponent(this.configuration.repository.name)}/pulls/${input.pullRequestNumber}`,
        { method: "PATCH", body: JSON.stringify({ state: "closed" }) },
        [404, 422],
      );
    }
    if (input.branch !== undefined) {
      const encodedRef = ["heads", ...input.branch.split("/")].map(encodeURIComponent).join("/");
      await this.api.restVoid(
        `/repos/${encodeURIComponent(this.configuration.repository.owner)}/${encodeURIComponent(this.configuration.repository.name)}/git/refs/${encodedRef}`,
        { method: "DELETE" },
        [404, 422],
      );
    }
    for (const related of input.relatedIssues ?? []) {
      await this.deleteProjectItem(project.id, related.projectItemId);
      await this.closeIssue(related.issueNumber);
    }
    await this.deleteProjectItem(project.id, input.fixture.projectItemId);
    await this.closeIssue(input.fixture.issueNumber);
    await this.manifest.markCleaned();
  }

  public async cleanupRecordedArtifacts(): Promise<void> {
    const data = this.manifest.snapshot();
    const configuredRepository = `${this.configuration.repository.owner}/${this.configuration.repository.name}`;
    if (
      data.repository !== configuredRepository ||
      data.projectOwner !== this.configuration.projectOwner ||
      data.projectNumber !== this.configuration.projectNumber
    ) {
      throw new Error(
        `manifest target ${data.repository} ${data.projectOwner}#${data.projectNumber.toString()} does not match live configuration`,
      );
    }
    const repository = await this.api.rest(
      `/repos/${encodeURIComponent(this.configuration.repository.owner)}/${encodeURIComponent(this.configuration.repository.name)}`,
      { method: "GET" },
      repositorySchema,
    );
    if (!repository.private) {
      throw new Error(`cleanup target ${repository.full_name} must be private`);
    }
    if (data.pullRequestNumber !== undefined) {
      await this.api.restVoid(
        `/repos/${encodeURIComponent(this.configuration.repository.owner)}/${encodeURIComponent(this.configuration.repository.name)}/pulls/${data.pullRequestNumber.toString()}`,
        { method: "PATCH", body: JSON.stringify({ state: "closed" }) },
        [404, 422],
      );
    }
    if (data.branch !== undefined) {
      const encodedRef = ["heads", ...data.branch.split("/")].map(encodeURIComponent).join("/");
      await this.api.restVoid(
        `/repos/${encodeURIComponent(this.configuration.repository.owner)}/${encodeURIComponent(this.configuration.repository.name)}/git/refs/${encodedRef}`,
        { method: "DELETE" },
        [404, 422],
      );
    }
    if (data.projectId !== undefined) {
      for (const related of data.relatedIssues ?? []) {
        await this.deleteProjectItem(data.projectId, related.projectItemId);
        await this.closeIssue(related.issueNumber);
      }
      if (data.projectItemId !== undefined) {
        await this.deleteProjectItem(data.projectId, data.projectItemId);
      }
    }
    if (data.issueNumber !== undefined) await this.closeIssue(data.issueNumber);
    await this.manifest.markCleaned();
  }

  private async closeIssue(issueNumber: number): Promise<void> {
    await this.api.restVoid(
      `/repos/${encodeURIComponent(this.configuration.repository.owner)}/${encodeURIComponent(this.configuration.repository.name)}/issues/${issueNumber}`,
      { method: "PATCH", body: JSON.stringify({ state: "closed" }) },
      [404, 422],
    );
  }

  private async deleteProjectItem(projectId: string, projectItemId: ProjectItemId): Promise<void> {
    try {
      await this.api.graphql(
        deleteProjectItemMutation,
        { project: projectId, item: projectItemId },
        deleteProjectItemSchema,
      );
    } catch (error) {
      if (!/could not resolve to a node|not found/i.test(String(error))) throw error;
    }
  }

  private async setSingleSelect(
    projectItemId: ProjectItemId,
    field:
      | GitHubProjectConfiguration["fields"]["lifecycle"]
      | GitHubProjectConfiguration["fields"]["workType"],
    semanticValue: string,
  ): Promise<void> {
    const project = this.requireProject();
    if (field === undefined) {
      throw new Error(`live declaration omits required fixture field for ${semanticValue}`);
    }
    const optionId = field.options[semanticValue];
    if (optionId === undefined) {
      throw new Error(`live binding omits option ${semanticValue}`);
    }
    await this.api.graphql(
      setSingleSelectMutation,
      { project: project.id, item: projectItemId, field: field.fieldId, option: optionId },
      updateProjectItemSchema,
    );
  }

  private async setText(
    projectItemId: ProjectItemId,
    field: GitHubProjectConfiguration["fields"]["component"],
    text: string,
  ): Promise<void> {
    const project = this.requireProject();
    if (field === undefined) throw new Error("live declaration omits the component fixture field");
    await this.api.graphql(
      setTextMutation,
      { project: project.id, item: projectItemId, field: field.fieldId, text },
      updateProjectItemSchema,
    );
  }

  private requireProject(): LiveProject {
    if (this.project === undefined) throw new Error("live Project has not been prepared");
    return this.project;
  }
}

export class GitHubApi {
  private readonly octokit: ReturnType<typeof createOctokit>;

  public constructor(
    token: string,
    private readonly maxRetryTimeMs: number,
    apiUrl?: string,
    retryAfterBaseValueMs = 1_000,
  ) {
    this.octokit = createOctokit({
      auth: { kind: "token", token },
      apiVersion,
      resilience: { requestRetries: 3, retryAfterBaseValueMs },
      ...(apiUrl === undefined ? {} : { apiUrl }),
    });
  }

  public async rest<Output>(
    resourcePath: string,
    init: RequestInit,
    schema: z.ZodType<Output>,
    retry = true,
  ): Promise<Output> {
    return this.execute(async () => {
      const response = await this.octokit.request({
        method: init.method ?? "GET",
        url: resourcePath,
        ...(init.body === undefined || init.body === null
          ? {}
          : { data: parseJsonBody(init.body) }),
        ...(retry ? {} : { request: { retries: 0 } }),
      });
      return schema.parse(response.data);
    }, retry);
  }

  public async restVoid(
    resourcePath: string,
    init: RequestInit,
    ignoredStatuses: number[] = [],
  ): Promise<void> {
    await this.execute(async () => {
      try {
        await this.octokit.request({
          method: init.method ?? "GET",
          url: resourcePath,
          ...(init.body === undefined || init.body === null
            ? {}
            : { data: parseJsonBody(init.body) }),
        });
      } catch (error) {
        const status = errorStatus(error);
        if (status !== undefined && ignoredStatuses.includes(status)) return;
        throw error;
      }
    });
  }

  public async graphql<Output>(
    query: string,
    variables: Readonly<Record<string, unknown>>,
    schema: z.ZodType<Output>,
    retry = true,
  ): Promise<Output> {
    return this.execute(async () => {
      const result: unknown = await this.octokit.graphql(query, {
        ...variables,
        ...(retry ? {} : { request: { retries: 0 } }),
      });
      return schema.parse(result);
    }, retry);
  }

  private async execute<Output>(operation: () => Promise<Output>, retry = true): Promise<Output> {
    const normalized = async (): Promise<Output> => {
      try {
        return await operation();
      } catch (error) {
        throw normalizeGitHubError(error);
      }
    };
    if (!retry) return normalized();
    return retryInfrastructureOperation(normalized, {
      retries: 8,
      maxRetryTimeMs: this.maxRetryTimeMs,
      shouldRetry: isRetryableGitHubFailure,
    });
  }
}

const repositorySchema = z.object({
  full_name: z.string().min(1),
  private: z.boolean(),
  archived: z.boolean(),
  default_branch: z.string().min(1),
});

const issueSchema = z.object({
  node_id: z.string().min(1),
  number: z.number().int().positive(),
  html_url: z.url(),
});

const issueListSchema = z.array(issueSchema.extend({ title: z.string() }));

const pullRequestSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.url(),
  state: z.string(),
  merged: z.boolean(),
  merge_commit_sha: z.string().nullable().optional(),
  head: z.object({ ref: z.string(), sha: z.string() }),
});

const commentsSchema = z.array(
  z.object({ id: z.number().int().positive(), html_url: z.url(), body: z.string().nullable() }),
);

const issueByIdSchema = z.object({
  node: z
    .object({
      id: z.string().min(1),
      number: z.number().int().positive(),
      url: z.url(),
      projectItems: z.object({
        nodes: z.array(
          z
            .object({
              id: z.string().min(1),
              project: z.object({ id: z.string().min(1) }),
            })
            .nullable(),
        ),
      }),
    })
    .nullable(),
});

const rawProjectSchema = z.object({
  id: z.string().min(1),
  number: z.number().int().positive(),
  title: z.string().min(1),
  url: z.url(),
  public: z.boolean(),
  closed: z.boolean(),
  items: z.object({
    nodes: z.array(
      z
        .object({
          id: z.string().min(1),
          status: z.object({ name: z.string().min(1) }).nullable(),
        })
        .nullable(),
    ),
    pageInfo: z.object({ hasNextPage: z.boolean() }),
  }),
});

const projectQuerySchema = z.object({
  repositoryOwner: z
    .object({
      __typename: z.enum(["Organization", "User"]),
      projectV2: rawProjectSchema.nullable(),
    })
    .nullable(),
});

const addProjectItemSchema = z.object({
  addProjectV2ItemById: z.object({ item: z.object({ id: z.string().min(1) }) }),
});

const updateProjectItemSchema = z.object({
  updateProjectV2ItemFieldValue: z.object({ projectV2Item: z.object({ id: z.string().min(1) }) }),
});

const deleteProjectItemSchema = z.object({
  deleteProjectV2Item: z.object({ deletedItemId: z.string().min(1) }),
});

const projectQuery = `
  query ThorLiveProject($owner: String!, $number: Int!, $statusField: String!) {
    repositoryOwner(login: $owner) {
      __typename
      ... on User { projectV2(number: $number) { ...ThorLiveProjectFields } }
      ... on Organization { projectV2(number: $number) { ...ThorLiveProjectFields } }
    }
  }
  fragment ThorLiveProjectFields on ProjectV2 {
    id number title url public closed
    items(first: 100) {
      nodes {
        id
        status: fieldValueByName(name: $statusField) {
          ... on ProjectV2ItemFieldSingleSelectValue { name }
        }
      }
      pageInfo { hasNextPage }
    }
  }
`;

const addProjectItemMutation = `
  mutation ThorLiveAddItem($project: ID!, $content: ID!) {
    addProjectV2ItemById(input: {projectId: $project, contentId: $content}) { item { id } }
  }
`;

const setSingleSelectMutation = `
  mutation ThorLiveSetSelect($project: ID!, $item: ID!, $field: ID!, $option: String!) {
    updateProjectV2ItemFieldValue(input: {
      projectId: $project,
      itemId: $item,
      fieldId: $field,
      value: {singleSelectOptionId: $option}
    }) { projectV2Item { id } }
  }
`;

const setTextMutation = `
  mutation ThorLiveSetText($project: ID!, $item: ID!, $field: ID!, $text: String!) {
    updateProjectV2ItemFieldValue(input: {
      projectId: $project,
      itemId: $item,
      fieldId: $field,
      value: {text: $text}
    }) { projectV2Item { id } }
  }
`;

const deleteProjectItemMutation = `
  mutation ThorLiveDeleteItem($project: ID!, $item: ID!) {
    deleteProjectV2Item(input: {projectId: $project, itemId: $item}) { deletedItemId }
  }
`;

const issueByIdQuery = `
  query ThorLiveIssue($issue: ID!) {
    node(id: $issue) {
      ... on Issue {
        id number url
        projectItems(first: 100) { nodes { id project { id } } }
      }
    }
  }
`;

function parseRepository(value: string): RepositoryRef {
  const [owner, name, extra] = value.split("/");
  if (owner === undefined || name === undefined || extra !== undefined) {
    throw new Error(`invalid THOR_LIVE_REPOSITORY: ${value}`);
  }
  return { owner, name };
}

async function githubCliToken(): Promise<string> {
  try {
    const result = await execFileAsync("gh", ["auth", "token"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    const token = result.stdout.trim();
    if (token.length === 0) throw new Error("GitHub CLI returned an empty token");
    return token;
  } catch (error) {
    throw new Error("set GITHUB_TOKEN or authenticate the GitHub CLI before running live tests", {
      cause: error,
    });
  }
}

function parseJsonBody(body: NonNullable<RequestInit["body"]>): unknown {
  if (typeof body !== "string")
    throw new Error("live GitHub API only supports JSON request bodies");
  return JSON.parse(body) as unknown;
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  const status = error.status;
  return typeof status === "number" ? status : undefined;
}
