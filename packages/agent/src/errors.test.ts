import { describe, expect, it } from "vitest";

import { normalizeProviderError, parseStructuredResponse } from "./errors.js";

describe("provider result normalization", () => {
  it("uses native structured output before parsing text", () => {
    expect(parseStructuredResponse({ status: "ok" }, "not json", true)).toEqual({ status: "ok" });
  });

  it("parses structured JSON returned as final text", () => {
    expect(parseStructuredResponse(undefined, '{"status":"ok"}', true)).toEqual({ status: "ok" });
  });

  it("classifies cancellation as terminal", () => {
    const controller = new AbortController();
    controller.abort();
    expect(normalizeProviderError(new Error("stopped"), controller.signal)).toMatchObject({
      code: "cancelled",
      retryable: false,
    });
  });

  it("classifies transient provider failures as retryable", () => {
    expect(
      normalizeProviderError(new Error("429 rate limit"), new AbortController().signal),
    ).toMatchObject({
      code: "provider_unavailable",
      retryable: true,
    });
  });

  it("classifies a missing checkpointed session for recovery", () => {
    expect(
      normalizeProviderError(
        new Error("No rollout found for thread ID stale"),
        new AbortController().signal,
        { resumingSession: true },
      ),
    ).toMatchObject({
      code: "session_unavailable",
      retryable: true,
    });
  });

  it("does not classify an unavailable session when starting a fresh execution", () => {
    expect(
      normalizeProviderError(new Error("Session not found"), new AbortController().signal),
    ).toMatchObject({
      code: "provider_failed",
    });
  });
});
