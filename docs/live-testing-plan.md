# Live System Validation Plan

## Purpose

This plan expands Thor's live validation in the order that provides the most value toward a working
system. It complements the deterministic unit, Workflow replay, and local Temporal integration
suites; it does not replace them.

The current baseline is:

- the standard format, typecheck, lint, unit/replay, and local integration suites pass;
- the real GitHub gateway has been exercised manually against a private repository and Project;
- status transitions, stale-state conflicts, idempotent comments, branches, pull requests, deferred
  issues, readiness checks, and repeated merge calls were verified;
- the opt-in `test:live:e2e` suite has passed its original five complete polling-synchronizer,
  Temporal, and GitHub scenarios against private disposable fixtures; two additional recovery and
  removal scenarios are implemented but still require a successful opted-in live run. A partial
  recovery on 2026-08-17 exposed and fixed a high-cost nested dependency query; the replacement
  ordinary snapshot query was measured against the live Project at one GraphQL point. After the
  account's 5,000-point bucket reset, a seven-scenario run used only 40 points but could not begin
  Workflow execution because GitHub still reported a major partial outage and its Projects GraphQL
  and repository REST endpoints returned HTTP 503/504;
- detailed and compact declarations now pass the local compiler, mapper, synchronizer, Workflow
  replay, and real-Activity/local-Git matrix, but the new Project control-plane mutations and
  compact profile have not been exercised against live GitHub;
- GitHub App authentication and paid Claude/Codex calls have not yet been exercised;
- webhook architecture and delivery are explicitly deferred.

## Safety and test conventions

Live suites must be explicit, isolated, and safe to rerun:

- Gate GitHub tests behind `THOR_LIVE_TESTS=1` and provider tests behind a separate opt-in.
- Never include live tests in `npm test` or `npm run test:integration`.
- Use a private disposable repository and Project, with a unique run identifier on every fixture.
- Record every created repository, Project, item, issue, branch, pull request, and comment in a run
  manifest so cleanup is deterministic.
- Clean successful runs by default. Retain failed fixtures and print their URLs for diagnosis.
- Make cleanup independently rerunnable and scope it to exact IDs from the manifest.
- Use scripted fake harnesses for control-plane tests. Spend Claude or Codex tokens only in the
  separately gated provider-contract suite.
- Store credentials only in the process environment or GitHub App configuration. Do not write them
  to manifests, logs, Workflow histories, prompts, or fixtures.

## Prioritized plan

### 1. Prove a complete delivery with real GitHub and real Temporal

Status: implemented; the original five scenarios passed live, while the two added intervention
scenarios await a rerun after the 2026-08-17 GitHub outage.

This is the highest-value test because it proves that the individually tested components form a
working system.

Build an opt-in `test:live:e2e` runner that provisions or selects private GitHub fixtures, starts a
real Temporal server, worker, and polling synchronizer, and uses deterministic scripted harness
adapters. Cover:

- autonomous progression from an eligible Project item through pull-request merge and `Done`;
- blueprint and merge approval gates driven by real Project field changes;
- review findings, repair, re-review, and accepted deferral materialization;
- a human moving an active ticket to `Blocked` or `Cancelled` during a long-running Activity;
- a human clearing `Blocked` and successfully resuming the suspended implementation;
- Project-item removal cancelling active work and ending the Workflow as `Orphaned`;
- worker restart and worktree recovery during an in-flight delivery.

Complete this item when each scenario is repeatable from one command, asserts both Temporal state
and GitHub state, and leaves a run manifest sufficient for cleanup and diagnosis.

### 2. Prove the Project declaration control plane against live GitHub

The checked-in declaration is now the only source for Project schema, workflow profile, agent
profiles, and runtime ID bindings. Exercise `project plan/apply/validate/adopt` against a disposable
owner. Start with an unnumbered declaration, create the Project, fields, options, repository links,
and saved views, adopt GitHub's assigned number, and prove the second apply is a no-op.

Then inject or simulate a failure between mutations and prove rerun convergence; add a field and
option; introduce type, case-only rename, and option-metadata conflicts; and verify extra unmanaged
fields, options, views, and item values are preserved. Record every created ID in the live manifest
and clean the Project exactly.

Complete this item when the detailed template passes the whole lifecycle and the compact template
passes at least create/apply/validate plus one delivery smoke test without hand-copied node IDs.

### 3. Prove polling synchronization and recovery

The system is not autonomous if Project changes cannot reliably reach their Workflow. Add a live
suite around the polling synchronizer. Cover:

- startup reconciliation discovers an existing eligible item and starts the correct deterministic
  Workflow ID;
- a Project edit after startup is found within the configured polling interval;
- blueprint and merge approval field changes produce the correct Workflow signals;
- overlapping poll ticks do not produce concurrent reconciliation batches;
- unchanged full-reconciliation snapshots do not cause unbounded Workflow history growth;
- a malformed or failed item does not prevent later valid items from being dispatched;
- process downtime and restart recover every change;
- any checkpoint or fingerprint optimization preserves same-second Project changes and remains safe
  after partial failure.

Complete this item when real Project edits are observed end to end through polling alone, including
a failed batch and process restart.

### 4. Prove idempotency across concurrency and crash windows

Temporal retries make this core correctness work, not merely stress testing. Exercise simultaneous
identical requests for comments, branches, pull requests, deferred issues, Project transitions, and
merges. Inject a worker failure after GitHub accepts a mutation but before the Activity completes,
then allow Temporal to retry it.

Complete this item when every logical mutation has exactly one durable outcome, or returns the same
existing outcome, without overwriting a conflicting human edit.

### 5. Codify and extend the real GitHub gateway smoke suite

Turn the successful manual gateway validation into `test:live:github`. Preserve its assertions for
Project mapping, status transitions, stale-state conflict detection, comment upsert, branch and
pull-request find-or-create behavior, deferred-issue materialization with inherited fields, merge
readiness, and repeated merge calls.

The runner should own fixture creation, run manifests, cleanup, and failure retention. This suite is
the fast live diagnostic below the full system test and should be usable without Temporal or a paid
agent provider.

Complete this item when the existing manual coverage is repeatable against a newly provisioned
fixture without editing source or configuration files.

### 6. Tolerate mixed and malformed Project content

Real Projects can contain issues, pull requests, draft items, archived items, deleted content, and
items missing required Thor fields. Verify that one unsupported item cannot fail reconciliation of
the entire Project.

Cover explicit skip or quarantine behavior for each content type, a useful diagnostic for malformed
Thor tickets, and continued processing of valid later items in the same poll.

Complete this item when mixed Project content has a documented policy and the synchronizer makes
forward progress without starting an invalid Workflow.

### 7. Exercise repository policy and merge edge cases

Run against realistic branch protection and repository settings. Cover pending and failed required
checks, stale head SHAs, merge conflicts, a human closing or merging the pull request, missing or
renamed labels, and a branch changed outside Thor.

Complete this item when each case resolves to a clear retry, conflict, blocked state, or successful
idempotent result rather than an ambiguous loop.

### 8. Prove production GitHub App authentication

Run the GitHub suites using an installed GitHub App rather than a personal token. Verify least
privilege, installation scoping, token renewal during a long run, and useful terminal errors when a
required permission is denied.

Complete this item when the documented permission set supports the full system test and removing any
required permission produces a safe, actionable failure.

### 9. Exercise live Claude and Codex provider contracts

Keep this small and separately gated because it costs money and is less deterministic. For each
harness, execute one minimal ticket package and verify SDK authentication, cancellation, session
handling, normalized structured results, invalid-output mapping, and recorded prompt, instruction,
skill, and provider-version digests.

Complete this item when both providers satisfy the same domain contract and provider-specific types
or secrets do not appear in Workflow payloads or logs.

### 10. Validate pagination, rate limits, and scale

Create more than 100 Project items and comments to cross GitHub page boundaries. Exercise large
dependency and association sets, GraphQL/REST rate limiting, retry backoff, and the time required
for a full startup reconciliation.

Complete this item when pagination has no omissions or duplicates, rate limits remain retryable, and
polling has an explicit operating envelope.

### 11. Decide and prove webhook synchronization

Webhook ingestion is intentionally the final roadmap item. First decide its deployment, buffering,
deduplication, retry, and secret-management architecture; do not assume a long-running HTTP server,
AWS Lambda, SQS, or another transport before that decision.

After selecting the architecture, reuse the polling synchronizer's authoritative Project re-read and
Temporal dispatch boundary. Cover:

- a genuine signed `projects_v2_item` delivery starts or signals the correct deterministic Workflow
  ID;
- invalid signatures, missing delivery IDs, malformed bodies, and oversized bodies are rejected;
- duplicate and delayed deliveries do not duplicate work;
- a webhook/poller race is safe if polling remains as a recovery mechanism;
- downtime, redelivery, and durable delivery-ID deduplication behave as designed.

Complete this item when the architecture is recorded in `docs/design.md` and live ingress is proven
without changing Workflow policy or GitHub authority boundaries.

## Recommended delivery sequence

The priority order above is value-based. Item 1 established the shared live-test runner, fixture
manifest, and cleanup library. Item 2 is now the highest-value unverified boundary because every
runtime service depends on its compiled result; item 5 can reuse the same fixtures. Items 3 and 4
then focus on synchronization recovery and mutation idempotency, the failure boundaries most likely
to corrupt or stall real work. Item 11 remains deferred until the polling system and the rest of the
live roadmap are complete.

## Synchronization architecture for the current roadmap

Polling is Thor's only active GitHub-to-Temporal synchronization path. The synchronizer queries the
configured GitHub Project, re-reads complete items through the GitHub gateway, and passes
authoritative snapshots to Temporal.

```text
Human changes GitHub Project item
                |
                v
Synchronizer's next polling cycle
  - reconcile the complete Project
  - re-read complete Project item state
                |
                v
Start or signal the deterministic Temporal Workflow
                |
                v
Workflow applies lifecycle, approval, conflict, and cancellation policy
```

The synchronizer derives one deterministic Workflow ID per Project item. It starts a missing
Workflow only when the item is in `Design / Blueprint` or `Ready`, policy permits agents, and all
dependencies are complete. Existing Workflows receive `projectChanged`; the Workflow itself maps
documented Project status changes to active approval-gate decisions. The Workflow, not the poller,
owns the resulting orchestration decision.

The Workflow cancels active execution scopes when a snapshot is `Blocked` or `Cancelled`, or when a
conflicting status or material ticket-context change arrives. The poller runs once at startup and
then waits durably for `THOR_POLL_INTERVAL_MS`. The cadence belongs to a per-Project Temporal
Workflow; a GitHub scan Activity retries recoverable outages with exponential backoff capped at five
minutes. It exposes no inbound HTTP listener and requires no webhook secret.

Polling loads the complete Project on every tick. This is safe against same-second timestamp gaps
and process downtime. Item reads are now isolated, retryable unreadable items are debounced,
non-retryable malformed items are surfaced immediately, and valid items later in the scan continue.
The poller detects removal from complete-scan membership and seeds prior IDs from running Workflow
memo after restart. Workflows suppress unchanged snapshots, including dependency-order-only
differences. Continue-as-New carries polling reconciliation state without unbounded Workflow
history. Local fault-injection now covers transient 503 recovery, terminal authentication, dispatch
isolation, capped exponential scheduling, and retry-safe live mutation bodies. Scale testing should
determine whether any additional durable checkpoint is needed.

The existing HMAC and webhook-payload helpers are retained as inactive building blocks. They do not
define the future deployment architecture and are not invoked by the synchronizer process.
