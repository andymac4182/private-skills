use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Agent {
    Codex,
    Claude,
    Universal,
}
impl Agent {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
            Self::Universal => "universal",
        }
    }
}
impl std::str::FromStr for Agent {
    type Err = PathError;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.to_ascii_lowercase().as_str() {
            "codex" => Ok(Self::Codex),
            "claude" => Ok(Self::Claude),
            "universal" => Ok(Self::Universal),
            _ => Err(PathError::InvalidAgent(value.into())),
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallScope {
    Project,
    Global,
}
impl InstallScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Project => "project",
            Self::Global => "global",
        }
    }
}
#[derive(Debug, Error)]
pub enum PathError {
    #[error("unknown agent `{0}` (choose codex, claude, or universal)")]
    InvalidAgent(String),
    #[error("cannot determine the current project directory: {0}")]
    CurrentDirectory(#[source] std::io::Error),
    #[error("cannot determine the user's home directory")]
    NoHome,
    #[error("explicit install directory must be absolute: {0}")]
    RelativeExplicit(PathBuf),
    #[error("install directory cannot be a file: {0}")]
    File(PathBuf),
    #[error("cannot inspect install directory `{path}`: {source}")]
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
}
pub fn resolve_directory(
    explicit: Option<&Path>,
    agent: Agent,
    scope: InstallScope,
) -> Result<PathBuf, PathError> {
    if let Some(path) = explicit {
        if !path.is_absolute() {
            return Err(PathError::RelativeExplicit(path.to_path_buf()));
        }
        if path.exists() && path.is_file() {
            return Err(PathError::File(path.to_path_buf()));
        }
        return normalize_destination(path);
    }
    normalize_destination(&agent_root(agent, scope))
}
pub fn agent_root(agent: Agent, scope: InstallScope) -> PathBuf {
    match scope {
        InstallScope::Project => {
            let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            match agent {
                Agent::Codex | Agent::Universal => cwd.join(".agents").join("skills"),
                Agent::Claude => cwd.join(".claude").join("skills"),
            }
        }
        InstallScope::Global => {
            let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
            match agent {
                Agent::Codex | Agent::Universal => home.join(".agents").join("skills"),
                Agent::Claude => home.join(".claude").join("skills"),
            }
        }
    }
}
pub fn normalize_destination(path: &Path) -> Result<PathBuf, PathError> {
    if path.exists() {
        return std::fs::canonicalize(path).map_err(|source| PathError::Io {
            path: path.to_path_buf(),
            source,
        });
    }
    let mut suffix = Vec::new();
    let mut current = path;
    while !current.exists() {
        if let Some(name) = current.file_name() {
            suffix.push(name.to_os_string());
        }
        current = current.parent().unwrap_or_else(|| Path::new("."));
    }
    let mut result = std::fs::canonicalize(current).map_err(|source| PathError::Io {
        path: current.to_path_buf(),
        source,
    })?;
    for component in suffix.iter().rev() {
        result.push(component);
    }
    Ok(result)
}
