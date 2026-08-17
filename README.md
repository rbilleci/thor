# Thor

Thor is an autonomous software-delivery orchestrator built on Temporal, GitHub Projects, and GitHub
repositories. It runs blueprinting, implementation, parallel review, synthesis, repair, approval,
deferral, and merge as one durable Workflow per GitHub Project item.

The canonical architecture and lifecycle rules are in [docs/design.md](docs/design.md). Development
conventions are in [docs/development.md](docs/development.md), and deployment and recovery
procedures are in [docs/operations.md](docs/operations.md).

## What is implemented

- Strict TypeScript on Node.js 22 and Temporal TypeScript SDK 1.22.
- Deterministic ticket Workflow with explicit retries, durable waits, cancellation, and ten-way
  review fan-out.
- Native Claude Agent SDK and Codex SDK adapters behind one provider-neutral interface.
- A unique prompt, `AGENTS.md`, built-in phase skills, and execution configuration for Claude and
  Codex.
- Ticket- and blueprint-selected custom skills for security, data migration, API compatibility, and
  regression testing.
- Content-digest audit records for prompts, instructions, configuration, skills, and complete
  execution packages.
- Idempotent, durable GitHub blueprint artifacts and configurable Project-field inheritance for
  deferred findings.
- GitHub Project reads and conditional transitions, idempotent branches, pull requests, comments,
  deferred issues, and merges.
- A signed-webhook and polling synchronizer, production worker, operator CLI, local Temporal Compose
  service, fakes, replay tests, and an isolated Git worktree integration test.

GitHub remains authoritative for planning and human-facing delivery state. Temporal remains
authoritative for execution, retries, timers, cancellation, and fan-out. All network, filesystem,
Git, GitHub, and agent SDK effects execute in Activities.

## Prerequisites

- Node.js 22 and npm.
- Git.
- Docker with Compose for the local Temporal server, or a Temporal Cloud namespace.
- A GitHub token or GitHub App with access to the configured Project and repositories.
- Claude and/or Codex authentication in the worker environment when running live agents.

## Quick start

Install the exact dependency graph and create local configuration:

```bash
npm ci
npm run build
cp .env.example .env
```

Fill in the GitHub Project node ID, Status field ID, every Status option ID, webhook secret, and
authentication values in `.env`. Place working repository clones at:

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

The Temporal UI is available at <http://localhost:8233>. Configure the GitHub App webhook for
`projects_v2_item` deliveries at `POST /webhooks/github`; `GET /healthz` is the synchronizer health
endpoint. Polling remains enabled as a recovery path for missed webhook deliveries.

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

Routing is a Workflow input, and either harness can execute any phase. Harness-specific resources
live under `resources/harnesses/<harness>/`; custom ticket skills live under
`resources/skills/custom/`.

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

The CLI is useful for local operations and diagnostics:

```bash
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
apps/synchronizer    GitHub webhook/poll bridge
apps/cli             Operator commands
packages/domain      Domain schemas and deterministic state machine
packages/agent       Claude/Codex adapters and execution-package builder
packages/github      GitHub gateway, webhook validation, and fake
packages/workflows   Temporal Workflow, Activities, and Git workspaces
packages/runtime     Validated runtime configuration and connections
resources/           Versioned prompts, AGENTS.md files, and skills
tests/integration    Real Temporal Activity + isolated Git integration
```

## Validation

```bash
npm run format:check
npm run typecheck
npm run lint
npm test
npm run test:integration
```

The automated suite does not require live Claude, Codex, GitHub, or Temporal Cloud credentials. Live
provider and GitHub behavior must be verified in an authorized test Project before production
rollout.
