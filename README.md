# Thor

Thor defines a reusable subagent once, renders tracked Claude Code and Codex
dogfood snapshots, and packages verified release bundles in CI. End-user
machines install signed, prebuilt bundles; they never transform an agent pack
and do not need Rust, Java, or either harness's build tooling.

The normative design and source-format contract are in
[docs/design.md](docs/design.md).

## What it provides

- One portable agent definition per `assets/agents/<id>.md` file.
- Optional reusable `assets/definitions/<id>.md` bundles expanded by validated identifiers.
- Optional `assets/templates/<id>.md` wrappers for shared build-time instruction text.
- A small `assets/thor.yaml` manifest for package metadata plus global logical model
  mappings, each of which supplies target model and Codex-aligned effort.
- Pack-author rendering directly into Claude Code (`.md`) and Codex (`.toml`)
  project discovery directories for dogfooding.
- Standard `assets/skills/<name>/SKILL.md` directories with optional source-only
  definition expansion; every other skill file is copied byte-for-byte.
- Optional static files below `assets/.claude/` and `assets/.codex/`, copied
  unchanged below the matching harness root.
- Deterministic, signed agent-pack bundles and a native Rust `thor` lifecycle
  binary for verified install, update, status, recovery, and uninstall.

## Repository layout

- `assets/` — complete Thor pack source: manifest, agents, instruction templates, and skills.
- `schema/` — canonical versioned Thor JSON Schema.
- `crates/thor-core/` — strict source parsing, validation, skills handling,
  and target renderers.
- `crates/thor-build/` — pack-author validator, transformer, packager, and
  release-manifest signer.
- `crates/thor/` — native lifecycle installer; it does no transformation.
- `scripts/` — POSIX and PowerShell native-binary bootstraps.
- `.github/workflows/` — strict CI and manually dispatched signed CLI release
  automation.

## Author an agent pack

An agent-pack repository contains no installer code:

```text
my-pack/
└── assets/
    ├── thor.yaml
    ├── agents/
    │   └── pr-reviewer.md
    ├── definitions/
    │   └── review-terms.md
    ├── templates/
    │   └── reviewer.md
    ├── .codex/
    │   └── config.toml
    └── skills/
        └── review-checklist/
            └── SKILL.md
```

`assets/thor.yaml` owns the package-wide target list and logical model mappings; each
target mapping supplies both model and effort. Each agent owns its description,
instructions, model id, access profile, and allowed Claude-only settings. See the complete examples
and the Claude/Codex field mapping in [docs/design.md](docs/design.md).

Pack CI validates and creates a release bundle. It must supply the immutable
commit resolved from the release tag and a CI-held 32-byte Ed25519 signing seed
encoded as lowercase hex:

```bash
thor-build validate
thor-build bundle \
  --source assets \
  --out "$RUNNER_TEMP/thor-bundle-1.2.0.zip" \
  --signing-key "$THOR_PACK_SIGNING_KEY_FILE" \
  --source-repository acme/my-pack \
  --source-commit "$(git rev-parse HEAD)" \
  --claude-compatibility '>=1.0.0' \
  --codex-compatibility '>=0.0.0'
```

Publish only `thor-bundle-1.2.0.zip` and its generated `.sig` alongside the
immutable `v1.2.0` GitHub Release. The transformer refuses unsafe source files,
invalid mappings, unmanaged-path collisions, and unportable/case-colliding skill
paths.

## Dogfood the pack locally

Render the pack straight into this project's harness discovery locations:

```bash
cargo run --locked -p thor-build -- transform
```

This writes Claude agents and skills to `.claude/agents/` and `.claude/skills/`,
Codex agents and skills to `.codex/agents/` and `.agents/skills/`, expands only
source `SKILL.md` files, preserves every other skill file byte-for-byte, and copies
static files below `assets/.claude/` or `assets/.codex/` to the matching harness
root. Git tracks these generated definitions as reviewable dogfood snapshots;
`assets/` remains the only authoring source. Each harness root contains a generated
`.thor-generated.json` inventory. On later runs, the transformer refreshes
source-derived agents and skills and removes only paths listed in that inventory.
Static files overwrite their matching paths but are not removed automatically
when their source file disappears. The transformer preserves unrelated harness
files and rejects an untracked file at a generated agent or skill path.

CI verifies the tracked snapshots without modifying them:

```bash
cargo run --locked -p thor-build -- transform --check
```

## Install Thor

The release contains one native binary per supported OS/architecture. On macOS
or Linux, use a pinned release URL when reproducibility matters:

```bash
curl -fsSL https://github.com/acme/thor/releases/download/v0.1.0/install.sh | sh
```

The bootstrap selects the native binary, verifies its SHA-256 against
`SHA256SUMS`, and installs it to `~/.local/bin` (or `$THOR_BIN_DIR`). Set
`THOR_VERSION` or pass `--version` to select a release; set
`THOR_REPOSITORY`/`--repository` when publishing a fork. The convenience
latest-release form is also supported:

```bash
curl -fsSL https://github.com/acme/thor/releases/latest/download/install.sh | sh
```

On Windows, use the corresponding `install.ps1` from a versioned release:

```powershell
irm https://github.com/acme/thor/releases/download/v0.1.0/install.ps1 | iex
```

The small `curl | sh`/PowerShell bootstrap deliberately verifies a checksum
served from the same GitHub Release; its first use trusts the HTTPS-delivered
script and release. For stronger bootstrap provenance, use a version-pinned
URL plus a separately trusted verifier for `thor-release-manifest.json.sig`,
or distribute Thor with a package manager. This limitation does not apply to
agent packs: `thor init` verifies their detached Ed25519 signature using a
public key you explicitly trust.

## Install and manage a pack

```bash
# Project scope is the default and uses the current Git worktree.
thor init \
  --repo acme/my-pack \
  --ref v1.2.0 \
  --pack-key ./my-pack.ed25519.pub \
  --target all

# Select the greatest stable compatible signed release.
thor update --repo acme/my-pack

# Inspect release, targets, signing-key fingerprint, paths, and drift.
thor status --repo acme/my-pack

# Remove only files whose state inventory says Thor owns them.
thor uninstall --repo acme/my-pack
```

Project state lives in `.thor/` (which this repository's `.gitignore` ignores);
user state uses `$XDG_STATE_HOME/thor` or `~/.local/state/thor`. `--scope user`
installs into the user harness locations. The installer takes a scope lock,
checks existing harness-visible agent/skill names, verifies all signatures and
payload digests before changing configuration, journals replacements with
same-volume backups, and recovers an interrupted operation on the next command.

For a deliberately air-gapped release, `--bundle` additionally requires
`--signature` and `--offline-commit`; that commit must have been independently
verified as the immutable commit bound to the supplied release tag. Normal
operation resolves the GitHub tag itself and checks this binding.

## Build and verify Thor

Development requires the pinned Rust toolchain in
[rust-toolchain.toml](rust-toolchain.toml). Run from the repository root:

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo run --locked -p thor-build -- validate
cargo run --locked -p thor-build -- transform --check
```

The CI workflow runs these checks with Rust 1.97.1. The release workflow builds
native binaries, `thor-build` for Linux pack CI, bootstrap scripts,
`SHA256SUMS`, and a signed `thor-cli-release/v1` inventory. It accepts only an
existing immutable Git tag and requires the protected
`THOR_RELEASE_SIGNING_KEY` secret. Repository administrators must protect the
`v*` tag namespace so only the release process can create, update, or delete
those tags; `gh release create --verify-tag` confirms that a tag exists but
cannot make a mutable tag immutable.
