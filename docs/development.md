# Thor Development Guide

The canonical product and lifecycle specification is [design.md](design.md). This guide explains the
implementation boundaries, dependency choices, and verification workflow.

## Runtime and language

Thor targets Node.js 22 and strict TypeScript. TypeScript is pinned to the newest release supported
by the installed `typescript-eslint` toolchain; adopting a newer compiler requires its peer range to
support that compiler first. `@types/node` follows the Node 22 runtime line so type checking does
not admit APIs unavailable in production.

## Package boundaries

- `@thor/domain` owns schemas, branded identifiers, redaction, policies, and the pure lifecycle
  state machine. It has no infrastructure dependencies.
- `@thor/config` owns strict `DeliveryProject` schemas, semantic validation, stable digests, live
  Project binding compilation, and the pure desired-versus-live configuration planner.
- `@thor/agent` owns the provider-neutral harness contract, execution-package assembly, and native
  Claude and Codex SDK adapters.
- `@thor/github` owns GitHub GraphQL/REST mapping, conditional mutations, idempotent side effects,
  and reserved webhook-validation helpers for the deferred webhook roadmap item.
- `@thor/slack` owns Slack Web API mapping, task-surface provisioning, transcript rendering,
  short-lived live-control credentials, command parsing, and fakes.
- `@thor/workflows` owns deterministic Temporal Workflow code and Activity implementations. Only
  Activities import filesystem, Git, GitHub, or agent SDK behavior.
- `@thor/runtime` validates environment configuration and creates concrete Temporal and GitHub
  connections.

Applications are composition roots: the worker wires real delivery adapters, the synchronizer hosts
the per-Project polling Workflow's scan/dispatch Activities and ensures that Workflow is running,
the Slack gateway verifies signed ingress and fans out live control, and the CLI exposes operator
controls.

## Dependency rationale

- Temporal SDK packages provide durable Workflow execution, replay, retries, heartbeats,
  cancellation, and the local test server. Reimplementing those semantics would violate the core
  architecture.
- `@anthropic-ai/claude-agent-sdk` and `@openai/codex-sdk` are the direct supported harness APIs;
  provider types stop at their adapters.
- Octokit provides typed GitHub REST, GraphQL, and GitHub App authentication primitives. Its
  maintained retry and throttling plugins handle short transport retries plus GitHub-specific
  primary and secondary rate-limit pacing; Temporal still owns durable Activity retries.
- `p-retry` supplies exponential jitter for process startup and live-test operations that execute
  outside Temporal. Its maximum delay is five minutes; Activity code must use Temporal Retry
  Policies instead.
- Zod validates every external payload and also produces the structured-output JSON Schemas sent to
  agent SDKs.
- Vitest, ESLint, Prettier, and `typescript-eslint` provide deterministic tests and strict static
  validation across the workspace.

The standard library handles hashing, HMAC verification, subprocess execution, file operations, and
logging; no additional framework is used for those paths.

## Development loop

Install from the lockfile and run all checks:

```bash
npm ci
npm run format:check
npm run typecheck
npm run lint
npm test
npm run test:integration
```

`npm test` includes declaration/compiler and Project-reconciler tests, semantic ID-based mapping,
synchronizer eligibility for detailed and compact boards, deterministic transition tests, Temporal
retry, cancellation, human gates, repair/re-review, and replay for both delivery profiles. The
integration suite runs both profiles through real Temporal Activities against an isolated local Git
repository while using SDK-shaped fake harnesses and a fake GitHub gateway.

Slack tests use the in-memory Slack API and signed HTTP requests. They cover both task-surface
modes, idempotent provisioning, authorization and command receipts, normalized Claude and Codex
streams, queue/redirect/cancel semantics, transcript coalescing and rate-limit recovery, router
mapping and deduplication, direct acknowledgement, and the durable phase-restart fallback. They
require no Slack workspace or provider credentials. The integration suite additionally carries a
signed event through the production HTTP gateway, a real local Temporal router Workflow, and the
Slack receipt Activity for both task-surface modes.

## Adding or changing a delivery profile

Start from `config/templates/default-delivery.json` or `compact-delivery.json`. The declaration
contains desired Project metadata, repository base branches, semantic fields and options, supported
saved views, explicit ticket defaults, a supported Workflow implementation/profile, internal-state
projection, entry and approval transitions, reviewers, named agent profiles, and custom skill
selectors.

Use `npm run thor -- project plan` before mutation. `project apply` creates missing resources and
performs supported additive updates one operation at a time, re-reading GitHub between operations.
`project validate` must compile an exact binding before a worker or synchronizer starts. Unknown
declaration/API versions and unsupported Workflow implementation IDs fail closed. A materially new
process graph requires deterministic TypeScript Workflow code and replay tests; configuration may
only parameterize a supported implementation.

Build output is generated under each workspace's `dist/` directory and is ignored by Git. Use
`npm run clean` to remove it. Tests must never require live Claude, Codex, GitHub, or Temporal Cloud
credentials.

## Live system validation

The opt-in `npm run test:live:e2e` suite is excluded from both standard test commands. Configure it
from `.env.live.example` and use only a private disposable repository and Project. The suite starts
a real local Temporal server, production Workflow/Activity wiring, and a spawned polling
synchronizer. It calls the real GitHub GraphQL and REST APIs while deterministic scripted harnesses
stand in for paid Claude and Codex calls. Fixture setup and cleanup use bounded exponential retries;
fixture Issues and Project membership use find-or-create reconciliation so an ambiguous response
cannot create duplicate artifacts.

Each scenario gets a unique run ID and a manifest under `.thor-live-runs/`. Successful fixtures are
cleaned by default. Failed fixtures are retained for diagnosis unless `THOR_LIVE_CLEANUP=always` is
set; cleanup is scoped to the exact IDs recorded by the run. A failure during setup is cleaned
best-effort unless cleanup is disabled, preventing one unstarted fixture from invalidating every
later scenario; its manifest retains the failure reason. After diagnosis, rerun exact cleanup with
`npm run test:live:cleanup -- .thor-live-runs/<run-id>.json`. The suite validates autonomous merge,
GitHub-driven blueprint and merge gates, repair/re-review and deferred issue materialization,
Blocked/Cancelled Activity cancellation, unexpected-status recovery, in-flight ticket edits,
dependency regression with replan and resume policies, unreadable-item recovery, Project-item
orphaning, and replacement-worker/worktree recovery. Every new intervention Workflow scenario should
include replay verification.

## Adding a harness resource or custom skill

Harness resources live under `resources/harnesses/<harness>/`; shared custom selectors live under
`resources/skills/custom/`. Every non-empty skill is hashed when selected. Prompts, `AGENTS.md`,
configuration, each skill, and the complete package receive SHA-256 audit digests.

Claude setting sources and Codex repository `AGENTS.md` discovery are disabled. Thor supplies the
audited harness instructions explicitly, preventing repository instructions from changing an
execution package after its digest is recorded. Runtime authentication remains external to the
package and must come from the worker's secret-managed environment.

When adding a selector, derive it from normalized ticket or phase context, give the selection a
clear audit reason, and test both matching and non-matching cases. Never place credentials in a
resource or configuration key.
