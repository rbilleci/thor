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
});
