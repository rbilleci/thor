import { issueIdSchema, projectItemIdSchema, type IssueId, type ProjectItemId } from "@thor/domain";

export type ManagedWorkflowIdentity = {
  workflowId: string;
  projectItemId: ProjectItemId;
  issueId: IssueId;
};

export function managedWorkflowIdentity(
  execution: {
    type: string;
    workflowId: string;
    memo?: Record<string, unknown>;
    status: { name: string };
  },
  projectId: string,
): ManagedWorkflowIdentity | undefined {
  if (execution.type !== "ticketWorkflow" || execution.status.name !== "RUNNING") return undefined;
  if (execution.memo?.thorProjectId !== projectId) return undefined;
  const projectItemId = projectItemIdSchema.safeParse(execution.memo.thorProjectItemId);
  const issueId = issueIdSchema.safeParse(execution.memo.thorIssueId);
  if (!projectItemId.success || !issueId.success) return undefined;
  return {
    workflowId: execution.workflowId,
    projectItemId: projectItemId.data,
    issueId: issueId.data,
  };
}
