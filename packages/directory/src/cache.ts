/** Cacheable metadata endpoints in the skills.sh API. */
export type DirectoryCacheEndpoint = 'list' | 'search' | 'curated' | 'detail' | 'audit';

/**
 * The official skills.sh API documents these maximum cache windows.  A
 * deployment may select a shorter TTL, but this module never permits a
 * longer one.
 */
export const DIRECTORY_CACHE_MAX_TTL_MS: Readonly<Record<DirectoryCacheEndpoint, number>> = Object.freeze({
  list: 60_000,
  search: 60_000,
  curated: 5 * 60_000,
  detail: 5 * 60_000,
  // The public API documentation names list/search and detail/curated
  // windows, but does not promise an audit-specific window. Keep audit on
  // the conservative metadata default rather than extending an undocumented
  // retention period.
  audit: 60_000,
});

export const DEFAULT_DIRECTORY_CACHE_OPTIONS: Readonly<{
  maxEntries: number;
  maxBytes: number;
  ttlMs: Readonly<Record<DirectoryCacheEndpoint, number>>;
}> = Object.freeze({
  maxEntries: 256,
  maxBytes: 8 * 1024 * 1024,
  ttlMs: DIRECTORY_CACHE_MAX_TTL_MS,
});

const MAX_CACHE_ENTRIES = 10_000;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_CACHE_KEY_BYTES = 8 * 1024;

/**
 * Signals that a valid endpoint/query identity is larger than the bounded
 * cache key budget. The client may perform that request uncached; malformed
 * identities continue to fail closed with the ordinary validation error.
 */
export class DirectoryCacheKeyTooLargeError extends Error {
  readonly code = 'directory_cache_key_too_large' as const;

  constructor() {
    super('directory cache key exceeds its bounded size');
    this.name = 'DirectoryCacheKeyTooLargeError';
  }
}

export interface DirectoryCacheOptions {
  /** Maximum successful normalized responses retained by one cache instance. */
  maxEntries?: number;
  /** Maximum UTF-8 bytes retained by one cache instance. */
  maxBytes?: number;
  /** Per-endpoint TTLs. Values may be shorter than the official maximum. */
  ttlMs?: Partial<Record<DirectoryCacheEndpoint, number>>;
  /** Injected clock for tests and hosts with a monotonic time source. */
  now?: () => number;
  /** Safe metadata observer. It never receives credentials, headers, errors, or values. */
  observe?: (event: DirectoryCacheEvent) => void;
}

export interface DirectoryCacheLoadResult<T> {
  /** Already normalized metadata. Raw upstream JSON must not enter this cache. */
  value: T;
  /** HTTP response status associated with the normalized value. */
  status: number;
}

export interface DirectoryCacheRequest<T> {
  endpoint: DirectoryCacheEndpoint;
  /** Full identity key, including the configured directory base and query. */
  key: string;
  /** Resolve auth before every lookup, including a warm hit. Its result is never retained. */
  authenticate?: (signal?: AbortSignal) => Promise<unknown>;
  /** Load one normalized successful response. The credential is request scoped and never cached. */
  load: (credential: unknown, signal?: AbortSignal) => Promise<DirectoryCacheLoadResult<T>>;
  signal?: AbortSignal;
}

export type DirectoryCacheEventType =
  | 'auth-failed'
  | 'bypass'
  | 'coalesced'
  | 'evicted'
  | 'expired'
  | 'hit'
  | 'load-failed'
  | 'miss'
  | 'store';

/** Safe cache telemetry. No field carries response values or exception text. */
export interface DirectoryCacheEvent {
  type: DirectoryCacheEventType;
  endpoint: DirectoryCacheEndpoint;
  key: string;
  ageMs: number;
  bytes: number;
  totalBytes: number;
  entries: number;
  maxBytes: number;
  maxEntries: number;
  status?: number;
  ttlMs?: number;
  reason?: 'entry-too-large' | 'non-success' | 'serialization';
}

export interface DirectoryCacheEntryStats {
  endpoint: DirectoryCacheEndpoint;
  key: string;
  status: number;
  ageMs: number;
  ttlMs: number;
  bytes: number;
  expiresInMs: number;
}

export interface DirectoryCacheStats {
  hits: number;
  misses: number;
  coalesced: number;
  stores: number;
  evictions: number;
  expirations: number;
  bypasses: number;
  authFailures: number;
  loadFailures: number;
  entries: number;
  totalBytes: number;
  maxEntries: number;
  maxBytes: number;
  cached: DirectoryCacheEntryStats[];
}

interface CacheEntry<T> {
  endpoint: DirectoryCacheEndpoint;
  key: string;
  value: T;
  status: number;
  bytes: number;
  createdAt: number;
  expiresAt: number;
  ttlMs: number;
}

interface Counters {
  hits: number;
  misses: number;
  coalesced: number;
  stores: number;
  evictions: number;
  expirations: number;
  bypasses: number;
  authFailures: number;
  loadFailures: number;
}

/**
 * A per-client-instance cache for normalized skills.sh metadata.
 *
 * Authentication is deliberately outside the cache key and is resolved
 * before checking entries. This makes a warm cache unable to hide an expired
 * or revoked request credential. Only successful, cloned normalized values
 * are retained; errors, headers, credentials, and raw response bodies never
 * enter the cache.
 */
export class DirectoryResponseCache {
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly ttlMs: Readonly<Record<DirectoryCacheEndpoint, number>>;
  private readonly now: () => number;
  private readonly observe?: (event: DirectoryCacheEvent) => void;
  private readonly entries = new Map<string, CacheEntry<unknown>>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private totalBytes = 0;
  private readonly counters: Counters = {
    hits: 0,
    misses: 0,
    coalesced: 0,
    stores: 0,
    evictions: 0,
    expirations: 0,
    bypasses: 0,
    authFailures: 0,
    loadFailures: 0,
  };

  constructor(options: DirectoryCacheOptions = {}) {
    this.maxEntries = boundedInteger(options.maxEntries ?? DEFAULT_DIRECTORY_CACHE_OPTIONS.maxEntries, 0, MAX_CACHE_ENTRIES, 'maxEntries');
    this.maxBytes = boundedInteger(options.maxBytes ?? DEFAULT_DIRECTORY_CACHE_OPTIONS.maxBytes, 0, MAX_CACHE_BYTES, 'maxBytes');
    this.ttlMs = normalizeTtls(options.ttlMs);
    this.now = options.now ?? Date.now;
    this.observe = options.observe;
  }

  /**
   * Resolve auth and then return a cloned cached value or load one response.
   * Concurrent misses for the same endpoint/key share one successful loader;
   * each caller still resolves its own credential first.
   */
  async get<T>(request: DirectoryCacheRequest<T>): Promise<T> {
    assertEndpoint(request.endpoint);
    const key = normalizeCacheKey(request.key);
    const identity = cacheIdentity(request.endpoint, key);
    let credential: unknown;
    try {
      credential = await request.authenticate?.(request.signal);
    } catch (error) {
      this.counters.authFailures += 1;
      this.emit({ type: 'auth-failed', endpoint: request.endpoint, key, ageMs: 0, bytes: 0 });
      throw error;
    }
    if (request.signal?.aborted) throw abortError();

    const now = this.currentTime();
    const existing = this.entries.get(identity);
    if (existing) {
      if (now < existing.expiresAt) {
        this.touch(identity, existing);
        this.counters.hits += 1;
        this.emit({
          type: 'hit',
          endpoint: existing.endpoint,
          key: existing.key,
          ageMs: age(now, existing.createdAt),
          bytes: existing.bytes,
          status: existing.status,
          ttlMs: existing.ttlMs,
        });
        return cloneValue(existing.value) as T;
      }
      this.remove(identity, existing);
      this.counters.expirations += 1;
      this.emit({
        type: 'expired',
        endpoint: existing.endpoint,
        key: existing.key,
        ageMs: age(now, existing.createdAt),
        bytes: existing.bytes,
        status: existing.status,
        ttlMs: existing.ttlMs,
      });
    }

    this.counters.misses += 1;
    const pending = this.inFlight.get(identity);
    if (pending) {
      this.counters.coalesced += 1;
      this.emit({ type: 'coalesced', endpoint: request.endpoint, key, ageMs: 0, bytes: 0 });
      return cloneValue(await awaitWithAbort(pending, request.signal)) as T;
    }

    this.emit({ type: 'miss', endpoint: request.endpoint, key, ageMs: 0, bytes: 0 });
    const load = this.loadAndStore(request, key, identity, credential);
    this.inFlight.set(identity, load as Promise<unknown>);
    try {
      return cloneValue(await load);
    } finally {
      if (this.inFlight.get(identity) === load) this.inFlight.delete(identity);
    }
  }

  /** Return safe metadata for the cache without exposing cached values. */
  inspect(): DirectoryCacheStats {
    const now = this.currentTime();
    this.purgeExpired(now);
    return {
      ...this.counters,
      entries: this.entries.size,
      totalBytes: this.totalBytes,
      maxEntries: this.maxEntries,
      maxBytes: this.maxBytes,
      cached: [...this.entries.values()].map((entry) => ({
        endpoint: entry.endpoint,
        key: entry.key,
        status: entry.status,
        ageMs: age(now, entry.createdAt),
        ttlMs: entry.ttlMs,
        bytes: entry.bytes,
        expiresInMs: Math.max(0, entry.expiresAt - now),
      })),
    };
  }

  /** Remove all cached values while retaining safe counters. */
  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  private async loadAndStore<T>(
    request: DirectoryCacheRequest<T>,
    key: string,
    identity: string,
    credential: unknown,
  ): Promise<T> {
    let loaded: DirectoryCacheLoadResult<T>;
    try {
      loaded = await request.load(credential, request.signal);
    } catch (error) {
      this.counters.loadFailures += 1;
      this.emit({ type: 'load-failed', endpoint: request.endpoint, key, ageMs: 0, bytes: 0 });
      throw error;
    }
    if (!Number.isSafeInteger(loaded.status) || loaded.status < 100 || loaded.status > 599) {
      this.counters.loadFailures += 1;
      this.emit({ type: 'load-failed', endpoint: request.endpoint, key, ageMs: 0, bytes: 0 });
      throw new Error('directory cache loader returned an invalid status');
    }

    let detached: T;
    let bytes: number;
    try {
      detached = cloneValue(loaded.value);
      bytes = serializedBytes(detached);
    } catch {
      this.counters.bypasses += 1;
      this.emit({ type: 'bypass', endpoint: request.endpoint, key, ageMs: 0, bytes: 0, status: loaded.status, reason: 'serialization' });
      return loaded.value;
    }

    const ttl = this.ttlMs[request.endpoint];
    if (loaded.status < 200 || loaded.status >= 300) {
      this.counters.bypasses += 1;
      this.emit({ type: 'bypass', endpoint: request.endpoint, key, ageMs: 0, bytes, status: loaded.status, reason: 'non-success' });
      return detached;
    }
    if (ttl === 0 || this.maxEntries === 0 || this.maxBytes === 0 || bytes > this.maxBytes) {
      this.counters.bypasses += 1;
      this.emit({ type: 'bypass', endpoint: request.endpoint, key, ageMs: 0, bytes, status: loaded.status, ttlMs: ttl, reason: bytes > this.maxBytes ? 'entry-too-large' : undefined });
      return detached;
    }

    const createdAt = this.currentTime();
    const entry: CacheEntry<T> = {
      endpoint: request.endpoint,
      key,
      value: detached,
      status: loaded.status,
      bytes,
      createdAt,
      expiresAt: createdAt + ttl,
      ttlMs: ttl,
    };
    const previous = this.entries.get(identity);
    if (previous) this.remove(identity, previous);
    this.entries.set(identity, entry as CacheEntry<unknown>);
    this.totalBytes += bytes;
    this.counters.stores += 1;
    this.emit({ type: 'store', endpoint: request.endpoint, key, ageMs: 0, bytes, status: loaded.status, ttlMs: ttl });
    this.evictIfNeeded();
    return detached;
  }

  private evictIfNeeded(): void {
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const oldest = this.entries.entries().next().value as [string, CacheEntry<unknown>] | undefined;
      if (!oldest) break;
      const [identity, entry] = oldest;
      this.remove(identity, entry);
      this.counters.evictions += 1;
      this.emit({
        type: 'evicted',
        endpoint: entry.endpoint,
        key: entry.key,
        ageMs: age(this.currentTime(), entry.createdAt),
        bytes: entry.bytes,
        status: entry.status,
        ttlMs: entry.ttlMs,
      });
    }
  }

  private purgeExpired(now: number): void {
    for (const [identity, entry] of this.entries) {
      if (now < entry.expiresAt) continue;
      this.remove(identity, entry);
      this.counters.expirations += 1;
      this.emit({
        type: 'expired',
        endpoint: entry.endpoint,
        key: entry.key,
        ageMs: age(now, entry.createdAt),
        bytes: entry.bytes,
        status: entry.status,
        ttlMs: entry.ttlMs,
      });
    }
  }

  private touch(identity: string, entry: CacheEntry<unknown>): void {
    this.entries.delete(identity);
    this.entries.set(identity, entry);
  }

  private remove(identity: string, entry: CacheEntry<unknown>): void {
    if (!this.entries.delete(identity)) return;
    this.totalBytes -= entry.bytes;
    if (this.totalBytes < 0) this.totalBytes = 0;
  }

  private currentTime(): number {
    const value = this.now();
    if (!Number.isFinite(value)) throw new Error('directory cache clock returned an invalid time');
    return value;
  }

  private emit(event: Omit<DirectoryCacheEvent, 'totalBytes' | 'entries' | 'maxBytes' | 'maxEntries'>): void {
    if (!this.observe) return;
    const safe: DirectoryCacheEvent = {
      ...event,
      totalBytes: this.totalBytes,
      entries: this.entries.size,
      maxBytes: this.maxBytes,
      maxEntries: this.maxEntries,
    };
    try {
      this.observe(safe);
    } catch {
      // Observability must never change cache correctness or request behavior.
    }
  }
}

/**
 * Build a stable metadata key that includes the configured directory root.
 * Callers should provide an already normalized API path and never include
 * authorization material in the endpoint or query.
 */
export function directoryCacheKey(
  baseURL: string | URL,
  endpoint: string,
  query?: URLSearchParams | Readonly<Record<string, string | number | boolean | null | undefined>>,
): string {
  const base = normalizeBaseURL(baseURL);
  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.includes('?') || endpoint.includes('#') || endpoint.includes('\\') || endpoint.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error('directory cache endpoint is invalid');
  }
  const normalizedEndpoint = endpoint.replace(/^\/+|\/+$/gu, '');
  if (!normalizedEndpoint) throw new Error('directory cache endpoint is invalid');
  const prefix = base.pathname.replace(/\/+$/u, '');
  const url = new URL(`${prefix}/api/v1/${normalizedEndpoint}`, base.origin);
  const params = new URLSearchParams();
  if (query instanceof URLSearchParams) {
    for (const [name, value] of query.entries()) params.append(name, value);
  } else if (query) {
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) params.append(name, String(value));
    }
  }
  params.sort();
  url.search = params.toString();
  return normalizeCacheKey(url.toString());
}

function cacheIdentity(endpoint: DirectoryCacheEndpoint, key: string): string {
  return `${endpoint}\u0000${key}`;
}

function normalizeTtls(value: Partial<Record<DirectoryCacheEndpoint, number>> | undefined): Readonly<Record<DirectoryCacheEndpoint, number>> {
  const normalized = { ...DIRECTORY_CACHE_MAX_TTL_MS };
  for (const endpoint of Object.keys(DIRECTORY_CACHE_MAX_TTL_MS) as DirectoryCacheEndpoint[]) {
    const requested = value?.[endpoint];
    if (requested === undefined) continue;
    normalized[endpoint] = boundedInteger(requested, 0, DIRECTORY_CACHE_MAX_TTL_MS[endpoint], `ttlMs.${endpoint}`);
  }
  return Object.freeze(normalized);
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`directory cache ${name} is out of bounds`);
  return value;
}

function normalizeCacheKey(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('directory cache key is invalid');
  }
  if (new TextEncoder().encode(value).byteLength > MAX_CACHE_KEY_BYTES) throw new DirectoryCacheKeyTooLargeError();
  return value;
}

function normalizeBaseURL(value: string | URL): URL {
  let url: URL;
  try {
    url = new URL(value.toString());
  } catch {
    throw new Error('directory cache base URL is invalid');
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error('directory cache base URL is invalid');
  }
  url.pathname = url.pathname.replace(/\/+$/u, '');
  return url;
}

function assertEndpoint(value: DirectoryCacheEndpoint): void {
  if (value !== 'list' && value !== 'search' && value !== 'curated' && value !== 'detail' && value !== 'audit') {
    throw new Error('directory cache endpoint is invalid');
  }
}

function age(now: number, createdAt: number): number {
  return Math.max(0, now - createdAt);
}

function serializedBytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('directory cache value is not serializable');
  return new TextEncoder().encode(serialized).byteLength;
}

function cloneValue<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function abortError(): Error {
  if (typeof DOMException === 'function') return new DOMException('The operation was aborted', 'AbortError');
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}
