# Repository Guidelines

## Project Structure & Module Organization

Thor is a Rust workspace. `crates/thor-core/` contains the portable pack model,
validation, and Claude/Codex renderers; `crates/thor-build/` provides the
pack-author and CI validation, transformation, and signing CLI; and
`crates/thor/` is the verified install/update lifecycle CLI. Treat `assets/` as the pack source of
truth: `agents/<id>.md` defines agents and their target model settings, and
`skills/<name>/SKILL.md` contains skills. The versioned JSON Schema is in
`schema/`; design and format rules are documented in `docs/design.md`.

## Build, Test, and Development Commands

Use the pinned Rust 1.97.1 toolchain from `rust-toolchain.toml`.

```bash
cargo fmt --all -- --check                 # verify formatting
cargo clippy --workspace --all-targets -- -D warnings  # deny lint warnings
cargo test --workspace                      # run all Rust unit tests
cargo build --workspace                     # build all workspace binaries
cargo run --locked -p thor-build -- validate # validate assets/
sh scripts/test-install.sh                  # test POSIX bootstrap offline
```

On Windows, run `Invoke-Pester -Path scripts/install.Tests.ps1 -CI` to verify
the PowerShell bootstrap. Use `cargo +1.97.1` explicitly if another toolchain
is active locally.

## Coding Style & Naming Conventions

Follow `rustfmt`; use four-space indentation and let it choose Rust line
wrapping. Keep Rust APIs and tests in `snake_case`, types in `PascalCase`, and
constants in `SCREAMING_SNAKE_CASE`. Prefer explicit validation and contextual
errors at filesystem, archive, and network boundaries. Agent IDs, filenames,
and skill directories should use portable lowercase kebab-case (for example,
`security-reviewer.md`). Do not hand-edit target-specific generated artifacts;
update their source definition in `assets/` and use the build tooling.

## Testing Guidelines

Rust tests are co-located in each crate's `#[cfg(test)]` module and use
descriptive `snake_case` names that state the behavior under test. Add focused
tests for parser, validation, renderer, installer, or bootstrap changes;
exercise both successful and rejected input where security boundaries change.
There is no stated coverage threshold, but all workspace tests, strict Clippy,
formatting, and the relevant bootstrap test must pass before review.

## Commit & Pull Request Guidelines

Keep each commit narrowly scoped. PRs should explain the user-visible
or format impact, identify affected crates or assets, link an issue when one
exists, and list commands run. Include screenshots only when a visual output
changes; for CLI or installer changes, provide representative command output
instead.
