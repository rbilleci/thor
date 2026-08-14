# Thor: Portable Subagent Pack Design

## Decision

Thor is a source format and release workflow for defining reusable subagents once and installing prebuilt definitions into Claude Code, Codex, and later harnesses.

The canonical source is one Markdown file per agent and standard Agent Skills directories. CI validates and transforms the source into immutable target artifacts. Pack authors may also render directly into a project's harness discovery locations to dogfood the pack. A local `thor` command installs release artifacts; it never transforms source YAML and never needs either harness's compiler or configuration model.

This deliberately keeps the portable surface small. Each agent owns its explicit settings, including concrete target model and effort, in its own Markdown file.

## Goals

- Define each subagent in its own source file, with a stable, harness-neutral identifier, description, instructions, requested access profile, concrete target model and effort, and a small set of target-only settings.
- Derive the pack target set from the same non-empty target keys in every source agent.
- Install, update, and uninstall both agents and standard skills from a GitHub repository/release.
- Make every installed file attributable to an exact release and safely removable.
- Render reviewable Claude Code and Codex dogfood snapshots from the portable
  source, then package signed release artifacts in CI/CD.
- Keep the Rust implementation small, auditable, and easy to add a future target to.

## Non-goals for v1

- Reproducing every harness-specific feature. Claude-only hooks and memory are excluded; only the documented per-agent target settings in this design may be authored in an agent's `targets` section.
- Merging with or editing a user's existing harness configuration files.
- Installing plugins or MCP-server configuration. Complete standard skills may contain scripts, but Thor only copies them; it never executes pack code.
- Resolving an agent's model dynamically at installation time.
- Supporting mutable Git branches as reproducible production installs. A release tag is the normal input.

## Repository and artifact roles

Thor uses two deliberately separate repository roles:

| Repository | Contents | Releases |
|---|---|---|
| `github.com/<org>/thor` | The Rust workspace, the canonical schemas, bootstrap scripts, and CI | Native `thor` binaries, `SHA256SUMS`, signed CLI release manifest, and bootstrap scripts. |
| `github.com/<org>/<agent-pack>` | Only `assets/agents/`, optional `assets/definitions/` and `assets/templates/`, `assets/skills/`, pack tests, and pack CI configuration | A signed `thor-bundle-<pack-version>.zip`. It contains no CLI binary or installer script. |

The agent-pack CI uses a version-pinned `thor-build` binary from the Thor tool repository. Before it executes that binary, it verifies the signed Thor tool release manifest against the Thor release public key pinned in the pack workflow, then verifies the selected `thor-build` asset's SHA-256 digest from that manifest. End users only download the native `thor` CLI and agent-pack bundles.

## Architecture

```text
Agent-pack repository
  assets/agents/<id>.md + assets/definitions/<id>.md + assets/templates/<id>.md + assets/skills/<name>/SKILL.md
              |
              | CI: validate -> transform -> snapshot-test -> package
              v
Agent-pack GitHub Release: thor-bundle-<version>.zip + signature
  manifest.json + targets/{claude,codex}/agents + skills/
              |
              | Rust `thor` CLI: init | update | uninstall
              v
Local harness directories
  .claude/agents + .claude/skills
  .codex/agents  + .agents/skills

Thor tool GitHub Release
  native `thor` binaries + checksums + signed release manifest + install.sh
              |
              | curl bootstrap (one-time)
              v
Local `thor` binary
```

The source repository and the release artifact are separate concerns:

- **Source** is human-authored YAML and portable standard skills.
- **Release artifact** contains generated agent files, expanded `SKILL.md` files, byte-identical auxiliary skill files, and an inventory with file digests.
- **Installer state** records exactly what Thor installed. It is not a second configuration source.

## Agent-pack source repository layout

```text
agent-pack/
├── assets/                            # Complete transform/package source root
│   ├── agents/                        # One portable source file per subagent
│   │   ├── pr-reviewer.md
│   │   └── focused-fixer.md
│   ├── definitions/                   # Optional reusable build-time instruction bundles
│   │   └── review-terms.md
│   ├── templates/                     # Optional build-time instruction wrappers
│   │   └── reviewer.md
│   └── skills/                        # Agent Skills source; only SKILL.md is preprocessed
│       └── pr-checklist/
│           ├── SKILL.md
│           └── references/
│               └── review-severity.md
└── .github/workflows/release.yml
```

The Thor tool repository has the separate Rust workspace described in [Rust implementation](#rust-implementation).

`assets/skills/<name>/SKILL.md` is a normal Agent Skills directory: `name` and `description` frontmatter followed by Markdown instructions, with optional `scripts/`, `references/`, and `assets/`. Claude Code and Codex both use the standard; neither target-specific skill extension is allowed in a portable Thor pack. Thor preprocesses only `SKILL.md` to expand selected definition bundles, then packages and installs it as a standard-compatible skill. Thor copies every other skill file as opaque bytes and never executes a bundled script during bootstrap, init, update, or uninstall; a harness may execute a script only later under its own policy.

The standard's optional `allowed-tools` field has differing host support. Treat it as advisory and do not use it to establish a security boundary; effective access control belongs to the invoking harness's sandbox and approval policy, with Thor's requested-access profile only supplying a default.

## Canonical meta-definition

Thor has these source inputs:

- `assets/agents/<id>.md` defines one subagent. Its YAML frontmatter contains the agent configuration, including the concrete `model` and `effort` for every selected target; its Markdown body is either the complete instruction text or the agent-specific text inserted into its declared template. The optional `definitions` list selects reusable definition bundles by identifier. Thor rejects reserved bundle markers in agent frontmatter and skill directives in agent frontmatter, bodies, and templates.
- `assets/definitions/<id>.md` is a UTF-8 Markdown definition bundle. Thor derives its path from the validated identifier, rejects empty, linked, missing, or nested-definition sources, and expands selected bundles in declaration order. Definition bundles are build-time source only and are never packaged as separate files.
- `assets/templates/<id>.md` is an optional build-time instruction wrapper. It contains exactly one `{{agent_instructions}}` slot. A direct agent that selects definitions requires exactly one `{{definition_bundles}}` marker in its instructions; an agent using a template requires exactly one marker in the raw template and none in its body. Thor validates those source locations before composition, inserts the non-empty agent body and selected bundles, rejects every other slot, and sends only expanded instructions to target renderers.
- `assets/skills/<name>/SKILL.md` may select bundles with one exact source-only directive, `<!-- thor:definitions: <id>[, <id>...] -->`, and requires exactly one `{{definition_bundles}}` marker. Thor rejects both reserved forms in skill frontmatter, then removes the directive and marker while inserting the selected bundles before target copy or bundle packaging. The generated file retains Agent Skills frontmatter and Markdown instructions; Thor copies every other file below the skill directory byte-for-byte.
- `assets/.claude/**` and `assets/.codex/**` are optional target-scoped static files. Thor copies their opaque bytes to the identical relative path below the matching harness root. Static files must not overlap generated `agents/` paths or Claude `skills/` paths.

Dogfood transformation overwrites each static source path but does not remove a static output after its source file disappears. Release installation tracks static payloads in the normal file inventory, so an update that removes a static payload removes its previously installed file.

The Thor tool repository's `schema/thor-v1.schema.json` is the sole normative schema source. It defines agent frontmatter and is embedded in the versioned `thor-build` binary. The Rust structures use `serde(deny_unknown_fields)` and must agree with that schema. CI validates frontmatter against the schema; the Markdown parser separately requires a non-empty UTF-8 body. YAML/Markdown remain author-friendly while the schema gives a language-neutral contract and clear validation failures.

### Agent definition: `assets/agents/pr-reviewer.md`

```md
---
id: pr-reviewer
description: Reviews a pull request for correctness, security, and test gaps.
requestedAccess: read-only

targets:
  claude:
    model: haiku
    effort: xhigh
    maxTurns: 20
    background: false
    # Optional when a separate worktree is required:
    # isolation: worktree
  codex:
    model: gpt-5.6-luna
    effort: xhigh
---

Review the requested change as an owner. Report only actionable findings.
For each finding, state its severity, affected file, rationale, and a concise
reproduction or verification path. Do not change files.
```

Every source agent must define the same non-empty set of target keys. Each target model mapping has a non-empty `model` and one Codex-aligned `effort`: `low`, `medium`, `high`, `xhigh`, or `max`. A package has no defaults, shared model aliases, inheritance, or separate metadata file. `thor-build bundle` receives package identity explicitly through `--package-name` and `--package-version`.

The filename must be `assets/agents/<id>.md`; the frontmatter `id` is the source of truth and CI rejects a mismatch. Source agents are flat in v1: no subdirectories, no inheritance, and no catch-all default file. An optional template performs deterministic build-time text composition; it does not inherit configuration or create a runtime dependency. This mirrors the generated target layout, where each harness receives one expanded file per agent in its `agents/` directory.

Thor's portable agent and skill identifier rule is `[a-z][a-z0-9-]{0,63}`. Every `assets/skills/<id>/SKILL.md` directory must use the same `id` in its directory name and `name` frontmatter. Within a skill, every other path component is 1–128 ASCII characters from `A–Z`, `a–z`, `0–9`, `.`, `_`, and `-`, is neither `.` nor `..`, does not end in `.`, and is not a Windows reserved device name (case-insensitive, including with an extension). No two source or archive path components may differ only by ASCII case at any depth. Pack validation accepts only real directories and regular files; symlinks, hard links, device files, FIFOs, and non-UTF-8 paths are errors.

### Schema rules

| Field | Rule |
|---|---|
| Agent files | Every `assets/agents/*.md` file must have YAML frontmatter and a non-empty Markdown body. There is no package manifest. |
| Agent `id` | Required; lowercase letters, digits, and hyphens; starts with a letter; 1–64 characters. It must equal the filename stem. |
| `description`, `requestedAccess`, `targets` | Required. Descriptions include the role and delegation trigger. `targets` must have at least one known target and every source agent must use the same target-key set. |
| `template` | Optional Thor identifier. Thor reads `assets/templates/<template>.md`, which must be a regular UTF-8 file containing exactly one `{{agent_instructions}}` slot and, when the agent selects definitions, exactly one `{{definition_bundles}}` marker. Templates are expanded during source loading and are not packaged. |
| `definitions` | Optional non-empty, unique list of Thor identifiers. Thor derives each path as `assets/definitions/<id>.md`, expands bundles in list order, and rejects unsafe, linked, missing, duplicate, empty, or nested-definition sources. An agent that selects bundles requires exactly one `{{definition_bundles}}` marker. |
| `instructions` | The Markdown body; required and non-empty. Thor either transforms it directly or inserts it into the declared template before producing a Claude Code Markdown body and Codex `developer_instructions`. |
| Target model mapping | Every selected target in every agent requires non-empty `model` and an effort of `low`, `medium`, `high`, `xhigh`, or `max`. |
| `requestedAccess` | One of `inherit`, `read-only`, or `workspace-write`. It is an initial request to the harness, never a security guarantee; parent policy and live approvals can be more restrictive or permissive. |
| `targets.claude` | When selected, requires `model` and `effort`; the v1 typed allowlist also includes `maxTurns` (positive integer), `background` (boolean), and `isolation: worktree`. Omitting a Claude-only field preserves Claude Code's documented default or parent-inheritance behavior for that field. |
| `targets.codex` | When selected, requires `model` and `effort`. Codex does support further session settings such as `mcp_servers` and `skills.config`, but endpoint definitions and machine-specific skill paths are intentionally outside Thor's small portable and install-safe contract. |
| Unknown fields | Rejected. Add new portable behavior through a versioned schema change, not unvalidated per-target blobs. |

## Common portability contract

Thor v1 guarantees the following common behavior, and only this behavior:

| Portable field | Meaning |
|---|---|
| Identity | Stable `id`, used as the generated target agent name and the installer-owned filename. |
| Delegation guidance | A concise description of what the agent does and when it should be selected. |
| Behavioral instructions | Markdown instructions governing the delegated task and expected result. |
| Target model and effort | Each selected target's concrete model identifier and Codex-aligned effort. |
| Requested access profile | Ask the target for parent inheritance, read-only access, or workspace-write access. This is not a sandbox or approval-policy guarantee. |
| Package skills | Standard skills installed beside the target configuration and available to the harness. |

Agent-specific skill preloading is excluded from the v1 contract. Claude can preload full skill content into an agent, while Codex exposes skills through its skills configuration and discovery flow. A package can make a skill universally available, but must not promise identical preloading behavior. If a particular procedure is mandatory, express that in the agent's `instructions` and give the skill a distinctive name.

## Transformation mapping

| Thor source | Claude Code output | Codex output |
|---|---|---|
| `id` | YAML `name`; `.claude/agents/<id>.md` | TOML `name`; `.codex/agents/<id>.toml` |
| `description` | YAML `description` | TOML `description` |
| Expanded `instructions` and definition bundles | Markdown after YAML frontmatter | `developer_instructions` multiline TOML string |
| Target model and effort | Read `targets.claude.model` and `.effort` into YAML `model` and `effort` | Read `targets.codex.model` and `.effort` into TOML `model` and `model_reasoning_effort` |
| `requestedAccess: inherit` | Omit tools and permission mode; parent configuration applies | Omit `sandbox_mode`; parent configuration applies |
| `requestedAccess: read-only` | Request `permissionMode: plan` and emit the fixed allowlist `Read, Grep, Glob, Bash` | Request `sandbox_mode = "read-only"` |
| `requestedAccess: workspace-write` | Request `permissionMode: default`; do not emit a tool allowlist | Request `sandbox_mode = "workspace-write"` |
| Claude-only target settings | Emit validated `maxTurns`, `background`, and optional `isolation: worktree` from `targets.claude` | N/A |

The transformer must fail when it cannot safely make this mapping. It must never silently drop a source field or pick an arbitrary model/effort fallback. A target adapter may emit a warning only for a documented, semantically harmless presentation difference.

The access mappings are requested defaults, not an authorization boundary. The invoking Claude Code or Codex session, organizational policy, and an interactive approval may override them. In particular, `read-only` must never be described as proof that a task cannot write outside the mapped sandbox.

### Example generated files

For `pr-reviewer`, CI produces:

```md
<!-- targets/claude/agents/pr-reviewer.md -->
---
name: pr-reviewer
description: Reviews a pull request for correctness, security, and test gaps.
model: haiku
effort: xhigh
permissionMode: plan
tools: Read, Grep, Glob, Bash
maxTurns: 20
background: false
---

Review the requested change as an owner. Report only actionable findings.
For each finding, state its severity, affected file, rationale, and a
concise reproduction or verification path. Do not change files.
```

```toml
# targets/codex/agents/pr-reviewer.toml
name = "pr-reviewer"
description = "Reviews a pull request for correctness, security, and test gaps."
model = "gpt-5.6-luna"
model_reasoning_effort = "xhigh"
sandbox_mode = "read-only"
developer_instructions = """
Review the requested change as an owner. Report only actionable findings.
For each finding, state its severity, affected file, rationale, and a
concise reproduction or verification path. Do not change files.
"""
```

## Per-agent target settings and future targets

An agent's `targets` section is the sole home for target-specific fields. Every selected target defines its concrete model and effort. It is a typed, versioned allowlist rather than an arbitrary target-configuration passthrough: in v1, Claude Code also supports `maxTurns`, `background`, and `isolation: worktree`. There are no package-wide fallbacks for these fields.

This makes every generated behavior inspectable from one source file. It also avoids a hidden default changing the meaning of an agent when a package is updated. An agent may omit a target setting only when that target's documented default or parent-inheritance behavior is desired.

When adding a new harness, implement a `TargetAdapter`, define its `targets.<new-target>` model, effort, and accepted settings in the JSON Schema, update every source agent with that target configuration, add golden-output tests, and release a new bundle. CI rejects a missing or inconsistent target configuration.

## CI/CD, release artifacts, and compatibility

The pack and CLI have independent release pipelines. An agent-pack release runs on a protected tag, for example `v1.2.0`:

1. Download the exact version-pinned Thor tool release. Verify its signed release manifest with the Thor public key pinned in the pack workflow, then verify the named `thor-build` asset's SHA-256 digest before executing it.
2. Parse every `assets/agents/*.md`, validate and expand any referenced definition bundle and instruction template, infer the common target set, and resolve each agent's target model/effort mapping. There is no agent inheritance or default resolution.
3. Validate every `assets/skills/*/SKILL.md` against the Agent Skills standard, expand its selected definition bundles, and validate the complete skill tree for portable packaging: its directory basename and `SKILL.md` `name` must match the Thor identifier rule; all paths must be normalized relative ASCII-safe paths; and every entry must be a regular file or directory, never a symlink, hard link, device, or FIFO.
4. Transform each independently defined agent for `claude` and `codex`; compare to approved golden snapshots and run target syntax checks where practical.
5. Copy each expanded `SKILL.md` and every other skill file byte-for-byte, calculate SHA-256 digests, create `thor-bundle-1.2.0.zip` with `--package-name` and `--package-version`, and produce a detached, versioned Ed25519 signature over the exact archive bytes using the pack's CI-held key.
6. Publish only the immutable bundle and its detached signature to the pack's GitHub Release.

The Thor tool pipeline builds, tests, signs, and publishes the native `thor` binaries and bootstrap assets in its own release. Pack CI does not build, package, or publish an installer.

```text
Agent-pack release assets
├── thor-bundle-1.2.0.zip
└── thor-bundle-1.2.0.zip.sig         # Ed25519 signature

thor-bundle-1.2.0.zip
├── manifest.json
├── targets/
│   ├── claude/agents/*.md
│   └── codex/agents/*.toml
└── skills/<skill-name>/**

Thor CLI release assets
├── thor-darwin-arm64
├── thor-darwin-amd64
├── thor-linux-amd64
├── thor-linux-arm64
├── thor-windows-amd64.exe
├── thor-build-linux-amd64
├── SHA256SUMS
├── thor-release-manifest.json
├── thor-release-manifest.sig
├── install.sh
└── install.ps1
```

`manifest.json` contains `format`, `minimumThorVersion`, the `--package-name` and `--package-version` inputs, canonical `sourceRepository`, `sourceReleaseTag` derived as `v<package-version>`, immutable source commit, supported targets, tested harness-version ranges, and a SHA-256 digest for every payload file. It contains no executable installation steps. The release client fetches an asset only from the exact GitHub Release for the canonical repository and selected tag, resolves that repository tag to its immutable commit, and requires it to equal the signed `sourceCommit`. On `init`, the CLI also requires the signed repository and tag/package version to match `--repo` and `--ref`. On `update`, it requires the repository and package identity to match the state record and, when given, the requested tag/package version to match `--ref`. It records the verified immutable commit and exposes it through `status`. The installed CLI rejects an unknown format, an incompatible `minimumThorVersion`, unsupported selected target, a harness version outside a declared compatible range when it can determine that version, or a bad pack signature before it writes anything.

With no explicit `--ref`, “latest compatible” means the greatest stable semantic-release tag whose signed manifest has a supported format, satisfies the installed CLI's `minimumThorVersion`, matches the pack signing key recorded at `init`, supports every selected target, and declares compatibility with any detected harness version. If harness version detection is unavailable, Thor warns and requires `--allow-unknown-harness-version`; it does not silently claim compatibility.

## Local lifecycle: bootstrap, install, update, uninstall

The local lifecycle tool is a native Rust binary named `thor`; users do not install Rust or any other language runtime. The GitHub Release contains one binary per operating system/architecture. `install.sh` is a deliberately small POSIX shell bootstrap: it detects `uname -s` and `uname -m`, downloads the matching binary and `SHA256SUMS` from the versioned release, verifies the binary digest, then installs `thor` into `~/.local/bin` (or `$THOR_BIN_DIR`). It does not download source YAML or execute repository code.

The Thor CLI release manifest is signed, but the deliberately dependency-free `curl | sh` bootstrap verifies only a checksum fetched from the same release. Its first invocation therefore trusts the HTTPS-delivered, GitHub-hosted script and release: it does not independently establish origin. Use a versioned URL and verify the signed manifest with a pre-trusted verifier, or use a package-manager distribution, where that assurance is required. A latest-release bootstrap is only an explicit convenience choice. This limitation does not apply to agent packs after `thor init`: the installed CLI verifies their Ed25519 signature against an explicitly trusted pack key before extraction.

```bash
# Bootstrap a specific native installer version on macOS or Linux.
curl -fsSL https://github.com/acme/thor/releases/download/v1.2.0/install.sh | sh

# Optional convenience form: resolve the latest published installer release.
curl -fsSL https://github.com/acme/thor/releases/latest/download/install.sh | sh

# Install a reproducible agent-pack release into the current project.
thor init --repo acme/thor-pack --ref v1.2.0 --pack-key ./acme-pack.ed25519.pub --target all

# Bring that pack to its newest compatible release.
thor update --repo acme/thor-pack

# Remove only files installed by this Thor package.
thor uninstall --repo acme/thor-pack
```

Windows releases include `thor-windows-amd64.exe` and `install.ps1`; the equivalent bootstrap is `irm <versioned-release-url>/install.ps1 | iex`. The POSIX `curl | sh` bootstrap is not presented as a Windows solution.

After bootstrap, `thor init` consumes an agent-pack GitHub repository reference and downloads its prebuilt bundle release, not source YAML. `--repo` accepts `owner/repo` or a GitHub HTTPS URL. `--pack-key` is required on a first install and supplies the Ed25519 public key used to verify that pack; its fingerprint is stored in the install record. Updates accept only bundles signed by the recorded key. Managed environments may provide an equivalent preconfigured trust store, but may not skip signature verification.

The default scope for every lifecycle command is `project`. The default project root is the Git worktree root containing the current directory. Outside a Git worktree, project scope requires `--root <absolute-path>`; Thor never guesses a project root. `--root` is invalid with `--scope user`, which installs into the user's harness directories. A new project-level `.thor/` directory should be added to the project's `.gitignore`.

Compatibility is evaluated separately for each selected target. If a selected harness version cannot be determined, both `init` and `update` fail unless the caller explicitly supplies `--allow-unknown-harness-version`; the flag applies only to targets whose version was unknown and is recorded in the operation log. It does not bypass an explicitly detected incompatible version.

| Operation | Required behavior |
|---|---|
| `init` | Resolve the requested tag/release, verify the signature, manifest, compatibility, ZIP safety, and every digest before any destination write. Refuse unmanaged generated-file conflicts and paths owned by another pack. Static payloads replace an existing regular file at the same path. Then execute a journaled transaction and write its state record only after commit. |
| `update` | Read the selected pack's state, resolve `--ref` or latest compatible release, then perform the same full verification. Refuse to replace a generated file whose digest differs from its previous installed digest unless `--force` is explicit. Static payloads replace an existing regular file at the same path. Delete a payload removed by the new release only when its previous digest still matches. |
| `uninstall` | Read the selected pack state and delete only state-listed files whose digest still equals the installed digest. Leave modified files in place and fail with their paths; `--force` removes them. Remove only empty directories that Thor created. Never delete a shared `.claude`, `.codex`, or `.agents` directory. |
| `status` | List installed packs, pinned release, selected targets, signing-key fingerprint, managed paths, and detected drift without changing files. |

Installation destinations:

| Scope | Claude Code agents | Codex agents | Claude Code skills | Codex skills |
|---|---|---|---|---|
| Project | `.claude/agents/` | `.codex/agents/` | `.claude/skills/` | `.agents/skills/` |
| User | `~/.claude/agents/` | `~/.codex/agents/` | `~/.claude/skills/` | `~/.agents/skills/` |

For project installs, Thor stores state under `<project-root>/.thor/installs/<pack-id>.json`; user state is under `$XDG_STATE_HOME/thor/installs/<pack-id>.json` (falling back to `~/.local/state/thor/installs/`). `<pack-id>` is a stable hash of the canonical repository identity and manifest package name. The record includes repository identity, selected tag, immutable commit, package and tool format versions, scope, selected targets, signing-key fingerprint, install time, directories created by Thor, and the full target-path/digest inventory for agents and complete skills.

`init --target all` creates one pack record containing all selected targets and is one transaction. `update --target codex` updates only the Codex payloads in that record. Multiple packs may be installed in a scope, but before any write Thor takes a scope lock and rejects a physical path or harness-visible agent/skill name already owned by another pack. It also rejects unmanaged destination files. This prevents two packs from silently fighting over the same configuration.

Before that ownership check, Thor scans the target discovery locations that can be visible to the chosen scope. For a project install, that means the project and user locations; for a user install, the user location only. Claude agent discovery is recursive under each `.claude/agents/` tree and Thor parses every Markdown frontmatter `name`; Codex agent discovery is the documented flat `*.toml` set under each `.codex/agents/` directory and Thor parses every TOML `name`. It scans immediate `skills/<directory>/SKILL.md` entries under the matching Claude or Codex skills root and parses their `name`. A candidate agent or skill whose visible name is already supplied by an unmanaged artifact or another pack is an error; a current artifact owned by the same pack is allowed during its update. An unreadable or malformed discovered definition is also a conflict because Thor cannot safely prove the identity is free. Duplicate visible skill names are errors even if their directories differ.

Transactions use a durable journal. Thor validates the complete release first, groups operations by destination filesystem, and creates a checked non-symlink staging and backup directory on each destination volume. It writes and fsyncs a `prepared` journal before replacement; each individual replacement is an atomic rename only within its own volume. After the per-volume changes and state are fsynced, it marks the journal `committed` and removes staging data. At the start of every lifecycle command, Thor recovers an incomplete journal by completing or rolling back the recorded operations, including the state record. It does not promise a cross-volume atomic operation; it promises recovery to the old or fully recorded new inventory.

Private GitHub repositories use the normal `GH_TOKEN` environment variable. Neither the bootstrap nor the installer runs repository scripts, Rust build steps, Git hooks, or transformation code.

### Bundle and filesystem safety

`BundleVerifier` treats every bundle as untrusted until verification completes. It rejects an invalid Ed25519 signature, duplicate ZIP members, absolute paths, `..` traversal, path separators or platform-reserved forms that normalize differently, symbolic or hard-link entries, entries not declared by the manifest, and entries outside `targets/<target>/agents/` or `skills/<name>/`. It enforces bounded entry count and compressed/uncompressed sizes (v1 defaults: 10,000 files and 100 MiB total uncompressed) before extraction.

The installer extracts only into fresh Thor-owned staging directories on the required destination volumes. It creates destination paths component by component without following symlinks, checks `symlink_metadata` before replacement, and verifies canonical containment in the selected scope. A user-controlled symlink in `.claude`, `.codex`, `.agents`, `.thor`, or an intermediate target directory is a conflict, not a path Thor follows.

## Rust implementation

Thor is one Rust workspace with two binaries and one small shared library. This removes the Java toolchain entirely while keeping local installations free of a Rust runtime.

```text
Cargo workspace
├── schema/        # Sole normative thor-v1.schema.json source
├── thor-core      # Strict source types, frontmatter, manifests, digests, signatures
├── thor-build     # Pack-author transformer and packager
└── thor            # Native local init/update/uninstall CLI
```

`Cargo.lock` and `rust-toolchain.toml` are committed. `thor-core` embeds the versioned schema and exposes the same validation entry points to both binaries; neither binary carries a second hand-maintained field list.

### `thor-build`: pack-author transformer and packager

`thor-build` is compiled for pack CI and for pack-author dogfooding; it is not an
end-user configuration tool:

```text
thor-build <command>
├── validate [--source <pack-directory>]                         # defaults to assets/
├── transform [--source <pack-directory>] [--target <claude|codex|all>]
│             [--root <project-root>] [--check]                  # defaults: all, .
└── bundle [--source <pack-directory>] --out <zip> --signing-key <seed-file>
           --source-repository <owner/repository> --source-commit <commit>
           --package-name <name> --package-version <semantic-version>
```

`transform` writes the selected target's agents and complete skills directly to
the documented project discovery locations. Claude output is
`<root>/.claude/agents/` plus `<root>/.claude/skills/`; Codex output is
`<root>/.codex/agents/` plus `<root>/.agents/skills/`. Each harness root stores
a tracked `.thor-generated.json` inventory of the files that `transform` owns.
`assets/` remains the only authoring source; the generated harness files are
reviewable snapshots that let a fresh clone exercise the pack through each
harness's normal discovery paths. On refresh, `transform` writes source-derived
paths, removes only inventory-listed paths, and preserves unrelated harness
files. It rejects a file at a required path when no inventory owns that path,
and it rejects symbolic links in a harness root, generated path, or
generated-path parent.

Before changing generated paths, `transform` atomically publishes a transition
inventory containing both the previously owned paths and the desired paths. It
writes and removes files while that inventory remains authoritative, then
atomically replaces it with the desired inventory. If the process stops during
either inventory replacement or a file mutation, rerunning `transform` with the
same source completes the change, while rerunning it after reverting the source
removes the interrupted addition. Both paths preserve files outside the
transition inventory.

`transform --check` compares the source-derived tree with the tracked snapshots
without writing files, so CI rejects stale generated definitions. The workflow
does not retain an intermediate `dist/` tree.

| Component | Responsibility |
|---|---|
| `PackParser` | Parses YAML and Markdown frontmatter, validates JSON Schema, enforces filename/identity rules, infers the common target set, and resolves each agent's target model/effort mapping. |
| `TargetAdapter` | One small implementation each for Claude Code and Codex; maps a resolved portable agent to target text. It is a compile-time extension point, not a runtime plugin system. |
| `BundleService` | Expands `SKILL.md`, copies other skill files byte-for-byte, writes the artifact manifest, calculates payload digests, and creates the bundle ZIP. |

### `thor`: native local lifecycle CLI

The released native `thor` binary handles only local lifecycle operations:

```text
thor <command>
├── init --repo <owner/repo> --ref <tag> --target <id|all>
│        --pack-key <ed25519-public-key-file> [--scope project|user]
│        [--allow-unknown-harness-version] [--root <absolute-path>]
├── update --repo <owner/repo> [--ref <tag>] [--target <id|all>] [--force]
│        [--scope project|user] [--allow-unknown-harness-version] [--root <absolute-path>]
├── uninstall --repo <owner/repo> [--target <id|all>] [--force]
│        [--scope project|user] [--root <absolute-path>]
└── status [--repo <owner/repo>] [--scope project|user] [--root <absolute-path>]
```

| Component | Responsibility |
|---|---|
| `ReleaseClient` | GitHub Release download using HTTPS and optional `GH_TOKEN` for private repositories. |
| `BundleVerifier` | Verifies the detached Ed25519 signature using the trusted pack key, validates compatibility and the manifest, rejects unsafe ZIPs, and verifies every payload digest before any write. |
| `InstallService` | Acquires the scope lock; stages files; detects ownership, unmanaged-file, and modification conflicts; applies a recoverable journal; and maintains per-pack state. |

Use `clap`, `serde`, `serde_yaml`, `serde_json`, `jsonschema`, `toml_edit`, `reqwest`, `sha2`, an Ed25519 crate, a ZIP crate, and a cross-platform file-lock crate. Keep Markdown-frontmatter parsing deliberately small and covered by fixtures rather than introducing an expansive rendering system. Avoid an embedded scripting runtime.

The Thor tool pipeline uses pinned-by-digest CI actions, a pinned Rust toolchain, a committed lockfile, clean release runners, and protected signing secrets. It runs `cargo fmt --check`, `cargo clippy -- -D warnings`, unit and property tests (including path and recovery tests), and `thor-build transform --check` before it signs a release. The check compares the source-derived harness outputs with the tracked snapshots. The pipeline also runs dependency/license vulnerability checks and reproducible-release checks. It builds `thor-build` on one supported Linux runner and builds the released `thor` binary in an operating-system/architecture matrix, using native macOS runners for macOS artifacts and a musl target for portable Linux where appropriate. The installed CLI is self-contained: its only external requirement is normal OS facilities for HTTPS and file access.

Do not introduce a database, daemon, external registry, dynamic plugin loading,
or source transformation code in the end-user `thor` lifecycle CLI.

## Build sequence

Build the smallest vertical slices in this order:

1. Create the workspace, canonical schema, strict Rust data types, frontmatter parser, and fixture-based validation tests.
2. Implement the two target adapters and golden tests for `inherit`, `read-only`, `workspace-write`, and every typed Claude-only setting.
3. Implement deterministic bundle creation, `SKILL.md` expansion, byte-for-byte opaque copying of every auxiliary skill file, manifest generation, and detached Ed25519 signing in `thor-build`.
4. Implement `thor init` read-only through verification first: release lookup, trusted-key signature check, compatibility check, ZIP hardening, and dry-run collision reporting.
5. Add journaled project and user installation, multi-pack state/locking, `status`, safe update, recovery, and uninstall tests.
6. Add the separate signed CLI release pipeline, bootstrap scripts, target-version compatibility matrix, and end-to-end release fixtures.

No lifecycle command should write a harness path until step 4's full verification path and step 5's recovery path are tested.

## Best-effort worker progress

Thor's Slicer and systemic-assurance prompts use a concise, best-effort `PROGRESS` update for work lasting roughly three minutes or more. The update is a 2x2: `CHANGE`, `CURRENT`, `ATTENTION`, and `NEXT`, with a structured health indicator and a short free-form phase such as `Architecture — deciding tenancy boundaries` or `Verification — exercising concurrent requests`.

The phase is deliberately descriptive rather than an enum. Recommended vocabulary is discovery, architecture, design, implementation, verification, lens review, remediation, systemic assurance, integration, and release readiness; it is not a Thor workflow state machine. `health` remains constrained to `on-track`, `waiting`, `blocked`, or `checkpoint-delayed`.

Progress is non-terminal operational communication. It neither creates durable repository state nor changes candidate certification, and it must never require an agent to interrupt a running command, write, transaction, migration, deployment, or external side effect. When a target runtime cannot deliver a non-terminal message, the worker supplies the same concise status when its owner requests it.

## Validation and acceptance criteria

- Each source agent is exactly one `assets/agents/<id>.md` file, and its filename must equal its `id`. A source agent may reference one build-time instruction template by identifier.
- Every source agent defines a concrete model and Codex-aligned effort for the same non-empty target set. Source agents do not reference shared model aliases.
- `thor-v1.schema.json` and strict Rust deserialization accept and reject the same fixtures, including unknown fields and invalid `targets` keys.
- Missing, invalid, unknown, or inconsistent target model mappings fail CI with the affected agent path.
- Every release contains identical skill file digests under `skills/` regardless of target.
- Pack CI refuses an unsigned/wrongly signed Thor tool release or a `thor-build` asset whose manifest digest differs, and source validation rejects unsafe skill files before packaging.
- Golden tests prove the complete generated Markdown and TOML for representative read-only and write-capable agents.
- Bootstrap tests cover OS/architecture selection, checksum failure, unsupported platforms, `THOR_BIN_DIR`, and a version-pinned install. The bootstrap never executes an agent-pack artifact.
- Pack-verification tests cover a wrong key, altered archive, altered manifest, unsupported format, too-new `minimumThorVersion`, absent/unsupported target, and incompatible or unknown harness versions.
- ZIP tests cover duplicate entries, traversal, absolute paths, links, oversized archives, destination symlinks, and manifest/payload disagreement.
- `init`, `update`, `status`, and `uninstall` test successful behavior, user modifications, unmanaged filename conflicts, same-name multi-pack conflicts, discovered Claude/Codex/skill identity conflicts, removed payloads, cross-volume interrupted staging/recovery, and multiple targets.
- A successful `uninstall` restores the target locations to their pre-install contents, apart from empty directories Thor itself created and removed.

## Standards basis

Claude Code defines subagents as Markdown files with YAML frontmatter and a Markdown system-prompt body. Codex defines a custom agent as a TOML configuration layer with required `name`, `description`, and `developer_instructions`. Both support model and reasoning configuration, but their non-shared controls differ; that is why Thor has a constrained portable core plus explicit per-agent target settings.

Skills remain `SKILL.md` directories following the Agent Skills open standard rather than becoming Thor YAML. This preserves their portability and lets Thor manage their lifecycle without owning their semantic format.

Relevant specifications: [Claude Code subagents](https://code.claude.com/docs/en/sub-agents), [OpenAI Docs: Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents), [OpenAI Docs: Codex skills](https://learn.chatgpt.com/docs/build-skills), and the [Agent Skills specification](https://openagentskills.dev/docs/specification).
