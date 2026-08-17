import { redactKnownSecrets } from "@thor/domain";

export type LogAttributes = Readonly<Record<string, string | number | boolean | undefined>>;

export function log(
  level: "debug" | "info" | "warn" | "error",
  event: string,
  attributes: LogAttributes = {},
): void {
  const record = {
    timestamp: new Date().toISOString(),
    level,
    event: redactKnownSecrets(event),
    ...Object.fromEntries(
      Object.entries(attributes)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [
          key,
          typeof value === "string" ? redactKnownSecrets(value) : value,
        ]),
    ),
  };
  const output = `${JSON.stringify(record)}\n`;
  if (level === "error" || level === "warn") process.stderr.write(output);
  else process.stdout.write(output);
}
