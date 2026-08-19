# Thor

Thor is an autonomous software-delivery orchestrator built on Temporal, GitHub Projects, and GitHub
repositories. It runs blueprinting, implementation, parallel review, synthesis, repair, approval,
deferral, and merge as one durable Workflow per GitHub Project item.

The canonical architecture and lifecycle rules are in [docs/design.md](docs/design.md). Development
conventions are in [docs/development.md](docs/development.md), and deployment and recovery
procedures are in [docs/operations.md](docs/operations.md).

## What is implemented

- Strict TypeScript on Node.js 22 and Temporal TypeScript SDK 1.22.
- Deterministic ticket Workflow with explicit retries, durable waits, cancellation, and configurable
  review fan-out (ten reviewers in the detailed default profile).
- Native Claude Agent SDK and Codex SDK adapters behind one provider-neutral interface.
- Slack task surfaces in shared-thread or dedicated-channel mode, with seconds-level normalized
  progress, signed ingress, authorized live steering, and durable Temporal fallback.
- A unique prompt, `AGENTS.md`, built-in phase skills, and execution configuration for Claude and
  Codex.
- Ticket- and blueprint-selected custom skills for security, data migration, API compatibility, and
  regression testing.
- Content-digest audit records for prompts, instructions, configuration, skills, and complete
  execution packages.
- Checked-in, versioned `DeliveryProject` declarations with strict validation, semantic field and
  option mappings, saved views, board projections, repository branches, reviewers, agent profiles,
  and skill selectors.
- Idempotent Project `plan`, `apply`, `validate`, and `adopt` operations plus startup compilation of
  live GitHub node IDs into one immutable runtime binding.
- Idempotent, durable GitHub blueprint artifacts and declaration-derived Project-field inheritance
  for deferred findings.
- GitHub Project reads and conditional transitions, idempotent branches, pull requests, comments,
  deferred issues, and merges.
- A durable Temporal polling synchronizer, production worker, operator CLI, local Temporal Compose
  service, fakes, replay tests, an isolated Git worktree integration test, and an opt-in live
  GitHub + Temporal system suite.

GitHub remains authoritative for planning and human-facing delivery state. Temporal remains
authoritative for execution, retries, timers, cancellation, and fan-out. All network, filesystem,
Git, GitHub, and agent SDK effects execute in Activities.

## Prerequisites

- Node.js 22 and npm.
- Git.
- Docker with Compose for the local Temporal server, or a Temporal Cloud namespace.
- A GitHub token or GitHub App with access to the configured Project and repositories.
- Claude and/or Codex authentication in the worker environment when running live agents.
- A Slack app and public HTTPS gateway endpoint when Slack collaboration is enabled.

## Quick start

Install the exact dependency graph and create local configuration:

```bash
npm ci
npm run build
cp .env.example .env
cp config/templates/default-delivery.json config/delivery-project.json
```

Customize `config/delivery-project.json` for the target owner, repository, Project, board, workflow,
and agent profiles. Set GitHub authentication in `.env`; Thor discovers node IDs from the live
Project. Preview and apply the declaration, then validate the exact runtime contract:

```bash
npm run thor -- project plan
npm run thor -- project apply
npm run thor -- project validate
```

To create a Project, omit `github.projectNumber` before `project apply`. Creation is selected by an
exact, unique title until GitHub assigns a number; use `project adopt` to emit a declaration with
that number pinned and check the adopted declaration back into Git. Existing extra fields, options,
views, and item values are preserved. Destructive field-type, rename, option-metadata, or removal
changes fail as explicit migration conflicts.

Place working repository clones at:

```text
repositories/<owner>/<repository>
```

Each clone must have an `origin` remote and non-interactive Git credentials that permit branch
pushes. Thor creates isolated worktrees under `.thor-worktrees/`.

Start local Temporal, then run the worker and synchronizer in separate terminals:

```bash
npm run temporal:up
npm run dev:worker
npm run dev:synchronizer
```

The Temporal UI is available at <http://localhost:8233>. Both services validate the declaration
against the live Project at startup. The synchronizer performs a complete Project item
reconciliation at startup and each `THOR_POLL_INTERVAL_MS`; it does not mutate Project structure.
Webhook ingress is deferred and the synchronizer exposes no HTTP endpoint.

Move an eligible Project item to `Design / Blueprint` or `Ready`. The synchronizer starts or signals
the deterministic Workflow ID `github-project-item:<project-item-node-id>`.

Stop local Temporal without deleting its SQLite volume:

```bash
npm run temporal:down
```

## Agent routing

The default phase routing is:

| Phase          | Harness |
| -------------- | ------- |
| Blueprint      | Claude  |
| Implementation | Codex   |
| Review         | Claude  |
| Synthesis      | Claude  |
| Repair         | Codex   |

This is the default declaration, not a hard-coded routing table. Each declaration maps logical phase
roles to named agent profiles, and each profile selects Claude or Codex plus its audited resource
profile and non-secret configuration. Harness-specific resources live under
`resources/harnesses/<harness>/`; custom ticket skills live under `resources/skills/custom/` and are
selected from ticket and blueprint context.

Read-only phases force read-only/plan permissions. Implementation and repair run in an isolated Git
worktree. Thor—not the model—owns commits, pushes, pull-request creation, deferred-issue creation,
and merge mutations.

## Human gates and control

Configured blueprint and pre-merge approvals are durable Temporal waits. Approval signals are
accepted only while the corresponding gate is active, so an unseen future artifact cannot be
pre-approved. In GitHub, move:

- `Awaiting Blueprint Approval` to `Ready` to approve, or back to `Design / Blueprint` to request
  changes;
- `Awaiting Human Merge Review` to `Ready to Merge` to approve, or `Repairing` to request changes;
- any active item to `Blocked` or `Cancelled` to stop current agent work.

Material ticket edits, dependency changes, unreadable items, unexpected status changes, and item
removal follow the checked-in `workflow.interventions` policy. The default replans material edits,
requires a blocked item to return to its suspended board phase before resuming, and records a
removed item as internal `Orphaned` without attempting to recreate it.

The CLI is useful for local operations and diagnostics:

```bash
npm run thor -- project plan
npm run thor -- project apply
npm run thor -- project validate
npm run thor -- project adopt
npm run thor -- start <project-item-id>
npm run thor -- status <project-item-id>
npm run thor -- approve-blueprint <project-item-id> <actor>
npm run thor -- request-blueprint-changes <project-item-id> <actor> "feedback"
npm run thor -- approve-merge <project-item-id> <actor>
npm run thor -- request-merge-changes <project-item-id> <actor> "feedback"
npm run thor -- cancel <project-item-id>
```

GitHub transitions are preferred for normal human decisions because GitHub is the business system of
record.

## Repository layout

```text
apps/worker          Temporal worker and concrete Activity wiring
apps/synchronizer    Worker for the per-Project polling Workflow and its Activities
apps/slack-gateway   Signed Slack ingress and stateless live-control fan-out
apps/cli             Operator commands
config/templates     Detailed and compact DeliveryProject declarations
packages/domain      Domain schemas and deterministic state machine
packages/config      Declaration schemas, compiler, bindings, and Project planner
packages/agent       Claude/Codex adapters and execution-package builder
packages/github      GitHub delivery/control-plane gateways, reserved webhook helpers, and fakes
packages/slack       Slack API, task surfaces, transcripts, controls, and fakes
packages/workflows   Temporal Workflow, Activities, and Git workspaces
packages/runtime     Validated runtime configuration and connections
resources/           Versioned prompts, AGENTS.md files, and skills
tests/integration    Real Temporal Activity + isolated Git integration
tests/live           Opt-in real GitHub + Temporal system validation
```

## Validation

```bash
npm run format:check
npm run typecheck
npm run lint
npm test
npm run test:integration
```

The standard automated suite does not require live Claude, Codex, GitHub, or Temporal Cloud
credentials. To run the separately gated system suite, copy `.env.live.example` to `.env.live`,
point it at a private disposable repository and Project, authenticate `gh`, and run:

```bash
npm run test:live:e2e
```

That command starts a real local Temporal server, the real polling synchronizer and worker, and uses
the real GitHub APIs with deterministic scripted Claude/Codex-shaped harnesses. It covers autonomous
delivery, both approval gates, repair/re-review with deferred work, cancellation, and replacement-
worker recovery. It also defines real Project scenarios for Blocked-to-resumed delivery and active
item removal/orphaning. Successful fixtures are cleaned by default; `.thor-live-runs/` retains
manifests for audit and exact cleanup. Rerun cleanup for a retained failure with
`npm run test:live:cleanup -- .thor-live-runs/<run-id>.json`. Paid provider SDK behavior remains a
separate future live suite.
