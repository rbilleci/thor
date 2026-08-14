---
name: dispatch-work
description: Use only in the main conversation when the user asks to handle a multi-part implementation end to end, finishing and validating each part before starting the next, or when the work naturally divides into independently deliverable changes.
---

# Dispatch Work


## Slice and candidate terms

A slice is a bounded, independently verifiable vertical unit that delivers one complete observable outcome across every affected layer, includes required validation, and does not depend on a later slice to finish the outcome.

A frozen candidate is the requirements baseline, base commit, and complete Git commit. The Slice Owner commits it on the assigned branch before assurance and `COMPLETE`; an identity change invalidates evidence. A tree is an immutable Git tree object, never a mutable working tree. General review roles may accept a commit or tree, but the Slice Owner still requires a commit.

Act as the Work Dispatcher. Use the existing checkout. Set the assigned branch to its current branch. Assign one active slice to one Slice Owner, wait for its terminal result or complete confirmed owner-loss handling, and only then start another slice. Do not coordinate implementation, design resolution, validation, selection, auditing, repair, or re-review.

## Delivery contract

Define an `ASSIGNMENT` containing the requirements baseline—an independently verifiable outcome, scope, non-goals, constraints, and acceptance criteria—plus decision authority, dependencies, base commit, assigned branch, and checkout. Use a new slice identifier. Before sending the `ASSIGNMENT`, verify that the current branch equals the assigned branch, `HEAD` equals the base commit, and `git status --porcelain` is empty. If a check fails, return `BLOCKED` to the user without altering the checkout. Launch one `slicer` subagent as the Slice Owner and make it the checkout’s only writer. Do not create another Git worktree or branch.

Send one `ASSIGNMENT` that names the new slice identifier to the Slice Owner. From the retained Slice Owner, accept zero or more `UPDATE` messages followed by one `TERMINAL`, provided each inbound message names the retained active slice identifier. Accept an `UPDATE` only for candidate freeze or review start, repair start, a blocker or decision, or a user-requested status.

Retain the active slice identifier, Slice Owner, checkout, base commit, assigned branch, and dependencies until accepting `TERMINAL` or until the platform confirms that the Slice Owner cannot continue and the original admission checks pass. Clear the assignment before sending another `ASSIGNMENT`. Do not persist workflow state or reports.

Accept a `TERMINAL` only when its status is `COMPLETE`, `DECISION_REQUIRED`, `BLOCKED`, or `FAILED` and it certifies that neither the retained Slice Owner nor work started for the slice can write to the checkout. Verify each `TERMINAL` against the active assignment. Require a candidate commit for `COMPLETE`; verify any candidate reported for another status. Route each non-complete `TERMINAL` by status. For `DECISION_REQUIRED`, ask the user for the stated decision. For `BLOCKED`, report the blocking condition and what must change to clear it. For `FAILED`, report the completion criterion that did not converge or proved infeasible and its supporting evidence.

Keep the active Slice Owner running until it returns `TERMINAL`. Continue waiting while it runs, and continue the same Slice Owner when the platform can resume it. Do not treat elapsed time, absence of an `UPDATE`, or a resumable platform pause as owner loss.

If the platform reports that the retained Slice Owner cannot continue the active slice, request a platform stop for that owner and slice. Start no other writer until the platform confirms that the retained Slice Owner and all work it started, directly or indirectly, can no longer write to the checkout. Treat any other confirmation as missing, return `BLOCKED`, and preserve the checkout. If the Slice Owner returns `TERMINAL` before confirmation, handle that result and ignore later stop confirmation. Otherwise, after confirmation, rerun the original admission checks. If they pass, clear the assignment and assign the outstanding outcome as a new slice. If they fail, return `BLOCKED` with the failed check and preserve the checkout.

## Terminal handling

Before accepting `COMPLETE`, require a clean checkout. Use the candidate commit as the next `ASSIGNMENT`'s base commit, retaining the checkout and assigned branch. After accepting `DECISION_REQUIRED` or `FAILED`, send no further `ASSIGNMENT` until the user authorizes the next action. After accepting `BLOCKED`, send no further `ASSIGNMENT` until the dispatcher verifies objective evidence that every reported blocking condition cleared or the user authorizes an alternative that avoids those conditions. User authorization cannot waive active-assignment retention or unresolved owner-loss confirmation. Require the checkout to pass the admission checks before any further `ASSIGNMENT`. Start follow-up as a new slice.
