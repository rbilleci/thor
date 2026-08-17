# Thor Operations Guide

This guide covers service configuration, startup, human controls, recovery, and production
deployment. The lifecycle invariants remain defined by [design.md](design.md).

## Runtime services

Thor has two long-running processes:

- `@thor/worker` polls the configured Temporal Task Queue and executes Workflows and Activities.
- `@thor/synchronizer` verifies GitHub webhooks, polls for missed changes, and sends Temporal
  Signals. It contains no lifecycle policy.

The CLI is an on-demand Temporal client. The worker and synchronizer may be replicated; Temporal
coordinates execution, and GitHub mutations use conditional or find-or-create behavior.

## GitHub configuration

Create the Status options listed in the design and record their GraphQL node IDs in
`GITHUB_STATUS_OPTIONS_JSON`. Every Thor status is required so a missing mapping fails at startup
instead of halfway through a ticket.

Configure `GITHUB_DEFERRED_FIELDS_JSON` when deferred issues should inherit Project metadata. Each
single-select route contains a `fieldId` and an `options` map keyed by Thor's normalized value;
`component` is a text field. For example:

```json
{
  "type": { "fieldId": "PVTSSF_TYPE", "options": { "feature": "OPT_FEATURE", "bug": "OPT_BUG" } },
  "priority": { "fieldId": "PVTSSF_PRIORITY", "options": { "P1": "OPT_P1", "P2": "OPT_P2" } },
  "component": { "fieldId": "PVTF_COMPONENT" },
  "agentPolicy": { "fieldId": "PVTSSF_AGENT", "options": { "preferred": "OPT_PREFERRED" } },
  "planningDepth": { "fieldId": "PVTSSF_PLAN", "options": { "full": "OPT_FULL" } },
  "severity": { "fieldId": "PVTSSF_SEVERITY", "options": { "high": "OPT_HIGH" } }
}
```

Routes are optional; unmapped values are left unset rather than guessed.

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

Subscribe the App webhook to Projects v2 item changes. Use a high-entropy webhook secret of at least
16 characters. Put the App private key in a filesystem secret and configure its path; do not place
the private-key contents in `.env`.

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

In a built deployment use each workspace package's `start` command. Both processes emit structured
JSON lifecycle logs. Correlate operations with Project item ID, Workflow ID, pull-request number,
review-run ID, and execution ID. Prompt and skill contents are deliberately absent from logs and
Workflow results; audit records contain only versions and SHA-256 digests.

The synchronizer listens on `THOR_SYNCHRONIZER_HOST:THOR_SYNCHRONIZER_PORT`. Expose only the webhook
route through TLS in production. It rejects invalid signatures before parsing JSON and limits
request bodies to 1 MiB.

On startup the synchronizer performs a full Project reconciliation, then advances a high-water
timestamp only after every item in a poll batch has been dispatched. A failed batch is retried from
the prior cursor, so downtime and partial polling failures do not create a silent event gap.

## Normal human controls

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
execution policy cancels active work and moves the item to `Blocked` conditionally. After resolving
the conflict, move the item out of `Blocked`; Thor restores the suspended lifecycle state, and
ticket-context changes restart at `Design / Blueprint`.

Risk flags or failed tests dynamically add a pre-merge human gate even for an initially autonomous
ticket. Approval does not override failed tests: the deterministic merge gate still requires tests
to pass.

## Recovery and retries

- Retryable provider, network, GitHub, and Git failures use bounded Activity retries with backoff.
- Authentication, invalid structured output, policy conflicts, and invalid execution packages are
  terminal Activity errors.
- Agent Activities heartbeat every 30 seconds; the worker caps heartbeat throttling at 10 seconds so
  cancellation propagates promptly.
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
2. Test GitHub field mappings and App permissions in a non-production Project.
3. Test one Claude and one Codex execution using non-sensitive fixture tickets.
4. Verify repository credential helpers can fetch and push without prompts.
5. Exercise Blocked, Cancelled, both approval gates, retry, and worker-restart behavior.
6. Confirm branch protection permits only the intended merge Activity behavior.
7. Confirm logs and Temporal payloads contain no secrets or full prompt content.
8. Back up or retain Temporal according to the organization's recovery requirements.

The repository integration suite verifies local Temporal and Git behavior with fakes. It does not
claim that live GitHub, Claude, Codex, or Temporal Cloud configuration has been verified.
