import {
  ApplicationFailure,
  Client,
  WorkflowNotFoundError,
  type WorkflowHandle,
} from "@temporalio/client";
import type { CompiledProjectBinding } from "@thor/config";
import { workflowIdFor } from "@thor/domain";
import type { GitHubGateway, ProjectItemObservation } from "@thor/github";
import { baseBranchFor, log } from "@thor/runtime";
import {
  projectChangedSignal,
  ticketWorkflow,
  toApplicationFailure,
  type ProjectSynchronizerActivities,
} from "@thor/workflows";

import { eligibleToStart } from "./eligibility.js";
import { managedWorkflowIdentity, type ManagedWorkflowIdentity } from "./workflow-discovery.js";

export type ProjectSynchronizerActivityDependencies = {
  client: Client;
  ticketTaskQueue: string;
  binding: CompiledProjectBinding;
  github: GitHubGateway;
};

export function createProjectSynchronizerActivities(
  dependencies: ProjectSynchronizerActivityDependencies,
): ProjectSynchronizerActivities {
  return {
    initializeProjectPolling: async ({ projectId }) => {
      assertProject(projectId, dependencies.binding.project.id);
      const running = await listManagedWorkflows(dependencies.client, projectId);
      log("info", "synchronizer_workflow_inventory_loaded", { count: running.length });
      return running.map((workflow) => workflow.projectItemId);
    },
    scanProjectItems: async ({ projectId }) => {
      assertProject(projectId, dependencies.binding.project.id);
      try {
        return await dependencies.github.listProjectItemObservations();
      } catch (error) {
        throw toApplicationFailure(error);
      }
    },
    dispatchProjectObservation: async ({ projectId, observation, actor }) => {
      assertProject(projectId, dependencies.binding.project.id);
      await dispatchObservation(dependencies, observation, actor);
    },
  };
}

async function dispatchObservation(
  dependencies: ProjectSynchronizerActivityDependencies,
  observation: ProjectItemObservation,
  actor: string,
): Promise<void> {
  const workflowId = workflowIdFor(observation.projectItemId);
  let handle: WorkflowHandle<typeof ticketWorkflow>;
  const existing = dependencies.client.workflow.getHandle<typeof ticketWorkflow>(workflowId);
  try {
    await existing.describe();
    handle = existing;
  } catch (error) {
    if (!(error instanceof WorkflowNotFoundError)) throw error;
    if (observation.kind !== "present") {
      log("debug", "project_observation_without_workflow_ignored", {
        projectItemId: observation.projectItemId,
        observation: observation.kind,
      });
      return;
    }
    if (!eligibleToStart(observation.snapshot, dependencies.binding)) {
      log("debug", "project_change_not_eligible", {
        projectItemId: observation.projectItemId,
        status: observation.snapshot.status,
      });
      return;
    }
    const duplicate = (
      await listManagedWorkflows(dependencies.client, dependencies.binding.project.id)
    ).find(
      (workflow) =>
        workflow.issueId === observation.snapshot.ticket.issueId &&
        workflow.projectItemId !== observation.projectItemId,
    );
    if (duplicate !== undefined) {
      log("info", "readded_issue_waiting_for_prior_workflow", {
        issueId: observation.snapshot.ticket.issueId,
        projectItemId: observation.projectItemId,
        priorProjectItemId: duplicate.projectItemId,
        priorWorkflowId: duplicate.workflowId,
      });
      return;
    }
    handle = await dependencies.client.workflow.start(ticketWorkflow, {
      workflowId,
      workflowIdConflictPolicy: "USE_EXISTING",
      workflowIdReusePolicy: "REJECT_DUPLICATE",
      taskQueue: dependencies.ticketTaskQueue,
      memo: {
        thorProjectId: observation.snapshot.projectId,
        thorProjectItemId: observation.projectItemId,
        thorIssueId: observation.snapshot.ticket.issueId,
      },
      args: [
        {
          projectItemId: observation.projectItemId,
          baseBranch: baseBranchFor(dependencies.binding, observation.snapshot.ticket.repository),
          delivery: dependencies.binding.delivery,
        },
      ],
    });
  }
  try {
    const event =
      observation.kind === "present"
        ? {
            kind: "present" as const,
            snapshot: observation.snapshot,
            reason: `GitHub update by ${actor}`,
          }
        : {
            kind: observation.kind,
            projectItemId: observation.projectItemId,
            reason: observation.reason,
          };
    await handle.signal(projectChangedSignal, event);
    log("info", "project_change_dispatched", {
      workflowId,
      projectItemId: observation.projectItemId,
      observation: observation.kind,
      ...(observation.kind === "present" ? { status: observation.snapshot.status } : {}),
    });
  } catch (error) {
    if (error instanceof WorkflowNotFoundError) {
      log("info", "completed_workflow_ignored", { workflowId });
      return;
    }
    throw error;
  }
}

export async function listManagedWorkflows(
  client: Client,
  projectId: string,
): Promise<ManagedWorkflowIdentity[]> {
  const workflows: ManagedWorkflowIdentity[] = [];
  for await (const execution of client.workflow.list({
    query: 'ExecutionStatus = "Running"',
  })) {
    const identity = managedWorkflowIdentity(execution, projectId);
    if (identity !== undefined) workflows.push(identity);
  }
  return workflows;
}

function assertProject(actual: string, expected: string): void {
  if (actual !== expected) {
    throw ApplicationFailure.nonRetryable(
      `Synchronizer Activity received Project ${actual}; expected ${expected}`,
      "synchronizer_invalid_project",
    );
  }
}
