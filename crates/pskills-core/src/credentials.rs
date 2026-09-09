use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::PathBuf;
use std::process::Command;
use thiserror::Error;

const SERVICE: &str = "private-skills";
const ACCOUNT: &str = "pskills-cli";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct ConfigFile {
    #[serde(default)]
    registries: BTreeMap<String, RegistryConfig>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegistryConfig {
    pub url: String,
    #[serde(default)]
    pub organization: Option<String>,
}

#[derive(Debug, Error)]
pub enum CredentialError {
    #[error("cannot determine the configuration directory")]
    NoConfigDirectory,
    #[error("cannot read credential configuration `{path}`: {source}")]
    ReadConfig { path: PathBuf, source: io::Error },
    #[error("cannot write credential configuration `{path}`: {source}")]
    WriteConfig { path: PathBuf, source: io::Error },
    #[error("credential configuration is invalid: {0}")]
    InvalidConfig(#[from] serde_json::Error),
    #[error("no token is available for {0}; run `pskills login --registry {0} --token-stdin` or set PSKILLS_TOKEN for CI")]
    MissingToken(String),
    #[error("OS keyring is unavailable ({0}); set PSKILLS_TOKEN for headless use instead of storing a plaintext token")]
    KeyringUnavailable(String),
}

#[derive(Debug, Clone)]
pub struct CredentialStore {
    service: String,
    account: String,
}
impl Default for CredentialStore {
    fn default() -> Self {
        Self {
            service: SERVICE.into(),
            account: ACCOUNT.into(),
        }
    }
}
impl CredentialStore {
    pub fn config_path(&self) -> Result<PathBuf, CredentialError> {
        dirs::config_dir()
            .map(|dir| dir.join("pskills").join("config.json"))
            .ok_or(CredentialError::NoConfigDirectory)
    }
    fn load_config(&self) -> Result<ConfigFile, CredentialError> {
        let path = self.config_path()?;
        match fs::read(&path) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(ConfigFile::default()),
            Err(source) => Err(CredentialError::ReadConfig { path, source }),
        }
    }
    pub fn registry(&self, override_url: Option<&str>) -> Result<RegistryConfig, CredentialError> {
        if let Some(url) = override_url {
            return Ok(RegistryConfig {
                url: normalize_registry_url(url),
                organization: None,
            });
        }
        if let Ok(url) = std::env::var("PSKILLS_REGISTRY") {
            if !url.trim().is_empty() {
                return Ok(RegistryConfig {
                    url: normalize_registry_url(&url),
                    organization: None,
                });
            }
        }
        self.load_config()?
            .registries
            .values()
            .next()
            .cloned()
            .ok_or_else(|| CredentialError::MissingToken("<configured registry>".into()))
    }
    pub fn set_registry(&self, config: RegistryConfig) -> Result<(), CredentialError> {
        let path = self.config_path()?;
        let mut current = self.load_config()?;
        current.registries.insert(config.url.clone(), config);
        write_private_json(&path, &current)
    }
    pub fn remove_registry(&self, url: &str) -> Result<(), CredentialError> {
        let path = self.config_path()?;
        let mut current = self.load_config()?;
        current.registries.remove(&normalize_registry_url(url));
        write_private_json(&path, &current)
    }
    pub fn token(&self, registry: &str) -> Result<String, CredentialError> {
        if let Ok(token) = std::env::var("PSKILLS_TOKEN") {
            let token = token.trim().to_string();
            if !token.is_empty() {
                return Ok(token);
            }
        }
        let registry = normalize_registry_url(registry);
        match keyring_get(&self.service, &self.account, &registry) {
            Ok(Some(token)) if !token.trim().is_empty() => Ok(token.trim().into()),
            Ok(_) => Err(CredentialError::MissingToken(registry)),
            Err(err) => Err(CredentialError::KeyringUnavailable(err)),
        }
    }
    pub fn save_token(&self, registry: &str, token: &str) -> Result<(), CredentialError> {
        let token = token.trim();
        if token.is_empty() {
            return Err(CredentialError::MissingToken(registry.into()));
        }
        keyring_set(
            &self.service,
            &self.account,
            &normalize_registry_url(registry),
            token,
        )
        .map_err(CredentialError::KeyringUnavailable)
    }
    pub fn delete_token(&self, registry: &str) -> Result<(), CredentialError> {
        keyring_delete(
            &self.service,
            &self.account,
            &normalize_registry_url(registry),
        )
        .map_err(CredentialError::KeyringUnavailable)
    }
}
fn normalize_registry_url(url: &str) -> String {
    url.trim().trim_end_matches('/').into()
}
fn write_private_json(path: &PathBuf, value: &ConfigFile) -> Result<(), CredentialError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|source| CredentialError::WriteConfig {
            path: parent.into(),
            source,
        })?;
    }
    let bytes = serde_json::to_vec_pretty(value)?;
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, bytes).map_err(|source| CredentialError::WriteConfig {
        path: temp.clone(),
        source,
    })?;
    fs::rename(&temp, path).map_err(|source| CredentialError::WriteConfig {
        path: path.clone(),
        source,
    })
}

fn run_keyring(
    command: &str,
    args: &[&str],
    input: Option<&str>,
) -> Result<std::process::Output, String> {
    let mut process = Command::new(command);
    process.args(args);
    if input.is_some() {
        process.stdin(std::process::Stdio::piped());
    }
    let mut child = process.spawn().map_err(|err| format!("{command}: {err}"))?;
    if let Some(input) = input {
        use std::io::Write;
        child
            .stdin
            .take()
            .expect("piped stdin")
            .write_all(input.as_bytes())
            .map_err(|err| format!("{command}: {err}"))?;
    }
    child
        .wait_with_output()
        .map_err(|err| format!("{command}: {err}"))
}
fn keyring_get(service: &str, account: &str, registry: &str) -> Result<Option<String>, String> {
    let account = format!("{account}:{registry}");
    #[cfg(target_os = "macos")]
    {
        let output = run_keyring(
            "security",
            &["find-generic-password", "-a", &account, "-s", service, "-w"],
            None,
        )?;
        if output.status.success() {
            return Ok(Some(String::from_utf8_lossy(&output.stdout).trim().into()));
        }
        if output.status.code() == Some(44) {
            return Ok(None);
        }
        Err(String::from_utf8_lossy(&output.stderr).trim().into())
    }
    #[cfg(target_os = "linux")]
    {
        let output = run_keyring(
            "secret-tool",
            &[
                "lookup", "service", service, "account", account, "registry", registry,
            ],
            None,
        )?;
        if output.status.success() {
            return Ok(Some(String::from_utf8_lossy(&output.stdout).trim().into()));
        }
        return Ok(None);
    }
    #[cfg(target_os = "windows")]
    {
        let _ = (service, account, registry);
        Err("Windows Credential Manager integration is unavailable in this build".into())
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        let _ = (service, account, registry);
        Err("no supported OS keyring backend".into())
    }
}
fn keyring_set(service: &str, account: &str, registry: &str, token: &str) -> Result<(), String> {
    let account = format!("{account}:{registry}");
    #[cfg(target_os = "macos")]
    {
        let output = run_keyring(
            "security",
            &[
                "add-generic-password",
                "-U",
                "-a",
                &account,
                "-s",
                service,
                "-w",
                token,
            ],
            None,
        )?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().into())
        }
    }
    #[cfg(target_os = "linux")]
    {
        let output = run_keyring(
            "secret-tool",
            &[
                "store",
                "--label",
                "Private Skills CLI token",
                "service",
                service,
                "account",
                account,
                "registry",
                registry,
            ],
            Some(token),
        )?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().into())
        }
    }
    #[cfg(target_os = "windows")]
    {
        let _ = (service, account, registry, token);
        Err("Windows Credential Manager integration is unavailable in this build".into())
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        let _ = (service, account, registry, token);
        Err("no supported OS keyring backend".into())
    }
}
fn keyring_delete(service: &str, account: &str, registry: &str) -> Result<(), String> {
    let account = format!("{account}:{registry}");
    #[cfg(target_os = "macos")]
    {
        let output = run_keyring(
            "security",
            &["delete-generic-password", "-a", &account, "-s", service],
            None,
        )?;
        if output.status.success() || output.status.code() == Some(44) {
            return Ok(());
        }
        Err(String::from_utf8_lossy(&output.stderr).trim().into())
    }
    #[cfg(target_os = "linux")]
    {
        let output = run_keyring(
            "secret-tool",
            &[
                "clear", "service", service, "account", account, "registry", registry,
            ],
            None,
        )?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().into())
        }
    }
    #[cfg(target_os = "windows")]
    {
        let _ = (service, account, registry);
        Err("Windows Credential Manager integration is unavailable in this build".into())
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        let _ = (service, account, registry);
        Err("no supported OS keyring backend".into())
    }
}
