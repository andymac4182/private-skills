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

/// Typed external directory/catalog resolution evidence persisted alongside
/// the canonical registry provenance.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalProvenance {
    pub provider: String,
    pub external_id: String,
    pub source: String,
    pub slug: String,
    pub source_type: String,
    pub source_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_snapshot_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_digest: Option<Digest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skill_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_commit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_tree: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub well_known_index_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frontmatter_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frontmatter_description: Option<String>,
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
    /// Optional identity supplied by an external directory/catalog adapter.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_source_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_snapshot_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub feed_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub feed_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub feed_config_revision: Option<String>,
    /// Server-derived canonical source identity for display and lifecycle
    /// output. This is separate from the original external catalog id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_reference: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_provider_origin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_resolution_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub well_known_entry_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_digest: Option<Digest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skill_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_commit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_tree: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub well_known_index_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frontmatter_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frontmatter_description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external: Option<ExternalProvenance>,
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
            external_id: None,
            external_source_type: None,
            external_snapshot_hash: None,
            feed_id: None,
            feed_name: None,
            feed_config_revision: None,
            source_reference: None,
            source_provider_origin: None,
            source_resolution_kind: None,
            well_known_entry_name: None,
            external_digest: None,
            source_url: None,
            page_url: None,
            artifact_url: None,
            skill_path: None,
            requested_ref: None,
            resolved_commit: None,
            resolved_tree: None,
            well_known_index_url: None,
            frontmatter_name: None,
            frontmatter_description: None,
            external: None,
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
    /// Additive receipt ticket metadata returned by newer registries.
    #[serde(default)]
    pub receipt: Option<InstallReceiptTicketMetadata>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstallReceiptTicketMetadata {
    pub id: String,
    pub authorization_id: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstallReceiptRequest {
    pub authorization_id: String,
    pub changed: bool,
    pub agent: String,
    pub platform: String,
    pub client_version: String,
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
    #[serde(rename = "ref")]
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
    #[serde(rename = "ref")]
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

/// A transparent external-directory resolution request.  The registry owns
/// source mapping, private release naming, versioning, and snapshot identity;
/// the CLI deliberately sends no guessed private reference or upstream data.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalResolveRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub feed: Option<String>,
    pub external_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh: Option<bool>,
}

/// Public feed metadata returned by the registry discovery endpoint.
/// Optional fields keep the client compatible with older registries while
/// preserving server-owned feed identity when present.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FeedInfo {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub config_revision: Option<String>,
    #[serde(default)]
    pub repositories: Vec<String>,
    #[serde(default)]
    pub base_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FeedList {
    #[serde(default)]
    pub feeds: Vec<FeedInfo>,
}

/// Resolution plus the optional canonical source identity returned by the
/// transparent proxy response envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExternalResolution {
    pub resolution: Resolution,
    pub reference: Option<String>,
}

/// A registry controlled pull-through request.  The CLI sends this only to
/// the registry proxy endpoint; it never fetches an upstream directly.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportRequest {
    pub upstream_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    pub path: String,
    #[serde(rename = "ref", skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
    pub name: String,
    pub version: String,
}

/// A request to import a directory entry through the registry.  The CLI
/// deliberately sends this only to the authenticated registry; it never
/// resolves the public directory or its upstream sources locally.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryImportRequest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRequest {
    pub resource_id: String,
    pub authorization_id: String,
}
