import { describe, expect, it } from "vitest";

import { redactKnownSecrets, redactStructuredSecrets } from "./secrets.js";

describe("secret redaction", () => {
  it("redacts common credentials in nested structured output", () => {
    const value = redactStructuredSecrets({
      evidence: ["token=abcdefghijklmnop", "safe"],
      nested: { key: "sk-abcdefghijklmnop" },
    });

    expect(value).toEqual({
      evidence: ["token=[REDACTED]", "safe"],
      nested: { key: "[REDACTED]" },
    });
    expect(redactKnownSecrets("password=abcdefghijklmnop")).toBe("password=[REDACTED]");
  });
});
