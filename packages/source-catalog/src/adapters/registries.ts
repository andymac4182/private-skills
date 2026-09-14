/**
 * Built-in adapters for the public skill registries that expose a documented
 * JSON search surface.
 *
 * These adapters deliberately stop at discovery.  A registry result is
 * metadata and source evidence; it is never scan evidence and it is never a
 * permission to download an arbitrary URL.  `resolve` returns one of the
 * source identities understood by the existing acquisition boundary after
 * rechecking the identity against the provider and, for GitHub records, the
 * GitHub API.
 */

import {
  SourceCatalogError,
  type SourceAcquisition,
  type SourceAvailability,
  type SourceCatalogAdapter,
  type SourceCatalogAdapterContext,
  type SourceId,
  type SourceResolveRequest,
  type SourceResolution,
  type SourceSearchRequest,
  type SourceSearchResult,
  type SourceValue,
} from '../types.js';
import {
  parsePolyskillNativeSkill,
  polyskillNativeIdentity,
} from './polyskill-native.js';

export const REGISTRY_ORIGINS = Object.freeze({
  skillsmp: 'https://skillsmp.com',
  clawhub: 'https://clawhub.ai',
  skillhubPublic: 'https://skills.palebluedot.live',
  polyskill: 'https://polyskill.ai',
  skillsDirectory: 'https://www.skillsdirectory.com',
  skillhubPro: 'https://www.skillhub.club',
  github: 'https://github.com',
  githubApi: 'https://api.github.com',
});

export const REGISTRY_SOURCE_ORIGINS = REGISTRY_ORIGINS;

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_RESULTS = 100;
const MAX_QUERY_BYTES = 16 * 1024;
const MAX_EXTERNAL_ID_BYTES = 4 * 1024;
const MAX_TITLE_BYTES = 512;
// The source-catalog client carries descriptions through a 4 KiB contract.
// Rejecting longer provider prose here lets the caller fall through to a
// shorter summary instead of returning a row that the client must reject.
const MAX_DESCRIPTION_BYTES = 4 * 1024;
const MAX_METADATA_STRING_BYTES = 2 * 1024;
const MAX_PATH_BYTES = 4 * 1024;
const MAX_GITHUB_TREE_ENTRIES = 20_000;
const MAX_GITHUB_METADATA_CANDIDATES = 24;
const MAX_GITHUB_SKILL_FILE_BYTES = 256 * 1024;
const MAX_RESOLUTION_HANDLE_BYTES = 900;
const MAX_NATIVE_FILES = 128;
const MAX_NATIVE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_NATIVE_TOTAL_BYTES = 32 * 1024 * 1024;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/u;
const COMMIT_RE = /^[0-9a-f]{40}$/u;
const HEX_SHA256_RE = /^[0-9a-f]{64}$/u;
const LOOKUP_HANDLE_PREFIX = 'pskills-lookup-v1:';

type FetchLike = typeof fetch;
type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

/** An injected resolver keeps adapter fixtures independent from live GitHub. */
export interface VerifiedGithubIdentity {
  repository: string;
  path: string;
  ref: string;
  sourceUrl?: string;
}

export interface RegistryAdapterOptions {
  /** Test/runtime fetch implementation. Defaults to globalThis.fetch. */
  fetch?: FetchLike;
  /** Explicit environment snapshot; no credentials are read from request data. */
  env?: RuntimeEnvironment;
  /** Optional server-owned credential. It is sent only to this adapter origin. */
  apiKey?: string;
  enabled?: boolean;
  trustedOrigins?: readonly string[];
  configRevision?: string;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  maxResults?: number;
  /** Optional source verifier used by deterministic tests or an edge gateway. */
  githubResolver?: (identity: GithubIdentity, signal?: AbortSignal) => Promise<VerifiedGithubIdentity>;
  /** Clock injection for deterministic resolution timestamps. */
  now?: () => Date;
  /** Per-provider credentials used only by the factory; never broadcast. */
  apiKeys?: Readonly<Partial<Record<'skillsmp' | 'clawhub' | 'skillhub-public' | 'polyskill' | 'skills-directory' | 'skillhub-pro', string>>>;
}

export interface GithubIdentity {
  repository: string;
  path?: string;
  ref?: string;
  /** Catalog name/slug used only to disambiguate repository-only records. */
  skillHint?: string;
}

interface BaseRegistryAdapterOptions extends RegistryAdapterOptions {
  id: SourceId;
  label: string;
  origin: string;
  credentialEnv?: string;
  credentialRequired?: boolean;
}

interface RecordValue {
  readonly [key: string]: unknown;
}

interface GithubEvidence {
  repository: string;
  path?: string;
  ref?: string;
  sourceUrl?: string;
  skillHint?: string;
}

interface ClawHubFile {
  path: string;
  size: number;
  sha256: string;
}

interface ParsedProviderRecord {
  item: RecordValue;
  externalId: string;
  row: SourceSearchResult;
  github?: GithubEvidence;
}

function defaultFetch(): FetchLike {
  const value = (globalThis as { fetch?: FetchLike }).fetch;
  if (typeof value !== 'function') {
    throw new SourceCatalogError('SOURCE_UNAVAILABLE', 'The source HTTP client is unavailable', 503, { retryable: true });
  }
  return value.bind(globalThis) as FetchLike;
}

function globalEnvironment(): RuntimeEnvironment {
  const processLike = (globalThis as { process?: { env?: RuntimeEnvironment } }).process;
  return processLike?.env ?? {};
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function cleanString(value: unknown, maxBytes = MAX_METADATA_STRING_BYTES): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').trim();
  if (!normalized || utf8Bytes(normalized) > maxBytes) return undefined;
  return normalized;
}

function requiredString(value: unknown, field: string, maxBytes = MAX_METADATA_STRING_BYTES): string {
  const result = cleanString(value, maxBytes);
  if (!result) throw invalidResponse(field);
  return result;
}

function scalar(value: unknown, maxStringBytes = MAX_METADATA_STRING_BYTES): SourceValue | undefined {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) return value;
    return undefined;
  }
  return cleanString(value, maxStringBytes);
}

function metadataOf(entries: ReadonlyArray<readonly [string, unknown]>): Readonly<Record<string, SourceValue>> | undefined {
  const metadata: Record<string, SourceValue> = {};
  for (const [key, value] of entries) {
    const normalized = scalar(value);
    if (normalized !== undefined) metadata[key] = normalized;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function asRecord(value: unknown): RecordValue | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as RecordValue;
}

function nested(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split('.')) {
    const record = asRecord(current);
    if (record) {
      current = record[segment];
      continue;
    }
    if (Array.isArray(current) && /^[0-9]+$/u.test(segment)) {
      current = current[Number(segment)];
      continue;
    }
    return undefined;
  }
  return current;
}

function firstString(record: RecordValue, paths: readonly string[], maxBytes = MAX_METADATA_STRING_BYTES): string | undefined {
  for (const path of paths) {
    const value = cleanString(nested(record, path), maxBytes);
    if (value) return value;
  }
  return undefined;
}

function firstUnknown(record: RecordValue, paths: readonly string[]): unknown {
  for (const path of paths) {
    const value = nested(record, path);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function invalidResponse(field: string): SourceCatalogError {
  return new SourceCatalogError('SOURCE_RESOLUTION_INVALID', `The source returned an invalid ${field}`, 502);
}

function invalidExternalId(sourceId: SourceId, message = 'The source identifier is invalid'): SourceCatalogError {
  return new SourceCatalogError('SOURCE_INVALID_EXTERNAL_ID', message, 400, { source: sourceId });
}

function validateQuery(value: unknown): string {
  const query = cleanString(value, MAX_QUERY_BYTES);
  if (!query || utf8Bytes(query) > MAX_QUERY_BYTES || /[\u0000-\u001f\u007f]/u.test(query)) {
    throw new SourceCatalogError('SOURCE_INVALID_QUERY', 'The source query is invalid', 400);
  }
  return query;
}

function boundedLimit(value: unknown, max = DEFAULT_MAX_RESULTS): number {
  if (value === undefined) return Math.min(DEFAULT_MAX_RESULTS, max);
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new SourceCatalogError('SOURCE_INVALID_QUERY', 'The source result limit is invalid', 400);
  }
  return Math.min(number, DEFAULT_MAX_RESULTS, max);
}

function boundedTimeout(value: unknown): number {
  const number = value === undefined ? DEFAULT_TIMEOUT_MS : Number(value);
  if (!Number.isSafeInteger(number) || number < 1) return DEFAULT_TIMEOUT_MS;
  return Math.min(number, MAX_TIMEOUT_MS);
}

function boundedResponseBytes(value: unknown): number {
  const number = value === undefined ? DEFAULT_MAX_RESPONSE_BYTES : Number(value);
  if (!Number.isSafeInteger(number) || number < 1) return DEFAULT_MAX_RESPONSE_BYTES;
  return Math.min(number, MAX_RESPONSE_BYTES);
}

function assertSourceRequest(input: SourceSearchRequest | SourceResolveRequest, sourceId: SourceId): void {
  const requestedSource = 'sourceId' in input ? input.sourceId : input.source;
  // SourceSearchRequest intentionally has a selection field named `source`;
  // adapters ignore an omitted value but reject an explicit mismatch.
  if (requestedSource !== undefined && requestedSource !== sourceId) {
    throw invalidExternalId(sourceId, 'The request selected a different source adapter');
  }
}

function assertExternalId(value: unknown, sourceId: SourceId): string {
  const externalId = cleanString(value, MAX_EXTERNAL_ID_BYTES);
  if (!externalId || utf8Bytes(externalId) > MAX_EXTERNAL_ID_BYTES || /[\u0000-\u001f\u007f]/u.test(externalId)) {
    throw invalidExternalId(sourceId);
  }
  return externalId;
}

function isSha256(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && SHA256_RE.test(value);
}

function optionalDigest(record: RecordValue, paths: readonly string[]): `sha256:${string}` | undefined {
  const value = firstString(record, paths, 128);
  return isSha256(value) ? value : undefined;
}

function safeProviderUrl(value: unknown, origin: string): string | undefined {
  const text = cleanString(value, 4_096);
  if (!text) return undefined;
  try {
    const url = new URL(text, origin);
    if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password || url.port) return undefined;
    url.hash = '';
    return url.href;
  } catch {
    return undefined;
  }
}

function safePath(value: unknown, allowEmpty = false): string | undefined {
  const path = cleanString(value, MAX_PATH_BYTES);
  if (!path) return allowEmpty ? '' : undefined;
  if (utf8Bytes(path) > MAX_PATH_BYTES || path.startsWith('/') || path.startsWith('\\') || path.includes('\\') || path.includes('\0')) return undefined;
  const parts = path.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.endsWith(' ') || part.endsWith('.'))) return undefined;
  return parts.join('/');
}

function safeRef(value: unknown): string | undefined {
  const ref = cleanString(value, 512);
  if (!ref || utf8Bytes(ref) > 512 || ref.startsWith('/') || ref.startsWith('\\') || ref.includes('\\') || ref.includes('\0')) return undefined;
  if (ref.split('/').some((part) => !part || part === '.' || part === '..')) return undefined;
  return ref;
}

function safeRepository(value: unknown): string | undefined {
  let text = cleanString(value, 512);
  if (!text) return undefined;
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) return undefined;
    text = parsed.pathname;
  } catch {
    // An owner/repository coordinate is also accepted.
  }
  text = text.replace(/^\/+|\/+$/gu, '').replace(/\.git$/u, '');
  const parts = text.split('/');
  if (parts.length !== 2 || parts.some((part) => part === '.' || part === '..' || !/^[A-Za-z0-9._-]+$/u.test(part))) return undefined;
  return parts.join('/');
}

/**
 * Parse a GitHub web URL without treating arbitrary URLs as source evidence.
 * Branch names containing `/` should be supplied through a separate `ref`
 * field; the conventional `tree/<ref>/<path>` form remains unambiguous for
 * the common branch/tag names.
 */
export function parseGithubReference(value: unknown): GithubEvidence | undefined {
  const text = cleanString(value, 8_192);
  if (!text) return undefined;
  let parsed: URL;
  try { parsed = new URL(text); } catch { return undefined; }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) return undefined;
  const parts = parsed.pathname.replace(/^\/+|\/+$/gu, '').split('/');
  if (parts.length < 2) return undefined;
  const repository = safeRepository(`${parts[0]}/${parts[1]}`);
  if (!repository) return undefined;
  if (parts.length === 2) return { repository, sourceUrl: `https://github.com/${repository}` };
  if (parts[2] !== 'tree' && parts[2] !== 'blob') return undefined;
  let decodedRef: string;
  try { decodedRef = decodeURIComponent(parts[3] ?? ''); } catch { return undefined; }
  const ref = safeRef(decodedRef);
  if (!ref) return undefined;
  const trailing = parts.slice(4).map((part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  }).join('/');
  const rawPath = trailing === 'SKILL.md'
    ? ''
    : trailing.endsWith('/SKILL.md')
    ? trailing.slice(0, -'/SKILL.md'.length)
    : trailing;
  const path = safePath(rawPath, true);
  if (path === undefined) return undefined;
  return {
    repository,
    path,
    ref,
    sourceUrl: `https://github.com/${repository}/${parts[2]}/${encodeURIComponent(ref)}${path ? `/${path.split('/').map((part) => encodeURIComponent(part)).join('/')}` : ''}`,
  };
}

function githubEvidenceFromRecord(record: RecordValue): GithubEvidence | undefined {
  const url = firstString(record, [
    'githubUrl', 'github_url', 'repositoryUrl', 'repository_url', 'repoUrl', 'repository',
    'manifest.repository', 'manifest.githubUrl', 'sourceUrl', 'source_url',
  ], 8_192);
  const parsed = parseGithubReference(url);
  const owner = firstString(record, ['githubOwner', 'github_owner', 'owner.login', 'owner']) ?? firstString(asRecord(firstUnknown(record, ['manifest.author'])) ?? {}, ['name']);
  const repoName = firstString(record, ['githubRepo', 'github_repo', 'repo', 'repositoryName']);
  const repository = parsed?.repository ?? (owner && repoName ? safeRepository(`${owner}/${repoName}`) : undefined);
  if (!repository) return undefined;
  const suppliedPath = firstUnknown(record, ['skillPath', 'skill_path', 'path', 'githubPath', 'github_path', 'manifest.path']);
  const pathValue = suppliedPath === undefined || suppliedPath === null ? parsed?.path : suppliedPath;
  const path = pathValue === undefined ? undefined : safePath(pathValue, true);
  if (pathValue !== undefined && path === undefined) return undefined;
  const suppliedRef = firstUnknown(record, ['ref', 'branch', 'defaultBranch', 'default_branch', 'manifest.ref']);
  const refValue = suppliedRef === undefined || suppliedRef === null ? parsed?.ref : suppliedRef;
  const ref = refValue === undefined ? undefined : safeRef(refValue);
  if (refValue !== undefined && ref === undefined) return undefined;
  const skillHint = firstString(record, ['skillName', 'skill_name', 'skillSlug', 'skill_slug', 'slug', 'displayName', 'title', 'name'], 512);
  return {
    repository,
    ...(path === undefined ? {} : { path }),
    ...(ref === undefined ? {} : { ref }),
    ...(parsed?.sourceUrl === undefined ? {} : { sourceUrl: parsed.sourceUrl }),
    ...(path === undefined && skillHint === undefined ? {} : { ...(skillHint === undefined ? {} : { skillHint }) }),
  };
}

function canonicalGithubUrl(identity: VerifiedGithubIdentity): string {
  const path = identity.path ? `/${identity.path.split('/').map((part) => encodeURIComponent(part)).join('/')}` : '';
  return `https://github.com/${identity.repository}/tree/${encodeURIComponent(identity.ref)}${path}`;
}

function providerPageUrl(origin: string, path: string): string {
  return new URL(path, origin).href;
}

function safeInstallName(value: unknown): string | undefined {
  const name = cleanString(value, MAX_EXTERNAL_ID_BYTES);
  if (!name || /[\u0000-\u001f\u007f]/u.test(name) || name.includes('\\') || name.split('/').some((part) => !part || part === '.' || part === '..')) return undefined;
  return name;
}

interface LookupHandle {
  nativeId: string;
  query: string;
  /** Search engines may rank the same query differently at another limit. */
  limit?: number;
}

/**
 * Search-only providers have no documented detail route.  Rows therefore carry
 * a bounded, opaque re-query handle rather than pretending that a provider
 * page is an artifact locator.  The original query is needed because some
 * public search implementations do not return a record when queried by its
 * opaque database id.
 */
function encodeLookupHandle(nativeId: string, query: string, limit?: number): string | undefined {
  const encoded = `${LOOKUP_HANDLE_PREFIX}${base64UrlEncode(nativeId)}.${base64UrlEncode(query)}${limit === undefined ? '' : `.${base64UrlEncode(String(limit))}`}`;
  return utf8Bytes(encoded) <= MAX_RESOLUTION_HANDLE_BYTES ? encoded : undefined;
}

function decodeLookupHandle(value: string): LookupHandle | undefined {
  if (!value.startsWith(LOOKUP_HANDLE_PREFIX)) return undefined;
  const parts = value.slice(LOOKUP_HANDLE_PREFIX.length).split('.');
  if ((parts.length !== 2 && parts.length !== 3) || parts.some((part) => !/^[A-Za-z0-9_-]+$/u.test(part))) return undefined;
  const nativeId = base64UrlDecode(parts[0]!);
  const query = base64UrlDecode(parts[1]!);
  if (nativeId === undefined || query === undefined) return undefined;
  const safeNativeId = cleanString(nativeId, MAX_EXTERNAL_ID_BYTES);
  const safeQuery = cleanString(query, MAX_QUERY_BYTES);
  if (!safeNativeId || !safeQuery || /[\u0000-\u001f\u007f]/u.test(safeQuery)) return undefined;
  let limit: number | undefined;
  if (parts.length === 3) {
    const decodedLimit = base64UrlDecode(parts[2]!);
    const parsedLimit = decodedLimit === undefined ? NaN : Number(decodedLimit);
    if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > DEFAULT_MAX_RESULTS) return undefined;
    limit = parsedLimit;
  }
  return { nativeId: safeNativeId, query: safeQuery, ...(limit === undefined ? {} : { limit }) };
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function base64UrlDecode(value: string): string | undefined {
  try {
    const padded = `${value.replace(/-/gu, '+').replace(/_/gu, '/')}${'='.repeat((4 - (value.length % 4)) % 4)}`;
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function lookupRow(row: SourceSearchResult, nativeId: string, query: string, limit?: number): SourceSearchResult {
  const handle = encodeLookupHandle(nativeId, query, limit);
  if (!handle) {
    return {
      ...row,
      installable: false,
      unavailableReason: 'The provider identity is too large for a bounded resolution handle',
    };
  }
  return {
    ...row,
    externalId: handle,
    ...(cleanString(nativeId, 1_024) === undefined
      ? {}
      : { metadata: { ...(row.metadata ?? {}), providerExternalId: nativeId } }),
  };
}

function resolveLookup(value: string): LookupHandle {
  return decodeLookupHandle(value) ?? { nativeId: value, query: value };
}

function unwrapArray(payload: unknown, paths: readonly string[]): RecordValue[] {
  if (Array.isArray(payload)) return payload.filter((item): item is RecordValue => Boolean(asRecord(item)));
  for (const path of paths) {
    const value = nested(payload, path);
    if (Array.isArray(value)) return value.filter((item): item is RecordValue => Boolean(asRecord(item)));
  }
  throw invalidResponse('items');
}

function unwrapObject(payload: unknown): RecordValue {
  const record = asRecord(payload);
  if (!record) throw invalidResponse('detail');
  for (const path of ['data.skill', 'data.item', 'skill', 'item', 'data']) {
    const candidate = asRecord(nested(record, path));
    if (candidate) return candidate;
  }
  return record;
}

function textDescription(record: RecordValue, fields: readonly string[] = ['description', 'summary', 'shortDescription']): string | undefined {
  return firstString(record, fields, MAX_DESCRIPTION_BYTES);
}

function rowMetadata(record: RecordValue, github?: GithubEvidence, extra: ReadonlyArray<readonly [string, unknown]> = []): Readonly<Record<string, SourceValue>> | undefined {
  const entries: Array<readonly [string, unknown]> = [...extra];
  if (github) {
    entries.push(['repository', github.repository]);
    if (github.path !== undefined) entries.push(['path', github.path]);
    if (github.ref !== undefined) entries.push(['ref', github.ref]);
  }
  return metadataOf(entries);
}

function makeRow(sourceId: SourceId, record: RecordValue, fields: {
  externalId: string;
  title: string;
  description?: string;
  version?: string;
  sourceUrl?: string;
  github?: GithubEvidence;
  snapshotDigest?: `sha256:${string}`;
  metadata?: Readonly<Record<string, SourceValue>>;
  installable?: boolean;
  unavailableReason?: string;
  sourceType?: string;
}): SourceSearchResult {
  const metadata: Record<string, SourceValue> = { ...(fields.metadata ?? {}) };
  if (fields.github) {
    metadata.repository = fields.github.repository;
    if (fields.github.path !== undefined) metadata.path = fields.github.path;
    if (fields.github.ref !== undefined) metadata.ref = fields.github.ref;
  }
  return {
    sourceId,
    externalId: fields.externalId,
    title: fields.title,
    ...(fields.description === undefined ? {} : { description: fields.description }),
    ...(fields.version === undefined ? {} : { version: fields.version }),
    ...(fields.sourceUrl === undefined ? {} : { sourceUrl: fields.sourceUrl }),
    ...(fields.github?.repository === undefined ? {} : { repository: fields.github.repository }),
    ...(fields.github?.path === undefined ? {} : { path: fields.github.path }),
    ...(fields.github?.ref === undefined ? {} : { ref: fields.github.ref }),
    installable: fields.installable ?? Boolean(fields.github?.repository),
    ...(fields.unavailableReason === undefined ? {} : { unavailableReason: fields.unavailableReason }),
    ...(fields.sourceType === undefined ? {} : { sourceType: fields.sourceType }),
    ...(fields.snapshotDigest === undefined ? {} : { snapshotDigest: fields.snapshotDigest }),
    ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
  };
}

function pickExternalId(record: RecordValue, github?: GithubEvidence, fallback?: string): string {
  const value = firstString(record, ['id', 'slug', 'name', 'skillId', 'skill_id'], MAX_EXTERNAL_ID_BYTES)
    ?? (github ? `${github.repository}${github.path ? `:${github.path}` : ''}` : fallback);
  if (!value) throw invalidResponse('id');
  return value;
}

function pickTitle(record: RecordValue, fallback = 'skill'): string {
  return firstString(record, ['displayName', 'name', 'title', 'slug', 'skillName', 'skill_name'], MAX_TITLE_BYTES) ?? fallback;
}

function pickVersion(record: RecordValue): string | undefined {
  return firstString(record, ['version', 'latestVersion', 'latest_version', 'manifest.version', 'release.version'], 256);
}

function mergeMetadata(...values: ReadonlyArray<Readonly<Record<string, SourceValue>> | undefined>): Readonly<Record<string, SourceValue>> | undefined {
  const merged: Record<string, SourceValue> = {};
  for (const value of values) if (value) Object.assign(merged, value);
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function externalRecordStatus(record: RecordValue): Readonly<Record<string, SourceValue>> | undefined {
  return metadataOf([
    ['providerSecurityGrade', firstUnknown(record, ['securityGrade', 'security_grade'])],
    ['providerSecurityScore', firstUnknown(record, ['securityScore', 'security_score'])],
    ['providerSecurityStatus', firstUnknown(record, ['securityStatus', 'security_status'])],
    ['providerReviewStatus', firstUnknown(record, ['reviewStatus', 'review_status'])],
    ['providerAiScore', firstUnknown(record, ['aiScore', 'ai_score'])],
  ]);
}

function mapGithubRecord(sourceId: SourceId, record: RecordValue, origin: string, extra: ReadonlyArray<readonly [string, unknown]> = []): ParsedProviderRecord {
  const github = githubEvidenceFromRecord(record);
  const externalId = pickExternalId(record, github);
  const title = pickTitle(record);
  const sourceUrl = safeProviderUrl(firstUnknown(record, ['skillUrl', 'skill_url', 'url', 'canonicalUrl', 'canonical_url']), origin)
    ?? (github?.sourceUrl ? safeProviderUrl(github.sourceUrl, REGISTRY_ORIGINS.github) : undefined);
  const snapshotDigest = optionalDigest(record, ['snapshotDigest', 'snapshotHash', 'contentHash', 'content_hash', 'digest', 'hash']);
  const metadata = mergeMetadata(rowMetadata(record, github, extra), externalRecordStatus(record));
  const row = makeRow(sourceId, record, {
    externalId,
    title,
    description: textDescription(record),
    version: pickVersion(record),
    sourceUrl,
    github,
    snapshotDigest,
    metadata,
    sourceType: github ? 'github' : undefined,
    installable: Boolean(github?.repository),
    unavailableReason: github ? undefined : 'The provider did not expose a physical GitHub source',
  });
  return { item: record, externalId, row, ...(github ? { github } : {}) };
}

function validateProviderOrigin(options: BaseRegistryAdapterOptions): SourceAvailability | undefined {
  if (options.trustedOrigins === undefined) return undefined;
  const normalized = options.trustedOrigins.map((value) => {
    try { return new URL(value).origin; } catch { return ''; }
  });
  if (!normalized.includes(options.origin)) {
    return { state: 'unavailable', code: 'origin_untrusted', reason: 'The source origin is not operator-trusted', retryable: false };
  }
  return undefined;
}

function sourceErrorFromUnknown(error: unknown, sourceId: SourceId): SourceCatalogError {
  if (error instanceof SourceCatalogError) {
    if (error.source === sourceId) return error;
    return new SourceCatalogError(error.code, error.message, error.status, { retryable: error.retryable, source: sourceId });
  }
  return new SourceCatalogError('SOURCE_UNAVAILABLE', 'The source request failed', 503, { retryable: true, source: sourceId });
}

class BoundedJsonHttp {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(
    private readonly sourceId: SourceId,
    options: RegistryAdapterOptions,
  ) {
    this.fetchImpl = options.fetch ?? defaultFetch();
    this.timeoutMs = boundedTimeout(options.requestTimeoutMs);
    this.maxResponseBytes = boundedResponseBytes(options.maxResponseBytes);
  }

  async json(url: string, expectedOrigin: string, init: RequestInit = {}, signal?: AbortSignal): Promise<unknown> {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new SourceCatalogError('SOURCE_ORIGIN_UNTRUSTED', 'The source URL is invalid', 502, { source: this.sourceId }); }
    if (parsed.protocol !== 'https:' || parsed.origin !== expectedOrigin || parsed.username || parsed.password || parsed.port) {
      throw new SourceCatalogError('SOURCE_ORIGIN_UNTRUSTED', 'The source URL is not trusted', 502, { source: this.sourceId });
    }
    if (signal?.aborted) throw new SourceCatalogError('SOURCE_TIMEOUT', 'The source request was cancelled', 504, { retryable: true, source: this.sourceId });

    const controller = new AbortController();
    let timedOut = false;
    let parentAborted = false;
    const onAbort = () => { parentAborted = true; controller.abort(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    try {
      const headers = new Headers(init.headers);
      if (!headers.has('accept')) headers.set('accept', 'application/json');
      const response = await this.fetchImpl(parsed.href, {
        ...init,
        headers,
        redirect: 'error',
        signal: controller.signal,
      });
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        throw new SourceCatalogError('SOURCE_ORIGIN_UNTRUSTED', 'The source redirected a request', 502, { source: this.sourceId });
      }
      if (response.url) {
        let responseUrl: URL;
        try { responseUrl = new URL(response.url); } catch { throw new SourceCatalogError('SOURCE_ORIGIN_UNTRUSTED', 'The source response URL is invalid', 502, { source: this.sourceId }); }
        if (responseUrl.origin !== expectedOrigin) throw new SourceCatalogError('SOURCE_ORIGIN_UNTRUSTED', 'The source response crossed origins', 502, { source: this.sourceId });
      }
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
        const status = response.status === 429 ? 429 : response.status >= 500 ? 503 : response.status;
        throw new SourceCatalogError('SOURCE_UNAVAILABLE', 'The source rejected the request', status, { retryable, source: this.sourceId });
      }
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isSafeInteger(declaredLength) && declaredLength > this.maxResponseBytes) {
        throw new SourceCatalogError('SOURCE_UNAVAILABLE', 'The source response exceeded the byte limit', 502, { retryable: false, source: this.sourceId });
      }
      const bytes = await this.readBounded(response);
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw invalidResponse('UTF-8 body'); }
      try { return JSON.parse(text) as unknown; } catch { throw invalidResponse('JSON body'); }
    } catch (error) {
      if (error instanceof SourceCatalogError) throw error;
      if (timedOut || parentAborted || controller.signal.aborted) {
        throw new SourceCatalogError('SOURCE_TIMEOUT', 'The source request timed out', 504, { retryable: true, source: this.sourceId });
      }
      throw sourceErrorFromUnknown(error, this.sourceId);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private async readBounded(response: Response): Promise<Uint8Array> {
    if (!response.body) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > this.maxResponseBytes) throw new SourceCatalogError('SOURCE_UNAVAILABLE', 'The source response exceeded the byte limit', 502, { source: this.sourceId });
      return bytes;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        const chunk = part.value instanceof Uint8Array ? part.value : new Uint8Array(part.value);
        total += chunk.byteLength;
        if (total > this.maxResponseBytes) {
          await reader.cancel();
          throw new SourceCatalogError('SOURCE_UNAVAILABLE', 'The source response exceeded the byte limit', 502, { source: this.sourceId });
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  }
}

abstract class BaseRegistryAdapter implements SourceCatalogAdapter {
  readonly id: SourceId;
  readonly label: string;
  readonly capabilities: readonly ('search' | 'resolve')[];
  readonly configRevision: string;
  protected readonly origin: string;
  protected readonly options: RegistryAdapterOptions;
  protected readonly http: BoundedJsonHttp;
  private readonly credentialEnv?: string;
  private readonly credentialRequired: boolean;
  private readonly configuredAvailability?: SourceAvailability;
  private readonly now: () => Date;

  protected constructor(options: BaseRegistryAdapterOptions, capabilities: readonly ('search' | 'resolve')[]) {
    this.id = options.id;
    this.label = options.label;
    this.capabilities = capabilities;
    this.configRevision = cleanString(options.configRevision, 256) ?? `builtin-${options.id}-v1`;
    this.origin = options.origin;
    this.options = options;
    this.http = new BoundedJsonHttp(this.id, options);
    this.credentialEnv = options.credentialEnv;
    this.credentialRequired = options.credentialRequired ?? false;
    this.now = options.now ?? (() => new Date());
    this.configuredAvailability = validateProviderOrigin(options)
      ?? (options.enabled === false ? { state: 'disabled', reason: 'The source is disabled by configuration' } : undefined);
  }

  availability(_context: SourceCatalogAdapterContext): SourceAvailability {
    if (this.configuredAvailability) return this.configuredAvailability;
    if (this.credentialRequired && !this.credential()) {
      return { state: 'unavailable', code: 'auth_missing', reason: `The source credential ${this.credentialEnv ?? 'credential'} is not configured`, retryable: false };
    }
    return { state: 'available' };
  }

  protected ensureAvailable(): void {
    const status = this.availability({ organizationId: 'adapter' });
    if (status.state === 'available') return;
    if (status.state === 'disabled') throw new SourceCatalogError('SOURCE_DISABLED', status.reason, 503, { source: this.id });
    throw new SourceCatalogError(status.code === 'origin_untrusted' ? 'SOURCE_ORIGIN_UNTRUSTED' : 'SOURCE_UNAVAILABLE', status.reason, 503, { retryable: status.retryable, source: this.id });
  }

  protected credential(): string | undefined {
    if (!this.credentialEnv) return this.options.apiKey;
    // An explicit environment snapshot is authoritative.  Falling back to
    // the ambient process environment would let a test/tenant-scoped adapter
    // accidentally borrow another deployment's credential.
    const environment = this.options.env ?? globalEnvironment();
    const value = this.options.apiKey ?? environment[this.credentialEnv];
    const credential = cleanString(value, 4_096);
    return credential;
  }

  protected providerHeaders(): Headers {
    const headers = new Headers({ accept: 'application/json' });
    const credential = this.credential();
    if (credential) headers.set('authorization', `Bearer ${credential}`);
    return headers;
  }

  protected async github(identity: GithubIdentity, signal?: AbortSignal): Promise<VerifiedGithubIdentity> {
    const repository = safeRepository(identity.repository);
    const path = identity.path === undefined ? undefined : safePath(identity.path, true);
    const ref = safeRef(identity.ref) ?? 'HEAD';
    if (!repository || (identity.path !== undefined && path === undefined)) throw invalidResponse('GitHub source identity');
    if (this.options.githubResolver) {
      const resolved = await this.options.githubResolver({ repository, ...(path === undefined ? {} : { path }), ref, ...(identity.skillHint === undefined ? {} : { skillHint: identity.skillHint }) }, signal);
      return validateVerifiedGithub(resolved);
    }
    return resolveGithubIdentity(this.http, { repository, ...(path === undefined ? {} : { path }), ref, ...(identity.skillHint === undefined ? {} : { skillHint: identity.skillHint }) }, signal, this.id);
  }

  protected resultLimit(input: SourceSearchRequest, providerMax: number): number {
    const configuredMax = this.options.maxResults === undefined
      ? providerMax
      : boundedLimit(this.options.maxResults, providerMax);
    return boundedLimit(input.limit, configuredMax);
  }

  protected resolution(row: SourceSearchResult, acquisition: SourceAcquisition, input: SourceResolveRequest, version: string, sourceUrl?: string, metadata?: Readonly<Record<string, SourceValue>>): SourceResolution {
    return {
      sourceId: this.id,
      externalId: input.externalId,
      row,
      reference: sourceResolutionReference(this.id, input.externalId, version, acquisition),
      title: row.title,
      ...(row.description === undefined ? {} : { description: row.description }),
      version,
      ...(row.sourceType === undefined ? {} : { sourceType: row.sourceType }),
      ...(sourceUrl ?? row.sourceUrl) === undefined ? {} : { sourceUrl: sourceUrl ?? row.sourceUrl },
      ...(row.snapshotDigest === undefined ? {} : { snapshotDigest: row.snapshotDigest }),
      ...(metadata ?? row.metadata) === undefined ? {} : { metadata: metadata ?? row.metadata },
      acquisition,
      configRevision: this.configRevision,
      resolvedAt: this.now().toISOString(),
    };
  }

  abstract search(input: SourceSearchRequest): Promise<readonly SourceSearchResult[]>;
  abstract resolve(input: SourceResolveRequest): Promise<SourceResolution>;
}

function sourceResolutionReference(sourceId: SourceId, externalId: string, version: string, acquisition: SourceAcquisition): string {
  if (acquisition.kind === 'polyskill') return `${sourceId}:${acquisition.name}@${acquisition.version}`;
  if (acquisition.kind === 'clawhub') return `${sourceId}:${acquisition.owner}/${acquisition.slug}@${acquisition.version}`;
  return `${sourceId}:${externalId}@${version}`;
}

function validateVerifiedGithub(identity: VerifiedGithubIdentity): VerifiedGithubIdentity {
  const repository = safeRepository(identity.repository);
  const path = safePath(identity.path, true);
  const ref = safeRef(identity.ref);
  if (!repository || path === undefined || !ref || !COMMIT_RE.test(ref)) throw invalidResponse('verified GitHub source identity');
  return {
    repository,
    path,
    ref,
    sourceUrl: safeProviderUrl(identity.sourceUrl ?? canonicalGithubUrl({ repository, path, ref }), REGISTRY_ORIGINS.github) ?? canonicalGithubUrl({ repository, path, ref }),
  };
}

async function resolveGithubIdentity(http: BoundedJsonHttp, identity: GithubIdentity, signal?: AbortSignal, sourceId: SourceId = 'github-code-search'): Promise<VerifiedGithubIdentity> {
  const repository = safeRepository(identity.repository);
  const requestedPath = identity.path === undefined ? undefined : normalizeGithubDirectoryPath(identity.path);
  const requestedRef = safeRef(identity.ref) ?? 'HEAD';
  if (!repository || (identity.path !== undefined && requestedPath === undefined)) throw invalidResponse('GitHub source identity');

  let commit = requestedRef;
  if (!COMMIT_RE.test(commit)) {
    const commitPayload = await http.json(
      `${REGISTRY_ORIGINS.githubApi}/repos/${repository}/commits/${requestedRef.split('/').map((part) => encodeURIComponent(part)).join('/')}`,
      REGISTRY_ORIGINS.githubApi,
      { method: 'GET', headers: new Headers({ accept: 'application/vnd.github+json' }) },
      signal,
    );
    commit = requiredString(asRecord(commitPayload)?.sha, 'GitHub commit', 128);
    if (!COMMIT_RE.test(commit)) throw invalidResponse('GitHub commit');
  }

  let path: string;
  if (requestedPath === undefined || requestedPath === '') {
    const treePayload = await http.json(
      `${REGISTRY_ORIGINS.githubApi}/repos/${repository}/git/trees/${encodeURIComponent(commit)}?recursive=1`,
      REGISTRY_ORIGINS.githubApi,
      { method: 'GET', headers: new Headers({ accept: 'application/vnd.github+json' }) },
      signal,
    );
    const treeRecord = asRecord(treePayload);
    if (treeRecord?.truncated === true) throw new SourceCatalogError('SOURCE_RESOLUTION_INVALID', 'The GitHub source tree was truncated', 502, { source: sourceId });
    if (!Array.isArray(treeRecord?.tree)) throw new SourceCatalogError('SOURCE_RESOLUTION_INVALID', 'The GitHub source tree was missing', 502, { source: sourceId });
    if (treeRecord.tree.length > MAX_GITHUB_TREE_ENTRIES) throw new SourceCatalogError('SOURCE_RESOLUTION_INVALID', 'The GitHub source tree exceeded its entry bound', 502, { source: sourceId });
    const candidates = treeRecord.tree.flatMap((value) => {
      const entry = asRecord(value);
      if (!entry || entry.type !== 'blob' || typeof entry.path !== 'string') return [];
      const folder = githubSkillFolder(entry.path);
      return folder === undefined ? [] : [{ folder, filePath: entry.path }];
    });
    if (requestedPath === '') {
      if (!candidates.some((candidate) => candidate.folder === '')) throw new SourceCatalogError('SOURCE_RESOLUTION_INVALID', 'The GitHub repository has no root SKILL.md', 502, { source: sourceId });
      path = '';
    } else {
      const hint = normalizedSkillHint(identity.skillHint);
      let matches = hint === undefined
        ? []
        : candidates.filter((candidate) => folderLeaf(candidate.folder).toLocaleLowerCase('en-US') === hint);
      if (matches.length !== 1 && hint !== undefined) {
        if (candidates.length > MAX_GITHUB_METADATA_CANDIDATES) throw new SourceCatalogError('SOURCE_RESOLUTION_INVALID', 'The GitHub repository has too many SKILL.md candidates to disambiguate safely', 502, { source: sourceId });
        const frontmatterMatches: typeof candidates = [];
        for (const candidate of candidates) {
          const name = await githubFrontmatterName(http, repository, candidate.filePath, commit, signal);
          if (name !== undefined && normalizedSkillHint(name) === hint) frontmatterMatches.push(candidate);
        }
        matches = frontmatterMatches;
      }
      if (matches.length === 1) path = matches[0]!.folder;
      else if (candidates.length === 1 && hint === undefined) path = candidates[0]!.folder;
      else throw new SourceCatalogError('SOURCE_RESOLUTION_INVALID', candidates.length === 0 ? 'The GitHub repository has no SKILL.md' : 'The GitHub repository has no unambiguous SKILL.md matching the catalog identity', 502, { source: sourceId });
    }
  } else {
    path = requestedPath;
    const contentsPath = path.split('/').map((part) => encodeURIComponent(part)).join('/');
    const contentsPayload = await http.json(
      `${REGISTRY_ORIGINS.githubApi}/repos/${repository}/contents/${contentsPath}?ref=${encodeURIComponent(commit)}`,
      REGISTRY_ORIGINS.githubApi,
      { method: 'GET', headers: new Headers({ accept: 'application/vnd.github+json' }) },
      signal,
    );
    const contents = Array.isArray(contentsPayload) ? contentsPayload : [contentsPayload];
    const hasSkill = contents.some((item) => {
      const record = asRecord(item);
      return record?.type === 'file' && record.name === 'SKILL.md';
    });
    if (!hasSkill) throw new SourceCatalogError('SOURCE_RESOLUTION_INVALID', 'The selected GitHub directory has no exact SKILL.md', 502, { source: sourceId });
  }
  return validateVerifiedGithub({ repository, path, ref: commit, sourceUrl: canonicalGithubUrl({ repository, path, ref: commit }) });
}

function normalizeGithubDirectoryPath(value: string): string | undefined {
  const path = safePath(value, true);
  if (path === undefined) return undefined;
  if (path === 'SKILL.md') return '';
  return path.endsWith('/SKILL.md') ? path.slice(0, -'/SKILL.md'.length) : path;
}

function githubSkillFolder(value: string): string | undefined {
  const path = safePath(value, false);
  if (path === undefined || path !== 'SKILL.md' && !path.endsWith('/SKILL.md')) return undefined;
  return path === 'SKILL.md' ? '' : path.slice(0, -'/SKILL.md'.length);
}

function folderLeaf(value: string): string {
  return value.split('/').at(-1) ?? value;
}

function normalizedSkillHint(value: unknown): string | undefined {
  const text = cleanString(value, 512);
  if (!text) return undefined;
  const leaf = text.replace(/^@/u, '').split('/').at(-1) ?? text;
  const normalized = leaf.replace(/\.md$/iu, '').trim().toLocaleLowerCase('en-US');
  return normalized || undefined;
}

async function githubFrontmatterName(http: BoundedJsonHttp, repository: string, filePath: string, ref: string, signal?: AbortSignal): Promise<string | undefined> {
  const contentsPath = filePath.split('/').map((part) => encodeURIComponent(part)).join('/');
  const payload = await http.json(
    `${REGISTRY_ORIGINS.githubApi}/repos/${repository}/contents/${contentsPath}?ref=${encodeURIComponent(ref)}`,
    REGISTRY_ORIGINS.githubApi,
    { method: 'GET', headers: new Headers({ accept: 'application/vnd.github+json' }) },
    signal,
  );
  const record = asRecord(payload);
  if (!record || record.type !== 'file' || record.name !== 'SKILL.md' || record.encoding !== 'base64' || typeof record.content !== 'string') return undefined;
  const size = record.size;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1 || size > MAX_GITHUB_SKILL_FILE_BYTES) return undefined;
  const bytes = decodeBase64(record.content);
  if (bytes.byteLength !== size) return undefined;
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return undefined; }
  const lines = text.split(/\r?\n/u);
  if (lines[0]?.trim() !== '---') return undefined;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0 || end > 200) return undefined;
  for (const line of lines.slice(1, end)) {
    const match = /^name:[ \t]*(.*)$/u.exec(line);
    if (match) return cleanString(match[1], 512);
  }
  return undefined;
}

function decodeBase64(value: string): Uint8Array {
  const normalized = value.replace(/[\r\n\t ]/gu, '');
  if (normalized.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized) || normalized.length % 4 !== 0) return new Uint8Array();
  try {
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return new Uint8Array();
  }
}

function githubAcquisition(identity: VerifiedGithubIdentity): SourceAcquisition {
  return {
    kind: 'github',
    repository: identity.repository,
    path: identity.path,
    ref: identity.ref,
    sourceProviderOrigin: REGISTRY_ORIGINS.github,
  };
}

function clawHubAcquisition(owner: string, slug: string, version: string, files: readonly ClawHubFile[]): SourceAcquisition {
  return {
    kind: 'clawhub',
    owner,
    slug,
    version,
    files,
    sourceProviderOrigin: REGISTRY_ORIGINS.clawhub,
  };
}

interface ClawHubCoordinate {
  owner?: string;
  slug: string;
  packageName: string;
  canonical: string;
}

function parseNativeCoordinate(value: unknown): { owner?: string; slug: string } | undefined {
  const text = cleanString(value, MAX_EXTERNAL_ID_BYTES);
  if (!text) return undefined;
  const normalized = text.replace(/^clawhub:/u, '').replace(/^@/u, '').replace(/^\/+|\/+$/gu, '');
  const parts = normalized.split('/');
  if (parts.length === 1 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(parts[0]!)) return { slug: parts[0]! };
  if (parts.length === 2 && parts.every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(part))) return { owner: parts[0]!, slug: parts[1]! };
  return undefined;
}

function ownerSlug(record: RecordValue, externalId: string): ClawHubCoordinate {
  const installCoordinate = parseNativeCoordinate(firstUnknown(record, ['install.reference', 'installReference']));
  const idCoordinate = parseNativeCoordinate(externalId);
  const recordOwner = firstString(record, ['ownerHandle', 'owner.handle', 'publisher.handle', 'author.handle', 'author', 'author_name'], 256);
  const owner = recordOwner?.replace(/^@/u, '') ?? installCoordinate?.owner ?? idCoordinate?.owner;
  const slug = firstString(record, ['slug', 'name', 'skillName', 'skill_name'], 512)
    ?? installCoordinate?.slug
    ?? idCoordinate?.slug;
  if (!slug) throw invalidResponse('native skill slug');
  const safeSlug = safeInstallName(slug);
  if (!safeSlug || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(safeSlug)) throw invalidResponse('native skill slug');
  const safeOwner = owner ? safeInstallName(owner.replace(/^@/u, '')) : undefined;
  if (safeOwner !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(safeOwner)) throw invalidResponse('native skill owner');
  const packageName = safeOwner ? `@${safeOwner}/${safeSlug}` : safeSlug;
  // Search/install references are documented as owner/slug. Keep the npm-like
  // @owner/slug spelling only in the native packageName used by OpenClaw
  // compatibility; the catalog external id stays stable across both forms.
  return { owner: safeOwner, slug: safeSlug, packageName, canonical: safeOwner ? `${safeOwner}/${safeSlug}` : safeSlug };
}

function clawHubVersion(record: RecordValue): string | undefined {
  return pickVersion(record) ?? firstString(record, ['native.version.version', 'latestVersion.version'], 256);
}

function clawHubCanonical(record: RecordValue, externalId: string): string {
  const coordinate = ownerSlug(record, externalId);
  const path = coordinate.owner ? `/${encodeURIComponent(coordinate.owner)}/skills/${encodeURIComponent(coordinate.slug)}` : `/skills/${encodeURIComponent(coordinate.slug)}`;
  return providerPageUrl(REGISTRY_ORIGINS.clawhub, path);
}

export class SkillsMpAdapter extends BaseRegistryAdapter {
  constructor(options: RegistryAdapterOptions = {}) {
    super({ ...options, id: 'skillsmp', label: 'SkillsMP', origin: REGISTRY_ORIGINS.skillsmp, credentialEnv: 'SKILLSMP_API_KEY' }, ['search', 'resolve']);
  }

  async search(input: SourceSearchRequest): Promise<readonly SourceSearchResult[]> {
    this.ensureAvailable();
    assertSourceRequest(input, this.id);
    const query = validateQuery(input.query);
    const limit = this.resultLimit(input, 50);
    const url = new URL('/api/v1/skills/search', REGISTRY_ORIGINS.skillsmp);
    url.searchParams.set('q', query);
    url.searchParams.set('page', '1');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('sortBy', 'stars');
    const payload = await this.http.json(url.href, REGISTRY_ORIGINS.skillsmp, { method: 'GET', headers: this.providerHeaders() }, input.signal);
    const records = unwrapArray(payload, ['data.skills', 'skills', 'data']);
    return records.slice(0, limit).map((record) => {
      const parsed = this.map(record);
      return lookupRow(parsed.row, parsed.externalId, query, limit);
    });
  }

  async resolve(input: SourceResolveRequest): Promise<SourceResolution> {
    this.ensureAvailable();
    assertSourceRequest(input, this.id);
    const externalId = assertExternalId(input.externalId, this.id);
    const lookup = resolveLookup(externalId);
    const record = await this.lookup(lookup.nativeId, lookup.query, input.signal, lookup.limit ?? 50);
    const parsed = this.map(record);
    if (!parsed.github) throw new SourceCatalogError('SOURCE_RESOLUTION_INVALID', 'SkillsMP did not expose a GitHub source', 502, { source: this.id });
    const github = await this.github(parsed.github, input.signal);
    const row = makeRow(this.id, record, {
      externalId,
      title: parsed.row.title,
      description: parsed.row.description,
      version: parsed.row.version,
      sourceUrl: canonicalGithubUrl(github),
      github,
      snapshotDigest: parsed.row.snapshotDigest,
      metadata: parsed.row.metadata,
      sourceType: 'github',
      installable: true,
    });
    return this.resolution(row, githubAcquisition(github), input, parsed.row.version ?? github.ref, canonicalGithubUrl(github));
  }

  private map(record: RecordValue): ParsedProviderRecord {
    const parsed = mapGithubRecord(this.id, record, REGISTRY_ORIGINS.skillsmp, [
      ['stars', firstUnknown(record, ['stars'])],
      ['contentLanguage', firstUnknown(record, ['contentLanguage', 'content_language'])],
      ['updatedAt', firstUnknown(record, ['updatedAt', 'updated_at'])],
    ]);
    return parsed;
  }

  private async lookup(externalId: string, query: string, signal?: AbortSignal, limit = 50): Promise<RecordValue> {
    // SkillsMP documents only search, so exact resolution is a bounded search
    // match. A fuzzy match is rejected rather than turned into a new source.
    const url = new URL('/api/v1/skills/search', REGISTRY_ORIGINS.skillsmp);
    url.searchParams.set('q', validateQuery(query));
    url.searchParams.set('page', '1');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('sortBy', 'stars');
    const payload = await this.http.json(url.href, REGISTRY_ORIGINS.skillsmp, { method: 'GET', headers: this.providerHeaders() }, signal);
    const records = unwrapArray(payload, ['data.skills', 'skills', 'data']);
    const matches = records.filter((record) => pickExternalId(record, githubEvidenceFromRecord(record)) === externalId);
    if (matches.length !== 1) throw invalidExternalId(this.id, matches.length === 0 ? 'SkillsMP returned no exact source identity' : 'SkillsMP returned an ambiguous source identity');
    return matches[0]!;
  }
}

export class ClawHubAdapter extends BaseRegistryAdapter {
  constructor(options: RegistryAdapterOptions = {}) {
    super({ ...options, id: 'clawhub', label: 'ClawHub', origin: REGISTRY_ORIGINS.clawhub }, ['search', 'resolve']);
  }

  async search(input: SourceSearchRequest): Promise<readonly SourceSearchResult[]> {
    this.ensureAvailable();
    assertSourceRequest(input, this.id);
    const query = validateQuery(input.query);
    const limit = this.resultLimit(input, 100);
    const url = new URL('/api/v1/search', REGISTRY_ORIGINS.clawhub);
    url.searchParams.set('q', query);
    url.searchParams.set('nonSuspiciousOnly', 'true');
    const payload = await this.http.json(url.href, REGISTRY_ORIGINS.clawhub, { method: 'GET', headers: this.providerHeaders() }, input.signal);
    const records = unwrapArray(payload, ['results', 'skills', 'data']);
    const results: SourceSearchResult[] = [];
    for (const record of records) {
      // ClawHub's search is a unified catalog. Rows sourced from skills.sh are
      // deliberately excluded because their identity belongs to that source.
      const source = firstString(record, ['source'], 128);
      if (source && source !== 'clawhub') continue;
      const parsed = this.map(record);
      results.push(parsed.row);
      if (results.length >= limit) break;
    }
    return results;
  }

  async resolve(input: SourceResolveRequest): Promise<SourceResolution> {
    this.ensureAvailable();
    assertSourceRequest(input, this.id);
    const externalId = assertExternalId(input.externalId, this.id);
    const coordinate = parseClawHubExternalId(externalId);
    // ClawHub documents the detail endpoint by slug.  The owner is checked
    // against the returned owner handle so a same-slug result cannot cross
    // publisher boundaries.
    const payload = await this.http.json(`${REGISTRY_ORIGINS.clawhub}/api/v1/skills/${encodeURIComponent(coordinate.slug)}`, REGISTRY_ORIGINS.clawhub, { method: 'GET', headers: this.providerHeaders() }, input.signal);
    const rawPayload = asRecord(payload);
    const detailSkill = unwrapObject(payload);
    const record = rawPayload?.owner && asRecord(rawPayload.owner)
      ? { ...detailSkill, owner: rawPayload.owner }
      : detailSkill;
    const returnedOwner = firstString(record, ['ownerHandle', 'owner.handle', 'publisher.handle', 'author.handle'], 256);
    const returnedSlug = firstString(record, ['slug'], 512);
    if (!returnedOwner || !returnedSlug) {
      throw invalidExternalId(this.id, 'ClawHub detail did not expose a publisher and slug');
    }
    const detailCoordinate = ownerSlug(record, coordinate.canonical);
    if (!detailCoordinate.owner || detailCoordinate.slug !== returnedSlug || returnedSlug !== coordinate.slug || detailCoordinate.owner !== returnedOwner.replace(/^@/u, '') || (coordinate.owner !== undefined && detailCoordinate.owner !== coordinate.owner)) {
      throw invalidExternalId(this.id, 'ClawHub detail identity did not match the requested source');
    }
    const detailVersion = pickVersion(record) ?? firstString(rawPayload ?? {}, ['latestVersion.version'], 256);
    if (!detailVersion) throw new SourceCatalogError('SOURCE_RESOLUTION_INVALID', 'ClawHub did not expose a version', 502, { source: this.id });
    const versionPayload = await this.http.json(
      `${REGISTRY_ORIGINS.clawhub}/api/v1/skills/${encodeURIComponent(detailCoordinate.slug)}/versions/${encodeURIComponent(detailVersion)}`,
      REGISTRY_ORIGINS.clawhub,
      { method: 'GET', headers: this.providerHeaders() },
      input.signal,
    );
    const versionPayloadRecord = asRecord(versionPayload);
    const versionRecord = asRecord(versionPayloadRecord?.version) ?? versionPayloadRecord;
    const returnedVersion = firstString(versionRecord ?? {}, ['version'], 256);
    if (returnedVersion !== detailVersion) throw new SourceCatalogError('SOURCE_RESOLUTION_INVALID', 'ClawHub version identity did not match the requested source', 502, { source: this.id });
    const versionSkill = asRecord(versionPayloadRecord?.skill);
    const versionReturnedSlug = firstString(versionSkill ?? {}, ['slug'], 512);
    if (versionReturnedSlug !== detailCoordinate.slug) throw new SourceCatalogError('SOURCE_RESOLUTION_INVALID', 'ClawHub version skill identity did not match the requested source', 502, { source: this.id });
    const files = parseClawHubFiles(versionRecord?.files);
    const parsed = this.map(record, coordinate.canonical);
    if (files === undefined) throw new SourceCatalogError('SOURCE_RESOLUTION_INVALID', 'ClawHub did not expose a version file manifest', 502, { source: this.id });
    const snapshotDigest = await clawHubSnapshotDigest(detailCoordinate, detailVersion, files);
    const row = makeRow(this.id, record, {
      externalId,
      title: parsed.row.title,
      description: parsed.row.description,
      version: detailVersion,
      sourceUrl: clawHubCanonical(record, coordinate.canonical),
      snapshotDigest,
      metadata: parsed.row.metadata,
      sourceType: 'clawhub',
      installable: true,
    });
    return this.resolution(row, clawHubAcquisition(detailCoordinate.owner, detailCoordinate.slug, detailVersion, files), input, detailVersion, row.sourceUrl);
  }

  private map(record: RecordValue, fallbackId?: string): ParsedProviderRecord {
    const nativeCoordinate = ownerSlug(record, fallbackId ?? pickExternalId(record));
    // ClawHub search ids are opaque database identifiers.  The documented
    // install reference (owner/slug) is the stable source identity.
    const externalId = nativeCoordinate.canonical;
    const coordinate = nativeCoordinate;
    const version = clawHubVersion(record);
    const canonical = clawHubCanonical(record, externalId);
    const metadata = mergeMetadata(metadataOf([
      ['downloads', firstUnknown(record, ['downloads', 'metrics.downloads', 'native.skill.stats.downloads'])],
      ['score', firstUnknown(record, ['score'])],
      ['official', firstUnknown(record, ['official'])],
      ['source', firstUnknown(record, ['source'])],
      ['owner', coordinate.owner],
      ['providerSuspicious', firstUnknown(record, ['native.skill.isSuspicious', 'isSuspicious'])],
    ]), externalRecordStatus(record));
    const row = makeRow(this.id, record, {
      externalId,
      title: pickTitle(record, coordinate.slug),
      // ClawHub detail responses put the complete SKILL.md in `description`;
      // use the documented summary for catalog metadata and keep the full
      // instructions out of the discovery response.
      description: textDescription(record, ['summary', 'shortDescription', 'description']),
      version,
      sourceUrl: canonical,
      metadata,
      sourceType: 'clawhub',
      // A search row can be resolved through the documented version manifest;
      // the version digest is intentionally learned only during resolve.
      installable: Boolean(coordinate.slug),
      unavailableReason: undefined,
    });
    return { item: record, externalId, row };
  }
}

function parseClawHubExternalId(value: string): ClawHubCoordinate {
  const normalized = value.replace(/^@/u, '');
  const parts = normalized.split('/');
  if (parts.length === 1 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(parts[0]!)) {
    return { slug: parts[0]!, packageName: parts[0]!, canonical: parts[0]! };
  }
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(part))) throw invalidExternalId('clawhub');
  return { owner: parts[0]!, slug: parts[1]!, packageName: `@${parts[0]}/${parts[1]}`, canonical: `${parts[0]}/${parts[1]}` };
}

function parseClawHubFiles(value: unknown): readonly ClawHubFile[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_NATIVE_FILES) return undefined;
  const files: ClawHubFile[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const item of value) {
    const record = asRecord(item);
    const path = safePath(record?.path, false);
    const size = record?.size;
    const sha256 = cleanString(record?.sha256 ?? record?.hash, 128);
    if (path === undefined || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || size > MAX_NATIVE_FILE_BYTES || !sha256 || !HEX_SHA256_RE.test(sha256) || seen.has(path)) return undefined;
    total += size;
    if (total > MAX_NATIVE_TOTAL_BYTES) return undefined;
    seen.add(path);
    files.push({ path, size, sha256 });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

async function clawHubSnapshotDigest(coordinate: ClawHubCoordinate, version: string, files: readonly ClawHubFile[]): Promise<`sha256:${string}`> {
  const canonical = JSON.stringify({
    owner: coordinate.owner ?? null,
    slug: coordinate.slug,
    version,
    files: files.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 })),
  });
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new SourceCatalogError('SOURCE_UNAVAILABLE', 'Web Crypto is unavailable for ClawHub identity verification', 503, { source: 'clawhub', retryable: true });
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export class SkillHubPublicAdapter extends BaseRegistryAdapter {
  constructor(options: RegistryAdapterOptions = {}) {
    super({ ...options, id: 'skillhub-public', label: 'SkillHub Public', origin: REGISTRY_ORIGINS.skillhubPublic }, ['search', 'resolve']);
  }

  async search(input: SourceSearchRequest): Promise<readonly SourceSearchResult[]> {
    this.ensureAvailable();
    assertSourceRequest(input, this.id);
    const query = validateQuery(input.query);
    const limit = this.resultLimit(input, 100);
    const url = new URL('/api/skills', REGISTRY_ORIGINS.skillhubPublic);
    url.searchParams.set('q', query);
    url.searchParams.set('limit', String(limit));
    const payload = await this.http.json(url.href, REGISTRY_ORIGINS.skillhubPublic, { method: 'GET', headers: this.providerHeaders() }, input.signal);
    const records = unwrapArray(payload, ['skills', 'data']);
    return records.slice(0, limit).map((record) => {
      const parsed = this.map(record);
      return lookupRow(parsed.row, parsed.externalId, query, limit);
    });
  }

  async resolve(input: SourceResolveRequest): Promise<SourceResolution> {
    this.ensureAvailable();
    assertSourceRequest(input, this.id);
    const externalId = assertExternalId(input.externalId, this.id);
    const lookup = resolveLookup(externalId);
    const record = await this.lookup(lookup.nativeId, lookup.query, input.signal, lookup.limit ?? 100);
    const parsed = this.map(record, lookup.nativeId);
    if (!parsed.github) throw new SourceCatalogError('SOURCE_RESOLUTION_INVALID', 'SkillHub Public did not expose a GitHub repository', 502, { source: this.id });
    const github = await this.github(parsed.github, input.signal);
    const row = makeRow(this.id, record, {
      externalId,
      title: parsed.row.title,
      description: parsed.row.description,
      version: parsed.row.version,
      sourceUrl: canonicalGithubUrl(github),
      github,
      snapshotDigest: parsed.row.snapshotDigest,
      metadata: parsed.row.metadata,
      sourceType: 'github',
      installable: true,
    });
    return this.resolution(row, githubAcquisition(github), input, parsed.row.version ?? github.ref, canonicalGithubUrl(github));
  }

  private async lookup(externalId: string, query: string, signal?: AbortSignal, limit = 100): Promise<RecordValue> {
    // SkillHub Public documents a detail-looking URL, but public deployments
    // may reject it. Re-query the documented search surface and require one
    // exact native id before accepting any GitHub evidence.
    const url = new URL('/api/skills', REGISTRY_ORIGINS.skillhubPublic);
    url.searchParams.set('q', validateQuery(query));
    url.searchParams.set('limit', String(limit));
    const payload = await this.http.json(url.href, REGISTRY_ORIGINS.skillhubPublic, { method: 'GET', headers: this.providerHeaders() }, signal);
    const records = unwrapArray(payload, ['skills', 'data']);
    const matches = records.filter((record) => pickExternalId(record, githubEvidenceFromRecord(record)) === externalId);
    if (matches.length !== 1) throw invalidExternalId(this.id, matches.length === 0 ? 'SkillHub Public returned no exact source identity' : 'SkillHub Public returned an ambiguous source identity');
    return matches[0]!;
  }

  private map(record: RecordValue, fallbackId?: string): ParsedProviderRecord {
    const github = githubEvidenceFromRecord(record);
    const externalId = pickExternalId(record, github, fallbackId);
    const sourceUrl = safeProviderUrl(firstUnknown(record, ['url', 'skillUrl', 'skill_url']), REGISTRY_ORIGINS.skillhubPublic)
      ?? providerPageUrl(REGISTRY_ORIGINS.skillhubPublic, `/skill/${externalId.split('/').map((part) => encodeURIComponent(part)).join('/')}`);
    const metadata = mergeMetadata(rowMetadata(record, github, [
      ['githubStars', firstUnknown(record, ['githubStars', 'github_stars'])],
      ['downloads', firstUnknown(record, ['downloadCount', 'download_count'])],
      ['providerSecurityScore', firstUnknown(record, ['securityScore', 'security_score'])],
      ['providerSecurityStatus', firstUnknown(record, ['securityStatus', 'security_status'])],
      ['providerAiScore', firstUnknown(record, ['aiScore', 'ai_score'])],
      ['providerReviewStatus', firstUnknown(record, ['reviewStatus', 'review_status'])],
      ['sourceFormat', firstUnknown(record, ['sourceFormat', 'source_format'])],
    ]), externalRecordStatus(record));
    const row = makeRow(this.id, record, {
      externalId,
      title: pickTitle(record),
      description: textDescription(record),
      version: pickVersion(record),
      sourceUrl,
      github,
      metadata,
      sourceType: github ? 'github' : undefined,
      installable: Boolean(github?.repository),
      unavailableReason: github ? undefined : 'SkillHub Public did not expose a GitHub repository',
    });
    return { item: record, externalId, row, ...(github ? { github } : {}) };
  }
}

export class PolySkillAdapter extends BaseRegistryAdapter {
  constructor(options: RegistryAdapterOptions = {}) {
    super({ ...options, id: 'polyskill', label: 'PolySkill', origin: REGISTRY_ORIGINS.polyskill }, ['search', 'resolve']);
  }

  async search(input: SourceSearchRequest): Promise<readonly SourceSearchResult[]> {
    this.ensureAvailable();
    assertSourceRequest(input, this.id);
    const query = validateQuery(input.query);
    const limit = this.resultLimit(input, 100);
    const url = new URL('/api/skills', REGISTRY_ORIGINS.polyskill);
    url.searchParams.set('q', query);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('sort', 'relevance');
    const payload = await this.http.json(url.href, REGISTRY_ORIGINS.polyskill, { method: 'GET', headers: this.providerHeaders() }, input.signal);
    const records = unwrapArray(payload, ['skills', 'data.skills', 'data']);
    return records.slice(0, limit).map((record) => this.map(record).row);
  }

  async resolve(input: SourceResolveRequest): Promise<SourceResolution> {
    this.ensureAvailable();
    assertSourceRequest(input, this.id);
    const externalId = assertExternalId(input.externalId, this.id);
    const coordinate = parsePolySkillExternalId(externalId);
    const payload = await this.http.json(
      `${REGISTRY_ORIGINS.polyskill}/api/skills/${encodeURIComponent(coordinate.name)}${coordinate.version === undefined ? '' : `/${encodeURIComponent(coordinate.version)}`}`,
      REGISTRY_ORIGINS.polyskill,
      { method: 'GET', headers: this.providerHeaders() },
      input.signal,
    );
    const record = unwrapObject(payload);
    const parsed = this.map(record, externalId);
    if (isPolySkillNativeRecord(record)) {
      let native: ReturnType<typeof parsePolyskillNativeSkill>;
      try {
        native = parsePolyskillNativeSkill(record);
      } catch (error) {
        throw new SourceCatalogError('SOURCE_RESOLUTION_INVALID', error instanceof Error ? error.message.slice(0, 512) : 'PolySkill native package is invalid', 502, { source: this.id });
      }
      let identity: Awaited<ReturnType<typeof polyskillNativeIdentity>>;
      try {
        identity = await polyskillNativeIdentity(native);
      } catch (error) {
        throw new SourceCatalogError('SOURCE_RESOLUTION_INVALID', error instanceof Error ? error.message.slice(0, 512) : 'PolySkill native identity is invalid', 502, { source: this.id });
      }
      if (identity.name !== coordinate.name || (coordinate.version !== undefined && identity.version !== coordinate.version)) {
        throw new SourceCatalogError('SOURCE_INVALID_EXTERNAL_ID', 'PolySkill detail identity did not match the requested source', 400, { source: this.id });
      }
      const row = makeRow(this.id, record, {
        externalId,
        title: parsed.row.title,
        description: parsed.row.description,
        version: identity.version,
        sourceUrl: parsed.row.sourceUrl,
        snapshotDigest: identity.contentDigest,
        metadata: parsed.row.metadata,
        sourceType: 'polyskill',
        installable: true,
      });
      return this.resolution(row, {
        kind: 'polyskill',
        name: identity.name,
        version: identity.version,
        contentDigest: identity.contentDigest,
        sourceProviderOrigin: REGISTRY_ORIGINS.polyskill,
      }, input, identity.version, row.sourceUrl);
    }
    if (!parsed.github) throw new SourceCatalogError('SOURCE_RESOLUTION_INVALID', 'PolySkill did not expose a physical GitHub source', 502, { source: this.id });
    const github = await this.github(parsed.github, input.signal);
    const row = makeRow(this.id, record, {
      externalId,
      title: parsed.row.title,
      description: parsed.row.description,
      version: parsed.row.version,
      sourceUrl: canonicalGithubUrl(github),
      github,
      snapshotDigest: parsed.row.snapshotDigest,
      metadata: parsed.row.metadata,
      sourceType: 'github',
      installable: true,
    });
    return this.resolution(row, githubAcquisition(github), input, parsed.row.version ?? github.ref, canonicalGithubUrl(github));
  }

  private map(raw: RecordValue, fallbackId?: string): ParsedProviderRecord {
    const manifest = asRecord(raw.manifest) ?? raw;
    const record = { ...raw, manifest };
    const native = isPolySkillNativeRecord(record);
    const github = native ? undefined : githubEvidenceFromRecord(record);
    const name = firstString(manifest, ['name']) ?? firstString(raw, ['name', 'slug']) ?? fallbackId ?? 'skill';
    const version = pickVersion(record);
    const nativeName = normalizePolySkillName(name);
    const externalId = nativeName === undefined
      ? pickExternalId(record, github, fallbackId ?? name)
      : `${nativeName}${version === undefined ? '' : `@${version}`}`;
    const publisher = firstString(manifest, ['author.name']) ?? firstString(raw, ['author', 'author_name']);
    const listing = safeInstallName(name) && name.includes('/')
      ? providerPageUrl(REGISTRY_ORIGINS.polyskill, `/skill/${name.split('/').map((part) => encodeURIComponent(part)).join('/')}`)
      : undefined;
    const metadata = mergeMetadata(rowMetadata(record, github, [
      ['type', firstUnknown(manifest, ['type']) ?? firstUnknown(raw, ['type'])],
      ['license', firstUnknown(manifest, ['license']) ?? firstUnknown(raw, ['license'])],
      ['category', firstUnknown(manifest, ['category']) ?? firstUnknown(raw, ['category'])],
      ['publisher', publisher],
      ['providerVerified', firstUnknown(raw, ['verified'])],
      ['downloads', firstUnknown(raw, ['downloads'])],
      ['stars', firstUnknown(raw, ['stars'])],
      ['score', firstUnknown(raw, ['score'])],
    ]), externalRecordStatus(record));
    const row = makeRow(this.id, record, {
      externalId,
      title: cleanString(name, MAX_TITLE_BYTES) ?? 'skill',
      description: firstString(manifest, ['description']) ?? textDescription(raw),
      version,
      sourceUrl: listing,
      github,
      metadata,
      sourceType: native ? 'polyskill' : github ? 'github' : undefined,
      installable: native ? Boolean(nativeName && version) : Boolean(github?.repository),
      unavailableReason: native && (!nativeName || !version)
        ? 'PolySkill native package did not expose a complete name and version'
        : github ? undefined : native ? undefined : 'PolySkill did not expose a physical GitHub source',
    });
    return { item: record, externalId, row, ...(github ? { github } : {}) };
  }
}

function isPolySkillNativeRecord(record: RecordValue): boolean {
  const manifest = asRecord(record.manifest);
  return Boolean(manifest && (record.instructions !== undefined || manifest.skill !== undefined));
}

function normalizePolySkillName(value: unknown): string | undefined {
  const name = cleanString(value, 512);
  if (!name || !/^@[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,127}$/u.test(name)) return undefined;
  return name;
}

function parsePolySkillExternalId(value: string): { name: string; version?: string } {
  const at = value.lastIndexOf('@');
  const name = at > 0 ? value.slice(0, at) : value;
  const version = at > 0 ? value.slice(at + 1) : undefined;
  const normalizedName = normalizePolySkillName(name);
  if (!normalizedName || (version !== undefined && (!version || /[\\/\u0000-\u001f\u007f]/u.test(version)))) {
    throw invalidExternalId('polyskill');
  }
  return { name: normalizedName, ...(version === undefined ? {} : { version }) };
}

abstract class KeyedDirectoryAdapter extends BaseRegistryAdapter {
  protected constructor(options: RegistryAdapterOptions, id: SourceId, label: string, origin: string, credentialEnv: string) {
    super({ ...options, id, label, origin, credentialEnv, credentialRequired: true }, ['search', 'resolve']);
  }

  protected mapDirectoryRecord(record: RecordValue, fallbackId?: string, extra: ReadonlyArray<readonly [string, unknown]> = []): ParsedProviderRecord {
    const github = githubEvidenceFromRecord(record);
    const externalId = pickExternalId(record, github, fallbackId);
    const sourceUrl = safeProviderUrl(firstUnknown(record, ['url', 'skillUrl', 'skill_url', 'canonicalUrl', 'canonical_url']), this.origin);
    const metadata = mergeMetadata(rowMetadata(record, github, extra), externalRecordStatus(record));
    const row = makeRow(this.id, record, {
      externalId,
      title: pickTitle(record),
      description: textDescription(record),
      version: pickVersion(record),
      sourceUrl,
      github,
      snapshotDigest: optionalDigest(record, ['snapshotDigest', 'snapshotHash', 'contentHash', 'content_hash', 'digest', 'hash']),
      metadata,
      sourceType: github ? 'github' : undefined,
      installable: Boolean(github?.repository),
      unavailableReason: github ? undefined : 'The provider did not expose a physical GitHub source',
    });
    return { item: record, externalId, row, ...(github ? { github } : {}) };
  }

  protected async resolveGithubRecord(input: SourceResolveRequest, record: RecordValue, parsed: ParsedProviderRecord): Promise<SourceResolution> {
    if (!parsed.github) throw new SourceCatalogError('SOURCE_RESOLUTION_INVALID', 'The source did not expose a physical GitHub source', 502, { source: this.id });
    const github = await this.github(parsed.github, input.signal);
    const row = makeRow(this.id, record, {
      externalId: input.externalId,
      title: parsed.row.title,
      description: parsed.row.description,
      version: parsed.row.version,
      sourceUrl: canonicalGithubUrl(github),
      github,
      snapshotDigest: parsed.row.snapshotDigest,
      metadata: parsed.row.metadata,
      sourceType: 'github',
      installable: true,
    });
    return this.resolution(row, githubAcquisition(github), input, parsed.row.version ?? github.ref, canonicalGithubUrl(github));
  }
}

export class SkillsDirectoryAdapter extends KeyedDirectoryAdapter {
  constructor(options: RegistryAdapterOptions = {}) {
    super(options, 'skills-directory', 'Skills Directory', REGISTRY_ORIGINS.skillsDirectory, 'SKILLS_DIRECTORY_API_KEY');
  }

  async search(input: SourceSearchRequest): Promise<readonly SourceSearchResult[]> {
    this.ensureAvailable();
    assertSourceRequest(input, this.id);
    const query = validateQuery(input.query);
    const limit = this.resultLimit(input, 100);
    const url = new URL('/api/v1/skills', REGISTRY_ORIGINS.skillsDirectory);
    url.searchParams.set('q', query);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('securityGrade', 'all');
    const payload = await this.http.json(url.href, REGISTRY_ORIGINS.skillsDirectory, { method: 'GET', headers: this.providerHeaders() }, input.signal);
    const records = unwrapArray(payload, ['data', 'skills']);
    return records.slice(0, limit).map((record) => this.mapDirectoryRecord(record, undefined, [
      ['stars', firstUnknown(record, ['stars'])],
      ['votes', firstUnknown(record, ['votes'])],
      ['providerScore', firstUnknown(record, ['_score'])],
    ]).row);
  }

  async resolve(input: SourceResolveRequest): Promise<SourceResolution> {
    this.ensureAvailable();
    assertSourceRequest(input, this.id);
    const externalId = assertExternalId(input.externalId, this.id);
    const payload = await this.http.json(`${REGISTRY_ORIGINS.skillsDirectory}/api/v1/skills/${encodeURIComponent(externalId)}`, REGISTRY_ORIGINS.skillsDirectory, { method: 'GET', headers: this.providerHeaders() }, input.signal);
    const record = unwrapObject(payload);
    return this.resolveGithubRecord(input, record, this.mapDirectoryRecord(record, externalId));
  }
}

export class SkillHubProAdapter extends KeyedDirectoryAdapter {
  constructor(options: RegistryAdapterOptions = {}) {
    super(options, 'skillhub-pro', 'SkillHub Pro', REGISTRY_ORIGINS.skillhubPro, 'SKILLHUB_API_KEY');
  }

  async search(input: SourceSearchRequest): Promise<readonly SourceSearchResult[]> {
    this.ensureAvailable();
    assertSourceRequest(input, this.id);
    const query = validateQuery(input.query);
    const limit = this.resultLimit(input, 100);
    const payload = await this.http.json(
      `${REGISTRY_ORIGINS.skillhubPro}/api/v1/skills/search`,
      REGISTRY_ORIGINS.skillhubPro,
      { method: 'POST', headers: new Headers({ ...Object.fromEntries(this.providerHeaders().entries()), 'content-type': 'application/json' }), body: JSON.stringify({ query, limit, method: 'hybrid' }) },
      input.signal,
    );
    const records = unwrapArray(payload, ['data', 'skills', 'results']);
    return records.slice(0, limit).map((record) => {
      const parsed = this.mapDirectoryRecord(record, undefined, [
        ['providerScore', firstUnknown(record, ['_score', 'score'])],
        ['providerSimilarity', firstUnknown(record, ['_similarity', 'similarity'])],
      ]);
      // SkillHub Pro documents search but no immutable detail endpoint. Keep
      // the original query beside the native id so resolve can re-query the
      // same bounded search surface and demand one exact row.
      return lookupRow(parsed.row, parsed.externalId, query, limit);
    });
  }

  async resolve(input: SourceResolveRequest): Promise<SourceResolution> {
    this.ensureAvailable();
    assertSourceRequest(input, this.id);
    const externalId = assertExternalId(input.externalId, this.id);
    const lookup = resolveLookup(externalId);
    const payload = await this.http.json(
      `${REGISTRY_ORIGINS.skillhubPro}/api/v1/skills/search`,
      REGISTRY_ORIGINS.skillhubPro,
      { method: 'POST', headers: new Headers({ ...Object.fromEntries(this.providerHeaders().entries()), 'content-type': 'application/json' }), body: JSON.stringify({ query: validateQuery(lookup.query), limit: lookup.limit ?? 100, method: 'hybrid' }) },
      input.signal,
    );
    const records = unwrapArray(payload, ['data', 'skills', 'results']);
    const matches = records.filter((record) => pickExternalId(record, githubEvidenceFromRecord(record), lookup.nativeId) === lookup.nativeId);
    if (matches.length !== 1) throw invalidExternalId(this.id, matches.length === 0 ? 'SkillHub Pro returned no exact source identity' : 'SkillHub Pro returned an ambiguous source identity');
    const record = matches[0]!;
    return this.resolveGithubRecord(input, record, this.mapDirectoryRecord(record, externalId));
  }
}

/** Construct the six requested external adapters in stable UI order. */
export function createRegistrySourceAdapters(options: RegistryAdapterOptions = {}): readonly SourceCatalogAdapter[] {
  // A factory-level `apiKey` would be ambiguous and could accidentally be
  // sent to every provider. Direct constructors may still receive `apiKey`;
  // factory callers must use the explicitly keyed map below.
  const scoped = (id: keyof NonNullable<RegistryAdapterOptions['apiKeys']>): RegistryAdapterOptions => {
    const { apiKey: _ignored, apiKeys: _all, ...shared } = options;
    const key = options.apiKeys?.[id];
    return key === undefined ? shared : { ...shared, apiKey: key };
  };
  return Object.freeze([
    new SkillsMpAdapter(scoped('skillsmp')),
    new ClawHubAdapter(scoped('clawhub')),
    new SkillHubPublicAdapter(scoped('skillhub-public')),
    new PolySkillAdapter(scoped('polyskill')),
    new SkillsDirectoryAdapter(scoped('skills-directory')),
    new SkillHubProAdapter(scoped('skillhub-pro')),
  ]);
}

export const createExternalRegistryAdapters = createRegistrySourceAdapters;

export const REGISTRY_ADAPTERS = Object.freeze({
  skillsmp: SkillsMpAdapter,
  clawhub: ClawHubAdapter,
  'skillhub-public': SkillHubPublicAdapter,
  polyskill: PolySkillAdapter,
  'skills-directory': SkillsDirectoryAdapter,
  'skillhub-pro': SkillHubProAdapter,
});

export type RegistryAdapterClass = (typeof REGISTRY_ADAPTERS)[keyof typeof REGISTRY_ADAPTERS];

/** Provider endpoint metadata for API capability/readiness views. */
export const REGISTRY_ENDPOINTS = Object.freeze({
  skillsmp: { method: 'GET', path: '/api/v1/skills/search', auth: 'optional', docs: 'https://skillsmp.com/docs/api' },
  clawhub: { method: 'GET', path: '/api/v1/search', auth: 'none', docs: 'https://github.com/openclaw/clawhub/blob/main/docs/api.md' },
  'skillhub-public': { method: 'GET', path: '/api/skills', auth: 'none', docs: 'https://skills.palebluedot.live/docs/api' },
  polyskill: { method: 'GET', path: '/api/skills', auth: 'none', docs: 'https://polyskill.ai/docs' },
  'skills-directory': { method: 'GET', path: '/api/v1/skills', auth: 'required', docs: 'https://www.skillsdirectory.com/api-docs' },
  'skillhub-pro': { method: 'POST', path: '/api/v1/skills/search', auth: 'required', docs: 'https://www.skillhub.club/docs/api' },
} as const);

// Keep these names available for callers that mirror the upstream adapter
// naming while retaining the stable built-in ids above.
export const SkillsMPAdapter = SkillsMpAdapter;
export const PolySkillSourceAdapter = PolySkillAdapter;
export const SkillHubPublicSourceAdapter = SkillHubPublicAdapter;
export const SkillsDirectorySourceAdapter = SkillsDirectoryAdapter;
export const SkillHubProSourceAdapter = SkillHubProAdapter;
