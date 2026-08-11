---
name: deliver-slice
description: Complete one delegated repository slice as its trusted owner, including implementation, validation, ten specialized code reviews, systemic assurance, repairs, and re-review. Use only from a spawned Slice Owner or Integration Owner with explicit scope and authority. Do not use from a read-only reviewer.
---

# Deliver Slice

Own the assigned outcome from acceptance through a clean terminal result. Keep routine implementation and review activity within this thread.

## Accept the assignment

1. Restate the outcome, scope, constraints, dependencies, authority, and completion criteria.
2. Inspect the repository and current revision before editing.
3. Escalate immediately as `DECISION_REQUIRED` when materially different interpretations would change the implementation.
4. Preserve unrelated user changes and remain within the assigned write scope.

## Implement and validate

Implement the smallest complete change that satisfies the outcome. Exercise relevant behavioral tests and repository validation. Diagnose failures and repair defects within the assigned authority.

Write only product code, tests, configuration, migrations, and documentation required by the slice. Do not create workflow state, reviewer reports, handoff files, agent mailboxes, or private protocol records.

Establish an immutable review target using the assigned base and complete candidate tree. Prefer a commit or pull-request head. If review must use a working tree, record its tree identity, prohibit all writes while the review batch runs, and verify the tree is unchanged before accepting any result. Discard the entire batch if the candidate changes.

On resume, reconstruct implementation state from the work item, branch or worktree, commits, pull request, CI, and explicit decisions. Unless a terminal result for the exact candidate is durably recorded in an existing authoritative work item or pull request, rerun behavioral validation, all ten lens reviews, and systemic assurance. Never trust a compacted or partial account of intermediate passes.

## Run first-tier review

Spawn the following ten read-only custom agents against the same complete candidate:

1. `intent_scope_reviewer`
2. `functional_domain_correctness_reviewer`
3. `architecture_boundaries_reviewer`
4. `interfaces_compatibility_reviewer`
5. `data_integrity_lifecycle_reviewer`
6. `security_privacy_abuse_reviewer`
7. `reliability_failure_behavior_reviewer`
8. `concurrency_distributed_systems_reviewer`
9. `performance_scalability_reviewer`
10. `verification_observability_change_safety_reviewer`

Create fresh reviewer threads for each candidate. Use minimal task-local context with no inherited implementation or prior-review history where the runtime supports it, such as `fork_turns="none"`. Provide each reviewer only the outcome, constraints, base, candidate identity, complete diff, relevant repository instructions, and available evidence. Run reviewers concurrently when capacity permits and in waves otherwise. Wait for every result, summarize it locally, and close completed reviewer threads before starting another candidate batch.

For each result:

- Treat `FINDINGS` as blocking. Repair every qualifying finding within scope.
- Treat `INDETERMINATE` as blocking until the missing evidence is supplied or the uncertainty is escalated.
- Treat `PASS` as valid only for the exact candidate reviewed.
- Do not dismiss or suppress a finding merely because another reviewer did not report it.
- Escalate findings that require new scope, architectural authority, or risk acceptance.

After any repair, create a new candidate identity and rerun all ten reviewers. Proceed only when all ten return `PASS` for the same candidate.

## Run systemic assurance

After the ten passes, spawn `systemic_assurance_reviewer` in a fresh thread with minimal task-local context and no inherited implementation or repair history where supported. Keep the candidate frozen. Supply the ten reports, requirements, complete diff, validation evidence, and applicable deployment, migration, rollback, recovery, and operational context. Accept its decision only when it names the same candidate; then close its thread after summarizing the result.

- On `BLOCK` that requires a source, configuration, migration, or material rollout-plan change, repair it, assign a new candidate identity, rerun all ten first-tier reviewers, and then rerun systemic assurance.
- On `BLOCK` caused only by missing external validation or operational evidence, retain the unchanged candidate and rerun systemic assurance with the new evidence. When uncertain whether the candidate changed materially, use the complete first-tier sequence.
- On `NOT READY`, supply the missing prerequisite or escalate it.
- On `APPROVE WITH ACCEPTED RESIDUAL RISK`, return `DECISION_REQUIRED` unless the assignment already identifies an authorized owner and explicit acceptance for that exact risk.
- On `APPROVE`, finish the slice.

Do not use a ceremonial retry counter. Return `FAILED` or `DECISION_REQUIRED` when a repair cycle makes no material progress, the same root finding recurs, or convergence requires authority outside the assignment.

## Return one terminal report

Return exactly one of `COMPLETE`, `DECISION_REQUIRED`, `BLOCKED`, or `FAILED`.

For `COMPLETE`, report concisely:

- slice identifier and outcome;
- base and final candidate identity;
- changed files or components;
- behavioral validation performed;
- confirmation that all ten reviewers passed the same candidate;
- systemic assurance decision;
- remaining limitations or accepted risks; and
- integration notes.

For `DECISION_REQUIRED`, report the current candidate, exact decision, authority required, viable options and material tradeoffs, safest default while paused, and preserved work state.

For `BLOCKED`, report the current candidate, external blocker, responsible owner or dependency, evidence of the blocker, precise unblock condition, and preserved work state.

For `FAILED`, report the current candidate, unmet completion criterion, concise evidence of non-convergence or infeasibility, preserved work state, and recommended next action.

Do not return raw test logs, reviewer transcripts, intermediate findings, or repair history unless specifically requested after completion.
