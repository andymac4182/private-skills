import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import type {
  ImportRequest,
  Job,
  Provenance,
  SkillBundle,
  Upstream,
} from '../../contracts/src/index.js';

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
const MAX_TOKEN_BYTES = 4_096;
const MAX_CHAIN_BYTES = 4_096;
const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;
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

  if (normalized.upstream.enabled === false) {
    throw new UpstreamAcquisitionError(
      'upstream_disabled',
      `Upstream ${safeId(normalized.upstream.id)} is disabled`,
    );
  }

  switch (normalized.upstream.kind) {
    case 'github':
      return acquireGithub(normalized);
    case 'registry':
      return acquireRegistry(normalized);
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
  return acquireRegistry(normalized);
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
    },
  };
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
  if (typeof repositoryInput !== 'string' || repositoryInput.trim() === '') {
    throw new UpstreamAcquisitionError('repository_required', 'GitHub imports require a repository');
  }
  const repository = normalizeRepositoryIdentity(repositoryInput);
  if (!allowlist || allowlist.length === 0) {
    throw new UpstreamAcquisitionError('repository_denied', 'GitHub upstream has no repository allowlist');
  }
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
  if (pathInput.includes('\0') || pathInput.includes('\\') || /[\u0000-\u001f\u007f]/.test(pathInput) || pathInput.startsWith('/') || /^[A-Za-z]:/.test(pathInput) || pathInput.startsWith('//')) {
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
    if (mode !== '' && mode !== '100644' && mode !== '100755') {
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
  if (typeof entry.size === 'number' && entry.size !== bytes.length) {
    throw new UpstreamAcquisitionError('size_mismatch', `GitHub file ${String(entry.path)} size changed during acquisition`);
  }
  if (typeof blob.size === 'number' && blob.size !== bytes.length) {
    throw new UpstreamAcquisitionError('size_mismatch', `GitHub blob ${String(entry.path)} size is inconsistent`);
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

function credentialHeader(upstream: Upstream, _source: 'github' | 'registry'): string | undefined {
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
      });
      const status = response.status;
      if (isRedirectStatus(status)) {
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
        if (next.origin !== current.origin) {
          if (!request.allowCrossOriginRedirectWithoutAuth) {
            throw new UpstreamAcquisitionError('redirect_denied', 'Upstream redirect changed origin', status);
          }
          const safeHeaders: FetchHeaders = {};
          for (const [key, value] of Object.entries(headers)) {
            const lower = key.toLocaleLowerCase('en-US');
            if (lower !== 'authorization' && lower !== 'cookie' && lower !== 'proxy-authorization') safeHeaders[key] = value;
          }
          headers = safeHeaders;
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
      const bytes = await readResponseBytes(response, this.limits.maxResponseBytes);
      return { bytes, response };
    }
  }

  private async requestOnce(url: URL, request: ClientRequest & { attempts: number }): Promise<Response> {
    await this.throttle();
    const controller = new AbortController();
    const onAbort = () => controller.abort(this.options.signal?.reason);
    if (this.options.signal) {
      if (this.options.signal.aborted) throw new UpstreamAcquisitionError('cancelled', 'Upstream acquisition cancelled');
      this.options.signal.addEventListener('abort', onAbort, { once: true });
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
      this.options.signal?.removeEventListener('abort', onAbort);
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
  allowedOrigin?: string;
  retryable?: boolean;
  allowCrossOriginRedirectWithoutAuth?: boolean;
  expectJson?: boolean;
}

async function readResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    throw new UpstreamAcquisitionError('response_size_limit', `Upstream response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new UpstreamAcquisitionError('response_size_limit', 'Upstream response is too large');
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
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
