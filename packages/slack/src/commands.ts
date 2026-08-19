import { createHash } from "node:crypto";

import { redactKnownSecrets } from "@thor/domain";

import { type SlackCommandMode } from "./types.js";

export type ParsedSlackCommand = {
  mode: SlackCommandMode;
  text: string;
};

export function parseSlackCommand(
  rawText: string,
  botUserId: string,
  defaultMode: Exclude<SlackCommandMode, "cancel">,
): ParsedSlackCommand | undefined {
  const mention = `<@${escapeRegExp(botUserId)}>`;
  const match = new RegExp(`^${mention}\\s+(steer|queue|cancel)\\s*:\\s*([\\s\\S]+)$`, "i").exec(
    rawText.trim(),
  );
  if (match === null) return undefined;
  const verb = match[1]?.toLowerCase();
  const text = match[2]?.trim();
  if (text === undefined || text.length === 0 || text.length > 3_000) return undefined;
  const mode = verb === "steer" ? defaultMode : verb;
  if (mode !== "queue" && mode !== "redirect" && mode !== "cancel") return undefined;
  return { mode, text };
}

export function slackCommandDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function slackCommandContainsSecret(text: string): boolean {
  return redactKnownSecrets(text) !== text;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
