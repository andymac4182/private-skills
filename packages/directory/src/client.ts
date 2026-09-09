import {
  SKILLS_DIRECTORY_DEFAULT_BASE_URL,
  SkillsDirectoryError,
  type CuratedOwner,
  type CuratedSkillsResponse,
  type DirectoryLimits,
  type ListSkillsOptions,
  type SearchSkillsOptions,
  type SkillAuditEntry,
  type SkillAuditResponse,
  type SkillDetailFile,
  type SkillDetailResponse,
  type SkillListResponse,
  type SkillPagination,
  type SkillSearchResponse,
  type SkillSearchType,
  type SkillSourceType,
  type SkillView,
  type SkillsDirectoryClientOptions,
  type SkillsFetch,
  type SkillsTokenProvider,
  type V1Skill,
  type RequestOptions,
} from './types.js';

/** Conservative limits for data retained from an external directory. */
export const DEFAULT_DIRECTORY_LIMITS: Readonly<DirectoryLimits> = Object.freeze({
  maxResponseBytes: 8 * 1024 * 1024,
  maxFiles: 2_000,
  maxPathBytes: 4_096,
  maxTextBytes: 1 * 1024 * 1024,
  maxTotalTextBytes: 32 * 1024 * 1024,
  maxStringBytes: 16 * 1024,
  maxAttempts: 3,
  maxRetryAfterMs: 2_000,
  requestTimeoutMs: 15_000,
});

const DEFAULT_LIST_PAGE = 0;
const DEFAULT_LIST_PER_PAGE = 100;
const DEFAULT_SEARCH_LIMIT = 50;
const MAX_QUERY_BYTES = 16 * 1024;
const MAX_OWNER_BYTES = 512;
const MAX_IDENTIFIER_BYTES = 2_048;
const MAX_IDENTIFIER_SEGMENTS = 64;
const MAX_IDENTIFIER_SEGMENT_BYTES = 512;

type JsonRecord = Record<string, unknown>;

interface FetchAttempt {
  response: Response;
  controller: AbortController;
  cleanup: () => void;
}

/**
 * A small, dependency-free client for the public skills.sh API.
 *
 * Authentication is deliberately request scoped: `getToken` is called once
 * for every public API method invocation and its result is kept only for that
 * request's bounded retry loop.  No token or response metadata is cached by
 * this class.
 */
export class SkillsDirectoryClient {
  private readonly baseURL: URL;
  private readonly fetchImpl: SkillsFetch;
  private readonly getToken?: SkillsTokenProvider;
  private readonly limits: DirectoryLimits;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(options: SkillsDirectoryClientOptions = {}) {
    this.baseURL = normalizeBaseURL(options.baseURL);
    this.fetchImpl = options.fetch ?? options.fetchImpl ?? defaultFetch;
    this.getToken = options.getToken;
    this.limits = normalizeLimits(options);
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Return one bounded leaderboard page. */
  async list(options: ListSkillsOptions = {}): Promise<SkillListResponse> {
    const view = normalizeView(options.view);
    const page = normalizeNonNegativeInteger(options.page ?? DEFAULT_LIST_PAGE, 'page');
    const perPage = normalizeBoundedInteger(options.perPage ?? DEFAULT_LIST_PER_PAGE, 1, 500, 'perPage');
    const query = new URLSearchParams();
    query.set('view', view);
    query.set('page', String(page));
    query.set('per_page', String(perPage));

    return this.request(
      'skills',
      query,
      options.signal,
      (body) => normalizeSkillListResponse(body, this.limits, this.baseURL),
    );
  }

  /**
   * Search by name/source/description.  Both `search({ q })` and
   * `search('query', { limit, owner })` are accepted for host ergonomics.
   */
  async search(options: SearchSkillsOptions): Promise<SkillSearchResponse>;
  async search(query: string, options?: Omit<SearchSkillsOptions, 'q'>): Promise<SkillSearchResponse>;
  async search(
    queryOrOptions: string | SearchSkillsOptions,
    options: Omit<SearchSkillsOptions, 'q'> = {},
  ): Promise<SkillSearchResponse> {
    const searchOptions: SearchSkillsOptions = typeof queryOrOptions === 'string'
      ? { ...options, q: queryOrOptions }
      : queryOrOptions;
    const q = normalizeQuery(searchOptions.q);
    const limit = normalizeBoundedInteger(searchOptions.limit ?? DEFAULT_SEARCH_LIMIT, 1, 200, 'limit');
    const owner = searchOptions.owner === undefined ? undefined : normalizeOwner(searchOptions.owner);
    const query = new URLSearchParams();
    query.set('q', q);
    query.set('limit', String(limit));
    if (owner !== undefined) query.set('owner', owner);

    return this.request(
      'skills/search',
      query,
      searchOptions.signal,
      (body) => normalizeSkillSearchResponse(body, this.limits, this.baseURL),
    );
  }

  /** Return the official first-party curated grouping. */
  async curated(options: RequestOptions = {}): Promise<CuratedSkillsResponse> {
    return this.request(
      'skills/curated',
      undefined,
      options.signal,
      (body) => normalizeCuratedSkillsResponse(body, this.limits, this.baseURL),
    );
  }

  /** Return a skill's metadata and bounded text snapshot, when available. */
  async detail(id: string, options: RequestOptions = {}): Promise<SkillDetailResponse> {
    const normalizedId = normalizeSkillId(id);
    return this.request(
      `skills/${pathEncodeId(normalizedId)}`,
      undefined,
      options.signal,
      (body) => {
        const detail = normalizeSkillDetailResponse(body, this.limits, this.baseURL);
        if (detail.id !== normalizedId) throw invalidResponseError('detail.id');
        return detail;
      },
    );
  }

  /** Return partner audit evidence without translating it into local policy. */
  async audit(id: string, options: RequestOptions = {}): Promise<SkillAuditResponse> {
    const normalizedId = normalizeSkillId(id);
    return this.request(
      `skills/audit/${pathEncodeId(normalizedId)}`,
      undefined,
      options.signal,
      (body) => {
        const audit = normalizeSkillAuditResponse(body, this.limits, this.baseURL);
        if (audit.id !== normalizedId) throw invalidResponseError('audit.id');
        return audit;
      },
    );
  }

  private async request<T>(
    endpoint: string,
    query: URLSearchParams | undefined,
    signal: AbortSignal | undefined,
    normalize: (body: unknown) => T,
  ): Promise<T> {
    if (signal?.aborted) throw requestTimeoutError();

    // Resolve the token once for this high-level API request.  It is scoped to
    // this invocation and is never saved on the client or shared globally.
    const token = await this.resolveToken(signal);
    const url = this.urlFor(endpoint, query);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (token !== undefined) headers.authorization = `Bearer ${token}`;

    for (let attempt = 1; attempt <= this.limits.maxAttempts; attempt += 1) {
      let attemptResult: FetchAttempt;
      try {
        attemptResult = await this.fetchOnce(url, headers, signal);
      } catch (error) {
        if (error instanceof SkillsDirectoryError) throw error;
        if (isAbortError(error)) throw requestTimeoutError();
        if (attempt < this.limits.maxAttempts) {
          await this.retryDelay(undefined, attempt);
          continue;
        }
        throw unavailableError();
      }

      try {
        const { response } = attemptResult;
        if (isRedirectStatus(response.status)) {
          cancelBody(response);
          throw new SkillsDirectoryError(
            'redirect_denied',
            'skills.sh returned a redirect that this client will not follow',
            { status: response.status },
          );
        }

        if (response.status === 429) {
          const retryAfter = parseRetryAfter(response.headers.get('retry-after'), this.limits.maxRetryAfterMs, attempt);
          cancelBody(response);
          if (retryAfter.exceedsMaximum || attempt >= this.limits.maxAttempts) {
            throw new SkillsDirectoryError(
              'rate_limited',
              'skills.sh rate limit exceeded',
              { status: 429, retryAfterMs: retryAfter.milliseconds },
            );
          }
          await this.sleep(retryAfter.milliseconds);
          continue;
        }

        if (response.status === 404) {
          cancelBody(response);
          throw new SkillsDirectoryError('not_found', 'The requested skills.sh resource was not found', { status: 404 });
        }

        if (response.status === 401 || response.status === 403) {
          cancelBody(response);
          throw new SkillsDirectoryError('unauthorized', 'skills.sh authentication was rejected', { status: response.status });
        }

        if (isRetryableStatus(response.status)) {
          cancelBody(response);
          if (attempt < this.limits.maxAttempts) {
            await this.retryDelay(undefined, attempt);
            continue;
          }
          throw unavailableError(response.status);
        }

        if (response.status < 200 || response.status >= 300) {
          cancelBody(response);
          throw new SkillsDirectoryError('http_error', 'skills.sh rejected the request', { status: response.status });
        }

        let body: unknown;
        try {
          body = await withTimeout(
            readJsonResponse(response, this.limits.maxResponseBytes, attemptResult.controller.signal),
            this.limits.requestTimeoutMs,
            () => attemptResult.controller.abort(),
          );
        } catch (error) {
          if (error instanceof TimeoutMarker || isAbortError(error)) {
            cancelBody(response);
            throw requestTimeoutError();
          }
          throw error;
        }
        return normalize(body);
      } finally {
        attemptResult.cleanup();
      }
    }

    // The loop always returns or throws.  Keep a defensive branch so a future
    // change to the retry policy cannot accidentally create an undefined API.
    throw unavailableError();
  }

  private async resolveToken(callerSignal: AbortSignal | undefined): Promise<string | undefined> {
    if (!this.getToken) return undefined;
    const controller = new AbortController();
    const abortCaller = () => controller.abort();
    if (callerSignal) {
      if (callerSignal.aborted) throw requestTimeoutError();
      callerSignal.addEventListener('abort', abortCaller, { once: true });
    }
    try {
      const result = await withTimeout(
        this.getToken(controller.signal),
        this.limits.requestTimeoutMs,
        () => controller.abort(),
      );
      if (callerSignal?.aborted) throw requestTimeoutError();
      if (result === undefined || result === null || result.trim() === '') return undefined;
      if (result.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(result)) {
        throw invalidInputError('token');
      }
      return result;
    } catch (error) {
      if (callerSignal?.aborted || controller.signal.aborted) throw requestTimeoutError();
      if (error instanceof SkillsDirectoryError) throw error;
      if (isAbortError(error) || error instanceof TimeoutMarker) throw requestTimeoutError();
      // Do not expose provider errors, which can contain credential material.
      throw unavailableError();
    } finally {
      callerSignal?.removeEventListener('abort', abortCaller);
    }
  }

  private async fetchOnce(
    url: URL,
    headers: Record<string, string>,
    callerSignal: AbortSignal | undefined,
  ): Promise<FetchAttempt> {
    const controller = new AbortController();
    const abortCaller = () => controller.abort();
    if (callerSignal) {
      if (callerSignal.aborted) throw requestTimeoutError();
      callerSignal.addEventListener('abort', abortCaller, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), this.limits.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(url.toString(), {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: controller.signal,
      });
      return {
        response,
        controller,
        cleanup: () => {
          clearTimeout(timer);
          callerSignal?.removeEventListener('abort', abortCaller);
        },
      };
    } catch (error) {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', abortCaller);
      if (callerSignal?.aborted || controller.signal.aborted) throw requestTimeoutError();
      throw error;
    }
  }

  private async retryDelay(retryAfter: string | null | undefined, attempt: number): Promise<void> {
    const delay = parseRetryAfter(retryAfter, this.limits.maxRetryAfterMs, attempt);
    await this.sleep(delay.milliseconds);
  }

  private urlFor(endpoint: string, query: URLSearchParams | undefined): URL {
    const url = new URL(this.baseURL.toString());
    const prefix = url.pathname.replace(/\/+$/u, '');
    const normalizedEndpoint = endpoint.replace(/^\/+|\/+$/gu, '');
    url.pathname = `${prefix}/api/v1/${normalizedEndpoint}`.replace(/\/{2,}/gu, '/');
    url.search = query?.toString() ?? '';
    return url;
  }
}

/** Factory spelling keeps route/worker composition terse. */
export function createSkillsDirectoryClient(options: SkillsDirectoryClientOptions = {}): SkillsDirectoryClient {
  return new SkillsDirectoryClient(options);
}

/** Compatibility aliases for callers that name the service after skills.sh. */
export const SkillsShClient = SkillsDirectoryClient;
export const SkillsClient = SkillsDirectoryClient;

function defaultFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init);
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeBaseURL(value: string | URL | undefined): URL {
  let url: URL;
  try {
    url = new URL(value?.toString() ?? SKILLS_DIRECTORY_DEFAULT_BASE_URL);
  } catch {
    throw invalidInputError('baseURL');
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw invalidInputError('baseURL');
  }
  url.pathname = url.pathname.replace(/\/+$/u, '');
  return url;
}

function normalizeLimits(options: SkillsDirectoryClientOptions): DirectoryLimits {
  const raw: DirectoryLimits = {
    ...DEFAULT_DIRECTORY_LIMITS,
    ...options.limits,
  };
  if (options.requestTimeoutMs !== undefined) raw.requestTimeoutMs = options.requestTimeoutMs;
  if (options.maxAttempts !== undefined) raw.maxAttempts = options.maxAttempts;
  if (options.maxRetryAfterMs !== undefined) raw.maxRetryAfterMs = options.maxRetryAfterMs;

  requirePositiveBound(raw.maxResponseBytes, 1, 64 * 1024 * 1024, 'maxResponseBytes');
  requirePositiveBound(raw.maxFiles, 1, 100_000, 'maxFiles');
  requirePositiveBound(raw.maxPathBytes, 1, 1 * 1024 * 1024, 'maxPathBytes');
  requirePositiveBound(raw.maxTextBytes, 1, 32 * 1024 * 1024, 'maxTextBytes');
  requirePositiveBound(raw.maxTotalTextBytes, 1, 256 * 1024 * 1024, 'maxTotalTextBytes');
  requirePositiveBound(raw.maxStringBytes, 1, 1 * 1024 * 1024, 'maxStringBytes');
  requirePositiveBound(raw.maxAttempts, 1, 5, 'maxAttempts');
  requirePositiveBound(raw.maxRetryAfterMs, 0, 60_000, 'maxRetryAfterMs');
  requirePositiveBound(raw.requestTimeoutMs, 1, 120_000, 'requestTimeoutMs');
  return raw;
}

function requirePositiveBound(value: number, minimum: number, maximum: number, name: string): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw invalidInputError(name);
}

function normalizeView(value: SkillView | undefined): SkillView {
  if (value === undefined) return 'all-time';
  if (value === 'all-time' || value === 'trending' || value === 'hot') return value;
  throw invalidInputError('view');
}

function normalizeNonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw invalidInputError(name);
  return value;
}

function normalizeBoundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw invalidInputError(name);
  return value;
}

function normalizeQuery(value: unknown): string {
  if (typeof value !== 'string') throw invalidInputError('q');
  const normalized = value.trim();
  if ([...normalized].length < 2 || new TextEncoder().encode(normalized).byteLength > MAX_QUERY_BYTES || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw invalidInputError('q');
  }
  return normalized;
}

function normalizeOwner(value: unknown): string {
  if (typeof value !== 'string') throw invalidInputError('owner');
  const normalized = value.trim();
  if (normalized.length === 0 || new TextEncoder().encode(normalized).byteLength > MAX_OWNER_BYTES || /[\u0000-\u001f\u007f/\\]/u.test(normalized)) {
    throw invalidInputError('owner');
  }
  return normalized;
}

function normalizeSkillId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || new TextEncoder().encode(value).byteLength > MAX_IDENTIFIER_BYTES || value.trim() !== value || hasUnpairedSurrogate(value) || /[\u0000-\u001f\u007f?#%\\]/u.test(value)) {
    throw invalidInputError('id');
  }
  const segments = value.split('/');
  if (segments.length < 2 || segments.length > MAX_IDENTIFIER_SEGMENTS || segments.some((segment) => {
    const segmentBytes = new TextEncoder().encode(segment).byteLength;
    return segment.length === 0 || segment === '.' || segment === '..' || segmentBytes > MAX_IDENTIFIER_SEGMENT_BYTES;
  })) {
    throw invalidInputError('id');
  }
  return value;
}

function isSafeSkillIdentity(id: string, source: string, slug: string): boolean {
  if (id !== `${source}/${slug}`) return false;
  if (new TextEncoder().encode(id).byteLength > MAX_IDENTIFIER_BYTES || id.trim() !== id || hasUnpairedSurrogate(id) || /[\u0000-\u001f\u007f?#%\\]/u.test(id)) return false;
  const segments = id.split('/');
  return segments.length >= 2 && segments.length <= MAX_IDENTIFIER_SEGMENTS && segments.every((segment) => {
    const segmentBytes = new TextEncoder().encode(segment).byteLength;
    return segment.length > 0 && segment !== '.' && segment !== '..' && segmentBytes <= MAX_IDENTIFIER_SEGMENT_BYTES;
  });
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function pathEncodeId(id: string): string {
  return id.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function normalizeSkillListResponse(value: unknown, limits: DirectoryLimits, baseURL: URL): SkillListResponse {
  const record = responseRecord(value, 'list');
  const data = responseArray(record.data, 'list.data');
  if (data.length > 500) throw invalidResponseError('list.data');
  const pagination = responseRecord(record.pagination, 'list.pagination');
  return {
    data: data.map((entry, index) => normalizeSkill(entry, limits, baseURL, `list.data[${index}]`)),
    pagination: normalizePagination(pagination, 'list.pagination'),
  };
}

function normalizeSkillSearchResponse(value: unknown, limits: DirectoryLimits, baseURL: URL): SkillSearchResponse {
  const record = responseRecord(value, 'search');
  const data = responseArray(record.data, 'search.data');
  if (data.length > 200) throw invalidResponseError('search.data');
  const searchType = boundedMetadataString(record.searchType, limits, 'search.searchType');
  if (searchType !== 'fuzzy' && searchType !== 'semantic') throw invalidResponseError('search.searchType');
  return {
    data: data.map((entry, index) => normalizeSkill(entry, limits, baseURL, `search.data[${index}]`)),
    query: boundedMetadataString(record.query, limits, 'search.query'),
    searchType,
    count: nonNegativeInteger(record.count, 'search.count'),
    durationMs: nonNegativeInteger(record.durationMs, 'search.durationMs'),
  };
}

function normalizeCuratedSkillsResponse(value: unknown, limits: DirectoryLimits, baseURL: URL): CuratedSkillsResponse {
  const record = responseRecord(value, 'curated');
  const data = responseArray(record.data, 'curated.data');
  if (data.length > limits.maxFiles) throw invalidResponseError('curated.data');
  return {
    data: data.map((entry, index) => normalizeCuratedOwner(entry, limits, baseURL, `curated.data[${index}]`)),
    totalOwners: nonNegativeInteger(record.totalOwners, 'curated.totalOwners'),
    totalSkills: nonNegativeInteger(record.totalSkills, 'curated.totalSkills'),
    generatedAt: isoTimestamp(record.generatedAt, 'curated.generatedAt', limits),
  };
}

function normalizeSkillDetailResponse(value: unknown, limits: DirectoryLimits, _baseURL: URL): SkillDetailResponse {
  const record = responseRecord(value, 'detail');
  const id = boundedMetadataString(record.id, limits, 'detail.id');
  const source = boundedMetadataString(record.source, limits, 'detail.source');
  const slug = boundedMetadataString(record.slug, limits, 'detail.slug');
  if (!isSafeSkillIdentity(id, source, slug)) throw invalidResponseError('detail.identity');
  const filesValue = record.files;
  let files: SkillDetailFile[] | null;
  if (filesValue === null) {
    files = null;
  } else {
    const entries = responseArray(filesValue, 'detail.files');
    if (entries.length > limits.maxFiles) throw invalidResponseError('detail.files');
    const seen = new Set<string>();
    let totalBytes = 0;
    files = entries.map((entry, index) => {
      const file = normalizeDetailFile(entry, limits, `detail.files[${index}]`);
      const key = file.path.normalize('NFC').toLocaleLowerCase('en-US');
      if (seen.has(key)) throw invalidResponseError('detail.files');
      seen.add(key);
      const bytes = new TextEncoder().encode(file.contents).byteLength;
      totalBytes += bytes;
      if (totalBytes > limits.maxTotalTextBytes) throw invalidResponseError('detail.files');
      return file;
    });
  }
  return {
    id,
    source,
    slug,
    installs: nonNegativeInteger(record.installs, 'detail.installs'),
    hash: nullableSnapshotHash(record.hash, limits, 'detail.hash'),
    files,
  };
}

function normalizeSkillAuditResponse(value: unknown, limits: DirectoryLimits, _baseURL: URL): SkillAuditResponse {
  const record = responseRecord(value, 'audit');
  const id = boundedMetadataString(record.id, limits, 'audit.id');
  const source = boundedMetadataString(record.source, limits, 'audit.source');
  const slug = boundedMetadataString(record.slug, limits, 'audit.slug');
  if (!isSafeSkillIdentity(id, source, slug)) throw invalidResponseError('audit.identity');
  const audits = responseArray(record.audits, 'audit.audits');
  if (audits.length > limits.maxFiles) throw invalidResponseError('audit.audits');
  return {
    id,
    source,
    slug,
    audits: audits.map((entry, index) => normalizeAuditEntry(entry, limits, `audit.audits[${index}]`)),
  };
}

function normalizeSkill(value: unknown, limits: DirectoryLimits, baseURL: URL, context: string): V1Skill {
  const record = responseRecord(value, context);
  const sourceType = boundedMetadataString(record.sourceType, limits, `${context}.sourceType`);
  if (sourceType !== 'github' && sourceType !== 'well-known') throw invalidResponseError(`${context}.sourceType`);
  const id = boundedMetadataString(record.id, limits, `${context}.id`);
  const slug = boundedMetadataString(record.slug, limits, `${context}.slug`);
  const source = boundedMetadataString(record.source, limits, `${context}.source`);
  if (!isSafeSkillIdentity(id, source, slug)) throw invalidResponseError(`${context}.identity`);
  const installUrl = record.installUrl === null
    ? null
    : httpsUrl(record.installUrl, limits, `${context}.installUrl`, baseURL, false);
  const normalized: V1Skill = {
    id,
    slug,
    name: boundedMetadataString(record.name, limits, `${context}.name`),
    source,
    installs: nonNegativeInteger(record.installs, `${context}.installs`),
    sourceType,
    installUrl,
    url: httpsUrl(record.url, limits, `${context}.url`, baseURL, true),
  };
  if (record.isDuplicate !== undefined) {
    if (typeof record.isDuplicate !== 'boolean') throw invalidResponseError(`${context}.isDuplicate`);
    normalized.isDuplicate = record.isDuplicate;
  }
  if (record.installsYesterday !== undefined) normalized.installsYesterday = nonNegativeInteger(record.installsYesterday, `${context}.installsYesterday`);
  if (record.change !== undefined) normalized.change = integer(record.change, `${context}.change`);
  return normalized;
}

function normalizePagination(value: JsonRecord, context: string): SkillPagination {
  const pagination = {
    page: nonNegativeInteger(value.page, `${context}.page`),
    perPage: nonNegativeInteger(value.perPage, `${context}.perPage`),
    total: nonNegativeInteger(value.total, `${context}.total`),
    hasMore: value.hasMore,
  };
  if (pagination.perPage < 1 || pagination.perPage > 500 || typeof pagination.hasMore !== 'boolean') throw invalidResponseError(context);
  return pagination as SkillPagination;
}

function normalizeCuratedOwner(value: unknown, limits: DirectoryLimits, baseURL: URL, context: string): CuratedOwner {
  const record = responseRecord(value, context);
  const skills = responseArray(record.skills, `${context}.skills`);
  if (skills.length > limits.maxFiles) throw invalidResponseError(`${context}.skills`);
  return {
    owner: boundedMetadataString(record.owner, limits, `${context}.owner`),
    totalInstalls: nonNegativeInteger(record.totalInstalls, `${context}.totalInstalls`),
    featuredRepo: boundedMetadataString(record.featuredRepo, limits, `${context}.featuredRepo`),
    featuredSkill: boundedMetadataString(record.featuredSkill, limits, `${context}.featuredSkill`),
    skills: skills.map((entry, index) => normalizeSkill(entry, limits, baseURL, `${context}.skills[${index}]`)),
  };
}

function normalizeDetailFile(value: unknown, limits: DirectoryLimits, context: string): SkillDetailFile {
  const record = responseRecord(value, context);
  const path = boundedMetadataString(record.path, limits, `${context}.path`);
  const contents = responseText(record.contents, limits, `${context}.contents`);
  const pathBytes = new TextEncoder().encode(path).byteLength;
  if (pathBytes > limits.maxPathBytes || !isSafeRelativePath(path)) throw invalidResponseError(`${context}.path`);
  return { path, contents };
}

function normalizeAuditEntry(value: unknown, limits: DirectoryLimits, context: string): SkillAuditEntry {
  const record = responseRecord(value, context);
  const status = boundedMetadataString(record.status, limits, `${context}.status`);
  if (status !== 'pass' && status !== 'warn' && status !== 'fail') throw invalidResponseError(`${context}.status`);
  const riskLevelValue = record.riskLevel;
  let riskLevel: SkillAuditEntry['riskLevel'];
  if (riskLevelValue === null) {
    riskLevel = null;
  } else if (riskLevelValue !== undefined) {
    const candidate = boundedMetadataString(riskLevelValue, limits, `${context}.riskLevel`);
    if (!['SAFE', 'NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(candidate)) throw invalidResponseError(`${context}.riskLevel`);
    riskLevel = candidate as SkillAuditEntry['riskLevel'];
  }
  let categories: SkillAuditEntry['categories'];
  if (record.categories === null) {
    categories = null;
  } else if (record.categories !== undefined) {
    const values = responseArray(record.categories, `${context}.categories`);
    if (values.length > 128) throw invalidResponseError(`${context}.categories`);
    categories = values.map((item, index) => boundedMetadataString(item, limits, `${context}.categories[${index}]`));
  }
  return {
    provider: boundedMetadataString(record.provider, limits, `${context}.provider`),
    slug: boundedMetadataString(record.slug, limits, `${context}.slug`),
    status,
    summary: boundedMetadataString(record.summary, limits, `${context}.summary`),
    auditedAt: isoTimestamp(record.auditedAt, `${context}.auditedAt`, limits),
    ...(riskLevel === undefined ? {} : { riskLevel }),
    ...(categories === undefined ? {} : { categories }),
  };
}

function responseRecord(value: unknown, context: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidResponseError(context);
  return value as JsonRecord;
}

function responseArray(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) throw invalidResponseError(context);
  return value;
}

function boundedMetadataString(value: unknown, limits: DirectoryLimits, context: string): string {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000\u007f]/u.test(value)) throw invalidResponseError(context);
  if (new TextEncoder().encode(value).byteLength > limits.maxStringBytes) throw invalidResponseError(context);
  return value;
}

function responseText(value: unknown, limits: DirectoryLimits, context: string): string {
  if (typeof value !== 'string') throw invalidResponseError(context);
  if (new TextEncoder().encode(value).byteLength > limits.maxTextBytes) throw invalidResponseError(context);
  return value;
}

function httpsUrl(
  value: unknown,
  limits: DirectoryLimits,
  context: string,
  baseURL: URL,
  allowRootRelative: boolean,
): string {
  const candidate = boundedMetadataString(value, limits, context);
  let url: URL;
  try {
    const rootRelative = candidate.startsWith('/') && !candidate.startsWith('//');
    if (rootRelative) {
      if (!allowRootRelative) throw invalidResponseError(context);
      url = new URL(candidate, baseURL);
    } else {
      url = new URL(candidate);
    }
  } catch {
    throw invalidResponseError(context);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw invalidResponseError(context);
  return url.toString();
}

function isoTimestamp(value: unknown, context: string, limits: DirectoryLimits): string {
  const timestamp = boundedMetadataString(value, limits, context);
  if (!Number.isFinite(Date.parse(timestamp))) throw invalidResponseError(context);
  return timestamp;
}

function nullableSnapshotHash(value: unknown, limits: DirectoryLimits, context: string): string | null {
  if (value === null) return null;
  return boundedMetadataString(value, limits, context);
}

function nonNegativeInteger(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw invalidResponseError(context);
  return value;
}

function integer(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw invalidResponseError(context);
  return value;
}

function isSafeRelativePath(value: string): boolean {
  if (value.length === 0 || value.startsWith('/') || value.includes('\\') || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

async function readJsonResponse(response: Response, maxBytes: number, signal: AbortSignal | undefined): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && /^\d+$/u.test(contentLength) && Number(contentLength) > maxBytes) {
    cancelBody(response);
    throw invalidResponseError('response size');
  }

  let bytes: Uint8Array;
  try {
    if (response.body) {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      const abortReader = () => {
        try {
          const cancellation = reader.cancel();
          void cancellation.catch(() => undefined);
        } catch {
          // The stream may already be closed while the deadline fires.
        }
      };
      signal?.addEventListener('abort', abortReader, { once: true });
      try {
        while (true) {
          if (signal?.aborted) throw new TimeoutMarker();
          const result = await reader.read();
          if (result.done) break;
          const chunk = result.value instanceof Uint8Array ? result.value : new Uint8Array(result.value);
          total += chunk.byteLength;
          if (total > maxBytes) {
            await reader.cancel();
            throw invalidResponseError('response size');
          }
          chunks.push(chunk);
        }
        if (signal?.aborted) throw new TimeoutMarker();
      } finally {
        signal?.removeEventListener('abort', abortReader);
        reader.releaseLock();
      }
      bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
    } else {
      const text = await response.text();
      if (signal?.aborted) throw new TimeoutMarker();
      bytes = new TextEncoder().encode(text);
      if (bytes.byteLength > maxBytes) throw invalidResponseError('response size');
    }
  } catch (error) {
    if (error instanceof SkillsDirectoryError) throw error;
    if (error instanceof TimeoutMarker || isAbortError(error)) throw requestTimeoutError();
    throw unavailableError();
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidResponseError('JSON');
  }
}

interface RetryDelay {
  milliseconds: number;
  exceedsMaximum: boolean;
}

function parseRetryAfter(value: string | null | undefined, maximum: number, attempt: number): RetryDelay {
  let milliseconds: number | undefined;
  if (value !== null && value !== undefined) {
    const seconds = Number(value.trim());
    if (/^\d+(?:\.\d+)?$/u.test(value.trim())) {
      const requested = seconds * 1_000;
      milliseconds = Number.isFinite(requested) ? Math.max(0, requested) : Number.MAX_SAFE_INTEGER;
    } else {
      const date = Date.parse(value);
      if (Number.isFinite(date)) milliseconds = Math.max(0, date - Date.now());
    }
  }
  if (milliseconds === undefined) milliseconds = Math.min(maximum, 100 * (2 ** Math.max(0, attempt - 1)));
  const normalized = Math.max(0, Math.round(milliseconds));
  return {
    milliseconds: Math.min(maximum, normalized),
    exceedsMaximum: normalized > maximum,
  };
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status >= 500;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && (error as { name?: unknown }).name === 'AbortError';
}

function cancelBody(response: Response): void {
  try {
    const cancellation = response.body?.cancel();
    if (cancellation) void cancellation.catch(() => undefined);
  } catch {
    // A fixture may expose a body that cannot be cancelled; no bytes are read.
  }
}

function invalidInputError(field: string): SkillsDirectoryError {
  return new SkillsDirectoryError('invalid_input', `Invalid skills.sh client option: ${field}`);
}

function invalidResponseError(field: string): SkillsDirectoryError {
  return new SkillsDirectoryError('invalid_response', `skills.sh returned an invalid ${field}`);
}

function unavailableError(status?: number): SkillsDirectoryError {
  return new SkillsDirectoryError('unavailable', 'skills.sh is temporarily unavailable', { status });
}

function requestTimeoutError(): SkillsDirectoryError {
  return new SkillsDirectoryError('request_timeout', 'skills.sh request timed out');
}

class TimeoutMarker extends Error {
  constructor() {
    super('request timeout');
    this.name = 'TimeoutMarker';
  }
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new TimeoutMarker());
    }, milliseconds);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
