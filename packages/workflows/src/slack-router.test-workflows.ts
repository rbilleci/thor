import { condition, setHandler } from "@temporalio/workflow";

import type { AcceptedSlackCommand } from "./slack-contracts.js";
import { acceptedSlackCommandSignal, slackWorkspaceRouterWorkflow } from "./slack-router.js";

export { slackWorkspaceRouterWorkflow };

export async function slackCommandCollectorWorkflow(): Promise<AcceptedSlackCommand> {
  let accepted: AcceptedSlackCommand | undefined;
  setHandler(acceptedSlackCommandSignal, (command) => {
    accepted = command;
  });
  await condition(() => accepted !== undefined);
  if (accepted === undefined) throw new Error("accepted command was not set");
  return accepted;
}
