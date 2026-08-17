import {
  findingIdSchema,
  projectItemIdSchema,
  type NormalizedFinding,
  type TicketContext,
} from "@thor/domain";
import { describe, expect, it } from "vitest";

import { mapDeferredProjectFields, type DeferredFieldRouting } from "./config.js";

describe("deferred Project field routing", () => {
  it("maps configured ticket and finding metadata without guessing unmapped values", () => {
    const routing: DeferredFieldRouting = {
      type: { fieldId: "field-type", options: { bug: "option-bug" } },
      priority: { fieldId: "field-priority", options: { P1: "option-p1" } },
      component: { fieldId: "field-component" },
      agentPolicy: { fieldId: "field-agent", options: { preferred: "option-preferred" } },
      planningDepth: { fieldId: "field-planning", options: {} },
      severity: { fieldId: "field-severity", options: { high: "option-high" } },
    };

    expect(mapDeferredProjectFields(routing, finding(), ticket())).toEqual([
      { fieldId: "field-type", kind: "single_select", optionId: "option-bug" },
      { fieldId: "field-priority", kind: "single_select", optionId: "option-p1" },
      { fieldId: "field-component", kind: "text", text: "payments" },
      { fieldId: "field-agent", kind: "single_select", optionId: "option-preferred" },
      { fieldId: "field-severity", kind: "single_select", optionId: "option-high" },
    ]);
  });
});

function ticket(): TicketContext {
  return {
    projectItemId: projectItemIdSchema.parse("PVTI_runtime"),
    repository: { owner: "example", name: "repository" },
    issueNumber: 23,
    title: "Fix payment failure",
    body: "",
    workType: "bug",
    priority: "P1",
    component: "payments",
    acceptanceCriteria: ["payments succeed"],
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

function finding(): NormalizedFinding {
  return {
    findingId: findingIdSchema.parse("finding-runtime"),
    sourceFindingIds: [findingIdSchema.parse("source-runtime")],
    reviewers: ["correctness"],
    severity: "high",
    category: "correctness",
    summary: "Payment fails",
    evidence: ["test failure"],
    affectedFiles: ["payments.ts"],
    recommendedFix: "Handle the failure",
    disposition: "defer_candidate",
    confidence: 1,
  };
}
