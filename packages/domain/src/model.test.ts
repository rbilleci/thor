import { describe, expect, it } from "vitest";

import { issueIdSchema, projectItemIdSchema } from "./ids.js";
import { classifyTicketContextChange, type TicketContext } from "./model.js";

describe("classifyTicketContextChange", () => {
  it("does not let a simultaneous dependency edit mask changed ticket intent", () => {
    const current = ticket();
    const incoming: TicketContext = {
      ...current,
      body: "changed intent",
      dependencies: [{ issueId: "I_blocker", complete: false }],
    };

    expect(classifyTicketContextChange(current, incoming)).toBe("intent");
  });

  it("does not let a simultaneous dependency edit mask changed execution policy", () => {
    const current = ticket();
    const incoming: TicketContext = {
      ...current,
      dependencies: [{ issueId: "I_blocker", complete: false }],
      policy: { ...current.policy, agentPolicy: "disabled" },
    };

    expect(classifyTicketContextChange(current, incoming)).toBe("policy");
  });
});

function ticket(): TicketContext {
  return {
    projectItemId: projectItemIdSchema.parse("PVTI_context"),
    issueId: issueIdSchema.parse("I_context"),
    repository: { owner: "example", name: "service" },
    issueNumber: 1,
    title: "Original intent",
    body: "original body",
    workType: "task",
    priority: "P2",
    acceptanceCriteria: ["done"],
    dependencies: [],
    policy: {
      executionMode: "agent",
      planningDepth: "full",
      approvalPolicy: "autonomous",
      agentPolicy: "preferred",
      autonomousRepairBudget: 2,
    },
  };
}
