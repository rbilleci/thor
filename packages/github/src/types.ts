import type {
  DeferredIssueId,
  ProjectItemId,
  RepositoryRef,
  TicketContext,
  TicketStatus,
} from "@thor/domain";

export type ProjectItemSnapshot = {
  projectItemId: ProjectItemId;
  projectId: string;
  updatedAt: string;
  status: TicketStatus;
  ticket: TicketContext;
};

export type StatusTransition = {
  projectItemId: ProjectItemId;
  expectedStatus: TicketStatus;
  expectedUpdatedAt?: string;
  targetStatus: TicketStatus;
};

export type PullRequestRef = {
  number: number;
  nodeId: string;
  url: string;
  headSha: string;
  merged: boolean;
  mergeCommitSha?: string;
};

export type DeferredProjectField =
  | { fieldId: string; kind: "single_select"; optionId: string }
  | { fieldId: string; kind: "text"; text: string };

export type DeferredIssueDraft = {
  repository: RepositoryRef;
  title: string;
  body: string;
  labels: string[];
  originKey: string;
  projectFields: DeferredProjectField[];
};

export type DeferredIssueRef = {
  issueId: DeferredIssueId;
  number: number;
  url: string;
  projectItemId: ProjectItemId;
};

export type MergeReadiness = {
  mergeable: boolean;
  reason?: string;
  headSha: string;
  merged: boolean;
  mergeCommitSha?: string;
};

export type GitHubGateway = {
  getProjectItem(projectItemId: ProjectItemId): Promise<ProjectItemSnapshot>;
  listProjectItemsUpdatedSince(since: string): Promise<ProjectItemSnapshot[]>;
  transitionStatus(transition: StatusTransition): Promise<ProjectItemSnapshot>;
  ensureBranch(repository: RepositoryRef, branch: string, sourceSha: string): Promise<string>;
  ensurePullRequest(input: {
    repository: RepositoryRef;
    branch: string;
    base: string;
    title: string;
    body: string;
  }): Promise<PullRequestRef>;
  upsertComment(input: {
    repository: RepositoryRef;
    issueNumber: number;
    idempotencyKey: string;
    body: string;
  }): Promise<number>;
  ensureDeferredIssue(draft: DeferredIssueDraft): Promise<DeferredIssueRef>;
  getMergeReadiness(repository: RepositoryRef, pullRequestNumber: number): Promise<MergeReadiness>;
  mergePullRequest(input: {
    repository: RepositoryRef;
    pullRequestNumber: number;
    expectedHeadSha: string;
    commitTitle: string;
  }): Promise<string>;
};

export class GitHubError extends Error {
  public constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly code:
      | "not_found"
      | "conflict"
      | "invalid_response"
      | "authentication"
      | "rate_limited"
      | "unavailable",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GitHubError";
  }
}
