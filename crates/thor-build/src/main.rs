use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::{Cursor, Write},
    path::{Component, Path, PathBuf},
};

use anyhow::{Context, Result, anyhow, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use clap::{Parser, Subcommand};
use ed25519_dalek::{Signer, SigningKey};
use sha2::{Digest, Sha256};
use thor_core::{
    ArtifactManifest, ArtifactPackage, Harness, PayloadDigest, SignatureEnvelope, SourcePack,
    collect_skill_payloads, collect_static_payloads, render_claude, render_codex,
};
use zip::{CompressionMethod, ZipWriter, write::FileOptions};

const DEFAULT_SOURCE_DIRECTORY: &str = "assets";
const DEFAULT_PROJECT_ROOT: &str = ".";
const GENERATED_OUTPUT_MANIFEST: &str = ".thor-generated.json";
const GENERATED_OUTPUT_FORMAT: &str = "thor-generated-output/v1";

#[derive(Debug, Parser)]
#[command(name = "thor-build", about = "Thor source validator and transformer")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Clone)]
enum TargetSelection {
    All,
    One(Harness),
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Validate a Thor agent-pack source directory.
    Validate {
        #[arg(long, default_value = DEFAULT_SOURCE_DIRECTORY)]
        source: PathBuf,
    },
    /// Transform a Thor agent pack into its project-local harness definitions.
    Transform {
        #[arg(long, default_value = DEFAULT_SOURCE_DIRECTORY)]
        source: PathBuf,
        /// One harness to transform, or all selected harnesses (the default).
        #[arg(long, default_value = "all")]
        target: String,
        /// Project root containing the harness discovery directories.
        #[arg(long, default_value = DEFAULT_PROJECT_ROOT)]
        root: PathBuf,
        /// Verify that the harness definitions match the source without writing files.
        #[arg(long)]
        check: bool,
    },
    /// Transform, validate, and sign a deterministic release bundle.
    Bundle {
        #[arg(long, default_value = DEFAULT_SOURCE_DIRECTORY)]
        source: PathBuf,
        #[arg(long)]
        out: PathBuf,
        /// File containing a 32-byte Ed25519 seed encoded as 64 hexadecimal characters.
        #[arg(long)]
        signing_key: PathBuf,
        /// Canonical GitHub repository identity, for example acme/agent-pack.
        #[arg(long)]
        source_repository: String,
        /// Immutable Git commit that the release tag resolves to.
        #[arg(long)]
        source_commit: String,
        #[arg(long, default_value = "0.1.0")]
        minimum_thor_version: String,
        #[arg(long)]
        claude_compatibility: Option<String>,
        #[arg(long)]
        codex_compatibility: Option<String>,
    },
    /// Create a detached Thor Ed25519 signature for a release asset.
    Sign {
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        out: PathBuf,
        /// File containing a 32-byte Ed25519 seed encoded as 64 hexadecimal characters.
        #[arg(long)]
        signing_key: PathBuf,
    },
    /// Generate and sign the native Thor CLI release inventory.
    ReleaseManifest {
        #[arg(long)]
        assets_dir: PathBuf,
        #[arg(long)]
        out: PathBuf,
        /// File containing a 32-byte Ed25519 seed encoded as 64 hexadecimal characters.
        #[arg(long)]
        signing_key: PathBuf,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Validate { source } => {
            let pack = SourcePack::load(&source)
                .with_context(|| format!("invalid source {}", source.display()))?;
            collect_skill_payloads(source.join("skills"))
                .with_context(|| format!("invalid skills in {}", source.display()))?;
            for target in Harness::ALL {
                collect_static_payloads(source.join(format!(".{}", target.as_str())), target)?;
            }
            println!(
                "validated {} {} with {} agent(s)",
                pack.manifest.metadata.name,
                pack.manifest.metadata.version,
                pack.agents.len()
            );
        }
        Command::Transform {
            source,
            target,
            root,
            check,
        } => transform(&source, parse_target_selection(&target)?, &root, check)?,
        Command::Bundle {
            source,
            out,
            signing_key,
            source_repository,
            source_commit,
            minimum_thor_version,
            claude_compatibility,
            codex_compatibility,
        } => {
            let metadata = BundleMetadata {
                source_repository,
                source_commit,
                minimum_thor_version,
                claude_compatibility,
                codex_compatibility,
            };
            let (archive, signature) = bundle(&source, &signing_key, &metadata)?;
            write_new_file(&out, &archive)?;
            write_new_file(&signature_path(&out), &signature)?;
            println!(
                "created {} and {}",
                out.display(),
                signature_path(&out).display()
            );
        }
        Command::Sign {
            input,
            out,
            signing_key,
        } => {
            let bytes =
                fs::read(&input).with_context(|| format!("cannot read {}", input.display()))?;
            write_new_file(
                &out,
                &canonical_json(&signature_envelope(&bytes, &signing_key)?)?,
            )?;
            println!("signed {} as {}", input.display(), out.display());
        }
        Command::ReleaseManifest {
            assets_dir,
            out,
            signing_key,
        } => {
            let manifest = cli_release_manifest(&assets_dir)?;
            let bytes = canonical_json(&manifest)?;
            write_new_file(&out, &bytes)?;
            write_new_file(
                &signature_path(&out),
                &canonical_json(&signature_envelope(&bytes, &signing_key)?)?,
            )?;
            println!(
                "created {} and {}",
                out.display(),
                signature_path(&out).display()
            );
        }
    }
    Ok(())
}

#[derive(Debug)]
struct BundleMetadata {
    source_repository: String,
    source_commit: String,
    minimum_thor_version: String,
    claude_compatibility: Option<String>,
    codex_compatibility: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CliReleaseManifest {
    format: String,
    version: String,
    assets: std::collections::BTreeMap<String, PayloadDigest>,
}

fn cli_release_manifest(assets_dir: &Path) -> Result<CliReleaseManifest> {
    let metadata = fs::symlink_metadata(assets_dir)
        .with_context(|| format!("cannot inspect {}", assets_dir.display()))?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
        bail!("--assets-dir must be a real directory");
    }
    let mut assets = std::collections::BTreeMap::new();
    for entry in
        fs::read_dir(assets_dir).with_context(|| format!("cannot read {}", assets_dir.display()))?
    {
        let entry = entry?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .with_context(|| format!("cannot inspect {}", path.display()))?;
        if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
            bail!("release assets must be regular files: {}", path.display());
        }
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| anyhow!("release asset filename must be UTF-8"))?;
        if name.is_empty()
            || name.contains(['/', '\\'])
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        {
            bail!("release asset name is not portable: {name:?}");
        }
        let bytes = fs::read(&path).with_context(|| format!("cannot read {}", path.display()))?;
        assets.insert(
            name,
            PayloadDigest {
                sha256: sha256_hex(&bytes),
                bytes: bytes.len() as u64,
            },
        );
    }
    if assets.is_empty() {
        bail!("--assets-dir must contain at least one release asset");
    }
    Ok(CliReleaseManifest {
        format: "thor-cli-release/v1".to_owned(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
        assets,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OutputKind {
    Claude,
    CodexAgents,
    CodexSkills,
}

impl OutputKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::CodexAgents => "codex-agents",
            Self::CodexSkills => "codex-skills",
        }
    }

    fn allows_path(self, path: &Path) -> bool {
        let components = path.components().collect::<Vec<_>>();
        let Some(first) = components.first() else {
            return false;
        };
        let Component::Normal(first) = first else {
            return false;
        };
        match self {
            Self::Claude => {
                (*first == "agents"
                    && components.len() == 2
                    && path.extension().is_some_and(|extension| extension == "md"))
                    || (*first == "skills" && components.len() >= 3)
            }
            Self::CodexAgents => {
                *first == "agents"
                    && components.len() == 2
                    && path
                        .extension()
                        .is_some_and(|extension| extension == "toml")
            }
            Self::CodexSkills => *first == "skills" && components.len() >= 3,
        }
    }
}

#[derive(Debug)]
struct OutputPlan {
    kind: OutputKind,
    root: PathBuf,
    desired: BTreeMap<PathBuf, Vec<u8>>,
    previous: BTreeSet<PathBuf>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct GeneratedOutputManifest {
    format: String,
    output: String,
    paths: Vec<String>,
}

fn transform(source: &Path, selection: TargetSelection, root: &Path, check: bool) -> Result<()> {
    ensure_real_directory(root, "project root")?;
    let pack =
        SourcePack::load(source).with_context(|| format!("invalid source {}", source.display()))?;
    let targets = match selection {
        TargetSelection::All => pack.manifest.spec.targets.clone(),
        TargetSelection::One(target) => vec![target],
    };
    for target in &targets {
        if !pack.manifest.spec.targets.contains(target) {
            bail!(
                "target {} is not selected by {}",
                target.as_str(),
                source.join("thor.yaml").display()
            );
        }
    }
    let skill_payloads = collect_skill_payloads(source.join("skills"))?;

    let mut plans = output_plans(root, &pack, &targets, &skill_payloads)?;
    for plan in &mut plans {
        prepare_output_plan(plan)?;
    }
    let mut static_stale = false;
    for target in &targets {
        static_stale |= static_output_is_stale(root, source, target)?;
    }
    if check {
        let stale = static_stale || plans.iter().any(output_plan_is_stale);
        if stale {
            bail!(
                "generated harness definitions are stale; run `thor-build transform` to refresh them"
            );
        }
        println!("generated harness definitions are current");
        return Ok(());
    }

    for plan in &plans {
        apply_output_plan(plan)?;
    }
    for target in &targets {
        apply_static_output(root, source, target)?;
    }
    for target in &targets {
        println!(
            "generated {} agent(s) and {} skill file(s) for {}",
            pack.agents.len(),
            skill_payloads.len(),
            target.as_str()
        );
    }
    Ok(())
}

fn static_output_is_stale(root: &Path, source: &Path, target: &Harness) -> Result<bool> {
    let output_root = root.join(format!(".{}", target.as_str()));
    ensure_real_or_missing_directory(&output_root, "harness directory")?;
    for (relative, expected) in static_output_files(source, target)? {
        ensure_static_output_path_is_safe(&output_root, &relative)?;
        match fs::read(output_root.join(relative)) {
            Ok(actual) if actual == expected => {}
            _ => return Ok(true),
        }
    }
    Ok(false)
}

fn apply_static_output(root: &Path, source: &Path, target: &Harness) -> Result<()> {
    let output_root = root.join(format!(".{}", target.as_str()));
    ensure_real_or_missing_directory(&output_root, "harness directory")?;
    fs::create_dir_all(&output_root)
        .with_context(|| format!("failed to create {}", output_root.display()))?;
    for (relative, contents) in static_output_files(source, target)? {
        ensure_static_output_path_is_safe(&output_root, &relative)?;
        create_static_parent_directories(&output_root, &relative)?;
        fs::write(output_root.join(&relative), contents)
            .with_context(|| format!("failed to write {}", output_root.join(relative).display()))?;
    }
    Ok(())
}

fn static_output_files(source: &Path, target: &Harness) -> Result<BTreeMap<PathBuf, Vec<u8>>> {
    let prefix = format!("targets/{}/static/", target.as_str());
    collect_static_payloads(source.join(format!(".{}", target.as_str())), target.clone())?
        .into_iter()
        .map(|(archive_path, bytes)| {
            let relative = archive_path
                .strip_prefix(&prefix)
                .expect("static payload uses its target archive prefix");
            Ok((PathBuf::from(relative), bytes))
        })
        .collect()
}

fn ensure_static_output_path_is_safe(root: &Path, relative: &Path) -> Result<()> {
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        bail!("static output path {} is invalid", relative.display());
    }
    let mut current = root.to_path_buf();
    for (index, component) in relative.components().enumerate() {
        let Component::Normal(component) = component else {
            unreachable!("validated static output path has normal components")
        };
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                bail!(
                    "static output path {} must not be a symlink",
                    current.display()
                );
            }
            Ok(metadata) if index + 1 < relative.components().count() && !metadata.is_dir() => {
                bail!(
                    "static output parent {} must be a directory",
                    current.display()
                );
            }
            Ok(metadata) if index + 1 == relative.components().count() && !metadata.is_file() => {
                bail!(
                    "static output path {} must be a regular file",
                    current.display()
                );
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("failed to inspect {}", current.display()));
            }
        }
    }
    Ok(())
}

fn create_static_parent_directories(root: &Path, relative: &Path) -> Result<()> {
    let parent = relative.parent().expect("static file has a parent");
    let mut current = root.to_path_buf();
    for component in parent.components() {
        let Component::Normal(component) = component else {
            unreachable!("validated static output path has normal components")
        };
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                bail!(
                    "static output parent {} must be a real directory",
                    current.display()
                );
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => fs::create_dir(&current)
                .with_context(|| format!("failed to create {}", current.display()))?,
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("failed to inspect {}", current.display()));
            }
        }
    }
    Ok(())
}

fn output_plans(
    root: &Path,
    pack: &SourcePack,
    targets: &[Harness],
    skill_payloads: &BTreeMap<String, Vec<u8>>,
) -> Result<Vec<OutputPlan>> {
    let mut plans = Vec::new();
    for target in targets {
        match target {
            Harness::Claude => {
                let mut desired = BTreeMap::new();
                for agent in &pack.agents {
                    let resolved = pack.resolve(agent, Harness::Claude)?;
                    insert_output_file(
                        &mut desired,
                        PathBuf::from("agents").join(format!("{}.md", resolved.id)),
                        render_claude(&resolved).into_bytes(),
                    )?;
                }
                add_skill_payloads(&mut desired, skill_payloads)?;
                plans.push(OutputPlan {
                    kind: OutputKind::Claude,
                    root: root.join(".claude"),
                    desired,
                    previous: BTreeSet::new(),
                });
            }
            Harness::Codex => {
                let mut agents = BTreeMap::new();
                for agent in &pack.agents {
                    let resolved = pack.resolve(agent, Harness::Codex)?;
                    insert_output_file(
                        &mut agents,
                        PathBuf::from("agents").join(format!("{}.toml", resolved.id)),
                        render_codex(&resolved)
                            .context("failed to render Codex agent")?
                            .into_bytes(),
                    )?;
                }
                plans.push(OutputPlan {
                    kind: OutputKind::CodexAgents,
                    root: root.join(".codex"),
                    desired: agents,
                    previous: BTreeSet::new(),
                });
                let mut skills = BTreeMap::new();
                add_skill_payloads(&mut skills, skill_payloads)?;
                plans.push(OutputPlan {
                    kind: OutputKind::CodexSkills,
                    root: root.join(".agents"),
                    desired: skills,
                    previous: BTreeSet::new(),
                });
            }
        }
    }
    Ok(plans)
}

fn insert_output_file(
    desired: &mut BTreeMap<PathBuf, Vec<u8>>,
    path: PathBuf,
    contents: Vec<u8>,
) -> Result<()> {
    if desired.insert(path.clone(), contents).is_some() {
        bail!("duplicate generated output path {}", path.display());
    }
    Ok(())
}

fn add_skill_payloads(
    desired: &mut BTreeMap<PathBuf, Vec<u8>>,
    skill_payloads: &BTreeMap<String, Vec<u8>>,
) -> Result<()> {
    for (archive_path, bytes) in skill_payloads {
        let relative = archive_path
            .strip_prefix("skills/")
            .expect("skill payload paths always begin with skills/");
        insert_output_file(
            desired,
            PathBuf::from("skills").join(relative),
            bytes.clone(),
        )?;
    }
    Ok(())
}

fn prepare_output_plan(plan: &mut OutputPlan) -> Result<()> {
    ensure_real_or_missing_directory(&plan.root, "harness directory")?;
    plan.previous = load_generated_output_manifest(plan)?;

    for path in plan.previous.iter().chain(plan.desired.keys()) {
        ensure_managed_path_is_safe(plan, path)?;
    }
    for path in plan.desired.keys() {
        if !plan.previous.contains(path) && managed_file_exists(plan, path)? {
            bail!(
                "refusing to overwrite unmanaged harness definition {}",
                plan.root.join(path).display()
            );
        }
    }
    Ok(())
}

fn load_generated_output_manifest(plan: &OutputPlan) -> Result<BTreeSet<PathBuf>> {
    let marker = plan.root.join(GENERATED_OUTPUT_MANIFEST);
    let metadata = match fs::symlink_metadata(&marker) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            bail!(
                "generated-output manifest {} must not be a symlink",
                marker.display()
            );
        }
        Ok(metadata) if metadata.file_type().is_file() => metadata,
        Ok(_) => bail!(
            "generated-output manifest {} must be a file",
            marker.display()
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeSet::new()),
        Err(error) => {
            return Err(error).with_context(|| format!("failed to inspect {}", marker.display()));
        }
    };
    debug_assert!(metadata.file_type().is_file());
    let manifest: GeneratedOutputManifest = serde_json::from_slice(
        &fs::read(&marker).with_context(|| format!("failed to read {}", marker.display()))?,
    )
    .with_context(|| format!("invalid generated-output manifest {}", marker.display()))?;
    if manifest.format != GENERATED_OUTPUT_FORMAT || manifest.output != plan.kind.as_str() {
        bail!("invalid generated-output manifest {}", marker.display());
    }
    let mut paths = BTreeSet::new();
    for path in manifest.paths {
        let path = PathBuf::from(path);
        validate_managed_relative_path(plan.kind, &path)?;
        if !paths.insert(path.clone()) {
            bail!(
                "generated-output manifest {} lists {} more than once",
                marker.display(),
                path.display()
            );
        }
    }
    Ok(paths)
}

fn validate_managed_relative_path(kind: OutputKind, path: &Path) -> Result<()> {
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
        || !kind.allows_path(path)
    {
        bail!(
            "generated-output manifest contains an invalid {} path {}",
            kind.as_str(),
            path.display()
        );
    }
    Ok(())
}

fn ensure_managed_path_is_safe(plan: &OutputPlan, relative: &Path) -> Result<()> {
    validate_managed_relative_path(plan.kind, relative)?;
    let components = relative.components().collect::<Vec<_>>();
    let mut current = plan.root.clone();
    for (index, component) in components.iter().enumerate() {
        let std::path::Component::Normal(component) = component else {
            continue;
        };
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                bail!(
                    "generated output path {} must not be a symlink",
                    current.display()
                );
            }
            Ok(metadata) if index + 1 < components.len() && !metadata.file_type().is_dir() => {
                bail!(
                    "generated output parent {} must be a directory",
                    current.display()
                );
            }
            Ok(metadata) if index + 1 == components.len() && !metadata.file_type().is_file() => {
                bail!("generated output path {} must be a file", current.display());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("failed to inspect {}", current.display()));
            }
        }
    }
    Ok(())
}

fn managed_file_exists(plan: &OutputPlan, relative: &Path) -> Result<bool> {
    ensure_managed_path_is_safe(plan, relative)?;
    match fs::symlink_metadata(plan.root.join(relative)) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error)
            .with_context(|| format!("failed to inspect {}", plan.root.join(relative).display())),
    }
}

fn output_plan_is_stale(plan: &OutputPlan) -> bool {
    let expected_manifest = match generated_output_manifest_bytes(plan) {
        Ok(bytes) => bytes,
        Err(_) => return true,
    };
    match fs::read(plan.root.join(GENERATED_OUTPUT_MANIFEST)) {
        Ok(bytes) if bytes == expected_manifest => {}
        _ => return true,
    }
    plan.desired.iter().any(|(path, expected)| {
        fs::read(plan.root.join(path))
            .map(|contents| contents != *expected)
            .unwrap_or(true)
    })
}

fn apply_output_plan(plan: &OutputPlan) -> Result<()> {
    fs::create_dir_all(&plan.root)
        .with_context(|| format!("failed to create {}", plan.root.display()))?;
    for (path, contents) in &plan.desired {
        create_managed_parent_directories(plan, path)?;
        if plan.previous.contains(path) || !managed_file_exists(plan, path)? {
            fs::write(plan.root.join(path), contents)
                .with_context(|| format!("failed to write {}", plan.root.join(path).display()))?;
        }
    }
    let desired_paths = plan.desired.keys().cloned().collect::<BTreeSet<_>>();
    for path in plan.previous.difference(&desired_paths) {
        let full_path = plan.root.join(path);
        if managed_file_exists(plan, path)? {
            fs::remove_file(&full_path)
                .with_context(|| format!("failed to remove {}", full_path.display()))?;
            remove_empty_managed_parent_directories(plan, path)?;
        }
    }
    fs::write(
        plan.root.join(GENERATED_OUTPUT_MANIFEST),
        generated_output_manifest_bytes(plan)?,
    )
    .with_context(|| {
        format!(
            "failed to write {}",
            plan.root.join(GENERATED_OUTPUT_MANIFEST).display()
        )
    })?;
    Ok(())
}

fn create_managed_parent_directories(plan: &OutputPlan, relative: &Path) -> Result<()> {
    let parent = relative
        .parent()
        .expect("generated output path has a parent");
    let mut current = plan.root.clone();
    for component in parent.components() {
        let std::path::Component::Normal(component) = component else {
            continue;
        };
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                bail!(
                    "generated output directory {} must not be a symlink",
                    current.display()
                );
            }
            Ok(metadata) if metadata.file_type().is_dir() => {}
            Ok(_) => bail!(
                "generated output directory {} must be a directory",
                current.display()
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current)
                    .with_context(|| format!("failed to create {}", current.display()))?;
            }
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("failed to inspect {}", current.display()));
            }
        }
    }
    Ok(())
}

fn remove_empty_managed_parent_directories(plan: &OutputPlan, relative: &Path) -> Result<()> {
    let mut parent = relative.parent();
    while let Some(path) = parent {
        if path.components().count() <= 1 {
            break;
        }
        let directory = plan.root.join(path);
        match fs::remove_dir(&directory) {
            Ok(()) => parent = path.parent(),
            Err(error) if error.kind() == std::io::ErrorKind::DirectoryNotEmpty => break,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => parent = path.parent(),
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("failed to remove {}", directory.display()));
            }
        }
    }
    Ok(())
}

fn generated_output_manifest_bytes(plan: &OutputPlan) -> Result<Vec<u8>> {
    canonical_json(&GeneratedOutputManifest {
        format: GENERATED_OUTPUT_FORMAT.to_owned(),
        output: plan.kind.as_str().to_owned(),
        paths: plan
            .desired
            .keys()
            .map(|path| path.to_string_lossy().into_owned())
            .collect(),
    })
}

fn ensure_real_directory(path: &Path, description: &str) -> Result<()> {
    match fs::symlink_metadata(path)
        .with_context(|| format!("failed to inspect {}", path.display()))?
        .file_type()
    {
        file_type if file_type.is_symlink() => {
            bail!("{description} {} must not be a symlink", path.display());
        }
        file_type if file_type.is_dir() => Ok(()),
        _ => bail!("{description} {} must be a directory", path.display()),
    }
}

fn ensure_real_or_missing_directory(path: &Path, description: &str) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            bail!("{description} {} must not be a symlink", path.display());
        }
        Ok(metadata) if metadata.file_type().is_dir() => Ok(()),
        Ok(_) => bail!("{description} {} must be a directory", path.display()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("failed to inspect {}", path.display())),
    }
}

fn bundle(
    source: &Path,
    signing_key_path: &Path,
    metadata: &BundleMetadata,
) -> Result<(Vec<u8>, Vec<u8>)> {
    validate_bundle_metadata(metadata)?;
    let pack =
        SourcePack::load(source).with_context(|| format!("invalid source {}", source.display()))?;
    let mut payloads = collect_skill_payloads(source.join("skills"))?;
    let mut targets = pack.manifest.spec.targets.clone();
    targets.sort();
    for target in &targets {
        for (path, bytes) in
            collect_static_payloads(source.join(format!(".{}", target.as_str())), target.clone())?
        {
            if payloads.insert(path.clone(), bytes).is_some() {
                bail!("duplicate bundle payload {path}");
            }
        }
        for agent in &pack.agents {
            let resolved = pack.resolve(agent, target.clone())?;
            let (path, content) = match target {
                Harness::Claude => (
                    format!("targets/claude/agents/{}.md", resolved.id),
                    render_claude(&resolved),
                ),
                Harness::Codex => (
                    format!("targets/codex/agents/{}.toml", resolved.id),
                    render_codex(&resolved)?,
                ),
            };
            if payloads
                .insert(path.clone(), content.into_bytes())
                .is_some()
            {
                bail!("duplicate bundle payload {path}");
            }
        }
    }
    let harness_compatibility = compatibility_for(&targets, metadata)?;
    let manifest = ArtifactManifest {
        format: "thor-bundle/v1".to_owned(),
        minimum_thor_version: metadata.minimum_thor_version.clone(),
        package: ArtifactPackage {
            name: pack.manifest.metadata.name.clone(),
            version: pack.manifest.metadata.version.clone(),
        },
        source_repository: metadata.source_repository.clone(),
        source_release_tag: format!("v{}", pack.manifest.metadata.version),
        source_commit: metadata.source_commit.clone(),
        targets,
        harness_compatibility,
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
    };
    let manifest_bytes = canonical_json(&manifest)?;
    let mut archive_entries = payloads;
    archive_entries.insert("manifest.json".to_owned(), manifest_bytes);
    let archive = deterministic_zip(&archive_entries)?;
    let envelope = signature_envelope(&archive, signing_key_path)?;
    Ok((archive, canonical_json(&envelope)?))
}

fn validate_bundle_metadata(metadata: &BundleMetadata) -> Result<()> {
    if canonical_repository(&metadata.source_repository).is_none() {
        bail!("--source-repository must be a canonical owner/repository identity");
    }
    if !matches!(metadata.source_commit.len(), 40 | 64)
        || !metadata
            .source_commit
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        bail!(
            "--source-commit must be an exact 40- or 64-character lowercase hexadecimal commit id"
        );
    }
    if metadata
        .minimum_thor_version
        .parse::<semver::Version>()
        .is_err()
    {
        bail!("--minimum-thor-version must be a semantic version");
    }
    Ok(())
}

fn compatibility_for(
    targets: &[Harness],
    metadata: &BundleMetadata,
) -> Result<std::collections::BTreeMap<Harness, String>> {
    let mut compatibility = std::collections::BTreeMap::new();
    for target in targets {
        let value = match target {
            Harness::Claude => metadata.claude_compatibility.as_deref(),
            Harness::Codex => metadata.codex_compatibility.as_deref(),
        }
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            anyhow!(
                "--{}-compatibility is required for this pack",
                target.as_str()
            )
        })?;
        semver::VersionReq::parse(value).with_context(|| {
            format!(
                "--{}-compatibility must be a semantic-version requirement",
                target.as_str()
            )
        })?;
        compatibility.insert(target.clone(), value.to_owned());
    }
    Ok(compatibility)
}

fn canonical_repository(value: &str) -> Option<&str> {
    let (owner, repository) = value.split_once('/')?;
    if owner.is_empty()
        || repository.is_empty()
        || repository.contains('/')
        || !owner
            .bytes()
            .chain(repository.bytes())
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return None;
    }
    Some(value)
}

fn deterministic_zip(entries: &std::collections::BTreeMap<String, Vec<u8>>) -> Result<Vec<u8>> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    let options = FileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .last_modified_time(zip::DateTime::default())
        .unix_permissions(0o644);
    for (path, contents) in entries {
        writer
            .start_file(path, options)
            .with_context(|| format!("cannot add {path} to bundle"))?;
        writer
            .write_all(contents)
            .with_context(|| format!("cannot write {path} to bundle"))?;
    }
    writer
        .finish()
        .context("cannot finalize bundle")
        .map(Cursor::into_inner)
}

fn signature_envelope(archive: &[u8], signing_key_path: &Path) -> Result<SignatureEnvelope> {
    let signing_key = load_signing_key(signing_key_path)?;
    let verifying_key = signing_key.verifying_key();
    let signature = signing_key.sign(archive);
    Ok(SignatureEnvelope {
        format: "thor-signature/v1".to_owned(),
        algorithm: "ed25519".to_owned(),
        key_id: sha256_hex(verifying_key.as_bytes()),
        signature: BASE64.encode(signature.to_bytes()),
    })
}

fn load_signing_key(path: &Path) -> Result<SigningKey> {
    let encoded = fs::read_to_string(path)
        .with_context(|| format!("cannot read signing key {}", path.display()))?;
    let bytes = hex::decode(encoded.trim()).context("signing key must be hexadecimal")?;
    let seed: [u8; 32] = bytes
        .try_into()
        .map_err(|_: Vec<u8>| anyhow!("signing key must contain exactly 32 bytes"))?;
    Ok(SigningKey::from_bytes(&seed))
}

fn canonical_json<T: serde::Serialize>(value: &T) -> Result<Vec<u8>> {
    let mut json = serde_json::to_vec_pretty(value).context("cannot serialize JSON")?;
    json.push(b'\n');
    Ok(json)
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn write_new_file(path: &Path, contents: &[u8]) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .with_context(|| format!("refusing to overwrite existing {}", path.display()))?;
    file.write_all(contents)
        .with_context(|| format!("cannot write {}", path.display()))?;
    file.sync_all()
        .with_context(|| format!("cannot sync {}", path.display()))?;
    Ok(())
}

fn signature_path(bundle: &Path) -> PathBuf {
    PathBuf::from(format!("{}.sig", bundle.display()))
}

fn parse_target_selection(value: &str) -> Result<TargetSelection> {
    match value {
        "all" => Ok(TargetSelection::All),
        "claude" => Ok(TargetSelection::One(Harness::Claude)),
        "codex" => Ok(TargetSelection::One(Harness::Codex)),
        _ => bail!("target must be claude, codex, or all"),
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, io::Read};

    use ed25519_dalek::{Signature, Verifier};
    use tempfile::tempdir;
    use thor_core::{ArtifactManifest, SignatureEnvelope, preprocess_skill_file};
    use zip::ZipArchive;

    use super::*;

    const MANIFEST: &str = r#"
apiVersion: thor/v1alpha1
kind: AgentPack
metadata: { name: acme-engineering, version: 1.2.0, description: Agents. }
spec:
  targets: [claude, codex]
  models:
    frontier:
      description: Deep work.
      targets:
        claude: { model: opus, effort: high }
        codex: { model: gpt-5.6, effort: high }
"#;

    const AGENT: &str = r#"---
id: reviewer
description: Reviews changes.
model: frontier
requestedAccess: read-only
---

Review the change.
"#;

    #[test]
    fn defaults_to_the_assets_source_directory() {
        let cli = Cli::try_parse_from(["thor-build", "validate"]).unwrap();
        let Command::Validate { source } = cli.command else {
            panic!("expected validate command");
        };
        assert_eq!(source, PathBuf::from(DEFAULT_SOURCE_DIRECTORY));
    }

    #[test]
    fn transform_writes_agents_and_skills_to_harness_discovery_directories() {
        let source = tempdir().unwrap();
        write_source(source.path());
        let root = source.path().join("project");
        fs::create_dir(&root).unwrap();

        transform(source.path(), TargetSelection::All, &root, false).unwrap();

        assert!(root.join(".claude/agents/reviewer.md").is_file());
        assert!(root.join(".codex/agents/reviewer.toml").is_file());
        assert!(
            root.join(".claude/skills/review-checklist/SKILL.md")
                .is_file()
        );
        assert!(
            root.join(".agents/skills/review-checklist/references/severity.md")
                .is_file()
        );
        assert_eq!(
            fs::read(root.join(".claude/skills/review-checklist/SKILL.md")).unwrap(),
            fs::read(source.path().join("skills/review-checklist/SKILL.md")).unwrap()
        );
        assert_eq!(
            fs::read(root.join(".agents/skills/review-checklist/references/severity.md"),).unwrap(),
            fs::read(
                source
                    .path()
                    .join("skills/review-checklist/references/severity.md"),
            )
            .unwrap()
        );
        assert!(!root.join(".codex/skills").exists());
    }

    #[test]
    fn transform_expands_skill_markdown_for_both_targets_and_preserves_auxiliary_bytes() {
        let source = tempdir().unwrap();
        write_source(source.path());
        fs::create_dir(source.path().join("definitions")).unwrap();
        fs::write(
            source.path().join("definitions/assurance-terms.md"),
            "## Assurance terms\n\nA passing result has no findings or evidence gaps.\n",
        )
        .unwrap();
        let skill = source.path().join("skills/review-checklist");
        fs::write(
            skill.join("SKILL.md"),
            "---\nname: review-checklist\ndescription: A checklist.\n---\n\n<!-- thor:definitions: assurance-terms -->\n\n{{definition_bundles}}\n\nCheck changes.\n",
        )
        .unwrap();
        let script = b"#!/bin/sh\n\x00echo untouched\n";
        fs::write(skill.join("references/severity.md"), script).unwrap();
        let root = source.path().join("project");
        fs::create_dir(&root).unwrap();

        transform(source.path(), TargetSelection::All, &root, false).unwrap();

        let expected = preprocess_skill_file(source.path(), skill.join("SKILL.md")).unwrap();
        assert_eq!(
            fs::read(root.join(".claude/skills/review-checklist/SKILL.md")).unwrap(),
            expected
        );
        assert_eq!(
            fs::read(root.join(".agents/skills/review-checklist/SKILL.md")).unwrap(),
            expected
        );
        assert_eq!(
            fs::read(root.join(".claude/skills/review-checklist/references/severity.md")).unwrap(),
            script
        );
        assert_eq!(
            fs::read(root.join(".agents/skills/review-checklist/references/severity.md")).unwrap(),
            script
        );
    }

    #[test]
    fn transform_copies_and_replaces_target_scoped_static_files() {
        let source = tempdir().unwrap();
        write_source(source.path());
        fs::create_dir_all(source.path().join(".codex")).unwrap();
        fs::create_dir_all(source.path().join(".claude")).unwrap();
        fs::write(
            source.path().join(".codex/config.toml"),
            "[agents]\nmax_concurrent_threads_per_session = 16\n",
        )
        .unwrap();
        fs::write(
            source.path().join(".claude/settings.json"),
            "{\"enabled\":true}\n",
        )
        .unwrap();
        let root = source.path().join("project");
        fs::create_dir_all(root.join(".codex")).unwrap();
        fs::write(root.join(".codex/config.toml"), "local = true\n").unwrap();

        transform(source.path(), TargetSelection::All, &root, false).unwrap();

        assert_eq!(
            fs::read_to_string(root.join(".codex/config.toml")).unwrap(),
            "[agents]\nmax_concurrent_threads_per_session = 16\n"
        );
        assert_eq!(
            fs::read_to_string(root.join(".claude/settings.json")).unwrap(),
            "{\"enabled\":true}\n"
        );

        fs::write(
            source.path().join(".codex/config.toml"),
            "[agents]\nmax_concurrent_threads_per_session = 8\n",
        )
        .unwrap();
        assert!(transform(source.path(), TargetSelection::All, &root, true).is_err());
        transform(source.path(), TargetSelection::All, &root, false).unwrap();
        assert_eq!(
            fs::read_to_string(root.join(".codex/config.toml")).unwrap(),
            "[agents]\nmax_concurrent_threads_per_session = 8\n"
        );
    }

    #[test]
    fn transform_refreshes_owned_files_and_preserves_unrelated_harness_files() {
        let source = tempdir().unwrap();
        write_source(source.path());
        let root = source.path().join("project");
        fs::create_dir(&root).unwrap();

        transform(source.path(), TargetSelection::All, &root, false).unwrap();
        let local_agent = root.join(".claude/agents/local.md");
        let local_skill = root.join(".agents/skills/local/SKILL.md");
        fs::write(&local_agent, "local Claude agent\n").unwrap();
        fs::create_dir_all(local_skill.parent().unwrap()).unwrap();
        fs::write(&local_skill, "local Codex skill\n").unwrap();
        fs::write(
            source.path().join("agents/reviewer.md"),
            AGENT.replace("Review the change.", "Review the refreshed change."),
        )
        .unwrap();

        transform(source.path(), TargetSelection::All, &root, false).unwrap();

        assert!(
            fs::read_to_string(root.join(".claude/agents/reviewer.md"))
                .unwrap()
                .contains("Review the refreshed change.")
        );
        assert_eq!(
            fs::read_to_string(local_agent).unwrap(),
            "local Claude agent\n"
        );
        assert_eq!(
            fs::read_to_string(local_skill).unwrap(),
            "local Codex skill\n"
        );
    }

    #[test]
    fn transform_refuses_to_adopt_an_unmanaged_generated_path_with_matching_contents() {
        let source = tempdir().unwrap();
        write_source(source.path());
        let root = source.path().join("project");
        let agent = root.join(".claude/agents/reviewer.md");
        fs::create_dir_all(agent.parent().unwrap()).unwrap();
        let pack = SourcePack::load(source.path()).unwrap();
        let expected = render_claude(&pack.resolve(&pack.agents[0], Harness::Claude).unwrap());
        fs::write(&agent, &expected).unwrap();

        let error = transform(
            source.path(),
            TargetSelection::One(Harness::Claude),
            &root,
            false,
        )
        .unwrap_err();

        assert!(error.to_string().contains("unmanaged harness definition"));
        assert_eq!(fs::read_to_string(agent).unwrap(), expected);
        assert!(!root.join(".claude/.thor-generated.json").exists());
    }

    #[test]
    fn transform_removes_stale_owned_agents_and_skills() {
        let source = tempdir().unwrap();
        write_source(source.path());
        write_obsolete_source(source.path());
        let root = source.path().join("project");
        fs::create_dir(&root).unwrap();

        transform(source.path(), TargetSelection::All, &root, false).unwrap();
        fs::remove_file(source.path().join("agents/obsolete.md")).unwrap();
        fs::remove_dir_all(source.path().join("skills/obsolete")).unwrap();

        transform(source.path(), TargetSelection::All, &root, false).unwrap();

        for path in [
            ".claude/agents/obsolete.md",
            ".codex/agents/obsolete.toml",
            ".claude/skills/obsolete/SKILL.md",
            ".agents/skills/obsolete/SKILL.md",
        ] {
            assert!(!root.join(path).exists(), "{path} should be removed");
        }
    }

    #[test]
    fn transform_check_reports_source_drift_without_modifying_the_candidate_tree() {
        let source = tempdir().unwrap();
        write_source(source.path());
        let root = source.path().join("project");
        fs::create_dir(&root).unwrap();

        transform(source.path(), TargetSelection::All, &root, false).unwrap();
        transform(source.path(), TargetSelection::All, &root, true).unwrap();
        let generated = root.join(".claude/agents/reviewer.md");
        let original = fs::read(&generated).unwrap();
        fs::write(
            source.path().join("agents/reviewer.md"),
            AGENT.replace("Review the change.", "Review the changed source."),
        )
        .unwrap();

        let error = transform(source.path(), TargetSelection::All, &root, true).unwrap_err();

        assert!(
            error
                .to_string()
                .contains("generated harness definitions are stale")
        );
        assert_eq!(fs::read(&generated).unwrap(), original);
        transform(source.path(), TargetSelection::All, &root, false).unwrap();
        transform(source.path(), TargetSelection::All, &root, true).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn transform_refuses_a_symlinked_harness_directory() {
        use std::os::unix::fs::symlink;

        let source = tempdir().unwrap();
        write_source(source.path());
        let root = source.path().join("project");
        let external = tempdir().unwrap();
        fs::create_dir(&root).unwrap();
        symlink(external.path(), root.join(".claude")).unwrap();

        let error = transform(
            source.path(),
            TargetSelection::One(Harness::Claude),
            &root,
            false,
        )
        .unwrap_err();
        assert!(error.to_string().contains("must not be a symlink"));
        assert!(!external.path().join("agents/reviewer.md").exists());
    }

    #[cfg(unix)]
    #[test]
    fn transform_refuses_a_symlinked_generated_output_file() {
        use std::os::unix::fs::symlink;

        let source = tempdir().unwrap();
        write_source(source.path());
        let root = source.path().join("project");
        fs::create_dir(&root).unwrap();
        transform(
            source.path(),
            TargetSelection::One(Harness::Claude),
            &root,
            false,
        )
        .unwrap();
        let generated = root.join(".claude/agents/reviewer.md");
        let external = source.path().join("external.md");
        fs::write(&external, "external\n").unwrap();
        fs::remove_file(&generated).unwrap();
        symlink(&external, &generated).unwrap();

        let error = transform(
            source.path(),
            TargetSelection::One(Harness::Claude),
            &root,
            false,
        )
        .unwrap_err();

        assert!(error.to_string().contains("must not be a symlink"));
        assert_eq!(fs::read_to_string(external).unwrap(), "external\n");
    }

    #[test]
    fn transform_all_uses_only_targets_selected_by_the_pack() {
        let source = tempdir().unwrap();
        write_source(source.path());
        fs::write(
            source.path().join("thor.yaml"),
            MANIFEST.replace("targets: [claude, codex]", "targets: [claude]"),
        )
        .unwrap();
        let root = source.path().join("project");
        fs::create_dir(&root).unwrap();

        transform(source.path(), TargetSelection::All, &root, false).unwrap();

        assert!(root.join(".claude/agents/reviewer.md").is_file());
        assert!(!root.join(".codex").exists());
        assert!(!root.join(".agents").exists());
    }

    #[test]
    fn transform_cli_defaults_to_all_targets_in_the_current_project() {
        let cli = Cli::try_parse_from(["thor-build", "transform"]).unwrap();
        let Command::Transform {
            source,
            target,
            root,
            check,
        } = cli.command
        else {
            panic!("expected transform command");
        };
        assert_eq!(source, PathBuf::from(DEFAULT_SOURCE_DIRECTORY));
        assert_eq!(target, "all");
        assert_eq!(root, PathBuf::from(DEFAULT_PROJECT_ROOT));
        assert!(!check);
    }

    #[test]
    fn inventories_only_regular_portable_cli_release_assets() {
        let directory = tempdir().unwrap();
        fs::write(directory.path().join("thor-linux-amd64"), b"binary").unwrap();
        let manifest = cli_release_manifest(directory.path()).unwrap();
        assert_eq!(manifest.format, "thor-cli-release/v1");
        assert_eq!(manifest.assets["thor-linux-amd64"].bytes, 6);
        fs::write(directory.path().join("bad name"), b"bad").unwrap();
        assert!(cli_release_manifest(directory.path()).is_err());
    }

    #[test]
    fn signs_a_cli_release_inventory_including_the_pack_transformer() {
        let directory = tempdir().unwrap();
        fs::write(directory.path().join("thor-linux-amd64"), b"cli").unwrap();
        fs::write(directory.path().join("thor-build-linux-amd64"), b"builder").unwrap();
        let key_path = directory.path().join("key.txt");
        let signing_key = SigningKey::from_bytes(&[9u8; 32]);
        fs::write(&key_path, hex::encode(signing_key.to_bytes())).unwrap();

        let manifest = cli_release_manifest(directory.path()).unwrap();
        assert!(manifest.assets.contains_key("thor-build-linux-amd64"));
        let bytes = canonical_json(&manifest).unwrap();
        let envelope = signature_envelope(&bytes, &key_path).unwrap();
        let signature = Signature::from_slice(&BASE64.decode(envelope.signature).unwrap()).unwrap();
        signing_key
            .verifying_key()
            .verify(&bytes, &signature)
            .unwrap();
    }

    #[test]
    fn bundle_is_deterministic_and_signed() {
        let source = tempdir().unwrap();
        write_source(source.path());
        fs::create_dir(source.path().join("definitions")).unwrap();
        fs::write(
            source.path().join("definitions/assurance-terms.md"),
            "## Assurance terms\n\nA passing result has no findings or evidence gaps.\n",
        )
        .unwrap();
        fs::write(
            source.path().join("skills/review-checklist/SKILL.md"),
            "---\nname: review-checklist\ndescription: A checklist.\n---\n\n<!-- thor:definitions: assurance-terms -->\n\n{{definition_bundles}}\n\nCheck changes.\n",
        )
        .unwrap();
        fs::create_dir_all(source.path().join(".codex")).unwrap();
        fs::write(
            source.path().join(".codex/config.toml"),
            "[agents]\nmax_concurrent_threads_per_session = 16\n",
        )
        .unwrap();
        let key_path = source.path().join("key.txt");
        fs::write(&key_path, hex::encode([7u8; 32])).unwrap();
        let metadata = BundleMetadata {
            source_repository: "acme/agent-pack".to_owned(),
            source_commit: "0123456789abcdef0123456789abcdef01234567".to_owned(),
            minimum_thor_version: "0.1.0".to_owned(),
            claude_compatibility: Some(">=1.0.0".to_owned()),
            codex_compatibility: Some(">=1.0.0".to_owned()),
        };

        let (first_archive, first_signature) = bundle(source.path(), &key_path, &metadata).unwrap();
        let (second_archive, second_signature) =
            bundle(source.path(), &key_path, &metadata).unwrap();
        assert_eq!(first_archive, second_archive);
        assert_eq!(first_signature, second_signature);

        let signature: SignatureEnvelope = serde_json::from_slice(&first_signature).unwrap();
        assert_eq!(signature.format, "thor-signature/v1");
        let mut archive = ZipArchive::new(Cursor::new(first_archive)).unwrap();
        let mut manifest_bytes = Vec::new();
        archive
            .by_name("manifest.json")
            .unwrap()
            .read_to_end(&mut manifest_bytes)
            .unwrap();
        let manifest: ArtifactManifest = serde_json::from_slice(&manifest_bytes).unwrap();
        let mut skill_bytes = Vec::new();
        archive
            .by_name("skills/review-checklist/SKILL.md")
            .unwrap()
            .read_to_end(&mut skill_bytes)
            .unwrap();
        let skill = String::from_utf8(skill_bytes).unwrap();
        assert!(skill.contains("## Assurance terms"));
        assert!(!skill.contains("thor:definitions"));
        assert!(!skill.contains("{{definition_bundles}}"));
        assert!(
            manifest
                .payloads
                .contains_key("targets/claude/agents/reviewer.md")
        );
        assert!(
            manifest
                .payloads
                .contains_key("targets/codex/agents/reviewer.toml")
        );
        assert!(
            manifest
                .payloads
                .contains_key("skills/review-checklist/references/severity.md")
        );
        assert!(
            manifest
                .payloads
                .contains_key("targets/codex/static/config.toml")
        );
    }

    #[test]
    fn rejects_ambiguous_commit_ids_and_invalid_compatibility_ranges() {
        let short_commit = BundleMetadata {
            source_repository: "acme/agent-pack".to_owned(),
            source_commit: "0123456".to_owned(),
            minimum_thor_version: "0.1.0".to_owned(),
            claude_compatibility: Some(">=1.0.0".to_owned()),
            codex_compatibility: Some(">=1.0.0".to_owned()),
        };
        assert!(validate_bundle_metadata(&short_commit).is_err());

        let invalid_range = BundleMetadata {
            source_repository: "acme/agent-pack".to_owned(),
            source_commit: "0123456789abcdef0123456789abcdef01234567".to_owned(),
            minimum_thor_version: "0.1.0".to_owned(),
            claude_compatibility: Some("not a range".to_owned()),
            codex_compatibility: Some(">=1.0.0".to_owned()),
        };
        assert!(compatibility_for(&Harness::ALL, &invalid_range).is_err());
    }

    fn write_source(source: &Path) {
        fs::write(source.join("thor.yaml"), MANIFEST).unwrap();
        fs::create_dir(source.join("agents")).unwrap();
        fs::write(source.join("agents/reviewer.md"), AGENT).unwrap();
        let skill = source.join("skills/review-checklist");
        fs::create_dir_all(skill.join("references")).unwrap();
        fs::write(
            skill.join("SKILL.md"),
            "---\nname: review-checklist\ndescription: A checklist.\n---\n\nCheck changes.\n",
        )
        .unwrap();
        fs::write(skill.join("references/severity.md"), "# Severity\n").unwrap();
    }

    fn write_obsolete_source(source: &Path) {
        fs::write(
            source.join("agents/obsolete.md"),
            AGENT.replace("id: reviewer", "id: obsolete"),
        )
        .unwrap();
        let skill = source.join("skills/obsolete");
        fs::create_dir_all(&skill).unwrap();
        fs::write(
            skill.join("SKILL.md"),
            "---\nname: obsolete\ndescription: An obsolete skill.\n---\n\nRemove me.\n",
        )
        .unwrap();
    }
}
