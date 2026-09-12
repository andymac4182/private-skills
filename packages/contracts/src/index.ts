export const PROTOCOL_VERSION = 1;
export type Digest = `sha256:${string}`;
export type Role = 'owner' | 'admin' | 'publisher' | 'reader' | 'worker';
export interface Principal { organizationId: string; subject: string; roles: Role[]; namespaces?: string[]; scopes?: string[]; }
/** A bounded, request-local observation of one external fetch boundary. */
export type UpstreamRequestKind = 'catalog' | 'source';
export interface UpstreamRequestObserver {
  /** Record only the category of a fetch; URLs, headers, and response data stay out of telemetry. */
  record(kind: UpstreamRequestKind): void;
}
/** content is strict RFC 4648 padded base64. Never raw UTF-8 text. */
export interface BundleFile { path: string; content: string; executable?: boolean; }
export interface SkillBundle { format: 'pskills-bundle-v1'; files: BundleFile[]; }
export interface StoredBlob { key: string; digest: Digest; size: number; }
export interface BlobStore { put(bytes: Uint8Array): Promise<StoredBlob>; get(key: string): Promise<Uint8Array>; remove(key: string): Promise<void>; }
export type DistributionState = 'pending' | 'approved' | 'quarantined' | 'scan-error' | 'revoked';
export type ScannerId = 'cisco-skill-scanner' | 'nvidia-skillspector' | 'skillsguard';
export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';
export interface ScannerPolicy { id: ScannerId; mode: 'disabled' | 'advisory' | 'required'; blockSeverities: Severity[]; timeoutSeconds: number; configuration?: Record<string, unknown>; }
export interface Policy { revision: string; scanners: ScannerPolicy[]; allowUnscanned: boolean; evidenceMaxAgeSeconds: number; hooks?: HookConfiguration[]; }
export interface HookConfiguration { id: string; event: 'ingest.validate' | 'artifact.evaluate' | 'pack.evaluate' | 'artifact.approved' | 'artifact.quarantined'; mode: 'disabled' | 'advisory' | 'required'; url?: string; secretEnv?: string; timeoutSeconds: number; }
export interface Finding { ruleId: string; fingerprint: string; severity: Severity; category: string; message: string; file?: string; line?: number; redactedEvidence?: string; }
export interface ScanResult {
  id: string; organizationId: string; jobId: string; artifactDigest: Digest; policyRevision: string;
  scannerId: ScannerId; engineVersion: string; rulesRevision: string; configurationHash: string;
  status: 'completed' | 'degraded' | 'error' | 'timeout' | 'unsupported'; findings: Finding[];
  coverage: { filesEnumerated: number; filesAnalyzed: number; filesSkipped: number; filesUnsupported: number; limitations: string[]; externalDestinations: string[]; };
  createdAt: string; durationMs: number; error?: string;
}
/**
 * Provenance supplied by an external catalog adapter.  These fields identify
 * the catalog row/snapshot and are intentionally separate from sourceDigest,
 * which always means the registry's canonical bundle digest.
 */
export interface Provenance {
  kind: 'native' | 'github' | 'registry' | 'skills-sh';
  upstreamId?: string;
  repository?: string;
  path?: string;
  revision?: string;
  sourceDigest?: Digest;
  externalId?: string;
  externalSourceType?: 'github' | 'well-known';
  externalSnapshotHash?: string | null;
  feedId?: string;
  feedName?: string;
  feedConfigRevision?: string;
  /** Server-derived public source identity; never accepted from install input. */
  sourceReference?: string;
  /** Verified origin emitted by the acquisition adapter, not a catalog URL hint. */
  sourceProviderOrigin?: string;
  /** How the worker established the source identity. */
  sourceResolutionKind?: 'snapshot' | 'github' | 'well-known';
  /** Trusted worker time when the external source bytes were fetched. */
  fetchedAt?: string;
  /** Digest advertised by a well-known source, kept distinct from the local artifact digest. */
  externalDigest?: Digest;
  /** Optional source-resolution evidence returned by the skills.sh worker. */
  sourceUrl?: string;
  /** Detail route fallback used only after a fresh exact nested catalog match. */
  catalogDetailFallback?: 'invalid_path' | 'not_found' | 'identity_mismatch';
  pageUrl?: string;
  artifactUrl?: string;
  skillPath?: string;
  requestedRef?: string;
  resolvedCommit?: string;
  resolvedTree?: string;
  wellKnownIndexUrl?: string;
  /** Exact entry selected from the authenticated well-known index. */
  wellKnownEntryName?: string;
  frontmatterName?: string;
  frontmatterDescription?: string;
  external?: ExternalProvenance;
}
export interface ExternalProvenance {
  provider: 'skills.sh';
  externalId: string;
  source: string;
  slug: string;
  sourceType: 'github' | 'well-known';
  sourceUrl: string;
  /** Detail route fallback used only after a fresh exact nested catalog match. */
  catalogDetailFallback?: 'invalid_path' | 'not_found' | 'identity_mismatch';
  sourceProviderOrigin?: string;
  sourceResolutionKind?: 'snapshot' | 'github' | 'well-known';
  /** Trusted worker time when the external source bytes were fetched. */
  fetchedAt?: string;
  pageUrl?: string;
  externalSnapshotHash: string | null;
  externalDigest?: Digest;
  repository?: string;
  skillPath?: string;
  requestedRef?: string;
  resolvedCommit?: string;
  resolvedTree?: string;
  wellKnownIndexUrl?: string;
  wellKnownEntryName?: string;
  artifactUrl?: string;
  frontmatterName?: string;
  frontmatterDescription?: string;
}
export interface SkillReleaseAuthoring { baseResourceId: string; baseDigest: Digest; draftId: string; draftRevision: number; actor: string; }
export interface SkillVersion { id: string; organizationId: string; name: string; skillName: string; version: string; description: string; artifact: StoredBlob; state: DistributionState; policyRevision: string; createdAt: string; approvedAt?: string; provenance: Provenance; fileCount: number; scanIds: string[]; authoring?: SkillReleaseAuthoring; }
export type SkillDraftStatus = 'open' | 'publishing' | 'published' | 'discarded';
export interface SkillDraftIdempotencyRecord {
  key: string;
  subject: string;
  requestDigest: Digest;
  revision: number;
  digest: Digest;
  artifact: StoredBlob;
  manifest: SkillDraftFileManifestEntry[];
  updatedAt: string;
}
export interface SkillDraftFileManifestEntry { path: string; size: number; digest: Digest; executable?: boolean; }
export type SkillDraftFilePreviewState = 'text' | 'binary' | 'unsupported' | 'oversize';
/** Metadata returned for one lazily readable draft file. */
export interface SkillDraftFileView extends SkillDraftFileManifestEntry {
  previewState: SkillDraftFilePreviewState;
  /** Canonical base64, present only for bounded supported text files. */
  content?: string;
}
export interface SkillDraftPublicationRecord {
  key: string;
  subject: string;
  requestDigest: Digest;
  revision: number;
  digest: Digest;
  version: string;
  resourceId: string;
  jobId: string;
  createdAt: string;
}
export type SkillDraftOrigin = 'release' | 'upload';
/** Tenant-scoped mutable authoring state; the referenced artifact is always a fresh sealed object. */
export interface SkillDraft {
  id: string;
  organizationId: string;
  origin: SkillDraftOrigin;
  name: string;
  skillName: string;
  description: string;
  /** Set only when the draft was forked from an approved immutable release. */
  baseResourceId?: string;
  baseDigest?: Digest;
  revision: number;
  digest: Digest;
  artifact: StoredBlob;
  files: BundleFile[];
  status: SkillDraftStatus;
  actor: string;
  createdAt: string;
  updatedAt: string;
  createIdempotency?: SkillDraftIdempotencyRecord;
  idempotency?: SkillDraftIdempotencyRecord[];
  publications?: SkillDraftPublicationRecord[];
}
/** A bounded text-only operation proposed by the private skill builder. */
export type SkillBuilderPatchOperation =
  | { op: 'add' | 'edit'; path: string; content: string }
  | { op: 'rename'; path: string; newPath: string }
  | { op: 'delete'; path: string };
export type SkillBuilderProposalState = 'pending' | 'applied' | 'rejected' | 'stale';
export interface SkillBuilderProposalRecord {
  id: string;
  idempotencyKey: string;
  /** Digest of the canonical proposal request (binding, session, operations). */
  requestDigest: Digest;
  organizationId: string;
  draftId: string;
  subject: string;
  sessionId: string;
  baseRevision: number;
  baseDigest: Digest;
  proposedDigest: Digest;
  operations: SkillBuilderPatchOperation[];
  state: SkillBuilderProposalState;
  createdAt: string;
  updatedAt: string;
}
export type SkillBuilderRequestState = 'accepted' | 'completed' | 'failed' | 'uncertain';
export interface SkillBuilderRequestRecord {
  id: string;
  /** Digest of the exact prompt request bound to this request id. */
  requestDigest: Digest;
  state: SkillBuilderRequestState;
  proposalId?: string;
  createdAt: string;
  updatedAt: string;
}
/**
 * Registry-owned mapping; the Eve session key and service credentials never
 * leave the server. A terminal record is retained as attempt history. A later
 * attempt for the same exact draft binding gets a distinct record, so
 * provider callbacks cannot be rebound to a different attempt.
 */
export interface SkillBuilderSessionRecord {
  id: string;
  organizationId: string;
  subject: string;
  draftId: string;
  draftRevision: number;
  draftDigest: Digest;
  sessionKey: string;
  eveSessionId: string;
  /** Last provider turn observed for this session; used to scope cancellation. */
  activeTurnId?: string;
  /** Durable single-flight fence for a prompt awaiting provider settlement. */
  activeRequestId?: string;
  state: 'ready' | 'running' | 'stopped' | 'failed' | 'completed';
  requests: SkillBuilderRequestRecord[];
  proposals: SkillBuilderProposalRecord[];
  createdAt: string;
  updatedAt: string;
}
export interface PackMember { resourceId: string; name: string; version: string; digest: Digest; }
export interface PackVersion { id: string; organizationId: string; name: string; version: string; description: string; members: PackMember[]; manifestDigest: Digest; state: 'approved' | 'revoked'; createdAt: string; policyRevision: string; }
export interface Resolution { kind: 'skill' | 'pack'; resourceId: string; organizationId: string; name: string; version: string; digest: Digest; members: SkillVersion[]; }
export interface InstallAuthorization { id: string; organizationId: string; subject: string; resolution: Resolution; expiresAt: string; }
/**
 * A receipt ticket is issued with an install authorization and deliberately
 * outlives that short-lived authorization.  The resolution is a server-owned
 * snapshot; clients must never be allowed to replace it when reporting an
 * install result.
 */
export interface InstallReceiptTicket {
  id: string;
  organizationId: string;
  subject: string;
  authorizationId: string;
  resolution: Resolution;
  issuedAt: string;
  expiresAt: string;
}
export type InstallReceiptAgent = 'codex' | 'claude' | 'universal';
export type InstallReceiptPlatform = 'windows' | 'macos' | 'linux' | 'other';
export interface InstallReceipt {
  id: string;
  organizationId: string;
  subject: string;
  authorizationId: string;
  ticketId: string;
  resolution: Resolution;
  changed: boolean;
  agent: InstallReceiptAgent;
  platform: InstallReceiptPlatform;
  clientVersion: string;
  createdAt: string;
  expiresAt: string;
}
export interface InstallReceiptTicketMetadata {
  id: string;
  authorizationId: string;
  expiresAt: string;
}
export interface InstallReceiptResolutionMember {
  resourceId: string;
  name: string;
  version: string;
  digest: Digest;
}
export interface InstallReceiptResolutionMetadata {
  kind: 'skill' | 'pack';
  resourceId: string;
  name: string;
  version: string;
  digest: Digest;
  members: InstallReceiptResolutionMember[];
}
export interface InstallReceiptMetadata {
  id: string;
  ticketId: string;
  authorizationId: string;
  createdAt: string;
  expiresAt: string;
  changed: boolean;
  agent: InstallReceiptAgent;
  platform: InstallReceiptPlatform;
  clientVersion: string;
  resolution: InstallReceiptResolutionMetadata;
}
export interface AnalyticsTotals {
  installOperations: number;
  skillInstalls: number;
  packInstalls: number;
  upToDateChecks: number;
}
export interface AnalyticsDaily extends AnalyticsTotals { date: string; }
export interface InstallAnalyticsTopSkill {
  resourceId: string;
  name: string;
  version: string;
  installs: number;
}
export interface InstallAnalytics {
  days: number;
  from: string;
  to: string;
  totals: AnalyticsTotals;
  daily: AnalyticsDaily[];
  topSkills: InstallAnalyticsTopSkill[];
}
export interface TransferGrant { id: string; organizationId: string; subject: string; resourceId: string; authorizationId: string; digest: Digest; expiresAt: string; }
export interface TransferDescriptor { mode: 'gateway' | 'signed-url'; url: string; method: 'GET'; headers: Record<string, string>; expiresAt: string; size: number; digest: Digest; rangeSupported: boolean; }
export interface Upstream { id: string; organizationId: string; name: string; kind: 'github' | 'registry' | 'skills-sh'; enabled: boolean; repositories?: string[]; baseUrl?: string; credentialEnv?: string; namespace: string; /** Server-owned configuration revision for transparent feed snapshots. */ configRevision?: string; }
/**
 * A tenant-owned catalog feed used by transparent pull-through installs.
 * `repositories` is intentionally tri-state: omitted means every source
 * approved by the catalog, while an explicit empty array denies all sources.
 * Credentials are referenced by environment name and never stored here.
 */
export interface Feed {
  id: string;
  organizationId: string;
  name: string;
  kind: 'skills-sh';
  enabled: boolean;
  repositories?: string[];
  baseUrl: string;
  /** Namespace used for internal authorization; independent from discovery name. */
  namespace?: string;
  credentialEnv?: string;
  /** Changes whenever any source restriction or trusted endpoint changes. */
  configRevision: string;
}
/**
 * Optional external identity fields are server-derived for directory imports.
 * `path` remains the full external identifier for skills.sh rows so workers
 * cannot silently substitute a different catalog item.
 */
export interface ImportRequest {
  upstreamId: string;
  repository?: string;
  path: string;
  ref?: string;
  name: string;
  version: string;
  externalId?: string;
  externalSourceType?: 'github' | 'well-known';
  externalSnapshotHash?: string | null;
  /** Server-owned transparent feed identity; never caller-selected for legacy imports. */
  feedId?: string;
  feedName?: string;
  feedConfigRevision?: string;
  /** Server-derived canonical source reference for reader-triggered pull-through jobs. */
  sourceReference?: string;
}
export interface Job { id: string; organizationId: string; kind: 'scan' | 'import'; state: 'queued' | 'running' | 'completed' | 'failed'; resourceId?: string; artifact?: StoredBlob; policyRevision: string; policy: Policy; import?: ImportRequest; upstream?: Upstream; /** Server-owned OpenClaw source target; never accepted from public job input. */ openclawSource?: unknown; createdAt: string; updatedAt: string; attempts: number; leaseToken?: string; leaseExpiresAt?: string; error?: string; }
export interface AuditEvent { id: string; organizationId: string; subject: string; action: string; resourceId?: string; createdAt: string; details?: Record<string, unknown>; }
export interface RegistryState {
  metadataRevision?: number;
  schemaVersion: 1;
  skills: SkillVersion[];
  /** Optional so states written before M6 authoring remain readable. */
  drafts?: SkillDraft[];
  packs: PackVersion[];
  jobs: Job[];
  scans: ScanResult[];
  policy: Policy;
  upstreams: Upstream[];
  /** Optional for state documents written before transparent feeds existed. */
  feeds?: Feed[];
  authorizations: InstallAuthorization[];
  /** Optional so states written before analytics can still be loaded. */
  installReceiptTickets?: InstallReceiptTicket[];
  /** Optional so states written before analytics can still be loaded. */
  installReceipts?: InstallReceipt[];
  /** Optional so states written before the interactive builder can still be loaded. */
  builderSessions?: SkillBuilderSessionRecord[];
  grants: TransferGrant[];
  audit: AuditEvent[];
}
export interface StateRepository { read(organizationId: string): Promise<RegistryState>; transaction<T>(organizationId: string, updater: (state: RegistryState) => T): Promise<T>; }
export interface Authenticator { authenticate(request: Request): Promise<Principal | null>; createSession?(token: string): Promise<{ cookie: string; principal: Principal } | null>; clearSessionCookie?(): string; }
export interface RegistryConfiguration {
  publicOrigin: string;
  maxBodyBytes: number;
  organizationId: string;
  leaseSeconds: number;
  allowLoopbackUpstreams?: boolean;
  /** Server-operator allowlist for skills.sh feeds; defaults to https://skills.sh. */
  trustedSkillsShBaseUrls?: readonly string[];
}
export interface RegistryDependencies { repository: StateRepository; blobs: BlobStore; auth: Authenticator; config: RegistryConfiguration; }
export interface WorkerCompletion { leaseToken: string; bundle?: SkillBundle; provenance?: Provenance; scanResults?: ScanResult[]; error?: string; }
