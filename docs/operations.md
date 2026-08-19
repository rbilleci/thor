# Thor Operations Guide

This guide covers service configuration, startup, human controls, recovery, and production
deployment. The lifecycle invariants remain defined by [design.md](design.md).

## Runtime services

Thor has two required long-running processes and one process required when Slack collaboration is
enabled:

- `@thor/worker` polls the configured Temporal Task Queue and executes Workflows and Activities.
- `@thor/synchronizer` polls GitHub Project changes and sends Temporal Signals. It contains no
  lifecycle policy.
- `@thor/slack-gateway` verifies Slack signatures, durably submits commands to Temporal, and fans
  accepted controls out to active Agent Activities over an internal HTTP path.

The CLI is an on-demand Temporal client. The worker and synchronizer may be replicated; Temporal
coordinates execution, and GitHub mutations use conditional or find-or-create behavior.

## GitHub configuration

Set `THOR_PROJECT_DECLARATION` to a checked-in strict JSON `DeliveryProject` document. Two reference
profiles live under `config/templates/`: the detailed Thor lifecycle and a compact board with
renamed fields/options, fewer visible states, alternate reviewers, swapped Claude/Codex routing, and
a different base branch.

The declaration is the automation contract. GitHub remains authoritative for ticket values and human
decisions. Thor discovers the live Project, resolves semantic fields and options to GraphQL node
IDs, validates saved views and repository associations, and compiles an immutable runtime binding.
Required policy values fail closed; optional or intentionally absent fields use the declaration's
explicit defaults. Deferred issues inherit only fields present in that same binding, so there is no
second field-ID configuration.

Before starting services, run:

```bash
npm run thor -- project plan
npm run thor -- project apply
npm run thor -- project validate
```

`plan` is read-only. `apply` supports Project creation, metadata updates, missing fields, additive
select options, repository links, and the supported saved-view layout/filter/visible-field subset.
It preserves existing option IDs and extra unmanaged Project content. Field type changes, case-only
renames, removal or replacement of existing options, and existing option metadata changes are
conflicts requiring an explicit migration.

For a new Project, omit `github.projectNumber`; Thor finds or creates by exact unique title. After
GitHub assigns the number, `project adopt` emits a validated declaration with the number pinned.
Check that declaration into the protected configuration source. If a numbered Project does not
exist, Thor fails rather than creating a different Project accidentally. View grouping, sorting,
roadmap markers, and other settings not represented in the schema remain manual prerequisites and
are never reported as applied.

For local development, `GITHUB_TOKEN` is sufficient. Production should use a GitHub App. The current
combined worker needs:

- read/write access to the selected organization Project;
- issue read/write access for status context, comments, and deferred backlog issues;
- pull-request read/write access;
- repository contents read/write access for branches and merge;
- metadata read access.

Thor pins REST requests to GitHub API version `2026-03-10` rather than relying on GitHub's
deprecated unversioned default. Set `GITHUB_API_VERSION` explicitly when a GitHub Enterprise Server
deployment supports a different API version.

Webhook delivery is deferred and does not need to be configured. Put the App private key in a
filesystem secret and configure its path; do not place the private-key contents in `.env`.

Repository clones must exist at `THOR_SOURCE_ROOT/<owner>/<repository>`. Configure a credential
helper, SSH remote, or other non-interactive Git authentication for `origin`. Never embed tokens in
remote URLs because Git commands, process metadata, and error messages may expose them.

## Local Temporal

`compose.yaml` pins the official Temporal CLI development image and persists SQLite state in the
`temporal-data` volume:

```bash
npm run temporal:up
docker compose ps
npm run temporal:down
```

The gRPC endpoint is `localhost:7233`; the embedded UI is <http://localhost:8233>.
`docker compose down --volumes` intentionally deletes local Workflow history and should only be used
when that data is no longer needed.

## Temporal Cloud

Set:

```text
TEMPORAL_ADDRESS=<namespace>.<account>.tmprl.cloud:7233
TEMPORAL_NAMESPACE=<namespace>.<account>
TEMPORAL_TLS=true
TEMPORAL_API_KEY=<secret>
```

Store the API key in the deployment secret manager. Worker and synchronizer processes must use the
same namespace and Task Queue. Do not pass provider or Temporal credentials as Workflow arguments;
Workflow histories are durable and inspectable.

## Starting services

After validating `.env`, start:

```bash
npm run dev:worker
npm run dev:synchronizer
```

When the checked-in declaration enables Slack, also start:

```bash
npm run dev:slack-gateway
```

In a built deployment use each workspace package's `start` command. Both processes emit structured
JSON lifecycle logs. Each process validates the live Project and compiles the same declaration
before connecting delivery behavior to it; structural drift prevents startup. Correlate operations
with Project item ID, Workflow ID, pull-request number, review-run ID, and execution ID. Prompt and
skill contents are deliberately absent from logs and Workflow results; audit records contain only
versions and SHA-256 digests.

On startup and every later tick, the synchronizer performs a full Project reconciliation. This
avoids a missed-change window caused by GitHub's second-granular Project item timestamps. Workflows
ignore identical and stale snapshots, while material ticket or lifecycle changes remain
authoritative. Poll ticks do not overlap within a process; a failed scan is retried in full on the
next tick. Set `THOR_POLL_INTERVAL_MS` to at least 5000; the default is 30000. The synchronizer
exposes no inbound HTTP listener.

## Slack setup

Create one Slack app for Thor and enable the Events API plus interactivity. Configure these public
request URLs on the Slack app:

```text
https://<public-gateway>/slack/events
https://<public-gateway>/slack/interactions
```

Subscribe the bot to `app_mention`. Grant `app_mentions:read`, `chat:write`, `usergroups:read`, and
the conversation read/history scopes appropriate to the channels in use. Dedicated ticket channels
also need channel creation, management, invitation, and private-conversation read/history scopes.
Enable interactivity so the task header's Cancel button can call the configured interactions URL.
Invite the bot to the shared project and optional index channels. Slack organization policy can
restrict these capabilities, so verify them in a disposable private channel before production
rollout.

The worker and gateway share the bot identity and a control secret, but the secret itself is never
sent as a bearer credential. The worker derives a one-minute HMAC credential bound to its Workflow
and execution IDs for each internal request. Configure:

```text
SLACK_BOT_TOKEN=<secret>                   # worker and gateway
SLACK_BOT_USER_ID=U...                     # worker and gateway
SLACK_SIGNING_SECRET=<secret>              # gateway only
THOR_SLACK_CONTROL_TOKEN=<32+ byte secret> # worker and gateway
THOR_SLACK_GATEWAY_URL=http://slack-gateway:8080 # worker only; private network
THOR_SLACK_GATEWAY_PORT=8080               # gateway only
THOR_EXECUTION_ROOT=./.thor-executions     # worker checkpoint volume
```

Do not expose `/internal/control/*` publicly. The public reverse proxy should route only the two
signed `/slack/*` endpoints. In a replicated worker deployment, mount `THOR_EXECUTION_ROOT` on an
access-controlled persistent volume shared by workers that can take over the same Task Queue. This
directory contains Thor's short-lived execution checkpoints, never application business state. To
resume a provider session after worker replacement, its SDK-specific local session storage must also
survive on an access-controlled shared volume. If it does not, Thor detects the unavailable session
and starts a marked recovery session against the preserved worktree and execution package.

Configure `collaboration.slack` in the checked-in delivery declaration using one of the two examples
in [slack-agent-sessions.md](slack-agent-sessions.md). `thread_per_ticket` requires a stable project
channel ID. `channel_per_ticket` requires a deterministic prefix, privacy and membership policy, and
optionally a project index channel. Restart the worker and gateway after changing the declaration;
active ticket Workflows retain their pinned mode.

## Normal human controls

The state names below describe the detailed reference profile. Compact or team-specific declarations
can use different physical labels; the compiled semantic projection and approval transitions
preserve the same Workflow invariants.

GitHub status changes are authoritative:

| Current state               | Human transition   | Effect                                        |
| --------------------------- | ------------------ | --------------------------------------------- |
| Awaiting Blueprint Approval | Ready              | Approve blueprint                             |
| Awaiting Blueprint Approval | Design / Blueprint | Request blueprint changes                     |
| Awaiting Human Merge Review | Ready to Merge     | Approve merge                                 |
| Awaiting Human Merge Review | Repairing          | Request repair                                |
| Any active state            | Blocked            | Cancel active Activities and wait durably     |
| Any active state            | Cancelled          | Cancel active Activities and finish cancelled |

Approvals arriving before their gate is active are ignored. This prevents approval of a future
artifact. Reapply the intended GitHub transition after the gate becomes visible.

An unexpected status transition or an edit to ticket intent, acceptance criteria, dependencies, or
execution policy cancels active work and follows the declaration's `workflow.interventions` policy.
The detailed default moves the item to `Blocked` and replans. After resolving the conflict, move the
item to the board state projected for the suspended phase; Thor resumes only when that state matches
and all blocking dependencies are complete. The compact template demonstrates the alternative
dependency `resume` policy.

`workflow.dependencies.completion` declares whether blockers complete on Issue closure, semantic
Project `Done`, or both. The detailed default requires a managed dependency to be both closed and
Done, while an external dependency completes on Issue closure. `closeIssueAfterMerge` defaults to
true so downstream dependencies normally receive both completion signals. Thor projects the source
item to semantic Done before closing its Issue, avoiding a race with GitHub automation that removes
closed Issues from the Project.

Repeated unreadable-item polls block or cancel according to policy without stopping reconciliation
of other items. Project-item removal ends the default Workflow as internal `Orphaned`; no board
transition is attempted because the target item no longer exists. Running Workflow memo lets a
restarted synchronizer detect removal that happened during downtime and prevents a re-added issue
from starting concurrently with its prior Workflow.

Set `THOR_POLL_INTERVAL_MS` with the live Project size and the authenticating account's GitHub API
budget in mind; the default is 30 seconds and the enforced minimum is 5 seconds. Snapshot reads are
isolated and issued in batches of at most four. Dependency Project membership and lifecycle fields
are queried separately only when a real blocker and the declaration's completion rule require them,
avoiding the high GraphQL cost of a worst-case nested blocker query. GitHub primary, secondary, and
account-level rate-limit responses are retryable infrastructure failures, not authentication
failures. The scale suite in the live-test roadmap still owns measurement of a formal operating
envelope for large Projects.

Risk flags or failed tests dynamically add a pre-merge human gate even for an initially autonomous
ticket. Approval does not override failed tests: the deterministic merge gate still requires tests
to pass.

## Recovery and retries

- Project polling is a durable per-Project Temporal Workflow. Each scan is an Activity; recoverable
  failures retry indefinitely with exponential backoff from one second to a five-minute cap.
- Ticket GitHub Activities also continue across recoverable outages with a five-minute retry cap.
  Agent and workspace retries remain bounded where repeated execution can consume provider budget.
- GitHub's official Octokit retry and throttling plugins absorb a small number of immediate
  transport failures and apply GitHub primary/secondary-limit guidance. Temporal remains the
  authoritative durable retry scheduler.
- GitHub `Retry-After` and exhausted `X-RateLimit-Reset` timing is propagated to Temporal and capped
  at five minutes. Ordinary rate-budget headers do not turn authentication failures into retries.
- Worker and synchronizer configuration bootstrap, plus live-test setup and cleanup outside
  Temporal, use exponential jitter with a five-minute maximum delay.
- Authentication, invalid structured output, policy conflicts, and invalid execution packages are
  terminal Activity errors.
- Agent Activities emit a heartbeat at least every five seconds; their heartbeat timeout is 30
  seconds and the worker caps heartbeat throttling at 10 seconds so cancellation propagates
  promptly.
- A worker loss reschedules the Activity. A new worker can recreate the isolated worktree from the
  durable remote branch.
- GitHub transition conflicts pause the internal run instead of overwriting the human state.
- Branches, pull requests, summary comments, and deferred issues use stable identities or
  find-or-create behavior. Deferred issue lookup first inspects recent repository issues to avoid
  GitHub search-index delay.

Use `npm run thor -- status <project-item-id>` and the Temporal UI to inspect a stuck run. Correct
the external condition in GitHub, then signal through a new Project change. Do not terminate or
reset Workflow history merely to bypass a gate.

## Production rollout checklist

1. Run the full validation suite.
2. Run `project plan` and `project validate`, and review any live Project drift.
3. Test one Claude and one Codex execution using non-sensitive fixture tickets.
4. Verify repository credential helpers can fetch and push without prompts.
5. Exercise Blocked, Cancelled, both approval gates, retry, and worker-restart behavior.
6. Confirm branch protection permits only the intended merge Activity behavior.
7. Confirm logs and Temporal payloads contain no secrets or full prompt content.
8. Back up or retain Temporal according to the organization's recovery requirements.

The repository integration suite verifies local Temporal, Git, and the signed Slack-to-Temporal
control path with fakes. The separately gated `npm run test:live:e2e` suite verifies real GitHub
plus a real local Temporal server with scripted harnesses. It does not verify a real Slack
workspace, paid Claude/Codex calls, GitHub App authentication, or Temporal Cloud; qualify those
separately in disposable environments before production rollout.
