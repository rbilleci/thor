const secretPatterns = [
  /(api[_-]?key|token|password|secret)\s*[:=]\s*["']?[A-Za-z0-9_./+\-=]{8,}/gi,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /AKIA[0-9A-Z]{16}/g,
] as const;

/** Redacts common credential shapes before text enters durable execution state or agent input. */
export function redactKnownSecrets(value: string): string {
  return secretPatterns.reduce(
    (redacted, pattern, index) =>
      index === 0
        ? redacted.replace(pattern, "$1=[REDACTED]")
        : redacted.replace(pattern, "[REDACTED]"),
    value,
  );
}

/** Recursively redacts strings in JSON-like provider output before it enters Workflow history. */
export function redactStructuredSecrets(value: unknown): unknown {
  if (typeof value === "string") return redactKnownSecrets(value);
  if (Array.isArray(value)) return value.map(redactStructuredSecrets);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, redactStructuredSecrets(nested)]),
  );
}
