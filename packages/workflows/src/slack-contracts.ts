import {
  slackCommandReferenceSchema,
  slackTaskSurfaceSchema,
  slackTimestampSchema,
  slackUserGroupIdSchema,
  slackWorkspaceIdSchema,
} from "@thor/slack/types";
import { z } from "zod";

export const slackRouterRegistrationSchema = z.strictObject({
  workflowId: z.string().min(1),
  projectItemId: z.string().min(1),
  surface: slackTaskSurfaceSchema,
  allowedUserGroupIds: z.array(slackUserGroupIdSchema).min(1),
  defaultMode: z.enum(["queue", "redirect"]),
  archiveDelayDays: z.number().int().min(0).max(3650).optional(),
  terminal: z.boolean().default(false),
  terminalAtEpochMilliseconds: z.number().int().nonnegative().optional(),
  archivedAtEpochMilliseconds: z.number().int().nonnegative().optional(),
});
export type SlackRouterRegistration = z.infer<typeof slackRouterRegistrationSchema>;

export const acceptedSlackCommandSchema = z.strictObject({
  reference: slackCommandReferenceSchema,
  receiptTs: slackTimestampSchema,
});
export type AcceptedSlackCommand = z.infer<typeof acceptedSlackCommandSchema>;

export const appliedSlackCommandSchema = z.strictObject({
  commandId: z.string().min(1),
  executionId: z.string().min(1),
});
export type AppliedSlackCommand = z.infer<typeof appliedSlackCommandSchema>;

export const slackRouterInputSchema = z.strictObject({
  workspaceId: slackWorkspaceIdSchema,
  reconciliationIntervalSeconds: z.number().int().min(5).max(3600).default(30),
  registrations: z.array(slackRouterRegistrationSchema).default([]),
  seenEventIds: z.array(z.string().min(1)).default([]),
  reconciliationHighWatermarks: z.record(z.string().min(1), slackTimestampSchema).default({}),
  processedEvents: z.number().int().nonnegative().default(0),
});
export type SlackRouterInput = z.input<typeof slackRouterInputSchema>;

export const slackRouterStateSchema = z.strictObject({
  workspaceId: slackWorkspaceIdSchema,
  registrations: z.array(slackRouterRegistrationSchema),
  seenEventIds: z.array(z.string().min(1)),
  reconciliationHighWatermarks: z.record(z.string().min(1), slackTimestampSchema),
  queuedCommandCount: z.number().int().nonnegative(),
  processedEvents: z.number().int().nonnegative(),
});
export type SlackRouterState = z.infer<typeof slackRouterStateSchema>;

export type MaterializeSlackCommandInput = {
  registration: SlackRouterRegistration;
  reference: z.infer<typeof slackCommandReferenceSchema>;
};

export type ReconcileSlackCommandsInput = {
  registrations: SlackRouterRegistration[];
  seenEventIds: string[];
  highWatermarks: Record<string, z.infer<typeof slackTimestampSchema>>;
  limit: number;
};

export type ReconcileSlackCommandsResult = {
  references: z.infer<typeof slackCommandReferenceSchema>[];
  highWatermarks: Record<string, z.infer<typeof slackTimestampSchema>>;
};

export type SlackRouterActivities = {
  materializeSlackCommand(input: MaterializeSlackCommandInput): Promise<AcceptedSlackCommand>;
  replyClosedSlackSession(input: MaterializeSlackCommandInput): Promise<void>;
  archiveSlackTicketChannel(input: { registration: SlackRouterRegistration }): Promise<void>;
  unarchiveSlackTicketChannel(input: { registration: SlackRouterRegistration }): Promise<void>;
  reconcileSlackCommands(input: ReconcileSlackCommandsInput): Promise<ReconcileSlackCommandsResult>;
};
