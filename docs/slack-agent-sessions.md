# Slack Agent Session and Steering Design

Status: implemented baseline as of 2026-08-17; live Slack and provider qualification remains
required before production rollout.

This document specifies Slack as Thor's live agent-session surface. It extends the authority and
workflow boundaries in [design.md](design.md); if the documents conflict, `design.md` remains
canonical until the conflict is resolved explicitly.

## 1. Goals

Thor must:

- stream useful Claude and Codex progress into Slack with seconds-level delay;
- let each managed GitHub Project choose either one shared project channel with a thread per ticket
  or a dedicated channel per ticket;
- let authorized humans guide, redirect, or cancel an active agent from that ticket's Slack surface;
- preserve GitHub as the source of truth for ticket intent and Temporal as the source of truth for
  execution state;
- remain usable through transient Slack, provider, worker, and network failures;
- avoid adding an application database or durable message broker.

Healthy-dependency latency targets are:

- p95 agent event to visible Slack update: at most 2 seconds;
- p95 Slack command to durable Temporal acceptance: at most 3 seconds;
- p95 Slack command to acknowledgement in its task surface: at most 3 seconds;
- p95 direct steering delivery to a live agent session: at most 5 seconds;
- fallback recovery of a missed Slack event: at most one configured reconciliation interval, with a
  default of 30 seconds.

These are service objectives rather than correctness assumptions. Slack or provider outages may
exceed them without corrupting the ticket Workflow.

## 2. Non-goals

The first version does not provide:

- a compliance-grade, immutable transcript archive;
- a new transcript database;
- token-by-token display when a semantic update is clearer and cheaper;
- hidden chain-of-thought or raw provider reasoning;
- permission for Slack guidance to silently replace GitHub ticket intent;
- identical provider internals for Claude and Codex.

Slack retains the human-readable operational transcript. Temporal retains the execution and command
state needed for recovery. GitHub retains business state, code, pull requests, and durable delivery
artifacts. A future compliance requirement may add a completion-time JSONL export to protected
object storage or a protected GitHub audit repository without changing the live interaction model.

## 3. Authority boundaries

| Concern                                    | Authority                                           |
| ------------------------------------------ | --------------------------------------------------- |
| Ticket objective, scope, acceptance policy | GitHub issue and Project                            |
| Branches, commits, pull requests, merge    | GitHub repository                                   |
| Workflow phase, retries, cancellation      | Temporal                                            |
| Live transcript and human conversation     | Slack task surface                                  |
| Provider process and workspace effects     | Temporal Activity                                   |
| Project messaging-mode declaration         | Checked-in `DeliveryProject` configuration          |
| Task-to-Slack-surface routing              | Temporal Slack router Workflow and Workflow history |

Slack guidance may refine execution within the current ticket, for example by asking the agent to
inspect an existing helper or run another relevant test. A requested change to scope, acceptance
criteria, permissions, dependencies, or delivery policy must be made in GitHub. Thor replies with
that distinction and follows the existing GitHub-change cancellation or replanning policy.

## 4. Architecture

```text
GitHub Project item <--------- stable links ---------> Slack task surface
        |                                                   ^
        | polling                                           | streamed updates
        v                                                   |
TicketWorkflow <---- Signals ---- SlackWorkspaceRouter      |
        |                                ^                  |
        | Activity dispatch              | durable command  |
        v                                | reference         |
Agent Activity <---- live control ---- Slack Gateway -------+
        |
        +---- Claude adapter ---- Claude Agent SDK
        |
        +---- Codex adapter ----- Codex SDK
```

The design deliberately has two steering paths:

1. a low-latency, best-effort live-control path from the stateless Slack Gateway to the running
   Agent Activity; and
2. a durable Temporal Signal path that records the command reference and recovers when the direct
   path is unavailable.

Slack is already the durable source for the human's message. The Temporal Signal carries its stable
reference and digest rather than requiring another storage system.

## 5. Identity and mapping

### 5.1 Project messaging mode

Each managed `DeliveryProject` declares a stable Slack workspace ID and exactly one messaging mode:

- `thread_per_ticket`: all tickets use one declared project channel, and each ticket owns one root
  message and its reply thread;
- `channel_per_ticket`: Thor creates or finds one dedicated channel for each ticket. An optional
  project index channel may receive compact ticket-channel links, but it is not a command or
  transcript surface.

The mode is pinned in `TicketWorkflow` input. A declaration change applies to new ticket Workflows
by default; it does not silently move an active transcript. Moving an existing ticket requires an
explicit migration that closes the old surface, creates the new one idempotently, posts mutual
pointers, and updates the Workflow mapping before accepting commands on the new surface.

Display names and channel names are not identities and may change. Secrets and OAuth tokens remain
worker or gateway deployment secrets and never enter the declaration, Workflow history, prompts, or
Slack metadata.

Representative thread-per-ticket declaration:

```json
{
  "collaboration": {
    "slack": {
      "enabled": true,
      "workspaceId": "T012345",
      "messaging": {
        "mode": "thread_per_ticket",
        "projectChannelId": "C012345"
      },
      "eventReconciliationIntervalSeconds": 30,
      "streamFlushIntervalMilliseconds": 1000,
      "steering": {
        "allowedUserGroupIds": ["S012345"],
        "defaultMode": "redirect"
      }
    }
  }
}
```

Representative channel-per-ticket declaration:

```json
{
  "collaboration": {
    "slack": {
      "enabled": true,
      "workspaceId": "T012345",
      "messaging": {
        "mode": "channel_per_ticket",
        "projectIndexChannelId": "C045678",
        "ticketChannels": {
          "namePrefix": "thor-payments",
          "isPrivate": true,
          "memberUserGroupIds": ["S012345"],
          "archiveDelayDays": 7
        }
      },
      "eventReconciliationIntervalSeconds": 30,
      "streamFlushIntervalMilliseconds": 1000,
      "steering": {
        "allowedUserGroupIds": ["S012345"],
        "defaultMode": "redirect"
      }
    }
  }
}
```

`projectIndexChannelId` is optional. If present, Thor posts or updates one compact index entry for
each ticket and never treats replies there as ticket commands. Private ticket channels require an
explicit membership policy and app scopes capable of creating and managing them. Declaration
validation rejects `channel_per_ticket` when naming, privacy, membership, or required Slack scopes
cannot be satisfied.

The exact schema will be versioned with the declaration and validated before startup.

### 5.2 Task surface

`TicketWorkflow` creates or finds one task surface for its Project item through idempotent Slack
Activities.

In `thread_per_ticket` mode, the surface is a bot-owned root message in the declared project
channel. In `channel_per_ticket` mode, the surface is a dedicated public or private channel plus a
bot-owned header message. The header is pinned when permissions allow, but pinning is presentational
and is never required for routing or recovery.

The root or header contains:

- ticket title and GitHub issue link;
- Workflow ID and Project item ID;
- current projected lifecycle phase;
- pull-request link when available;
- short command guidance for humans.

The bot attaches namespaced metadata containing the Workflow ID, Project item ID, repository, and
issue number. Root or header creation uses the Project item ID as its stable origin key. A retry
first searches bot-owned messages in the resolved surface for the same metadata and reuses the
match.

Dedicated channel creation uses a deterministic, length-bounded name made from the configured
prefix, issue number, and a short Project item ID digest. Because Slack channel creation has no
cross-request idempotency key, a retry handles `name_taken` by resolving the exact channel and
verifying Thor ownership from the channel creator, bot membership, deterministic digest, and
namespaced header metadata when present. A pre-existing channel without sufficient ownership
evidence is a conflict and is never silently reused. This also covers a worker failure after channel
creation but before posting the header. Thor stores the returned channel ID immediately, then
repairs the header, topic, membership, and index entry idempotently. Renaming a channel does not
break the stored mapping.

Workflow state stores a discriminated task-surface locator:

```ts
type SlackTaskSurface =
  | {
      mode: "thread_per_ticket";
      workspaceId: string;
      channelId: string;
      threadTs: string;
      headerTs: string;
      permalink: string;
    }
  | {
      mode: "channel_per_ticket";
      workspaceId: string;
      channelId: string;
      headerTs: string;
      permalink: string;
    };
```

The permalink always targets the bot-owned root or header message, giving GitHub a stable entry
point for either mode. Thor upserts one stable GitHub issue comment containing that permalink and
the Temporal Workflow ID. The Slack root or header contains the GitHub link, producing the
bidirectional association without a mapping database.

For `channel_per_ticket`, top-level messages form the primary transcript. Replies to messages in the
ticket channel remain part of the same task surface and may contain explicit Thor commands. When a
ticket reaches a terminal state, the workspace router posts the final status and archives the
channel after the configured delay. It never deletes the channel. Re-registering a reopened ticket
before that deadline cancels archival; reopening after archival idempotently unarchives and reuses
the channel when Slack retention and permissions permit. If the surface is no longer recoverable,
Thor provisions a replacement through the normal conflict-safe surface path.

### 5.3 Slack router Workflow

One deterministic `SlackWorkspaceRouterWorkflow` runs per configured Slack workspace, independent of
the selected messaging mode:

```text
slack-workspace:<workspace-id>
```

The workspace scope is required for channel-per-ticket reliability: an incoming Slack event always
contains its workspace ID, while a newly created ticket-channel ID cannot be mapped to a Project by
static gateway configuration. The stateless gateway can therefore derive the router Workflow ID
without a database or a Slack lookup in the three-second acknowledgement path.

The router maintains a mode-aware mapping from a thread key (`channelId`, `threadTs`) or
dedicated-channel key (`channelId`) to delivery Project and `TicketWorkflow` ID, deduplicates Slack
event IDs, and forwards command references to ticket Workflows. In channel mode, any nested reply
still resolves by the dedicated channel ID. `TicketWorkflow` registers the mapping through a durable
Workflow Update and waits for acceptance before marking the Slack surface ready for commands.
Conflicting registrations are rejected rather than overwritten.

The router uses Continue-as-New to bound history while carrying active mappings, event high-water
marks, and a bounded duplicate-detection window forward. Terminal tickets leave a short-lived
tombstone (30 days in the first implementation) so a late message receives a clear closed-session
response rather than being routed to a new execution. Re-registering the same ticket reactivates its
surface; expired tombstones and their reconciliation watermarks are removed. Reconciliation is
partitioned into bounded Activity batches so one busy project cannot starve other projects in the
same workspace.

### 5.4 Mode tradeoffs and default

`thread_per_ticket` is the recommended default. It has fewer Slack lifecycle mutations, one stable
permission boundary, and cheaper missed-event reconciliation. Its tradeoff is that many active
tickets share one channel and thread discovery can become noisy.

`channel_per_ticket` provides stronger ticket isolation, a dedicated notification and membership
boundary, and easier discovery for long-running work. It consumes more channels and Slack API calls,
requires channel-management scopes and membership reconciliation, and is more exposed to workspace
channel limits and administrative policy. Project owners must choose it deliberately.

The normal streaming and steering latency objectives are identical after a task surface is ready.
Dedicated-channel provisioning has a separate setup path and is not included in the two-second
agent-event objective. A provisioning failure marks Slack collaboration degraded and is retried
independently; it does not change GitHub or Temporal authority or discard agent work.

## 6. Slack message model

The task root or channel header is a compact status and link card. In thread mode, its replies form
the transcript. In channel mode, top-level channel messages form the primary transcript and Slack
threads may hold local discussion or a native streamed response.

Each logical agent phase posts a labeled streamed message: a reply to the task root in thread mode,
or a top-level message in channel mode.

```text
Implementation · Codex · execution 0002
Review: security · Claude · execution 0007
Repair pass 2 · Codex · execution 0015
```

Provider events are rendered as:

| Normalized event          | Slack rendering                                      |
| ------------------------- | ---------------------------------------------------- |
| Turn or phase started     | phase header and status                              |
| Assistant text            | buffered markdown                                    |
| Plan/todo update          | Slack plan or task update chunk                      |
| Command started/completed | compact task update with exit status and duration    |
| File change completed     | paths and add/modify/delete summary                  |
| Tool call                 | sanitized tool name, status, and bounded result      |
| Test update               | suite name and pass/fail/running state               |
| Human steering received   | acknowledgement with actor and mode                  |
| Recovery                  | explicit interruption/recovery marker                |
| Turn completed or failed  | terminal status, usage summary, and result reference |

Thor uses two Slack rendering transports behind the same transcript sink:

- when a turn responds to a Slack user message and the required recipient user and team IDs are
  known, use `chat.startStream`, `chat.appendStream`, and `chat.stopStream`;
- for autonomous phases rooted by a Thor bot message, create one bot-owned phase message with
  `chat.postMessage` and refresh it with `chat.update`; this message is a task-root reply in thread
  mode and a top-level message in channel mode.

Slack documents native streams as replies to a user request and requires recipient IDs when
streaming into a channel. In channel mode such a response may therefore appear as a thread under the
user's explicit command even though autonomous phase messages are top-level. Thor must not
impersonate a user merely to force the native streaming surface. Both transports buffer small text
deltas and flush at the configured interval. Repeated plan, todo, and command updates are coalesced
by provider item ID. Completed commands, file changes, human commands, failures, and terminal
results are never discarded merely to reduce message rate.

Parallel reviewers share the task surface. Every stream is labeled with reviewer, review-run ID, and
execution ID so interleaving remains understandable. High-volume reviewer tool details may be
coalesced while findings and terminal reviewer results remain visible.

## 7. Provider-neutral streaming contract

Provider SDK types stop inside their adapters. The orchestration and Slack layers consume a bounded
domain event union:

```ts
type AgentStreamEvent =
  | { kind: "session_started"; providerSessionId: string }
  | { kind: "turn_started"; turn: number }
  | { kind: "assistant_delta"; itemId: string; text: string }
  | { kind: "assistant_completed"; itemId: string; text: string }
  | { kind: "plan_updated"; itemId: string; items: AgentPlanItem[] }
  | { kind: "command_updated"; itemId: string; command: string; status: AgentActionStatus }
  | { kind: "file_change"; itemId: string; changes: AgentFileChange[]; status: AgentActionStatus }
  | { kind: "tool_updated"; itemId: string; tool: string; status: AgentActionStatus }
  | { kind: "usage"; usage: AgentUsage }
  | { kind: "turn_completed"; turn: number }
  | { kind: "turn_failed"; turn: number; retryable: boolean; message: string };

type AgentControl =
  | { kind: "queue"; commandId: string; text: string }
  | { kind: "redirect"; commandId: string; text: string }
  | { kind: "cancel"; commandId: string; reason?: string };

type StreamingAgentHarness = {
  readonly kind: "claude" | "codex";
  execute(
    request: AgentExecutionRequest,
    events: AgentEventSink,
    controls: AsyncIterable<AgentControl>,
    signal: AbortSignal,
  ): Promise<AgentExecutionResult>;
};
```

The concrete TypeScript names may change during implementation, but the boundary must preserve:

- ordered normalized events;
- provider-neutral controls;
- early publication of a resumable provider session ID;
- one validated final structured result;
- cancellation and retry classification;
- no provider-specific types in Workflow payloads.

All event text passes through redaction and size limits before leaving the Activity. Thor stores and
displays provider-supplied summaries and visible messages, not hidden model reasoning.

## 8. Codex behavior

The Codex adapter uses `Thread.runStreamed()` and normalizes `thread.started`, turn, item, and error
events. Command executions, file changes, MCP calls, web searches, plans, assistant messages, and
usage events map into the shared union.

Codex does not accept an arbitrary new user message in the middle of a `runStreamed()` turn through
the supported Thread interface. Therefore:

- `queue` waits for the active turn to finish, then calls `runStreamed()` again on the same Thread;
- `redirect` aborts the active turn with its `AbortSignal`, records the interruption, and calls
  `runStreamed()` again on the same Thread with the human instruction and the original required
  output schema;
- `cancel` aborts the turn and ends the Activity as a cancellation.

The adapter emits the Codex thread ID as soon as `thread.started` arrives and checkpoints it. A
subsequent turn reuses the in-memory Thread. Activity recovery uses `resumeThread()` when the
execution volume still contains the provider session; otherwise it starts a recovery session that
receives the ticket package, current workspace, prior completed result context, and referenced Slack
guidance.

## 9. Claude behavior

The Claude adapter continues to consume the Agent SDK's async message stream and enables partial
messages when useful for the configured display policy. It normalizes assistant, tool, hook, result,
usage, and error messages into the same event union.

For steering, the adapter uses streaming input and the Query control surface:

- `queue` supplies the instruction at the next turn boundary;
- `redirect` interrupts the active query and supplies the instruction on the continuing session;
- `cancel` interrupts and closes the query.

Claude's richer live-input support is an implementation advantage, not a different product contract.
Slack users see the same command meanings for Claude and Codex. The Claude session ID is
checkpointed as soon as it is available and used for recovery when the provider session can be
resumed.

## 10. Steering and command delivery

### 10.1 User commands

The first version recognizes explicit bot mentions and Block Kit actions only:

```text
@Thor steer: inspect the existing retry helper before changing this path
@Thor queue: run the integration suite after the focused tests
@Thor cancel: requirements need clarification
```

`steer` maps to the configured default, normally `redirect`. Ordinary replies remain conversation
and are not model input. Authorized actor IDs, allowed Slack user groups, and command modes are
validated before delivery. Edits to an accepted command do not mutate agent input; the user sends a
new command instead. Deleting a Slack message does not revoke an applied command.

### 10.2 Low-latency path

While running, each Agent Activity maintains an authenticated control subscription to the stateless
Slack Gateway keyed by Workflow ID, execution ID, and the mode-aware task-surface locator. The
gateway pushes an accepted command to that subscription immediately. The Activity deduplicates by
Slack event ID and message timestamp, applies the provider-neutral control, acknowledges it in the
same task surface, and reports the applied command ID back through the gateway. Before that applied
acknowledgement can clear the Workflow's pending command, the Activity checkpoints the command's
bounded Slack reference (never its raw text). It clears the reference only after the guided provider
turn finishes. A worker failure in between therefore reloads the validated source or durable receipt
from Slack and replays the guidance rather than silently losing it.

The gateway holds no durable session or command state. Restarting it is safe: Activities reconnect
and resubscribe, while Slack and Temporal retain the recoverable state.

### 10.3 Durable path

For every accepted Slack event, the gateway also signals `SlackWorkspaceRouterWorkflow` with:

```text
Slack event ID
workspace and channel ID
optional thread timestamp and message timestamp
actor ID
command mode
content digest
```

The raw message does not need to enter Workflow history. A provider Activity loads it from Slack by
reference when the direct delivery was missed or a phase must be restarted.

The router resolves the ticket mapping and invokes an idempotent Slack Activity to materialize an
accepted command as a bot-owned receipt with stable command metadata. This gives recovery a stable
Slack copy even if the user later edits or deletes the source message. Only the receipt reference
and content digest enter Workflow history; the command text remains in Slack and is loaded inside an
Activity.

The router then signals `TicketWorkflow`. The ticket Workflow records a pending command reference. A
matching applied acknowledgement clears it. If no acknowledgement arrives within the
control-delivery timeout, the Workflow requests graceful Activity cancellation and restarts the
logical phase with the command receipt reference. This fallback may lose provider-local conversation
context, but it preserves the ticket, workspace, and human instruction.

`cancel` does not wait for the direct-path timeout. It immediately follows the existing durable
cancellation path.

### 10.4 Events API acknowledgement and recovery

The production gateway uses Slack's signed HTTP Events API. It validates the actor against its
compiled policy cache, asks Temporal to accept the router Signal, and only then attempts direct live
delivery. The router's Slack Activity revalidates authorization before materializing the durable
command receipt. The gateway returns success only after Temporal accepts the Signal, and it
completes this boundary within Slack's three-second acknowledgement window. If Temporal is
unavailable, the gateway returns a retryable failure so Slack redelivers the event. Duplicate
deliveries are expected and harmless.

For local development, Socket Mode may replace the public HTTP endpoint. Production keeps the choice
deployment-specific, but HTTP event delivery is the reference path.

Because the Events API is best effort, the router periodically invokes a Slack reconciliation
Activity for active task surfaces. In thread mode it reads replies after the thread's high-water
timestamp. In channel mode it reads channel history and the replies of roots whose activity changed
after the channel high-water timestamp. It reconstructs any explicit command event missed by normal
delivery. The default interval is 30 seconds and is adapted or backed off when Slack reports rate
limits. Channel mode has a larger reconciliation cost, so implementations must bound pagination and
prioritize surfaces with active agent executions.

## 11. Activity lifecycle and checkpoints

An agent phase remains one logical Temporal Activity even when steering causes multiple provider
turns. Applying a live command inside the Activity avoids losing its in-memory provider session or
partially modified workspace.

The Activity heartbeats on every material event and at least every five seconds while the provider
is quiet. Heartbeat details are bounded and contain only operational checkpoint data:

```text
execution ID and Activity attempt
provider-neutral session ID
provider turn number
Slack task-surface locator and current stream timestamp
last normalized provider item ID
last Slack update acknowledged
last steering command applied
bounded references for applied commands whose guided turn has not completed
current phase
```

The agent Activity heartbeat timeout should default to 30 seconds, with worker heartbeat throttling
low enough to deliver cancellation promptly. Exact values remain resource-profile configuration and
must be load-tested before production rollout.

Isolated worktrees and Thor's small atomic checkpoint files live under an execution-scoped,
access-controlled volume. Provider session files may use an SDK-specific local directory, which must
be backed by that volume or an equivalent durable handoff when production workers may take over one
another's Activities. This is filesystem execution state, not an application database or business
authority. Provider session files are short-lived and are removed according to execution-retention
policy. If provider-local state is unavailable, the checkpointed ID is cleared before Temporal
retries the Activity so the next attempt creates a marked recovery session instead of retrying an
unusable ID.

On Activity retry:

1. read Temporal heartbeat details and the execution checkpoint;
2. reopen the same worktree;
3. resume the provider session when its files are valid;
4. inspect the current Slack stream before appending more content;
5. otherwise post a recovery marker and start a new provider session against the preserved workspace
   and execution package;
6. reload and replay any checkpointed guidance whose provider turn did not complete;
7. deduplicate already applied Slack commands before continuing.

The final structured output schema remains mandatory. Intermediate turns caused by guidance do not
bypass output validation or the deterministic merge gates.

## 12. Backpressure, rate limits, and degraded operation

Each Agent Activity uses a bounded transcript buffer. It coalesces assistant deltas and repeated
updates for the same provider item, then respects Slack `Retry-After` responses with jitter. Native
stream appends and bot-message updates have separate Slack rate tiers, so the sink selects and paces
them independently. It may drop superseded partial deltas or repeated running states, but it retains
completed actions, failures, human commands, and terminal results.

Slack publishing is ancillary to the software-delivery result:

- a transient Slack write failure does not restart the provider or discard repository work;
- the Activity continues while retrying and coalescing within a bounded buffer;
- when the buffer reaches its limit, Thor preserves terminal and human-command events first;
- completion waits for a bounded final flush, then records `slackDelivery: degraded` if Slack is
  still unavailable;
- a retryable summary Activity later repairs the root status and posts the final result;
- GitHub `Blocked` and `Cancelled` remain available when Slack cannot be used.

This choice prioritizes delivery resilience over a complete transcript. It is consistent with the
current decision not to build a compliance archive.

## 13. Failure behavior

| Failure                                       | Required behavior                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------- |
| Slack append is rate-limited                  | Honor `Retry-After`, coalesce updates, preserve the provider run                      |
| Slack write API is unavailable                | Buffer within bounds, continue work, repair final status later                        |
| Slack Events ingress is unavailable           | Slack retries; reconciliation reads missed active-surface messages                    |
| Dedicated channel creation is rate-limited    | Honor `Retry-After`; retry provisioning without starting a second channel             |
| Deterministic ticket-channel name conflicts   | Refuse adoption without Thor ownership evidence and surface a collaboration conflict  |
| Private ticket membership cannot be applied   | Do not post sensitive output; retry membership while delivery remains fail-safe       |
| Live gateway-to-Activity control is lost      | Temporal pending-command timeout cancels/restarts the phase by reference              |
| Duplicate Slack event                         | Deduplicate by event ID and message timestamp                                         |
| Worker process dies                           | Heartbeat timeout causes retry; reopen execution volume and resume or recover session |
| Provider stream disconnects                   | Map retryability; resume provider session when supported                              |
| Provider cannot resume                        | Start a recovery session against preserved workspace and ticket context               |
| Temporal is temporarily unavailable           | Agent may finish its current safe unit; no unrecorded merge or lifecycle transition   |
| Slack task surface is deleted or inaccessible | Mark collaboration degraded; repair or replace it without changing ticket authority   |
| Human changes GitHub during Slack steering    | GitHub intervention policy wins; active agent work is cancelled or replanned          |

No Slack outage may authorize a merge, override a human gate, or turn a failed test into a pass.

## 14. Security and permissions

- Prefer a private project or ticket channel when source, command, test, or review details are
  sensitive.
- Use a dedicated Slack app and least-privilege bot scopes.
- Verify Slack request timestamps and signatures before acknowledging Events API requests.
- Authenticate Activity control subscriptions with short-lived service credentials.
- Authorize steering against declared user or user-group policy and record the Slack actor ID.
- Never place provider, GitHub, Temporal, or Slack credentials in messages or metadata.
- Redact known credential shapes and cap command/tool output before sending it to Slack.
- Treat Slack metadata as visible to channel members; store identifiers, not secrets.
- Ignore messages from bots, Thor itself, and unapproved applications to prevent feedback loops.
- In channel-per-ticket mode, apply the declared membership policy before posting sensitive agent
  output and revalidate membership when a channel is unarchived.

## 15. GitHub and board projection

Slack does not introduce a parallel ticket status. The task root or channel header displays the
current Temporal and GitHub projection, but GitHub remains authoritative.

Thor maintains one idempotent GitHub issue comment such as:

```text
Thor execution

Slack: <task-surface-permalink>
Temporal Workflow: github-project-item:<node-id>
Pull request: <link when available>
Latest result: <status and execution ID>
```

The Slack root or channel header and GitHub comment are repaired independently after transient
failure. Neither link is required for deterministic Workflow replay or merge eligibility.

## 16. Package and process boundaries

The expected implementation shape is:

```text
apps/slack-gateway       signed Slack ingress and stateless live-control fan-out
packages/slack           Slack API mapping, rendering, redaction, and fakes
packages/agent           normalized stream/control contract and Claude/Codex adapters
packages/workflows       SlackWorkspaceRouterWorkflow and TicketWorkflow steering state
packages/config          Slack declaration schema and task-surface mode binding
apps/worker              Activity wiring, transcript sink, and execution checkpoints
```

Slack SDK and Web API calls that produce delivery side effects execute in Activities. The ingress
gateway is limited to authenticating incoming events, signaling Temporal, and forwarding live
control to registered Activities. It contains no business workflow policy.

## 17. Validation strategy

### Unit and contract tests

- normalize representative Codex and Claude event streams into identical domain events;
- prove `queue`, `redirect`, and `cancel` semantics for both harnesses;
- redact and bound message, command, and tool payloads;
- coalesce partial updates without dropping completed or terminal events;
- render parallel reviewer streams with stable correlation identifiers;
- deduplicate Slack events and agent controls.

### Workflow and replay tests

- register and carry thread-per-ticket and channel-per-ticket mappings through Continue-as-New;
- pin the messaging mode for active tickets and reject an implicit mid-execution mode switch;
- route a newly created ticket channel through the workspace router after a stateless gateway
  restart;
- accept a steering reference while an Activity is active;
- clear a pending command after a direct-delivery acknowledgement;
- cancel and restart a phase after the fallback timeout;
- keep duplicate, late, edited, and terminal-ticket commands deterministic;
- prove GitHub intervention wins over conflicting Slack guidance.

### Integration and failure tests

- stream scripted Codex- and Claude-shaped events through a fake Slack API;
- create, find, rename, archive, unarchive, and recover a dedicated ticket channel idempotently;
- route and reconcile commands from a shared ticket thread and from top-level or nested messages in
  a dedicated ticket channel;
- inject HTTP 429 and honor `Retry-After` without restarting the provider;
- disconnect and restart the Slack Gateway while an Activity remains active;
- kill a worker after Slack accepts an update but before the next heartbeat;
- resume from an execution volume or execute the documented recovery-session fallback;
- recover a Slack command omitted from Events API delivery through reconciliation;
- verify the GitHub-to-Slack and Slack-to-GitHub links converge idempotently.

### Opt-in live tests

Use a private disposable Slack workspace/channel and disposable GitHub fixtures. Exercise one real
Codex and one real Claude session separately from the default test suite. Record created Slack
message timestamps in the live-run manifest and never post credentials or sensitive repository
content.

## 18. Rollout

1. Add the discriminated Slack declaration, thread-per-ticket creation, stable links, and fake Slack
   tests.
2. Add provider-neutral streaming and outbound read-only progress for Codex and Claude.
3. Add signed Events API ingress and Temporal router delivery with commands acknowledged but not yet
   applied.
4. Enable `queue` and `redirect` behind per-Project policy, then enable `cancel` after fallback and
   authorization tests pass.
5. Add channel-per-ticket creation, membership, index projection, reconciliation, archival, and
   recovery behind a per-Project feature flag.
6. Exercise worker, gateway, Slack, and provider failure injection before making Slack steering a
   production control surface.
7. Measure rate-limit, channel-volume, and latency behavior with the configured review fan-out and
   set the initial production concurrency envelope.

## 19. External assumptions

This design relies on Slack capabilities available when reviewed on 2026-08-17:

- threaded replies through `chat.postMessage` and `thread_ts`;
- message metadata with application-defined event types and payloads;
- `chat.startStream`, `chat.appendStream`, and `chat.stopStream` for AI response streaming;
- the Events API, unique event IDs, signed requests, acknowledgement deadlines, and retries;
- `chat.getPermalink` for stable browser links;
- channel creation, history, replies, membership, archival, and unarchival through the
  `conversations.*` APIs;
- configurable workspace message-retention policy.

References:

- Slack message streaming: <https://docs.slack.dev/reference/methods/chat.startStream/>
- Slack stream append: <https://docs.slack.dev/reference/methods/chat.appendStream/>
- Slack stream completion: <https://docs.slack.dev/reference/methods/chat.stopStream/>
- Slack message updates: <https://docs.slack.dev/reference/methods/chat.update/>
- Slack channel creation: <https://docs.slack.dev/reference/methods/conversations.create/>
- Slack channel history: <https://docs.slack.dev/reference/methods/conversations.history/>
- Slack thread replies: <https://docs.slack.dev/reference/methods/conversations.replies/>
- Slack channel membership: <https://docs.slack.dev/reference/methods/conversations.invite/>
- Slack channel archival: <https://docs.slack.dev/reference/methods/conversations.archive/>
- Slack channel unarchival: <https://docs.slack.dev/reference/methods/conversations.unarchive/>
- Slack Events API: <https://docs.slack.dev/apis/events-api/>
- Slack message metadata: <https://docs.slack.dev/messaging/message-metadata/>
- Slack message permalinks: <https://docs.slack.dev/reference/methods/chat.getPermalink/>
- Slack retention: <https://slack.com/help/articles/203457187-Customize-data-retention-in-Slack>
- Codex SDK streaming and resumption: <https://learn.chatgpt.com/docs/codex-sdk>
- Claude Agent SDK: <https://code.claude.com/docs/en/agent-sdk/overview>
