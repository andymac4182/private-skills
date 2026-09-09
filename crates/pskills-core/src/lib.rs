//! Shared protocol and filesystem primitives for the `pskills` CLI.
//!
//! The registry transports a canonical UTF-8 JSON document rather than an
//! archive.  That makes the artifact digest independent of archive tooling and
//! leaves normal Agent Skills directories (`SKILL.md` plus supporting files)
//! untouched on disk.

pub mod bundle;
pub mod client;
pub mod credentials;
pub mod install;
pub mod model;
pub mod paths;

pub use bundle::{
    bundle_from_directory, canonical_bundle_bytes, decode_bundle_bytes, BundleLimits,
};
pub use client::{ApiClient, ApiError, HttpResponse};
pub use credentials::{CredentialStore, RegistryConfig};
pub use install::{InstallPlan, InstallResult, InstalledEntry, LocalState};
pub use model::*;
pub use paths::{agent_root, resolve_directory, Agent, InstallScope};

pub const VERSION: &str = "0.1.0";
pub const SERVICE: &str = "private-skills";
