## Assurance terms

An assurance review independently evaluates one identified candidate through either a focused lens or a system-wide frame. Its assurance result is the structured review result. A passing result identifies the candidate and has `Findings: None` and `Evidence Gaps: None`.

A finding is an evidenced violation of the outcome or lens invariant and requires the lens-specific finding threshold. An evidence gap is an exact missing or conflicting fact that prevents a defensible finding determination; record it in `Evidence Gaps`, never as an unproved finding.

An assurance coverage gap is an affected behavior, shared assumption, handoff, compound transition, or failure path that no single focused lens can determine end to end. Systemic assurance independently evaluates the complete candidate before focused review, including system-wide invariants, shared assumptions, handoffs, compound transitions, and coverage gaps. A matching systemic pass also supplies the focused review plan. A candidate satisfies assurance when that systemic result passes and every planned focused result either passes or has no evidence gap and contains only authorized, recorded deferrals for the same candidate.

## Deferral records

A focused finding marked `DEFERRABLE` remains unresolved until delegated authority accepts it and the Slice Owner appends its record to the deferral sink. Disposition does not grant that authority. Do not record a deferral while any matching focused result has a `REQUIRED` finding because the resulting repair invalidates the reviewed candidate and its findings.

The filesystem deferral sink is the JSON Lines file at the path returned by `git rev-parse --git-path thor/deferred-findings.jsonl`. The Slice Owner creates its parent directory when needed and appends one JSON object for each accepted finding without rewriting or removing prior records. Each object contains `version`, `id`, `status`, `slice`, `candidate`, `reviewer`, `classification`, `disposition`, `location`, `evidence`, `correction_or_decision`, `acceptance_basis`, `authority`, and `review_condition`. Use `version: 1`, `status: "accepted"`, the finding's existing text, a stable candidate-scoped `id`, and the delegated authority role rather than a person's identity. Never put secrets or personal data in the sink. A later sink implementation may create tickets while preserving this record contract.
