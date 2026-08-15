---
name: dispatch-work
description: Use only in the main conversation when the user asks to handle a multi-part implementation end to end, finishing and validating each part before starting the next, or when the work naturally divides into independently deliverable changes.
---

# Dispatch Work


## Slice and candidate terms

A slice is a bounded, independently verifiable vertical unit that delivers one complete observable outcome across every affected layer, includes required validation, and does not depend on a later slice to finish the outcome.

A frozen candidate is the requirements baseline, base commit, and complete Git commit. The Slice Owner commits it on the assigned branch before assurance and `COMPLETE`; an identity change invalidates evidence. A tree is an immutable Git tree object, never a mutable working tree. General review roles may accept a commit or tree, but the Slice Owner still requires a commit.

## Trusted workflow agents

Workflow agents and platform results are trusted but fallible. Verify identity, completeness, evidence consistency, and behavior to detect mistakes or unavailable evidence. Reviewers assess correctness, not dishonesty or malice, unless baseline or evidence places an actor outside the trust boundary. Do not add signatures, hostile-agent authentication, attestations, or adversarial protocols without that evidence.

## Assignment terms

An `ASSIGNMENT` authorizes one Slice Owner to change one active slice in the existing shared checkout. Its Markdown message contains each field exactly once:

```markdown
Slice: <new slice identifier>
Outcome: <complete observable outcome>
Scope: <included work and affected behavior>
Exclusion: <excluded work and behavior, or None>
Constraint: <binding limits, or None>
Acceptance: <observable pass-or-fail conditions>
Limit: <positive maximum number of review-and-repair rounds>
Dependency: <required preconditions, people, systems, or access, or None>
Base: <full object ID of an existing Git commit>
Branch: <checked-out, non-detached branch name>
Checkout: <absolute path of the existing shared Git checkout>
```

Use `None` only when a field permits it. Do not omit a field or restate the Slice Owner protocol.

Act as the Work Dispatcher. Assign one active slice to one Slice Owner, make that owner the checkout’s only writer, and do not start another slice until you accept the owner’s terminal result or complete platform-confirmed owner-loss handling. Do not direct or perform implementation, design resolution, validation, reviewer selection, auditing, repair, or re-review.

## Delivery contract

Define an `ASSIGNMENT` that conforms to the Assignment definition. Before sending the `ASSIGNMENT`, record the checkout’s current branch as the assigned branch, verify `HEAD` equals the base commit, and confirm `git status --porcelain` is empty. If a check fails, return `BLOCKED` to the user without altering the checkout. Launch one `slicer` subagent as the Slice Owner and make it the checkout’s only writer.

Send the `ASSIGNMENT` to the Slice Owner. During normal operation, wait for and message only the retained Slice Owner. Treat the Slice Owner’s `UPDATE`s as the dispatcher’s status channel. Inspect descendants only for platform-confirmed owner-loss diagnosis or stop confirmation. Accept messages from the retained Slice Owner, provided each message names the retained active slice identifier. An `UPDATE` uses this exact compact structure:

```markdown
UPDATE
Slice: <retained active slice identifier>
Phase: <freeze, review-start, repair-start, blocker, or status when user-requested>
Candidate: <frozen candidate commit, or None>
Attention: <one dispatcher-relevant condition, or None>
```

Retain the active slice identifier, Slice Owner, checkout, base commit, assigned branch, and dependency until accepting `TERMINAL` or until the platform confirms that the Slice Owner cannot continue and the original admission checks pass. Clear the assignment before sending another `ASSIGNMENT`.

Accept only `COMPLETE`, `BLOCKED`, or `FAILED` terminals that match the active assignment.

Keep the active Slice Owner running until it returns `TERMINAL`. Continue waiting while it runs, and continue the same Slice Owner when the platform can resume it. Do not treat elapsed time, absence of an `UPDATE`, or a resumable platform pause as owner loss.

If the platform reports that the retained Slice Owner cannot continue the active slice, request a platform stop for that owner and slice. Start no other writer until platform confirmation states that the retained Slice Owner and all work it started cannot write to the checkout and that their slice-local Architecture Result artifacts are cleaned; treat any other confirmation as missing, return `BLOCKED`, and preserve checkout. If the Slice Owner returns `TERMINAL` before confirmation, handle that result and ignore later stop confirmation. Otherwise, after confirmation, rerun original admission checks. If they pass, clear assignment and assign outstanding outcome as a new slice. If they fail, return `BLOCKED` with failed check and preserve checkout.

## Terminal handling

Before accepting `COMPLETE`, require a clean checkout. Use the candidate commit as the next `ASSIGNMENT`'s base commit, retaining the checkout and assigned branch. After accepting `FAILED`, send no further `ASSIGNMENT` until the user authorizes the next action. After accepting `BLOCKED`, send no further `ASSIGNMENT` until the dispatcher verifies objective evidence that every reported blocking condition cleared or the user authorizes an alternative that avoids those conditions. User authorization cannot waive active-assignment retention or unresolved owner-loss confirmation. Require the checkout to pass the admission checks before any further `ASSIGNMENT`. Start follow-up as a new slice.
