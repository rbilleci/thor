import { issueIdSchema, projectItemIdSchema } from "@thor/domain";
import type { ProjectItemObservation, ProjectItemSnapshot } from "@thor/github";
import { describe, expect, it } from "vitest";

import { PollingObservationTracker } from "./polling.js";

describe("PollingObservationTracker", () => {
  it("isolates unreadable items, debounces retryable failures, and detects removal", () => {
    const tracker = new PollingObservationTracker();
    const first = tracker.reconcile([present("one"), present("two")], 2);
    expect(first.map(key)).toEqual(["present:one", "present:two"]);

    const firstFailure = tracker.reconcile([present("one"), unreadable("two", true)], 2);
    expect(firstFailure.map(key)).toEqual(["present:one"]);

    const repeatedFailure = tracker.reconcile([present("one"), unreadable("two", true)], 2);
    expect(repeatedFailure.map(key)).toEqual(["present:one", "unreadable:two"]);
    expect(tracker.reconcile([present("one"), unreadable("two", true)], 2).map(key)).toEqual([
      "present:one",
    ]);

    const removed = tracker.reconcile([present("one")], 2);
    expect(removed.map(key)).toEqual(["present:one", "removed:two"]);
  });

  it("surfaces a non-retryable malformed item immediately without dropping valid items", () => {
    const tracker = new PollingObservationTracker();
    expect(tracker.reconcile([unreadable("bad", false), present("good")], 10).map(key)).toEqual([
      "unreadable:bad",
      "present:good",
    ]);
  });

  it("detects an item removed before synchronizer restart when seeded from running Workflows", () => {
    const tracker = new PollingObservationTracker();
    tracker.seed([projectItemIdSchema.parse("missing-after-restart")]);
    expect(tracker.reconcile([], 3).map(key)).toEqual(["removed:missing-after-restart"]);
  });

  it("retries suppressed removal and unreadable observations after dispatch failure", () => {
    const tracker = new PollingObservationTracker();
    tracker.reconcile([present("one"), unreadable("two", false)], 3);

    const removal = tracker
      .reconcile([unreadable("two", false)], 3)
      .find((observation) => observation.kind === "removed");
    if (removal === undefined) throw new Error("fixture did not emit removal");
    tracker.markDispatchFailed(removal);
    expect(tracker.reconcile([unreadable("two", false)], 3).map(key)).toContain("removed:one");

    const unreadableObservation = unreadable("two", false);
    tracker.markDispatchFailed(unreadableObservation);
    expect(tracker.reconcile([unreadableObservation], 3).map(key)).toContain("unreadable:two");
  });

  it("preserves removal and unreadable debounce state across Continue-as-New", () => {
    const initial = new PollingObservationTracker();
    initial.reconcile([present("one"), unreadable("two", true)], 2);

    const resumed = new PollingObservationTracker(initial.snapshot());

    expect(resumed.reconcile([unreadable("two", true)], 2).map(key)).toEqual([
      "unreadable:two",
      "removed:one",
    ]);
  });
});

function present(id: string): ProjectItemObservation {
  const projectItemId = projectItemIdSchema.parse(id);
  const snapshot: ProjectItemSnapshot = {
    projectItemId,
    projectId: "PVT_polling",
    updatedAt: "1",
    status: "ready",
    ticket: {
      projectItemId,
      issueId: issueIdSchema.parse(`I_${id}`),
      repository: { owner: "example", name: "service" },
      issueNumber: id === "one" ? 1 : 2,
      title: id,
      body: "body",
      workType: "task",
      priority: "P2",
      acceptanceCriteria: ["done"],
      dependencies: [],
      policy: {
        executionMode: "agent",
        planningDepth: "full",
        approvalPolicy: "autonomous",
        agentPolicy: "preferred",
        autonomousRepairBudget: 2,
      },
    },
  };
  return { kind: "present", projectItemId, snapshot };
}

function unreadable(id: string, retryable: boolean): ProjectItemObservation {
  return {
    kind: "unreadable",
    projectItemId: projectItemIdSchema.parse(id),
    reason: "fixture read failure",
    retryable,
  };
}

function key(observation: ProjectItemObservation): string {
  return `${observation.kind}:${observation.projectItemId}`;
}
