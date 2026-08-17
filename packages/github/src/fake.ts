import {
  deferredIssueIdSchema,
  projectItemIdSchema,
  type ProjectItemId,
  type RepositoryRef,
  type TicketStatus,
} from "@thor/domain";

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

export class FakeGitHubGateway implements GitHubGateway {
  public readonly mutationCounts = {
    transitions: 0,
    branches: 0,
    pullRequests: 0,
    comments: 0,
    deferredIssues: 0,
    merges: 0,
  };

  private readonly items = new Map<ProjectItemId, ProjectItemSnapshot>();
  private readonly branches = new Map<string, string>();
  private readonly pulls = new Map<string, PullRequestRef>();
  private readonly comments = new Map<string, { id: number; body: string }>();
  private readonly deferredIssues = new Map<string, DeferredIssueRef>();
  private readonly readiness = new Map<string, MergeReadiness>();

  public constructor(items: ProjectItemSnapshot[] = []) {
    items.forEach((item) => this.items.set(item.projectItemId, structuredClone(item)));
  }

  public async getProjectItem(projectItemId: ProjectItemId): Promise<ProjectItemSnapshot> {
    const item = this.items.get(projectItemId);
    if (item === undefined) throw new GitHubError("Project item not found", false, "not_found");
    return Promise.resolve(structuredClone(item));
  }

  public async listProjectItemsUpdatedSince(since: string): Promise<ProjectItemSnapshot[]> {
    return Promise.resolve(
      [...this.items.values()]
        .filter((item) => item.updatedAt > since)
        .map((item) => structuredClone(item)),
    );
  }

  public async transitionStatus(transition: StatusTransition): Promise<ProjectItemSnapshot> {
    const item = await this.getProjectItem(transition.projectItemId);
    if (item.status === transition.targetStatus) return item;
    if (
      item.status !== transition.expectedStatus ||
      (transition.expectedUpdatedAt !== undefined &&
        item.updatedAt !== transition.expectedUpdatedAt)
    ) {
      throw new GitHubError("Project state changed concurrently", false, "conflict");
    }
    const changed = {
      ...item,
      status: transition.targetStatus,
      updatedAt: incrementVersion(item.updatedAt),
    };
    this.items.set(item.projectItemId, changed);
    this.mutationCounts.transitions += 1;
    return structuredClone(changed);
  }

  public setHumanStatus(projectItemId: ProjectItemId, status: TicketStatus): void {
    const item = this.items.get(projectItemId);
    if (item === undefined) throw new Error("Project item not found");
    this.items.set(projectItemId, { ...item, status, updatedAt: incrementVersion(item.updatedAt) });
  }

  public async ensureBranch(
    repository: RepositoryRef,
    branch: string,
    sourceSha: string,
  ): Promise<string> {
    const key = `${fullName(repository)}:${branch}`;
    const existing = this.branches.get(key);
    if (existing !== undefined) return Promise.resolve(existing);
    this.branches.set(key, sourceSha);
    this.mutationCounts.branches += 1;
    return Promise.resolve(sourceSha);
  }

  public async ensurePullRequest(input: {
    repository: RepositoryRef;
    branch: string;
    base: string;
    title: string;
    body: string;
  }): Promise<PullRequestRef> {
    const key = `${fullName(input.repository)}:${input.branch}:${input.base}`;
    const existing = this.pulls.get(key);
    if (existing !== undefined) return Promise.resolve(existing);
    const pull: PullRequestRef = {
      number: this.pulls.size + 1,
      nodeId: `PR_${this.pulls.size + 1}`,
      url: `https://example.invalid/${fullName(input.repository)}/pull/${this.pulls.size + 1}`,
      headSha: this.branches.get(`${fullName(input.repository)}:${input.branch}`) ?? "unknown",
      merged: false,
    };
    this.pulls.set(key, pull);
    this.mutationCounts.pullRequests += 1;
    return Promise.resolve(pull);
  }

  public async upsertComment(input: {
    repository: RepositoryRef;
    issueNumber: number;
    idempotencyKey: string;
    body: string;
  }): Promise<number> {
    const key = `${fullName(input.repository)}:${input.issueNumber}:${input.idempotencyKey}`;
    const existing = this.comments.get(key);
    if (existing !== undefined) {
      existing.body = input.body;
      return Promise.resolve(existing.id);
    }
    const id = this.comments.size + 1;
    this.comments.set(key, { id, body: input.body });
    this.mutationCounts.comments += 1;
    return Promise.resolve(id);
  }

  public async ensureDeferredIssue(draft: DeferredIssueDraft): Promise<DeferredIssueRef> {
    const key = `${fullName(draft.repository)}:${draft.originKey}`;
    const existing = this.deferredIssues.get(key);
    if (existing !== undefined) return Promise.resolve(existing);
    const sequence = this.deferredIssues.size + 1;
    const issue: DeferredIssueRef = {
      issueId: deferredIssueIdSchema.parse(`I_deferred_${sequence}`),
      number: 1_000 + sequence,
      url: `https://example.invalid/${fullName(draft.repository)}/issues/${1_000 + sequence}`,
      projectItemId: projectItemIdSchema.parse(`PVTI_deferred_${sequence}`),
    };
    this.deferredIssues.set(key, issue);
    this.mutationCounts.deferredIssues += 1;
    return Promise.resolve(issue);
  }

  public setMergeReadiness(
    repository: RepositoryRef,
    pullRequestNumber: number,
    value: MergeReadiness,
  ): void {
    this.readiness.set(`${fullName(repository)}:${pullRequestNumber}`, value);
  }

  public async getMergeReadiness(
    repository: RepositoryRef,
    pullRequestNumber: number,
  ): Promise<MergeReadiness> {
    return Promise.resolve(
      this.readiness.get(`${fullName(repository)}:${pullRequestNumber}`) ?? {
        mergeable: true,
        headSha: "head-sha",
        merged: false,
      },
    );
  }

  public async mergePullRequest(input: {
    repository: RepositoryRef;
    pullRequestNumber: number;
    expectedHeadSha: string;
    commitTitle: string;
  }): Promise<string> {
    const key = `${fullName(input.repository)}:${input.pullRequestNumber}`;
    const status = await this.getMergeReadiness(input.repository, input.pullRequestNumber);
    if (status.merged) return status.mergeCommitSha ?? status.headSha;
    if (!status.mergeable || status.headSha !== input.expectedHeadSha) {
      throw new GitHubError("pull request is not mergeable at expected head", false, "conflict");
    }
    this.readiness.set(key, { ...status, merged: true });
    this.mutationCounts.merges += 1;
    return `merge-${input.expectedHeadSha}`;
  }
}

function fullName(repository: RepositoryRef): string {
  return `${repository.owner}/${repository.name}`;
}

function incrementVersion(value: string): string {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) ? String(numeric + 1) : `${value}.next`;
}
