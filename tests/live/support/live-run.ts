import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { WorkflowNotFoundError, type WorkflowHandle } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { ExecutionPackageBuilder, HarnessRouter } from "@thor/agent";
import { workflowIdFor, type ApprovalPolicy, type TicketStatus } from "@thor/domain";
import { OctokitGitHubGateway } from "@thor/github";
import { isRetryableGitHubFailure, retryInfrastructureOperation } from "@thor/runtime";
import {
  branchFor,
  createTicketActivities,
  GitWorkspaceManager,
  ticketWorkflow,
  ticketStateQuery,
  type TicketWorkflowResult,
  type TicketWorkflowState,
} from "@thor/workflows";

import {
  createLiveRunId,
  LiveGitHubFixtureManager,
  LiveRunManifest,
  loadLiveTestConfiguration,
  type LiveFixture,
  type LiveRelatedIssue,
  type LiveTestConfiguration,
} from "./github-fixture.js";
import { ScriptedLiveHarness, type ScriptedLiveScenario } from "./scripted-harness.js";

const execFileAsync = promisify(execFile);
const workflowsPath = fileURLToPath(
  new URL("../../../packages/workflows/src/workflows.ts", import.meta.url),
);

export type LiveRunOptions = {
  scenario: ScriptedLiveScenario;
  description: string;
  approvalPolicy?: ApprovalPolicy;
};

type WorkspaceFixture = {
  temporaryRoot: string;
  sourceRoot: string;
  worktreeRoot: string;
  repositoryPath: string;
};

type WorkerFixture = {
  worker: Worker;
  run: Promise<void>;
};

type DeliveryRecord = {
  branch: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  mergeCommitSha?: string;
};

type TicketHandle = WorkflowHandle<typeof ticketWorkflow>;

export class LiveDeliveryRun {
  public readonly branch: string;
  public readonly repairFile: string;
  private readonly workspaces: WorkspaceFixture[] = [];
  private readonly relatedIssues: LiveRelatedIssue[] = [];
  private workerFixture: WorkerFixture;
  private workspace: WorkspaceFixture;
  private delivery: DeliveryRecord | undefined;
  private workerGeneration = 1;

  private constructor(
    public readonly configuration: LiveTestConfiguration,
    public readonly runId: string,
    public readonly deliveryFile: string,
    public readonly fixture: LiveFixture,
    public readonly fixtures: LiveGitHubFixtureManager,
    public readonly manifest: LiveRunManifest,
    public readonly github: OctokitGitHubGateway,
    public readonly environment: TestWorkflowEnvironment,
    public readonly handle: TicketHandle,
    private readonly taskQueue: string,
    private readonly options: LiveRunOptions,
    private readonly synchronizer: ManagedProcess,
    workspace: WorkspaceFixture,
    workerFixture: WorkerFixture,
    private readonly previousGhToken: string | undefined,
  ) {
    this.workspace = workspace;
    this.workspaces.push(workspace);
    this.workerFixture = workerFixture;
    this.branch = branchFor(fixture.projectItemId);
    this.repairFile = `thor-live/${runId}-repair.txt`;
  }

  public static async start(options: LiveRunOptions): Promise<LiveDeliveryRun> {
    const configuration = await loadLiveTestConfiguration();
    const runId = createLiveRunId();
    const deliveryFile = `thor-live/${runId}.txt`;
    const taskQueue = `thor-live-${runId}`;
    const manifest = await LiveRunManifest.create(configuration, runId);
    const fixtures = new LiveGitHubFixtureManager(configuration, manifest);
    const previousGhToken = process.env.GH_TOKEN;
    process.env.GH_TOKEN = configuration.token;
    let fixture: LiveFixture | undefined;
    let environment: TestWorkflowEnvironment | undefined;
    let workspace: WorkspaceFixture | undefined;
    let workerFixture: WorkerFixture | undefined;
    let synchronizer: ManagedProcess | undefined;

    try {
      const project = await fixtures.prepare();
      fixture = await fixtures.createFixture(runId, deliveryFile, {
        scenario: options.description,
        ...(options.approvalPolicy === undefined ? {} : { approvalPolicy: options.approvalPolicy }),
      });
      await manifest.recordBranch(branchFor(fixture.projectItemId));
      workspace = await createWorkspace(configuration, runId, 1);
      const declarationPath = path.join(workspace.temporaryRoot, "delivery-project.json");
      await writeFile(declarationPath, `${JSON.stringify(project.declaration, null, 2)}\n`, "utf8");
      const github = new OctokitGitHubGateway({
        auth: { kind: "token", token: configuration.token },
        project: project.gateway,
      });
      environment = await TestWorkflowEnvironment.createLocal();
      workerFixture = await startWorker({
        environment,
        taskQueue,
        github,
        workspace,
        runId,
        deliveryFile,
        repairFile: `thor-live/${runId}-repair.txt`,
        scenario: options.scenario,
      });
      await manifest.markRunning();

      synchronizer = startSynchronizer({
        temporalAddress: environment.address,
        temporalNamespace: environment.namespace ?? "default",
        taskQueue,
        token: configuration.token,
        declarationPath,
        sourceRoot: workspace.sourceRoot,
        worktreeRoot: workspace.worktreeRoot,
        pollIntervalMs: configuration.pollIntervalMs,
      });
      await synchronizer.waitFor('"event":"synchronizer_started"', configuration.timeoutMs);

      const workflowId = workflowIdFor(fixture.projectItemId);
      const handle = environment.client.workflow.getHandle<typeof ticketWorkflow>(workflowId);
      await waitUntil(
        async () => {
          try {
            await handle.describe();
            return true;
          } catch (error) {
            if (error instanceof WorkflowNotFoundError) return false;
            throw error;
          }
        },
        configuration.timeoutMs,
        `polling synchronizer did not start ${workflowId}`,
      );

      return new LiveDeliveryRun(
        configuration,
        runId,
        deliveryFile,
        fixture,
        fixtures,
        manifest,
        github,
        environment,
        handle,
        taskQueue,
        options,
        synchronizer,
        workspace,
        workerFixture,
        previousGhToken,
      );
    } catch (error) {
      await manifest.markFailed(error);
      process.stderr.write(
        `Thor live E2E retained failed fixtures. Manifest: ${manifest.filePath}\n`,
      );
      await synchronizer?.stop();
      if (workerFixture !== undefined) await stopWorker(workerFixture);
      await environment?.teardown();
      if (fixture !== undefined && configuration.cleanup !== "never") {
        try {
          await fixtures.cleanup({
            fixture,
            branch: branchFor(fixture.projectItemId),
          });
        } catch (cleanupError) {
          process.stderr.write(
            `Thor live E2E could not clean its failed setup fixture: ${String(cleanupError)}\n`,
          );
        }
      }
      if (workspace !== undefined) {
        await rm(workspace.temporaryRoot, { recursive: true, force: true });
      }
      restoreGhToken(previousGhToken);
      throw error;
    }
  }

  public async state(): Promise<TicketWorkflowState> {
    return this.handle.query(ticketStateQuery);
  }

  public async waitForWorkflowStatus(status: TicketStatus): Promise<TicketWorkflowState> {
    let latest: TicketWorkflowState | undefined;
    await waitUntil(
      async () => {
        latest = await this.state();
        return latest.run?.status === status;
      },
      this.configuration.timeoutMs,
      `Workflow ${this.handle.workflowId} did not reach ${status}`,
    );
    if (latest === undefined) throw new Error("live Workflow status wait did not query state");
    return latest;
  }

  public async waitForProjectStatus(status: TicketStatus): Promise<void> {
    await waitUntil(
      async () => (await this.github.getProjectItem(this.fixture.projectItemId)).status === status,
      this.configuration.timeoutMs,
      `GitHub Project item ${this.fixture.projectItemId} did not reach ${status}`,
      1_000,
    );
  }

  public async setProjectStatus(status: TicketStatus): Promise<void> {
    await this.fixtures.setStatus(this.fixture.projectItemId, status);
  }

  public async removeProjectItem(): Promise<void> {
    await this.fixtures.removeProjectItem(this.fixture.projectItemId);
  }

  public async waitForActiveExecution(): Promise<TicketWorkflowState> {
    let latest: TicketWorkflowState | undefined;
    await waitUntil(
      async () => {
        latest = await this.state();
        return latest.activeExecutionIds.length > 0;
      },
      this.configuration.timeoutMs,
      `Workflow ${this.handle.workflowId} did not start an agent execution`,
    );
    if (latest === undefined) throw new Error("live active execution wait did not query state");
    return latest;
  }

  public async waitForNoActiveExecutions(): Promise<TicketWorkflowState> {
    return this.waitForState(
      "all agent executions to stop",
      (state) => state.activeExecutionIds.length === 0,
    );
  }

  public async waitForState(
    description: string,
    predicate: (state: TicketWorkflowState) => boolean,
  ): Promise<TicketWorkflowState> {
    let latest: TicketWorkflowState | undefined;
    await waitUntil(
      async () => {
        latest = await this.state();
        return predicate(latest);
      },
      this.configuration.timeoutMs,
      `Workflow ${this.handle.workflowId} did not reach ${description}`,
    );
    if (latest === undefined) throw new Error("live Workflow state wait did not query state");
    return latest;
  }

  public async result(): Promise<TicketWorkflowResult> {
    const result = this.handle.result();
    void result.catch(() => undefined);
    return withTimeout(
      result,
      this.configuration.timeoutMs,
      `Workflow ${this.handle.workflowId} did not complete`,
    );
  }

  public async restartWorker(): Promise<void> {
    await stopWorker(this.workerFixture);
    await rm(this.workspace.temporaryRoot, { recursive: true, force: true });
    this.workerGeneration += 1;
    const workspace = await createWorkspace(this.configuration, this.runId, this.workerGeneration);
    this.workspace = workspace;
    this.workspaces.push(workspace);
    this.workerFixture = await startWorker({
      environment: this.environment,
      taskQueue: this.taskQueue,
      github: this.github,
      workspace,
      runId: this.runId,
      deliveryFile: this.deliveryFile,
      repairFile: this.repairFile,
      scenario: this.options.scenario,
    });
  }

  public async readOriginFile(filePath: string): Promise<string> {
    await git(this.workspace.repositoryPath, ["fetch", "origin", "main"]);
    return git(this.workspace.repositoryPath, ["show", `origin/main:${filePath}`]);
  }

  public recordDelivery(input: DeliveryRecord): void {
    this.delivery = input;
  }

  public addRelatedIssue(issue: LiveRelatedIssue): void {
    this.relatedIssues.push(issue);
  }

  public async complete(): Promise<void> {
    const comments = await this.fixtures.issueComments(this.fixture.issueNumber);
    await this.manifest.recordComments(
      comments.map((comment) => ({ id: comment.id, url: comment.html_url })),
    );
    await this.manifest.recordRelatedIssues(this.relatedIssues);
    if (this.delivery === undefined) {
      await this.manifest.markPassed();
    } else {
      await this.manifest.recordDelivery(this.delivery);
      await this.manifest.markPassed();
    }
  }

  public async fail(error: unknown): Promise<void> {
    await this.captureFailureArtifacts();
    await this.manifest.markFailed(error);
    process.stderr.write(
      `Thor live E2E retained failed fixtures. Manifest: ${this.manifest.filePath}\n`,
    );
  }

  private async captureFailureArtifacts(): Promise<void> {
    try {
      const state = await this.state();
      const implementation = state.run?.implementation;
      if (implementation !== undefined) {
        const pull = await this.fixtures.pullRequest(implementation.pullRequestNumber);
        this.delivery = {
          branch: implementation.branch,
          pullRequestNumber: implementation.pullRequestNumber,
          pullRequestUrl: pull.html_url,
          ...(pull.merge_commit_sha == null ? {} : { mergeCommitSha: pull.merge_commit_sha }),
        };
        await this.manifest.recordDelivery(this.delivery);
      }
      for (const deferral of state.run?.deferrals ?? []) {
        if (deferral.issueId === undefined) continue;
        const related = await this.fixtures.relatedIssue(deferral.issueId);
        if (!this.relatedIssues.some((candidate) => candidate.issueId === related.issueId)) {
          this.relatedIssues.push(related);
        }
      }
      await this.manifest.recordRelatedIssues(this.relatedIssues);
      const comments = await this.fixtures.issueComments(this.fixture.issueNumber);
      await this.manifest.recordComments(
        comments.map((comment) => ({ id: comment.id, url: comment.html_url })),
      );
    } catch (captureError) {
      process.stderr.write(
        `Thor live E2E could not capture every failure artifact: ${String(captureError)}\n`,
      );
    }
  }

  public async dispose(passed: boolean): Promise<void> {
    await this.synchronizer.stop();
    await stopWorker(this.workerFixture);
    await this.environment.teardown();
    for (const workspace of this.workspaces) {
      await rm(workspace.temporaryRoot, { recursive: true, force: true });
    }
    const shouldCleanup =
      this.configuration.cleanup === "always" ||
      (this.configuration.cleanup === "success" && passed);
    if (shouldCleanup) {
      await this.fixtures.cleanup({
        fixture: this.fixture,
        branch: this.branch,
        ...(this.delivery === undefined
          ? {}
          : { pullRequestNumber: this.delivery.pullRequestNumber }),
        relatedIssues: this.relatedIssues,
      });
    }
    restoreGhToken(this.previousGhToken);
  }
}

export async function runLiveScenario(
  options: LiveRunOptions,
  exercise: (run: LiveDeliveryRun) => Promise<void>,
): Promise<void> {
  const run = await LiveDeliveryRun.start(options);
  let passed = false;
  try {
    await exercise(run);
    await run.complete();
    passed = true;
  } catch (error) {
    await run.fail(error);
    throw error;
  } finally {
    await run.dispose(passed);
  }
}

async function startWorker(input: {
  environment: TestWorkflowEnvironment;
  taskQueue: string;
  github: OctokitGitHubGateway;
  workspace: WorkspaceFixture;
  runId: string;
  deliveryFile: string;
  repairFile: string;
  scenario: ScriptedLiveScenario;
}): Promise<WorkerFixture> {
  const harnesses = new HarnessRouter();
  const harnessOptions = { scenario: input.scenario, repairFile: input.repairFile } as const;
  harnesses.register(
    new ScriptedLiveHarness("claude", input.runId, input.deliveryFile, harnessOptions),
  );
  harnesses.register(
    new ScriptedLiveHarness("codex", input.runId, input.deliveryFile, harnessOptions),
  );
  const activities = createTicketActivities({
    github: input.github,
    harnesses,
    packageBuilder: new ExecutionPackageBuilder(path.resolve("resources")),
    workspaces: new GitWorkspaceManager({
      sourceRoot: input.workspace.sourceRoot,
      worktreeRoot: input.workspace.worktreeRoot,
    }),
  });
  const worker = await Worker.create({
    connection: input.environment.nativeConnection,
    namespace: input.environment.namespace ?? "default",
    taskQueue: input.taskQueue,
    workflowsPath,
    activities,
    maxHeartbeatThrottleInterval: "10 seconds",
  });
  return { worker, run: worker.run() };
}

async function stopWorker(fixture: WorkerFixture): Promise<void> {
  fixture.worker.shutdown();
  await fixture.run;
}

class ManagedProcess {
  private output = "";

  public constructor(private readonly child: ChildProcess) {
    child.stdout?.on("data", (chunk: unknown) => this.append(chunk));
    child.stderr?.on("data", (chunk: unknown) => this.append(chunk));
  }

  public async waitFor(value: string, timeoutMs: number): Promise<void> {
    await waitUntil(
      () => {
        if (this.output.includes(value)) return true;
        if (this.child.exitCode !== null) {
          throw new Error(
            `synchronizer exited with ${this.child.exitCode.toString()}: ${this.output.slice(-8_000)}`,
          );
        }
        return false;
      },
      timeoutMs,
      `synchronizer did not emit ${value}: ${this.output.slice(-8_000)}`,
    );
  }

  public async stop(): Promise<void> {
    if (this.child.exitCode !== null) return;
    this.child.kill("SIGTERM");
    const exited = await Promise.race([
      once(this.child, "exit").then(() => true),
      delay(5_000).then(() => false),
    ]);
    if (!exited) {
      this.child.kill("SIGKILL");
      await Promise.race([once(this.child, "exit"), delay(1_000)]);
    }
  }

  private append(chunk: unknown): void {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    this.output = `${this.output}${text}`.slice(-64_000);
  }
}

function startSynchronizer(input: {
  temporalAddress: string;
  temporalNamespace: string;
  taskQueue: string;
  token: string;
  declarationPath: string;
  sourceRoot: string;
  worktreeRoot: string;
  pollIntervalMs: number;
}): ManagedProcess {
  const child = spawn(process.execPath, ["--import", "tsx", "apps/synchronizer/src/main.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TEMPORAL_ADDRESS: input.temporalAddress,
      TEMPORAL_NAMESPACE: input.temporalNamespace,
      TEMPORAL_TASK_QUEUE: input.taskQueue,
      TEMPORAL_TLS: "false",
      GITHUB_TOKEN: input.token,
      THOR_PROJECT_DECLARATION: input.declarationPath,
      THOR_SOURCE_ROOT: input.sourceRoot,
      THOR_WORKTREE_ROOT: input.worktreeRoot,
      THOR_RESOURCE_ROOT: path.resolve("resources"),
      THOR_POLL_INTERVAL_MS: input.pollIntervalMs.toString(),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new ManagedProcess(child);
}

async function createWorkspace(
  configuration: LiveTestConfiguration,
  runId: string,
  generation: number,
): Promise<WorkspaceFixture> {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), `thor-live-${runId}-worker-${generation.toString()}-`),
  );
  const sourceRoot = path.join(temporaryRoot, "sources");
  const worktreeRoot = path.join(temporaryRoot, "worktrees");
  const repositoryPath = path.join(
    sourceRoot,
    configuration.repository.owner,
    configuration.repository.name,
  );
  await cloneRepository(
    configuration.token,
    configuration.repository,
    repositoryPath,
    configuration.timeoutMs,
  );
  return { temporaryRoot, sourceRoot, worktreeRoot, repositoryPath };
}

async function cloneRepository(
  token: string,
  repository: { owner: string; name: string },
  target: string,
  timeoutMs: number,
): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  await retryInfrastructureOperation(
    async () => {
      await rm(target, { recursive: true, force: true });
      await execFileAsync(
        "gh",
        [
          "repo",
          "clone",
          `${repository.owner}/${repository.name}`,
          target,
          "--",
          "--branch",
          "main",
          "--single-branch",
        ],
        {
          env: { ...process.env, GH_TOKEN: token },
          encoding: "utf8",
          maxBuffer: 10 * 1024 * 1024,
        },
      );
    },
    {
      retries: 8,
      maxRetryTimeMs: timeoutMs,
      shouldRetry: isRetryableGitHubFailure,
    },
  );
  await git(target, ["config", "credential.helper", "!gh auth git-credential"]);
  await readFile(path.join(target, "README.md"), "utf8");
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  timeoutMessage: string,
  intervalMs = 200,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(intervalMs);
  }
  throw new Error(timeoutMessage);
}

async function withTimeout<Value>(
  promise: Promise<Value>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<Value> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<Value>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function restoreGhToken(previous: string | undefined): void {
  if (previous === undefined) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = previous;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
