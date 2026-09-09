use crate::model::{BundleFile, SkillBundle};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use sha2::{Digest as ShaDigest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use thiserror::Error;
use unicode_normalization::UnicodeNormalization;
use walkdir::WalkDir;

pub const BUNDLE_FORMAT: &str = "pskills-bundle-v1";
pub const MAX_EXPANDED_BYTES: u64 = 100 * 1024 * 1024;
pub const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
pub const MAX_FILES: usize = 2_000;

#[derive(Debug, Clone, Copy)]
pub struct BundleLimits {
    pub max_expanded_bytes: u64,
    pub max_file_bytes: u64,
    pub max_files: usize,
}

impl Default for BundleLimits {
    fn default() -> Self {
        Self {
            max_expanded_bytes: MAX_EXPANDED_BYTES,
            max_file_bytes: MAX_FILE_BYTES,
            max_files: MAX_FILES,
        }
    }
}

#[derive(Debug, Error)]
pub enum BundleError {
    #[error("bundle JSON is invalid: {0}")]
    Json(#[from] serde_json::Error),
    #[error("bundle file `{path}` contains invalid base64: {source}")]
    Base64 {
        path: String,
        source: base64::DecodeError,
    },
    #[error("bundle file `{0}` is not canonical base64")]
    NonCanonicalBase64(String),
    #[error("bundle format must be {BUNDLE_FORMAT}")]
    WrongFormat,
    #[error("bundle JSON is not canonical UTF-8 JSON")]
    NonCanonical,
    #[error("bundle must contain at least one file")]
    Empty,
    #[error("bundle has too many files ({actual}; maximum {maximum})")]
    TooManyFiles { actual: usize, maximum: usize },
    #[error("bundle is too large ({actual} bytes; maximum {maximum})")]
    TooLarge { actual: u64, maximum: u64 },
    #[error("bundle file `{path}` is too large ({actual} bytes; maximum {maximum})")]
    FileTooLarge {
        path: String,
        actual: u64,
        maximum: u64,
    },
    #[error("invalid bundle path `{path}`: {reason}")]
    InvalidPath { path: String, reason: String },
    #[error("duplicate bundle path `{0}`")]
    DuplicatePath(String),
    #[error("bundle paths collide on a case-insensitive filesystem: `{first}` and `{second}`")]
    CaseCollision { first: String, second: String },
    #[error("bundle must contain a root SKILL.md")]
    MissingSkillFile,
    #[error("SKILL.md must be UTF-8: {0}")]
    SkillUtf8(String),
    #[error("SKILL.md frontmatter is invalid: {0}")]
    SkillFrontmatter(String),
    #[error("cannot read `{path}`: {source}")]
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("source directory does not exist: {0}")]
    MissingDirectory(PathBuf),
    #[error("source path is not a directory: {0}")]
    NotDirectory(PathBuf),
    #[error("source directory contains a symbolic link: {0}")]
    Symlink(PathBuf),
    #[error("source path is not representable as UTF-8: {0}")]
    NonUtf8Path(PathBuf),
}

pub fn bundle_from_directory(
    path: &Path,
    limits: BundleLimits,
) -> Result<SkillBundle, BundleError> {
    let metadata = fs::symlink_metadata(path).map_err(|source| BundleError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    if metadata.file_type().is_symlink() {
        return Err(BundleError::Symlink(path.to_path_buf()));
    }
    if !metadata.is_dir() {
        return Err(BundleError::NotDirectory(path.to_path_buf()));
    }

    let mut files = Vec::new();
    for entry in WalkDir::new(path).follow_links(false).sort_by_file_name() {
        let entry = entry.map_err(|err| BundleError::Io {
            path: err.path().unwrap_or(path).to_path_buf(),
            source: std::io::Error::other(err.to_string()),
        })?;
        let entry_path = entry.path();
        if entry_path == path {
            continue;
        }
        let kind = entry.file_type();
        if kind.is_symlink() {
            return Err(BundleError::Symlink(entry_path.to_path_buf()));
        }
        if !kind.is_file() {
            continue;
        }
        let relative = entry_path
            .strip_prefix(path)
            .expect("walkdir path under root");
        let relative = relative
            .to_str()
            .ok_or_else(|| BundleError::NonUtf8Path(relative.to_path_buf()))?
            .replace('\\', "/");
        validate_path(&relative)?;
        let bytes = fs::read(entry_path).map_err(|source| BundleError::Io {
            path: entry_path.to_path_buf(),
            source,
        })?;
        let executable = is_executable(&entry.metadata().map_err(|source| BundleError::Io {
            path: entry_path.to_path_buf(),
            source: std::io::Error::other(source.to_string()),
        })?);
        files.push(BundleFile {
            path: relative,
            content: BASE64.encode(bytes),
            executable: executable.then_some(true),
        });
    }
    let bundle = SkillBundle {
        format: BUNDLE_FORMAT.to_string(),
        files,
    };
    validate_bundle(&bundle, limits)?;
    Ok(bundle)
}

#[cfg(unix)]
fn is_executable(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_metadata: &std::fs::Metadata) -> bool {
    false
}

pub fn validate_bundle(bundle: &SkillBundle, limits: BundleLimits) -> Result<u64, BundleError> {
    if bundle.format != BUNDLE_FORMAT {
        return Err(BundleError::WrongFormat);
    }
    if bundle.files.is_empty() {
        return Err(BundleError::Empty);
    }
    if bundle.files.len() > limits.max_files {
        return Err(BundleError::TooManyFiles {
            actual: bundle.files.len(),
            maximum: limits.max_files,
        });
    }

    let mut exact = HashMap::<String, String>::new();
    let mut insensitive = HashMap::<String, String>::new();
    let mut total = 0u64;
    let mut skill_file = None;
    for file in &bundle.files {
        validate_path(&file.path)?;
        if exact.insert(file.path.clone(), file.path.clone()).is_some() {
            return Err(BundleError::DuplicatePath(file.path.clone()));
        }
        let folded = path_collision_key(&file.path);
        if let Some(first) = insensitive.insert(folded, file.path.clone()) {
            if first != file.path {
                return Err(BundleError::CaseCollision {
                    first,
                    second: file.path.clone(),
                });
            }
        }
        let bytes =
            BASE64
                .decode(file.content.as_bytes())
                .map_err(|source| BundleError::Base64 {
                    path: file.path.clone(),
                    source,
                })?;
        if BASE64.encode(&bytes) != file.content {
            return Err(BundleError::NonCanonicalBase64(file.path.clone()));
        }
        let size = bytes.len() as u64;
        if size > limits.max_file_bytes {
            return Err(BundleError::FileTooLarge {
                path: file.path.clone(),
                actual: size,
                maximum: limits.max_file_bytes,
            });
        }
        total = total.checked_add(size).ok_or(BundleError::TooLarge {
            actual: u64::MAX,
            maximum: limits.max_expanded_bytes,
        })?;
        if total > limits.max_expanded_bytes {
            return Err(BundleError::TooLarge {
                actual: total,
                maximum: limits.max_expanded_bytes,
            });
        }
        if file.path == "SKILL.md" {
            skill_file = Some(bytes);
        }
    }
    let skill_file = skill_file.ok_or(BundleError::MissingSkillFile)?;
    let markdown =
        std::str::from_utf8(&skill_file).map_err(|e| BundleError::SkillUtf8(e.to_string()))?;
    validate_skill_markdown(markdown)?;
    Ok(total)
}

pub fn canonical_bundle_bytes(bundle: &SkillBundle) -> Result<Vec<u8>, BundleError> {
    let mut normalized = bundle.clone();
    for file in &mut normalized.files {
        file.path = file.path.nfc().collect();
    }
    validate_bundle(&normalized, BundleLimits::default())?;
    normalized.files.sort_by(|a, b| a.path.cmp(&b.path));
    serde_json::to_vec(&normalized).map_err(BundleError::Json)
}

pub fn decode_bundle_bytes(bytes: &[u8]) -> Result<SkillBundle, BundleError> {
    let mut bundle: SkillBundle = serde_json::from_slice(bytes)?;
    for file in &mut bundle.files {
        file.path = file.path.nfc().collect();
    }
    validate_bundle(&bundle, BundleLimits::default())?;
    if canonical_bundle_bytes(&bundle)? != bytes {
        return Err(BundleError::NonCanonical);
    }
    Ok(bundle)
}

pub fn digest_bytes(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    format!("sha256:{}", encode_hex(&digest))
}

pub fn bundle_digest(bundle: &SkillBundle) -> Result<String, BundleError> {
    Ok(digest_bytes(&canonical_bundle_bytes(bundle)?))
}

pub fn tree_digest(bundle: &SkillBundle) -> Result<String, BundleError> {
    validate_bundle(bundle, BundleLimits::default())?;
    let mut files = bundle.files.clone();
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let mut hasher = Sha256::new();
    for file in files {
        let bytes =
            BASE64
                .decode(file.content.as_bytes())
                .map_err(|source| BundleError::Base64 {
                    path: file.path.clone(),
                    source,
                })?;
        hasher.update(file.path.as_bytes());
        hasher.update([0]);
        hasher.update(&bytes);
        hasher.update([0]);
    }
    Ok(format!("sha256:{}", encode_hex(&hasher.finalize())))
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

pub fn validate_path(path: &str) -> Result<(), BundleError> {
    if path.is_empty() {
        return Err(BundleError::InvalidPath {
            path: path.into(),
            reason: "empty path".into(),
        });
    }
    if path.contains('\0') || path.chars().any(|character| character.is_control()) {
        return Err(BundleError::InvalidPath {
            path: path.into(),
            reason: "NUL byte".into(),
        });
    }
    if path.contains('\\') {
        return Err(BundleError::InvalidPath {
            path: path.into(),
            reason: "backslash is not allowed; use `/`".into(),
        });
    }
    if path.nfc().collect::<String>() != path {
        return Err(BundleError::InvalidPath {
            path: path.into(),
            reason: "path must use NFC Unicode".into(),
        });
    }
    if path.encode_utf16().count() > 4096 {
        return Err(BundleError::InvalidPath {
            path: path.into(),
            reason: "path is too long".into(),
        });
    }
    if path.starts_with('/') || path.starts_with("//") {
        return Err(BundleError::InvalidPath {
            path: path.into(),
            reason: "absolute or UNC path".into(),
        });
    }
    if path.split('/').any(|part| part.is_empty()) {
        return Err(BundleError::InvalidPath {
            path: path.into(),
            reason: "empty path component".into(),
        });
    }
    let bytes = path.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return Err(BundleError::InvalidPath {
            path: path.into(),
            reason: "Windows drive path".into(),
        });
    }
    if path.ends_with('.') || path.ends_with(' ') {
        return Err(BundleError::InvalidPath {
            path: path.into(),
            reason: "trailing dot or space".into(),
        });
    }
    for component in Path::new(path).components() {
        match component {
            Component::Normal(part) => {
                let name = part.to_str().ok_or_else(|| BundleError::InvalidPath {
                    path: path.into(),
                    reason: "non-UTF-8 component".into(),
                })?;
                if name.is_empty() || name == "." || name == ".." {
                    return Err(BundleError::InvalidPath {
                        path: path.into(),
                        reason: "empty or traversal component".into(),
                    });
                }
                if name.ends_with('.') || name.ends_with(' ') {
                    return Err(BundleError::InvalidPath {
                        path: path.into(),
                        reason: "trailing dot or space in path component".into(),
                    });
                }
                if name.contains(':')
                    || name
                        .chars()
                        .any(|character| matches!(character, '<' | '>' | '"' | '|' | '?' | '*'))
                {
                    return Err(BundleError::InvalidPath {
                        path: path.into(),
                        reason: "reserved Windows path character".into(),
                    });
                }
                if name.len() > 255 {
                    return Err(BundleError::InvalidPath {
                        path: path.into(),
                        reason: "path component is too long".into(),
                    });
                }
                if is_reserved_windows_name(name) {
                    return Err(BundleError::InvalidPath {
                        path: path.into(),
                        reason: format!("reserved Windows name `{name}`"),
                    });
                }
            }
            Component::CurDir
            | Component::ParentDir
            | Component::RootDir
            | Component::Prefix(_) => {
                return Err(BundleError::InvalidPath {
                    path: path.into(),
                    reason: "absolute or traversal component".into(),
                })
            }
        }
    }
    if path.split('/').any(|part| {
        matches!(
            part.to_ascii_lowercase().as_str(),
            ".claude-plugin"
                | ".agents"
                | ".codex"
                | ".cursor"
                | ".windsurf"
                | ".mcp"
                | ".mcp.json"
        )
    }) {
        return Err(BundleError::InvalidPath {
            path: path.into(),
            reason: "agent-reserved or plugin path".into(),
        });
    }
    Ok(())
}

fn path_collision_key(path: &str) -> String {
    path.nfc().collect::<String>().to_lowercase()
}

fn is_reserved_windows_name(component: &str) -> bool {
    let stem = component
        .split('.')
        .next()
        .unwrap_or(component)
        .to_ascii_uppercase();
    matches!(
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

fn validate_skill_markdown(markdown: &str) -> Result<(), BundleError> {
    if markdown.starts_with('\u{feff}') {
        return Err(BundleError::SkillFrontmatter(
            "UTF-8 BOM is not allowed".into(),
        ));
    }
    let normalized = markdown.replace("\r\n", "\n").replace('\r', "\n");
    if !normalized.starts_with("---") {
        return Err(BundleError::SkillFrontmatter(
            "missing YAML frontmatter".into(),
        ));
    }
    let mut lines = normalized.lines();
    if lines.next().unwrap_or_default() != "---" {
        return Err(BundleError::SkillFrontmatter(
            "frontmatter must start with `---`".into(),
        ));
    }
    let mut name = None;
    let mut description = None;
    let mut closed = false;
    let mut seen = HashSet::new();
    for line in lines {
        if line == "---" {
            closed = true;
            break;
        }
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        if line.chars().next().is_some_and(char::is_whitespace) {
            return Err(BundleError::SkillFrontmatter(
                "frontmatter cannot contain indented or nested data".into(),
            ));
        }
        let (key, value) = line.split_once(':').ok_or_else(|| {
            BundleError::SkillFrontmatter("frontmatter has an invalid field".into())
        })?;
        if key.is_empty()
            || key.len() > 64
            || !key.chars().enumerate().all(|(index, character)| {
                if index == 0 {
                    character.is_ascii_alphabetic()
                } else {
                    character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
                }
            })
        {
            return Err(BundleError::SkillFrontmatter(
                "frontmatter has an invalid field name".into(),
            ));
        }
        if is_dangerous_frontmatter_key(key) {
            return Err(BundleError::SkillFrontmatter(
                "frontmatter cannot enable plugins or execution".into(),
            ));
        }
        let normalized_key = key.trim().to_ascii_lowercase().replace(['-', '_'], "");
        if !seen.insert(normalized_key.clone())
            || matches!(normalized_key.as_str(), "__proto__" | "constructor")
        {
            return Err(BundleError::SkillFrontmatter(
                "frontmatter contains a duplicate or reserved field".into(),
            ));
        }
        let parsed = parse_frontmatter_scalar(value, key)?;
        match (key, parsed) {
            ("name", FrontmatterScalar::String(value)) => name = Some(value),
            ("description", FrontmatterScalar::String(value)) => description = Some(value),
            _ => {}
        }
    }
    if !closed {
        return Err(BundleError::SkillFrontmatter(
            "frontmatter is not closed".into(),
        ));
    }
    let name = name
        .filter(|value| !value.is_empty())
        .ok_or_else(|| BundleError::SkillFrontmatter("missing name".into()))?;
    if name.chars().count() > 64
        || !name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        || name.starts_with('-')
        || name.ends_with('-')
        || name.contains("--")
    {
        return Err(BundleError::SkillFrontmatter(
            "name must be lowercase letters, digits and single hyphens".into(),
        ));
    }
    let description = description
        .filter(|value| !value.is_empty())
        .ok_or_else(|| BundleError::SkillFrontmatter("missing description".into()))?;
    if description.chars().count() > 1024 {
        return Err(BundleError::SkillFrontmatter(
            "description exceeds 1024 bytes".into(),
        ));
    }
    Ok(())
}

#[derive(Debug)]
enum FrontmatterScalar {
    String(String),
    Number,
    Boolean,
}

fn parse_frontmatter_scalar(raw: &str, key: &str) -> Result<FrontmatterScalar, BundleError> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(BundleError::SkillFrontmatter(format!(
            "frontmatter field {key} cannot be empty"
        )));
    }
    if value.starts_with(['[', '{', '!']) {
        return Err(BundleError::SkillFrontmatter(format!(
            "frontmatter field {key} must be a scalar"
        )));
    }
    let value = if value.starts_with('"') {
        if !value.ends_with('"') || value.len() < 2 {
            return Err(BundleError::SkillFrontmatter(format!(
                "frontmatter field {key} has an unterminated quote"
            )));
        }
        serde_json::from_str::<String>(value).map_err(|_| {
            BundleError::SkillFrontmatter(format!(
                "frontmatter field {key} has an invalid quoted value"
            ))
        })?
    } else if value.starts_with('\'') {
        if !value.ends_with('\'') || value.len() < 2 {
            return Err(BundleError::SkillFrontmatter(format!(
                "frontmatter field {key} has an unterminated quote"
            )));
        }
        value[1..value.len() - 1].replace("''", "'")
    } else {
        value.to_string()
    };
    if value.chars().any(char::is_control) {
        return Err(BundleError::SkillFrontmatter(format!(
            "frontmatter field {key} contains control characters"
        )));
    }
    if value == "true" || value == "false" {
        return Ok(FrontmatterScalar::Boolean);
    }
    if value.parse::<f64>().is_ok() {
        return Ok(FrontmatterScalar::Number);
    }
    Ok(FrontmatterScalar::String(value))
}

fn is_dangerous_frontmatter_key(raw_key: &str) -> bool {
    let raw_key = raw_key.trim();
    let normalized = raw_key.to_ascii_lowercase();
    let compact = normalized.replace(['-', '_'], "");
    if compact == "allowedtools" {
        return false;
    }
    const DANGEROUS: &[&str] = &[
        "plugin",
        "plugins",
        "pluginjson",
        "extension",
        "extensions",
        "mcp",
        "mcpserver",
        "mcpservers",
        "hook",
        "hooks",
        "command",
        "commands",
        "script",
        "scripts",
        "runtime",
        "runtimes",
        "entrypoint",
        "install",
        "installer",
        "tool",
        "tools",
    ];
    if DANGEROUS.iter().any(|candidate| compact == *candidate) {
        return true;
    }
    const PARTS: &[&str] = &[
        "plugin",
        "extension",
        "mcp",
        "hook",
        "command",
        "script",
        "runtime",
        "entrypoint",
        "install",
        "execute",
    ];
    let mut segmented = String::new();
    for (index, character) in raw_key.chars().enumerate() {
        if index > 0 && character.is_ascii_uppercase() {
            segmented.push('-');
        }
        segmented.push(character.to_ascii_lowercase());
    }
    let segments: Vec<&str> = segmented.split(['-', '_']).collect();
    PARTS
        .iter()
        .any(|part| segments.contains(part) || compact.starts_with(part) || compact.ends_with(part))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn bundle(files: &[(&str, &[u8])]) -> SkillBundle {
        SkillBundle {
            format: BUNDLE_FORMAT.into(),
            files: files
                .iter()
                .map(|(path, bytes)| BundleFile {
                    path: (*path).into(),
                    content: BASE64.encode(bytes),
                    executable: None,
                })
                .collect(),
        }
    }
    #[test]
    fn canonical_bytes_sort_paths_and_are_stable() {
        let a = bundle(&[
            ("z.txt", b"z"),
            ("SKILL.md", b"---\nname: demo\ndescription: test\n---\n"),
        ]);
        let b = bundle(&[
            ("SKILL.md", b"---\nname: demo\ndescription: test\n---\n"),
            ("z.txt", b"z"),
        ]);
        assert_eq!(
            canonical_bundle_bytes(&a).unwrap(),
            canonical_bundle_bytes(&b).unwrap()
        );
    }
    #[test]
    fn rejects_traversal_and_windows_paths() {
        for path in ["../x", "/x", "C:/x", "\\\\server\\x", "CON.txt", "foo/../x"] {
            assert!(validate_path(path).is_err(), "accepted {path}");
        }
    }
    #[test]
    fn rejects_missing_frontmatter() {
        let b = bundle(&[("SKILL.md", b"# no frontmatter")]);
        assert!(matches!(
            validate_bundle(&b, BundleLimits::default()),
            Err(BundleError::SkillFrontmatter(_))
        ));
    }

    #[test]
    fn canonical_protocol_vector_matches_frozen_digest() {
        let bytes = include_bytes!("../../../fixtures/protocol/hello.bundle.json");
        let expected_digest = include_str!("../../../fixtures/protocol/hello.digest.txt").trim();
        let bundle = decode_bundle_bytes(bytes).expect("protocol fixture is valid");
        let canonical = canonical_bundle_bytes(&bundle).expect("fixture canonicalizes");
        assert_eq!(canonical, bytes);
        assert_eq!(digest_bytes(&canonical), expected_digest);
    }
}
