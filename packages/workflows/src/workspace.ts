import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { ProjectItemId, TicketContext } from "@thor/domain";

const execFileAsync = promisify(execFile);

export type PreparedWorkspace = {
  path: string;
  branch: string;
  baseSha: string;
};

export type FinalizedWorkspace = {
  commitSha: string;
  changedFiles: string[];
};

export type WorkspaceManager = {
  readWorkspace(ticket: TicketContext, baseBranch: string, signal: AbortSignal): Promise<string>;
  prepareWriteWorkspace(
    ticket: TicketContext,
    baseBranch: string,
    signal: AbortSignal,
  ): Promise<PreparedWorkspace>;
  existingWriteWorkspace(
    ticket: TicketContext,
    branch: string,
    signal: AbortSignal,
  ): Promise<string>;
  finalizeWriteWorkspace(
    workspace: string,
    previousSha: string,
    commitMessage: string,
    branch: string,
    signal: AbortSignal,
  ): Promise<FinalizedWorkspace>;
};

export type GitWorkspaceManagerOptions = {
  sourceRoot: string;
  worktreeRoot: string;
  gitAuthorName?: string;
  gitAuthorEmail?: string;
};

export class GitWorkspaceManager implements WorkspaceManager {
  private readonly sourceRoot: string;
  private readonly worktreeRoot: string;

  public constructor(private readonly options: GitWorkspaceManagerOptions) {
    this.sourceRoot = path.resolve(options.sourceRoot);
    this.worktreeRoot = path.resolve(options.worktreeRoot);
  }

  public async readWorkspace(
    ticket: TicketContext,
    baseBranch: string,
    signal: AbortSignal,
  ): Promise<string> {
    const repositoryPath = await this.repositoryWorkspace(ticket, signal);
    await git(repositoryPath, ["worktree", "prune"], signal);
    await git(repositoryPath, ["fetch", "--prune", "origin"], signal);
    const baseRef = `refs/remotes/origin/${baseBranch}`;
    await git(repositoryPath, ["rev-parse", "--verify", baseRef], signal);
    const worktreePath = safeChild(this.worktreeRoot, `${worktreeKey(ticket.projectItemId)}-read`);
    await mkdir(this.worktreeRoot, { recursive: true });
    if (await isDirectory(worktreePath)) {
      const status = await git(worktreePath, ["status", "--porcelain"], signal);
      if (status.length > 0) {
        throw new WorkspaceError(`read-only worktree ${worktreePath} contains changes`, false);
      }
      await git(worktreePath, ["checkout", "--detach", baseRef], signal);
      return worktreePath;
    }
    await git(repositoryPath, ["worktree", "add", "--detach", worktreePath, baseRef], signal);
    return worktreePath;
  }

  private async repositoryWorkspace(ticket: TicketContext, signal: AbortSignal): Promise<string> {
    const repositoryPath = safeChild(
      this.sourceRoot,
      ticket.repository.owner,
      ticket.repository.name,
    );
    await requireDirectory(repositoryPath);
    await git(repositoryPath, ["rev-parse", "--is-inside-work-tree"], signal);
    return repositoryPath;
  }

  public async prepareWriteWorkspace(
    ticket: TicketContext,
    baseBranch: string,
    signal: AbortSignal,
  ): Promise<PreparedWorkspace> {
    const repositoryPath = await this.repositoryWorkspace(ticket, signal);
    await git(repositoryPath, ["worktree", "prune"], signal);
    await git(repositoryPath, ["fetch", "--prune", "origin"], signal);
    const baseSha = await git(repositoryPath, ["rev-parse", `origin/${baseBranch}`], signal);
    const branch = branchFor(ticket.projectItemId);
    const worktreePath = safeChild(this.worktreeRoot, worktreeKey(ticket.projectItemId));
    await mkdir(this.worktreeRoot, { recursive: true });

    if (await isDirectory(worktreePath)) {
      const actualBranch = await git(worktreePath, ["branch", "--show-current"], signal);
      if (actualBranch !== branch) {
        throw new WorkspaceError(
          `worktree ${worktreePath} uses ${actualBranch}, expected ${branch}`,
          false,
        );
      }
      return { path: worktreePath, branch, baseSha };
    }

    const localBranchExists =
      (await gitExitCode(
        repositoryPath,
        ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
        signal,
      )) === 0;
    const remoteBranchExists = await ensureRemoteBranchRef(repositoryPath, branch, signal);
    if (localBranchExists) {
      await git(repositoryPath, ["worktree", "add", worktreePath, branch], signal);
    } else {
      await git(
        repositoryPath,
        [
          "worktree",
          "add",
          "-b",
          branch,
          worktreePath,
          remoteBranchExists ? `origin/${branch}` : `origin/${baseBranch}`,
        ],
        signal,
      );
    }
    return { path: worktreePath, branch, baseSha };
  }

  public async existingWriteWorkspace(
    ticket: TicketContext,
    branch: string,
    signal: AbortSignal,
  ): Promise<string> {
    const worktreePath = safeChild(this.worktreeRoot, worktreeKey(ticket.projectItemId));
    if (await isDirectory(worktreePath)) {
      await requireBranch(worktreePath, branch, signal);
      return worktreePath;
    }
    await mkdir(this.worktreeRoot, { recursive: true });
    const repositoryPath = await this.repositoryWorkspace(ticket, signal);
    await git(repositoryPath, ["worktree", "prune"], signal);
    await git(repositoryPath, ["fetch", "--prune", "origin"], signal);
    const localBranchExists =
      (await gitExitCode(
        repositoryPath,
        ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
        signal,
      )) === 0;
    if (localBranchExists) {
      await git(repositoryPath, ["worktree", "add", worktreePath, branch], signal);
    } else {
      const remoteBranchExists = await ensureRemoteBranchRef(repositoryPath, branch, signal);
      if (!remoteBranchExists) {
        throw new WorkspaceError(`remote branch ${branch} does not exist`, false);
      }
      await git(
        repositoryPath,
        ["worktree", "add", "-b", branch, worktreePath, `origin/${branch}`],
        signal,
      );
    }
    return worktreePath;
  }

  public async finalizeWriteWorkspace(
    workspace: string,
    previousSha: string,
    commitMessage: string,
    branch: string,
    signal: AbortSignal,
  ): Promise<FinalizedWorkspace> {
    await git(workspace, ["add", "--all"], signal);
    const hasStagedChanges =
      (await gitExitCode(workspace, ["diff", "--cached", "--quiet"], signal)) === 1;
    if (hasStagedChanges) {
      await git(workspace, ["commit", "-m", commitMessage], signal, this.gitIdentity());
    }
    const commitSha = await git(workspace, ["rev-parse", "HEAD"], signal);
    if (commitSha === previousSha) {
      throw new WorkspaceError("agent execution produced no commit", false);
    }
    const status = await git(workspace, ["status", "--porcelain"], signal);
    if (status.length > 0) {
      throw new WorkspaceError("agent execution left uncommitted workspace changes", false);
    }
    await git(workspace, ["push", "--set-upstream", "origin", `HEAD:refs/heads/${branch}`], signal);
    const changed = await git(workspace, ["diff", "--name-only", `${previousSha}...HEAD`], signal);
    return {
      commitSha,
      changedFiles: changed.length === 0 ? [] : changed.split("\n").filter(Boolean).sort(),
    };
  }

  private gitIdentity(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      GIT_AUTHOR_NAME: this.options.gitAuthorName ?? "Thor Automation",
      GIT_AUTHOR_EMAIL: this.options.gitAuthorEmail ?? "thor@localhost",
      GIT_COMMITTER_NAME: this.options.gitAuthorName ?? "Thor Automation",
      GIT_COMMITTER_EMAIL: this.options.gitAuthorEmail ?? "thor@localhost",
    };
  }
}

export class WorkspaceError extends Error {
  public constructor(
    message: string,
    public readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkspaceError";
  }
}

async function git(
  cwd: string,
  args: string[],
  signal: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      env,
      signal,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return result.stdout.trim();
  } catch (error) {
    if (signal.aborted) throw error;
    throw new WorkspaceError(
      `git ${args[0] ?? "command"} failed in ${cwd}: ${errorMessage(error)}`,
      isRetryableGitError(error),
      { cause: error },
    );
  }
}

async function gitExitCode(cwd: string, args: string[], signal: AbortSignal): Promise<number> {
  try {
    await execFileAsync("git", args, { cwd, signal, encoding: "utf8" });
    return 0;
  } catch (error) {
    if (signal.aborted) throw error;
    if (typeof error === "object" && error !== null && "code" in error) {
      const code = error.code;
      if (typeof code === "number") return code;
    }
    throw new WorkspaceError(`git ${args[0] ?? "command"} failed: ${errorMessage(error)}`, false, {
      cause: error,
    });
  }
}

export function branchFor(projectItemId: ProjectItemId): string {
  const readable = projectItemId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 40);
  return `thor/${readable}-${worktreeKey(projectItemId).slice(0, 8)}`;
}

function worktreeKey(projectItemId: ProjectItemId): string {
  return createHash("sha256").update(projectItemId).digest("hex").slice(0, 24);
}

function safeChild(root: string, ...segments: string[]): string {
  const target = path.resolve(root, ...segments);
  const relative = path.relative(root, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new WorkspaceError(`workspace path escapes configured root: ${target}`, false);
  }
  return target;
}

async function requireDirectory(target: string): Promise<void> {
  if (!(await isDirectory(target))) {
    throw new WorkspaceError(`required repository directory does not exist: ${target}`, false);
  }
}

async function requireBranch(
  workspace: string,
  expectedBranch: string,
  signal: AbortSignal,
): Promise<void> {
  const actualBranch = await git(workspace, ["branch", "--show-current"], signal);
  if (actualBranch !== expectedBranch) {
    throw new WorkspaceError(
      `worktree ${workspace} uses ${actualBranch}, expected ${expectedBranch}`,
      false,
    );
  }
}

async function ensureRemoteBranchRef(
  repositoryPath: string,
  branch: string,
  signal: AbortSignal,
): Promise<boolean> {
  const remoteRef = `refs/remotes/origin/${branch}`;
  if (
    (await gitExitCode(repositoryPath, ["show-ref", "--verify", "--quiet", remoteRef], signal)) ===
    0
  ) {
    return true;
  }
  const remoteHead = `refs/heads/${branch}`;
  const fetchResult = await gitExitCode(
    repositoryPath,
    ["fetch", "origin", `+${remoteHead}:${remoteRef}`],
    signal,
  );
  return fetchResult === 0;
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isRetryableGitError(error: unknown): boolean {
  return /timeout|connection|network|temporar|could not resolve|remote hung up/i.test(
    errorMessage(error),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
