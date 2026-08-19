import { describe, expect, it } from "vitest";

import { createSlackControlCredential, verifySlackControlCredential } from "./control-auth.js";

describe("Slack live-control credentials", () => {
  it("binds a short-lived credential to one Workflow execution", () => {
    const credential = createSlackControlCredential({
      secret: "a sufficiently long shared control secret",
      workflowId: "workflow-42",
      executionId: "execution-1",
      nowMilliseconds: 1_800_000_000_000,
    });

    expect(
      verifySlackControlCredential({
        credential,
        secret: "a sufficiently long shared control secret",
        workflowId: "workflow-42",
        executionId: "execution-1",
        nowMilliseconds: 1_800_000_030_000,
      }),
    ).toBe(true);
    expect(
      verifySlackControlCredential({
        credential,
        secret: "a sufficiently long shared control secret",
        workflowId: "workflow-42",
        executionId: "execution-2",
        nowMilliseconds: 1_800_000_030_000,
      }),
    ).toBe(false);
    expect(
      verifySlackControlCredential({
        credential,
        secret: "a sufficiently long shared control secret",
        workflowId: "workflow-42",
        executionId: "execution-1",
        nowMilliseconds: 1_800_000_090_000,
      }),
    ).toBe(false);
  });
});
