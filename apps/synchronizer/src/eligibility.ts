import type { CompiledProjectBinding } from "@thor/config";
import { policyAllowsAgent } from "@thor/domain";
import type { ProjectItemSnapshot } from "@thor/github";

export function eligibleToStart(
  snapshot: ProjectItemSnapshot,
  binding: CompiledProjectBinding,
): boolean {
  const entrypoints = binding.delivery.workflow.board.entrypoints;
  return (
    (entrypoints.blueprint.includes(snapshot.status) ||
      entrypoints.implementation.includes(snapshot.status)) &&
    policyAllowsAgent(snapshot.ticket.policy) &&
    snapshot.ticket.dependencies.every((dependency) => dependency.complete)
  );
}
