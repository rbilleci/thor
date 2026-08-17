import type { BoardStateKey } from "@thor/config/schema";
import type { DeferredIssueId, ProjectItemId, RepositoryRef, TicketContext } from "@thor/domain";

export type ProjectItemSnapshot = {
  projectItemId: ProjectItemId;
  projectId: string;
  updatedAt: string;
  status: BoardStateKey;
  ticket: TicketContext;
};

export type ProjectItemObservation =
  | { kind: "present"; projectItemId: ProjectItemId; snapshot: ProjectItemSnapshot }
  | { kind: "removed"; projectItemId: ProjectItemId; reason: string }
  | {
      kind: "unreadable";
      projectItemId: ProjectItemId;
      reason: string;
      retryable: boolean;
    };

export type StatusTransition = {
  projectItemId: ProjectItemId;
  expectedStatus: BoardStateKey;
  expectedUpdatedAt?: string;
  expectedTicket?: TicketContext;
  targetStatus: BoardStateKey;
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

export type GitHubErrorOptions = ErrorOptions & {
  retryAfterMs?: number;
};

export type GitHubGateway = {
  getProjectItem(projectItemId: ProjectItemId): Promise<ProjectItemSnapshot>;
  listProjectItemObservations(): Promise<ProjectItemObservation[]>;
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
  closeIssue(repository: RepositoryRef, issueNumber: number): Promise<void>;
};

export class GitHubError extends Error {
  public readonly retryAfterMs: number | undefined;

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
    options?: GitHubErrorOptions,
  ) {
    super(message, options);
    this.name = "GitHubError";
    this.retryAfterMs = options?.retryAfterMs;
  }
}
