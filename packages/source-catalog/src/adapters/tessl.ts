import {
  SourceCatalogError,
  type SourceAvailability,
  type SourceCatalogAdapter,
  type SourceCatalogAdapterContext,
  type SourceId,
  type SourceResolution,
  type SourceResolveRequest,
  type SourceSearchRequest,
  type SourceSearchResult,
} from '../types.js';

/** The only origin used for Tessl API requests and native acquisition. */
export const TESSL_API_ORIGIN = 'https://api.tessl.io' as const;

/** Display-only registry origin. The adapter never downloads from this host. */
export const TESSL_REGISTRY_ORIGIN = 'https://tessl.io' as const;

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESULTS = 50;
const MAX_RESULTS = 100;
const MAX_QUERY_LENGTH = 500;
const MAX_RESPONSE_BYTES = 1 * 1024 * 1024;
const MAX_REQUESTS_PER_OPERATION = 24;
const MAX_SEARCH_PAGES = 8;
const MAX_FILE_PAGES = 8;
const MAX_FILE_ENTRIES = 8_192;
const MAX_SKILLS_PER_TILE = 256;
const MAX_TEXT_LENGTH = 4_096;
const MAX_DESCRIPTION_LENGTH = 4_096;
const MAX_COORDINATE_LENGTH = 256;
const MAX_PATH_LENGTH = 4_096;
const FINGERPRINT_RE = /^[0-9a-f]{64}$/u;
const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const COORDINATE_RE = /^[A-Za-z0-9][A-Za-z0-9._+~-]{0,255}$/u;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._+~-]{0,127}$/u;
const SEGMENT_RE = /^[^\u0000-\u001f\u007f\\/#?%]+$/u;

export type TesslFetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface TesslSourceAdapterOptions {
  id?: SourceId;
  label?: string;
  fetch?: TesslFetchLike;
  /** Explicit environment map is accepted for host-neutral composition. */
  env?: Readonly<Record<string, string | undefined>>;
  requestTimeoutMs?: number;
  maxResults?: number;
  configRevision?: string;
  now?: () => Date;
}

interface FetchContext {
  signal?: AbortSignal;
  requests: number;
}

interface ParsedTesslIdentity {
  workspace: string;
  tile: string;
  version: string;
  /** Exact archive member path, including the SKILL.md filename. */
  skillFilePath?: string;
}

interface TesslVersion {
  version: string;
  fingerprint: string;
  summary?: string;
  skills?: readonly TesslSkill[];
}

interface TesslSkill {
  path: string;
  name?: string;
  description?: string;
}

interface TesslTile {
  workspace: string;
  tile: string;
  name: string;
  version: TesslVersion;
}

interface TesslSearchPage {
  data: readonly unknown[];
  next?: string;
}

/**
 * Tessl's public catalog adapter.
 *
 * Search and resolve only read documented JSON endpoints. The files endpoint
 * is inspected as a bounded JSON manifest to prove the selected SKILL.md
 * member exists; the native tar.gz is fetched and decoded by the worker from
 * the typed `tessl` acquisition identity.
 */
export class TesslSourceAdapter implements SourceCatalogAdapter {
  readonly id: SourceId;
  readonly label: string;
  readonly capabilities = ['search', 'resolve'] as const;
  readonly configRevision: string;

  private readonly fetchImpl: TesslFetchLike;
  private readonly timeoutMs: number;
  private readonly maxResults: number;
  private readonly now: () => Date;

  constructor(options: TesslSourceAdapterOptions = {}) {
    this.id = options.id ?? 'tessl';
    this.label = options.label ?? 'Tessl';
    this.fetchImpl = options.fetch ?? defaultFetch;
    this.timeoutMs = boundedInteger(options.requestTimeoutMs, DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS);
    this.maxResults = boundedInteger(options.maxResults, DEFAULT_MAX_RESULTS, 1, MAX_RESULTS);
    this.now = options.now ?? (() => new Date());
    this.configRevision = options.configRevision ?? 'tessl-v1';
  }

  availability(_context: SourceCatalogAdapterContext): SourceAvailability {
    return typeof this.fetchImpl === 'function'
      ? { state: 'available', reason: 'Bounded public Tessl catalog discovery' }
      : { state: 'unavailable', code: 'HTTP_UNAVAILABLE', reason: 'Tessl API client is unavailable', retryable: true };
  }

  async search(input: SourceSearchRequest): Promise<readonly SourceSearchResult[]> {
    const query = normalizeQuery(input.query);
    const limit = Math.min(normalizeLimit(input.limit), this.maxResults);
    const context: FetchContext = { signal: input.signal, requests: 0 };
    const rows: SourceSearchResult[] = [];
    const seen = new Set<string>();
    let next: string | undefined = '/experimental/search';
    const pageUrls = new Set<string>();
    for (let page = 0; next !== undefined && rows.length < limit; page += 1) {
      if (page >= MAX_SEARCH_PAGES) throw sourceError('SOURCE_UNAVAILABLE', 'Tessl search exceeded its page bound', true);
      const pageUrl = next;
      if (pageUrls.has(pageUrl)) throw sourceError('SOURCE_RESOLUTION_INVALID', 'Tessl search repeated a page link', false);
      pageUrls.add(pageUrl);
      const payload = await this.requestJson(pageUrl, page === 0 ? {
        q: query,
        searchMode: 'hybrid',
        'page[number]': 1,
        'page[size]': limit,
        'filter[type][eq]': 'tile',
        'filter[hasSkills]': true,
        'filter[includePrivate]': false,
        'filter[includeInvalid]': false,
        include: 'tile-skills',
      } : undefined, input.signal, context);
      const parsed = parseSearchPage(payload);
      for (const value of parsed.data) {
        if (rows.length >= limit) break;
        if (!isRecord(value) || value.type !== 'tile') continue;
        const tile = parseSearchTile(value);
        if (tile === undefined) continue;
        for (const skill of tile.version.skills ?? []) {
          if (rows.length >= limit || seen.size >= limit) break;
          const skillFilePath = normalizeSkillFilePath(skill.path);
          if (skillFilePath === undefined || seen.has(`${tile.workspace}\u0000${tile.tile}\u0000${tile.version.version}\u0000${skillFilePath}`)) continue;
          seen.add(`${tile.workspace}\u0000${tile.tile}\u0000${tile.version.version}\u0000${skillFilePath}`);
          rows.push(this.resultFor(tile, skill, skillFilePath));
        }
      }
      next = parsed.next;
    }
    return rows;
  }

  async resolve(input: SourceResolveRequest): Promise<SourceResolution> {
    const identity = parseTesslExternalId(input.externalId);
    const context: FetchContext = { signal: input.signal, requests: 0 };
    const versionPayload = await this.requestJson(
      tesslVersionPath(identity.workspace, identity.tile, identity.version),
      undefined,
      input.signal,
      context,
    );
    const version = parseVersionResponse(versionPayload, identity);
    const manifest = await this.listFiles(identity, input.signal, context);
    const selectedFilePath = selectSkillFile(identity.skillFilePath, manifest);
    const skillPath = folderForSkillFile(selectedFilePath);
    const skill: TesslSkill = {
      path: selectedFilePath,
      name: skillNameForPath(skillPath, identity.tile),
      ...(version.summary === undefined ? {} : { description: version.summary }),
    };
    const tile: TesslTile = {
      workspace: identity.workspace,
      tile: identity.tile,
      name: identity.tile,
      version,
    };
    const row = this.resultFor(tile, skill, selectedFilePath, input.externalId);
    const reference = canonicalTesslExternalId(identity.workspace, identity.tile, identity.version, selectedFilePath);
    return {
      sourceId: this.id,
      externalId: input.externalId,
      row,
      reference,
      title: row.title,
      ...(row.description === undefined ? {} : { description: row.description }),
      version: version.version,
      sourceType: 'tessl',
      sourceUrl: row.sourceUrl,
      metadata: row.metadata,
      acquisition: {
        kind: 'tessl',
        workspace: identity.workspace,
        tile: identity.tile,
        version: version.version,
        fingerprint: version.fingerprint,
        skillPath,
        sourceProviderOrigin: TESSL_API_ORIGIN,
      },
      configRevision: this.configRevision,
      resolvedAt: this.now().toISOString(),
    };
  }

  private resultFor(tile: TesslTile, skill: TesslSkill, skillFilePath: string, externalId?: string): SourceSearchResult {
    const skillPath = folderForSkillFile(skillFilePath);
    const canonicalExternalId = canonicalTesslExternalId(tile.workspace, tile.tile, tile.version.version, skillFilePath);
    const title = cleanText(skill.name) ?? skillNameForPath(skillPath, tile.tile);
    const description = cleanDescription(skill.description ?? tile.version.summary);
    const versionUrl = tesslVersionUrl(tile.workspace, tile.tile, tile.version.version);
    return {
      sourceId: this.id,
      externalId: externalId ?? canonicalExternalId,
      title,
      ...(description === undefined ? {} : { description }),
      version: tile.version.version,
      sourceUrl: versionUrl,
      path: skillPath,
      ref: tile.version.version,
      installable: true,
      sourceType: 'tessl',
      metadata: {
        tesslWorkspace: tile.workspace,
        tesslTile: tile.tile,
        tesslVersion: tile.version.version,
        tesslFingerprint: tile.version.fingerprint,
        tesslSkillFile: skillFilePath,
        tesslVersionUrl: versionUrl,
        tesslFilesUrl: tesslFilesUrl(tile.workspace, tile.tile, tile.version.version),
      },
    };
  }

  private async listFiles(identity: ParsedTesslIdentity, signal: AbortSignal | undefined, context: FetchContext): Promise<readonly string[]> {
    const basePath = tesslFilesPath(identity.workspace, identity.tile, identity.version);
    let next: string | undefined = basePath;
    const paths: string[] = [];
    const seen = new Set<string>();
    for (let page = 0; next !== undefined; page += 1) {
      if (page >= MAX_FILE_PAGES) throw sourceError('SOURCE_UNAVAILABLE', 'Tessl file manifest exceeded its page bound', true);
      const payload = await this.requestJson(next, undefined, signal, context, 'application/json');
      if (!isRecord(payload) || !Array.isArray(payload.data)) {
        throw sourceError('SOURCE_RESOLUTION_INVALID', 'Tessl files response did not match the documented schema', false);
      }
      if (paths.length + payload.data.length > MAX_FILE_ENTRIES) {
        throw sourceError('SOURCE_RESOLUTION_INVALID', 'Tessl file manifest exceeded its entry bound', false);
      }
      for (const value of payload.data) {
        if (!isRecord(value) || value.type !== 'file' || !isRecord(value.attributes) || typeof value.attributes.path !== 'string') {
          throw sourceError('SOURCE_RESOLUTION_INVALID', 'Tessl files response contained an invalid file entry', false);
        }
        const path = normalizeArchivePath(value.attributes.path);
        if (path === undefined) throw sourceError('SOURCE_RESOLUTION_INVALID', 'Tessl files response contained an unsafe path', false);
        if (!seen.has(path)) {
          seen.add(path);
          paths.push(path);
        }
      }
      if (!isRecord(payload.links)) {
        throw sourceError('SOURCE_RESOLUTION_INVALID', 'Tessl files response omitted links', false);
      }
      const candidate = payload.links.next;
      if (candidate === null || candidate === undefined) {
        next = undefined;
      } else if (typeof candidate === 'string') {
        next = validateNextPage(candidate, basePath);
      } else {
        throw sourceError('SOURCE_RESOLUTION_INVALID', 'Tessl files response contained an invalid next link', false);
      }
    }
    return paths;
  }

  private async requestJson(
    path: string,
    params: Record<string, string | number | boolean> | undefined,
    parentSignal: AbortSignal | undefined,
    context: FetchContext,
    accept = 'application/json',
  ): Promise<unknown> {
    if (++context.requests > MAX_REQUESTS_PER_OPERATION) throw sourceError('SOURCE_TIMEOUT', 'Tessl request budget exhausted', true);
    const url = trustedApiUrl(path, params);
    const request = requestSignal(parentSignal, this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { accept },
        redirect: 'error',
        signal: request.signal,
      });
      verifyResponseOrigin(response);
      if (!response.ok) throw httpFailure(response.status, 'Tessl API request failed');
      const bytes = await readBounded(response, MAX_RESPONSE_BYTES);
      const mediaType = response.headers.get('content-type')?.toLocaleLowerCase('en-US') ?? '';
      if (mediaType !== '' && !mediaType.includes('json')) {
        throw sourceError('SOURCE_RESOLUTION_INVALID', 'Tessl API returned a non-JSON response', false);
      }
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch {
        throw sourceError('SOURCE_RESOLUTION_INVALID', 'Tessl API returned invalid UTF-8', false);
      }
      try { return JSON.parse(text) as unknown; } catch {
        throw sourceError('SOURCE_RESOLUTION_INVALID', 'Tessl API returned invalid JSON', false);
      }
    } catch (error) {
      if (error instanceof SourceCatalogError) throw error;
      if (request.signal.aborted || parentSignal?.aborted) throw sourceError('SOURCE_TIMEOUT', 'Tessl request timed out or was cancelled', true);
      throw sourceError('SOURCE_UNAVAILABLE', 'Tessl API request failed', true);
    } finally {
      request.dispose();
    }
  }
}

export function createTesslSourceAdapter(options: TesslSourceAdapterOptions = {}): TesslSourceAdapter {
  return new TesslSourceAdapter(options);
}

function defaultFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const fetchImpl = (globalThis as { fetch?: TesslFetchLike }).fetch;
  if (typeof fetchImpl !== 'function') return Promise.reject(sourceError('SOURCE_UNAVAILABLE', 'Tessl API client is unavailable', true));
  return fetchImpl(input, init);
}

function parseSearchPage(value: unknown): TesslSearchPage {
  if (!isRecord(value) || !Array.isArray(value.data) || !isRecord(value.links) || !isRecord(value.meta) || !isRecord(value.meta.pagination)) {
    throw sourceError('SOURCE_RESOLUTION_INVALID', 'Tessl search response did not match the documented schema', false);
  }
  const pagination = value.meta.pagination;
  const number = pagination.number;
  const size = pagination.size;
  const total = pagination.total;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1 || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1 || size > MAX_RESULTS || typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) {
    throw sourceError('SOURCE_RESOLUTION_INVALID', 'Tessl search pagination was invalid', false);
  }
  const candidate = value.links.next;
  if (candidate === null || candidate === undefined) return { data: value.data };
  if (typeof candidate !== 'string') throw sourceError('SOURCE_RESOLUTION_INVALID', 'Tessl search next link was invalid', false);
  return { data: value.data, next: validateNextPage(candidate, '/experimental/search') };
}

function parseSearchTile(value: Record<string, unknown>): TesslTile | undefined {
  if (typeof value.id !== 'string' || !UUID_RE.test(value.id)) return undefined;
  const attributes = isRecord(value.attributes) ? value.attributes : undefined;
  if (attributes === undefined || attributes.isPrivate !== false || typeof attributes.fullName !== 'string' || typeof attributes.name !== 'string') return undefined;
  const coordinate = parseFullName(attributes.fullName);
  if (coordinate === undefined) throw sourceError('SOURCE_RESOLUTION_INVALID', 'Tessl tile fullName was invalid', false);
  if (attributes.name !== coordinate.tile) throw sourceError('SOURCE_RESOLUTION_INVALID', 'Tessl tile name did not match fullName', false);
  const relationships = isRecord(value.relationships) && isRecord(value.relationships.workspace) ? value.relationships.workspace : undefined;
  const workspaceData = relationships && isRecord(relationships.data) ? relationships.data : undefined;
  const workspaceAttrs = workspaceData && isRecord(workspaceData.attributes) ? workspaceData.attributes : undefined;
  if (workspaceData?.type !== 'workspace' || workspaceAttrs?.name !== coordinate.workspace) {
    throw sourceError('SOURCE_RESOLUTION_INVALID', 'Tessl tile workspace identity changed', false);
  }
  const versions = Array.isArray(attributes.versions) ? attributes.versions : [];
  const scores = isRecord(attributes.scores) ? attributes.scores : undefined;
  const scoredVersion = typeof scores?.version === 'string' ? scores.version : undefined;
  const candidate = selectActiveVersion(versions, scoredVersion);
  if (candidate === undefined) return undefined;
  const tileName = cleanText(attributes.name) ?? coordinate.tile;
  return { workspace: coordinate.workspace, tile: coordinate.tile, name: tileName, version: candidate };
}

function selectActiveVersion(values: readonly unknown[], scoredVersion: string | undefined): TesslVersion | undefined {
  const ordered = scoredVersion === undefined
    ? [...values]
    : [...values].sort((left, right) => (isRecord(left) && left.version === scoredVersion ? -1 : 0) - (isRecord(right) && right.version === scoredVersion ? -1 : 0));
  for (const value of ordered) {
    if (!isRecord(value) || typeof value.version !== 'string' || !REF_RE.test(value.version) || value.hasSkills !== true || value.archived !== false) continue;
    if (scoredVersion !== undefined && value.version !== scoredVersion) continue;
    if (typeof value.fingerprint !== 'string' || !FINGERPRINT_RE.test(value.fingerprint)) continue;
    const summary = cleanDescription(value.summary);
    const skills = parseSkills(value.skills);
    return { version: value.version, fingerprint: value.fingerprint, ...(summary === undefined ? {} : { summary }), ...(skills === undefined ? {} : { skills }) };
  }
  return undefined;
}

function parseSkills(value: unknown): readonly TesslSkill[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const skills: TesslSkill[] = [];
  for (const item of value.slice(0, MAX_SKILLS_PER_TILE)) {
    if (!isRecord(item) || typeof item.path !== 'string') continue;
    const path = normalizeSkillFilePath(item.path);
    if (path === undefined) continue;
    const name = cleanText(item.name);
    const description = cleanDescription(item.description);
    skills.push({ path, ...(name === undefined ? {} : { name }), ...(description === undefined ? {} : { description }) });
  }
  return skills;
}

function parseVersionResponse(value: unknown, identity: ParsedTesslIdentity): TesslVersion {
  if (!isRecord(value) || !isRecord(value.data)) throw sourceError('SOURCE_RESOLUTION_INVALID', 'Tessl version response did not match the documented schema', false);
  const data = value.data;
  if (data.type !== 'tile-version' || !isRecord(data.attributes)) throw sourceError('SOURCE_RESOLUTION_INVALID', 'Tessl version response was not a tile version', false);
  const attrs = data.attributes;
  if (attrs.version !== identity.version || typeof attrs.fingerprint !== 'string' || !FINGERPRINT_RE.test(attrs.fingerprint) || attrs.hasSkills !== true || attrs.archived !== false) {
    throw sourceError('SOURCE_RESOLUTION_INVALID', 'Tessl tile version identity is not active', false);
  }
  if (attrs.moderationPassed === false || (typeof attrs.moderationStatus === 'string' && ['fail', 'error', 'pending'].includes(attrs.moderationStatus))) {
    throw sourceError('SOURCE_RESOLUTION_INVALID', 'Tessl tile version is not installable', false);
  }
  const summary = cleanDescription(attrs.summary);
  return { version: identity.version, fingerprint: attrs.fingerprint, ...(summary === undefined ? {} : { summary }) };
}

function selectSkillFile(requested: string | undefined, manifest: readonly string[]): string {
  const skillFiles = manifest.filter((path) => isSkillFilePath(path));
  if (requested !== undefined) {
    if (!skillFiles.includes(requested)) throw sourceError('SOURCE_RESOLUTION_INVALID', 'Tessl selected SKILL.md was not present in the tile version', false);
    return requested;
  }
  if (skillFiles.length !== 1) {
    throw sourceError('SOURCE_RESOLUTION_INVALID', skillFiles.length === 0 ? 'Tessl tile version has no SKILL.md' : 'Tessl tile version has multiple SKILL.md files; select one explicitly', false);
  }
  return skillFiles[0]!;
}

function parseTesslExternalId(value: string): ParsedTesslIdentity {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_024 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new SourceCatalogError('SOURCE_INVALID_EXTERNAL_ID', 'Tessl external id is invalid', 400);
  }
  let body = value;
  if (body.startsWith('tessl:')) body = body.slice('tessl:'.length);
  else if (body.startsWith('@tessl/')) body = body.slice('@tessl/'.length);
  else throw new SourceCatalogError('SOURCE_INVALID_EXTERNAL_ID', 'Tessl external id must use the Tessl scheme', 400);
  const hash = body.indexOf('#');
  const coordinate = hash < 0 ? body : body.slice(0, hash);
  const suppliedPath = hash < 0 ? undefined : body.slice(hash + 1);
  if (hash >= 0 && body.indexOf('#', hash + 1) >= 0) throw new SourceCatalogError('SOURCE_INVALID_EXTERNAL_ID', 'Tessl external id contains multiple paths', 400);
  const slash = coordinate.indexOf('/');
  const at = coordinate.indexOf('@');
  if (slash <= 0 || at <= slash + 1 || coordinate.indexOf('/', slash + 1) >= 0 || coordinate.indexOf('@', at + 1) >= 0) {
    throw new SourceCatalogError('SOURCE_INVALID_EXTERNAL_ID', 'Tessl external id must include workspace, tile, and version', 400);
  }
  const workspace = coordinate.slice(0, slash);
  const tile = coordinate.slice(slash + 1, at);
  const version = coordinate.slice(at + 1);
  if (!COORDINATE_RE.test(workspace) || !COORDINATE_RE.test(tile) || !REF_RE.test(version)) {
    throw new SourceCatalogError('SOURCE_INVALID_EXTERNAL_ID', 'Tessl external id coordinate is invalid', 400);
  }
  if (suppliedPath === undefined || suppliedPath === '') return { workspace, tile, version };
  const filePath = suppliedPath.endsWith('/SKILL.md') || suppliedPath === 'SKILL.md' ? suppliedPath : `${suppliedPath}/SKILL.md`;
  if (normalizeArchivePath(filePath) === undefined || !isSkillFilePath(filePath)) throw new SourceCatalogError('SOURCE_INVALID_EXTERNAL_ID', 'Tessl skill path is invalid', 400);
  return { workspace, tile, version, skillFilePath: filePath };
}

function parseFullName(value: string): { workspace: string; tile: string } | undefined {
  const slash = value.indexOf('/');
  if (slash <= 0 || value.indexOf('/', slash + 1) >= 0) return undefined;
  const workspace = value.slice(0, slash);
  const tile = value.slice(slash + 1);
  return COORDINATE_RE.test(workspace) && COORDINATE_RE.test(tile) ? { workspace, tile } : undefined;
}

function normalizeSkillFilePath(value: string): string | undefined {
  const normalized = normalizeArchivePath(value);
  return normalized !== undefined && isSkillFilePath(normalized) ? normalized : undefined;
}

function normalizeArchivePath(value: string): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_LENGTH || value.startsWith('/') || value.includes('\\') || value.includes('#') || value.includes('?')) return undefined;
  const parts = value.split('/');
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..' && SEGMENT_RE.test(part)) ? value : undefined;
}

function isSkillFilePath(value: string): boolean {
  return normalizeArchivePath(value) !== undefined && value === 'SKILL.md' || (normalizeArchivePath(value) !== undefined && value.endsWith('/SKILL.md'));
}

function folderForSkillFile(path: string): string {
  if (path === 'SKILL.md') return '';
  return path.slice(0, -'/SKILL.md'.length);
}

function skillNameForPath(path: string, tile: string): string {
  if (path === '') return tile;
  return path.split('/').at(-1) ?? tile;
}

function canonicalTesslExternalId(workspace: string, tile: string, version: string, skillFilePath: string): string {
  return `tessl:${workspace}/${tile}@${version}#${skillFilePath}`;
}

function tesslVersionPath(workspace: string, tile: string, version: string): string {
  return `/v1/tiles/${encodeURIComponent(workspace)}/${encodeURIComponent(tile)}/versions/${encodeURIComponent(version)}`;
}

function tesslFilesPath(workspace: string, tile: string, version: string): string {
  return `${tesslVersionPath(workspace, tile, version)}/files`;
}

function tesslVersionUrl(workspace: string, tile: string, version: string): string {
  return `${TESSL_API_ORIGIN}${tesslVersionPath(workspace, tile, version)}`;
}

function tesslFilesUrl(workspace: string, tile: string, version: string): string {
  return `${TESSL_API_ORIGIN}${tesslFilesPath(workspace, tile, version)}`;
}

function validateNextPage(value: string, expectedPath: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw sourceError('SOURCE_ORIGIN_UNTRUSTED', 'Tessl next link is invalid', false); }
  if (url.origin !== TESSL_API_ORIGIN || url.protocol !== 'https:' || url.username || url.password || url.hash || url.pathname !== expectedPath) {
    throw sourceError('SOURCE_ORIGIN_UNTRUSTED', 'Tessl next link left the fixed API origin', false);
  }
  return `${url.pathname}${url.search}`;
}

function trustedApiUrl(path: string, params: Record<string, string | number | boolean> | undefined): URL {
  let url: URL;
  try { url = new URL(path, TESSL_API_ORIGIN); } catch { throw sourceError('SOURCE_ORIGIN_UNTRUSTED', 'Tessl request URL is invalid', false); }
  if (url.origin !== TESSL_API_ORIGIN || url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw sourceError('SOURCE_ORIGIN_UNTRUSTED', 'Tessl request origin is not trusted', false);
  }
  if (params) for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url;
}

function verifyResponseOrigin(response: Response): void {
  if (response.url === '') return;
  let url: URL;
  try { url = new URL(response.url); } catch { throw sourceError('SOURCE_ORIGIN_UNTRUSTED', 'Tessl response URL is invalid', false); }
  if (url.origin !== TESSL_API_ORIGIN || url.protocol !== 'https:') throw sourceError('SOURCE_ORIGIN_UNTRUSTED', 'Tessl response origin is not trusted', false);
}

async function readBounded(response: Response, maximum: number): Promise<Uint8Array> {
  const length = response.headers.get('content-length');
  if (length !== null && /^\d+$/u.test(length) && Number(length) > maximum) throw sourceError('SOURCE_RESOLUTION_INVALID', 'Tessl response exceeded its byte bound', false);
  if (response.body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximum) throw sourceError('SOURCE_RESOLUTION_INVALID', 'Tessl response exceeded its byte bound', false);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw sourceError('SOURCE_RESOLUTION_INVALID', 'Tessl response exceeded its byte bound', false);
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function requestSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort(parent?.reason);
  if (parent) {
    if (parent.aborted) controller.abort(parent.reason);
    else parent.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

function cleanText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').trim();
  return text.length > 0 && text.length <= MAX_TEXT_LENGTH ? text : undefined;
}

function cleanDescription(value: unknown): string | undefined {
  const text = cleanText(value);
  return text !== undefined && text.length <= MAX_DESCRIPTION_LENGTH ? text : undefined;
}

function normalizeQuery(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.length > MAX_QUERY_LENGTH || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new SourceCatalogError('SOURCE_INVALID_QUERY', 'Tessl search query is invalid', 400);
  }
  return value.trim();
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_RESULTS;
  if (!Number.isSafeInteger(value) || value < 1) throw new SourceCatalogError('SOURCE_INVALID_QUERY', 'Tessl search limit must be a positive integer', 400);
  return Math.min(value, MAX_RESULTS);
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min) throw new SourceCatalogError('SOURCE_UNAVAILABLE', 'Tessl adapter bound is invalid', 500);
  return Math.min(value, max);
}

function httpFailure(status: number, message: string): SourceCatalogError {
  if (status === 401 || status === 403 || status === 429) return new SourceCatalogError('SOURCE_UNAVAILABLE', message, status, { retryable: status === 429 });
  if (status >= 500) return new SourceCatalogError('SOURCE_UNAVAILABLE', message, 502, { retryable: true });
  return new SourceCatalogError('SOURCE_RESOLUTION_INVALID', message, 502);
}

function sourceError(code: 'SOURCE_RESOLUTION_INVALID' | 'SOURCE_TIMEOUT' | 'SOURCE_UNAVAILABLE' | 'SOURCE_ORIGIN_UNTRUSTED', message: string, retryable: boolean): SourceCatalogError {
  const status = code === 'SOURCE_TIMEOUT' ? 504 : code === 'SOURCE_ORIGIN_UNTRUSTED' ? 502 : 502;
  return new SourceCatalogError(code, message, status, { retryable });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
