//! Public-API installation safety checks.
//!
//! These tests deliberately use the same `LocalState`/`InstallPlan` surface
//! consumed by the CLI.  They do not reach into the installer implementation
//! or use private helpers, so a change in staging or journaling cannot make a
//! safety property look tested while bypassing the public path.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use pskills_core::bundle::{bundle_digest, BUNDLE_FORMAT};
use pskills_core::install::InstallError;
use pskills_core::model::{BundleFile, SkillBundle};
use pskills_core::{InstallPlan, LocalState};
use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

struct TempRoot(PathBuf);

impl TempRoot {
    fn new(label: &str) -> Self {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "pskills-install-safety-{label}-{}-{suffix}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("create temporary install root");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn bundle(body: &str) -> SkillBundle {
    SkillBundle {
        format: BUNDLE_FORMAT.into(),
        files: vec![BundleFile {
            path: "SKILL.md".into(),
            content: BASE64.encode(format!(
                "---\nname: shared\ndescription: install safety fixture\n---\n{body}\n"
            )),
            executable: None,
        }],
    }
}

fn install_plan(root: &Path, skill_name: &str, bundle: SkillBundle, owner: &str) -> InstallPlan {
    let digest = bundle_digest(&bundle).expect("fixture bundle digest");
    InstallPlan {
        root: root.to_path_buf(),
        skill_name: skill_name.into(),
        bundle,
        artifact_digest: digest,
        owner: owner.into(),
        dry_run: false,
    }
}

fn leftovers_with_prefix(root: &Path, prefix: &str) -> usize {
    fs::read_dir(root)
        .expect("root reads")
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().starts_with(prefix))
        .count()
}

#[test]
fn conflicting_resources_cannot_replace_a_shared_destination() {
    let temp = TempRoot::new("collision");
    let state = LocalState::for_global(temp.path().to_path_buf());

    let first = install_plan(
        temp.path(),
        "shared",
        bundle("first resource"),
        "pack:registry-a:@team/first@1.0.0",
    );
    let first_digest = first.artifact_digest.clone();
    state.install(&first).expect("first resource installs");

    let second = install_plan(
        temp.path(),
        "shared",
        bundle("second resource"),
        "pack:registry-b:@other/second@1.0.0",
    );
    let error = state
        .install(&second)
        .expect_err("a distinct resource must not replace the destination");
    assert!(matches!(error, InstallError::DestinationConflict(_)));
    assert_eq!(
        state.entries().expect("journal reads")[0].digest,
        first_digest
    );
    assert_eq!(
        fs::read_to_string(temp.path().join("shared/SKILL.md")).expect("active bytes"),
        "---\nname: shared\ndescription: install safety fixture\n---\nfirst resource\n"
    );
    assert!(!temp.path().join(".pskills-stage").exists());
}

#[test]
fn shared_owners_are_removed_independently_and_last_owner_removes_bytes() {
    let temp = TempRoot::new("owners");
    let state = LocalState::for_global(temp.path().to_path_buf());
    let fixture = bundle("shared bytes");

    state
        .install(&install_plan(
            temp.path(),
            "shared",
            fixture.clone(),
            "direct:@team/shared@1.0.0",
        ))
        .expect("direct owner installs");
    state
        .install(&install_plan(
            temp.path(),
            "shared",
            fixture,
            "pack:registry:@team/pack@1.0.0",
        ))
        .expect("pack owner joins existing bytes");

    state
        .remove("shared", Some("direct:@team/shared@1.0.0"), false)
        .expect("direct owner removes");
    let entries = state.entries().expect("journal after first removal");
    assert_eq!(entries.len(), 1);
    assert_eq!(
        entries[0].owners,
        vec!["pack:registry:@team/pack@1.0.0".to_string()]
    );
    assert!(temp.path().join("shared/SKILL.md").exists());

    state
        .remove("shared", Some("pack:registry:@team/pack@1.0.0"), false)
        .expect("pack owner removes");
    assert!(!temp.path().join("shared").exists());
    assert!(state.entries().expect("empty journal").is_empty());
}

#[test]
fn a_blocked_member_does_not_activate_or_leave_staged_bytes() {
    let temp = TempRoot::new("blocked-member");
    let state = LocalState::for_global(temp.path().to_path_buf());

    // An unmanaged destination represents a member that failed the local
    // preflight.  The installer must report the conflict before writing any
    // staged bytes or journal entry for that member.
    fs::create_dir_all(temp.path().join("blocked")).expect("unmanaged destination");
    fs::write(
        temp.path().join("blocked/README.txt"),
        b"preserve this local file",
    )
    .expect("unmanaged file");

    let error = state
        .install(&install_plan(
            temp.path(),
            "blocked",
            bundle("must not activate"),
            "pack:registry:@team/pack@1.0.0",
        ))
        .expect_err("unmanaged member destination must block activation");
    assert!(matches!(error, InstallError::DestinationConflict(_)));
    assert_eq!(
        fs::read(temp.path().join("blocked/README.txt")).expect("local file"),
        b"preserve this local file"
    );
    assert!(state.entries().expect("journal reads").is_empty());
    assert_eq!(
        leftovers_with_prefix(temp.path(), ".pskills-stage-"),
        0,
        "blocked preflight must clean its stage"
    );
}

#[test]
fn install_many_preflights_every_pack_member_before_activation() {
    let temp = TempRoot::new("batch-preflight");
    let state = LocalState::for_global(temp.path().to_path_buf());
    fs::create_dir_all(temp.path().join("blocked")).expect("unmanaged destination");
    fs::write(
        temp.path().join("blocked/README.txt"),
        b"preserve this local file",
    )
    .expect("unmanaged file");

    let first = install_plan(
        temp.path(),
        "first",
        bundle("must not activate before the full pack preflight"),
        "pack:registry:@team/pack@1.0.0",
    );
    let second = install_plan(
        temp.path(),
        "blocked",
        bundle("blocked pack member"),
        "pack:registry:@team/pack@1.0.0",
    );
    let error = state
        .install_many(&[first, second])
        .expect_err("one blocked member must reject the whole pack");
    assert!(matches!(error, InstallError::DestinationConflict(_)));
    assert!(!temp.path().join("first").exists());
    assert_eq!(
        fs::read(temp.path().join("blocked/README.txt")).expect("local file"),
        b"preserve this local file"
    );
    assert!(state.entries().expect("journal reads").is_empty());
    assert_eq!(leftovers_with_prefix(temp.path(), ".pskills-stage-"), 0);
}

#[test]
fn verify_reports_tampered_content_as_not_ok() {
    let temp = TempRoot::new("tamper");
    let state = LocalState::for_global(temp.path().to_path_buf());
    state
        .install(&install_plan(
            temp.path(),
            "tamper",
            bundle("original bytes"),
            "direct:@team/tamper@1.0.0",
        ))
        .expect("install");

    fs::write(
        temp.path().join("tamper/SKILL.md"),
        b"---\nname: tamper\ndescription: changed\n---\nlocal edit\n",
    )
    .expect("tamper active file");
    let report = state.verify().expect("verify returns a report");
    assert_eq!(report.len(), 1);
    assert!(!report[0].ok, "tampering must never be reported as healthy");
    assert!(report[0].error.is_some());
}

#[test]
fn verify_rejects_tampered_tree_metadata_even_when_files_are_unchanged() {
    let temp = TempRoot::new("tree-metadata");
    let state = LocalState::for_global(temp.path().to_path_buf());
    state
        .install(&install_plan(
            temp.path(),
            "tree",
            bundle("tree metadata fixture"),
            "direct:@team/tree@1.0.0",
        ))
        .expect("install");

    let mut journal = state.read_journal().expect("journal reads");
    journal.entries[0].key = "tree@sha256:0000000000000000000000000000000000000000000000000000000000000000|tree=sha256:0000000000000000000000000000000000000000000000000000000000000000".into();
    state
        .write_journal(&journal)
        .expect("tampered journal writes");
    let report = state.verify().expect("verify returns a report");
    assert_eq!(report.len(), 1);
    assert!(
        !report[0].ok,
        "journal tree metadata is part of the integrity claim"
    );
    assert_ne!(
        report[0].expected_tree_digest,
        report[0].actual_tree_digest.clone().unwrap_or_default()
    );
}

#[test]
fn artifact_digest_pin_is_checked_before_any_activation() {
    let temp = TempRoot::new("digest-pin");
    let state = LocalState::for_global(temp.path().to_path_buf());
    let fixture = bundle("must not activate with a stale lock digest");
    let mut plan = install_plan(temp.path(), "pinned", fixture, "direct:@team/pinned@1.0.0");
    plan.artifact_digest =
        "sha256:0000000000000000000000000000000000000000000000000000000000000000".into();

    let error = state
        .install(&plan)
        .expect_err("a frozen artifact digest mismatch must fail closed");
    assert!(matches!(error, InstallError::DigestMismatch { .. }));
    assert!(!temp.path().join("pinned").exists());
    assert!(state.entries().expect("journal reads").is_empty());
}

#[test]
fn interrupted_replacement_is_reported_before_bytes_are_reused() {
    let temp = TempRoot::new("recovery");
    let state = LocalState::for_global(temp.path().to_path_buf());
    state
        .install(&install_plan(
            temp.path(),
            "recover",
            bundle("before replacement"),
            "direct:@team/recover",
        ))
        .expect("initial install");
    let replacement = state
        .install(&install_plan(
            temp.path(),
            "recover",
            bundle("after replacement"),
            "direct:@team/recover",
        ))
        .expect("replacement install");
    let backup = replacement
        .backup
        .expect("replacement keeps a recovery backup");

    // Model a crash after the previous directory was restored but before the
    // journal could be reconciled.  Verification must expose the inconsistency
    // instead of reporting the stale lock/journal as healthy.
    fs::remove_dir_all(temp.path().join("recover")).expect("remove active replacement");
    fs::rename(&backup, temp.path().join("recover")).expect("restore previous directory");
    let report = state.verify().expect("verify interrupted state");
    assert_eq!(report.len(), 1);
    assert!(!report[0].ok);
    assert!(report[0].error.is_some());
}

#[test]
fn recover_rolls_back_an_activated_transaction_with_the_old_journal() {
    let temp = TempRoot::new("recover-transaction");
    let state = LocalState::for_global(temp.path().to_path_buf());
    state
        .install(&install_plan(
            temp.path(),
            "recover",
            bundle("before crash"),
            "direct:@team/recover",
        ))
        .expect("initial install");
    let old_journal = state.read_journal().expect("old journal");
    let replacement = state
        .install(&install_plan(
            temp.path(),
            "recover",
            bundle("after crash"),
            "direct:@team/recover",
        ))
        .expect("replacement install");
    let new_journal = state.read_journal().expect("new journal");
    let backup = replacement.backup.expect("replacement backup");
    let canonical_root = fs::canonicalize(temp.path()).expect("canonical install root");
    let stage_root = canonical_root.join(".pskills-stage-crash-fixture");
    fs::create_dir(&stage_root).expect("stale stage root");

    // Simulate a process dying after activation but before its journal write:
    // the filesystem has the replacement, the durable journal is old, and the
    // transaction marker records the backup needed to roll back.
    state
        .write_journal(&old_journal)
        .expect("restore pre-transaction journal");
    let marker = serde_json::json!({
        "version": 1,
        "phase": "activated",
        "old_journal": old_journal,
        "new_journal": new_journal,
        "operations": [{
            "destination": canonical_root.join("recover"),
            "stage": null,
            "backup": backup,
            "kind": "replace",
            "retain_backup": true,
            "bundle": null
        }],
        "stage_root": stage_root
    });
    fs::write(
        temp.path().join(".pskills-transaction.json"),
        serde_json::to_vec_pretty(&marker).expect("transaction marker JSON"),
    )
    .expect("transaction marker");

    state.recover().expect("recover interrupted transaction");
    assert_eq!(
        fs::read_to_string(temp.path().join("recover/SKILL.md")).expect("restored bytes"),
        "---\nname: shared\ndescription: install safety fixture\n---\nbefore crash\n"
    );
    assert_eq!(
        state.read_journal().expect("recovered journal"),
        old_journal
    );
    assert!(!temp.path().join(".pskills-transaction.json").exists());
    assert!(!stage_root.exists());
    assert!(!backup.exists());
}

#[cfg(unix)]
fn hold_install_lock(file: &File) -> io::Result<()> {
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
fn release_install_lock(file: &File) {
    use std::os::fd::AsRawFd;
    const LOCK_UN: i32 = 8;
    unsafe extern "C" {
        fn flock(fd: i32, operation: i32) -> i32;
    }
    let _ = unsafe { flock(file.as_raw_fd(), LOCK_UN) };
}

#[cfg(windows)]
fn hold_install_lock(file: &File) -> io::Result<()> {
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
fn release_install_lock(file: &File) {
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

#[cfg(any(unix, windows))]
#[test]
fn public_state_operations_fail_closed_when_another_processor_holds_the_lock() {
    let temp = TempRoot::new("lock-busy");
    let state = LocalState::for_global(temp.path().to_path_buf());
    let lock_path = temp.path().join(".pskills-install.lock");
    let lock_file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)
        .expect("lock file");
    hold_install_lock(&lock_file).expect("hold native install lock");

    let worker_state = state.clone();
    let result = thread::spawn(move || worker_state.entries())
        .join()
        .expect("lock probe thread");
    assert!(matches!(result, Err(InstallError::Lock { .. })));
    release_install_lock(&lock_file);
}

#[test]
fn project_scope_keeps_its_lockfile_inside_the_selected_project_root() {
    let temp = TempRoot::new("project-lock");
    let state = LocalState::for_project(temp.path().to_path_buf());
    assert_eq!(
        state.lock_path,
        temp.path().join("pskills.lock.json"),
        "a project install must not read or write the caller's CWD lockfile"
    );
}
