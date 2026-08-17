import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import {
  ExecutionPackageBuilder,
  HarnessRouter,
  type AgentExecutionRequest,
  type AgentExecutionResult,
  type AgentHarness,
} from "@thor/agent";
import { projectItemIdSchema, type HarnessKind } from "@thor/domain";
import { FakeGitHubGateway, type MergeReadiness } from "@thor/github";
import { createTicketActivities, GitWorkspaceManager, ticketWorkflow } from "@thor/workflows";
import { afterEach, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const workflowsPath = fileURLToPath(
  new URL("../../packages/workflows/src/workflows.ts", import.meta.url),
);

describe("delivery integration", () => {
  let environment: TestWorkflowEnvironment | undefined;
  let temporaryRoot: string | undefined;

  afterEach(async () => {
    await environment?.teardown();
    environment = undefined;
    if (temporaryRoot !== undefined) await rm(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = undefined;
  });

  test("executes real Activities against an isolated Git worktree", async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "thor-integration-"));
    const sourceRoot = path.join(temporaryRoot, "sources");
    const worktreeRoot = path.join(temporaryRoot, "worktrees");
    const repositoryPath = path.join(sourceRoot, "example", "repository");
    const remotePath = path.join(temporaryRoot, "remote.git");
    await initializeRepository(repositoryPath, remotePath);

    const projectItemId = projectItemIdSchema.parse("PVTI_integration");
    const github = new IntegrationGitHubGateway([
      {
        projectItemId,
        projectId: "PVT_integration",
        updatedAt: "1",
        status: "design_blueprint",
        ticket: {
          projectItemId,
          repository: { owner: "example", name: "repository" },
          issueNumber: 91,
          title: "Add the delivery marker",
          body: "Create a durable delivery marker file.",
          workType: "feature",
          priority: "P2",
          acceptanceCriteria: ["delivery.txt exists"],
          dependencies: [],
          policy: {
            executionMode: "agent",
            planningDepth: "full",
            approvalPolicy: "autonomous",
            agentPolicy: "preferred",
            autonomousRepairBudget: 2,
          },
        },
      },
    ]);
    const harnesses = new HarnessRouter();
    harnesses.register(new EditingHarness("claude"));
    harnesses.register(new EditingHarness("codex"));
    const activities = createTicketActivities({
      github,
      harnesses,
      packageBuilder: new ExecutionPackageBuilder(path.resolve("resources")),
      workspaces: new GitWorkspaceManager({ sourceRoot, worktreeRoot }),
    });

    environment = await TestWorkflowEnvironment.createTimeSkipping();
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: "thor-delivery-integration",
      workflowsPath,
      activities,
    });
    const result = await worker.runUntil(
      environment.client.workflow.execute(ticketWorkflow, {
        workflowId: `github-project-item:${projectItemId}`,
        taskQueue: "thor-delivery-integration",
        args: [{ projectItemId, baseBranch: "main" }],
      }),
    );

    expect(result.run.status).toBe("done");
    expect(result.run.implementation?.changedFiles).toContain("delivery.txt");
    expect(result.auditTrail).toHaveLength(13);
    expect(github.mutationCounts.pullRequests).toBe(1);
    expect(github.mutationCounts.comments).toBe(2);
    expect(github.mutationCounts.merges).toBe(1);
    const remoteFile = await git(remotePath, [
      "show",
      "refs/heads/thor/PVTI_integration-2de61f7d:delivery.txt",
    ]);
    expect(remoteFile).toBe("delivered by Thor");
    const implementation = result.run.implementation;
    if (implementation === undefined) throw new Error("integration result omitted implementation");
    const recoveredSourceRoot = path.join(temporaryRoot, "recovered-sources");
    const recoveredRepository = path.join(recoveredSourceRoot, "example", "repository");
    await mkdir(path.dirname(recoveredRepository), { recursive: true });
    await git(temporaryRoot, ["clone", "--branch", "main", remotePath, recoveredRepository]);
    const recoveredWorkspace = await new GitWorkspaceManager({
      sourceRoot: recoveredSourceRoot,
      worktreeRoot: path.join(temporaryRoot, "recovered-worktrees"),
    }).existingWriteWorkspace(
      (await github.getProjectItem(projectItemId)).ticket,
      implementation.branch,
      new AbortController().signal,
    );
    expect(await readFile(path.join(recoveredWorkspace, "delivery.txt"), "utf8")).toBe(
      "delivered by Thor\n",
    );
  }, 60_000);
});

class EditingHarness implements AgentHarness {
  public constructor(public readonly kind: HarnessKind) {}

  public async execute(
    request: AgentExecutionRequest,
    signal: AbortSignal,
  ): Promise<AgentExecutionResult> {
    if (signal.aborted) throw signal.reason;
    const purpose = request.package.purpose;
    let structuredOutput: unknown;
    switch (purpose.kind) {
      case "blueprint":
        structuredOutput = {
          objective: "Add the delivery marker",
          constraints: [],
          architecture: "A repository fixture",
          proposedDesign: "Add delivery.txt",
          affectedAreas: ["delivery.txt"],
          implementationPlan: ["Create the marker"],
          testingPlan: ["Verify its content"],
          rolloutPlan: [],
          risks: [],
          unresolvedBlockingQuestions: [],
          acceptanceCriteria: ["delivery.txt exists"],
        };
        break;
      case "implementation":
        await writeFile(
          path.join(request.workspace, "delivery.txt"),
          "delivered by Thor\n",
          "utf8",
        );
        structuredOutput = {
          testsPassed: true,
          riskFlags: [],
          summary: "Added the delivery marker",
          verification: ["inspected delivery.txt"],
        };
        break;
      case "review":
        structuredOutput = {
          reviewRunId: "review-run-integration",
          reviewer: purpose.reviewer,
          findings: [],
          passed: true,
        };
        break;
      case "synthesis":
        structuredOutput = { findings: [], failureScope: "repair", fullReReview: false };
        break;
      case "repair":
        throw new Error("repair is not expected in this integration path");
    }
    return {
      executionId: request.package.executionId,
      harness: this.kind,
      finalResponse: JSON.stringify(structuredOutput),
      structuredOutput,
      sessionId: `${this.kind}-${request.package.executionId}`,
      packageDigest: request.package.digest,
      usage: {},
    };
  }
}

class IntegrationGitHubGateway extends FakeGitHubGateway {
  public override getMergeReadiness(): Promise<MergeReadiness> {
    return Promise.resolve({ mergeable: true, headSha: "integration-head", merged: false });
  }

  public override mergePullRequest(): Promise<string> {
    this.mutationCounts.merges += 1;
    return Promise.resolve("integration-merge");
  }
}

async function initializeRepository(repositoryPath: string, remotePath: string): Promise<void> {
  await mkdir(path.dirname(repositoryPath), { recursive: true });
  await git(process.cwd(), ["init", "--bare", remotePath]);
  await git(process.cwd(), ["init", "--initial-branch=main", repositoryPath]);
  await writeFile(path.join(repositoryPath, "README.md"), "# Fixture\n", "utf8");
  await git(repositoryPath, ["add", "README.md"]);
  await git(repositoryPath, ["commit", "-m", "Initial fixture"], gitIdentity());
  await git(repositoryPath, ["remote", "add", "origin", remotePath]);
  await git(repositoryPath, ["push", "--set-upstream", "origin", "main"]);
}

async function git(
  cwd: string,
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    env: environment,
    encoding: "utf8",
  });
  return result.stdout.trim();
}

function gitIdentity(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "Thor Integration",
    GIT_AUTHOR_EMAIL: "thor-integration@example.invalid",
    GIT_COMMITTER_NAME: "Thor Integration",
    GIT_COMMITTER_EMAIL: "thor-integration@example.invalid",
  };
}
