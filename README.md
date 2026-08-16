# Thor

Thor is an autonomous software-delivery orchestrator built around Temporal and GitHub. It coordinates planning, implementation, review, repair, approval, and merge workflows executed by AI agents while keeping humans in control of project state and policy.

The project is currently in its design phase. The complete architecture and lifecycle specification is in [docs/design.md](docs/design.md).

## Architecture

- **GitHub Projects** is the source of truth for tickets, planning state, dependencies, priorities, and human approvals.
- **GitHub repositories** are the source of truth for code, commits, pull requests, and software artifacts.
- **Temporal** owns durable workflow execution, retries, timers, cancellation, worker coordination, and parallel review fan-out.
- **Agent workers** execute blueprinting, implementation, review, repair, and selected maintenance activities.

Thor uses Temporal Open Source for local development and Temporal Cloud in production.

## Technical direction

- Workflows and workers are implemented in Rust using the Temporal Rust SDK.
- Claude and Codex are supported as interchangeable agentic harnesses behind a shared interface.
- Agent SDK calls and all other external effects run in Temporal Activities so Workflow code remains deterministic.
- Each harness has its own base prompt, `AGENTS.md`, built-in skills, and execution configuration.
- Ticket metadata and blueprint context determine which additional custom skills are injected for an execution.
- Prompt, instruction, and skill versions are recorded for reproducibility and auditing.

## Delivery lifecycle

```text
Blueprint
-> Implementation
-> Parallel focused review
-> Synthesis
-> Repair and impact-based re-review
-> Deferred-finding materialization
-> Merge
-> Done
```

Human approval gates are inserted only when required by ticket policy or dynamic risk escalation.

## Development

The Rust workspace has not been scaffolded yet. Once it exists, the baseline validation commands will be:

```bash
cargo fmt --check
cargo check --workspace
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
```

Repository-specific contribution and implementation guidance lives in [AGENTS.md](AGENTS.md).
