use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const PROTOCOL_VERSION: u8 = 1;
pub type Digest = String;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BundleFile {
    pub path: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executable: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SkillBundle {
    pub format: String,
    pub files: Vec<BundleFile>,
}

impl Default for SkillBundle {
    fn default() -> Self {
        Self {
            format: "pskills-bundle-v1".into(),
            files: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoredBlob {
    pub key: String,
    pub digest: Digest,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Provenance {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_digest: Option<Digest>,
}
impl Default for Provenance {
    fn default() -> Self {
        Self {
            kind: "native".into(),
            upstream_id: None,
            repository: None,
            path: None,
            revision: None,
            source_digest: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillVersion {
    pub id: String,
    #[serde(default)]
    pub organization_id: String,
    pub name: String,
    #[serde(default)]
    pub skill_name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    pub artifact: StoredBlob,
    pub state: String,
    #[serde(default)]
    pub policy_revision: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub approved_at: Option<String>,
    #[serde(default)]
    pub provenance: Provenance,
    #[serde(default)]
    pub file_count: usize,
    #[serde(default)]
    pub scan_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PackMember {
    pub resource_id: String,
    pub name: String,
    pub version: String,
    pub digest: Digest,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PackVersion {
    pub id: String,
    #[serde(default)]
    pub organization_id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    pub members: Vec<PackMember>,
    pub manifest_digest: Digest,
    pub state: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub policy_revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Resolution {
    pub kind: String,
    pub resource_id: String,
    #[serde(default)]
    pub organization_id: String,
    pub name: String,
    pub version: String,
    pub digest: Digest,
    #[serde(default)]
    pub members: Vec<SkillVersion>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstallAuthorization {
    pub id: String,
    #[serde(default)]
    pub organization_id: String,
    pub subject: String,
    pub resolution: Resolution,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransferDescriptor {
    pub mode: String,
    pub url: String,
    pub method: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    pub expires_at: String,
    pub size: u64,
    pub digest: Digest,
    #[serde(default)]
    pub range_supported: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Principal {
    pub organization_id: String,
    pub subject: String,
    #[serde(default)]
    pub roles: Vec<String>,
    #[serde(default)]
    pub namespaces: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    pub id: String,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub resource_id: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PackDraft {
    pub schema_version: u8,
    pub kind: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub skills: Vec<PackDraftMember>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PackDraftMember {
    #[serde(rename = "ref")]
    pub reference: String,
    pub version: String,
}
impl PackDraftMember {
    pub fn new(reference: impl Into<String>, version: impl Into<String>) -> Self {
        Self {
            reference: reference.into(),
            version: version.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LockTarget {
    pub agent: String,
    pub adapter_version: String,
    pub scope: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LockPack {
    pub registry: String,
    pub reference: String,
    pub version: String,
    pub manifest_digest: Digest,
    pub members: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LockSkill {
    pub key: String,
    pub registry: String,
    pub reference: String,
    pub version: String,
    pub skill_name: String,
    pub artifact_digest: Digest,
    pub tree_digest: Digest,
    pub owners: Vec<String>,
    pub provenance: Provenance,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LockFile {
    pub lock_version: u8,
    #[serde(default)]
    pub registries: BTreeMap<String, LockRegistry>,
    #[serde(default)]
    pub targets: Vec<LockTarget>,
    #[serde(default)]
    pub packs: Vec<LockPack>,
    #[serde(default)]
    pub skills: Vec<LockSkill>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LockRegistry {
    pub url: String,
    #[serde(default)]
    pub organization: String,
}
impl Default for LockFile {
    fn default() -> Self {
        Self {
            lock_version: 1,
            registries: BTreeMap::new(),
            targets: Vec::new(),
            packs: Vec::new(),
            skills: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct JournalFile {
    pub path: String,
    pub digest: Digest,
    pub size: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct JournalEntry {
    pub key: String,
    pub destination: String,
    pub skill_name: String,
    pub digest: Digest,
    pub owners: Vec<String>,
    pub files: Vec<JournalFile>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct JournalFileDocument {
    pub version: u8,
    pub entries: Vec<JournalEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SearchResponse {
    #[serde(default)]
    pub skills: Vec<SkillVersion>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HealthResponse {
    pub ok: bool,
    pub service: String,
    pub version: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ErrorResponse {
    #[serde(default)]
    pub error: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub code: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PublishRequest {
    pub name: String,
    pub version: String,
    pub description: String,
    pub bundle: SkillBundle,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResolveRequest {
    pub kind: String,
    #[serde(rename = "ref")]
    pub reference: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRequest {
    pub resource_id: String,
    pub authorization_id: String,
}
