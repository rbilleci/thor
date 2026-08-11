use std::{
    fs::{self, OpenOptions},
    io::{Cursor, Write},
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, anyhow, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use clap::{Parser, Subcommand};
use ed25519_dalek::{Signer, SigningKey};
use sha2::{Digest, Sha256};
use thor_core::{
    ArtifactManifest, ArtifactPackage, Harness, PayloadDigest, SignatureEnvelope, SourcePack,
    collect_skill_payloads, render_claude, render_codex,
};
use zip::{CompressionMethod, ZipWriter, write::FileOptions};

#[derive(Debug, Parser)]
#[command(
    name = "thor-build",
    about = "CI-only Thor source validator and transformer"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Validate a Thor agent-pack source directory.
    Validate {
        #[arg(long, default_value = ".")]
        source: PathBuf,
    },
    /// Transform a Thor agent pack into one target's generated definitions.
    Transform {
        #[arg(long, default_value = ".")]
        source: PathBuf,
        #[arg(long)]
        target: String,
        #[arg(long)]
        out: PathBuf,
    },
    /// Transform, validate, and sign a deterministic release bundle.
    Bundle {
        #[arg(long, default_value = ".")]
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
        claude_code_compatibility: Option<String>,
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
            out,
        } => transform(&source, parse_target(&target)?, &out)?,
        Command::Bundle {
            source,
            out,
            signing_key,
            source_repository,
            source_commit,
            minimum_thor_version,
            claude_code_compatibility,
            codex_compatibility,
        } => {
            let metadata = BundleMetadata {
                source_repository,
                source_commit,
                minimum_thor_version,
                claude_code_compatibility,
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
    claude_code_compatibility: Option<String>,
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

fn transform(source: &Path, target: Harness, out: &Path) -> Result<()> {
    let pack =
        SourcePack::load(source).with_context(|| format!("invalid source {}", source.display()))?;
    if !pack.manifest.spec.targets.contains(&target) {
        bail!(
            "target {} is not selected by {}",
            target.as_str(),
            source.join("thor.yaml").display()
        );
    }
    ensure_empty_output_directory(out)?;
    let agents_dir = out.join("agents");
    fs::create_dir_all(&agents_dir)
        .with_context(|| format!("failed to create {}", agents_dir.display()))?;
    for agent in &pack.agents {
        let resolved = pack.resolve(agent, target.clone())?;
        let (filename, content) = match target {
            Harness::ClaudeCode => (format!("{}.md", resolved.id), render_claude(&resolved)),
            Harness::Codex => (
                format!("{}.toml", resolved.id),
                render_codex(&resolved).context("failed to render Codex agent")?,
            ),
        };
        let path = agents_dir.join(filename);
        fs::write(&path, content).with_context(|| format!("failed to write {}", path.display()))?;
    }
    println!(
        "generated {} agent(s) for {}",
        pack.agents.len(),
        target.as_str()
    );
    Ok(())
}

fn ensure_empty_output_directory(out: &Path) -> Result<()> {
    if out.exists() {
        if !out.is_dir() {
            bail!(
                "output path {} exists and is not a directory",
                out.display()
            );
        }
        if fs::read_dir(out)
            .with_context(|| format!("failed to inspect {}", out.display()))?
            .next()
            .is_some()
        {
            bail!(
                "output directory {} must be empty; transform never mixes generated files with existing output",
                out.display()
            );
        }
    } else {
        fs::create_dir_all(out).with_context(|| format!("failed to create {}", out.display()))?;
    }
    Ok(())
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
        for agent in &pack.agents {
            let resolved = pack.resolve(agent, target.clone())?;
            let (path, content) = match target {
                Harness::ClaudeCode => (
                    format!("targets/claude-code/agents/{}.md", resolved.id),
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
            Harness::ClaudeCode => metadata.claude_code_compatibility.as_deref(),
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

fn parse_target(value: &str) -> Result<Harness> {
    match value {
        "claude-code" => Ok(Harness::ClaudeCode),
        "codex" => Ok(Harness::Codex),
        _ => bail!("target must be claude-code or codex"),
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, io::Read};

    use ed25519_dalek::{Signature, Verifier};
    use tempfile::tempdir;
    use thor_core::{ArtifactManifest, SignatureEnvelope};
    use zip::ZipArchive;

    use super::*;

    const MANIFEST: &str = r#"
apiVersion: thor/v1alpha1
kind: AgentPack
metadata: { name: acme-engineering, version: 1.2.0, description: Agents. }
spec:
  targets: [claude-code, codex]
  models:
    frontier:
      description: Deep work.
      targets: { claude-code: opus, codex: gpt-5.6 }
  efforts:
    low: { targets: { claude-code: low, codex: low } }
    medium: { targets: { claude-code: medium, codex: medium } }
    high: { targets: { claude-code: high, codex: high } }
    xhigh: { targets: { claude-code: xhigh, codex: xhigh } }
    max: { targets: { claude-code: max, codex: max } }
"#;

    const AGENT: &str = r#"---
id: reviewer
description: Reviews changes.
model: frontier
effort: high
requestedAccess: read-only
---

Review the change.
"#;

    #[test]
    fn transform_refuses_to_mix_with_stale_output() {
        let source = tempdir().unwrap();
        fs::write(source.path().join("thor.yaml"), MANIFEST).unwrap();
        fs::create_dir(source.path().join("agents")).unwrap();
        fs::write(source.path().join("agents/reviewer.md"), AGENT).unwrap();
        let output = source.path().join("generated");

        transform(source.path(), Harness::Codex, &output).unwrap();
        assert!(output.join("agents/reviewer.toml").is_file());
        let error = transform(source.path(), Harness::Codex, &output).unwrap_err();
        assert!(error.to_string().contains("must be empty"));
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
        fs::write(source.path().join("thor.yaml"), MANIFEST).unwrap();
        fs::create_dir(source.path().join("agents")).unwrap();
        fs::write(source.path().join("agents/reviewer.md"), AGENT).unwrap();
        let skill = source.path().join("skills/review-checklist");
        fs::create_dir_all(skill.join("references")).unwrap();
        fs::write(
            skill.join("SKILL.md"),
            "---\nname: review-checklist\ndescription: A checklist.\n---\n\nCheck changes.\n",
        )
        .unwrap();
        fs::write(skill.join("references/severity.md"), "# Severity\n").unwrap();
        let key_path = source.path().join("key.txt");
        fs::write(&key_path, hex::encode([7u8; 32])).unwrap();
        let metadata = BundleMetadata {
            source_repository: "acme/agent-pack".to_owned(),
            source_commit: "0123456789abcdef0123456789abcdef01234567".to_owned(),
            minimum_thor_version: "0.1.0".to_owned(),
            claude_code_compatibility: Some(">=1.0.0".to_owned()),
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
    }

    #[test]
    fn rejects_ambiguous_commit_ids_and_invalid_compatibility_ranges() {
        let short_commit = BundleMetadata {
            source_repository: "acme/agent-pack".to_owned(),
            source_commit: "0123456".to_owned(),
            minimum_thor_version: "0.1.0".to_owned(),
            claude_code_compatibility: Some(">=1.0.0".to_owned()),
            codex_compatibility: Some(">=1.0.0".to_owned()),
        };
        assert!(validate_bundle_metadata(&short_commit).is_err());

        let invalid_range = BundleMetadata {
            source_repository: "acme/agent-pack".to_owned(),
            source_commit: "0123456789abcdef0123456789abcdef01234567".to_owned(),
            minimum_thor_version: "0.1.0".to_owned(),
            claude_code_compatibility: Some("not a range".to_owned()),
            codex_compatibility: Some(">=1.0.0".to_owned()),
        };
        assert!(compatibility_for(&Harness::ALL, &invalid_range).is_err());
    }
}
