import type {
  ImportRequest,
  Job,
  Provenance,
  SkillBundle,
  Upstream,
} from '../../../packages/contracts/src/index.js';
import {
  acquireClawHubSource,
  acquireOpenClawSource,
  acquireSkill,
  acquireTesslSource,
  validateClawHubSourceIdentity,
  validateOpenClawSourceIdentity,
  validateTesslSourceIdentity,
  type AcquireSkillOptions,
  type AcquisitionResult,
  type ClawHubSourceAcquisition,
  type OpenClawSourceFetcher,
  type OpenClawSourceJobDescriptor,
  type TesslSourceAcquisition,
} from '../../../packages/upstreams/src/index.js';
import {
  isOpenClawFeedFresh,
  OPENCLAW_CLAWHUB_SKILLS_COMPATIBILITY_PROFILE,
  normalizeOpenClawEntry,
} from '../../../packages/openclaw/src/index.js';
import type {
  OpenClawFeedEntry,
  OpenClawNormalizedSource,
  OpenClawSha256,
} from '../../../packages/openclaw/src/types.js';
import {
  POLYSKILL_API_ORIGIN,
  acquirePolyskillSkill,
  validatePolyskillSourceIdentity,
  type PolyskillSourceAcquisition,
  type PolyskillFetchLike,
} from '../../../packages/upstreams/src/polyskill.js';
import {
  MAX_SKILLS_DIRECTORY_GATEWAYS,
  isValidSkillsShGatewayToken,
  normalizeDirectoryBaseURL,
  resolveSkillsDirectoryGateways,
  type SkillsDirectoryGatewayResolution,
  type SkillsShGatewayCredential,
} from '../../../packages/directory/src/index.js';
import type { WorkerClaimedJob } from './client.js';

/** Options supplied by the worker supervisor for a source acquisition. */
export interface WorkerOpenClawAcquisitionOptions {
  /** Safe fetcher built from an operator-owned source locator. */
  fetcher: OpenClawSourceFetcher;
  /** Deployment allowlist, never taken from the claimed job. */
  allowedArtifactOrigins: readonly string[];
  /** Optional fixed source identity origin for the configured adapter. */
  sourceProviderOrigin?: string;
  /** Clock injection for deterministic expiry checks; defaults to Date.now. */
  now?: () => number;
}

/** Options supplied by the worker supervisor for native Tessl acquisition. */
export interface WorkerTesslAcquisitionOptions {
  /** Optional operator-owned Tessl API credential resolver. */
  getToken?: (signal?: AbortSignal) => Promise<string>;
  /** Loopback-only test endpoint; production transport remains api.tessl.io. */
  apiBaseUrl?: string;
}

/** Options supplied by the worker supervisor for native ClawHub acquisition. */
export interface WorkerClawHubAcquisitionOptions {
  /** Loopback-only test endpoint; production transport remains clawhub.ai. */
  apiBaseUrl?: string;
}

/** Options supplied by the worker supervisor for native PolySkill acquisition. */
export interface WorkerPolyskillAcquisitionOptions {
  /** Loopback-only test endpoint; production transport remains polyskill.ai. */
  apiBaseUrl?: string;
}

/** Options supplied by the worker supervisor for a source acquisition. */
export interface WorkerAcquisitionOptions extends AcquireSkillOptions {
  /** Enabled only for server-owned jobs carrying an OpenClaw source proof target. */
  openClaw?: WorkerOpenClawAcquisitionOptions;
  /** Enabled only for server-owned jobs carrying a Tessl source descriptor. */
  tessl?: WorkerTesslAcquisitionOptions;
  /** Enabled only for server-owned jobs carrying a native ClawHub descriptor. */
  clawHub?: WorkerClawHubAcquisitionOptions;
  /** Enabled only for server-owned jobs carrying a native PolySkill descriptor. */
  polyskill?: WorkerPolyskillAcquisitionOptions;
}

export interface WorkerOpenClawSourceArtifactProof {
  verified: true;
  digest: `sha256:${string}`;
  format: 'clawhub-skill-v1' | 'github-skill-folder-v1';
  identity: string;
}

export interface WorkerOpenClawProof {
  entry: OpenClawFeedEntry;
  sourceArtifact: WorkerOpenClawSourceArtifactProof;
}

type WorkerGithubSourceAcquisition = {
  kind: 'github';
  repository: string;
  path: string;
  ref: string;
  sourceProviderOrigin?: string;
  contentDigest?: string;
};

type WorkerRegistrySourceAcquisition = {
  kind: 'registry';
  baseUrl: string;
  package: string;
  version: string;
  sourceProviderOrigin?: string;
  artifactDigest?: string;
};

type WorkerOpenClawSourceAcquisition = {
  kind: 'openclaw';
  source: OpenClawNormalizedSource;
  sourceProviderOrigin?: string;
  allowedArtifactOrigins?: readonly string[];
};

type WorkerPolyskillSourceAcquisition = {
  kind: 'polyskill';
  name: string;
  version: string;
  contentDigest: string;
  sourceProviderOrigin: string;
};

type WorkerSourceAcquisition =
  | WorkerGithubSourceAcquisition
  | WorkerRegistrySourceAcquisition
  | WorkerOpenClawSourceAcquisition
  | TesslSourceAcquisition
  | ClawHubSourceAcquisition
  | WorkerPolyskillSourceAcquisition;

const GATEWAY_CREDENTIAL_UNAVAILABLE = 'skills.sh gateway credential unavailable';

/**
 * Build the optional portable gateway credential from supervisor settings.
 * The returned object binds the token to the exact configured base URL; the
 * upstream adapter performs the normalized origin+pathname comparison before
 * invoking it.  Directory credentials are ignored while the directory is
 * disabled, and incomplete settings fail closed when the credential is used.
 */
export function workerAcquisitionOptionsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): WorkerAcquisitionOptions {
  const tessl = workerTesslOptionsFromEnv(env);
  const withTessl = (options: WorkerAcquisitionOptions): WorkerAcquisitionOptions =>
    tessl === undefined ? options : { ...options, tessl };
  const resolution: SkillsDirectoryGatewayResolution = resolveSkillsDirectoryGateways(env);
  if (resolution.kind === 'disabled') return withTessl({});

  // An enabled directory with no gateway profile is the historical worker
  // configuration. Keep the empty options object so explicitly mapped
  // upstream.credentialEnv credentials continue to work. An explicitly
  // supplied JSON profile (including []) remains authoritative and is handled
  // below as a fail-closed multi-feed configuration.
  if (env.PSKILLS_DIRECTORY_GATEWAYS_JSON === undefined
    && env.PSKILLS_DIRECTORY_GATEWAY_URL === undefined) {
    return withTessl({});
  }

  // A multi-feed document is represented by the plural seam even when it
  // happens to contain one gateway. This lets the upstream adapter treat an
  // empty or unmatched profile as authoritative and fail closed.
  if (resolution.kind === 'ready') {
    if (env.PSKILLS_DIRECTORY_GATEWAYS_JSON !== undefined) {
      return withTessl({ skillsShGatewayCredentials: resolution.gateways });
    }
    // Preserve the pre-multi-feed object shape for deployments using the
    // original URL/token pair. The upstream accepts this field unchanged.
    if (resolution.gateways.length === 1) {
      return withTessl({ skillsShGatewayCredential: resolution.gateways[0] });
    }
    return withTessl({ skillsShGatewayCredentials: resolution.gateways });
  }

  if (env.PSKILLS_DIRECTORY_GATEWAYS_JSON !== undefined) {
    // The empty list is an explicit fail-closed profile. It cannot be
    // mistaken for an unset option and therefore cannot fall through to an
    // upstream credentialEnv or anonymous custom-feed request.
    return withTessl({ skillsShGatewayCredentials: [] });
  }

  // Preserve the established legacy failure marker for one URL/token pair so
  // existing standalone workers keep their stable error and redaction path.
  const baseUrl = env.PSKILLS_DIRECTORY_GATEWAY_URL;
  if (baseUrl === undefined) return withTessl({});
  const credential: SkillsShGatewayCredential = {
    baseUrl: normalizeDirectoryBaseURL(baseUrl) ?? '',
    getToken: async (signal?: AbortSignal): Promise<string> => {
      if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
      throw new Error(GATEWAY_CREDENTIAL_UNAVAILABLE);
    },
  };
  return withTessl({ skillsShGatewayCredential: credential });
}

function workerTesslOptionsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): WorkerTesslAcquisitionOptions | undefined {
  const token = env.PSKILLS_TESSL_API_TOKEN ?? env.PSKILLS_TESSL_TOKEN;
  if (token === undefined) return undefined;
  // Keep the value inside a supervisor callback. It is validated and
  // redacted at the worker boundary before the upstream adapter sees it.
  return {
    getToken: async (signal?: AbortSignal): Promise<string> => {
      if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
      return token;
    },
  };
}

export interface AcquiredImport {
  bundle: SkillBundle;
  provenance: Provenance;
  /** True when the import was selected from an OpenClaw source job. */
  openClawSource?: boolean;
  /** Source proof material for the post-completion recorder, if queued. */
  openClawProof?: WorkerOpenClawProof;
}

/**
 * Acquire an import job from its administrator-selected source mapping.
 *
 * The claim is treated as untrusted transport data: the worker verifies that
 * the embedded import request and upstream agree before passing them to the
 * source adapter. Credentials remain environment references on the upstream;
 * the claimed job never carries credential bytes.
 */
export async function acquireImportJob(
  job: WorkerClaimedJob,
  options: WorkerAcquisitionOptions = {},
): Promise<AcquiredImport> {
  if (job.kind !== 'import') {
    throw new Error(`cannot acquire job kind ${String(job.kind)}`);
  }
  const sourceAcquisition = parseSourceAcquisition(job.sourceAcquisition);
  const tesslSource = sourceAcquisition?.kind === 'tessl' ? sourceAcquisition : undefined;
  const clawHubSource = sourceAcquisition?.kind === 'clawhub' ? sourceAcquisition : undefined;
  const upstream = asUpstream(job.upstream, sourceAcquisition?.kind);
  const importRequest = asImportRequest(job.import ?? job.importRequest);
  if (importRequest.upstreamId !== upstream.id) {
    throw new Error('claimed import request does not match its upstream');
  }
  if (upstream.organizationId !== job.organizationId) {
    throw new Error('claimed upstream belongs to a different organization');
  }

  if (tesslSource !== undefined) {
    if (job.openclawSource !== undefined || clawHubSource !== undefined) {
      throw new Error('claimed import job contains conflicting source descriptors');
    }
    // Tessl's public API does not require a credential.  An explicit worker
    // option only overrides the fixed endpoint or supplies an operator token;
    // native source jobs remain usable with the default worker options.
    const configured = options.tessl ?? {};
    validateTesslSourceBinding(tesslSource, importRequest);
    const upstreamKind = (upstream as unknown as { kind: string }).kind;
    const provenanceKind = upstreamKind === 'github' || upstreamKind === 'registry' || upstreamKind === 'skills-sh' || upstreamKind === 'native'
      ? upstreamKind
      : 'native';
    const result = await acquireTesslSource({
      source: tesslSource,
      ...(configured.getToken === undefined ? {} : { getTesslToken: configured.getToken }),
      ...(configured.apiBaseUrl === undefined ? {} : { tesslApiBaseUrl: configured.apiBaseUrl }),
      upstreamId: upstream.id,
      externalId: importRequest.externalId ?? importRequest.path,
      externalSnapshotHash: importRequest.externalSnapshotHash ?? tesslSource.fingerprint,
      provenanceKind,
      provenanceRepository: importRequest.repository ?? upstream.baseUrl,
      provenancePath: importRequest.path,
      sourceReference: importRequest.sourceReference,
      fetchImpl: options.fetchImpl ?? options.fetch,
      fetch: options.fetch,
      limits: options.limits,
      allowLoopbackForTests: options.allowLoopbackForTests,
      signal: options.signal,
      upstreamObserver: options.upstreamObserver,
    });
    return result;
  }

  if (clawHubSource !== undefined) {
    if (job.openclawSource !== undefined) {
      throw new Error('claimed import job contains conflicting source descriptors');
    }
    // ClawHub's native download is public.  The optional worker setting only
    // exists for loopback fixtures and future deployment transport knobs.
    const configured = options.clawHub ?? {};
    validateClawHubSourceBinding(clawHubSource, importRequest);
    const result = await acquireClawHubSource({
      source: clawHubSource,
      ...(configured.apiBaseUrl === undefined ? {} : { clawHubApiBaseUrl: configured.apiBaseUrl }),
      upstreamId: upstream.id,
      externalId: importRequest.externalId ?? importRequest.path,
      ...(importRequest.externalSnapshotHash === undefined ? {} : { externalSnapshotHash: importRequest.externalSnapshotHash }),
      provenanceRepository: importRequest.repository ?? upstream.baseUrl,
      provenancePath: importRequest.path,
      sourceReference: importRequest.sourceReference,
      fetchImpl: options.fetchImpl ?? options.fetch,
      fetch: options.fetch,
      limits: options.limits,
      allowLoopbackForTests: options.allowLoopbackForTests,
      signal: options.signal,
      upstreamObserver: options.upstreamObserver,
    });
    return result;
  }

  const polyskillSource = sourceAcquisition?.kind === 'polyskill' ? sourceAcquisition : undefined;
  if (polyskillSource !== undefined) {
    if (job.openclawSource !== undefined) {
      throw new Error('claimed import job contains conflicting source descriptors');
    }
    validatePolyskillSourceBinding(polyskillSource, importRequest);
    const configured = options.polyskill ?? {};
    const result = await acquirePolyskillSkill({
      source: polyskillSource as unknown as PolyskillSourceAcquisition,
      ...(configured.apiBaseUrl === undefined ? {} : { apiBaseUrl: configured.apiBaseUrl }),
      fetchImpl: (options.fetchImpl ?? options.fetch) as PolyskillFetchLike | undefined,
      allowLoopbackForTests: options.allowLoopbackForTests,
      signal: options.signal,
      upstreamId: upstream.id,
      externalId: importRequest.externalId ?? importRequest.path,
      ...(importRequest.externalSnapshotHash === undefined ? {} : { externalSnapshotHash: importRequest.externalSnapshotHash }),
    });
    return {
      ...result,
      provenance: {
        ...result.provenance,
        // Source-catalog native jobs are represented by the existing registry
        // completion contract. The native helper's semantic content digest is
        // retained as external evidence below.
        kind: 'registry',
        repository: importRequest.repository ?? upstream.baseUrl ?? result.provenance.repository,
        path: importRequest.path,
        revision: polyskillSource.version,
        externalId: importRequest.externalId ?? importRequest.path,
        externalSnapshotHash: importRequest.externalSnapshotHash ?? polyskillSource.contentDigest,
        sourceReference: importRequest.sourceReference ?? result.provenance.sourceReference,
      },
    };
  }

  if (job.openclawSource !== undefined && sourceAcquisition !== undefined && sourceAcquisition.kind !== 'openclaw') {
    throw new Error('claimed import job contains conflicting source descriptors');
  }

  const openClawAcquisition = sourceAcquisition?.kind === 'openclaw' ? sourceAcquisition : undefined;
  if (openClawAcquisition !== undefined && job.openclawSource !== undefined) {
    throw new Error('claimed import job contains conflicting source descriptors');
  }
  if (openClawAcquisition !== undefined) {
    validateOpenClawAcquisitionBinding(openClawAcquisition, importRequest);
  }
  const openClawJob = openClawAcquisition === undefined ? parseOpenClawSourceJob(job.openclawSource) : undefined;
  const openClawSource = openClawAcquisition?.source ?? openClawJob?.source;
  if (openClawSource !== undefined) {
    const configured = options.openClaw;
    if (configured === undefined) {
      throw new Error('OpenClaw source worker is not configured');
    }
    const source = openClawSource;
    const externalId = importRequest.externalId ?? importRequest.path;
    const openClawFeed = openClawJob?.feed;
    validateOpenClawQueuedFeed(openClawFeed, configured.now?.() ?? Date.now());
    if (source.kind === 'public-clawhub' && source.version !== importRequest.version && openClawAcquisition === undefined) {
      throw new Error('OpenClaw hosted source version does not match the import request');
    }
    if (source.kind === 'public-github' && importRequest.repository !== undefined && importRequest.repository !== source.repo) {
      throw new Error('OpenClaw GitHub source repository does not match the import request');
    }
    const result = await acquireOpenClawSource({
      source,
      fetcher: configured.fetcher,
      allowedArtifactOrigins: openClawAcquisition?.allowedArtifactOrigins ?? configured.allowedArtifactOrigins,
      ...(openClawAcquisition?.sourceProviderOrigin ?? configured.sourceProviderOrigin) === undefined ? {} : { sourceProviderOrigin: openClawAcquisition?.sourceProviderOrigin ?? configured.sourceProviderOrigin },
      upstreamId: upstream.id,
      externalId,
      ...(importRequest.externalSourceType === undefined ? {} : { externalSourceType: importRequest.externalSourceType }),
      ...(importRequest.externalSnapshotHash === undefined ? {} : { externalSnapshotHash: importRequest.externalSnapshotHash }),
      signal: options.signal,
      limits: options.limits,
      upstreamObserver: options.upstreamObserver,
    });
    const openClawProofEntry = openClawJob?.entry;
    const openClawProof = openClawProofEntry === undefined
      ? undefined
      : buildOpenClawProof(openClawProofEntry, source, externalId);
    return {
      ...result,
      openClawSource: true,
      ...(openClawProof === undefined ? {} : { openClawProof }),
    };
  }

  if (sourceAcquisition?.kind === 'github' || sourceAcquisition?.kind === 'registry') {
    validateGenericSourceBinding(sourceAcquisition, importRequest);
  }
  // The worker receives a frozen job policy/source mapping from the registry.
  // Pass only the source adapter options through; authorization from the
  // browser or registry caller is deliberately not inherited here.
  const result: AcquisitionResult = await acquireSkill({
    job: job as unknown as Job,
    upstream,
    importRequest,
    ...safeSkillsShOptions(options),
  });
  return result;
}

function parseSourceAcquisition(value: unknown): WorkerSourceAcquisition | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new Error('claimed source acquisition descriptor is unsupported');
  }
  try {
    switch (value.kind) {
      case 'tessl':
        return validateTesslSourceIdentity(value as unknown as TesslSourceAcquisition);
      case 'clawhub':
        return validateClawHubSourceIdentity(value as unknown as ClawHubSourceAcquisition);
      case 'github':
        return parseGithubSourceAcquisition(value);
      case 'registry':
        return parseRegistrySourceAcquisition(value);
      case 'openclaw':
        return parseOpenClawSourceAcquisition(value);
      case 'polyskill':
        return parsePolyskillSourceAcquisition(value);
      default:
        throw new Error('unsupported source kind');
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'unsupported source kind') {
      throw new Error('claimed source acquisition descriptor is unsupported');
    }
    const label = value.kind === 'tessl' ? 'Tessl' : value.kind === 'clawhub' ? 'ClawHub' : 'source';
    throw new Error(`claimed ${label} source acquisition descriptor is invalid`);
  }
}

function parseGithubSourceAcquisition(value: Record<string, unknown>): WorkerGithubSourceAcquisition {
  if (typeof value.repository !== 'string' || typeof value.path !== 'string' || typeof value.ref !== 'string' ||
    !isSafeClaimedText(value.repository, 512) || (value.path !== '' && !isSafeClaimedText(value.path, 4_096)) || !isSafeClaimedText(value.ref, 256)) {
    throw new Error('invalid source');
  }
  if (value.sourceProviderOrigin !== undefined && !isSafeClaimedText(value.sourceProviderOrigin, 512)) throw new Error('invalid source');
  if (value.contentDigest !== undefined && !isRawOrPrefixedSha256(value.contentDigest)) throw new Error('invalid source');
  return value as unknown as WorkerGithubSourceAcquisition;
}

function parseRegistrySourceAcquisition(value: Record<string, unknown>): WorkerRegistrySourceAcquisition {
  if (typeof value.baseUrl !== 'string' || typeof value.package !== 'string' || typeof value.version !== 'string' ||
    !isSafeClaimedText(value.baseUrl, 2_048) || !isSafeClaimedText(value.package, 512) || !isSafeClaimedText(value.version, 256)) {
    throw new Error('invalid source');
  }
  if (value.sourceProviderOrigin !== undefined && !isSafeClaimedText(value.sourceProviderOrigin, 512)) throw new Error('invalid source');
  if (value.artifactDigest !== undefined && !isPrefixedSha256(value.artifactDigest)) throw new Error('invalid source');
  return value as unknown as WorkerRegistrySourceAcquisition;
}

function parseOpenClawSourceAcquisition(value: Record<string, unknown>): WorkerOpenClawSourceAcquisition {
  if (!isRecord(value.source)) throw new Error('invalid source');
  const source = validateOpenClawSourceIdentity(value.source as unknown as OpenClawNormalizedSource);
  if (value.sourceProviderOrigin !== undefined && !isSafeClaimedText(value.sourceProviderOrigin, 512)) throw new Error('invalid source');
  if (value.allowedArtifactOrigins !== undefined && (!Array.isArray(value.allowedArtifactOrigins) || value.allowedArtifactOrigins.some((origin) => typeof origin !== 'string' || !isSafeClaimedText(origin, 512)))) {
    throw new Error('invalid source');
  }
  return {
    kind: 'openclaw',
    source,
    ...(value.sourceProviderOrigin === undefined ? {} : { sourceProviderOrigin: value.sourceProviderOrigin }),
    ...(value.allowedArtifactOrigins === undefined ? {} : { allowedArtifactOrigins: value.allowedArtifactOrigins as readonly string[] }),
  };
}

function parsePolyskillSourceAcquisition(value: Record<string, unknown>): WorkerPolyskillSourceAcquisition {
  if (typeof value.name !== 'string' || typeof value.version !== 'string' || typeof value.contentDigest !== 'string' || typeof value.sourceProviderOrigin !== 'string' ||
    !isSafeClaimedText(value.name, 512) || !isSafeClaimedText(value.version, 256) || !isRawOrPrefixedSha256(value.contentDigest) || !isSafeClaimedText(value.sourceProviderOrigin, 512)) {
    throw new Error('invalid source');
  }
  if (value.sourceProviderOrigin !== POLYSKILL_API_ORIGIN) throw new Error('invalid source');
  validatePolyskillSourceIdentity(value as unknown as PolyskillSourceAcquisition);
  return value as unknown as WorkerPolyskillSourceAcquisition;
}

function isSafeClaimedText(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= maxBytes && !hasUnsafeClaimedText(value);
}

function hasUnsafeClaimedText(value: string): boolean {
  if (/[\u0000-\u001f\u007f\r\n]/u.test(value)) return true;
  try {
    encodeURIComponent(value);
    return false;
  } catch {
    return true;
  }
}

function isPrefixedSha256(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function isRawOrPrefixedSha256(value: unknown): value is string {
  return typeof value === 'string' && (/^[0-9a-f]{64}$/u.test(value) || isPrefixedSha256(value));
}

function validateTesslSourceBinding(
  source: TesslSourceAcquisition,
  request: ImportRequest,
): void {
  const expectedPath = source.skillPath
    ? `${source.workspace}/${source.tile}/${source.skillPath}`
    : `${source.workspace}/${source.tile}`;
  if (request.path !== expectedPath || request.ref !== source.version) {
    throw new Error('Tessl source identity does not match the import request');
  }
}

function validateClawHubSourceBinding(
  source: ClawHubSourceAcquisition,
  request: ImportRequest,
): void {
  const expectedPaths = [`@${source.owner}/${source.slug}`, `${source.owner}/${source.slug}`];
  if (!expectedPaths.includes(request.path) || request.ref !== source.version) {
    throw new Error('ClawHub source identity does not match the import request');
  }
}

function validatePolyskillSourceBinding(
  source: WorkerPolyskillSourceAcquisition,
  request: ImportRequest,
): void {
  if (request.path !== source.name || request.ref !== source.version) {
    throw new Error('PolySkill source identity does not match the import request');
  }
}

function validateOpenClawAcquisitionBinding(
  acquisition: WorkerOpenClawSourceAcquisition,
  request: ImportRequest,
): void {
  const source = acquisition.source;
  if (source.kind === 'public-clawhub') {
    if (request.path !== source.packageName || request.ref !== source.version) {
      throw new Error('OpenClaw ClawHub source identity does not match the import request');
    }
    return;
  }
  if (request.repository !== undefined && request.repository !== source.repo) {
    throw new Error('OpenClaw GitHub source repository does not match the import request');
  }
  if (request.path !== source.path || request.ref !== source.commit) {
    throw new Error('OpenClaw GitHub source identity does not match the import request');
  }
}

function validateGenericSourceBinding(
  source: WorkerGithubSourceAcquisition | WorkerRegistrySourceAcquisition,
  request: ImportRequest,
): void {
  if (source.kind === 'github') {
    if (request.repository !== source.repository || request.path !== source.path || request.ref !== source.ref) {
      throw new Error('GitHub source identity does not match the import request');
    }
    return;
  }
  if (request.path !== source.package || request.ref !== source.version || request.repository !== source.baseUrl) {
    throw new Error('registry source identity does not match the import request');
  }
}

function parseOpenClawSourceJob(value: unknown): OpenClawSourceJobDescriptor | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !isRecord(value.source)) {
    throw new Error('claimed OpenClaw source job descriptor is invalid');
  }
  if (value.entry !== undefined && !isRecord(value.entry)) {
    throw new Error('claimed OpenClaw source proof entry is invalid');
  }
  const feed = parseOpenClawSourceFeed(value.feed);
  const source = value.source;
  if (source.sourceRef === 'public-clawhub' && source.kind === 'public-clawhub' &&
    typeof source.packageName === 'string' && typeof source.version === 'string' &&
    typeof source.artifactDigest === 'string') {
    return {
      source: source as unknown as OpenClawSourceJobDescriptor['source'],
      ...(value.entry === undefined ? {} : { entry: value.entry as unknown as OpenClawFeedEntry }),
      ...(feed === undefined ? {} : { feed }),
    };
  }
  if (source.sourceRef === 'public-github' && source.kind === 'public-github' &&
    typeof source.repo === 'string' && typeof source.path === 'string' &&
    typeof source.commit === 'string' && typeof source.contentHash === 'string') {
    return {
      source: source as unknown as OpenClawSourceJobDescriptor['source'],
      ...(value.entry === undefined ? {} : { entry: value.entry as unknown as OpenClawFeedEntry }),
      ...(feed === undefined ? {} : { feed }),
    };
  }
  throw new Error('claimed OpenClaw source identity is invalid');
}

function parseOpenClawSourceFeed(value: unknown): OpenClawSourceJobDescriptor['feed'] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.sourceUrl !== 'string' ||
    typeof value.sequence !== 'number' || !Number.isSafeInteger(value.sequence) || value.sequence < 0 ||
    typeof value.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value.digest)) {
    throw new Error('claimed OpenClaw feed descriptor is invalid');
  }
  if ((value.generatedAt === undefined) !== (value.expiresAt === undefined) ||
    (value.generatedAt !== undefined && typeof value.generatedAt !== 'string') ||
    (value.expiresAt !== undefined && typeof value.expiresAt !== 'string')) {
    throw new Error('claimed OpenClaw feed freshness metadata is incomplete');
  }
  if (value.compatibilityProfile !== undefined && value.compatibilityProfile !== OPENCLAW_CLAWHUB_SKILLS_COMPATIBILITY_PROFILE) {
    throw new Error('claimed OpenClaw compatibility profile is invalid');
  }
  let url: URL;
  try {
    url = new URL(value.sourceUrl);
  } catch {
    throw new Error('claimed OpenClaw feed URL is invalid');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.href !== value.sourceUrl) {
    throw new Error('claimed OpenClaw feed URL is invalid');
  }
  return {
    id: value.id,
    sequence: value.sequence,
    digest: value.digest as OpenClawSha256,
    sourceUrl: url.href,
    ...(value.generatedAt === undefined ? {} : { generatedAt: value.generatedAt }),
    ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt }),
    ...(value.compatibilityProfile === undefined ? {} : { compatibilityProfile: value.compatibilityProfile }),
  };
}

/** Recheck a claimed descriptor immediately before completion as a worker-side
 * guard; the registry repeats the same check inside its completion transaction. */
export function validateOpenClawSourceFeedFreshness(value: unknown, now = Date.now()): void {
  const feedValue = isRecord(value) && Object.prototype.hasOwnProperty.call(value, 'source') ? value.feed : value;
  validateOpenClawQueuedFeed(parseOpenClawSourceFeed(feedValue), now);
}

function validateOpenClawQueuedFeed(
  feed: OpenClawSourceJobDescriptor['feed'],
  now: number,
): void {
  // Jobs created before feed freshness was part of the descriptor remain
  // compatible for the strict published profile. The alternate ClawHub
  // producer profile is fail-closed because its seven-day wire expiry must be
  // reduced to one local day even when the worker starts much later.
  if (feed === undefined) return;
  if (!Number.isFinite(now)) throw new Error('OpenClaw feed clock is invalid');
  if (feed.generatedAt === undefined || feed.expiresAt === undefined) {
    if (feed.compatibilityProfile !== undefined) throw new Error('OpenClaw feed freshness metadata is required');
    return;
  }
  if (!isOpenClawFeedFresh({
    id: feed.id,
    generatedAt: feed.generatedAt,
    expiresAt: feed.expiresAt,
  }, feed.sourceUrl, now, feed.compatibilityProfile)) throw new Error('OpenClaw feed has expired');
}

function buildOpenClawProof(
  entry: OpenClawFeedEntry,
  source: OpenClawNormalizedSource,
  externalId: string,
): WorkerOpenClawProof {
  if (entry.id !== externalId || entry.type !== 'skill' || entry.state !== 'available') {
    throw new Error('OpenClaw source proof entry does not match the import identity');
  }
  let normalized: ReturnType<typeof normalizeOpenClawEntry>;
  try {
    normalized = normalizeOpenClawEntry(entry);
  } catch {
    throw new Error('OpenClaw source proof entry is invalid');
  }
  const matches = normalized.filter((candidate) => {
    if (source.kind === 'public-clawhub') {
      return candidate.source.kind === source.kind && candidate.source.packageName === source.packageName && candidate.source.version === source.version && candidate.source.artifactDigest === source.artifactDigest;
    }
    return candidate.source.kind === source.kind && candidate.source.repo === source.repo && candidate.source.path === source.path && candidate.source.commit === source.commit && candidate.source.contentHash === source.contentHash;
  });
  if (matches.length !== 1) throw new Error('OpenClaw source proof candidate is ambiguous or mismatched');
  return {
    entry,
    sourceArtifact: source.kind === 'public-clawhub'
      ? {
        verified: true,
        digest: source.artifactDigest as `sha256:${string}`,
        format: 'clawhub-skill-v1',
        identity: `${source.packageName}@${source.version}`,
      }
      : {
        verified: true,
        digest: `sha256:${source.contentHash}`,
        format: 'github-skill-folder-v1',
        identity: `${source.repo}:${source.path}@${source.commit}`,
      },
  };
}

/**
 * Keep request-scoped directory credential failures out of worker telemetry.
 * The callback is deployment-owned and can throw an OIDC/provider error that
 * contains sensitive context; the source adapter only needs a closed/open
 * credential result, so normalize every callback failure to one safe marker.
 * This wrapper is intentionally applied at the worker boundary, before the
 * options reach the upstream adapter, and never stores the returned token.
 */
function safeSkillsShOptions(options: WorkerAcquisitionOptions): WorkerAcquisitionOptions {
  const candidate = (options as WorkerAcquisitionOptions & {
    getSkillsShToken?: unknown;
  }).getSkillsShToken;
  const gateway = (options as WorkerAcquisitionOptions & {
    skillsShGatewayCredential?: unknown;
  }).skillsShGatewayCredential;
  const gateways = (options as WorkerAcquisitionOptions & {
    skillsShGatewayCredentials?: unknown;
  }).skillsShGatewayCredentials;
  if (candidate === undefined && gateway === undefined && gateways === undefined) return options;

  const safe: WorkerAcquisitionOptions = { ...options };
  if (candidate !== undefined) {
    if (typeof candidate !== 'function') throw new Error('skills.sh credential unavailable');
    safe.getSkillsShToken = async (signal?: AbortSignal): Promise<string> => {
      try {
        const token = await (candidate as (signal?: AbortSignal) => Promise<unknown>)(signal);
        if (typeof token !== 'string' || token.length === 0 || Buffer.byteLength(token, 'utf8') > 4_096 || /[\r\n]/.test(token)) {
          throw new Error('invalid skills.sh credential');
        }
        return token;
      } catch {
        throw new Error('skills.sh credential unavailable');
      }
    };
  }
  if (gateway !== undefined) {
    safe.skillsShGatewayCredential = wrapGatewayCredential(gateway);
  }
  if (gateways !== undefined) {
    if (!Array.isArray(gateways) || gateways.length > MAX_SKILLS_DIRECTORY_GATEWAYS) {
      throw new Error(GATEWAY_CREDENTIAL_UNAVAILABLE);
    }
    safe.skillsShGatewayCredentials = gateways.map((entry) => wrapGatewayCredential(entry));
  }
  return safe;
}

/** Validate and redact every plural provider without retaining its token. */
function wrapGatewayCredential(value: unknown): SkillsShGatewayCredential {
  if (typeof value !== 'object' || value === null
    || typeof (value as { baseUrl?: unknown }).baseUrl !== 'string'
    || typeof (value as { getToken?: unknown }).getToken !== 'function') {
    throw new Error(GATEWAY_CREDENTIAL_UNAVAILABLE);
  }
  const credential = value as SkillsShGatewayCredential;
  return {
    baseUrl: credential.baseUrl,
    getToken: async (signal?: AbortSignal): Promise<string> => {
      try {
        const token = await credential.getToken(signal);
        if (!isValidSkillsShGatewayToken(token)) throw new Error('invalid skills.sh gateway credential');
        return token;
      } catch {
        throw new Error(GATEWAY_CREDENTIAL_UNAVAILABLE);
      }
    },
  };
}

function asUpstream(value: unknown, sourceKind?: string): Upstream {
  const nativeKindAllowed = sourceKind === 'tessl' || sourceKind === 'clawhub' || sourceKind === 'polyskill';
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.organizationId !== 'string' || typeof value.name !== 'string' ||
    (value.kind !== 'github' && value.kind !== 'registry' && value.kind !== 'skills-sh' &&
      !(nativeKindAllowed && value.kind === sourceKind)) || typeof value.namespace !== 'string') {
    throw new Error('claimed import job omitted a valid upstream mapping');
  }
  return value as unknown as Upstream;
}

function asImportRequest(value: unknown): ImportRequest {
  if (!isRecord(value) || typeof value.upstreamId !== 'string' || typeof value.path !== 'string' || typeof value.name !== 'string' || typeof value.version !== 'string') {
    throw new Error('claimed import job omitted a valid import request');
  }
  return value as unknown as ImportRequest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
