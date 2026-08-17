import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/core";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import {
  boardStateKeySchema,
  type DependencyPolicy,
  type ResolvedProjectFields,
  type TicketDefaults,
} from "@thor/config/schema";
import {
  agentPolicySchema,
  approvalPolicySchema,
  deferredIssueIdSchema,
  executionModeSchema,
  issueIdSchema,
  planningDepthSchema,
  prioritySchema,
  projectItemIdSchema,
  redactKnownSecrets,
  ticketContextSchema,
  ticketContextsEqual,
  workTypeSchema,
  type ProjectItemId,
  type RepositoryRef,
} from "@thor/domain";
import { z } from "zod";

import type {
  DeferredIssueDraft,
  DeferredIssueRef,
  GitHubGateway,
  MergeReadiness,
  ProjectItemSnapshot,
  ProjectItemObservation,
  PullRequestRef,
  StatusTransition,
} from "./types.js";
import { GitHubError } from "./types.js";

export type GitHubAuth =
  | { kind: "token"; token: string }
  | { kind: "app"; appId: number; privateKey: string; installationId: number };

export type GitHubProjectConfiguration = {
  projectId: string;
  fields: ResolvedProjectFields;
  ticketDefaults: TicketDefaults;
  dependencyCompletion: DependencyPolicy["completion"];
  doneOptionId: string;
};

export type OctokitClientOptions = {
  auth: GitHubAuth;
  apiUrl?: string;
  apiVersion?: string;
  resilience?: {
    requestRetries?: number;
    retryAfterBaseValueMs?: number;
    throttleEnabled?: boolean;
  };
};

export type OctokitGatewayOptions = OctokitClientOptions & {
  project: GitHubProjectConfiguration;
};

export const DEFAULT_GITHUB_API_VERSION = "2026-03-10";
export const GITHUB_MAX_RETRY_DELAY_MS = 5 * 60 * 1_000;

const ResilientOctokit = Octokit.plugin(retry, throttling);
const retryableRequestDoNotRetry = [400, 401, 403, 404, 410, 422, 429, 451];

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
            blockedBy(first: 50) {
              nodes {
                id
                state
              }
              pageInfo { hasNextPage endCursor }
            }
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
const pageInfoSchema = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable(),
});
const blockedByIssueSchema = z.object({ id: z.string(), state: z.string() });
type BlockedByIssue = z.infer<typeof blockedByIssueSchema>;
const blockedByPageSchema = z.object({
  nodes: z.array(blockedByIssueSchema.nullable()),
  pageInfo: pageInfoSchema,
});
const projectItemResponseSchema = z.object({
  node: z
    .object({
      id: projectItemIdSchema,
      updatedAt: z.string(),
      project: z.object({ id: z.string() }),
      fieldValues: z.object({ nodes: z.array(fieldValueSchema.nullable()) }),
      content: z
        .object({
          id: z.string(),
          number: z.number().int().positive(),
          title: z.string(),
          body: z.string().nullable(),
          repository: z.object({ name: z.string(), owner: z.object({ login: z.string() }) }),
          blockedBy: blockedByPageSchema,
        })
        .nullable(),
    })
    .nullable(),
});
const blockedByPageResponseSchema = z.object({
  node: z.object({ blockedBy: blockedByPageSchema }).nullable(),
});
const dependencyProjectItemsResponseSchema = z.object({
  node: z
    .object({
      projectItems: z.object({
        nodes: z.array(
          z.object({ id: projectItemIdSchema, project: z.object({ id: z.string() }) }).nullable(),
        ),
        pageInfo: pageInfoSchema,
      }),
    })
    .nullable(),
});
const dependencyProjectStatusResponseSchema = z.object({
  node: z
    .object({
      fieldValues: z.object({ nodes: z.array(fieldValueSchema.nullable()) }),
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
      if (parsed.node.content === null) return mapProjectItem(parsed.node, this.options.project);
      const dependencies = await this.loadBlockedBy(
        parsed.node.content.id,
        parsed.node.content.blockedBy,
      );
      const managedDependencyDone = await this.loadManagedDependencyDone(dependencies);
      return mapProjectItem(
        {
          ...parsed.node,
          content: {
            ...parsed.node.content,
            blockedBy: {
              nodes: dependencies,
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
        this.options.project,
        managedDependencyDone,
      );
    } catch (error) {
      throw normalizeGitHubError(error);
    }
  }

  private async loadBlockedBy(
    issueId: string,
    firstPage: NonNullable<
      NonNullable<z.infer<typeof projectItemResponseSchema>["node"]>["content"]
    >["blockedBy"],
  ): Promise<BlockedByIssue[]> {
    const dependencies = firstPage.nodes.filter(
      (dependency): dependency is BlockedByIssue => dependency !== null,
    );
    let cursor = nextCursor(firstPage.pageInfo, `Issue ${issueId} blockedBy`);
    while (cursor !== undefined) {
      const response: unknown = await this.octokit.graphql(
        `query ThorBlockedBy($id: ID!, $after: String!) {
          node(id: $id) {
            ... on Issue {
              blockedBy(first: 50, after: $after) {
                nodes { id state }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }`,
        { id: issueId, after: cursor },
      );
      const page = blockedByPageResponseSchema.parse(response).node?.blockedBy;
      if (page === undefined) {
        throw new GitHubError(
          `Issue ${issueId} was unavailable while reading dependencies`,
          true,
          "unavailable",
        );
      }
      dependencies.push(
        ...page.nodes.filter((dependency): dependency is BlockedByIssue => dependency !== null),
      );
      cursor = nextCursor(page.pageInfo, `Issue ${issueId} blockedBy`);
    }
    return dependencies;
  }

  private async loadManagedDependencyDone(
    dependencies: readonly BlockedByIssue[],
  ): Promise<ReadonlyMap<string, boolean>> {
    const results = new Map<string, boolean>();
    for (const dependency of dependencies) {
      if (!projectStateCanAffectCompletion(dependency, this.options.project)) continue;
      const projectItemId = await this.findManagedProjectItemId(dependency.id);
      if (projectItemId !== undefined) {
        results.set(dependency.id, await this.projectItemIsDone(projectItemId));
      }
    }
    return results;
  }

  private async findManagedProjectItemId(issueId: string): Promise<ProjectItemId | undefined> {
    let cursor: string | undefined;
    do {
      const response: unknown = await this.octokit.graphql(
        `query ThorDependencyProjectItems($id: ID!, $after: String) {
          node(id: $id) {
            ... on Issue {
              projectItems(first: 100, after: $after) {
                nodes { id project { id } }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }`,
        { id: issueId, ...(cursor === undefined ? {} : { after: cursor }) },
      );
      const projectItems = dependencyProjectItemsResponseSchema.parse(response).node?.projectItems;
      if (projectItems === undefined) {
        throw new GitHubError(
          `Dependency Issue ${issueId} was unavailable while reading Project membership`,
          true,
          "unavailable",
        );
      }
      const managed = projectItems.nodes.find(
        (item) => item?.project.id === this.options.project.projectId,
      );
      if (managed !== undefined && managed !== null) return managed.id;
      cursor = nextCursor(projectItems.pageInfo, `Issue ${issueId} projectItems`);
    } while (cursor !== undefined);
    return undefined;
  }

  private async projectItemIsDone(projectItemId: ProjectItemId): Promise<boolean> {
    const response: unknown = await this.octokit.graphql(
      `query ThorDependencyProjectStatus($id: ID!) {
        node(id: $id) {
          ... on ProjectV2Item {
            fieldValues(first: 100) {
              nodes {
                ... on ProjectV2ItemFieldSingleSelectValue {
                  optionId
                  field { ... on ProjectV2SingleSelectField { id name } }
                }
              }
            }
          }
        }
      }`,
      { id: projectItemId },
    );
    const item = dependencyProjectStatusResponseSchema.parse(response).node;
    if (item === null) {
      throw new GitHubError(
        `Dependency Project item ${projectItemId} was not found`,
        true,
        "unavailable",
      );
    }
    return item.fieldValues.nodes.some(
      (value) =>
        value?.field?.id === this.options.project.fields.lifecycle.fieldId &&
        value.optionId === this.options.project.doneOptionId,
    );
  }

  public async listProjectItemObservations(): Promise<ProjectItemObservation[]> {
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
        if (items === undefined) {
          throw new GitHubError(
            `GitHub Project ${this.options.project.projectId} was not available for a complete scan`,
            true,
            "unavailable",
          );
        }
        ids.push(
          ...items.nodes
            .filter((item): item is NonNullable<typeof item> => item !== null)
            .map((item) => item.id),
        );
        if (items.pageInfo.hasNextPage && items.pageInfo.endCursor === null) {
          throw new GitHubError(
            `GitHub Project ${this.options.project.projectId} returned an incomplete pagination cursor`,
            true,
            "unavailable",
          );
        }
        cursor = items.pageInfo.hasNextPage ? (items.pageInfo.endCursor ?? undefined) : undefined;
      } while (cursor !== undefined);
      return await loadProjectItemsIndependently(ids, (id) => this.getProjectItem(id));
    } catch (error) {
      throw normalizeGitHubError(error);
    }
  }

  public async transitionStatus(transition: StatusTransition): Promise<ProjectItemSnapshot> {
    let current = await this.getProjectItem(transition.projectItemId);
    if (current.status === transition.targetStatus) {
      assertTargetSnapshotCompatible(current, transition);
      return current;
    }
    for (
      let attempt = 0;
      attempt < 4 &&
      current.status !== transition.expectedStatus &&
      transitionSnapshotMayBeStale(current, transition);
      attempt += 1
    ) {
      await delay(250);
      current = await this.getProjectItem(transition.projectItemId);
      if (current.status === transition.targetStatus) {
        assertTargetSnapshotCompatible(current, transition);
        return current;
      }
    }
    if (statusTransitionConflicts(current, transition)) {
      throw new GitHubError(
        `Project item changed from expected ${transition.expectedStatus} before transition`,
        false,
        "conflict",
      );
    }
    const optionId = this.options.project.fields.lifecycle.options[transition.targetStatus];
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
          field: this.options.project.fields.lifecycle.fieldId,
          option: optionId,
        },
      );
      const updated = await this.getProjectItem(transition.projectItemId);
      if (updated.status === transition.targetStatus) {
        assertTargetSnapshotCompatible(updated, transition);
      }
      return updated;
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
        ...(pull.merge_commit_sha == null ? {} : { mergeCommitSha: pull.merge_commit_sha }),
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

  public async closeIssue(repository: RepositoryRef, issueNumber: number): Promise<void> {
    try {
      await this.octokit.request("PATCH /repos/{owner}/{repo}/issues/{issue_number}", {
        owner: repository.owner,
        repo: repository.name,
        issue_number: issueNumber,
        state: "closed",
      });
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

export async function loadProjectItemsIndependently(
  projectItemIds: readonly ProjectItemId[],
  load: (projectItemId: ProjectItemId) => Promise<ProjectItemSnapshot>,
): Promise<ProjectItemObservation[]> {
  const observations: ProjectItemObservation[] = [];
  const concurrency = 4;
  for (let offset = 0; offset < projectItemIds.length; offset += concurrency) {
    observations.push(
      ...(await Promise.all(
        projectItemIds
          .slice(offset, offset + concurrency)
          .map(async (projectItemId): Promise<ProjectItemObservation> => {
            try {
              return { kind: "present", projectItemId, snapshot: await load(projectItemId) };
            } catch (error) {
              const normalized = normalizeGitHubError(error);
              const reason = redactKnownSecrets(normalized.message);
              return normalized.code === "not_found"
                ? { kind: "removed", projectItemId, reason }
                : {
                    kind: "unreadable",
                    projectItemId,
                    reason,
                    retryable: normalized.retryable,
                  };
            }
          }),
      )),
    );
  }
  return observations;
}

export function statusTransitionConflicts(
  current: ProjectItemSnapshot,
  transition: StatusTransition,
): boolean {
  const ticketChanged =
    transition.expectedTicket !== undefined &&
    !ticketContextsEqual(current.ticket, transition.expectedTicket);
  // Nested dependency state can change without updating the dependent Project item's timestamp.
  // Ticket context is therefore an independent compare-and-set guard, while updatedAt alone may
  // reflect unrelated Project metadata and must not cause a conflict.
  return current.status !== transition.expectedStatus || ticketChanged;
}

function assertTargetSnapshotCompatible(
  current: ProjectItemSnapshot,
  transition: StatusTransition,
): void {
  if (
    transition.expectedTicket !== undefined &&
    !ticketContextsEqual(current.ticket, transition.expectedTicket)
  ) {
    throw new GitHubError(
      `Project item reached ${transition.targetStatus}, but its ticket context changed concurrently`,
      false,
      "conflict",
    );
  }
}

export function transitionSnapshotMayBeStale(
  current: ProjectItemSnapshot,
  transition: StatusTransition,
): boolean {
  if (transition.expectedUpdatedAt === undefined || transition.expectedTicket === undefined) {
    return false;
  }
  if (!ticketContextsEqual(current.ticket, transition.expectedTicket)) return false;
  if (current.updatedAt === transition.expectedUpdatedAt) return true;
  const currentTime = Date.parse(current.updatedAt);
  const expectedTime = Date.parse(transition.expectedUpdatedAt);
  return (
    Number.isFinite(currentTime) && Number.isFinite(expectedTime) && currentTime < expectedTime
  );
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
  merge_commit_sha: z.string().nullable().optional(),
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

export function mapProjectItem(
  item: NonNullable<z.infer<typeof projectItemResponseSchema>["node"]>,
  configuration: GitHubProjectConfiguration,
  managedDependencyDone: ReadonlyMap<string, boolean> = new Map(),
): ProjectItemSnapshot {
  if (item.project.id !== configuration.projectId) {
    throw new GitHubError(
      `Project item ${item.id} belongs to ${item.project.id}, expected ${configuration.projectId}`,
      false,
      "invalid_response",
    );
  }
  const values = new Map<string, z.infer<typeof fieldValueSchema>>();
  for (const value of item.fieldValues.nodes) {
    if (value?.field == null) continue;
    values.set(value.field.id, value);
  }
  const status = readSelect(
    configuration.fields.lifecycle,
    values,
    undefined,
    boardStateKeySchema,
    "lifecycle",
  );
  const content = item.content;
  if (content === null) {
    throw new GitHubError(
      `Project item ${item.id} no longer has GitHub Issue content`,
      false,
      "not_found",
    );
  }
  const component = readText(configuration.fields.component, values, "component");
  const ticket = ticketContextSchema.parse({
    projectItemId: item.id,
    issueId: issueIdSchema.parse(content.id),
    repository: { owner: content.repository.owner.login, name: content.repository.name },
    issueNumber: content.number,
    title: redactKnownSecrets(content.title),
    body: redactKnownSecrets(content.body ?? ""),
    workType: readSelect(
      configuration.fields.workType,
      values,
      configuration.ticketDefaults.workType,
      workTypeSchema,
      "work type",
    ),
    priority: readSelect(
      configuration.fields.priority,
      values,
      configuration.ticketDefaults.priority,
      prioritySchema,
      "priority",
    ),
    ...(component === undefined ? {} : { component: redactKnownSecrets(component) }),
    acceptanceCriteria: extractAcceptanceCriteria(redactKnownSecrets(content.body ?? "")),
    dependencies: content.blockedBy.nodes
      .filter((dependency): dependency is NonNullable<typeof dependency> => dependency !== null)
      .map((dependency) => ({
        issueId: dependency.id,
        complete: dependencyIsComplete(dependency, configuration, managedDependencyDone),
      })),
    policy: {
      executionMode: readSelect(
        configuration.fields.executionMode,
        values,
        configuration.ticketDefaults.executionMode,
        executionModeSchema,
        "execution mode",
      ),
      planningDepth: readSelect(
        configuration.fields.planningDepth,
        values,
        configuration.ticketDefaults.planningDepth,
        planningDepthSchema,
        "planning depth",
      ),
      approvalPolicy: readSelect(
        configuration.fields.approvalPolicy,
        values,
        configuration.ticketDefaults.approvalPolicy,
        approvalPolicySchema,
        "approval policy",
      ),
      agentPolicy: readSelect(
        configuration.fields.agentPolicy,
        values,
        configuration.ticketDefaults.agentPolicy,
        agentPolicySchema,
        "agent policy",
      ),
      autonomousRepairBudget: configuration.ticketDefaults.autonomousRepairBudget,
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

function dependencyIsComplete(
  dependency: NonNullable<
    NonNullable<z.infer<typeof projectItemResponseSchema>["node"]>["content"]
  >["blockedBy"]["nodes"][number] & {},
  configuration: GitHubProjectConfiguration,
  managedDependencyDone: ReadonlyMap<string, boolean>,
): boolean {
  const issueClosed = dependency.state === "CLOSED";
  if (configuration.dependencyCompletion === "issue_closed") return issueClosed;
  const projectDone = managedDependencyDone.get(dependency.id);
  if (projectDone === undefined) return issueClosed;
  return configuration.dependencyCompletion === "issue_closed_or_project_done"
    ? issueClosed || projectDone
    : issueClosed && projectDone;
}

function projectStateCanAffectCompletion(
  dependency: BlockedByIssue,
  configuration: GitHubProjectConfiguration,
): boolean {
  if (configuration.dependencyCompletion === "issue_closed") return false;
  const issueClosed = dependency.state === "CLOSED";
  return configuration.dependencyCompletion === "issue_closed_or_project_done"
    ? !issueClosed
    : issueClosed;
}

type ResolvedSelectField = ResolvedProjectFields["lifecycle"];
type FieldValue = z.infer<typeof fieldValueSchema>;

function readSelect<Value>(
  binding: ResolvedSelectField | undefined,
  values: ReadonlyMap<string, FieldValue>,
  fallback: Value | undefined,
  schema: z.ZodType<Value>,
  semanticName: string,
): Value {
  if (binding === undefined) {
    if (fallback !== undefined) return fallback;
    throw missingFieldValue(semanticName);
  }
  const optionId = values.get(binding.fieldId)?.optionId;
  if (optionId == null) {
    if (!binding.requiredOnItems && fallback !== undefined) return fallback;
    throw missingFieldValue(semanticName);
  }
  const semanticValue = Object.entries(binding.options).find(
    ([, configuredOptionId]) => configuredOptionId === optionId,
  )?.[0];
  if (semanticValue === undefined) {
    throw new GitHubError(
      `GitHub Project ${semanticName} option ${optionId} is not present in the compiled binding`,
      false,
      "invalid_response",
    );
  }
  return schema.parse(semanticValue);
}

function readText(
  binding: ResolvedProjectFields["component"],
  values: ReadonlyMap<string, FieldValue>,
  semanticName: string,
): string | undefined {
  if (binding === undefined) return undefined;
  const text = values.get(binding.fieldId)?.text?.trim();
  if (text === undefined || text.length === 0) {
    if (!binding.requiredOnItems) return undefined;
    throw missingFieldValue(semanticName);
  }
  return text;
}

function missingFieldValue(semanticName: string): GitHubError {
  return new GitHubError(
    `GitHub Project item is missing required ${semanticName} configuration`,
    false,
    "invalid_response",
  );
}

function extractAcceptanceCriteria(body: string): string[] {
  const lines = body
    .split("\n")
    .map((line) => /^\s*[-*]\s*\[[ xX]\]\s*(.+)$/.exec(line)?.[1]?.trim())
    .filter((line): line is string => line !== undefined && line.length > 0);
  return lines.length === 0 ? ["Satisfy the ticket description"] : lines;
}

export function createOctokit(options: OctokitClientOptions): Octokit {
  const baseUrl = options.apiUrl;
  const apiVersion = options.apiVersion ?? DEFAULT_GITHUB_API_VERSION;
  const retryAfterBaseValue = options.resilience?.retryAfterBaseValueMs ?? 1_000;
  const maxRetryDelaySeconds = GITHUB_MAX_RETRY_DELAY_MS / 1_000;
  const throttle =
    options.resilience?.throttleEnabled === false
      ? { enabled: false as const }
      : {
          retryAfterBaseValue,
          fallbackSecondaryRateRetryAfter: 60,
          onRateLimit: (
            retryAfter: number,
            _request: unknown,
            _octokit: unknown,
            retryCount: number,
          ) => retryCount < 1 && retryAfter <= maxRetryDelaySeconds,
          onSecondaryRateLimit: (
            retryAfter: number,
            _request: unknown,
            _octokit: unknown,
            retryCount: number,
          ) => retryCount < 1 && retryAfter <= maxRetryDelaySeconds,
        };
  const resilience = {
    retry: {
      retries: options.resilience?.requestRetries ?? 3,
      retryAfterBaseValue,
      doNotRetry: retryableRequestDoNotRetry,
    },
    throttle,
  };
  let octokit: Octokit;
  if (options.auth.kind === "token") {
    octokit = new ResilientOctokit({
      auth: options.auth.token,
      ...resilience,
      ...(baseUrl === undefined ? {} : { baseUrl }),
    });
  } else {
    octokit = new ResilientOctokit({
      authStrategy: createAppAuth,
      auth: {
        appId: options.auth.appId,
        privateKey: options.auth.privateKey,
        installationId: options.auth.installationId,
      },
      ...resilience,
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function nextCursor(
  pageInfo: z.infer<typeof pageInfoSchema>,
  connectionName: string,
): string | undefined {
  if (!pageInfo.hasNextPage) return undefined;
  if (pageInfo.endCursor === null) {
    throw new GitHubError(
      `${connectionName} returned an incomplete pagination cursor`,
      true,
      "unavailable",
    );
  }
  return pageInfo.endCursor;
}

export function normalizeGitHubError(error: unknown): GitHubError {
  if (error instanceof GitHubError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const retryAfterMs = githubRetryAfterMs(error);
  if (hasStatus(error, 429) || retryAfterMs !== undefined || /rate[ -]?limit/i.test(message)) {
    return new GitHubError(message, true, "rate_limited", {
      cause: error,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }
  if (hasStatus(error, 401) || hasStatus(error, 403)) {
    return new GitHubError(message, false, "authentication", { cause: error });
  }
  if (hasStatus(error, 404)) return new GitHubError(message, false, "not_found", { cause: error });
  if (hasStatus(error, 409) || hasStatus(error, 422)) {
    return new GitHubError(message, false, "conflict", { cause: error });
  }
  if (/5\d\d|timeout|connection|network/i.test(message)) {
    return new GitHubError(message, true, "unavailable", { cause: error });
  }
  if (error instanceof z.ZodError) {
    return new GitHubError(z.prettifyError(error), false, "invalid_response", { cause: error });
  }
  return new GitHubError(message, true, "unavailable", { cause: error });
}

export function githubRetryAfterMs(error: unknown, nowMs: number = Date.now()): number | undefined {
  const retryAfter = responseHeader(error, "retry-after");
  const retryAfterSeconds = retryAfter === undefined ? undefined : Number(retryAfter);
  if (retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds)) {
    return capRetryDelay(Math.max(0, retryAfterSeconds * 1_000));
  }
  if (retryAfter !== undefined) {
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) return capRetryDelay(Math.max(0, retryAt - nowMs));
  }
  if (responseHeader(error, "x-ratelimit-remaining") !== "0") return undefined;
  const reset = responseHeader(error, "x-ratelimit-reset");
  if (reset === undefined) return undefined;
  const resetSeconds = Number(reset);
  if (!Number.isFinite(resetSeconds)) return undefined;
  return capRetryDelay(Math.max(0, resetSeconds * 1_000 - nowMs + 1_000));
}

function capRetryDelay(milliseconds: number): number {
  return Math.min(milliseconds, GITHUB_MAX_RETRY_DELAY_MS);
}

function responseHeader(error: unknown, name: string): string | undefined {
  const response = property(error, "response");
  const headers = property(response, "headers");
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const value = property(headers, name) ?? property(headers, name.toLowerCase());
  if (typeof value === "string") return value;
  if (typeof value === "number") return value.toString();
  return undefined;
}

function property(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}
