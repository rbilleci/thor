# Repository Guidance

## Project

Thor is an autonomous software-delivery orchestrator. Read `docs/design.md` before making architectural or workflow changes; it is the canonical design specification.

The system keeps these authority boundaries:

- GitHub Projects owns human-facing business state, planning policy, dependencies, and approvals.
- GitHub repositories own code, commits, pull requests, and software artifacts.
- Temporal owns durable execution state, retries, timers, cancellation, fan-out, and coordination.
- Human GitHub changes are authoritative external events and must not be overwritten blindly.

## Technical Direction

- Implement workflows and workers in Rust using the Temporal Rust SDK.
- Keep Temporal Workflow code deterministic. Network calls, repository operations, model execution, and all other external effects belong in Activities.
- Support Claude and Codex as first-class, interchangeable agentic harnesses behind a shared Rust abstraction.
- Invoke each harness programmatically through its SDK from Temporal Activities.
- Keep provider-specific authentication, configuration, cancellation, result parsing, and error mapping inside provider adapters.
- Do not let provider-specific types leak into orchestration-domain interfaces.

## Agent Execution Packages

- Maintain a distinct base prompt, `AGENTS.md`, built-in skill set, and execution configuration for each supported harness.
- Assemble a ticket-specific execution package as part of the workflow.
- Select and inject custom skills from ticket and blueprint context, including work type, component, risk, acceptance criteria, and execution policy.
- Treat prompts, instruction files, and skills as versioned inputs. Record their versions or content digests with execution results for auditability and reproducibility.
- Validate generated instruction and skill bundles before invoking a harness.
- Never place secrets in prompts, instruction files, skills, workflow histories, logs, or GitHub comments.

## Workflow Invariants

- Use one deterministic Temporal Workflow ID per GitHub Project item.
- Design every GitHub mutation with idempotency or find-or-create semantics.
- Re-read GitHub state before material transitions and surface conflicts to the Workflow.
- Use Activity heartbeats for long-running work and make Activities cancellation-aware.
- Keep review findings structured. Reviewers discover, synthesis arbitrates, and repair workers act.
- Keep ordinary remediation in `Repairing` and `Re-review`; only broader failures return to implementation or blueprinting.
- Materialize every accepted deferred finding as a durable GitHub issue before merge.
- Enforce configured human approval gates through durable Workflow waits.

## Rust Practices

- Prefer explicit domain types and enums over loosely typed strings for workflow state, policies, findings, and identifiers.
- Separate deterministic workflow logic from Activities, provider adapters, GitHub integration, and persistence concerns.
- Make retryability explicit in error types; distinguish retryable infrastructure failures from terminal policy or validation failures.
- Use structured tracing with correlation identifiers, but avoid logging credentials or full sensitive prompts.
- Keep public APIs documented and avoid `unsafe` unless a documented constraint makes it necessary.

## Validation

Once a Cargo workspace exists, run the applicable checks before considering a change complete:

```text
cargo fmt --check
cargo check --workspace
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
```

Add focused tests for workflow transitions, replay determinism, retries, cancellation, idempotent side effects, provider normalization, and prompt/skill selection. Do not claim integration behavior is verified when external services were unavailable.

## Change Discipline

- Preserve unrelated worktree changes.
- Update `docs/design.md` when an architectural decision or lifecycle invariant changes.
- Keep provider behavior replaceable and testable with fakes; unit tests must not require live Claude, Codex, GitHub, or Temporal Cloud access.
- Do not add dependencies without explaining why the standard library or existing dependencies are insufficient.
