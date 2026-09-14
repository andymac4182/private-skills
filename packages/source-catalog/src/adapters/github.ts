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

/** The only origin used for GitHub API requests by this adapter. */
export const GITHUB_API_ORIGIN = 'https://api.github.com' as const;
/** The only origin used for human-readable source links. */
export const GITHUB_SOURCE_ORIGIN = 'https://github.com' as const;
export const GITHUB_API_VERSION = '2022-11-28' as const;

export const BUILT_IN_GITHUB_REPOSITORIES = Object.freeze({
  'github-openai-skills': 'openai/skills',
  'github-anthropics-skills': 'anthropics/skills',
  'github-google-skills': 'google/skills',
  'github-vercel-agent-skills': 'vercel-labs/agent-skills',
} as const);

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_QUERY_LENGTH = 500;
const MAX_RESULTS = 50;
const MAX_REPOSITORIES = 32;
const MAX_TREE_ENTRIES = 20_000;
const MAX_RESPONSE_BYTES = 1 * 1024 * 1024;
const MAX_SEARCH_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_SKILL_FILE_BYTES = 256 * 1024;
const MAX_METADATA_FETCHES = 20;
const MAX_REQUESTS_PER_SEARCH = 64;
const MAX_SNAPSHOT_CACHE_ENTRIES = 32;
const MAX_REPOSITORY_METADATA_CACHE_ENTRIES = 32;
const SNAPSHOT_TTL_MS = 60_000;
const SHA1_RE = /^[0-9a-f]{40}$/iu;
// GitHub permits punctuation-leading repository names (for example
// `.dotfiles`); reject only the path-like `.` and `..` components.
const REPOSITORY_RE = /^(?!\.{1,2}\/)[A-Za-z0-9._-]{1,100}\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/u;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/~+-]{0,255}$/u;
const SEGMENT_RE = /^[^\u0000-\u001f\u007f\\/#?]+$/u;
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export type GitHubFetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type GitHubTokenProvider = (signal?: AbortSignal) => string | undefined | Promise<string | undefined>;

export interface GitHubRepositorySpec {
  repository: string;
  /** A branch, tag, or immutable commit. The adapter resolves it to a commit. */
  ref?: string;
}

export interface GitHubSourceAdapterOptions {
  /** Defaults to `github-code-search`; factories supply the built-in ids. */
  id?: SourceId;
  label?: string;
  repositories?: readonly (string | GitHubRepositorySpec)[];
  /** Alias accepted by the runtime composition for custom repository sources. */
  customRepositories?: readonly (string | GitHubRepositorySpec)[];
  fetch?: GitHubFetchLike;
  /** A request-scoped provider is preferred so tokens are not retained. */
  tokenProvider?: GitHubTokenProvider;
  getToken?: GitHubTokenProvider;
  /** Convenience for a server-owned token supplied by the runtime. */
  token?: string;
  /** Explicit environment map keeps this module usable in edge runtimes. */
  env?: Readonly<Record<string, string | undefined>>;
  requestTimeoutMs?: number;
  maxResults?: number;
  configRevision?: string;
  now?: () => Date;
}

interface NormalizedRepository {
  repository: string;
  ref?: string;
}

interface TreeEntry {
  path: string;
  type: 'blob' | 'tree';
  sha: string;
  size?: number;
}

interface RepositorySnapshot {
  repository: string;
  requestedRef: string;
  resolvedCommit: string;
  treeSha: string;
  entries: readonly TreeEntry[];
  fetchedAt: number;
}

interface RepositoryMetadata {
  repository: string;
  defaultBranch: string;
  fetchedAt: number;
}

interface SkillMetadata {
  name: string;
  description: string;
}

interface ParsedGithubIdentity {
  repository: string;
  /** Folder containing SKILL.md. The empty string identifies repository root. */
  skillPath: string;
  requestedRef?: string;
}

interface GithubBlobPayload {
  content?: unknown;
  encoding?: unknown;
  size?: unknown;
  sha?: unknown;
}

interface GithubFetchContext {
  signal?: AbortSignal;
  requests: number;
}

/**
 * Safe public GitHub skill discovery and identity resolution.
 *
 * The adapter only reads GitHub JSON API responses. It never clones a
 * repository, follows a provider redirect, or evaluates a discovered file.
 * Code search is used when a server token is available; public tree/blob
 * lookup keeps built-in and explicitly configured repositories useful when
 * GitHub's code-search endpoint requires authentication.
 */
export class GitHubSourceAdapter implements SourceCatalogAdapter {
  readonly id: SourceId;
  readonly label: string;
  readonly capabilities = ['search', 'resolve'] as const;
  readonly configRevision: string;

  private readonly fetchImpl: GitHubFetchLike;
  private readonly tokenProvider?: GitHubTokenProvider;
  private readonly token?: string;
  private readonly env?: Readonly<Record<string, string | undefined>>;
  private readonly timeoutMs: number;
  private readonly maxResults: number;
  private readonly now: () => Date;
  private readonly repositories: readonly NormalizedRepository[];
  private readonly snapshots = new Map<string, RepositorySnapshot>();
  private readonly repositoryMetadata = new Map<string, RepositoryMetadata>();

  constructor(options: GitHubSourceAdapterOptions = {}) {
    this.id = options.id ?? 'github-code-search';
    this.label = options.label ?? 'GitHub skills';
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.tokenProvider = options.tokenProvider ?? options.getToken;
    this.token = options.token;
    this.env = options.env;
    this.timeoutMs = boundedInteger(options.requestTimeoutMs, DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS);
    this.maxResults = boundedInteger(options.maxResults, MAX_RESULTS, 1, MAX_RESULTS);
    this.now = options.now ?? (() => new Date());

    const configured = options.repositories ?? options.customRepositories;
    const defaults = defaultRepositoriesForId(this.id);
    this.repositories = normalizeRepositories(configured ?? defaults);
    this.configRevision = options.configRevision ?? `github-v1:${this.id}:${this.repositories.map((item) => `${item.repository}@${item.ref ?? ''}`).join(',')}`;
  }

  availability(_context: SourceCatalogAdapterContext): SourceAvailability {
    if (this.id === 'github-code-search') {
      return this.hasConfiguredToken()
        ? { state: 'available', reason: 'Bounded public GitHub code search' }
        : { state: 'unavailable', code: 'MISSING_TOKEN', reason: 'GitHub public code search requires a server-owned token' };
    }
    return this.repositories.length > 0
      ? { state: 'available', reason: 'Bounded public GitHub repository discovery' }
      : { state: 'unavailable', code: 'NO_REPOSITORIES', reason: 'GitHub source has no configured repositories' };
  }

  async search(input: SourceSearchRequest): Promise<readonly SourceSearchResult[]> {
    const query = normalizeQuery(input.query);
    const limit = Math.min(normalizeLimit(input.limit), this.maxResults);
    const requestContext: GithubFetchContext = { signal: input.signal, requests: 0 };
    if (this.id === 'github-code-search') {
      const token = await this.readToken(input.signal);
      if (token === undefined) {
        throw sourceError('SOURCE_UNAVAILABLE', 'GitHub public code search requires a server-owned token', true);
      }
      return this.searchCode(query, limit, token, requestContext);
    }
    return this.searchRepositories(query, limit, requestContext);
  }

  async resolve(input: SourceResolveRequest): Promise<SourceResolution> {
    const identity = parseGithubExternalId(input.externalId);
    const repository = this.repositories.find((item) => item.repository.toLocaleLowerCase('en-US') === identity.repository.toLocaleLowerCase('en-US'));
    if (!repository && this.id !== 'github-code-search') {
      throw new SourceCatalogError('SOURCE_INVALID_EXTERNAL_ID', 'GitHub external id is outside the configured repository set', 400, { source: this.id });
    }
    if (input.refresh) this.clearSnapshots(identity.repository);
    const requestedRef = identity.requestedRef ?? repository?.ref;
    const snapshot = await this.loadRepository({ repository: identity.repository, ...(requestedRef === undefined ? {} : { ref: requestedRef }) }, input.signal);
    const selectedFolder = identity.skillPath;
    const skillFilePath = skillFilePathForFolder(selectedFolder);
    const entry = snapshot.entries.find((candidate) => candidate.type === 'blob' && candidate.path === skillFilePath);
    if (!entry) {
      throw new SourceCatalogError('SOURCE_RESOLUTION_INVALID', 'GitHub skill path was not found at the resolved ref', 502, { source: this.id });
    }
    const raw = await this.loadBlob(snapshot.repository, entry.sha, input.signal);
    const metadata = parseSkillMetadata(raw);
    const contentDigest = await sha256(raw);
    const row = this.resultFor(snapshot, selectedFolder, entry, metadata, contentDigest, input.externalId);
    const reference = canonicalGithubExternalId(snapshot.repository, snapshot.resolvedCommit, selectedFolder);
    return {
      sourceId: this.id,
      externalId: input.externalId,
      row,
      reference,
      title: metadata.name,
      description: metadata.description,
      version: snapshot.resolvedCommit,
      sourceType: 'github',
      sourceUrl: row.sourceUrl,
      snapshotDigest: contentDigest,
      metadata: row.metadata,
      acquisition: {
        kind: 'github',
        repository: snapshot.repository,
        path: selectedFolder,
        ref: snapshot.resolvedCommit,
        sourceProviderOrigin: GITHUB_SOURCE_ORIGIN,
        contentDigest,
      },
      configRevision: this.configRevision,
      resolvedAt: this.now().toISOString(),
    };
  }

  private async searchCode(
    query: string,
    limit: number,
    token: string,
    context: GithubFetchContext,
  ): Promise<readonly SourceSearchResult[]> {
    const terms = queryTerms(query);
    const searchQuery = `${terms.map((term) => `"${term}"`).join(' ')} filename:SKILL.md is:public`;
    const payload = await this.requestJson('/search/code', {
      q: searchQuery,
      per_page: Math.min(100, Math.max(10, limit * 2)),
      page: 1,
    }, context.signal, token, MAX_SEARCH_RESPONSE_BYTES, context);
    if (!isRecord(payload) || !Array.isArray(payload.items) || typeof payload.total_count !== 'number' || typeof payload.incomplete_results !== 'boolean') {
      throw sourceError('SOURCE_RESOLUTION_INVALID', 'GitHub code-search response did not match the documented schema', false);
    }
    if (payload.incomplete_results) {
      throw sourceError('SOURCE_UNAVAILABLE', 'GitHub code-search results were incomplete', true);
    }
    const results: SourceSearchResult[] = [];
    const seen = new Set<string>();
    let fetched = 0;
    for (const item of payload.items) {
      if (results.length >= limit || fetched >= MAX_METADATA_FETCHES) break;
      const location = parseCodeSearchLocation(item, this.id === 'github-code-search' ? undefined : this.repositories);
      if (!location) continue;
      const key = `${location.repository.toLocaleLowerCase('en-US')}\u0000${location.skillPath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fetched += 1;
      const repositorySpec = this.id === 'github-code-search'
        ? { repository: location.repository }
        : this.repositories.find((candidate) => candidate.repository.toLocaleLowerCase('en-US') === location.repository.toLocaleLowerCase('en-US')) ?? { repository: location.repository };
      try {
        const snapshot = await this.loadRepository({ ...repositorySpec, repository: location.repository }, context.signal, context);
        const entry = snapshot.entries.find((candidate) => candidate.type === 'blob' && candidate.path === skillFilePathForFolder(location.skillPath));
        if (!entry || entry.sha !== location.blobSha) continue;
        const raw = await this.loadBlob(snapshot.repository, entry.sha, context.signal, context);
        const metadata = parseSkillMetadata(raw);
        const digest = await sha256(raw);
        results.push(this.resultFor(snapshot, location.skillPath, entry, metadata, digest));
      } catch (error) {
        // A malformed candidate can be skipped, but provider transport and
        // origin failures must reach the client so availability is truthful.
        if (error instanceof SourceCatalogError && error.code === 'SOURCE_RESOLUTION_INVALID') continue;
        throw error;
      }
    }
    return results;
  }

  private async searchRepositories(
    query: string,
    limit: number,
    context: GithubFetchContext,
  ): Promise<readonly SourceSearchResult[]> {
    const terms = queryTerms(query);
    const results: SourceSearchResult[] = [];
    const seen = new Set<string>();
    let metadataFetches = 0;
    for (const repository of this.repositories) {
      if (results.length >= limit || metadataFetches >= MAX_METADATA_FETCHES) break;
      const snapshot = await this.loadRepository(repository, context.signal, context);
      const candidates = snapshot.entries
        .filter((entry) => entry.type === 'blob' && isSkillFilePath(entry.path))
        .sort((left, right) => pathScore(right.path, terms) - pathScore(left.path, terms) || left.path.localeCompare(right.path))
        .slice(0, MAX_METADATA_FETCHES);
      // Paths containing a query term are cheap to prioritize, but metadata is
      // still fetched for a bounded number of remaining candidates so a skill
      // whose useful words live only in its description can be found.
      for (const entry of candidates) {
        if (results.length >= limit || metadataFetches >= MAX_METADATA_FETCHES) break;
        const key = `${snapshot.repository.toLocaleLowerCase('en-US')}\u0000${entry.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        metadataFetches += 1;
        try {
          const raw = await this.loadBlob(snapshot.repository, entry.sha, context.signal, context);
          const metadata = parseSkillMetadata(raw);
          const haystack = `${metadata.name} ${metadata.description}`.toLocaleLowerCase('en-US');
          if (!terms.every((term) => haystack.includes(term.toLocaleLowerCase('en-US')) || entry.path.toLocaleLowerCase('en-US').includes(term.toLocaleLowerCase('en-US')))) continue;
          const digest = await sha256(raw);
          results.push(this.resultFor(snapshot, folderForSkillFile(entry.path), entry, metadata, digest));
        } catch (error) {
          if (error instanceof SourceCatalogError && error.code === 'SOURCE_TIMEOUT') throw error;
          // A malformed SKILL.md is not a resolvable source candidate.
        }
      }
    }
    return results;
  }

  private resultFor(
    snapshot: RepositorySnapshot,
    skillPath: string,
    entry: TreeEntry,
    metadata: SkillMetadata,
    contentDigest: `sha256:${string}`,
    externalId?: string,
  ): SourceSearchResult {
    const filePath = skillFilePathForFolder(skillPath);
    const canonicalExternalId = canonicalGithubExternalId(snapshot.repository, snapshot.resolvedCommit, skillPath);
    const sourceUrl = githubBlobUrl(snapshot.repository, snapshot.resolvedCommit, filePath);
    return {
      sourceId: this.id,
      externalId: externalId ?? canonicalExternalId,
      title: metadata.name,
      description: metadata.description,
      version: snapshot.resolvedCommit,
      sourceUrl,
      repository: snapshot.repository,
      path: skillPath,
      ref: snapshot.resolvedCommit,
      installable: true,
      sourceType: 'github',
      snapshotDigest: contentDigest,
      metadata: {
        githubRepository: snapshot.repository,
        githubSkillPath: skillPath,
        githubSkillFile: filePath,
        githubRequestedRef: snapshot.requestedRef,
        githubResolvedCommit: snapshot.resolvedCommit,
        githubTreeSha: snapshot.treeSha,
        githubBlobSha: entry.sha,
      },
    };
  }

  private async loadRepository(
    spec: NormalizedRepository,
    signal?: AbortSignal,
    context: GithubFetchContext = { signal, requests: 0 },
  ): Promise<RepositorySnapshot> {
    const metadata = await this.loadRepositoryMetadata(spec.repository, signal, context);
    const requestedRef = spec.ref ?? metadata.defaultBranch;
    const cacheKey = `${spec.repository.toLocaleLowerCase('en-US')}\u0000${requestedRef}`;
    const cached = this.snapshots.get(cacheKey);
    const now = this.cacheNow();
    if (cached && now - cached.fetchedAt <= SNAPSHOT_TTL_MS) return cached;
    if (cached) this.snapshots.delete(cacheKey);
    const commitPayload = await this.requestJson(
      `/repos/${repositoryPath(spec.repository)}/commits/${encodeURIComponent(requestedRef)}`,
      undefined,
      signal,
      undefined,
      MAX_RESPONSE_BYTES,
      context,
    );
    if (!isRecord(commitPayload) || !isSha(commitPayload.sha)) {
      throw sourceError('SOURCE_RESOLUTION_INVALID', 'GitHub commit response did not contain an immutable commit', false);
    }
    const resolvedCommit = commitPayload.sha.toLocaleLowerCase('en-US');
    const treePayload = await this.requestJson(
      `/repos/${repositoryPath(spec.repository)}/git/trees/${resolvedCommit}`,
      { recursive: '1' },
      signal,
      undefined,
      MAX_RESPONSE_BYTES,
      context,
    );
    if (!isRecord(treePayload) || treePayload.truncated !== false || !isSha(treePayload.sha) || !Array.isArray(treePayload.tree) || treePayload.tree.length > MAX_TREE_ENTRIES) {
      throw sourceError('SOURCE_RESOLUTION_INVALID', 'GitHub recursive tree was missing, truncated, or too large', false);
    }
    const entries: TreeEntry[] = [];
    for (const raw of treePayload.tree) {
      if (!isRecord(raw) || (raw.type !== 'blob' && raw.type !== 'tree') || typeof raw.path !== 'string' || !safeRelativePath(raw.path) || !isSha(raw.sha)) continue;
      const size = raw.size === undefined ? undefined : raw.size;
      if (size !== undefined && (!Number.isSafeInteger(size) || size < 0 || size > MAX_SKILL_FILE_BYTES)) continue;
      entries.push({ path: raw.path, type: raw.type, sha: raw.sha.toLocaleLowerCase('en-US'), ...(size === undefined ? {} : { size }) });
    }
    const snapshot: RepositorySnapshot = {
      repository: spec.repository,
      requestedRef,
      resolvedCommit,
      treeSha: treePayload.sha.toLocaleLowerCase('en-US'),
      entries,
      fetchedAt: now,
    };
    this.rememberSnapshot(cacheKey, snapshot);
    return snapshot;
  }

  private async loadRepositoryMetadata(repository: string, signal: AbortSignal | undefined, context: GithubFetchContext): Promise<RepositoryMetadata> {
    const cacheKey = repository.toLocaleLowerCase('en-US');
    const cached = this.repositoryMetadata.get(cacheKey);
    const now = this.cacheNow();
    if (cached && now - cached.fetchedAt <= SNAPSHOT_TTL_MS) return cached;
    if (cached) this.repositoryMetadata.delete(cacheKey);
    const payload = await this.requestJson(`/repos/${repositoryPath(repository)}`, undefined, signal, undefined, MAX_RESPONSE_BYTES, context);
    if (!isRecord(payload) || payload.private !== false || typeof payload.default_branch !== 'string' || !REF_RE.test(payload.default_branch)) {
      throw sourceError('SOURCE_RESOLUTION_INVALID', 'GitHub repository metadata did not prove a public default branch', false);
    }
    if (typeof payload.full_name === 'string' && payload.full_name.toLocaleLowerCase('en-US') !== repository.toLocaleLowerCase('en-US')) {
      throw sourceError('SOURCE_RESOLUTION_INVALID', 'GitHub repository identity changed during resolution', false);
    }
    const metadata: RepositoryMetadata = {
      repository,
      defaultBranch: payload.default_branch,
      fetchedAt: now,
    };
    this.rememberRepositoryMetadata(cacheKey, metadata);
    return metadata;
  }

  private async loadBlob(repository: string, sha: string, signal?: AbortSignal, context: GithubFetchContext = { signal, requests: 0 }): Promise<Uint8Array> {
    const payload = await this.requestJson(`/repos/${repositoryPath(repository)}/git/blobs/${sha}`, undefined, signal, undefined, MAX_RESPONSE_BYTES, context);
    if (!isRecord(payload)) throw sourceError('SOURCE_RESOLUTION_INVALID', 'GitHub blob response was not an object', false);
    const blob = payload as GithubBlobPayload;
    if (blob.encoding !== 'base64' || !isSha(blob.sha) || blob.sha.toLocaleLowerCase('en-US') !== sha.toLocaleLowerCase('en-US') || typeof blob.size !== 'number' || !Number.isSafeInteger(blob.size) || blob.size <= 0 || blob.size > MAX_SKILL_FILE_BYTES || typeof blob.content !== 'string') {
      throw sourceError('SOURCE_RESOLUTION_INVALID', 'GitHub blob response was not a bounded base64 blob', false);
    }
    const bytes = decodeBase64(blob.content);
    if (bytes.byteLength !== blob.size) throw sourceError('SOURCE_RESOLUTION_INVALID', 'GitHub blob size did not match its content', false);
    const computed = await gitSha1(blob.size, bytes);
    if (computed !== sha.toLocaleLowerCase('en-US')) throw sourceError('SOURCE_RESOLUTION_INVALID', 'GitHub blob content did not match its Git identity', false);
    return bytes;
  }

  private async requestJson(
    path: string,
    params: Record<string, string | number> | undefined,
    parentSignal: AbortSignal | undefined,
    token: string | undefined,
    maxBytes: number,
    context: GithubFetchContext,
  ): Promise<unknown> {
    if (++context.requests > MAX_REQUESTS_PER_SEARCH) throw sourceError('SOURCE_TIMEOUT', 'GitHub request budget exhausted', true);
    const url = new URL(path, GITHUB_API_ORIGIN);
    if (params) for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    if (url.origin !== GITHUB_API_ORIGIN || url.protocol !== 'https:') throw sourceError('SOURCE_ORIGIN_UNTRUSTED', 'GitHub request origin is not trusted', false);
    const request = requestSignal(parentSignal, this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
      };
      // The token is intentionally attached only to the code-search request.
      // Public repository/blob reads never inherit a private token.
      if (token !== undefined && path === '/search/code') headers.Authorization = `Bearer ${token}`;
      const response = await this.fetchImpl(url, { method: 'GET', headers, redirect: 'error', signal: request.signal });
      verifyResponseOrigin(response, GITHUB_API_ORIGIN);
      if (!response.ok) throw httpFailure(response.status, 'GitHub API request failed');
      const bytes = await readBounded(response, maxBytes);
      const mediaType = response.headers.get('content-type');
      if (mediaType !== null && !mediaType.toLocaleLowerCase('en-US').startsWith('application/json')) {
        throw sourceError('SOURCE_RESOLUTION_INVALID', 'GitHub API returned a non-JSON response', false);
      }
      let decoded: string;
      try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw sourceError('SOURCE_RESOLUTION_INVALID', 'GitHub API returned invalid UTF-8', false); }
      try { return JSON.parse(decoded) as unknown; } catch { throw sourceError('SOURCE_RESOLUTION_INVALID', 'GitHub API returned invalid JSON', false); }
    } catch (error) {
      if (error instanceof SourceCatalogError) throw error;
      if (request.signal.aborted || parentSignal?.aborted) throw sourceError('SOURCE_TIMEOUT', 'GitHub request timed out or was cancelled', true);
      throw sourceError('SOURCE_UNAVAILABLE', 'GitHub API request failed', true);
    } finally {
      request.dispose();
    }
  }

  private async readToken(signal?: AbortSignal): Promise<string | undefined> {
    let token: string | undefined;
    if (this.tokenProvider) {
      try { token = await this.tokenProvider(signal); } catch { return undefined; }
    }
    else token = this.token ?? this.env?.GITHUB_TOKEN ?? this.env?.GH_TOKEN;
    if (token === undefined || token === '') return undefined;
    if (token.length > 4_096 || /[\u0000-\u001f\u007f\r\n]/u.test(token)) return undefined;
    return token;
  }

  private clearSnapshots(repository: string): void {
    const prefix = `${repository.toLocaleLowerCase('en-US')}\u0000`;
    for (const key of this.snapshots.keys()) if (key.startsWith(prefix)) this.snapshots.delete(key);
    this.repositoryMetadata.delete(repository.toLocaleLowerCase('en-US'));
  }

  private hasConfiguredToken(): boolean {
    if (this.tokenProvider) return true;
    const token = this.token ?? this.env?.GITHUB_TOKEN ?? this.env?.GH_TOKEN;
    return typeof token === 'string' && token.length > 0 && token.length <= 4_096 && !/[\u0000-\u001f\u007f\r\n]/u.test(token);
  }

  private cacheNow(): number {
    const value = this.now().getTime();
    return Number.isFinite(value) ? value : Date.now();
  }

  private rememberSnapshot(key: string, value: RepositorySnapshot): void {
    if (this.snapshots.size >= MAX_SNAPSHOT_CACHE_ENTRIES && !this.snapshots.has(key)) {
      const oldest = [...this.snapshots.entries()].sort((left, right) => left[1].fetchedAt - right[1].fetchedAt)[0];
      if (oldest) this.snapshots.delete(oldest[0]);
    }
    this.snapshots.set(key, value);
  }

  private rememberRepositoryMetadata(key: string, value: RepositoryMetadata): void {
    if (this.repositoryMetadata.size >= MAX_REPOSITORY_METADATA_CACHE_ENTRIES && !this.repositoryMetadata.has(key)) {
      const oldest = [...this.repositoryMetadata.entries()].sort((left, right) => left[1].fetchedAt - right[1].fetchedAt)[0];
      if (oldest) this.repositoryMetadata.delete(oldest[0]);
    }
    this.repositoryMetadata.set(key, value);
  }
}

export function createGitHubSourceAdapters(options: Omit<GitHubSourceAdapterOptions, 'id' | 'repositories' | 'customRepositories'> & {
  repositories?: readonly (string | GitHubRepositorySpec)[];
  customRepositories?: readonly (string | GitHubRepositorySpec)[];
} = {}): readonly GitHubSourceAdapter[] {
  const common = { ...options };
  const codeSearch = new GitHubSourceAdapter({ ...common, id: 'github-code-search', label: 'GitHub public code search' });
  const builtIns = (Object.entries(BUILT_IN_GITHUB_REPOSITORIES) as Array<[SourceId, string]>).map(([id, repository]) => new GitHubSourceAdapter({
    ...common,
    id,
    label: builtInLabel(id),
    repositories: [repository],
  }));
  const custom = options.customRepositories ?? options.repositories;
  const customAdapter = new GitHubSourceAdapter({ ...common, id: 'github-custom', label: 'Configured GitHub repositories', repositories: custom ?? [] });
  return [codeSearch, ...builtIns, customAdapter];
}

/** Spelling alias retained for callers that use the provider's usual casing. */
export const createGithubSourceAdapters = createGitHubSourceAdapters;

function defaultRepositoriesForId(id: SourceId): readonly GitHubRepositorySpec[] {
  const builtIn = (BUILT_IN_GITHUB_REPOSITORIES as Readonly<Record<string, string>>)[id];
  if (builtIn) return [{ repository: builtIn }];
  return [];
}

function normalizeRepositories(value: readonly (string | GitHubRepositorySpec)[]): readonly NormalizedRepository[] {
  if (value.length > MAX_REPOSITORIES) throw new SourceCatalogError('SOURCE_UNAVAILABLE', 'GitHub source has too many configured repositories', 500);
  const seen = new Set<string>();
  const result: NormalizedRepository[] = [];
  for (const item of value) {
    const repository = typeof item === 'string' ? item : item?.repository;
    const ref = typeof item === 'string' ? undefined : item?.ref;
    if (typeof repository !== 'string' || !REPOSITORY_RE.test(repository) || repository.endsWith('.git')) throw new SourceCatalogError('SOURCE_UNAVAILABLE', 'GitHub repository configuration is invalid', 500);
    if (ref !== undefined && (typeof ref !== 'string' || !REF_RE.test(ref) || ref.includes('..'))) throw new SourceCatalogError('SOURCE_UNAVAILABLE', 'GitHub repository ref configuration is invalid', 500);
    const key = repository.toLocaleLowerCase('en-US');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ repository, ...(ref === undefined ? {} : { ref }) });
  }
  return result;
}

function parseCodeSearchLocation(value: unknown, repositories?: readonly NormalizedRepository[]): { repository: string; skillPath: string; blobSha: string } | undefined {
  if (!isRecord(value) || !isRecord(value.repository) || value.repository.private !== false || typeof value.repository.full_name !== 'string' || !REPOSITORY_RE.test(value.repository.full_name) || typeof value.path !== 'string' || !isSkillFilePath(value.path) || !isSha(value.sha)) return undefined;
  if (repositories !== undefined && !repositories.some((item) => item.repository.toLocaleLowerCase('en-US') === value.repository.full_name.toLocaleLowerCase('en-US'))) return undefined;
  if (typeof value.html_url === 'string') {
    try {
      const url = new URL(value.html_url);
      const parts = url.pathname.split('/').filter(Boolean);
      let htmlRef: string;
      let htmlPath: string;
      try {
        htmlRef = decodeURIComponent(parts[3] ?? '');
        htmlPath = parts.slice(4).map((part) => decodeURIComponent(part)).join('/');
      } catch { return undefined; }
      if (url.origin !== GITHUB_SOURCE_ORIGIN || url.search || url.hash || parts.length < 5 || parts[0] !== value.repository.full_name.split('/')[0] || parts[1] !== value.repository.full_name.split('/')[1] || parts[2] !== 'blob' || !REF_RE.test(htmlRef) || htmlPath !== value.path) return undefined;
    } catch { return undefined; }
  }
  return { repository: value.repository.full_name, skillPath: folderForSkillFile(value.path), blobSha: value.sha.toLocaleLowerCase('en-US') };
}

function parseGithubExternalId(value: string): ParsedGithubIdentity {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_024 || /[\u0000-\u001f\u007f]/u.test(value)) throw new SourceCatalogError('SOURCE_INVALID_EXTERNAL_ID', 'GitHub external id is invalid', 400);
  if (value.startsWith('http://') || value.startsWith('https://')) return parseGithubUrl(value);
  let body = value;
  if (body.startsWith('@github/')) body = body.slice('@github/'.length);
  else if (body.startsWith('github:')) body = body.slice('github:'.length);
  const hash = body.indexOf('#');
  const beforePath = hash >= 0 ? body.slice(0, hash) : body;
  const suppliedPath = hash >= 0 ? body.slice(hash + 1) : undefined;
  const slash = beforePath.indexOf('/');
  if (slash <= 0) throw new SourceCatalogError('SOURCE_INVALID_EXTERNAL_ID', 'GitHub external id must include owner/repository/path', 400);
  const secondSlash = beforePath.indexOf('/', slash + 1);
  let repositoryPart = secondSlash < 0 ? beforePath : beforePath.slice(0, secondSlash);
  let path = secondSlash < 0 ? suppliedPath : suppliedPath ?? beforePath.slice(secondSlash + 1);
  const at = repositoryPart.indexOf('@');
  const requestedRef = at < 0 ? undefined : repositoryPart.slice(at + 1);
  if (at >= 0) repositoryPart = repositoryPart.slice(0, at);
  if (!REPOSITORY_RE.test(repositoryPart) || (requestedRef !== undefined && !REF_RE.test(requestedRef))) throw new SourceCatalogError('SOURCE_INVALID_EXTERNAL_ID', 'GitHub external id repository or ref is invalid', 400);
  if (path === undefined || path === '') throw new SourceCatalogError('SOURCE_INVALID_EXTERNAL_ID', 'GitHub external id must select a skill path', 400);
  if (path.endsWith('/SKILL.md') || path === 'SKILL.md') path = folderForSkillFile(path);
  const skillPath = normalizeSkillFolder(path);
  return { repository: repositoryPart, skillPath, ...(requestedRef === undefined ? {} : { requestedRef }) };
}

function parseGithubUrl(value: string): ParsedGithubIdentity {
  let url: URL;
  try { url = new URL(value); } catch { throw new SourceCatalogError('SOURCE_INVALID_EXTERNAL_ID', 'GitHub external URL is invalid', 400); }
  if (url.origin !== GITHUB_SOURCE_ORIGIN || url.username || url.password || url.search || url.hash) throw new SourceCatalogError('SOURCE_INVALID_EXTERNAL_ID', 'GitHub external URL must use the fixed public origin', 400);
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 5 || (parts[2] !== 'tree' && parts[2] !== 'blob')) throw new SourceCatalogError('SOURCE_INVALID_EXTERNAL_ID', 'GitHub URL must select a tree or blob path', 400);
  const repository = `${parts[0]}/${parts[1]}`;
  const requestedRef = parts[3];
  if (!REPOSITORY_RE.test(repository) || !requestedRef || !REF_RE.test(requestedRef)) throw new SourceCatalogError('SOURCE_INVALID_EXTERNAL_ID', 'GitHub URL repository or ref is invalid', 400);
  const filePath = parts.slice(4).join('/');
  if (!isSkillFilePath(filePath) && !safeRelativePath(filePath)) throw new SourceCatalogError('SOURCE_INVALID_EXTERNAL_ID', 'GitHub URL skill path is invalid', 400);
  return { repository, skillPath: isSkillFilePath(filePath) ? folderForSkillFile(filePath) : normalizeSkillFolder(filePath), requestedRef };
}

function canonicalGithubExternalId(repository: string, commit: string, skillPath: string): string {
  return `github:${repository}@${commit}#${skillPath || 'SKILL.md'}`;
}

function githubBlobUrl(repository: string, commit: string, path: string): string {
  return `${GITHUB_SOURCE_ORIGIN}/${repository}/blob/${commit}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

function repositoryPath(repository: string): string {
  return repository.split('/').map(encodeURIComponent).join('/');
}

function skillFilePathForFolder(folder: string): string {
  return folder === '' ? 'SKILL.md' : `${folder}/SKILL.md`;
}

function folderForSkillFile(filePath: string): string {
  const slash = filePath.lastIndexOf('/');
  return slash < 0 ? '' : filePath.slice(0, slash);
}

function normalizeSkillFolder(value: string): string {
  if (value === '') return '';
  if (!safeRelativePath(value)) throw new SourceCatalogError('SOURCE_INVALID_EXTERNAL_ID', 'GitHub skill path is invalid', 400);
  return value;
}

function safeRelativePath(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096 || value.startsWith('/') || value.includes('\\') || value.includes('#') || value.includes('?')) return false;
  const parts = value.split('/');
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..' && SEGMENT_RE.test(part));
}

function isSkillFilePath(value: string): boolean {
  // Agent Skills uses the exact case-sensitive filename `SKILL.md`; accepting
  // another spelling would produce an acquisition the worker cannot select.
  return safeRelativePath(value) && value.split('/').at(-1) === 'SKILL.md';
}

function queryTerms(value: string): string[] {
  const terms = [...value.matchAll(/[A-Za-z0-9][A-Za-z0-9_.+#-]*/gu)].map((match) => match[0]!.toLocaleLowerCase('en-US'));
  const unique = [...new Set(terms)];
  if (unique.length === 0) throw new SourceCatalogError('SOURCE_INVALID_QUERY', 'GitHub search query must contain capability words', 400);
  return unique.slice(0, 32);
}

function normalizeQuery(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < 2 || value.length > MAX_QUERY_LENGTH || /[\u0000-\u001f\u007f]/u.test(value)) throw new SourceCatalogError('SOURCE_INVALID_QUERY', 'GitHub search query is invalid', 400, { source: 'github-code-search' });
  return value.trim();
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return 20;
  if (!Number.isSafeInteger(value) || value < 1) throw new SourceCatalogError('SOURCE_INVALID_QUERY', 'GitHub search limit must be a positive integer', 400);
  return Math.min(value, MAX_RESULTS);
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min) throw new SourceCatalogError('SOURCE_UNAVAILABLE', 'GitHub adapter bound is invalid', 500);
  return Math.min(value, max);
}

function pathScore(path: string, terms: readonly string[]): number {
  const lower = path.toLocaleLowerCase('en-US');
  return terms.reduce((score, term) => score + (lower.includes(term) ? 1 : 0), 0);
}

function builtInLabel(id: SourceId): string {
  if (id === 'github-openai-skills') return 'OpenAI skills';
  if (id === 'github-anthropics-skills') return 'Anthropic skills';
  if (id === 'github-google-skills') return 'Google skills';
  if (id === 'github-vercel-agent-skills') return 'Vercel agent skills';
  return 'GitHub skills';
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSha(value: unknown): value is string {
  return typeof value === 'string' && SHA1_RE.test(value);
}

function sourceError(code: 'SOURCE_RESOLUTION_INVALID' | 'SOURCE_TIMEOUT' | 'SOURCE_UNAVAILABLE' | 'SOURCE_ORIGIN_UNTRUSTED', message: string, retryable: boolean): SourceCatalogError {
  return new SourceCatalogError(code, message, code === 'SOURCE_TIMEOUT' ? 504 : code === 'SOURCE_ORIGIN_UNTRUSTED' ? 502 : 502, { retryable });
}

function httpFailure(status: number, message: string): SourceCatalogError {
  if (status === 401 || status === 403 || status === 429) return new SourceCatalogError('SOURCE_UNAVAILABLE', message, status, { retryable: status === 429 });
  if (status >= 500) return new SourceCatalogError('SOURCE_UNAVAILABLE', message, 502, { retryable: true });
  return new SourceCatalogError('SOURCE_RESOLUTION_INVALID', message, status === 404 ? 502 : 502);
}

function verifyResponseOrigin(response: Response, expected: string): void {
  const value = response.url;
  if (value === '') return;
  try {
    const url = new URL(value);
    if (url.origin !== expected || url.protocol !== 'https:') throw sourceError('SOURCE_ORIGIN_UNTRUSTED', 'GitHub response origin did not match the fixed API origin', false);
  } catch (error) {
    if (error instanceof SourceCatalogError) throw error;
    throw sourceError('SOURCE_ORIGIN_UNTRUSTED', 'GitHub response URL was invalid', false);
  }
}

async function readBounded(response: Response, maximum: number): Promise<Uint8Array> {
  const length = response.headers.get('content-length');
  if (length !== null && /^\d+$/u.test(length) && Number(length) > maximum) throw sourceError('SOURCE_RESOLUTION_INVALID', 'GitHub response exceeded its byte bound', false);
  if (response.body === null) {
    const raw = new Uint8Array(await response.arrayBuffer());
    if (raw.byteLength > maximum) throw sourceError('SOURCE_RESOLUTION_INVALID', 'GitHub response exceeded its byte bound', false);
    return raw;
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
        throw sourceError('SOURCE_RESOLUTION_INVALID', 'GitHub response exceeded its byte bound', false);
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
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

function decodeBase64(value: string): Uint8Array {
  const normalized = value.replace(/[\r\n\t ]/gu, '');
  if (normalized.length === 0 || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized)) throw sourceError('SOURCE_RESOLUTION_INVALID', 'GitHub blob base64 was invalid', false);
  try {
    const binary = globalThis.atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch { throw sourceError('SOURCE_RESOLUTION_INVALID', 'GitHub blob base64 was invalid', false); }
}

async function gitSha1(size: number, bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw sourceError('SOURCE_UNAVAILABLE', 'Web Crypto is unavailable for GitHub blob verification', true);
  // Web Crypto does not expose Git's `blob <size>\\0` framing directly, so
  // implement SHA-1 locally over the small bounded byte array. This remains
  // data-only verification and avoids a Node-only import in edge bundles.
  const prefix = new TextEncoder().encode(`blob ${size}\u0000`);
  const input = new Uint8Array(prefix.length + bytes.length);
  input.set(prefix);
  input.set(bytes, prefix.length);
  const digest = await subtle.digest('SHA-1', input.buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(bytes: Uint8Array): Promise<`sha256:${string}`> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw sourceError('SOURCE_UNAVAILABLE', 'Web Crypto is unavailable for GitHub content verification', true);
  const copy = bytes.slice();
  const digest = await subtle.digest('SHA-256', copy.buffer as ArrayBuffer);
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function parseSkillMetadata(bytes: Uint8Array): SkillMetadata {
  let markdown: string;
  try { markdown = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw sourceError('SOURCE_RESOLUTION_INVALID', 'GitHub SKILL.md was not valid UTF-8', false); }
  const lines = markdown.split(/\r?\n/u);
  if (lines[0]?.trim() !== '---') throw sourceError('SOURCE_RESOLUTION_INVALID', 'GitHub SKILL.md is missing frontmatter', false);
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0 || end > 200) throw sourceError('SOURCE_RESOLUTION_INVALID', 'GitHub SKILL.md frontmatter is malformed', false);
  const values = new Map<string, string>();
  for (let index = 1; index < end; index += 1) {
    const match = /^([A-Za-z][A-Za-z0-9_-]{0,63}):[ \t]*(.*)$/u.exec(lines[index]!);
    if (!match) continue;
    const key = match[1]!;
    const raw = match[2]!.trim();
    if (key !== 'name' && key !== 'description') continue;
    if (raw === '>' || raw === '>-' || raw === '|' || raw === '|-') {
      const block: string[] = [];
      for (let cursor = index + 1; cursor < end && (/^\s+/u.test(lines[cursor]!) || lines[cursor]!.trim() === ''); cursor += 1) block.push(lines[cursor]!.trim());
      values.set(key, block.join(raw.startsWith('>') ? ' ' : '\n').trim());
    } else {
      values.set(key, scalarText(raw));
    }
  }
  const name = values.get('name') ?? '';
  const description = values.get('description') ?? '';
  if (!NAME_RE.test(name) || name.length > 64 || description.length === 0 || description.length > 1_024 || /[\u0000-\u001f\u007f]/u.test(description)) throw sourceError('SOURCE_RESOLUTION_INVALID', 'GitHub SKILL.md frontmatter metadata is invalid', false);
  return { name, description };
}

function scalarText(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) return value.slice(1, -1).trim();
  if (/^(?:null|true|false|yes|no|on|off|~)$/iu.test(value) || /^[\[{!&*]/u.test(value) || /^[-+]?\d/u.test(value)) return '';
  return value.trim();
}
