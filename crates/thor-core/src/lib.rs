//! Strict Thor v1 source parsing, validation, and target rendering.
//!
//! This crate is deliberately the only place that knows the portable source
//! model. `thor-build` uses it in CI and the local installer will use its
//! artifact types, preventing two incompatible interpretations of the format.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Component, Path, PathBuf},
};

use semver::Version;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use walkdir::WalkDir;

pub const API_VERSION: &str = "thor/v1alpha1";
pub const KIND: &str = "AgentPack";
pub const SCHEMA: &str = include_str!("../../../schema/thor-v1.schema.json");
const AGENT_INSTRUCTIONS_SLOT: &str = "{{agent_instructions}}";
const DEFINITION_BUNDLES_SLOT: &str = "{{definition_bundles}}";
const SKILL_DEFINITION_DIRECTIVE_PREFIX: &str = "<!-- thor:definitions: ";
const SKILL_DEFINITION_DIRECTIVE_SUFFIX: &str = " -->";

pub type Result<T> = std::result::Result<T, ThorError>;

#[derive(Debug, Error)]
pub enum ThorError {
    #[error("failed to read {path}: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("{path}: invalid UTF-8: {source}")]
    Utf8 {
        path: PathBuf,
        #[source]
        source: std::string::FromUtf8Error,
    },
    #[error("{path}: invalid YAML: {source}")]
    Yaml {
        path: PathBuf,
        #[source]
        source: serde_yaml::Error,
    },
    #[error("{path}: {message}")]
    Validation { path: PathBuf, message: String },
    #[error("invalid embedded JSON schema: {0}")]
    Schema(String),
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Harness {
    Claude,
    Codex,
}

impl Harness {
    pub const ALL: [Self; 2] = [Self::Claude, Self::Codex];

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PackageManifest {
    #[serde(rename = "apiVersion")]
    pub api_version: String,
    pub kind: String,
    pub metadata: PackageMetadata,
    pub spec: PackageSpec,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PackageMetadata {
    pub name: String,
    pub version: String,
    pub description: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PackageSpec {
    pub targets: Vec<Harness>,
    pub models: BTreeMap<String, ModelMapping>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ModelMapping {
    pub description: String,
    pub targets: BTreeMap<Harness, TargetModel>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TargetModel {
    pub model: String,
    pub effort: Effort,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Effort {
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl Effort {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
            Self::Max => "max",
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AgentFrontmatter {
    pub id: String,
    pub description: String,
    pub model: String,
    #[serde(rename = "requestedAccess")]
    pub requested_access: RequestedAccess,
    pub template: Option<String>,
    #[serde(default)]
    pub definitions: Vec<String>,
    #[serde(default)]
    pub targets: AgentTargets,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AgentTargets {
    pub claude: Option<ClaudeSettings>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ClaudeSettings {
    pub max_turns: Option<u32>,
    pub background: Option<bool>,
    pub isolation: Option<ClaudeIsolation>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ClaudeIsolation {
    Worktree,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RequestedAccess {
    Inherit,
    ReadOnly,
    WorkspaceWrite,
}

#[derive(Debug, Clone)]
pub struct AgentDefinition {
    pub frontmatter: AgentFrontmatter,
    pub instructions: String,
    pub source_path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct SourcePack {
    pub manifest: PackageManifest,
    pub manifest_path: PathBuf,
    pub agents: Vec<AgentDefinition>,
    definition_bundles: DefinitionBundles,
}

#[derive(Debug, Clone)]
pub struct ResolvedAgent {
    pub id: String,
    pub description: String,
    pub instructions: String,
    pub requested_access: RequestedAccess,
    pub claude_settings: Option<ClaudeSettings>,
    pub model: String,
    pub effort: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactManifest {
    pub format: String,
    pub minimum_thor_version: String,
    pub package: ArtifactPackage,
    pub source_repository: String,
    pub source_release_tag: String,
    pub source_commit: String,
    pub targets: Vec<Harness>,
    pub harness_compatibility: BTreeMap<Harness, String>,
    pub payloads: BTreeMap<String, PayloadDigest>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ArtifactPackage {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PayloadDigest {
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignatureEnvelope {
    pub format: String,
    pub algorithm: String,
    pub key_id: String,
    pub signature: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SkillFrontmatter {
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone)]
pub struct SkillDefinition {
    pub frontmatter: SkillFrontmatter,
    pub instructions: String,
    pub source_path: PathBuf,
    source: String,
    instructions_offset: usize,
}

type DefinitionBundles = BTreeMap<String, String>;

impl SourcePack {
    pub fn load(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref();
        let manifest_path = root.join("thor.yaml");
        let manifest = parse_package_file(&manifest_path)?;
        let definition_bundles = load_definition_sources(root)?;
        let agents_dir = root.join("agents");
        ensure_real_directory(&agents_dir, "agents directory")?;
        let entries = fs::read_dir(&agents_dir).map_err(|source| ThorError::Read {
            path: agents_dir.clone(),
            source,
        })?;

        let mut agents = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|source| ThorError::Read {
                path: agents_dir.clone(),
                source,
            })?;
            let file_type = entry.file_type().map_err(|source| ThorError::Read {
                path: entry.path(),
                source,
            })?;
            if file_type.is_dir() {
                return validation(entry.path(), "agent directories are not allowed in v1");
            }
            if !file_type.is_file() || entry.path().extension().is_none_or(|ext| ext != "md") {
                return validation(entry.path(), "agents/ may contain only Markdown files");
            }
            let mut agent = parse_agent_file(entry.path())?;
            expand_agent_instructions(&definition_bundles, &mut agent)?;
            agents.push(agent);
        }
        if agents.is_empty() {
            return validation(agents_dir, "at least one agent definition is required");
        }
        agents.sort_by(|left, right| left.frontmatter.id.cmp(&right.frontmatter.id));

        validate_pack(&manifest, &manifest_path, &agents)?;
        Ok(Self {
            manifest,
            manifest_path,
            agents,
            definition_bundles,
        })
    }

    pub fn resolve(&self, agent: &AgentDefinition, target: Harness) -> Result<ResolvedAgent> {
        if !self.manifest.spec.targets.contains(&target) {
            return validation(
                &self.manifest_path,
                format!("target {} is not enabled for this pack", target.as_str()),
            );
        }
        let mapping = self
            .manifest
            .spec
            .models
            .get(&agent.frontmatter.model)
            .and_then(|mapping| mapping.targets.get(&target))
            .ok_or_else(|| ThorError::Validation {
                path: agent.source_path.clone(),
                message: format!(
                    "model {} has no {} mapping",
                    agent.frontmatter.model,
                    target.as_str()
                ),
            })?;

        Ok(ResolvedAgent {
            id: agent.frontmatter.id.clone(),
            description: agent.frontmatter.description.clone(),
            instructions: agent.instructions.clone(),
            requested_access: agent.frontmatter.requested_access,
            claude_settings: agent.frontmatter.targets.claude.clone(),
            model: mapping.model.clone(),
            effort: mapping.effort.as_str().to_owned(),
        })
    }

    pub fn definition_bundles(&self) -> &BTreeMap<String, String> {
        &self.definition_bundles
    }
}

pub fn parse_package_file(path: impl AsRef<Path>) -> Result<PackageManifest> {
    let path = path.as_ref();
    ensure_regular_source_file(path, "package manifest")?;
    let text = read_utf8(path)?;
    validate_against_schema(path, &text, "packageManifest")?;
    let manifest: PackageManifest =
        serde_yaml::from_str(&text).map_err(|source| ThorError::Yaml {
            path: path.to_path_buf(),
            source,
        })?;
    validate_manifest(&manifest, path)?;
    Ok(manifest)
}

pub fn parse_agent_file(path: impl AsRef<Path>) -> Result<AgentDefinition> {
    let path = path.as_ref();
    ensure_regular_source_file(path, "agent definition")?;
    let text = read_utf8(path)?;
    let (frontmatter, instructions) = split_frontmatter(path, &text)?;
    reject_reserved_definition_syntax(path, frontmatter, "agent frontmatter")?;
    reject_skill_definition_directive(path, instructions, "agent instructions")?;
    validate_against_schema(path, frontmatter, "agentFrontmatter")?;
    let frontmatter: AgentFrontmatter =
        serde_yaml::from_str(frontmatter).map_err(|source| ThorError::Yaml {
            path: path.to_path_buf(),
            source,
        })?;
    if instructions.trim().is_empty() {
        return validation(path, "agent instructions must not be empty");
    }
    if frontmatter.description.contains(['\n', '\r']) {
        return validation(path, "agent description must be one line");
    }
    validate_identifier(path, "agent id", &frontmatter.id)?;
    let expected_file = format!("{}.md", frontmatter.id);
    if path.file_name().and_then(|name| name.to_str()) != Some(expected_file.as_str()) {
        return validation(
            path,
            format!("agent filename must be {expected_file} to match its id"),
        );
    }
    Ok(AgentDefinition {
        frontmatter,
        instructions: instructions.to_owned(),
        source_path: path.to_path_buf(),
    })
}

fn expand_agent_instructions(
    definitions: &DefinitionBundles,
    agent: &mut AgentDefinition,
) -> Result<()> {
    let definition_bundles = load_definition_bundles(
        definitions,
        &agent.source_path,
        &agent.frontmatter.definitions,
    )?;
    let (instructions, instruction_origin, instruction_owner) = if let Some(template_id) =
        agent.frontmatter.template.as_deref()
    {
        validate_identifier(&agent.source_path, "agent template", template_id)?;

        let root = agent
            .source_path
            .parent()
            .and_then(Path::parent)
            .expect("agent definitions always have an assets/agents parent");
        let templates_dir = root.join("templates");
        ensure_real_directory(&templates_dir, "templates directory")?;
        let template_path = templates_dir.join(format!("{template_id}.md"));
        ensure_regular_source_file(&template_path, "agent template")?;
        let template = read_utf8(&template_path)?;
        reject_skill_definition_directive(&template_path, &template, "agent template")?;

        let slot_count = template.match_indices(AGENT_INSTRUCTIONS_SLOT).count();
        if slot_count != 1 {
            return validation(
                &template_path,
                format!("agent template must contain exactly one {AGENT_INSTRUCTIONS_SLOT} slot"),
            );
        }
        let template_definition_slot_count =
            template.match_indices(DEFINITION_BUNDLES_SLOT).count();
        if definition_bundles.is_empty() {
            if template_definition_slot_count != 0 {
                return validation(
                    &template_path,
                    format!(
                        "agent template selects no definitions but contains {DEFINITION_BUNDLES_SLOT}"
                    ),
                );
            }
        } else if template_definition_slot_count != 1 {
            return validation(
                &template_path,
                format!(
                    "agent template with definitions must contain exactly one {DEFINITION_BUNDLES_SLOT} slot"
                ),
            );
        }
        if agent.instructions.contains(DEFINITION_BUNDLES_SLOT) {
            return validation(
                &agent.source_path,
                format!(
                    "agent instructions may not contain {DEFINITION_BUNDLES_SLOT} when an agent template is selected"
                ),
            );
        }
        let template = template.replacen(AGENT_INSTRUCTIONS_SLOT, agent.instructions.trim(), 1);
        (
            expand_definition_bundles(
                &template_path,
                &template,
                &definition_bundles,
                "agent template",
            )?,
            template_path,
            "agent template",
        )
    } else {
        (
            expand_definition_bundles(
                &agent.source_path,
                &agent.instructions,
                &definition_bundles,
                "agent instructions",
            )?,
            agent.source_path.clone(),
            "agent instructions",
        )
    };

    if instructions.contains("{{") || instructions.contains("}}") {
        return validation(
            &instruction_origin,
            format!(
                "{instruction_owner} supports only the {AGENT_INSTRUCTIONS_SLOT} and {DEFINITION_BUNDLES_SLOT} slots"
            ),
        );
    }
    agent.instructions = instructions;
    Ok(())
}

fn load_definition_bundles(
    definitions: &DefinitionBundles,
    source_path: &Path,
    definition_ids: &[String],
) -> Result<String> {
    if definition_ids.is_empty() {
        return Ok(String::new());
    }

    let mut seen = BTreeSet::new();
    let mut bundles = Vec::new();
    for definition_id in definition_ids {
        validate_identifier(source_path, "definition bundle", definition_id)?;
        if !seen.insert(definition_id) {
            return validation(
                source_path,
                format!("duplicate definition bundle {definition_id}"),
            );
        }
        let definition = definitions
            .get(definition_id)
            .ok_or_else(|| ThorError::Validation {
                path: source_path.to_path_buf(),
                message: format!("definition bundle {definition_id} does not exist"),
            })?;
        bundles.push(definition.trim().to_owned());
    }
    Ok(bundles.join("\n\n"))
}

fn load_definition_sources(root: &Path) -> Result<DefinitionBundles> {
    let definitions_dir = root.join("definitions");
    match fs::symlink_metadata(&definitions_dir) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(source) => {
            return Err(ThorError::Read {
                path: definitions_dir.clone(),
                source,
            });
        }
    }
    ensure_real_directory(&definitions_dir, "definitions directory")?;
    let entries = fs::read_dir(&definitions_dir).map_err(|source| ThorError::Read {
        path: definitions_dir.clone(),
        source,
    })?;
    let mut names = BTreeMap::new();
    let mut definitions = BTreeMap::new();
    for entry in entries {
        let entry = entry.map_err(|source| ThorError::Read {
            path: definitions_dir.clone(),
            source,
        })?;
        let path = entry.path();
        let file_type = entry.file_type().map_err(|source| ThorError::Read {
            path: path.clone(),
            source,
        })?;
        if !file_type.is_file() || path.extension().is_none_or(|extension| extension != "md") {
            return validation(path, "definitions/ may contain only Markdown files");
        }
        let definition_id = path
            .file_stem()
            .and_then(|name| name.to_str())
            .ok_or_else(|| ThorError::Validation {
                path: path.clone(),
                message: "definition filename must be UTF-8".to_owned(),
            })?;
        validate_identifier(&path, "definition filename", definition_id)?;
        let expected_name = format!("{definition_id}.md");
        if path.file_name().and_then(|name| name.to_str()) != Some(expected_name.as_str()) {
            return validation(path, format!("definition filename must be {expected_name}"));
        }
        let folded = definition_id.to_ascii_lowercase();
        if let Some(previous) = names.insert(folded, definition_id.to_owned()) {
            return validation(
                path,
                format!(
                    "definition bundle collides on a case-insensitive filesystem with {previous}"
                ),
            );
        }
        ensure_regular_source_file(&path, "definition bundle")?;
        let definition = read_utf8(&path)?;
        validate_definition_content(&path, &definition)?;
        definitions.insert(definition_id.to_owned(), definition);
    }
    Ok(definitions)
}

fn validate_definition_content(path: &Path, definition: &str) -> Result<()> {
    if definition.trim().is_empty() {
        return validation(path, "definition bundle must not be empty");
    }
    if definition.contains(DEFINITION_BUNDLES_SLOT)
        || definition.contains(AGENT_INSTRUCTIONS_SLOT)
        || definition.contains("<!-- thor:definitions")
    {
        return validation(
            path,
            "definition bundles may not include Thor markers or definition directives",
        );
    }
    Ok(())
}

fn reject_reserved_definition_syntax(path: &Path, text: &str, location: &str) -> Result<()> {
    if text.contains(DEFINITION_BUNDLES_SLOT) {
        return validation(
            path,
            format!("{location} may not contain {DEFINITION_BUNDLES_SLOT}"),
        );
    }
    reject_skill_definition_directive(path, text, location)
}

fn reject_skill_definition_directive(path: &Path, text: &str, location: &str) -> Result<()> {
    if text.contains("<!-- thor:definitions") {
        return validation(
            path,
            format!("{location} may not contain a skill definition directive"),
        );
    }
    Ok(())
}

fn expand_definition_bundles(
    path: &Path,
    text: &str,
    definition_bundles: &str,
    owner: &str,
) -> Result<String> {
    let marker_count = text.match_indices(DEFINITION_BUNDLES_SLOT).count();
    if definition_bundles.is_empty() {
        if marker_count != 0 {
            return validation(
                path,
                format!(
                    "{owner} has a {DEFINITION_BUNDLES_SLOT} marker but selects no definitions"
                ),
            );
        }
        return Ok(text.to_owned());
    }
    if marker_count != 1 {
        return validation(
            path,
            format!(
                "{owner} that selects definitions must contain exactly one {DEFINITION_BUNDLES_SLOT} marker"
            ),
        );
    }
    Ok(text.replacen(DEFINITION_BUNDLES_SLOT, definition_bundles, 1))
}

pub fn parse_skill_file(path: impl AsRef<Path>) -> Result<SkillDefinition> {
    let path = path.as_ref();
    ensure_regular_source_file(path, "skill definition")?;
    let text = read_utf8(path)?;
    let (frontmatter, instructions) = split_frontmatter(path, &text)?;
    reject_reserved_definition_syntax(path, frontmatter, "skill frontmatter")?;
    let frontmatter: SkillFrontmatter =
        serde_yaml::from_str(frontmatter).map_err(|source| ThorError::Yaml {
            path: path.to_path_buf(),
            source,
        })?;
    if frontmatter.name.trim().is_empty() || frontmatter.description.trim().is_empty() {
        return validation(path, "skill name and description must not be empty");
    }
    if instructions.trim().is_empty() {
        return validation(path, "skill instructions must not be empty");
    }
    let instructions_offset = text.len() - instructions.len();
    Ok(SkillDefinition {
        frontmatter,
        instructions: instructions.to_owned(),
        source_path: path.to_path_buf(),
        source: text,
        instructions_offset,
    })
}

/// Expands the Thor-only definition directive in one `SKILL.md` source file.
/// Every other file in a skill tree remains an opaque byte payload.
pub fn preprocess_skill_file(root: impl AsRef<Path>, path: impl AsRef<Path>) -> Result<Vec<u8>> {
    let root = root.as_ref();
    let path = path.as_ref();
    let definitions = load_definition_sources(root)?;
    let skill = parse_skill_file(path)?;
    preprocess_skill_definition(&skill, &definitions)
}

fn preprocess_skill_definition(
    skill: &SkillDefinition,
    definitions: &DefinitionBundles,
) -> Result<Vec<u8>> {
    let (definition_ids, instructions) =
        extract_skill_definition_directive(&skill.source_path, &skill.instructions)?;
    let definition_bundles =
        load_definition_bundles(definitions, &skill.source_path, &definition_ids)?;
    let instructions = expand_definition_bundles(
        &skill.source_path,
        &instructions,
        &definition_bundles,
        "skill instructions",
    )?;
    Ok(format!(
        "{}{instructions}",
        &skill.source[..skill.instructions_offset]
    )
    .into_bytes())
}

fn extract_skill_definition_directive(
    path: &Path,
    instructions: &str,
) -> Result<(Vec<String>, String)> {
    let mut definition_ids = None;
    let mut output = String::new();
    for line in instructions.split_inclusive('\n') {
        let content = line_content(line);
        if content.contains("<!-- thor:definitions") {
            if !content.starts_with(SKILL_DEFINITION_DIRECTIVE_PREFIX)
                || !content.ends_with(SKILL_DEFINITION_DIRECTIVE_SUFFIX)
            {
                return validation(
                    path,
                    "skill definition directive must be exactly <!-- thor:definitions: <id>[, <id>...] -->",
                );
            }
            if definition_ids.is_some() {
                return validation(path, "skill may declare definition bundles only once");
            }
            let value = &content[SKILL_DEFINITION_DIRECTIVE_PREFIX.len()
                ..content.len() - SKILL_DEFINITION_DIRECTIVE_SUFFIX.len()];
            let ids = value
                .split(',')
                .map(str::trim)
                .map(str::to_owned)
                .collect::<Vec<_>>();
            if ids.is_empty() || ids.iter().any(|id| id.is_empty()) {
                return validation(
                    path,
                    "skill definition directive must name at least one definition bundle",
                );
            }
            definition_ids = Some(ids);
        } else {
            output.push_str(line);
        }
    }
    Ok((definition_ids.unwrap_or_default(), output))
}

/// Validates portable skill trees and returns their archive payloads in sorted
/// archive-path order. Thor preprocesses only each `SKILL.md`; scripts,
/// references, and assets are copied as opaque bytes and are never run.
pub fn collect_skill_payloads(skills_root: impl AsRef<Path>) -> Result<BTreeMap<String, Vec<u8>>> {
    collect_skill_payloads_inner(skills_root.as_ref(), None)
}

pub fn collect_skill_payloads_with_definitions(
    skills_root: impl AsRef<Path>,
    definitions: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, Vec<u8>>> {
    collect_skill_payloads_inner(skills_root.as_ref(), Some(definitions))
}

fn collect_skill_payloads_inner(
    skills_root: &Path,
    definitions: Option<&BTreeMap<String, String>>,
) -> Result<BTreeMap<String, Vec<u8>>> {
    if !skills_root.exists() {
        return Ok(BTreeMap::new());
    }
    let root_metadata = fs::symlink_metadata(skills_root).map_err(|source| ThorError::Read {
        path: skills_root.to_path_buf(),
        source,
    })?;
    if !root_metadata.file_type().is_dir() || root_metadata.file_type().is_symlink() {
        return validation(skills_root, "skills must be a real directory");
    }
    let source_root = skills_root.parent().ok_or_else(|| ThorError::Validation {
        path: skills_root.to_path_buf(),
        message: "skills directory must have a source root".to_owned(),
    })?;
    let loaded_definitions;
    let definitions = if let Some(definitions) = definitions {
        definitions
    } else {
        loaded_definitions = load_definition_sources(source_root)?;
        &loaded_definitions
    };

    let mut payloads = BTreeMap::new();
    let mut portable_payload_paths = BTreeMap::new();
    for entry in fs::read_dir(skills_root).map_err(|source| ThorError::Read {
        path: skills_root.to_path_buf(),
        source,
    })? {
        let entry = entry.map_err(|source| ThorError::Read {
            path: skills_root.to_path_buf(),
            source,
        })?;
        let skill_dir = entry.path();
        let metadata = fs::symlink_metadata(&skill_dir).map_err(|source| ThorError::Read {
            path: skill_dir.clone(),
            source,
        })?;
        if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
            return validation(&skill_dir, "every skills/ entry must be a real directory");
        }
        let skill_id = entry
            .file_name()
            .into_string()
            .map_err(|_| ThorError::Validation {
                path: skill_dir.clone(),
                message: "skill directory name must be UTF-8".to_owned(),
            })?;
        validate_identifier(&skill_dir, "skill directory name", &skill_id)?;

        let skill_file = skill_dir.join("SKILL.md");
        ensure_regular_source_file(&skill_file, "skill definition")?;
        let skill = parse_skill_file(&skill_file)?;
        if skill.frontmatter.name != skill_id {
            return validation(
                &skill_file,
                format!("skill frontmatter name must equal directory name {skill_id}"),
            );
        }
        validate_identifier(&skill_file, "skill name", &skill.frontmatter.name)?;

        for walked in WalkDir::new(&skill_dir).follow_links(false) {
            let walked = walked.map_err(|error| ThorError::Validation {
                path: skill_dir.clone(),
                message: format!("cannot walk skill tree: {error}"),
            })?;
            if walked.path() == skill_dir {
                continue;
            }
            let file_type = walked.file_type();
            if file_type.is_symlink() || (!file_type.is_file() && !file_type.is_dir()) {
                return validation(
                    walked.path(),
                    "skill trees may contain only regular files and directories",
                );
            }
            let relative = walked
                .path()
                .strip_prefix(&skill_dir)
                .expect("walk path is below root");
            validate_portable_skill_path(walked.path(), relative)?;
            if file_type.is_file() {
                reject_hard_link(walked.path())?;
                let archive_path = format!("skills/{skill_id}/{}", portable_path(relative)?);
                insert_portable_payload_path(&mut portable_payload_paths, &archive_path).map_err(
                    |message| ThorError::Validation {
                        path: walked.path().to_path_buf(),
                        message,
                    },
                )?;
                let bytes = if walked.path() == skill_file {
                    preprocess_skill_definition(&skill, definitions)?
                } else {
                    fs::read(walked.path()).map_err(|source| ThorError::Read {
                        path: walked.path().to_path_buf(),
                        source,
                    })?
                };
                if payloads.insert(archive_path.clone(), bytes).is_some() {
                    return validation(
                        walked.path(),
                        format!("duplicate skill payload {archive_path}"),
                    );
                }
            }
        }
    }
    Ok(payloads)
}

/// Validates a target-scoped static tree and returns its opaque payloads in
/// sorted archive-path order.
pub fn collect_static_payloads(
    static_root: impl AsRef<Path>,
    target: Harness,
) -> Result<BTreeMap<String, Vec<u8>>> {
    collect_static_payloads_inner(static_root.as_ref(), target)
}

fn collect_static_payloads_inner(
    static_root: &Path,
    target: Harness,
) -> Result<BTreeMap<String, Vec<u8>>> {
    if !static_root.exists() {
        return Ok(BTreeMap::new());
    }
    ensure_real_directory(static_root, "static payload directory")?;

    let mut payloads = BTreeMap::new();
    let mut portable_payload_paths = BTreeMap::new();
    for walked in WalkDir::new(static_root).follow_links(false) {
        let walked = walked.map_err(|error| ThorError::Validation {
            path: static_root.to_path_buf(),
            message: format!("cannot walk static payload tree: {error}"),
        })?;
        if walked.path() == static_root {
            continue;
        }
        let file_type = walked.file_type();
        if file_type.is_symlink() || (!file_type.is_file() && !file_type.is_dir()) {
            return validation(
                walked.path(),
                "static payload trees may contain only regular files and directories",
            );
        }
        let relative = walked
            .path()
            .strip_prefix(static_root)
            .expect("walk path is below static root");
        validate_portable_skill_path(walked.path(), relative)?;
        let first = relative
            .components()
            .next()
            .and_then(|component| match component {
                Component::Normal(component) => component.to_str(),
                _ => None,
            })
            .expect("validated static path has a first component");
        if first == "agents" || (matches!(target, Harness::Claude) && first == "skills") {
            return validation(
                walked.path(),
                "static payload paths may not overlap generated agents or skills",
            );
        }
        if file_type.is_file() {
            reject_hard_link(walked.path())?;
            let archive_path = format!(
                "targets/{}/static/{}",
                target.as_str(),
                portable_path(relative)?
            );
            insert_portable_payload_path(&mut portable_payload_paths, &archive_path).map_err(
                |message| ThorError::Validation {
                    path: walked.path().to_path_buf(),
                    message,
                },
            )?;
            let bytes = fs::read(walked.path()).map_err(|source| ThorError::Read {
                path: walked.path().to_path_buf(),
                source,
            })?;
            if payloads.insert(archive_path.clone(), bytes).is_some() {
                return validation(
                    walked.path(),
                    format!("duplicate static payload {archive_path}"),
                );
            }
        }
    }
    Ok(payloads)
}

pub fn render_claude(agent: &ResolvedAgent) -> String {
    let mut frontmatter = vec![
        format!("name: {}", yaml_string(&agent.id)),
        format!("description: {}", yaml_string(&agent.description)),
        format!("model: {}", yaml_string(&agent.model)),
        format!("effort: {}", yaml_string(&agent.effort)),
    ];
    match agent.requested_access {
        RequestedAccess::Inherit => {}
        RequestedAccess::ReadOnly => {
            frontmatter.push("permissionMode: plan".to_owned());
            frontmatter.push("tools: Read, Grep, Glob, Bash".to_owned());
        }
        RequestedAccess::WorkspaceWrite => frontmatter.push("permissionMode: default".to_owned()),
    }
    if let Some(settings) = &agent.claude_settings {
        if let Some(max_turns) = settings.max_turns {
            frontmatter.push(format!("maxTurns: {max_turns}"));
        }
        if let Some(background) = settings.background {
            frontmatter.push(format!("background: {background}"));
        }
        if matches!(settings.isolation, Some(ClaudeIsolation::Worktree)) {
            frontmatter.push("isolation: worktree".to_owned());
        }
    }
    format!(
        "---\n{}\n---\n\n{}\n",
        frontmatter.join("\n"),
        agent.instructions.trim()
    )
}

pub fn render_codex(agent: &ResolvedAgent) -> Result<String> {
    #[derive(Serialize)]
    struct CodexDocument<'a> {
        name: &'a str,
        description: &'a str,
        model: &'a str,
        model_reasoning_effort: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        sandbox_mode: Option<&'a str>,
        developer_instructions: &'a str,
    }

    let sandbox_mode = match agent.requested_access {
        RequestedAccess::Inherit => None,
        RequestedAccess::ReadOnly => Some("read-only"),
        RequestedAccess::WorkspaceWrite => Some("workspace-write"),
    };
    toml::to_string_pretty(&CodexDocument {
        name: &agent.id,
        description: &agent.description,
        model: &agent.model,
        model_reasoning_effort: &agent.effort,
        sandbox_mode,
        developer_instructions: agent.instructions.trim(),
    })
    .map_err(|error| ThorError::Validation {
        path: PathBuf::from("generated Codex definition"),
        message: error.to_string(),
    })
}

fn validate_pack(
    manifest: &PackageManifest,
    manifest_path: &Path,
    agents: &[AgentDefinition],
) -> Result<()> {
    let mut ids = BTreeSet::new();
    for agent in agents {
        if !ids.insert(&agent.frontmatter.id) {
            return validation(
                &agent.source_path,
                format!("duplicate agent id {}", agent.frontmatter.id),
            );
        }
        if !manifest.spec.models.contains_key(&agent.frontmatter.model) {
            return validation(
                &agent.source_path,
                format!("unknown model tier {}", agent.frontmatter.model),
            );
        }
    }
    validate_manifest(manifest, manifest_path)
}

fn validate_manifest(manifest: &PackageManifest, path: &Path) -> Result<()> {
    if manifest.api_version != API_VERSION {
        return validation(path, format!("apiVersion must be {API_VERSION}"));
    }
    if manifest.kind != KIND {
        return validation(path, format!("kind must be {KIND}"));
    }
    validate_identifier(path, "metadata.name", &manifest.metadata.name)?;
    Version::parse(&manifest.metadata.version).map_err(|_| ThorError::Validation {
        path: path.to_path_buf(),
        message: "metadata.version must be semantic versioning without a v prefix".to_owned(),
    })?;
    if manifest.metadata.description.trim().is_empty() {
        return validation(path, "metadata.description must not be empty");
    }

    let configured_targets: BTreeSet<_> = manifest.spec.targets.iter().collect();
    if configured_targets.len() != manifest.spec.targets.len() {
        return validation(path, "spec.targets must not contain duplicates");
    }
    for (model_id, model) in &manifest.spec.models {
        validate_identifier(path, "model tier", model_id)?;
        if model.description.trim().is_empty() {
            return validation(path, "model description must not be empty");
        }
        for target in &manifest.spec.targets {
            if model
                .targets
                .get(target)
                .is_none_or(|mapping| mapping.model.trim().is_empty())
            {
                return validation(
                    path,
                    format!("every model must map target {}", target.as_str()),
                );
            }
        }
    }
    Ok(())
}

fn validate_against_schema(path: &Path, yaml: &str, definition: &str) -> Result<()> {
    let value: serde_yaml::Value =
        serde_yaml::from_str(yaml).map_err(|source| ThorError::Yaml {
            path: path.to_path_buf(),
            source,
        })?;
    let instance = serde_json::to_value(value).map_err(|error| ThorError::Validation {
        path: path.to_path_buf(),
        message: format!("cannot convert YAML for schema validation: {error}"),
    })?;
    let root: serde_json::Value =
        serde_json::from_str(SCHEMA).map_err(|error| ThorError::Schema(error.to_string()))?;
    let schema = serde_json::json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$ref": format!("#/$defs/{definition}"),
        "$defs": root["$defs"].clone()
    });
    let validator =
        jsonschema::validator_for(&schema).map_err(|error| ThorError::Schema(error.to_string()))?;
    if let Err(error) = validator.validate(&instance) {
        return validation(path, format!("schema validation failed: {error}"));
    }
    Ok(())
}

fn split_frontmatter<'a>(path: &Path, text: &'a str) -> Result<(&'a str, &'a str)> {
    let mut offset = 0usize;
    let mut lines = text.split_inclusive('\n');
    let first = lines.next().ok_or_else(|| ThorError::Validation {
        path: path.to_path_buf(),
        message: "agent file must begin with YAML frontmatter".to_owned(),
    })?;
    offset += first.len();
    if line_content(first) != "---" {
        return validation(path, "agent file must begin with --- frontmatter delimiter");
    }
    let frontmatter_start = offset;
    for line in lines {
        offset += line.len();
        if line_content(line) == "---" {
            let frontmatter_end = offset - line.len();
            return Ok((&text[frontmatter_start..frontmatter_end], &text[offset..]));
        }
    }
    validation(
        path,
        "agent frontmatter is missing its closing --- delimiter",
    )
}

fn line_content(line: &str) -> &str {
    line.strip_suffix('\n')
        .unwrap_or(line)
        .strip_suffix('\r')
        .unwrap_or(line.strip_suffix('\n').unwrap_or(line))
}

fn read_utf8(path: &Path) -> Result<String> {
    let bytes = fs::read(path).map_err(|source| ThorError::Read {
        path: path.to_path_buf(),
        source,
    })?;
    String::from_utf8(bytes).map_err(|source| ThorError::Utf8 {
        path: path.to_path_buf(),
        source,
    })
}

fn ensure_real_directory(path: &Path, label: &str) -> Result<()> {
    let metadata = fs::symlink_metadata(path).map_err(|source| ThorError::Read {
        path: path.to_path_buf(),
        source,
    })?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
        return validation(
            path,
            format!("{label} must be a real directory, not a link"),
        );
    }
    Ok(())
}

fn ensure_regular_source_file(path: &Path, label: &str) -> Result<()> {
    let metadata = fs::symlink_metadata(path).map_err(|source| ThorError::Read {
        path: path.to_path_buf(),
        source,
    })?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        return validation(path, format!("{label} must be a regular file, not a link"));
    }
    reject_hard_link(path)
}

fn validate_identifier(path: &Path, field: &str, value: &str) -> Result<()> {
    let valid_length = (1..=64).contains(&value.len());
    let mut chars = value.chars();
    let starts_with_letter = chars
        .next()
        .is_some_and(|character| character.is_ascii_lowercase());
    let remaining_are_valid = chars.all(|character| {
        character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
    });
    if !valid_length
        || !starts_with_letter
        || !remaining_are_valid
        || !is_portable_skill_component(value)
    {
        return validation(path, format!("{field} must match [a-z][a-z0-9-]{{0,63}}"));
    }
    Ok(())
}

fn validate_portable_skill_path(path: &Path, relative: &Path) -> Result<()> {
    for component in relative.components() {
        let Component::Normal(component) = component else {
            return validation(path, "skill path must be normalized and relative");
        };
        let component = component.to_str().ok_or_else(|| ThorError::Validation {
            path: path.to_path_buf(),
            message: "skill path component must be UTF-8".to_owned(),
        })?;
        if !is_portable_skill_component(component) {
            return validation(
                path,
                format!("skill path component {component:?} is not portable"),
            );
        }
    }
    Ok(())
}

fn portable_path(relative: &Path) -> Result<String> {
    let mut components = Vec::new();
    for component in relative.components() {
        let Component::Normal(component) = component else {
            return validation(relative, "skill path must be normalized and relative");
        };
        components.push(
            component
                .to_str()
                .ok_or_else(|| ThorError::Validation {
                    path: relative.to_path_buf(),
                    message: "skill path component must be UTF-8".to_owned(),
                })?
                .to_owned(),
        );
    }
    Ok(components.join("/"))
}

fn insert_portable_payload_path(
    paths: &mut BTreeMap<String, String>,
    path: &str,
) -> std::result::Result<(), String> {
    let mut prefix = Vec::new();
    for component in path.split('/') {
        prefix.push(component);
        let raw = prefix.join("/");
        let folded = raw.to_ascii_lowercase();
        if let Some(previous) = paths.get(&folded)
            && previous != &raw
        {
            return Err(format!(
                "skill payload collides on a case-insensitive filesystem: {path}"
            ));
        }
        paths.insert(folded, raw);
    }
    Ok(())
}

fn is_portable_skill_component(component: &str) -> bool {
    if component.is_empty()
        || component.len() > 128
        || component.ends_with('.')
        || matches!(component, "." | "..")
        || !component
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return false;
    }
    let stem = component
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    !matches!(
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

#[cfg(unix)]
fn reject_hard_link(path: &Path) -> Result<()> {
    use std::os::unix::fs::MetadataExt;

    let metadata = fs::metadata(path).map_err(|source| ThorError::Read {
        path: path.to_path_buf(),
        source,
    })?;
    if metadata.nlink() > 1 {
        return validation(path, "hard-linked source files are not allowed");
    }
    Ok(())
}

#[cfg(not(unix))]
fn reject_hard_link(path: &Path) -> Result<()> {
    validation(
        path,
        "source-pack hard-link validation requires the supported Unix CI builder",
    )
}

fn validation<T>(path: impl AsRef<Path>, message: impl Into<String>) -> Result<T> {
    Err(ThorError::Validation {
        path: path.as_ref().to_path_buf(),
        message: message.into(),
    })
}

fn yaml_string(value: &str) -> String {
    serde_json::to_string(value).expect("serializing a string cannot fail")
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use tempfile::tempdir;

    const MANIFEST: &str = r#"
apiVersion: thor/v1alpha1
kind: AgentPack
metadata:
  name: acme-engineering
  version: 1.2.0
  description: Engineering agents.
spec:
  targets: [claude, codex]
  models:
    fast:
      description: Fast work.
      targets:
        claude: { model: haiku, effort: low }
        codex: { model: gpt-5.6-luna, effort: low }
    frontier:
      description: Deep work.
      targets:
        claude: { model: opus, effort: xhigh }
        codex: { model: gpt-5.6, effort: xhigh }
"#;

    const AGENT: &str = r#"---
id: pr-reviewer
description: Reviews a pull request for correctness and test gaps.
model: frontier
requestedAccess: read-only
targets:
  claude:
    maxTurns: 20
    background: false
---

Review the requested change and report actionable findings only.
"#;

    fn fixture_pack() -> tempfile::TempDir {
        let directory = tempdir().unwrap();
        fs::write(directory.path().join("thor.yaml"), MANIFEST).unwrap();
        fs::create_dir(directory.path().join("agents")).unwrap();
        fs::write(directory.path().join("agents/pr-reviewer.md"), AGENT).unwrap();
        directory
    }

    #[test]
    fn loads_and_resolves_a_pack() {
        let directory = fixture_pack();
        let pack = SourcePack::load(directory.path()).unwrap();
        assert_eq!(pack.agents.len(), 1);
        let resolved = pack.resolve(&pack.agents[0], Harness::Codex).unwrap();
        assert_eq!(resolved.model, "gpt-5.6");
        assert_eq!(resolved.effort, "xhigh");
    }

    #[test]
    fn renders_the_access_profile_for_both_targets() {
        let directory = fixture_pack();
        let pack = SourcePack::load(directory.path()).unwrap();
        let agent = &pack.agents[0];
        let claude = render_claude(&pack.resolve(agent, Harness::Claude).unwrap());
        assert!(claude.contains("permissionMode: plan"));
        assert!(claude.contains("tools: Read, Grep, Glob, Bash"));
        assert!(claude.contains("maxTurns: 20"));

        let codex = render_codex(&pack.resolve(agent, Harness::Codex).unwrap()).unwrap();
        let parsed: toml::Value = toml::from_str(&codex).unwrap();
        assert_eq!(parsed["sandbox_mode"].as_str(), Some("read-only"));
        assert_eq!(parsed["model"].as_str(), Some("gpt-5.6"));
    }

    #[test]
    fn expands_one_agent_body_into_a_shared_template_for_both_targets() {
        let directory = fixture_pack();
        fs::create_dir(directory.path().join("templates")).unwrap();
        fs::write(
            directory.path().join("templates/first-tier-reviewer.md"),
            "Shared prefix.\n\n{{agent_instructions}}\n\nShared suffix.\n",
        )
        .unwrap();
        let agent_path = directory.path().join("agents/pr-reviewer.md");
        fs::write(
            &agent_path,
            AGENT.replace(
                "requestedAccess: read-only",
                "requestedAccess: read-only\ntemplate: first-tier-reviewer",
            ),
        )
        .unwrap();

        let pack = SourcePack::load(directory.path()).unwrap();
        let agent = &pack.agents[0];
        let expected = "Shared prefix.\n\nReview the requested change and report actionable findings only.\n\nShared suffix.";
        assert_eq!(agent.instructions.trim(), expected);

        let claude = render_claude(&pack.resolve(agent, Harness::Claude).unwrap());
        assert!(claude.contains(expected));
        let codex = render_codex(&pack.resolve(agent, Harness::Codex).unwrap()).unwrap();
        let parsed: toml::Value = toml::from_str(&codex).unwrap();
        assert_eq!(parsed["developer_instructions"].as_str(), Some(expected));
    }

    #[test]
    fn expands_selected_definition_bundles_before_both_agent_renderers() {
        let directory = fixture_pack();
        fs::create_dir(directory.path().join("templates")).unwrap();
        fs::create_dir(directory.path().join("definitions")).unwrap();
        fs::write(
            directory.path().join("templates/first-tier-reviewer.md"),
            "Shared prefix.\n\n{{definition_bundles}}\n\n{{agent_instructions}}\n",
        )
        .unwrap();
        fs::write(
            directory.path().join("definitions/assurance-terms.md"),
            "## Assurance terms\n\nA passing result has no findings or evidence gaps.\n",
        )
        .unwrap();
        let agent_path = directory.path().join("agents/pr-reviewer.md");
        fs::write(
            &agent_path,
            AGENT.replace(
                "requestedAccess: read-only",
                "requestedAccess: read-only\ntemplate: first-tier-reviewer\ndefinitions: [assurance-terms]",
            ),
        )
        .unwrap();

        let pack = SourcePack::load(directory.path()).unwrap();
        let agent = &pack.agents[0];
        assert!(agent.instructions.contains("## Assurance terms"));
        assert!(!agent.instructions.contains(DEFINITION_BUNDLES_SLOT));
        let claude = render_claude(&pack.resolve(agent, Harness::Claude).unwrap());
        let codex = render_codex(&pack.resolve(agent, Harness::Codex).unwrap()).unwrap();
        let codex: toml::Value = toml::from_str(&codex).unwrap();
        assert!(claude.contains("A passing result has no findings or evidence gaps."));
        assert!(
            codex["developer_instructions"]
                .as_str()
                .unwrap()
                .contains("A passing result has no findings or evidence gaps.")
        );
    }

    #[test]
    fn expands_definition_bundles_in_declared_order() {
        let directory = fixture_pack();
        fs::create_dir(directory.path().join("definitions")).unwrap();
        fs::write(
            directory.path().join("definitions/first.md"),
            "First bundle.\n",
        )
        .unwrap();
        fs::write(
            directory.path().join("definitions/second.md"),
            "Second bundle.\n",
        )
        .unwrap();
        let agent = AGENT
            .replace(
                "requestedAccess: read-only",
                "requestedAccess: read-only\ndefinitions: [second, first]",
            )
            .replace(
                "Review the requested change and report actionable findings only.",
                "{{definition_bundles}}\n\nReview the requested change and report actionable findings only.",
            );
        fs::write(directory.path().join("agents/pr-reviewer.md"), agent).unwrap();

        let pack = SourcePack::load(directory.path()).unwrap();
        let instructions = &pack.agents[0].instructions;
        assert!(instructions.find("Second bundle.") < instructions.find("First bundle."));
    }

    #[test]
    fn rejects_invalid_missing_or_duplicate_agent_definition_bundles_and_markers() {
        for (definitions, instructions, expected) in [
            (
                "definitions: [missing]",
                "{{definition_bundles}}\n\nReview the change.",
                "definition bundle",
            ),
            (
                "definitions: [known, known]",
                "{{definition_bundles}}\n\nReview the change.",
                "schema validation failed",
            ),
            (
                "definitions: [../escape]",
                "{{definition_bundles}}\n\nReview the change.",
                "schema validation failed",
            ),
            (
                "definitions: [known]",
                "Review the change.",
                "must contain exactly one",
            ),
            (
                "",
                "{{definition_bundles}}\n\nReview the change.",
                "selects no definitions",
            ),
            (
                "definitions: [known]",
                "{{definition_bundles}}\n\n{{definition_bundles}}\n\nReview the change.",
                "must contain exactly one",
            ),
        ] {
            let directory = fixture_pack();
            fs::create_dir(directory.path().join("definitions")).unwrap();
            fs::write(
                directory.path().join("definitions/known.md"),
                "Known definition.\n",
            )
            .unwrap();
            let frontmatter = if definitions.is_empty() {
                "requestedAccess: read-only".to_owned()
            } else {
                format!("requestedAccess: read-only\n{definitions}")
            };
            let agent = AGENT
                .replace("requestedAccess: read-only", &frontmatter)
                .replace(
                    "Review the requested change and report actionable findings only.",
                    instructions,
                );
            fs::write(directory.path().join("agents/pr-reviewer.md"), agent).unwrap();

            let error = SourcePack::load(directory.path()).unwrap_err();
            assert!(
                error.to_string().contains(expected),
                "expected {expected:?} in {error}"
            );
        }
    }

    #[test]
    fn rejects_a_definition_marker_supplied_by_a_templated_agent_body() {
        let directory = fixture_pack();
        fs::create_dir(directory.path().join("templates")).unwrap();
        fs::create_dir(directory.path().join("definitions")).unwrap();
        fs::write(
            directory.path().join("templates/first-tier-reviewer.md"),
            "Shared prefix.\n\n{{agent_instructions}}\n",
        )
        .unwrap();
        fs::write(
            directory.path().join("definitions/known.md"),
            "Known definition.\n",
        )
        .unwrap();
        let agent = AGENT
            .replace(
                "requestedAccess: read-only",
                "requestedAccess: read-only\ntemplate: first-tier-reviewer\ndefinitions: [known]",
            )
            .replace(
                "Review the requested change and report actionable findings only.",
                "{{definition_bundles}}\n\nReview the change.",
            );
        fs::write(directory.path().join("agents/pr-reviewer.md"), agent).unwrap();

        let error = SourcePack::load(directory.path()).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("agent template with definitions must contain exactly one"),
            "unexpected error: {error}"
        );

        fs::write(
            directory.path().join("templates/first-tier-reviewer.md"),
            "Shared prefix.\n\n{{definition_bundles}}\n\n{{agent_instructions}}\n",
        )
        .unwrap();
        let error = SourcePack::load(directory.path()).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("agent instructions may not contain {{definition_bundles}}"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn rejects_reserved_definition_syntax_outside_supported_source_locations() {
        for (replacement, expected) in [
            (
                "description: \"{{definition_bundles}}\"",
                "agent frontmatter may not contain {{definition_bundles}}",
            ),
            (
                "description: \"<!-- thor:definitions: known -->\"",
                "agent frontmatter may not contain a skill definition directive",
            ),
        ] {
            let directory = fixture_pack();
            let agent = AGENT.replace(
                "description: Reviews a pull request for correctness and test gaps.",
                replacement,
            );
            fs::write(directory.path().join("agents/pr-reviewer.md"), agent).unwrap();

            let error = SourcePack::load(directory.path()).unwrap_err();
            assert!(
                error.to_string().contains(expected),
                "expected {expected:?} in {error}"
            );
        }

        let agent_directive = fixture_pack();
        let agent = AGENT.replace(
            "Review the requested change and report actionable findings only.",
            "<!-- thor:definitions: known -->\n\nReview the change.",
        );
        fs::write(agent_directive.path().join("agents/pr-reviewer.md"), agent).unwrap();
        let error = SourcePack::load(agent_directive.path()).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("agent instructions may not contain a skill definition directive"),
            "unexpected error: {error}"
        );

        let template_directive = fixture_pack();
        fs::create_dir(template_directive.path().join("templates")).unwrap();
        fs::write(
            template_directive.path().join("templates/wrapper.md"),
            "<!-- thor:definitions: known -->\n\n{{agent_instructions}}\n",
        )
        .unwrap();
        let agent = AGENT.replace(
            "requestedAccess: read-only",
            "requestedAccess: read-only\ntemplate: wrapper",
        );
        fs::write(
            template_directive.path().join("agents/pr-reviewer.md"),
            agent,
        )
        .unwrap();
        let error = SourcePack::load(template_directive.path()).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("agent template may not contain a skill definition directive"),
            "unexpected error: {error}"
        );

        for (description, expected) in [
            (
                "\"{{definition_bundles}}\"",
                "skill frontmatter may not contain {{definition_bundles}}",
            ),
            (
                "\"<!-- thor:definitions: known -->\"",
                "skill frontmatter may not contain a skill definition directive",
            ),
        ] {
            let directory = tempdir().unwrap();
            let skill = directory.path().join("skills/review-checklist");
            fs::create_dir_all(&skill).unwrap();
            fs::write(
                skill.join("SKILL.md"),
                format!(
                    "---\nname: review-checklist\ndescription: {description}\n---\n\nUse this checklist.\n"
                ),
            )
            .unwrap();

            let error = collect_skill_payloads(directory.path().join("skills")).unwrap_err();
            assert!(
                error.to_string().contains(expected),
                "expected {expected:?} in {error}"
            );
        }
    }

    #[test]
    fn rejects_unusable_definition_sources_before_any_agent_selects_them() {
        let nested_marker = fixture_pack();
        fs::create_dir(nested_marker.path().join("definitions")).unwrap();
        fs::write(
            nested_marker.path().join("definitions/known.md"),
            "{{definition_bundles}}\n",
        )
        .unwrap();
        let error = SourcePack::load(nested_marker.path()).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("definition bundles may not include")
        );

        let agent_marker = fixture_pack();
        fs::create_dir(agent_marker.path().join("definitions")).unwrap();
        fs::write(
            agent_marker.path().join("definitions/known.md"),
            "{{agent_instructions}}\n",
        )
        .unwrap();
        let error = SourcePack::load(agent_marker.path()).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("definition bundles may not include")
        );

        let unsafe_name = fixture_pack();
        fs::create_dir(unsafe_name.path().join("definitions")).unwrap();
        fs::write(
            unsafe_name.path().join("definitions/NotPortable.md"),
            "Definition.\n",
        )
        .unwrap();
        let error = SourcePack::load(unsafe_name.path()).unwrap_err();
        assert!(error.to_string().contains("definition filename"));
    }

    #[test]
    fn rejects_agent_templates_without_exactly_one_supported_slot() {
        for template in [
            "No slot.\n",
            "{{agent_instructions}}\n{{agent_instructions}}\n",
            "{{agent_instructions}}\n{{unsupported}}\n",
        ] {
            let directory = fixture_pack();
            fs::create_dir(directory.path().join("templates")).unwrap();
            fs::write(
                directory.path().join("templates/first-tier-reviewer.md"),
                template,
            )
            .unwrap();
            let agent_path = directory.path().join("agents/pr-reviewer.md");
            fs::write(
                &agent_path,
                AGENT.replace(
                    "requestedAccess: read-only",
                    "requestedAccess: read-only\ntemplate: first-tier-reviewer",
                ),
            )
            .unwrap();

            let error = SourcePack::load(directory.path()).unwrap_err();
            assert!(error.to_string().contains("agent template"));
        }
    }

    #[test]
    fn rejects_unknown_target_specific_fields() {
        let directory = fixture_pack();
        let agent_path = directory.path().join("agents/pr-reviewer.md");
        let invalid = AGENT.replace(
            "    background: false",
            "    background: false\n    mcpServers: []",
        );
        fs::write(&agent_path, invalid).unwrap();
        let error = SourcePack::load(directory.path()).unwrap_err();
        assert!(error.to_string().contains("schema validation failed"));
    }

    #[test]
    fn rejects_agent_level_effort() {
        let directory = fixture_pack();
        let agent_path = directory.path().join("agents/pr-reviewer.md");
        fs::write(
            &agent_path,
            AGENT.replace("model: frontier", "model: frontier\neffort: high"),
        )
        .unwrap();
        let error = SourcePack::load(directory.path()).unwrap_err();
        assert!(error.to_string().contains("schema validation failed"));
    }

    #[test]
    fn rejects_filename_id_mismatch() {
        let directory = fixture_pack();
        let original = directory.path().join("agents/pr-reviewer.md");
        fs::rename(&original, directory.path().join("agents/wrong-name.md")).unwrap();
        let error = SourcePack::load(directory.path()).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("filename must be pr-reviewer.md")
        );
    }

    #[test]
    fn rejects_an_unsupported_model_effort() {
        let directory = fixture_pack();
        let manifest_path = directory.path().join("thor.yaml");
        fs::write(
            &manifest_path,
            MANIFEST.replace(
                "model: gpt-5.6, effort: xhigh",
                "model: gpt-5.6, effort: ultra",
            ),
        )
        .unwrap();
        let error = SourcePack::load(directory.path()).unwrap_err();
        assert!(error.to_string().contains("schema validation failed"));
    }

    #[test]
    fn published_schema_has_a_normal_validator_entry_point() {
        let schema: serde_json::Value = serde_json::from_str(SCHEMA).unwrap();
        let validator = jsonschema::validator_for(&schema).unwrap();
        let instance: serde_yaml::Value = serde_yaml::from_str(MANIFEST).unwrap();
        assert!(
            validator
                .validate(&serde_json::to_value(instance).unwrap())
                .is_ok()
        );

        let invalid: serde_yaml::Value = serde_yaml::from_str(&MANIFEST.replace(
            "codex: { model: gpt-5.6, effort: xhigh }",
            "rogue: { model: gpt-5.6, effort: xhigh }",
        ))
        .unwrap();
        assert!(
            validator
                .validate(&serde_json::to_value(invalid).unwrap())
                .is_err()
        );
    }

    #[test]
    fn collects_complete_portable_skill_trees_without_executing_them() {
        let directory = tempdir().unwrap();
        let skill = directory.path().join("skills/review-checklist");
        fs::create_dir_all(skill.join("scripts")).unwrap();
        fs::write(
            skill.join("SKILL.md"),
            "---\nname: review-checklist\ndescription: A review checklist.\nmetadata:\n  owner: acme\n---\n\nUse this checklist.\n",
        )
        .unwrap();
        fs::write(skill.join("scripts/check.sh"), b"#!/bin/sh\necho not-run\n").unwrap();

        let payloads = collect_skill_payloads(directory.path().join("skills")).unwrap();
        assert_eq!(
            payloads["skills/review-checklist/scripts/check.sh"],
            b"#!/bin/sh\necho not-run\n"
        );
        assert!(payloads.contains_key("skills/review-checklist/SKILL.md"));
    }

    #[test]
    fn preprocesses_skill_markdown_and_preserves_auxiliary_skill_file_bytes() {
        let directory = tempdir().unwrap();
        fs::create_dir(directory.path().join("definitions")).unwrap();
        fs::write(
            directory.path().join("definitions/assurance-terms.md"),
            "## Assurance terms\n\nAn evidence gap prevents a defensible determination.\n",
        )
        .unwrap();
        let skill = directory.path().join("skills/review-checklist");
        fs::create_dir_all(skill.join("scripts")).unwrap();
        fs::write(
            skill.join("SKILL.md"),
            "---\nname: review-checklist\ndescription: A review checklist.\n---\n\n<!-- thor:definitions: assurance-terms -->\n\n{{definition_bundles}}\n\nUse this checklist.\n",
        )
        .unwrap();
        let script = b"#!/bin/sh\n\x00echo not-run\n";
        fs::write(skill.join("scripts/check.sh"), script).unwrap();

        let payloads = collect_skill_payloads(directory.path().join("skills")).unwrap();
        let rendered =
            String::from_utf8(payloads["skills/review-checklist/SKILL.md"].clone()).unwrap();
        assert!(rendered.contains("## Assurance terms"));
        assert!(!rendered.contains("thor:definitions"));
        assert!(!rendered.contains(DEFINITION_BUNDLES_SLOT));
        assert_eq!(payloads["skills/review-checklist/scripts/check.sh"], script);
    }

    #[test]
    fn rejects_invalid_missing_or_duplicate_skill_definition_directives_and_markers() {
        for (directive, markers, expected) in [
            (
                "<!-- thor:definitions: missing -->",
                "{{definition_bundles}}",
                "definition bundle",
            ),
            (
                "<!-- thor:definitions: known, known -->",
                "{{definition_bundles}}",
                "duplicate definition bundle",
            ),
            (
                "<!-- thor:definitions: ../escape -->",
                "{{definition_bundles}}",
                "definition bundle",
            ),
            (
                "<!-- thor:definitions: known -->",
                "No marker.",
                "must contain exactly one",
            ),
            (
                "<!-- thor:definitions: known -->",
                "{{definition_bundles}}\n{{definition_bundles}}",
                "must contain exactly one",
            ),
        ] {
            let directory = tempdir().unwrap();
            fs::create_dir(directory.path().join("definitions")).unwrap();
            fs::write(
                directory.path().join("definitions/known.md"),
                "Known definition.\n",
            )
            .unwrap();
            let skill = directory.path().join("skills/review-checklist");
            fs::create_dir_all(&skill).unwrap();
            fs::write(
                skill.join("SKILL.md"),
                format!(
                    "---\nname: review-checklist\ndescription: A review checklist.\n---\n\n{directive}\n\n{markers}\n"
                ),
            )
            .unwrap();

            let error = collect_skill_payloads(directory.path().join("skills")).unwrap_err();
            assert!(
                error.to_string().contains(expected),
                "expected {expected:?} in {error}"
            );
        }
    }

    #[test]
    fn collects_target_scoped_static_files_as_opaque_payloads() {
        let directory = tempdir().unwrap();
        let static_root = directory.path().join(".codex");
        fs::create_dir_all(static_root.join("nested")).unwrap();
        fs::write(
            static_root.join("config.toml"),
            "[agents]\nmax_concurrent_threads_per_session = 16\n",
        )
        .unwrap();
        fs::write(static_root.join("nested/settings.json"), "{}\n").unwrap();

        let payloads = collect_static_payloads(&static_root, Harness::Codex).unwrap();
        assert_eq!(
            payloads["targets/codex/static/config.toml"],
            b"[agents]\nmax_concurrent_threads_per_session = 16\n"
        );
        assert_eq!(
            payloads["targets/codex/static/nested/settings.json"],
            b"{}\n"
        );
    }

    #[test]
    fn rejects_static_files_that_overlap_generated_definitions() {
        let directory = tempdir().unwrap();
        let agents = directory.path().join(".codex/agents");
        fs::create_dir_all(&agents).unwrap();
        fs::write(agents.join("reviewer.toml"), "name = \"reviewer\"\n").unwrap();

        assert!(collect_static_payloads(directory.path().join(".codex"), Harness::Codex).is_err());
    }

    #[test]
    fn rejects_windows_collisions_in_source_names_and_skill_trees() {
        let directory = fixture_pack();
        let agent = directory.path().join("agents/pr-reviewer.md");
        fs::rename(&agent, directory.path().join("agents/con.md")).unwrap();
        let invalid = AGENT.replace("id: pr-reviewer", "id: con");
        fs::write(directory.path().join("agents/con.md"), invalid).unwrap();
        assert!(SourcePack::load(directory.path()).is_err());

        let skills = tempdir().unwrap();
        let skill = skills.path().join("skills/research");
        fs::create_dir_all(&skill).unwrap();
        fs::write(
            skill.join("SKILL.md"),
            "---\nname: research\ndescription: Research.\n---\n",
        )
        .unwrap();
        fs::write(skill.join("Reference.md"), "one").unwrap();
        fs::write(skill.join("reference.md"), "two").unwrap();
        assert!(collect_skill_payloads(skills.path().join("skills")).is_err());

        let nested = tempdir().unwrap();
        let skill = nested.path().join("skills/research");
        fs::create_dir_all(skill.join("Foo")).unwrap();
        fs::create_dir_all(skill.join("foo")).unwrap();
        fs::write(
            skill.join("SKILL.md"),
            "---\nname: research\ndescription: Research.\n---\n",
        )
        .unwrap();
        fs::write(skill.join("Foo/one.md"), "one").unwrap();
        fs::write(skill.join("foo/two.md"), "two").unwrap();
        assert!(collect_skill_payloads(nested.path().join("skills")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_linked_manifest_agents_directory_and_agent_files() {
        use std::os::unix::fs::symlink;

        let manifest_link = fixture_pack();
        let manifest = manifest_link.path().join("thor.yaml");
        fs::rename(&manifest, manifest_link.path().join("real-manifest.yaml")).unwrap();
        symlink("real-manifest.yaml", &manifest).unwrap();
        assert!(
            SourcePack::load(manifest_link.path())
                .unwrap_err()
                .to_string()
                .contains("package manifest must be a regular file")
        );

        let directory_link = fixture_pack();
        let agents = directory_link.path().join("agents");
        fs::rename(&agents, directory_link.path().join("real-agents")).unwrap();
        symlink("real-agents", &agents).unwrap();
        assert!(
            SourcePack::load(directory_link.path())
                .unwrap_err()
                .to_string()
                .contains("agents directory must be a real directory")
        );

        let agent_link = fixture_pack();
        let agent = agent_link.path().join("agents/pr-reviewer.md");
        fs::hard_link(&agent, agent_link.path().join("agents/copy.md")).unwrap();
        assert!(
            SourcePack::load(agent_link.path())
                .unwrap_err()
                .to_string()
                .contains("hard-linked source files are not allowed")
        );

        let template_link = fixture_pack();
        let templates = template_link.path().join("templates");
        fs::create_dir(&templates).unwrap();
        fs::write(
            templates.join("real-template.md"),
            "{{agent_instructions}}\n",
        )
        .unwrap();
        symlink("real-template.md", templates.join("first-tier-reviewer.md")).unwrap();
        let agent = template_link.path().join("agents/pr-reviewer.md");
        fs::write(
            &agent,
            AGENT.replace(
                "requestedAccess: read-only",
                "requestedAccess: read-only\ntemplate: first-tier-reviewer",
            ),
        )
        .unwrap();
        assert!(
            SourcePack::load(template_link.path())
                .unwrap_err()
                .to_string()
                .contains("agent template must be a regular file")
        );
    }
}
