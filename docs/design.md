# Autonomous Software Delivery Orchestration Specification

## 1. Purpose

This specification defines an autonomous software-development orchestration system built around:

- **Temporal Open Source** for local development and testing.
- **Temporal Cloud** as the production orchestration service when deployed remotely.
- **GitHub repositories** as the source of truth for code, pull requests, commits, and software
  artifacts.
- **GitHub Projects** as the human-facing system of record for tickets, planning state,
  dependencies, prioritization, and workflow status.
- **AI agent workers** as the execution layer for planning, implementation, repair, review, and
  selected maintenance tasks.

The design assumes that most work proceeds autonomously, while selected tickets can require human
review at explicitly configured gates.

The architecture intentionally avoids a separate Git-based lease service. Temporal provides durable
workflow execution, task dispatch, retries, heartbeats, timers, cancellation, and worker
coordination. GitHub remains authoritative for business-facing project state.

---

## 2. Design Principles

### 2.1 Separate business state from execution state

GitHub Projects describes what the team believes should happen and the coarse lifecycle state of the
work. Temporal describes how automated execution is currently attempting to make it happen.

Examples of **GitHub Project state**:

- Design / Blueprint
- Ready
- In Progress
- In Review
- Repairing
- Ready to Merge
- Done

Examples of **Temporal execution state**:

- Workflow running
- Activity attempt 3
- Heartbeat received
- Retry scheduled
- Reviewer 7 completed
- Waiting for human approval
- Repair pass 2 in progress

Execution details should not be mirrored into GitHub unless they are genuinely useful to humans.

### 2.2 GitHub is authoritative for software-delivery state

GitHub repositories and Projects remain the canonical location for:

- ticket intent and description;
- planning metadata;
- dependencies and hierarchy;
- code and commits;
- pull requests and review artifacts;
- merge state;
- human interventions.

Temporal must react to GitHub changes rather than attempt to overwrite or outvote human actions
blindly.

Checked-in Thor declarations define the automation contract used to interpret and provision that
state: semantic field mappings, supported Workflow profiles, board projection, agent roles, and
versioned defaults. This does not make Git authoritative over live ticket values. A mismatch between
the declaration and Project structure is explicit configuration drift to validate and resolve; it is
not permission to overwrite human state blindly.

### 2.3 Temporal is authoritative for orchestration

Temporal owns:

- workflow identity;
- worker assignment through Task Queues;
- retries and backoff;
- activity heartbeats;
- durable timers;
- waiting for external events;
- cancellation;
- parallel review fan-out;
- repair and re-review loops;
- durable workflow history.

### 2.4 Prefer idempotent external effects

Activities that mutate GitHub must be designed for retry safety. A worker can perform an external
side effect and then fail before Temporal records successful completion. Therefore operations such
as creating pull requests, comments, branches, labels, or backlog issues should use stable
idempotency keys or find-or-create semantics.

### 2.5 Human intervention is an explicit policy path

Human approval is not the default lifecycle. Most tickets should run autonomously. Human gates are
introduced only when configured by policy or when the system escalates because a risk threshold or
uncertainty threshold is exceeded.

---

## 3. High-Level Architecture

```text
                         +----------------------+
                         |   GitHub Projects    |
                         | tickets / Kanban     |
                         +----------+-----------+
                                    |
                     polling through a GitHub Activity
                                    |
                                    v
                         +----------------------+
                         | Project Synchronizer |
                         | Temporal Workflow    |
                         +----------+-----------+
                                    |
                          Signals / Updates
                                    |
                                    v
+----------------+       +----------------------+       +----------------+
| GitHub Repos   |<----->|      Temporal        |<----->| Agent Workers  |
| code / PRs     |       | Workflow Orchestrator|       | model runtimes |
+----------------+       +----------+-----------+       +----------------+
                                    |
                         workflow/activity state
                                    |
                                    v
                         Temporal persistence
                 (local OSS backing store in development;
                    Temporal Cloud in production)
```

The Project Synchronizer is deliberately simple. One durable `ProjectSynchronizerWorkflow` per
managed Project owns the polling cadence through Workflow timers. Each complete GitHub scan and each
dispatch are Activities. The synchronizer process hosts those Activities and ensures the
deterministic synchronizer Workflow is running; it does not keep the cadence or reconciliation state
only in process memory. Observations become Temporal Signals or new ticket Workflows, while business
workflow logic remains in `TicketWorkflow`.

## 3.1 Implementation Runtime and Agent Harnesses

Thor is implemented in strict TypeScript on Node.js 22. Workflows, Activities, workers, the Project
Synchronizer, and operational tooling use the Temporal TypeScript SDK. The TypeScript SDK is
selected instead of the Temporal Rust SDK because it provides a mature production surface while
allowing both supported agent harnesses to run through their official SDKs in the same worker
process.

The required SDKs are:

- `@temporalio/client`, `@temporalio/worker`, `@temporalio/workflow`, and `@temporalio/activity` for
  orchestration;
- `@anthropic-ai/claude-agent-sdk` for Claude;
- `@openai/codex-sdk` for Codex.

Claude and Codex implement one provider-neutral agent harness interface. Provider SDK objects and
response types remain inside their adapters. Workflow payloads contain only Thor domain types.

All agent SDK calls execute inside Temporal Activities. No Workflow may import an agent SDK, access
the filesystem or network, read process environment, use wall-clock time, or perform another
non-deterministic effect.

## 3.2 Versioned Agent Execution Packages

Every harness has a separately versioned execution profile containing:

- a base prompt;
- an `AGENTS.md` instruction document;
- built-in skills for blueprinting, implementation, review, synthesis, and repair;
- non-secret harness configuration and permission policy.

Before an agent Activity starts, Thor assembles an immutable execution package from the harness
profile, ticket context, approved blueprint, execution purpose, and custom skills selected from
ticket metadata. Selectors may consider work type, component, risk flags, acceptance criteria,
affected areas, and review role.

The package records content digests and versions for the prompt, instructions, skills, and
non-secret configuration. These identifiers are returned with the Activity result and correlated
with the Workflow, review run, and repair pass. Credentials are provided only through worker
configuration and must never be included in Workflow payloads, execution packages, GitHub comments,
or logs.

## 3.3 Versioned Delivery Project Declarations

Every managed Project has a checked-in, schema-versioned `DeliveryProject` declaration. It may live
in Thor's repository or a dedicated protected control-plane configuration repository; it does not
need to live in every repository whose issues appear in the Project. The initial serialization is
strict JSON so configuration can be parsed with the Node.js standard library. A future YAML surface
must compile to the same domain schema and may not introduce different semantics.

The declaration contains:

- Project owner, identity, visibility, associated repositories, and repository base branches;
- semantic Project fields, their physical display names, allowed option labels, and whether an item
  must supply a value;
- supported saved-view names, layouts, filters, and visible semantic fields;
- explicit ticket defaults used only when a semantic field is intentionally absent from the
  declaration or declared optional;
- a versioned Workflow profile and implementation identifier;
- projection of internal Temporal lifecycle states onto semantic, human-facing board states;
- entry states, cancellation controls, and human approval-transition meanings;
- human-intervention policy for ticket edits, dependency changes, unexpected statuses, unreadable
  items, and Project-item removal;
- dependency-completion semantics and whether a successful merge closes the originating issue;
- the configured reviewer set;
- logical phase-to-agent-role assignments;
- named Claude/Codex agent profiles, resource profiles, and non-secret execution configuration;
- custom skill selectors based on purpose, reviewer, work type, component, risk, and ticket context.

Thor validates cross-references before contacting GitHub. It then discovers the live Project and
compiles the declaration into an immutable runtime binding containing Project, field, and option
node IDs plus declaration, agent-profile, and binding digests. GitHub display names and provider
types do not cross this binding into orchestration-domain decisions.

```text
checked-in DeliveryProject declaration
                |
                v
schema + semantic validation
                |
                v
plan / idempotent apply / live discovery
                |
                v
compiled runtime binding (IDs + versions + digests)
        |                   |                    |
        v                   v                    v
GitHub mapper       polling synchronizer     Workflow input
                                                 |
                                                 v
                                      agent execution packages
```

The Project README and lane descriptions are not configuration storage. Thor may publish an
informational declaration path, commit, and digest there for discoverability, but must load and
verify the reviewed Git declaration. Runtime bindings are generated deployment artifacts and contain
no credentials.

## 3.4 Configuration and Executable Workflow Boundaries

Configuration selects a supported deterministic Workflow implementation and supplies its validated
profile. It may vary board vocabulary and granularity, entry states, approval transition mappings,
reviewer sets, phase routing, agent profiles, and skill-selection rules. It must not inject
arbitrary executable Workflow code.

A materially new process graph requires checked-in deterministic TypeScript, replay tests, a new
implementation identifier, and an explicit migration strategy. A running Workflow pins the resolved
declaration and profile versions and digest in its start input. Later Git changes apply to new
Workflows by default; changing an active execution requires an explicit versioned migration or
Update policy.

---

## 4. GitHub Project Model

## 4.1 Recommended Status Columns

The primary board should use the following lifecycle states:

1. **Backlog**  
   Work has been captured but is not currently being analyzed or scheduled.

2. **Discovery**  
   Optional exploratory phase for unclear requirements, research, spikes, or problem clarification.

3. **Design / Blueprint**  
   A planning agent analyzes the repository, architecture, dependencies, acceptance criteria, risks,
   and implementation approach.

4. **Awaiting Blueprint Approval**  
   Used only when the ticket's approval policy requires human review before implementation.

5. **Ready**  
   The ticket is sufficiently specified and unblocked for implementation.

6. **In Progress**  
   Initial implementation is underway.

7. **Ready for Review**  
   Implementation has completed and is prepared for automated review.

8. **In Review**  
   The multi-reviewer review workflow is running or review findings are being synthesized.

9. **Repairing**  
   Review findings are being corrected.

10. **Re-review**  
    Corrected work is undergoing targeted or full review again.

11. **Awaiting Human Merge Review**  
    Used only when a configured human approval gate is required before merge.

12. **Ready to Merge**  
    All automated and required human gates are satisfied; merge can proceed.

13. **Done**  
    Work has been merged and required post-merge bookkeeping is complete.

14. **Blocked**  
    Work cannot progress because of an external dependency, unresolved requirement, policy
    condition, or environmental issue.

15. **Cancelled**  
    Work was intentionally terminated and should not continue.

This is the detailed default profile, not a required physical vocabulary. A Project may use renamed
or fewer visible states. Its declaration gives each option a stable semantic key and projects every
internal Temporal status onto that key. Multiple internal phases may intentionally share one visible
state; for example, `In Progress` and `Ready for Review` can both project to `Doing`. Human
approval, block, cancel, and entry transitions remain explicit even in a compact projection.

---

## 4.2 Recommended Project Fields

### Core planning fields

- **Work Type**: Feature, Bug, Task, Spike, Chore, Documentation. Thor also accepts `Type` on
  existing Projects, but new GitHub Projects reserve that field name.
- **Priority**: P0, P1, P2, P3.
- **Effort**: XS, S, M, L, XL.
- **Iteration**: native GitHub iteration field.
- **Target Date**: date field.
- **Component / Area**: e.g. API, UI, persistence, infrastructure, agent runtime.
- **Repository**: useful when one Project spans multiple repositories.
- **Human Owner**: optional planning responsibility; not the Temporal worker identity.

### Automation policy fields

- **Execution Mode**:
  - Human
  - Agent
  - Human + Agent
  - Disabled

- **Planning Depth**:
  - None
  - Light
  - Full
  - Architecture Review

- **Approval Policy**:
  - Autonomous
  - Blueprint Review
  - Pre-Merge Review
  - Blueprint + Pre-Merge Review

- **Approval State**:
  - Not Required
  - Pending
  - Approved
  - Changes Requested

- **Agent Policy**:
  - Disabled
  - Allowed
  - Preferred
  - Required

These fields allow the orchestrator to route work without embedding policy in issue text or labels.

Physical field and option names are presentation. Thor reads and writes them through compiled
node-ID bindings. A configured required field with no value is invalid ticket data; it must not
silently fall back to an autonomous or agent-enabled policy. When a field is intentionally omitted
or optional, the declaration supplies the explicit normalized default.

## 4.3 Project Provisioning and Drift

Operational tooling provides four idempotent boundaries:

```text
thor project plan      discover and classify create/update/conflict operations
thor project apply     apply approved additive or explicitly authorized changes
thor project validate  compile the live Project into a runtime binding or fail with exact drift
thor project adopt     validate an exact-title Project and emit a declaration with its number pinned
```

Creation requires an unnumbered declaration and uses exact-title find-or-create semantics. After
GitHub assigns a number, adoption emits a declaration with that stable number pinned. A numbered
declaration whose Project is absent is a conflict, not permission to create a replacement. Additive
reconciliation re-reads GitHub after each operation, and a second apply against the same declaration
is a no-op. Destructive changes such as field-type replacement, option removal, option metadata
changes, or an ambiguous rename require an explicit migration decision.

Thor manages the declared saved-view name, supported layout, filter, and ordered visible-field
subset. GitHub view settings not represented by the declaration, including grouping, sorting, and
roadmap markers, remain manual prerequisites. Thor never reports an unsupported setting as applied.

---

## 4.4 Saved Views

Recommended saved views include:

### Delivery Board

Grouped by Status. This is the default operational Kanban.

### Ready for Agents

Filters:

- Status = Ready
- Execution Mode = Agent or Human + Agent
- not blocked

### Human Work

Filters:

- Execution Mode = Human

### Review Queue

Filters:

- Status in Ready for Review, In Review, Repairing, Re-review, Awaiting Human Merge Review

### Blocked

Shows all currently blocked work and the dependencies responsible.

### Current Iteration

Grouped by component or human owner.

### Roadmap

Roadmap layout for larger features and target dates.

### Hierarchy

Table grouped by Parent Issue, showing sub-issue progress.

---

## 5. Work Hierarchy and Dependencies

## 5.1 Parent and sub-issue relationships

Use GitHub's native parent/sub-issue relationships for decomposition.

Example:

```text
Feature: Add organization-level audit export
├── Define export schema
├── Implement API endpoint
├── Implement background export worker
├── Add authorization checks
├── Add integration tests
└── Add user documentation
```

Parent/sub-issue relationships answer:

> What pieces constitute this larger unit of work?

They should not be used to represent ordering constraints.

## 5.2 Blocking dependencies

Use GitHub's native **blocked by / blocking** issue relationships for sequencing constraints.

Example:

```text
Issue B: Implement migration runner
    blocked by
Issue A: Define migration metadata format
```

The orchestration rule for a Ready candidate is:

```text
eligible_for_execution =
    status == Ready
    AND execution_policy_allows_agent
    AND all_blocking_dependencies_are_complete
```

Dependency completion is declared rather than inferred from display labels. The strict default is:

```text
dependency outside the managed Project
    = referenced Issue is closed

dependency inside the managed Project
    = referenced Issue is closed
      AND its bound lifecycle field is the semantic Done state
```

A profile may instead use Issue closure alone, or accept either Issue closure or semantic Project
Done for managed dependencies. Thor re-reads native `blocked by` relationships on every complete
poll, so reopening a dependency or moving a managed dependency out of Done is a material ticket
change even when the dependent Project item's own `updatedAt` did not move. By default Thor closes
the originating issue idempotently after a successful PR merge and after projecting delivery Done;
profiles that delegate issue closure elsewhere may disable that mutation explicitly. Projecting Done
first prevents issue-closure automation from removing the item before Thor records its final board
state.

Parent/child relationships and blocking dependencies are therefore separate concepts:

```text
Parent / sub-issue
    = decomposition

Blocked by / blocking
    = ordering constraint
```

---

## 6. Blueprint Phase

## 6.1 Purpose

The Blueprint phase exists so that expensive, high-reasoning models can perform repository-wide
analysis before cheaper implementation agents begin work.

The `Ready` state should mean that implementation can proceed with bounded ambiguity.

## 6.2 Blueprint artifact

The blueprint should be stored as a durable GitHub artifact associated with the ticket. Depending on
project conventions, this can be:

- a structured section in the issue;
- a linked Markdown document in the repository;
- a pull-request planning document;
- or another repository-tracked planning artifact.

Thor's default implementation upserts a structured blueprint comment with a stable idempotency
marker. Replanning updates that artifact in place and records the producing execution-package digest
without publishing prompt contents.

Recommended blueprint structure:

```text
1. Problem / objective
2. Constraints
3. Relevant existing architecture
4. Proposed design
5. Files and components likely affected
6. Interfaces, APIs, or schemas changed
7. Dependencies
8. Implementation plan
9. Testing plan
10. Migration / rollout plan
11. Risks
12. Unresolved questions
13. Acceptance criteria
```

## 6.3 Blueprint routing

Planning depth controls the amount of analysis:

```text
None
    obvious small changes; no dedicated blueprint agent execution; derive and persist a bounded
    plan deterministically from the ticket and acceptance criteria

Light
    concise implementation plan and affected-area analysis

Full
    repository-aware design, implementation plan, tests, risks, dependencies

Architecture Review
    full blueprint plus architectural critique and possibly human approval
```

## 6.4 Ready gate

A ticket may move to Ready when:

```text
blueprint_complete
AND acceptance_criteria_defined
AND dependencies_identified
AND no_unresolved_blocking_design_question
AND implementation_is_sufficiently_bounded
AND required_blueprint_approval_satisfied
```

---

## 7. Human Approval Policy

Most tickets should use `Approval Policy = Autonomous`.

Human review is introduced only where necessary.

## 7.1 Supported approval modes

### Autonomous

```text
Blueprint -> Ready -> Implement -> Automated Review -> Merge
```

No mandatory human gate.

### Blueprint Review

```text
Blueprint -> Awaiting Blueprint Approval -> Ready -> Implement -> Automated Review -> Merge
```

### Pre-Merge Review

```text
Blueprint -> Ready -> Implement -> Automated Review
          -> Awaiting Human Merge Review -> Merge
```

### Blueprint + Pre-Merge Review

Both gates are enforced.

## 7.2 Dynamic escalation

An autonomous workflow may escalate itself to human review if it encounters conditions such as:

- destructive data migrations;
- security-sensitive modifications;
- architectural deviation from the approved blueprint;
- ambiguous requirements;
- unexpected dependency changes;
- high-impact or high-risk changes;
- unresolved test failures requiring judgment;
- unexpectedly large change surface;
- policy violations;
- model confidence below an accepted threshold.

Temporal should wait durably for human approval rather than keeping a worker occupied.

---

## 8. Temporal Workflow Identity and Coordination

## 8.1 One logical workflow per GitHub Project item

Use a deterministic Workflow ID derived from the stable GitHub identifier, for example:

```text
github-project-item:<graphql-node-id>
```

A human-readable repository and issue number may be stored as workflow metadata but should not be
the sole durable identifier because names can change.

The pinned ticket context also records the stable GitHub Issue node ID. Workflow identity remains
the Project item node ID, but the synchronizer records Project, Project-item, and Issue IDs in
Temporal memo. Before starting a Workflow for a re-added Project item, it checks running managed
Workflows for the same Issue ID. This prevents concurrent automation when a human removes and
immediately re-adds the same issue.

The Workflow start input also contains the validated runtime delivery profile: declaration name,
version and digest; Workflow implementation/profile; board projection; configured reviewers; and the
resolved logical agent profiles. This snapshot is immutable replay input. Deployment-specific GitHub
node IDs remain in Activities and are not needed for deterministic orchestration.

## 8.2 No separate lease engine

Temporal Task Queues provide worker assignment. For long-running Activities:

- worker execution is represented by the Activity attempt;
- Activity Heartbeats represent liveness/progress;
- heartbeat timeout represents worker loss or stalled execution;
- retry policies provide takeover/re-execution;
- Workflow state provides durable orchestration ownership.

The previous Git-lease concepts map approximately as follows:

```text
Git lease acquisition    -> Activity Task dispatch
lease owner              -> worker executing Activity attempt
lease renewal            -> Activity heartbeat
lease timeout            -> heartbeat timeout
abandoned lease          -> timed-out Activity attempt
takeover                 -> Activity retry
retry count              -> Activity attempt / Retry Policy
job identity             -> Workflow ID
```

A separate lease is only required for a scarce external resource that can also be manipulated
outside Temporal.

---

## 9. GitHub Change Synchronization

## 9.1 Project Synchronizer

A small long-running synchronizer process ensures one deterministic `ProjectSynchronizerWorkflow` is
running per managed Project. That Workflow owns the polling cadence with durable timers and invokes
one GitHub scan Activity per cycle. On its first run and on every polling cycle it reconciles the
complete Project. GitHub Project item `updatedAt` values are only second-granular, so a strict
timestamp cursor could miss a human change made in the same second as Thor's preceding transition.
Workflows deterministically ignore stale or identical snapshots. A Workflow awaits each scan before
scheduling the next cycle, so polls cannot overlap even across synchronizer process restarts.

Webhook ingestion is deliberately deferred until the end of the delivery roadmap. Its deployment
model and buffering architecture will be decided separately. A future webhook adapter may reuse the
same Project-state re-read and Temporal dispatch boundary, but webhook ingress is not an initial
runtime requirement.

Its responsibility is limited to:

1. detect a relevant GitHub change;
2. identify the corresponding Temporal Workflow;
3. send a Signal or Update containing the changed state;
4. let the Workflow decide what to do.

Each complete scan produces explicit per-item observations:

```text
present(snapshot)       item was read and validated
unreadable(id, reason)  item exists but could not be mapped safely
removed(id, reason)     item disappeared or was deleted during the scan
```

Item reads are isolated so one deleted, draft, malformed, or temporarily unavailable item cannot
discard valid snapshots later in the same scan. Retryable unreadable observations are debounced for
the configured number of consecutive polls; non-retryable mapping failures are surfaced immediately.
A normal item snapshot does not nest every blocker Project and field connection into one GraphQL
query. Thor pages blocker identities first and reads Project membership and lifecycle state only for
an actual blocker whose configured completion rule can be affected by Project state. Full-scan item
reads use bounded concurrency to reduce secondary-rate-limit bursts; explicit primary or
account-level rate-limit responses remain retryable. Recoverable scan failures use Temporal's native
Activity Retry Policy with exponential delays starting at one second and capped at five minutes;
polling continues until recovery. Authentication and invalid-response failures are terminal.
GitHub-provided retry timing is capped at five minutes and passed to Temporal as the next Activity
retry delay. Operators must still choose a polling interval that fits the Project size and the
installation or user account's GitHub API budget. A successful read clears the unreadable condition.
The Workflow remembers the IDs from the prior complete scan to detect removal and carries that state
through Continue-as-New. Its initial inventory Activity seeds the set from running managed Workflow
memo, so an item removed during process downtime is still observed. A failed signal dispatch
restores tracker state so unreadable and removed observations are retried on a later complete scan.

Octokit uses its maintained retry and throttling plugins for a small number of immediate transport
retries and GitHub's primary and secondary rate-limit rules. This request-local behavior does not
replace Temporal retries. Process bootstrap and live-test fixture operations, which execute outside
Temporal, use a maintained promise retry library with exponential jitter and the same five-minute
maximum delay.

The synchronizer should not contain orchestration policy.

## 9.2 Human changes during agent execution

Humans retain authority to modify tickets while agents are working.

Example:

```text
Agent is implementing ticket X
Human moves ticket X to Blocked
Synchronizer observes change
Synchronizer signals Temporal workflow
Workflow decides whether to pause, cancel, or redirect execution
```

The system must not blindly overwrite human changes.

`Blocked` and `Cancelled` immediately cancel active agent Activities. An unexpected human status
transition is treated as a conflict: the Workflow preserves its suspended lifecycle state,
conditionally surfaces `Blocked`, and waits for a later synchronization cycle. A change to ticket
intent, acceptance criteria, dependencies, or execution policy also blocks current work and requires
a new blueprint before resuming. Only the documented approval transitions are interpreted as gate
decisions.

These defaults are pinned in the Workflow profile. A Project may instead cancel automation for a
material ticket edit or unexpected status. Dependency changes may replan, resume the interrupted
phase after the dependency block is cleared, or cancel. Unreadable items may block after a
configured consecutive-poll threshold or cancel. Removal defaults to the internal terminal
`Orphaned` outcome because no Project item remains to update; a profile may classify it as
`Cancelled` instead. None of these settings permits silent continuation through an unacknowledged
intervention.

Blocked work resumes only when dependencies are complete and the human-visible Project state matches
the suspended phase's configured board projection. Moving a blocked item to an unrelated state does
not implicitly resume it. Ticket comparisons use a canonical execution-intent form, including
dependency sorting, rather than raw object serialization.

## 9.3 Agent-initiated Project transitions

Agents may propose status transitions such as:

- In Progress -> Ready for Review
- In Review -> Repairing
- Ready to Merge -> Done
- In Progress -> Blocked

Before performing material GitHub mutations, the Activity should re-read current GitHub state and
apply an idempotent or conditional update. If human changes conflict materially, control returns to
the Workflow for policy resolution. Changes to unrelated Project metadata do not invalidate a status
transition when the lifecycle status and normalized ticket context are unchanged. A transition is
also successful when a confirming re-read shows that the target was already reached. If the
confirming read instead observes a valid human gate decision, the Workflow consumes that newer
authoritative snapshot. Delayed poll echoes of Thor's own visible gate status are compatible with
the corresponding internal wait state.

---

## 10. Implementation Lifecycle

A typical autonomous implementation proceeds as follows:

```text
Backlog
  -> Design / Blueprint
  -> Ready
  -> In Progress
  -> Ready for Review
  -> In Review
  -> Repairing (if required)
  -> Re-review (if required)
  -> Ready to Merge
  -> Done
```

If blueprint or merge approval is required, the corresponding human gate is inserted.

## 10.1 Implementation activity

The implementation worker receives:

- ticket context;
- approved blueprint;
- repository information;
- dependency state;
- acceptance criteria;
- execution policy;
- relevant prior review findings if this is a repair pass.

The worker should:

1. create or reuse a working branch;
2. inspect current repository state;
3. implement the requested change;
4. run relevant tests and checks;
5. create or update a pull request using idempotent semantics;
6. report structured completion data to Temporal.

Long-running implementation Activities should heartbeat periodically.

---

## 11. Automated Review Architecture

## 11.1 Review fan-out

After implementation, a dedicated Review Orchestrator launches the Workflow profile's configured
focused reviewers in parallel. The default profile launches ten.

A suggested default reviewer set is:

1. **Correctness reviewer** — logic errors, edge cases, specification compliance.
2. **Architecture reviewer** — layering, coupling, boundaries, design consistency.
3. **Security reviewer** — authentication, authorization, injection, secrets, unsafe behavior.
4. **Performance reviewer** — complexity, contention, memory, latency, scalability.
5. **Testing reviewer** — coverage, test quality, missing scenarios, brittleness.
6. **API / compatibility reviewer** — API contracts, backwards compatibility, versioning.
7. **Data / migration reviewer** — schemas, migrations, consistency, rollback implications.
8. **Observability / operability reviewer** — logs, metrics, diagnostics, supportability.
9. **Maintainability reviewer** — readability, duplication, modularity, technical debt.
10. **Product / specification reviewer** — acceptance criteria, user-visible behavior, blueprint
    compliance.

The set is versioned configuration and can be changed per Project profile. Ticket-type-specific
selection may be added as a validated profile rule; it must be resolved before the review fan-out is
recorded in Workflow history.

## 11.2 Structured review findings

Each reviewer returns structured findings rather than only prose.

Recommended schema:

```text
finding_id
review_run_id
reviewer_type
severity
category
summary
evidence
affected_files
recommended_fix
blocking
deferrable
confidence
```

## 11.3 Finding classification

The synthesis stage normalizes and deduplicates findings into:

### BLOCKING

Must be resolved before merge.

### NON_BLOCKING_FIX_NOW

Should be corrected in the current change although it does not independently block merge.

### DEFER_CANDIDATE

A valid issue that may be intentionally deferred if the current work is ultimately accepted for
merge.

No deferred GitHub issue is created at this point.

---

## 12. Review Synthesis

A dedicated synthesis step consumes all ten review results and performs:

- duplicate detection;
- conflict resolution between reviewers;
- severity normalization;
- grouping by root cause;
- identification of repair work;
- identification of provisional deferrals;
- decision about whether full or targeted re-review will be required.

Reviewers discover. The synthesizer arbitrates. Repair workers act.

This separation prevents ten reviewers from independently creating tickets or mutating the pull
request in inconsistent ways.

---

## 13. Repair Lifecycle

## 13.1 Kanban state during repair

Ordinary review remediation should not return the ticket to normal `In Progress`.

Use:

```text
In Review
   -> Repairing
   -> Re-review
```

This preserves the distinction between initial implementation and remediation of known findings.

## 13.2 Exceptional rollback states

Use these rules:

```text
ordinary review findings
    -> Repairing / Re-review

major implementation failure
    -> In Progress

architectural or requirements failure
    -> Design / Blueprint
```

The synthesis stage should classify whether the work remains a repair or requires a broader
lifecycle rollback.

## 13.3 Repair input

The repair worker receives:

- the current implementation;
- approved blueprint;
- normalized review findings;
- exact blocking and fix-now items;
- relevant reviewer evidence;
- previous repair attempts.

The repair worker should not independently reinterpret unrelated reviewer findings unless needed to
make the repairs coherent.

---

## 14. Re-Review Strategy

After repair, rerunning all ten reviewers is not always necessary.

The default strategy should be **impact-based re-review**:

1. rerun every reviewer whose finding was repaired;
2. always rerun correctness and testing reviewers;
3. rerun architecture, security, data, API, or performance reviewers when the repair touched their
   concern area;
4. rerun the full review set if the repair caused substantial change or architectural movement.

This controls model cost while preserving assurance.

Each review pass receives a stable `review_run_id`.

Example:

```text
review-run: issue-381-pass-03
```

All findings, repair commits, and eventual deferred issues reference the originating review run.

### 14.1 Convergence and escalation

The repair loop must be bounded by policy even though Temporal can execute it indefinitely.
Recommended controls are:

- track `repair_pass_number`;
- track whether blocking-finding count and severity are decreasing;
- detect recurrence of substantially identical findings;
- detect repairs that repeatedly introduce new blocking findings;
- impose a configurable autonomous repair-pass budget;
- escalate to a stronger model, Blueprint, or human review when convergence fails.

A representative policy is:

```text
if blocking_findings == 0:
    continue toward merge
else if repair_pass_number < autonomous_repair_budget
     and review_is_converging:
    repair again
else:
    escalate
```

Escalation does not imply failure of the ticket. Depending on cause, the workflow may move to
`In Progress`, `Design / Blueprint`, `Blocked`, or a durable human-review wait.

---

## 15. Deferred Findings and Backlog Creation

Deferred findings are intentionally **not** converted into GitHub issues during initial review.

They remain provisional because the implementation may still be rejected, redesigned, or abandoned.

## 15.1 Deferred finding lifecycle

Recommended internal states:

```text
OPEN
FIX_NOW
REPAIRED
DEFER_PROPOSED
DEFER_APPROVED
DEFER_MATERIALIZED
REJECTED
```

## 15.2 Materialization rule

Deferred backlog items are created only when the work is proceeding toward merge.

The merge gate performs:

```text
1. Confirm all blocking findings are resolved.
2. Confirm required automated review has passed.
3. Confirm required human approvals are satisfied.
4. Determine the final set of approved deferrals.
5. Deduplicate deferrals against one another and against the existing backlog.
6. Create GitHub issues for approved deferrals.
7. Verify each required deferred issue exists durably.
8. Record created issue IDs in the review result.
9. Proceed with merge.
10. Mark the original ticket Done after merge bookkeeping completes.
```

The key invariant is:

> The system never knowingly merges unresolved review findings unless every accepted deferral has
> been durably represented in the backlog.

## 15.3 Deferred issue content

Each generated deferred issue should contain:

- originating ticket;
- originating pull request;
- review run ID;
- reviewer type(s);
- original finding IDs;
- reason for deferral;
- affected files/components;
- recommended remediation;
- priority/severity;
- relevant commit SHA or PR state;
- acceptance criteria where possible.

It should also receive the appropriate Project fields such as Type, Priority, Component, Agent
Policy, and Planning Depth.

---

## 16. Merge Gate

Merge eligibility should be deterministic and policy-driven.

A representative rule is:

```text
merge_allowed =
    no_unresolved_blocking_findings
    AND all_required_tests_pass
    AND required_reviewers_pass
    AND required_human_approvals_satisfied
    AND all_approved_deferrals_materialized
    AND github_state_is_compatible_with_merge
```

If the ticket is autonomous, Temporal may perform the merge once the gate evaluates true.

If human pre-merge approval is required, Temporal enters a durable waiting state until GitHub
signals approval or change requests.

---

## 17. Failure Handling and Resilience

## 17.1 Activity retries

Activities should define explicit retry policies, including:

- initial retry interval;
- exponential backoff coefficient;
- maximum interval;
- maximum attempts where appropriate;
- non-retryable error classes.

Polling scan Activities continue retrying recoverable infrastructure failures because a GitHub
outage must not permanently stop Project discovery. Ticket GitHub Activities use the same durable
recovery rule. Agent execution remains bounded where repeating an invocation can consume provider
budget or reproduce non-idempotent work.

## 17.2 Heartbeats

Long-running Activities such as implementation, complex review, or repository analysis should
heartbeat.

Heartbeat payloads may contain lightweight progress information such as:

- current phase;
- repository operation in progress;
- test suite stage;
- last completed unit of work.

Heartbeats are not a substitute for durable business state in GitHub.

## 17.3 Cancellation

A human Project change may trigger cancellation or redirection. Activities should periodically
observe Temporal cancellation and terminate safely.

## 17.4 Idempotency

Every external mutation should be retry-safe.

Examples:

```text
create PR
    -> find existing PR for workflow/ticket before creating

create deferred issue
    -> use stable origin key in title/body/metadata and find before create

post review summary
    -> update existing review comment identified by stable marker

move Project state
    -> read current state before applying transition
```

---

## 18. GitHub Attachments and Artifacts

GitHub issue and pull-request conversations support direct file attachments. At the time this
specification was reviewed, GitHub documents the following per-file limits for conversation
attachments:

- **images and GIFs:** 10 MB;
- **videos:** 10 MB for repositories owned by users or organizations on a free GitHub plan, or 100
  MB on a paid GitHub plan;
- **other supported files:** 25 MB.

GitHub issues can therefore carry small human-oriented artifacts such as:

- screenshots;
- logs;
- PDFs;
- diagnostic archives;
- small text or data files.

For files committed to repositories, GitHub warns above 50 MiB and enforces a 100 MiB per-object
limit for normal Git operations; larger files should use Git LFS. Browser-based repository uploads
are limited to 25 MiB per file. These service limits are external constraints and should be
rechecked if attachment handling becomes part of an automated contract.

Large generated artifacts, datasets, binaries, and build outputs should not be treated as ticket
attachments. Prefer:

- repository commits for source-sized text artifacts;
- GitHub Releases;
- CI artifacts;
- Git LFS;
- external object storage.

Blueprints and review outputs should preferably remain text-native and repository- or issue-linked
for auditability and machine consumption.

---

## 19. Recommended Temporal Workflow Decomposition

A practical decomposition is:

```text
TicketWorkflow
│
├── Blueprint phase
│   └── BlueprintActivity / BlueprintChildWorkflow
│
├── optional blueprint approval wait
│
├── Implementation phase
│   └── ImplementationActivity
│
├── ReviewOrchestrator
│   ├── Reviewer 1
│   ├── Reviewer 2
│   ├── ...
│   └── Reviewer 10
│
├── Synthesis
│
├── Repair loop
│   ├── RepairActivity
│   └── targeted/full ReReview
│
├── optional human merge approval wait
│
├── DeferredIssueMaterialization
│
├── MergeActivity
│
└── Completion bookkeeping
```

Review may be implemented as parallel Activities or Child Workflows. Child Workflows are preferable
when individual reviewer execution requires its own durable lifecycle, retries, signals, or
substantial state.

---

## 20. Recommended State Machine

```text
BACKLOG
  |
  v
DISCOVERY (optional)
  |
  v
DESIGN_BLUEPRINT
  |
  +---- approval required ----> AWAITING_BLUEPRINT_APPROVAL
  |                                   |
  +-----------------------------------+
  |
  v
READY
  |
  v
IN_PROGRESS
  |
  v
READY_FOR_REVIEW
  |
  v
IN_REVIEW
  |
  +---- findings requiring repair ----> REPAIRING
  |                                        |
  |                                        v
  |                                    RE_REVIEW
  |                                        |
  +<---------------------------------------+
  |
  +---- major implementation failure ----> IN_PROGRESS
  |
  +---- architecture failure ------------> DESIGN_BLUEPRINT
  |
  v
AUTOMATED_REVIEW_PASSED
  |
  +---- human merge review required ----> AWAITING_HUMAN_MERGE_REVIEW
  |                                              |
  +----------------------------------------------+
  |
  v
MATERIALIZE_APPROVED_DEFERRALS
  |
  v
READY_TO_MERGE
  |
  v
MERGING
  |
  v
DONE
```

`BLOCKED` and `CANCELLED` are side states reachable from appropriate points in the lifecycle.
`ORPHANED` is an internal terminal outcome used when the Project item no longer exists and therefore
has no human-facing board projection.

---

## 21. Observability and Auditability

The system should provide traceability across GitHub and Temporal.

Recommended correlation identifiers:

- GitHub Project Item Node ID;
- repository and issue number;
- Temporal Workflow ID;
- pull request number;
- review run ID;
- finding IDs;
- repair pass number;
- deferred issue IDs.

A human inspecting a GitHub ticket should be able to identify the associated Temporal Workflow. A
Temporal operator should be able to identify the corresponding GitHub issue and pull request.

Detailed Activity retries and heartbeats remain in Temporal. Human-relevant summaries belong in
GitHub.

---

## 22. Local Development and Production

### Local development / testing

Use Temporal Open Source locally with the standard Temporal UI and an appropriate local persistence
configuration.

The local environment should support:

- workflow development;
- Activity execution;
- retries;
- heartbeat testing;
- cancellation testing;
- reviewer fan-out;
- GitHub API integration against test repositories/Projects;
- simulated human approval events.

### Production

When using Temporal Cloud:

- Temporal Cloud becomes the durable orchestration service;
- workers may run independently and poll Task Queues;
- no Git-based lease service is required for ordinary ticket ownership;
- GitHub remains authoritative for Project and repository state;
- the same Workflow IDs and lifecycle semantics should be used as in local development.

---

## 23. Security and Permissions

Use least-privilege credentials for automated workers.

Separate permissions where practical between:

- Project read/write;
- issue creation and mutation;
- pull-request creation and merge;
- repository content write;
- administrative operations.

A reviewer generally should not need merge authority. A blueprint worker generally should not need
repository write authority. The merge Activity should use a narrowly scoped credential appropriate
to repository policy.

Human review policy should not be bypassable by ordinary worker credentials.

An approval decision is valid only while its corresponding Workflow gate is active. A decision
received before the blueprint or automated-review artifact exists must be ignored rather than queued
as approval for a future artifact.

---

## 24. Policy Defaults

Recommended default policy for ordinary tickets:

```text
Execution Mode: Agent
Planning Depth: Full
Approval Policy: Autonomous
Agent Policy: Preferred
```

Recommended autonomous lifecycle:

```text
Blueprint
-> Implementation
-> 10-way focused review
-> Synthesis
-> Repair / targeted re-review as needed
-> materialize approved deferred findings
-> Merge
-> Done
```

Human involvement occurs only when:

- explicitly requested by Approval Policy;
- the workflow escalates based on risk or uncertainty;
- a human changes GitHub state in a way that alters execution policy;
- an unrecoverable or policy-relevant failure occurs.

---

## 25. Key Invariants

The implementation should preserve the following invariants:

1. **One orchestration authority per ticket.**  
   A deterministic Temporal Workflow ID represents the logical execution lifecycle of a GitHub
   Project item.

2. **GitHub remains authoritative for business state.**  
   Human changes are treated as external events, not corruption.

3. **Temporal remains authoritative for execution state.**  
   Retries, attempts, heartbeats, waiting, cancellation, and parallel execution are not implemented
   through GitHub fields.

4. **External effects are idempotent.**  
   Activity retries must not duplicate pull requests, backlog issues, comments, or other externally
   visible effects.

5. **Ready means executable.**  
   A ticket does not enter Ready until its configured planning requirements are satisfied.

6. **Review is multi-perspective and structured.**  
   The profile's configured focused reviewers produce structured findings that are synthesized
   centrally; the default profile uses ten.

7. **Repair remains part of review.**  
   Ordinary review remediation uses Repairing/Re-review instead of resetting the ticket to initial
   In Progress.

8. **Deferrals are provisional until merge is accepted.**  
   Review-time deferral candidates do not create backlog clutter prematurely.

9. **Known unresolved work is never silently merged.**  
   Every accepted deferral is materialized as a durable GitHub backlog item before merge.

10. **Human gates are explicit and durable.**  
    Temporal waits for human decisions without occupying workers or relying on transient process
    state.

11. **Human interventions fail safe and recover explicitly.** Material edits, dependency
    regressions, unreadable items, removals, and unexpected lifecycle changes cancel active
    execution and follow the pinned intervention policy; unrelated Project items continue
    reconciling.

---

## 26. External Platform Assumptions and References

This design intentionally depends on public GitHub and Temporal capabilities rather than private
implementation details. The following platform assumptions were verified when this specification was
reviewed on 2026-08-16:

- GitHub issues support native blocking dependencies (`blocked by` / `blocking`).
- GitHub supports native sub-issue hierarchies and Project fields for parent issue and sub-issue
  progress.
- GitHub issue and pull-request conversations support file attachments with the limits described in
  Section 18.
- Temporal supports Activity Retry Policies, Heartbeats, Workflow Signals/Updates, Task Queues, and
  Child Workflows.

Reference documentation:

- GitHub issue dependencies:
  <https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies>
- GitHub sub-issues:
  <https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/browsing-sub-issues>
- GitHub Project parent/sub-issue progress fields:
  <https://docs.github.com/en/issues/planning-and-tracking-with-projects/understanding-fields/about-parent-issue-and-sub-issue-progress-fields>
- GitHub file attachments:
  <https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files>
- GitHub large files:
  <https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github>
- Temporal Activity operations and heartbeats: <https://docs.temporal.io/activity-operations>
- Temporal Child Workflows: <https://docs.temporal.io/child-workflows>
- Temporal terminology and Retry Policies: <https://docs.temporal.io/glossary>
- Temporal TypeScript SDK: <https://docs.temporal.io/develop/typescript>
- Claude Agent SDK: <https://code.claude.com/docs/en/agent-sdk/overview>
- Codex SDK: <https://learn.chatgpt.com/docs/codex-sdk>

These references are informative rather than normative. The workflow invariants in this
specification should remain stable even if provider APIs or UI details evolve.

---

## 27. Summary

The system treats GitHub Projects as the planning and human collaboration surface, GitHub
repositories as the software source of truth, and Temporal as the durable execution engine.

A strong planning model produces a blueprint before work becomes Ready. Implementation agents
execute against that blueprint. Ten specialized reviewers inspect the result in parallel. A
synthesis stage converts their output into blocking repairs, immediate non-blocking repairs, or
provisional deferrals. Repairs remain within the review lifecycle and undergo targeted re-review.
Deferred findings are only converted into durable backlog issues once the work has passed its merge
decision and is actually proceeding toward merge. Human approval is exceptional and
policy-controlled rather than mandatory.

This separation keeps the Project board intelligible to humans while allowing Temporal to carry the
detailed resilience, concurrency, retry, waiting, and failure-recovery semantics required for
autonomous software delivery.
