import { createHmac, timingSafeEqual } from "node:crypto";

import { projectItemIdSchema } from "@thor/domain";
import { z } from "zod";

export type ProjectWebhookChange = {
  deliveryId: string;
  action: string;
  projectItemId: ReturnType<typeof projectItemIdSchema.parse>;
  actor: string;
};

const projectsItemWebhookSchema = z.object({
  action: z.string().min(1),
  projects_v2_item: z.object({
    node_id: projectItemIdSchema,
  }),
  sender: z.object({ login: z.string().min(1) }).optional(),
});

export function verifyWebhookSignature(
  secret: string,
  body: Uint8Array,
  signatureHeader: string | undefined,
): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(body).digest("hex"), "hex");
  const receivedHex = signatureHeader.slice("sha256=".length);
  if (!/^[a-f0-9]{64}$/i.test(receivedHex)) return false;
  const received = Buffer.from(receivedHex, "hex");
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export function parseProjectWebhook(body: Uint8Array, deliveryId: string): ProjectWebhookChange {
  const payload: unknown = JSON.parse(Buffer.from(body).toString("utf8"));
  const parsed = projectsItemWebhookSchema.parse(payload);
  return {
    deliveryId,
    action: parsed.action,
    projectItemId: parsed.projects_v2_item.node_id,
    actor: parsed.sender?.login ?? "github-webhook",
  };
}
