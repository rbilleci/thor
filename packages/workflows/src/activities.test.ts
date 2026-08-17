import { ApplicationFailure } from "@temporalio/common";
import { GitHubError } from "@thor/github";
import { describe, expect, it } from "vitest";

import { toApplicationFailure } from "./activities.js";

describe("Activity failure normalization", () => {
  it("passes a capped GitHub retry delay to Temporal", () => {
    const failure = toApplicationFailure(
      new GitHubError("rate limited", true, "rate_limited", { retryAfterMs: 300_000 }),
    );

    expect(failure).toBeInstanceOf(ApplicationFailure);
    expect(failure).toMatchObject({
      type: "github_rate_limited",
      nonRetryable: false,
      nextRetryDelay: 300_000,
    });
  });

  it("marks authentication failures as terminal", () => {
    const failure = toApplicationFailure(
      new GitHubError("bad credentials", false, "authentication"),
    );

    expect(failure).toMatchObject({
      type: "github_authentication",
      nonRetryable: true,
    });
  });
});
