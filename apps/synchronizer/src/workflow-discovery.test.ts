import { describe, expect, it } from "vitest";

import { managedWorkflowIdentity } from "./workflow-discovery.js";

describe("managedWorkflowIdentity", () => {
  it("selects only running ticket Workflows for the configured Project", () => {
    const execution = {
      type: "ticketWorkflow",
      workflowId: "github-project-item:PVTI_active",
      status: { name: "RUNNING" as const },
      memo: {
        thorProjectId: "PVT_managed",
        thorProjectItemId: "PVTI_active",
        thorIssueId: "I_active",
      },
    };
    expect(managedWorkflowIdentity(execution, "PVT_managed")).toEqual({
      workflowId: execution.workflowId,
      projectItemId: "PVTI_active",
      issueId: "I_active",
    });
    expect(managedWorkflowIdentity(execution, "PVT_other")).toBeUndefined();
    expect(
      managedWorkflowIdentity(
        { ...execution, status: { name: "COMPLETED" as const } },
        "PVT_managed",
      ),
    ).toBeUndefined();
  });
});
