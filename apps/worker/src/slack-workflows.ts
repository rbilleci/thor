import { Client, WithStartWorkflowOperation } from "@temporalio/client";
import {
  closeSlackSurfaceUpdate,
  registerSlackSurfaceUpdate,
  type RegisterTicketSlackSurfaceInput,
  type SlackRouterInput,
  type SlackWorkflowRegistrationGateway,
} from "@thor/workflows";

export class TemporalSlackWorkflowRegistrationGateway implements SlackWorkflowRegistrationGateway {
  public constructor(
    private readonly client: Client,
    private readonly taskQueue: string,
  ) {}

  public async register(input: RegisterTicketSlackSurfaceInput): Promise<void> {
    const routerInput: SlackRouterInput = {
      workspaceId: input.slack.workspaceId,
      reconciliationIntervalSeconds: input.slack.eventReconciliationIntervalSeconds,
    };
    const startWorkflowOperation = new WithStartWorkflowOperation("slackWorkspaceRouterWorkflow", {
      workflowId: routerWorkflowId(input.slack.workspaceId),
      taskQueue: this.taskQueue,
      args: [routerInput],
      workflowIdConflictPolicy: "USE_EXISTING",
    });
    await this.client.workflow.executeUpdateWithStart(registerSlackSurfaceUpdate, {
      args: [
        {
          workflowId: input.workflowId,
          projectItemId: input.projectItemId,
          surface: input.surface,
          allowedUserGroupIds: input.slack.steering.allowedUserGroupIds,
          defaultMode: input.slack.steering.defaultMode,
          ...(input.slack.messaging.mode === "channel_per_ticket"
            ? { archiveDelayDays: input.slack.messaging.ticketChannels.archiveDelayDays }
            : {}),
          terminal: false,
        },
      ],
      startWorkflowOperation,
    });
  }

  public async close(input: RegisterTicketSlackSurfaceInput): Promise<void> {
    await this.client.workflow
      .getHandle(routerWorkflowId(input.slack.workspaceId))
      .executeUpdate(closeSlackSurfaceUpdate, { args: [input.workflowId] });
  }
}

function routerWorkflowId(workspaceId: string): string {
  return `slack-workspace:${workspaceId}`;
}
