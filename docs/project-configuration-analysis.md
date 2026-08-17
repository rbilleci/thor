# GitHub Project Initialization and Configuration Analysis

Status: architecture analysis and implementation record, updated 2026-08-17. The baseline findings
below describe the repository when this analysis began; they are intentionally retained as the
rationale for the resulting architecture. The current-verdict and remaining-gap sections describe
the implementation now present in the worktree. Canonical decisions are recorded in
[design.md](design.md).

## Scope and terminology

This analysis answers three questions:

1. Can Thor initialize a new GitHub Project?
2. Can a Project, delivery workflow, and agent setup be declared from versioned configuration or
   templates and safely changed over time?
3. Does the automated and live test suite prove that multiple Project configurations work?

The phrase "agent condos" in the request is interpreted as **agent configurations or logical agent
profiles**: the names used for roles such as planner or implementer, the Claude/Codex harness behind
each role, and the prompt, `AGENTS.md`, skills, and execution settings assigned to it.

## Executive verdict

| Capability                                       | Current verdict                              | What exists in the worktree                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Initialize a new GitHub Project                  | **Implemented; live API verification open**  | `project plan/apply/validate/adopt` discover by number or exact title, create Projects, reconcile metadata, fields, additive options, repository links, and supported saved views, and compile the result. Fake-GitHub tests prove convergence, destructive-drift refusal, adoption, and second-apply no-op. |
| Configure a Project from declarations/templates  | **Implemented end to end**                   | Strict `DeliveryProject` schemas, detailed and compact templates, semantic compilation, stable digests, ID-based mapping, runtime startup validation, per-repository branches, polling eligibility, and pinned Workflow inputs all consume one declaration/binding contract.                                 |
| Handle multiple workflow or agent configurations | **Implemented within `ticket-delivery/v1`**  | Profiles vary board vocabulary/granularity, entry and approval meanings, reviewer sets, named roles, Claude/Codex routing, harness resources/configuration, and ticket/blueprint skill selectors. Arbitrary new process graphs remain code-defined, versioned Workflow implementations.                      |
| Test multiple Project configurations             | **Locally verified; live matrix still open** | Schema/compiler, mapper, synchronizer, package-builder, Workflow/replay, and real-Activity/local-Git integration tests cover both detailed and compact profiles. Credential-gated Project creation and a compact-profile delivery have not been run against live GitHub in this work session.                |

Thor now meets the requested configuration-independence boundary for the supported delivery
Workflow. No runtime component needs hand-copied Project, field, or option IDs, and physical lane or
field names no longer determine orchestration semantics. The remaining work is operational proof and
explicit migration tooling, not completion of the core configuration path.

The selected canonical source is a checked-in declaration in Thor's repository or a protected
control-plane configuration repository. GitHub Project metadata remains authoritative operational
state, but is not used as the machine-configuration store; at most it contains an informational
declaration path and digest.

## Baseline state when the analysis began

The following subsections preserve the evidence that motivated the architecture. They describe the
pre-generalization implementation, not the current completion state.

### 1. Project initialization and provisioning

There is no Project initializer, template applier, or reconciliation engine in the repository.

Evidence:

- `GitHubGateway` in `packages/github/src/types.ts` exposes item reads, status transitions,
  repository/PR operations, comments, deferred issues, and merge operations. It exposes no Project,
  field, option, or Project-template reconciliation operation.
- `OctokitGitHubGateway` only queries a Project by its configured node ID and mutates existing item
  field values.
- `apps/cli/src/main.ts` supports `start`, `status`, approval decisions, and `cancel`. It has no
  `project init`, `project plan`, `project apply`, or `project validate` command.
- No versioned Project declaration, Project template, provisioning package, or Project schema
  manifest exists in the repository.
- `.env.example` requires the operator to supply `GITHUB_PROJECT_ID`, `GITHUB_STATUS_FIELD_ID`, and
  the option ID for every Thor status.
- `LiveGitHubFixtureManager.prepare()` in `tests/live/support/github-fixture.ts` selects an existing
  Project by owner and number and fails if required fields/options are absent. It creates an issue
  and Project item, not the Project or its schema.

The word `provisions` in the live-testing plan should therefore be read as provisioning test items
inside a pre-existing repository and Project. It does not mean Thor can provision those containers.

### 2. Existing configuration seams

The implementation has several pieces worth retaining:

- Runtime configuration validates the selected Project ID, Status field ID, and a complete mapping
  from Thor status keys to GitHub option IDs.
- Status writes use node IDs rather than guessing option labels.
- Deferred-issue output fields can be mapped to configured field and option IDs through
  `GITHUB_DEFERRED_FIELDS_JSON`.
- `ticketWorkflow` accepts phase routing for blueprint, implementation, review, synthesis, and
  repair.
- Claude and Codex share a provider-neutral domain interface.
- Each harness has distinct prompt, `AGENTS.md`, built-in skills, and configuration resources under
  `resources/harnesses/<harness>/`.
- Execution-package digests make the prompt, instructions, skills, and non-secret harness
  configuration auditable.
- Custom skills are selected from ticket and phase context, and tests cover both provider-specific
  packages and context-based selection.

These are configuration _seams_, not a coherent Project declaration system. They are split across
environment JSON, hard-coded mappings, directory conventions, and Workflow defaults.

### 3. Hard-wired Project schema

The read path in `mapProjectItem()` uses physical GitHub field names directly:

- `Type` or `Work Type`;
- `Priority`;
- `Component / Area`;
- `Execution Mode`;
- `Planning Depth`;
- `Approval Policy`;
- `Agent Policy`.

Except for the one `Type`/`Work Type` compatibility alias, these names are not configurable. Their
accepted option labels are also fixed in `parseEnumField()` maps. A renamed field can silently fall
back to a default (`task`, `P2`, `agent`, `full`, `autonomous`, or `preferred`), while an unfamiliar
option label fails the item mapping. This is particularly risky because a board rename can change
execution or approval policy without producing a startup configuration error.

Status handling is only partly configurable:

- writes use a configured Status field ID and configured option IDs;
- reads parse the selected option's _display name_ into the fixed `TicketStatus` enum;
- labels such as `Doing` or `Needs approval` cannot be mapped to canonical meanings through
  configuration;
- runtime loading requires an option ID for every member of the fixed status union.

The fixed domain union currently has 18 values. The recommended board in `design.md` lists 15
visible lifecycle states, while the runtime additionally requires internal phases such as
`automated_review_passed`, `materializing_deferrals`, and `merging` as Project options. This reveals
a deeper coupling: internal Workflow state and human-facing board state are represented by the same
type.

One synchronizer process is also bound to one `GITHUB_PROJECT_ID`. Supporting another Project or
schema currently means starting another deployment with a separately hand-authored environment,
provided that Project still conforms to the same implicit schema.

### 4. Hard-wired workflow and agent model

`packages/workflows/src/workflows.ts` exports one workflow: `ticketWorkflow`. The deterministic
state machine, entry statuses, eligible start statuses, reviewer set, human transition meanings, and
lifecycle transitions are code-defined.

The `harnesses` Workflow input is a useful partial abstraction, but it is limited to:

```text
blueprint       -> claude | codex
implementation  -> claude | codex
review          -> claude | codex
synthesis       -> claude | codex
repair          -> claude | codex
```

The synchronizer and CLI do not supply project-specific routing, so both use the defaults. There is
no workflow registry, workflow-profile ID, logical agent-role registry, or deployment configuration
that maps a name such as `payments-planner` to a harness and execution profile.

`ExecutionPackageBuilder` always resolves resources from `resources/harnesses/<claude|codex>/...`.
Its public API can merge a configuration override, but the production Activity call does not provide
one. Custom skill routing is currently a fixed keyword and work-type function rather than a
versioned selector declaration.

### 5. Test-suite generality

The current test suite is strong in behavioral areas that do not vary the Project schema:

- deterministic state-machine and Workflow transition tests;
- Temporal replay, retries, cancellation, conflict handling, approval gates, repair, review, and
  deferral behavior;
- provider-neutral harness execution and provider-specific package resources;
- a real GitHub/Temporal live suite covering five substantial delivery scenarios.

It does not prove configuration independence:

- the live suite requires an existing private repository and Project through `THOR_LIVE_REPOSITORY`,
  `THOR_LIVE_PROJECT_OWNER`, and `THOR_LIVE_PROJECT_NUMBER`;
- only the Status field name is configurable in the live fixture;
- fixture creation writes the exact names `Work Type`, `Priority`, `Component / Area`,
  `Execution Mode`, `Planning Depth`, `Approval Policy`, and `Agent Policy`;
- the live fixture contains its own hard-coded display-name maps for all statuses and approval
  policies;
- every live scenario runs against that same Project and schema;
- no test applies a declaration twice, detects drift, migrates a schema, or produces a runtime
  binding;
- no matrix covers renamed fields, renamed options, fewer visible board states, alternative workflow
  profiles, or logical agent profiles;
- the Workflow tests vary policy and execution conditions but do not pass an alternative harness
  routing map;
- the only schema-compatibility unit test checks the special `Type`/`Work Type` alias.

The live runner discovers node IDs from the existing Project, which is useful, but discovery is not
generality when the discovery still requires the same names and values.

## Current implementation status

The implementation now completes the shared configuration path:

- `@thor/config` defines strict runtime schemas for `DeliveryProject` declarations, semantic Project
  fields/options, saved views, explicit ticket defaults, board projections, supported Workflow
  implementations, reviewers, logical agent profiles, human-intervention/dependency policies, and
  custom skill selectors;
- the pure TypeScript compiler validates cross-references, rejects unknown API and Workflow
  implementation versions, resolves live Project/field/option IDs, validates repositories and saved
  views, and produces stable declaration, agent-profile, and binding digests;
- detailed and compact checked-in templates deliberately vary physical names, lifecycle granularity,
  defaults, reviewer count, repository branch, and Claude/Codex phase routing;
- the Project control plane discovers and paginates live Projects, fields, repositories, and views;
  `plan` is read-only, `apply` converges one re-read operation at a time, `validate` produces an
  exact binding, and `adopt` pins GitHub's assigned Project number;
- reconciliation creates unnumbered Projects by exact unique title, adds missing fields/options,
  preserves existing option IDs and unmanaged content, links repositories, and manages the supported
  saved-view subset while rejecting destructive or ambiguous drift;
- production Project-item reads and writes use compiled node IDs, enforce configured required policy
  fields, and derive deferred-issue inheritance from the same binding;
- runtime, CLI starts, worker, and polling synchronizer all load and validate
  `THOR_PROJECT_DECLARATION`; repository base branches and synchronizer entry eligibility come from
  the compiled profile;
- Workflows pin the immutable runtime delivery profile, project every internal lifecycle state to a
  declared board state, use the configured reviewer set and named phase agents, and record
  declaration/profile/digest audit metadata. They also apply pinned replan/resume/cancel/orphan
  behavior for human changes; and
- execution-package construction resolves each named Claude/Codex profile, overlays its audited
  non-secret configuration, and selects custom skills from ticket plus blueprint/review context.

Local verification covers declaration versions and references, compiler and saved-view drift,
Project reconciliation and adoption, detailed/compact ID mapping, required-policy failures,
detailed/compact polling eligibility, named-agent resources and selectors, configurable Workflow
review fan-out and replay, and both profiles through real Temporal Activities and isolated Git.

The live fixture also derives its field IDs and option values from a production declaration and
binding. It still selects an existing Project and uses a default-profile-shaped live schema; this
work session did not exercise Project creation or the compact profile against GitHub's live API.

## Ideal state

### 1. One versioned source declaration

Thor should have a checked-in, runtime-validated declaration for each supported Project setup. The
declaration should use stable semantic keys and keep GitHub display names and node IDs out of domain
logic. Conceptually:

```yaml
apiVersion: thor.dev/v1alpha1
kind: DeliveryProject
metadata:
  name: default-delivery

github:
  owner: example
  title: Delivery
  repositories: [example/service]
  fields:
    lifecycle:
      name: Delivery State
      type: single_select
      options:
        backlog: Backlog
        blueprint: Design
        ready: Ready
        active: Doing
        review: Reviewing
        awaiting_merge: Human approval
        done: Done
        blocked: Blocked
        cancelled: Cancelled
    work_type:
      name: Kind
      type: single_select
      options: { feature: Feature, bug: Defect, task: Task }
    approval_policy:
      name: Delivery Policy
      type: single_select
      options: { autonomous: Automatic, pre_merge_review: Human merge review }

orchestration:
  profile: software-delivery/v1
  boardProjection: compact-delivery/v1
  agentRoles:
    planner: planning-primary
    implementer: coding-primary
    reviewer: review-primary
    repairer: coding-primary

agents:
  planning-primary:
    harness: claude
    executionProfile: claude/default-v1
  coding-primary:
    harness: codex
    executionProfile: codex/default-v1
  review-primary:
    harness: claude
    executionProfile: claude/review-v1
```

This is illustrative, not a settled schema. The important boundary is semantic key versus physical
GitHub representation.

Separate documents may be cleaner in the final design:

- a **Project template** for fields, options, supported saved-view settings, and repository
  associations;
- an **orchestration profile** for a supported workflow type, gates, entry policy, and projection of
  internal phases onto visible board states;
- **agent profiles** for logical role name, Claude/Codex harness, prompt/instruction/skill profile,
  and non-secret execution settings;
- a **deployment binding** containing the resolved Project, field, and option node IDs.

All documents need a schema version and content digest.

### 2. Keep canonical configuration in Git, not Project metadata

The checked-in declaration is the canonical configuration source. Thor should not infer its
automation contract from field names or lane labels, and it should not store the complete manifest
inside the GitHub Project README.

A Project README could technically contain an embedded YAML or JSON block, and single-select options
can carry names, colors, and descriptions. That approach is rejected as the primary configuration
mechanism because it would turn mutable presentation metadata into a configuration database. It
would provide weaker schema validation, review, atomic change with Workflow code and agent assets,
rollback, local testing, and protection against accidental edits. Project templates are valuable for
bootstrapping, but copied Projects also need explicit validation and evolution rather than implicit
configuration inheritance.

The declaration does not need to live in every repository serviced by a Project. A multi-repository
Project can be declared in Thor's repository or in a dedicated, protected control-plane
configuration repository, for example:

```text
config/
  projects/
    payments-delivery.yaml
  workflows/
    software-delivery-v1.yaml
  agents/
    planning-primary.yaml
    coding-primary.yaml
```

The authority boundary should be explicit:

| Source                             | Authority                                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Checked-in declaration             | Desired Project structure, semantic field mapping, supported workflow/profile selection, logical agent-role mapping, defaults, and configuration versions.    |
| Live GitHub Project                | Current ticket values, dependencies, approvals, human decisions, and other business state. Human changes must be re-read and must not be overwritten blindly. |
| Checked-in Thor code and resources | Deterministic Workflow implementations, configuration schemas and migrations, prompts, `AGENTS.md`, skills, and agent adapters.                               |
| Temporal Workflow history          | The immutable resolved declaration/profile versions and digest selected for one execution.                                                                    |

A structural mismatch between the declaration and live Project is drift to plan, validate, and
resolve; it is not permission to overwrite a human change automatically. Item-level Project values
remain authoritative even though Git owns the automation contract that explains how Thor interprets
them.

For discoverability, Thor may write a non-authoritative marker to the Project README or description:

```text
Thor declaration: config/projects/payments-delivery.yaml
Commit: 8df31ab
Digest: sha256:...
```

That marker is informational. Thor must load the reviewed declaration from Git and verify its digest
rather than treating Markdown as executable configuration.

### 3. Compile declarations into immutable runtime bindings

A compiler should validate the declaration and resolve it against GitHub. Its output should be an
immutable, generated binding that contains node IDs and the declaration digest. Runtime components
should consume that same compiled model:

```text
versioned declaration
        |
        v
validate + plan + idempotent apply
        |
        +----> GitHub Project, fields, options, and supported template settings
        |
        v
resolved binding (IDs + profile versions + digest)
        |
        +----> polling synchronizer and GitHub mapper
        +----> Temporal Workflow input
        +----> agent execution-package builder
        +----> unit, integration, and live fixture builders
```

The binding should be generated or stored separately from the human declaration because GitHub node
IDs are deployment-specific. It must contain no credentials.

At Workflow start, Thor should snapshot the selected workflow/profile versions and digest into the
Workflow input. A running Workflow must not reinterpret mutable configuration during replay. New
configuration should affect new Workflows by default; changing an active Workflow should require an
explicit, versioned migration or Temporal Update policy.

### 4. Idempotent Project lifecycle commands

The CLI or a dedicated package should provide:

- `thor project plan`: discover current state and show create/update/conflict actions without
  mutation;
- `thor project apply`: create or adopt a Project and reconcile fields, options, associations, and
  other GitHub-supported template settings using find-or-create/idempotent behavior;
- `thor project validate`: verify type, names, option mappings, permissions, repository access, and
  drift before services start;
- `thor project export` or `adopt`: bootstrap a declaration from an existing Project where useful.

The reconciler must preserve human authority. Additive safe changes may be automatic; destructive
renames, option removals, type changes, or ambiguous matches should produce a plan and require an
explicit migration decision. The binding should only be published after successful validation. Any
desired Project setting that GitHub does not expose for safe automation should appear as an explicit
manual prerequisite in the plan rather than being reported as applied.

### 5. Separate internal execution state from board projection

Temporal should retain a stable, deterministic internal state machine. A Project profile should map
those internal phases onto a configurable human-facing lifecycle rather than requiring one GitHub
option per internal state. This permits both a detailed Thor-native board and a compact team board
without hiding orchestration detail in ad hoc strings.

Human transitions still need explicit semantic meanings. For example, a profile can declare which
board transition represents blueprint approval or a repair request. Those mappings must be validated
for ambiguity and cannot bypass the Workflow's safety invariants.

Configuration should select among supported, versioned Workflow implementations or profiles. It
should not load arbitrary executable workflow logic from YAML. A materially new process graph still
requires deterministic TypeScript Workflow code, replay tests, and a versioned migration strategy.

### 6. Generalized test architecture

Production and test code should share the declaration parser, compiler, binding type, and Project
reconciler. The test suite should then cover a configuration matrix rather than repeat physical
names in fixture code.

Minimum matrix:

| Configuration                        | Purpose                                                                                   |
| ------------------------------------ | ----------------------------------------------------------------------------------------- |
| Thor-native detailed board           | Prove the complete canonical lifecycle.                                                   |
| Renamed compact board                | Prove semantic field/option mapping and many-internal-to-one-visible state projection.    |
| Alternate approval and agent profile | Prove workflow policy and logical role-to-harness routing come from the selected profile. |
| Existing/legacy board                | Prove safe adoption, aliases, validation warnings, and explicit conflicts.                |

Required test layers:

1. Declaration-schema tests for valid, invalid, upgraded, and unknown versions.
2. Compiler golden tests that produce stable bindings and digests.
3. Fake-GitHub reconciler tests for first apply, second-apply idempotency, partial failure, drift,
   adoption, and destructive conflicts.
4. Mapper contract tests generated from each declaration, including renamed fields/options, missing
   required fields, unknown values, and mixed Project content.
5. Workflow conformance tests for every supported orchestration profile, including custom phase
   routing and replay.
6. Agent-profile tests proving logical names select the intended harness, prompt, `AGENTS.md`,
   skills, configuration, and audit versions.
7. Live tests that create or reconcile disposable Projects from declarations. Run the full scenario
   suite on the canonical profile and at least one end-to-end smoke delivery on every other profile.

The fixture builder must set fields using semantic keys from the compiled binding. It must not own a
second copy of production field names or display labels.

## Prioritized remaining gaps

| Priority | Gap                                                  | Why it matters                                                                                                                                           | Completion signal                                                                                                                                            |
| -------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **P0**   | Live Project control-plane contract verification     | GitHub's GraphQL Project creation/field/view mutations are the main external boundary not exercised by the local suite.                                  | An authorized disposable owner passes create, partial retry, second-apply no-op, validate, adopt, additive evolution, and exact cleanup against live GitHub. |
| **P1**   | Active-Workflow configuration migration policy       | New executions safely pin their profile, but there is no operator command to migrate an already-running Workflow to a new declaration version.           | The design specifies stay-pinned versus explicit Update/continue-as-new behavior, compatibility rules, audit records, and replay tests.                      |
| **P1**   | Explicit destructive Project migrations              | Refusing unsafe drift is correct, but intentional renames, type replacement, option retirement, and item-value remapping still require manual handling.  | A reviewed migration format plans data movement, preserves human values, supports dry-run/recovery, and validates the new binding before cutover.            |
| **P1**   | Compact-profile live delivery                        | Local tests prove the compact profile, but a real renamed/fewer-lane board would validate the complete GraphQL mapping and human transition surface.     | One live smoke delivery provisions or reconciles the compact template and reaches `Done` using only semantic bindings.                                       |
| **P2**   | Broader Project template settings                    | The current schema manages text/select fields and view name/layout/filter/visible fields, not iteration/date fields, grouping, sorting, or roadmap data. | Supported settings are added from verified APIs; unsupported settings remain explicit manual prerequisites rather than inferred or overwritten.              |
| **P2**   | Existing-Project export and schema migration tooling | `adopt` validates a supplied declaration and pins its number; it does not infer a declaration from an arbitrary existing board or upgrade older schemas. | Export produces a reviewable semantic draft, and versioned migrations upgrade known older declarations while unknown versions continue to fail closed.       |
| **P2**   | Multi-Project deployment registry                    | One declaration per synchronizer process is a simple isolation boundary but duplicates deployments when many Projects are managed.                       | Either document one process pair per binding as the production model or add a validated registry with per-Project failure isolation and capacity controls.   |
| **P3**   | Webhook architecture                                 | Polling is the deliberate current transport; webhook delivery, buffering, deduplication, and hosting need a separate decision.                           | A later design selects the ingress architecture and proves it without weakening authoritative Project re-reads or poll-based recovery.                       |

## Recommended implementation sequence

1. **Completed:** establish the Git-backed authority boundary, strict declaration, compiled binding,
   versioning rules, and separation of internal Workflow state from board projection.
2. **Completed:** migrate Project mapping, runtime, polling synchronization, Workflow starts,
   reviewer fan-out, logical agents, execution packages, deferred fields, fixtures, and audits to
   the same compiled contract.
3. **Completed:** implement read-only planning, convergent additive apply, exact validation,
   adoption, saved-view support, destructive-drift conflicts, and fake control-plane tests.
4. **Completed locally:** prove the detailed and compact declarations across compiler, mapper,
   synchronizer, agent-package, Workflow replay, and real-Activity/local-Git integration layers.
5. **Next:** run a disposable live GitHub Project control-plane suite, including create, retry,
   idempotent reapply, validate, adopt, additive evolution, and cleanup.
6. Add compact-profile live delivery and an explicit active-Workflow/profile migration policy.
7. Add destructive migration and existing-Project export tools only after their human-data movement
   semantics are designed and reviewed.

## Bottom line

The core architectural revision is complete for Thor's supported `ticket-delivery/v1` process. Thor
can declare, plan, create or adopt, reconcile, validate, bind, execute, and audit differently shaped
Project and agent configurations without using Project presentation metadata as executable
configuration. Git remains the reviewed automation authority, GitHub remains the human/business
authority, and Temporal receives an immutable profile snapshot.

The highest-value remaining work is external contract proof: exercise the new Project control plane
against a disposable live GitHub owner and add one live compact-profile delivery. After that, the
important product work is explicit evolution—active-Workflow profile migration and intentional
destructive Project migrations—not another round of runtime configuration refactoring.
