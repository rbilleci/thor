import {
  findingIdSchema,
  issueIdSchema,
  projectItemIdSchema,
  type NormalizedFinding,
  type TicketContext,
} from "@thor/domain";
import { describe, expect, it } from "vitest";

import { mapDeferredProjectFields } from "./config.js";

describe("deferred Project field routing", () => {
  it("maps configured ticket and finding metadata without guessing unmapped values", () => {
    const binding = {
      fields: {
        lifecycle: select("field-lifecycle", {}),
        workType: select("field-type", { bug: "option-bug" }),
        priority: select("field-priority", { P1: "option-p1" }),
        component: { type: "text" as const, fieldId: "field-component", requiredOnItems: false },
        agentPolicy: select("field-agent", { preferred: "option-preferred" }),
        planningDepth: select("field-planning", {}),
        severity: select("field-severity", { high: "option-high" }),
      },
    };

    expect(mapDeferredProjectFields(binding, finding(), ticket())).toEqual([
      { fieldId: "field-type", kind: "single_select", optionId: "option-bug" },
      { fieldId: "field-priority", kind: "single_select", optionId: "option-p1" },
      { fieldId: "field-component", kind: "text", text: "payments" },
      { fieldId: "field-agent", kind: "single_select", optionId: "option-preferred" },
      { fieldId: "field-severity", kind: "single_select", optionId: "option-high" },
    ]);
  });
});

function select(fieldId: string, options: Record<string, string>) {
  return { type: "single_select" as const, fieldId, requiredOnItems: false, options };
}

function ticket(): TicketContext {
  return {
    projectItemId: projectItemIdSchema.parse("PVTI_runtime"),
    issueId: issueIdSchema.parse("I_runtime"),
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
