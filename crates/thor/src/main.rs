use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    fs::{File, OpenOptions},
    io::{Cursor, Read, Write},
    path::{Component, Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, anyhow, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use clap::{Parser, Subcommand, ValueEnum};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use fs2::FileExt;
use reqwest::blocking::Client;
use semver::{Version, VersionReq};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thor_core::{ArtifactManifest, Harness, SignatureEnvelope};
use zip::ZipArchive;

const CLI_VERSION: &str = env!("CARGO_PKG_VERSION");
const MAX_ZIP_ENTRIES: usize = 10_000;
const MAX_UNCOMPRESSED_BYTES: u64 = 100 * 1024 * 1024;

#[derive(Debug, Parser)]
#[command(
    name = "thor",
    about = "Thor verified agent-pack lifecycle tool",
    version
)]
struct Cli {
    #[command(subcommand)]
    command: CommandLine,
}

#[derive(Debug, Subcommand)]
enum CommandLine {
    /// Install a signed release into project or user harness locations.
    Init(InstallArgs),
    /// Replace selected managed files with a verified release.
    Update(UpdateArgs),
    /// Remove only files managed by the selected Thor pack.
    Uninstall(RemoveArgs),
    /// Report installed pack state and local file drift.
    Status(StatusArgs),
    /// Verify a bundle without writing configuration files.
    Verify(VerifyArgs),
}

#[derive(Debug, clap::Args)]
struct VerifyArgs {
    #[command(flatten)]
    release: ReleaseArgs,
    #[arg(long, value_enum, default_value_t = TargetArg::All)]
    target: TargetArg,
    #[arg(long)]
    allow_unknown_harness_version: bool,
}

#[derive(Debug, clap::Args)]
struct InstallArgs {
    #[command(flatten)]
    release: ReleaseArgs,
    #[command(flatten)]
    location: LocationArgs,
    #[arg(long, value_enum, default_value_t = TargetArg::All)]
    target: TargetArg,
    #[arg(long)]
    allow_unknown_harness_version: bool,
}

#[derive(Debug, clap::Args)]
struct UpdateArgs {
    #[command(flatten)]
    release: UpdateReleaseArgs,
    #[command(flatten)]
    location: LocationArgs,
    #[arg(long, value_enum, default_value_t = TargetArg::All)]
    target: TargetArg,
    #[arg(long)]
    allow_unknown_harness_version: bool,
    #[arg(long)]
    force: bool,
}

#[derive(Debug, clap::Args)]
struct RemoveArgs {
    #[arg(long)]
    repo: String,
    #[command(flatten)]
    location: LocationArgs,
    #[arg(long, value_enum, default_value_t = TargetArg::All)]
    target: TargetArg,
    #[arg(long)]
    force: bool,
}

#[derive(Debug, clap::Args)]
struct StatusArgs {
    #[arg(long)]
    repo: Option<String>,
    #[command(flatten)]
    location: LocationArgs,
}

#[derive(Debug, clap::Args)]
struct ReleaseArgs {
    /// GitHub owner/repository that owns the release.
    #[arg(long)]
    repo: String,
    /// Immutable GitHub release tag.
    #[arg(long)]
    r#ref: String,
    /// File containing the trusted 32-byte Ed25519 public key in hexadecimal.
    #[arg(long)]
    pack_key: PathBuf,
    /// Local bundle fixture or air-gapped release; requires --signature.
    #[arg(long)]
    bundle: Option<PathBuf>,
    /// Detached signature paired with --bundle.
    #[arg(long)]
    signature: Option<PathBuf>,
    /// Immutable commit independently verified to be bound to --ref in offline mode.
    #[arg(long)]
    offline_commit: Option<String>,
}

#[derive(Debug, clap::Args)]
struct UpdateReleaseArgs {
    #[arg(long)]
    repo: String,
    /// Explicit replacement tag. When absent, Thor selects the newest compatible stable release.
    #[arg(long)]
    r#ref: Option<String>,
    #[arg(long)]
    bundle: Option<PathBuf>,
    #[arg(long)]
    signature: Option<PathBuf>,
    /// Immutable commit independently verified to be bound to --ref in offline mode.
    #[arg(long)]
    offline_commit: Option<String>,
}

#[derive(Debug, clap::Args)]
struct LocationArgs {
    #[arg(long, value_enum, default_value_t = ScopeArg::Project)]
    scope: ScopeArg,
    /// Required outside a Git worktree; invalid for --scope user.
    #[arg(long)]
    root: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, ValueEnum, PartialEq, Eq)]
enum TargetArg {
    All,
    ClaudeCode,
    Codex,
}

#[derive(Debug, Clone, Copy, ValueEnum, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ScopeArg {
    Project,
    User,
}

#[derive(Debug, Clone)]
struct VerifiedBundle {
    manifest: ArtifactManifest,
    payloads: BTreeMap<String, Vec<u8>>,
    public_key_hex: String,
    key_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallState {
    format: String,
    repository: String,
    release_tag: String,
    source_commit: String,
    package_name: String,
    package_version: String,
    public_key: String,
    key_id: String,
    scope: ScopeArg,
    targets: Vec<Harness>,
    files: Vec<ManagedFile>,
    #[serde(default)]
    created_directories: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedFile {
    target: Harness,
    destination: String,
    sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransactionJournal {
    format: String,
    id: String,
    phase: String,
    operations: Vec<JournalOperation>,
    state: JournalState,
    #[serde(default)]
    created_directories: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JournalOperation {
    target: Harness,
    destination: String,
    backup: String,
    existed: bool,
    action: String,
    status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JournalState {
    destination: String,
    backup: String,
    existed: bool,
    status: String,
}

fn main() -> Result<()> {
    match Cli::parse().command {
        CommandLine::Verify(args) => {
            let release = acquire_release(&args.release)?;
            let bundle =
                verify_bundle(&release.archive, &release.signature, &args.release.pack_key)?;
            let targets = select_targets(&bundle.manifest, args.target, None)?;
            enforce_compatibility(
                &bundle.manifest,
                &targets,
                args.allow_unknown_harness_version,
            )?;
            println!(
                "verified {} {} at {}",
                bundle.manifest.package.name,
                bundle.manifest.package.version,
                bundle.manifest.source_commit
            );
        }
        CommandLine::Init(args) => init(args)?,
        CommandLine::Update(args) => update(args)?,
        CommandLine::Uninstall(args) => uninstall(args)?,
        CommandLine::Status(args) => status(args)?,
    }
    Ok(())
}

struct ReleaseBytes {
    archive: Vec<u8>,
    signature: Vec<u8>,
    resolved_commit: Option<String>,
}

fn acquire_release(args: &ReleaseArgs) -> Result<ReleaseBytes> {
    let repository = canonical_repository(&args.repo)?;
    if let Some(bundle) = &args.bundle {
        let signature = args
            .signature
            .as_ref()
            .ok_or_else(|| anyhow!("--signature is required with --bundle"))?;
        let offline_commit = args.offline_commit.as_deref().ok_or_else(|| {
            anyhow!(
                "--offline-commit is required with --bundle; verify the tag-to-commit binding before offline installation"
            )
        })?;
        validate_commit(offline_commit)?;
        return Ok(ReleaseBytes {
            archive: fs::read(bundle)
                .with_context(|| format!("cannot read {}", bundle.display()))?,
            signature: fs::read(signature)
                .with_context(|| format!("cannot read {}", signature.display()))?,
            resolved_commit: Some(offline_commit.to_owned()),
        });
    }
    if args.signature.is_some() || args.offline_commit.is_some() {
        bail!("--signature and --offline-commit may be used only with --bundle");
    }
    fetch_github_release(&repository, &args.r#ref)
}

fn init(args: InstallArgs) -> Result<()> {
    let release = acquire_release(&args.release)?;
    let bundle = verify_bundle(&release.archive, &release.signature, &args.release.pack_key)?;
    bind_release(
        &bundle,
        &args.release.repo,
        &args.release.r#ref,
        release.resolved_commit.as_deref(),
    )?;
    let location = resolve_location(&args.location)?;
    let targets = select_targets(&bundle.manifest, args.target, None)?;
    enforce_compatibility(
        &bundle.manifest,
        &targets,
        args.allow_unknown_harness_version,
    )?;
    let state_path = state_path(
        &location,
        &bundle.manifest.source_repository,
        &bundle.manifest.package.name,
    );
    let _lock = acquire_lock(&location)?;
    recover_transactions(&location)?;
    if state_path.exists() {
        bail!("pack is already installed; use thor update instead");
    }
    let (mut state, writes) = installation_plan(&bundle, location.scope, &location.root, &targets)?;
    reject_conflicts(&location, None, &[], &writes)?;
    apply_install(
        &location,
        &state_path,
        None,
        Some(&mut state),
        writes,
        &[],
        false,
    )?;
    println!("installed {} {}", state.package_name, state.package_version);
    Ok(())
}

fn update(args: UpdateArgs) -> Result<()> {
    let location = resolve_location(&args.location)?;
    let repository = canonical_repository(&args.release.repo)?;
    let _lock = acquire_lock(&location)?;
    recover_transactions(&location)?;
    let state_path = find_state_path(&location, &repository)?;
    let previous = read_state(&state_path)?;
    let (bundle, targets) = acquire_update_bundle(
        &args.release,
        &repository,
        &previous,
        args.target,
        args.allow_unknown_harness_version,
    )?;
    let (candidate, writes) = installation_plan(&bundle, location.scope, &location.root, &targets)?;
    let (mut state, deletes) = merge_update_state(candidate, &previous, &targets)?;
    reject_conflicts(&location, Some(&state_path), &previous.files, &writes)?;
    apply_install(
        &location,
        &state_path,
        Some(&previous),
        Some(&mut state),
        writes,
        &deletes,
        args.force,
    )?;
    println!(
        "updated {} to {}",
        state.package_name, state.package_version
    );
    Ok(())
}

fn merge_update_state(
    mut candidate: InstallState,
    previous: &InstallState,
    selected_targets: &[Harness],
) -> Result<(InstallState, Vec<ManagedFile>)> {
    let selected = selected_targets.iter().cloned().collect::<BTreeSet<_>>();
    let deletes = previous
        .files
        .iter()
        .filter(|file| {
            selected.contains(&file.target)
                && !candidate
                    .files
                    .iter()
                    .any(|next| next.destination == file.destination)
        })
        .cloned()
        .collect::<Vec<_>>();
    candidate.files.extend(
        previous
            .files
            .iter()
            .filter(|file| !selected.contains(&file.target))
            .cloned(),
    );
    candidate.created_directories = previous.created_directories.clone();
    candidate.targets = candidate
        .files
        .iter()
        .map(|file| file.target.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    candidate
        .files
        .sort_by(|left, right| left.destination.cmp(&right.destination));
    candidate
        .files
        .dedup_by(|left, right| left.destination == right.destination);
    validate_install_state(&candidate)?;
    Ok((candidate, deletes))
}

fn uninstall(args: RemoveArgs) -> Result<()> {
    let location = resolve_location(&args.location)?;
    let repository = canonical_repository(&args.repo)?;
    let _lock = acquire_lock(&location)?;
    recover_transactions(&location)?;
    let state_path = find_state_path(&location, &repository)?;
    let previous = read_state(&state_path)?;
    let mut state = previous.clone();
    let targets = select_state_targets(&state, args.target)?;
    let selected: BTreeSet<_> = targets.into_iter().collect();
    let deletes = state
        .files
        .iter()
        .filter(|file| selected.contains(&file.target))
        .cloned()
        .collect::<Vec<_>>();
    for file in &deletes {
        let path = safe_destination(&location.root, &file.target, &file.destination)?;
        if path.exists() && sha256_file(&path)? != file.sha256 && !args.force {
            bail!(
                "refusing to remove modified managed file {}; use --force",
                path.display()
            );
        }
    }
    state.files.retain(|file| !selected.contains(&file.target));
    state.targets.retain(|target| !selected.contains(target));
    if state.files.is_empty() {
        apply_install(
            &location,
            &state_path,
            Some(&previous),
            None,
            Vec::new(),
            &deletes,
            args.force,
        )?;
        remove_owned_empty_directories(&location, &previous.created_directories)?;
    } else {
        apply_install(
            &location,
            &state_path,
            Some(&previous),
            Some(&mut state),
            Vec::new(),
            &deletes,
            args.force,
        )?;
        remove_owned_empty_directories(&location, &state.created_directories)?;
    }
    println!("uninstalled selected targets for {}", repository);
    Ok(())
}

fn status(args: StatusArgs) -> Result<()> {
    let location = resolve_location(&args.location)?;
    let _lock = acquire_lock(&location)?;
    recover_transactions(&location)?;
    let states = all_install_states(&location)?;
    if states.is_empty() {
        println!("no Thor packs installed");
        return Ok(());
    }
    for (_, state) in states {
        if args.repo.as_deref().is_some_and(|repo| {
            canonical_repository(repo).ok().as_deref() != Some(state.repository.as_str())
        }) {
            continue;
        }
        let drift = state
            .files
            .iter()
            .filter(|file| {
                let path = safe_destination(&location.root, &file.target, &file.destination).ok();
                path.as_ref().is_none_or(|path| !path.is_file())
                    || path.and_then(|path| sha256_file(&path).ok()).as_deref()
                        != Some(file.sha256.as_str())
            })
            .count();
        println!(
            "{} {} {} tag={} commit={} targets={} key={} drift={}",
            state.repository,
            state.package_name,
            state.package_version,
            state.release_tag,
            state.source_commit,
            state
                .targets
                .iter()
                .map(Harness::as_str)
                .collect::<Vec<_>>()
                .join(","),
            state.key_id,
            drift
        );
        for file in &state.files {
            println!("  {} {}", file.target.as_str(), file.destination);
        }
    }
    Ok(())
}

fn verify_bundle(
    archive: &[u8],
    signature_bytes: &[u8],
    public_key_path: &Path,
) -> Result<VerifiedBundle> {
    let public_key_hex = fs::read_to_string(public_key_path)
        .with_context(|| format!("cannot read trusted key {}", public_key_path.display()))?
        .trim()
        .to_owned();
    verify_bundle_with_public_key(archive, signature_bytes, public_key_hex)
}

fn verify_bundle_with_public_key(
    archive: &[u8],
    signature_bytes: &[u8],
    public_key_hex: String,
) -> Result<VerifiedBundle> {
    let public_key = parse_public_key(&public_key_hex)?;
    let envelope: SignatureEnvelope =
        serde_json::from_slice(signature_bytes).context("detached signature is not valid JSON")?;
    if envelope.format != "thor-signature/v1" || envelope.algorithm != "ed25519" {
        bail!("unsupported signature format or algorithm");
    }
    let key_id = sha256_hex(public_key.as_bytes());
    if envelope.key_id != key_id {
        bail!("signature key id does not match the trusted public key");
    }
    let signature_bytes = BASE64
        .decode(envelope.signature)
        .context("signature is not base64")?;
    let signature =
        Signature::from_slice(&signature_bytes).context("signature has invalid length")?;
    public_key
        .verify(archive, &signature)
        .context("bundle signature verification failed")?;

    let mut zip =
        ZipArchive::new(Cursor::new(archive)).context("bundle is not a valid ZIP archive")?;
    if zip.len() > MAX_ZIP_ENTRIES {
        bail!("bundle contains too many ZIP entries");
    }
    let mut files = BTreeMap::new();
    let mut portable_paths = BTreeMap::new();
    let mut total_size = 0u64;
    for index in 0..zip.len() {
        let mut file = zip.by_index(index).context("cannot read ZIP entry")?;
        let path = file.name().to_owned();
        validate_archive_path(&path)?;
        insert_portable_archive_path(&mut portable_paths, &path)?;
        if file.is_dir()
            || file
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            bail!("bundle ZIP may contain files only; invalid entry {path}");
        }
        total_size = total_size
            .checked_add(file.size())
            .ok_or_else(|| anyhow!("bundle size overflow"))?;
        if total_size > MAX_UNCOMPRESSED_BYTES {
            bail!("bundle exceeds uncompressed size limit");
        }
        let mut bytes = Vec::with_capacity(file.size() as usize);
        file.read_to_end(&mut bytes)
            .with_context(|| format!("cannot read {path}"))?;
        if files.insert(path.clone(), bytes).is_some() {
            bail!("bundle contains duplicate ZIP entry {path}");
        }
    }
    let manifest_bytes = files
        .remove("manifest.json")
        .ok_or_else(|| anyhow!("bundle lacks manifest.json"))?;
    let manifest: ArtifactManifest =
        serde_json::from_slice(&manifest_bytes).context("bundle manifest is invalid JSON")?;
    validate_artifact_manifest(&manifest)?;
    if manifest.payloads.len() != files.len() {
        bail!("bundle manifest payload inventory does not match ZIP entries");
    }
    for (path, payload) in &manifest.payloads {
        validate_payload_path(path)?;
        let bytes = files
            .get(path)
            .ok_or_else(|| anyhow!("manifest payload {path} is missing from ZIP"))?;
        if payload.bytes != bytes.len() as u64 || payload.sha256 != sha256_hex(bytes) {
            bail!("manifest digest does not match payload {path}");
        }
    }
    for path in files.keys() {
        if !manifest.payloads.contains_key(path) {
            bail!("ZIP entry {path} is not declared by the manifest");
        }
    }
    Ok(VerifiedBundle {
        manifest,
        payloads: files,
        public_key_hex,
        key_id,
    })
}

fn parse_public_key(encoded: &str) -> Result<VerifyingKey> {
    let bytes = hex::decode(encoded).context("trusted public key must be hexadecimal")?;
    let bytes: [u8; 32] = bytes
        .try_into()
        .map_err(|_: Vec<u8>| anyhow!("trusted public key must contain exactly 32 bytes"))?;
    VerifyingKey::from_bytes(&bytes).context("trusted public key is invalid")
}

fn validate_artifact_manifest(manifest: &ArtifactManifest) -> Result<()> {
    if manifest.format != "thor-bundle/v1" {
        bail!("unsupported bundle format {}", manifest.format);
    }
    let minimum = Version::parse(&manifest.minimum_thor_version)
        .context("manifest minimumThorVersion is invalid")?;
    if minimum > Version::parse(CLI_VERSION).expect("package version is valid semver") {
        bail!(
            "bundle requires Thor {} or newer",
            manifest.minimum_thor_version
        );
    }
    canonical_repository(&manifest.source_repository)?;
    if !manifest.source_release_tag.starts_with('v')
        || manifest.source_release_tag[1..] != manifest.package.version
    {
        bail!("manifest sourceReleaseTag must equal v<package version>");
    }
    validate_commit(&manifest.source_commit)?;
    if manifest.targets.is_empty()
        || manifest.targets.len() != manifest.targets.iter().collect::<BTreeSet<_>>().len()
    {
        bail!("manifest targets must be non-empty and unique");
    }
    for target in &manifest.targets {
        let range = manifest
            .harness_compatibility
            .get(target)
            .ok_or_else(|| anyhow!("manifest lacks compatibility for {}", target.as_str()))?;
        VersionReq::parse(range).with_context(|| {
            format!("manifest compatibility for {} is invalid", target.as_str())
        })?;
    }
    Ok(())
}

fn validate_archive_path(path: &str) -> Result<()> {
    if path.is_empty()
        || path.starts_with('/')
        || path.contains('\\')
        || path
            .split('/')
            .any(|component| component.is_empty() || matches!(component, "." | ".."))
    {
        bail!("bundle contains unsafe ZIP path {path:?}");
    }
    Ok(())
}

fn insert_portable_archive_path(paths: &mut BTreeMap<String, String>, path: &str) -> Result<()> {
    let mut prefix = Vec::new();
    for component in path.split('/') {
        prefix.push(component);
        let raw = prefix.join("/");
        let folded = raw.to_ascii_lowercase();
        if let Some(previous) = paths.get(&folded)
            && previous != &raw
        {
            bail!("bundle contains paths that collide on a case-insensitive filesystem: {path}");
        }
        paths.insert(folded, raw);
    }
    Ok(())
}

fn validate_payload_path(path: &str) -> Result<()> {
    validate_archive_path(path)?;
    let pieces = path.split('/').collect::<Vec<_>>();
    match pieces.as_slice() {
        ["targets", "claude-code", "agents", filename] if filename.ends_with(".md") => {
            validate_identifier(&filename[..filename.len() - 3])
        }
        ["targets", "codex", "agents", filename] if filename.ends_with(".toml") => {
            validate_identifier(&filename[..filename.len() - 5])
        }
        ["skills", skill, rest @ ..] if !rest.is_empty() => {
            validate_identifier(skill)?;
            if rest.iter().all(|component| portable_component(component)) {
                Ok(())
            } else {
                bail!("bundle contains non-portable skill payload path {path}")
            }
        }
        _ => bail!("bundle payload path is outside the allowed layout: {path}"),
    }
}

fn validate_identifier(value: &str) -> Result<()> {
    let valid = (1..=64).contains(&value.len())
        && value.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && portable_component(value);
    if !valid {
        bail!("invalid portable identifier {value:?}");
    }
    Ok(())
}

fn portable_component(component: &str) -> bool {
    let stem = component
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    !component.is_empty()
        && component.len() <= 128
        && !component.ends_with('.')
        && component
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        && !matches!(
            stem.as_str(),
            "CON"
                | "PRN"
                | "AUX"
                | "NUL"
                | "COM1"
                | "COM2"
                | "COM3"
                | "COM4"
                | "COM5"
                | "COM6"
                | "COM7"
                | "COM8"
                | "COM9"
                | "LPT1"
                | "LPT2"
                | "LPT3"
                | "LPT4"
                | "LPT5"
                | "LPT6"
                | "LPT7"
                | "LPT8"
                | "LPT9"
        )
}

fn bind_release(
    bundle: &VerifiedBundle,
    repo: &str,
    release_tag: &str,
    resolved_commit: Option<&str>,
) -> Result<()> {
    let repository = canonical_repository(repo)?;
    if bundle.manifest.source_repository != repository
        || bundle.manifest.source_release_tag != release_tag
    {
        bail!("signed bundle repository or release tag does not match the requested release");
    }
    if let Some(commit) = resolved_commit
        && bundle.manifest.source_commit != commit
    {
        bail!("signed bundle source commit does not match the GitHub release tag");
    }
    Ok(())
}

fn enforce_compatibility(
    manifest: &ArtifactManifest,
    targets: &[Harness],
    allow_unknown: bool,
) -> Result<()> {
    for target in targets {
        let requirement = VersionReq::parse(
            manifest
                .harness_compatibility
                .get(target)
                .expect("verified manifest includes selected target"),
        )?;
        match detect_harness_version(target) {
            Some(version) if !requirement.matches(&version) => bail!(
                "{} version {} does not satisfy bundle requirement {}",
                target.as_str(),
                version,
                requirement
            ),
            Some(_) => {}
            None if !allow_unknown => bail!(
                "cannot determine {} version; retry with --allow-unknown-harness-version to acknowledge this",
                target.as_str()
            ),
            None => {}
        }
    }
    Ok(())
}

fn detect_harness_version(target: &Harness) -> Option<Version> {
    let binary = match target {
        Harness::ClaudeCode => "claude",
        Harness::Codex => "codex",
    };
    let output = Command::new(binary).arg("--version").output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    text.split(|character: char| {
        !(character.is_ascii_alphanumeric() || character == '.' || character == '-')
    })
    .find_map(|token| Version::parse(token.trim_start_matches('v')).ok())
}

fn canonical_repository(value: &str) -> Result<String> {
    let normalized = value
        .strip_prefix("https://github.com/")
        .unwrap_or(value)
        .strip_suffix(".git")
        .unwrap_or_else(|| value.strip_prefix("https://github.com/").unwrap_or(value));
    let (owner, repository) = normalized
        .split_once('/')
        .ok_or_else(|| anyhow!("repository must be owner/repository or a GitHub HTTPS URL"))?;
    if owner.is_empty()
        || repository.is_empty()
        || repository.contains('/')
        || !owner
            .bytes()
            .chain(repository.bytes())
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        bail!("repository must be owner/repository or a GitHub HTTPS URL");
    }
    if normalized != format!("{owner}/{repository}") {
        bail!("repository must not contain a path beyond owner/repository");
    }
    Ok(format!("{owner}/{repository}").to_ascii_lowercase())
}

fn validate_commit(commit: &str) -> Result<()> {
    if matches!(commit.len(), 40 | 64)
        && commit
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        bail!("source commit must be an exact 40- or 64-character lowercase hexadecimal id")
    }
}

#[derive(Debug, Clone, Deserialize)]
struct GithubRelease {
    #[serde(default)]
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    assets: Vec<GithubAsset>,
}

#[derive(Debug, Clone, Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Debug, Deserialize)]
struct GithubRef {
    object: GithubObject,
}

#[derive(Debug, Deserialize)]
struct GithubTag {
    object: GithubObject,
}

#[derive(Debug, Deserialize)]
struct GithubObject {
    sha: String,
    #[serde(rename = "type")]
    kind: String,
}

fn fetch_github_release(repository: &str, tag: &str) -> Result<ReleaseBytes> {
    let client = github_client()?;
    let release_url = format!("https://api.github.com/repos/{repository}/releases/tags/{tag}");
    let release: GithubRelease = client
        .get(&release_url)
        .send()
        .with_context(|| format!("cannot query {release_url}"))?
        .error_for_status()
        .with_context(|| format!("GitHub release {repository}@{tag} was not found"))?
        .json()
        .context("cannot parse GitHub release metadata")?;
    let version = tag.strip_prefix('v').unwrap_or(tag);
    let bundle_name = format!("thor-bundle-{version}.zip");
    let signature_name = format!("{bundle_name}.sig");
    let bundle = release
        .assets
        .iter()
        .find(|asset| asset.name == bundle_name)
        .ok_or_else(|| anyhow!("release lacks {bundle_name}"))?;
    let signature = release
        .assets
        .iter()
        .find(|asset| asset.name == signature_name)
        .ok_or_else(|| anyhow!("release lacks {signature_name}"))?;
    let archive = github_download(&client, &bundle.browser_download_url)?;
    let signature = github_download(&client, &signature.browser_download_url)?;
    let resolved_commit = resolve_tag_commit(&client, repository, tag)?;
    Ok(ReleaseBytes {
        archive,
        signature,
        resolved_commit: Some(resolved_commit),
    })
}

fn acquire_update_bundle(
    args: &UpdateReleaseArgs,
    repository: &str,
    previous: &InstallState,
    requested: TargetArg,
    allow_unknown: bool,
) -> Result<(VerifiedBundle, Vec<Harness>)> {
    if args.bundle.is_none() && args.r#ref.is_none() {
        return latest_compatible_release(repository, previous, requested, allow_unknown);
    }
    let release_tag = args.r#ref.as_deref().unwrap_or(&previous.release_tag);
    let release_args = ReleaseArgs {
        repo: repository.to_owned(),
        r#ref: release_tag.to_owned(),
        pack_key: PathBuf::new(),
        bundle: args.bundle.clone(),
        signature: args.signature.clone(),
        offline_commit: args.offline_commit.clone(),
    };
    let release = acquire_release(&release_args)?;
    let bundle = verify_bundle_with_public_key(
        &release.archive,
        &release.signature,
        previous.public_key.clone(),
    )?;
    validate_update_candidate(
        &bundle,
        repository,
        release_tag,
        release.resolved_commit.as_deref(),
        previous,
        requested,
        allow_unknown,
    )
}

fn latest_compatible_release(
    repository: &str,
    previous: &InstallState,
    requested: TargetArg,
    allow_unknown: bool,
) -> Result<(VerifiedBundle, Vec<Harness>)> {
    let client = github_client()?;
    let releases = collect_release_pages(|page| {
        let releases_url =
            format!("https://api.github.com/repos/{repository}/releases?per_page=100&page={page}");
        client
            .get(&releases_url)
            .send()
            .with_context(|| format!("cannot query {releases_url}"))?
            .error_for_status()
            .context("cannot list GitHub releases")?
            .json()
            .context("cannot parse GitHub release list")
    })?;
    for tag in stable_release_tags(releases) {
        let Ok(release) = fetch_github_release(repository, &tag) else {
            continue;
        };
        let Ok(bundle) = verify_bundle_with_public_key(
            &release.archive,
            &release.signature,
            previous.public_key.clone(),
        ) else {
            continue;
        };
        if let Ok(candidate) = validate_update_candidate(
            &bundle,
            repository,
            &tag,
            release.resolved_commit.as_deref(),
            previous,
            requested,
            allow_unknown,
        ) {
            return Ok(candidate);
        }
    }
    bail!("no stable compatible release is available for the installed pack")
}

fn collect_release_pages<F>(mut fetch: F) -> Result<Vec<GithubRelease>>
where
    F: FnMut(u32) -> Result<Vec<GithubRelease>>,
{
    let mut releases = Vec::new();
    let mut page = 1u32;
    loop {
        let batch = fetch(page)?;
        let complete = batch.len() < 100;
        releases.extend(batch);
        if complete {
            return Ok(releases);
        }
        page = page
            .checked_add(1)
            .ok_or_else(|| anyhow!("GitHub release page number overflow"))?;
    }
}

fn stable_release_tags(releases: Vec<GithubRelease>) -> Vec<String> {
    let mut tags = releases
        .into_iter()
        .filter(|release| !release.draft && !release.prerelease)
        .filter_map(|release| {
            let version = Version::parse(
                release
                    .tag_name
                    .strip_prefix('v')
                    .unwrap_or(&release.tag_name),
            )
            .ok()?;
            version
                .pre
                .is_empty()
                .then_some((version, release.tag_name))
        })
        .collect::<Vec<_>>();
    tags.sort_by(|left, right| right.0.cmp(&left.0));
    tags.into_iter().map(|(_, tag)| tag).collect()
}

fn validate_update_candidate(
    bundle: &VerifiedBundle,
    repository: &str,
    release_tag: &str,
    resolved_commit: Option<&str>,
    previous: &InstallState,
    requested: TargetArg,
    allow_unknown: bool,
) -> Result<(VerifiedBundle, Vec<Harness>)> {
    bind_release(bundle, repository, release_tag, resolved_commit)?;
    if bundle.public_key_hex != previous.public_key
        || bundle.manifest.package.name != previous.package_name
    {
        bail!("replacement release does not match the installed pack identity");
    }
    let targets = select_targets(&bundle.manifest, requested, Some(&previous.targets))?;
    enforce_compatibility(&bundle.manifest, &targets, allow_unknown)?;
    Ok((bundle.clone(), targets))
}

fn github_client() -> Result<Client> {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::ACCEPT,
        "application/vnd.github+json".parse()?,
    );
    if let Ok(token) = env::var("GH_TOKEN") {
        headers.insert(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {token}").parse()?,
        );
    }
    Client::builder()
        .user_agent(format!("thor/{CLI_VERSION}"))
        .default_headers(headers)
        .build()
        .context("cannot construct GitHub HTTP client")
}

fn github_download(client: &Client, url: &str) -> Result<Vec<u8>> {
    let response = client
        .get(url)
        .send()
        .with_context(|| format!("cannot download {url}"))?
        .error_for_status()
        .with_context(|| format!("download failed for {url}"))?;
    let bytes = response.bytes().context("cannot read release asset")?;
    if bytes.len() as u64 > MAX_UNCOMPRESSED_BYTES {
        bail!("release asset exceeds Thor's bundle size limit");
    }
    Ok(bytes.to_vec())
}

fn resolve_tag_commit(client: &Client, repository: &str, tag: &str) -> Result<String> {
    let mut object: GithubObject = client
        .get(format!(
            "https://api.github.com/repos/{repository}/git/ref/tags/{tag}"
        ))
        .send()
        .context("cannot resolve GitHub tag")?
        .error_for_status()
        .context("GitHub tag was not found")?
        .json::<GithubRef>()
        .context("cannot parse GitHub tag reference")?
        .object;
    for _ in 0..5 {
        if object.kind == "commit" {
            validate_commit(&object.sha)?;
            return Ok(object.sha);
        }
        if object.kind != "tag" {
            bail!("GitHub tag did not resolve to a commit");
        }
        object = client
            .get(format!(
                "https://api.github.com/repos/{repository}/git/tags/{}",
                object.sha
            ))
            .send()
            .context("cannot dereference annotated Git tag")?
            .error_for_status()
            .context("annotated Git tag was not found")?
            .json::<GithubTag>()
            .context("cannot parse annotated Git tag")?
            .object;
    }
    bail!("GitHub tag nesting exceeds Thor's safety limit")
}

struct InstallLocation {
    scope: ScopeArg,
    root: PathBuf,
    state_root: PathBuf,
}

fn resolve_location(args: &LocationArgs) -> Result<InstallLocation> {
    match args.scope {
        ScopeArg::Project => {
            let root = if let Some(root) = &args.root {
                if !root.is_absolute() {
                    bail!("--root must be an absolute path");
                }
                root.clone()
            } else {
                let output = Command::new("git")
                    .args(["rev-parse", "--show-toplevel"])
                    .output()
                    .context("cannot locate project root; use --root outside a Git worktree")?;
                if !output.status.success() {
                    bail!("cannot locate project root; use --root outside a Git worktree");
                }
                PathBuf::from(
                    String::from_utf8(output.stdout)
                        .context("Git returned a non-UTF-8 root")?
                        .trim(),
                )
            };
            ensure_real_directory(&root, "project root")?;
            Ok(InstallLocation {
                scope: ScopeArg::Project,
                state_root: root.join(".thor"),
                root,
            })
        }
        ScopeArg::User => {
            if args.root.is_some() {
                bail!("--root is invalid with --scope user");
            }
            let root = home_directory()?;
            ensure_real_directory(&root, "home directory")?;
            let state_root = env::var_os("XDG_STATE_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| root.join(".local/state"))
                .join("thor");
            Ok(InstallLocation {
                scope: ScopeArg::User,
                root,
                state_root,
            })
        }
    }
}

fn home_directory() -> Result<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("cannot determine the user home directory"))
}

fn state_root(location: &InstallLocation) -> PathBuf {
    location.state_root.clone()
}

fn state_path(location: &InstallLocation, repository: &str, package_name: &str) -> PathBuf {
    state_root(location)
        .join("installs")
        .join(format!("{}.json", pack_id(repository, package_name)))
}

fn find_state_path(location: &InstallLocation, repository: &str) -> Result<PathBuf> {
    let mut matching = Vec::new();
    for (path, state) in all_install_states(location)? {
        if state.repository == repository {
            matching.push(path);
        }
    }
    match matching.as_slice() {
        [path] => Ok(path.clone()),
        [] => bail!("no Thor pack state exists for {repository}"),
        _ => bail!(
            "multiple Thor packages use repository {repository}; specify package support is not yet available"
        ),
    }
}

fn pack_id(repository: &str, package_name: &str) -> String {
    sha256_hex(format!("{repository}\0{package_name}").as_bytes())[..32].to_owned()
}

fn acquire_lock(location: &InstallLocation) -> Result<File> {
    ensure_directory_tree(&state_root(location))?;
    let lock_path = state_root(location).join("install.lock");
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)
        .with_context(|| format!("cannot open {}", lock_path.display()))?;
    file.lock_exclusive()
        .context("cannot lock Thor installation scope")?;
    Ok(file)
}

fn read_state(path: impl AsRef<Path>) -> Result<InstallState> {
    let path = path.as_ref();
    let bytes = fs::read(path).with_context(|| format!("cannot read {}", path.display()))?;
    let state: InstallState = serde_json::from_slice(&bytes)
        .with_context(|| format!("invalid state {}", path.display()))?;
    if state.format != "thor-install/v1" {
        bail!("unsupported install-state format at {}", path.display());
    }
    validate_install_state(&state)?;
    Ok(state)
}

fn validate_install_state(state: &InstallState) -> Result<()> {
    let repository = canonical_repository(&state.repository)?;
    if repository != state.repository {
        bail!("install state repository is not canonical");
    }
    validate_commit(&state.source_commit)?;
    Version::parse(&state.package_version).context("install state package version is invalid")?;
    if state.release_tag != format!("v{}", state.package_version) {
        bail!("install state release tag does not match package version");
    }
    let key = parse_public_key(&state.public_key)?;
    if state.key_id != sha256_hex(key.as_bytes()) {
        bail!("install state public key fingerprint is invalid");
    }
    let targets = state.targets.iter().collect::<BTreeSet<_>>();
    if targets.len() != state.targets.len() || targets.is_empty() {
        bail!("install state targets are invalid");
    }
    let mut destinations = BTreeSet::new();
    let mut file_targets = BTreeSet::new();
    for file in &state.files {
        if file.sha256.len() != 64
            || !file
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            bail!("install state contains an invalid file digest");
        }
        validate_destination(&file.target, &file.destination)?;
        if !destinations.insert(&file.destination) {
            bail!(
                "install state contains duplicate destination {}",
                file.destination
            );
        }
        file_targets.insert(&file.target);
    }
    if file_targets != targets {
        bail!("install state target list does not match its file inventory");
    }
    let mut created = BTreeSet::new();
    for directory in &state.created_directories {
        validate_created_directory(directory)?;
        if !created.insert(directory) {
            bail!("install state contains duplicate created directory");
        }
    }
    Ok(())
}

fn safe_destination(root: &Path, target: &Harness, destination: &str) -> Result<PathBuf> {
    validate_destination(target, destination)?;
    ensure_real_directory(root, "installation root")?;
    let mut path = root.to_path_buf();
    for component in Path::new(destination).components() {
        let Component::Normal(component) = component else {
            bail!("managed destination is not normalized");
        };
        path.push(component);
    }
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("managed destination has no parent"))?;
    let mut check = root.to_path_buf();
    for component in parent
        .strip_prefix(root)
        .expect("parent is below root")
        .components()
    {
        let Component::Normal(component) = component else {
            bail!("managed parent is invalid")
        };
        check.push(component);
        if check.exists() {
            ensure_real_directory(&check, "managed destination parent")?;
        }
    }
    Ok(path)
}

fn validate_destination(target: &Harness, destination: &str) -> Result<()> {
    validate_relative_path(destination)?;
    let expected_agents = match target {
        Harness::ClaudeCode => ".claude/agents/",
        Harness::Codex => ".codex/agents/",
    };
    let expected_skills = match target {
        Harness::ClaudeCode => ".claude/skills/",
        Harness::Codex => ".agents/skills/",
    };
    if let Some(filename) = destination.strip_prefix(expected_agents) {
        let extension = if matches!(target, Harness::ClaudeCode) {
            ".md"
        } else {
            ".toml"
        };
        let Some(identifier) = filename.strip_suffix(extension) else {
            bail!("managed agent has an invalid extension")
        };
        if identifier.is_empty() || identifier.contains('/') {
            bail!("managed agent destination must be flat");
        }
        return validate_identifier(identifier);
    }
    if let Some(skill) = destination.strip_prefix(expected_skills)
        && skill.split('/').all(portable_component)
    {
        return Ok(());
    }
    bail!("managed destination is outside the target layout: {destination}")
}

fn validate_relative_path(value: &str) -> Result<()> {
    if value.is_empty()
        || value.starts_with('/')
        || value.contains('\\')
        || value
            .split('/')
            .any(|part| part.is_empty() || matches!(part, "." | ".."))
    {
        bail!("path is not normalized and relative: {value:?}");
    }
    Ok(())
}

fn select_targets(
    manifest: &ArtifactManifest,
    requested: TargetArg,
    previous: Option<&[Harness]>,
) -> Result<Vec<Harness>> {
    let available = &manifest.targets;
    let selected = match requested {
        TargetArg::All => previous.map_or_else(|| available.clone(), ToOwned::to_owned),
        TargetArg::ClaudeCode => vec![Harness::ClaudeCode],
        TargetArg::Codex => vec![Harness::Codex],
    };
    if selected.is_empty() || selected.iter().any(|target| !available.contains(target)) {
        bail!("selected target is not supported by this bundle");
    }
    let mut selected = selected;
    selected.sort();
    selected.dedup();
    Ok(selected)
}

fn select_state_targets(state: &InstallState, requested: TargetArg) -> Result<Vec<Harness>> {
    let selected = match requested {
        TargetArg::All => state.targets.clone(),
        TargetArg::ClaudeCode => vec![Harness::ClaudeCode],
        TargetArg::Codex => vec![Harness::Codex],
    };
    if selected
        .iter()
        .any(|target| !state.targets.contains(target))
    {
        bail!("selected target is not installed for this pack");
    }
    Ok(selected)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum VisibleKind {
    Agent,
    Skill,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct VisibleDefinition {
    target: Harness,
    kind: VisibleKind,
    name: String,
}

fn reject_conflicts(
    location: &InstallLocation,
    current_state_path: Option<&Path>,
    current_files: &[ManagedFile],
    writes: &[PendingWrite],
) -> Result<()> {
    let candidates = visible_definitions_from_writes(writes)?;
    let mut unique = BTreeSet::new();
    for definition in &candidates {
        if !unique.insert(definition) {
            bail!(
                "bundle defines duplicate visible {} name {} for {}",
                visible_kind_name(definition.kind),
                definition.name,
                definition.target.as_str()
            );
        }
    }
    let candidate_destinations = writes
        .iter()
        .map(|write| write.destination.as_str())
        .collect::<BTreeSet<_>>();
    for (path, state) in all_install_states(location)? {
        if current_state_path.is_some_and(|current| current == path) {
            continue;
        }
        for file in &state.files {
            if candidate_destinations.contains(file.destination.as_str()) {
                bail!(
                    "destination {} is owned by another Thor pack",
                    file.destination
                );
            }
            if let Some(definition) = visible_definition_from_managed(file)?
                && unique.contains(&definition)
            {
                bail!(
                    "visible {} name {} for {} is owned by another Thor pack",
                    visible_kind_name(definition.kind),
                    definition.name,
                    definition.target.as_str()
                );
            }
        }
    }
    let mut own_paths = BTreeSet::new();
    for file in current_files {
        own_paths.insert(safe_destination(
            &location.root,
            &file.target,
            &file.destination,
        )?);
    }
    for root in discovery_roots(location)? {
        for (path, definition) in scan_discovery_root(&root, &candidates)? {
            if own_paths.contains(&path) {
                continue;
            }
            if unique.contains(&definition) {
                bail!(
                    "visible {} name {} for {} is already supplied by unmanaged configuration at {}",
                    visible_kind_name(definition.kind),
                    definition.name,
                    definition.target.as_str(),
                    path.display()
                );
            }
        }
    }
    Ok(())
}

fn all_install_states(location: &InstallLocation) -> Result<Vec<(PathBuf, InstallState)>> {
    let installs = state_root(location).join("installs");
    if !installs.exists() {
        return Ok(Vec::new());
    }
    ensure_real_directory(&installs, "install-state directory")?;
    let mut paths = fs::read_dir(&installs)
        .with_context(|| format!("cannot read {}", installs.display()))?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<std::result::Result<Vec<_>, _>>()?;
    paths.sort();
    let mut states = Vec::new();
    for path in paths {
        ensure_regular_file(&path, "install-state entry")?;
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            bail!(
                "install-state entry {} does not end in .json",
                path.display()
            );
        }
        let state = read_state(&path)?;
        if state.scope != location.scope {
            bail!("install-state scope does not match its location");
        }
        states.push((path, state));
    }
    Ok(states)
}

fn visible_definitions_from_writes(writes: &[PendingWrite]) -> Result<Vec<VisibleDefinition>> {
    writes
        .iter()
        .filter_map(|write| visible_definition_from_payload(write).transpose())
        .collect()
}

fn visible_definition_from_payload(write: &PendingWrite) -> Result<Option<VisibleDefinition>> {
    let agent_prefix = match write.target {
        Harness::ClaudeCode => ".claude/agents/",
        Harness::Codex => ".codex/agents/",
    };
    if write.destination.starts_with(agent_prefix) {
        let name = match write.target {
            Harness::ClaudeCode => parse_markdown_name(&write.bytes, "agent")?,
            Harness::Codex => parse_toml_name(&write.bytes, "agent")?,
        };
        return Ok(Some(VisibleDefinition {
            target: write.target.clone(),
            kind: VisibleKind::Agent,
            name,
        }));
    }
    let skill_root = match write.target {
        Harness::ClaudeCode => ".claude/skills/",
        Harness::Codex => ".agents/skills/",
    };
    if let Some(rest) = write.destination.strip_prefix(skill_root)
        && rest.split('/').count() == 2
        && rest.ends_with("/SKILL.md")
    {
        return Ok(Some(VisibleDefinition {
            target: write.target.clone(),
            kind: VisibleKind::Skill,
            name: parse_markdown_name(&write.bytes, "skill")?,
        }));
    }
    Ok(None)
}

fn visible_definition_from_managed(file: &ManagedFile) -> Result<Option<VisibleDefinition>> {
    let agent_prefix = match file.target {
        Harness::ClaudeCode => ".claude/agents/",
        Harness::Codex => ".codex/agents/",
    };
    if let Some(filename) = file.destination.strip_prefix(agent_prefix) {
        let extension = if matches!(file.target, Harness::ClaudeCode) {
            ".md"
        } else {
            ".toml"
        };
        let name = filename
            .strip_suffix(extension)
            .ok_or_else(|| anyhow!("managed agent has invalid extension"))?;
        return Ok(Some(VisibleDefinition {
            target: file.target.clone(),
            kind: VisibleKind::Agent,
            name: name.to_owned(),
        }));
    }
    let skill_root = match file.target {
        Harness::ClaudeCode => ".claude/skills/",
        Harness::Codex => ".agents/skills/",
    };
    if let Some(rest) = file.destination.strip_prefix(skill_root) {
        let skill = rest.split('/').next().unwrap_or_default();
        validate_identifier(skill)?;
        return Ok(Some(VisibleDefinition {
            target: file.target.clone(),
            kind: VisibleKind::Skill,
            name: skill.to_owned(),
        }));
    }
    Ok(None)
}

fn visible_kind_name(kind: VisibleKind) -> &'static str {
    match kind {
        VisibleKind::Agent => "agent",
        VisibleKind::Skill => "skill",
    }
}

fn discovery_roots(location: &InstallLocation) -> Result<Vec<PathBuf>> {
    let mut roots = vec![location.root.clone()];
    if matches!(location.scope, ScopeArg::Project) {
        let home = home_directory()?;
        ensure_real_directory(&home, "home directory")?;
        if !roots.contains(&home) {
            roots.push(home);
        }
    }
    Ok(roots)
}

fn scan_discovery_root(
    root: &Path,
    candidates: &[VisibleDefinition],
) -> Result<Vec<(PathBuf, VisibleDefinition)>> {
    let selected = candidates
        .iter()
        .map(|definition| definition.target.clone())
        .collect::<BTreeSet<_>>();
    let mut definitions = Vec::new();
    if selected.contains(&Harness::ClaudeCode) {
        scan_claude_agents(&root.join(".claude/agents"), &mut definitions)?;
        scan_skills(
            &root.join(".claude/skills"),
            Harness::ClaudeCode,
            &mut definitions,
        )?;
    }
    if selected.contains(&Harness::Codex) {
        scan_codex_agents(&root.join(".codex/agents"), &mut definitions)?;
        scan_skills(
            &root.join(".agents/skills"),
            Harness::Codex,
            &mut definitions,
        )?;
    }
    Ok(definitions)
}

fn scan_claude_agents(
    directory: &Path,
    definitions: &mut Vec<(PathBuf, VisibleDefinition)>,
) -> Result<()> {
    if !directory.exists() {
        return Ok(());
    }
    ensure_real_directory(directory, "Claude agent directory")?;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() {
            bail!(
                "Claude agent discovery path {} is a symlink",
                path.display()
            );
        }
        if metadata.file_type().is_dir() {
            scan_claude_agents(&path, definitions)?;
        } else if metadata.file_type().is_file()
            && path.extension().and_then(|value| value.to_str()) == Some("md")
        {
            let bytes =
                fs::read(&path).with_context(|| format!("cannot read {}", path.display()))?;
            definitions.push((
                path,
                VisibleDefinition {
                    target: Harness::ClaudeCode,
                    kind: VisibleKind::Agent,
                    name: parse_markdown_name(&bytes, "agent")?,
                },
            ));
        } else if !metadata.file_type().is_file() {
            bail!(
                "Claude agent discovery path {} is not a regular file or directory",
                path.display()
            );
        }
    }
    Ok(())
}

fn scan_codex_agents(
    directory: &Path,
    definitions: &mut Vec<(PathBuf, VisibleDefinition)>,
) -> Result<()> {
    if !directory.exists() {
        return Ok(());
    }
    ensure_real_directory(directory, "Codex agent directory")?;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() {
            bail!("Codex agent discovery path {} is a symlink", path.display());
        }
        if metadata.file_type().is_file()
            && path.extension().and_then(|value| value.to_str()) == Some("toml")
        {
            let bytes =
                fs::read(&path).with_context(|| format!("cannot read {}", path.display()))?;
            definitions.push((
                path,
                VisibleDefinition {
                    target: Harness::Codex,
                    kind: VisibleKind::Agent,
                    name: parse_toml_name(&bytes, "agent")?,
                },
            ));
        } else if !metadata.file_type().is_file() {
            bail!(
                "Codex agent discovery path {} is not a regular file",
                path.display()
            );
        }
    }
    Ok(())
}

fn scan_skills(
    directory: &Path,
    target: Harness,
    definitions: &mut Vec<(PathBuf, VisibleDefinition)>,
) -> Result<()> {
    if !directory.exists() {
        return Ok(());
    }
    ensure_real_directory(directory, "skill directory")?;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
            bail!(
                "skill discovery entry {} is not a real directory",
                path.display()
            );
        }
        let skill = path.join("SKILL.md");
        ensure_regular_file(&skill, "skill definition")?;
        let bytes = fs::read(&skill).with_context(|| format!("cannot read {}", skill.display()))?;
        definitions.push((
            skill,
            VisibleDefinition {
                target: target.clone(),
                kind: VisibleKind::Skill,
                name: parse_markdown_name(&bytes, "skill")?,
            },
        ));
    }
    Ok(())
}

fn parse_markdown_name(bytes: &[u8], kind: &str) -> Result<String> {
    let text =
        std::str::from_utf8(bytes).with_context(|| format!("{kind} definition is not UTF-8"))?;
    let body = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))
        .ok_or_else(|| anyhow!("{kind} definition lacks YAML frontmatter"))?;
    let closing = body
        .find("\n---\n")
        .or_else(|| body.find("\n---\r\n"))
        .ok_or_else(|| anyhow!("{kind} definition has unterminated YAML frontmatter"))?;
    let frontmatter: serde_yaml::Value = serde_yaml::from_str(&body[..closing])
        .with_context(|| format!("{kind} frontmatter is invalid YAML"))?;
    let name = frontmatter
        .get("name")
        .and_then(serde_yaml::Value::as_str)
        .ok_or_else(|| anyhow!("{kind} frontmatter lacks string name"))?;
    validate_identifier(name)?;
    Ok(name.to_owned())
}

fn parse_toml_name(bytes: &[u8], kind: &str) -> Result<String> {
    let text =
        std::str::from_utf8(bytes).with_context(|| format!("{kind} definition is not UTF-8"))?;
    let value: toml::Value =
        toml::from_str(text).with_context(|| format!("{kind} definition is invalid TOML"))?;
    let name = value
        .get("name")
        .and_then(toml::Value::as_str)
        .ok_or_else(|| anyhow!("{kind} definition lacks string name"))?;
    validate_identifier(name)?;
    Ok(name.to_owned())
}

struct PendingWrite {
    target: Harness,
    destination: String,
    bytes: Vec<u8>,
    sha256: String,
}

fn installation_plan(
    bundle: &VerifiedBundle,
    scope: ScopeArg,
    _root: &Path,
    targets: &[Harness],
) -> Result<(InstallState, Vec<PendingWrite>)> {
    let mut writes = BTreeMap::<String, PendingWrite>::new();
    for target in targets {
        let (agent_destination, skill_destination, agent_extension) = match target {
            Harness::ClaudeCode => (".claude/agents", ".claude/skills", ".md"),
            Harness::Codex => (".codex/agents", ".agents/skills", ".toml"),
        };
        let prefix = format!("targets/{}/agents/", target.as_str());
        for (source, bytes) in &bundle.payloads {
            let destination = if let Some(filename) = source.strip_prefix(&prefix) {
                if !filename.ends_with(agent_extension) || filename.contains('/') {
                    bail!("verified bundle has malformed agent payload {source}");
                }
                format!("{agent_destination}/{filename}")
            } else if let Some(rest) = source.strip_prefix("skills/") {
                format!("{skill_destination}/{rest}")
            } else {
                continue;
            };
            let write = PendingWrite {
                target: target.clone(),
                destination: destination.clone(),
                bytes: bytes.clone(),
                sha256: sha256_hex(bytes),
            };
            if writes.insert(destination.clone(), write).is_some() {
                bail!("bundle maps multiple payloads to {destination}");
            }
        }
    }
    let files = writes
        .values()
        .map(|write| ManagedFile {
            target: write.target.clone(),
            destination: write.destination.clone(),
            sha256: write.sha256.clone(),
        })
        .collect();
    Ok((
        InstallState {
            format: "thor-install/v1".to_owned(),
            repository: bundle.manifest.source_repository.clone(),
            release_tag: bundle.manifest.source_release_tag.clone(),
            source_commit: bundle.manifest.source_commit.clone(),
            package_name: bundle.manifest.package.name.clone(),
            package_version: bundle.manifest.package.version.clone(),
            public_key: bundle.public_key_hex.clone(),
            key_id: bundle.key_id.clone(),
            scope,
            targets: targets.to_vec(),
            files,
            created_directories: Vec::new(),
        },
        writes.into_values().collect(),
    ))
}

fn apply_install(
    location: &InstallLocation,
    state_path: &Path,
    previous: Option<&InstallState>,
    mut next: Option<&mut InstallState>,
    writes: Vec<PendingWrite>,
    deletes: &[ManagedFile],
    force: bool,
) -> Result<()> {
    ensure_directory_tree(&state_root(location))?;
    let previous_files = previous
        .map(|state| {
            state
                .files
                .iter()
                .map(|file| (file.destination.as_str(), file.sha256.as_str()))
                .collect::<BTreeMap<_, _>>()
        })
        .unwrap_or_default();
    for write in &writes {
        let path = safe_destination(&location.root, &write.target, &write.destination)?;
        if path.exists() {
            match previous_files.get(write.destination.as_str()) {
                Some(expected) if sha256_file(&path)? == *expected || force => {}
                Some(_) => bail!(
                    "refusing to replace modified managed file {}; use --force",
                    path.display()
                ),
                None => bail!("refusing to overwrite unmanaged file {}", path.display()),
            }
        }
    }
    for file in deletes {
        let path = safe_destination(&location.root, &file.target, &file.destination)?;
        if path.exists() && sha256_file(&path)? != file.sha256 && !force {
            bail!(
                "refusing to remove modified managed file {}; use --force",
                path.display()
            );
        }
    }
    let mut destinations = BTreeSet::new();
    let mut operations = Vec::new();
    let id = transaction_id();
    for write in &writes {
        if !destinations.insert(write.destination.clone()) {
            bail!(
                "transaction contains duplicate destination {}",
                write.destination
            );
        }
        let path = safe_destination(&location.root, &write.target, &write.destination)?;
        operations.push(JournalOperation {
            target: write.target.clone(),
            destination: write.destination.clone(),
            backup: backup_relative(&write.destination, &id)?,
            existed: path.exists(),
            action: "write".to_owned(),
            status: "pending".to_owned(),
        });
    }
    for file in deletes {
        if !destinations.insert(file.destination.clone()) {
            bail!(
                "transaction contains duplicate destination {}",
                file.destination
            );
        }
        let path = safe_destination(&location.root, &file.target, &file.destination)?;
        operations.push(JournalOperation {
            target: file.target.clone(),
            destination: file.destination.clone(),
            backup: backup_relative(&file.destination, &id)?,
            existed: path.exists(),
            action: "delete".to_owned(),
            status: "pending".to_owned(),
        });
    }
    let state_relative = state_path
        .strip_prefix(state_root(location))
        .context("state path is outside the Thor state root")?
        .to_str()
        .ok_or_else(|| anyhow!("state path must be UTF-8"))?
        .replace(std::path::MAIN_SEPARATOR, "/");
    validate_state_relative(&state_relative)?;
    let checked_state_path = safe_state_path(&state_root(location), &state_relative)?;
    if checked_state_path != state_path {
        bail!("state path is not normalized under the Thor state root");
    }
    if state_path.exists() {
        ensure_regular_file(state_path, "state record")?;
    }
    let mut journal = TransactionJournal {
        format: "thor-transaction/v1".to_owned(),
        id: id.clone(),
        phase: "prepared".to_owned(),
        operations,
        state: JournalState {
            destination: state_relative.clone(),
            backup: backup_relative(&state_relative, &id)?,
            existed: state_path.exists(),
            status: "pending".to_owned(),
        },
        created_directories: Vec::new(),
    };
    let journal_path = journal_path(location, &id);
    ensure_directory_tree(
        journal_path
            .parent()
            .ok_or_else(|| anyhow!("transaction journal has no parent"))?,
    )?;
    write_journal(&journal_path, &journal)?;

    for (index, write) in writes.iter().enumerate() {
        let created = ensure_safe_parent(&location.root, &write.destination)?;
        for directory in created {
            if is_trackable_directory(&directory)
                && !journal.created_directories.contains(&directory)
            {
                journal.created_directories.push(directory.clone());
                if let Some(state) = next.as_deref_mut()
                    && !state.created_directories.contains(&directory)
                {
                    state.created_directories.push(directory);
                }
            }
        }
        journal.operations[index].status = "active".to_owned();
        write_journal(&journal_path, &journal)?;
        perform_file_operation(
            &location.root,
            &journal.operations[index],
            Some(&write.bytes),
        )?;
        journal.operations[index].status = "applied".to_owned();
        write_journal(&journal_path, &journal)?;
    }
    for (offset, _) in deletes.iter().enumerate() {
        let index = writes.len() + offset;
        journal.operations[index].status = "active".to_owned();
        write_journal(&journal_path, &journal)?;
        perform_file_operation(&location.root, &journal.operations[index], None)?;
        journal.operations[index].status = "applied".to_owned();
        write_journal(&journal_path, &journal)?;
    }
    if let Some(state) = next.as_deref_mut() {
        state.created_directories.sort();
        state.created_directories.dedup();
        validate_install_state(state)?;
    }
    journal.state.status = "active".to_owned();
    write_journal(&journal_path, &journal)?;
    perform_state_operation(
        &state_root(location),
        &journal.state,
        next.as_deref().map(canonical_json).transpose()?.as_deref(),
    )?;
    journal.state.status = "applied".to_owned();
    write_journal(&journal_path, &journal)?;
    journal.phase = "committed".to_owned();
    write_journal(&journal_path, &journal)?;
    finalize_transaction(location, &journal, &journal_path)
}

fn transaction_id() -> String {
    format!(
        "{}-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        std::process::id()
    )
}

fn backup_relative(destination: &str, id: &str) -> Result<String> {
    let (parent, filename) = destination
        .rsplit_once('/')
        .ok_or_else(|| anyhow!("transaction destination has no parent"))?;
    Ok(format!("{parent}/.thor-txn-{id}/{filename}"))
}

fn journal_path(location: &InstallLocation, id: &str) -> PathBuf {
    state_root(location)
        .join("transactions")
        .join(format!("{id}.json"))
}

fn write_journal(path: &Path, journal: &TransactionJournal) -> Result<()> {
    atomic_write(path, &canonical_json(journal)?)
}

fn perform_file_operation(
    root: &Path,
    operation: &JournalOperation,
    bytes: Option<&[u8]>,
) -> Result<()> {
    let destination = safe_destination(root, &operation.target, &operation.destination)?;
    if operation.existed {
        ensure_regular_file(&destination, "managed destination")?;
        let backup = safe_relative_path(root, &operation.backup, "transaction backup")?;
        ensure_directory_tree(
            backup
                .parent()
                .ok_or_else(|| anyhow!("transaction backup has no parent"))?,
        )?;
        fs::rename(&destination, &backup).with_context(|| {
            format!(
                "cannot move {} to same-volume transaction backup {}",
                destination.display(),
                backup.display()
            )
        })?;
        sync_directory(
            destination
                .parent()
                .ok_or_else(|| anyhow!("managed destination has no parent"))?,
        )?;
    } else if destination.exists() {
        bail!(
            "unmanaged file appeared during transaction: {}",
            destination.display()
        );
    }
    if operation.action == "write" {
        let bytes = bytes.ok_or_else(|| anyhow!("write operation lacks payload"))?;
        atomic_write(&destination, bytes)?;
    } else if operation.action != "delete" {
        bail!("transaction has an unknown operation action");
    }
    Ok(())
}

fn perform_state_operation(
    state_root: &Path,
    state: &JournalState,
    bytes: Option<&[u8]>,
) -> Result<()> {
    let destination = safe_state_path(state_root, &state.destination)?;
    if state.existed {
        ensure_regular_file(&destination, "state record")?;
        let backup = safe_relative_path(state_root, &state.backup, "state backup")?;
        ensure_directory_tree(
            backup
                .parent()
                .ok_or_else(|| anyhow!("state backup has no parent"))?,
        )?;
        fs::rename(&destination, &backup)
            .with_context(|| format!("cannot back up state record {}", destination.display()))?;
        sync_directory(
            destination
                .parent()
                .ok_or_else(|| anyhow!("state record has no parent"))?,
        )?;
    } else if destination.exists() {
        bail!(
            "state record appeared during transaction: {}",
            destination.display()
        );
    }
    if let Some(bytes) = bytes {
        ensure_directory_tree(
            destination
                .parent()
                .ok_or_else(|| anyhow!("state record has no parent"))?,
        )?;
        atomic_write(&destination, bytes)?;
    }
    Ok(())
}

fn finalize_transaction(
    location: &InstallLocation,
    journal: &TransactionJournal,
    path: &Path,
) -> Result<()> {
    for operation in &journal.operations {
        remove_backup_file(&location.root, &operation.backup)?;
    }
    remove_state_backup(&state_root(location), &journal.state.backup)?;
    remove_transaction_backup_directories(location, journal)?;
    fs::remove_file(path)
        .with_context(|| format!("cannot remove transaction {}", path.display()))?;
    sync_directory(
        path.parent()
            .ok_or_else(|| anyhow!("transaction journal has no parent"))?,
    )
}

fn remove_backup_file(root: &Path, relative: &str) -> Result<()> {
    let path = safe_relative_path(root, relative, "transaction backup")?;
    if path.exists() {
        ensure_regular_file(&path, "transaction backup")?;
        fs::remove_file(&path).with_context(|| format!("cannot remove {}", path.display()))?;
    }
    Ok(())
}

fn remove_state_backup(root: &Path, relative: &str) -> Result<()> {
    let path = safe_relative_path(root, relative, "state backup")?;
    if path.exists() {
        ensure_regular_file(&path, "state backup")?;
        fs::remove_file(&path).with_context(|| format!("cannot remove {}", path.display()))?;
    }
    Ok(())
}

fn remove_transaction_backup_directories(
    location: &InstallLocation,
    journal: &TransactionJournal,
) -> Result<()> {
    let mut directories = BTreeSet::new();
    for operation in &journal.operations {
        let backup = safe_relative_path(&location.root, &operation.backup, "transaction backup")?;
        if let Some(parent) = backup.parent() {
            directories.insert(parent.to_path_buf());
        }
    }
    let state_backup =
        safe_relative_path(&state_root(location), &journal.state.backup, "state backup")?;
    if let Some(parent) = state_backup.parent() {
        directories.insert(parent.to_path_buf());
    }
    for directory in directories.into_iter().rev() {
        if directory.exists() {
            ensure_real_directory(&directory, "transaction backup directory")?;
            let _ = fs::remove_dir(&directory);
        }
    }
    Ok(())
}

fn ensure_safe_parent(root: &Path, relative: &str) -> Result<Vec<String>> {
    ensure_real_directory(root, "installation root")?;
    let relative = Path::new(relative);
    let parent = relative
        .parent()
        .ok_or_else(|| anyhow!("destination has no parent"))?;
    let mut current = root.to_path_buf();
    let mut created = Vec::new();
    for component in parent.components() {
        let Component::Normal(component) = component else {
            bail!("destination path is not relative and normalized");
        };
        current.push(component);
        if current.exists() {
            ensure_real_directory(&current, "destination parent")?;
        } else {
            fs::create_dir(&current)
                .with_context(|| format!("cannot create {}", current.display()))?;
            let directory = current
                .strip_prefix(root)
                .expect("created directory is below installation root")
                .to_str()
                .ok_or_else(|| anyhow!("created directory must be UTF-8"))?
                .replace(std::path::MAIN_SEPARATOR, "/");
            created.push(directory);
        }
    }
    Ok(created)
}

fn ensure_directory_tree(path: &Path) -> Result<()> {
    let mut missing = Vec::new();
    let mut current = path;
    while !current.exists() {
        missing.push(current.to_path_buf());
        current = current
            .parent()
            .ok_or_else(|| anyhow!("cannot create filesystem root"))?;
    }
    ensure_real_directory(current, "Thor state directory")?;
    for directory in missing.into_iter().rev() {
        fs::create_dir(&directory)
            .with_context(|| format!("cannot create {}", directory.display()))?;
        ensure_real_directory(&directory, "Thor state directory")?;
    }
    Ok(())
}

fn recover_transactions(location: &InstallLocation) -> Result<()> {
    let transactions = state_root(location).join("transactions");
    if !transactions.exists() {
        return Ok(());
    }
    ensure_real_directory(&transactions, "transaction directory")?;
    let mut journals = fs::read_dir(&transactions)
        .with_context(|| format!("cannot read {}", transactions.display()))?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<std::result::Result<Vec<_>, _>>()?;
    journals.sort();
    for path in journals {
        let metadata = fs::symlink_metadata(&path)
            .with_context(|| format!("cannot inspect {}", path.display()))?;
        if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
            bail!("transaction entry {} is not a regular file", path.display());
        }
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            bail!(
                "transaction entry {} has an invalid filename",
                path.display()
            );
        }
        let journal: TransactionJournal = serde_json::from_slice(
            &fs::read(&path).with_context(|| format!("cannot read {}", path.display()))?,
        )
        .with_context(|| format!("invalid transaction journal {}", path.display()))?;
        validate_journal(&journal)?;
        if path != journal_path(location, &journal.id) {
            bail!("transaction journal path does not match its identifier");
        }
        match journal.phase.as_str() {
            "prepared" => rollback_transaction(location, &journal, &path)?,
            "committed" => finalize_transaction(location, &journal, &path)?,
            _ => bail!("transaction journal has an unknown phase"),
        }
    }
    Ok(())
}

fn rollback_transaction(
    location: &InstallLocation,
    journal: &TransactionJournal,
    path: &Path,
) -> Result<()> {
    for operation in journal.operations.iter().rev() {
        rollback_file_operation(&location.root, operation)?;
    }
    rollback_state_operation(&state_root(location), &journal.state)?;
    for directory in journal.created_directories.iter().rev() {
        let path = safe_relative_path(&location.root, directory, "created directory")?;
        if path.exists() {
            ensure_real_directory(&path, "created directory")?;
            let _ = fs::remove_dir(&path);
        }
    }
    finalize_transaction(location, journal, path)
}

fn rollback_file_operation(root: &Path, operation: &JournalOperation) -> Result<()> {
    if operation.status == "pending" {
        let backup = safe_relative_path(root, &operation.backup, "transaction backup")?;
        if backup.exists() {
            bail!("pending transaction operation unexpectedly has a backup");
        }
        return Ok(());
    }
    let destination = safe_destination(root, &operation.target, &operation.destination)?;
    let backup = safe_relative_path(root, &operation.backup, "transaction backup")?;
    if backup.exists() {
        ensure_regular_file(&backup, "transaction backup")?;
        if destination.exists() {
            ensure_regular_file(&destination, "managed destination")?;
            fs::remove_file(&destination)
                .with_context(|| format!("cannot remove {}", destination.display()))?;
        }
        fs::rename(&backup, &destination).with_context(|| {
            format!(
                "cannot restore {} from {}",
                destination.display(),
                backup.display()
            )
        })?;
        sync_directory(
            destination
                .parent()
                .ok_or_else(|| anyhow!("managed destination has no parent"))?,
        )?;
    } else if !operation.existed && destination.exists() {
        ensure_regular_file(&destination, "managed destination")?;
        fs::remove_file(&destination)
            .with_context(|| format!("cannot remove {}", destination.display()))?;
    }
    Ok(())
}

fn rollback_state_operation(root: &Path, state: &JournalState) -> Result<()> {
    if state.status == "pending" {
        let backup = safe_relative_path(root, &state.backup, "state backup")?;
        if backup.exists() {
            bail!("pending transaction state operation unexpectedly has a backup");
        }
        return Ok(());
    }
    let destination = safe_state_path(root, &state.destination)?;
    let backup = safe_relative_path(root, &state.backup, "state backup")?;
    if backup.exists() {
        ensure_regular_file(&backup, "state backup")?;
        if destination.exists() {
            ensure_regular_file(&destination, "state record")?;
            fs::remove_file(&destination)
                .with_context(|| format!("cannot remove {}", destination.display()))?;
        }
        fs::rename(&backup, &destination)
            .with_context(|| format!("cannot restore {}", destination.display()))?;
        sync_directory(
            destination
                .parent()
                .ok_or_else(|| anyhow!("state record has no parent"))?,
        )?;
    } else if !state.existed && destination.exists() {
        ensure_regular_file(&destination, "state record")?;
        fs::remove_file(&destination)
            .with_context(|| format!("cannot remove {}", destination.display()))?;
    }
    Ok(())
}

fn validate_journal(journal: &TransactionJournal) -> Result<()> {
    if journal.format != "thor-transaction/v1"
        || !matches!(journal.phase.as_str(), "prepared" | "committed")
        || journal.id.is_empty()
        || !journal
            .id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'-')
    {
        bail!("transaction journal has invalid metadata");
    }
    let mut destinations = BTreeSet::new();
    for operation in &journal.operations {
        validate_destination(&operation.target, &operation.destination)?;
        if backup_relative(&operation.destination, &journal.id)? != operation.backup
            || !matches!(operation.action.as_str(), "write" | "delete")
            || !matches!(operation.status.as_str(), "pending" | "active" | "applied")
            || !destinations.insert(&operation.destination)
        {
            bail!("transaction journal has an invalid file operation");
        }
    }
    validate_state_relative(&journal.state.destination)?;
    if backup_relative(&journal.state.destination, &journal.id)? != journal.state.backup
        || !matches!(
            journal.state.status.as_str(),
            "pending" | "active" | "applied"
        )
    {
        bail!("transaction journal has an invalid state operation");
    }
    for directory in &journal.created_directories {
        validate_created_directory(directory)?;
    }
    if journal.phase == "committed"
        && (journal
            .operations
            .iter()
            .any(|operation| operation.status != "applied")
            || journal.state.status != "applied")
    {
        bail!("committed transaction journal is incomplete");
    }
    Ok(())
}

fn validate_state_relative(value: &str) -> Result<()> {
    validate_relative_path(value)?;
    let filename = value
        .strip_prefix("installs/")
        .ok_or_else(|| anyhow!("state record is outside the installs directory"))?;
    if filename.is_empty() || filename.contains('/') || !filename.ends_with(".json") {
        bail!("state record path is invalid");
    }
    Ok(())
}

fn safe_state_path(root: &Path, relative: &str) -> Result<PathBuf> {
    validate_state_relative(relative)?;
    safe_relative_path(root, relative, "state path")
}

fn safe_relative_path(root: &Path, relative: &str, label: &str) -> Result<PathBuf> {
    validate_relative_path(relative)?;
    ensure_real_directory(root, label)?;
    let mut path = root.to_path_buf();
    for component in Path::new(relative).components() {
        let Component::Normal(component) = component else {
            bail!("{label} is not normalized")
        };
        path.push(component);
    }
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("{label} has no parent"))?;
    let mut checked = root.to_path_buf();
    for component in parent
        .strip_prefix(root)
        .expect("safe path parent is below root")
        .components()
    {
        let Component::Normal(component) = component else {
            bail!("{label} parent is invalid")
        };
        checked.push(component);
        if checked.exists() {
            ensure_real_directory(&checked, label)?;
        }
    }
    Ok(path)
}

fn ensure_regular_file(path: &Path, label: &str) -> Result<()> {
    let metadata =
        fs::symlink_metadata(path).with_context(|| format!("cannot inspect {}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        bail!("{label} {} must be a regular file", path.display());
    }
    Ok(())
}

fn sync_directory(path: &Path) -> Result<()> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .with_context(|| format!("cannot sync {}", path.display()))
}

fn is_trackable_directory(directory: &str) -> bool {
    !matches!(directory, ".claude" | ".codex" | ".agents")
}

fn validate_created_directory(directory: &str) -> Result<()> {
    validate_relative_path(directory)?;
    if !is_trackable_directory(directory)
        || !matches!(
            directory,
            value if value == ".claude/agents"
                || value.starts_with(".claude/agents/")
                || value == ".claude/skills"
                || value.starts_with(".claude/skills/")
                || value == ".codex/agents"
                || value.starts_with(".codex/agents/")
                || value == ".agents/skills"
                || value.starts_with(".agents/skills/")
        )
    {
        bail!("created directory is outside managed configuration paths");
    }
    Ok(())
}

fn remove_owned_empty_directories(
    location: &InstallLocation,
    directories: &[String],
) -> Result<()> {
    let mut directories = directories.to_vec();
    directories.sort_by_key(|directory| std::cmp::Reverse(directory.matches('/').count()));
    directories.dedup();
    for directory in directories {
        validate_created_directory(&directory)?;
        let path = safe_relative_path(&location.root, &directory, "created directory")?;
        if path.exists() {
            ensure_real_directory(&path, "created directory")?;
            let _ = fs::remove_dir(&path);
        }
    }
    Ok(())
}

fn ensure_real_directory(path: &Path, label: &str) -> Result<()> {
    let metadata =
        fs::symlink_metadata(path).with_context(|| format!("cannot inspect {}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
        bail!(
            "{label} {} must be a real directory, not a symlink",
            path.display()
        );
    }
    Ok(())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("destination has no parent"))?;
    ensure_real_directory(parent, "destination parent")?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| anyhow!("destination filename must be UTF-8"))?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temporary = parent.join(format!(
        ".{file_name}.thor-{nonce}-{}.tmp",
        std::process::id()
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .with_context(|| format!("cannot stage {}", temporary.display()))?;
    file.write_all(bytes)
        .with_context(|| format!("cannot write {}", temporary.display()))?;
    file.sync_all()
        .with_context(|| format!("cannot sync {}", temporary.display()))?;
    fs::rename(&temporary, path).with_context(|| format!("cannot install {}", path.display()))?;
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .with_context(|| format!("cannot sync {}", parent.display()))?;
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String> {
    let metadata =
        fs::symlink_metadata(path).with_context(|| format!("cannot inspect {}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        bail!("managed path {} is not a regular file", path.display());
    }
    let bytes = fs::read(path).with_context(|| format!("cannot read {}", path.display()))?;
    Ok(sha256_hex(&bytes))
}

fn canonical_json<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
    use ed25519_dalek::{Signer, SigningKey};
    use tempfile::tempdir;
    use thor_core::{ArtifactPackage, PayloadDigest};
    use zip::{CompressionMethod, ZipWriter, write::FileOptions};

    use super::*;

    fn signed_fixture_bundle() -> (Vec<u8>, Vec<u8>, String) {
        let payload =
            b"name = \"reviewer\"\ndescription = \"Review\"\ndeveloper_instructions = \"Review\"\n"
                .to_vec();
        let payload_path = "targets/codex/agents/reviewer.toml".to_owned();
        let manifest = ArtifactManifest {
            format: "thor-bundle/v1".to_owned(),
            minimum_thor_version: "0.1.0".to_owned(),
            package: ArtifactPackage {
                name: "acme-pack".to_owned(),
                version: "1.2.0".to_owned(),
            },
            source_repository: "acme/agent-pack".to_owned(),
            source_release_tag: "v1.2.0".to_owned(),
            source_commit: "0123456789abcdef0123456789abcdef01234567".to_owned(),
            targets: vec![Harness::Codex],
            harness_compatibility: BTreeMap::from([(Harness::Codex, ">=0.0.0".to_owned())]),
            payloads: BTreeMap::from([(
                payload_path.clone(),
                PayloadDigest {
                    sha256: sha256_hex(&payload),
                    bytes: payload.len() as u64,
                },
            )]),
        };
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        let options = FileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .last_modified_time(zip::DateTime::default());
        writer.start_file("manifest.json", options).unwrap();
        writer
            .write_all(&canonical_json(&manifest).unwrap())
            .unwrap();
        writer.start_file(&payload_path, options).unwrap();
        writer.write_all(&payload).unwrap();
        let archive = writer.finish().unwrap().into_inner();
        let signing_key = SigningKey::from_bytes(&[3u8; 32]);
        let public_key = signing_key.verifying_key();
        let signature = signing_key.sign(&archive);
        let envelope = SignatureEnvelope {
            format: "thor-signature/v1".to_owned(),
            algorithm: "ed25519".to_owned(),
            key_id: sha256_hex(public_key.as_bytes()),
            signature: BASE64.encode(signature.to_bytes()),
        };
        (
            archive,
            canonical_json(&envelope).unwrap(),
            hex::encode(public_key.as_bytes()),
        )
    }

    fn verified_payload_bundle(
        version: &str,
        targets: Vec<Harness>,
        payloads: BTreeMap<String, Vec<u8>>,
    ) -> VerifiedBundle {
        let public_key = SigningKey::from_bytes(&[3u8; 32]).verifying_key();
        VerifiedBundle {
            manifest: ArtifactManifest {
                format: "thor-bundle/v1".to_owned(),
                minimum_thor_version: "0.1.0".to_owned(),
                package: ArtifactPackage {
                    name: "acme-pack".to_owned(),
                    version: version.to_owned(),
                },
                source_repository: "acme/agent-pack".to_owned(),
                source_release_tag: format!("v{version}"),
                source_commit: "0123456789abcdef0123456789abcdef01234567".to_owned(),
                harness_compatibility: targets
                    .iter()
                    .cloned()
                    .map(|target| (target, ">=0.0.0".to_owned()))
                    .collect(),
                targets,
                payloads: payloads
                    .iter()
                    .map(|(path, bytes)| {
                        (
                            path.clone(),
                            PayloadDigest {
                                sha256: sha256_hex(bytes),
                                bytes: bytes.len() as u64,
                            },
                        )
                    })
                    .collect(),
            },
            payloads,
            public_key_hex: hex::encode(public_key.as_bytes()),
            key_id: sha256_hex(public_key.as_bytes()),
        }
    }

    #[test]
    fn verifies_signed_bundle_and_rejects_tampering() {
        let (archive, signature, key) = signed_fixture_bundle();
        let verified = verify_bundle_with_public_key(&archive, &signature, key.clone()).unwrap();
        assert_eq!(verified.manifest.package.name, "acme-pack");
        let mut tampered = archive;
        let last = tampered.len() - 1;
        tampered[last] ^= 1;
        assert!(verify_bundle_with_public_key(&tampered, &signature, key).is_err());
    }

    #[test]
    fn installs_updates_and_removes_only_managed_files() {
        let (archive, signature, key) = signed_fixture_bundle();
        let verified = verify_bundle_with_public_key(&archive, &signature, key).unwrap();
        let directory = tempdir().unwrap();
        let location = InstallLocation {
            scope: ScopeArg::Project,
            root: directory.path().to_path_buf(),
            state_root: directory.path().join(".thor"),
        };
        let targets = vec![Harness::Codex];
        let (mut state, writes) =
            installation_plan(&verified, location.scope, &location.root, &targets).unwrap();
        let state_path = state_path(&location, &state.repository, &state.package_name);
        apply_install(
            &location,
            &state_path,
            None,
            Some(&mut state),
            writes,
            &[],
            false,
        )
        .unwrap();
        let installed = directory.path().join(".codex/agents/reviewer.toml");
        assert!(installed.is_file());
        assert_eq!(
            read_state(&state_path).unwrap().source_commit,
            state.source_commit
        );

        fs::write(&installed, "modified").unwrap();
        let previous = state.clone();
        let (_, writes) =
            installation_plan(&verified, location.scope, &location.root, &targets).unwrap();
        assert!(
            apply_install(
                &location,
                &state_path,
                Some(&previous),
                Some(&mut state),
                writes,
                &[],
                false
            )
            .is_err()
        );
        assert!(
            apply_install(
                &location,
                &state_path,
                Some(&previous),
                None,
                Vec::new(),
                &previous.files,
                true
            )
            .is_ok()
        );
        assert!(!installed.exists());
        remove_owned_empty_directories(&location, &previous.created_directories).unwrap();
        assert!(!state_path.exists());
        assert!(!directory.path().join(".codex/agents").exists());
        assert!(directory.path().join(".codex").is_dir());
    }

    #[test]
    fn updates_one_target_removes_its_payload_and_retains_other_targets() {
        let codex =
            b"name = \"reviewer\"\ndescription = \"Review\"\ndeveloper_instructions = \"Review\"\n"
                .to_vec();
        let claude = b"---\nname: writer\ndescription: Write\n---\n\nWrite.\n".to_vec();
        let initial = verified_payload_bundle(
            "1.2.0",
            vec![Harness::ClaudeCode, Harness::Codex],
            BTreeMap::from([
                ("targets/codex/agents/reviewer.toml".to_owned(), codex),
                ("targets/claude-code/agents/writer.md".to_owned(), claude),
            ]),
        );
        let directory = tempdir().unwrap();
        let location = InstallLocation {
            scope: ScopeArg::Project,
            root: directory.path().to_path_buf(),
            state_root: directory.path().join(".thor"),
        };
        let all_targets = vec![Harness::ClaudeCode, Harness::Codex];
        let (mut initial_state, initial_writes) =
            installation_plan(&initial, location.scope, &location.root, &all_targets).unwrap();
        let state_path = state_path(
            &location,
            &initial_state.repository,
            &initial_state.package_name,
        );
        apply_install(
            &location,
            &state_path,
            None,
            Some(&mut initial_state),
            initial_writes,
            &[],
            false,
        )
        .unwrap();
        let replacement = verified_payload_bundle(
            "1.3.0",
            vec![Harness::ClaudeCode, Harness::Codex],
            BTreeMap::new(),
        );
        let selected = vec![Harness::Codex];
        let (candidate, writes) =
            installation_plan(&replacement, location.scope, &location.root, &selected).unwrap();
        let previous = initial_state.clone();
        let (mut state, deletes) = merge_update_state(candidate, &previous, &selected).unwrap();
        apply_install(
            &location,
            &state_path,
            Some(&previous),
            Some(&mut state),
            writes,
            &deletes,
            false,
        )
        .unwrap();
        assert!(
            !directory
                .path()
                .join(".codex/agents/reviewer.toml")
                .exists()
        );
        assert!(directory.path().join(".claude/agents/writer.md").is_file());
        assert_eq!(state.targets, vec![Harness::ClaudeCode]);

        let final_previous = state.clone();
        apply_install(
            &location,
            &state_path,
            Some(&final_previous),
            None,
            Vec::new(),
            &final_previous.files,
            false,
        )
        .unwrap();
        remove_owned_empty_directories(&location, &final_previous.created_directories).unwrap();
        assert!(!directory.path().join(".claude/agents/writer.md").exists());
        assert!(!state_path.exists());
    }

    #[test]
    fn rejects_windows_device_name_in_skill_payload() {
        assert!(!portable_component("CON.txt"));
        assert!(!portable_component("lpt9"));
        assert!(!portable_component("reference."));
        assert!(validate_payload_path("skills/con/SKILL.md").is_err());
        assert!(validate_payload_path("skills/research/references/foo.").is_err());
        assert!(portable_component("reference.txt"));
    }

    #[test]
    fn rejects_case_folded_archive_path_collisions() {
        let mut paths = BTreeMap::new();
        insert_portable_archive_path(&mut paths, "skills/research/REFERENCE.md").unwrap();
        assert!(insert_portable_archive_path(&mut paths, "skills/research/reference.md").is_err());
        let mut paths = BTreeMap::new();
        insert_portable_archive_path(&mut paths, "skills/research/Foo/one.md").unwrap();
        assert!(insert_portable_archive_path(&mut paths, "skills/research/foo/two.md").is_err());
    }

    #[test]
    fn collects_every_release_page_before_sorting_versions() {
        let release = |tag_name: String| GithubRelease {
            tag_name,
            draft: false,
            prerelease: false,
            assets: Vec::new(),
        };
        let first_page = (0..100)
            .map(|_| release("v1.0.0".to_owned()))
            .collect::<Vec<_>>();
        let mut requested = Vec::new();
        let releases = collect_release_pages(|page| {
            requested.push(page);
            if page == 1 {
                Ok(first_page.clone())
            } else if page == 2 {
                Ok(vec![release("v2.0.0".to_owned())])
            } else {
                Ok(Vec::new())
            }
        })
        .unwrap();
        assert_eq!(requested, vec![1, 2]);
        assert_eq!(
            stable_release_tags(releases).first(),
            Some(&"v2.0.0".to_owned())
        );
    }

    #[test]
    fn rejects_unmanaged_visible_agent_conflicts() {
        let (archive, signature, key) = signed_fixture_bundle();
        let verified = verify_bundle_with_public_key(&archive, &signature, key).unwrap();
        let directory = tempdir().unwrap();
        let location = InstallLocation {
            scope: ScopeArg::Project,
            root: directory.path().to_path_buf(),
            state_root: directory.path().join(".thor"),
        };
        let unmanaged = directory.path().join(".codex/agents");
        fs::create_dir_all(&unmanaged).unwrap();
        fs::write(
            unmanaged.join("someone-else.toml"),
            "name = \"reviewer\"\ndescription = \"Other\"\ndeveloper_instructions = \"Other\"\n",
        )
        .unwrap();
        let (_, writes) =
            installation_plan(&verified, location.scope, &location.root, &[Harness::Codex])
                .unwrap();
        assert!(reject_conflicts(&location, None, &[], &writes).is_err());
    }

    #[test]
    fn rejects_unmanaged_visible_claude_agent_conflicts() {
        let directory = tempdir().unwrap();
        let location = InstallLocation {
            scope: ScopeArg::Project,
            root: directory.path().to_path_buf(),
            state_root: directory.path().join(".thor"),
        };
        let agent = b"---\nname: reviewer\ndescription: Review\n---\n\nReview.\n".to_vec();
        let unmanaged = directory.path().join(".claude/agents/nested");
        fs::create_dir_all(&unmanaged).unwrap();
        fs::write(unmanaged.join("someone-else.md"), &agent).unwrap();
        let writes = vec![PendingWrite {
            target: Harness::ClaudeCode,
            destination: ".claude/agents/reviewer.md".to_owned(),
            sha256: sha256_hex(&agent),
            bytes: agent,
        }];
        assert!(reject_conflicts(&location, None, &[], &writes).is_err());
    }

    #[test]
    fn rejects_another_packs_managed_agent_name() {
        let (archive, signature, key) = signed_fixture_bundle();
        let verified = verify_bundle_with_public_key(&archive, &signature, key).unwrap();
        let directory = tempdir().unwrap();
        let location = InstallLocation {
            scope: ScopeArg::Project,
            root: directory.path().to_path_buf(),
            state_root: directory.path().join(".thor"),
        };
        let (foreign, writes) =
            installation_plan(&verified, location.scope, &location.root, &[Harness::Codex])
                .unwrap();
        let foreign_path = location.state_root.join("installs/foreign.json");
        ensure_directory_tree(foreign_path.parent().unwrap()).unwrap();
        atomic_write(&foreign_path, &canonical_json(&foreign).unwrap()).unwrap();
        assert!(reject_conflicts(&location, None, &[], &writes).is_err());
    }

    #[test]
    fn rejects_unmanaged_visible_skill_conflicts() {
        let directory = tempdir().unwrap();
        let location = InstallLocation {
            scope: ScopeArg::Project,
            root: directory.path().to_path_buf(),
            state_root: directory.path().join(".thor"),
        };
        let skill = b"---\nname: research\ndescription: Research\n---\n".to_vec();
        let existing = directory.path().join(".agents/skills/existing");
        fs::create_dir_all(&existing).unwrap();
        fs::write(existing.join("SKILL.md"), &skill).unwrap();
        let writes = vec![PendingWrite {
            target: Harness::Codex,
            destination: ".agents/skills/research/SKILL.md".to_owned(),
            sha256: sha256_hex(&skill),
            bytes: skill,
        }];
        assert!(reject_conflicts(&location, None, &[], &writes).is_err());
    }

    #[test]
    fn recovers_a_prepared_transaction_to_the_old_file() {
        let (archive, signature, key) = signed_fixture_bundle();
        let verified = verify_bundle_with_public_key(&archive, &signature, key).unwrap();
        let directory = tempdir().unwrap();
        let location = InstallLocation {
            scope: ScopeArg::Project,
            root: directory.path().to_path_buf(),
            state_root: directory.path().join(".thor"),
        };
        let (mut state, writes) =
            installation_plan(&verified, location.scope, &location.root, &[Harness::Codex])
                .unwrap();
        let state_path = state_path(&location, &state.repository, &state.package_name);
        apply_install(
            &location,
            &state_path,
            None,
            Some(&mut state),
            writes,
            &[],
            false,
        )
        .unwrap();
        let destination = ".codex/agents/reviewer.toml";
        let original = fs::read(directory.path().join(destination)).unwrap();
        let id = "12345-678";
        let file_backup_relative = backup_relative(destination, id).unwrap();
        let backup =
            safe_relative_path(directory.path(), &file_backup_relative, "test backup").unwrap();
        ensure_directory_tree(backup.parent().unwrap()).unwrap();
        fs::rename(directory.path().join(destination), &backup).unwrap();
        fs::write(
            directory.path().join(destination),
            "name = \"reviewer\"\nchanged = true\n",
        )
        .unwrap();
        let journal = TransactionJournal {
            format: "thor-transaction/v1".to_owned(),
            id: id.to_owned(),
            phase: "prepared".to_owned(),
            operations: vec![JournalOperation {
                target: Harness::Codex,
                destination: destination.to_owned(),
                backup: file_backup_relative,
                existed: true,
                action: "write".to_owned(),
                status: "applied".to_owned(),
            }],
            state: JournalState {
                destination: state_path
                    .strip_prefix(&location.state_root)
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .replace(std::path::MAIN_SEPARATOR, "/"),
                backup: backup_relative(
                    state_path
                        .strip_prefix(&location.state_root)
                        .unwrap()
                        .to_str()
                        .unwrap(),
                    id,
                )
                .unwrap(),
                existed: true,
                status: "pending".to_owned(),
            },
            created_directories: Vec::new(),
        };
        let journal_path = journal_path(&location, id);
        ensure_directory_tree(journal_path.parent().unwrap()).unwrap();
        write_journal(&journal_path, &journal).unwrap();
        recover_transactions(&location).unwrap();
        assert_eq!(
            fs::read(directory.path().join(destination)).unwrap(),
            original
        );
        assert!(!journal_path.exists());
    }

    #[test]
    fn recovers_an_interrupted_state_mutation_with_external_state_storage() {
        let (archive, signature, key) = signed_fixture_bundle();
        let verified = verify_bundle_with_public_key(&archive, &signature, key).unwrap();
        let config = tempdir().unwrap();
        let external_state = tempdir().unwrap();
        let location = InstallLocation {
            scope: ScopeArg::User,
            root: config.path().to_path_buf(),
            state_root: external_state.path().join("thor"),
        };
        let (mut state, writes) =
            installation_plan(&verified, location.scope, &location.root, &[Harness::Codex])
                .unwrap();
        let state_path = state_path(&location, &state.repository, &state.package_name);
        apply_install(
            &location,
            &state_path,
            None,
            Some(&mut state),
            writes,
            &[],
            false,
        )
        .unwrap();
        let original = fs::read(&state_path).unwrap();
        let id = "98765-432";
        let state_relative = state_path
            .strip_prefix(&location.state_root)
            .unwrap()
            .to_str()
            .unwrap()
            .replace(std::path::MAIN_SEPARATOR, "/");
        let backup_relative = backup_relative(&state_relative, id).unwrap();
        let backup =
            safe_relative_path(&location.state_root, &backup_relative, "test backup").unwrap();
        ensure_directory_tree(backup.parent().unwrap()).unwrap();
        fs::rename(&state_path, &backup).unwrap();
        fs::write(&state_path, "{\"format\":\"interrupted\"}\n").unwrap();
        let journal = TransactionJournal {
            format: "thor-transaction/v1".to_owned(),
            id: id.to_owned(),
            phase: "prepared".to_owned(),
            operations: Vec::new(),
            state: JournalState {
                destination: state_relative,
                backup: backup_relative,
                existed: true,
                status: "applied".to_owned(),
            },
            created_directories: Vec::new(),
        };
        let journal_path = journal_path(&location, id);
        ensure_directory_tree(journal_path.parent().unwrap()).unwrap();
        write_journal(&journal_path, &journal).unwrap();
        recover_transactions(&location).unwrap();
        assert_eq!(fs::read(&state_path).unwrap(), original);
        assert!(!journal_path.exists());
    }

    #[test]
    fn supports_a_separate_user_state_root_and_status() {
        let (archive, signature, key) = signed_fixture_bundle();
        let verified = verify_bundle_with_public_key(&archive, &signature, key).unwrap();
        let config = tempdir().unwrap();
        let state_directory = tempdir().unwrap();
        let location = InstallLocation {
            scope: ScopeArg::User,
            root: config.path().to_path_buf(),
            state_root: state_directory.path().join("thor"),
        };
        let (mut state, writes) =
            installation_plan(&verified, location.scope, &location.root, &[Harness::Codex])
                .unwrap();
        let state_path = state_path(&location, &state.repository, &state.package_name);
        apply_install(
            &location,
            &state_path,
            None,
            Some(&mut state),
            writes,
            &[],
            false,
        )
        .unwrap();
        assert!(config.path().join(".codex/agents/reviewer.toml").is_file());
        assert!(state_path.is_file());
        let _lock = acquire_lock(&location).unwrap();
        recover_transactions(&location).unwrap();
        assert_eq!(all_install_states(&location).unwrap().len(), 1);
        let previous = state.clone();
        apply_install(
            &location,
            &state_path,
            Some(&previous),
            None,
            Vec::new(),
            &previous.files,
            false,
        )
        .unwrap();
        remove_owned_empty_directories(&location, &previous.created_directories).unwrap();
        assert!(!state_path.exists());
    }

    #[test]
    fn retains_unselected_target_membership_on_partial_update() {
        let public_key = SigningKey::from_bytes(&[3u8; 32]).verifying_key();
        let mut state = InstallState {
            format: "thor-install/v1".to_owned(),
            repository: "acme/agent-pack".to_owned(),
            release_tag: "v1.2.0".to_owned(),
            source_commit: "0123456789abcdef0123456789abcdef01234567".to_owned(),
            package_name: "acme-pack".to_owned(),
            package_version: "1.2.0".to_owned(),
            public_key: hex::encode(public_key.as_bytes()),
            key_id: sha256_hex(public_key.as_bytes()),
            scope: ScopeArg::Project,
            targets: vec![Harness::Codex],
            files: vec![ManagedFile {
                target: Harness::Codex,
                destination: ".codex/agents/reviewer.toml".to_owned(),
                sha256: "0".repeat(64),
            }],
            created_directories: Vec::new(),
        };
        let retained = ManagedFile {
            target: Harness::ClaudeCode,
            destination: ".claude/agents/reviewer.md".to_owned(),
            sha256: "1".repeat(64),
        };
        state.files.push(retained);
        state.targets = state
            .files
            .iter()
            .map(|file| file.target.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        assert_eq!(
            select_state_targets(&state, TargetArg::All).unwrap().len(),
            2
        );
        validate_install_state(&state).unwrap();
    }

    #[test]
    fn rejects_state_inventory_paths_outside_the_installation_root() {
        let public_key = SigningKey::from_bytes(&[3u8; 32]).verifying_key();
        let state = InstallState {
            format: "thor-install/v1".to_owned(),
            repository: "acme/agent-pack".to_owned(),
            release_tag: "v1.2.0".to_owned(),
            source_commit: "0123456789abcdef0123456789abcdef01234567".to_owned(),
            package_name: "acme-pack".to_owned(),
            package_version: "1.2.0".to_owned(),
            public_key: hex::encode(public_key.as_bytes()),
            key_id: sha256_hex(public_key.as_bytes()),
            scope: ScopeArg::Project,
            targets: vec![Harness::Codex],
            files: vec![ManagedFile {
                target: Harness::Codex,
                destination: "../outside.toml".to_owned(),
                sha256: "0".repeat(64),
            }],
            created_directories: Vec::new(),
        };
        assert!(validate_install_state(&state).is_err());
    }
}
