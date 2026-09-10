import type { Principal } from '../../contracts/src/index.ts';
import {
  createOpenClawTenantFeedPreview,
  normalizeOpenClawEntry,
  OpenClawValidationError,
  OpenClawFeedCache,
  OpenClawRequestError,
  validateOpenClawFeedUrl,
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

const DEFAULT_FEED_TTL_MS = 15 * 60 * 1_000;
const MAX_FEED_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_FEED_ID_BYTES = 512;
const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/u;
const SAFE_FEED_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const READER_ROLES = new Set(['reader', 'publisher', 'admin', 'owner']);

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
  /** Digest of the exact canonical artifact represented by the install entry. */
  canonicalDigest: string;
}

export interface OpenClawEligibleRecordSource {
  listEligible(input: {
    tenantId: string;
    principal: Principal;
    signal: AbortSignal;
  }): Promise<readonly OpenClawEligibleRecord[]>;
}

export interface OpenClawFeedHandlerOptions {
  /** Host authentication remains injected so this package is Node/edge safe. */
  authenticate(request: Request): Promise<Principal | null>;
  source: OpenClawEligibleRecordSource;
  /** Return a stable opaque feed id; do not return a raw tenant identifier. */
  feedIdForTenant(tenantId: string, principal: Principal): string | Promise<string>;
  /** Usually backed by a state metadata revision; it must not mutate state. */
  sequenceForTenant(tenantId: string, principal: Principal): number | Promise<number>;
  /** Optional stricter ACL for a feed or namespace. */
  authorize?(principal: Principal): boolean | Promise<boolean>;
  now?: () => number;
  expiresInMs?: number;
}

export interface OpenClawFeedHandler {
  (request: Request): Promise<Response>;
}

/** A safe, non-secret error returned by the adapter boundary. */
export class OpenClawAdapterError extends Error {
  readonly code: 'invalid_configuration' | 'invalid_record' | 'unavailable';

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
 * Create the authenticated private producer route. This function only reads
 * through the injected source and builds an in-memory response. It does not
 * queue imports, write artifacts, or change registry state.
 */
export function createOpenClawSkillsFeedHandler(
  options: OpenClawFeedHandlerOptions,
): OpenClawFeedHandler {
  if (!options || typeof options.authenticate !== 'function' || !options.source) {
    throw new OpenClawAdapterError('invalid_configuration', 'OpenClaw feed dependencies are invalid');
  }
  const expiresInMs = boundedFeedTtl(options.expiresInMs);
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
      const feedId = safeFeedId(await options.feedIdForTenant(tenantId, principal));
      const sequence = safeSequence(await options.sequenceForTenant(tenantId, principal));
      const nowMs = safeNow(now());
      const records = await options.source.listEligible({
        tenantId,
        principal,
        signal: request.signal,
      });
      const entries = normalizeEligibleRecords(records);
      const produced = await createOpenClawTenantFeedPreview({
        id: feedId,
        generatedAt: new Date(nowMs).toISOString(),
        sequence,
        expiresAt: new Date(nowMs + expiresInMs).toISOString(),
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

export interface OpenClawTrustedFeedProfile {
  /** Exact HTTPS endpoint; credentials/query/fragment are rejected. */
  url: string | URL;
  expectedFeedId: string;
  allowedOrigins: readonly string[];
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
    if (!profile.expectedFeedId || profile.expectedFeedId.length > 512) throw new Error('invalid feed identity');
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
    if (!record || typeof record !== 'object' || !record.entry || typeof record.canonicalDigest !== 'string') {
      throw new OpenClawAdapterError('invalid_record', 'An eligible record is malformed');
    }
    if (!SHA256_RE.test(record.canonicalDigest)) {
      throw new OpenClawAdapterError('invalid_record', 'An eligible record has an invalid artifact digest');
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
    const matching = candidates.filter((candidate) => candidate.candidate.integrity === record.canonicalDigest);
    if (matching.length !== 1) {
      throw new OpenClawAdapterError('invalid_record', 'An install coordinate does not match the approved artifact');
    }
    if (seenIds.has(record.entry.id)) {
      throw new OpenClawAdapterError('invalid_record', 'The feed contains duplicate skill identities');
    }
    seenIds.add(record.entry.id);
    // Only publish the candidate bound to the canonical approved digest. A
    // caller may retain other discovery candidates in its private state, but
    // exposing them here would let a consumer select an unverified artifact.
    const selected = matching[0]!.candidate;
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
  // Leave room for the configured expiry interval before constructing the
  // second ISO timestamp; Date rejects values outside this finite range.
  if (!Number.isFinite(value) || value < 0 || value > 8.64e15 - MAX_FEED_TTL_MS) {
    throw new OpenClawAdapterError('invalid_configuration', 'Feed clock is invalid');
  }
  return value;
}

function boundedFeedTtl(value: number | undefined): number {
  const ttl = value ?? DEFAULT_FEED_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > MAX_FEED_TTL_MS) {
    throw new OpenClawAdapterError('invalid_configuration', 'Feed expiry is outside supported bounds');
  }
  return ttl;
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
