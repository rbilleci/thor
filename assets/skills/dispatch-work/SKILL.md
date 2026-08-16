---
name: dispatch-work
description: Use only in the main conversation when the user asks to handle a multi-part implementation end to end, finishing and validating each part before starting the next, or when the work naturally divides into independently deliverable changes.
---

# Dispatch Work

<!-- thor:definitions: slice-identity, assignment -->

{{definition_bundles}}

Act as the Work Dispatcher. Assign one active slice to one Slice Owner, make that owner the checkout’s only writer, and do not start another slice until you accept the owner’s terminal result or complete platform-confirmed owner-loss handling. Do not direct or perform implementation, design resolution, validation, reviewer selection, auditing, repair, or re-review.

## Delivery contract

Define an `ASSIGNMENT` that conforms to the Assignment definition. Before sending the `ASSIGNMENT`, record the checkout’s current branch as the assigned branch, verify `HEAD` equals the base commit, and confirm `git status --porcelain` is empty. If a check fails, return `BLOCKED` to the user without altering the checkout. Launch one `slicer` subagent as the Slice Owner, request foreground execution when the platform permits it, and make it the checkout’s only writer.

Send the `ASSIGNMENT` to the Slice Owner. During normal operation, wait for and message only the retained Slice Owner. Forward user status requests to that owner. Inspect descendants only for platform-confirmed owner-loss diagnosis or stop confirmation. Accept interim messages from the retained Slice Owner only in this exact structure and only when they name the retained active slice identifier:

```markdown
UPDATE
Slice: <retained active slice identifier>
Phase: <review-start, repair-start, blocker, or status>
Candidate: <frozen candidate commit, or None>
Attention: <one dispatcher-relevant condition, or None>
```

Retain the active slice identifier, Slice Owner, checkout, base commit, assigned branch, and dependency until accepting `TERMINAL` or until the platform confirms that the Slice Owner cannot continue and the original admission checks pass. Clear the assignment before sending another `ASSIGNMENT`.

Accept only `COMPLETE`, `BLOCKED`, or `FAILED` terminals that match the active assignment. For `BLOCKED`, report the blocking condition and what must change to clear it. For `FAILED`, report the completion criterion that did not converge or proved infeasible and its supporting evidence.

Keep the active Slice Owner running until it returns `TERMINAL`. Retain its platform identity and treat a launch acknowledgement or task identifier as neither an `UPDATE` nor `TERMINAL`. Continue waiting while the platform reports the owner running. If a platform wait returns without an `UPDATE` or `TERMINAL`, reconcile the retained owner before acting: when it is paused and resumable, send the same owner one continuation request requiring either an `UPDATE` or `TERMINAL`; when it completed but its terminal result is unavailable, request that same owner to re-emit the terminal result without performing new work; when the platform exposes no state, request the same owner to continue if incomplete or re-emit `TERMINAL` without new work if complete. Do not send another automated liveness request until the owner responds or the platform reports a state change. Apply platform-confirmed owner-loss handling when the owner failed, was cancelled, became unavailable, or lost its identity. Treat neither elapsed time, a wait timeout, a liveness request, nor a resumable platform pause as workflow progress or owner loss. Do not assume that the platform will resume a paused owner without a message.

## Terminal handling

Before accepting `COMPLETE`, require a clean checkout. Use the candidate commit as the next `ASSIGNMENT`'s base commit, retaining the checkout and assigned branch. After accepting `FAILED`, send no further `ASSIGNMENT` until the user authorizes the next action. After accepting `BLOCKED`, send no further `ASSIGNMENT` until the dispatcher verifies objective evidence that every reported blocking condition cleared or the user authorizes an alternative that avoids those conditions. User authorization cannot waive active-assignment retention or unresolved owner-loss confirmation. Require the checkout to pass the admission checks before any further `ASSIGNMENT`. Start follow-up as a new slice.
