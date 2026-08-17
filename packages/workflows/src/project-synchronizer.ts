import {
  ApplicationFailure,
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
  workflowInfo,
} from "@temporalio/workflow";
import { projectItemIdSchema, type ProjectItemId } from "@thor/domain";
import type { ProjectItemObservation } from "@thor/github";
import { z } from "zod";

import { projectItemSnapshotSchema } from "./contracts.js";

const projectItemObservationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("present"),
    projectItemId: projectItemIdSchema,
    snapshot: projectItemSnapshotSchema,
  }),
  z.strictObject({
    kind: z.literal("removed"),
    projectItemId: projectItemIdSchema,
    reason: z.string(),
  }),
  z.strictObject({
    kind: z.literal("unreadable"),
    projectItemId: projectItemIdSchema,
    reason: z.string(),
    retryable: z.boolean(),
  }),
]);

const pollingTrackerStateSchema = z.strictObject({
  knownProjectItemIds: z.array(projectItemIdSchema),
  unreadableCounts: z.array(
    z.strictObject({ projectItemId: projectItemIdSchema, count: z.number().int().positive() }),
  ),
  unreadableNotified: z.array(projectItemIdSchema),
});

export type PollingTrackerState = z.infer<typeof pollingTrackerStateSchema>;

export const projectSynchronizerInputSchema = z.strictObject({
  projectId: z.string().min(1),
  pollIntervalMs: z.number().int().positive(),
  unreadableAfterConsecutivePolls: z.number().int().positive(),
  resumeState: pollingTrackerStateSchema.optional(),
  completedPolls: z.number().int().nonnegative().default(0),
  dispatchFailures: z.number().int().nonnegative().default(0),
});

export type ProjectSynchronizerInput = z.input<typeof projectSynchronizerInputSchema>;

export type ProjectSynchronizerState = {
  projectId: string;
  completedPolls: number;
  dispatchFailures: number;
  knownProjectItems: number;
  stopping: boolean;
};

export type ProjectSynchronizerActivities = {
  initializeProjectPolling(input: { projectId: string }): Promise<ProjectItemId[]>;
  scanProjectItems(input: { projectId: string }): Promise<ProjectItemObservation[]>;
  dispatchProjectObservation(input: {
    projectId: string;
    observation: ProjectItemObservation;
    actor: string;
  }): Promise<void>;
};

const scanActivities = proxyActivities<
  Pick<ProjectSynchronizerActivities, "initializeProjectPolling" | "scanProjectItems">
>({
  startToCloseTimeout: "10 minutes",
  retry: {
    initialInterval: "1 second",
    backoffCoefficient: 2,
    maximumInterval: "5 minutes",
    nonRetryableErrorTypes: [
      "github_authentication",
      "github_conflict",
      "github_invalid_response",
      "github_not_found",
    ],
  },
});

const dispatchActivities = proxyActivities<
  Pick<ProjectSynchronizerActivities, "dispatchProjectObservation">
>({
  startToCloseTimeout: "2 minutes",
  retry: {
    initialInterval: "1 second",
    backoffCoefficient: 2,
    maximumInterval: "5 minutes",
    maximumAttempts: 8,
  },
});

export const stopProjectSynchronizerSignal = defineSignal("stopProjectSynchronizer");
export const projectSynchronizerStateQuery = defineQuery<ProjectSynchronizerState>(
  "projectSynchronizerState",
);

export async function projectSynchronizerWorkflow(
  rawInput: ProjectSynchronizerInput,
): Promise<ProjectSynchronizerState> {
  const input = projectSynchronizerInputSchema.parse(rawInput);
  const tracker = new PollingObservationTracker(input.resumeState);
  let completedPolls = input.completedPolls;
  let dispatchFailures = input.dispatchFailures;
  const control = { stopping: false };
  const state = (): ProjectSynchronizerState => ({
    projectId: input.projectId,
    completedPolls,
    dispatchFailures,
    knownProjectItems: tracker.knownCount,
    stopping: control.stopping,
  });
  setHandler(projectSynchronizerStateQuery, state);
  setHandler(stopProjectSynchronizerSignal, () => {
    control.stopping = true;
  });

  if (input.resumeState === undefined) {
    tracker.seed(await scanActivities.initializeProjectPolling({ projectId: input.projectId }));
  }

  while (!isStopping(control)) {
    const scan = parseProjectObservations(
      await scanActivities.scanProjectItems({ projectId: input.projectId }),
    );
    const observations = tracker.reconcile(scan, input.unreadableAfterConsecutivePolls);
    await Promise.all(
      observations.map(async (observation) => {
        try {
          await dispatchActivities.dispatchProjectObservation({
            projectId: input.projectId,
            observation,
            actor: "github-poller",
          });
        } catch {
          tracker.markDispatchFailed(observation);
          dispatchFailures += 1;
        }
      }),
    );
    completedPolls += 1;
    if (isStopping(control)) break;
    if (workflowInfo().continueAsNewSuggested) {
      return continueAsNew<typeof projectSynchronizerWorkflow>({
        projectId: input.projectId,
        pollIntervalMs: input.pollIntervalMs,
        unreadableAfterConsecutivePolls: input.unreadableAfterConsecutivePolls,
        resumeState: tracker.snapshot(),
        completedPolls,
        dispatchFailures,
      });
    }
    await condition(() => isStopping(control), input.pollIntervalMs);
  }
  return state();
}

function isStopping(control: { stopping: boolean }): boolean {
  return control.stopping;
}

function parseProjectObservations(value: unknown): ProjectItemObservation[] {
  const parsed = z.array(projectItemObservationSchema).safeParse(value);
  if (parsed.success) return parsed.data;
  throw ApplicationFailure.nonRetryable(z.prettifyError(parsed.error), "github_invalid_response");
}

/**
 * Deterministic state used by the Project synchronizer Workflow for removal detection and
 * unreadable-item debouncing. Snapshots cross Continue-as-New without relying on process memory.
 */
export class PollingObservationTracker {
  private knownProjectItemIds: Set<ProjectItemId>;
  private readonly unreadableCounts: Map<ProjectItemId, number>;
  private readonly unreadableNotified: Set<ProjectItemId>;

  public constructor(rawState?: PollingTrackerState) {
    const state = rawState === undefined ? undefined : pollingTrackerStateSchema.parse(rawState);
    this.knownProjectItemIds = new Set(state?.knownProjectItemIds ?? []);
    this.unreadableCounts = new Map(
      state?.unreadableCounts.map(({ projectItemId, count }) => [projectItemId, count]) ?? [],
    );
    this.unreadableNotified = new Set(state?.unreadableNotified ?? []);
  }

  public get knownCount(): number {
    return this.knownProjectItemIds.size;
  }

  public seed(projectItemIds: Iterable<ProjectItemId>): void {
    for (const projectItemId of projectItemIds) this.knownProjectItemIds.add(projectItemId);
  }

  public reconcile(
    scan: readonly ProjectItemObservation[],
    unreadableAfterConsecutivePolls: number,
  ): ProjectItemObservation[] {
    const current = new Set<ProjectItemId>();
    const output: ProjectItemObservation[] = [];
    const explicitlyRemoved = new Set<ProjectItemId>();

    for (const observation of scan) {
      if (observation.kind === "removed") {
        explicitlyRemoved.add(observation.projectItemId);
        output.push(observation);
        this.clearUnreadable(observation.projectItemId);
        continue;
      }
      current.add(observation.projectItemId);
      if (observation.kind === "present") {
        output.push(observation);
        this.clearUnreadable(observation.projectItemId);
        continue;
      }
      const count = (this.unreadableCounts.get(observation.projectItemId) ?? 0) + 1;
      this.unreadableCounts.set(observation.projectItemId, count);
      const shouldNotify = !observation.retryable || count >= unreadableAfterConsecutivePolls;
      if (shouldNotify && !this.unreadableNotified.has(observation.projectItemId)) {
        output.push(observation);
        this.unreadableNotified.add(observation.projectItemId);
      }
    }

    for (const projectItemId of this.knownProjectItemIds) {
      if (!current.has(projectItemId) && !explicitlyRemoved.has(projectItemId)) {
        output.push({
          kind: "removed",
          projectItemId,
          reason: "GitHub Project item disappeared from a complete polling reconciliation",
        });
        this.clearUnreadable(projectItemId);
      }
    }
    this.knownProjectItemIds = current;
    return output;
  }

  public markDispatchFailed(observation: ProjectItemObservation): void {
    if (observation.kind === "removed") {
      this.knownProjectItemIds.add(observation.projectItemId);
    } else if (observation.kind === "unreadable") {
      this.unreadableNotified.delete(observation.projectItemId);
    }
  }

  public snapshot(): PollingTrackerState {
    return {
      knownProjectItemIds: [...this.knownProjectItemIds],
      unreadableCounts: [...this.unreadableCounts].map(([projectItemId, count]) => ({
        projectItemId,
        count,
      })),
      unreadableNotified: [...this.unreadableNotified],
    };
  }

  private clearUnreadable(projectItemId: ProjectItemId): void {
    this.unreadableCounts.delete(projectItemId);
    this.unreadableNotified.delete(projectItemId);
  }
}
