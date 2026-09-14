/**
 * Bounded worker acquisition for PolySkill's native JSON API.
 *
 * The catalog supplies an immutable `{ name, version, contentDigest }`
 * identity.  This module binds that identity to the fixed PolySkill origin,
 * fetches one JSON response, verifies the semantic digest, and converts the
 * native files into the registry's existing data-only skill bundle.  No
 * native tool implementation, package hook, or external file is executed.
 */

import { createHash } from 'node:crypto';

import type {
  BundleFile,
  Digest,
  Provenance,
  SkillBundle,
  UpstreamRequestObserver,
} from '../../contracts/src/index.js';
import {
  encodeBundle,
  parseSkillMetadata,
  validateBundle,
} from '../../storage/src/bundle.js';
import {
  DEFAULT_POLYSKILL_NATIVE_LIMITS,
  POLYSKILL_API_ORIGIN,
  PolyskillNativeError,
  type PolyskillJsonValue,
  type PolyskillNativeLimits,
  type PolyskillNativeSkill,
  canonicalPolyskillFileJson,
  parsePolyskillNativeSkill,
  polyskillSkillSlug,
  serializePolyskillNativeSemanticFields,
} from '../../source-catalog/src/adapters/polyskill-native.js';
import { UpstreamAcquisitionError } from './index.js';

export { POLYSKILL_API_ORIGIN } from '../../source-catalog/src/adapters/polyskill-native.js';
export type { PolyskillNativeSkill } from '../../source-catalog/src/adapters/polyskill-native.js';

export interface PolyskillSourceAcquisition {
  kind: 'polyskill';
  name: string;
  version: string;
  contentDigest: Digest;
}

export type PolyskillSourceIdentity = PolyskillSourceAcquisition;

export interface PolyskillFetchLike {
  (
    input: string | URL,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      redirect?: RequestRedirect;
      signal?: AbortSignal;
    },
  ): Promise<Response>;
}

export interface PolyskillWorkerLimits extends PolyskillNativeLimits {
  /** Maximum bytes retained for the complete JSON response. */
  maxResponseBytes: number;
  /** Per-request wall-clock deadline. */
  requestTimeoutMs: number;
}

export const DEFAULT_POLYSKILL_WORKER_LIMITS: Readonly<PolyskillWorkerLimits> = Object.freeze({
  ...DEFAULT_POLYSKILL_NATIVE_LIMITS,
  maxResponseBytes: 20 * 1024 * 1024,
  requestTimeoutMs: 20_000,
});

export interface PolyskillAcquireInput {
  /** Server-owned identity returned by the catalog resolver. */
  source: PolyskillSourceAcquisition;
  fetchImpl?: PolyskillFetchLike;
  /** Alias used by generic worker adapters. */
  fetch?: PolyskillFetchLike;
  limits?: Partial<PolyskillWorkerLimits> & { native?: Partial<PolyskillNativeLimits> };
  nativeLimits?: Partial<PolyskillNativeLimits>;
  /** Only test fixtures may select a loopback endpoint. */
  apiBaseUrl?: string;
  allowLoopbackForTests?: boolean;
  signal?: AbortSignal;
  upstreamObserver?: UpstreamRequestObserver;
  upstreamId?: string;
  externalId?: string;
  externalSnapshotHash?: string | null;
}

/** Exact response returned by a successful native fetch, before conversion. */
export interface PolyskillNativeFetchResult {
  skill: PolyskillNativeSkill;
  requestedUrl: string;
}

/**
 * Validate a server-owned PolySkill acquisition identity without network I/O.
 * Provider URLs are intentionally absent from this type and cannot be
 * supplied by a caller.
 */
export function validatePolyskillSourceIdentity(
  source: PolyskillSourceAcquisition,
): PolyskillSourceAcquisition {
  if (!isRecord(source) || source.kind !== 'polyskill') {
    throw acquisitionError('invalid_source', 'PolySkill source identity is invalid');
  }
  if (
    typeof source.name !== 'string' ||
    !/^@[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,127}$/u.test(source.name) ||
    hasLoneSurrogate(source.name)
  ) {
    throw acquisitionError('invalid_source', 'PolySkill source name is invalid');
  }
  if (
    typeof source.version !== 'string' ||
    source.version.length === 0 ||
    source.version.length > 128 ||
    hasLoneSurrogate(source.version) ||
    /^latest$/iu.test(source.version) ||
    /[\u0000-\u001f\u007f\\/]/u.test(source.version)
  ) {
    throw acquisitionError('invalid_source', 'PolySkill source version is invalid');
  }
  if (typeof source.contentDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(source.contentDigest)) {
    throw acquisitionError('invalid_source', 'PolySkill source content digest is invalid');
  }
  return {
    kind: 'polyskill',
    name: source.name,
    version: source.version,
    contentDigest: source.contentDigest,
  };
}

/**
 * Fetch one exact version from PolySkill's public REST endpoint.  The source
 * identity is checked before the request, redirects are denied at the fetch
 * boundary, and the response is bounded before JSON parsing.
 */
export async function fetchPolyskillNativeSkill(
  input: PolyskillAcquireInput,
): Promise<PolyskillNativeSkill> {
  const source = validatePolyskillSourceIdentity(input.source);
  const limits = mergeWorkerLimits(input.limits, input.nativeLimits);
  const base = normalizeApiBase(input.apiBaseUrl, input.allowLoopbackForTests ?? false);
  const requestedUrl = polyskillEndpoint(base, source);
  const fetchImpl = input.fetchImpl ?? input.fetch ?? defaultFetch();
  if (input.signal?.aborted) throw acquisitionError('cancelled', 'PolySkill source acquisition cancelled');

  const controller = new AbortController();
  let timedOut = false;
  let parentAborted = false;
  const onParentAbort = (): void => {
    parentAborted = true;
    controller.abort();
  };
  input.signal?.addEventListener('abort', onParentAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, limits.requestTimeoutMs);

  try {
    input.upstreamObserver?.record('source');
    const response = await fetchImpl(requestedUrl, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': 'private-skills-polyskill-worker/0.1',
      },
      redirect: 'error',
      signal: controller.signal,
    });
    if (timedOut) throw acquisitionError('timeout', 'PolySkill source request timed out');
    if (parentAborted || input.signal?.aborted) throw acquisitionError('cancelled', 'PolySkill source acquisition cancelled');

    assertNoRedirect(response, requestedUrl, base.origin);
    if (response.status === 404) {
      throw acquisitionError('source_not_found', 'The requested PolySkill version was not found', 404);
    }
    if (!response.ok) {
      throw acquisitionError('source_unavailable', 'PolySkill rejected the native source request', response.status);
    }

    const bytes = await readBounded(response, limits.maxResponseBytes);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw acquisitionError('invalid_native', 'PolySkill response is not valid UTF-8');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      throw acquisitionError('invalid_native', 'PolySkill response is not valid JSON');
    }
    const payloadRecord = isRecord(payload) ? payload : undefined;
    if (payloadRecord !== undefined && hasOwn(payloadRecord, 'name') && payloadRecord.name !== source.name) {
      throw acquisitionError('identity_mismatch', 'PolySkill response name does not match the requested identity');
    }
    if (payloadRecord !== undefined && hasOwn(payloadRecord, 'version') && payloadRecord.version !== source.version) {
      throw acquisitionError('identity_mismatch', 'PolySkill response version does not match the requested identity');
    }

    let skill: PolyskillNativeSkill;
    try {
      skill = parsePolyskillNativeSkill(payload, limits);
    } catch (error) {
      throw mapNativeError(error);
    }
    if (skill.manifest.name !== source.name || skill.manifest.version !== source.version) {
      throw acquisitionError('identity_mismatch', 'PolySkill manifest identity does not match the requested identity');
    }
    return skill;
  } catch (error) {
    if (error instanceof UpstreamAcquisitionError) throw error;
    if (timedOut) throw acquisitionError('timeout', 'PolySkill source request timed out');
    if (parentAborted || input.signal?.aborted) throw acquisitionError('cancelled', 'PolySkill source acquisition cancelled');
    throw acquisitionError('source_unavailable', 'PolySkill source request failed');
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener('abort', onParentAbort);
    controller.abort();
  }
}

/**
 * Acquire and convert one native package through the normal worker result
 * contract.  The semantic provider digest and local canonical bundle digest
 * are kept distinct in provenance.
 */
export async function acquirePolyskillSkill(
  input: PolyskillAcquireInput,
): Promise<{ bundle: SkillBundle; provenance: Provenance }> {
  const source = validatePolyskillSourceIdentity(input.source);
  const limits = mergeWorkerLimits(input.limits, input.nativeLimits);
  const skill = await fetchPolyskillNativeSkill({ ...input, source, limits });
  const semanticDigest = digestBytes(serializePolyskillNativeSemanticFields(skill, limits));
  if (semanticDigest !== source.contentDigest) {
    throw acquisitionError('digest_mismatch', 'PolySkill native content digest does not match the requested identity');
  }

  const bundle = polyskillNativeToSkillBundle(skill, limits);
  const localDigest = digestBytes(encodeBundle(bundle));
  const fetchedAt = new Date().toISOString();
  return {
    bundle,
    provenance: {
      kind: 'native',
      ...(input.upstreamId === undefined ? {} : { upstreamId: input.upstreamId }),
      repository: POLYSKILL_API_ORIGIN,
      path: source.name,
      revision: source.version,
      sourceDigest: localDigest,
      externalId: input.externalId ?? source.name,
      externalSnapshotHash: input.externalSnapshotHash ?? source.contentDigest,
      sourceProviderOrigin: POLYSKILL_API_ORIGIN,
      sourceResolutionKind: 'snapshot',
      fetchedAt,
      externalDigest: source.contentDigest,
      sourceReference: `polyskill:${source.name}@${source.version}#${source.contentDigest}`,
    },
  };
}

/** Explicit alias for callers that name the operation after the source. */
export const acquirePolyskillNativeSkill = acquirePolyskillSkill;
/** Naming parallel to the other native upstream adapters. */
export const acquirePolyskillSource = acquirePolyskillSkill;

/** Convert an already verified native package into the canonical data bundle. */
export function polyskillNativeToSkillBundle(
  input: PolyskillNativeSkill,
  limitsInput: Partial<PolyskillWorkerLimits> = {},
): SkillBundle {
  const limits = mergeWorkerLimits(limitsInput);
  let skill: PolyskillNativeSkill;
  try {
    skill = parsePolyskillNativeSkill(input, limits);
  } catch (error) {
    throw mapNativeError(error);
  }

  const files: BundleFile[] = [
    {
      path: 'SKILL.md',
      content: encodeText(polyskillWrapperMarkdown(skill)),
    },
    {
      path: 'skill.json',
      content: encodeText(canonicalPolyskillFileJson(skill.manifest, limits)),
    },
  ];
  if (skill.instructions !== undefined) {
    // TextEncoder/Buffer use the exact string returned by the API.  No trim,
    // newline normalization, or markdown interpretation is performed.
    files.push({ path: 'instructions.md', content: encodeText(skill.instructions) });
  }
  if (skill.tools !== undefined && skill.tools !== null) {
    files.push({ path: 'tools.json', content: encodeText(canonicalPolyskillFileJson(skill.tools, limits)) });
  }
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

  let bundle: SkillBundle;
  try {
    bundle = validateBundle({ format: 'pskills-bundle-v1', files });
    parseSkillMetadata(bundle);
  } catch (error) {
    if (error instanceof UpstreamAcquisitionError) throw error;
    throw acquisitionError('invalid_bundle', error instanceof Error ? error.message : 'PolySkill bundle is invalid');
  }
  return bundle;
}

export const convertPolyskillNativeSkill = polyskillNativeToSkillBundle;
export const buildPolyskillSkillBundle = polyskillNativeToSkillBundle;

function polyskillWrapperMarkdown(skill: PolyskillNativeSkill): string {
  const name = polyskillSkillSlug(skill.manifest.name);
  // JSON's quoted-string grammar is a safe YAML double-quoted scalar. Escape
  // the two Unicode line separators as well because some YAML parsers treat
  // them as physical line breaks.
  const description = JSON.stringify(skill.manifest.description)
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
  return `---\nname: ${name}\ndescription: ${description}\n---\n${skill.instructions ?? ''}`;
}

function mergeWorkerLimits(
  input: (Partial<PolyskillWorkerLimits> & { native?: Partial<PolyskillNativeLimits> }) | undefined,
  nativeInput?: Partial<PolyskillNativeLimits>,
): PolyskillWorkerLimits {
  const output = { ...DEFAULT_POLYSKILL_WORKER_LIMITS };
  if (input !== undefined) {
    for (const key of Object.keys(DEFAULT_POLYSKILL_WORKER_LIMITS) as Array<keyof PolyskillWorkerLimits>) {
      const value = input[key];
      if (value === undefined || typeof value !== 'number') continue;
      if (!Number.isSafeInteger(value) || value < 1) throw acquisitionError('invalid_limits', `PolySkill ${key} limit is invalid`);
      output[key] = value;
    }
  }
  const native = { ...(input?.native ?? {}), ...(nativeInput ?? {}) };
  for (const key of Object.keys(DEFAULT_POLYSKILL_NATIVE_LIMITS) as Array<keyof PolyskillNativeLimits>) {
    const value = native[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 1) throw acquisitionError('invalid_limits', `PolySkill ${key} limit is invalid`);
    output[key] = value;
  }
  return output;
}

function normalizeApiBase(value: string | undefined, allowLoopbackForTests: boolean): URL {
  if (value === undefined) return new URL(POLYSKILL_API_ORIGIN);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw acquisitionError('invalid_source', 'PolySkill API base URL is invalid');
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== '/' && parsed.pathname !== '')
  ) {
    throw acquisitionError('invalid_source', 'PolySkill API base URL is invalid');
  }
  if (parsed.port && !allowLoopbackForTests) {
    throw acquisitionError('invalid_source', 'PolySkill API base URL is invalid');
  }
  if (!allowLoopbackForTests && (parsed.protocol !== 'https:' || parsed.origin !== POLYSKILL_API_ORIGIN)) {
    throw acquisitionError('invalid_source', 'PolySkill transport origin is fixed to polyskill.ai');
  }
  if (allowLoopbackForTests && parsed.origin !== POLYSKILL_API_ORIGIN && !isLoopbackHost(parsed.hostname)) {
    throw acquisitionError('invalid_source', 'PolySkill test transport must use loopback');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw acquisitionError('invalid_source', 'PolySkill API base URL must use HTTP(S)');
  }
  return parsed;
}

function polyskillEndpoint(base: URL, source: PolyskillSourceAcquisition): string {
  const url = new URL(
    `/api/skills/${encodeURIComponent(source.name)}/${encodeURIComponent(source.version)}`,
    base,
  );
  return url.href;
}

function assertNoRedirect(response: Response, requestedUrl: string, expectedOrigin: string): void {
  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    throw acquisitionError('redirect_denied', 'PolySkill source redirects are not allowed');
  }
  if (!response.url) return;
  let finalUrl: URL;
  try {
    finalUrl = new URL(response.url);
  } catch {
    throw acquisitionError('redirect_denied', 'PolySkill source response URL is invalid');
  }
  let requested: URL;
  try {
    requested = new URL(requestedUrl);
  } catch {
    throw acquisitionError('redirect_denied', 'PolySkill requested URL is invalid');
  }
  let finalPath: string;
  let requestedPath: string;
  try {
    // URL serialization may choose a different spelling for an equivalent
    // escaped @ or slash. Compare the decoded path after requiring the same
    // fixed origin and no query/hash instead of treating that serialization
    // detail as a redirect.
    finalPath = decodeURIComponent(finalUrl.pathname);
    requestedPath = decodeURIComponent(requested.pathname);
  } catch {
    throw acquisitionError('redirect_denied', 'PolySkill source response URL is invalid');
  }
  if (finalUrl.origin !== expectedOrigin || finalUrl.search !== requested.search || finalUrl.hash !== requested.hash || finalPath !== requestedPath) {
    throw acquisitionError('redirect_denied', 'PolySkill source response crossed the fixed origin');
  }
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isSafeInteger(declared) && declared >= 0 && declared > maxBytes) {
    throw acquisitionError('response_too_large', 'PolySkill response exceeds its byte limit');
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw acquisitionError('response_too_large', 'PolySkill response exceeds its byte limit');
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
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* preserve the bounded-size error */ }
        throw acquisitionError('response_too_large', 'PolySkill response exceeds its byte limit');
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function defaultFetch(): PolyskillFetchLike {
  const fetchImpl = globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw acquisitionError('source_unavailable', 'The source HTTP client is unavailable');
  return fetchImpl.bind(globalThis) as PolyskillFetchLike;
}

function mapNativeError(error: unknown): UpstreamAcquisitionError {
  if (error instanceof UpstreamAcquisitionError) return error;
  if (error instanceof PolyskillNativeError) {
    const code = error.code === 'bounds' ? 'response_too_large'
      : error.code === 'identity_mismatch' ? 'identity_mismatch'
        : error.code === 'unsupported_external_reference' ? 'unsupported_external_reference'
          : error.code === 'unsupported_composite' ? 'unsupported_composite'
            : error.code === 'unsupported_remote_tool' ? 'unsupported_remote_tool'
              : error.code === 'missing_file' ? 'invalid_native'
                : 'invalid_native';
    return acquisitionError(code, error.message);
  }
  return acquisitionError('invalid_native', 'PolySkill native package is invalid');
}

function acquisitionError(code: string, message: string, status?: number): UpstreamAcquisitionError {
  return new UpstreamAcquisitionError(code, message, status);
}

function digestBytes(bytes: Uint8Array): Digest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function encodeText(value: string): string {
  return Buffer.from(new TextEncoder().encode(value)).toString('base64');
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' || normalized === '::1' || normalized === '[::1]' || /^127(?:\.[0-9]{1,3}){3}$/u.test(normalized);
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
