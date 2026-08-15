## Assurance terms

An assurance review is one independent canonical-lens evaluation of one frozen candidate. Its result identifies that candidate.

A review set contains every assurance review selected by the accepted Architecture Result for one frozen candidate. A complete review set contains one matching result from every selected reviewer. A clean review set is complete and contains no findings or evidence gaps. A valid `Selection: None` creates an empty review set.

A review-and-repair round contains one review set and the evidence resolution, authority resolution, repair, and validation arising from that set. It excludes any review of the repaired candidate.

A finding proves that accepting the candidate violates a named acceptance condition, outcome invariant, or applicable contract in a feasible current-context scenario. Its evidence names the governing requirement, candidate connection, observable failure, and acceptance consequence. Importance, preference, possible future exposure, and hardening do not establish a finding.

A `REPAIR` finding identifies a correction within the requirements baseline. An `AUTHORITY_REQUIRED` finding identifies an exact authority question whose answer determines the correction. It does not contain or imply the authority’s answer.

An authority request states one exact authority question, its governing evidence, its permitted choices, and each choice’s consequence. It is not a finding or a decision.

An evidence gap is an exact missing or conflicting fact that prevents a defensible finding determination. It is not an unproved finding.

An assurance coverage gap is an affected behavior, shared assumption, handoff, compound transition, or failure path that no canonical lens can determine end to end.
