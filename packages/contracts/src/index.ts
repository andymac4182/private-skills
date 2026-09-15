export const PROTOCOL_VERSION = 1;
export type Digest = `sha256:${string}`;
export type Role = 'owner' | 'admin' | 'publisher' | 'reader' | 'worker';
/**
 * Human-facing labels resolved by the authenticated server record. This
 * metadata is display-only: it is never used for tenant selection or access
 * checks, and it deliberately excludes credentials and authorization grants.
 */
export interface PrincipalDisplayMetadata {
  userName?: string;
  userEmail?: string;
  organizationName?: string;
  organizationSlug?: string;
}

const PRINCIPAL_DISPLAY_VALUE_MAX_LENGTH = 256;

function safePrincipalDisplayValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > PRINCIPAL_DISPLAY_VALUE_MAX_LENGTH || /[\u0000-\u001f\u007f]/u.test(normalized)) return undefined;
  return normalized;
}

/** Normalize optional server-derived labels before they cross a public API boundary. */
export function normalizePrincipalDisplayMetadata(value: unknown): PrincipalDisplayMetadata | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<PrincipalDisplayMetadata>;
  const userName = safePrincipalDisplayValue(candidate.userName);
  const userEmail = safePrincipalDisplayValue(candidate.userEmail);
  const organizationName = safePrincipalDisplayValue(candidate.organizationName);
  const organizationSlug = safePrincipalDisplayValue(candidate.organizationSlug);
  if (!userName && !userEmail && !organizationName && !organizationSlug) return undefined;
  return {
    ...(userName === undefined ? {} : { userName }),
    ...(userEmail === undefined ? {} : { userEmail }),
    ...(organizationName === undefined ? {} : { organizationName }),
    ...(organizationSlug === undefined ? {} : { organizationSlug }),
  };
}

export interface Principal {
  organizationId: string;
  subject: string;
  roles: Role[];
  namespaces?: string[];
  scopes?: string[];
  display?: PrincipalDisplayMetadata;
}
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
/**
 * A bounded provider observation used by the storage-attempt reconciler.
 * `unknown` is intentionally distinct from `absent`: a timeout, permission
 * failure, or integrity failure must retain the metered reservation.
 */
export type StorageObjectInspection =
  | { state: 'present'; key: string; digest: Digest; size: number }
  | { state: 'absent'; key: string }
  | { state: 'unknown'; key: string; reason: 'provider-error' | 'integrity' | 'limit' };

/**
 * BlobStore capability required for durable write recovery. The caller
 * allocates the object identity before provider I/O, then retries the same
 * key and verifies its bytes instead of creating an untracked object.
 */
export interface RecoverableBlobStore extends BlobStore {
  allocateObjectKey(): string;
  putAtKey(key: string, bytes: Uint8Array, metadata?: Record<string, string>): Promise<StoredBlob>;
  inspectObject(key: string): Promise<StorageObjectInspection>;
  /**
   * Stable, non-secret identity for the provider configuration used by this
   * store. Hosts should change it when the bucket, endpoint, account, or
   * private object prefix changes. It is optional so legacy stores remain
   * usable, but a verified write receipt cannot be minted without it.
   */
  readonly providerBinding?: string;
  /**
   * Provider-specific proof that the original write for this stable key has
   * reached a terminal outcome and can no longer create the object later.
   * An adapter must return false when it cannot establish that fact.
   */
  confirmWriteTerminated?(key: string): Promise<boolean>;
}
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
  /** Server-owned source catalog adapter identity for imported releases. */
  externalSource?: string;
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
/**
 * Server-computed admission for a catalog row. This is response metadata,
 * never persisted release state, and does not widen any file or install gate.
 */
export type CurrentSkillAdmissionStatus = 'current' | 'needs-rescan' | 'unavailable';
export type CurrentSkillAdmissionReason = 'current' | 'policy-changed' | 'evidence-missing' | 'evidence-stale' | 'evidence-incomplete' | 'scan-failed' | 'blocking-finding' | Exclude<DistributionState, 'approved'>;
export interface CurrentSkillAdmission {
  allowed: boolean;
  status: CurrentSkillAdmissionStatus;
  reason: CurrentSkillAdmissionReason;
  policyRevision: string;
  scannerId?: ScannerId;
  expiresAt?: string;
}
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
  /** Server-owned discovery adapter identity for warm-cache reconciliation. */
  sourceCatalogId?: string;
  /** Source adapter trust/config revision captured when this job was queued. */
  sourceCatalogConfigRevision?: string;
  /** Provider version retained separately from the registry SemVer cache version. */
  sourceCatalogProviderVersion?: string;
}
/** Durable settlement intent for the one scan reservation attached to a job. */
export type MeteredScanSettlement = 'unused' | 'executed' | 'released';
export interface Job { id: string; organizationId: string; kind: 'scan' | 'import'; state: 'queued' | 'running' | 'completed' | 'failed'; resourceId?: string; artifact?: StoredBlob; policyRevision: string; policy: Policy; import?: ImportRequest; upstream?: Upstream; /** Server-owned OpenClaw source target; never accepted from public input. */ openclawSource?: unknown; /** Server-owned source-catalog acquisition descriptor; never accepted from public input. */ sourceAcquisition?: unknown; /** Additional source adapters that have revalidated this physical source identity. */ sourceCatalogAliases?: Array<{ sourceId: string; externalId: string; configRevision: string }>; /** Server-owned metered reservation owner; workers must reuse this key across retries. */ meteredReservationKey?: string; /** Exact billing reservation lifecycle returned by server-side admission. */ meteredReservationGeneration?: number; /** Terminal worker intent; `unused` is reconciled only after the job transaction commits. */ meteredScanSettlement?: MeteredScanSettlement; createdAt: string; updatedAt: string; attempts: number; leaseToken?: string; leaseExpiresAt?: string; error?: string; }
/**
 * Durable ownership for a reserved artifact write.  The billing reservation
 * remains charged while an attempt is pending or orphaned; a reconciler may
 * release it only after it verifies that no object remains (or deletion has
 * completed).  This is intentionally separate from a Job because publication
 * and draft writes can fail before a job exists.
 */
export type StorageAttemptState = 'pending' | 'committed' | 'orphaned' | 'recovering' | 'releasing' | 'released';
/**
 * Durable marker for a metered correction that crossed an external boundary.
 * `release-pending` is written before the billing zero and therefore also
 * covers the crash window in which that call may still be in flight.
 * `restore-pending` is written after a late metadata reference is observed
 * following a settled zero and requires an exact ledger inverse.
 */
export type StorageBillingCorrection = 'release-pending' | 'restore-pending';
export interface StorageAttempt {
  id: string;
  organizationId: string;
  reservationKey: string;
  digest: Digest;
  size: number;
  state: StorageAttemptState;
  /** Exact metered reservation lifecycle captured at admission. */
  reservationGeneration?: number;
  /** Stable provider configuration identity captured before provider I/O. */
  providerBinding?: string;
  /** Server-created proof that this exact write completed and was verified. */
  writeReceipt?: StorageWriteReceipt;
  /** Set atomically around an external billing correction. */
  billingCorrection?: StorageBillingCorrection;
  createdAt: string;
  updatedAt: string;
  objectKey?: string;
  jobId?: string;
  /** A short-lived compare-and-set fence held during external recovery I/O. */
  recoveryToken?: string;
  recoveryStartedAt?: string;
}

/**
 * A durable positive write result. This receipt is deliberately narrower than
 * a provider error: callers may mint it only after the adapter has awaited the
 * write and verified the exact returned bytes. An ambiguous write has no
 * receipt and remains retained until provider finality is established.
 */
export interface StorageWriteReceipt {
  kind: 'verified';
  providerBinding: string;
  key: string;
  digest: Digest;
  size: number;
  completedAt: string;
}
/**
 * Durable fence for a metered reservation while a caller is deciding whether
 * it owns a queued job. `releasing` is committed before the external billing
 * correction so a concurrent queue cannot acquire the same reservation in
 * the gap between the ownership check and the correction.
 */
export type MeteredReservationOwnerState = 'owned' | 'releasing' | 'released';
export interface MeteredReservationOwner {
  reservationKey: string;
  state: MeteredReservationOwnerState;
  updatedAt: string;
  jobId?: string;
  /** Exact billing reservation lifecycle fenced by this owner row. */
  reservationGeneration?: number;
  releaseToken?: string;
}
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
  /** Optional so pre-metering state documents remain readable. */
  storageAttempts?: StorageAttempt[];
  /** Optional durable ownership fences for metered reservations. */
  meteredReservationOwners?: MeteredReservationOwner[];
  grants: TransferGrant[];
  audit: AuditEvent[];
  /** Optional host-owned daily Eve dispatch records. */
  tenantReviewDispatches?: TenantReviewDispatchRecord[];
  /** Optional host-owned cursor for bounded tenant review fan-out. */
  tenantReviewDispatchCursor?: TenantReviewDispatchCursor;
}
export interface StateRepository { read(organizationId: string): Promise<RegistryState>; transaction<T>(organizationId: string, updater: (state: RegistryState) => T): Promise<T>; }

/** Durable scheduler bookkeeping; no prompts, credentials, or candidate text. */
export interface TenantReviewDispatchRecord {
  operationKey: string;
  /** `starting` is durably committed before an external provider call. */
  /** `uncertain` means the provider may have accepted the session; retries are fenced. */
  state: 'claimed' | 'starting' | 'completed' | 'uncertain';
  claimToken?: string;
  leaseExpiresAt: string;
  sessionId?: string;
  updatedAt: string;
  startingAt?: string;
  completedAt?: string;
  uncertainAt?: string;
}

/** Durable bounded queue state used when a deployment has more tenants than one page. */
export interface TenantReviewDispatchCursor {
  day: string;
  pendingOrganizationIds: string[];
  completedOrganizationIds: string[];
  /** Tenants whose provider outcome is uncertain for this daily operation. */
  blockedOrganizationIds?: string[];
  updatedAt: string;
}
export interface Authenticator { authenticate(request: Request): Promise<Principal | null>; createSession?(token: string): Promise<{ cookie: string; principal: Principal } | null>; clearSessionCookie?(): string; }
/**
 * Host-neutral metered admission used by registry, authoring, and worker
 * adapters. The billing package implements this shape without making the
 * portable contracts depend on a provider SDK or a web framework.
 */
export interface MeteredUsageDelta {
  seats?: number;
  storageBytes?: number;
  scans?: number;
  eveCostCents?: number;
}
/**
 * Result of a metered admission. The generation is the billing ledger's
 * exact lifecycle token; older adapters may omit it and therefore cannot
 * safely perform a delayed reconciliation.
 */
export interface MeteredUsageReservation {
  idempotent: boolean;
  reservationGeneration?: number;
}

/**
 * Result of restoring the exact retained storage bytes from a released
 * reservation. The returned generation is required for any later cleanup.
 */
export interface MeteredUsageRestoration extends MeteredUsageReservation {
  /** Generation that was released before the inverse was applied. */
  restoredFromGeneration: number;
  reservationGeneration: number;
}

export type MeteredStorageRecoveryAction = 'restored' | 'fenced';

/**
 * Result of resolving an uncertain storage release. `fenced` advances only
 * the lifecycle generation because the original charge is still present;
 * `restored` inverses a committed zero reconciliation.
 */
export interface MeteredStorageRecoveryResolution {
  action: MeteredStorageRecoveryAction;
  idempotent: boolean;
  restoredFromGeneration: number;
  reservationGeneration: number;
}
export interface BillingUsageAdmission {
  status(): { enabled: boolean };
  reserveUsage(organizationId: string, delta: MeteredUsageDelta, operationKey: string): Promise<MeteredUsageReservation>;
  /**
   * Reconcile the exact reservation lifecycle returned by reserveUsage. A
   * stale generation is rejected by the billing ledger without changing
   * usage; callers must retain the value across retries.
   */
  reconcileUsage(organizationId: string, reservationKey: string, actual: MeteredUsageDelta, operationKey: string, reservationGeneration?: number): Promise<unknown>;
  /**
   * Restore the exact storage estimate from a released lifecycle. This is a
   * compensation capability, not ordinary quota admission: it may put the
   * organization above its current cap, while future admissions remain
   * subject to the cap. Implementations must require the exact generation.
   */
  restoreUsage?(
    organizationId: string,
    reservationKey: string,
    delta: Pick<MeteredUsageDelta, 'storageBytes'>,
    operationKey: string,
    reservationGeneration: number,
  ): Promise<MeteredUsageRestoration>;
  /**
   * Resolve the retain/reference branch of an uncertain storage release in
   * one ledger transaction. A released source is restored above quota; a
   * still-charged source is fenced without changing usage.
   */
  resolveStorageRecovery?(
    organizationId: string,
    reservationKey: string,
    delta: Pick<MeteredUsageDelta, 'storageBytes'>,
    operationKey: string,
    reservationGeneration: number,
  ): Promise<MeteredStorageRecoveryResolution>;
  setSeatCount?(organizationId: string, seats: number, operationKey: string): Promise<unknown>;
}

/**
 * Canonical input shared by registry queue admission and the worker retry
 * path. Callers project request fields to match their durable deduplication
 * semantics before hashing this value; the full request is never exposed as
 * a billing operation key.
 */
export interface MeteredImportIdentity {
  organizationId: string;
  policyRevision: string;
  request: ImportRequest;
  upstream?: Pick<Upstream, 'id' | 'kind' | 'namespace' | 'baseUrl' | 'repositories' | 'configRevision' | 'credentialEnv'>;
  sourceAcquisition?: unknown;
  openclawSource?: unknown;
}

export function canonicalMeteredImportIdentity(input: MeteredImportIdentity): string {
  const stable = (value: unknown): string => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map((entry) => stable(entry)).join(',')}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
  };
  return stable({
    organizationId: input.organizationId,
    policyRevision: input.policyRevision,
    request: input.request,
    upstream: input.upstream ?? null,
    sourceAcquisition: input.sourceAcquisition ?? null,
    openclawSource: input.openclawSource ?? null,
  });
}
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
export interface WorkerCompletion { leaseToken: string; bundle?: SkillBundle; provenance?: Provenance; scanResults?: ScanResult[]; error?: string; /** Worker-authenticated marker; absent is conservative and keeps the reservation charged. */ scanInvocationStarted?: boolean; /** Exact billing reservation lifecycle observed at worker admission. */ meteredReservationGeneration?: number; }
