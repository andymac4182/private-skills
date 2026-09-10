import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { gunzipSync, inflateRawSync } from 'node:zlib';

import type {
  ImportRequest,
  Job,
  Provenance,
  SkillBundle,
  Upstream,
} from '../../contracts/src/index.js';
import type {
  OpenClawFeedCompatibilityProfile,
  OpenClawFeedEntry,
  OpenClawNormalizedSource,
  OpenClawSha256,
} from '../../openclaw/src/types.js';
import {
  isReservedSkillsDirectoryHost,
  isValidSkillsShGatewayToken,
} from '../../directory/src/gateway.js';
import type { SkillsShGatewayCredential } from '../../directory/src/gateway.js';
import { BundleValidationError, parseSkillMetadata } from '../../storage/src/bundle.js';

export type { SkillsShGatewayCredential } from '../../directory/src/gateway.js';

/**
 * Limits applied while acquiring an upstream skill.  The limits are checked
 * before a response is retained and again after it has been decoded.  They
 * deliberately describe the expanded bundle rather than the request body
 * limit of a web handler.
 */
export interface AcquisitionLimits {
  /** Maximum number of files in the selected skill directory. */
  maxFiles: number;
  /** Maximum UTF-8/binary size of one file. */
  maxFileBytes: number;
  /** Maximum sum of all decoded file bytes. */
  maxExpandedBytes: number;
  /** Maximum UTF-8 path length in bytes. */
  maxPathBytes: number;
  /** Maximum bytes in a JSON/API response. */
  maxResponseBytes: number;
  /** Maximum bytes of one binary file before it is rejected. */
  maxBinaryBytes: number;
  /** Maximum total bytes retained across binary files. */
  maxBinaryTotalBytes: number;
  /** Maximum number of binary files in one selected directory. */
  maxBinaryFiles: number;
  /** Maximum redirects followed for one request. */
  maxRedirects: number;
  /** Maximum request attempts for retryable GETs. */
  maxAttempts: number;
  /** Maximum concurrent blob/transfer requests. */
  concurrency: number;
  /** Maximum request start rate for one source acquisition. */
  maxRequestsPerSecond: number;
  /** Per-request deadline. */
  requestTimeoutMs: number;
  /** Maximum proxy hops for registry-to-registry acquisition. */
  maxRegistryHops: number;
}

export const DEFAULT_ACQUISITION_LIMITS: Readonly<AcquisitionLimits> = {
  maxFiles: 2_000,
  maxFileBytes: 10 * 1024 * 1024,
  maxExpandedBytes: 100 * 1024 * 1024,
  maxPathBytes: 4_096,
  maxResponseBytes: 20 * 1024 * 1024,
  maxBinaryBytes: 10 * 1024 * 1024,
  maxBinaryTotalBytes: 100 * 1024 * 1024,
  maxBinaryFiles: 2_000,
  maxRedirects: 3,
  maxAttempts: 3,
  concurrency: 4,
  maxRequestsPerSecond: 64,
  requestTimeoutMs: 20_000,
  maxRegistryHops: 3,
};

type FetchHeaders = Record<string, string>;

/** A small fetch shape keeps the worker easy to test with an HTTP fixture. */
export type FetchLike = (
  input: string | URL,
  init?: {
    method?: string;
    headers?: FetchHeaders;
    body?: string;
    redirect?: 'manual' | 'follow' | 'error';
    signal?: AbortSignal;
  },
) => Promise<Response>;

export interface AcquireSkillOptions {
  /** Injected fetch for tests or a worker-specific fetch implementation. */
  fetchImpl?: FetchLike;
  /** Alias for fetchImpl used by small worker adapters. */
  fetch?: FetchLike;
  /** Override product limits for a worker profile or a bounded fixture. */
  limits?: Partial<AcquisitionLimits>;
  /** Explicitly permit loopback HTTP fixtures. Never enable for production. */
  allowLoopbackForTests?: boolean;
  /** Additional registry identities already traversed by the proxy chain. */
  registryChain?: string[];
  /** Current registry hop (zero for a direct source). */
  registryHop?: number;
  /** Optional cancellation signal supplied by the durable worker. */
  signal?: AbortSignal;
  /**
   * Resolve a fresh skills.sh catalog bearer token for this acquisition.
   * The callback is only consulted for the canonical https://skills.sh
   * catalog origin and is never used for source, artifact, or redirect
   * requests.  Callers should honor the supplied signal.
   */
  getSkillsShToken?: (signal?: AbortSignal) => Promise<string>;
  /**
   * Optional credential provider for one operator-configured skills.sh API
   * gateway.  The base URL is part of the credential binding: the provider is
   * invoked only when the normalized upstream base has the same origin and
   * pathname.  It is never a substitute for the canonical skills.sh OIDC
   * callback above.
   */
  skillsShGatewayCredential?: SkillsShGatewayCredential;
  /**
   * Credential providers for multiple operator-configured skills.sh API
   * gateways. Each provider is bound to one complete normalized origin and
   * pathname; an unmatched configured base is a terminal credential error.
   * The singular field remains for callers on the pre-multi-feed seam.
   */
  skillsShGatewayCredentials?: readonly SkillsShGatewayCredential[];
}

export interface AcquireSkillInput extends AcquireSkillOptions {
  job?: Job;
  upstream?: Upstream;
  importRequest?: ImportRequest;
  /** Alias accepted by callers that use the contracts field name. */
  import?: ImportRequest;
  /** Alias accepted by generic job dispatchers. */
  request?: ImportRequest;
  /** Optional nested options form used by job dispatchers. */
  options?: AcquireSkillOptions;
}

export interface AcquisitionResult {
  bundle: SkillBundle;
  provenance: Provenance;
}

/**
 * The source transport deliberately returns the bytes that were fetched.  It
 * does not return a display snapshot or a catalog URL, and the resolver below
 * never asks it to execute or interpret skill content.  A directory/core
 * adapter owns the actual HTTPS client and must use redirect:error, an
 * explicit source-origin allowlist, and no catalog credentials on source
 * requests.
 */
export interface OpenClawFetchedSource {
  bytes: Uint8Array;
  requestedUrl: string;
  finalUrl: string;
  status: number;
  redirected?: boolean;
  contentType?: string;
  /** Verified source identity origin, distinct from a codeload transport URL. */
  sourceProviderOrigin?: string;
}

export interface OpenClawSourceFetcher {
  fetch(
    source: OpenClawNormalizedSource,
    signal?: AbortSignal,
  ): Promise<OpenClawFetchedSource>;
}

/**
 * A deployment-owned source location. OpenClaw feed entries intentionally do
 * not contain registry URLs, so the caller must bind a selected candidate to
 * a configured artifact endpoint before the worker can fetch bytes.
 */
export interface OpenClawSourceLocation {
  url: string;
  allowedArtifactOrigins: readonly string[];
  sourceProviderOrigin: string;
}

/** Server-owned job extension placed alongside an import request. */
export interface OpenClawSourceFeedDescriptor {
  /** The exact feed identity selected by the server. */
  id: string;
  sequence: number;
  digest: OpenClawSha256;
  sourceUrl: string;
  /** Immutable producer timestamps used by delayed workers for freshness. */
  generatedAt?: string;
  expiresAt?: string;
  /** Set only for the server-selected, exact ClawHub compatibility profile. */
  compatibilityProfile?: OpenClawFeedCompatibilityProfile;
}

export interface OpenClawSourceJobDescriptor {
  source: OpenClawNormalizedSource;
  /** Server-owned feed entry retained for post-approval source-proof recording. */
  entry?: OpenClawFeedEntry;
  /** Server-owned snapshot identity/freshness bound to this import job. */
  feed?: OpenClawSourceFeedDescriptor;
}

export interface OpenClawSourceLocator {
  locate(
    source: OpenClawNormalizedSource,
    signal?: AbortSignal,
  ): OpenClawSourceLocation | Promise<OpenClawSourceLocation>;
}

export type OpenClawSourceKind = OpenClawNormalizedSource['kind'];

/**
 * Trusted transport settings for one public OpenClaw source family. The
 * artifact origin and the provider origin are intentionally separate: a
 * GitHub source is identified by github.com while its public archive bytes
 * are served by codeload.github.com.
 */
export interface OpenClawSourceTransportProfile {
  allowedArtifactOrigins: readonly string[];
  sourceProviderOrigin: string;
}

/**
 * Deployment-owned defaults for the two public OpenClaw source families.
 * The locator derives a URL only from an already normalized immutable source
 * identity; it does not accept a URL or origin from a feed entry or claimed
 * job.
 */
export interface DefaultOpenClawSourceConfiguration {
  locator: OpenClawSourceLocator;
  profiles: Readonly<Record<OpenClawSourceKind, OpenClawSourceTransportProfile>>;
}

export interface DefaultOpenClawSourceConfigurationOptions {
  /**
   * Operator-owned ClawHub API origin. The official default is
   * https://clawhub.ai and the fixed /api/v1/download route is used.
   */
  clawHubOrigin?: string;
}

export const DEFAULT_OPENCLAW_CLAWHUB_ORIGIN = 'https://clawhub.ai';
export const DEFAULT_OPENCLAW_GITHUB_SOURCE_ORIGIN = 'https://github.com';
export const DEFAULT_OPENCLAW_GITHUB_ARTIFACT_ORIGIN = 'https://codeload.github.com';

/**
 * Build the standard public source bindings once at worker construction.
 * ClawHub's documented v1 endpoint returns a deterministic hosted-skill ZIP
 * for /api/v1/download?slug=&version=. GitHub's public immutable archive is
 * addressed directly through codeload with the verified commit, avoiding the
 * GitHub API's 302 archive handoff. Both requests are anonymous and therefore
 * receive no catalog or OIDC credentials.
 */
export function createDefaultOpenClawSourceConfiguration(
  options: DefaultOpenClawSourceConfigurationOptions = {},
): DefaultOpenClawSourceConfiguration {
  const clawHubOrigin = normalizeOpenClawSourceProviderOrigin(
    options.clawHubOrigin ?? DEFAULT_OPENCLAW_CLAWHUB_ORIGIN,
  );
  const clawHubOrigins = Object.freeze([clawHubOrigin]);
  const githubSourceOrigin = DEFAULT_OPENCLAW_GITHUB_SOURCE_ORIGIN;
  const githubArtifactOrigins = Object.freeze([DEFAULT_OPENCLAW_GITHUB_ARTIFACT_ORIGIN]);
  const profiles = Object.freeze({
    'public-clawhub': Object.freeze({
      allowedArtifactOrigins: clawHubOrigins,
      sourceProviderOrigin: clawHubOrigin,
    }),
    'public-github': Object.freeze({
      allowedArtifactOrigins: githubArtifactOrigins,
      sourceProviderOrigin: githubSourceOrigin,
    }),
  });

  return {
    profiles,
    locator: {
      locate(source) {
        const record = asOpenClawSourceRecord(source);
        const kind = record.kind;
        const sourceRef = record.sourceRef;
        if (kind === 'public-clawhub' && sourceRef === 'public-clawhub') {
          const packageName = boundedDefaultSourceCoordinate(record.packageName);
          const version = boundedDefaultSourceCoordinate(record.version);
          if (typeof record.artifactDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(record.artifactDigest)) {
            throw new UpstreamAcquisitionError('invalid_source', 'OpenClaw ClawHub source integrity is invalid');
          }
          const { slug, ownerHandle } = parseDefaultClawHubPackage(packageName);
          const url = new URL('/api/v1/download', clawHubOrigin);
          url.searchParams.set('slug', slug);
          if (ownerHandle !== undefined) url.searchParams.set('ownerHandle', ownerHandle);
          url.searchParams.set('version', version);
          assertDefaultSourceURLSize(url);
          return {
            url: url.href,
            allowedArtifactOrigins: profiles['public-clawhub'].allowedArtifactOrigins,
            sourceProviderOrigin: profiles['public-clawhub'].sourceProviderOrigin,
          };
        }
        if (kind === 'public-github' && sourceRef === 'public-github') {
          const repo = validateDefaultGithubRepository(record.repo);
          validateDefaultGithubPath(record.path);
          const commit = validateDefaultGithubSha(record.commit, 40, 'commit');
          validateDefaultGithubSha(record.contentHash, 64, 'content hash');
          // Validate the selected path here even though it is not part of the
          // archive URL. This keeps malformed job identities from reaching a
          // source request or a later archive selector.
          const [owner, repository] = repo.split('/');
          const url = new URL(DEFAULT_OPENCLAW_GITHUB_ARTIFACT_ORIGIN);
          url.pathname = `/${encodeURIComponent(owner!)}/${encodeURIComponent(repository!)}/tar.gz/${commit}`;
          assertDefaultSourceURLSize(url);
          return {
            url: url.href,
            allowedArtifactOrigins: profiles['public-github'].allowedArtifactOrigins,
            sourceProviderOrigin: profiles['public-github'].sourceProviderOrigin,
          };
        }
        throw new UpstreamAcquisitionError('invalid_source', 'OpenClaw source identity is invalid');
      },
    },
  };
}

export interface OpenClawHttpFetcherOptions {
  locator: OpenClawSourceLocator;
  fetchImpl?: FetchLike;
  limits?: Partial<AcquisitionLimits>;
  allowLoopbackForTests?: boolean;
}

export interface OpenClawSourceAcquireInput {
  source: OpenClawNormalizedSource;
  fetcher: OpenClawSourceFetcher;
  /** Exact operator-approved origins for the source transport. */
  allowedArtifactOrigins: readonly string[];
  /** Verified source-provider origin (for example https://github.com). */
  sourceProviderOrigin?: string;
  upstreamId?: string;
  externalId?: string;
  externalSourceType?: 'github' | 'well-known';
  externalSnapshotHash?: string | null;
  limits?: Partial<AcquisitionLimits>;
  signal?: AbortSignal;
}

export interface OpenClawSourceResolution extends AcquisitionResult {
  source: OpenClawNormalizedSource;
  externalDigest: `sha256:${string}`;
}

/**
 * An acquisition failure carries a stable code for job/audit handling.  The
 * message intentionally contains source context but never credential values.
 */
export class UpstreamAcquisitionError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'UpstreamAcquisitionError';
    this.code = code;
    this.status = status;
  }
}

interface NormalizedInput {
  job?: Job;
  upstream: Upstream;
  importRequest: ImportRequest;
  options: AcquireSkillOptions;
}

interface NormalizedLimits extends AcquisitionLimits {}

interface GitTreeEntry {
  path?: unknown;
  mode?: unknown;
  type?: unknown;
  sha?: unknown;
  size?: unknown;
  url?: unknown;
}

interface GitHubTreeResponse {
  sha?: unknown;
  truncated?: unknown;
  tree?: unknown;
}

interface GitHubCommitResponse {
  sha?: unknown;
}

interface GitHubBlobResponse {
  content?: unknown;
  encoding?: unknown;
  size?: unknown;
  sha?: unknown;
}

interface SkillsShDetailResponse {
  id?: unknown;
  source?: unknown;
  slug?: unknown;
  name?: unknown;
  sourceType?: unknown;
  installUrl?: unknown;
  url?: unknown;
  hash?: unknown;
  snapshotHash?: unknown;
  files?: unknown;
  ref?: unknown;
}

/**
 * Presentation metadata is available on the skills.sh list/search shapes but
 * is intentionally absent from the documented detail response.  The worker
 * rehydrates only this narrow, source-identity-bearing subset when a detail
 * snapshot has no files and no source location.
 */
interface SkillsShCatalogMetadata {
  id: string;
  source: string;
  slug: string;
  name: string;
  sourceType: 'github' | 'well-known';
  installUrl: string | null;
}

interface SkillsShFile {
  path?: unknown;
  contents?: unknown;
  content?: unknown;
}

interface SkillsShResolutionMetadata {
  provider: 'skills.sh';
  externalId: string;
  source: string;
  slug: string;
  sourceType?: 'github' | 'well-known';
  /** Actual acquisition path, distinct from the catalog's reported sourceType. */
  sourceResolutionKind: 'snapshot' | 'github' | 'well-known';
  /** Trusted worker time when the selected source bytes were fetched. */
  fetchedAt: string;
  /** Verified source-provider origin; omitted when a custom resolver is opaque. */
  sourceProviderOrigin?: string;
  sourceUrl: string;
  pageUrl?: string;
  externalSnapshotHash: string | null;
  externalDigest?: string;
  repository?: string;
  skillPath?: string;
  requestedRef?: string;
  resolvedCommit?: string;
  resolvedTree?: string;
  wellKnownIndexUrl?: string;
  /** Name selected from the fetched discovery index, never inferred from catalog slug. */
  wellKnownEntryName?: string;
  artifactUrl?: string;
  frontmatterName?: string;
  frontmatterDescription?: string;
}

interface SkillsShTreeResponse extends GitHubTreeResponse {
  tree?: unknown;
}

interface SkillsShRepositoryResponse {
  default_branch?: unknown;
}

interface RegistryResolution {
  kind?: unknown;
  resourceId?: unknown;
  organizationId?: unknown;
  name?: unknown;
  version?: unknown;
  digest?: unknown;
  members?: unknown;
}

interface RegistryAuthorization {
  id?: unknown;
  expiresAt?: unknown;
  organizationId?: unknown;
  resolution?: unknown;
}

interface RegistryTransferDescriptor {
  mode?: unknown;
  url?: unknown;
  method?: unknown;
  headers?: unknown;
  expiresAt?: unknown;
  size?: unknown;
  digest?: unknown;
  rangeSupported?: unknown;
}

const DEFAULT_FETCH: FetchLike = (input, init) => globalThis.fetch(input, init);
const GITHUB_API_ORIGIN = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const SKILLS_SH_CANONICAL_ORIGIN = 'https://skills.sh';
const MAX_TOKEN_BYTES = 4_096;
const MAX_CHAIN_BYTES = 4_096;
const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;
const SKILLS_SH_METADATA_PAGE_SIZE = 500;
const SKILLS_SH_METADATA_SEARCH_LIMIT = 200;
const SKILLS_SH_METADATA_MAX_PAGES = 100;
const SKILLS_SH_METADATA_DEADLINE_MS = 30_000;
const RETRY_WAIT_MAX_MS = 1_000;

/**
 * Acquire a skill from an allowlisted GitHub repository or another private
 * registry.  The overloads make the worker call site ergonomic while keeping
 * the object form convenient for tests and job dispatchers.
 */
export function acquireSkill(
  input: AcquireSkillInput,
): Promise<AcquisitionResult>;
export function acquireSkill(
  job: Job,
  upstream: Upstream,
  importRequest: ImportRequest,
  options?: AcquireSkillOptions,
): Promise<AcquisitionResult>;
export async function acquireSkill(
  inputOrJob: AcquireSkillInput | Job,
  upstreamArg?: Upstream,
  importArg?: ImportRequest,
  optionsArg?: AcquireSkillOptions,
): Promise<AcquisitionResult> {
  const normalized = normalizeInput(
    inputOrJob,
    upstreamArg,
    importArg,
    optionsArg,
  );

  assertUpstreamEnabled(normalized.upstream);

  // The contracts package carries the skills.sh kind in the source branch
  // that owns the registry API.  Keep this adapter forward-compatible while
  // that shared union is rolled out across package boundaries.
  const upstreamKind = (normalized.upstream as unknown as { kind: string }).kind;
  switch (upstreamKind) {
    case 'github':
      return acquireGithub(normalized);
    case 'registry':
      return acquireRegistry(normalized);
    case 'skills-sh':
      return acquireSkillsSh(normalized);
    default:
      throw new UpstreamAcquisitionError(
        'unsupported_upstream',
        `Unsupported upstream kind ${String(normalized.upstream.kind)}`,
      );
  }
}

/** Explicit adapter export for worker code that dispatches by source kind. */
export async function acquireGithubSkill(
  input: AcquireSkillInput,
): Promise<AcquisitionResult> {
  const normalized = normalizeInput(input);
  if (normalized.upstream.kind !== 'github') {
    throw new UpstreamAcquisitionError(
      'upstream_kind_mismatch',
      'acquireGithubSkill requires a GitHub upstream',
    );
  }
  assertUpstreamEnabled(normalized.upstream);
  return acquireGithub(normalized);
}

/** Explicit adapter export for worker code that dispatches by source kind. */
export async function acquireRegistrySkill(
  input: AcquireSkillInput,
): Promise<AcquisitionResult> {
  const normalized = normalizeInput(input);
  if (normalized.upstream.kind !== 'registry') {
    throw new UpstreamAcquisitionError(
      'upstream_kind_mismatch',
      'acquireRegistrySkill requires a registry upstream',
    );
  }
  assertUpstreamEnabled(normalized.upstream);
  return acquireRegistry(normalized);
}

/** Explicit adapter export for the skills.sh catalog pullthrough worker. */
export async function acquireSkillsShSkill(
  input: AcquireSkillInput,
): Promise<AcquisitionResult> {
  const normalized = normalizeInput(input);
  if ((normalized.upstream as unknown as { kind?: unknown }).kind !== 'skills-sh') {
    throw new UpstreamAcquisitionError(
      'upstream_kind_mismatch',
      'acquireSkillsShSkill requires a skills.sh upstream',
    );
  }
  assertUpstreamEnabled(normalized.upstream);
  return acquireSkillsSh(normalized);
}

/** Validate a claimed OpenClaw source identity before any source request. */
export function validateOpenClawSourceIdentity(
  source: OpenClawNormalizedSource,
): OpenClawNormalizedSource {
  const record = asOpenClawSourceRecord(source);
  if (record.kind === 'public-clawhub' && record.sourceRef === 'public-clawhub') {
    const packageName = boundedDefaultSourceCoordinate(record.packageName);
    const version = boundedDefaultSourceCoordinate(record.version);
    if (typeof record.artifactDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(record.artifactDigest)) {
      throw new UpstreamAcquisitionError('invalid_source', 'OpenClaw ClawHub source integrity is invalid');
    }
    parseDefaultClawHubPackage(packageName);
    return {
      kind: 'public-clawhub',
      sourceRef: 'public-clawhub',
      packageName,
      version,
      artifactDigest: record.artifactDigest,
    };
  }
  if (record.kind === 'public-github' && record.sourceRef === 'public-github') {
    const repo = validateDefaultGithubRepository(record.repo);
    const path = validateDefaultGithubPath(record.path);
    const commit = validateDefaultGithubSha(record.commit, 40, 'commit');
    const contentHash = validateDefaultGithubSha(record.contentHash, 64, 'content hash');
    return {
      kind: 'public-github',
      sourceRef: 'public-github',
      repo,
      path,
      commit,
      contentHash,
    };
  }
  throw new UpstreamAcquisitionError('invalid_source', 'OpenClaw source identity is invalid');
}

/**
 * Resolve one explicit OpenClaw feed candidate into the canonical worker
 * bundle.  Feed normalization is intentionally separate from this function:
 * callers must choose a candidate, and this function is the only operation
 * that asks a source adapter for bytes.  A metadata/feed refresh therefore
 * cannot accidentally become an install or scan fetch.
 */
export async function acquireOpenClawSource(
  input: OpenClawSourceAcquireInput,
): Promise<OpenClawSourceResolution> {
  const limits = mergeLimits(input.limits);
  const allowedOrigins = normalizeOpenClawArtifactOrigins(input.allowedArtifactOrigins);
  const source = validateOpenClawSourceIdentity(input.source);
  if (input.signal?.aborted) {
    throw new UpstreamAcquisitionError('cancelled', 'OpenClaw source acquisition cancelled');
  }
  const fetched = await input.fetcher.fetch(source, input.signal);
  const fetchedAt = sourceFetchedAt();
  const transport = validateOpenClawFetchedSource(fetched, allowedOrigins, limits);
  const sourceProviderOrigin = normalizeOpenClawSourceProviderOrigin(
    input.sourceProviderOrigin ?? fetched.sourceProviderOrigin,
  );
  if (source.kind === 'public-clawhub') {
    const bundle = resolveOpenClawHostedArtifact(transport, source.artifactDigest, limits);
    const sourceDigest = digestBytes(serializeSkillBundle(bundle));
    return {
      source,
      externalDigest: source.artifactDigest as `sha256:${string}`,
      bundle,
      provenance: {
        kind: 'registry',
        ...(input.upstreamId === undefined ? {} : { upstreamId: input.upstreamId }),
        // Core's import contract binds repository/path to the selected
        // upstream. For a hosted ClawHub artifact the provider origin is the
        // repository identity and the package coordinate is the exact path;
        // the artifact CDN URL remains separate source transport evidence.
        repository: sourceProviderOrigin,
        path: source.packageName,
        revision: source.version,
        sourceDigest,
        externalId: input.externalId ?? source.packageName,
        externalSnapshotHash: input.externalSnapshotHash,
        externalDigest: source.artifactDigest as `sha256:${string}`,
        sourceUrl: transport.finalUrl,
        sourceProviderOrigin,
        sourceResolutionKind: 'snapshot',
        fetchedAt,
      },
    };
  }

  const resolved = resolveOpenClawGithubArchive(transport, source, limits);
  const sourceDigest = digestBytes(serializeSkillBundle(resolved.bundle));
  return {
    source,
    externalDigest: `sha256:${source.contentHash}`,
    bundle: resolved.bundle,
    provenance: {
      kind: 'github',
      ...(input.upstreamId === undefined ? {} : { upstreamId: input.upstreamId }),
      repository: source.repo,
      // Preserve an explicitly verified repository root path.  An empty path
      // means the repository root and must not be rewritten as "unknown".
      path: source.path,
      revision: source.commit,
      sourceDigest,
      externalId: input.externalId ?? `${source.repo}/${source.path}`,
      externalSourceType: input.externalSourceType,
      externalSnapshotHash: input.externalSnapshotHash,
      sourceUrl: transport.finalUrl,
      sourceProviderOrigin,
      sourceResolutionKind: 'github',
      fetchedAt,
      resolvedCommit: source.commit,
      externalDigest: `sha256:${source.contentHash}`,
    },
  };
}

/** Alias with the source-layer name used by directory adapters. */
export const resolveOpenClawSource = acquireOpenClawSource;

/**
 * Build the production Node-side fetcher used by a worker. The locator is
 * deployment-owned and must map an already selected feed source to an
 * operator-configured endpoint; this function never invents a ClawHub route
 * from package metadata. Every request uses the existing bounded HTTP client,
 * DNS/SSRF checks, manual redirects, and no credential headers.
 */
export function createOpenClawHttpFetcher(
  options: OpenClawHttpFetcherOptions,
): OpenClawSourceFetcher {
  if (!options || typeof options.locator?.locate !== 'function') {
    throw new UpstreamAcquisitionError('invalid_source', 'OpenClaw source locator is not configured');
  }
  const limits = mergeLimits(options.limits);
  const fetchImpl = options.fetchImpl ?? DEFAULT_FETCH;
  return {
    async fetch(source, signal): Promise<OpenClawFetchedSource> {
      if (signal?.aborted) throw new UpstreamAcquisitionError('cancelled', 'OpenClaw source acquisition cancelled');
      const location = await options.locator.locate(source, signal);
      const allowedOrigins = normalizeOpenClawArtifactOrigins(location.allowedArtifactOrigins);
      const url = validateOpenClawTransportURL(location.url, allowedOrigins, options.allowLoopbackForTests ?? false);
      const sourceProviderOrigin = normalizeOpenClawSourceProviderOrigin(location.sourceProviderOrigin);
      const clientOptions: AcquireSkillOptions = {
        fetchImpl,
        limits,
        ...(options.allowLoopbackForTests === undefined ? {} : { allowLoopbackForTests: options.allowLoopbackForTests }),
        ...(signal === undefined ? {} : { signal }),
      };
      const client = new HttpClient(fetchImpl, limits, clientOptions, url.origin);
      const response = await client.bytes(url, {
        headers: {
          accept: 'application/octet-stream, application/gzip, application/zip, application/json',
          'user-agent': 'private-skills-openclaw-worker/0.1',
        },
        retryable: false,
        signal,
        rejectRedirects: true,
      });
      return {
        bytes: response.bytes,
        requestedUrl: url.href,
        finalUrl: url.href,
        status: response.response.status,
        redirected: false,
        contentType: response.response.headers.get('content-type') ?? undefined,
        sourceProviderOrigin,
      };
    },
  };
}

function assertUpstreamEnabled(upstream: Upstream): void {
  if (upstream.enabled === false) {
    throw new UpstreamAcquisitionError(
      'upstream_disabled',
      `Upstream ${safeId(upstream.id)} is disabled`,
    );
  }
}

/**
 * Validate and canonicalize a bundle received from a registry.  This is also
 * used for GitHub output so both sources have exactly the same file/path
 * safety guarantees before they reach scanners or storage.
 */
export function validateSkillBundle(
  candidate: unknown,
  limitsInput?: Partial<AcquisitionLimits>,
): SkillBundle {
  const limits = mergeLimits(limitsInput);
  if (!isRecord(candidate) || candidate.format !== 'pskills-bundle-v1') {
    throw new UpstreamAcquisitionError(
      'invalid_bundle',
      'Upstream payload is not a pskills-bundle-v1 object',
    );
  }
  if (Object.keys(candidate).some((key) => key !== 'format' && key !== 'files')) {
    throw new UpstreamAcquisitionError('invalid_bundle', 'Upstream bundle contains unsupported properties');
  }
  if (!Array.isArray(candidate.files)) {
    throw new UpstreamAcquisitionError(
      'invalid_bundle',
      'Upstream bundle files must be an array',
    );
  }
  if (candidate.files.length > limits.maxFiles) {
    throw new UpstreamAcquisitionError(
      'file_count_limit',
      `Bundle contains more than ${limits.maxFiles} files`,
    );
  }

  const files: Array<{ path: string; content: string; executable?: boolean }> = [];
  const seen = new Set<string>();
  const seenNormalized = new Map<string, string>();
  let expandedBytes = 0;
  let binaryBytes = 0;
  let binaryFiles = 0;

  for (const rawFile of candidate.files) {
    if (!isRecord(rawFile) || typeof rawFile.path !== 'string') {
      throw new UpstreamAcquisitionError(
        'invalid_bundle',
        'Every bundle file requires a string path',
      );
    }
    if (Object.keys(rawFile).some((key) => key !== 'path' && key !== 'content' && key !== 'executable')) {
      throw new UpstreamAcquisitionError('invalid_bundle', 'Upstream bundle file contains unsupported properties');
    }
    const path = validateSkillPath(rawFile.path, limits);
    const pathKey = path.normalize('NFC').toLocaleLowerCase('en-US');
    const prior = seenNormalized.get(pathKey);
    if (prior !== undefined || seen.has(path)) {
      throw new UpstreamAcquisitionError(
        'path_collision',
        `Bundle contains colliding paths ${JSON.stringify(prior ?? path)} and ${JSON.stringify(path)}`,
      );
    }
    seen.add(path);
    seenNormalized.set(pathKey, path);

    if (typeof rawFile.content !== 'string' || !isCanonicalBase64(rawFile.content)) {
      throw new UpstreamAcquisitionError(
        'binary_file',
        `Bundle file ${JSON.stringify(path)} is not canonical base64`,
      );
    }
    const bytes = Buffer.from(rawFile.content, 'base64');
    if (bytes.length > limits.maxFileBytes) {
      throw new UpstreamAcquisitionError(
        'file_size_limit',
        `Bundle file ${JSON.stringify(path)} exceeds the per-file limit`,
      );
    }
    expandedBytes += bytes.length;
    if (expandedBytes > limits.maxExpandedBytes) {
      throw new UpstreamAcquisitionError(
        'expanded_size_limit',
        `Bundle exceeds the expanded size limit of ${limits.maxExpandedBytes} bytes`,
      );
    }
    if (isBinaryBytes(bytes)) {
      binaryFiles += 1;
      binaryBytes += bytes.length;
      if (binaryFiles > limits.maxBinaryFiles) {
        throw new UpstreamAcquisitionError('binary_file_limit', `Bundle contains more than ${limits.maxBinaryFiles} binary files`);
      }
      if (bytes.length > limits.maxBinaryBytes || binaryBytes > limits.maxBinaryTotalBytes) {
        throw new UpstreamAcquisitionError('binary_size_limit', `Bundle exceeds its binary file limits`);
      }
      if (path === 'SKILL.md') {
        throw new UpstreamAcquisitionError('binary_file', 'Root SKILL.md must be valid UTF-8 text');
      }
    }

    let executable = false;
    if (rawFile.executable !== undefined) {
      if (typeof rawFile.executable !== 'boolean') {
        throw new UpstreamAcquisitionError(
          'invalid_bundle',
          `Bundle file ${JSON.stringify(path)} has an invalid executable flag`,
        );
      }
      executable = rawFile.executable;
    }
    // `false` is the transport default.  Omitting it keeps the acquisition
    // digest identical to the storage canonical encoder.
    files.push(executable ? { path, content: rawFile.content, executable: true } : { path, content: rawFile.content });
  }

  if (!files.some((file) => file.path === 'SKILL.md')) {
    throw new UpstreamAcquisitionError(
      'missing_skill_file',
      'Selected directory does not contain a root SKILL.md',
    );
  }

  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return { format: 'pskills-bundle-v1', files };
}

/** Return the deterministic bytes used for provenance/source digest checks. */
export function serializeSkillBundle(bundle: SkillBundle): Uint8Array {
  const normalized = validateSkillBundle(bundle);
  return new TextEncoder().encode(JSON.stringify(normalized));
}

function normalizeInput(
  inputOrJob: AcquireSkillInput | Job,
  upstreamArg?: Upstream,
  importArg?: ImportRequest,
  optionsArg?: AcquireSkillOptions,
): NormalizedInput {
  if (upstreamArg !== undefined || importArg !== undefined) {
    const job = inputOrJob as Job;
    if (upstreamArg === undefined || importArg === undefined) {
      throw new UpstreamAcquisitionError(
        'invalid_arguments',
        'The positional form requires job, upstream, and import request',
      );
    }
    assertInputBindings(job, upstreamArg, importArg);
    return { job, upstream: upstreamArg, importRequest: importArg, options: optionsArg ?? {} };
  }

  const input = inputOrJob as AcquireSkillInput;
  const job = input.job;
  const upstream = input.upstream ?? job?.upstream;
  const importRequest = input.importRequest ?? input.import ?? input.request ?? job?.import;
  if (!upstream || !importRequest) {
    throw new UpstreamAcquisitionError(
      'invalid_arguments',
      'acquireSkill requires an upstream and import request',
    );
  }
  assertInputBindings(job, upstream, importRequest);

  const {
    job: _ignoredJob,
    upstream: _ignoredUpstream,
    importRequest: _ignoredImportRequest,
    import: _ignoredImport,
    fetchImpl,
    fetch,
    limits,
    allowLoopbackForTests,
    registryChain,
    registryHop,
    signal,
    getSkillsShToken,
    skillsShGatewayCredential,
    skillsShGatewayCredentials,
    options: nestedOptions,
  } = input;
  const mergedOptions: AcquireSkillOptions = {
    ...(nestedOptions ?? {}),
    fetchImpl: fetchImpl ?? fetch ?? nestedOptions?.fetchImpl ?? nestedOptions?.fetch,
    fetch: fetch ?? nestedOptions?.fetch,
    limits: limits ?? nestedOptions?.limits,
    allowLoopbackForTests: allowLoopbackForTests ?? nestedOptions?.allowLoopbackForTests,
    registryChain: registryChain ?? nestedOptions?.registryChain,
    registryHop: registryHop ?? nestedOptions?.registryHop,
    signal: signal ?? nestedOptions?.signal,
    getSkillsShToken: getSkillsShToken ?? nestedOptions?.getSkillsShToken,
    skillsShGatewayCredential: skillsShGatewayCredential ?? nestedOptions?.skillsShGatewayCredential,
    skillsShGatewayCredentials: skillsShGatewayCredentials ?? nestedOptions?.skillsShGatewayCredentials,
  };
  return {
    job,
    upstream,
    importRequest,
    options: mergedOptions,
  };
}

function assertInputBindings(job: Job | undefined, upstream: Upstream, importRequest: ImportRequest): void {
  if (importRequest.upstreamId !== upstream.id) {
    throw new UpstreamAcquisitionError(
      'invalid_arguments',
      'Import request does not belong to the selected upstream',
    );
  }
  if (job && (job.organizationId !== upstream.organizationId || (job.import !== undefined && job.import.upstreamId !== upstream.id))) {
    throw new UpstreamAcquisitionError(
      'invalid_arguments',
      'Job and upstream organization/source bindings do not match',
    );
  }
}

async function acquireGithub(input: NormalizedInput): Promise<AcquisitionResult> {
  const { upstream, importRequest, options } = input;
  const limits = mergeLimits(options.limits);
  const repository = normalizeRepository(importRequest.repository, upstream.repositories);
  const selectedPath = validateSourceDirectory(importRequest.path, limits);
  const apiBase = normalizeGithubApiBase(upstream.baseUrl, options.allowLoopbackForTests);
  const credential = credentialHeader(upstream, 'github');
  const fetchImpl = options.fetchImpl ?? options.fetch ?? DEFAULT_FETCH;
  const client = new HttpClient(fetchImpl, limits, options, apiBase.origin);
  const headers: FetchHeaders = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': GITHUB_API_VERSION,
    'user-agent': 'private-skills/0.1',
  };
  if (credential) headers.authorization = credential;

  const commitRef = validateRef(importRequest.ref);
  const commitURL = appendApiPath(apiBase, [
    'repos',
    repository.split('/')[0],
    repository.split('/')[1],
    'commits',
    commitRef,
  ]);
  const commit = await client.json<GitHubCommitResponse>(commitURL, {
    headers,
    allowedOrigin: apiBase.origin,
  });
  const revision = requireSha(commit.sha, 'GitHub commit response');

  const treeURL = appendApiPath(apiBase, [
    'repos',
    repository.split('/')[0],
    repository.split('/')[1],
    'git',
    'trees',
    revision,
  ], { recursive: '1' });
  const treeResponse = await client.json<GitHubTreeResponse>(treeURL, {
    headers,
    allowedOrigin: apiBase.origin,
  });
  if (treeResponse.truncated === true) {
    throw new UpstreamAcquisitionError(
      'tree_truncated',
      `GitHub tree for ${repository}@${revision} was truncated`,
    );
  }
  if (treeResponse.truncated !== false) {
    throw new UpstreamAcquisitionError('invalid_source', 'GitHub tree response has an invalid truncated flag');
  }
  if (treeResponse.sha !== undefined && treeResponse.sha !== revision) {
    throw new UpstreamAcquisitionError('digest_mismatch', 'GitHub tree response is not pinned to the resolved commit');
  }
  if (!Array.isArray(treeResponse.tree)) {
    throw new UpstreamAcquisitionError('invalid_source', 'GitHub tree response has no tree array');
  }

  const entries = selectTreeEntries(treeResponse.tree as unknown[], selectedPath, limits);
  if (entries.length === 0) {
    throw new UpstreamAcquisitionError(
      'source_not_found',
      `No files found at ${selectedPath || '/'} in ${repository}@${revision}`,
      404,
    );
  }
  if (entries.length > limits.maxFiles) {
    throw new UpstreamAcquisitionError(
      'file_count_limit',
      `Selected directory contains more than ${limits.maxFiles} files`,
    );
  }
  // GitHub includes blob sizes in recursive tree entries.  Reject a source
  // whose declared expanded size is already over the bundle limit before
  // starting any blob requests; the post-fetch check below still protects
  // against a source that lies about those declarations.
  let declaredExpandedBytes = 0;
  for (const entry of entries) {
    if (typeof entry.size === 'number') {
      declaredExpandedBytes += entry.size;
      if (declaredExpandedBytes > limits.maxExpandedBytes) {
        throw new UpstreamAcquisitionError(
          'expanded_size_limit',
          `Selected directory exceeds the expanded size limit of ${limits.maxExpandedBytes} bytes`,
        );
      }
    }
  }

  const blobs = await mapWithConcurrency(entries, limits.concurrency, async (entry) => {
    const sha = requireSha(entry.sha, `GitHub tree entry ${entry.path}`);
    const declaredSize = entry.size;
    if (declaredSize !== undefined && (typeof declaredSize !== 'number' || !Number.isSafeInteger(declaredSize) || declaredSize < 0)) {
      throw new UpstreamAcquisitionError('invalid_source', `Invalid size for GitHub file ${entry.path}`);
    }
    if (typeof declaredSize === 'number' && declaredSize > limits.maxFileBytes) {
      throw new UpstreamAcquisitionError(
        'file_size_limit',
        `GitHub file ${JSON.stringify(entry.path)} exceeds the per-file limit`,
      );
    }
    const blobURL = appendApiPath(apiBase, [
      'repos',
      repository.split('/')[0],
      repository.split('/')[1],
      'git',
      'blobs',
      sha,
    ]);
    const blob = await client.json<GitHubBlobResponse>(blobURL, {
      headers,
      allowedOrigin: apiBase.origin,
    });
    return decodeGithubBlob(blob, entry, limits);
  });
  const fetchedAt = sourceFetchedAt();

  let expandedBytes = 0;
  const bundleCandidate = {
    format: 'pskills-bundle-v1' as const,
    files: blobs.map((blob) => {
      expandedBytes += blob.bytes.length;
      if (expandedBytes > limits.maxExpandedBytes) {
        throw new UpstreamAcquisitionError(
          'expanded_size_limit',
          `Selected directory exceeds the expanded size limit of ${limits.maxExpandedBytes} bytes`,
        );
      }
      return {
        path: blob.path,
        content: blob.content,
        ...(blob.executable === undefined ? {} : { executable: blob.executable }),
      };
    }),
  };
  const bundle = validateSkillBundle(bundleCandidate, limits);
  const sourceDigest = digestBytes(serializeSkillBundle(bundle));
  return {
    bundle,
    provenance: {
      kind: 'github',
      upstreamId: upstream.id,
      repository,
      ...(selectedPath ? { path: selectedPath } : {}),
      revision,
      sourceDigest,
      fetchedAt,
    },
  };
}

/**
 * Pull a selected skills.sh catalog row through the server-side adapter.
 *
 * The catalog API is only an identity/metadata source.  A non-null detail
 * snapshot is preferred; otherwise the worker resolves the advertised public
 * source and applies the same immutable, bounded, non-executing acquisition
 * rules as administrator-configured upstreams.  The skills.sh credential (if
 * configured) is used only for the catalog API and is never forwarded to
 * GitHub or a well-known source.
 */
async function acquireSkillsSh(input: NormalizedInput): Promise<AcquisitionResult> {
  const { upstream, importRequest, options } = input;
  const limits = mergeLimits(options.limits);
  const externalId = validateSkillsShId(importRequest.path);
  const upstreamRecord = upstream as unknown as Record<string, unknown>;
  if (!Array.isArray(upstream.repositories) || upstream.repositories.length === 0 || upstream.repositories.some((candidate) => typeof candidate !== 'string' || candidate.trim() === '')) {
    throw new UpstreamAcquisitionError('repository_denied', 'skills.sh upstream has no valid source allowlist');
  }
  if (importRequest.repository !== undefined && typeof importRequest.repository !== 'string') {
    throw new UpstreamAcquisitionError('invalid_source', 'skills.sh import repository is invalid');
  }
  const apiBase = normalizeSkillsShBase(
    typeof upstreamRecord.baseUrl === 'string' ? upstreamRecord.baseUrl : undefined,
    options.allowLoopbackForTests,
  );
  const fetchImpl = options.fetchImpl ?? options.fetch ?? DEFAULT_FETCH;
  const client = new HttpClient(fetchImpl, limits, options, apiBase.origin);
  const headers: FetchHeaders = {
    accept: 'application/json',
    'user-agent': 'private-skills/0.1',
  };
  const credential = await skillsShCatalogCredential(upstream, apiBase, options, limits.requestTimeoutMs);
  if (credential) headers.authorization = credential;

  const detailURL = appendSkillsShDetailPath(apiBase, externalId);
  const detailValue = await client.json<SkillsShDetailResponse>(detailURL, {
    headers,
    allowedOrigin: apiBase.origin,
    retryable: false,
    stripCredentialsOnRedirect: true,
  });
  const importSourceType = (importRequest as unknown as { externalSourceType?: unknown }).externalSourceType;
  if (importSourceType !== undefined && importSourceType !== 'github' && importSourceType !== 'well-known') {
    throw new UpstreamAcquisitionError('invalid_source', 'skills.sh import source type is invalid');
  }
  let detail = parseSkillsShDetail(
    detailValue,
    externalId,
    importSourceType,
  );
  const requestedExternalId = (importRequest as unknown as { externalId?: unknown }).externalId;
  if (requestedExternalId !== undefined && requestedExternalId !== externalId) {
    throw new UpstreamAcquisitionError(
      'identity_mismatch',
      'skills.sh import externalId does not match its path',
    );
  }
  const requestedSnapshotHash = (importRequest as unknown as { externalSnapshotHash?: unknown }).externalSnapshotHash;
  if (requestedSnapshotHash !== undefined && requestedSnapshotHash !== detail.externalSnapshotHash) {
    throw new UpstreamAcquisitionError('source_changed', 'skills.sh snapshot hash changed since the import request');
  }
  // Check the administrator's source allowlist before any additional catalog
  // metadata lookup.  The list/search response only supplies presentation
  // metadata; it cannot broaden the selected mapping.
  assertSkillsShSourceAllowed(upstream, detail.source, importRequest.repository);
  // The documented detail response omits presentation metadata.  A
  // well-known files:null row therefore needs one authenticated list/search
  // lookup to recover its source location.  Explicit operator mapping remains
  // authoritative and avoids this lookup; GitHub rows can resolve from their
  // repository identity without an install URL.
  if (
    detail.files === null &&
    detail.sourceType === 'well-known' &&
    detail.installUrl === null &&
    !hasConfiguredWellKnownSource(detail, upstreamRecord) &&
    !(isGithubCandidateSource(detail.source) && typeof upstreamRecord.githubApiBaseUrl === 'string' && upstreamRecord.githubApiBaseUrl.trim() !== '')
  ) {
    detail = await hydrateSkillsShSourceMetadata({
      client,
      apiBase,
      headers,
      detail,
      limits,
      signal: options.signal,
    });
  }
  const pageUrl = detail.pageUrl ?? `https://skills.sh/${externalId}`;
  const sourceUrl = detail.installUrl ?? pageUrl;

  if (detail.files !== null) {
    const fetchedAt = sourceFetchedAt();
    const snapshot = bundleFromSnapshotFiles(detail.files, limits);
    const frontmatter = readSkillFrontmatter(snapshot);
    assertFrontmatterIdentity(frontmatter, detail);
    const digest = digestBytes(serializeSkillBundle(snapshot));
    return {
      bundle: snapshot,
      provenance: skillsShProvenance(upstream, detail, {
        sourceResolutionKind: 'snapshot',
        sourceUrl,
        pageUrl,
        externalSnapshotHash: detail.externalSnapshotHash,
        fetchedAt,
        frontmatterName: frontmatter.name,
        frontmatterDescription: frontmatter.description,
        sourceDigest: digest,
      }),
    };
  }

  if (detail.sourceType === 'github') {
    const github = await acquireSkillsShGithub({
      upstream,
      importRequest,
      options,
      detail,
      limits,
    });
    const frontmatter = readSkillFrontmatter(github.bundle);
    return {
      bundle: github.bundle,
      provenance: skillsShProvenance(upstream, detail, {
        sourceResolutionKind: 'github',
        ...(github.sourceProviderOrigin === undefined ? {} : { sourceProviderOrigin: github.sourceProviderOrigin }),
        sourceUrl,
        pageUrl,
        externalSnapshotHash: detail.externalSnapshotHash,
        fetchedAt: github.fetchedAt,
        repository: github.repository,
        skillPath: github.skillPath,
        requestedRef: github.requestedRef,
        resolvedCommit: github.resolvedCommit,
        resolvedTree: github.resolvedTree,
        revision: detail.externalSnapshotHash ?? github.resolvedCommit,
        frontmatterName: frontmatter.name,
        frontmatterDescription: frontmatter.description,
        sourceDigest: digestBytes(serializeSkillBundle(github.bundle)),
      }),
    };
  }

  if (detail.sourceType !== 'well-known') {
    throw new UpstreamAcquisitionError('source_unavailable', 'skills.sh detail has no verified sourceType for source fallback');
  }
  // Some catalog rows currently report a repository-shaped source with the
  // well-known type (for example googleworkspace/cli).  There is no safe DNS
  // origin to derive from such a value.  A narrowly gated GitHub candidate
  // resolver is allowed for an owner/repository identity whose owner cannot
  // be a hostname, and it still has to verify the exact frontmatter/path.
  // Keep the reported sourceType as well-known in provenance for auditability.
  if (isGithubCandidateSource(detail.source) && !hasConfiguredWellKnownSource(detail, upstreamRecord)) {
    const github = await acquireSkillsShGithub({
      upstream,
      importRequest,
      options,
      detail,
      limits,
    });
    const frontmatter = readSkillFrontmatter(github.bundle);
    return {
      bundle: github.bundle,
      provenance: skillsShProvenance(upstream, detail, {
        sourceResolutionKind: 'github',
        ...(github.sourceProviderOrigin === undefined ? {} : { sourceProviderOrigin: github.sourceProviderOrigin }),
        sourceUrl,
        pageUrl,
        externalSnapshotHash: detail.externalSnapshotHash,
        fetchedAt: github.fetchedAt,
        repository: github.repository,
        skillPath: github.skillPath,
        requestedRef: github.requestedRef,
        resolvedCommit: github.resolvedCommit,
        resolvedTree: github.resolvedTree,
        revision: detail.externalSnapshotHash ?? github.resolvedCommit,
        frontmatterName: frontmatter.name,
        frontmatterDescription: frontmatter.description,
        sourceDigest: digestBytes(serializeSkillBundle(github.bundle)),
      }),
    };
  }
  const wellKnown = await acquireSkillsShWellKnown({
    upstream,
    importRequest,
    options,
    detail,
    limits,
  });
  const frontmatter = readSkillFrontmatter(wellKnown.bundle);
  return {
    bundle: wellKnown.bundle,
    provenance: skillsShProvenance(upstream, detail, {
      sourceResolutionKind: 'well-known',
      sourceProviderOrigin: wellKnown.sourceProviderOrigin,
      sourceUrl,
      pageUrl,
      externalSnapshotHash: detail.externalSnapshotHash,
      fetchedAt: wellKnown.fetchedAt,
      externalDigest: wellKnown.externalDigest,
      wellKnownIndexUrl: wellKnown.indexUrl,
      wellKnownEntryName: wellKnown.wellKnownEntryName,
      artifactUrl: wellKnown.artifactUrl,
      revision: detail.externalSnapshotHash ?? wellKnown.externalDigest,
      frontmatterName: frontmatter.name,
      frontmatterDescription: frontmatter.description,
      sourceDigest: digestBytes(serializeSkillBundle(wellKnown.bundle)),
    }),
  };
}

interface SkillsShCatalogMetadataPage {
  rows: SkillsShCatalogMetadata[];
  hasMore?: boolean;
  page?: number;
}

/**
 * Rehydrate a missing well-known source location from authenticated catalog
 * metadata.  The matching identity is checked in full before its install URL
 * is used.  Search is preferred; the list walk is deliberately bounded and
 * never downloads source files.
 */
async function hydrateSkillsShSourceMetadata(args: {
  client: HttpClient;
  apiBase: URL;
  headers: FetchHeaders;
  detail: ParsedSkillsShDetail;
  limits: AcquisitionLimits;
  signal?: AbortSignal;
}): Promise<ParsedSkillsShDetail> {
  const { client, apiBase, headers, detail, limits, signal: parentSignal } = args;
  const deadline = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onParentAbort: (() => void) | undefined;
  if (parentSignal?.aborted) {
    throw new UpstreamAcquisitionError('cancelled', 'Upstream acquisition cancelled');
  }
  if (parentSignal) {
    onParentAbort = () => deadline.abort(parentSignal.reason);
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }
  timer = setTimeout(
    () => deadline.abort(),
    Math.min(SKILLS_SH_METADATA_DEADLINE_MS, limits.requestTimeoutMs),
  );
  try {
    const metadata = await discoverSkillsShMetadata(client, apiBase, headers, detail, limits, deadline.signal);
    if (metadata.sourceType !== detail.sourceType) {
      throw new UpstreamAcquisitionError(
        'identity_mismatch',
        'skills.sh catalog source type changed between detail and metadata',
      );
    }
    if (detail.installUrl !== null && metadata.installUrl !== detail.installUrl) {
      throw new UpstreamAcquisitionError(
        'source_changed',
        'skills.sh catalog install URL changed between detail and metadata',
      );
    }
    return {
      ...detail,
      // A null install URL retains the existing safe hostname-root behavior for
      // host-shaped sources. Repository-shaped well-known sources still fail
      // closed in normalizeWellKnownSourceBase because they have no safe origin.
      installUrl: detail.installUrl ?? metadata.installUrl,
    };
  } catch (error) {
    if (deadline.signal.aborted && !parentSignal?.aborted) {
      throw new UpstreamAcquisitionError('metadata_timeout', 'skills.sh catalog metadata lookup timed out');
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onParentAbort !== undefined) parentSignal?.removeEventListener('abort', onParentAbort);
  }
}

async function discoverSkillsShMetadata(
  client: HttpClient,
  apiBase: URL,
  headers: FetchHeaders,
  detail: ParsedSkillsShDetail,
  limits: AcquisitionLimits,
  signal: AbortSignal,
): Promise<SkillsShCatalogMetadata> {
  if ([...detail.slug].length >= 2) {
    try {
      const value = await client.json<unknown>(appendApiPath(apiBase, ['api', 'v1', 'skills', 'search'], {
        q: detail.slug,
        limit: String(SKILLS_SH_METADATA_SEARCH_LIMIT),
      }), {
        headers,
        allowedOrigin: apiBase.origin,
        retryable: false,
        signal,
        stripCredentialsOnRedirect: true,
      });
      const page = parseSkillsShCatalogMetadataPage(value, limits, false);
      const match = selectSkillsShMetadata(page.rows, detail);
      if (match) return match;
    } catch (error) {
      if (!isCatalogNotFound(error)) throw error;
    }
  }

  for (let pageNumber = 0; pageNumber < SKILLS_SH_METADATA_MAX_PAGES; pageNumber += 1) {
    let value: unknown;
    try {
      value = await client.json<unknown>(appendApiPath(apiBase, ['api', 'v1', 'skills'], {
        view: 'all-time',
        page: String(pageNumber),
        per_page: String(SKILLS_SH_METADATA_PAGE_SIZE),
      }), {
        headers,
        allowedOrigin: apiBase.origin,
        retryable: false,
        signal,
        stripCredentialsOnRedirect: true,
      });
    } catch (error) {
      if (isCatalogNotFound(error)) break;
      throw error;
    }
    const parsed = parseSkillsShCatalogMetadataPage(value, limits, true);
    if (parsed.page !== pageNumber) {
      throw new UpstreamAcquisitionError('invalid_response', 'skills.sh catalog metadata page is inconsistent');
    }
    const match = selectSkillsShMetadata(parsed.rows, detail);
    if (match) return match;
    if (!parsed.hasMore) break;
  }
  throw new UpstreamAcquisitionError(
    'source_unavailable',
    'skills.sh catalog has no exact source metadata for this skill',
  );
}

function parseSkillsShCatalogMetadataPage(
  value: unknown,
  limits: AcquisitionLimits,
  withPagination: boolean,
): SkillsShCatalogMetadataPage {
  const maxRows = withPagination ? SKILLS_SH_METADATA_PAGE_SIZE : SKILLS_SH_METADATA_SEARCH_LIMIT;
  if (!isRecord(value) || !Array.isArray(value.data) || value.data.length > maxRows) {
    throw new UpstreamAcquisitionError('invalid_response', 'skills.sh catalog metadata response is invalid');
  }
  const rows = value.data.map((entry: unknown, index: number) => parseSkillsShCatalogMetadata(entry, limits, `skills.sh metadata row ${index}`));
  if (!withPagination) return { rows };
  if (!isRecord(value.pagination) ||
    !Number.isSafeInteger(value.pagination.page) || value.pagination.page < 0 ||
    !Number.isSafeInteger(value.pagination.perPage) || value.pagination.perPage < 1 || value.pagination.perPage > SKILLS_SH_METADATA_PAGE_SIZE ||
    !Number.isSafeInteger(value.pagination.total) || value.pagination.total < 0 ||
    typeof value.pagination.hasMore !== 'boolean') {
    throw new UpstreamAcquisitionError('invalid_response', 'skills.sh catalog pagination is invalid');
  }
  return {
    rows,
    page: value.pagination.page,
    hasMore: value.pagination.hasMore,
  };
}

function parseSkillsShCatalogMetadata(
  value: unknown,
  _limits: AcquisitionLimits,
  context: string,
): SkillsShCatalogMetadata {
  if (!isRecord(value)) throw new UpstreamAcquisitionError('invalid_response', `${context} is invalid`);
  const id = requireSkillsShString(value.id, `${context}.id`, 2_048);
  const source = requireSkillsShString(value.source, `${context}.source`, 2_048);
  const slug = requireSkillsShString(value.slug, `${context}.slug`, 2_048);
  if (validateSkillsShId(id) !== id || id !== `${source}/${slug}`) {
    throw new UpstreamAcquisitionError('identity_mismatch', `${context} identity is inconsistent`);
  }
  const name = requireSkillsShString(value.name, `${context}.name`, 512);
  const sourceType = value.sourceType;
  if (sourceType !== 'github' && sourceType !== 'well-known') {
    throw new UpstreamAcquisitionError('invalid_response', `${context}.sourceType is invalid`);
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'installUrl')) {
    throw new UpstreamAcquisitionError('invalid_response', `${context}.installUrl is missing`);
  }
  const installUrl = value.installUrl === null
    ? null
    : requireSkillsShURL(value.installUrl, `${context}.installUrl`);
  return { id, source, slug, name, sourceType, installUrl };
}

function selectSkillsShMetadata(
  rows: readonly SkillsShCatalogMetadata[],
  detail: ParsedSkillsShDetail,
): SkillsShCatalogMetadata | undefined {
  const matches = rows.filter((row) =>
    row.id === detail.externalId &&
    row.source === detail.source &&
    row.slug === detail.slug &&
    row.id === `${row.source}/${row.slug}`,
  );
  if (matches.length > 1) {
    throw new UpstreamAcquisitionError('ambiguous_source', 'skills.sh catalog metadata contains duplicate source identities');
  }
  return matches[0];
}

function isCatalogNotFound(error: unknown): boolean {
  return error instanceof UpstreamAcquisitionError && (error.status === 404 || error.status === 410);
}

function isGithubCandidateSource(source: string): boolean {
  try {
    const repository = normalizeRepositoryIdentity(source);
    return !repository.split('/')[0]!.includes('.');
  } catch {
    return false;
  }
}

function hasConfiguredWellKnownSource(detail: ParsedSkillsShDetail, upstream: Record<string, unknown>): boolean {
  if (typeof upstream.wellKnownBaseUrl === 'string' && upstream.wellKnownBaseUrl.trim() !== '') return true;
  if (!detail.installUrl) return false;
  try {
    const install = new URL(detail.installUrl);
    return install.hostname !== 'skills.sh' && install.hostname !== 'www.skills.sh' && install.hostname !== 'github.com';
  } catch {
    return false;
  }
}

function assertSkillsShSourceAllowed(upstream: Upstream, source: string, requestedRepository?: string): void {
  const allowlist = upstream.repositories;
  if (!allowlist || allowlist.length === 0) {
    throw new UpstreamAcquisitionError('repository_denied', 'skills.sh upstream has no source allowlist');
  }
  if (requestedRepository !== undefined && normalizeSkillsShSource(requestedRepository) !== normalizeSkillsShSource(source)) {
    throw new UpstreamAcquisitionError('identity_mismatch', 'skills.sh detail source does not match the requested source mapping');
  }
  const normalized = normalizeSkillsShSource(source);
  if (!allowlist.some((candidate) => candidate.trim() === '*' || normalizeSkillsShSource(candidate) === normalized)) {
    throw new UpstreamAcquisitionError('repository_denied', `skills.sh source ${safeId(source)} is not allowlisted`);
  }
}

function normalizeSkillsShSource(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/^https?:\/\/(?:www\.)?skills\.sh\//u, '')
    .replace(/^https?:\/\/(?:www\.)?github\.com\//u, '')
    .replace(/^github\.com\//u, '')
    .replace(/^\/+|\/+$/gu, '')
    .replace(/\.git$/iu, '');
}

interface ParsedSkillsShDetail {
  externalId: string;
  source: string;
  slug: string;
  name: string;
  sourceType?: 'github' | 'well-known';
  installUrl: string | null;
  pageUrl?: string;
  externalSnapshotHash: string | null;
  files: SkillsShFile[] | null;
  ref?: string;
}

function parseSkillsShDetail(
  value: unknown,
  requestedId: string,
  sourceTypeHint?: 'github' | 'well-known',
): ParsedSkillsShDetail {
  if (!isRecord(value)) {
    throw new UpstreamAcquisitionError('invalid_source', 'skills.sh detail response is not an object');
  }
  const id = requireSkillsShString(value.id, 'skills.sh detail id', 2_048);
  const source = requireSkillsShString(value.source, 'skills.sh detail source', 2_048);
  const slug = requireSkillsShString(value.slug, 'skills.sh detail slug', 2_048);
  const name = value.name === undefined || value.name === null
    ? slug
    : requireSkillsShString(value.name, 'skills.sh detail name', 512);
  const sourceType = value.sourceType ?? sourceTypeHint;
  if (sourceType !== undefined && sourceType !== 'github' && sourceType !== 'well-known') {
    throw new UpstreamAcquisitionError('unsupported_source', 'skills.sh detail has an unsupported sourceType');
  }
  const canonicalId = validateSkillsShId(`${source}/${slug}`);
  if (canonicalId !== requestedId || id !== requestedId) {
    throw new UpstreamAcquisitionError('identity_mismatch', 'skills.sh detail identity does not match the requested source/slug');
  }
  const files = value.files;
  if (files === undefined) {
    throw new UpstreamAcquisitionError('invalid_source', 'skills.sh detail omitted files');
  }
  if (files !== null && !Array.isArray(files)) {
    throw new UpstreamAcquisitionError('invalid_source', 'skills.sh detail files must be an array or null');
  }
  if (files === null && sourceType === undefined) {
    throw new UpstreamAcquisitionError('source_unavailable', 'skills.sh detail has no verified sourceType for source fallback');
  }
  const installUrl = value.installUrl === null || value.installUrl === undefined
    ? null
    : requireSkillsShURL(value.installUrl, 'skills.sh installUrl');
  const pageUrl = value.url === null || value.url === undefined
    ? undefined
    : requireSkillsShURL(value.url, 'skills.sh page URL', true);
  const hasHash = Object.prototype.hasOwnProperty.call(value, 'hash');
  const hasSnapshotHash = Object.prototype.hasOwnProperty.call(value, 'snapshotHash');
  if (!hasHash && !hasSnapshotHash) {
    throw new UpstreamAcquisitionError('invalid_source', 'skills.sh detail omitted its snapshot hash');
  }
  if (hasHash && hasSnapshotHash && value.hash !== undefined && value.snapshotHash !== undefined && value.hash !== value.snapshotHash) {
    throw new UpstreamAcquisitionError('identity_mismatch', 'skills.sh detail contains conflicting snapshot hashes');
  }
  const hashValue = hasHash ? value.hash : value.snapshotHash;
  const externalSnapshotHash = hashValue === null || hashValue === undefined
    ? null
    : requireSkillsShString(hashValue, 'skills.sh snapshot hash', 512);
  const ref = value.ref === undefined ? undefined : validateRef(requireSkillsShString(value.ref, 'skills.sh detail ref', 256));
  return {
    externalId: requestedId,
    source,
    slug,
    name,
    sourceType,
    installUrl,
    ...(pageUrl === undefined ? {} : { pageUrl }),
    externalSnapshotHash,
    files: files === null ? null : files.map((file: unknown) => parseSkillsShFile(file)),
    ...(ref === undefined ? {} : { ref }),
  };
}

function parseSkillsShFile(value: unknown): SkillsShFile {
  if (!isRecord(value)) {
    throw new UpstreamAcquisitionError('invalid_source', 'skills.sh detail contains a malformed file');
  }
  if (typeof value.path !== 'string' || value.path.length === 0 || value.path.length > 4_096) {
    throw new UpstreamAcquisitionError('invalid_path', 'skills.sh detail contains an invalid file path');
  }
  const contents = value.contents ?? value.content;
  if (typeof contents !== 'string' || contents.length > DEFAULT_ACQUISITION_LIMITS.maxFileBytes * 2) {
    throw new UpstreamAcquisitionError('invalid_source', `skills.sh file ${JSON.stringify(value.path)} is not bounded text`);
  }
  return { path: value.path, contents };
}

function skillsShProvenance(
  upstream: Upstream,
  detail: ParsedSkillsShDetail,
  values: Omit<SkillsShResolutionMetadata, 'provider' | 'externalId' | 'source' | 'slug' | 'sourceType' | 'sourceResolutionKind' | 'externalSnapshotHash'> & {
    sourceResolutionKind: SkillsShResolutionMetadata['sourceResolutionKind'];
    sourceUrl: string;
    pageUrl?: string;
    externalSnapshotHash: string | null;
    fetchedAt: string;
    sourceDigest: `sha256:${string}`;
    revision?: string;
  },
): Provenance {
  const fetchedAt = validateSourceFetchedAt(values.fetchedAt);
  const resolution: SkillsShResolutionMetadata = {
    provider: 'skills.sh',
    externalId: detail.externalId,
    source: detail.source,
    slug: detail.slug,
    ...(detail.sourceType === undefined ? {} : { sourceType: detail.sourceType }),
    sourceResolutionKind: values.sourceResolutionKind,
    fetchedAt,
    ...(values.sourceProviderOrigin === undefined ? {} : { sourceProviderOrigin: values.sourceProviderOrigin }),
    sourceUrl: values.sourceUrl,
    ...(values.pageUrl === undefined ? {} : { pageUrl: values.pageUrl }),
    externalSnapshotHash: values.externalSnapshotHash,
    ...(values.externalDigest === undefined ? {} : { externalDigest: values.externalDigest }),
    ...(values.repository === undefined ? {} : { repository: values.repository }),
    // The root repository skill has an empty relative directory. Preserve the
    // empty value so a verified root source remains distinguishable from a
    // resolver that never established a physical path. Core validates this
    // only for a GitHub resolution with immutable commit/origin evidence.
    ...(values.skillPath === undefined ? {} : { skillPath: values.skillPath }),
    ...(values.requestedRef === undefined ? {} : { requestedRef: values.requestedRef }),
    ...(values.resolvedCommit === undefined ? {} : { resolvedCommit: values.resolvedCommit }),
    ...(values.resolvedTree === undefined ? {} : { resolvedTree: values.resolvedTree }),
    ...(values.wellKnownIndexUrl === undefined ? {} : { wellKnownIndexUrl: values.wellKnownIndexUrl }),
    ...(values.wellKnownEntryName === undefined ? {} : { wellKnownEntryName: values.wellKnownEntryName }),
    ...(values.artifactUrl === undefined ? {} : { artifactUrl: values.artifactUrl }),
    ...(values.frontmatterName === undefined ? {} : { frontmatterName: values.frontmatterName }),
    ...(values.frontmatterDescription === undefined ? {} : { frontmatterDescription: values.frontmatterDescription }),
  };
  // Keep both the flat fields and, when the source type is verified, a grouped
  // copy.  A detail snapshot can legitimately omit sourceType; emitting a
  // nested object with an undefined required field would be malformed after
  // JSON serialization and would fail the completion contract.
  const revision = values.revision ?? values.externalSnapshotHash ?? values.externalDigest ?? values.sourceDigest;
  return {
    kind: 'skills-sh',
    upstreamId: upstream.id,
    repository: values.repository ?? detail.source,
    path: detail.externalId,
    revision,
    sourceDigest: values.sourceDigest,
    externalId: detail.externalId,
    externalSourceType: detail.sourceType,
    externalSnapshotHash: values.externalSnapshotHash,
    ...(resolution as unknown as Record<string, unknown>),
    ...(detail.sourceType === undefined ? {} : { external: resolution }),
  } as unknown as Provenance;
}

const MAX_SOURCE_FETCHED_AT_BYTES = 64;

/** Stamp source evidence only from the trusted worker clock. */
function sourceFetchedAt(): string {
  return validateSourceFetchedAt(new Date().toISOString());
}

/** Keep persisted external fetch times bounded and in canonical ISO form. */
function validateSourceFetchedAt(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SOURCE_FETCHED_AT_BYTES) {
    throw new UpstreamAcquisitionError('invalid_source', 'Source fetchedAt is invalid');
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new UpstreamAcquisitionError('invalid_source', 'Source fetchedAt is invalid');
  }
  return value;
}

function bundleFromSnapshotFiles(files: SkillsShFile[], limits: AcquisitionLimits): SkillBundle {
  if (files.length === 0) {
    throw new UpstreamAcquisitionError('source_not_found', 'skills.sh detail snapshot contains no files');
  }
  return bundleFromRawFiles(files.map((file) => ({ path: String(file.path), bytes: new TextEncoder().encode(String(file.contents)) })), limits);
}

function bundleFromRawFiles(
  files: Array<{ path: string; bytes: Uint8Array; executable?: boolean }>,
  limits: AcquisitionLimits,
): SkillBundle {
  if (files.length > limits.maxFiles) {
    throw new UpstreamAcquisitionError('file_count_limit', `Selected source contains more than ${limits.maxFiles} files`);
  }
  const normalized = files.map((file) => ({
    ...file,
    path: validateSkillPath(file.path, limits, false),
  }));
  const skillPaths = normalized.filter((file) => file.path.toLocaleLowerCase('en-US').split('/').at(-1) === 'skill.md');
  if (skillPaths.length !== 1) {
    throw new UpstreamAcquisitionError(skillPaths.length === 0 ? 'missing_skill_file' : 'ambiguous_source', 'Selected source must contain exactly one SKILL.md');
  }
  const skillPath = skillPaths[0]!.path;
  const slash = skillPath.lastIndexOf('/');
  const prefix = slash < 0 ? '' : skillPath.slice(0, slash);
  const selected = normalized.map((file) => {
    if (prefix) {
      if (file.path !== prefix && !file.path.startsWith(`${prefix}/`)) {
        throw new UpstreamAcquisitionError('invalid_source', 'Selected source contains files outside its SKILL.md directory');
      }
      const relative = file.path === prefix ? '' : file.path.slice(prefix.length + 1);
      if (!relative) throw new UpstreamAcquisitionError('invalid_path', 'Selected source contains a directory entry');
      return { ...file, path: relative };
    }
    return file;
  });
  const candidate = {
    format: 'pskills-bundle-v1' as const,
    files: selected.map((file) => ({
      path: file.path,
      content: Buffer.from(file.bytes).toString('base64'),
      ...(file.executable === true ? { executable: true } : {}),
    })),
  };
  return validateSkillBundle(candidate, limits);
}

function readSkillFrontmatter(bundle: SkillBundle): { name: string; description: string } {
  try {
    const metadata = parseSkillMetadata(bundle);
    return { name: metadata.skillName, description: metadata.description };
  } catch {
    // Keep the storage parser as the single frontmatter implementation.  Its
    // detailed error can contain source-specific context; acquisition only
    // needs a stable, non-content-bearing rejection code.
    throw new UpstreamAcquisitionError('invalid_frontmatter', 'SKILL.md metadata is invalid');
  }
}

function readOpenClawFrontmatter(bundle: SkillBundle): { name: string; description: string } {
  try {
    const metadata = parseSkillMetadata(bundle);
    return { name: metadata.skillName, description: metadata.description };
  } catch (error) {
    // Keep storage's parser as the single frontmatter implementation. Its
    // detailed error can contain source context; acquisition only needs a
    // stable, non-content-bearing rejection code.
    const code = error instanceof BundleValidationError && error.code === 'unsafe_frontmatter'
      ? 'unsafe_frontmatter'
      : 'invalid_frontmatter';
    throw new UpstreamAcquisitionError(code, 'SKILL.md metadata is invalid');
  }
}

function assertFrontmatterIdentity(
  frontmatter: { name: string; description: string },
  detail: ParsedSkillsShDetail,
): void {
  const allowed = new Set([detail.name, detail.slug].map((value) => value.toLocaleLowerCase('en-US')));
  if (!allowed.has(frontmatter.name.toLocaleLowerCase('en-US'))) {
    throw new UpstreamAcquisitionError('identity_mismatch', 'SKILL.md frontmatter does not match the skills.sh catalog row');
  }
}

interface SkillsShGithubResult {
  bundle: SkillBundle;
  fetchedAt: string;
  repository: string;
  skillPath: string;
  requestedRef: string;
  resolvedCommit: string;
  resolvedTree: string;
  sourceProviderOrigin?: string;
}

async function acquireSkillsShGithub(args: {
  upstream: Upstream;
  importRequest: ImportRequest;
  options: AcquireSkillOptions;
  detail: ParsedSkillsShDetail;
  limits: AcquisitionLimits;
}): Promise<SkillsShGithubResult> {
  const { upstream, importRequest, detail, limits, options } = args;
  const upstreamRecord = upstream as unknown as Record<string, unknown>;
  const installHint = parseGithubInstallHint(detail.installUrl);
  const repository = parseSkillsShGithubRepository(detail.source, installHint?.repository);
  const configuredBase = typeof upstreamRecord.githubApiBaseUrl === 'string'
    ? upstreamRecord.githubApiBaseUrl
    : undefined;
  const apiBase = normalizeGithubApiBase(configuredBase, options.allowLoopbackForTests);
  const sourceProviderOrigin = resolveGithubSourceProviderOrigin(
    upstreamRecord,
    apiBase,
    options.allowLoopbackForTests ?? false,
  );
  const fetchImpl = options.fetchImpl ?? options.fetch ?? DEFAULT_FETCH;
  const client = new HttpClient(fetchImpl, limits, options, apiBase.origin);
  const headers: FetchHeaders = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': GITHUB_API_VERSION,
    'user-agent': 'private-skills/0.1',
  };
  const requestedSnapshotHash = (importRequest as unknown as { externalSnapshotHash?: unknown }).externalSnapshotHash;
  // The core includes the detail snapshot hash in `ref` for compatibility
  // with generic imports.  A skills.sh snapshot identifier is not a Git ref;
  // only an independently supplied ref may select the GitHub branch/tag.
  const importedRef = typeof importRequest.ref === 'string' && importRequest.ref !== requestedSnapshotHash
    ? importRequest.ref
    : undefined;
  const explicitRef = importedRef ?? detail.ref ?? installHint?.ref;
  let requestedRef = explicitRef;
  if (!requestedRef) {
    const repositoryResponse = await client.json<SkillsShRepositoryResponse>(appendApiPath(apiBase, [
      'repos', repository.split('/')[0]!, repository.split('/')[1]!,
    ]), { headers, allowedOrigin: apiBase.origin, retryable: false });
    requestedRef = requireSkillsShString(repositoryResponse.default_branch, 'GitHub default branch', 256);
  }
  requestedRef = validateRef(requestedRef);
  const commitResponse = await client.json<GitHubCommitResponse>(appendApiPath(apiBase, [
    'repos', repository.split('/')[0]!, repository.split('/')[1]!, 'commits', requestedRef,
  ]), { headers, allowedOrigin: apiBase.origin });
  const resolvedCommit = requireSha(commitResponse.sha, 'GitHub commit response');
  const treeResponse = await client.json<SkillsShTreeResponse>(appendApiPath(apiBase, [
    'repos', repository.split('/')[0]!, repository.split('/')[1]!, 'git', 'trees', resolvedCommit,
  ], { recursive: '1' }), { headers, allowedOrigin: apiBase.origin });
  if (treeResponse.truncated !== false || !Array.isArray(treeResponse.tree)) {
    throw new UpstreamAcquisitionError(treeResponse.truncated === true ? 'tree_truncated' : 'invalid_source', 'GitHub recursive tree is unavailable or truncated');
  }
  const candidates = treeResponse.tree.filter((raw): raw is Record<string, unknown> => {
    if (!isRecord(raw) || raw.type !== 'blob' || typeof raw.path !== 'string') return false;
    const path = raw.path;
    return path.split('/').at(-1)?.toLocaleLowerCase('en-US') === 'skill.md';
  });
  if (candidates.length === 0) throw new UpstreamAcquisitionError('source_not_found', `No SKILL.md was found in ${repository}`);
  if (candidates.length > limits.maxFiles) throw new UpstreamAcquisitionError('file_count_limit', 'GitHub source contains too many candidate SKILL.md files');

  const candidateScores: Array<{ raw: Record<string, unknown>; score: number; frontmatter?: { name: string; description: string } }> = [];
  for (const raw of candidates) {
    const path = validateSkillPath(String(raw.path), limits, false);
    const sha = requireSha(raw.sha, `GitHub candidate ${path}`);
    const blob = await client.json<GitHubBlobResponse>(appendApiPath(apiBase, [
      'repos', repository.split('/')[0]!, repository.split('/')[1]!, 'git', 'blobs', sha,
    ]), { headers, allowedOrigin: apiBase.origin });
    const decoded = decodeGithubBlob(blob, {
      path,
      sha,
      size: raw.size,
      mode: typeof raw.mode === 'string' ? raw.mode : '100644',
      type: 'blob',
    }, limits);
    let frontmatter: { name: string; description: string } | undefined;
    try {
      frontmatter = parseSkillFrontmatterBytes(decoded.bytes);
    } catch {
      // The final selected bundle remains fail-closed.  A malformed candidate
      // simply cannot win a frontmatter-name match during discovery.
    }
    const parent = path.slice(0, Math.max(0, path.lastIndexOf('/')));
    const slugPath = detail.slug.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const lowerParent = parent.toLocaleLowerCase('en-US');
    const lowerSlug = slugPath.toLocaleLowerCase('en-US');
    let score = 0;
    if (lowerParent === lowerSlug) score += 100;
    if (lowerParent.endsWith(`/${lowerSlug}`)) score += 90;
    if (parent.split('/').at(-1)?.toLocaleLowerCase('en-US') === detail.slug.toLocaleLowerCase('en-US')) score += 80;
    if (frontmatter && frontmatter.name.toLocaleLowerCase('en-US') === detail.slug.toLocaleLowerCase('en-US')) score += 70;
    if (frontmatter && frontmatter.name.toLocaleLowerCase('en-US') === detail.name.toLocaleLowerCase('en-US')) score += 60;
    score += githubDirectoryPriority(parent);
    candidateScores.push({ raw, score, ...(frontmatter === undefined ? {} : { frontmatter }) });
  }
  candidateScores.sort((left, right) => right.score - left.score || String(left.raw.path).localeCompare(String(right.raw.path)));
  const selected = candidateScores[0]!;
  const tied = candidateScores.filter((candidate) => candidate.score === selected.score);
  if (tied.length > 1) throw new UpstreamAcquisitionError('ambiguous_source', `Multiple GitHub SKILL.md files match ${detail.externalId}`);
  const selectedAbsolutePath = validateSkillPath(String(selected.raw.path), limits, false);
  const selectedPath = selectedAbsolutePath.slice(0, Math.max(0, selectedAbsolutePath.lastIndexOf('/')));
  const bundle = await downloadGithubDirectory(client, apiBase, repository, selectedPath, treeResponse.tree, headers, limits);
  const fetchedAt = sourceFetchedAt();
  const frontmatter = readSkillFrontmatter(bundle);
  assertFrontmatterIdentity(frontmatter, detail);
  const selectedTreeEntry = treeResponse.tree.find((raw) => isRecord(raw) && raw.type === 'tree' && raw.path === selectedPath);
  const resolvedTree = typeof treeResponse.sha === 'string' && /^[0-9a-f]{40}$/i.test(treeResponse.sha)
    ? treeResponse.sha.toLocaleLowerCase('en-US')
    : typeof selectedTreeEntry === 'object' && selectedTreeEntry !== null && typeof (selectedTreeEntry as Record<string, unknown>).sha === 'string'
      ? String((selectedTreeEntry as Record<string, unknown>).sha)
      : resolvedCommit;
  return {
    bundle,
    fetchedAt,
    repository,
    skillPath: selectedPath,
    requestedRef,
    resolvedCommit,
    resolvedTree,
    ...(sourceProviderOrigin === undefined ? {} : { sourceProviderOrigin }),
  };
}

/**
 * The GitHub API endpoint is a resolver transport, not proof of the source
 * host.  The official API has a canonical github.com source origin; a custom
 * endpoint needs an explicit operator-approved origin before it is exposed as
 * provenance.  This field is metadata only and never changes the fetch base.
 */
function resolveGithubSourceProviderOrigin(
  upstream: Record<string, unknown>,
  apiBase: URL,
  allowLoopbackForTests: boolean,
): string | undefined {
  const explicit = upstream.githubSourceOrigin;
  if (explicit !== undefined) {
    if (typeof explicit !== 'string' || explicit.trim() === '') {
      throw new UpstreamAcquisitionError('invalid_upstream_base', 'GitHub source origin is invalid');
    }
    return parseSourceProviderOrigin(explicit, allowLoopbackForTests);
  }
  if (apiBase.origin === GITHUB_API_ORIGIN) return 'https://github.com';
  return undefined;
}

function parseSourceProviderOrigin(value: string, allowLoopbackForTests: boolean): string {
  const parsed = parseFixedBase(value, allowLoopbackForTests);
  if (parsed.pathname !== '/') {
    throw new UpstreamAcquisitionError('invalid_upstream_base', 'Source provider origin must not include a path');
  }
  return parsed.origin;
}

function parseSkillFrontmatterBytes(bytes: Uint8Array): { name: string; description: string } {
  try {
    const metadata = parseSkillMetadata({
      format: 'pskills-bundle-v1',
      files: [{ path: 'SKILL.md', content: Buffer.from(bytes).toString('base64') }],
    });
    return { name: metadata.skillName, description: metadata.description };
  } catch {
    throw new UpstreamAcquisitionError('invalid_frontmatter', 'SKILL.md metadata is invalid');
  }
}

function githubDirectoryPriority(path: string): number {
  const lower = path.toLocaleLowerCase('en-US');
  if (!lower.includes('/')) return 30;
  if (lower.startsWith('skills/')) return 20;
  if (lower.startsWith('.agents/skills/')) return 10;
  if (lower.startsWith('agent-skills/')) return 10;
  return 0;
}

async function downloadGithubDirectory(
  client: HttpClient,
  apiBase: URL,
  repository: string,
  selectedPath: string,
  tree: unknown[],
  headers: FetchHeaders,
  limits: AcquisitionLimits,
): Promise<SkillBundle> {
  const entries = selectTreeEntries(tree, selectedPath, limits);
  if (entries.length === 0) throw new UpstreamAcquisitionError('source_not_found', `No files found at ${selectedPath || '/'}`);
  let declaredExpandedBytes = 0;
  for (const entry of entries) {
    if (typeof entry.size === 'number') {
      if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new UpstreamAcquisitionError('invalid_source', `Invalid size for GitHub file ${entry.path}`);
      declaredExpandedBytes += entry.size;
      if (declaredExpandedBytes > limits.maxExpandedBytes) throw new UpstreamAcquisitionError('expanded_size_limit', 'GitHub selected directory exceeds the expanded size limit');
    }
  }
  const blobs = await mapWithConcurrency(entries, limits.concurrency, async (entry) => {
    const sha = requireSha(entry.sha, `GitHub tree entry ${entry.path}`);
    if (typeof entry.size === 'number' && entry.size > limits.maxFileBytes) throw new UpstreamAcquisitionError('file_size_limit', `GitHub file ${entry.path} exceeds the per-file limit`);
    const blob = await client.json<GitHubBlobResponse>(appendApiPath(apiBase, [
      'repos', repository.split('/')[0]!, repository.split('/')[1]!, 'git', 'blobs', sha,
    ]), { headers, allowedOrigin: apiBase.origin });
    return decodeGithubBlob(blob, entry, limits);
  });
  return bundleFromRawFiles(blobs.map((blob) => ({ path: blob.path, bytes: blob.bytes, ...(blob.executable === true ? { executable: true } : {}) })), limits);
}

function parseSkillsShGithubRepository(source: string, installRepository?: string): string {
  try {
    return normalizeRepositoryIdentity(source);
  } catch {
    if (installRepository) return normalizeRepositoryIdentity(installRepository);
    throw new UpstreamAcquisitionError('invalid_source', 'skills.sh GitHub source is not an owner/repository identity');
  }
}

function parseGithubInstallHint(value: string | null): { repository: string; ref?: string } | undefined {
  if (!value) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.protocol !== 'https:' || url.hostname.toLocaleLowerCase('en-US') !== 'github.com' || url.username || url.password || url.search || url.hash) return undefined;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return undefined;
  const repository = normalizeRepositoryIdentity(`${parts[0]}/${parts[1]}`);
  if (parts[2] !== 'tree' && parts[2] !== 'blob') return { repository };
  const ref = parts[3];
  if (!ref) return { repository };
  let decodedRef: string;
  try {
    decodedRef = decodeURIComponent(ref);
  } catch {
    throw new UpstreamAcquisitionError('invalid_ref', 'GitHub install URL contains an invalid ref');
  }
  return { repository, ref: validateRef(decodedRef) };
}

interface SkillsShWellKnownResult {
  bundle: SkillBundle;
  fetchedAt: string;
  indexUrl: string;
  sourceProviderOrigin: string;
  wellKnownEntryName: string;
  artifactUrl?: string;
  externalDigest?: string;
}

interface WellKnownV1Entry {
  name: string;
  description: string;
  files: string[];
}

interface WellKnownV2Entry {
  name: string;
  type: 'skill-md' | 'archive';
  description: string;
  url: string;
  digest: string;
}

async function acquireSkillsShWellKnown(args: {
  upstream: Upstream;
  importRequest: ImportRequest;
  options: AcquireSkillOptions;
  detail: ParsedSkillsShDetail;
  limits: AcquisitionLimits;
}): Promise<SkillsShWellKnownResult> {
  const { upstream, detail, limits, options } = args;
  const upstreamRecord = upstream as unknown as Record<string, unknown>;
  const base = normalizeWellKnownSourceBase(detail, upstreamRecord, options.allowLoopbackForTests);
  const fetchImpl = options.fetchImpl ?? options.fetch ?? DEFAULT_FETCH;
  const client = new HttpClient(fetchImpl, limits, options, base.origin);
  const headers: FetchHeaders = { accept: 'application/json', 'user-agent': 'private-skills/0.1' };
  let lastUnavailable: UpstreamAcquisitionError | undefined;
  for (const wellKnownDirectory of ['agent-skills', 'skills'] as const) {
    const indexUrl = appendBasePath(base, ['.well-known', wellKnownDirectory, 'index.json']);
    let raw: unknown;
    try {
      raw = await client.json(indexUrl, { headers, allowedOrigin: base.origin, retryable: false });
    } catch (error) {
      if (error instanceof UpstreamAcquisitionError && (error.status === 404 || error.status === 410)) {
        lastUnavailable = error;
        continue;
      }
      throw error;
    }
    const index = parseWellKnownIndex(raw, limits);
    const entry = selectWellKnownEntry(index, detail);
    if (index.kind === 'v2') {
      const artifact = await fetchWellKnownV2(client, base, indexUrl, entry as WellKnownV2Entry, limits, fetchImpl, options);
      const fetchedAt = sourceFetchedAt();
      const frontmatter = readSkillFrontmatter(artifact.bundle);
      assertFrontmatterIdentity(frontmatter, detail);
      return {
        bundle: artifact.bundle,
        fetchedAt,
        indexUrl: indexUrl.toString(),
        sourceProviderOrigin: indexUrl.origin,
        wellKnownEntryName: entry.name,
        artifactUrl: artifact.artifactUrl,
        externalDigest: (entry as WellKnownV2Entry).digest,
      };
    }
    const bundle = await fetchWellKnownV1(client, base, wellKnownDirectory, entry as WellKnownV1Entry, limits);
    const fetchedAt = sourceFetchedAt();
    const frontmatter = readSkillFrontmatter(bundle);
    assertFrontmatterIdentity(frontmatter, detail);
    return {
      bundle,
      fetchedAt,
      indexUrl: indexUrl.toString(),
      sourceProviderOrigin: indexUrl.origin,
      wellKnownEntryName: entry.name,
    };
  }
  if (lastUnavailable) {
    throw new UpstreamAcquisitionError(
      'source_unavailable',
      'No well-known skills index is available',
      lastUnavailable.status,
    );
  }
  throw new UpstreamAcquisitionError('source_unavailable', 'No well-known skills index is available');
}

function normalizeWellKnownSourceBase(
  detail: ParsedSkillsShDetail,
  upstream: Record<string, unknown>,
  allowLoopbackForTests = false,
): URL {
  const configured = typeof upstream.wellKnownBaseUrl === 'string' ? upstream.wellKnownBaseUrl : undefined;
  let candidate = configured;
  if (!candidate && detail.installUrl) {
    try {
      const install = new URL(detail.installUrl);
      if (install.hostname !== 'skills.sh' && install.hostname !== 'www.skills.sh') {
        const marker = install.pathname.indexOf('/.well-known/');
        // A directory install URL can identify either a well-known scoped
        // prefix (`/published/.well-known/...`) or an explicit source root
        // (`/published/`). Preserve a non-marker path; silently replacing it
        // with `/` could redirect acquisition to a different source.
        if (marker >= 0) install.pathname = install.pathname.slice(0, marker) || '/';
        install.search = '';
        install.hash = '';
        candidate = install.toString();
      }
    } catch {
      // The detail parser has already validated installUrl.  This branch is
      // defensive for a future URL shape.
    }
  }
  if (!candidate) {
    // A source such as "googleworkspace/cli" is a catalog repository-like
    // identity, not a safe well-known host.  Without an explicit install URL
    // or deployment mapping there is no origin we can resolve responsibly.
    if (detail.source.includes('/')) {
      throw new UpstreamAcquisitionError('source_unavailable', 'Well-known skills.sh source has no safe origin mapping');
    }
    const source = detail.source.includes('://') ? detail.source : `https://${detail.source}`;
    candidate = source;
  }
  return parseFixedBase(candidate, allowLoopbackForTests);
}

type ParsedWellKnownIndex =
  | { kind: 'v1'; entries: WellKnownV1Entry[] }
  | { kind: 'v2'; entries: WellKnownV2Entry[] };

const DISCOVERY_SCHEMA_V2 = 'https://schemas.agentskills.io/discovery/0.2.0/schema.json';

function parseWellKnownIndex(value: unknown, limits: AcquisitionLimits): ParsedWellKnownIndex {
  if (!isRecord(value) || !Array.isArray(value.skills)) {
    throw new UpstreamAcquisitionError('unsupported_source', 'Well-known discovery index has an unsupported shape');
  }
  if (value.$schema === DISCOVERY_SCHEMA_V2) {
    const entries: WellKnownV2Entry[] = [];
    const names = new Set<string>();
    for (const raw of value.skills) {
      if (!isRecord(raw) || !isWellKnownName(raw.name) || typeof raw.description !== 'string' || raw.description.length === 0 || raw.description.length > 1_024 || (raw.type !== 'skill-md' && raw.type !== 'archive') || typeof raw.url !== 'string' || raw.url.length === 0 || typeof raw.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(raw.digest)) {
        throw new UpstreamAcquisitionError('invalid_source', 'Well-known v0.2 discovery entry is invalid');
      }
      if (names.has(raw.name)) throw new UpstreamAcquisitionError('ambiguous_source', `Well-known discovery contains duplicate skill ${raw.name}`);
      names.add(raw.name);
      if (raw.url.length > limits.maxPathBytes * 4) throw new UpstreamAcquisitionError('invalid_source', 'Well-known artifact URL is too long');
      entries.push({ name: raw.name, description: raw.description, type: raw.type, url: raw.url, digest: raw.digest });
    }
    if (entries.length === 0) throw new UpstreamAcquisitionError('source_not_found', 'Well-known discovery index contains no skills');
    return { kind: 'v2', entries };
  }
  if (value.$schema !== undefined) {
    throw new UpstreamAcquisitionError('unsupported_source', 'Well-known discovery schema is unsupported');
  }
  const entries: WellKnownV1Entry[] = [];
  const names = new Set<string>();
  for (const raw of value.skills) {
    if (!isRecord(raw) || !isWellKnownName(raw.name) || typeof raw.description !== 'string' || raw.description.length === 0 || raw.description.length > 1_024 || !Array.isArray(raw.files) || raw.files.length === 0 || raw.files.length > limits.maxFiles) {
      throw new UpstreamAcquisitionError('invalid_source', 'Well-known legacy discovery entry is invalid');
    }
    if (names.has(raw.name)) throw new UpstreamAcquisitionError('ambiguous_source', `Well-known discovery contains duplicate skill ${raw.name}`);
    names.add(raw.name);
    const files = raw.files.map((file) => {
      if (typeof file !== 'string' || file.length === 0 || file.length > limits.maxPathBytes || file.startsWith('/') || file.startsWith('\\') || file.includes('\\') || file.includes('\0') || file.split('/').some((part) => part === '.' || part === '..')) {
        throw new UpstreamAcquisitionError('invalid_path', 'Well-known legacy discovery contains an unsafe file path');
      }
      return validateSkillPath(file, limits, false);
    });
    if (!files.some((file) => file.toLocaleLowerCase('en-US') === 'skill.md')) {
      throw new UpstreamAcquisitionError('missing_skill_file', `Well-known skill ${raw.name} does not advertise SKILL.md`);
    }
    entries.push({ name: raw.name, description: raw.description, files });
  }
  if (entries.length === 0) throw new UpstreamAcquisitionError('source_not_found', 'Well-known discovery index contains no skills');
  return { kind: 'v1', entries };
}

function isWellKnownName(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 64 && /^[a-z0-9-]+$/.test(value) && !value.startsWith('-') && !value.endsWith('-') && !value.includes('--');
}

function selectWellKnownEntry(index: ParsedWellKnownIndex, detail: ParsedSkillsShDetail): WellKnownV1Entry | WellKnownV2Entry {
  const target = new Set([detail.slug, detail.name, detail.externalId.split('/').at(-1) ?? ''].map((value) => value.toLocaleLowerCase('en-US')));
  const matches = index.entries.filter((entry) => target.has(entry.name.toLocaleLowerCase('en-US')));
  if (matches.length === 0) throw new UpstreamAcquisitionError('source_not_found', `Well-known source does not advertise ${detail.slug}`);
  if (matches.length !== 1) throw new UpstreamAcquisitionError('ambiguous_source', `Well-known source advertises multiple matches for ${detail.slug}`);
  return matches[0]!;
}

async function fetchWellKnownV1(
  client: HttpClient,
  base: URL,
  wellKnownDirectory: 'agent-skills' | 'skills',
  entry: WellKnownV1Entry,
  limits: AcquisitionLimits,
): Promise<SkillBundle> {
  const files: Array<{ path: string; bytes: Uint8Array }> = [];
  for (const path of entry.files) {
    const url = appendBasePath(base, ['.well-known', wellKnownDirectory, entry.name, ...path.split('/')]);
    const response = await client.bytes(url, { allowedOrigin: base.origin });
    files.push({ path, bytes: response.bytes });
  }
  return bundleFromRawFiles(files, limits);
}

async function fetchWellKnownV2(
  client: HttpClient,
  base: URL,
  indexUrl: URL,
  entry: WellKnownV2Entry,
  limits: AcquisitionLimits,
  fetchImpl: FetchLike,
  options: AcquireSkillOptions,
): Promise<{ bundle: SkillBundle; artifactUrl: string }> {
  let artifactUrl: URL;
  try { artifactUrl = new URL(entry.url, indexUrl); } catch { throw new UpstreamAcquisitionError('invalid_source', 'Well-known artifact URL is invalid'); }
  assertSafeURL(artifactUrl, clientAllowsLoopback(client));
  // The discovery schema permits a public CDN/blob URL.  Use a new client
  // fixed to that artifact origin so redirects remain same-origin to the
  // artifact host, while no catalog/source credentials can be forwarded.
  const artifactClient = artifactUrl.origin === base.origin
    ? client
    : new HttpClient(fetchImpl, limits, options, artifactUrl.origin);
  const response = await artifactClient.bytes(artifactUrl, {});
  const actualDigest = digestBytes(response.bytes);
  if (actualDigest !== entry.digest) throw new UpstreamAcquisitionError('digest_mismatch', 'Well-known artifact digest does not match its discovery entry');
  const rawFiles = entry.type === 'skill-md'
    ? [{ path: 'SKILL.md', bytes: response.bytes }]
    : extractWellKnownArchive(response.bytes, response.response.headers.get('content-type') ?? '', artifactUrl.toString(), limits);
  return { bundle: bundleFromRawFiles(rawFiles, limits), artifactUrl: artifactUrl.toString() };
}

/** HttpClient always uses the worker's explicit loopback fixture switch. */
function clientAllowsLoopback(client: HttpClient): boolean {
  return (client as unknown as { options?: AcquireSkillOptions }).options?.allowLoopbackForTests === true;
}

const WELL_KNOWN_MAX_ARCHIVE_FILES = 1_000;
const WELL_KNOWN_MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;

interface ArchiveDirectoryEntry {
  path: string;
  kind: 'directory';
}

interface ArchiveFileEntry {
  path: string;
  bytes: Uint8Array;
  kind?: 'file';
}

type ArchiveEntry = ArchiveDirectoryEntry | ArchiveFileEntry;

function extractWellKnownArchive(
  bytes: Uint8Array,
  contentType: string,
  artifactUrl: string,
  limits: AcquisitionLimits,
): Array<{ path: string; bytes: Uint8Array }> {
  const lowerType = contentType.toLocaleLowerCase('en-US');
  const lowerURL = artifactUrl.toLocaleLowerCase('en-US');
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)) {
    return extractZipArchive(bytes, limits);
  }
  if ((bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) || lowerType.includes('gzip') || lowerURL.endsWith('.tar.gz') || lowerURL.endsWith('.tgz')) {
    try {
      // zlib otherwise expands a tiny compressed bomb before the tar parser
      // can apply its file/expanded-byte limits.  Bound decompression by the
      // archive cap plus tar header/padding overhead.
      const expandedLimit = Math.min(limits.maxExpandedBytes, WELL_KNOWN_MAX_ARCHIVE_BYTES);
      const decompressed = gunzipSync(Buffer.from(bytes), {
        maxOutputLength: expandedLimit + Math.min(limits.maxFiles, WELL_KNOWN_MAX_ARCHIVE_FILES) * 1_024 + 1_024,
      });
      return extractTarArchive(decompressed, limits);
    } catch (error) {
      if (error instanceof UpstreamAcquisitionError) throw error;
      throw new UpstreamAcquisitionError('invalid_archive', 'Well-known gzip archive is invalid');
    }
  }
  if (lowerType.includes('tar') || lowerURL.endsWith('.tar')) {
    return extractTarArchive(bytes, limits);
  }
  throw new UpstreamAcquisitionError('unsupported_archive', 'Well-known archive is not a supported ZIP, tar, or tar.gz file');
}

function extractOpenClawArchive(
  bytes: Uint8Array,
  contentType: string,
  artifactUrl: string,
  limits: AcquisitionLimits,
): ArchiveEntry[] {
  const lowerType = contentType.toLocaleLowerCase('en-US');
  const lowerURL = artifactUrl.toLocaleLowerCase('en-US');
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)) {
    return extractZipArchive(bytes, limits, true);
  }
  if ((bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) || lowerType.includes('gzip') || lowerURL.endsWith('.tar.gz') || lowerURL.endsWith('.tgz')) {
    try {
      const expandedLimit = Math.min(limits.maxExpandedBytes, WELL_KNOWN_MAX_ARCHIVE_BYTES);
      const decompressed = gunzipSync(Buffer.from(bytes), {
        maxOutputLength: expandedLimit + Math.min(limits.maxFiles, WELL_KNOWN_MAX_ARCHIVE_FILES) * 1_024 + 1_024,
      });
      return extractTarArchive(decompressed, limits, true);
    } catch (error) {
      if (error instanceof UpstreamAcquisitionError) throw error;
      throw new UpstreamAcquisitionError('invalid_archive', 'OpenClaw gzip archive is invalid');
    }
  }
  if (lowerType.includes('tar') || lowerURL.endsWith('.tar')) {
    return extractTarArchive(bytes, limits, true);
  }
  throw new UpstreamAcquisitionError('unsupported_archive', 'OpenClaw source is not a supported ZIP, tar, or tar.gz file');
}

function normalizeOpenClawArtifactOrigins(origins: readonly string[]): string[] {
  if (!Array.isArray(origins) || origins.length === 0 || origins.length > 8) {
    throw new UpstreamAcquisitionError('invalid_source', 'OpenClaw source transport requires a bounded origin allowlist');
  }
  const normalized = new Set<string>();
  for (const value of origins) {
    if (typeof value !== 'string' || value.length > 256) {
      throw new UpstreamAcquisitionError('invalid_source', 'OpenClaw source transport origin is invalid');
    }
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new UpstreamAcquisitionError('invalid_source', 'OpenClaw source transport origin is invalid');
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
      throw new UpstreamAcquisitionError('invalid_source', 'OpenClaw source transport origin must be an HTTPS origin');
    }
    normalized.add(parsed.origin);
  }
  return [...normalized];
}

function asOpenClawSourceRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new UpstreamAcquisitionError('invalid_source', 'OpenClaw source identity is invalid');
  }
  return value;
}

function boundedDefaultSourceCoordinate(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || new TextEncoder().encode(value).byteLength > 4_096) {
    throw new UpstreamAcquisitionError('invalid_source', 'OpenClaw source coordinate is invalid');
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new UpstreamAcquisitionError('invalid_source', 'OpenClaw source coordinate is invalid');
  }
  try {
    // Reject lone UTF-16 surrogates before URLSearchParams or URL path
    // encoding can silently replace them with U+FFFD.
    encodeURIComponent(value);
  } catch {
    throw new UpstreamAcquisitionError('invalid_source', 'OpenClaw source coordinate is invalid');
  }
  return value;
}

function parseDefaultClawHubPackage(value: string): { slug: string; ownerHandle?: string } {
  // OpenClaw's user-facing ClawHub coordinate is @owner/slug, while the v1
  // download API takes those as separate `ownerHandle` and `slug` query
  // parameters. Unscoped slugs stay as-is. A malformed scoped coordinate is
  // rejected instead of silently dropping its publisher identity.
  if (!value.startsWith('@')) {
    if (value.includes('/')) {
      throw new UpstreamAcquisitionError('invalid_source', 'OpenClaw ClawHub package identity is invalid');
    }
    return { slug: value };
  }
  const match = /^@([^/@]+)\/([^/@]+)$/.exec(value);
  if (!match || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(match[1]!) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(match[2]!)) {
    throw new UpstreamAcquisitionError('invalid_source', 'OpenClaw ClawHub package identity is invalid');
  }
  return { slug: match[2]!, ownerHandle: match[1]! };
}

function validateDefaultGithubRepository(value: unknown): string {
  const repo = boundedDefaultSourceCoordinate(value);
  if (new TextEncoder().encode(repo).byteLength > 256) {
    throw new UpstreamAcquisitionError('invalid_source', 'OpenClaw GitHub repository is invalid');
  }
  const parts = repo.split('/');
  if (parts.length !== 2 || parts.some((part) => part.length === 0 || part === '.' || part === '..' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))) {
    throw new UpstreamAcquisitionError('invalid_source', 'OpenClaw GitHub repository is invalid');
  }
  return repo;
}

function validateDefaultGithubPath(value: unknown): string {
  const path = boundedDefaultSourceCoordinate(value);
  if (path === '') return path;
  if (path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw new UpstreamAcquisitionError('invalid_source', 'OpenClaw GitHub source path is invalid');
  }
  return path;
}

function validateDefaultGithubSha(value: unknown, length: 40 | 64, label: string): string {
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${length}}$`).test(value)) {
    throw new UpstreamAcquisitionError('invalid_source', `OpenClaw GitHub ${label} is not immutable`);
  }
  return value;
}

function assertDefaultSourceURLSize(url: URL): void {
  if (new TextEncoder().encode(url.href).byteLength > 8_192) {
    throw new UpstreamAcquisitionError('unsafe_url', 'OpenClaw source URL is too large');
  }
}

function normalizeOpenClawSourceProviderOrigin(value: string | undefined): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new UpstreamAcquisitionError('invalid_source', 'OpenClaw source provider origin is missing');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new UpstreamAcquisitionError('invalid_source', 'OpenClaw source provider origin is invalid');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new UpstreamAcquisitionError('invalid_source', 'OpenClaw source provider origin must be an HTTPS origin');
  }
  return parsed.origin;
}

function validateOpenClawTransportURL(
  value: string,
  allowedOrigins: readonly string[],
  allowLoopbackForTests: boolean,
): URL {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8_192) {
    throw new UpstreamAcquisitionError('unsafe_url', 'OpenClaw source URL is invalid');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new UpstreamAcquisitionError('unsafe_url', 'OpenClaw source URL is invalid');
  }
  if (parsed.protocol !== 'https:' && !(allowLoopbackForTests && parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname))) {
    throw new UpstreamAcquisitionError('insecure_upstream', 'OpenClaw source connections require HTTPS');
  }
  if (parsed.username || parsed.password || parsed.hash || !allowedOrigins.includes(parsed.origin)) {
    throw new UpstreamAcquisitionError('unsafe_url', 'OpenClaw source URL is not bound to its configured origin');
  }
  return parsed;
}

function validateOpenClawFetchedSource(
  fetched: OpenClawFetchedSource,
  allowedOrigins: readonly string[],
  limits: AcquisitionLimits,
): OpenClawFetchedSource {
  if (!(fetched.bytes instanceof Uint8Array)) {
    throw new UpstreamAcquisitionError('invalid_source', 'OpenClaw source adapter did not return bytes');
  }
  if (fetched.bytes.byteLength > limits.maxResponseBytes) {
    throw new UpstreamAcquisitionError('response_size_limit', `OpenClaw source exceeds the ${limits.maxResponseBytes}-byte response limit`);
  }
  if (fetched.status !== 200) {
    throw new UpstreamAcquisitionError('unexpected_status', `OpenClaw source returned HTTP ${String(fetched.status)}`, fetched.status);
  }
  if (fetched.redirected === true) {
    throw new UpstreamAcquisitionError('redirect_denied', 'OpenClaw source redirects are not accepted');
  }
  let requested: URL;
  let final: URL;
  try {
    requested = new URL(fetched.requestedUrl);
    final = new URL(fetched.finalUrl);
  } catch {
    throw new UpstreamAcquisitionError('unsafe_url', 'OpenClaw source adapter returned an invalid URL');
  }
  if (requested.protocol !== 'https:' || final.protocol !== 'https:' || requested.username || requested.password || final.username || final.password) {
    throw new UpstreamAcquisitionError('unsafe_url', 'OpenClaw source transport must use HTTPS without URL credentials');
  }
  if (requested.href !== final.href || requested.origin !== final.origin) {
    throw new UpstreamAcquisitionError('redirect_denied', 'OpenClaw source redirects are not accepted');
  }
  if (!allowedOrigins.includes(requested.origin)) {
    throw new UpstreamAcquisitionError('source_origin_denied', 'OpenClaw source transport origin is not allowlisted');
  }
  return { ...fetched, bytes: fetched.bytes.slice() };
}

function resolveOpenClawHostedArtifact(
  fetched: OpenClawFetchedSource,
  expectedDigest: string,
  limits: AcquisitionLimits,
): SkillBundle {
  const digest = digestBytes(fetched.bytes);
  if (!/^sha256:[0-9a-f]{64}$/.test(expectedDigest) || digest !== expectedDigest) {
    throw new UpstreamAcquisitionError('digest_mismatch', 'OpenClaw hosted artifact digest did not match its feed integrity');
  }
  const firstNonWhitespace = new TextDecoder('utf-8').decode(fetched.bytes).trimStart().slice(0, 1);
  if (firstNonWhitespace === '{') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fetched.bytes)) as unknown;
    } catch {
      throw new UpstreamAcquisitionError('invalid_bundle', 'OpenClaw hosted artifact JSON is invalid');
    }
    const bundle = validateSkillBundle(parsed, limits);
    readOpenClawFrontmatter(bundle);
    return bundle;
  }
  const files = extractWellKnownArchive(
    fetched.bytes,
    fetched.contentType ?? '',
    fetched.finalUrl,
    limits,
  );
  const bundle = bundleFromRawFiles(files, limits);
  readOpenClawFrontmatter(bundle);
  return bundle;
}

function resolveOpenClawGithubArchive(
  fetched: OpenClawFetchedSource,
  source: Extract<OpenClawNormalizedSource, { kind: 'public-github' }>,
  limits: AcquisitionLimits,
): { bundle: SkillBundle; contentHash: string } {
  if (!/^[0-9a-f]{40}$/.test(source.commit) || !/^[0-9a-f]{64}$/.test(source.contentHash)) {
    throw new UpstreamAcquisitionError('invalid_source', 'OpenClaw GitHub source identity is not immutable');
  }
  const selectedPath = source.path === '' ? '' : validateSkillPath(source.path, limits);
  const entries = extractOpenClawArchive(
    fetched.bytes,
    fetched.contentType ?? '',
    fetched.finalUrl,
    limits,
  );
  const archiveRoot = inferOpenClawGithubArchiveRoot(entries, source.commit, limits);
  const selected = selectOpenClawGithubFolder(entries, archiveRoot, selectedPath, limits);
  const contentHash = digestOpenClawFolder(selected);
  if (contentHash !== source.contentHash) {
    throw new UpstreamAcquisitionError('digest_mismatch', 'OpenClaw GitHub folder content hash did not match its feed integrity');
  }
  const files = selected
    .filter((entry): entry is ArchiveFileEntry => entry.kind !== 'directory')
    .filter((entry) => {
      const first = entry.path.split('/')[0];
      return first !== '.clawhub' && first !== '.clawdhub';
    })
    .map((entry) => ({ path: entry.path, bytes: entry.bytes }));
  const bundle = bundleFromRawFiles(files, limits);
  readOpenClawFrontmatter(bundle);
  return { bundle, contentHash };
}

function inferOpenClawGithubArchiveRoot(
  entries: readonly ArchiveEntry[],
  commit: string,
  limits: AcquisitionLimits,
): string {
  const roots = new Set<string>();
  for (const entry of entries) {
    const first = entry.path.split('/')[0];
    if (!first || first === '.' || first === '..') {
      throw new UpstreamAcquisitionError('invalid_path', 'OpenClaw GitHub archive has no safe repository root');
    }
    roots.add(first);
    if (roots.size > 1) throw new UpstreamAcquisitionError('invalid_source', 'OpenClaw GitHub archive has multiple repository roots');
  }
  const root = [...roots][0];
  if (!root || !root.endsWith(`-${commit}`)) {
    throw new UpstreamAcquisitionError('digest_mismatch', 'OpenClaw GitHub archive is not pinned to the requested commit');
  }
  // Validate the archive root as a path segment even though it is removed
  // before bundle validation; this rejects encoded/control path surprises.
  validateSkillPath(root, limits, false);
  return root;
}

function selectOpenClawGithubFolder(
  entries: readonly ArchiveEntry[],
  archiveRoot: string,
  selectedPath: string,
  limits: AcquisitionLimits,
): ArchiveEntry[] {
  const prefix = `${archiveRoot}/`;
  const selectedPrefix = selectedPath ? `${selectedPath}/` : '';
  const output: ArchiveEntry[] = [];
  for (const entry of entries) {
    if (!entry.path.startsWith(prefix)) continue;
    const withoutRoot = entry.path.slice(prefix.length);
    if (!withoutRoot || withoutRoot === selectedPath) continue;
    const relative = selectedPath
      ? withoutRoot.startsWith(selectedPrefix) ? withoutRoot.slice(selectedPrefix.length) : undefined
      : withoutRoot;
    if (relative === undefined || relative === '') continue;
    // ClawHub's source identity hash includes its install metadata files. Keep
    // those entries through verification, then omit them only when building
    // the canonical installed bundle below. They still receive path safety
    // checks, but are not treated as executable plugin payload.
    const safe = validateSkillPath(relative, limits, false);
    output.push(entry.kind === 'directory' ? { path: safe, kind: 'directory' } : { path: safe, bytes: entry.bytes, kind: 'file' });
  }
  if (!output.some((entry) => entry.kind !== 'directory' && entry.path === 'SKILL.md')) {
    throw new UpstreamAcquisitionError('source_not_found', 'OpenClaw GitHub archive does not contain the selected SKILL.md');
  }
  return output;
}

function digestOpenClawFolder(entries: readonly ArchiveEntry[]): string {
  const files = new Map<string, Uint8Array>();
  const directories = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === 'directory') {
      if (files.has(entry.path)) {
        throw new UpstreamAcquisitionError('path_collision', `OpenClaw source path ${entry.path} is both a file and directory`);
      }
      directories.add(entry.path);
      continue;
    }
    if (files.has(entry.path)) throw new UpstreamAcquisitionError('path_collision', `OpenClaw source contains duplicate path ${entry.path}`);
    if (directories.has(entry.path)) throw new UpstreamAcquisitionError('path_collision', `OpenClaw source path ${entry.path} is both a file and directory`);
    files.set(entry.path, entry.bytes);
    const parts = entry.path.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      const directory = parts.slice(0, index).join('/');
      if (files.has(directory)) throw new UpstreamAcquisitionError('path_collision', `OpenClaw source path ${directory} is both a file and directory`);
      directories.add(directory);
    }
  }
  // Pinned ClawHub folder identity: file paths are sorted and represented as
  // relative path, byte length, and content digest. Directory records are not
  // hashed, while install metadata files remain part of source identity.
  const lines = [...files.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, bytes]) => `${path}\0${bytes.byteLength}\0${createHash('sha256').update(bytes).digest('hex')}`);
  if (lines.length === 0) throw new UpstreamAcquisitionError('source_not_found', 'OpenClaw source folder contains no files');
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}

function extractZipArchive(bytes: Uint8Array, limits: AcquisitionLimits): Array<{ path: string; bytes: Uint8Array }>;
function extractZipArchive(bytes: Uint8Array, limits: AcquisitionLimits, includeDirectories: true): ArchiveEntry[];
function extractZipArchive(
  bytes: Uint8Array,
  limits: AcquisitionLimits,
  includeDirectories = false,
): ArchiveEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findZipEndOfCentralDirectory(bytes);
  if (eocd < 0) throw new UpstreamAcquisitionError('invalid_archive', 'ZIP archive has no end record');
  const diskNumber = readU16(view, eocd + 4, 'ZIP disk number');
  const centralDisk = readU16(view, eocd + 6, 'ZIP central disk number');
  const entriesOnDisk = readU16(view, eocd + 8, 'ZIP entries on disk');
  const entryCount = readU16(view, eocd + 10, 'ZIP entry count');
  const centralSize = readU32(view, eocd + 12, 'ZIP central directory size');
  const centralOffset = readU32(view, eocd + 16, 'ZIP central directory offset');
  const commentLength = readU16(view, eocd + 20, 'ZIP comment length');
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount || eocd + 22 + commentLength !== bytes.length) {
    throw new UpstreamAcquisitionError('invalid_archive', 'ZIP archive has unsupported disks or trailing data');
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new UpstreamAcquisitionError('unsupported_archive', 'ZIP64 archives are not supported');
  }
  if (entryCount > Math.min(WELL_KNOWN_MAX_ARCHIVE_FILES, limits.maxFiles) || centralOffset + centralSize !== eocd) {
    throw new UpstreamAcquisitionError('archive_limit', 'ZIP archive exceeds entry or size limits');
  }
  const files: ArchiveEntry[] = [];
  const seen = new Set<string>();
  const dataRanges: Array<{ start: number; end: number }> = [];
  const localOffsets = collectZipLocalOffsets(view, centralOffset, centralSize, entryCount);
  let cursor = centralOffset;
  let total = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > bytes.length || readU32(view, cursor, 'ZIP central signature') !== 0x02014b50) {
      throw new UpstreamAcquisitionError('invalid_archive', 'ZIP central directory is malformed');
    }
    const flags = readU16(view, cursor + 8, 'ZIP flags');
    const method = readU16(view, cursor + 10, 'ZIP compression method');
    const compressedSize = readU32(view, cursor + 20, 'ZIP compressed size');
    const uncompressedSize = readU32(view, cursor + 24, 'ZIP uncompressed size');
    const nameLength = readU16(view, cursor + 28, 'ZIP file name length');
    const extraLength = readU16(view, cursor + 30, 'ZIP extra length');
    const commentLength = readU16(view, cursor + 32, 'ZIP comment length');
    const localOffset = readU32(view, cursor + 42, 'ZIP local header offset');
    const recordEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (recordEnd > centralOffset + centralSize || (flags & 0x1) !== 0) {
      throw new UpstreamAcquisitionError('unsupported_archive', 'Encrypted ZIP entries are not supported');
    }
    if (method !== 0 && method !== 8) throw new UpstreamAcquisitionError('unsupported_archive', 'ZIP compression method is unsupported');
    if (uncompressedSize > limits.maxFileBytes || uncompressedSize > WELL_KNOWN_MAX_ARCHIVE_BYTES || compressedSize > limits.maxResponseBytes) {
      throw new UpstreamAcquisitionError('archive_limit', 'ZIP entry exceeds file limits');
    }
    const filenameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    let rawName: string;
    try { rawName = new TextDecoder((flags & 0x800) !== 0 ? 'utf-8' : 'latin1', { fatal: true }).decode(filenameBytes); } catch { throw new UpstreamAcquisitionError('invalid_archive', 'ZIP filename is not valid text'); }
    const versionMadeBy = readU16(view, cursor + 4, 'ZIP creator version');
    const externalAttributes = readU32(view, cursor + 38, 'ZIP external attributes');
    // Unix symlinks are encoded in the high mode bits of the central record.
    // They must never be materialized as ordinary files, even if their name
    // and payload look harmless.
    const creatorOs = versionMadeBy >>> 8;
    const unixModeType = externalAttributes >>> 16 & 0xf000;
    const dosDirectory = (externalAttributes & 0x10) !== 0;
    if (creatorOs === 3 && unixModeType !== 0 && unixModeType !== 0x8000 && unixModeType !== 0x4000) {
      throw new UpstreamAcquisitionError('unsupported_archive', 'ZIP archive contains a non-regular Unix entry');
    }
    if ((creatorOs === 0 || creatorOs === 10) && dosDirectory && !rawName.endsWith('/')) {
      throw new UpstreamAcquisitionError('unsupported_archive', 'ZIP directory entry has an unsafe name');
    }
    if (creatorOs === 3 && unixModeType === 0x4000 && !rawName.endsWith('/')) {
      throw new UpstreamAcquisitionError('unsupported_archive', 'ZIP directory entry has an unsafe name');
    }
    if (rawName.endsWith('/')) {
      const directoryName = rawName.slice(0, -1);
      if (directoryName) {
        const path = validateArchivePath(directoryName, limits);
        if (seen.has(path)) throw new UpstreamAcquisitionError('path_collision', `ZIP archive contains duplicate path ${path}`);
        seen.add(path);
        if (includeDirectories) files.push({ path, kind: 'directory' });
      }
      cursor = recordEnd;
      continue;
    }
    if ((creatorOs === 3 && unixModeType === 0x4000) || ((creatorOs === 0 || creatorOs === 10) && dosDirectory)) {
      throw new UpstreamAcquisitionError('unsupported_archive', 'ZIP archive contains a directory entry');
    }
    const path = validateArchivePath(rawName, limits);
    if (seen.has(path)) throw new UpstreamAcquisitionError('path_collision', `ZIP archive contains duplicate path ${path}`);
    seen.add(path);
    if (localOffset + 30 > bytes.length || readU32(view, localOffset, 'ZIP local signature') !== 0x04034b50) {
      throw new UpstreamAcquisitionError('invalid_archive', 'ZIP local file header is malformed');
    }
    if (localOffset >= centralOffset) throw new UpstreamAcquisitionError('invalid_archive', 'ZIP local header overlaps its central directory');
    const localFlags = readU16(view, localOffset + 6, 'ZIP local flags');
    const localMethod = readU16(view, localOffset + 8, 'ZIP local compression method');
    const localCrc = readU32(view, localOffset + 14, 'ZIP local CRC');
    const localCompressedSize = readU32(view, localOffset + 18, 'ZIP local compressed size');
    const localUncompressedSize = readU32(view, localOffset + 22, 'ZIP local uncompressed size');
    const localNameLength = readU16(view, localOffset + 26, 'ZIP local name length');
    const localExtraLength = readU16(view, localOffset + 28, 'ZIP local extra length');
    const centralCrc = readU32(view, cursor + 16, 'ZIP CRC');
    const hasDataDescriptor = (flags & 0x8) !== 0;
    if (localFlags !== flags || localMethod !== method) {
      throw new UpstreamAcquisitionError('invalid_archive', 'ZIP local header does not match its central record');
    }
    if (hasDataDescriptor
      ? ((localCrc !== 0 && localCrc !== centralCrc)
        || (localCompressedSize !== 0 && localCompressedSize !== compressedSize)
        || (localUncompressedSize !== 0 && localUncompressedSize !== uncompressedSize))
      : (localCrc !== centralCrc || localCompressedSize !== compressedSize || localUncompressedSize !== uncompressedSize)) {
      throw new UpstreamAcquisitionError('invalid_archive', 'ZIP local header does not match its central record');
    }
    const localBoundary = nextZipLocalOffset(localOffsets, localOffset, centralOffset);
    if (localOffset + 30 + localNameLength + localExtraLength > localBoundary) {
      throw new UpstreamAcquisitionError('invalid_archive', 'ZIP local header is truncated');
    }
    const localName = bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength);
    if (!sameBytes(localName, filenameBytes)) {
      throw new UpstreamAcquisitionError('invalid_archive', 'ZIP local filename does not match its central record');
    }
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > localBoundary) throw new UpstreamAcquisitionError('invalid_archive', 'ZIP file data overlaps its next record');
    let entryEnd = dataEnd;
    if (hasDataDescriptor) {
      const descriptorBytes = localBoundary - dataEnd;
      const hasSignature = descriptorBytes === 16 && readU32(view, dataEnd, 'ZIP data descriptor signature') === 0x08074b50;
      const descriptorLength = hasSignature ? 16 : 12;
      if (descriptorBytes !== descriptorLength) {
        throw new UpstreamAcquisitionError('invalid_archive', 'ZIP data descriptor has an invalid boundary');
      }
      const descriptorOffset = hasSignature ? dataEnd + 4 : dataEnd;
      const descriptorCrc = readU32(view, descriptorOffset, 'ZIP data descriptor CRC');
      const descriptorCompressedSize = readU32(view, descriptorOffset + 4, 'ZIP data descriptor compressed size');
      const descriptorUncompressedSize = readU32(view, descriptorOffset + 8, 'ZIP data descriptor uncompressed size');
      if (descriptorCrc !== centralCrc || descriptorCompressedSize !== compressedSize || descriptorUncompressedSize !== uncompressedSize) {
        throw new UpstreamAcquisitionError('digest_mismatch', 'ZIP data descriptor does not match its central record');
      }
      entryEnd = dataEnd + descriptorLength;
    }
    const priorRange = dataRanges.find((range) => localOffset < range.end && entryEnd > range.start);
    if (priorRange) throw new UpstreamAcquisitionError('invalid_archive', 'ZIP file data overlaps another entry');
    dataRanges.push({ start: localOffset, end: entryEnd });
    let content: Uint8Array;
    try {
      content = method === 0
        ? bytes.slice(dataStart, dataEnd)
        : Uint8Array.from(inflateRawSync(Buffer.from(bytes.subarray(dataStart, dataEnd)), {
          maxOutputLength: Math.min(uncompressedSize, limits.maxFileBytes, WELL_KNOWN_MAX_ARCHIVE_BYTES),
        }));
    } catch {
      throw new UpstreamAcquisitionError('invalid_archive', `ZIP entry ${path} could not be decompressed`);
    }
    if (content.length !== uncompressedSize) throw new UpstreamAcquisitionError('size_mismatch', `ZIP entry ${path} size mismatch`);
    if (crc32Bytes(content) !== centralCrc) throw new UpstreamAcquisitionError('digest_mismatch', `ZIP entry ${path} CRC mismatch`);
    total += content.length;
    if (total > Math.min(limits.maxExpandedBytes, WELL_KNOWN_MAX_ARCHIVE_BYTES)) throw new UpstreamAcquisitionError('archive_limit', 'ZIP archive exceeds expanded size limits');
    files.push({ path, bytes: content, kind: 'file' });
    cursor = recordEnd;
  }
  if (cursor !== centralOffset + centralSize) throw new UpstreamAcquisitionError('invalid_archive', 'ZIP central directory size is inconsistent');
  return files;
}

function collectZipLocalOffsets(
  view: DataView,
  centralOffset: number,
  centralSize: number,
  entryCount: number,
): number[] {
  const centralEnd = centralOffset + centralSize;
  const offsets: number[] = [];
  const seen = new Set<number>();
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > centralEnd || readU32(view, cursor, 'ZIP central signature') !== 0x02014b50) {
      throw new UpstreamAcquisitionError('invalid_archive', 'ZIP central directory is malformed');
    }
    const nameLength = readU16(view, cursor + 28, 'ZIP file name length');
    const extraLength = readU16(view, cursor + 30, 'ZIP extra length');
    const commentLength = readU16(view, cursor + 32, 'ZIP comment length');
    const recordEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (recordEnd > centralEnd) throw new UpstreamAcquisitionError('invalid_archive', 'ZIP central directory record is truncated');
    const localOffset = readU32(view, cursor + 42, 'ZIP local header offset');
    if (localOffset >= centralOffset || seen.has(localOffset)) {
      throw new UpstreamAcquisitionError('invalid_archive', 'ZIP local header offsets are invalid');
    }
    seen.add(localOffset);
    offsets.push(localOffset);
    cursor = recordEnd;
  }
  if (cursor !== centralEnd) throw new UpstreamAcquisitionError('invalid_archive', 'ZIP central directory size is inconsistent');
  return offsets;
}

function nextZipLocalOffset(offsets: readonly number[], current: number, centralOffset: number): number {
  let boundary = centralOffset;
  for (const offset of offsets) {
    if (offset > current && offset < boundary) boundary = offset;
  }
  if (boundary <= current) throw new UpstreamAcquisitionError('invalid_archive', 'ZIP local header ordering is invalid');
  return boundary;
}

function findZipEndOfCentralDirectory(bytes: Uint8Array): number {
  const lower = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= lower; offset -= 1) {
    if (offset >= 0 && bytes[offset] === 0x50 && bytes[offset + 1] === 0x4b && bytes[offset + 2] === 0x05 && bytes[offset + 3] === 0x06) return offset;
  }
  return -1;
}

function readU16(view: DataView, offset: number, context: string): number {
  if (offset < 0 || offset + 2 > view.byteLength) throw new UpstreamAcquisitionError('invalid_archive', `${context} is truncated`);
  return view.getUint16(offset, true);
}

function readU32(view: DataView, offset: number, context: string): number {
  if (offset < 0 || offset + 4 > view.byteLength) throw new UpstreamAcquisitionError('invalid_archive', `${context} is truncated`);
  const value = view.getUint32(offset, true);
  if (!Number.isSafeInteger(value)) throw new UpstreamAcquisitionError('invalid_archive', `${context} is invalid`);
  return value;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function crc32Bytes(value: Uint8Array): number {
  let result = 0xffffffff;
  for (const byte of value) {
    result ^= byte;
    for (let bit = 0; bit < 8; bit += 1) result = (result >>> 1) ^ (result & 1 ? 0xedb88320 : 0);
  }
  return (result ^ 0xffffffff) >>> 0;
}

function extractTarArchive(bytes: Uint8Array, limits: AcquisitionLimits): Array<{ path: string; bytes: Uint8Array }>;
function extractTarArchive(bytes: Uint8Array, limits: AcquisitionLimits, includeDirectories: true): ArchiveEntry[];
function extractTarArchive(
  bytes: Uint8Array,
  limits: AcquisitionLimits,
  includeDirectories = false,
): ArchiveEntry[] {
  const files: ArchiveEntry[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let total = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (offset + 1_024 > bytes.length || !bytes.subarray(offset + 512, offset + 1_024).every((byte) => byte === 0)) {
        throw new UpstreamAcquisitionError('invalid_archive', 'tar archive has a truncated end-of-archive marker');
      }
      if (bytes.subarray(offset + 1_024).some((byte) => byte !== 0)) {
        throw new UpstreamAcquisitionError('invalid_archive', 'tar archive contains trailing data');
      }
      return files.length === 0
        ? (() => { throw new UpstreamAcquisitionError('source_not_found', 'tar archive contains no files'); })()
        : files;
    }
    if (!isTarHeaderMagic(header)) throw new UpstreamAcquisitionError('invalid_archive', 'tar archive has an invalid header magic');
    const storedChecksum = readTarOctal(header, 148, 8, 'tar checksum');
    let calculatedChecksum = 0;
    for (let index = 0; index < header.length; index += 1) calculatedChecksum += index >= 148 && index < 156 ? 0x20 : header[index]!;
    if (storedChecksum !== calculatedChecksum) throw new UpstreamAcquisitionError('digest_mismatch', 'tar archive header checksum does not match');
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const rawPath = prefix ? `${prefix}/${name}` : name;
    const size = readTarOctal(header, 124, 12, 'tar entry size');
    const type = header[156];
    if (!Number.isSafeInteger(size) || size < 0 || size > limits.maxFileBytes || size > WELL_KNOWN_MAX_ARCHIVE_BYTES) throw new UpstreamAcquisitionError('archive_limit', 'tar archive entry exceeds size limits');
    offset += 512;
    const blocks = Math.ceil(size / 512);
    const end = offset + blocks * 512;
    if (end > bytes.length) throw new UpstreamAcquisitionError('invalid_archive', 'tar archive is truncated');
    if (type === 0 || type === 0x30) {
      const path = validateArchivePath(rawPath, limits);
      if (seen.has(path)) throw new UpstreamAcquisitionError('path_collision', `tar archive contains duplicate path ${path}`);
      seen.add(path);
      const content = bytes.slice(offset, offset + size);
      total += content.length;
      if (total > Math.min(limits.maxExpandedBytes, WELL_KNOWN_MAX_ARCHIVE_BYTES)) throw new UpstreamAcquisitionError('archive_limit', 'tar archive exceeds expanded size limits');
      files.push({ path, bytes: content, kind: 'file' });
    } else if (type === 0x35) {
      if (rawPath) {
        const directoryPath = rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
        const path = validateArchivePath(directoryPath, limits);
        if (seen.has(path)) throw new UpstreamAcquisitionError('path_collision', `tar archive contains duplicate path ${path}`);
        seen.add(path);
        if (includeDirectories) files.push({ path, kind: 'directory' });
      }
    } else {
      throw new UpstreamAcquisitionError('unsupported_archive', 'tar archive contains a link or unsupported entry');
    }
    offset = end;
  }
  throw new UpstreamAcquisitionError('invalid_archive', 'tar archive is missing its end-of-archive marker');
}

function isTarHeaderMagic(header: Uint8Array): boolean {
  const magic = new TextDecoder('latin1').decode(header.subarray(257, 263));
  return magic === 'ustar\0' || magic === 'ustar ';
}

function readTarOctal(bytes: Uint8Array, start: number, length: number, context: string): number {
  const field = bytes.subarray(start, start + length);
  let end = field.length;
  while (end > 0 && (field[end - 1] === 0 || field[end - 1] === 0x20)) end -= 1;
  let begin = 0;
  while (begin < end && (field[begin] === 0 || field[begin] === 0x20)) begin += 1;
  if (begin === end) return 0;
  let result = 0;
  for (let index = begin; index < end; index += 1) {
    const digit = field[index]! - 0x30;
    if (digit < 0 || digit > 7) throw new UpstreamAcquisitionError('invalid_archive', `${context} is not strict octal`);
    result = result * 8 + digit;
    if (!Number.isSafeInteger(result)) throw new UpstreamAcquisitionError('invalid_archive', `${context} is too large`);
  }
  return result;
}

function readTarString(bytes: Uint8Array, start: number, length: number): string {
  const value = bytes.subarray(start, Math.min(bytes.length, start + length));
  const end = value.indexOf(0);
  const content = end >= 0 ? value.subarray(0, end) : value;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(content).trim(); } catch { throw new UpstreamAcquisitionError('invalid_archive', 'tar archive path is not valid UTF-8'); }
}

function validateArchivePath(value: string, limits: AcquisitionLimits): string {
  if (!value || value.startsWith('/') || value.startsWith('\\') || value.includes('\\') || value.includes('\0') || /^[A-Za-z]:/.test(value)) throw new UpstreamAcquisitionError('invalid_path', 'Archive contains an unsafe path');
  return validateSkillPath(value, limits, false);
}

async function acquireRegistry(input: NormalizedInput): Promise<AcquisitionResult> {
  const { upstream, importRequest, options } = input;
  const limits = mergeLimits(options.limits);
  const base = normalizeRegistryBase(upstream.baseUrl, options.allowLoopbackForTests);
  const identity = `${upstream.id}@${base.origin}${base.pathname}`;
  const chain = [...(options.registryChain ?? [])];
  const hop = options.registryHop ?? 0;
  if (!Number.isSafeInteger(hop) || hop < 0 || hop >= limits.maxRegistryHops) {
    throw new UpstreamAcquisitionError('proxy_hop_limit', 'Registry proxy hop limit exceeded');
  }
  if (chain.some((item) => item === identity || item === upstream.id || item === base.origin)) {
    throw new UpstreamAcquisitionError('proxy_cycle', `Registry proxy cycle detected at ${safeId(upstream.id)}`);
  }
  if (chain.length >= limits.maxRegistryHops) {
    throw new UpstreamAcquisitionError('proxy_hop_limit', 'Registry proxy chain is too long');
  }
  const nextChain = [...chain, identity];
  const serializedChain = nextChain.join(',');
  if (Buffer.byteLength(serializedChain, 'utf8') > MAX_CHAIN_BYTES) {
    throw new UpstreamAcquisitionError('proxy_hop_limit', 'Registry proxy chain is too large');
  }

  const credential = credentialHeader(upstream, 'registry');
  const fetchImpl = options.fetchImpl ?? options.fetch ?? DEFAULT_FETCH;
  const client = new HttpClient(fetchImpl, limits, options, base.origin);
  const headers: FetchHeaders = {
    accept: 'application/json',
    'content-type': 'application/json',
    'x-private-skills-proxy-hop': String(hop),
    'x-private-skills-proxy-chain': serializedChain,
  };
  if (credential) headers.authorization = credential;

  const requestedRef = importRequest.path || importRequest.name;
  const resolutionPayload = {
    kind: 'skill',
    ref: requestedRef,
    ...(importRequest.version ? { version: importRequest.version } : {}),
  };
  const resolveURL = appendBasePath(base, ['v1', 'resolve']);
  const resolvedResponse = await client.jsonWithHeaders<{ resolution?: unknown }>(resolveURL, {
    method: 'POST',
    headers,
    body: JSON.stringify(resolutionPayload),
    allowedOrigin: base.origin,
    retryable: false,
  });
  enforceRemoteProxyHeaders(resolvedResponse.response.headers, identity, nextChain, hop, limits);
  const resolution = parseResolution(resolvedResponse.value?.resolution);
  const expectedDigest = requireSha256Digest(resolution.digest, 'registry resolution');
  const resourceId = requireString(resolution.resourceId, 'registry resolution resourceId');

  const authURL = appendBasePath(base, ['v1', 'install-authorizations']);
  const authResponse = await client.jsonWithHeaders<{ authorization?: unknown }>(authURL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ resolution }),
    allowedOrigin: base.origin,
    retryable: false,
  });
  enforceRemoteProxyHeaders(authResponse.response.headers, identity, nextChain, hop, limits);
  const authorization = parseAuthorization(authResponse.value?.authorization);
  const authorizationId = requireString(authorization.id, 'registry authorization id');
  assertAuthorizationMatchesResolution(authorization, resolution);

  const downloadURL = appendBasePath(base, ['v1', 'artifacts', expectedDigest, 'download']);
  const descriptorResponse = await client.jsonWithHeaders<Record<string, unknown>>(downloadURL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ resourceId, authorizationId }),
    allowedOrigin: base.origin,
    retryable: false,
  });
  enforceRemoteProxyHeaders(descriptorResponse.response.headers, identity, nextChain, hop, limits);
  const descriptor = parseTransferDescriptor(
    descriptorResponse.value?.descriptor ?? descriptorResponse.value?.transferDescriptor ?? descriptorResponse.value?.transfer ?? descriptorResponse.value,
  );
  const descriptorDigest = requireSha256Digest(descriptor.digest, 'registry transfer descriptor');
  if (descriptorDigest !== expectedDigest) {
    throw new UpstreamAcquisitionError(
      'digest_mismatch',
      'Registry transfer descriptor digest does not match its resolution',
    );
  }
  if (descriptor.expiresAt) {
    const expires = Date.parse(descriptor.expiresAt);
    if (!Number.isFinite(expires) || expires <= Date.now()) {
      throw new UpstreamAcquisitionError('transfer_expired', 'Registry transfer descriptor is expired');
    }
  }
  if (descriptor.size !== undefined && descriptor.size > limits.maxResponseBytes) {
    throw new UpstreamAcquisitionError('response_size_limit', 'Registry transfer exceeds response limit');
  }

  const transferURL = resolveDescriptorURL(descriptor.url, base, options.allowLoopbackForTests ?? false);
  const transferHeaders = sanitizeTransferHeaders(descriptor.headers);
  const transfer = await client.bytes(transferURL, {
    method: descriptor.method,
    headers: transferHeaders,
    allowedOrigin: base.origin,
    allowCrossOriginRedirectWithoutAuth: true,
    retryable: false,
  });
  if (Number.isSafeInteger(descriptor.size) && descriptor.size !== transfer.bytes.length) {
    throw new UpstreamAcquisitionError(
      'size_mismatch',
      'Registry transfer byte count does not match its descriptor',
    );
  }
  if (transfer.bytes.length > limits.maxResponseBytes) {
    throw new UpstreamAcquisitionError('response_size_limit', 'Registry transfer exceeds response limit');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(transfer.bytes));
  } catch {
    throw new UpstreamAcquisitionError('invalid_bundle', 'Registry transfer is not valid UTF-8 JSON');
  }
  const bundle = validateSkillBundle(parsed, limits);
  const actualDigest = digestBytes(serializeSkillBundle(bundle));
  if (actualDigest !== expectedDigest) {
    throw new UpstreamAcquisitionError(
      'digest_mismatch',
      'Registry artifact bytes do not match the resolved digest',
    );
  }
  return {
    bundle,
    provenance: {
      kind: 'registry',
      upstreamId: upstream.id,
      repository: base.origin,
      path: requestedRef,
      revision: expectedDigest,
      sourceDigest: expectedDigest,
    },
  };
}

function mergeLimits(input?: Partial<AcquisitionLimits>): NormalizedLimits {
  const limits = { ...DEFAULT_ACQUISITION_LIMITS, ...(input ?? {}) };
  const positiveKeys: Array<keyof AcquisitionLimits> = [
    'maxFiles',
    'maxFileBytes',
    'maxExpandedBytes',
    'maxPathBytes',
    'maxResponseBytes',
    'maxRedirects',
    'maxAttempts',
    'concurrency',
    'maxRequestsPerSecond',
    'requestTimeoutMs',
    'maxRegistryHops',
  ];
  for (const key of positiveKeys) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0) {
      throw new UpstreamAcquisitionError('invalid_limits', `Invalid acquisition limit ${key}`);
    }
  }
  if (!Number.isSafeInteger(limits.maxBinaryBytes) || limits.maxBinaryBytes < 0 || !Number.isSafeInteger(limits.maxBinaryTotalBytes) || limits.maxBinaryTotalBytes < 0 || !Number.isSafeInteger(limits.maxBinaryFiles) || limits.maxBinaryFiles < 0) {
    throw new UpstreamAcquisitionError('invalid_limits', 'Invalid acquisition limit maxBinaryBytes');
  }
  return limits;
}

function normalizeRepository(repositoryInput: string | undefined, allowlist: string[] | undefined): string {
  if (!allowlist || allowlist.length === 0) {
    throw new UpstreamAcquisitionError('repository_denied', 'GitHub upstream has no repository allowlist');
  }
  // A single-repository mapping may omit the redundant repository field.  A
  // multi-repository mapping must name the selected repository explicitly so
  // the worker never guesses across an administrator allowlist.
  const requested = typeof repositoryInput === 'string' && repositoryInput.trim() !== ''
    ? repositoryInput
    : allowlist.length === 1
      ? allowlist[0]
      : undefined;
  if (!requested) {
    throw new UpstreamAcquisitionError('repository_required', 'GitHub imports require a repository');
  }
  const repository = normalizeRepositoryIdentity(requested);
  const allowed = allowlist.map(normalizeRepositoryIdentity);
  if (!allowed.some((entry) => entry.toLocaleLowerCase('en-US') === repository.toLocaleLowerCase('en-US'))) {
    throw new UpstreamAcquisitionError('repository_denied', `Repository ${repository} is not allowlisted`);
  }
  return repository;
}

function normalizeRepositoryIdentity(value: string): string {
  let candidate = value.trim();
  if (candidate.startsWith('https://') || candidate.startsWith('http://')) {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      throw new UpstreamAcquisitionError('invalid_repository', 'Invalid GitHub repository URL');
    }
    if (url.protocol !== 'https:' || url.hostname.toLocaleLowerCase('en-US') !== 'github.com' || url.username || url.password || url.search || url.hash) {
      throw new UpstreamAcquisitionError('invalid_repository', 'GitHub repository URL is not an approved identity');
    }
    candidate = url.pathname;
  } else if (candidate.startsWith('github.com/')) {
    candidate = candidate.slice('github.com/'.length);
  }
  candidate = candidate.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  const parts = candidate.split('/');
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..')) {
    throw new UpstreamAcquisitionError('invalid_repository', 'GitHub repository must be owner/name');
  }
  return `${parts[0]}/${parts[1]}`;
}

function validateSourceDirectory(pathInput: string | undefined, limits: AcquisitionLimits): string {
  if (typeof pathInput !== 'string') {
    throw new UpstreamAcquisitionError('path_required', 'Upstream imports require a path');
  }
  if (pathInput === '') return '';
  if (pathInput.includes('\\') || pathInput.startsWith('/') || pathInput.endsWith('/')) {
    throw new UpstreamAcquisitionError('invalid_path', `Unsafe source directory ${JSON.stringify(pathInput)}`);
  }
  const path = pathInput;
  if (path === '') return '';
  validateSkillPath(path, limits);
  return path;
}

function validateRef(ref: string | undefined): string {
  const value = ref?.trim() || '';
  if (!value || value.length > 256 || value.includes('\0') || value.startsWith('-')) {
    throw new UpstreamAcquisitionError('ref_required', 'GitHub imports require a safe commit, branch, or tag ref');
  }
  if (value.includes('..') && !/^[0-9a-f]{40}$/i.test(value)) {
    throw new UpstreamAcquisitionError('invalid_ref', 'GitHub ref contains a disallowed traversal sequence');
  }
  return value;
}

function validateSkillPath(pathInput: string, limits: AcquisitionLimits, rejectReserved = true): string {
  if (typeof pathInput !== 'string' || pathInput.length === 0) {
    throw new UpstreamAcquisitionError('invalid_path', 'Bundle paths cannot be empty');
  }
  if (hasLoneSurrogate(pathInput) || pathInput.includes('\0') || pathInput.includes('\\') || /[\u0000-\u001f\u007f]/.test(pathInput) || pathInput.startsWith('/') || /^[A-Za-z]:/.test(pathInput) || pathInput.startsWith('//')) {
    throw new UpstreamAcquisitionError('invalid_path', `Unsafe bundle path ${JSON.stringify(pathInput)}`);
  }
  const path = pathInput.normalize('NFC');
  const pathBytes = Buffer.byteLength(path, 'utf8');
  if (pathBytes > limits.maxPathBytes) {
    throw new UpstreamAcquisitionError('path_length_limit', `Bundle path exceeds ${limits.maxPathBytes} bytes`);
  }
  const parts = path.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..' || part.endsWith('.') || part.endsWith(' ') || part.includes(':') || /[<>"|?*]/.test(part))) {
    throw new UpstreamAcquisitionError('invalid_path', `Unsafe bundle path ${JSON.stringify(pathInput)}`);
  }
  for (const part of parts) {
    const stem = part.split('.')[0].toLocaleUpperCase('en-US');
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) {
      throw new UpstreamAcquisitionError('invalid_path', `Windows reserved path segment ${JSON.stringify(part)}`);
    }
  }
  if (rejectReserved) {
    const reserved = new Set(['.claude-plugin', '.agents', '.codex', '.cursor', '.windsurf', '.mcp']);
    if (parts.some((part) => reserved.has(part.toLocaleLowerCase('en-US')) || part.toLocaleLowerCase('en-US') === '.mcp.json')) {
      throw new UpstreamAcquisitionError('plugin_payload', `Agent-reserved directory in ${JSON.stringify(path)} is not skill content`);
    }
  }
  return path;
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

function selectTreeEntries(tree: unknown[], selectedPath: string, limits: AcquisitionLimits): GitTreeEntry[] {
  const prefix = selectedPath ? `${selectedPath}/` : '';
  const result: GitTreeEntry[] = [];
  for (const raw of tree) {
    if (!isRecord(raw) || typeof raw.path !== 'string') {
      throw new UpstreamAcquisitionError('invalid_source', 'GitHub tree contains a malformed entry');
    }
    const path = raw.path;
    if (!path.startsWith(prefix) || path === selectedPath) continue;
    const relative = prefix ? path.slice(prefix.length) : path;
    if (!relative) continue;
    const mode = typeof raw.mode === 'string' ? raw.mode : '';
    const type = typeof raw.type === 'string' ? raw.type : '';
    if (type === 'tree') continue;
    if (type !== 'blob' || mode === '120000' || mode === '160000') {
      throw new UpstreamAcquisitionError('unsupported_source_entry', `GitHub entry ${JSON.stringify(path)} is not a regular file`);
    }
    if (mode !== '100644' && mode !== '100755') {
      throw new UpstreamAcquisitionError('unsupported_source_entry', `GitHub entry ${JSON.stringify(path)} has an unsupported file mode`);
    }
    const safePath = validateSkillPath(relative, limits);
    result.push({
      path: safePath,
      mode,
      type,
      sha: raw.sha,
      size: raw.size,
      url: raw.url,
    });
    if (result.length > limits.maxFiles) {
      throw new UpstreamAcquisitionError('file_count_limit', `Selected directory contains more than ${limits.maxFiles} files`);
    }
  }
  return result;
}

function decodeGithubBlob(blob: GitHubBlobResponse, entry: GitTreeEntry, limits: AcquisitionLimits): {
  path: string;
  content: string;
  bytes: Uint8Array;
  executable?: boolean;
} {
  if (blob.encoding !== 'base64' || typeof blob.content !== 'string') {
    throw new UpstreamAcquisitionError('invalid_source', `GitHub blob ${String(entry.path)} is not base64`);
  }
  const clean = blob.content.replace(/\s+/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(clean)) {
    throw new UpstreamAcquisitionError('invalid_source', `GitHub blob ${String(entry.path)} has invalid base64`);
  }
  const bytes = Uint8Array.from(Buffer.from(clean, 'base64'));
  if (bytes.length > limits.maxFileBytes) {
    throw new UpstreamAcquisitionError('file_size_limit', `GitHub file ${String(entry.path)} exceeds the per-file limit`);
  }
  if (blob.size !== undefined && (typeof blob.size !== 'number' || !Number.isSafeInteger(blob.size) || blob.size < 0)) {
    throw new UpstreamAcquisitionError('invalid_source', `GitHub blob ${String(entry.path)} has an invalid size`);
  }
  if (typeof entry.size === 'number' && entry.size !== bytes.length) {
    throw new UpstreamAcquisitionError('size_mismatch', `GitHub file ${String(entry.path)} size changed during acquisition`);
  }
  if (typeof blob.size === 'number' && blob.size !== bytes.length) {
    throw new UpstreamAcquisitionError('size_mismatch', `GitHub blob ${String(entry.path)} size is inconsistent`);
  }
  if (typeof blob.sha === 'string' && blob.sha.toLocaleLowerCase('en-US') !== String(entry.sha).toLocaleLowerCase('en-US')) {
    throw new UpstreamAcquisitionError('digest_mismatch', `GitHub blob ${String(entry.path)} response digest mismatch`);
  }
  const declaredSha = typeof entry.sha === 'string' ? entry.sha : '';
  if (/^[0-9a-f]{40}$/i.test(declaredSha)) {
    const gitObject = Buffer.concat([Buffer.from(`blob ${bytes.length}\0`, 'utf8'), Buffer.from(bytes)]);
    const actualSha = createHash('sha1').update(gitObject).digest('hex');
    if (actualSha !== declaredSha.toLocaleLowerCase('en-US')) {
      throw new UpstreamAcquisitionError('digest_mismatch', `GitHub blob ${String(entry.path)} digest mismatch`);
    }
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let validText = true;
  try {
    decoder.decode(bytes);
  } catch {
    validText = false;
    if (bytes.length > limits.maxBinaryBytes) {
      throw new UpstreamAcquisitionError('binary_size_limit', `GitHub binary file ${String(entry.path)} exceeds its limit`);
    }
  }
  if (containsBinaryMarker(bytes)) validText = false;
  if (!validText && entry.path === 'SKILL.md') {
    throw new UpstreamAcquisitionError('binary_file', 'Root SKILL.md must be valid UTF-8 text');
  }
  const mode = typeof entry.mode === 'string' ? entry.mode : '';
  return {
    path: String(entry.path),
    content: Buffer.from(bytes).toString('base64'),
    bytes,
    ...(mode === '100755' ? { executable: true } : {}),
  };
}

function containsBinaryMarker(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte === 0) return true;
  }
  return false;
}

function isCanonicalBase64(value: string): boolean {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  return Buffer.from(value, 'base64').toString('base64') === value;
}

function isBinaryBytes(bytes: Uint8Array): boolean {
  if (containsBinaryMarker(bytes)) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return false;
  } catch {
    return true;
  }
}

function normalizeSkillsShBase(value: string | undefined, allowLoopbackForTests = false): URL {
  return parseFixedBase(value?.trim() || 'https://skills.sh', allowLoopbackForTests);
}

function appendSkillsShDetailPath(base: URL, externalId: string): URL {
  const parts = externalId.split('/');
  return appendBasePath(base, ['api', 'v1', 'skills', ...parts]);
}

function validateSkillsShId(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || new TextEncoder().encode(value).byteLength > 2_048 || value.trim() !== value || !isWellFormedUnicode(value) || /[\u0000-\u001f\u007f?#%\\]/u.test(value) || value.startsWith('/') || value.endsWith('/') || value.includes('//')) {
    throw new UpstreamAcquisitionError('invalid_source', 'skills.sh external id is invalid');
  }
  const parts = value.split('/');
  if (parts.length < 2 || parts.length > 64 || parts.some((part) => !isSafeSkillsShIdSegment(part))) {
    throw new UpstreamAcquisitionError('invalid_source', 'skills.sh external id must be a safe source/slug path');
  }
  return parts.join('/');
}

function isSafeSkillsShIdSegment(value: string): boolean {
  return value.length > 0 && value !== '.' && value !== '..' && new TextEncoder().encode(value).byteLength <= 512;
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function requireSkillsShString(value: unknown, context: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength || /[\u0000\r\n]/.test(value)) {
    throw new UpstreamAcquisitionError('invalid_source', `${context} is invalid`);
  }
  return value;
}

function requireSkillsShURL(value: unknown, context: string, allowRelative = false): string {
  if (typeof value !== 'string' || value.length > 8_192) throw new UpstreamAcquisitionError('invalid_source', `${context} is invalid`);
  let url: URL;
  try { url = allowRelative ? new URL(value, 'https://skills.sh') : new URL(value); } catch { throw new UpstreamAcquisitionError('invalid_source', `${context} must be an absolute URL`); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:' || url.username || url.password || url.search || url.hash) {
    throw new UpstreamAcquisitionError('unsafe_url', `${context} is unsafe`);
  }
  return url.toString();
}

function normalizeGithubApiBase(value: string | undefined, allowLoopbackForTests = false): URL {
  const candidate = value?.trim() || GITHUB_API_ORIGIN;
  const base = parseFixedBase(candidate, allowLoopbackForTests);
  if (!allowLoopbackForTests && base.origin !== GITHUB_API_ORIGIN) {
    // GitHub Enterprise remains safe only when explicitly configured as the
    // administrator's fixed API base.  It must still be HTTPS/public.
    if (base.protocol !== 'https:') {
      throw new UpstreamAcquisitionError('invalid_upstream_base', 'GitHub API base must use HTTPS');
    }
  }
  return base;
}

function normalizeRegistryBase(value: string | undefined, allowLoopbackForTests = false): URL {
  if (!value) {
    throw new UpstreamAcquisitionError('invalid_upstream_base', 'Registry upstream requires a fixed baseUrl');
  }
  return parseFixedBase(value, allowLoopbackForTests);
}

function parseFixedBase(value: string, allowLoopbackForTests: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UpstreamAcquisitionError('invalid_upstream_base', 'Upstream base URL is invalid');
  }
  const loopback = isLoopbackHost(url.hostname);
  if ((!allowLoopbackForTests || !loopback) && url.protocol !== 'https:') {
    throw new UpstreamAcquisitionError('insecure_upstream', 'Upstream connections require HTTPS');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new UpstreamAcquisitionError('invalid_upstream_base', 'Upstream base URL cannot contain credentials or query data');
  }
  if (!url.hostname || url.port && !/^\d+$/.test(url.port)) {
    throw new UpstreamAcquisitionError('invalid_upstream_base', 'Upstream base URL has an invalid host');
  }
  url.pathname = url.pathname.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
  return url;
}

function appendApiPath(base: URL, parts: string[], query?: Record<string, string>): URL {
  const url = appendBasePath(base, parts);
  if (query) {
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  }
  return url;
}

function appendBasePath(base: URL, parts: string[]): URL {
  const prefix = base.pathname === '/' ? '' : base.pathname.replace(/\/$/, '');
  const encoded = parts.map((part) => encodeURIComponent(part)).join('/');
  return new URL(`${prefix}/${encoded}`, base.origin);
}

/**
 * Resolve the catalog credential without allowing a request-scoped provider
 * token to escape the canonical skills.sh API origin.  An injected callback
 * takes precedence over the legacy explicit environment reference when it is
 * applicable; a failed callback is terminal so an expired/stale ambient token
 * cannot silently replace it.
 */
async function skillsShCatalogCredential(
  upstream: Upstream,
  apiBase: URL,
  options: AcquireSkillOptions,
  timeoutMs: number,
): Promise<string | undefined> {
  if (options.skillsShGatewayCredentials !== undefined) {
    const credentials = options.skillsShGatewayCredentials;
    if (!Array.isArray(credentials)) {
      throw new UpstreamAcquisitionError(
        'invalid_credential_ref',
        'skills.sh gateway credential configuration is invalid',
      );
    }
    const configuredCredentials: unknown[] = [...credentials];
    if (options.skillsShGatewayCredential !== undefined) configuredCredentials.push(options.skillsShGatewayCredential);
    const gateways = normalizeSkillsShGatewayCredentials(
      configuredCredentials,
      options.allowLoopbackForTests ?? false,
    );
    const matching = gateways.find((gateway) => sameCatalogBase(apiBase, gateway.base));

    // The official service has one credential path: the request-scoped OIDC
    // callback. Never route a configured gateway token to skills.sh, even if
    // the gateway list contains a malformed official alias (which validation
    // above rejects before any request is started).
    if (isCanonicalSkillsShCatalogBase(apiBase)) {
      if (options.getSkillsShToken !== undefined) {
        const token = await resolveSkillsShToken(options, timeoutMs);
        return `Bearer ${token}`;
      }
      throw new UpstreamAcquisitionError(
        'credential_missing',
        'skills.sh catalog authentication is unavailable',
      );
    }

    if (matching === undefined) {
      // A configured multi-feed profile is authoritative. Falling through to
      // upstream.credentialEnv (or an anonymous request) would let a job
      // select a sibling tenant while silently using another feed's secret.
      throw new UpstreamAcquisitionError(
        'credential_missing',
        'skills.sh gateway credential is unavailable for this catalog base',
      );
    }
    const token = await resolveSkillsShGatewayToken(matching.credential.getToken, options, timeoutMs);
    return `Bearer ${token}`;
  }

  const gateway = options.skillsShGatewayCredential;
  if (gateway !== undefined) {
    const gatewayBase = normalizeSkillsShGatewayCredentialBase(
      gateway,
      options.allowLoopbackForTests ?? false,
    );
    if (isCanonicalSkillsShOrigin(gatewayBase)) {
      // A gateway credential is never allowed to masquerade as the official
      // skills.sh credential, including www/trailing-dot aliases.  The
      // request-scoped OIDC callback below is the only credential path for
      // the canonical service.
      throw new UpstreamAcquisitionError(
        'invalid_credential_ref',
        'skills.sh gateway credential cannot target the canonical skills.sh origin',
      );
    }
    if (sameCatalogBase(apiBase, gatewayBase)) {
      const token = await resolveSkillsShGatewayToken(gateway.getToken, options, timeoutMs);
      return `Bearer ${token}`;
    }
    // An explicitly supplied gateway credential is bound to one exact
    // origin/path. Never fall back to an ambient credentialEnv token when the
    // claimed source points elsewhere; that would silently defeat the
    // credential binding and could forward a secret to a sibling catalog.
    if (isCanonicalSkillsShCatalogBase(apiBase) && options.getSkillsShToken !== undefined) {
      const token = await resolveSkillsShToken(options, timeoutMs);
      return `Bearer ${token}`;
    }
    return undefined;
  }
  if (isCanonicalSkillsShCatalogBase(apiBase) && options.getSkillsShToken !== undefined) {
    const token = await resolveSkillsShToken(options, timeoutMs);
    return `Bearer ${token}`;
  }
  // Keep the existing explicit operator configuration for non-canonical
  // fixtures/private destinations.  It is intentionally not a fallback for
  // a request-scoped callback failure above.
  return credentialHeader(upstream, 'skills-sh');
}

const MAX_SKILLS_SH_GATEWAY_CREDENTIALS = 16;

interface NormalizedSkillsShGatewayCredential {
  credential: SkillsShGatewayCredential;
  base: URL;
}

/**
 * Validate a multi-feed profile before selecting a request credential. The
 * full normalized origin and pathname are the identity key; two callbacks
 * bound to the same key are ambiguous even when their token values differ.
 */
function normalizeSkillsShGatewayCredentials(
  credentials: readonly unknown[],
  allowLoopbackForTests: boolean,
): NormalizedSkillsShGatewayCredential[] {
  if (!Array.isArray(credentials) || credentials.length > MAX_SKILLS_SH_GATEWAY_CREDENTIALS) {
    throw new UpstreamAcquisitionError(
      'invalid_credential_ref',
      'skills.sh gateway credential configuration is invalid',
    );
  }

  const normalized: NormalizedSkillsShGatewayCredential[] = [];
  const seen = new Set<string>();
  for (const credential of credentials) {
    const base = normalizeSkillsShGatewayCredentialBase(
      credential as SkillsShGatewayCredential,
      allowLoopbackForTests,
    );
    if (isCanonicalSkillsShOrigin(base)) {
      throw new UpstreamAcquisitionError(
        'invalid_credential_ref',
        'skills.sh gateway credential cannot target the canonical skills.sh origin',
      );
    }
    const key = `${base.origin}${base.pathname}`;
    if (seen.has(key)) {
      throw new UpstreamAcquisitionError(
        'invalid_credential_ref',
        'skills.sh gateway credential configuration contains duplicate bases',
      );
    }
    seen.add(key);
    normalized.push({ credential: credential as SkillsShGatewayCredential, base });
  }
  return normalized;
}

function isCanonicalSkillsShCatalogBase(apiBase: URL): boolean {
  return apiBase.origin === SKILLS_SH_CANONICAL_ORIGIN && apiBase.pathname === '/';
}

/**
 * Treat the complete normalized origin and pathname as the gateway binding.
 * URL normalization removes harmless trailing slashes, while parseFixedBase
 * rejects credentials, query data, fragments, and insecure non-loopback
 * destinations before the callback can be considered.
 */
function normalizeSkillsShGatewayCredentialBase(
  credential: SkillsShGatewayCredential,
  allowLoopbackForTests: boolean,
): URL {
  if (typeof credential !== 'object' || credential === null || typeof credential.baseUrl !== 'string' || typeof credential.getToken !== 'function') {
    throw new UpstreamAcquisitionError('invalid_credential_ref', 'skills.sh gateway credential is invalid');
  }
  try {
    return parseFixedBase(credential.baseUrl.trim(), allowLoopbackForTests);
  } catch {
    throw new UpstreamAcquisitionError('invalid_credential_ref', 'skills.sh gateway credential base is invalid');
  }
}

function sameCatalogBase(left: URL, right: URL): boolean {
  return left.origin === right.origin && left.pathname === right.pathname;
}

function isCanonicalSkillsShOrigin(value: URL): boolean {
  return value.protocol === 'https:' && isReservedSkillsDirectoryHost(value);
}

async function resolveSkillsShToken(
  options: AcquireSkillOptions,
  timeoutMs: number,
): Promise<string> {
  const provider = options.getSkillsShToken;
  if (provider === undefined) {
    throw new UpstreamAcquisitionError('credential_missing', 'skills.sh catalog authentication is unavailable');
  }
  return resolveCatalogToken(provider, options, timeoutMs);
}

async function resolveSkillsShGatewayToken(
  provider: SkillsShGatewayCredential['getToken'],
  options: AcquireSkillOptions,
  timeoutMs: number,
): Promise<string> {
  const token = await resolveCatalogToken(provider, options, timeoutMs);
  if (!isValidSkillsShGatewayToken(token)) {
    throw new UpstreamAcquisitionError('invalid_credential', 'skills.sh gateway credential is invalid');
  }
  return token;
}

async function resolveCatalogToken(
  provider: (signal?: AbortSignal) => Promise<unknown>,
  options: AcquireSkillOptions,
  timeoutMs: number,
): Promise<string> {
  if (options.signal?.aborted) {
    throw new UpstreamAcquisitionError('cancelled', 'Upstream acquisition cancelled');
  }

  const controller = new AbortController();
  let timedOut = false;
  let callerAborted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onCallerAbort: (() => void) | undefined;

  const providerPromise = Promise.resolve().then(() => provider(controller.signal));
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error('skills.sh catalog credential timeout'));
    }, timeoutMs);
  });
  const cancellationPromise = options.signal === undefined
    ? undefined
    : new Promise<never>((_, reject) => {
      onCallerAbort = () => {
        callerAborted = true;
        controller.abort(options.signal?.reason);
        reject(new Error('skills.sh catalog credential cancelled'));
      };
      options.signal!.addEventListener('abort', onCallerAbort, { once: true });
    });

  let token: unknown;
  try {
    const pending: Array<Promise<unknown>> = [providerPromise, timeoutPromise];
    if (cancellationPromise !== undefined) pending.push(cancellationPromise);
    token = await Promise.race(pending);
  } catch {
    if (callerAborted || options.signal?.aborted) {
      throw new UpstreamAcquisitionError('cancelled', 'Upstream acquisition cancelled');
    }
    if (timedOut) {
      throw new UpstreamAcquisitionError('credential_timeout', 'skills.sh catalog authentication timed out');
    }
    // Do not include provider exception text: official helpers can include
    // credential-bearing diagnostics.  The caller receives a stable message.
    throw new UpstreamAcquisitionError('credential_unavailable', 'skills.sh catalog authentication unavailable');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onCallerAbort !== undefined) options.signal?.removeEventListener('abort', onCallerAbort);
  }

  if (typeof token !== 'string' || token.trim().length === 0 || Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES || /[\r\n]/.test(token)) {
    throw new UpstreamAcquisitionError('invalid_credential', 'skills.sh catalog authentication token is invalid');
  }
  return token;
}

function credentialHeader(upstream: Upstream, _source: 'github' | 'registry' | 'skills-sh'): string | undefined {
  const name = upstream.credentialEnv;
  if (name === undefined || name === '') return undefined;
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
    throw new UpstreamAcquisitionError('invalid_credential_ref', 'credentialEnv must be a named environment variable');
  }
  const value = process.env[name];
  if (!value) {
    throw new UpstreamAcquisitionError('credential_missing', `Credential environment variable ${name} is not set`);
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_TOKEN_BYTES || /[\r\n]/.test(value)) {
    throw new UpstreamAcquisitionError('invalid_credential', 'Configured upstream credential is invalid');
  }
  return `Bearer ${value}`;
}

function parseResolution(value: unknown): RegistryResolution {
  if (!isRecord(value) || value.kind !== 'skill') {
    throw new UpstreamAcquisitionError('invalid_registry_response', 'Registry resolve did not return a skill resolution');
  }
  if (value.digest !== undefined) requireSha256Digest(value.digest, 'registry resolution');
  return value as RegistryResolution;
}

function parseAuthorization(value: unknown): RegistryAuthorization {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.length === 0 || value.id.length > 256 || /[\r\n]/.test(value.id)) {
    throw new UpstreamAcquisitionError('invalid_registry_response', 'Registry install authorization is invalid');
  }
  return value as RegistryAuthorization;
}

function assertAuthorizationMatchesResolution(
  authorization: RegistryAuthorization,
  resolution: RegistryResolution,
): void {
  if (authorization.organizationId !== undefined && authorization.organizationId !== resolution.organizationId) {
    throw new UpstreamAcquisitionError(
      'invalid_registry_response',
      'Registry install authorization belongs to a different organization',
    );
  }
  if (authorization.resolution === undefined) return;
  if (!isRecord(authorization.resolution)) {
    throw new UpstreamAcquisitionError('invalid_registry_response', 'Registry install authorization resolution is invalid');
  }
  const authorized = authorization.resolution;
  if (
    authorized.kind !== resolution.kind ||
    authorized.resourceId !== resolution.resourceId ||
    authorized.digest !== resolution.digest ||
    (authorized.organizationId !== undefined && authorized.organizationId !== resolution.organizationId)
  ) {
    throw new UpstreamAcquisitionError(
      'invalid_registry_response',
      'Registry install authorization does not match the resolved artifact',
    );
  }
}

interface ParsedTransferDescriptor {
  mode?: unknown;
  url: string;
  method: 'GET';
  headers: Record<string, unknown>;
  expiresAt?: string;
  size?: number;
  digest: string;
  rangeSupported?: boolean;
}

function parseTransferDescriptor(value: unknown): ParsedTransferDescriptor {
  if (!isRecord(value) || typeof value.url !== 'string' || value.url.length > 8_192 || (value.method !== undefined && value.method !== 'GET')) {
    throw new UpstreamAcquisitionError('invalid_registry_response', 'Registry transfer descriptor is invalid');
  }
  const headers = value.headers === undefined ? {} : value.headers;
  if (!isRecord(headers)) {
    throw new UpstreamAcquisitionError('invalid_registry_response', 'Registry transfer descriptor headers are invalid');
  }
  if (value.size !== undefined && (!Number.isSafeInteger(value.size) || value.size < 0)) {
    throw new UpstreamAcquisitionError('invalid_registry_response', 'Registry transfer descriptor size is invalid');
  }
  const digest = requireSha256Digest(value.digest, 'registry transfer descriptor');
  let expiresAt: string | undefined;
  if (value.expiresAt !== undefined) {
    if (typeof value.expiresAt !== 'string' || value.expiresAt.length > 128 || /[\r\n]/.test(value.expiresAt)) {
      throw new UpstreamAcquisitionError('invalid_registry_response', 'Registry transfer descriptor expiry is invalid');
    }
    expiresAt = value.expiresAt;
  }
  return {
    ...value,
    method: 'GET',
    headers,
    ...(value.size === undefined ? {} : { size: value.size as number }),
    digest,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    url: value.url,
  };
}

function sanitizeTransferHeaders(value: Record<string, unknown>): FetchHeaders {
  const headers: FetchHeaders = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || typeof raw !== 'string' || raw.length > 8_192 || /[\r\n]/.test(raw)) {
      throw new UpstreamAcquisitionError('invalid_registry_response', 'Registry transfer descriptor has unsafe headers');
    }
    const lower = key.toLocaleLowerCase('en-US');
    if (
      lower === 'host' ||
      lower === 'cookie' ||
      lower === 'authorization' ||
      lower === 'proxy-authorization' ||
      lower === 'content-length' ||
      lower === 'connection'
    ) continue;
    headers[key] = raw;
  }
  return headers;
}

function resolveDescriptorURL(value: string, base: URL, allowLoopbackForTests: boolean): URL {
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    throw new UpstreamAcquisitionError('invalid_registry_response', 'Registry transfer URL is invalid');
  }
  assertSafeURL(url, allowLoopbackForTests);
  return url;
}

function enforceRemoteProxyHeaders(
  headers: Headers,
  identity: string,
  chain: string[],
  hop: number,
  limits: AcquisitionLimits,
): void {
  const remoteHopRaw = headers.get('x-private-skills-proxy-hop');
  if (remoteHopRaw !== null && (!/^\d+$/.test(remoteHopRaw) || Number(remoteHopRaw) >= limits.maxRegistryHops || Number(remoteHopRaw) < hop)) {
    throw new UpstreamAcquisitionError('proxy_hop_limit', 'Remote registry returned an invalid proxy hop');
  }
  const remoteChainRaw = headers.get('x-private-skills-proxy-chain');
  if (remoteChainRaw !== null) {
    if (remoteChainRaw.length > MAX_CHAIN_BYTES) throw new UpstreamAcquisitionError('proxy_hop_limit', 'Remote proxy chain is too large');
    const remoteChain = remoteChainRaw.split(',').map((item) => item.trim()).filter(Boolean);
    const distinct = new Set(remoteChain);
    if (distinct.size !== remoteChain.length) {
      throw new UpstreamAcquisitionError('proxy_cycle', 'Remote registry reported a proxy cycle');
    }
  }
}

class HttpClient {
  private readonly fetchImpl: FetchLike;
  private readonly limits: AcquisitionLimits;
  private readonly options: AcquireSkillOptions;
  private readonly fixedOrigin: string;
  private nextRequestAt = 0;
  private requestGate: Promise<void> = Promise.resolve();

  constructor(
    fetchImpl: FetchLike,
    limits: AcquisitionLimits,
    options: AcquireSkillOptions,
    fixedOrigin: string,
  ) {
    this.fetchImpl = fetchImpl;
    this.limits = limits;
    this.options = options;
    this.fixedOrigin = fixedOrigin;
  }

  async json<T>(url: URL, request: ClientRequest): Promise<T> {
    const result = await this.jsonWithHeaders<T>(url, request);
    return result.value;
  }

  async jsonWithHeaders<T>(url: URL, request: ClientRequest): Promise<{ value: T; response: Response }> {
    const bytes = await this.bytes(url, { ...request, expectJson: true });
    let value: T;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.bytes)) as T;
    } catch {
      throw new UpstreamAcquisitionError('invalid_response', `Upstream ${url.pathname} returned invalid JSON`);
    }
    return { value, response: bytes.response };
  }

  async bytes(url: URL, request: ClientRequest): Promise<{ bytes: Uint8Array; response: Response }> {
    let current = new URL(url.toString());
    let headers: FetchHeaders = { ...(request.headers ?? {}) };
    let redirects = 0;
    let attempts = 0;
    const retryable = request.retryable ?? (request.method === undefined || request.method === 'GET');
    if (request.body !== undefined && Buffer.byteLength(request.body, 'utf8') > MAX_REQUEST_BODY_BYTES) {
      throw new UpstreamAcquisitionError('request_size_limit', 'Upstream request body is too large');
    }
    while (true) {
      assertSafeURL(current, this.options.allowLoopbackForTests);
      await assertResolvedPublicHost(current, this.options.allowLoopbackForTests ?? false);
      const sameOrigin = current.origin === this.fixedOrigin;
      if (!sameOrigin && !request.allowCrossOriginRedirectWithoutAuth && current.toString() !== url.toString()) {
        throw new UpstreamAcquisitionError('redirect_denied', 'Upstream redirect changed origin');
      }
      const response = await this.requestOnce(current, {
        method: request.method,
        headers,
        body: request.body,
        retryable,
        attempts,
        signal: request.signal,
      });
      const status = response.status;
      if (isRedirectStatus(status)) {
        if (request.rejectRedirects) {
          throw new UpstreamAcquisitionError('redirect_denied', 'Upstream redirects are not accepted', status);
        }
        const location = response.headers.get('location');
        if (!location || redirects >= this.limits.maxRedirects) {
          throw new UpstreamAcquisitionError('redirect_denied', 'Upstream redirect limit exceeded', status);
        }
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          throw new UpstreamAcquisitionError('redirect_denied', 'Upstream redirect location is invalid', status);
        }
        assertSafeURL(next, this.options.allowLoopbackForTests);
        // Off-origin redirects always lose credentials. Catalog API requests
        // also opt into same-origin stripping because a gateway/OIDC bearer
        // is bound to the exact catalog request path. Other source and
        // artifact requests retain their existing same-origin auth behavior.
        if (request.stripCredentialsOnRedirect || next.origin !== current.origin) {
          headers = withoutCredentialHeaders(headers);
        }
        if (next.origin !== current.origin) {
          if (!request.allowCrossOriginRedirectWithoutAuth) {
            throw new UpstreamAcquisitionError('redirect_denied', 'Upstream redirect changed origin', status);
          }
        }
        current = next;
        redirects += 1;
        if (status === 303 || ((status === 301 || status === 302) && request.method && request.method !== 'GET')) {
          request = { ...request, method: 'GET', body: undefined, retryable: true };
        }
        continue;
      }
      if (status < 200 || status >= 300) {
        if (retryable && isRetryableStatus(status) && attempts + 1 < this.limits.maxAttempts) {
          await boundedRetryDelay(response.headers.get('retry-after'), attempts);
          attempts += 1;
          continue;
        }
        throw new UpstreamAcquisitionError('upstream_http_error', `Upstream request failed with HTTP ${status}`, status);
      }
      let bytes: Uint8Array;
      try {
        bytes = await readResponseBytes(
          response,
          this.limits.maxResponseBytes,
          request.signal ?? this.options.signal,
        );
      } catch (error) {
        if (error instanceof UpstreamAcquisitionError) throw error;
        if (this.options.signal?.aborted) {
          throw new UpstreamAcquisitionError('cancelled', 'Upstream acquisition cancelled');
        }
        if (request.signal?.aborted) {
          throw new UpstreamAcquisitionError('request_cancelled', 'Upstream request was cancelled');
        }
        throw new UpstreamAcquisitionError('upstream_network_error', 'Upstream response could not be read');
      }
      return { bytes, response };
    }
  }

  private async requestOnce(url: URL, request: ClientRequest & { attempts: number }): Promise<Response> {
    await this.throttle();
    const controller = new AbortController();
    const abortListeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
    const signals = [this.options.signal, request.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    if (signals.some((signal) => signal.aborted)) {
      const signal = signals.find((candidate) => candidate.aborted)!;
      throw new UpstreamAcquisitionError(
        signal === this.options.signal ? 'cancelled' : 'request_cancelled',
        signal === this.options.signal ? 'Upstream acquisition cancelled' : 'Upstream request was cancelled',
      );
    }
    for (const signal of signals) {
      const listener = () => controller.abort(signal.reason);
      signal.addEventListener('abort', listener, { once: true });
      abortListeners.push({ signal, listener });
    }
    const timer = setTimeout(() => controller.abort(), this.limits.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: request.method ?? 'GET',
        headers: request.headers,
        body: request.body,
        redirect: 'manual',
        signal: controller.signal,
      });
      return response;
    } catch (error) {
      if (this.options.signal?.aborted) throw new UpstreamAcquisitionError('cancelled', 'Upstream acquisition cancelled');
      if (request.signal?.aborted) throw new UpstreamAcquisitionError('request_cancelled', 'Upstream request was cancelled');
      if ((error as { name?: unknown })?.name === 'AbortError') {
        if (request.attempts + 1 < this.limits.maxAttempts && (request.retryable ?? false)) {
          await boundedRetryDelay(undefined, request.attempts);
          return this.requestOnce(url, { ...request, attempts: request.attempts + 1 });
        }
        throw new UpstreamAcquisitionError('upstream_timeout', 'Upstream request timed out');
      }
      if (request.retryable && request.attempts + 1 < this.limits.maxAttempts) {
        await boundedRetryDelay(undefined, request.attempts);
        return this.requestOnce(url, { ...request, attempts: request.attempts + 1 });
      }
      throw new UpstreamAcquisitionError('upstream_network_error', 'Upstream request failed');
    } finally {
      clearTimeout(timer);
      for (const { signal, listener } of abortListeners) signal.removeEventListener('abort', listener);
    }
  }

  private async throttle(): Promise<void> {
    let release!: () => void;
    const previous = this.requestGate;
    this.requestGate = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const interval = 1_000 / this.limits.maxRequestsPerSecond;
      const waitMs = Math.max(0, this.nextRequestAt - Date.now());
      if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      this.nextRequestAt = Date.now() + interval;
    } finally {
      release();
    }
  }
}

interface ClientRequest {
  method?: string;
  headers?: FetchHeaders;
  body?: string;
  signal?: AbortSignal;
  allowedOrigin?: string;
  retryable?: boolean;
  allowCrossOriginRedirectWithoutAuth?: boolean;
  /** Strip credentials on same-origin redirects for bound catalog requests. */
  stripCredentialsOnRedirect?: boolean;
  /** Reject redirects before any location/body is consumed. */
  rejectRedirects?: boolean;
  expectJson?: boolean;
}

function withoutCredentialHeaders(headers: FetchHeaders): FetchHeaders {
  const safe: FetchHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLocaleLowerCase('en-US');
    if (lower === 'authorization' || lower === 'cookie' || lower === 'proxy-authorization') continue;
    safe[key] = value;
  }
  return safe;
}

async function readResponseBytes(response: Response, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    throw new UpstreamAcquisitionError('response_size_limit', `Upstream response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) {
    if (signal?.aborted) throw new Error('response read cancelled');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (signal?.aborted) throw new Error('response read cancelled');
    if (bytes.length > maxBytes) throw new UpstreamAcquisitionError('response_size_limit', 'Upstream response is too large');
    return bytes;
  }
  if (signal?.aborted) throw new Error('response read cancelled');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let aborted = false;
  const onAbort = signal === undefined
    ? undefined
    : () => {
      aborted = true;
      void reader.cancel().catch(() => undefined);
    };
  if (signal !== undefined) {
    signal.addEventListener('abort', onAbort!, { once: true });
  }
  try {
    while (true) {
      if (aborted || signal?.aborted) throw new Error('response read cancelled');
      const next = await reader.read();
      if (aborted || signal?.aborted) throw new Error('response read cancelled');
      if (next.done) break;
      const chunk = next.value;
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new UpstreamAcquisitionError('response_size_limit', `Upstream response exceeds ${maxBytes} bytes`);
      }
      chunks.push(chunk);
    }
  } finally {
    if (signal !== undefined) signal.removeEventListener('abort', onAbort!);
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function assertSafeURL(url: URL, allowLoopbackForTests = false): void {
  if (url.protocol !== 'https:' && !(allowLoopbackForTests && url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw new UpstreamAcquisitionError('insecure_upstream', 'Upstream requests require HTTPS');
  }
  if (url.username || url.password) {
    throw new UpstreamAcquisitionError('unsafe_url', 'Upstream URL cannot contain credentials');
  }
  if (!url.hostname || url.hostname.endsWith('.')) {
    throw new UpstreamAcquisitionError('unsafe_url', 'Upstream URL has an invalid hostname');
  }
  const hostname = stripIPv6Brackets(url.hostname);
  const directIp = isIP(hostname);
  if (directIp && isPrivateAddress(hostname) && !(allowLoopbackForTests && isLoopbackHost(hostname)) ) {
    throw new UpstreamAcquisitionError('ssrf_denied', 'Upstream URL resolves to a private or metadata address');
  }
  if (directIp === 0 && !allowLoopbackForTests && isObviouslyLocalName(url.hostname)) {
    throw new UpstreamAcquisitionError('ssrf_denied', 'Upstream URL uses a local hostname');
  }
}

async function assertResolvedPublicHost(url: URL, allowLoopbackForTests: boolean): Promise<void> {
  assertSafeURL(url, allowLoopbackForTests);
  const hostname = stripIPv6Brackets(url.hostname);
  if (isIP(hostname)) return;
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new UpstreamAcquisitionError('dns_denied', 'Upstream hostname could not be resolved');
  }
  if (addresses.length === 0) throw new UpstreamAcquisitionError('dns_denied', 'Upstream hostname has no addresses');
  if (!allowLoopbackForTests && addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new UpstreamAcquisitionError('ssrf_denied', 'Upstream hostname resolves to a private or metadata address');
  }
  if (allowLoopbackForTests && addresses.some(({ address }) => !isLoopbackHost(address))) {
    // The fixture bypass is limited to loopback.  It must not turn into a
    // general private-network bypass, and mixed public/loopback DNS answers
    // remain unsafe.
    throw new UpstreamAcquisitionError('ssrf_denied', 'Loopback test hostname does not resolve exclusively to loopback');
  }
}

function isPrivateAddress(address: string): boolean {
  const normalized = stripIPv6Brackets(address.toLocaleLowerCase('en-US'));
  if (normalized.includes('%')) return true;
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    const octets = normalized.split('.').map(Number);
    const [a, b] = octets;
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (ipVersion === 6) {
    const compact = normalized.replace(/^::ffff:/, '');
    if (isIP(compact) === 4) return isPrivateAddress(compact);
    return normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb') || normalized.startsWith('ff');
  }
  return true;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = stripIPv6Brackets(hostname.toLocaleLowerCase('en-US'));
  if (normalized === 'localhost') return true;
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) return normalized.split('.').map(Number)[0] === 127;
  return ipVersion === 6 && normalized === '::1';
}

function isObviouslyLocalName(hostname: string): boolean {
  const lower = stripIPv6Brackets(hostname.toLocaleLowerCase('en-US'));
  return lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.local') || lower.endsWith('.internal') || lower === 'metadata.google.internal';
}

function stripIPv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function requireSha(value: unknown, context: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/i.test(value)) {
    throw new UpstreamAcquisitionError('invalid_source', `${context} did not contain an immutable commit/blob SHA`);
  }
  return value.toLocaleLowerCase('en-US');
}

function requireSha256Digest(value: unknown, context: string): string {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new UpstreamAcquisitionError('invalid_registry_response', `${context} did not contain a valid SHA-256 digest`);
  }
  return value;
}

function requireString(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || /[\r\n]/.test(value)) {
    throw new UpstreamAcquisitionError('invalid_registry_response', `${context} did not contain a valid string`);
  }
  return value;
}

function digestBytes(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function safeId(value: unknown): string {
  return typeof value === 'string' && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : '<unknown>';
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function boundedRetryDelay(retryAfter: string | null | undefined, attempt: number): Promise<void> {
  let delayMs = Math.min(RETRY_WAIT_MAX_MS, 50 * (2 ** attempt));
  if (retryAfter && /^\d+$/.test(retryAfter)) delayMs = Math.min(RETRY_WAIT_MAX_MS, Number(retryAfter) * 1_000);
  if (delayMs <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      output[index] = await mapper(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, () => worker()));
  return output;
}

// DNS checks are intentionally kept separate from URL parsing so a worker can
// use this exported helper in a preflight policy check without making a fetch.
export async function validateUpstreamURL(url: string | URL, options?: Pick<AcquireSkillOptions, 'allowLoopbackForTests'>): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url.toString());
  } catch {
    throw new UpstreamAcquisitionError('unsafe_url', 'Upstream URL is invalid');
  }
  await assertResolvedPublicHost(parsed, options?.allowLoopbackForTests ?? false);
  return parsed;
}

export default acquireSkill;
