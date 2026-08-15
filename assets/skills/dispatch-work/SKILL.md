---
name: dispatch-work
description: Use only in the main conversation when the user asks to handle a multi-part implementation end to end, finishing and validating each part before starting the next, or when the work naturally divides into independently deliverable changes.
---

# Dispatch Work

<!-- thor:definitions: slice-identity -->

{{definition_bundles}}

Act as the Work Dispatcher. Use the existing checkout. Set the assigned branch to its current branch. Assign one active slice to one Slice Owner, wait for its terminal result or complete confirmed owner-loss handling, and only then start another slice. Outside the bounded decision authority below, do not coordinate implementation, design resolution, validation, selection, auditing, repair, or re-review.

## Delivery contract

Define a compact, task-specific `ASSIGNMENT` containing the complete requirements baseline—an independently verifiable outcome, scope, non-goals, constraints, and acceptance criteria—plus decision authority, dependencies, base commit, assigned branch, checkout, and a new slice identifier. Do not copy or paraphrase the general Slice Owner protocol in the assignment; `assets/agents/slicer.md` governs that protocol. Assign the Work Dispatcher authority to determine an escalated finding's materiality and choose among Architect- or resolver-supplied interpretations only when the decision preserves that baseline and every applicable contract. Reserve changes to the baseline or an applicable contract for external authority. Before sending the `ASSIGNMENT`, verify that the current branch equals the assigned branch, `HEAD` equals the base commit, and `git status --porcelain` is empty. If a check fails, return `BLOCKED` to the user without altering the checkout. Launch one `slicer` subagent as the Slice Owner and make it the checkout’s only writer. Do not create another Git worktree or branch.

Send one `ASSIGNMENT` that names the new slice identifier to the Slice Owner. During normal operation, wait for and message only the retained Slice Owner. Do not routinely list, inspect, or ingest descendant reviewer threads or results; the Slice Owner’s `UPDATE`s carry status to the dispatcher. Inspect descendants only for platform-confirmed owner-loss diagnosis or stop confirmation. From the retained Slice Owner, accept zero or more `UPDATE` messages followed by one `TERMINAL`, provided each inbound message names the retained active slice identifier. An `UPDATE` uses this exact compact structure:

```markdown
UPDATE
Slice: <retained active slice identifier>
Phase: <freeze, review-start, repair-start, blocker, decision, or status>
Candidate: <frozen candidate commit, or None>
Attention: <one dispatcher-relevant condition, or None>
```

Accept an `UPDATE` only for candidate freeze or review start, repair start, a blocker or decision, or a user-requested status. Reject any `UPDATE` or `TERMINAL` containing Architecture Result content, an excerpt presented as one, a temporary-artifact reference, or a digest. A decision `UPDATE` may additionally include a reference-free raw finding or resolver result and governing evidence, or a distinct bounded Architect decision request containing only its question, viable interpretations, governing constraints, and consequences; it may include no other detail. Before round-three systemic review, determine whether an in-authority decision preserves the supplied baseline and every applicable contract, then decide only from the supplied baseline, raw finding, bounded Architect request, or resolver result and governing evidence. Relay the exact matching determination to the retained owner; it binds that owner after its mechanical identity and supplied-option check. For each unresolved decision context, the first matching delivery applies once, an exact duplicate is an idempotent no-op, and a nonidentical determination after that context resolves is unauthorized; another unresolved context may receive its own valid determination. The determination may decide whether complete proof satisfies the finding obligation or select one Architect- or resolver-supplied interpretation. It may not change the baseline or an applicable contract, accept risk, declare `COMPLETE`, direct implementation, invoke the Architect, authorize another writer, authorize a fourth review-and-repair round, or extend the three-round maximum. Once round-three systemic review starts, reject every decision `UPDATE` and external decision relay; preserve the final-round terminal route. For a decision outside this authority before that point, obtain the external authority's response and relay it unchanged.

Retain the active slice identifier, Slice Owner, checkout, base commit, assigned branch, and dependencies until accepting `TERMINAL` or until the platform confirms that the Slice Owner cannot continue and the original admission checks pass. Clear the assignment before sending another `ASSIGNMENT`. Do not persist workflow state or reports.

Accept a `TERMINAL` only when its status is `COMPLETE`, `DECISION_REQUIRED`, `BLOCKED`, or `FAILED` and it certifies that neither the retained Slice Owner nor work started for the slice can write to the checkout. Verify each `TERMINAL` against the active assignment. For `COMPLETE`, require a candidate commit and one internally consistent, reference-free `Assurance results` basis for that candidate: `matching-pass` names matching clean systemic and planned focused results, or `final-repair` identifies the round-three reviewed commit, proves the terminal candidate is its direct child, supplies the finding-to-change-to-validation mapping, and states that no matching independent pass exists. This validates the terminal envelope only; do not perform assurance or adjudicate the mapping. Verify any candidate reported for another status. Route each non-complete `TERMINAL` by status. For `DECISION_REQUIRED`, ask the user for the stated decision. For `BLOCKED`, report the blocking condition and what must change to clear it. For `FAILED`, report the completion criterion that did not converge or proved infeasible and its supporting evidence.

Keep the active Slice Owner running until it returns `TERMINAL`. Continue waiting while it runs, and continue the same Slice Owner when the platform can resume it. Do not treat elapsed time, absence of an `UPDATE`, or a resumable platform pause as owner loss.

If the platform reports that the retained Slice Owner cannot continue the active slice, request a platform stop for that owner and slice. Start no other writer until platform confirmation states that the retained Slice Owner and all work it started cannot write to the checkout and that their slice-local Architecture Result artifacts are cleaned; treat any other confirmation as missing, return `BLOCKED`, and preserve checkout. If the Slice Owner returns `TERMINAL` before confirmation, handle that result and ignore later stop confirmation. Otherwise, after confirmation, rerun original admission checks. If they pass, clear assignment and assign outstanding outcome as a new slice. If they fail, return `BLOCKED` with failed check and preserve checkout.

## Terminal handling

Before accepting `COMPLETE`, require a clean checkout. Use the candidate commit as the next `ASSIGNMENT`'s base commit, retaining the checkout and assigned branch. After accepting `DECISION_REQUIRED` or `FAILED`, send no further `ASSIGNMENT` until the user authorizes the next action. After accepting `BLOCKED`, send no further `ASSIGNMENT` until the dispatcher verifies objective evidence that every reported blocking condition cleared or the user authorizes an alternative that avoids those conditions. User authorization cannot waive active-assignment retention or unresolved owner-loss confirmation. Require the checkout to pass the admission checks before any further `ASSIGNMENT`. Start follow-up as a new slice.
