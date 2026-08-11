---
name: dispatch-work
description: Delegate substantial repository changes into bounded, outcome-based slices owned end to end by spawned Slice Owners. Use only from the primary or root agent acting as Work Dispatcher for substantial single-slice, multi-slice, parallel, or long-running work. Do not use from a Slice Owner or reviewer.
---

# Dispatch Work

Act as the Work Dispatcher. Assign complete outcomes; do not coordinate routine implementation or review activity.

## Establish the delivery contract

1. State the overall outcome, constraints, non-goals, and verifiable completion criteria.
2. Inspect enough repository context to identify coherent ownership boundaries.
3. Divide work only when slices can be described as independently verifiable outcomes.
4. Give only one Slice Owner write responsibility for a file or tightly coupled area at a time.
5. Keep small or strongly coupled changes with one owner instead of manufacturing parallelism.

For every slice provide:

- identifier and intended outcome;
- included and excluded scope;
- relevant requirements and repository context;
- authority boundaries and decisions that require escalation;
- dependencies on other slices;
- validation and acceptance criteria;
- expected integration point or base revision; and
- instruction to use `$deliver-slice` and return only a terminal report.

## Delegate ownership

Spawn `slice_owner` for each ready slice. The Slice Owner owns implementation, validation, all ten first-tier reviews, the systemic review, repairs, and re-review. Do not relay routine findings between the owner and reviewers.

Run independent slices concurrently only when their write scopes do not overlap. Use separate worktrees when concurrent owners would otherwise share a checkout. Sequence dependent or overlapping slices.

Treat integration and finalization as another owned slice. Assign an Integration Owner through `slice_owner`; do not absorb its implementation or review loop into the Work Dispatcher.

## Process only terminal reports

Accept four outcomes:

- `COMPLETE`: the assigned outcome is implemented and validated; all ten lens reviewers passed the same final candidate; systemic assurance approved it.
- `DECISION_REQUIRED`: progress requires authority outside the assignment, including new scope, architecture, risk acceptance, or incompatible requirements.
- `BLOCKED`: an external dependency prevents progress.
- `FAILED`: the owner cannot produce a defensible candidate or the repair loop is not converging.

Resolve decisions and blockers, then return the slice to an owner with an amended delivery contract. Do not request raw review transcripts unless investigating a disputed terminal report.

## Preserve long-running state simply

Use the work item, branch or worktree, commits, pull request, CI results, and explicit user decisions as durable state. Record at most the terminal status and exact candidate identity in an existing authoritative work item or pull request. On resume, reconstruct status from those sources.

Unless a terminal result for the exact candidate is durably recorded, treat intermediate validation and review state as untrusted. Assign an owner to rerun validation, all ten lens reviews, and systemic assurance rather than relying on compacted or partial thread history.

Do not create workflow ledgers, agent mailboxes, lock files, review-result files, digest chains, or hidden protocol state. Do not require agents to maintain a lifecycle state machine.

## Finish

Make only `COMPLETE` slices eligible for integration. Assign integration and finalization to an Integration Owner through `slice_owner`. Verify terminal reports against the assigned boundaries and completion criteria without performing implementation or an unreviewed merge repair in the Work Dispatcher thread.
