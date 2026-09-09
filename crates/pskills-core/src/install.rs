use crate::bundle::{digest_bytes, tree_digest, validate_path, BundleError, BundleLimits};
use crate::model::{JournalEntry, JournalFile, JournalFileDocument, LockFile, SkillBundle};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::Digest as ShaDigest;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum InstallError {
    #[error("invalid bundle: {0}")]
    Bundle(#[from] BundleError),
    #[error("invalid skill name `{0}`")]
    InvalidSkillName(String),
    #[error("destination `{0}` is a symbolic link")]
    Symlink(PathBuf),
    #[error("destination `{0}` is not a directory")]
    NotDirectory(PathBuf),
    #[error("destination already contains unmanaged files: {0}")]
    DestinationConflict(PathBuf),
    #[error("local edits prevent replacing `{destination}`: {details}")]
    LocalEdits {
        destination: PathBuf,
        details: String,
    },
    #[error("owned skill `{0}` is not installed")]
    NotInstalled(String),
    #[error("cannot read `{path}`: {source}")]
    Read { path: PathBuf, source: io::Error },
    #[error("cannot write `{path}`: {source}")]
    Write { path: PathBuf, source: io::Error },
    #[error("cannot replace `{path}` safely: {source}")]
    Replace { path: PathBuf, source: io::Error },
    #[error("activation failed for `{path}` and rollback also failed: {source}")]
    Rollback { path: PathBuf, source: io::Error },
    #[error("artifact digest mismatch: expected {expected}, received {actual}")]
    DigestMismatch { expected: String, actual: String },
    #[error("cannot acquire installation lock `{path}`: {source}")]
    Lock { path: PathBuf, source: io::Error },
    #[error("local journal is invalid: {0}")]
    Journal(#[from] serde_json::Error),
}

#[derive(Debug, Clone)]
pub struct InstallPlan {
    pub root: PathBuf,
    pub skill_name: String,
    pub bundle: SkillBundle,
    pub artifact_digest: String,
    pub owner: String,
    pub dry_run: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InstalledEntry {
    pub key: String,
    pub destination: PathBuf,
    pub skill_name: String,
    pub digest: String,
    pub tree_digest: String,
    pub owners: Vec<String>,
    pub files: Vec<JournalFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InstallResult {
    pub changed: bool,
    pub destination: PathBuf,
    pub backup: Option<PathBuf>,
    pub entry: InstalledEntry,
}

#[derive(Debug, Clone)]
pub struct LocalState {
    pub root: PathBuf,
    pub lock_path: PathBuf,
    pub journal_path: PathBuf,
}

impl LocalState {
    pub fn for_project(root: PathBuf) -> Self {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        Self {
            root: root.clone(),
            lock_path: cwd.join("pskills.lock.json"),
            journal_path: root.join(".pskills-journal.json"),
        }
    }

    pub fn for_global(root: PathBuf) -> Self {
        Self {
            lock_path: root.join(".pskills.lock.json"),
            journal_path: root.join(".pskills-journal.json"),
            root: root.clone(),
        }
    }

    pub fn read_lock(&self) -> Result<LockFile, InstallError> {
        read_json_or_default(&self.lock_path)
    }

    pub fn read_journal(&self) -> Result<JournalFileDocument, InstallError> {
        read_json_or_default(&self.journal_path)
    }

    pub fn write_lock(&self, lock: &LockFile) -> Result<(), InstallError> {
        atomic_write_json(&self.lock_path, lock)
    }

    pub fn write_journal(&self, journal: &JournalFileDocument) -> Result<(), InstallError> {
        atomic_write_json(&self.journal_path, journal)
    }

    pub fn entries(&self) -> Result<Vec<InstalledEntry>, InstallError> {
        Ok(self
            .read_journal()?
            .entries
            .into_iter()
            .map(InstalledEntry::from)
            .collect())
    }

    pub fn install(&self, plan: &InstallPlan) -> Result<InstallResult, InstallError> {
        reject_symlink_components(&self.root)?;
        let _lock = InstallationLock::acquire(&self.root)?;
        let limits = BundleLimits::default();
        crate::bundle::validate_bundle(&plan.bundle, limits)?;
        let actual_digest = crate::bundle::bundle_digest(&plan.bundle)?;
        if actual_digest != plan.artifact_digest {
            return Err(InstallError::DigestMismatch {
                expected: plan.artifact_digest.clone(),
                actual: actual_digest,
            });
        }
        validate_skill_name(&plan.skill_name)?;
        fs::create_dir_all(&self.root).map_err(|source| InstallError::Write {
            path: self.root.clone(),
            source,
        })?;
        let destination = self.root.join(&plan.skill_name);
        reject_symlink_or_file(&destination)?;

        let mut journal = self.read_journal()?;
        journal.version = 1;
        let existing_index = journal
            .entries
            .iter()
            .position(|entry| entry.destination == destination.to_string_lossy());
        let existing = existing_index.map(|index| journal.entries[index].clone());
        if let Some(existing) = existing.as_ref() {
            verify_journal_entry(existing)?;
            if existing.digest != plan.artifact_digest
                && existing.owners.iter().any(|owner| owner != &plan.owner)
            {
                return Err(InstallError::DestinationConflict(destination));
            }
            if existing.digest == plan.artifact_digest
                && existing.owners.iter().any(|owner| owner == &plan.owner)
            {
                let entry = InstalledEntry::from(existing.clone());
                return Ok(InstallResult {
                    changed: false,
                    destination,
                    backup: None,
                    entry,
                });
            }
        } else if destination.exists() {
            return Err(InstallError::DestinationConflict(destination));
        }

        let entry = build_journal_entry(
            &destination,
            &plan.skill_name,
            &plan.artifact_digest,
            &plan.owner,
            &plan.bundle,
        )?;
        if plan.dry_run {
            let entry = InstalledEntry::from(entry);
            return Ok(InstallResult {
                changed: true,
                destination,
                backup: None,
                entry,
            });
        }

        let stage = make_stage_dir(&self.root)?;
        if let Err(error) = extract_bundle(&stage, &plan.bundle) {
            let _ = fs::remove_dir_all(&stage);
            return Err(error);
        }
        let backup = activate_directory(&stage, &destination)?;

        let mut new_entry = entry;
        if let Some(existing_index) = existing_index {
            let old = &journal.entries[existing_index];
            new_entry.owners = old.owners.clone();
            if !new_entry.owners.iter().any(|owner| owner == &plan.owner) {
                new_entry.owners.push(plan.owner.clone());
            }
            journal.entries[existing_index] = new_entry.clone();
        } else {
            journal.entries.push(new_entry.clone());
        }
        // The replacement is still recoverable through the backup path if the
        // journal write fails.
        self.write_journal(&journal)?;
        Ok(InstallResult {
            changed: true,
            destination,
            backup,
            entry: InstalledEntry::from(new_entry),
        })
    }

    pub fn remove(
        &self,
        skill_name: &str,
        owner: Option<&str>,
        dry_run: bool,
    ) -> Result<InstalledEntry, InstallError> {
        reject_symlink_components(&self.root)?;
        let _lock = InstallationLock::acquire(&self.root)?;
        validate_skill_name(skill_name)?;
        let mut journal = self.read_journal()?;
        journal.version = 1;
        let index = journal
            .entries
            .iter()
            .position(|entry| entry.skill_name == skill_name)
            .ok_or_else(|| InstallError::NotInstalled(skill_name.into()))?;
        let entry = journal.entries[index].clone();
        verify_journal_entry(&entry)?;
        let owner = owner.unwrap_or("direct");
        let mut updated = entry.clone();
        updated.owners.retain(|candidate| candidate != owner);
        if !dry_run {
            if updated.owners.is_empty() {
                let destination = PathBuf::from(&entry.destination);
                let backup = destination.with_file_name(format!(
                    ".pskills-remove-{}-{}",
                    skill_name,
                    unique_suffix()
                ));
                fs::rename(&destination, &backup).map_err(|source| InstallError::Replace {
                    path: destination.clone(),
                    source,
                })?;
                if let Err(source) = fs::remove_dir_all(&backup) {
                    let _ = fs::rename(&backup, &destination);
                    return Err(InstallError::Replace {
                        path: destination,
                        source,
                    });
                }
                journal.entries.remove(index);
            } else {
                journal.entries[index] = updated.clone();
            }
            self.write_journal(&journal)?;
        }
        Ok(InstalledEntry::from(updated))
    }

    pub fn verify(&self) -> Result<Vec<VerifyResult>, InstallError> {
        let journal = self.read_journal()?;
        journal.entries.iter().map(verify_entry).collect()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VerifyResult {
    pub key: String,
    pub destination: PathBuf,
    pub ok: bool,
    pub expected_tree_digest: String,
    pub actual_tree_digest: Option<String>,
    pub error: Option<String>,
}

impl From<JournalEntry> for InstalledEntry {
    fn from(entry: JournalEntry) -> Self {
        let tree_digest = tree_from_key(&entry.key);
        Self {
            key: entry.key,
            destination: PathBuf::from(entry.destination),
            skill_name: entry.skill_name,
            digest: entry.digest,
            tree_digest,
            owners: entry.owners,
            files: entry.files,
        }
    }
}

fn build_journal_entry(
    destination: &Path,
    skill_name: &str,
    digest: &str,
    owner: &str,
    bundle: &SkillBundle,
) -> Result<JournalEntry, InstallError> {
    let tree = tree_digest(bundle)?;
    let files = bundle
        .files
        .iter()
        .map(|file| {
            let bytes =
                BASE64
                    .decode(file.content.as_bytes())
                    .map_err(|source| BundleError::Base64 {
                        path: file.path.clone(),
                        source,
                    })?;
            Ok(JournalFile {
                path: file.path.clone(),
                digest: digest_bytes(&bytes),
                size: bytes.len() as u64,
            })
        })
        .collect::<Result<Vec<_>, BundleError>>()?;
    Ok(JournalEntry {
        key: format!("{skill_name}@{digest}"),
        destination: destination.to_string_lossy().into_owned(),
        skill_name: skill_name.into(),
        digest: digest.into(),
        owners: vec![owner.into()],
        files,
    })
    .map(|mut entry| {
        // Keep the tree digest in the key metadata without changing the lock
        // contract: journal entries are local and may carry an opaque suffix.
        entry.key = format!("{}|tree={tree}", entry.key);
        entry
    })
}

fn extract_bundle(stage: &Path, bundle: &SkillBundle) -> Result<(), InstallError> {
    fs::create_dir_all(stage).map_err(|source| InstallError::Write {
        path: stage.to_path_buf(),
        source,
    })?;
    for file in &bundle.files {
        validate_path(&file.path)?;
        let target = stage.join(&file.path);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|source| InstallError::Write {
                path: parent.to_path_buf(),
                source,
            })?;
        }
        let metadata = target.symlink_metadata();
        if metadata.is_ok() {
            return Err(InstallError::DestinationConflict(target));
        }
        let bytes =
            BASE64
                .decode(file.content.as_bytes())
                .map_err(|source| BundleError::Base64 {
                    path: file.path.clone(),
                    source,
                })?;
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|source| InstallError::Write {
                path: target.clone(),
                source,
            })?;
        output
            .write_all(&bytes)
            .map_err(|source| InstallError::Write {
                path: target.clone(),
                source,
            })?;
        output.sync_all().map_err(|source| InstallError::Write {
            path: target.clone(),
            source,
        })?;
        #[cfg(unix)]
        if file.executable.unwrap_or(false) {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = output
                .metadata()
                .map_err(|source| InstallError::Write {
                    path: target.clone(),
                    source,
                })?
                .permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&target, permissions).map_err(|source| InstallError::Write {
                path: target.clone(),
                source,
            })?;
        }
    }
    Ok(())
}

fn activate_directory(stage: &Path, destination: &Path) -> Result<Option<PathBuf>, InstallError> {
    let backup = if destination.exists() {
        let path = destination.with_file_name(format!(".pskills-backup-{}", unique_suffix()));
        fs::rename(destination, &path).map_err(|source| InstallError::Replace {
            path: destination.to_path_buf(),
            source,
        })?;
        Some(path)
    } else {
        None
    };
    if let Err(source) = fs::rename(stage, destination) {
        if let Some(backup) = backup.as_ref() {
            if let Err(rollback_source) = fs::rename(backup, destination) {
                return Err(InstallError::Rollback {
                    path: destination.to_path_buf(),
                    source: rollback_source,
                });
            }
        }
        return Err(InstallError::Replace {
            path: destination.to_path_buf(),
            source,
        });
    }
    Ok(backup)
}

fn verify_entry(entry: &JournalEntry) -> Result<VerifyResult, InstallError> {
    match verify_journal_entry(entry) {
        Ok(()) => Ok(VerifyResult {
            key: entry.key.clone(),
            destination: PathBuf::from(&entry.destination),
            ok: true,
            expected_tree_digest: tree_from_key(&entry.key),
            actual_tree_digest: Some(tree_from_files(entry)?),
            error: None,
        }),
        Err(error) => Ok(VerifyResult {
            key: entry.key.clone(),
            destination: PathBuf::from(&entry.destination),
            ok: false,
            expected_tree_digest: tree_from_key(&entry.key),
            actual_tree_digest: None,
            error: Some(error.to_string()),
        }),
    }
}

fn verify_journal_entry(entry: &JournalEntry) -> Result<(), InstallError> {
    let destination = PathBuf::from(&entry.destination);
    reject_symlink_or_file(&destination)?;
    if !destination.exists() {
        return Err(InstallError::NotInstalled(entry.skill_name.clone()));
    }
    for file in &entry.files {
        validate_path(&file.path)?;
        let path = destination.join(&file.path);
        let metadata = fs::symlink_metadata(&path).map_err(|source| InstallError::Read {
            path: path.clone(),
            source,
        })?;
        if metadata.file_type().is_symlink() {
            return Err(InstallError::Symlink(path));
        }
        if !metadata.is_file() {
            return Err(InstallError::NotDirectory(path));
        }
        let bytes = fs::read(&path).map_err(|source| InstallError::Read {
            path: path.clone(),
            source,
        })?;
        let actual = digest_bytes(&bytes);
        if actual != file.digest {
            return Err(InstallError::LocalEdits {
                destination,
                details: format!("file `{}` changed", file.path),
            });
        }
    }
    // Extra files are unmanaged edits.  This is intentionally recursive and
    // rejects symlinked directories instead of following them.
    for entry_path in walkdir::WalkDir::new(&destination).follow_links(false) {
        let entry_path = entry_path.map_err(|err| InstallError::Read {
            path: err.path().unwrap_or(&destination).to_path_buf(),
            source: io::Error::other(err.to_string()),
        })?;
        if entry_path.path() == destination {
            continue;
        }
        if entry_path.file_type().is_symlink() {
            return Err(InstallError::Symlink(entry_path.path().to_path_buf()));
        }
        let relative =
            entry_path
                .path()
                .strip_prefix(&destination)
                .map_err(|_| InstallError::Read {
                    path: entry_path.path().to_path_buf(),
                    source: io::Error::other("path escaped destination"),
                })?;
        let relative = relative.to_string_lossy().replace('\\', "/");
        if entry_path.file_type().is_file() && !entry.files.iter().any(|file| file.path == relative)
        {
            return Err(InstallError::LocalEdits {
                destination,
                details: format!("unmanaged file `{relative}` exists"),
            });
        }
    }
    Ok(())
}

fn tree_from_files(entry: &JournalEntry) -> Result<String, InstallError> {
    let mut files = entry.files.clone();
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let mut hasher = sha2::Sha256::new();
    for file in files {
        hasher.update(file.path.as_bytes());
        hasher.update([0]);
        let path = PathBuf::from(&entry.destination).join(&file.path);
        let bytes = fs::read(&path).map_err(|source| InstallError::Read { path, source })?;
        hasher.update(bytes);
        hasher.update([0]);
    }
    Ok(format!("sha256:{}", hex_digest(&hasher.finalize())))
}

fn tree_from_key(key: &str) -> String {
    key.split("|tree=").nth(1).unwrap_or_default().to_string()
}

fn hex_digest(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0xf) as usize] as char);
    }
    output
}

fn validate_skill_name(name: &str) -> Result<(), InstallError> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
    {
        return Err(InstallError::InvalidSkillName(name.into()));
    }
    validate_path(name).map_err(|_| InstallError::InvalidSkillName(name.into()))
}

fn reject_symlink_or_file(path: &Path) -> Result<(), InstallError> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() {
            return Err(InstallError::Symlink(path.to_path_buf()));
        }
        if !metadata.is_dir() {
            return Err(InstallError::NotDirectory(path.to_path_buf()));
        }
    }
    Ok(())
}

fn reject_symlink_components(path: &Path) -> Result<(), InstallError> {
    // The CLI canonicalizes the selected root first.  For direct library
    // callers, reject a symlink at the root itself while allowing platform
    // aliases such as macOS `/var -> /private/var` in its ancestors.
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() {
            return Err(InstallError::Symlink(path.to_path_buf()));
        }
    }
    Ok(())
}

fn make_stage_dir(root: &Path) -> Result<PathBuf, InstallError> {
    for _ in 0..10 {
        let stage = root.join(format!(".pskills-stage-{}", unique_suffix()));
        match fs::create_dir(&stage) {
            Ok(()) => return Ok(stage),
            Err(source) if source.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(source) => {
                return Err(InstallError::Write {
                    path: stage,
                    source,
                })
            }
        }
    }
    Err(InstallError::Write {
        path: root.to_path_buf(),
        source: io::Error::new(
            io::ErrorKind::AlreadyExists,
            "could not allocate a staging directory",
        ),
    })
}

fn unique_suffix() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{}-{}", std::process::id(), millis)
}

fn read_json_or_default<T>(path: &Path) -> Result<T, InstallError>
where
    T: serde::de::DeserializeOwned + Default,
{
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(InstallError::Journal),
        Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(T::default()),
        Err(source) => Err(InstallError::Read {
            path: path.to_path_buf(),
            source,
        }),
    }
}

fn atomic_write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), InstallError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|source| InstallError::Write {
            path: parent.to_path_buf(),
            source,
        })?;
    }
    let bytes = serde_json::to_vec_pretty(value).map_err(InstallError::Journal)?;
    let temp = path.with_file_name(format!(
        ".{}.tmp-{}",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("pskills"),
        unique_suffix()
    ));
    let mut file = File::create(&temp).map_err(|source| InstallError::Write {
        path: temp.clone(),
        source,
    })?;
    file.write_all(&bytes)
        .map_err(|source| InstallError::Write {
            path: temp.clone(),
            source,
        })?;
    file.sync_all().map_err(|source| InstallError::Write {
        path: temp.clone(),
        source,
    })?;
    fs::rename(&temp, path).map_err(|source| InstallError::Write {
        path: path.to_path_buf(),
        source,
    })
}

struct InstallationLock {
    path: PathBuf,
}

impl InstallationLock {
    fn acquire(root: &Path) -> Result<Self, InstallError> {
        fs::create_dir_all(root).map_err(|source| InstallError::Lock {
            path: root.to_path_buf(),
            source,
        })?;
        let path = root.join(".pskills-install.lock");
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                let _ = writeln!(file, "pid={} start={}", std::process::id(), unique_suffix());
                Ok(Self { path })
            }
            Err(source) if source.kind() == io::ErrorKind::AlreadyExists => {
                Err(InstallError::Lock { path, source })
            }
            Err(source) => Err(InstallError::Lock { path, source }),
        }
    }
}

impl Drop for InstallationLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bundle::{bundle_digest, BUNDLE_FORMAT};
    use crate::model::BundleFile;
    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine;

    fn fixture_bundle() -> SkillBundle {
        SkillBundle {
            format: BUNDLE_FORMAT.into(),
            files: vec![BundleFile {
                path: "SKILL.md".into(),
                content: BASE64.encode(b"---\nname: demo\ndescription: test\n---\n# Demo\n"),
                executable: None,
            }],
        }
    }

    fn temp_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!("pskills-install-test-{}", unique_suffix()));
        fs::create_dir_all(&root).expect("temp root");
        root
    }

    #[test]
    fn stages_installs_and_protects_local_edits() {
        let root = temp_root();
        let state = LocalState::for_global(root.clone());
        let bundle = fixture_bundle();
        let digest = bundle_digest(&bundle).expect("digest");
        let result = state
            .install(&InstallPlan {
                root: root.clone(),
                skill_name: "demo".into(),
                bundle: bundle.clone(),
                artifact_digest: digest,
                owner: "direct:@team/demo".into(),
                dry_run: false,
            })
            .expect("install");
        assert!(result.changed);
        assert!(root.join("demo/SKILL.md").exists());
        assert!(state.verify().expect("verify")[0].ok);

        fs::write(root.join("demo/SKILL.md"), b"local edit\n").expect("edit");
        let error = state
            .install(&InstallPlan {
                root: root.clone(),
                skill_name: "demo".into(),
                bundle: bundle.clone(),
                artifact_digest: bundle_digest(&bundle).expect("digest"),
                owner: "direct:@team/demo".into(),
                dry_run: false,
            })
            .expect_err("local edit should be protected");
        assert!(matches!(error, InstallError::LocalEdits { .. }));
        fs::remove_dir_all(root).expect("cleanup");
    }
}
