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
- `@thor/agent` owns the provider-neutral harness contract, execution-package assembly, and native
  Claude and Codex SDK adapters.
- `@thor/github` owns GitHub GraphQL/REST mapping, webhook verification, conditional mutations, and
  idempotent side effects.
- `@thor/workflows` owns deterministic Temporal Workflow code and Activity implementations. Only
  Activities import filesystem, Git, GitHub, or agent SDK behavior.
- `@thor/runtime` validates environment configuration and creates concrete Temporal and GitHub
  connections.

Applications are composition roots: the worker wires real adapters, the synchronizer bridges GitHub
events to Temporal Signals, and the CLI exposes operator controls.

## Dependency rationale

- Temporal SDK packages provide durable Workflow execution, replay, retries, heartbeats,
  cancellation, and the local test server. Reimplementing those semantics would violate the core
  architecture.
- `@anthropic-ai/claude-agent-sdk` and `@openai/codex-sdk` are the direct supported harness APIs;
  provider types stop at their adapters.
- Octokit provides typed GitHub REST, GraphQL, and GitHub App authentication primitives.
- Zod validates every external payload and also produces the structured-output JSON Schemas sent to
  agent SDKs.
- Vitest, ESLint, Prettier, and `typescript-eslint` provide deterministic tests and strict static
  validation across the workspace.

The standard library handles HTTP ingress, hashing, HMAC verification, subprocess execution, file
operations, and logging; no additional framework is used for those paths.

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

`npm test` includes deterministic transition tests, a Temporal retry, cancellation, human gates,
repair/re-review, and replay of a completed Workflow history. The integration suite runs real
Temporal Activities against an isolated local Git repository while using SDK-shaped fake harnesses
and a fake GitHub gateway.

Build output is generated under each workspace's `dist/` directory and is ignored by Git. Use
`npm run clean` to remove it. Tests must never require live Claude, Codex, GitHub, or Temporal Cloud
credentials.

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
