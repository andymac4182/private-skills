import type { StateRepository } from '../../contracts/src/index.ts';
import {
  OpenClawFeedCache,
  OpenClawRequestError,
  OpenClawValidationError,
  parseOpenClawFeed,
  sha256,
  isOpenClawFeedFresh,
  isOpenClawClawHubSkillsCompatibilityIdentity,
  isValidOpenClawTransportEtag,
  OPENCLAW_CLAWHUB_SKILLS_COMPATIBILITY_PROFILE,
  OPENCLAW_CLAWHUB_SKILLS_FEED_ID,
  validateOpenClawFeedUrl,
  OPENCLAW_DEFAULT_MAX_BODY_BYTES,
  OPENCLAW_DEFAULT_MAX_STALE_MS,
  OPENCLAW_MAX_BODY_BYTES,
  OPENCLAW_MAX_STALE_MS,
  type OpenClawCacheSnapshot,
  type OpenClawFeedCompatibilityProfile,
  type OpenClawFeedErrorCode,
  type OpenClawFeedRefreshRequest,
  type OpenClawFetch,
  type OpenClawRefreshResult,
  type OpenClawSha256,
} from '../../openclaw/src/index.ts';

const MAX_FEED_ID_BYTES = 512;
const MAX_SOURCE_URL_BYTES = 4 * 1024;
const DEFAULT_MAX_CACHE_KEYS = 32;
const MAX_CACHE_KEYS = 256;
const DEFAULT_MAX_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/u;

export interface OpenClawConsumerCacheKey {
  tenantId: string;
  feedId: string;
  sourceUrl: string;
}

export interface OpenClawConsumerSnapshotStore {
  read(key: OpenClawConsumerCacheKey): Promise<OpenClawCacheSnapshot | undefined>;
  put(key: OpenClawConsumerCacheKey, snapshot: OpenClawCacheSnapshot): Promise<void>;
  clear(key: OpenClawConsumerCacheKey): Promise<void>;
}

export type OpenClawConsumerSnapshotStoreErrorCode =
  | 'invalid'
  | 'identity-mismatch'
  | 'replay'
  | 'equivocation'
  | 'capacity'
  | 'unavailable';

export class OpenClawConsumerSnapshotStoreError extends Error {
  readonly code: OpenClawConsumerSnapshotStoreErrorCode;

  constructor(code: OpenClawConsumerSnapshotStoreErrorCode, message: string) {
    super(message);
    this.name = 'OpenClawConsumerSnapshotStoreError';
    this.code = code;
  }
}

export interface StateRepositoryOpenClawConsumerSnapshotStoreOptions {
  maxEntriesPerTenant?: number;
  maxBytesPerTenant?: number;
  maxBodyBytes?: number;
  /** Clock used at the durable transaction admission boundary. */
  now?: () => number;
}

interface PersistedConsumerSnapshot {
  feedId: string;
  sourceUrl: string;
  feedSequence: number;
  acceptedAt: number;
  body: string;
  bytesBase64: string;
  bytesLength: number;
  sha256: OpenClawSha256;
  etag: string;
  compatibilityProfile?: OpenClawFeedCompatibilityProfile;
  transportEtag?: string;
  lastModified?: string;
}

interface ConsumerRepositoryState extends Record<string, unknown> {
  openClawConsumerSnapshots?: Record<string, PersistedConsumerSnapshot>;
}

/**
 * StateRepository-backed last-known-good consumer snapshots.  StateRepository
 * already provides per-tenant atomic transactions; this adapter stores bytes
 * as bounded base64 JSON and keeps feed/origin identity in every record.
 */
export class StateRepositoryOpenClawConsumerSnapshotStore implements OpenClawConsumerSnapshotStore {
  private readonly maxEntriesPerTenant: number;
  private readonly maxBytesPerTenant: number;
  private readonly maxBodyBytes: number;
  private readonly now: () => number;

  constructor(
    private readonly repository: StateRepository,
    options: StateRepositoryOpenClawConsumerSnapshotStoreOptions = {},
  ) {
    if (!repository || typeof repository.read !== 'function' || typeof repository.transaction !== 'function') {
      throw new OpenClawConsumerSnapshotStoreError('invalid', 'OpenClaw consumer state repository is invalid');
    }
    this.maxEntriesPerTenant = boundedInteger(
      options.maxEntriesPerTenant ?? DEFAULT_MAX_CACHE_KEYS,
      1,
      MAX_CACHE_KEYS,
      'cache entry limit',
    );
    this.maxBytesPerTenant = boundedInteger(
      options.maxBytesPerTenant ?? DEFAULT_MAX_CACHE_BYTES,
      1,
      MAX_CACHE_BYTES,
      'cache byte limit',
    );
    this.maxBodyBytes = boundedInteger(
      options.maxBodyBytes ?? OPENCLAW_DEFAULT_MAX_BODY_BYTES,
      1,
      OPENCLAW_MAX_BODY_BYTES,
      'cache body limit',
    );
    this.now = options.now ?? Date.now;
  }

  async read(key: OpenClawConsumerCacheKey): Promise<OpenClawCacheSnapshot | undefined> {
    const normalized = normalizeCacheKey(key);
    const state = await this.repository.read(normalized.tenantId);
    const configured = (state as unknown as ConsumerRepositoryState).openClawConsumerSnapshots;
    if (configured !== undefined && !isRecord(configured)) {
      throw new OpenClawConsumerSnapshotStoreError('invalid', 'The persisted consumer snapshot index is invalid');
    }
    const persisted = configured?.[storageKey(normalized)];
    return persisted === undefined ? undefined : this.fromPersisted(normalized, persisted);
  }

  async put(key: OpenClawConsumerCacheKey, snapshot: OpenClawCacheSnapshot): Promise<void> {
    const normalized = normalizeCacheKey(key);
    const validated = await validateSnapshot(normalized, snapshot, this.maxBodyBytes);
    const isFreshAtAdmission = (now: number): boolean =>
      isOpenClawFeedFresh(validated.feed, normalized.sourceUrl, now, validated.compatibilityProfile) &&
      validated.acceptedAt <= now;
    if (!isFreshAtAdmission(this.now())) {
      throw new OpenClawConsumerSnapshotStoreError('invalid', 'The consumer snapshot is no longer fresh');
    }
    const persisted = toPersistedSnapshot(normalized, validated);
    await this.repository.transaction(normalized.tenantId, (state) => {
      // Validate again while the StateRepository transaction owns the tenant
      // row. A feed can cross its effective expiry between validation and
      // this synchronous updater, so a pre-transaction check is not enough.
      if (!isFreshAtAdmission(this.now())) {
        throw new OpenClawConsumerSnapshotStoreError('invalid', 'The consumer snapshot is no longer fresh');
      }
      const extension = state as unknown as ConsumerRepositoryState;
      const existing = extension.openClawConsumerSnapshots;
      if (existing !== undefined && !isRecord(existing)) {
        throw new OpenClawConsumerSnapshotStoreError('invalid', 'The persisted consumer snapshot index is invalid');
      }
      const snapshots = existing ?? {};
      const storage = storageKey(normalized);
      const current = snapshots[storage];
      if (current !== undefined && current.feedSequence > persisted.feedSequence) {
        throw new OpenClawConsumerSnapshotStoreError('replay', 'The consumer feed snapshot is older than the stored snapshot');
      }
      if (current !== undefined && current.feedSequence === persisted.feedSequence) {
        if (samePersistedSnapshot(current, persisted)) {
          // The body, digest, and canonical ETag define the accepted
          // sequence. A CDN representation may rotate its bounded transport
          // validators without changing that acceptance or extending its
          // local freshness window. Preserve acceptedAt when either validator
          // changes; an identical revalidation may still refresh it.
          const transportChanged = current.transportEtag !== persisted.transportEtag ||
            current.lastModified !== persisted.lastModified;
          snapshots[storage] = transportChanged
            ? { ...persisted, acceptedAt: current.acceptedAt }
            : persisted;
          extension.openClawConsumerSnapshots = snapshots;
          return;
        }
        throw new OpenClawConsumerSnapshotStoreError('equivocation', 'The consumer feed changed at the same sequence');
      }
      if (current === undefined && Object.keys(snapshots).length >= this.maxEntriesPerTenant) {
        throw new OpenClawConsumerSnapshotStoreError('capacity', 'The consumer snapshot cache is full');
      }
      const currentBytes = Object.values(snapshots).reduce((sum, value) => sum + boundedPersistedLength(value), 0);
      const nextBytes = currentBytes - (current === undefined ? 0 : boundedPersistedLength(current)) + persisted.bytesLength;
      if (nextBytes > this.maxBytesPerTenant) {
        throw new OpenClawConsumerSnapshotStoreError('capacity', 'The consumer snapshot cache is full');
      }
      snapshots[storage] = persisted;
      extension.openClawConsumerSnapshots = snapshots;
    });
  }

  async clear(key: OpenClawConsumerCacheKey): Promise<void> {
    const normalized = normalizeCacheKey(key);
    await this.repository.transaction(normalized.tenantId, (state) => {
      const extension = state as unknown as ConsumerRepositoryState;
      const snapshots = extension.openClawConsumerSnapshots;
      if (!snapshots) return;
      if (!isRecord(snapshots)) {
        throw new OpenClawConsumerSnapshotStoreError('invalid', 'The persisted consumer snapshot index is invalid');
      }
      delete snapshots[storageKey(normalized)];
      if (Object.keys(snapshots).length === 0) delete extension.openClawConsumerSnapshots;
    });
  }

  private async fromPersisted(
    key: OpenClawConsumerCacheKey,
    persisted: PersistedConsumerSnapshot,
  ): Promise<OpenClawCacheSnapshot> {
    if (
      !persisted ||
      typeof persisted !== 'object' ||
      persisted.feedId !== key.feedId ||
      persisted.sourceUrl !== key.sourceUrl ||
      !Number.isSafeInteger(persisted.bytesLength) ||
      persisted.bytesLength < 0 ||
      persisted.bytesLength > this.maxBodyBytes
    ) {
      throw new OpenClawConsumerSnapshotStoreError('identity-mismatch', 'The persisted consumer snapshot identity is invalid');
    }
    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(persisted.bytesBase64, this.maxBodyBytes);
    } catch {
      throw new OpenClawConsumerSnapshotStoreError('invalid', 'The persisted consumer snapshot bytes are invalid');
    }
    if (bytes.byteLength !== persisted.bytesLength) {
      throw new OpenClawConsumerSnapshotStoreError('invalid', 'The persisted consumer snapshot size is invalid');
    }
    try {
      const snapshot = await validateSnapshot(key, {
        feed: parseOpenClawFeed(persisted.body, { expectedFeedId: key.feedId, checkExpiry: false, maxBytes: this.maxBodyBytes }),
        body: persisted.body,
        bytes,
        sha256: persisted.sha256,
        etag: persisted.etag,
        ...(persisted.compatibilityProfile === undefined ? {} : { compatibilityProfile: persisted.compatibilityProfile }),
        ...(persisted.transportEtag === undefined ? {} : { transportEtag: persisted.transportEtag }),
        ...(persisted.lastModified === undefined ? {} : { lastModified: persisted.lastModified }),
        acceptedAt: persisted.acceptedAt,
        sourceUrl: persisted.sourceUrl,
      }, this.maxBodyBytes);
      if (snapshot.feed.sequence !== persisted.feedSequence) {
        throw new OpenClawConsumerSnapshotStoreError('invalid', 'The persisted consumer snapshot sequence is invalid');
      }
      return snapshot;
    } catch (error) {
      if (error instanceof OpenClawConsumerSnapshotStoreError) throw error;
      throw new OpenClawConsumerSnapshotStoreError('invalid', 'The persisted consumer snapshot is invalid');
    }
  }
}

export interface PersistentOpenClawFeedCacheOptions {
  store: OpenClawConsumerSnapshotStore;
  tenantId: string;
  maxBodyBytes?: number;
  maxStaleMs?: number;
  maxFeedKeys?: number;
  now?: () => number;
}

/**
 * Consumer cache facade that hydrates a bounded in-memory parser/cache from
 * StateRepository snapshots. The pinned OpenClawFeedCache remains the only
 * feed parser and refresh state machine; this layer only supplies durable
 * bytes, validators, expiry, and replay/equivocation retention.
 */
export class PersistentOpenClawFeedCache {
  private readonly tenantId: string;
  private readonly store: OpenClawConsumerSnapshotStore;
  private readonly maxBodyBytes: number;
  private readonly maxStaleMs: number;
  private readonly maxFeedKeys: number;
  private readonly now: () => number;
  private readonly caches = new Map<string, OpenClawFeedCache>();
  private readonly refreshTails = new Map<string, Promise<void>>();

  constructor(options: PersistentOpenClawFeedCacheOptions) {
    this.tenantId = safeTenantId(options.tenantId);
    if (!options.store || typeof options.store.read !== 'function' || typeof options.store.put !== 'function') {
      throw new OpenClawConsumerSnapshotStoreError('invalid', 'OpenClaw consumer snapshot storage is invalid');
    }
    this.store = options.store;
    this.maxBodyBytes = boundedInteger(options.maxBodyBytes ?? OPENCLAW_DEFAULT_MAX_BODY_BYTES, 1, OPENCLAW_MAX_BODY_BYTES, 'cache body limit');
    this.maxStaleMs = boundedInteger(options.maxStaleMs ?? OPENCLAW_DEFAULT_MAX_STALE_MS, 0, OPENCLAW_MAX_STALE_MS, 'cache stale limit');
    this.maxFeedKeys = boundedInteger(options.maxFeedKeys ?? DEFAULT_MAX_CACHE_KEYS, 1, MAX_CACHE_KEYS, 'cache feed limit');
    this.now = options.now ?? Date.now;
  }

  async refresh(request: OpenClawFeedRefreshRequest): Promise<OpenClawRefreshResult> {
    let key: OpenClawConsumerCacheKey;
    try {
      key = normalizeCacheKey({
        tenantId: this.tenantId,
        feedId: request.expectedFeedId,
        sourceUrl: validateOpenClawFeedUrl(request.url, request.allowedOrigins).href,
      });
    } catch {
      return { kind: 'rejected', error: 'invalid-url' };
    }
    const cacheKey = storageKey(key);
    const previous = this.refreshTails.get(cacheKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.refreshTails.set(cacheKey, gate);
    await previous;
    try {
      return await this.refreshInternal(key, request);
    } catch {
      // The adapter must never expose a transport or storage exception. A
      // durable read/put failure is handled inside refreshInternal; this is a
      // final guard for injected fetchers and malformed host implementations.
      return { kind: 'rejected', error: 'fetch-failed' };
    } finally {
      release();
      if (this.refreshTails.get(cacheKey) === gate) this.refreshTails.delete(cacheKey);
    }
  }

  private async refreshInternal(
    key: OpenClawConsumerCacheKey,
    request: OpenClawFeedRefreshRequest,
  ): Promise<OpenClawRefreshResult> {
    let cache = this.caches.get(storageKey(key));
    if (cache === undefined) {
      if (this.caches.size >= this.maxFeedKeys) return { kind: 'rejected', error: 'fetch-failed' };
      cache = new OpenClawFeedCache({
        maxBodyBytes: this.maxBodyBytes,
        maxStaleMs: this.maxStaleMs,
        now: this.now,
      });
      this.caches.set(storageKey(key), cache);
    }
    let durable: OpenClawCacheSnapshot | undefined;
    try {
      durable = await this.store.read(key);
    } catch {
      cache.clear();
      return { kind: 'rejected', error: 'fetch-failed' };
    }
    // The repository is the authoritative high-water mark. Never let a
    // process-local snapshot answer after restart or after another instance
    // advanced the durable sequence.
    cache.clear();
    const usableDurable = durable === undefined ? undefined : usableSnapshot(durable, this.now(), this.maxStaleMs);
    let durableNotModified = false;
    const fetcher = request.fetcher ?? globalThis.fetch;
    const wrappedFetcher: OpenClawFetch | undefined = typeof fetcher === 'function'
      ? async (input, init) => {
          const headers = new Headers(init?.headers);
          if (durable !== undefined) {
            headers.set('if-none-match', durable.transportEtag ?? durable.etag);
            if (durable.lastModified === undefined) headers.delete('if-modified-since');
            else headers.set('if-modified-since', durable.lastModified);
          }
          const response = await fetcher(input, { ...init, headers });
          // Do not turn a redirected 304 into a local response. The pinned
          // cache must observe the redirect marker and reject/fallback with
          // the redirect error.
          if (response.redirected) return response;
          if (response.url !== '' && response.url !== key.sourceUrl) {
            throw new OpenClawRequestError('redirected');
          }
          if (response.status === 304 && usableDurable !== undefined && !request.signal?.aborted && validatorsMatch(response, usableDurable, request.compatibilityProfile)) {
            // Keep the 304 response intact. The durable snapshot is selected
            // below only after the worker's redirect/validator checks run.
            durableNotModified = true;
          }
          return response;
        }
      : undefined;
    const result = await cache.refresh({ ...request, fetcher: wrappedFetcher });
    const canUseDurable304 = durableNotModified &&
      usableDurable !== undefined &&
      result.kind === 'rejected' &&
      result.error === 'no-cache' &&
      result.status === 304 &&
      canServeDurable304(usableDurable, request, this.maxBodyBytes, this.now(), this.maxStaleMs);
    if (canUseDurable304) {
      if (request.signal?.aborted) return { kind: 'rejected', status: 304, error: 'aborted' };
      const refreshed = cloneSnapshot(usableDurable);
      refreshed.acceptedAt = this.now();
      try {
        await this.store.put(key, refreshed);
      } catch (error) {
        cache.clear();
        const authoritative = await readAuthoritativeSnapshot(this.store, key, durable, usableDurable, this.now(), this.maxStaleMs);
        return authoritativeResult(authoritative.usable, 304, projectStoreError(error));
      }
      if (request.signal?.aborted) return { kind: 'rejected', status: 304, error: 'aborted' };
      const admitted = await confirmPersistedSnapshot(this.store, key, refreshed, request, this.maxBodyBytes, this.maxStaleMs, this.now);
      if (!admitted.ok) {
        cache.clear();
        return { kind: 'rejected', status: 304, error: admitted.error };
      }
      return { kind: 'not-modified', status: 304, snapshot: admitted.snapshot };
    }
    if (result.kind === 'accepted' || result.kind === 'not-modified') {
      const relation = durable === undefined ? 'newer' : compareSnapshots(result.snapshot, durable);
      if (relation === 'older' || relation === 'equivocation') {
        cache.clear();
        return authoritativeResult(usableDurable, result.status, relation === 'older' ? 'replay' : 'equivocation');
      }
      try {
        await this.store.put(key, result.snapshot);
      } catch (error) {
        cache.clear();
        // Another process may have won the compare-and-swap between read and
        // put. Re-read before deciding whether the candidate can be exposed.
        const authoritative = await readAuthoritativeSnapshot(this.store, key, durable, usableDurable, this.now(), this.maxStaleMs);
        return authoritativeResult(authoritative.usable, result.status, projectStoreError(error));
      }
      const admitted = await confirmPersistedSnapshot(this.store, key, result.snapshot, request, this.maxBodyBytes, this.maxStaleMs, this.now);
      if (!admitted.ok) {
        cache.clear();
        return { kind: 'rejected', status: result.status, error: admitted.error };
      }
      return { ...result, snapshot: admitted.snapshot };
    }
    if (result.snapshot !== undefined && durable !== undefined) {
      const relation = compareSnapshots(result.snapshot, durable);
      if (relation === 'older' || relation === 'equivocation') {
        cache.clear();
        return authoritativeResult(usableDurable, result.status, relation === 'older' ? 'replay' : 'equivocation');
      }
    }
    if (
      result.snapshot === undefined &&
      usableDurable !== undefined &&
      canFallbackToDurable(result.error)
    ) {
      return {
        kind: 'stale',
        ...(result.status === undefined ? {} : { status: result.status }),
        snapshot: cloneSnapshot(usableDurable),
        error: result.error,
      };
    }
    return result;
  }
}

type SnapshotRelation = 'older' | 'same' | 'newer' | 'equivocation';

function compareSnapshots(
  candidate: OpenClawCacheSnapshot,
  durable: OpenClawCacheSnapshot,
): SnapshotRelation {
  if (candidate.feed.sequence < durable.feed.sequence) return 'older';
  if (candidate.feed.sequence > durable.feed.sequence) return 'newer';
  return candidate.sha256 === durable.sha256 ? 'same' : 'equivocation';
}

function canServeDurable304(
  snapshot: OpenClawCacheSnapshot,
  request: OpenClawFeedRefreshRequest,
  maxBodyBytes: number,
  now: number,
  maxStaleMs: number,
): boolean {
  return canServeSnapshot(snapshot, request, maxBodyBytes, now, maxStaleMs);
}

function canServeSnapshot(
  snapshot: OpenClawCacheSnapshot,
  request: OpenClawFeedRefreshRequest,
  maxBodyBytes: number,
  now: number,
  maxStaleMs: number,
): boolean {
  if (request.signal?.aborted) return false;
  if (request.expectedSha256 !== undefined && !matchesExpectedSha256(snapshot.sha256, request.expectedSha256)) return false;
  if (request.maxBodyBytes !== undefined && (!Number.isSafeInteger(request.maxBodyBytes) || request.maxBodyBytes < 1)) return false;
  const limit = Math.min(request.maxBodyBytes ?? maxBodyBytes, maxBodyBytes);
  if (snapshot.bytes.byteLength > limit) return false;
  return usableSnapshot(snapshot, now, maxStaleMs) !== undefined;
}

function matchesExpectedSha256(actual: string, expected: string): boolean {
  const normalized = expected.startsWith('sha256:') ? expected : `sha256:${expected}`;
  return SHA256_RE.test(normalized) && normalized === actual;
}

function authoritativeResult(
  usable: OpenClawCacheSnapshot | undefined,
  status: number | undefined,
  error: OpenClawFeedErrorCode,
): OpenClawRefreshResult {
  if (usable !== undefined) {
    return {
      kind: 'stale',
      ...(status === undefined ? {} : { status }),
      snapshot: cloneSnapshot(usable),
      error,
    };
  }
  return {
    kind: 'rejected',
    ...(status === undefined ? {} : { status }),
    error,
  };
}

async function confirmPersistedSnapshot(
  store: OpenClawConsumerSnapshotStore,
  key: OpenClawConsumerCacheKey,
  candidate: OpenClawCacheSnapshot,
  request: OpenClawFeedRefreshRequest,
  maxBodyBytes: number,
  maxStaleMs: number,
  now: () => number,
): Promise<{ ok: true; snapshot: OpenClawCacheSnapshot } | { ok: false; error: OpenClawFeedErrorCode }> {
  let persisted: OpenClawCacheSnapshot | undefined;
  try {
    persisted = await store.read(key);
  } catch {
    return { ok: false, error: 'fetch-failed' };
  }
  if (persisted === undefined) return { ok: false, error: 'fetch-failed' };
  const relation = compareSnapshots(persisted, candidate);
  if (relation === 'older') return { ok: false, error: 'replay' };
  if (relation === 'equivocation') return { ok: false, error: 'equivocation' };
  if (!canServeSnapshot(persisted, request, maxBodyBytes, now(), maxStaleMs)) {
    if (request.expectedSha256 !== undefined && !matchesExpectedSha256(persisted.sha256, request.expectedSha256)) {
      return { ok: false, error: 'digest-mismatch' };
    }
    return { ok: false, error: 'no-cache' };
  }
  return { ok: true, snapshot: cloneSnapshot(persisted) };
}

async function readAuthoritativeSnapshot(
  store: OpenClawConsumerSnapshotStore,
  key: OpenClawConsumerCacheKey,
  prior: OpenClawCacheSnapshot | undefined,
  priorUsable: OpenClawCacheSnapshot | undefined,
  now: number,
  maxStaleMs: number,
): Promise<{ snapshot: OpenClawCacheSnapshot | undefined; usable: OpenClawCacheSnapshot | undefined }> {
  let current: OpenClawCacheSnapshot | undefined;
  try {
    current = await store.read(key);
  } catch {
    return { snapshot: prior, usable: priorUsable };
  }
  if (current === undefined) return { snapshot: prior, usable: priorUsable };
  if (prior === undefined) return { snapshot: current, usable: usableSnapshot(current, now, maxStaleMs) };
  const relation = compareSnapshots(current, prior);
  if (relation === 'older') return { snapshot: prior, usable: priorUsable };
  if (relation === 'equivocation') {
    // Same-sequence bytes have no safe winner. Keep the high-water identity
    // for diagnostics but never serve either conflicting body as fallback.
    return { snapshot: current, usable: undefined };
  }
  return { snapshot: current, usable: usableSnapshot(current, now, maxStaleMs) };
}

function normalizeCacheKey(value: OpenClawConsumerCacheKey): OpenClawConsumerCacheKey {
  const tenantId = safeTenantId(value.tenantId);
  const feedId = safeConsumerFeedId(value.feedId);
  let url: URL;
  try {
    url = new URL(value.sourceUrl);
  } catch {
    throw new OpenClawConsumerSnapshotStoreError('identity-mismatch', 'The consumer source URL is invalid');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    new TextEncoder().encode(url.href).byteLength > MAX_SOURCE_URL_BYTES
  ) {
    throw new OpenClawConsumerSnapshotStoreError('identity-mismatch', 'The consumer source URL is invalid');
  }
  return { tenantId, feedId, sourceUrl: url.href };
}

function storageKey(key: OpenClawConsumerCacheKey): string {
  return encodeBase64(new TextEncoder().encode(`${key.feedId}\u0000${key.sourceUrl}`));
}

async function validateSnapshot(
  key: OpenClawConsumerCacheKey,
  snapshot: OpenClawCacheSnapshot,
  maxBodyBytes: number,
): Promise<OpenClawCacheSnapshot> {
  if (
    !snapshot ||
    typeof snapshot.body !== 'string' ||
    !(snapshot.bytes instanceof Uint8Array) ||
    snapshot.bytes.byteLength > maxBodyBytes ||
    snapshot.sourceUrl !== key.sourceUrl ||
    !Number.isFinite(snapshot.acceptedAt) ||
    snapshot.acceptedAt < 0 ||
    !SHA256_RE.test(snapshot.sha256) ||
    snapshot.etag !== `"${snapshot.sha256}"` ||
    (snapshot.compatibilityProfile !== undefined && snapshot.compatibilityProfile !== OPENCLAW_CLAWHUB_SKILLS_COMPATIBILITY_PROFILE) ||
    (snapshot.compatibilityProfile === undefined && key.feedId === OPENCLAW_CLAWHUB_SKILLS_FEED_ID) ||
    (snapshot.compatibilityProfile !== undefined && !isOpenClawClawHubSkillsCompatibilityIdentity(key.feedId, key.sourceUrl)) ||
    (snapshot.transportEtag !== undefined &&
      (typeof snapshot.transportEtag !== 'string' ||
        !isValidOpenClawTransportEtag(snapshot.transportEtag, snapshot.sha256, key.sourceUrl, key.feedId)))
  ) {
    throw new OpenClawConsumerSnapshotStoreError('identity-mismatch', 'The consumer snapshot identity is invalid');
  }
  const bodyBytes = new TextEncoder().encode(snapshot.body);
  if (bodyBytes.byteLength !== snapshot.bytes.byteLength || !bytesEqual(bodyBytes, snapshot.bytes)) {
    throw new OpenClawConsumerSnapshotStoreError('invalid', 'The consumer snapshot bytes do not match its body');
  }
  let digest: OpenClawSha256;
  try {
    digest = await sha256(snapshot.bytes);
  } catch {
    throw new OpenClawConsumerSnapshotStoreError('unavailable', 'The consumer snapshot digest is unavailable');
  }
  if (digest !== snapshot.sha256) {
    throw new OpenClawConsumerSnapshotStoreError('invalid', 'The consumer snapshot digest is invalid');
  }
  let feed;
  try {
    feed = parseOpenClawFeed(snapshot.body, { expectedFeedId: key.feedId, checkExpiry: false, maxBytes: maxBodyBytes });
  } catch (error) {
    if (error instanceof OpenClawValidationError) {
      throw new OpenClawConsumerSnapshotStoreError('invalid', 'The consumer snapshot feed is invalid');
    }
    throw error;
  }
  const generatedAt = Date.parse(feed.generatedAt);
  const expiresAt = Date.parse(feed.expiresAt);
  const maxWireTtl = snapshot.compatibilityProfile === OPENCLAW_CLAWHUB_SKILLS_COMPATIBILITY_PROFILE
    ? 7 * 24 * 60 * 60 * 1_000
    : 24 * 60 * 60 * 1_000;
  if (!Number.isFinite(generatedAt) || !Number.isFinite(expiresAt) || expiresAt <= generatedAt || expiresAt - generatedAt > maxWireTtl) {
    throw new OpenClawConsumerSnapshotStoreError('invalid', 'The consumer snapshot freshness bounds are invalid');
  }
  return {
    feed,
    body: snapshot.body,
    bytes: snapshot.bytes.slice(),
    sha256: digest,
    etag: `"${digest}"`,
    ...(snapshot.compatibilityProfile === undefined ? {} : { compatibilityProfile: snapshot.compatibilityProfile }),
    ...(snapshot.transportEtag === undefined ? {} : { transportEtag: snapshot.transportEtag }),
    ...(snapshot.lastModified === undefined ? {} : { lastModified: boundedOptionalHeader(snapshot.lastModified) }),
    acceptedAt: snapshot.acceptedAt,
    sourceUrl: key.sourceUrl,
  };
}

function toPersistedSnapshot(key: OpenClawConsumerCacheKey, snapshot: OpenClawCacheSnapshot): PersistedConsumerSnapshot {
  return {
    feedId: key.feedId,
    sourceUrl: key.sourceUrl,
    feedSequence: snapshot.feed.sequence,
    acceptedAt: snapshot.acceptedAt,
    body: snapshot.body,
    bytesBase64: encodeBase64(snapshot.bytes),
    bytesLength: snapshot.bytes.byteLength,
    sha256: snapshot.sha256,
    etag: snapshot.etag,
    ...(snapshot.compatibilityProfile === undefined ? {} : { compatibilityProfile: snapshot.compatibilityProfile }),
    ...(snapshot.transportEtag === undefined ? {} : { transportEtag: snapshot.transportEtag }),
    ...(snapshot.lastModified === undefined ? {} : { lastModified: snapshot.lastModified }),
  };
}

function boundedPersistedLength(snapshot: PersistedConsumerSnapshot): number {
  return Number.isSafeInteger(snapshot.bytesLength) && snapshot.bytesLength >= 0 ? snapshot.bytesLength : Number.MAX_SAFE_INTEGER;
}

function samePersistedSnapshot(left: PersistedConsumerSnapshot, right: PersistedConsumerSnapshot): boolean {
  return left.feedId === right.feedId &&
    left.sourceUrl === right.sourceUrl &&
    left.feedSequence === right.feedSequence &&
    left.body === right.body &&
    left.bytesBase64 === right.bytesBase64 &&
    left.bytesLength === right.bytesLength &&
    left.sha256 === right.sha256 &&
    left.etag === right.etag &&
    left.compatibilityProfile === right.compatibilityProfile;
}

function validatorsMatch(
  response: Response,
  snapshot: OpenClawCacheSnapshot,
  compatibilityProfile?: typeof OPENCLAW_CLAWHUB_SKILLS_COMPATIBILITY_PROFILE,
): boolean {
  const etag = response.headers.get('etag');
  const expectedLiveEtag = `"${snapshot.sha256}-gzip"`;
  const weakExpectedLiveEtag = `W/"${snapshot.sha256}-gzip"`;
  const etagMatches = snapshot.compatibilityProfile === compatibilityProfile && (etag === null ||
    etag === snapshot.etag ||
    (compatibilityProfile === OPENCLAW_CLAWHUB_SKILLS_COMPATIBILITY_PROFILE &&
      isOpenClawClawHubSkillsCompatibilityIdentity(snapshot.feed.id, snapshot.sourceUrl) &&
      (etag === expectedLiveEtag || etag === weakExpectedLiveEtag)));
  if (!etagMatches) return false;
  const lastModified = response.headers.get('last-modified');
  return lastModified === null || lastModified === snapshot.lastModified;
}

function usableSnapshot(snapshot: OpenClawCacheSnapshot, now: number, maxStaleMs: number): OpenClawCacheSnapshot | undefined {
  if (!isOpenClawFeedFresh(snapshot.feed, snapshot.sourceUrl, now, snapshot.compatibilityProfile) ||
    snapshot.acceptedAt > now || now - snapshot.acceptedAt > maxStaleMs) return undefined;
  return cloneSnapshot(snapshot);
}

function canFallbackToDurable(error: OpenClawFeedErrorCode): boolean {
  return error !== 'invalid-url' &&
    error !== 'digest-mismatch' &&
    error !== 'invalid-etag' &&
    error !== 'no-cache';
}

function projectStoreError(error: unknown): OpenClawFeedErrorCode {
  if (error instanceof OpenClawConsumerSnapshotStoreError) {
    if (error.code === 'replay') return 'replay';
    if (error.code === 'equivocation') return 'equivocation';
    if (error.code === 'invalid' || error.code === 'identity-mismatch') return 'invalid-feed';
  }
  return 'fetch-failed';
}

function safeConsumerFeedId(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > MAX_FEED_ID_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value)
  ) throw new OpenClawConsumerSnapshotStoreError('identity-mismatch', 'The consumer feed identity is invalid');
  return value;
}

function safeTenantId(value: string): string {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    new TextEncoder().encode(value).byteLength > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new OpenClawConsumerSnapshotStoreError('identity-mismatch', 'The consumer tenant identity is invalid');
  }
  return value;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new OpenClawConsumerSnapshotStoreError('invalid', `The ${label} is outside supported bounds`);
  }
  return value;
}

function boundedOptionalHeader(value: string): string {
  if (typeof value !== 'string' || value.length > 8 * 1024 || /[\r\n\u0000-\u001f\u007f]/u.test(value)) {
    throw new OpenClawConsumerSnapshotStoreError('invalid', 'The consumer snapshot validator is invalid');
  }
  return value;
}

function encodeBase64(bytes: Uint8Array): string {
  if (typeof btoa !== 'function') throw new OpenClawConsumerSnapshotStoreError('unavailable', 'Base64 encoding is unavailable');
  let binary = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.byteLength)));
  }
  return btoa(binary);
}

function decodeBase64(value: string, maxBytes = OPENCLAW_MAX_BODY_BYTES): Uint8Array {
  if (
    typeof atob !== 'function' ||
    typeof value !== 'string' ||
    value.length > Math.ceil(maxBytes / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) throw new Error('invalid base64');
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, PersistedConsumerSnapshot> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneSnapshot(snapshot: OpenClawCacheSnapshot): OpenClawCacheSnapshot {
  return {
    feed: parseOpenClawFeed(snapshot.body, { checkExpiry: false, maxBytes: OPENCLAW_MAX_BODY_BYTES }),
    body: snapshot.body,
    bytes: snapshot.bytes.slice(),
    sha256: snapshot.sha256,
    etag: snapshot.etag,
    ...(snapshot.compatibilityProfile === undefined ? {} : { compatibilityProfile: snapshot.compatibilityProfile }),
    ...(snapshot.transportEtag === undefined ? {} : { transportEtag: snapshot.transportEtag }),
    ...(snapshot.lastModified === undefined ? {} : { lastModified: snapshot.lastModified }),
    acceptedAt: snapshot.acceptedAt,
    sourceUrl: snapshot.sourceUrl,
  };
}
