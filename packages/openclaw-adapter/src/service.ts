import type {
  Digest,
  Job,
  Principal,
  RegistryState,
  ScanResult,
  SkillVersion,
  StateRepository,
} from '../../contracts/src/index.ts';
import {
  OPENCLAW_OFFICIAL_FEED_ID,
  normalizeOpenClawCandidate,
  normalizeOpenClawEntry,
  parseOpenClawFeed,
  sha256,
  utf8Bytes,
  OPENCLAW_MAX_BODY_BYTES,
  type OpenClawCacheSnapshot,
  type OpenClawFeedEntry,
  type OpenClawNormalizedCandidate,
} from '../../openclaw/src/index.ts';
import type {
  OpenClawConsumerCacheKey,
  OpenClawConsumerSnapshotStore,
} from './consumer-cache.ts';
import type {
  OpenClawMetadataPreviewResult,
  OpenClawMetadataSnapshot,
  OpenClawSourceArtifactProof,
} from './index.ts';

const MAX_TENANT_ID_BYTES = 512;
const MAX_SKILL_ID_BYTES = 512;
const MAX_JOB_ID_BYTES = 512;
const MAX_PROOF_ENTRIES = 2_000;
const MAX_PROOF_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_SNAPSHOT_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_SNAPSHOT_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1_000;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/u;

// `openclawSource` is an optional registry job extension. Keep this adapter
// source-compatible with older contract snapshots that do not yet declare
// the extension on Job while still requiring it at the proof boundary.
type OpenClawJob = Job & { openclawSource?: unknown };

/** A source proof is produced only after an import job completed and its skill is approved. */
export interface OpenClawSourceProofRecord {
  proofVersion: 1;
  tenantId: string;
  skillId: string;
  skillVersion: string;
  policyRevision: string;
  completionJobId: string;
  upstreamId: string;
  /** The registry's canonical pskills-bundle digest. */
  registryArtifactDigest: Digest;
  /** The immutable digest and source identity verified by acquisition. */
  sourceArtifact: OpenClawSourceArtifactProof;
  /** The exact public install metadata bound to sourceArtifact. */
  entry: OpenClawFeedEntry;
  recordedAt: string;
}

/** Input accepted from the trusted import-completion/scan-completion boundary. */
export interface OpenClawSourceProofCompletion {
  tenantId: string;
  completionJobId: string;
  skillId: string;
  entry: OpenClawFeedEntry;
  sourceArtifact: OpenClawSourceArtifactProof;
}

export type OpenClawSourceProofStoreErrorCode =
  | 'invalid'
  | 'not-eligible'
  | 'equivocation'
  | 'capacity'
  | 'unavailable';

export class OpenClawSourceProofStoreError extends Error {
  readonly code: OpenClawSourceProofStoreErrorCode;

  constructor(code: OpenClawSourceProofStoreErrorCode, message: string) {
    super(message);
    this.name = 'OpenClawSourceProofStoreError';
    this.code = code;
  }
}

export interface OpenClawSourceProofStore {
  list(tenantId: string): Promise<readonly OpenClawSourceProofRecord[]>;
  recordFromCompletion(input: OpenClawSourceProofCompletion): Promise<OpenClawSourceProofRecord>;
}

export interface StateRepositoryOpenClawSourceProofStoreOptions {
  maxEntriesPerTenant?: number;
  maxBytesPerTenant?: number;
  now?: () => number;
  /** Host policy evaluator; the bounded fallback mirrors scanner evidence checks. */
  isCurrentPolicyApproved?: (state: RegistryState, skill: SkillVersion, now: number) => boolean;
}

interface OpenClawProofRepositoryState extends Record<string, unknown> {
  openClawSourceProofs?: Record<string, OpenClawSourceProofRecord>;
}

/**
 * Durable source-proof boundary. It never accepts a catalog row by itself:
 * recordFromCompletion requires a completed import job, an approved skill,
 * matching canonical artifact digest, current policy evidence, and a source
 * proof bound to exactly one install candidate.
 */
export class StateRepositoryOpenClawSourceProofStore implements OpenClawSourceProofStore {
  private readonly maxEntriesPerTenant: number;
  private readonly maxBytesPerTenant: number;
  private readonly now: () => number;
  private readonly isCurrentPolicyApproved: (state: RegistryState, skill: SkillVersion, now: number) => boolean;

  constructor(
    private readonly repository: StateRepository,
    options: StateRepositoryOpenClawSourceProofStoreOptions = {},
  ) {
    if (!repository || typeof repository.read !== 'function' || typeof repository.transaction !== 'function') {
      throw new OpenClawSourceProofStoreError('invalid', 'OpenClaw source-proof repository is invalid');
    }
    this.maxEntriesPerTenant = boundedInteger(options.maxEntriesPerTenant ?? 256, 1, MAX_PROOF_ENTRIES, 'source-proof entry limit');
    this.maxBytesPerTenant = boundedInteger(options.maxBytesPerTenant ?? MAX_PROOF_BYTES, 1, MAX_PROOF_BYTES, 'source-proof byte limit');
    this.now = options.now ?? Date.now;
    this.isCurrentPolicyApproved = options.isCurrentPolicyApproved ?? defaultCurrentPolicyApproved;
  }

  async list(tenantId: string): Promise<readonly OpenClawSourceProofRecord[]> {
    const normalizedTenant = safeTenantId(tenantId);
    let state: RegistryState;
    try {
      state = await this.repository.read(normalizedTenant);
    } catch {
      throw new OpenClawSourceProofStoreError('unavailable', 'OpenClaw source-proof storage is unavailable');
    }
    const extension = state as unknown as OpenClawProofRepositoryState;
    const stored = extension.openClawSourceProofs;
    if (stored === undefined) return [];
    if (!isRecord(stored)) {
      throw new OpenClawSourceProofStoreError('invalid', 'The persisted OpenClaw source-proof index is invalid');
    }
    const records = Object.values(stored).map((value) => validatePersistedProof(value, normalizedTenant));
    if (records.length > this.maxEntriesPerTenant || serializedBytes(records) > this.maxBytesPerTenant) {
      throw new OpenClawSourceProofStoreError('capacity', 'The persisted OpenClaw source-proof index is outside bounds');
    }
    return records
      .sort((left, right) => left.skillId.localeCompare(right.skillId))
      .map(cloneProof);
  }

  async recordFromCompletion(input: OpenClawSourceProofCompletion): Promise<OpenClawSourceProofRecord> {
    const tenantId = safeTenantId(input.tenantId);
    const completionJobId = safeIdentifier(input.completionJobId, MAX_JOB_ID_BYTES, 'completion job');
    const skillId = safeIdentifier(input.skillId, MAX_SKILL_ID_BYTES, 'skill');
    const recordedAt = canonicalTimestamp(this.now(), 'proof clock');
    try {
      return await this.repository.transaction(tenantId, (state) => {
        const extension = state as unknown as OpenClawProofRepositoryState;
        const existing = extension.openClawSourceProofs;
        if (existing !== undefined && !isRecord(existing)) {
          throw new OpenClawSourceProofStoreError('invalid', 'The persisted OpenClaw source-proof index is invalid');
        }
        const proofs = existing ?? {};
        const job = findCompletionJob(state.jobs, completionJobId, tenantId);
        if (!job || job.resourceId !== skillId) {
          throw new OpenClawSourceProofStoreError('not-eligible', 'The source proof is not bound to a completed import');
        }
        const skill = state.skills.find((candidate) => candidate.id === skillId && candidate.organizationId === tenantId);
        if (!skill || skill.state !== 'approved' || !skillCurrentlyApproved(state, skill, Date.parse(recordedAt), this.isCurrentPolicyApproved)) {
          throw new OpenClawSourceProofStoreError('not-eligible', 'The source proof is not bound to a current approved skill');
        }
        const request = job.import;
        if (!request || request.upstreamId !== job.upstream?.id || request.externalId === undefined || request.externalId !== input.entry.id) {
          throw new OpenClawSourceProofStoreError('not-eligible', 'The source proof is not bound to the completed source identity');
        }
        if (!job.artifact || job.artifact.digest !== skill.artifact.digest || !isDigest(skill.artifact.digest)) {
          throw new OpenClawSourceProofStoreError('not-eligible', 'The source proof is not bound to the canonical artifact');
        }
        const entry = validateProofEntry(input.entry, input.sourceArtifact);
        const normalized = normalizeOpenClawEntry(entry)[0];
        if (
          !normalized ||
          !openClawCompletionDescriptorMatches(job, entry, normalized, input.sourceArtifact) ||
          !sourceProofMatchesProvenance(skill, normalized, input.sourceArtifact)
        ) {
          throw new OpenClawSourceProofStoreError('not-eligible', 'The source proof is not bound to worker provenance');
        }
        const record: OpenClawSourceProofRecord = {
          proofVersion: 1,
          tenantId,
          skillId,
          skillVersion: skill.version,
          policyRevision: skill.policyRevision,
          completionJobId,
          upstreamId: request.upstreamId,
          registryArtifactDigest: skill.artifact.digest,
          sourceArtifact: cloneSourceArtifact(input.sourceArtifact),
          entry,
          recordedAt,
        };
        const key = proofStorageKey(skillId);
        const current = proofs[key];
        if (current !== undefined) {
          const validatedCurrent = validatePersistedProof(current, tenantId);
          if (!sameProofIdentity(validatedCurrent, record)) {
            throw new OpenClawSourceProofStoreError('equivocation', 'The source proof changed for an immutable skill');
          }
          return cloneProof(validatedCurrent);
        }
        if (Object.keys(proofs).length >= this.maxEntriesPerTenant) {
          throw new OpenClawSourceProofStoreError('capacity', 'The source-proof index is full');
        }
        const nextBytes = serializedBytes([...Object.values(proofs), record]);
        if (nextBytes > this.maxBytesPerTenant) {
          throw new OpenClawSourceProofStoreError('capacity', 'The source-proof index is full');
        }
        proofs[key] = record;
        extension.openClawSourceProofs = proofs;
        return cloneProof(record);
      });
    } catch (error) {
      if (error instanceof OpenClawSourceProofStoreError) throw error;
      throw new OpenClawSourceProofStoreError('unavailable', 'OpenClaw source-proof storage is unavailable');
    }
  }
}

export interface OpenClawCandidateProviderInput {
  tenantId: string;
  principal: Principal;
  state: RegistryState;
  metadata?: OpenClawMetadataSnapshot;
  signal: AbortSignal;
}

export interface OpenClawProjectedCandidate {
  skillId: string;
  skill: Pick<SkillVersion, 'state' | 'version' | 'artifact' | 'policyRevision'>;
  entry: OpenClawFeedEntry;
  sourceArtifact: OpenClawSourceArtifactProof;
}

export interface OpenClawCandidateProviderOptions {
  proofs: OpenClawSourceProofStore;
  canReadSkill?: (principal: Principal, skill: SkillVersion) => boolean;
  isCurrentPolicyApproved?: (state: RegistryState, skill: SkillVersion, now: number) => boolean;
  now?: () => number;
  maxMetadataAgeMs?: number;
}

export type OpenClawCandidateProvider = (
  input: OpenClawCandidateProviderInput,
) => Promise<readonly OpenClawProjectedCandidate[]>;

/** Build core's candidatesForTenant seam exclusively from persisted proofs. */
export function createOpenClawCandidateProvider(options: OpenClawCandidateProviderOptions): OpenClawCandidateProvider {
  if (!options || !options.proofs || typeof options.proofs.list !== 'function') {
    throw new OpenClawSourceProofStoreError('invalid', 'OpenClaw candidate proof dependencies are invalid');
  }
  const now = options.now ?? Date.now;
  const canReadSkill = options.canReadSkill ?? defaultCanReadSkill;
  const isCurrentPolicyApproved = options.isCurrentPolicyApproved ?? defaultCurrentPolicyApproved;
  const maxMetadataAgeMs = boundedInteger(options.maxMetadataAgeMs ?? DEFAULT_MAX_SNAPSHOT_AGE_MS, 0, MAX_SNAPSHOT_AGE_MS, 'metadata age');
  return async (input) => {
    if (input.signal.aborted || input.tenantId !== input.principal.organizationId) return [];
    const nowMs = boundedTimestamp(now(), 'candidate clock');
    if (input.metadata !== undefined && !usableMetadata(input.metadata, nowMs, maxMetadataAgeMs)) return [];
    const records = await options.proofs.list(input.tenantId);
    const projected: OpenClawProjectedCandidate[] = [];
    const seen = new Set<string>();
    for (const proof of records) {
      if (input.signal.aborted || projected.length >= 1_000 || seen.has(proof.skillId)) break;
      if (proof.tenantId !== input.tenantId) continue;
      const skill = input.state.skills.find((candidate) => candidate.id === proof.skillId && candidate.organizationId === input.tenantId);
      if (!skill || skill.version !== proof.skillVersion || skill.artifact.digest !== proof.registryArtifactDigest) continue;
      if (!canReadSkill(input.principal, skill) || !skillCurrentlyApproved(input.state, skill, nowMs, isCurrentPolicyApproved)) continue;
      let entry: OpenClawFeedEntry;
      try {
        entry = validateProofEntry(proof.entry, proof.sourceArtifact);
      } catch {
        continue;
      }
      const normalized = normalizeOpenClawEntry(entry)[0];
      if (!normalized || !sourceProofMatchesProvenance(skill, normalized, proof.sourceArtifact)) continue;
      const projectedEntry = input.metadata === undefined
        ? entry
        : metadataEntryProjection(input.metadata, entry);
      if (projectedEntry === undefined) continue;
      seen.add(proof.skillId);
      projected.push({
        skillId: skill.id,
        skill: {
          state: skill.state,
          version: skill.version,
          artifact: { ...skill.artifact },
          policyRevision: skill.policyRevision,
        },
        entry: projectedEntry,
        sourceArtifact: cloneSourceArtifact(proof.sourceArtifact),
      });
    }
    return projected;
  };
}

export interface OpenClawImportQueueRequest {
  tenantId: string;
  principal: Principal;
  feedId: string;
  feedSequence: number;
  feedDigest: Digest;
  sourceUrl: string;
  externalId: string;
  entry: OpenClawFeedEntry;
  signal: AbortSignal;
}

export interface OpenClawImportOperation {
  operationId: string;
  state: 'queued' | 'running';
}

export interface OpenClawImportQueue {
  enqueue(input: OpenClawImportQueueRequest): Promise<OpenClawImportOperation>;
}

export type OpenClawConsumerSelectionErrorCode =
  | 'aborted'
  | 'snapshot-unavailable'
  | 'snapshot-expired'
  | 'snapshot-invalid'
  | 'entry-not-found'
  | 'entry-invalid'
  | 'forbidden'
  | 'queue-unavailable';

export class OpenClawConsumerSelectionError extends Error {
  readonly code: OpenClawConsumerSelectionErrorCode;

  constructor(code: OpenClawConsumerSelectionErrorCode, message: string) {
    super(message);
    this.name = 'OpenClawConsumerSelectionError';
    this.code = code;
  }
}

export interface OpenClawTrustedSnapshotImportServiceOptions {
  store: OpenClawConsumerSnapshotStore;
  queue: OpenClawImportQueue;
  /**
   * Optional freshness gate for callers that combine refresh and selection in
   * one service. The callback must persist a new snapshot before returning;
   * stale/rejected results are never allowed to fall back to an older snapshot.
   * The registry route performs this gate itself when it owns the refresh.
   */
  refresh?: (signal: AbortSignal) => Promise<Pick<OpenClawMetadataPreviewResult, 'kind' | 'snapshot'>>;
  authorize?: (input: {
    principal: Principal;
    tenantId: string;
    entry: OpenClawFeedEntry;
    snapshot: OpenClawCacheSnapshot;
  }) => boolean | Promise<boolean>;
  now?: () => number;
  maxSnapshotAgeMs?: number;
}

/**
 * Selects one entry from a persisted, digest-checked feed snapshot and queues
 * the existing import/scanner path. It has no skill promotion or artifact
 * write operation, so metadata alone can never become an installable skill.
 */
export class OpenClawTrustedSnapshotImportService {
  private readonly store: OpenClawConsumerSnapshotStore;
  private readonly queue: OpenClawImportQueue;
  private readonly refresh: OpenClawTrustedSnapshotImportServiceOptions['refresh'];
  private readonly authorize: NonNullable<OpenClawTrustedSnapshotImportServiceOptions['authorize']>;
  private readonly now: () => number;
  private readonly maxSnapshotAgeMs: number;

  constructor(options: OpenClawTrustedSnapshotImportServiceOptions) {
    if (!options || !options.store || typeof options.store.read !== 'function' || !options.queue || typeof options.queue.enqueue !== 'function') {
      throw new OpenClawConsumerSelectionError('queue-unavailable', 'OpenClaw consumer dependencies are invalid');
    }
    this.store = options.store;
    this.queue = options.queue;
    this.refresh = options.refresh;
    this.authorize = options.authorize ?? ((input) => defaultCanReadEntry(input.principal, input.entry));
    this.now = options.now ?? Date.now;
    this.maxSnapshotAgeMs = boundedInteger(options.maxSnapshotAgeMs ?? DEFAULT_MAX_SNAPSHOT_AGE_MS, 0, MAX_SNAPSHOT_AGE_MS, 'snapshot age');
  }

  async selectAndQueue(input: {
    key: OpenClawConsumerCacheKey;
    externalId: string;
    principal: Principal;
    signal?: AbortSignal;
  }): Promise<OpenClawImportOperation> {
    const signal = input.signal;
    if (signal?.aborted) throw new OpenClawConsumerSelectionError('aborted', 'The operation was aborted');
    const key = normalizeConsumerKey(input.key);
    const externalId = safeExternalId(input.externalId);
    if (key.tenantId !== input.principal.organizationId) {
      throw new OpenClawConsumerSelectionError('forbidden', 'The consumer tenant is not authorized');
    }
    if (this.refresh) {
      let refreshed: Pick<OpenClawMetadataPreviewResult, 'kind' | 'snapshot'>;
      try {
        refreshed = await this.refresh(signal ?? new AbortController().signal);
      } catch {
        throw new OpenClawConsumerSelectionError('snapshot-unavailable', 'The trusted feed could not be refreshed');
      }
      if (
        (refreshed.kind !== 'accepted' && refreshed.kind !== 'not-modified') ||
        refreshed.snapshot === undefined
      ) {
        throw new OpenClawConsumerSelectionError('snapshot-unavailable', 'The trusted feed could not be refreshed');
      }
      if (signal?.aborted) throw new OpenClawConsumerSelectionError('aborted', 'The operation was aborted');
    }
    let snapshot: OpenClawCacheSnapshot | undefined;
    try {
      snapshot = await this.store.read(key);
    } catch {
      throw new OpenClawConsumerSelectionError('snapshot-invalid', 'The persisted feed snapshot is invalid');
    }
    if (snapshot === undefined) throw new OpenClawConsumerSelectionError('snapshot-unavailable', 'A trusted feed snapshot is unavailable');
    const nowMs = boundedTimestamp(this.now(), 'snapshot clock');
    const feed = await validateTrustedSnapshot(snapshot, key, nowMs, this.maxSnapshotAgeMs);
    if (signal?.aborted) throw new OpenClawConsumerSelectionError('aborted', 'The operation was aborted');
    const entries = feed.entries.filter((entry) => entry.id === externalId);
    if (entries.length !== 1) throw new OpenClawConsumerSelectionError('entry-not-found', 'The requested feed entry is unavailable');
    let entry: OpenClawFeedEntry;
    try {
      const candidates = normalizeOpenClawEntry(entries[0]!);
      if (entries[0]!.type !== 'skill' || entries[0]!.state !== 'available' || candidates.length !== 1) throw new Error('invalid entry');
      entry = sanitizeEntry(entries[0]!, candidates[0]!);
    } catch {
      throw new OpenClawConsumerSelectionError('entry-invalid', 'The requested feed entry is invalid');
    }
    let authorized = false;
    try {
      authorized = await this.authorize({ principal: input.principal, tenantId: key.tenantId, entry, snapshot });
    } catch {
      authorized = false;
    }
    if (!authorized) throw new OpenClawConsumerSelectionError('forbidden', 'The requested feed entry is not authorized');
    if (signal?.aborted) throw new OpenClawConsumerSelectionError('aborted', 'The operation was aborted');
    try {
      const operation = await this.queue.enqueue({
        tenantId: key.tenantId,
        principal: input.principal,
        feedId: key.feedId,
        feedSequence: feed.sequence,
        feedDigest: snapshot.sha256,
        sourceUrl: key.sourceUrl,
        externalId,
        entry,
        signal: signal ?? new AbortController().signal,
      });
      if (!operation || typeof operation.operationId !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/u.test(operation.operationId) || (operation.state !== 'queued' && operation.state !== 'running')) {
        throw new Error('invalid queue operation');
      }
      return { operationId: operation.operationId, state: operation.state };
    } catch (error) {
      if (error instanceof OpenClawConsumerSelectionError) throw error;
      throw new OpenClawConsumerSelectionError('queue-unavailable', 'The import queue is unavailable');
    }
  }
}

async function validateTrustedSnapshot(
  snapshot: OpenClawCacheSnapshot,
  key: OpenClawConsumerCacheKey,
  now: number,
  maxAgeMs: number,
): Promise<ReturnType<typeof parseOpenClawFeed>> {
  if (
    snapshot.sourceUrl !== key.sourceUrl ||
    !(snapshot.bytes instanceof Uint8Array) ||
    !Number.isFinite(snapshot.acceptedAt) ||
    !isDigest(snapshot.sha256) ||
    snapshot.etag !== `"${snapshot.sha256}"`
  ) throw new OpenClawConsumerSelectionError('snapshot-invalid', 'The persisted feed snapshot identity is invalid');
  if (snapshot.acceptedAt > now || now - snapshot.acceptedAt > maxAgeMs) {
    throw new OpenClawConsumerSelectionError('snapshot-expired', 'The persisted feed snapshot is expired');
  }
  const bytes = utf8Bytes(snapshot.body);
  if (bytes.byteLength !== snapshot.bytes.byteLength || !bytesEqual(bytes, snapshot.bytes)) {
    throw new OpenClawConsumerSelectionError('snapshot-invalid', 'The persisted feed snapshot bytes are invalid');
  }
  let digest: Digest;
  try {
    digest = await sha256(bytes);
  } catch {
    throw new OpenClawConsumerSelectionError('snapshot-invalid', 'The persisted feed snapshot digest is unavailable');
  }
  if (digest !== snapshot.sha256) throw new OpenClawConsumerSelectionError('snapshot-invalid', 'The persisted feed snapshot digest is invalid');
  try {
    const feed = parseOpenClawFeed(snapshot.body, {
      expectedFeedId: key.feedId,
      now,
      checkExpiry: true,
      maxBytes: OPENCLAW_MAX_BODY_BYTES,
    });
    const generatedAt = Date.parse(feed.generatedAt);
    const expiresAt = Date.parse(feed.expiresAt);
    if (feed.id !== key.feedId || feed.entries.length > 1_000 || !Number.isFinite(generatedAt) || !Number.isFinite(expiresAt) || generatedAt > now || expiresAt - generatedAt > MAX_SNAPSHOT_TTL_MS) throw new Error('invalid feed');
    return feed;
  } catch (error) {
    if (error instanceof OpenClawConsumerSelectionError) throw error;
    const message = error instanceof Error ? error.message : '';
    if (message.includes('expired')) throw new OpenClawConsumerSelectionError('snapshot-expired', 'The persisted feed snapshot is expired');
    throw new OpenClawConsumerSelectionError('snapshot-invalid', 'The persisted feed snapshot is invalid');
  }
}

function validateProofEntry(entry: OpenClawFeedEntry, sourceArtifact: OpenClawSourceArtifactProof): OpenClawFeedEntry {
  if (!entry || typeof entry !== 'object' || !entry.install || !Array.isArray(entry.install.candidates) || !sourceArtifact || sourceArtifact.verified !== true || !isDigest(sourceArtifact.digest) || typeof sourceArtifact.identity !== 'string' || new TextEncoder().encode(sourceArtifact.identity).byteLength > 2_048) {
    throw new OpenClawSourceProofStoreError('invalid', 'The source proof is invalid');
  }
  const matches = entry.install?.candidates?.filter((candidate) => candidate.integrity === sourceArtifact.digest) ?? [];
  if (matches.length !== 1) throw new OpenClawSourceProofStoreError('invalid', 'The source proof does not identify one install candidate');
  let normalized: OpenClawNormalizedCandidate;
  try {
    normalized = normalizeOpenClawCandidate(entry, matches[0]!);
  } catch {
    throw new OpenClawSourceProofStoreError('invalid', 'The source proof install candidate is invalid');
  }
  const expectedFormat = normalized.source.kind === 'public-clawhub' ? 'clawhub-skill-v1' : 'github-skill-folder-v1';
  const expectedIdentity = normalized.source.kind === 'public-clawhub'
    ? `${normalized.candidate.package}@${normalized.candidate.version}`
    : `${normalized.source.repo}:${normalized.source.path}@${normalized.source.commit}`;
  if (sourceArtifact.format !== expectedFormat || sourceArtifact.identity !== expectedIdentity) {
    throw new OpenClawSourceProofStoreError('invalid', 'The source proof identity is not bound to the candidate');
  }
  return sanitizeEntry(entry, normalized);
}

function sourceProofMatchesProvenance(
  skill: SkillVersion,
  normalized: OpenClawNormalizedCandidate,
  sourceArtifact: OpenClawSourceArtifactProof,
): boolean {
  const provenance = skill.provenance;
  // The external source digest and the registry's canonical bundle digest are
  // separate claims. Both must be present: accepting an omitted sourceDigest
  // would allow an older generic import to be re-labelled as a verified feed
  // proof after the fact.
  if (provenance.sourceDigest !== skill.artifact.digest) return false;
  if (normalized.source.kind === 'public-clawhub') {
    return provenance.externalId === normalized.candidate.package &&
      (provenance.path === undefined || provenance.path === normalized.candidate.package) &&
      provenance.externalDigest === sourceArtifact.digest &&
      provenance.sourceResolutionKind === 'snapshot' &&
      provenance.revision === normalized.candidate.version;
  }
  const provenancePath = provenance.skillPath ?? provenance.path;
  const provenanceOrigin = provenance.sourceProviderOrigin === undefined
    ? undefined
    : safeHostname(provenance.sourceProviderOrigin);
  return provenance.repository === normalized.source.repo &&
    provenancePath === normalized.source.path &&
    provenance.externalId === normalized.candidate.package &&
    provenance.resolvedCommit === normalized.source.commit &&
    provenance.sourceResolutionKind === 'github' &&
    provenanceOrigin === 'github.com' &&
    provenance.externalDigest === sourceArtifact.digest;
}

function safeHostname(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) return undefined;
    return url.hostname.toLowerCase().replace(/\.$/u, '');
  } catch {
    return undefined;
  }
}

function sanitizeEntry(entry: OpenClawFeedEntry, normalized: OpenClawNormalizedCandidate): OpenClawFeedEntry {
  return {
    type: entry.type,
    id: entry.id,
    title: entry.title,
    ...(entry.description === undefined ? {} : { description: entry.description }),
    ...(entry.icon === undefined ? {} : { icon: entry.icon }),
    version: entry.version,
    state: entry.state,
    ...(entry.featured === undefined ? {} : { featured: entry.featured }),
    ...(entry.featuredAt === undefined ? {} : { featuredAt: entry.featuredAt }),
    publisher: { id: entry.publisher.id, trust: entry.publisher.trust },
    install: {
      candidates: [{
        sourceRef: normalized.candidate.sourceRef,
        package: normalized.candidate.package,
        version: normalized.candidate.version,
        integrity: normalized.candidate.integrity,
        ...(normalized.candidate.github === undefined ? {} : { github: { ...normalized.candidate.github } }),
      }],
    },
  };
}

function findCompletionJob(jobs: readonly Job[], id: string, tenantId: string): Job | undefined {
  return jobs.find((job) =>
    job.id === id &&
    job.organizationId === tenantId &&
    job.kind === 'import' &&
    job.state === 'completed' &&
    hasOpenClawSourceDescriptor(openClawSourceOf(job)),
  );
}

function hasOpenClawSourceDescriptor(value: unknown): value is { source: Record<string, unknown>; entry: OpenClawFeedEntry } {
  return isRecord(value) && isRecord(value.source) && isRecord(value.entry);
}

function openClawSourceOf(job: Job): unknown {
  return (job as OpenClawJob).openclawSource;
}

function openClawCompletionDescriptorMatches(
  job: Job,
  entry: OpenClawFeedEntry,
  normalized: OpenClawNormalizedCandidate,
  sourceArtifact: OpenClawSourceArtifactProof,
): boolean {
  const rawDescriptor = openClawSourceOf(job);
  if (!hasOpenClawSourceDescriptor(rawDescriptor)) return false;
  const descriptor = rawDescriptor;
  let descriptorNormalized: OpenClawNormalizedCandidate;
  try {
    const candidates = normalizeOpenClawEntry(descriptor.entry);
    if (candidates.length !== 1 || !sourceMatchesNormalized(descriptor.source, candidates[0]!)) return false;
    descriptorNormalized = candidates[0]!;
  } catch {
    return false;
  }
  if (!sameNormalizedSource(descriptorNormalized, normalized)) return false;
  const descriptorArtifact = sourceArtifactForNormalized(descriptorNormalized);
  if (!sameSourceArtifact(descriptorArtifact, sourceArtifact)) return false;
  try {
    const descriptorEntry = validateProofEntry(descriptor.entry, descriptorArtifact);
    return JSON.stringify(descriptorEntry) === JSON.stringify(entry);
  } catch {
    return false;
  }
}

function sourceMatchesNormalized(
  descriptor: Record<string, unknown>,
  normalized: OpenClawNormalizedCandidate,
): boolean {
  if (normalized.source.kind === 'public-clawhub') {
    return descriptor.kind === 'public-clawhub' &&
      descriptor.sourceRef === 'public-clawhub' &&
      descriptor.packageName === normalized.source.packageName &&
      descriptor.version === normalized.source.version &&
      descriptor.artifactDigest === normalized.source.artifactDigest;
  }
  return descriptor.kind === 'public-github' &&
    descriptor.sourceRef === 'public-github' &&
    descriptor.repo === normalized.source.repo &&
    descriptor.path === normalized.source.path &&
    descriptor.commit === normalized.source.commit &&
    descriptor.contentHash === normalized.source.contentHash;
}

function sameNormalizedSource(
  left: OpenClawNormalizedCandidate,
  right: OpenClawNormalizedCandidate,
): boolean {
  if (left.source.kind !== right.source.kind) return false;
  if (left.source.kind === 'public-clawhub' && right.source.kind === 'public-clawhub') {
    return left.source.packageName === right.source.packageName &&
      left.source.version === right.source.version &&
      left.source.artifactDigest === right.source.artifactDigest;
  }
  if (left.source.kind === 'public-github' && right.source.kind === 'public-github') {
    return left.source.repo === right.source.repo &&
      left.source.path === right.source.path &&
      left.source.commit === right.source.commit &&
      left.source.contentHash === right.source.contentHash;
  }
  return false;
}

function sourceArtifactForNormalized(normalized: OpenClawNormalizedCandidate): OpenClawSourceArtifactProof {
  return normalized.source.kind === 'public-clawhub'
    ? {
      verified: true,
      digest: normalized.source.artifactDigest,
      format: 'clawhub-skill-v1',
      identity: `${normalized.source.packageName}@${normalized.source.version}`,
    }
    : {
      verified: true,
      digest: `sha256:${normalized.source.contentHash}`,
      format: 'github-skill-folder-v1',
      identity: `${normalized.source.repo}:${normalized.source.path}@${normalized.source.commit}`,
    };
}

function sameSourceArtifact(left: OpenClawSourceArtifactProof, right: OpenClawSourceArtifactProof): boolean {
  return left.verified === right.verified &&
    left.digest === right.digest &&
    left.format === right.format &&
    left.identity === right.identity;
}

function skillCurrentlyApproved(
  state: RegistryState,
  skill: SkillVersion,
  now: number,
  check: (state: RegistryState, skill: SkillVersion, now: number) => boolean,
): boolean {
  try {
    return check(state, skill, now);
  } catch {
    return false;
  }
}

function defaultCurrentPolicyApproved(state: RegistryState, skill: SkillVersion, now: number): boolean {
  if (skill.state !== 'approved' || skill.policyRevision !== state.policy.revision) return false;
  const relevant = state.scans.filter((scan) => skill.scanIds.includes(scan.id) && scan.artifactDigest === skill.artifact.digest && scan.policyRevision === state.policy.revision);
  const required = state.policy.scanners.filter((scanner) => scanner.mode === 'required');
  const enabled = state.policy.scanners.filter((scanner) => scanner.mode !== 'disabled');
  const latest = (scannerId: ScanResult['scannerId']) => {
    for (let index = relevant.length - 1; index >= 0; index -= 1) {
      if (relevant[index]?.scannerId === scannerId) return relevant[index];
    }
    return undefined;
  };
  for (const scanner of required) {
    const result = latest(scanner.id);
    if (!result || result.status !== 'completed' || evidenceExpired(result, state.policy.evidenceMaxAgeSeconds, now) || result.coverage.filesEnumerated <= 0 || result.coverage.filesAnalyzed <= 0 || result.coverage.filesSkipped > 0 || result.coverage.filesUnsupported > 0 || result.coverage.filesAnalyzed !== result.coverage.filesEnumerated || result.findings.some((finding) => scanner.blockSeverities.includes(finding.severity))) return false;
  }
  if (enabled.length === 0) return state.policy.allowUnscanned;
  if (!state.policy.allowUnscanned && enabled.some((scanner) => latest(scanner.id) === undefined)) return false;
  return !enabled.some((scanner) => {
    const result = latest(scanner.id);
    if (result?.status !== undefined && result.status !== 'completed') return true;
    if (result?.status === 'completed' && result.findings.some((finding) => scanner.blockSeverities.includes(finding.severity))) return true;
    return false;
  });
}

function evidenceExpired(result: ScanResult, maxAgeSeconds: number, now: number): boolean {
  const createdAt = Date.parse(result.createdAt);
  return !Number.isFinite(createdAt) || createdAt > now || now - createdAt > maxAgeSeconds * 1_000;
}

function defaultCanReadSkill(principal: Principal, skill: SkillVersion): boolean {
  if (principal.roles.includes('owner') || principal.roles.includes('admin')) return true;
  if (!principal.roles.includes('reader') && !principal.roles.includes('publisher')) return false;
  if (!principal.namespaces || principal.namespaces.length === 0) return true;
  const namespace = skill.name.startsWith('@') ? skill.name.split('/')[0]! : skill.name;
  return principal.namespaces.some((candidate) => candidate === namespace || candidate === namespace.slice(1));
}

function defaultCanReadEntry(principal: Principal, entry: OpenClawFeedEntry): boolean {
  if (principal.roles.includes('owner') || principal.roles.includes('admin')) return true;
  if (!principal.roles.includes('reader') && !principal.roles.includes('publisher')) return false;
  if (!principal.namespaces || principal.namespaces.length === 0) return true;
  const namespace = entry.id.startsWith('@') ? entry.id.split('/')[0]! : entry.publisher.id;
  return principal.namespaces.some((candidate) => candidate === namespace || candidate === namespace.slice(1));
}

function usableMetadata(snapshot: OpenClawMetadataSnapshot, now: number, maxAgeMs: number): boolean {
  const generatedAt = Date.parse(snapshot.feed.generatedAt);
  const expiresAt = Date.parse(snapshot.feed.expiresAt);
  return snapshot.feed.id === OPENCLAW_OFFICIAL_FEED_ID &&
    Number.isFinite(generatedAt) && Number.isFinite(expiresAt) &&
    expiresAt > now && snapshot.acceptedAt <= now && now - snapshot.acceptedAt <= maxAgeMs;
}

function metadataEntryProjection(snapshot: OpenClawMetadataSnapshot, entry: OpenClawFeedEntry): OpenClawFeedEntry | undefined {
  const metadataEntry = snapshot.feed.entries.find((candidate) =>
    candidate.id === entry.id &&
    candidate.version === entry.version &&
    candidate.type === entry.type &&
    candidate.install.candidates.some((item) => entry.install.candidates.some((selected) =>
      item.sourceRef === selected.sourceRef &&
      item.package === selected.package &&
      item.version === selected.version &&
      item.integrity === selected.integrity &&
      JSON.stringify(item.github) === JSON.stringify(selected.github),
    )),
  );
  // A current trusted catalog row is an eligibility gate. The proof remains
  // the source-integrity authority, while current display/state claims are
  // projected from the matched row. Every state other than available is
  // withheld from publication and selection.
  if (!metadataEntry || metadataEntry.state !== 'available') return undefined;
  return {
    type: metadataEntry.type,
    id: metadataEntry.id,
    title: metadataEntry.title,
    ...(metadataEntry.description === undefined ? {} : { description: metadataEntry.description }),
    ...(metadataEntry.icon === undefined ? {} : { icon: metadataEntry.icon }),
    version: metadataEntry.version,
    state: metadataEntry.state,
    ...(metadataEntry.featured === undefined ? {} : { featured: metadataEntry.featured }),
    ...(metadataEntry.featuredAt === undefined ? {} : { featuredAt: metadataEntry.featuredAt }),
    publisher: { ...metadataEntry.publisher },
    // Never replace the immutable verified candidate with catalog-only data.
    install: { candidates: entry.install.candidates.map((candidate) => ({
      sourceRef: candidate.sourceRef,
      package: candidate.package,
      version: candidate.version,
      integrity: candidate.integrity,
      ...(candidate.github === undefined ? {} : { github: { ...candidate.github } }),
    })) },
  };
}

function validatePersistedProof(value: unknown, tenantId: string): OpenClawSourceProofRecord {
  if (!isRecord(value) || value.proofVersion !== 1 || value.tenantId !== tenantId || typeof value.skillId !== 'string' || typeof value.skillVersion !== 'string' || typeof value.policyRevision !== 'string' || typeof value.completionJobId !== 'string' || typeof value.upstreamId !== 'string' || !isDigest(value.registryArtifactDigest) || typeof value.recordedAt !== 'string') {
    throw new OpenClawSourceProofStoreError('invalid', 'The persisted OpenClaw source proof is invalid');
  }
  let entry: OpenClawFeedEntry;
  try {
    entry = validateProofEntry(value.entry as OpenClawFeedEntry, value.sourceArtifact as OpenClawSourceArtifactProof);
  } catch (error) {
    if (error instanceof OpenClawSourceProofStoreError) throw error;
    throw new OpenClawSourceProofStoreError('invalid', 'The persisted OpenClaw source proof is invalid');
  }
  const recordedAt = Date.parse(value.recordedAt);
  if (!Number.isFinite(recordedAt)) throw new OpenClawSourceProofStoreError('invalid', 'The persisted OpenClaw source proof timestamp is invalid');
  return {
    proofVersion: 1,
    tenantId,
    skillId: value.skillId,
    skillVersion: value.skillVersion,
    policyRevision: value.policyRevision,
    completionJobId: value.completionJobId,
    upstreamId: value.upstreamId,
    registryArtifactDigest: value.registryArtifactDigest,
    sourceArtifact: cloneSourceArtifact(value.sourceArtifact as OpenClawSourceArtifactProof),
    entry,
    recordedAt: new Date(recordedAt).toISOString(),
  };
}

function sameProofIdentity(left: OpenClawSourceProofRecord, right: OpenClawSourceProofRecord): boolean {
  return left.tenantId === right.tenantId &&
    left.skillId === right.skillId &&
    left.skillVersion === right.skillVersion &&
    left.upstreamId === right.upstreamId &&
    left.registryArtifactDigest === right.registryArtifactDigest &&
    JSON.stringify(left.sourceArtifact) === JSON.stringify(right.sourceArtifact) &&
    JSON.stringify(left.entry) === JSON.stringify(right.entry);
}

function cloneProof(value: OpenClawSourceProofRecord): OpenClawSourceProofRecord {
  return {
    ...value,
    sourceArtifact: cloneSourceArtifact(value.sourceArtifact),
    entry: sanitizeEntry(value.entry, normalizeOpenClawEntry(value.entry)[0]!),
  };
}

function cloneSourceArtifact(value: OpenClawSourceArtifactProof): OpenClawSourceArtifactProof {
  return { verified: true, digest: value.digest, format: value.format, identity: value.identity };
}

function proofStorageKey(skillId: string): string {
  return encodeURIComponent(skillId);
}

function normalizeConsumerKey(value: OpenClawConsumerCacheKey): OpenClawConsumerCacheKey {
  if (!value || typeof value !== 'object') {
    throw new OpenClawConsumerSelectionError('snapshot-invalid', 'The feed identity is invalid');
  }
  let tenantId: string;
  let feedId: string;
  try {
    tenantId = safeTenantId(value.tenantId);
    feedId = safeConsumerIdentifier(value.feedId, 512, 'feed');
  } catch {
    throw new OpenClawConsumerSelectionError('snapshot-invalid', 'The feed identity is invalid');
  }
  let sourceUrl: URL;
  try {
    sourceUrl = new URL(value.sourceUrl);
  } catch {
    throw new OpenClawConsumerSelectionError('snapshot-invalid', 'The feed source identity is invalid');
  }
  if (sourceUrl.protocol !== 'https:' || sourceUrl.username || sourceUrl.password || sourceUrl.search || sourceUrl.hash) {
    throw new OpenClawConsumerSelectionError('snapshot-invalid', 'The feed source identity is invalid');
  }
  return { tenantId, feedId, sourceUrl: sourceUrl.href };
}

function safeConsumerIdentifier(value: string, maxBytes: number, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || new TextEncoder().encode(value).byteLength > maxBytes || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

function safeExternalId(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048 || /[\u0000-\u001f\u007f?#%\\]/u.test(value) || value.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new OpenClawConsumerSelectionError('entry-not-found', 'The requested feed identity is invalid');
  }
  return value;
}

function safeTenantId(value: string): string {
  if (typeof value !== 'string' || value.trim() === '' || new TextEncoder().encode(value).byteLength > MAX_TENANT_ID_BYTES || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new OpenClawSourceProofStoreError('invalid', 'The tenant identity is invalid');
  }
  return value;
}

function safeIdentifier(value: string, maxBytes: number, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || new TextEncoder().encode(value).byteLength > maxBytes || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new OpenClawSourceProofStoreError('invalid', `The ${label} identity is invalid`);
  }
  return value;
}

function isDigest(value: unknown): value is Digest {
  return typeof value === 'string' && SHA256_RE.test(value);
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new OpenClawSourceProofStoreError('invalid', `The ${label} is outside supported bounds`);
  return value;
}

function boundedTimestamp(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 8.64e15) throw new OpenClawSourceProofStoreError('invalid', `The ${label} is invalid`);
  return value;
}

function canonicalTimestamp(value: number, label: string): string {
  return new Date(boundedTimestamp(value, label)).toISOString();
}

function serializedBytes(value: unknown): number {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) return Number.MAX_SAFE_INTEGER;
    return new TextEncoder().encode(encoded).byteLength;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
  return true;
}
