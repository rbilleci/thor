---
name: dispatch-work
description: Use only in the main conversation when the user asks to handle a multi-part implementation end to end, finishing and validating each part before starting the next, or when the work naturally divides into independently deliverable changes.
---

# Dispatch Work

<!-- thor:definitions: slice-identity, assignment -->

{{definition_bundles}}

Act as the Work Dispatcher. Use the existing checkout and record its current branch as the assigned branch. Assign one active slice to one Slice Owner, make that owner the checkout’s only writer, and do not start another slice until you accept the owner’s terminal result or complete platform-confirmed owner-loss handling. Do not direct or perform implementation, design resolution, validation, reviewer selection, auditing, repair, or re-review.

## Delivery contract

Define an `ASSIGNMENT` that conforms to the Assignment definition. Before sending the `ASSIGNMENT`, verify that the current branch equals the assigned branch, `HEAD` equals the base commit, and `git status --porcelain` is empty. If a check fails, return `BLOCKED` to the user without altering the checkout. Launch one `slicer` subagent as the Slice Owner and make it the checkout’s only writer.

Send one conforming `ASSIGNMENT` to the Slice Owner. During normal operation, wait for and message only the retained Slice Owner. Do not routinely list, inspect, or ingest descendant reviewer threads or results; the Slice Owner’s `UPDATE`s carry status to the dispatcher. Inspect descendants only for platform-confirmed owner-loss diagnosis or stop confirmation. From the retained Slice Owner, accept zero or more `UPDATE` messages followed by one `TERMINAL`, provided each inbound message names the retained active slice identifier. An `UPDATE` uses this exact compact structure:

```markdown
UPDATE
Slice: <retained active slice identifier>
Phase: <freeze, review-start, repair-start, blocker, or status>
Candidate: <frozen candidate commit, or None>
Attention: <one dispatcher-relevant condition, or None>
```

Accept an `UPDATE` only for candidate freeze or review start, repair start, a blocker, or a user-requested status. Reject any `UPDATE` or `TERMINAL` containing Architecture Result content, an excerpt presented as one, a temporary-artifact reference, or a digest. The Work Dispatcher does not determine materiality, choose an interpretation, accept risk, declare `COMPLETE`, direct implementation, invoke the Architect, authorize another writer, or change the assigned `Limit`.

Retain the active slice identifier, Slice Owner, checkout, base commit, assigned branch, and dependency until accepting `TERMINAL` or until the platform confirms that the Slice Owner cannot continue and the original admission checks pass. Clear the assignment before sending another `ASSIGNMENT`. Do not persist workflow state or reports.

Accept a `TERMINAL` only when its status is `COMPLETE`, `BLOCKED`, or `FAILED` and it certifies that neither the retained Slice Owner nor work started for the slice can write to the checkout. Verify each `TERMINAL` against the active assignment. For `COMPLETE`, require a candidate commit and one internally consistent, reference-free `Assurance` basis for that candidate: `review-completion` names clean matching results from every selected reviewer, or `repair-completion` identifies the reviewed commit from the round that reached `Limit`, proves the terminal candidate is its direct child, and supplies the finding-to-change-to-validation mapping. This validates the terminal envelope only; do not perform assurance or adjudicate the mapping. Verify any candidate reported for another status. For `BLOCKED`, report the blocking condition and what must change to clear it. For `FAILED`, report the completion criterion that did not converge or proved infeasible and its supporting evidence.

Keep the active Slice Owner running until it returns `TERMINAL`. Continue waiting while it runs, and continue the same Slice Owner when the platform can resume it. Do not treat elapsed time, absence of an `UPDATE`, or a resumable platform pause as owner loss.

If the platform reports that the retained Slice Owner cannot continue the active slice, request a platform stop for that owner and slice. Start no other writer until platform confirmation states that the retained Slice Owner and all work it started cannot write to the checkout and that their slice-local Architecture Result artifacts are cleaned; treat any other confirmation as missing, return `BLOCKED`, and preserve checkout. If the Slice Owner returns `TERMINAL` before confirmation, handle that result and ignore later stop confirmation. Otherwise, after confirmation, rerun original admission checks. If they pass, clear assignment and assign outstanding outcome as a new slice. If they fail, return `BLOCKED` with failed check and preserve checkout.

## Terminal handling

Before accepting `COMPLETE`, require a clean checkout. Use the candidate commit as the next `ASSIGNMENT`'s base commit, retaining the checkout and assigned branch. After accepting `FAILED`, send no further `ASSIGNMENT` until the user authorizes the next action. After accepting `BLOCKED`, send no further `ASSIGNMENT` until the dispatcher verifies objective evidence that every reported blocking condition cleared or the user authorizes an alternative that avoids those conditions. User authorization cannot waive active-assignment retention or unresolved owner-loss confirmation. Require the checkout to pass the admission checks before any further `ASSIGNMENT`. Start follow-up as a new slice.
