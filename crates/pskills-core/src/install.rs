use crate::bundle::{digest_bytes, tree_digest, validate_path, BundleError, BundleLimits};
use crate::model::{JournalEntry, JournalFile, JournalFileDocument, LockFile, SkillBundle};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::Digest as ShaDigest;
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;

static UNIQUE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Error)]
pub enum InstallError {
    #[error("invalid bundle: {0}")]
    Bundle(#[from] BundleError),
    #[error("invalid skill name `{0}`")]
    InvalidSkillName(String),
    #[error("owner must not be empty")]
    EmptyOwner,
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
    #[error("expected tree digest is missing for `{0}`")]
    MissingTreeDigest(PathBuf),
    #[error("installed tree for `{destination}` changed: expected {expected}, received {actual}")]
    TreeMismatch {
        destination: PathBuf,
        expected: String,
        actual: String,
    },
    #[error("installation journal is inconsistent: {0}")]
    JournalInvariant(String),
    #[error("installation recovery is unsafe: {0}")]
    RecoveryConflict(String),
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
        let project_root = if root.file_name().and_then(|name| name.to_str()) == Some("skills")
            && matches!(
                root.parent()
                    .and_then(|parent| parent.file_name())
                    .and_then(|name| name.to_str()),
                Some(".agents") | Some(".claude")
            ) {
            root.parent()
                .and_then(Path::parent)
                .map(Path::to_path_buf)
                .unwrap_or_else(|| root.clone())
        } else {
            root.clone()
        };
        Self {
            root: root.clone(),
            lock_path: project_root.join("pskills.lock.json"),
            journal_path: root.join(".pskills-journal.json"),
        }
    }

    pub fn for_global(root: PathBuf) -> Self {
        Self {
            lock_path: root.join(".pskills.lock.json"),
            journal_path: root.join(".pskills-journal.json"),
            root,
        }
    }

    pub fn read_lock(&self) -> Result<LockFile, InstallError> {
        let root = self.prepare_root()?;
        let _locks = self.acquire_state_locks(&root)?;
        recover_locked(&root, &self.journal_path, &self.lock_path)?;
        read_json_or_default(&self.lock_path)
    }

    pub fn read_journal(&self) -> Result<JournalFileDocument, InstallError> {
        let root = self.prepare_root()?;
        let _locks = self.acquire_state_locks(&root)?;
        recover_locked(&root, &self.journal_path, &self.lock_path)?;
        read_json_or_default(&self.journal_path)
    }

    pub fn write_lock(&self, lock: &LockFile) -> Result<(), InstallError> {
        let root = self.prepare_root()?;
        let _locks = self.acquire_state_locks(&root)?;
        recover_locked(&root, &self.journal_path, &self.lock_path)?;
        atomic_write_json(&self.lock_path, lock)
    }

    pub fn write_journal(&self, journal: &JournalFileDocument) -> Result<(), InstallError> {
        let root = self.prepare_root()?;
        let _locks = self.acquire_state_locks(&root)?;
        recover_locked(&root, &self.journal_path, &self.lock_path)?;
        atomic_write_json(&self.journal_path, journal)
    }

    pub fn entries(&self) -> Result<Vec<InstalledEntry>, InstallError> {
        let root = self.prepare_root()?;
        let _locks = self.acquire_state_locks(&root)?;
        recover_locked(&root, &self.journal_path, &self.lock_path)?;
        Ok(read_checked_journal(&self.journal_path, &root)?
            .entries
            .into_iter()
            .map(InstalledEntry::from)
            .collect())
    }

    /// Recover an interrupted transaction while holding the native OS lock.
    /// Mutating and observing methods call this automatically as well.
    pub fn recover(&self) -> Result<(), InstallError> {
        let root = self.prepare_root()?;
        let _locks = self.acquire_state_locks(&root)?;
        recover_locked(&root, &self.journal_path, &self.lock_path)
    }

    pub fn install(&self, plan: &InstallPlan) -> Result<InstallResult, InstallError> {
        self.install_many(std::slice::from_ref(plan))?
            .into_iter()
            .next()
            .ok_or_else(|| InstallError::JournalInvariant("empty install result".into()))
    }

    /// Preflight and activate a complete set of skill installations under one
    /// durable transaction. A batch never permits duplicate destinations: a
    /// duplicate pack member must be rejected before any files are changed.
    pub fn install_many(&self, plans: &[InstallPlan]) -> Result<Vec<InstallResult>, InstallError> {
        self.install_many_with_lock(plans, None, None)
    }

    pub fn install_many_with_lock(
        &self,
        plans: &[InstallPlan],
        expected_lock: Option<&LockFile>,
        new_lock: Option<&LockFile>,
    ) -> Result<Vec<InstallResult>, InstallError> {
        let root = self.prepare_root()?;
        let _locks = self.acquire_state_locks(&root)?;
        recover_locked(&root, &self.journal_path, &self.lock_path)?;
        let lock_change = prepare_lock_change(&self.lock_path, expected_lock, new_lock)?;
        let journal = read_checked_journal(&self.journal_path, &root)?;
        if plans.is_empty() {
            return Ok(Vec::new());
        }
        let dry_run = plans[0].dry_run;
        if plans.iter().any(|plan| plan.dry_run != dry_run) {
            return Err(InstallError::JournalInvariant(
                "install_many cannot mix dry-run and mutating plans".into(),
            ));
        }

        let mut prepared = Vec::with_capacity(plans.len());
        let mut destinations = BTreeSet::new();
        for plan in plans {
            if self.prepare_root_for_plan(&plan.root)? != root {
                return Err(InstallError::JournalInvariant(format!(
                    "install plan root `{}` does not match state root `{}`",
                    plan.root.display(),
                    root.display()
                )));
            }
            validate_skill_name(&plan.skill_name)?;
            validate_owner(&plan.owner)?;
            crate::bundle::validate_bundle(&plan.bundle, BundleLimits::default())?;
            let actual_digest = crate::bundle::bundle_digest(&plan.bundle)?;
            if actual_digest != plan.artifact_digest {
                return Err(InstallError::DigestMismatch {
                    expected: plan.artifact_digest.clone(),
                    actual: actual_digest,
                });
            }
            let destination = root.join(&plan.skill_name);
            reject_symlink_or_file(&destination)?;
            if !destinations.insert(destination.clone()) {
                return Err(InstallError::DestinationConflict(destination));
            }
            prepared.push(PreparedInstall {
                plan,
                destination: destination.clone(),
                entry: build_journal_entry(
                    &destination,
                    &plan.skill_name,
                    &plan.artifact_digest,
                    &plan.owner,
                    &plan.bundle,
                )?,
            });
        }

        let mut index_by_destination = BTreeMap::new();
        for (index, entry) in journal.entries.iter().enumerate() {
            let destination = PathBuf::from(&entry.destination);
            if index_by_destination
                .insert(destination.clone(), index)
                .is_some()
            {
                return Err(InstallError::JournalInvariant(format!(
                    "duplicate journal destination `{}`",
                    destination.display()
                )));
            }
        }
        let mut new_journal = journal.clone();
        let mut operations = Vec::new();
        let mut results = Vec::with_capacity(prepared.len());
        let mut changed = false;

        for item in prepared {
            let existing_index = index_by_destination.get(&item.destination).copied();
            let existing = existing_index.map(|index| journal.entries[index].clone());
            let mut new_entry = item.entry.clone();
            let mut needs_files = false;
            let mut needs_metadata = false;
            let backup = if let Some(existing) = existing.as_ref() {
                verify_journal_entry(existing)?;
                if existing.skill_name != item.plan.skill_name {
                    return Err(InstallError::DestinationConflict(item.destination));
                }
                let mut owners = unique_sorted_owners(&existing.owners);
                if existing.digest != item.plan.artifact_digest {
                    if owners.iter().any(|owner| owner != &item.plan.owner) {
                        return Err(InstallError::DestinationConflict(item.destination));
                    }
                    // A replacement is valid only for its sole current owner.
                    owners = vec![item.plan.owner.clone()];
                    needs_files = true;
                    new_entry.owners = owners.clone();
                } else {
                    new_entry = existing.clone();
                    new_entry.owners = owners;
                    if !new_entry
                        .owners
                        .iter()
                        .any(|owner| owner == &item.plan.owner)
                    {
                        new_entry.owners.push(item.plan.owner.clone());
                        new_entry.owners.sort();
                        needs_metadata = true;
                    }
                }
                if needs_files {
                    Some(allocate_backup_path(&root, &item.destination)?)
                } else {
                    None
                }
            } else {
                if fs::symlink_metadata(&item.destination).is_ok() {
                    return Err(InstallError::DestinationConflict(item.destination));
                }
                needs_files = true;
                None
            };

            if !needs_files && !needs_metadata {
                results.push(InstallResult {
                    changed: false,
                    destination: item.destination,
                    backup: None,
                    entry: InstalledEntry::from(new_entry),
                });
                continue;
            }
            changed = true;
            if let Some(index) = existing_index {
                new_journal.entries[index] = new_entry.clone();
            } else {
                new_journal.entries.push(new_entry.clone());
            }
            operations.push(TransactionOperation {
                destination: item.destination.clone(),
                stage: None,
                backup: backup.clone(),
                kind: if needs_files {
                    TransactionOperationKind::Replace
                } else {
                    TransactionOperationKind::Metadata
                },
                retain_backup: needs_files && existing_index.is_some(),
                bundle: needs_files.then(|| item.plan.bundle.clone()),
            });
            results.push(InstallResult {
                changed: true,
                destination: item.destination,
                backup,
                entry: InstalledEntry::from(new_entry),
            });
        }

        if dry_run || (!changed && lock_change.is_none()) {
            return Ok(results);
        }
        self.commit_transaction(&root, &journal, &mut new_journal, operations, lock_change)?;
        Ok(results)
    }

    /// Remove one owner from selected skills in one transaction. Shared
    /// installations remain until their final owner is removed. An empty
    /// `skill_names` slice selects every entry carrying `owner`.
    pub fn remove_owner(
        &self,
        owner: &str,
        skill_names: &[String],
        dry_run: bool,
    ) -> Result<Vec<InstalledEntry>, InstallError> {
        self.remove_owner_with_lock(owner, skill_names, dry_run, None, None)
    }

    pub fn remove_owner_with_lock(
        &self,
        owner: &str,
        skill_names: &[String],
        dry_run: bool,
        expected_lock: Option<&LockFile>,
        new_lock: Option<&LockFile>,
    ) -> Result<Vec<InstalledEntry>, InstallError> {
        validate_owner(owner)?;
        let root = self.prepare_root()?;
        let _locks = self.acquire_state_locks(&root)?;
        recover_locked(&root, &self.journal_path, &self.lock_path)?;
        let lock_change = prepare_lock_change(&self.lock_path, expected_lock, new_lock)?;
        let journal = read_checked_journal(&self.journal_path, &root)?;

        let mut selected = Vec::new();
        if skill_names.is_empty() {
            for (index, entry) in journal.entries.iter().enumerate() {
                if entry.owners.iter().any(|candidate| candidate == owner) {
                    selected.push(index);
                }
            }
        } else {
            let mut names = BTreeSet::new();
            for skill_name in skill_names {
                validate_skill_name(skill_name)?;
                if !names.insert(skill_name.clone()) {
                    return Err(InstallError::DestinationConflict(root.join(skill_name)));
                }
                selected.push(
                    journal
                        .entries
                        .iter()
                        .position(|entry| entry.skill_name == *skill_name)
                        .ok_or_else(|| InstallError::NotInstalled(skill_name.clone()))?,
                );
            }
        }

        let mut new_journal = journal.clone();
        let mut operations = Vec::new();
        let mut results = Vec::with_capacity(selected.len());
        for index in selected {
            let entry = &journal.entries[index];
            validate_journal_entry_destination(entry, &root)?;
            let owner_present = entry.owners.iter().any(|candidate| candidate == owner);
            if !owner_present && !skill_names.is_empty() {
                return Err(InstallError::NotInstalled(entry.skill_name.clone()));
            }
            if owner_present {
                verify_journal_entry(entry)?;
            }
            let mut updated = entry.clone();
            updated.owners.retain(|candidate| candidate != owner);
            updated.owners = unique_sorted_owners(&updated.owners);
            if owner_present {
                new_journal.entries[index] = updated.clone();
                if updated.owners.is_empty() {
                    operations.push(TransactionOperation {
                        destination: PathBuf::from(&entry.destination),
                        stage: None,
                        backup: Some(allocate_backup_path(
                            &root,
                            &PathBuf::from(&entry.destination),
                        )?),
                        kind: TransactionOperationKind::Remove,
                        retain_backup: false,
                        bundle: None,
                    });
                } else {
                    operations.push(TransactionOperation {
                        destination: PathBuf::from(&entry.destination),
                        stage: None,
                        backup: None,
                        kind: TransactionOperationKind::Metadata,
                        retain_backup: false,
                        bundle: None,
                    });
                }
            }
            results.push(InstalledEntry::from(updated));
        }
        new_journal.entries.retain(|entry| !entry.owners.is_empty());
        if dry_run || (operations.is_empty() && lock_change.is_none()) {
            return Ok(results);
        }
        self.commit_transaction(&root, &journal, &mut new_journal, operations, lock_change)?;
        Ok(results)
    }

    pub fn remove(
        &self,
        skill_name: &str,
        owner: Option<&str>,
        dry_run: bool,
    ) -> Result<InstalledEntry, InstallError> {
        self.remove_owner(
            owner.unwrap_or("direct"),
            &[skill_name.to_string()],
            dry_run,
        )?
        .into_iter()
        .next()
        .ok_or_else(|| InstallError::NotInstalled(skill_name.into()))
    }

    pub fn verify(&self) -> Result<Vec<VerifyResult>, InstallError> {
        let root = self.prepare_root()?;
        let _locks = self.acquire_state_locks(&root)?;
        recover_locked(&root, &self.journal_path, &self.lock_path)?;
        let journal = read_verify_journal(&self.journal_path, &root)?;
        journal.entries.iter().map(verify_entry).collect()
    }

    fn prepare_root(&self) -> Result<PathBuf, InstallError> {
        canonical_root(&self.root)
    }

    fn prepare_root_for_plan(&self, root: &Path) -> Result<PathBuf, InstallError> {
        canonical_root(root)
    }

    fn acquire_state_locks(&self, root: &Path) -> Result<StateLocks, InstallError> {
        let lock_parent = self
            .lock_path
            .parent()
            .ok_or_else(|| InstallError::JournalInvariant("lock path has no parent".into()))?;
        let canonical_parent = canonical_root(lock_parent)?;
        let project = InstallationLock::acquire(&canonical_parent)?;
        let root_lock = if canonical_parent == root {
            None
        } else {
            Some(InstallationLock::acquire(root)?)
        };
        Ok(StateLocks {
            _project: project,
            _root: root_lock,
        })
    }

    fn commit_transaction(
        &self,
        root: &Path,
        old_journal: &JournalFileDocument,
        new_journal: &mut JournalFileDocument,
        mut operations: Vec<TransactionOperation>,
        lock_change: Option<LockChange>,
    ) -> Result<(), InstallError> {
        new_journal.version = 1;
        new_journal
            .entries
            .sort_by(|a, b| a.destination.cmp(&b.destination));
        for entry in &mut new_journal.entries {
            entry.owners = unique_sorted_owners(&entry.owners);
            entry.files.sort_by(|a, b| a.path.cmp(&b.path));
        }
        operations.sort_by(|a, b| a.destination.cmp(&b.destination));
        let stage_root = make_private_dir(root, ".pskills-stage")?;
        let mut staged = Vec::with_capacity(operations.len());
        for (index, mut operation) in operations.into_iter().enumerate() {
            if operation.kind == TransactionOperationKind::Replace {
                let bundle = operation.bundle.take().ok_or_else(|| {
                    InstallError::JournalInvariant("replace operation has no bundle".into())
                })?;
                let stage = stage_root.join(format!("member-{index}"));
                fs::create_dir(&stage).map_err(|source| InstallError::Write {
                    path: stage.clone(),
                    source,
                })?;
                if let Err(error) = extract_bundle(&stage, &bundle) {
                    let _ = fs::remove_dir_all(&stage_root);
                    return Err(error);
                }
                operation.stage = Some(stage);
            }
            staged.push(operation);
        }
        let transaction_path = root.join(".pskills-transaction.json");
        let lock_path = lock_change.as_ref().map(|change| change.path.clone());
        let old_lock = lock_change.as_ref().map(|change| change.old.clone());
        let new_lock = lock_change.as_ref().map(|change| change.new.clone());
        let record = TransactionRecord {
            version: 1,
            phase: TransactionPhase::Prepared,
            old_journal: old_journal.clone(),
            new_journal: new_journal.clone(),
            operations: staged.clone(),
            stage_root: stage_root.clone(),
            lock_path,
            old_lock,
            new_lock,
        };
        if let Err(error) = atomic_write_json(&transaction_path, &record) {
            let _ = fs::remove_dir_all(&stage_root);
            return Err(error);
        }

        if let Err(error) = activate_operations(&staged) {
            let rollback = rollback_transaction(&record);
            if let Err(rollback_error) = rollback {
                return Err(InstallError::Rollback {
                    path: root.to_path_buf(),
                    source: io::Error::other(rollback_error.to_string()),
                });
            }
            let _ = remove_transaction_marker(&transaction_path);
            return Err(error);
        }
        let activated = TransactionRecord {
            phase: TransactionPhase::Activated,
            ..record.clone()
        };
        atomic_write_json(&transaction_path, &activated)?;
        // The durable transaction record remains in Activated state if this
        // write fails. The next state open will roll the filesystem back.
        atomic_write_json(&self.journal_path, new_journal)?;
        if let Some(lock) = record.new_lock.as_ref() {
            atomic_write_json(
                record.lock_path.as_ref().ok_or_else(|| {
                    InstallError::JournalInvariant("lock transaction has no path".into())
                })?,
                lock,
            )?;
        }
        let committed = TransactionRecord {
            phase: TransactionPhase::JournalWritten,
            ..activated
        };
        atomic_write_json(&transaction_path, &committed)?;
        cleanup_transaction_artifacts(&committed, root)?;
        remove_transaction_marker(&transaction_path)?;
        Ok(())
    }
}

#[derive(Debug, Clone)]
struct PreparedInstall<'a> {
    plan: &'a InstallPlan,
    destination: PathBuf,
    entry: JournalEntry,
}

#[derive(Debug)]
struct StateLocks {
    _project: InstallationLock,
    _root: Option<InstallationLock>,
}

#[derive(Debug, Clone)]
struct LockChange {
    path: PathBuf,
    old: LockFile,
    new: LockFile,
}

fn prepare_lock_change(
    path: &Path,
    expected: Option<&LockFile>,
    new: Option<&LockFile>,
) -> Result<Option<LockChange>, InstallError> {
    if expected.is_none() && new.is_none() {
        return Ok(None);
    }
    let (Some(expected), Some(new)) = (expected, new) else {
        return Err(InstallError::JournalInvariant(
            "expected and new lock values must be supplied together".into(),
        ));
    };
    let current: LockFile = read_json_or_default(path)?;
    if &current != expected {
        return Err(InstallError::JournalInvariant(
            "lockfile changed while preparing installation".into(),
        ));
    }
    Ok(Some(LockChange {
        path: path.to_path_buf(),
        old: current,
        new: new.clone(),
    }))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct TransactionRecord {
    version: u8,
    phase: TransactionPhase,
    old_journal: JournalFileDocument,
    new_journal: JournalFileDocument,
    operations: Vec<TransactionOperation>,
    stage_root: PathBuf,
    #[serde(default)]
    lock_path: Option<PathBuf>,
    #[serde(default)]
    old_lock: Option<LockFile>,
    #[serde(default)]
    new_lock: Option<LockFile>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum TransactionPhase {
    Prepared,
    Activated,
    JournalWritten,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum TransactionOperationKind {
    Replace,
    Remove,
    Metadata,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct TransactionOperation {
    destination: PathBuf,
    stage: Option<PathBuf>,
    backup: Option<PathBuf>,
    kind: TransactionOperationKind,
    retain_backup: bool,
    #[serde(default)]
    bundle: Option<SkillBundle>,
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
        Self {
            key: entry.key.clone(),
            destination: PathBuf::from(&entry.destination),
            skill_name: entry.skill_name,
            digest: entry.digest,
            tree_digest: tree_from_key(&entry.key),
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
    let mut files = bundle
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
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(JournalEntry {
        key: format!("{skill_name}@{digest}|tree={tree}"),
        destination: destination.to_string_lossy().into_owned(),
        skill_name: skill_name.into(),
        digest: digest.into(),
        owners: vec![owner.into()],
        files,
    })
}

fn extract_bundle(stage: &Path, bundle: &SkillBundle) -> Result<(), InstallError> {
    fs::create_dir_all(stage).map_err(|source| InstallError::Write {
        path: stage.to_path_buf(),
        source,
    })?;
    reject_symlink_components(stage)?;
    for file in &bundle.files {
        validate_path(&file.path)?;
        let target = stage.join(&file.path);
        if let Some(parent) = target.parent() {
            reject_symlink_components(parent)?;
            fs::create_dir_all(parent).map_err(|source| InstallError::Write {
                path: parent.to_path_buf(),
                source,
            })?;
        }
        if fs::symlink_metadata(&target).is_ok() {
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

fn activate_operations(operations: &[TransactionOperation]) -> Result<(), InstallError> {
    for operation in operations {
        if operation.kind == TransactionOperationKind::Metadata {
            continue;
        }
        reject_symlink_or_file(&operation.destination)?;
        if let Some(backup) = &operation.backup {
            if fs::symlink_metadata(&operation.destination).is_ok() {
                fs::rename(&operation.destination, backup).map_err(|source| {
                    InstallError::Replace {
                        path: operation.destination.clone(),
                        source,
                    }
                })?;
            }
        } else if operation.kind == TransactionOperationKind::Remove {
            return Err(InstallError::Replace {
                path: operation.destination.clone(),
                source: io::Error::other("remove operation has no backup"),
            });
        }
        if operation.kind == TransactionOperationKind::Replace {
            let stage = operation.stage.as_ref().ok_or_else(|| {
                InstallError::JournalInvariant("replace operation has no stage".into())
            })?;
            fs::rename(stage, &operation.destination).map_err(|source| InstallError::Replace {
                path: operation.destination.clone(),
                source,
            })?;
        }
    }
    Ok(())
}

fn verify_entry(entry: &JournalEntry) -> Result<VerifyResult, InstallError> {
    let destination = PathBuf::from(&entry.destination);
    let expected = tree_from_key(&entry.key);
    let actual = tree_from_directory(&destination).ok();
    let result = verify_journal_entry(entry);
    Ok(VerifyResult {
        key: entry.key.clone(),
        destination,
        ok: result.is_ok(),
        expected_tree_digest: expected,
        actual_tree_digest: actual,
        error: result.err().map(|error| error.to_string()),
    })
}

fn verify_journal_entry(entry: &JournalEntry) -> Result<(), InstallError> {
    let destination = PathBuf::from(&entry.destination);
    reject_symlink_or_file(&destination)?;
    if !destination.exists() {
        return Err(InstallError::NotInstalled(entry.skill_name.clone()));
    }
    let expected = tree_from_key(&entry.key);
    if expected.is_empty() {
        return Err(InstallError::MissingTreeDigest(destination));
    }
    let actual = tree_from_directory(&destination)?;
    if actual != expected {
        return Err(InstallError::TreeMismatch {
            destination,
            expected,
            actual,
        });
    }
    let actual_files = file_manifest(&destination)?;
    let mut expected_files = entry.files.clone();
    expected_files.sort_by(|a, b| a.path.cmp(&b.path));
    if actual_files != expected_files {
        return Err(InstallError::LocalEdits {
            destination,
            details: "journal file manifest does not match installed tree".into(),
        });
    }
    Ok(())
}

fn file_manifest(destination: &Path) -> Result<Vec<JournalFile>, InstallError> {
    let mut files = Vec::new();
    for (relative, path) in walk_files(destination)? {
        let bytes = fs::read(&path).map_err(|source| InstallError::Read {
            path: path.clone(),
            source,
        })?;
        files.push(JournalFile {
            path: relative,
            digest: digest_bytes(&bytes),
            size: bytes.len() as u64,
        });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

fn tree_from_directory(destination: &Path) -> Result<String, InstallError> {
    let mut files = Vec::new();
    for (relative, path) in walk_files(destination)? {
        let bytes = fs::read(&path).map_err(|source| InstallError::Read {
            path: path.clone(),
            source,
        })?;
        files.push((relative, bytes));
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    let mut hasher = sha2::Sha256::new();
    for (path, bytes) in files {
        hasher.update(path.as_bytes());
        hasher.update([0]);
        hasher.update(bytes);
        hasher.update([0]);
    }
    Ok(format!("sha256:{}", hex_digest(&hasher.finalize())))
}

fn walk_files(destination: &Path) -> Result<Vec<(String, PathBuf)>, InstallError> {
    reject_symlink_or_file(destination)?;
    if !destination.exists() {
        return Err(InstallError::NotInstalled(
            destination.to_string_lossy().into_owned(),
        ));
    }
    let mut files = Vec::new();
    for item in walkdir::WalkDir::new(destination)
        .follow_links(false)
        .sort_by_file_name()
    {
        let item = item.map_err(|error| InstallError::Read {
            path: error.path().unwrap_or(destination).to_path_buf(),
            source: io::Error::other(error.to_string()),
        })?;
        if item.path() == destination {
            continue;
        }
        if item.file_type().is_symlink() {
            return Err(InstallError::Symlink(item.path().to_path_buf()));
        }
        if !item.file_type().is_file() {
            continue;
        }
        let relative = item
            .path()
            .strip_prefix(destination)
            .map_err(|_| InstallError::Read {
                path: item.path().to_path_buf(),
                source: io::Error::other("path escaped destination"),
            })?
            .to_str()
            .ok_or_else(|| InstallError::Read {
                path: item.path().to_path_buf(),
                source: io::Error::other("non-UTF-8 path"),
            })?
            .replace('\\', "/");
        validate_path(&relative)?;
        files.push((relative, item.path().to_path_buf()));
    }
    Ok(files)
}

fn tree_from_key(key: &str) -> String {
    key.split_once("|tree=")
        .map(|(_, tree)| tree.to_string())
        .unwrap_or_default()
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

fn validate_owner(owner: &str) -> Result<(), InstallError> {
    if owner.is_empty() || owner.contains('\0') {
        Err(InstallError::EmptyOwner)
    } else {
        Ok(())
    }
}

fn unique_sorted_owners(owners: &[String]) -> Vec<String> {
    owners
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
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
    let mut current = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => current.push(prefix.as_os_str()),
            Component::RootDir => current.push(Path::new(std::path::MAIN_SEPARATOR_STR)),
            Component::CurDir => {}
            Component::ParentDir => current.push(".."),
            Component::Normal(part) => current.push(part),
        }
        if let Ok(metadata) = fs::symlink_metadata(&current) {
            if metadata.file_type().is_symlink() && !is_platform_path_alias(&current) {
                return Err(InstallError::Symlink(current));
            }
        }
    }
    Ok(())
}

fn is_platform_path_alias(path: &Path) -> bool {
    #[cfg(target_os = "macos")]
    {
        // macOS exposes these compatibility aliases by default. The selected
        // installation root is canonicalized immediately after this walk;
        // user-created symlink ancestors remain rejected.
        matches!(
            path,
            p if p == Path::new("/var")
                || p == Path::new("/tmp")
                || p == Path::new("/etc")
                || p == Path::new("/private")
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        false
    }
}

fn canonical_root(root: &Path) -> Result<PathBuf, InstallError> {
    let absolute = if root.is_absolute() {
        root.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|source| InstallError::Read {
                path: root.to_path_buf(),
                source,
            })?
            .join(root)
    };
    reject_symlink_components(&absolute)?;
    if !absolute.exists() {
        fs::create_dir_all(&absolute).map_err(|source| InstallError::Write {
            path: absolute.clone(),
            source,
        })?;
    }
    reject_symlink_components(&absolute)?;
    let metadata = fs::symlink_metadata(&absolute).map_err(|source| InstallError::Read {
        path: absolute.clone(),
        source,
    })?;
    if metadata.file_type().is_symlink() {
        return Err(InstallError::Symlink(absolute));
    }
    if !metadata.is_dir() {
        return Err(InstallError::NotDirectory(absolute));
    }
    fs::canonicalize(&absolute).map_err(|source| InstallError::Read {
        path: absolute,
        source,
    })
}

fn validate_journal_entry_destination(
    entry: &JournalEntry,
    root: &Path,
) -> Result<(), InstallError> {
    validate_skill_name(&entry.skill_name)?;
    let destination = PathBuf::from(&entry.destination);
    if !destination.is_absolute() || destination.parent() != Some(root) {
        return Err(InstallError::JournalInvariant(format!(
            "journal destination `{}` is outside the installation root",
            destination.display()
        )));
    }
    if destination.file_name().and_then(|name| name.to_str()) != Some(entry.skill_name.as_str()) {
        return Err(InstallError::JournalInvariant(format!(
            "journal skill `{}` does not match destination `{}`",
            entry.skill_name,
            destination.display()
        )));
    }
    reject_symlink_or_file(&destination)
}

fn validate_journal_shape(journal: &JournalFileDocument, root: &Path) -> Result<(), InstallError> {
    validate_journal_shape_with_tree(journal, root, true)
}

fn validate_journal_shape_with_tree(
    journal: &JournalFileDocument,
    root: &Path,
    require_tree: bool,
) -> Result<(), InstallError> {
    let mut destinations = BTreeSet::new();
    let mut names = BTreeSet::new();
    for entry in &journal.entries {
        validate_journal_entry_destination(entry, root)?;
        if !destinations.insert(entry.destination.clone()) {
            return Err(InstallError::JournalInvariant(format!(
                "duplicate journal destination `{}`",
                entry.destination
            )));
        }
        if !names.insert(entry.skill_name.clone()) {
            return Err(InstallError::JournalInvariant(format!(
                "duplicate journal skill `{}`",
                entry.skill_name
            )));
        }
        validate_owner_list(&entry.owners)?;
        if require_tree && tree_from_key(&entry.key).is_empty() {
            return Err(InstallError::MissingTreeDigest(PathBuf::from(
                &entry.destination,
            )));
        }
    }
    Ok(())
}

fn validate_owner_list(owners: &[String]) -> Result<(), InstallError> {
    if owners.is_empty() {
        return Err(InstallError::JournalInvariant(
            "journal entry has no owners".into(),
        ));
    }
    for owner in owners {
        validate_owner(owner)?;
    }
    Ok(())
}

fn make_private_dir(root: &Path, prefix: &str) -> Result<PathBuf, InstallError> {
    for _ in 0..100 {
        let path = root.join(format!("{}-{}", prefix, unique_suffix()));
        match fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(source) if source.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(source) => return Err(InstallError::Write { path, source }),
        }
    }
    Err(InstallError::Write {
        path: root.to_path_buf(),
        source: io::Error::new(
            io::ErrorKind::AlreadyExists,
            "could not allocate private directory",
        ),
    })
}

fn allocate_backup_path(root: &Path, destination: &Path) -> Result<PathBuf, InstallError> {
    let name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| InstallError::JournalInvariant("non-UTF-8 destination".into()))?;
    for _ in 0..100 {
        let path = root.join(format!(".pskills-backup-{name}-{}", unique_suffix()));
        if fs::symlink_metadata(&path).is_err() {
            return Ok(path);
        }
    }
    Err(InstallError::Write {
        path: root.to_path_buf(),
        source: io::Error::new(
            io::ErrorKind::AlreadyExists,
            "could not allocate backup path",
        ),
    })
}

fn unique_suffix() -> String {
    let counter = UNIQUE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{}-{}-{}", std::process::id(), nanos, counter)
}

fn read_json_or_default<T>(path: &Path) -> Result<T, InstallError>
where
    T: serde::de::DeserializeOwned + Default,
{
    reject_state_symlink(path)?;
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(InstallError::Journal),
        Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(T::default()),
        Err(source) => Err(InstallError::Read {
            path: path.to_path_buf(),
            source,
        }),
    }
}

fn read_checked_journal(path: &Path, root: &Path) -> Result<JournalFileDocument, InstallError> {
    let mut journal: JournalFileDocument = read_json_or_default(path)?;
    journal.version = 1;
    validate_journal_shape(&journal, root)?;
    Ok(journal)
}

fn read_verify_journal(path: &Path, root: &Path) -> Result<JournalFileDocument, InstallError> {
    let mut journal: JournalFileDocument = read_json_or_default(path)?;
    journal.version = 1;
    validate_journal_shape_with_tree(&journal, root, false)?;
    Ok(journal)
}

fn reject_state_symlink(path: &Path) -> Result<(), InstallError> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() {
            return Err(InstallError::Symlink(path.to_path_buf()));
        }
    }
    Ok(())
}

fn atomic_write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), InstallError> {
    reject_state_symlink(path)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|source| InstallError::Write {
            path: parent.to_path_buf(),
            source,
        })?;
        reject_symlink_components(parent)?;
    }
    let bytes = serde_json::to_vec_pretty(value).map_err(InstallError::Journal)?;
    let temp = path.with_file_name(format!(
        ".{}.tmp-{}",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("pskills"),
        unique_suffix()
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|source| InstallError::Write {
            path: temp.clone(),
            source,
        })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|source| InstallError::Write {
                path: temp.clone(),
                source,
            })?;
    }
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
    })?;
    if let Some(parent) = path.parent() {
        sync_directory(parent).map_err(|source| InstallError::Write {
            path: parent.to_path_buf(),
            source,
        })?;
    }
    Ok(())
}

fn sync_directory(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        File::open(path)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

#[derive(Debug)]
struct InstallationLock {
    file: File,
}

impl InstallationLock {
    fn acquire(root: &Path) -> Result<Self, InstallError> {
        fs::create_dir_all(root).map_err(|source| InstallError::Lock {
            path: root.to_path_buf(),
            source,
        })?;
        reject_symlink_components(root)?;
        let path = root.join(".pskills-install.lock");
        reject_state_symlink(&path)?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(|source| InstallError::Lock {
                path: path.clone(),
                source,
            })?;
        try_lock_file(&file).map_err(|source| InstallError::Lock { path, source })?;
        Ok(Self { file })
    }
}

impl Drop for InstallationLock {
    fn drop(&mut self) {
        unlock_file(&self.file);
    }
}

#[cfg(unix)]
fn try_lock_file(file: &File) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    const LOCK_EX: i32 = 2;
    const LOCK_NB: i32 = 4;
    unsafe extern "C" {
        fn flock(fd: i32, operation: i32) -> i32;
    }
    if unsafe { flock(file.as_raw_fd(), LOCK_EX | LOCK_NB) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(unix)]
fn unlock_file(file: &File) {
    use std::os::fd::AsRawFd;
    const LOCK_UN: i32 = 8;
    unsafe extern "C" {
        fn flock(fd: i32, operation: i32) -> i32;
    }
    let _ = unsafe { flock(file.as_raw_fd(), LOCK_UN) };
}

#[cfg(windows)]
fn try_lock_file(file: &File) -> io::Result<()> {
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;
    #[repr(C)]
    struct Overlapped {
        internal: usize,
        internal_high: usize,
        offset: u32,
        offset_high: u32,
        event: *mut c_void,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn LockFileEx(
            handle: *mut c_void,
            flags: u32,
            reserved: u32,
            bytes_low: u32,
            bytes_high: u32,
            overlapped: *mut Overlapped,
        ) -> i32;
    }
    let mut overlapped = Overlapped {
        internal: 0,
        internal_high: 0,
        offset: 0,
        offset_high: 0,
        event: std::ptr::null_mut(),
    };
    let result = unsafe { LockFileEx(file.as_raw_handle(), 3, 0, 1, 0, &mut overlapped) };
    if result != 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn unlock_file(file: &File) {
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;
    #[repr(C)]
    struct Overlapped {
        internal: usize,
        internal_high: usize,
        offset: u32,
        offset_high: u32,
        event: *mut c_void,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn UnlockFileEx(
            handle: *mut c_void,
            reserved: u32,
            bytes_low: u32,
            bytes_high: u32,
            overlapped: *mut Overlapped,
        ) -> i32;
    }
    let mut overlapped = Overlapped {
        internal: 0,
        internal_high: 0,
        offset: 0,
        offset_high: 0,
        event: std::ptr::null_mut(),
    };
    unsafe {
        let _ = UnlockFileEx(file.as_raw_handle(), 0, 1, 0, &mut overlapped);
    }
}

#[cfg(not(any(unix, windows)))]
fn try_lock_file(_file: &File) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "native installation locks are unsupported on this platform",
    ))
}

#[cfg(not(any(unix, windows)))]
fn unlock_file(_file: &File) {}

fn recover_locked(root: &Path, journal_path: &Path, lock_path: &Path) -> Result<(), InstallError> {
    let transaction_path = root.join(".pskills-transaction.json");
    reject_state_symlink(&transaction_path)?;
    let record = match fs::read(&transaction_path) {
        Ok(bytes) => serde_json::from_slice::<TransactionRecord>(&bytes)?,
        Err(source) if source.kind() == io::ErrorKind::NotFound => {
            cleanup_orphan_stages(root)?;
            return Ok(());
        }
        Err(source) => {
            return Err(InstallError::Read {
                path: transaction_path,
                source,
            })
        }
    };
    validate_transaction_record(&record, root, lock_path)?;
    let mut current = read_json_or_default::<JournalFileDocument>(journal_path)?;
    // An absent/legacy journal deserializes with version zero; the in-memory
    // transaction representation normalizes it to the current schema.
    current.version = 1;
    let journal_is_new = current == record.new_journal;
    let journal_is_old = current == record.old_journal;
    let lock_is_new = record
        .new_lock
        .as_ref()
        .map(|lock| read_lock_value(lock_path).map(|current| current == *lock))
        .transpose()?
        .unwrap_or(true);
    let lock_is_old = record
        .old_lock
        .as_ref()
        .map(|lock| read_lock_value(lock_path).map(|current| current == *lock))
        .transpose()?
        .unwrap_or(true);
    if journal_is_new && lock_is_new {
        validate_journal_shape(&record.new_journal, root)?;
        verify_new_destinations(&record.new_journal)?;
        cleanup_transaction_artifacts(&record, root)?;
        remove_transaction_marker(&transaction_path)?;
        return Ok(());
    }
    if !journal_is_old && !journal_is_new {
        return Err(InstallError::RecoveryConflict(
            "journal is neither the transaction's old nor new state".into(),
        ));
    }
    if !lock_is_old && !lock_is_new {
        return Err(InstallError::RecoveryConflict(
            "lockfile is neither the transaction's old nor new state".into(),
        ));
    }
    rollback_transaction(&record)?;
    atomic_write_json(journal_path, &record.old_journal)?;
    if let Some(lock) = record.old_lock.as_ref() {
        atomic_write_json(lock_path, lock)?;
    }
    remove_transaction_marker(&transaction_path)?;
    Ok(())
}

fn read_lock_value(path: &Path) -> Result<LockFile, InstallError> {
    read_json_or_default(path)
}

fn validate_transaction_record(
    record: &TransactionRecord,
    root: &Path,
    lock_path: &Path,
) -> Result<(), InstallError> {
    if record.version != 1 {
        return Err(InstallError::JournalInvariant(format!(
            "unsupported transaction version {}",
            record.version
        )));
    }
    if record.old_lock.is_some() != record.new_lock.is_some() {
        return Err(InstallError::RecoveryConflict(
            "transaction has only one lockfile state".into(),
        ));
    }
    if let Some(record_lock_path) = record.lock_path.as_ref() {
        if record_lock_path != lock_path {
            return Err(InstallError::RecoveryConflict(
                "transaction lockfile path does not match local state".into(),
            ));
        }
    } else if record.old_lock.is_some() {
        return Err(InstallError::RecoveryConflict(
            "transaction lockfile state has no lockfile path".into(),
        ));
    }
    if record.stage_root.parent() != Some(root)
        || !record
            .stage_root
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.starts_with(".pskills-stage-"))
            .unwrap_or(false)
    {
        return Err(InstallError::RecoveryConflict(
            "transaction stage is outside the installation root".into(),
        ));
    }
    validate_journal_shape(&record.old_journal, root)?;
    validate_journal_shape(&record.new_journal, root)?;
    for operation in &record.operations {
        if operation.destination.parent() != Some(root) {
            return Err(InstallError::RecoveryConflict(format!(
                "transaction destination `{}` is outside the installation root",
                operation.destination.display()
            )));
        }
        let present_in_old = record
            .old_journal
            .entries
            .iter()
            .any(|entry| entry.destination == operation.destination.to_string_lossy());
        let present_in_new = record
            .new_journal
            .entries
            .iter()
            .any(|entry| entry.destination == operation.destination.to_string_lossy());
        if !present_in_old && !present_in_new {
            return Err(InstallError::RecoveryConflict(format!(
                "transaction destination `{}` is not journaled",
                operation.destination.display()
            )));
        }
        if let Some(path) = operation.stage.as_ref() {
            let private_name = path.file_name().and_then(|name| name.to_str());
            if path.parent() != Some(&record.stage_root)
                || !private_name
                    .map(|name| name.starts_with("member-"))
                    .unwrap_or(false)
            {
                return Err(InstallError::RecoveryConflict(format!(
                    "transaction stage `{}` is outside private state",
                    path.display()
                )));
            }
        }
        if let Some(path) = operation.backup.as_ref() {
            let private_name = path.file_name().and_then(|name| name.to_str());
            if path.parent() != Some(root)
                || !private_name
                    .map(|name| name.starts_with(".pskills-backup-"))
                    .unwrap_or(false)
            {
                return Err(InstallError::RecoveryConflict(format!(
                    "transaction backup `{}` is outside private state",
                    path.display()
                )));
            }
        }
    }
    Ok(())
}

fn rollback_transaction(record: &TransactionRecord) -> Result<(), InstallError> {
    for operation in record.operations.iter().rev() {
        let destination = &operation.destination;
        if operation.kind == TransactionOperationKind::Metadata {
            continue;
        }
        if let Some(backup) = &operation.backup {
            if backup.exists() {
                if destination.exists() {
                    if !destination_matches_journal(destination, &record.new_journal)? {
                        return Err(InstallError::RecoveryConflict(format!(
                            "destination `{}` changed after interrupted activation",
                            destination.display()
                        )));
                    }
                    fs::remove_dir_all(destination).map_err(|source| InstallError::Rollback {
                        path: destination.clone(),
                        source,
                    })?;
                }
                fs::rename(backup, destination).map_err(|source| InstallError::Rollback {
                    path: destination.clone(),
                    source,
                })?;
            }
        } else if operation.kind == TransactionOperationKind::Replace
            && destination.exists()
            && destination_matches_journal(destination, &record.new_journal)?
        {
            fs::remove_dir_all(destination).map_err(|source| InstallError::Rollback {
                path: destination.clone(),
                source,
            })?;
        }
    }
    if record.stage_root.exists() {
        fs::remove_dir_all(&record.stage_root).map_err(|source| InstallError::Rollback {
            path: record.stage_root.clone(),
            source,
        })?;
    }
    Ok(())
}

fn destination_matches_journal(
    destination: &Path,
    journal: &JournalFileDocument,
) -> Result<bool, InstallError> {
    let Some(entry) = journal
        .entries
        .iter()
        .find(|entry| entry.destination == destination.to_string_lossy())
    else {
        return Ok(false);
    };
    match verify_journal_entry(entry) {
        Ok(()) => Ok(true),
        Err(InstallError::TreeMismatch { .. }) | Err(InstallError::LocalEdits { .. }) => Ok(false),
        Err(error) => Err(error),
    }
}

fn verify_new_destinations(journal: &JournalFileDocument) -> Result<(), InstallError> {
    for entry in &journal.entries {
        verify_journal_entry(entry)?;
    }
    Ok(())
}

fn cleanup_transaction_artifacts(
    record: &TransactionRecord,
    root: &Path,
) -> Result<(), InstallError> {
    if record.stage_root.exists() {
        fs::remove_dir_all(&record.stage_root).map_err(|source| InstallError::Write {
            path: record.stage_root.clone(),
            source,
        })?;
    }
    for operation in &record.operations {
        if !operation.retain_backup {
            if let Some(backup) = &operation.backup {
                if backup.exists() {
                    fs::remove_dir_all(backup).map_err(|source| InstallError::Write {
                        path: backup.clone(),
                        source,
                    })?;
                }
            }
        }
    }
    sync_directory(root).map_err(|source| InstallError::Write {
        path: root.to_path_buf(),
        source,
    })
}

fn remove_transaction_marker(path: &Path) -> Result<(), InstallError> {
    match fs::remove_file(path) {
        Ok(()) => {
            if let Some(parent) = path.parent() {
                sync_directory(parent).map_err(|source| InstallError::Write {
                    path: parent.to_path_buf(),
                    source,
                })?;
            }
            Ok(())
        }
        Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(InstallError::Write {
            path: path.to_path_buf(),
            source,
        }),
    }
}

fn cleanup_orphan_stages(root: &Path) -> Result<(), InstallError> {
    for item in fs::read_dir(root).map_err(|source| InstallError::Read {
        path: root.to_path_buf(),
        source,
    })? {
        let item = item.map_err(|source| InstallError::Read {
            path: root.to_path_buf(),
            source,
        })?;
        let path = item.path();
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        if !name.starts_with(".pskills-stage-") {
            continue;
        }
        let metadata = fs::symlink_metadata(&path).map_err(|source| InstallError::Read {
            path: path.clone(),
            source,
        })?;
        if metadata.file_type().is_symlink() {
            return Err(InstallError::Symlink(path));
        }
        fs::remove_dir_all(&path).map_err(|source| InstallError::Write { path, source })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bundle::{bundle_digest, BUNDLE_FORMAT};
    use crate::model::BundleFile;
    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine;

    fn fixture_bundle(contents: &[u8]) -> SkillBundle {
        SkillBundle {
            format: BUNDLE_FORMAT.into(),
            files: vec![BundleFile {
                path: "SKILL.md".into(),
                content: BASE64.encode(contents),
                executable: None,
            }],
        }
    }

    fn temp_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!("pskills-install-test-{}", unique_suffix()));
        fs::create_dir_all(&root).expect("temp root");
        root
    }

    fn plan(root: &Path, name: &str, contents: &[u8], owner: &str) -> InstallPlan {
        let bundle = fixture_bundle(contents);
        let digest = bundle_digest(&bundle).expect("digest");
        InstallPlan {
            root: root.to_path_buf(),
            skill_name: name.into(),
            bundle,
            artifact_digest: digest,
            owner: owner.into(),
            dry_run: false,
        }
    }

    #[test]
    fn installs_and_computes_tree_from_disk() {
        let root = temp_root();
        let state = LocalState::for_global(root.clone());
        state
            .install(&plan(
                &root,
                "demo",
                b"---\nname: demo\ndescription: test\n---\n",
                "direct:demo",
            ))
            .expect("install");
        assert!(state.verify().expect("verify")[0].ok);
        fs::write(root.join("demo/SKILL.md"), b"local edit\n").expect("edit");
        assert!(!state.verify().expect("verify after edit")[0].ok);
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn batch_preflight_rejects_duplicate_destinations_without_mutating() {
        let root = temp_root();
        let state = LocalState::for_global(root.clone());
        let first = plan(
            &root,
            "demo",
            b"---\nname: demo\ndescription: a\n---\n",
            "pack:x",
        );
        let second = plan(
            &root,
            "demo",
            b"---\nname: demo\ndescription: b\n---\n",
            "pack:x",
        );
        let error = state.install_many(&[first, second]).expect_err("duplicate");
        assert!(matches!(error, InstallError::DestinationConflict(_)));
        assert!(!root.join("demo").exists());
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn shared_owner_removal_preserves_remaining_installation() {
        let root = temp_root();
        let state = LocalState::for_global(root.clone());
        let first = plan(
            &root,
            "demo",
            b"---\nname: demo\ndescription: a\n---\n",
            "pack:a",
        );
        state.install(&first).expect("first");
        let second = plan(
            &root,
            "demo",
            b"---\nname: demo\ndescription: a\n---\n",
            "pack:b",
        );
        state.install(&second).expect("second owner");
        let removed = state
            .remove_owner("pack:a", &["demo".into()], false)
            .expect("remove owner");
        assert_eq!(removed[0].owners, vec!["pack:b"]);
        assert!(root.join("demo/SKILL.md").exists());
        state
            .remove_owner("pack:b", &["demo".into()], false)
            .expect("remove final owner");
        assert!(!root.join("demo").exists());
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn direct_update_replaces_single_clean_owner() {
        let root = temp_root();
        let state = LocalState::for_global(root.clone());
        state
            .install(&plan(
                &root,
                "demo",
                b"---\nname: demo\ndescription: a\n---\n",
                "direct:demo",
            ))
            .expect("first");
        state
            .install(&plan(
                &root,
                "demo",
                b"---\nname: demo\ndescription: b\n---\n",
                "direct:demo",
            ))
            .expect("update");
        assert!(state.verify().expect("verify")[0].ok);
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn native_lock_is_held_until_drop() {
        let root = temp_root();
        let first = InstallationLock::acquire(&root).expect("first lock");
        let second = InstallationLock::acquire(&root).expect_err("second lock");
        assert!(matches!(second, InstallError::Lock { .. }));
        drop(first);
        let _third = InstallationLock::acquire(&root).expect("lock after drop");
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn recovery_rolls_back_an_activated_replacement_with_old_journal() {
        let root = temp_root();
        let state = LocalState::for_global(root.clone());
        let old_plan = plan(
            &root,
            "recover",
            b"---\nname: recover\ndescription: old\n---\n",
            "direct:recover",
        );
        state.install(&old_plan).expect("initial install");
        let old_journal = state.read_journal().expect("old journal");
        let new_plan = plan(
            &root,
            "recover",
            b"---\nname: recover\ndescription: new\n---\n",
            "direct:recover",
        );
        let canonical = state.prepare_root().expect("canonical root");
        let destination = canonical.join("recover");
        let stage_root = make_private_dir(&canonical, ".pskills-stage").expect("stage root");
        let stage = stage_root.join("member-0");
        fs::create_dir(&stage).expect("stage member");
        extract_bundle(&stage, &new_plan.bundle).expect("stage bytes");
        let backup = allocate_backup_path(&canonical, &destination).expect("backup");
        fs::rename(&destination, &backup).expect("move old bytes");
        fs::rename(&stage, &destination).expect("activate new bytes");
        let new_entry = build_journal_entry(
            &destination,
            "recover",
            &new_plan.artifact_digest,
            "direct:recover",
            &new_plan.bundle,
        )
        .expect("new journal entry");
        let record = TransactionRecord {
            version: 1,
            phase: TransactionPhase::Activated,
            old_journal: old_journal.clone(),
            new_journal: JournalFileDocument {
                version: 1,
                entries: vec![new_entry],
            },
            operations: vec![TransactionOperation {
                destination: destination.clone(),
                stage: Some(stage),
                backup: Some(backup),
                kind: TransactionOperationKind::Replace,
                retain_backup: true,
                bundle: None,
            }],
            stage_root,
            lock_path: None,
            old_lock: None,
            new_lock: None,
        };
        atomic_write_json(&canonical.join(".pskills-transaction.json"), &record)
            .expect("transaction marker");

        state.recover().expect("recovery");
        assert_eq!(
            fs::read_to_string(destination.join("SKILL.md")).expect("restored bytes"),
            "---\nname: recover\ndescription: old\n---\n"
        );
        assert_eq!(
            state.read_journal().expect("journal after recovery"),
            old_journal
        );
        assert!(!root.join(".pskills-transaction.json").exists());
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn lock_inclusive_install_commits_journal_and_lock_together() {
        let root = temp_root();
        let state = LocalState::for_global(root.clone());
        let old_lock = state.read_lock().expect("old lock");
        let mut new_lock = old_lock.clone();
        new_lock.targets.push(crate::model::LockTarget {
            agent: "codex".into(),
            adapter_version: "1".into(),
            scope: "global".into(),
        });
        state
            .install_many_with_lock(
                &[plan(
                    &root,
                    "locked",
                    b"---\nname: locked\ndescription: lock\n---\n",
                    "direct:locked",
                )],
                Some(&old_lock),
                Some(&new_lock),
            )
            .expect("lock-inclusive install");
        assert_eq!(state.read_lock().expect("new lock"), new_lock);
        assert!(root.join("locked/SKILL.md").exists());
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn stale_expected_lock_fails_before_activation() {
        let root = temp_root();
        let state = LocalState::for_global(root.clone());
        let expected = state.read_lock().expect("old lock");
        let mut current = expected.clone();
        current.targets.push(crate::model::LockTarget {
            agent: "claude".into(),
            adapter_version: "1".into(),
            scope: "global".into(),
        });
        state.write_lock(&current).expect("external lock update");
        let error = state
            .install_many_with_lock(
                &[plan(
                    &root,
                    "stale",
                    b"---\nname: stale\ndescription: stale\n---\n",
                    "direct:stale",
                )],
                Some(&expected),
                Some(&current),
            )
            .expect_err("stale expected lock");
        assert!(matches!(error, InstallError::JournalInvariant(_)));
        assert!(!root.join("stale").exists());
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn lock_inclusive_install_commits_lock_changes_without_file_changes() {
        let root = temp_root();
        let state = LocalState::for_global(root.clone());
        let install = plan(
            &root,
            "same",
            b"---\nname: same\ndescription: same\n---\n",
            "direct:same",
        );
        state.install(&install).expect("initial install");
        let old_lock = state.read_lock().expect("old lock");
        let mut new_lock = old_lock.clone();
        new_lock.targets.push(crate::model::LockTarget {
            agent: "universal".into(),
            adapter_version: "1".into(),
            scope: "project".into(),
        });
        let result = state
            .install_many_with_lock(&[install], Some(&old_lock), Some(&new_lock))
            .expect("metadata-only transaction");
        assert!(!result[0].changed);
        assert_eq!(state.read_lock().expect("new lock"), new_lock);
        fs::remove_dir_all(root).expect("cleanup");
    }
}
