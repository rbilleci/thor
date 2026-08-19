import { Client } from "@temporalio/client";
import type { SlackCommandReference } from "@thor/slack";
import {
  appliedSlackCommandSignal,
  slackCommandEventSignal,
  type SlackRouterInput,
} from "@thor/workflows";

import type { SlackGatewayTemporal } from "./gateway.js";

export class TemporalSlackGateway implements SlackGatewayTemporal {
  public constructor(
    private readonly client: Client,
    private readonly taskQueue: string,
    private readonly reconciliationIntervalSeconds: number,
  ) {}

  public async acceptCommand(reference: SlackCommandReference): Promise<void> {
    const workflowId = `slack-workspace:${reference.workspaceId}`;
    const input: SlackRouterInput = {
      workspaceId: reference.workspaceId,
      reconciliationIntervalSeconds: this.reconciliationIntervalSeconds,
    };
    await this.client.workflow.signalWithStart("slackWorkspaceRouterWorkflow", {
      workflowId,
      taskQueue: this.taskQueue,
      args: [input],
      signal: slackCommandEventSignal,
      signalArgs: [reference],
    });
  }

  public async acknowledgeApplied(input: {
    workflowId: string;
    executionId: string;
    commandId: string;
  }): Promise<void> {
    await this.client.workflow.getHandle(input.workflowId).signal(appliedSlackCommandSignal, {
      executionId: input.executionId,
      commandId: input.commandId,
    });
  }
}
