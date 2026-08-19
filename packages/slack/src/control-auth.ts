import { createHmac, timingSafeEqual } from "node:crypto";

const credentialLifetimeSeconds = 60;
const acceptedClockSkewSeconds = 15;

export function createSlackControlCredential(input: {
  secret: string;
  workflowId: string;
  executionId: string;
  nowMilliseconds?: number;
}): string {
  const expiresAt =
    Math.floor((input.nowMilliseconds ?? Date.now()) / 1_000) + credentialLifetimeSeconds;
  const signature = sign(input.secret, input.workflowId, input.executionId, expiresAt);
  return `v1.${expiresAt.toString()}.${signature}`;
}

export function verifySlackControlCredential(input: {
  credential: string | undefined;
  secret: string;
  workflowId: string;
  executionId: string;
  nowMilliseconds?: number;
}): boolean {
  if (input.credential === undefined) return false;
  const [version, rawExpiry, signature, ...extra] = input.credential.split(".");
  if (version !== "v1" || rawExpiry === undefined || signature === undefined || extra.length > 0) {
    return false;
  }
  const expiresAt = Number(rawExpiry);
  if (!Number.isSafeInteger(expiresAt)) return false;
  const now = Math.floor((input.nowMilliseconds ?? Date.now()) / 1_000);
  if (
    expiresAt < now - acceptedClockSkewSeconds ||
    expiresAt > now + credentialLifetimeSeconds + acceptedClockSkewSeconds
  ) {
    return false;
  }
  const expected = sign(input.secret, input.workflowId, input.executionId, expiresAt);
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function sign(secret: string, workflowId: string, executionId: string, expiresAt: number): string {
  return createHmac("sha256", secret)
    .update(`${workflowId}\n${executionId}\n${expiresAt.toString()}`)
    .digest("base64url");
}
