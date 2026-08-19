import {
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  defineUpdate,
  getExternalWorkflowHandle,
  proxyActivities,
  setHandler,
  workflowInfo,
} from "@temporalio/workflow";
import {
  slackCommandReferenceSchema,
  slackSurfaceKey,
  slackSurfaceKeyString,
  type SlackCommandReference,
} from "@thor/slack/types";

import {
  acceptedSlackCommandSchema,
  slackRouterInputSchema,
  slackRouterRegistrationSchema,
  type AcceptedSlackCommand,
  type AppliedSlackCommand,
  type SlackRouterActivities,
  type SlackRouterInput,
  type SlackRouterRegistration,
  type SlackRouterState,
} from "./slack-contracts.js";

export const registerSlackSurfaceUpdate = defineUpdate<
  "created" | "unchanged",
  [SlackRouterRegistration]
>("registerSlackSurface");
export const closeSlackSurfaceUpdate = defineUpdate<undefined, [string]>("closeSlackSurface");
export const slackCommandEventSignal = defineSignal<[SlackCommandReference]>("slackCommandEvent");
export const slackRouterStateQuery = defineQuery<SlackRouterState>("slackRouterState");
export const acceptedSlackCommandSignal =
  defineSignal<[AcceptedSlackCommand]>("acceptedSlackCommand");
export const appliedSlackCommandSignal = defineSignal<[AppliedSlackCommand]>("appliedSlackCommand");

const slackActivities = proxyActivities<SlackRouterActivities>({
  startToCloseTimeout: "2 minutes",
  retry: {
    initialInterval: "1 second",
    backoffCoefficient: 2,
    maximumInterval: "30 seconds",
    maximumAttempts: 8,
    nonRetryableErrorTypes: ["slack_invalid_command", "slack_unauthorized", "slack_conflict"],
  },
});

const seenWindow = 2_000;
const terminalTombstoneRetentionMilliseconds = 30 * 24 * 60 * 60 * 1_000;

export async function slackWorkspaceRouterWorkflow(rawInput: SlackRouterInput): Promise<void> {
  const input = slackRouterInputSchema.parse(rawInput);
  const registrations = new Map<string, SlackRouterRegistration>();
  const seenEventIds = new Set(input.seenEventIds);
  const reconciliationHighWatermarks = new Map(Object.entries(input.reconciliationHighWatermarks));
  const queuedCommands: SlackCommandReference[] = [];
  let processedEvents = input.processedEvents;
  let registrationChanged = false;

  for (const registration of input.registrations) register(registration, registrations);

  setHandler(
    registerSlackSurfaceUpdate,
    (rawRegistration) => {
      const registration = slackRouterRegistrationSchema.parse(rawRegistration);
      if (registration.surface.workspaceId !== input.workspaceId) {
        throw new Error("Slack registration belongs to a different workspace");
      }
      const key = slackSurfaceKeyString(slackSurfaceKey(registration.surface));
      const current = registrations.get(key);
      if (current !== undefined) {
        registrations.set(key, registration);
        registrationChanged = true;
        return "unchanged";
      }
      registrations.set(key, registration);
      registrationChanged = true;
      return "created";
    },
    {
      validator: (rawRegistration) => {
        const registration = slackRouterRegistrationSchema.parse(rawRegistration);
        const key = slackSurfaceKeyString(slackSurfaceKey(registration.surface));
        const current = registrations.get(key);
        if (
          current !== undefined &&
          (current.workflowId !== registration.workflowId ||
            current.projectItemId !== registration.projectItemId)
        ) {
          throw new Error(`Slack surface ${key} is already owned by another ticket`);
        }
      },
    },
  );
  setHandler(closeSlackSurfaceUpdate, (workflowId) => {
    for (const [key, registration] of registrations) {
      if (registration.workflowId === workflowId) {
        const terminalAtEpochMilliseconds = registration.terminalAtEpochMilliseconds ?? Date.now();
        const closing: SlackRouterRegistration = { ...registration };
        if (!registration.terminal) delete closing.archivedAtEpochMilliseconds;
        registrations.set(key, {
          ...closing,
          terminal: true,
          terminalAtEpochMilliseconds,
        });
        registrationChanged = true;
      }
    }
    return undefined;
  });
  setHandler(slackCommandEventSignal, (reference) => {
    const parsed = slackCommandReferenceSchema.parse(reference);
    if (
      parsed.workspaceId !== input.workspaceId ||
      seenEventIds.has(parsed.eventId) ||
      seenEventIds.has(messageDeduplicationKey(parsed))
    ) {
      return;
    }
    queuedCommands.push(parsed);
  });
  setHandler(slackRouterStateQuery, () => ({
    workspaceId: input.workspaceId,
    registrations: [...registrations.values()],
    seenEventIds: [...seenEventIds],
    reconciliationHighWatermarks: Object.fromEntries(reconciliationHighWatermarks),
    queuedCommandCount: queuedCommands.length,
    processedEvents,
  }));

  for (;;) {
    await condition(
      () => queuedCommands.length > 0 || registrationChanged,
      nextMaintenanceDelay(registrations, input.reconciliationIntervalSeconds),
    );
    registrationChanged = false;
    removeExpiredTombstones(registrations, reconciliationHighWatermarks);
    await archiveDueTicketChannels(registrations);
    await repairActiveArchivedChannels(registrations);
    const activeRegistrations = [...registrations.values()].filter(
      (registration) => !registration.terminal,
    );
    if (queuedCommands.length === 0 && activeRegistrations.length > 0) {
      const reconciled = await slackActivities.reconcileSlackCommands({
        registrations: activeRegistrations,
        seenEventIds: [...seenEventIds],
        highWatermarks: Object.fromEntries(reconciliationHighWatermarks),
        limit: 200,
      });
      for (const [key, timestamp] of Object.entries(reconciled.highWatermarks)) {
        reconciliationHighWatermarks.set(key, timestamp);
      }
      for (const reference of reconciled.references) {
        const parsed = slackCommandReferenceSchema.parse(reference);
        if (!seenEventIds.has(parsed.eventId)) queuedCommands.push(parsed);
      }
    }

    const deferredCommands: SlackCommandReference[] = [];
    while (queuedCommands.length > 0) {
      const reference = queuedCommands.shift();
      if (
        reference === undefined ||
        seenEventIds.has(reference.eventId) ||
        seenEventIds.has(messageDeduplicationKey(reference))
      ) {
        continue;
      }
      const registration = resolveRegistration(reference, registrations);
      if (registration === undefined) {
        markSeen(reference);
        continue;
      }
      if (registration.terminal) {
        try {
          await slackActivities.replyClosedSlackSession({ registration, reference });
          markSeen(reference);
        } catch (error) {
          if (isTerminalSlackCommandFailure(error)) markSeen(reference);
          else deferredCommands.push(reference);
        }
        continue;
      }
      try {
        const accepted = acceptedSlackCommandSchema.parse(
          await slackActivities.materializeSlackCommand({ registration, reference }),
        );
        await getExternalWorkflowHandle(registration.workflowId).signal(
          acceptedSlackCommandSignal,
          accepted,
        );
        markSeen(reference);
      } catch (error) {
        if (isTerminalSlackCommandFailure(error)) markSeen(reference);
        else deferredCommands.push(reference);
      }
    }
    if (deferredCommands.length > 0) {
      await condition(() => queuedCommands.length > 0, input.reconciliationIntervalSeconds * 1_000);
      queuedCommands.push(...deferredCommands);
    }

    if (workflowInfo().continueAsNewSuggested) {
      await continueAsNew<typeof slackWorkspaceRouterWorkflow>({
        workspaceId: input.workspaceId,
        reconciliationIntervalSeconds: input.reconciliationIntervalSeconds,
        registrations: [...registrations.values()],
        seenEventIds: [...seenEventIds],
        reconciliationHighWatermarks: Object.fromEntries(reconciliationHighWatermarks),
        processedEvents,
      });
    }
  }

  async function archiveDueTicketChannels(
    current: Map<string, SlackRouterRegistration>,
  ): Promise<void> {
    const now = Date.now();
    for (const [key, registration] of current) {
      if (
        registration.surface.mode !== "channel_per_ticket" ||
        !registration.terminal ||
        registration.archivedAtEpochMilliseconds !== undefined ||
        registration.terminalAtEpochMilliseconds === undefined ||
        registration.archiveDelayDays === undefined ||
        registration.terminalAtEpochMilliseconds +
          daysToMilliseconds(registration.archiveDelayDays) >
          now
      ) {
        continue;
      }
      try {
        await slackActivities.archiveSlackTicketChannel({ registration });
        const latest = current.get(key);
        if (latest === undefined) continue;
        if (
          (latest.terminal &&
            latest.terminalAtEpochMilliseconds === registration.terminalAtEpochMilliseconds) ||
          !latest.terminal
        ) {
          current.set(key, { ...latest, archivedAtEpochMilliseconds: now });
        }
      } catch {
        // Slack archival is ancillary and is retried on the next maintenance wake.
      }
    }
  }

  async function repairActiveArchivedChannels(
    current: Map<string, SlackRouterRegistration>,
  ): Promise<void> {
    for (const [key, registration] of current) {
      if (
        registration.surface.mode !== "channel_per_ticket" ||
        registration.terminal ||
        registration.archivedAtEpochMilliseconds === undefined
      ) {
        continue;
      }
      try {
        await slackActivities.unarchiveSlackTicketChannel({ registration });
        const latest = current.get(key);
        if (
          latest !== undefined &&
          !latest.terminal &&
          latest.archivedAtEpochMilliseconds === registration.archivedAtEpochMilliseconds
        ) {
          const active: SlackRouterRegistration = { ...latest };
          delete active.archivedAtEpochMilliseconds;
          current.set(key, active);
        }
      } catch {
        // Retain the marker and compensate again on the next maintenance wake.
      }
    }
  }

  function markSeen(reference: SlackCommandReference): void {
    seenEventIds.add(reference.eventId);
    seenEventIds.add(messageDeduplicationKey(reference));
    processedEvents += 1;
    trimSet(seenEventIds, seenWindow);
  }
}

function nextMaintenanceDelay(
  registrations: ReadonlyMap<string, SlackRouterRegistration>,
  reconciliationIntervalSeconds: number,
): number {
  const now = Date.now();
  const active = [...registrations.values()].some((registration) => !registration.terminal);
  const candidates = [...registrations.values()].flatMap((registration) => {
    if (!registration.terminal || registration.terminalAtEpochMilliseconds === undefined) return [];
    const tombstoneExpiry =
      registration.terminalAtEpochMilliseconds + terminalTombstoneRetentionMilliseconds;
    const archiveAt =
      registration.surface.mode === "channel_per_ticket" &&
      registration.archiveDelayDays !== undefined &&
      registration.archivedAtEpochMilliseconds === undefined
        ? registration.terminalAtEpochMilliseconds +
          daysToMilliseconds(registration.archiveDelayDays)
        : undefined;
    return archiveAt === undefined ? [tombstoneExpiry] : [archiveAt, tombstoneExpiry];
  });
  const nextMaintenance = candidates.sort((left, right) => left - right)[0];
  const defaultDelay = active ? reconciliationIntervalSeconds * 1_000 : 24 * 60 * 60 * 1_000;
  return Math.max(
    1,
    nextMaintenance === undefined ? defaultDelay : Math.min(defaultDelay, nextMaintenance - now),
  );
}

function daysToMilliseconds(days: number): number {
  return days * 24 * 60 * 60 * 1_000;
}

function removeExpiredTombstones(
  registrations: Map<string, SlackRouterRegistration>,
  highWatermarks: Map<string, string>,
): void {
  const cutoff = Date.now() - terminalTombstoneRetentionMilliseconds;
  for (const [key, registration] of registrations) {
    if (
      registration.terminal &&
      registration.terminalAtEpochMilliseconds !== undefined &&
      registration.terminalAtEpochMilliseconds <= cutoff
    ) {
      registrations.delete(key);
      highWatermarks.delete(key);
    }
  }
}

function register(
  registration: SlackRouterRegistration,
  registrations: Map<string, SlackRouterRegistration>,
): void {
  const parsed = slackRouterRegistrationSchema.parse(registration);
  registrations.set(slackSurfaceKeyString(slackSurfaceKey(parsed.surface)), parsed);
}

function resolveRegistration(
  reference: SlackCommandReference,
  registrations: ReadonlyMap<string, SlackRouterRegistration>,
): SlackRouterRegistration | undefined {
  if (reference.threadTs !== undefined) {
    const thread = registrations.get(`thread:${reference.channelId}:${reference.threadTs}`);
    if (thread !== undefined) return thread;
  }
  return registrations.get(`channel:${reference.channelId}`);
}

function trimSet(values: Set<string>, maximum: number): void {
  while (values.size > maximum) {
    const oldest = values.values().next().value;
    if (oldest === undefined) return;
    values.delete(oldest);
  }
}

function messageDeduplicationKey(reference: SlackCommandReference): string {
  return `reconcile:${reference.channelId}:${reference.messageTs}`;
}

function isTerminalSlackCommandFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("nonRetryable" in error && error.nonRetryable === true) return true;
  const type = "type" in error && typeof error.type === "string" ? error.type : undefined;
  if (
    type === "slack_invalid_command" ||
    type === "slack_unauthorized" ||
    type === "slack_conflict"
  ) {
    return true;
  }
  return "cause" in error && isTerminalSlackCommandFailure(error.cause);
}
