import type { Principal, SkillVersion, StateRepository } from '../../contracts/src/index.ts';
import {
  createOpenClawTenantFeedPreview,
  normalizeOpenClawEntry,
  parseOpenClawFeed,
  sha256,
  OpenClawValidationError,
  OpenClawFeedCache,
  OpenClawRequestError,
  validateOpenClawFeedUrl,
  type OpenClawFeedCompatibilityProfile,
  effectiveOpenClawFeedExpiry,
  isOpenClawClawHubSkillsCompatibilityIdentity,
  OPENCLAW_CLAWHUB_SKILLS_MAX_TTL_MS,
  OPENCLAW_SOURCE_CLAWHUB,
  OPENCLAW_SOURCE_GITHUB,
  type OpenClawCacheSnapshot,
  type OpenClawFeed,
  type OpenClawFeedEntry,
  type OpenClawFetch,
  type OpenClawFeedErrorCode,
  type OpenClawRefreshResult,
  type OpenClawSha256,
} from '../../openclaw/src/index.ts';

/** The pinned hosted skills-feed route. */
export const OPENCLAW_SKILLS_FEED_ROUTE = '/v1/feeds/skills';

/** The producer must never impersonate the ClawHub-owned feed identity. */
export const OPENCLAW_RESERVED_OFFICIAL_FEED_ID = 'clawhub-official';

export {
  PersistentOpenClawFeedCache,
  StateRepositoryOpenClawConsumerSnapshotStore,
  OpenClawConsumerSnapshotStoreError,
} from './consumer-cache.ts';
export type {
  OpenClawConsumerCacheKey,
  OpenClawConsumerSnapshotStore,
  OpenClawConsumerSnapshotStoreErrorCode,
  PersistentOpenClawFeedCacheOptions,
  StateRepositoryOpenClawConsumerSnapshotStoreOptions,
} from './consumer-cache.ts';

export {
  OpenClawConsumerSelectionError,
  OpenClawSourceProofStoreError,
  OpenClawTrustedSnapshotImportService,
  StateRepositoryOpenClawSourceProofStore,
  createOpenClawCandidateProvider,
} from './service.ts';
export type {
  OpenClawCandidateProvider,
  OpenClawCandidateProviderInput,
  OpenClawCandidateProviderOptions,
  OpenClawConsumerSelectionErrorCode,
  OpenClawImportOperation,
  OpenClawImportQueue,
  OpenClawImportQueueRequest,
  OpenClawProjectedCandidate,
  OpenClawSourceProofCompletion,
  OpenClawSourceProofRecord,
  OpenClawSourceProofStore,
  OpenClawSourceProofStoreErrorCode,
  OpenClawTrustedSnapshotImportServiceOptions,
  StateRepositoryOpenClawSourceProofStoreOptions,
} from './service.ts';

const MAX_FEED_ID_BYTES = 512;
const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;
const MAX_PUBLICATION_TTL_MS = 24 * 60 * 60 * 1_000;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/u;
const SAFE_FEED_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const READER_ROLES = new Set(['reader', 'publisher', 'admin', 'owner']);
const SOURCE_ARTIFACT_FORMATS = new Set(['clawhub-skill-v1', 'github-skill-folder-v1']);

/**
 * A record returned by the registry's existing approved-and-scanned view.
 *
 * The adapter deliberately receives an already eligible record rather than
 * re-implementing scanner policy. `entry` must carry the exact OpenClaw
 * publisher/install coordinates selected by the caller; this layer never
 * invents a source URL, publisher trust, or provider coordinate.
 */
export interface OpenClawEligibleRecord {
  entry: OpenClawFeedEntry;
  /**
   * The private registry's canonical stored artifact digest. This is retained
   * as admission evidence and is deliberately never substituted for the
   * OpenClaw source integrity below.
   */
  registryArtifactDigest: string;
  /** Produced only after the exact source bytes/format were verified. */
  sourceArtifact: OpenClawSourceArtifactProof;
}

export interface OpenClawSourceArtifactProof {
  verified: true;
  digest: string;
  format: 'clawhub-skill-v1' | 'github-skill-folder-v1';
  /** Exact source identity, bound below to the candidate fields. */
  identity: string;
}

/**
 * One coherent publication read. The host persists/refreshes this snapshot
 * separately from the request route, so a sequence, timestamp, and entry set
 * cannot be mixed across state revisions.
 */
export interface OpenClawFeedPublicationSnapshot {
  id: string;
  generatedAt: string;
  sequence: number;
  expiresAt: string;
  records: readonly OpenClawEligibleRecord[];
}

/**
 * The immutable representation persisted by a publication store.  `body`,
 * `bytes`, and the validators are produced together and are returned directly
 * by the authenticated route, so a request cannot reserialize a different
 * view of the same sequence.
 */
export interface OpenClawStoredPublication {
  id: string;
  generatedAt: string;
  sequence: number;
  expiresAt: string;
  body: string;
  bytes: Uint8Array;
  sha256: OpenClawSha256;
  etag: string;
  lastModified: string;
}

/**
 * Host persistence seam for tenant publications.  A database-backed
 * implementation must make `putIfNewer` an atomic compare-and-swap on the
 * tenant key.  The adapter never uses a process-global publication or cache.
 */
export interface OpenClawPublicationStore {
  read(tenantId: string): Promise<OpenClawStoredPublication | undefined>;
  putIfNewer(tenantId: string, publication: OpenClawStoredPublication): Promise<boolean>;
}

export interface OpenClawPublicationSequenceAllocator {
  reserveNext(tenantId: string): Promise<number>;
}

/** A bounded in-memory store for tests and single-process development only. */
export class MemoryOpenClawPublicationStore implements OpenClawPublicationStore {
  private readonly publications = new Map<string, OpenClawStoredPublication>();
  private readonly nextSequences = new Map<string, number>();

  constructor(private readonly options: { maxTenants?: number } = {}) {
    const maxTenants = options.maxTenants ?? 128;
    if (!Number.isSafeInteger(maxTenants) || maxTenants < 1 || maxTenants > 10_000) {
      throw new OpenClawAdapterError('invalid_configuration', 'OpenClaw publication storage bounds are invalid');
    }
  }

  async read(tenantId: string): Promise<OpenClawStoredPublication | undefined> {
    const publication = this.publications.get(safeTenantId(tenantId));
    return publication === undefined ? undefined : cloneStoredPublication(await validateStoredPublication(publication));
  }

  async putIfNewer(tenantId: string, publication: OpenClawStoredPublication): Promise<boolean> {
    const key = safeTenantId(tenantId);
    const validated = await validateStoredPublication(publication);
    const current = this.publications.get(key);
    if (current !== undefined && validated.sequence < current.sequence) return false;
    if (current !== undefined && validated.sequence === current.sequence) {
      return sameStoredPublication(current, validated);
    }
    if (current === undefined && this.publications.size >= (this.options.maxTenants ?? 128)) {
      throw new OpenClawAdapterError('unavailable', 'OpenClaw publication storage is full');
    }
    this.publications.set(key, cloneStoredPublication(validated));
    this.nextSequences.set(key, Math.max(this.nextSequences.get(key) ?? 0, validated.sequence));
    return true;
  }

  async reserveNext(tenantId: string): Promise<number> {
    const key = safeTenantId(tenantId);
    const next = Math.max(this.nextSequences.get(key) ?? 0, this.publications.get(key)?.sequence ?? 0) + 1;
    this.nextSequences.set(key, next);
    return next;
  }
}

interface PersistedOpenClawPublication {
  id: string;
  generatedAt: string;
  sequence: number;
  expiresAt: string;
  body: string;
  bytesBase64: string;
  sha256: OpenClawSha256;
  etag: string;
  lastModified: string;
}

interface OpenClawRepositoryState extends Record<string, unknown> {
  openClawPublication?: PersistedOpenClawPublication;
  openClawNextSequence?: number;
}

/** JSON-safe StateRepository persistence for one tenant's latest publication. */
export class StateRepositoryOpenClawPublicationStore implements OpenClawPublicationStore, OpenClawPublicationSequenceAllocator {
  constructor(private readonly repository: StateRepository) {
    if (!repository || typeof repository.read !== 'function' || typeof repository.transaction !== 'function') {
      throw new OpenClawAdapterError('invalid_configuration', 'OpenClaw state repository is invalid');
    }
  }

  async read(tenantId: string): Promise<OpenClawStoredPublication | undefined> {
    const state = await this.repository.read(safeTenantId(tenantId));
    const persisted = (state as unknown as OpenClawRepositoryState).openClawPublication;
    return persisted === undefined ? undefined : fromPersistedPublication(persisted);
  }

  async putIfNewer(tenantId: string, publication: OpenClawStoredPublication): Promise<boolean> {
    const key = safeTenantId(tenantId);
    const validated = await validateStoredPublication(publication);
    const persisted = toPersistedPublication(validated);
    return this.repository.transaction(key, (state) => {
      const extension = state as unknown as OpenClawRepositoryState;
      const current = extension.openClawPublication;
      if (current !== undefined && current.sequence > persisted.sequence) return false;
      if (current !== undefined && current.sequence === persisted.sequence) {
        return samePersistedPublication(current, persisted);
      }
      extension.openClawPublication = persisted;
      extension.openClawNextSequence = Math.max(extension.openClawNextSequence ?? 0, persisted.sequence);
      return true;
    });
  }

  async reserveNext(tenantId: string): Promise<number> {
    const key = safeTenantId(tenantId);
    return this.repository.transaction(key, (state) => {
      const extension = state as unknown as OpenClawRepositoryState;
      const currentSequence = extension.openClawPublication?.sequence ?? 0;
      const next = Math.max(extension.openClawNextSequence ?? 0, currentSequence) + 1;
      extension.openClawNextSequence = next;
      return next;
    });
  }
}

export interface OpenClawPublicationReader {
  get(tenantId: string): Promise<OpenClawStoredPublication | undefined>;
}

/** Input accepted from the registry's approved/current-policy projection. */
export interface OpenClawApprovedSkillCandidate {
  skill: Pick<SkillVersion, 'state' | 'version' | 'artifact' | 'policyRevision'>;
  entry: OpenClawFeedEntry;
  sourceArtifact: OpenClawSourceArtifactProof;
}

/** The caller supplies the canonical policy predicate from the registry. */
export type OpenClawCurrentPolicyCheck = (
  skill: Pick<SkillVersion, 'state' | 'version' | 'artifact' | 'policyRevision'>,
) => boolean;

/** Host-facing metadata for advertising a private feed link. */
export interface OpenClawFeedAdvertisement {
  schemaVersion: 1;
  feedId: string;
  feedUrl: string;
  visibility: 'private';
  authentication: 'tenant-reader';
}

export interface OpenClawFeedHandlerOptions {
  /** Host authentication remains injected so this package is Node/edge safe. */
  authenticate(request: Request): Promise<Principal | null>;
  /** Read one host-persisted, internally coherent tenant publication. */
  publicationForTenant(input: {
    tenantId: string;
    principal: Principal;
    signal: AbortSignal;
  }): Promise<OpenClawStoredPublication | OpenClawFeedPublicationSnapshot>;
  /** Optional stricter ACL for a feed or namespace. */
  authorize?(principal: Principal): boolean | Promise<boolean>;
  /**
   * Optional per-publication admission check. A restricted namespace
   * principal is denied by default unless the host supplies a check that
   * revalidates every published resource against the current policy.
   */
  authorizePublication?(input: {
    tenantId: string;
    principal: Principal;
    publication: OpenClawStoredPublication | OpenClawFeedPublicationSnapshot;
    signal: AbortSignal;
  }): boolean | Promise<boolean>;
  now?: () => number;
}

export interface OpenClawFeedHandler {
  (request: Request): Promise<Response>;
}

/** A safe, non-secret error returned by the adapter boundary. */
export class OpenClawAdapterError extends Error {
  readonly code: 'invalid_configuration' | 'invalid_record' | 'stale_publication' | 'unavailable';

  constructor(
    code: OpenClawAdapterError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'OpenClawAdapterError';
    this.code = code;
  }
}

/**
 * Construct the manager used by the host's publication job.  The manager is
 * the only adapter operation that turns eligible metadata into feed bytes;
 * route reads remain side-effect free and consume the stored result.
 */
export class OpenClawPublicationManager {
  constructor(private readonly store: OpenClawPublicationStore) {
    if (!store || typeof store.read !== 'function' || typeof store.putIfNewer !== 'function') {
      throw new OpenClawAdapterError('invalid_configuration', 'OpenClaw publication storage is invalid');
    }
  }

  async publish(input: {
    tenantId: string;
    publication: OpenClawFeedPublicationSnapshot;
  }): Promise<OpenClawStoredPublication> {
    const tenantId = safeTenantId(input.tenantId);
    const snapshot = validatePublicationSnapshot(input.publication);
    const entries = normalizeEligibleRecords(snapshot.records);
    const produced = await createOpenClawTenantFeedPreview({
      id: snapshot.id,
      generatedAt: snapshot.generatedAt,
      sequence: snapshot.sequence,
      expiresAt: snapshot.expiresAt,
      entries,
      authenticatedTenantId: tenantId,
    });
    const stored = await toStoredPublication(produced);
    let accepted: boolean;
    try {
      accepted = await this.store.putIfNewer(tenantId, stored);
    } catch {
      throw new OpenClawAdapterError('unavailable', 'OpenClaw publication storage is unavailable');
    }
    if (!accepted) {
      throw new OpenClawAdapterError('stale_publication', 'The OpenClaw publication is older than the stored snapshot');
    }
    return cloneStoredPublication(stored);
  }

  /**
   * Allocate the next tenant sequence before building a publication.  Durable
   * stores implement this as a repository transaction; generic stores may
   * fall back to a bounded read-then-publish path.
   */
  async publishNext(input: {
    tenantId: string;
    publication: Omit<OpenClawFeedPublicationSnapshot, 'sequence'>;
  }): Promise<OpenClawStoredPublication> {
    const allocator = this.store as OpenClawPublicationStore & Partial<OpenClawPublicationSequenceAllocator>;
    let sequence: number;
    if (typeof allocator.reserveNext === 'function') {
      sequence = await allocator.reserveNext(safeTenantId(input.tenantId));
    } else {
      const current = await this.get(input.tenantId);
      sequence = (current?.sequence ?? 0) + 1;
    }
    return this.publish({
      tenantId: input.tenantId,
      publication: { ...input.publication, sequence },
    });
  }

  async get(tenantId: string): Promise<OpenClawStoredPublication | undefined> {
    try {
      const publication = await this.store.read(safeTenantId(tenantId));
      return publication === undefined ? undefined : await validateStoredPublication(publication);
    } catch (error) {
      if (error instanceof OpenClawAdapterError) throw error;
      throw new OpenClawAdapterError('unavailable', 'OpenClaw publication storage is unavailable');
    }
  }
}

/**
 * Create the authenticated private producer route. This function only reads
 * through the injected publication and builds an in-memory response. It does not
 * queue imports, write artifacts, or change registry state.
 */
export function createOpenClawSkillsFeedHandler(
  options: OpenClawFeedHandlerOptions,
): OpenClawFeedHandler {
  if (!options || typeof options.authenticate !== 'function' || typeof options.publicationForTenant !== 'function') {
    throw new OpenClawAdapterError('invalid_configuration', 'OpenClaw feed dependencies are invalid');
  }
  const now = options.now ?? Date.now;

  return async function openClawSkillsFeedHandler(request: Request): Promise<Response> {
    if (request.method.toUpperCase() !== 'GET') {
      return methodNotAllowed();
    }

    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return errorResponse(400, 'INVALID_REQUEST', 'The feed request is invalid');
    }
    if (url.pathname !== OPENCLAW_SKILLS_FEED_ROUTE || url.search || url.hash) {
      return errorResponse(404, 'NOT_FOUND', 'Feed not found');
    }

    let principal: Principal | null;
    try {
      principal = await options.authenticate(request);
    } catch {
      return unauthorizedResponse();
    }
    if (!principal || !isReaderPrincipal(principal)) {
      return unauthorizedResponse();
    }
    if (options.authorize) {
      let allowed = false;
      try {
        allowed = await options.authorize(principal);
      } catch {
        allowed = false;
      }
      if (!allowed) return forbiddenResponse();
    }

    try {
      const tenantId = safeTenantId(principal.organizationId);
      const publication = await options.publicationForTenant({
        tenantId,
        principal,
        signal: request.signal,
      });
      if (isRestrictedNamespacePrincipal(principal) && !options.authorizePublication) {
        return forbiddenResponse();
      }
      if (options.authorizePublication) {
        let allowed = false;
        try {
          allowed = await options.authorizePublication({
            tenantId,
            principal,
            publication,
            signal: request.signal,
          });
        } catch {
          allowed = false;
        }
        if (!allowed) return forbiddenResponse();
      }
      const nowMs = safeNow(now());
      if (isStoredPublication(publication)) {
        const stored = await validateStoredPublication(publication);
        const storedGeneratedAt = safeIsoTimestamp(stored.generatedAt, 'generatedAt');
        const storedExpiresAt = safeIsoTimestamp(stored.expiresAt, 'expiresAt');
        if (storedGeneratedAt > nowMs || storedExpiresAt - storedGeneratedAt > MAX_PUBLICATION_TTL_MS) {
          throw new OpenClawAdapterError('invalid_record', 'The publication timestamps are invalid');
        }
        if (storedExpiresAt <= nowMs) {
          return errorResponse(503, 'OPENCLAW_FEED_EXPIRED', 'The OpenClaw feed snapshot is unavailable', true);
        }
        return feedResponse(request, stored.body, stored.bytes.byteLength, stored.etag, stored.lastModified);
      }
      const validated = validatePublicationSnapshot(publication);
      const feedId = safeFeedId(validated.id);
      const sequence = safeSequence(validated.sequence);
      const generatedAt = safeIsoTimestamp(validated.generatedAt, 'generatedAt');
      const expiresAt = safeIsoTimestamp(validated.expiresAt, 'expiresAt');
      if (generatedAt > nowMs || expiresAt - generatedAt > MAX_PUBLICATION_TTL_MS) {
        throw new OpenClawAdapterError('invalid_record', 'The publication timestamps are invalid');
      }
      if (expiresAt <= nowMs) {
        return errorResponse(503, 'OPENCLAW_FEED_EXPIRED', 'The OpenClaw feed snapshot is unavailable', true);
      }
      const entries = normalizeEligibleRecords(validated.records);
      const produced = await createOpenClawTenantFeedPreview({
        id: feedId,
        generatedAt: validated.generatedAt,
        sequence,
        expiresAt: validated.expiresAt,
        entries,
        authenticatedTenantId: tenantId,
      });
      return feedResponse(request, produced.body, produced.bytes.byteLength, produced.etag, produced.lastModified);
    } catch (error) {
      if (error instanceof OpenClawAdapterError && error.code === 'invalid_configuration') {
        return errorResponse(500, 'OPENCLAW_CONFIGURATION', 'The OpenClaw feed is unavailable');
      }
      if (error instanceof OpenClawAdapterError && error.code === 'invalid_record') {
        return errorResponse(500, 'OPENCLAW_FEED_INVALID', 'The OpenClaw feed is unavailable');
      }
      if (error instanceof OpenClawValidationError) {
        return errorResponse(500, 'OPENCLAW_FEED_INVALID', 'The OpenClaw feed is unavailable');
      }
      if (request.signal.aborted) {
        return errorResponse(499, 'REQUEST_ABORTED', 'The feed request was aborted');
      }
      return errorResponse(503, 'OPENCLAW_FEED_UNAVAILABLE', 'The OpenClaw feed is temporarily unavailable', true);
    }
  };
}

/** Route composition for a host using the durable tenant publication manager. */
export function createOpenClawTenantFeedRoute(options: {
  manager: OpenClawPublicationReader;
  authenticate(request: Request): Promise<Principal | null>;
  authorize?(principal: Principal): boolean | Promise<boolean>;
  authorizePublication?(input: {
    tenantId: string;
    principal: Principal;
    publication: OpenClawStoredPublication | OpenClawFeedPublicationSnapshot;
    signal: AbortSignal;
  }): boolean | Promise<boolean>;
  now?: () => number;
}): OpenClawFeedHandler {
  if (!options || !options.manager || typeof options.manager.get !== 'function') {
    throw new OpenClawAdapterError('invalid_configuration', 'OpenClaw publication manager is invalid');
  }
  return createOpenClawSkillsFeedHandler({
    authenticate: options.authenticate,
    authorize: options.authorize,
    authorizePublication: options.authorizePublication,
    now: options.now,
    publicationForTenant: async ({ tenantId }) => {
      const publication = await options.manager.get(tenantId);
      if (publication === undefined) {
        throw new OpenClawAdapterError('unavailable', 'OpenClaw publication is unavailable');
      }
      return publication;
    },
  });
}

/**
 * Create the metadata-only link a host may expose from its own authenticated
 * well-known document.  OpenClaw's pinned v1 feed contract does not define a
 * public discovery endpoint, so this helper does not claim one or fetch data.
 */
export function createOpenClawFeedAdvertisement(input: {
  feedUrl: string | URL;
  feedId: string;
}): OpenClawFeedAdvertisement {
  const feedId = safeFeedId(input.feedId);
  let feedUrl: URL;
  try {
    feedUrl = new URL(input.feedUrl);
  } catch {
    throw new OpenClawAdapterError('invalid_configuration', 'OpenClaw feed URL is invalid');
  }
  if (feedUrl.protocol !== 'https:' || feedUrl.username || feedUrl.password || feedUrl.search || feedUrl.hash) {
    throw new OpenClawAdapterError('invalid_configuration', 'OpenClaw feed URL is invalid');
  }
  if (feedUrl.pathname !== OPENCLAW_SKILLS_FEED_ROUTE) {
    throw new OpenClawAdapterError('invalid_configuration', 'OpenClaw feed URL is invalid');
  }
  return {
    schemaVersion: 1,
    feedId,
    feedUrl: feedUrl.href,
    visibility: 'private',
    authentication: 'tenant-reader',
  };
}

/**
 * Project only records that the registry has already approved under its
 * current scanner/policy revision.  Source coordinates and source digests are
 * supplied by the acquisition verifier; native private artifacts and rows
 * without a bound public proof are intentionally skipped.
 */
export function selectOpenClawEligibleRecords(
  candidates: readonly OpenClawApprovedSkillCandidate[],
  isCurrentPolicyApproved: OpenClawCurrentPolicyCheck,
): OpenClawEligibleRecord[] {
  if (!Array.isArray(candidates) || candidates.length > 1_000) {
    throw new OpenClawAdapterError('invalid_record', 'The approved skill set is outside the feed limit');
  }
  if (typeof isCurrentPolicyApproved !== 'function') {
    throw new OpenClawAdapterError('invalid_configuration', 'The current policy predicate is invalid');
  }
  const selected: OpenClawEligibleRecord[] = [];
  const seenIds = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || !candidate.skill || !candidate.entry || !candidate.sourceArtifact) {
      continue;
    }
    // OpenClaw's public version is source-defined: GitHub candidates expose
    // the full immutable commit, while the registry stores a private
    // SemVer-compatible release version.  The candidate provider has already
    // bound this entry to a verified source proof, so comparing these two
    // version namespaces would silently discard valid records.
    if (candidate.skill.state !== 'approved') continue;
    let current = false;
    try {
      current = isCurrentPolicyApproved(candidate.skill);
    } catch {
      current = false;
    }
    if (!current || seenIds.has(candidate.entry.id)) continue;
    const record: OpenClawEligibleRecord = {
      entry: candidate.entry,
      registryArtifactDigest: candidate.skill.artifact.digest,
      sourceArtifact: candidate.sourceArtifact,
    };
    try {
      normalizeEligibleRecords([record]);
    } catch {
      // Unsupported source formats, missing proofs, and malformed candidate
      // coordinates are excluded from the feed rather than being rewritten.
      continue;
    }
    seenIds.add(candidate.entry.id);
    selected.push(record);
  }
  return selected;
}

function validatePublicationSnapshot(value: OpenClawFeedPublicationSnapshot): OpenClawFeedPublicationSnapshot {
  if (!value || typeof value !== 'object') {
    throw new OpenClawAdapterError('invalid_record', 'The OpenClaw publication is malformed');
  }
  const id = safeFeedId(value.id);
  const sequence = safeSequence(value.sequence);
  const generatedAt = safeIsoTimestamp(value.generatedAt, 'generatedAt');
  const expiresAt = safeIsoTimestamp(value.expiresAt, 'expiresAt');
  if (expiresAt <= generatedAt || expiresAt - generatedAt > MAX_PUBLICATION_TTL_MS) {
    throw new OpenClawAdapterError('invalid_record', 'The publication expiry is invalid');
  }
  if (!Array.isArray(value.records)) {
    throw new OpenClawAdapterError('invalid_record', 'The publication records are invalid');
  }
  return {
    id,
    sequence,
    generatedAt: new Date(generatedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    records: value.records,
  };
}

function isStoredPublication(value: unknown): value is OpenClawStoredPublication {
  return Boolean(value && typeof value === 'object' && 'body' in value && 'bytes' in value && 'sha256' in value && 'etag' in value);
}

function toPersistedPublication(publication: OpenClawStoredPublication): PersistedOpenClawPublication {
  return {
    id: publication.id,
    generatedAt: publication.generatedAt,
    sequence: publication.sequence,
    expiresAt: publication.expiresAt,
    body: publication.body,
    bytesBase64: bytesToBase64(publication.bytes),
    sha256: publication.sha256,
    etag: publication.etag,
    lastModified: publication.lastModified,
  };
}

async function fromPersistedPublication(value: PersistedOpenClawPublication): Promise<OpenClawStoredPublication> {
  if (!value || typeof value !== 'object' || typeof value.bytesBase64 !== 'string') {
    throw new OpenClawAdapterError('invalid_record', 'The persisted OpenClaw publication is malformed');
  }
  return validateStoredPublication({
    id: value.id,
    generatedAt: value.generatedAt,
    sequence: value.sequence,
    expiresAt: value.expiresAt,
    body: value.body,
    bytes: base64ToBytes(value.bytesBase64),
    sha256: value.sha256,
    etag: value.etag,
    lastModified: value.lastModified,
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa !== 'function') {
    throw new OpenClawAdapterError('unavailable', 'OpenClaw publication encoding is unavailable');
  }
  let binary = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.byteLength)));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  if (
    typeof atob !== 'function' ||
    value.length > 8 * 1024 * 1024 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    throw new OpenClawAdapterError('invalid_record', 'The persisted OpenClaw bytes are invalid');
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new OpenClawAdapterError('invalid_record', 'The persisted OpenClaw bytes are invalid');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function samePersistedPublication(left: PersistedOpenClawPublication, right: PersistedOpenClawPublication): boolean {
  return left.id === right.id &&
    left.generatedAt === right.generatedAt &&
    left.expiresAt === right.expiresAt &&
    left.body === right.body &&
    left.bytesBase64 === right.bytesBase64 &&
    left.sha256 === right.sha256 &&
    left.etag === right.etag &&
    left.lastModified === right.lastModified;
}

async function validateStoredPublication(value: OpenClawStoredPublication): Promise<OpenClawStoredPublication> {
  const snapshot = validatePublicationSnapshot({
    id: value.id,
    generatedAt: value.generatedAt,
    sequence: value.sequence,
    expiresAt: value.expiresAt,
    records: [],
  });
  if (
    typeof value.body !== 'string' ||
    value.body.length === 0 ||
    !(value.bytes instanceof Uint8Array) ||
    value.bytes.byteLength > 4 * 1024 * 1024 ||
    !SHA256_RE.test(value.sha256) ||
    value.etag !== `"${value.sha256}"` ||
    typeof value.lastModified !== 'string' ||
    value.lastModified.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(value.lastModified)
  ) {
    throw new OpenClawAdapterError('invalid_record', 'The stored publication is malformed');
  }
  const bodyBytes = new TextEncoder().encode(value.body);
  if (!bytesEqual(bodyBytes, value.bytes)) {
    throw new OpenClawAdapterError('invalid_record', 'The stored publication bytes do not match its body');
  }
  let actualSha256: OpenClawSha256;
  try {
    actualSha256 = await sha256(value.bytes);
  } catch {
    throw new OpenClawAdapterError('unavailable', 'OpenClaw publication hashing is unavailable');
  }
  if (actualSha256 !== value.sha256) {
    throw new OpenClawAdapterError('invalid_record', 'The stored publication digest does not match its bytes');
  }
  try {
    const parsed = parseOpenClawFeed(value.body, {
      expectedFeedId: snapshot.id,
      checkExpiry: false,
      maxBytes: 4 * 1024 * 1024,
    });
    if (
      parsed.generatedAt !== snapshot.generatedAt ||
      parsed.expiresAt !== snapshot.expiresAt ||
      parsed.sequence !== snapshot.sequence
    ) {
      throw new Error('stored feed metadata does not match its publication');
    }
  } catch {
    throw new OpenClawAdapterError('invalid_record', 'The stored publication body is invalid');
  }
  return {
    ...snapshot,
    body: value.body,
    bytes: value.bytes.slice(),
    sha256: value.sha256,
    etag: value.etag,
    lastModified: value.lastModified,
  };
}

async function toStoredPublication(produced: {
  feed: OpenClawFeed;
  body: string;
  bytes: Uint8Array;
  sha256: OpenClawSha256;
  etag: string;
  lastModified: string;
}): Promise<OpenClawStoredPublication> {
  return validateStoredPublication({
    id: produced.feed.id,
    generatedAt: produced.feed.generatedAt,
    sequence: produced.feed.sequence,
    expiresAt: produced.feed.expiresAt,
    body: produced.body,
    bytes: produced.bytes,
    sha256: produced.sha256,
    etag: produced.etag,
    lastModified: produced.lastModified,
  });
}

function cloneStoredPublication(publication: OpenClawStoredPublication): OpenClawStoredPublication {
  return {
    ...publication,
    bytes: publication.bytes.slice(),
  };
}

function sameStoredPublication(left: OpenClawStoredPublication, right: OpenClawStoredPublication): boolean {
  return left.id === right.id &&
    left.generatedAt === right.generatedAt &&
    left.expiresAt === right.expiresAt &&
    left.body === right.body &&
    left.sha256 === right.sha256 &&
    left.etag === right.etag &&
    left.lastModified === right.lastModified;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export interface OpenClawTrustedFeedProfile {
  /** Exact HTTPS endpoint; credentials/query/fragment are rejected. */
  url: string | URL;
  expectedFeedId: string;
  allowedOrigins: readonly string[];
  /**
   * Optional revision-pinned producer compatibility. The profile is
   * server-selected and its implementation verifies the exact ClawHub URL
   * and feed identity before accepting any relaxed wire details.
   */
  compatibilityProfile?: OpenClawFeedCompatibilityProfile;
  /** A server-side fetcher may add its own configured auth; it is never returned. */
  fetcher?: OpenClawFetch;
  timeoutMs?: number;
  maxBodyBytes?: number;
}

export interface OpenClawMetadataPreviewOptions {
  cache?: OpenClawFeedCache;
  signal?: AbortSignal;
}

export interface OpenClawMetadataSnapshot {
  feed: OpenClawMetadataFeed;
  sha256: OpenClawSha256;
  etag: string;
  lastModified?: string;
  acceptedAt: number;
  sourceUrl: string;
}

export interface OpenClawMetadataFeed {
  schemaVersion: OpenClawFeed['schemaVersion'];
  id: string;
  generatedAt: string;
  sequence: number;
  expiresAt: string;
  description?: string;
  entries: readonly OpenClawMetadataEntry[];
}

export interface OpenClawMetadataEntry {
  type: OpenClawFeedEntry['type'];
  id: string;
  title: string;
  description?: string;
  icon?: string;
  version: string;
  state: OpenClawFeedEntry['state'];
  featured?: boolean;
  featuredAt?: number;
  publisher: OpenClawFeedEntry['publisher'];
  install: {
    candidates: readonly OpenClawMetadataCandidate[];
  };
}

export interface OpenClawMetadataCandidate {
  sourceRef: string;
  package: string;
  version: string;
  integrity: string;
  github?: {
    repo: string;
    path: string;
    commit: string;
    contentHash: string;
  };
}

export type OpenClawMetadataPreviewResult =
  | {
      kind: 'accepted';
      status: 200;
      snapshot: OpenClawMetadataSnapshot;
    }
  | {
      kind: 'not-modified';
      status: 304;
      snapshot: OpenClawMetadataSnapshot;
    }
  | {
      kind: 'stale';
      status?: number;
      snapshot: OpenClawMetadataSnapshot;
      error: OpenClawFeedErrorCode;
    }
  | {
      kind: 'rejected';
      status?: number;
      snapshot?: OpenClawMetadataSnapshot;
      error: OpenClawFeedErrorCode;
    };

/**
 * Read only a trusted feed's validated metadata. The cache holds bounded feed
 * bytes in memory for conditional refresh; this function returns no body,
 * bytes, artifact handle, import job, or storage mutation.
 */
export async function previewOpenClawFeed(
  profile: OpenClawTrustedFeedProfile,
  options: OpenClawMetadataPreviewOptions = {},
): Promise<OpenClawMetadataPreviewResult> {
  let url: URL;
  try {
    url = validateOpenClawFeedUrl(profile.url, profile.allowedOrigins);
    if (
      typeof profile.expectedFeedId !== 'string' ||
      profile.expectedFeedId.length === 0 ||
      new TextEncoder().encode(profile.expectedFeedId).byteLength > MAX_FEED_ID_BYTES ||
      /[\u0000-\u001f\u007f]/u.test(profile.expectedFeedId)
    ) throw new Error('invalid feed identity');
  } catch {
    return { kind: 'rejected', error: 'invalid-url' };
  }

  const cache = options.cache ?? new OpenClawFeedCache();
  const fetcher = profile.fetcher ?? globalThis.fetch;
  const guardedFetcher: OpenClawFetch | undefined = typeof fetcher === 'function'
    ? async (input, init) => {
        const requested = new URL(input instanceof URL ? input.href : String(input));
        const response = await fetcher(input, { ...init, redirect: 'manual' });
        // An injected fetcher may ignore redirect:manual. Reject a followed
        // redirect before the parsed bytes become a trusted snapshot.
        if (response.url) {
          let returned: URL;
          try {
            returned = new URL(response.url);
          } catch {
            throw new OpenClawRequestError('invalid-url');
          }
          if (returned.href !== requested.href) throw new OpenClawRequestError('invalid-url');
        }
        return response;
      }
    : undefined;

  const result = await cache.refresh({
    url,
    expectedFeedId: profile.expectedFeedId,
    allowedOrigins: profile.allowedOrigins,
    ...(profile.compatibilityProfile === undefined
      ? {}
      : { compatibilityProfile: profile.compatibilityProfile }),
    fetcher: guardedFetcher,
    timeoutMs: profile.timeoutMs,
    maxBodyBytes: profile.maxBodyBytes,
    signal: options.signal,
  });
  return mapRefreshResult(result);
}

function normalizeEligibleRecords(
  records: readonly OpenClawEligibleRecord[],
): OpenClawFeedEntry[] {
  if (!Array.isArray(records) || records.length > 1_000) {
    throw new OpenClawAdapterError('invalid_record', 'The eligible record set is outside the feed limit');
  }
  const entries: OpenClawFeedEntry[] = [];
  const seenIds = new Set<string>();
  for (const record of records) {
    if (
      !record ||
      typeof record !== 'object' ||
      !record.entry ||
      typeof record.registryArtifactDigest !== 'string' ||
      !record.sourceArtifact ||
      typeof record.sourceArtifact !== 'object'
    ) {
      throw new OpenClawAdapterError('invalid_record', 'An eligible record is malformed');
    }
    if (!SHA256_RE.test(record.registryArtifactDigest)) {
      throw new OpenClawAdapterError('invalid_record', 'An eligible record has an invalid registry digest');
    }
    if (
      record.sourceArtifact.verified !== true ||
      !SHA256_RE.test(record.sourceArtifact.digest) ||
      !SOURCE_ARTIFACT_FORMATS.has(record.sourceArtifact.format) ||
      typeof record.sourceArtifact.identity !== 'string' ||
      record.sourceArtifact.identity.length === 0
    ) {
      throw new OpenClawAdapterError('invalid_record', 'An eligible record lacks verified source integrity');
    }
    if (record.entry.type !== 'skill' || record.entry.state !== 'available') {
      throw new OpenClawAdapterError('invalid_record', 'An eligible record is not an available skill');
    }
    let candidates;
    try {
      candidates = normalizeOpenClawEntry(record.entry);
    } catch {
      throw new OpenClawAdapterError('invalid_record', 'An eligible record has invalid install metadata');
    }
    const matching = candidates.filter((candidate) => candidate.candidate.integrity === record.sourceArtifact.digest);
    if (matching.length !== 1) {
      throw new OpenClawAdapterError('invalid_record', 'An install coordinate does not match verified source integrity');
    }
    const selected = matching[0]!.candidate;
    const expectedFormat = selected.sourceRef === OPENCLAW_SOURCE_CLAWHUB
      ? 'clawhub-skill-v1'
      : selected.sourceRef === OPENCLAW_SOURCE_GITHUB
        ? 'github-skill-folder-v1'
        : undefined;
    const expectedIdentity = selected.sourceRef === OPENCLAW_SOURCE_CLAWHUB
      ? `${selected.package}@${selected.version}`
      : selected.github
        ? `${selected.github.repo}:${selected.github.path}@${selected.github.commit}`
        : undefined;
    if (
      expectedFormat === undefined ||
      record.sourceArtifact.format !== expectedFormat ||
      expectedIdentity === undefined ||
      record.sourceArtifact.identity !== expectedIdentity
    ) {
      throw new OpenClawAdapterError('invalid_record', 'Source integrity proof is not bound to the install identity');
    }
    if (seenIds.has(record.entry.id)) {
      throw new OpenClawAdapterError('invalid_record', 'The feed contains duplicate skill identities');
    }
    seenIds.add(record.entry.id);
    // Only publish the candidate bound to the verified source digest. A
    // caller may retain other discovery candidates in its private state, but
    // exposing them here would let a consumer select an unverified artifact.
    entries.push({
      ...record.entry,
      install: {
        candidates: [{
          sourceRef: selected.sourceRef,
          package: selected.package,
          version: selected.version,
          integrity: selected.integrity,
          ...(selected.github === undefined ? {} : { github: { ...selected.github } }),
        }],
      },
    });
  }
  return entries;
}

function mapRefreshResult(result: OpenClawRefreshResult): OpenClawMetadataPreviewResult {
  if (result.kind === 'rejected') {
    return {
      kind: 'rejected',
      ...(result.status === undefined ? {} : { status: result.status }),
      error: result.error,
    };
  }
  const snapshot = metadataSnapshot(result.snapshot);
  if (result.kind === 'accepted') return { kind: 'accepted', status: 200, snapshot };
  if (result.kind === 'not-modified') return { kind: 'not-modified', status: 304, snapshot };
  return {
    kind: 'stale',
    ...(result.status === undefined ? {} : { status: result.status }),
    snapshot,
    error: result.error,
  };
}

function metadataSnapshot(snapshot: OpenClawCacheSnapshot): OpenClawMetadataSnapshot {
  return {
    feed: {
      schemaVersion: snapshot.feed.schemaVersion,
      id: snapshot.feed.id,
      generatedAt: snapshot.feed.generatedAt,
      sequence: snapshot.feed.sequence,
      expiresAt: snapshot.feed.expiresAt,
      ...(snapshot.feed.description === undefined ? {} : { description: snapshot.feed.description }),
      entries: snapshot.feed.entries.map((entry) => ({
        type: entry.type,
        id: entry.id,
        title: entry.title,
        ...(entry.description === undefined ? {} : { description: entry.description }),
        ...(entry.icon === undefined ? {} : { icon: entry.icon }),
        version: entry.version,
        state: entry.state,
        ...(entry.featured === undefined ? {} : { featured: entry.featured }),
        ...(entry.featuredAt === undefined ? {} : { featuredAt: entry.featuredAt }),
        publisher: { ...entry.publisher },
        install: {
          candidates: entry.install.candidates.map((candidate) => ({
            sourceRef: candidate.sourceRef,
            package: candidate.package,
            version: candidate.version,
            integrity: candidate.integrity,
            ...(candidate.github === undefined ? {} : { github: { ...candidate.github } }),
          })),
        },
      })),
    },
    sha256: snapshot.sha256,
    etag: snapshot.etag,
    ...(snapshot.lastModified === undefined ? {} : { lastModified: snapshot.lastModified }),
    acceptedAt: snapshot.acceptedAt,
    sourceUrl: snapshot.sourceUrl,
  };
}

function isReaderPrincipal(principal: Principal): boolean {
  if (!principal || typeof principal.organizationId !== 'string' || principal.organizationId.trim() === '') return false;
  if (!Array.isArray(principal.roles) || !principal.roles.some((role) => READER_ROLES.has(role))) return false;
  if (principal.scopes === undefined) return true;
  if (!Array.isArray(principal.scopes)) return false;
  return principal.scopes.some((scope) =>
    scope === '*' || scope === 'registry:*' || scope === 'registry:read' || scope === 'skills:read',
  );
}

function isRestrictedNamespacePrincipal(principal: Principal): boolean {
  if (principal.roles.includes('owner') || principal.roles.includes('admin')) return false;
  return Array.isArray(principal.namespaces) && principal.namespaces.length > 0;
}

function safeTenantId(value: string): string {
  if (typeof value !== 'string' || value.trim() === '' || new TextEncoder().encode(value).byteLength > 512) {
    throw new OpenClawAdapterError('invalid_configuration', 'Tenant identity is invalid');
  }
  return value;
}

function safeFeedId(value: string): string {
  if (
    typeof value !== 'string' ||
    value === OPENCLAW_RESERVED_OFFICIAL_FEED_ID ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > MAX_FEED_ID_BYTES ||
    !SAFE_FEED_ID_RE.test(value)
  ) {
    throw new OpenClawAdapterError('invalid_configuration', 'Private feed identity is invalid');
  }
  return value;
}

function safeSequence(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SEQUENCE) {
    throw new OpenClawAdapterError('invalid_configuration', 'Feed sequence is invalid');
  }
  return value;
}

function safeNow(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 8.64e15) {
    throw new OpenClawAdapterError('invalid_configuration', 'Feed clock is invalid');
  }
  return value;
}

function safeIsoTimestamp(value: string, label: string): number {
  if (typeof value !== 'string' || value.length > 64 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new OpenClawAdapterError('invalid_record', `The publication ${label} is invalid`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new OpenClawAdapterError('invalid_record', `The publication ${label} is invalid`);
  }
  return parsed;
}

function feedResponse(
  request: Request,
  body: string,
  byteLength: number,
  etag: string,
  lastModified: string,
): Response {
  const headers = new Headers({
    'cache-control': 'private, no-cache',
    'content-type': 'application/json; charset=utf-8',
    etag,
    'last-modified': lastModified,
    'x-content-type-options': 'nosniff',
    vary: 'authorization',
  });
  if (request.headers.get('if-none-match')?.split(',').some((value) => value.trim() === etag)) {
    return new Response(null, { status: 304, headers });
  }
  headers.set('content-length', String(byteLength));
  return new Response(body, { status: 200, headers });
}

function methodNotAllowed(): Response {
  return new Response(JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED', message: 'GET is required' } }), {
    status: 405,
    headers: {
      allow: 'GET',
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

function unauthorizedResponse(): Response {
  return errorResponse(401, 'UNAUTHORIZED', 'Authentication is required');
}

function forbiddenResponse(): Response {
  return errorResponse(403, 'FORBIDDEN', 'Feed access is denied');
}

function errorResponse(status: number, code: string, message: string, retryable = false): Response {
  return new Response(JSON.stringify({ error: { code, message, ...(retryable ? { retryable: true } : {}) } }), {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    },
  });
}
