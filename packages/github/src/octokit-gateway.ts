import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/core";
import {
  deferredIssueIdSchema,
  projectItemIdSchema,
  redactKnownSecrets,
  ticketContextSchema,
  ticketStatusSchema,
  type AgentPolicy,
  type ApprovalPolicy,
  type ExecutionMode,
  type PlanningDepth,
  type Priority,
  type ProjectItemId,
  type RepositoryRef,
  type TicketStatus,
  type WorkType,
} from "@thor/domain";
import { z } from "zod";

import type {
  DeferredIssueDraft,
  DeferredIssueRef,
  GitHubGateway,
  MergeReadiness,
  ProjectItemSnapshot,
  PullRequestRef,
  StatusTransition,
} from "./types.js";
import { GitHubError } from "./types.js";

export type GitHubAuth =
  | { kind: "token"; token: string }
  | { kind: "app"; appId: number; privateKey: string; installationId: number };

export type GitHubProjectConfiguration = {
  projectId: string;
  statusFieldId: string;
  statusOptions: Readonly<Partial<Record<TicketStatus, string>>>;
};

export type OctokitGatewayOptions = {
  auth: GitHubAuth;
  project: GitHubProjectConfiguration;
  apiUrl?: string;
  apiVersion?: string;
};

export const DEFAULT_GITHUB_API_VERSION = "2026-03-10";

const projectItemQuery = `
  query ThorProjectItem($id: ID!) {
    node(id: $id) {
      ... on ProjectV2Item {
        id
        updatedAt
        project { id }
        fieldValues(first: 100) {
          nodes {
            ... on ProjectV2ItemFieldSingleSelectValue {
              name
              optionId
              field { ... on ProjectV2SingleSelectField { id name } }
            }
            ... on ProjectV2ItemFieldTextValue {
              text
              field { ... on ProjectV2Field { id name } }
            }
          }
        }
        content {
          ... on Issue {
            id
            number
            title
            body
            repository { name owner { login } }
            blockedBy(first: 50) { nodes { id state } }
          }
        }
      }
    }
  }
`;

const fieldValueSchema = z.looseObject({
  name: z.string().nullable().optional(),
  optionId: z.string().nullable().optional(),
  text: z.string().nullable().optional(),
  field: z.object({ id: z.string(), name: z.string() }).nullable().optional(),
});
const projectItemResponseSchema = z.object({
  node: z
    .object({
      id: projectItemIdSchema,
      updatedAt: z.string(),
      project: z.object({ id: z.string() }),
      fieldValues: z.object({ nodes: z.array(fieldValueSchema.nullable()) }),
      content: z.object({
        id: z.string(),
        number: z.number().int().positive(),
        title: z.string(),
        body: z.string().nullable(),
        repository: z.object({ name: z.string(), owner: z.object({ login: z.string() }) }),
        blockedBy: z.object({
          nodes: z.array(z.object({ id: z.string(), state: z.string() }).nullable()),
        }),
      }),
    })
    .nullable(),
});

export class OctokitGitHubGateway implements GitHubGateway {
  private readonly octokit: Octokit;

  public constructor(private readonly options: OctokitGatewayOptions) {
    this.octokit = createOctokit(options);
  }

  public async getProjectItem(projectItemId: ProjectItemId): Promise<ProjectItemSnapshot> {
    try {
      const response: unknown = await this.octokit.graphql(projectItemQuery, { id: projectItemId });
      const parsed = projectItemResponseSchema.parse(response);
      if (parsed.node === null) {
        throw new GitHubError(`Project item ${projectItemId} was not found`, false, "not_found");
      }
      return mapProjectItem(parsed.node, this.options.project.statusFieldId);
    } catch (error) {
      throw normalizeGitHubError(error);
    }
  }

  public async listProjectItemsUpdatedSince(since: string): Promise<ProjectItemSnapshot[]> {
    try {
      const ids: ProjectItemId[] = [];
      let cursor: string | undefined;
      do {
        const response: unknown = await this.octokit.graphql(
          `query ThorProjectItems($id: ID!, $after: String) {
            node(id: $id) {
              ... on ProjectV2 {
                items(first: 100, after: $after, orderBy: {field: POSITION, direction: ASC}) {
                  nodes { id updatedAt }
                  pageInfo { hasNextPage endCursor }
                }
              }
            }
          }`,
          {
            id: this.options.project.projectId,
            ...(cursor === undefined ? {} : { after: cursor }),
          },
        );
        const parsed = z
          .object({
            node: z
              .object({
                items: z.object({
                  nodes: z.array(
                    z.object({ id: projectItemIdSchema, updatedAt: z.string() }).nullable(),
                  ),
                  pageInfo: z.object({
                    hasNextPage: z.boolean(),
                    endCursor: z.string().nullable(),
                  }),
                }),
              })
              .nullable(),
          })
          .parse(response);
        const items = parsed.node?.items;
        if (items === undefined) break;
        ids.push(
          ...items.nodes
            .filter(
              (item): item is NonNullable<typeof item> => item !== null && item.updatedAt > since,
            )
            .map((item) => item.id),
        );
        cursor = items.pageInfo.hasNextPage ? (items.pageInfo.endCursor ?? undefined) : undefined;
      } while (cursor !== undefined);
      return await Promise.all(ids.map((id) => this.getProjectItem(id)));
    } catch (error) {
      throw normalizeGitHubError(error);
    }
  }

  public async transitionStatus(transition: StatusTransition): Promise<ProjectItemSnapshot> {
    const current = await this.getProjectItem(transition.projectItemId);
    if (current.status === transition.targetStatus) return current;
    if (
      current.status !== transition.expectedStatus ||
      (transition.expectedUpdatedAt !== undefined &&
        current.updatedAt !== transition.expectedUpdatedAt)
    ) {
      throw new GitHubError(
        `Project item changed from expected ${transition.expectedStatus} before transition`,
        false,
        "conflict",
      );
    }
    const optionId = this.options.project.statusOptions[transition.targetStatus];
    if (optionId === undefined) {
      throw new GitHubError(
        `No GitHub status option is configured for ${transition.targetStatus}`,
        false,
        "invalid_response",
      );
    }
    try {
      await this.octokit.graphql(
        `mutation ThorSetStatus($project: ID!, $item: ID!, $field: ID!, $option: String!) {
          updateProjectV2ItemFieldValue(input: {
            projectId: $project,
            itemId: $item,
            fieldId: $field,
            value: {singleSelectOptionId: $option}
          }) { projectV2Item { id updatedAt } }
        }`,
        {
          project: this.options.project.projectId,
          item: transition.projectItemId,
          field: this.options.project.statusFieldId,
          option: optionId,
        },
      );
      return await this.getProjectItem(transition.projectItemId);
    } catch (error) {
      throw normalizeGitHubError(error);
    }
  }

  public async ensureBranch(
    repository: RepositoryRef,
    branch: string,
    sourceSha: string,
  ): Promise<string> {
    try {
      const existing = await this.octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
        owner: repository.owner,
        repo: repository.name,
        ref: `heads/${branch}`,
      });
      return z.object({ object: z.object({ sha: z.string() }) }).parse(existing.data).object.sha;
    } catch (error) {
      if (!hasStatus(error, 404)) throw normalizeGitHubError(error);
    }
    try {
      const created = await this.octokit.request("POST /repos/{owner}/{repo}/git/refs", {
        owner: repository.owner,
        repo: repository.name,
        ref: `refs/heads/${branch}`,
        sha: sourceSha,
      });
      return z.object({ object: z.object({ sha: z.string() }) }).parse(created.data).object.sha;
    } catch (error) {
      if (hasStatus(error, 422)) return this.ensureBranch(repository, branch, sourceSha);
      throw normalizeGitHubError(error);
    }
  }

  public async ensurePullRequest(input: {
    repository: RepositoryRef;
    branch: string;
    base: string;
    title: string;
    body: string;
  }): Promise<PullRequestRef> {
    try {
      const listed = await this.octokit.request("GET /repos/{owner}/{repo}/pulls", {
        owner: input.repository.owner,
        repo: input.repository.name,
        state: "open",
        head: `${input.repository.owner}:${input.branch}`,
        base: input.base,
        per_page: 100,
      });
      const existing = z.array(pullResponseSchema).parse(listed.data).at(0);
      if (existing !== undefined) return mapPull(existing);
      const created = await this.octokit.request("POST /repos/{owner}/{repo}/pulls", {
        owner: input.repository.owner,
        repo: input.repository.name,
        head: input.branch,
        base: input.base,
        title: input.title,
        body: input.body,
      });
      return mapPull(pullResponseSchema.parse(created.data));
    } catch (error) {
      throw normalizeGitHubError(error);
    }
  }

  public async upsertComment(input: {
    repository: RepositoryRef;
    issueNumber: number;
    idempotencyKey: string;
    body: string;
  }): Promise<number> {
    const marker = idempotencyMarker(input.idempotencyKey);
    try {
      const commentSchema = z.object({ id: z.number().int(), body: z.string().nullable() });
      let existing: z.infer<typeof commentSchema> | undefined;
      let page = 1;
      while (existing === undefined) {
        const listed = await this.octokit.request(
          "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
          {
            owner: input.repository.owner,
            repo: input.repository.name,
            issue_number: input.issueNumber,
            per_page: 100,
            page,
          },
        );
        const comments = z.array(commentSchema).parse(listed.data);
        existing = comments.find((comment) => comment.body?.includes(marker) === true);
        if (comments.length < 100) break;
        page += 1;
      }
      const body = `${marker}\n${input.body}`;
      if (existing !== undefined) {
        await this.octokit.request("PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}", {
          owner: input.repository.owner,
          repo: input.repository.name,
          comment_id: existing.id,
          body,
        });
        return existing.id;
      }
      const created = await this.octokit.request(
        "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
        {
          owner: input.repository.owner,
          repo: input.repository.name,
          issue_number: input.issueNumber,
          body,
        },
      );
      return commentSchema.parse(created.data).id;
    } catch (error) {
      throw normalizeGitHubError(error);
    }
  }

  public async ensureDeferredIssue(draft: DeferredIssueDraft): Promise<DeferredIssueRef> {
    const marker = idempotencyMarker(draft.originKey);
    try {
      const listed = await this.octokit.request("GET /repos/{owner}/{repo}/issues", {
        owner: draft.repository.owner,
        repo: draft.repository.name,
        state: "all",
        sort: "created",
        direction: "desc",
        per_page: 100,
      });
      const listedResult = z
        .array(issueResponseSchema)
        .parse(listed.data)
        .find((issue) => issue.body?.includes(marker) === true);
      const searchResult =
        listedResult === undefined
          ? z
              .object({ items: z.array(issueResponseSchema) })
              .parse(
                (
                  await this.octokit.request("GET /search/issues", {
                    q: `repo:${draft.repository.owner}/${draft.repository.name} type:issue in:body "${marker}"`,
                    per_page: 10,
                  })
                ).data,
              )
              .items.at(0)
          : undefined;
      const issue =
        listedResult ??
        searchResult ??
        issueResponseSchema.parse(
          (
            await this.octokit.request("POST /repos/{owner}/{repo}/issues", {
              owner: draft.repository.owner,
              repo: draft.repository.name,
              title: draft.title,
              body: `${marker}\n${draft.body}`,
              labels: draft.labels,
            })
          ).data,
        );
      const projectItemId = await this.ensureIssueInProject(issue.node_id, draft.projectFields);
      return {
        issueId: deferredIssueIdSchema.parse(issue.node_id),
        number: issue.number,
        url: issue.html_url,
        projectItemId,
      };
    } catch (error) {
      throw normalizeGitHubError(error);
    }
  }

  public async getMergeReadiness(
    repository: RepositoryRef,
    pullRequestNumber: number,
  ): Promise<MergeReadiness> {
    try {
      const response = await this.octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner: repository.owner,
        repo: repository.name,
        pull_number: pullRequestNumber,
      });
      const pull = pullDetailSchema.parse(response.data);
      const mergeable =
        pull.merged || (pull.mergeable === true && pull.mergeable_state === "clean");
      return {
        mergeable,
        ...(mergeable ? {} : { reason: pull.mergeable_state }),
        headSha: pull.head.sha,
        merged: pull.merged,
        ...(pull.merge_commit_sha === null ? {} : { mergeCommitSha: pull.merge_commit_sha }),
      };
    } catch (error) {
      throw normalizeGitHubError(error);
    }
  }

  public async mergePullRequest(input: {
    repository: RepositoryRef;
    pullRequestNumber: number;
    expectedHeadSha: string;
    commitTitle: string;
  }): Promise<string> {
    const readiness = await this.getMergeReadiness(input.repository, input.pullRequestNumber);
    if (readiness.merged) return readiness.mergeCommitSha ?? readiness.headSha;
    if (!readiness.mergeable || readiness.headSha !== input.expectedHeadSha) {
      throw new GitHubError(
        `pull request is not mergeable at expected head ${input.expectedHeadSha}`,
        false,
        "conflict",
      );
    }
    try {
      const merged = await this.octokit.request(
        "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge",
        {
          owner: input.repository.owner,
          repo: input.repository.name,
          pull_number: input.pullRequestNumber,
          sha: input.expectedHeadSha,
          commit_title: input.commitTitle,
          merge_method: "squash",
        },
      );
      const parsed = z
        .object({ merged: z.boolean(), sha: z.string().nullable(), message: z.string() })
        .parse(merged.data);
      if (!parsed.merged || parsed.sha === null) {
        throw new GitHubError(parsed.message, false, "conflict");
      }
      return parsed.sha;
    } catch (error) {
      throw normalizeGitHubError(error);
    }
  }

  private async ensureIssueInProject(
    issueId: string,
    fields: DeferredIssueDraft["projectFields"],
  ): Promise<ProjectItemId> {
    const existingResponse: unknown = await this.octokit.graphql(
      `query ThorIssueProjectItems($id: ID!) {
        node(id: $id) { ... on Issue { projectItems(first: 50) { nodes { id project { id } } } } }
      }`,
      { id: issueId },
    );
    const existing = z
      .object({
        node: z
          .object({
            projectItems: z.object({
              nodes: z.array(
                z
                  .object({ id: projectItemIdSchema, project: z.object({ id: z.string() }) })
                  .nullable(),
              ),
            }),
          })
          .nullable(),
      })
      .parse(existingResponse)
      .node?.projectItems.nodes.find((item) => item?.project.id === this.options.project.projectId);

    let projectItemId = existing?.id;
    if (projectItemId === undefined) {
      const added: unknown = await this.octokit.graphql(
        `mutation ThorAddDeferredIssue($project: ID!, $content: ID!) {
          addProjectV2ItemById(input: {projectId: $project, contentId: $content}) {
            item { id }
          }
        }`,
        { project: this.options.project.projectId, content: issueId },
      );
      projectItemId = z
        .object({ addProjectV2ItemById: z.object({ item: z.object({ id: projectItemIdSchema }) }) })
        .parse(added).addProjectV2ItemById.item.id;
    }
    for (const field of fields) {
      const value =
        field.kind === "single_select"
          ? { singleSelectOptionId: field.optionId }
          : { text: field.text };
      await this.octokit.graphql(
        `mutation ThorSetDeferredField($project: ID!, $item: ID!, $field: ID!, $value: ProjectV2FieldValue!) {
          updateProjectV2ItemFieldValue(input: {
            projectId: $project, itemId: $item, fieldId: $field, value: $value
          }) { projectV2Item { id } }
        }`,
        {
          project: this.options.project.projectId,
          item: projectItemId,
          field: field.fieldId,
          value,
        },
      );
    }
    return projectItemId;
  }
}

const pullResponseSchema = z.object({
  number: z.number().int().positive(),
  node_id: z.string(),
  html_url: z.string(),
  head: z.object({ sha: z.string() }),
  merged_at: z.string().nullable().optional(),
});
const pullDetailSchema = pullResponseSchema.extend({
  merged: z.boolean(),
  mergeable: z.boolean().nullable(),
  mergeable_state: z.string(),
  merge_commit_sha: z.string().nullable(),
});
const issueResponseSchema = z.object({
  number: z.number().int().positive(),
  node_id: z.string(),
  html_url: z.string(),
  body: z.string().nullable().optional(),
});

function mapPull(pull: z.infer<typeof pullResponseSchema>): PullRequestRef {
  return {
    number: pull.number,
    nodeId: pull.node_id,
    url: pull.html_url,
    headSha: pull.head.sha,
    merged: pull.merged_at != null,
  };
}

function mapProjectItem(
  item: NonNullable<z.infer<typeof projectItemResponseSchema>["node"]>,
  statusFieldId: string,
): ProjectItemSnapshot {
  const fields = new Map<string, string>();
  let status: TicketStatus = "backlog";
  for (const value of item.fieldValues.nodes) {
    if (value?.field == null) continue;
    const fieldValue = value.name ?? value.text;
    if (fieldValue !== undefined && fieldValue !== null) fields.set(value.field.name, fieldValue);
    if (value.field.id === statusFieldId && value.name != null) status = parseStatus(value.name);
  }
  const content = item.content;
  const ticket = ticketContextSchema.parse({
    projectItemId: item.id,
    repository: { owner: content.repository.owner.login, name: content.repository.name },
    issueNumber: content.number,
    title: redactKnownSecrets(content.title),
    body: redactKnownSecrets(content.body ?? ""),
    workType: mapWorkTypeField(fields),
    priority: parseEnumField<Priority>(
      fields.get("Priority"),
      { p0: "P0", p1: "P1", p2: "P2", p3: "P3" },
      "P2",
    ),
    ...(fields.get("Component / Area") === undefined
      ? {}
      : { component: redactKnownSecrets(fields.get("Component / Area") ?? "") }),
    acceptanceCriteria: extractAcceptanceCriteria(redactKnownSecrets(content.body ?? "")),
    dependencies: content.blockedBy.nodes
      .filter((dependency): dependency is NonNullable<typeof dependency> => dependency !== null)
      .map((dependency) => ({ issueId: dependency.id, complete: dependency.state === "CLOSED" })),
    policy: {
      executionMode: parseEnumField<ExecutionMode>(
        fields.get("Execution Mode"),
        {
          human: "human",
          agent: "agent",
          "human + agent": "human_and_agent",
          disabled: "disabled",
        },
        "agent",
      ),
      planningDepth: parseEnumField<PlanningDepth>(
        fields.get("Planning Depth"),
        {
          none: "none",
          light: "light",
          full: "full",
          "architecture review": "architecture_review",
        },
        "full",
      ),
      approvalPolicy: parseEnumField<ApprovalPolicy>(
        fields.get("Approval Policy"),
        {
          autonomous: "autonomous",
          "blueprint review": "blueprint_review",
          "pre-merge review": "pre_merge_review",
          "blueprint + pre-merge review": "blueprint_and_pre_merge_review",
        },
        "autonomous",
      ),
      agentPolicy: parseEnumField<AgentPolicy>(
        fields.get("Agent Policy"),
        {
          disabled: "disabled",
          allowed: "allowed",
          preferred: "preferred",
          required: "required",
        },
        "preferred",
      ),
      autonomousRepairBudget: 3,
    },
  });
  return {
    projectItemId: item.id,
    projectId: item.project.id,
    updatedAt: item.updatedAt,
    status,
    ticket,
  };
}

/** Maps the legacy Type field and GitHub-compatible Work Type alias into Thor's domain. */
export function mapWorkTypeField(fields: ReadonlyMap<string, string>): WorkType {
  return parseEnumField<WorkType>(
    fields.get("Type") ?? fields.get("Work Type"),
    {
      feature: "feature",
      bug: "bug",
      task: "task",
      spike: "spike",
      chore: "chore",
      documentation: "documentation",
    },
    "task",
  );
}

function parseStatus(value: string): TicketStatus {
  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll("/", " ")
    .replaceAll("-", " ")
    .replace(/\s+/g, "_");
  const aliases: Readonly<Record<string, TicketStatus>> = {
    design_blueprint: "design_blueprint",
    awaiting_blueprint_approval: "awaiting_blueprint_approval",
    ready_for_review: "ready_for_review",
    in_review: "in_review",
    re_review: "re_review",
    awaiting_human_merge_review: "awaiting_human_merge_review",
    ready_to_merge: "ready_to_merge",
  };
  return aliases[normalized] ?? ticketStatusSchema.parse(normalized);
}

function parseEnumField<Value extends string>(
  value: string | undefined,
  mapping: Readonly<Record<string, Value>>,
  fallback: Value,
): Value {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  const mapped = mapping[normalized];
  if (mapped === undefined) {
    throw new GitHubError(
      `Unsupported GitHub Project field value: ${value}`,
      false,
      "invalid_response",
    );
  }
  return mapped;
}

function extractAcceptanceCriteria(body: string): string[] {
  const lines = body
    .split("\n")
    .map((line) => /^\s*[-*]\s*\[[ xX]\]\s*(.+)$/.exec(line)?.[1]?.trim())
    .filter((line): line is string => line !== undefined && line.length > 0);
  return lines.length === 0 ? ["Satisfy the ticket description"] : lines;
}

function createOctokit(options: OctokitGatewayOptions): Octokit {
  const baseUrl = options.apiUrl;
  const apiVersion = options.apiVersion ?? DEFAULT_GITHUB_API_VERSION;
  let octokit: Octokit;
  if (options.auth.kind === "token") {
    octokit = new Octokit({
      auth: options.auth.token,
      ...(baseUrl === undefined ? {} : { baseUrl }),
    });
  } else {
    octokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: options.auth.appId,
        privateKey: options.auth.privateKey,
        installationId: options.auth.installationId,
      },
      ...(baseUrl === undefined ? {} : { baseUrl }),
    });
  }
  octokit.hook.before("request", (request) => {
    request.headers["x-github-api-version"] = apiVersion;
  });
  return octokit;
}

function idempotencyMarker(key: string): string {
  return `<!-- thor:idempotency:${key.replace(/[^A-Za-z0-9_.:-]/g, "_")} -->`;
}

function hasStatus(error: unknown, status: number): boolean {
  return (
    typeof error === "object" && error !== null && "status" in error && error.status === status
  );
}

function normalizeGitHubError(error: unknown): GitHubError {
  if (error instanceof GitHubError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (hasStatus(error, 401) || hasStatus(error, 403)) {
    return new GitHubError(message, false, "authentication", { cause: error });
  }
  if (hasStatus(error, 404)) return new GitHubError(message, false, "not_found", { cause: error });
  if (hasStatus(error, 409) || hasStatus(error, 422)) {
    return new GitHubError(message, false, "conflict", { cause: error });
  }
  if (hasStatus(error, 429))
    return new GitHubError(message, true, "rate_limited", { cause: error });
  if (/5\d\d|timeout|connection|network/i.test(message)) {
    return new GitHubError(message, true, "unavailable", { cause: error });
  }
  if (error instanceof z.ZodError) {
    return new GitHubError(z.prettifyError(error), false, "invalid_response", { cause: error });
  }
  return new GitHubError(message, true, "unavailable", { cause: error });
}
