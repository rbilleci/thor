import { GitHubError } from "@thor/github";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isRetryableGitHubFailure, retryInfrastructureOperation } from "./retry.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("infrastructure retry scheduling", () => {
  it("uses exponential delays, caps them, and eventually succeeds", async () => {
    vi.useFakeTimers();
    const delays: number[] = [];
    let attempts = 0;
    const result = retryInfrastructureOperation(
      () => {
        attempts += 1;
        if (attempts < 4) throw new GitHubError("temporary outage", true, "unavailable");
        return "recovered";
      },
      {
        retries: 4,
        minDelayMs: 100,
        maxDelayMs: 250,
        randomize: false,
        shouldRetry: (error) => error instanceof GitHubError && error.retryable,
        onFailedAttempt: ({ retryDelay }) => {
          delays.push(retryDelay);
        },
      },
    );

    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe("recovered");
    expect(attempts).toBe(4);
    expect(delays).toEqual([100, 200, 250]);
  });

  it("does not retry terminal failures", async () => {
    let attempts = 0;
    await expect(
      retryInfrastructureOperation(
        () => {
          attempts += 1;
          throw new GitHubError("bad credentials", false, "authentication");
        },
        {
          retries: 10,
          randomize: false,
          shouldRetry: (error) => error instanceof GitHubError && error.retryable,
        },
      ),
    ).rejects.toThrow("bad credentials");
    expect(attempts).toBe(1);
  });

  it("recognizes transient failures reported by GitHub CLI outside the SDK", () => {
    expect(
      isRetryableGitHubFailure(
        new Error("HTTP 503: No server is currently available to service your request"),
      ),
    ).toBe(true);
    expect(isRetryableGitHubFailure(new Error("HTTP 401: Bad credentials"))).toBe(false);
  });
});
