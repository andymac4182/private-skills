import {
  PROTOCOL_VERSION,
  type AuditEvent,
  type Authenticator,
  type Digest,
  type DistributionState,
  type ExternalProvenance,
  type Feed,
  type Finding,
  type ImportRequest,
  type InstallAuthorization,
  type InstallAnalytics,
  type InstallAnalyticsTopSkill,
  type InstallReceipt,
  type InstallReceiptAgent,
  type InstallReceiptMetadata,
  type InstallReceiptPlatform,
  type InstallReceiptResolutionMember,
  type InstallReceiptResolutionMetadata,
  type InstallReceiptTicket,
  type InstallReceiptTicketMetadata,
  type Job,
  type PackMember,
  type PackVersion,
  type Policy,
  type Principal,
  type Provenance,
  type RegistryConfiguration,
  type RegistryDependencies,
  type RegistryState,
  type Resolution,
  type Role,
  type ScanResult,
  type ScannerId,
  type ScannerPolicy,
  type SkillBundle,
  type SkillVersion,
  type StateRepository,
  type StoredBlob,
  type TransferDescriptor,
  type TransferGrant,
  type Upstream,
} from '../../contracts/src/index.js';
import {
  digestBytes,
  encodeBundle,
  parseSkillMetadata,
  validateBundle,
} from '../../storage/src/index.js';
import {
  SkillsDirectoryError,
  type CuratedSkillsResponse,
  type SkillAuditResponse,
  type SkillDetailMetadataResponse,
  type SkillDetailResponse,
  type SkillListResponse,
  type SkillSearchResponse,
  type SkillSourceType,
  type SkillsTopicResponse,
  type V1Skill,
} from '../../directory/src/index.js';
import type { SkillsPackManifest } from '../../directory-packs/src/index.js';
import {
  createReleaseFilesHandler,
  type AuthoringHandlerDependencies,
  type UploadReviewIntegration,
} from '../../authoring/src/index.js';
import { createDraftHandler } from '../../authoring/src/drafts.js';
import type { UploadReviewBinding } from '../../upload-reviews/src/index.js';
import { createBuilderBffHandler, type BuilderBffRuntime } from './builder.js';
import {
  OpenClawConsumerSelectionError,
  createOpenClawFeedAdvertisement,
  createOpenClawTenantFeedRoute,
  OpenClawPublicationManager,
  type OpenClawImportOperation,
  type OpenClawImportQueue,
  type OpenClawImportQueueRequest,
  previewOpenClawFeed,
  selectOpenClawEligibleRecords,
  type OpenClawApprovedSkillCandidate,
  type OpenClawFeedAdvertisement,
  type OpenClawFeedPublicationSnapshot,
  type OpenClawMetadataSnapshot,
  type OpenClawPublicationReader,
  type OpenClawSourceArtifactProof,
  type OpenClawStoredPublication,
  type OpenClawTrustedFeedProfile,
} from '../../openclaw-adapter/src/index.ts';
import {
  OPENCLAW_CLAWHUB_SKILLS_COMPATIBILITY_PROFILE,
  OPENCLAW_CLAWHUB_SKILLS_FEED_ID,
  effectiveOpenClawFeedExpiry,
  isOpenClawClawHubSkillsCompatibilityIdentity,
  OPENCLAW_CLAWHUB_SKILLS_MAX_TTL_MS,
  normalizeOpenClawCandidate,
  parseOpenClawFeed,
  type OpenClawFeedEntry,
} from '../../openclaw/src/index.ts';
import { SERVICE_VERSION } from '../../contracts/src/version.js';

/**
 * The registry handler is deliberately implemented using only Web APIs.  The
 * persistence, authentication, and private object store are injected by the
 * Nitro adapter (or by a test), which keeps this package usable on Node and
 * edge Nitro targets alike.
 */

const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;
const DEFAULT_LEASE_SECONDS = 300;
const TRANSFER_TTL_SECONDS = 60;
const INSTALL_RECEIPT_TTL_SECONDS = 24 * 60 * 60;
const INSTALL_RECEIPT_RETENTION_SECONDS = 90 * 24 * 60 * 60;
const MAX_ANALYTICS_DAYS = 90;
const MAX_INSTALL_RECEIPTS = 100_000;
const MAX_INSTALL_RECEIPT_TICKETS = 100_000;
const MAX_CLIENT_VERSION_LENGTH = 128;
const DIRECTORY_METADATA_LOOKUP_DEADLINE_MS = 30_000;
const DIRECTORY_METADATA_LOOKUP_MAX_PAGES = 100;
const DIRECTORY_ID_MAX_SEGMENTS = 64;
const DIRECTORY_ID_MAX_SEGMENT_BYTES = 512;
const SUPPORTED_SCANNERS: readonly ScannerId[] = [
  'cisco-skill-scanner',
  'nvidia-skillspector',
  'skillsguard',
];
const SCAN_STATUSES = new Set<ScanResult['status']>([
  'completed',
  'degraded',
  'error',
  'timeout',
  'unsupported',
]);
const JOB_STATES = new Set<Job['state']>(['queued', 'running', 'completed', 'failed']);
const PACK_STATES = new Set<PackVersion['state']>(['approved', 'revoked']);
const SEVERITIES = new Set<Finding['severity']>([
  'info',
  'low',
  'medium',
  'high',
  'critical',
]);
const DISTRIBUTION_STATES = new Set<DistributionState>([
  'pending',
  'approved',
  'quarantined',
  'scan-error',
  'revoked',
]);
const ROLES = new Set<Role>(['owner', 'admin', 'publisher', 'reader', 'worker']);
const POLICY_MODES = new Set<ScannerPolicy['mode']>([
  'disabled',
  'advisory',
  'required',
]);
const HOOK_MODES = new Set<'disabled' | 'advisory' | 'required'>([
  'disabled',
  'advisory',
  'required',
]);
const HOOK_EVENTS = new Set<NonNullable<Policy['hooks']>[number]['event']>([
  'ingest.validate',
  'artifact.evaluate',
  'pack.evaluate',
  'artifact.approved',
  'artifact.quarantined',
]);

type JsonObject = Record<string, unknown>;
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type AuthenticatedPrincipalShape = Principal & {
  identity?: unknown;
  scopes?: unknown;
};

export class RegistryApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    status = 400,
    options?: { retryable?: boolean; details?: Record<string, unknown> },
  ) {
    super(message);
    this.name = 'RegistryApiError';
    this.code = code;
    this.status = status;
    this.retryable = options?.retryable ?? false;
    this.details = options?.details;
  }
}

export interface RegistryHandler {
  (request: Request): Promise<Response>;
}

/**
 * The directory adapter is injected so the core remains portable and never
 * performs a source fetch itself.  A structural interface keeps the core
 * independent from a provider SDK while accepting SkillsDirectoryClient and
 * small test fakes alike.
 */
export interface RegistryDirectoryClient {
  list(options?: { view?: 'all-time' | 'trending' | 'hot'; page?: number; perPage?: number; signal?: AbortSignal }): Promise<SkillListResponse>;
  search(options: { q: string; owner?: string; limit?: number; signal?: AbortSignal }): Promise<SkillSearchResponse>;
  curated(options?: { signal?: AbortSignal }): Promise<CuratedSkillsResponse>;
  detail(id: string, options?: { signal?: AbortSignal }): Promise<SkillDetailResponse>;
  audit(id: string, options?: { signal?: AbortSignal }): Promise<SkillAuditResponse>;
  /** Return one validated, source-backed topic page DTO. */
  topic?(slug: string, options?: { signal?: AbortSignal }): Promise<SkillsTopicResponse>;
}

/**
 * Server-owned context attached to discovery responses.  `feedName` is null
 * for the global directory view, even when a default catalog client is
 * configured; it is populated only after a caller explicitly selects and is
 * authorized for a persisted feed.  Per-row source metadata remains owned by
 * the directory adapter, so core never invents freshness timestamps or
 * interprets catalog status as registry approval.
 */
export interface DirectoryDiscoveryContext {
  feedName: string | null;
}

export type DirectoryDiscoveryResponse<T extends object> = T & DirectoryDiscoveryContext;

/** Public route DTOs widen the server-owned feed context without changing the
 * directory adapter's normalized `feedName: null` provider contract. */
export type DirectoryPublicSkill = Omit<V1Skill, 'feedName'> & DirectoryDiscoveryContext;
export type DirectoryPublicSkillListResponse = Omit<SkillListResponse, 'data'> & {
  data: DirectoryPublicSkill[];
} & DirectoryDiscoveryContext;
export type DirectoryPublicSkillSearchResponse = Omit<SkillSearchResponse, 'data'> & {
  data: DirectoryPublicSkill[];
} & DirectoryDiscoveryContext;
export type DirectoryPublicCuratedResponse = Omit<CuratedSkillsResponse, 'data'> & {
  data: Array<Omit<CuratedSkillsResponse['data'][number], 'skills'> & { skills: DirectoryPublicSkill[] }>;
} & DirectoryDiscoveryContext;
export type DirectoryPublicDetailResponse = Omit<SkillDetailMetadataResponse, 'feedName'> & DirectoryDiscoveryContext;
export type DirectoryPublicAuditResponse = SkillAuditResponse & DirectoryDiscoveryContext;

type DirectorySourceStatus =
  | 'metadata-only'
  | 'snapshot-available'
  | 'source-resolved'
  | 'changed'
  | 'unavailable'
  | 'rejected';

interface DirectoryFoundationMetadata {
  provider?: 'skills.sh';
  fetchedAt?: string;
  sourceStatus?: DirectorySourceStatus;
  sourceReason?: string;
}

/** Metadata-only pack discovery seam; member bytes remain a separate worker operation. */
export interface RegistryDirectoryPackClient {
  inspect(input: string | URL): Promise<SkillsPackManifest>;
}

/**
 * A verifier-backed candidate for the private OpenClaw publication. The
 * worker owns construction of `entry` and `sourceArtifact`; core only binds
 * it to an existing registry skill and rechecks the current policy.
 */
export interface RegistryOpenClawCandidate {
  skillId: string;
  skill: OpenClawApprovedSkillCandidate['skill'];
  entry: OpenClawFeedEntry;
  sourceArtifact: OpenClawSourceArtifactProof;
}

/** Completion seam for the durable source-proof store owned by the adapter. */
export interface RegistryOpenClawSourceProofCompletion {
  tenantId: string;
  completionJobId: string;
  skillId: string;
  entry: OpenClawFeedEntry;
  sourceArtifact: OpenClawSourceArtifactProof;
}

export interface RegistryOpenClawConsumerDependencies {
  /** Refreshes the configured trusted snapshot before a selection. */
  refresh?: (signal: AbortSignal) => Promise<{
    kind: string;
    snapshot?: OpenClawMetadataSnapshot;
  }>;
  /** Selects one verified snapshot entry and queues the canonical import job. */
  selectAndQueue: (input: {
    key: { tenantId: string; feedId: string; sourceUrl: string };
    externalId: string;
    principal: Principal;
    signal?: AbortSignal;
  }) => Promise<{ operationId: string; state: 'queued' | 'running' }>;
}

/**
 * Server-owned queue options for the OpenClaw consumer.  The queue is kept in
 * core because the public selection route must derive the import name,
 * upstream identity, policy snapshot, and worker source descriptor together
 * in one transaction.  Browser input never reaches this seam.
 */
export interface RegistryOpenClawImportQueueOptions {
  repository: StateRepository;
  organizationId: string;
  namespace: string;
  /** Operator-owned HTTPS origin used by the hosted source adapter. */
  sourceProviderOrigin: string;
  now?: () => number;
}

/** Build the durable import queue consumed by OpenClawTrustedSnapshotImportService. */
export function createOpenClawImportQueue(
  options: RegistryOpenClawImportQueueOptions,
): OpenClawImportQueue {
  const namespace = validateOpenClawQueueNamespace(options.namespace);
  const sourceProviderOrigin = validateOpenClawSourceProviderOrigin(options.sourceProviderOrigin);
  const now = options.now ?? Date.now;
  if (!options.repository || typeof options.repository.read !== 'function' || typeof options.repository.transaction !== 'function') {
    throw new RegistryApiError('INVALID_CONFIGURATION', 'OpenClaw import queue storage is invalid', 500);
  }
  if (!options.organizationId || typeof options.organizationId !== 'string') {
    throw new RegistryApiError('INVALID_CONFIGURATION', 'OpenClaw import queue organization is invalid', 500);
  }

  return {
    async enqueue(input: OpenClawImportQueueRequest): Promise<OpenClawImportOperation> {
      if (input.signal?.aborted) throw new RegistryApiError('REQUEST_ABORTED', 'The OpenClaw selection was cancelled', 400);
      if (input.tenantId !== options.organizationId || input.principal.organizationId !== options.organizationId) {
        throw new RegistryApiError('FORBIDDEN', 'The OpenClaw consumer tenant is not authorized', 403);
      }
      if (!canReadNamespace(input.principal, namespace)) {
        throw new RegistryApiError('FORBIDDEN', 'The OpenClaw feed namespace is denied', 403);
      }
      const queueNow = now();
      validateOpenClawQueueFeed(input, queueNow);
      const normalized = normalizeOpenClawQueueEntry(input.entry);
      const source = normalized.source;
      const feedDigest = input.feedDigest;
      if (!/^sha256:[0-9a-f]{64}$/u.test(feedDigest)) {
        throw new RegistryApiError('OPENCLAW_CONSUMER_UNAVAILABLE', 'The trusted OpenClaw feed digest is invalid', 503, { retryable: true });
      }
      if (!Number.isSafeInteger(input.feedSequence) || input.feedSequence < 0) {
        throw new RegistryApiError('OPENCLAW_CONSUMER_UNAVAILABLE', 'The trusted OpenClaw feed sequence is invalid', 503, { retryable: true });
      }
      const sourceIdentity = openClawQueueSourceIdentity(source);
      const sourceKey = await digestBytes(new TextEncoder().encode(sourceIdentity));
      const managedName = `${namespace}/openclaw-${sourceKey.slice('sha256:'.length, 'sha256:'.length + 48)}`;
      const version = openClawQueueVersion(input.entry.version, source);
      const upstreamIdDigest = await digestBytes(new TextEncoder().encode(`${sourceProviderOrigin}\u0000${sourceIdentity}`));
      const upstreamId = `openclaw-${upstreamIdDigest.slice('sha256:'.length, 'sha256:'.length + 32)}`;
      const upstream: Upstream = {
        id: upstreamId,
        organizationId: options.organizationId,
        name: `openclaw-${source.kind === 'public-clawhub' ? 'clawhub' : 'github'}`,
        kind: source.kind === 'public-github' ? 'github' : 'registry',
        enabled: true,
        repositories: source.kind === 'public-github' ? [source.repo] : [sourceProviderOrigin],
        baseUrl: source.kind === 'public-github' ? 'https://api.github.com' : sourceProviderOrigin,
        namespace,
      };
      const importRequest: ImportRequest = {
        upstreamId,
        repository: source.kind === 'public-github' ? source.repo : sourceProviderOrigin,
        path: source.kind === 'public-github' ? source.path : source.packageName,
        ...(source.kind === 'public-github' ? { ref: source.commit } : {}),
        name: managedName,
        version,
        externalId: input.externalId,
      };
      const sourceDescriptor = {
        source,
        entry: input.entry,
        feed: {
          id: input.feedId,
          sequence: input.feedSequence,
          digest: feedDigest,
          sourceUrl: input.sourceUrl,
          generatedAt: input.feedGeneratedAt,
          expiresAt: input.feedExpiresAt,
          ...(input.feedCompatibilityProfile === undefined ? {} : { compatibilityProfile: input.feedCompatibilityProfile }),
        },
      };
      return await options.repository.transaction(options.organizationId, (state) => {
        const mutable = ensureState(state, defaultPolicy());
        const sameSource = (job: Job): boolean => {
          if (job.organizationId !== options.organizationId || job.kind !== 'import' || !job.import || !isObject(job.openclawSource)) return false;
          if (job.import.externalId !== input.externalId || job.import.name !== managedName || !job.upstream) return false;
          if (job.upstream.id !== upstream.id || !sameUpstreamOrigin(job.upstream, upstream)) return false;
          const descriptor = job.openclawSource;
          return isObject(descriptor.source) && stableStringify(descriptor.source) === stableStringify(source) &&
            sameOpenClawQueueFeed(descriptor.feed, sourceDescriptor.feed);
        };
        const candidates = mutable.jobs
          .filter(sameSource)
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
        const active = candidates.find((job) => job.state === 'queued' || job.state === 'running');
        if (active) return { operationId: active.id, state: active.state === 'queued' ? 'queued' : 'running' };
        const completed = candidates.find((job) => job.state === 'completed' && job.resourceId);
        if (completed) {
          const skill = mutable.skills.find((candidate) => candidate.id === completed.resourceId);
          if (skill && skillCurrentlyApproved(mutable, skill, queueNow)) {
            return { operationId: completed.id, state: 'running' };
          }
          const scan = skill && mutable.jobs.find((job) => job.kind === 'scan' && job.resourceId === skill.id && (job.state === 'queued' || job.state === 'running'));
          if (scan) return { operationId: scan.id, state: 'running' };
        }
        if (mutable.skills.some((skill) => skill.organizationId === options.organizationId && skill.name === managedName && skill.version === version)) {
          throw new RegistryApiError('PROVENANCE_CONFLICT', 'The OpenClaw source identity is already bound to a different release', 409);
        }
        const job: Job = {
          id: randomId('job'),
          organizationId: options.organizationId,
          kind: 'import',
          state: 'queued',
          policyRevision: mutable.policy.revision,
          policy: clonePolicy(mutable.policy),
          import: importRequest,
          upstream,
          openclawSource: sourceDescriptor,
          createdAt: new Date(queueNow).toISOString(),
          updatedAt: new Date(queueNow).toISOString(),
          attempts: 0,
        };
        mutable.jobs.push(job);
        appendAudit(mutable, audit(input.principal, 'openclaw.import.queued', job.id, {
          feedId: input.feedId,
          feedSequence: input.feedSequence,
          feedDigest,
          externalId: input.externalId,
          source: source.kind,
        }, options.organizationId));
        return { operationId: job.id, state: 'queued' as const };
      });
    },
  };
}

/**
 * Optional OpenClaw composition. The route is disabled when this is absent.
 * A configured feed without a verifier-backed candidate provider can serve an
 * already persisted publication, but cannot refresh it.
 */
export interface RegistryOpenClawDependencies {
  enabled?: boolean;
  feedId: string;
  feedUrl: string;
  publicationManager: OpenClawPublicationManager & OpenClawPublicationReader;
  /** Server-side source verifier output; never derived from catalog rows. */
  candidatesForTenant?: (input: {
    tenantId: string;
    principal: Principal;
    state: RegistryState;
    metadata?: OpenClawMetadataSnapshot;
    signal: AbortSignal;
  }) => Promise<readonly RegistryOpenClawCandidate[]> | readonly RegistryOpenClawCandidate[];
  /** Persist a proof only after the core has accepted an import completion. */
  recordSourceProof?: (input: RegistryOpenClawSourceProofCompletion) => Promise<unknown> | unknown;
  /** Optional consumer selection path for an explicitly configured trusted feed. */
  consumer?: RegistryOpenClawConsumerDependencies;
  /** Internal namespace used for server-generated imported release names. */
  namespace?: string;
  /** Operator-owned source provider origin used by OpenClaw worker jobs. */
  sourceProviderOrigin?: string;
  /** Optional trusted-feed metadata source. It is metadata-only and bounded. */
  trustedFeed?: OpenClawTrustedFeedProfile;
  /**
   * Reads the latest validated persisted trusted-feed metadata without doing
   * network I/O. A configured trusted feed must provide this for publication
   * reads to recheck current upstream eligibility.
   */
  currentTrustedMetadata?: () => Promise<OpenClawMetadataSnapshot | undefined> | OpenClawMetadataSnapshot | undefined;
  now?: () => number;
}

export type RegistryHandlerDependencies = RegistryDependencies & {
  directory?: RegistryDirectoryClient;
  /** Resolve the metadata client bound to one exact transparent feed base. */
  directoryForBase?: (baseUrl: string) => RegistryDirectoryClient | undefined;
  directoryPacks?: RegistryDirectoryPackClient;
  /** Optional separate upload/edit reviewer; scanner admission remains core-owned. */
  uploadReview?: UploadReviewIntegration;
  /** Optional same-origin facade for the separately deployed skill builder. */
  builder?: BuilderBffRuntime;
  openClaw?: RegistryOpenClawDependencies;
};

/** A safe, empty state used by memory repositories and migration shims. */
export function createEmptyRegistryState(policy: Policy = defaultPolicy()): RegistryState {
  return {
    schemaVersion: 1,
    skills: [],
    packs: [],
    jobs: [],
    scans: [],
    policy,
    upstreams: [],
    feeds: [],
    authorizations: [],
    installReceiptTickets: [],
    installReceipts: [],
    builderSessions: [],
    grants: [],
    audit: [],
  };
}

export function defaultPolicy(): Policy {
  return {
    revision: 'policy-initial',
    scanners: SUPPORTED_SCANNERS.map((id) => ({
      id,
      mode: 'disabled',
      blockSeverities: ['high', 'critical'],
      timeoutSeconds: 300,
    })),
    // A registry must opt in to distribution without scanner evidence.  This
    // default makes an unconfigured deployment fail closed.
    allowUnscanned: false,
    evidenceMaxAgeSeconds: 7 * 24 * 60 * 60,
    hooks: [],
  };
}

/**
 * Resolve the server-owned upload-review binding from the current draft state.
 * Queue transactions call this pure helper through their injected resolver so
 * an old review cannot complete or accept a decision after a draft save.
 */
export function resolveCurrentUploadReviewBinding(
  state: RegistryState,
  draftId: string,
): UploadReviewBinding | undefined {
  const draft = state.drafts?.find((candidate) => candidate.id === draftId);
  if (!draft) return undefined;
  const base = draft.baseResourceId === undefined
    ? undefined
    : state.skills.find((candidate) => candidate.id === draft.baseResourceId);
  if (
    draft.baseResourceId !== undefined &&
    (!base || !skillCurrentlyApproved(state, base) || draft.baseDigest !== base.artifact.digest)
  ) return undefined;
  return {
    draftId: draft.id,
    draftRevision: draft.revision,
    contentDigest: draft.digest,
    ...(draft.baseResourceId === undefined ? {} : { baseReleaseId: draft.baseResourceId }),
    ...(base?.version === undefined ? {} : { baseReleaseVersion: base.version }),
    ...(draft.baseDigest === undefined ? {} : { baseDigest: draft.baseDigest }),
    policyRevision: state.policy.revision,
  };
}

/**
 * Create a portable Request -> Response registry API.
 *
 * The handler does not call fetch, read a filesystem, execute an uploaded
 * script, or use a provider SDK.  Network/source acquisition and scanning are
 * worker responsibilities and arrive through the fenced job completion route.
 */
export function createRegistryHandler(deps: RegistryHandlerDependencies): RegistryHandler {
  const config = normalizeConfiguration(deps.config);
  const builderBff = deps.builder
    ? createBuilderBffHandler({
      repository: deps.repository,
      blobs: deps.blobs,
      auth: deps.auth,
      config: {
        organizationId: config.organizationId,
        publicOrigin: config.publicOrigin,
        maxBodyBytes: config.maxBodyBytes,
      },
      authoring: createAuthoringHandlerDependencies({
        organizationId: config.organizationId,
        subject: 'builder-bff',
        roles: ['publisher'],
      }, deps, config),
      runtime: deps.builder,
    })
    : undefined;
  const openClaw = normalizeOpenClawDependencies(deps.openClaw);

  return async function registryHandler(request: Request): Promise<Response> {
    const requestId = randomId('req');

    try {
      const url = parseRequestUrl(request, config.publicOrigin);
      const method = request.method.toUpperCase() as HttpMethod;
      const path = normalizePath(url.pathname);
      const segments = splitPath(path);

      // Health is intentionally the first public route and contains no
      // authentication or deployment-specific information.
      if (method === 'GET' && path === '/health') {
        return jsonResponse({
          ok: true,
          service: 'private-skills',
          version: SERVICE_VERSION,
        }, 200, { 'cache-control': 'no-store' });
      }

      // Session exchange is the only authenticated API family that does not
      // require an existing principal.  CLI Bearer authentication is handled
      // by the injected authenticator for all other routes.
      if (segments[0] === 'auth' && segments[1] === 'session') {
        assertSessionRequestSafe(request, config, method);
        if (method === 'POST') {
          return await createSessionResponse(request, deps.auth, config.maxBodyBytes, config.organizationId);
        }
        if (method === 'DELETE') {
          return new Response(null, {
            status: 204,
            headers: {
              'cache-control': 'no-store',
              ...(deps.auth.clearSessionCookie
                ? { 'set-cookie': deps.auth.clearSessionCookie() }
                : {}),
            },
          });
        }
        return methodNotAllowed(['POST', 'DELETE']);
      }

      // A transfer grant is an opaque, short-lived capability.  It is not
      // a substitute for the current registry principal: same-origin gateway
      // reads must carry the user's current bearer or session credential.
      if (segments[0] === 'v1' && segments[1] === 'transfers' && segments.length === 3) {
        if (method !== 'GET') return methodNotAllowed(['GET']);
        assertTransferRequestSafe(request, config);
        const transferPrincipal = await authenticate(deps.auth, request);
        assertPrincipal(transferPrincipal, config.organizationId);
        assertUserPrincipal(transferPrincipal);
        requireRouteScopes(transferPrincipal, ['artifacts:download', 'install:read', 'registry:read']);
        return await serveTransferGrant(segments[2], transferPrincipal, deps, config, requestId);
      }

      const principal = await authenticate(deps.auth, request);
      assertPrincipal(principal, config.organizationId);
      const internalJobs = segments[0] === 'internal' && segments[1] === 'jobs';
      if (!internalJobs) assertUserPrincipal(principal);
      requireRouteScopes(principal, scopesForRoute(method, path, segments));

      if (builderBff && segments[0] === 'v1' && segments[1] === 'drafts' && segments[3] === 'builder') {
        // Builder POSTs are browser mutations as well as bearer-compatible
        // server calls.  Reuse the shared cookie-aware Origin policy so a
        // browser session cannot omit Origin, while CLI bearer callers may.
        if (method === 'POST') assertSessionRequestSafe(request, config, method);
        const response = await builderBff(request, principal);
        if (response) return response;
      }
      if (!builderBff && segments[0] === 'v1' && segments[1] === 'drafts' && segments[3] === 'builder') {
        if (method === 'GET' && segments[4] === 'availability') {
          return jsonResponse({ enabled: false, reason: 'The skill builder is not configured for this registry.' }, 200, { 'cache-control': 'no-store' });
        }
        return jsonResponse({ code: 'BUILDER_DISABLED', message: 'The skill builder is not configured for this registry.' }, 503, { 'cache-control': 'no-store' });
      }

      if (path === '/v1/me') {
        if (method !== 'GET') return methodNotAllowed(['GET']);
        return jsonResponse(publicPrincipal(principal));
      }

      if (path === '/v1/capabilities') {
        if (method !== 'GET') return methodNotAllowed(['GET']);
        requireReader(principal);
        return jsonResponse({
          protocolVersion: PROTOCOL_VERSION,
          schemaVersion: 1,
          service: 'private-skills',
          features: {
            bundles: ['pskills-bundle-v1'],
            packs: true,
            imports: true,
            proxyResolve: true,
            directory: !!deps.directory,
            installAuthorizations: true,
            installReceipts: true,
            uploadReview: {
              enabled: deps.uploadReview !== undefined,
              configured: deps.uploadReview?.configured === true,
            },
            openClaw: openClawCapability(openClaw),
            transferMode: 'gateway',
            rangeSupported: false,
          },
          limits: {
            maxBodyBytes: config.maxBodyBytes,
            leaseSeconds: config.leaseSeconds,
            transferTtlSeconds: TRANSFER_TTL_SECONDS,
          },
          scanners: [...SUPPORTED_SCANNERS],
        });
      }

      if (segments[0] === 'v1' && segments[1] === 'drafts') {
        return await createDraftHandler(
          createAuthoringHandlerDependencies(principal, deps, config),
        )(request);
      }

      if (segments[0] === 'v1' && segments[1] === 'directory') {
        return await handleDirectoryRoute(
          method,
          segments,
          url,
          request,
          principal,
          deps,
          config,
          requestId,
        );
      }

      if (segments[0] === 'v1' && segments[1] === 'skills') {
        return await handleSkillsRoute(
          method,
          segments,
          url,
          request,
          principal,
          deps,
          config,
          requestId,
        );
      }

      if (segments[0] === 'v1' && segments[1] === 'drafts') {
        return await createDraftHandler(
          createAuthoringHandlerDependencies(principal, deps, config),
        )(request);
      }

      if (segments[0] === 'v1' && segments[1] === 'publish' && segments.length === 2) {
        if (method !== 'POST') return methodNotAllowed(['POST']);
        requirePublisher(principal);
        const body = await readJson(request, config.maxBodyBytes);
        return await publishSkill(body, principal, deps, config, requestId);
      }

      if (segments[0] === 'v1' && segments[1] === 'resolve' && segments.length === 2) {
        if (method !== 'POST') return methodNotAllowed(['POST']);
        requireReader(principal);
        const body = await readJson(request, config.maxBodyBytes);
        return await resolveRoute(body, principal, deps, requestId);
      }

      if (segments[0] === 'v1' && segments[1] === 'operations') {
        return await handleOperationsRoute(
          method,
          segments,
          principal,
          deps,
          requestId,
        );
      }

      if (
        segments[0] === 'v1' &&
        segments[1] === 'install-authorizations'
      ) {
        return await handleInstallAuthorizationRoute(
          method,
          segments,
          request,
          principal,
          deps,
          config,
          requestId,
        );
      }

      if (segments[0] === 'v1' && segments[1] === 'install-receipts' && segments.length === 2) {
        if (method !== 'POST') return methodNotAllowed(['POST']);
        // A receipt is a browser-visible mutation as well as a report of a
        // local transaction.  Apply the same Origin/Sec-Fetch protections as
        // session mutations when the caller uses a cookie credential.
        assertSessionRequestSafe(request, config, method);
        requireReader(principal);
        const body = await readJson(request, config.maxBodyBytes);
        return await createInstallReceipt(body, principal, deps, config, requestId);
      }

      if (segments[0] === 'v1' && segments[1] === 'analytics' && segments.length === 2) {
        if (method !== 'GET') return methodNotAllowed(['GET']);
        requireAdmin(principal);
        const state = await readState(deps.repository, config.organizationId);
        return jsonResponse(buildInstallAnalytics(url, state, principal));
      }

      if (segments[0] === 'v1' && segments[1] === 'artifacts' && segments.length === 4) {
        if (method !== 'POST' || segments[3] !== 'download') {
          return methodNotAllowed(['POST']);
        }
        requireReader(principal);
        const body = await readJson(request, config.maxBodyBytes);
        return await createDownloadGrant(
          decodePathPart(segments[2]),
          body,
          principal,
          deps,
          config,
          requestId,
        );
      }

      if (segments[0] === 'v1' && segments[1] === 'packs') {
        return await handlePacksRoute(
          method,
          segments,
          request,
          principal,
          deps,
          config,
          requestId,
        );
      }

      if (segments[0] === 'v1' && segments[1] === 'policy') {
        if (method === 'GET') {
          requireReader(principal);
          const state = await readState(deps.repository, config.organizationId);
          return jsonResponse({ policy: state.policy });
        }
        if (method === 'PUT') {
          requireAdmin(principal);
          const body = await readJson(request, config.maxBodyBytes);
          return await updatePolicy(body, principal, deps, config, requestId);
        }
        return methodNotAllowed(['GET', 'PUT']);
      }

      if (segments[0] === 'v1' && segments[1] === 'scans') {
        if (method !== 'GET') return methodNotAllowed(['GET']);
        requireReader(principal);
        const state = await readState(deps.repository, config.organizationId);
        const artifactDigest = url.searchParams.get('artifactDigest');
        if (artifactDigest && !isDigest(artifactDigest)) {
          throw new RegistryApiError('INVALID_DIGEST', 'artifactDigest must be a sha256 digest');
        }
        const accessible = accessibleSkillIds(state, principal);
        const scans = state.scans.filter((scan) => {
          if (artifactDigest && scan.artifactDigest !== artifactDigest) return false;
          return state.skills.some(
            (skill) => skill.artifact.digest === scan.artifactDigest && accessible.has(skill.id),
          );
        });
        return jsonResponse({ scans });
      }

      if (segments[0] === 'v1' && segments[1] === 'feeds') {
        if (segments[2] === 'skills') {
          return await handleOpenClawRoute(
            method,
            segments,
            request,
            principal,
            deps,
            config,
            openClaw,
            requestId,
          );
        }
        return await handleFeedsRoute(
          method,
          segments,
          request,
          principal,
          deps,
          config,
          requestId,
        );
      }

      if (segments[0] === 'v1' && segments[1] === 'upstreams') {
        if (method === 'GET') {
          requireReader(principal);
          const state = await readState(deps.repository, config.organizationId);
          return jsonResponse({
            upstreams: state.upstreams.filter((upstream) => canReadNamespace(principal, upstream.namespace)),
          });
        }
        if (method === 'POST') {
          requireAdmin(principal);
          const body = await readJson(request, config.maxBodyBytes);
          return await createUpstream(body, principal, deps, config, requestId);
        }
        return methodNotAllowed(['GET', 'POST']);
      }

      if (segments[0] === 'v1' && segments[1] === 'imports' && segments.length === 2) {
        if (method !== 'POST') return methodNotAllowed(['POST']);
        requirePublisher(principal);
        const body = await readJson(request, config.maxBodyBytes);
        return await createImportJob(body, principal, deps, config, requestId);
      }

      // The explicit upstream/path form remains a publisher operation.  The
      // transparent skills.sh form is an install request: a reader with the
      // proxy capability may populate the governed cache, while the server
      // derives the private release identity and source mapping.
      if (segments[0] === 'v1' && segments[1] === 'proxy' && segments[2] === 'resolve' && segments.length === 3) {
        if (method !== 'POST') return methodNotAllowed(['POST']);
        requireReader(principal);
        const body = await readJson(request, config.maxBodyBytes);
        if (body.reference !== undefined) {
          requireRouteScopes(principal, ['proxy:resolve']);
          return await resolveSourceReferenceRequest(body, principal, deps, config, requestId);
        }
        if (isTransparentProxyRequest(body)) {
          requireRouteScopes(principal, ['proxy:resolve']);
          return await resolveTransparentProxyRequest(body, principal, deps, config, requestId, request.signal);
        }
        requireRouteScopes(principal, ['imports:create', 'skills:publish', 'proxy:resolve']);
        requirePublisher(principal);
        return await resolveProxyRequest(body, principal, deps, config, requestId);
      }

      if (segments[0] === 'v1' && segments[1] === 'audit') {
        if (method !== 'GET') return methodNotAllowed(['GET']);
        requireAdmin(principal);
        const state = await readState(deps.repository, config.organizationId);
        return jsonResponse({ events: state.audit });
      }

      if (segments[0] === 'internal' && segments[1] === 'jobs') {
        return await handleJobsRoute(
          method,
          segments,
          request,
          principal,
          deps,
          config,
          requestId,
        );
      }

      throw new RegistryApiError('NOT_FOUND', 'Route not found', 404);
    } catch (error) {
      return errorResponse(error, requestId);
    }
  };
}

function normalizeConfiguration(config: RegistryConfiguration): Required<RegistryConfiguration> {
  return {
    publicOrigin: config.publicOrigin || 'http://localhost',
    maxBodyBytes:
      Number.isFinite(config.maxBodyBytes) && config.maxBodyBytes > 0
        ? Math.floor(config.maxBodyBytes)
        : DEFAULT_MAX_BODY_BYTES,
    organizationId: config.organizationId,
    leaseSeconds:
      Number.isFinite(config.leaseSeconds) && config.leaseSeconds > 0
        ? Math.floor(config.leaseSeconds)
        : DEFAULT_LEASE_SECONDS,
    allowLoopbackUpstreams: config.allowLoopbackUpstreams ?? false,
    trustedSkillsShBaseUrls: normalizeTrustedSkillsShBaseUrls(config.trustedSkillsShBaseUrls),
  };
}

function normalizeTrustedSkillsShBaseUrls(value: readonly string[] | undefined): readonly string[] {
  const values = value === undefined ? ['https://skills.sh'] : value;
  if (!Array.isArray(values)) throw new RegistryApiError('INVALID_CONFIGURATION', 'trustedSkillsShBaseUrls must be an array', 500);
  return values.map((candidate) => {
    if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 2_048) {
      throw new RegistryApiError('INVALID_CONFIGURATION', 'trustedSkillsShBaseUrls contains an invalid URL', 500);
    }
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new RegistryApiError('INVALID_CONFIGURATION', 'trustedSkillsShBaseUrls contains an invalid URL', 500);
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new RegistryApiError('INVALID_CONFIGURATION', 'trustedSkillsShBaseUrls must contain HTTPS URLs without credentials or query data', 500);
    }
    return parsed.toString().replace(/\/$/u, '');
  });
}

function assertSessionRequestSafe(
  request: Request,
  config: Required<RegistryConfiguration>,
  method: HttpMethod,
): void {
  if (method !== 'POST' && method !== 'DELETE') return;
  const site = request.headers.get('sec-fetch-site')?.toLowerCase();
  if (site === 'cross-site') {
    throw new RegistryApiError('CSRF_DENIED', 'Cross-site session mutations are not allowed', 403);
  }
  const originHeader = request.headers.get('origin');
  if (originHeader) {
    let origin: string;
    try {
      origin = new URL(originHeader).origin;
    } catch {
      throw new RegistryApiError('CSRF_DENIED', 'Session request origin is invalid', 403);
    }
    let expected: string;
    try {
      expected = new URL(config.publicOrigin).origin;
    } catch {
      throw new RegistryApiError('CSRF_DENIED', 'Session origin policy is invalid', 403);
    }
    if (origin !== expected) {
      throw new RegistryApiError('CSRF_DENIED', 'Session request origin is not allowed', 403);
    }
  }
  // A CLI exchange has no cookie and may omit Origin. Once a browser cookie is
  // present, both login refresh and logout must carry a same-origin Origin.
  if (request.headers.get('cookie') && !originHeader) {
    throw new RegistryApiError('CSRF_DENIED', 'Origin is required for cookie session mutations', 403);
  }
}

function assertTransferRequestSafe(
  request: Request,
  config: Required<RegistryConfiguration>,
): void {
  if (request.headers.get('sec-fetch-site')?.toLowerCase() === 'cross-site') {
    throw new RegistryApiError('CSRF_DENIED', 'Cross-site transfer reads are not allowed', 403);
  }
  const originHeader = request.headers.get('origin');
  if (!originHeader) return;
  let origin: string;
  let expected: string;
  try {
    origin = new URL(originHeader).origin;
    expected = new URL(config.publicOrigin).origin;
  } catch {
    throw new RegistryApiError('CSRF_DENIED', 'Transfer request origin is invalid', 403);
  }
  if (origin !== expected) {
    throw new RegistryApiError('CSRF_DENIED', 'Transfer request origin is not allowed', 403);
  }
}

async function authenticate(auth: Authenticator, request: Request): Promise<Principal> {
  try {
    const principal = await auth.authenticate(request);
    if (!principal) throw new RegistryApiError('UNAUTHORIZED', 'Authentication required', 401);
    return principal;
  } catch (error) {
    if (error instanceof RegistryApiError) throw error;
    if (isObject(error) && typeof error.code === 'string' && Number.isFinite(Number(error.status))) {
      throw new RegistryApiError(error.code, typeof error.message === 'string' ? error.message : 'Authentication failed', Number(error.status));
    }
    throw new RegistryApiError('UNAUTHORIZED', 'Authentication required', 401);
  }
}

function assertPrincipal(principal: Principal, organizationId: string): void {
  if (
    !principal ||
    typeof principal.subject !== 'string' ||
    principal.subject.trim() === '' ||
    typeof principal.organizationId !== 'string' ||
    principal.organizationId.trim() === ''
  ) {
    throw new RegistryApiError('UNAUTHORIZED', 'Authentication required', 401);
  }
  if (principal.organizationId !== organizationId) {
    throw new RegistryApiError('FORBIDDEN', 'Organization access denied', 403);
  }
  const identity = (principal as AuthenticatedPrincipalShape).identity;
  if (
    identity !== undefined &&
    identity !== 'user' &&
    identity !== 'worker'
  ) {
    throw new RegistryApiError('FORBIDDEN', 'Principal identity is invalid', 403);
  }
  if (
    principal.namespaces !== undefined &&
    (!Array.isArray(principal.namespaces) || principal.namespaces.some((namespace) => typeof namespace !== 'string' || namespace.trim() === ''))
  ) {
    throw new RegistryApiError('FORBIDDEN', 'Principal namespace grants are invalid', 403);
  }
  const scopes = (principal as AuthenticatedPrincipalShape).scopes;
  if (scopes !== undefined && (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== 'string' || scope.trim() === ''))) {
    throw new RegistryApiError('FORBIDDEN', 'Principal scopes are invalid', 403);
  }
  if (
    !Array.isArray(principal.roles) ||
    principal.roles.length === 0 ||
    principal.roles.some((role) => !ROLES.has(role))
  ) {
    throw new RegistryApiError('FORBIDDEN', 'No registry role is assigned', 403);
  }
  if (identity === 'user' && principal.roles.includes('worker')) {
    throw new RegistryApiError('FORBIDDEN', 'Worker roles require a worker identity', 403);
  }
  if (identity === 'worker' && !principal.roles.includes('worker')) {
    throw new RegistryApiError('FORBIDDEN', 'Worker identity requires the worker role', 403);
  }
}

function assertUserPrincipal(principal: Principal): void {
  const identity = (principal as AuthenticatedPrincipalShape).identity;
  if (identity === 'worker' || principal.roles.includes('worker')) {
    throw new RegistryApiError('FORBIDDEN', 'Worker identity cannot access this route', 403);
  }
}

function principalScopes(principal: Principal): string[] | undefined {
  const value = (principal as AuthenticatedPrincipalShape).scopes;
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((scope) => typeof scope !== 'string' || scope.trim() === '')) {
    throw new RegistryApiError('FORBIDDEN', 'Principal scopes are invalid', 403);
  }
  return value as string[];
}

function hasAnyScope(principal: Principal, required: readonly string[]): boolean {
  const scopes = principalScopes(principal);
  // Injected test/adaptor principals predating scoped auth have no `scopes`
  // field. The role and namespace checks remain their authorization boundary;
  // an explicit scopes array is what opts a principal into scope enforcement.
  if (!scopes) return true;
  if (scopes.length === 0) return false;
  if (scopes.includes('registry:*')) return true;
  return scopes.some((granted) => {
    if (granted === '*') return true;
    return required.some((candidate) => granted === candidate || (granted.endsWith(':*') && candidate.startsWith(granted.slice(0, -1))));
  });
}

function requireRouteScopes(principal: Principal, required: readonly string[]): void {
  if (required.length > 0 && !hasAnyScope(principal, required)) {
    throw new RegistryApiError('FORBIDDEN', 'The principal lacks the required scope', 403);
  }
}

function scopesForRoute(method: HttpMethod, path: string, segments: string[]): readonly string[] {
  if (path === '/v1/me') return [];
  if (path === '/v1/capabilities') return ['registry:read'];
  if (segments[0] === 'v1' && segments[1] === 'drafts' && (segments[3] === 'builder-context' || segments[3] === 'builder-file')) {
    return ['skills:builder'];
  }
  if (segments[0] === 'v1' && segments[1] === 'drafts' && segments[3] === 'proposals' && segments.length === 4 && method === 'POST') {
    return ['skills:builder'];
  }
  if (segments[0] === 'v1' && segments[1] === 'skills') {
    if (segments.length === 2 || (segments.length === 3 && method === 'GET')) return ['skills:read', 'registry:read'];
    if (segments.length === 4 && (segments[3] === 'files' || segments[3] === 'file')) return ['skills:read', 'registry:read'];
    if (segments.length === 4 && segments[3] === 'drafts') return ['skills:write', 'skills:publish'];
    if (segments.length === 4 && segments[3] === 'rescan') return ['skills:rescan', 'skills:write', 'skills:publish'];
    if (segments.length === 4 && segments[3] === 'revoke') return ['skills:revoke', 'skills:write', 'skills:admin'];
  }
  if (segments[0] === 'v1' && segments[1] === 'publish') return ['skills:publish', 'skills:write'];
  if (segments[0] === 'v1' && segments[1] === 'drafts') return ['skills:write', 'skills:publish'];
  if (segments[0] === 'v1' && segments[1] === 'resolve') return ['skills:read', 'packs:read', 'registry:read'];
  if (segments[0] === 'v1' && segments[1] === 'operations') return ['jobs:read', 'registry:read'];
  if (segments[0] === 'v1' && segments[1] === 'install-authorizations') {
    return segments.length === 4 ? ['install:validate', 'artifacts:download', 'registry:read'] : ['install:authorize', 'artifacts:download', 'registry:read'];
  }
  if (segments[0] === 'v1' && segments[1] === 'install-receipts') {
    return ['install:receipt', 'analytics:write'];
  }
  if (segments[0] === 'v1' && segments[1] === 'analytics') {
    return ['analytics:read', 'registry:admin'];
  }
  if (segments[0] === 'v1' && segments[1] === 'directory') {
    return segments.length === 3 && segments[2] === 'import'
      ? ['imports:create', 'skills:publish', 'proxy:resolve']
      : ['skills:read', 'registry:read'];
  }
  if (segments[0] === 'v1' && segments[1] === 'artifacts') return ['artifacts:download', 'install:read', 'registry:read'];
  if (segments[0] === 'v1' && segments[1] === 'packs') return method === 'GET' ? ['packs:read', 'registry:read'] : ['packs:publish', 'packs:write'];
  if (segments[0] === 'v1' && segments[1] === 'policy') return method === 'GET' ? ['policy:read', 'registry:read'] : ['policy:write', 'policy:admin'];
  if (segments[0] === 'v1' && segments[1] === 'scans') return ['scans:read', 'registry:read'];
  if (segments[0] === 'v1' && segments[1] === 'feeds' && segments[2] === 'skills') {
    if ((segments.length === 3 || (segments.length === 4 && segments[3] === 'catalog')) && method === 'GET') return ['registry:read'];
    if (segments.length === 4 && segments[3] === 'refresh' && method === 'POST') return ['registry:admin'];
    if (segments.length === 4 && segments[3] === 'import' && method === 'POST') return ['proxy:resolve'];
    return ['registry:admin'];
  }
  if (segments[0] === 'v1' && segments[1] === 'feeds') return method === 'GET' ? ['registry:read'] : ['upstreams:write', 'upstreams:admin'];
  if (segments[0] === 'v1' && segments[1] === 'upstreams') return method === 'GET' ? ['upstreams:read', 'registry:read'] : ['upstreams:write', 'upstreams:admin'];
  if (segments[0] === 'v1' && segments[1] === 'imports') return ['imports:create', 'upstreams:write', 'skills:publish', 'proxy:resolve'];
  // The request body determines whether this is a reader cache-fill or the
  // legacy publisher form.  Enforce the capability after parsing the body so
  // registry:read alone can never authorize a pull-through side effect.
  if (segments[0] === 'v1' && segments[1] === 'proxy' && segments[2] === 'resolve') return [];
  if (segments[0] === 'v1' && segments[1] === 'audit') return ['audit:read', 'registry:admin'];
  if (segments[0] === 'internal' && segments[1] === 'jobs') {
    if (segments.length === 3 && segments[2] === 'claim') return ['jobs:claim'];
    if (segments.length === 4 && segments[3] === 'artifact') return ['jobs:artifact', 'jobs:read'];
    if (segments.length === 4 && segments[3] === 'complete') return ['jobs:complete'];
    return ['jobs:read'];
  }
  return [];
}

function publicPrincipal(principal: Principal): Principal {
  const scopes = principalScopes(principal);
  return {
    organizationId: principal.organizationId,
    subject: principal.subject,
    roles: [...principal.roles],
    namespaces: principal.namespaces ? [...principal.namespaces] : undefined,
    ...(scopes === undefined ? {} : { scopes: [...scopes] }),
  };
}

function requireReader(principal: Principal): void {
  if (!hasRole(principal, 'reader') && !hasRole(principal, 'publisher') && !hasRole(principal, 'admin') && !hasRole(principal, 'owner')) {
    throw new RegistryApiError('FORBIDDEN', 'Reader role required', 403);
  }
}

function requirePublisher(principal: Principal): void {
  if (!hasRole(principal, 'publisher') && !hasRole(principal, 'admin') && !hasRole(principal, 'owner')) {
    throw new RegistryApiError('FORBIDDEN', 'Publisher role required', 403);
  }
}

function requireAdmin(principal: Principal): void {
  if (!hasRole(principal, 'admin') && !hasRole(principal, 'owner')) {
    throw new RegistryApiError('FORBIDDEN', 'Administrator role required', 403);
  }
}

function requireWorker(principal: Principal): void {
  if (!hasRole(principal, 'worker')) {
    throw new RegistryApiError('FORBIDDEN', 'Worker role required', 403);
  }
}

function hasRole(principal: Principal, role: Role): boolean {
  return Array.isArray(principal.roles) && principal.roles.includes(role);
}

function canReadNamespace(principal: Principal, namespaceOrName: string): boolean {
  if (hasRole(principal, 'owner') || hasRole(principal, 'admin')) return true;
  const namespace = namespaceOrName.startsWith('@')
    ? namespaceOrName.split('/')[0]
    : namespaceOrName;
  if (!hasRole(principal, 'reader') && !hasRole(principal, 'publisher')) return false;
  if (!principal.namespaces || principal.namespaces.length === 0) return true;
  return principal.namespaces.some((candidate) => candidate === namespace || candidate === namespace.slice(1));
}

function canPublishName(principal: Principal, name: string): boolean {
  return (hasRole(principal, 'owner') || hasRole(principal, 'admin') || hasRole(principal, 'publisher')) && canReadNamespace(principal, name);
}

function splitPath(path: string): string[] {
  if (path === '/') return [];
  return path.split('/').filter(Boolean);
}

function normalizePath(pathname: string): string {
  if (!pathname || pathname === '/') return '/';
  const path = pathname.replaceAll('\\', '/').replace(/\/+/g, '/');
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

function parseRequestUrl(request: Request, publicOrigin: string): URL {
  try {
    return new URL(request.url, publicOrigin);
  } catch {
    throw new RegistryApiError('INVALID_REQUEST', 'Request URL is invalid', 400);
  }
}

function decodePathPart(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    throw new RegistryApiError('INVALID_REQUEST', 'Path parameter is invalid', 400);
  }
}

async function readJson(request: Request, maxBodyBytes: number): Promise<JsonObject> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength && Number.isFinite(Number(declaredLength)) && Number(declaredLength) > maxBodyBytes) {
    throw new RegistryApiError('PAYLOAD_TOO_LARGE', 'Request body exceeds the configured limit', 413);
  }
  let bytes: ArrayBuffer;
  try {
    bytes = await request.arrayBuffer();
  } catch {
    throw new RegistryApiError('INVALID_REQUEST', 'Request body could not be read', 400);
  }
  if (bytes.byteLength > maxBodyBytes) {
    throw new RegistryApiError('PAYLOAD_TOO_LARGE', 'Request body exceeds the configured limit', 413);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new RegistryApiError('INVALID_JSON', 'Request body must be valid JSON', 400);
  }
  if (!isObject(parsed)) {
    throw new RegistryApiError('INVALID_JSON', 'Request body must be a JSON object', 400);
  }
  return parsed;
}

async function createSessionResponse(
  request: Request,
  auth: Authenticator,
  maxBodyBytes: number,
  organizationId: string,
): Promise<Response> {
  if (!auth.createSession) {
    throw new RegistryApiError('UNSUPPORTED', 'Session authentication is not configured', 501);
  }
  const body = await readJson(request, maxBodyBytes);
  const token = stringValue(body.token);
  if (!token) throw new RegistryApiError('INVALID_TOKEN', 'A session token is required', 400);
  const result = await auth.createSession(token);
  if (!result) throw new RegistryApiError('UNAUTHORIZED', 'Session token is invalid', 401);
  assertPrincipal(result.principal, organizationId);
  assertUserPrincipal(result.principal);
  return jsonResponse({ principal: publicPrincipal(result.principal) }, 200, {
    'cache-control': 'no-store',
    'set-cookie': result.cookie,
  });
}

/**
 * Compose authoring adapters with the core's already-authenticated actor.
 * Keeping this request-local prevents a second credential lookup from
 * observing a different actor while retaining one repository/blob/config
 * boundary for both read-only release views and mutable drafts.
 */
function createAuthoringHandlerDependencies(
  principal: Principal,
  deps: RegistryHandlerDependencies,
  config: Required<RegistryConfiguration>,
): AuthoringHandlerDependencies {
  return {
    repository: deps.repository,
    blobs: deps.blobs,
    auth: { authenticate: async () => principal },
    config: {
      organizationId: config.organizationId,
      maxBodyBytes: config.maxBodyBytes,
    },
    releaseAdmission: (state, release, releasePrincipal) =>
      releasePrincipal.organizationId === config.organizationId &&
      canReadNamespace(releasePrincipal, release.name) &&
      skillCurrentlyApproved(state, release),
    releaseAdmissionAtCommit: (state, release, releasePrincipal) =>
      releasePrincipal.organizationId === config.organizationId &&
      canReadNamespace(releasePrincipal, release.name) &&
      skillCurrentlyApproved(state, release),
    ...(deps.uploadReview === undefined ? {} : { uploadReview: deps.uploadReview }),
  };
}

async function handleSkillsRoute(
  method: HttpMethod,
  segments: string[],
  url: URL,
  request: Request,
  principal: Principal,
  deps: RegistryDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
): Promise<Response> {
  if (segments.length === 4 && segments[3] === 'drafts') {
    return await createDraftHandler(
      createAuthoringHandlerDependencies(principal, deps, config),
    )(request);
  }

  if (segments.length === 4 && (segments[3] === 'files' || segments[3] === 'file')) {
    if (method !== 'GET') return methodNotAllowed(['GET']);

    // The authoring adapter owns bundle decoding and per-file integrity checks,
    // while core owns the authenticated principal and current policy gate. A
    // request-local authenticator forwards this already-validated principal so
    // the adapter cannot perform a second credential lookup for the same read.
    const releaseFilesHandler = createReleaseFilesHandler(
      createAuthoringHandlerDependencies(principal, deps, config),
    );
    return await releaseFilesHandler(request);
  }

  if (segments.length === 2) {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    requireReader(principal);
    const state = await readState(deps.repository, config.organizationId);
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    const skills = state.skills.filter((skill) => {
      if (!canReadNamespace(principal, skill.name)) return false;
      if (!q) return true;
      return [skill.name, skill.skillName, skill.description, skill.version]
        .some((value) => value.toLowerCase().includes(q));
    });
    return jsonResponse({ skills });
  }

  if (segments.length === 3) {
    const id = decodePathPart(segments[2]);
    if (method === 'GET') {
      requireReader(principal);
      const state = await readState(deps.repository, config.organizationId);
      const skill = state.skills.find((candidate) => candidate.id === id && canReadNamespace(principal, candidate.name));
      if (!skill) throw unavailable();
      assertKnownDistributionState(skill.state);
      return jsonResponse({ skill });
    }
    return methodNotAllowed(['GET']);
  }

  if (segments.length === 4 && segments[3] === 'rescan') {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    requirePublisher(principal);
    const id = decodePathPart(segments[2]);
    return await rescanSkill(id, principal, deps, config, requestId);
  }

  if (segments.length === 4 && segments[3] === 'revoke') {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    requireAdmin(principal);
    const id = decodePathPart(segments[2]);
    return await revokeSkill(id, principal, deps, config, requestId);
  }

  throw new RegistryApiError('NOT_FOUND', 'Route not found', 404);
}

/**
 * Server-side skills.sh catalog proxy.  The injected client owns all network
 * policy and request-scoped credentials; this route only authenticates the
 * caller, validates bounded query/body fields, and returns its validated DTO.
 */
async function handleDirectoryRoute(
  method: HttpMethod,
  segments: string[],
  url: URL,
  request: Request,
  principal: Principal,
  deps: RegistryHandlerDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
): Promise<Response> {
  const directory = deps.directory;

  if (segments.length === 4 && segments[2] === 'packs' && segments[3] === 'preview') {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    assertSessionRequestSafe(request, config, method);
    requireReader(principal);
    const packDirectory = deps.directoryPacks;
    if (!packDirectory) throw directoryUnavailable();
    const body = await readJson(request, config.maxBodyBytes);
    const packUrl = requireDirectoryPackUrl(body.url);
    const result = await directoryPackRequest(() => packDirectory.inspect(packUrl));
    return jsonResponse(result);
  }

  if (segments.length === 3 && segments[2] === 'import') {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    // Browser callers use the same cookie mutation protections as session and
    // receipt routes; bearer CLI callers remain usable without an Origin.
    assertSessionRequestSafe(request, config, method);
    requirePublisher(principal);
    const body = await readJson(request, config.maxBodyBytes);
    return await createDirectoryImport(body, principal, deps, config, requestId, request.signal);
  }

  if (segments.length === 3 && segments[2] === 'skills') {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    requireReader(principal);
    const view = optionalDirectoryView(url.searchParams.get('view'));
    const page = optionalDirectoryInteger(url.searchParams.get('page'), 'page', 0, Number.MAX_SAFE_INTEGER);
    const perPage = optionalDirectoryInteger(url.searchParams.get('per_page'), 'per_page', 1, 500);
    const target = await resolveDirectoryBrowseTarget(url, principal, deps, config);
    const result = await directoryRequest(() => target.directory.list({ view, page, perPage, signal: request.signal }));
    return jsonResponse(withDirectoryDiscoveryContext(result, target.feedName));
  }

  if (segments.length === 3 && segments[2] === 'search') {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    requireReader(principal);
    const q = url.searchParams.get('q')?.trim() || '';
    if ([...q].length < 2 || q.length > 16_384 || /[\u0000-\u001f\u007f]/u.test(q)) {
      throw new RegistryApiError('INVALID_REQUEST', 'q must contain at least two characters', 400);
    }
    const ownerRaw = url.searchParams.get('owner');
    const owner = ownerRaw === null ? undefined : ownerRaw.trim();
    if (owner !== undefined && (!owner || owner.length > 512 || /[\u0000-\u001f\u007f/\\]/u.test(owner))) {
      throw new RegistryApiError('INVALID_REQUEST', 'owner is invalid', 400);
    }
    const limit = optionalDirectoryInteger(url.searchParams.get('limit'), 'limit', 1, 200);
    const target = await resolveDirectoryBrowseTarget(url, principal, deps, config);
    const result = await directoryRequest(() => target.directory.search({ q, owner, limit, signal: request.signal }));
    return jsonResponse(withDirectoryDiscoveryContext(result, target.feedName));
  }

  if (segments.length === 3 && segments[2] === 'official') {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    requireReader(principal);
    const target = await resolveDirectoryBrowseTarget(url, principal, deps, config);
    const result = await directoryRequest(() => target.directory.curated({ signal: request.signal }));
    return jsonResponse(withDirectoryDiscoveryContext(result, target.feedName));
  }

  if (segments.length === 3 && segments[2] === 'topic') {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    requireReader(principal);
    if (!directory || typeof directory.topic !== 'function') throw directoryUnavailable();
    const slugValues = url.searchParams.getAll('slug');
    if (slugValues.length !== 1) {
      throw new RegistryApiError('INVALID_REQUEST', 'slug is invalid', 400);
    }
    const slug = requireDirectoryTopicSlug(slugValues[0]);
    const result = await directoryRequest(() => directory.topic!(slug, { signal: request.signal }));
    return jsonResponse(result);
  }

  if (segments.length === 3 && (segments[2] === 'detail' || segments[2] === 'audits')) {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    requireReader(principal);
    const id = requireDirectoryId(url.searchParams.get('id'));
    const target = await resolveDirectoryBrowseTarget(url, principal, deps, config);
    if (segments[2] === 'detail') {
      const detail = await directoryRequest(() => target.directory.detail(id, { signal: request.signal }));
      return jsonResponse(withDirectoryDiscoveryContext(toDirectoryDetailMetadata(detail), target.feedName));
    }
    const result = await directoryRequest(() => target.directory.audit(id, { signal: request.signal }));
    return jsonResponse(withDirectoryDiscoveryContext(result, target.feedName));
  }

  throw new RegistryApiError('NOT_FOUND', 'Route not found', 404);
}

interface DirectoryBrowseTarget {
  directory: RegistryDirectoryClient;
  feedName: string | null;
}

/**
 * Resolve an optional discovery-feed selector without changing the existing
 * global directory behavior.  An omitted selector deliberately uses the
 * injected global client and does not infer a feed from the configured
 * default or from the available state records.
 */
async function resolveDirectoryBrowseTarget(
  url: URL,
  principal: Principal,
  deps: RegistryHandlerDependencies,
  config: Required<RegistryConfiguration>,
): Promise<DirectoryBrowseTarget> {
  const feedValues = url.searchParams.getAll('feed');
  if (feedValues.length > 1) {
    throw new RegistryApiError('INVALID_FEED', 'feed may be specified only once', 400);
  }
  if (feedValues.length === 0) {
    if (!deps.directory) throw directoryUnavailable();
    return { directory: deps.directory, feedName: null };
  }

  const feedName = requireFeedName(feedValues[0]);
  const state = await readState(deps.repository, config.organizationId);
  const feed = findTransparentFeed(state, feedName, principal, config);
  const directory = deps.directoryForBase?.(feed.baseUrl);
  if (!directory) throw directoryUnavailable();
  return { directory, feedName: feed.name };
}

function withDirectoryDiscoveryContext<T extends object>(
  value: T,
  feedName: string | null,
): DirectoryDiscoveryResponse<T> {
  const record = value as Record<string, unknown>;
  const data = Array.isArray(record.data)
    ? record.data.map((entry) => projectDirectorySkillCollectionEntry(entry, feedName))
    : record.data;
  return {
    ...record,
    ...(data === undefined ? {} : { data }),
    feedName,
  } as DirectoryDiscoveryResponse<T>;
}

/**
 * Catalog rows are cached by the provider client.  Clone only the response
 * collection being returned so a selected tenant feed cannot be written into
 * a shared row or into a different request's global view.
 */
function projectDirectorySkillCollectionEntry(value: unknown, feedName: string | null): unknown {
  if (!isObject(value)) return value;
  if (Array.isArray(value.skills)) {
    return {
      ...value,
      skills: value.skills.map((skill) => projectDirectorySkillRow(skill, feedName)),
    };
  }
  return projectDirectorySkillRow(value, feedName);
}

function projectDirectorySkillRow(value: unknown, feedName: string | null): unknown {
  if (!isObject(value)) return value;
  return { ...value, feedName };
}

/**
 * Keep the foundation metadata produced by the directory adapter at the
 * detail response boundary.  These are bounded metadata strings only; core
 * does not create a request-time timestamp or translate source status into
 * approval.
 */
function directoryFoundationProjection(value: unknown): DirectoryFoundationMetadata {
  if (!isObject(value)) return {};
  const projected: DirectoryFoundationMetadata = {};
  if (value.provider === 'skills.sh') projected.provider = value.provider;
  if (isCanonicalIsoTimestamp(value.fetchedAt)) projected.fetchedAt = value.fetchedAt;
  if (isDirectorySourceStatus(value.sourceStatus)) projected.sourceStatus = value.sourceStatus;
  if (typeof value.sourceReason === 'string' &&
      value.sourceReason.length > 0 &&
      value.sourceReason.length <= 512 &&
      isWellFormedUnicodeString(value.sourceReason) &&
      new TextEncoder().encode(value.sourceReason).byteLength <= 2_048) {
    projected.sourceReason = value.sourceReason;
  }
  return projected;
}

/**
 * Keep the directory detail route metadata-only.  The injected client still
 * returns the complete bounded snapshot to import/acquisition callers, but a
 * reader-facing response must not expose source text before scanner admission.
 */
function toDirectoryDetailMetadata(detail: SkillDetailResponse): SkillDetailMetadataResponse {
  return {
    ...directoryFoundationProjection(detail),
    id: detail.id,
    source: detail.source,
    slug: detail.slug,
    installs: detail.installs,
    hash: detail.hash,
    files: detail.files === null ? null : detail.files.map((file) => ({ path: file.path })),
  };
}

async function createDirectoryImport(
  body: JsonObject,
  principal: Principal,
  deps: RegistryHandlerDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
  requestSignal?: AbortSignal,
): Promise<Response> {
  const id = requireDirectoryId(stringValue(body.id));
  const name = requireSkillName(body.name);
  const version = requireVersion(body.version);
  if (!canPublishName(principal, name)) {
    throw new RegistryApiError('FORBIDDEN', 'Namespace publish denied', 403);
  }

  const requestedUpstreamId = optionalImportField(body.upstreamId, 'upstreamId');
  const stateBeforeDetail = await readState(deps.repository, config.organizationId);
  const eligibleMappings = stateBeforeDetail.upstreams
    .filter((upstream) =>
      upstream.organizationId === config.organizationId &&
      upstream.kind === 'skills-sh' &&
      upstream.enabled &&
      canReadNamespace(principal, upstream.namespace),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  let selected = requestedUpstreamId === undefined
    ? eligibleMappings.length === 1 ? eligibleMappings[0] : undefined
    : eligibleMappings.find((upstream) => upstream.id === requestedUpstreamId);
  if (requestedUpstreamId !== undefined && !selected) throw unavailable();

  // A completed/active import already contains the server-validated external
  // identity and mapping.  Reuse it directly so an approved warm hit never
  // calls the directory detail endpoint or observes a mutable catalog row.
  const cachedRequest = findDirectoryCachedImportRequest(
    stateBeforeDetail,
    id,
    name,
    version,
    principal,
    requestedUpstreamId,
  );
  if (cachedRequest) {
    selected ??= eligibleMappings.find((upstream) => upstream.id === cachedRequest.upstreamId);
    if (!selected || !isTrustedSkillsShBaseUrl(selected, config)) throw directoryUnavailable();
    return await createImportJob({ ...cachedRequest }, principal, deps, config, requestId);
  }

  if (!selected) {
    if (eligibleMappings.length === 0) throw unavailable();
    // An administrator can deliberately configure multiple source mappings;
    // do not silently choose an origin when the UI has not selected one.
    throw new RegistryApiError('UPSTREAM_MAPPING_REQUIRED', 'Select an authorized skills.sh upstream mapping', 409, {
      details: {
        upstreams: eligibleMappings.map((upstream) => ({ id: upstream.id, name: upstream.name, namespace: upstream.namespace })),
      },
    });
  }

  if (!isTrustedSkillsShBaseUrl(selected, config)) throw directoryUnavailable();
  const directoryBaseUrl = skillsShDirectoryBaseUrl(selected);
  const directory = deps.directoryForBase?.(directoryBaseUrl);
  if (!directory) throw directoryUnavailable();

  // Fetch exactly the selected catalog row.  A bounded metadata lookup is
  // performed only when this row has no immutable snapshot hash, and the
  // returned identity is checked before queueing.
  const detail = await directoryRequest(() => directory.detail(id));
  if (
    detail.id !== id ||
    detail.id !== `${detail.source}/${detail.slug}` ||
    !detail.source ||
    !detail.slug ||
    !isSafeDirectoryExternalValue(detail.source) ||
    !isSafeDirectoryExternalValue(detail.slug)
  ) {
    throw new RegistryApiError('DIRECTORY_INTEGRITY', 'Directory detail identity is inconsistent', 502, { retryable: true });
  }
  // Check the selected administrator mapping before any additional catalog
  // metadata lookup. A denied source must not cause a search or list request
  // against the selected public catalog.
  if (!upstreamAllowsImport(selected, detail.source)) throw unavailable();

  // A null catalog snapshot cannot by itself tell the worker whether the
  // public source is GitHub or a well-known host. Resolve that one row from
  // the trusted list/search metadata before queueing; never infer the type
  // from an ID shape or pass a browser-supplied hint through to the worker.
  const trustedRow = detail.hash === null || detail.files === null
    ? await lookupDirectoryCatalogRow(directory, detail, requestSignal)
    : undefined;

  const importBody: JsonObject = {
    upstreamId: selected.id,
    repository: detail.source,
    // Preserve the complete skills.sh ID in the durable request.  The worker
    // uses this identity when it performs its governed source acquisition.
    path: detail.id,
    name,
    version,
    externalId: detail.id,
    externalSnapshotHash: detail.hash,
    ...(trustedRow ? {
      externalSourceType: trustedRow.sourceType,
    } : {}),
    ...(detail.hash ? { ref: detail.hash } : {}),
  };
  return await createImportJob(importBody, principal, deps, config, requestId);
}

/**
 * Resolve the source type for a detail row whose snapshot hash is absent.
 * Search is preferred because it is narrow; the bounded leaderboard walk is
 * a compatibility fallback for directory deployments whose search index does
 * not contain the row yet.  Both paths compare the complete external identity
 * before accepting any metadata.
 */
async function lookupDirectoryCatalogRow(
  directory: RegistryDirectoryClient,
  detail: SkillDetailResponse,
  requestSignal?: AbortSignal,
): Promise<V1Skill> {
  const deadline = createDirectoryLookupSignal(requestSignal, DIRECTORY_METADATA_LOOKUP_DEADLINE_MS);
  try {
    const owner = directorySearchOwner(detail.source);
    const searchOptions = {
      q: detail.slug,
      limit: 200,
      signal: deadline.signal,
      ...(owner === undefined ? {} : { owner }),
    };
    // The public search API requires at least two characters.  A one-character
    // catalog slug therefore goes directly to the bounded list fallback.
    if ([...detail.slug].length >= 2) {
      const searched = await directoryLookupRequest(() => directory.search(searchOptions));
      const searchMatch = searched ? exactDirectoryCatalogRow(searched.data, detail) : undefined;
      if (searchMatch) return searchMatch;

      // An owner-filtered fuzzy search can omit a valid row when a provider's
      // owner index is stale.  One unfiltered query remains bounded and still
      // requires the complete id/source/slug match below.
      if (owner !== undefined) {
        const unfiltered = await directoryLookupRequest(() => directory.search({
          q: detail.slug,
          limit: 200,
          signal: deadline.signal,
        }));
        const unfilteredMatch = unfiltered ? exactDirectoryCatalogRow(unfiltered.data, detail) : undefined;
        if (unfilteredMatch) return unfilteredMatch;
      }
    }

    for (let page = 0; page < DIRECTORY_METADATA_LOOKUP_MAX_PAGES; page += 1) {
      const listed = await directoryLookupRequest(() => directory.list({
        view: 'all-time',
        page,
        perPage: 500,
        signal: deadline.signal,
      }));
      if (!listed) continue;
      const listMatch = exactDirectoryCatalogRow(listed.data, detail);
      if (listMatch) return listMatch;
      if (!listed.pagination.hasMore) break;
    }
  } finally {
    deadline.close();
  }
  throw new RegistryApiError(
    'DIRECTORY_INTEGRITY',
    'The directory did not return trusted source metadata for this skill',
    502,
    { retryable: true },
  );
}

async function directoryLookupRequest<T>(action: () => Promise<T>): Promise<T | undefined> {
  try {
    return await action();
  } catch (error) {
    // Search/list may be absent on older directory deployments.  Treat only
    // an explicit not-found as an empty result; outages and malformed data
    // remain errors and do not silently weaken provenance.
    if (error instanceof SkillsDirectoryError && error.code === 'not_found') return undefined;
    if (error instanceof SkillsDirectoryError) throw directoryApiError(error);
    throw error;
  }
}

function exactDirectoryCatalogRow(rows: readonly V1Skill[], detail: SkillDetailResponse): V1Skill | undefined {
  const sameId = rows.filter((row) => row.id === detail.id);
  if (sameId.length > 1) {
    throw new RegistryApiError(
      'DIRECTORY_INTEGRITY',
      'The directory returned duplicate source metadata',
      502,
      { retryable: true },
    );
  }
  const row = sameId[0];
  if (!row || row.source !== detail.source || row.slug !== detail.slug || row.id !== `${row.source}/${row.slug}`) {
    return undefined;
  }
  if (row.sourceType !== 'github' && row.sourceType !== 'well-known') return undefined;
  return row;
}

function directorySearchOwner(source: string): string | undefined {
  const parts = source.split('/');
  if (parts.length === 2 && parts[0] && parts[0].length <= 512 && !/[\u0000-\u001f\u007f/\\]/u.test(parts[0])) return parts[0];
  if (/^github\.com\//iu.test(source) && parts.length >= 3 && parts[1] && parts[1].length <= 512 && !/[\u0000-\u001f\u007f/\\]/u.test(parts[1])) return parts[1];
  return undefined;
}

function createDirectoryLookupSignal(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  close: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abortParent = () => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener('abort', abortParent, { once: true });
  return {
    signal: controller.signal,
    close: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', abortParent);
    },
  };
}

function findDirectoryCachedImportRequest(
  state: RegistryState,
  id: string,
  name: string,
  version: string,
  principal: Principal,
  requestedUpstreamId: string | undefined,
): ImportRequest | undefined {
  const matches = state.jobs
    .filter((job) => {
      if (job.organizationId !== principal.organizationId || job.kind !== 'import') return false;
      if (job.state !== 'queued' && job.state !== 'running' && job.state !== 'completed') return false;
      const request = job.import;
      if (!request || request.externalId !== id || request.path !== id || request.name !== name || request.version !== version) return false;
      if (requestedUpstreamId !== undefined && request.upstreamId !== requestedUpstreamId) return false;
      const currentUpstream = state.upstreams.find((upstream) => upstream.id === request.upstreamId);
      return !!currentUpstream &&
        currentUpstream.kind === 'skills-sh' &&
        currentUpstream.enabled &&
        canReadNamespace(principal, currentUpstream.namespace) &&
        upstreamAllowsImport(currentUpstream, request.repository);
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  if (matches.length === 0) return undefined;
  if (matches.length > 1) {
    throw new RegistryApiError('UPSTREAM_MAPPING_REQUIRED', 'Select an authorized skills.sh upstream mapping', 409, {
      details: {
        upstreams: [...new Set(matches.map((job) => job.import?.upstreamId).filter((value): value is string => !!value))],
      },
    });
  }
  const request = matches[0]?.import;
  return request ? { ...request } : undefined;
}

function optionalDirectoryView(value: string | null): 'all-time' | 'trending' | 'hot' | undefined {
  if (value === null || value === '') return undefined;
  if (value === 'all-time' || value === 'trending' || value === 'hot') return value;
  throw new RegistryApiError('INVALID_REQUEST', 'view is invalid', 400);
}

function optionalDirectoryInteger(
  value: string | null,
  field: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === null || value === '') return undefined;
  if (!/^\d+$/u.test(value)) throw new RegistryApiError('INVALID_REQUEST', `${field} is invalid`, 400);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RegistryApiError('INVALID_REQUEST', `${field} is invalid`, 400);
  }
  return parsed;
}

function requireDirectoryId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    !isWellFormedUnicodeString(value) ||
    new TextEncoder().encode(value).byteLength > 2_048 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f?#%\\]/u.test(value)
  ) {
    throw new RegistryApiError('INVALID_REQUEST', 'id is invalid', 400);
  }
  const parts = value.split('/');
  if (parts.length < 2 || parts.length > DIRECTORY_ID_MAX_SEGMENTS || parts.some((part) => !isSafeDirectorySegment(part))) {
    throw new RegistryApiError('INVALID_REQUEST', 'id is invalid', 400);
  }
  return value;
}

function isSafeDirectoryExternalValue(value: string): boolean {
  return isWellFormedUnicodeString(value) &&
    new TextEncoder().encode(value).byteLength <= 2_048 &&
    value.length > 0 &&
    value.trim() === value &&
    value.split('/').every((part) => isSafeDirectorySegment(part)) &&
    !/[\u0000-\u001f\u007f?#%\\]/u.test(value);
}

function isSafeDirectorySegment(value: string): boolean {
  return isWellFormedUnicodeString(value) &&
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    new TextEncoder().encode(value).byteLength <= DIRECTORY_ID_MAX_SEGMENT_BYTES;
}

function isWellFormedUnicodeString(value: string): boolean {
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

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64 || !isWellFormedUnicodeString(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isDirectorySourceStatus(value: unknown): value is DirectorySourceStatus {
  return value === 'metadata-only' ||
    value === 'snapshot-available' ||
    value === 'source-resolved' ||
    value === 'changed' ||
    value === 'unavailable' ||
    value === 'rejected';
}

async function directoryRequest<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (!(error instanceof SkillsDirectoryError)) throw error;
    throw directoryApiError(error);
  }
}

function directoryApiError(error: SkillsDirectoryError): RegistryApiError {
  if (error.code === 'not_found') throw unavailable();
  if (error.code === 'invalid_input') {
    return new RegistryApiError('INVALID_REQUEST', 'Directory request is invalid', 400);
  }
  const retryable = error.code === 'unavailable' || error.code === 'rate_limited' || error.code === 'request_timeout' || error.code === 'http_error';
  return new RegistryApiError(
    'DIRECTORY_UNAVAILABLE',
    'The skills.sh directory is temporarily unavailable',
    503,
    { retryable },
  );
}

function directoryUnavailable(): RegistryApiError {
  return new RegistryApiError('DIRECTORY_NOT_CONFIGURED', 'The skills.sh directory is disconnected', 503, { retryable: false });
}

function requireDirectoryPackUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new RegistryApiError('INVALID_REQUEST', 'url is invalid', 400);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new RegistryApiError('INVALID_REQUEST', 'url is invalid', 400);
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./u, '');
  if (parsed.protocol !== 'https:' || host !== 'skills.sh' || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash || !/^\/p\/[A-Za-z0-9][A-Za-z0-9._~-]{0,127}\/?$/u.test(parsed.pathname)) {
    throw new RegistryApiError('INVALID_REQUEST', 'url is not a valid skills.sh pack URL', 400);
  }
  return value;
}

function requireDirectoryTopicSlug(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    !isWellFormedUnicodeString(value) ||
    value.length > 128 ||
    new TextEncoder().encode(value).byteLength > 512 ||
    value.trim() !== value ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)
  ) {
    throw new RegistryApiError('INVALID_REQUEST', 'slug is invalid', 400);
  }
  return value;
}

async function directoryPackRequest<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'SkillsPackError') throw error;
    const code = (error as { code?: unknown }).code;
    if (code === 'not_found') throw unavailable();
    if (code === 'invalid_input' || code === 'invalid_manifest' || code === 'unsafe_path') {
      throw new RegistryApiError('INVALID_REQUEST', 'The skills.sh pack manifest is invalid', 400);
    }
    throw new RegistryApiError('DIRECTORY_UNAVAILABLE', 'The skills.sh pack is temporarily unavailable', 503, { retryable: true });
  }
}

async function publishSkill(
  body: JsonObject,
  principal: Principal,
  deps: RegistryDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
): Promise<Response> {
  const name = requireSkillName(body.name);
  if (!canPublishName(principal, name)) throw new RegistryApiError('FORBIDDEN', 'Namespace publish denied', 403);
  const version = requireVersion(body.version);
  if (body.description !== undefined && typeof body.description !== 'string') {
    throw new RegistryApiError('INVALID_REQUEST', 'description must be a string', 400);
  }
  const requestedDescription = stringValue(body.description) || '';
  if (!isObject(body.bundle)) throw new RegistryApiError('BUNDLE_INVALID', 'bundle must be an object', 400);

  let bundle: SkillBundle;
  let bytes: Uint8Array;
  let parsedMetadata: { skillName?: string; description?: string };
  try {
    bundle = validateBundle(body.bundle) as SkillBundle;
    bytes = encodeBundle(bundle);
    parsedMetadata = parseSkillMetadata(bundle) as { skillName?: string; description?: string };
  } catch (error) {
    throw bundleError(error);
  }
  const digest = await digestBytes(bytes);
  const state = await readState(deps.repository, config.organizationId);
  const duplicate = state.skills.find(
    (skill) => skill.name === name && skill.version === version,
  );
  if (duplicate) throw new RegistryApiError('VERSION_CONFLICT', 'That skill version already exists', 409);

  const stored = await putVerifiedBlob(deps, bytes, digest);
  const now = nowIso();
  const policy = clonePolicy(state.policy);
  const jobId = randomId('job');
  const skillId = randomId('skill');
  const skill: SkillVersion = {
    id: skillId,
    organizationId: config.organizationId,
    name,
    skillName: normalizeSkillName(parsedMetadata.skillName) || name.slice(name.indexOf('/') + 1),
    version,
    description: requestedDescription || stringValue(parsedMetadata.description) || '',
    artifact: stored,
    state: 'pending',
    policyRevision: policy.revision,
    createdAt: now,
    provenance: { kind: 'native' },
    fileCount: bundle.files.length,
    scanIds: [],
  };
  const job: Job = {
    id: jobId,
    organizationId: config.organizationId,
    kind: 'scan',
    state: 'queued',
    resourceId: skillId,
    artifact: stored,
    policyRevision: policy.revision,
    policy,
    createdAt: now,
    updatedAt: now,
    attempts: 0,
  };
  const result = await deps.repository.transaction(config.organizationId, (current) => {
    const mutable = ensureState(current, state.policy);
    if (mutable.skills.some((candidate) => candidate.name === name && candidate.version === version)) {
      throw new RegistryApiError('VERSION_CONFLICT', 'That skill version already exists', 409);
    }
    mutable.skills.push(skill);
    mutable.jobs.push(job);
    appendAudit(mutable, audit(principal, 'skill.publish.queued', skillId, {
      digest,
      version,
      requestId,
    }, config.organizationId));
    return job;
  });
  return jsonResponse({ operation: result }, 202);
}

async function handleOperationsRoute(
  method: HttpMethod,
  segments: string[],
  principal: Principal,
  deps: RegistryDependencies,
  requestId: string,
): Promise<Response> {
  if (method !== 'GET') return methodNotAllowed(['GET']);
  requireReader(principal);
  const state = await readState(deps.repository, principal.organizationId);
  if (segments.length === 2) {
    const operations = state.jobs.filter((job) => jobVisibleToPrincipal(job, state, principal));
    return jsonResponse({ operations });
  }
  if (segments.length === 3) {
    const id = decodePathPart(segments[2]);
    const job = state.jobs.find((candidate) => candidate.id === id && jobVisibleToPrincipal(candidate, state, principal));
    if (!job) throw unavailable();
    return jsonResponse({ operation: job });
  }
  throw new RegistryApiError('NOT_FOUND', 'Route not found', 404, {
    details: { requestId },
  });
}

function jobVisibleToPrincipal(job: Job, state: RegistryState, principal: Principal): boolean {
  if (hasRole(principal, 'owner') || hasRole(principal, 'admin')) return true;
  if (job.resourceId) {
    const skill = state.skills.find((candidate) => candidate.id === job.resourceId);
    return !!skill && canReadNamespace(principal, skill.name);
  }
  if (!job.import) return false;
  if (job.import.externalId || job.import.sourceReference) return canReadNamespace(principal, job.import.name);
  return canPublishName(principal, job.import.name);
}

async function resolveRoute(
  body: JsonObject,
  principal: Principal,
  deps: RegistryDependencies,
  requestId: string,
): Promise<Response> {
  const kind = body.kind;
  if (kind !== 'skill' && kind !== 'pack') {
    throw new RegistryApiError('INVALID_RESOLUTION', 'kind must be skill or pack', 400);
  }
  const ref = stringValue(body.ref);
  if (!ref) throw new RegistryApiError('INVALID_RESOLUTION', 'ref is required', 400);
  const version = body.version === undefined ? undefined : requireVersion(body.version);
  const state = await readState(deps.repository, principal.organizationId);
  const result = resolveResource(state, principal, kind, ref, version);
  if (result.kind === 'pending') return jsonResponse({ operation: result.job }, 202);
  if (result.kind !== 'resolved') throw unavailable();
  return jsonResponse({ resolution: result.resolution });
}

function resolveResource(
  state: RegistryState,
  principal: Principal,
  kind: 'skill' | 'pack',
  ref: string,
  version?: string,
): { kind: 'resolved'; resource: SkillVersion | PackVersion; resolution: Resolution } | { kind: 'pending'; job: Job } | { kind: 'unavailable' } {
  if (kind === 'skill') {
    const candidates = state.skills.filter((skill) => {
      if (!canReadNamespace(principal, skill.name)) return false;
      return skill.id === ref || skill.name === ref || skill.skillName === ref;
    });
    const selected = chooseVersion(candidates, version);
    if (!selected) {
      const pending = state.jobs.find((job) => {
        if (!job.resourceId || job.kind !== 'scan') return false;
        const skill = state.skills.find((candidate) => candidate.id === job.resourceId);
        return !!skill && canReadNamespace(principal, skill.name) && (skill.id === ref || skill.name === ref) && (version === undefined || skill.version === version);
      });
      const pendingImport = pending || state.jobs.find((job) => {
        return (job.state === 'queued' || job.state === 'running') &&
          job.kind === 'import' &&
          !!job.import &&
          canPublishName(principal, job.import.name) &&
          job.import.name === ref &&
          (version === undefined || job.import.version === version);
      });
      return pendingImport ? { kind: 'pending', job: pendingImport } : { kind: 'unavailable' };
    }
    assertKnownDistributionState(selected.state);
    if (selected.state === 'pending') {
      const job = state.jobs.find((candidate) => candidate.resourceId === selected.id && candidate.kind === 'scan');
      return job ? { kind: 'pending', job } : { kind: 'unavailable' };
    }
    if (!skillCurrentlyApproved(state, selected)) {
      return { kind: 'unavailable' };
    }
    return {
      kind: 'resolved',
      resource: selected,
      resolution: {
        kind: 'skill',
        resourceId: selected.id,
        organizationId: selected.organizationId,
        name: selected.name,
        version: selected.version,
        digest: selected.artifact.digest,
        members: [selected],
      },
    };
  }

  const candidates = state.packs.filter((pack) => {
    if (!canReadNamespace(principal, pack.name)) return false;
    return pack.id === ref || pack.name === ref;
  });
  const selected = chooseVersion(candidates, version);
  if (!selected) return { kind: 'unavailable' };
  if (selected.state !== 'approved' || selected.policyRevision !== state.policy.revision) return { kind: 'unavailable' };
  const members: SkillVersion[] = [];
  for (const member of selected.members) {
    const skill = state.skills.find((candidate) => candidate.id === member.resourceId);
    if (!skill || !skillCurrentlyApproved(state, skill) || skill.artifact.digest !== member.digest || !canReadNamespace(principal, skill.name)) {
      return { kind: 'unavailable' };
    }
    members.push(skill);
  }
  return {
    kind: 'resolved',
    resource: selected,
    resolution: {
      kind: 'pack',
      resourceId: selected.id,
      organizationId: selected.organizationId,
      name: selected.name,
      version: selected.version,
      digest: selected.manifestDigest,
      members,
    },
  };
}

/**
 * Approval is bound to both the policy revision and the evidence age.  A
 * release may remain in the historical `approved` state for audit purposes,
 * but it stops resolving or minting install capabilities when its required
 * evidence is no longer current.
 */
function skillCurrentlyApproved(state: RegistryState, skill: SkillVersion, now = Date.now()): boolean {
  if (skill.state !== 'approved' || skill.policyRevision !== state.policy.revision) return false;
  const scans = state.scans.filter((scan) => skill.scanIds.includes(scan.id));
  return evaluatePolicy(state.policy, scans, skill.artifact.digest, now).state === 'approved';
}

/** Shared admission predicate for durable source-proof projections. */
export function isSkillCurrentlyApproved(state: RegistryState, skill: SkillVersion, now = Date.now()): boolean {
  return skillCurrentlyApproved(state, skill, now);
}

/** Shared namespace predicate for adapter-owned candidate providers. */
export function canReadSkillForPrincipal(principal: Principal, skill: SkillVersion): boolean {
  return skill.organizationId === principal.organizationId && canReadNamespace(principal, skill.name);
}

/** Shared namespace predicate for consumer selection and runtime composition. */
export function canReadOpenClawNamespace(principal: Principal, namespace: string): boolean {
  return canReadNamespace(principal, namespace);
}

async function handleInstallAuthorizationRoute(
  method: HttpMethod,
  segments: string[],
  request: Request,
  principal: Principal,
  deps: RegistryDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
): Promise<Response> {
  if (segments.length === 2) {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    requireReader(principal);
    const body = await readJson(request, config.maxBodyBytes);
    return await createInstallAuthorization(body, principal, deps, config, requestId);
  }
  if (segments.length === 4 && segments[3] === 'validate') {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    requireReader(principal);
    return await validateInstallAuthorization(decodePathPart(segments[2]), principal, deps, config, requestId);
  }
  throw new RegistryApiError('NOT_FOUND', 'Route not found', 404);
}

async function createInstallAuthorization(
  body: JsonObject,
  principal: Principal,
  deps: RegistryDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
): Promise<Response> {
  const state = await readState(deps.repository, principal.organizationId);
  const requested = isObject(body.resolution) ? body.resolution : body;
  const resolution = await resolveRequestedResolution(requested, state, principal);
  assertCurrentResolution(state, principal, resolution);
  const now = Date.now();
  const authorization: InstallAuthorization = {
    id: randomId('authz'),
    organizationId: config.organizationId,
    subject: principal.subject,
    resolution: cloneResolution(resolution),
    expiresAt: new Date(now + TRANSFER_TTL_SECONDS * 1000).toISOString(),
  };
  const ticket: InstallReceiptTicket = {
    id: randomId('receipt_ticket'),
    organizationId: config.organizationId,
    subject: principal.subject,
    authorizationId: authorization.id,
    resolution: cloneResolution(resolution),
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + INSTALL_RECEIPT_TTL_SECONDS * 1000).toISOString(),
  };
  const result = await deps.repository.transaction(config.organizationId, (current) => {
    const mutable = ensureState(current, state.policy);
    const currentResolution = resolveResource(
      mutable,
      principal,
      resolution.kind,
      resolution.resourceId,
      resolution.version,
    );
    if (currentResolution.kind !== 'resolved' || !sameResolution(currentResolution.resolution, resolution)) {
      throw new RegistryApiError('POLICY_BLOCKED', 'Resolution changed before authorization', 409, { retryable: true });
    }
    const nowForTickets = Date.now();
    mutable.installReceiptTickets = mutable.installReceiptTickets!.filter((candidate) =>
      !timestampExpired(candidate.expiresAt, nowForTickets),
    );
    if (mutable.installReceiptTickets.length >= MAX_INSTALL_RECEIPT_TICKETS) {
      throw new RegistryApiError('ANALYTICS_LIMIT', 'Install receipt ticket limit reached', 503, { retryable: true });
    }
    mutable.authorizations.push(authorization);
    mutable.installReceiptTickets!.push(ticket);
    appendAudit(mutable, audit(principal, 'install.authorization.create', authorization.id, {
      resourceId: resolution.resourceId,
      digest: resolution.digest,
      requestId,
    }, config.organizationId));
    return { authorization, ticket };
  });
  return jsonResponse({
    authorization: result.authorization,
    receipt: publicReceiptTicket(result.ticket),
  }, 201);
}

async function validateInstallAuthorization(
  id: string,
  principal: Principal,
  deps: RegistryDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
): Promise<Response> {
  const state = await readState(deps.repository, config.organizationId);
  const current = state.authorizations.find(
    (authorization) => authorization.id === id && authorization.subject === principal.subject,
  );
  if (!current) throw unavailable();
  if (timestampExpired(current.expiresAt)) throw unavailable();
  assertCurrentResolution(state, principal, current.resolution);
  const result = await deps.repository.transaction(config.organizationId, (mutableState) => {
    const mutable = ensureState(mutableState, state.policy);
    const index = mutable.authorizations.findIndex((candidate) => candidate.id === id && candidate.subject === principal.subject);
    if (index < 0) throw unavailable();
    const currentAuthorization = mutable.authorizations[index]!;
    if (timestampExpired(currentAuthorization.expiresAt)) throw unavailable();
    assertCurrentResolution(mutable, principal, currentAuthorization.resolution);
    const authorization: InstallAuthorization = {
      ...currentAuthorization,
      expiresAt: new Date(Date.now() + TRANSFER_TTL_SECONDS * 1000).toISOString(),
    };
    mutable.authorizations[index] = authorization;
    appendAudit(mutable, audit(principal, 'install.authorization.validate', id, {
      resourceId: authorization.resolution.resourceId,
      requestId,
    }, config.organizationId));
    const ticket = mutable.installReceiptTickets!.find(
      (candidate) => candidate.authorizationId === authorization.id && candidate.subject === principal.subject,
    );
    return { authorization, ticket };
  });
  return jsonResponse({
    authorization: result.authorization,
    ...(result.ticket ? { receipt: publicReceiptTicket(result.ticket) } : {}),
  });
}

interface InstallReceiptInput {
  authorizationId: string;
  changed: boolean;
  agent: InstallReceiptAgent;
  platform: InstallReceiptPlatform;
  clientVersion: string;
}

function parseInstallReceiptInput(body: JsonObject): InstallReceiptInput {
  const authorizationId = stringValue(body.authorizationId)?.trim();
  if (!authorizationId || authorizationId.length > 256) {
    throw new RegistryApiError('INVALID_RECEIPT', 'authorizationId is required', 400);
  }
  if (typeof body.changed !== 'boolean') {
    throw new RegistryApiError('INVALID_RECEIPT', 'changed must be a boolean', 400);
  }
  const agent = body.agent;
  if (agent !== 'codex' && agent !== 'claude' && agent !== 'universal') {
    throw new RegistryApiError('INVALID_RECEIPT', 'agent is invalid', 400);
  }
  const platform = body.platform;
  if (platform !== 'windows' && platform !== 'macos' && platform !== 'linux' && platform !== 'other') {
    throw new RegistryApiError('INVALID_RECEIPT', 'platform is invalid', 400);
  }
  const clientVersion = stringValue(body.clientVersion)?.trim();
  if (!clientVersion || clientVersion.length > MAX_CLIENT_VERSION_LENGTH || /[\u0000-\u001f\u007f]/u.test(clientVersion)) {
    throw new RegistryApiError('INVALID_RECEIPT', 'clientVersion is invalid', 400);
  }
  return {
    authorizationId,
    changed: body.changed,
    agent,
    platform,
    clientVersion,
  };
}

function publicReceiptTicket(ticket: InstallReceiptTicket): InstallReceiptTicketMetadata {
  return {
    id: ticket.id,
    authorizationId: ticket.authorizationId,
    expiresAt: ticket.expiresAt,
  };
}

function publicReceiptResolution(resolution: Resolution): InstallReceiptResolutionMetadata {
  const members: InstallReceiptResolutionMember[] = resolution.members.map((member) => ({
    resourceId: member.id,
    name: member.name,
    version: member.version,
    digest: member.artifact.digest,
  }));
  return {
    kind: resolution.kind,
    resourceId: resolution.resourceId,
    name: resolution.name,
    version: resolution.version,
    digest: resolution.digest,
    members,
  };
}

function publicInstallReceipt(receipt: InstallReceipt): InstallReceiptMetadata {
  return {
    id: receipt.id,
    ticketId: receipt.ticketId,
    authorizationId: receipt.authorizationId,
    createdAt: receipt.createdAt,
    expiresAt: receipt.expiresAt,
    changed: receipt.changed,
    agent: receipt.agent,
    platform: receipt.platform,
    clientVersion: receipt.clientVersion,
    resolution: publicReceiptResolution(receipt.resolution),
  };
}

function sameInstallReceiptInput(receipt: InstallReceipt, input: InstallReceiptInput): boolean {
  return receipt.changed === input.changed &&
    receipt.agent === input.agent &&
    receipt.platform === input.platform &&
    receipt.clientVersion === input.clientVersion;
}

async function createInstallReceipt(
  body: JsonObject,
  principal: Principal,
  deps: RegistryDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
): Promise<Response> {
  const input = parseInstallReceiptInput(body);
  const state = await readState(deps.repository, config.organizationId);
  const result = await deps.repository.transaction(config.organizationId, (mutableState) => {
    const mutable = ensureState(mutableState, state.policy);
    const now = Date.now();
    const retentionCutoff = now - INSTALL_RECEIPT_RETENTION_SECONDS * 1000;
    mutable.installReceipts = mutable.installReceipts!.filter((candidate) => {
      const createdAt = Date.parse(candidate.createdAt);
      return Number.isFinite(createdAt) && createdAt >= retentionCutoff;
    });
    const existing = mutable.installReceipts!.find(
      (candidate) => candidate.authorizationId === input.authorizationId,
    );
    if (existing) {
      // The authorization id is the idempotency key.  Do not disclose a
      // receipt belonging to another subject, even when an attacker guesses
      // the id; a same-subject conflicting replay is an explicit 409.
      if (existing.organizationId !== config.organizationId || existing.subject !== principal.subject) {
        throw unavailable();
      }
      if (!sameInstallReceiptInput(existing, input)) {
        throw new RegistryApiError('RECEIPT_CONFLICT', 'The authorization already has a different receipt', 409);
      }
      return { receipt: existing, status: 200 as const };
    }

    const ticket = mutable.installReceiptTickets!.find(
      (candidate) => candidate.id &&
        candidate.authorizationId === input.authorizationId &&
        candidate.organizationId === config.organizationId &&
        candidate.subject === principal.subject,
    );
    if (!ticket || timestampExpired(ticket.expiresAt)) throw unavailable();
    if (ticket.resolution.organizationId !== config.organizationId) {
      throw new RegistryApiError('INTERNAL_STATE_INVALID', 'Receipt ticket resolution organization is invalid', 500);
    }
    if (mutable.installReceipts.length >= MAX_INSTALL_RECEIPTS) {
      throw new RegistryApiError('ANALYTICS_LIMIT', 'Install receipt retention limit reached', 503, { retryable: true });
    }
    const receipt: InstallReceipt = {
      id: randomId('receipt'),
      organizationId: config.organizationId,
      subject: principal.subject,
      authorizationId: input.authorizationId,
      ticketId: ticket.id,
      resolution: cloneResolution(ticket.resolution),
      changed: input.changed,
      agent: input.agent,
      platform: input.platform,
      clientVersion: input.clientVersion,
      createdAt: new Date(now).toISOString(),
      expiresAt: ticket.expiresAt,
    };
    mutable.installReceipts.push(receipt);
    // Tickets have a short bounded lifetime.  A receipt keeps its own
    // immutable resolution snapshot, so an accepted receipt does not require
    // retaining the ticket for idempotent replay.
    mutable.installReceiptTickets = mutable.installReceiptTickets!.filter((candidate) =>
      !timestampExpired(candidate.expiresAt, now),
    );
    if (mutable.installReceiptTickets.length > MAX_INSTALL_RECEIPT_TICKETS) {
      mutable.installReceiptTickets = mutable.installReceiptTickets.slice(-MAX_INSTALL_RECEIPT_TICKETS);
    }
    appendAudit(mutable, audit(principal, 'install.receipt.create', receipt.id, {
      authorizationId: receipt.authorizationId,
      resourceId: receipt.resolution.resourceId,
      digest: receipt.resolution.digest,
      changed: receipt.changed,
      agent: receipt.agent,
      platform: receipt.platform,
      requestId,
    }, config.organizationId));
    return { receipt, status: 201 as const };
  });
  return jsonResponse({ receipt: publicInstallReceipt(result.receipt) }, result.status);
}

function parseAnalyticsDays(url: URL): number {
  const raw = url.searchParams.get('days');
  if (raw === null || raw === '') return 30;
  if (!/^\d+$/u.test(raw)) {
    throw new RegistryApiError('INVALID_ANALYTICS_RANGE', 'days must be an integer between 1 and 90', 400);
  }
  const days = Number(raw);
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_ANALYTICS_DAYS) {
    throw new RegistryApiError('INVALID_ANALYTICS_RANGE', 'days must be an integer between 1 and 90', 400);
  }
  return days;
}

function emptyAnalyticsTotals(): { installOperations: number; skillInstalls: number; packInstalls: number; upToDateChecks: number } {
  return { installOperations: 0, skillInstalls: 0, packInstalls: 0, upToDateChecks: 0 };
}

function buildInstallAnalytics(url: URL, state: RegistryState, principal: Principal): InstallAnalytics {
  const days = parseAnalyticsDays(url);
  const now = Date.now();
  const currentDay = new Date(now);
  currentDay.setUTCHours(0, 0, 0, 0);
  const start = currentDay.getTime() - (days - 1) * 24 * 60 * 60 * 1000;
  const daily = new Map<string, InstallAnalytics['daily'][number]>();
  for (let index = 0; index < days; index += 1) {
    const date = new Date(start + index * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    daily.set(date, { date, ...emptyAnalyticsTotals() });
  }
  const topSkills = new Map<string, InstallAnalyticsTopSkill>();
  const receipts = (state.installReceipts ?? []).filter((receipt) => {
    const createdAt = Date.parse(receipt.createdAt);
    return receipt.organizationId === principal.organizationId &&
      Number.isFinite(createdAt) &&
      createdAt >= start && createdAt <= now &&
      canReadNamespace(principal, receipt.resolution.name);
  });
  const totals = emptyAnalyticsTotals();
  for (const receipt of receipts) {
    const createdAt = Date.parse(receipt.createdAt);
    const date = new Date(createdAt).toISOString().slice(0, 10);
    const bucket = daily.get(date);
    if (!bucket) continue;
    totals.installOperations += 1;
    bucket.installOperations += 1;
    if (!receipt.changed) {
      totals.upToDateChecks += 1;
      bucket.upToDateChecks += 1;
      continue;
    }
    if (receipt.resolution.kind === 'skill') {
      totals.skillInstalls += 1;
      bucket.skillInstalls += 1;
    } else {
      totals.packInstalls += 1;
      bucket.packInstalls += 1;
    }
    for (const member of receipt.resolution.members) {
      if (!canReadNamespace(principal, member.name)) continue;
      const key = `${member.id}\u0000${member.version}`;
      const existing = topSkills.get(key);
      if (existing) {
        existing.installs += 1;
      } else {
        topSkills.set(key, {
          resourceId: member.id,
          name: member.name,
          version: member.version,
          installs: 1,
        });
      }
    }
  }
  const top = [...topSkills.values()]
    .sort((left, right) => right.installs - left.installs || left.name.localeCompare(right.name) || left.version.localeCompare(right.version))
    .slice(0, 20);
  return {
    days,
    from: new Date(start).toISOString(),
    to: new Date(now).toISOString(),
    totals,
    daily: [...daily.values()],
    topSkills: top,
  };
}

async function resolveRequestedResolution(
  requested: JsonObject,
  state: RegistryState,
  principal: Principal,
): Promise<Resolution> {
  const kind = requested.kind;
  if (kind !== 'skill' && kind !== 'pack') {
    throw new RegistryApiError('INVALID_RESOLUTION', 'kind must be skill or pack', 400);
  }
  const ref = stringValue(requested.ref) || stringValue(requested.resourceId);
  if (!ref) throw new RegistryApiError('INVALID_RESOLUTION', 'ref or resourceId is required', 400);
  const version = requested.version === undefined ? undefined : requireVersion(requested.version);
  const result = resolveResource(state, principal, kind, ref, version);
  if (result.kind !== 'resolved') {
    if (result.kind === 'pending') throw new RegistryApiError('SCAN_PENDING', 'Resource is still being evaluated', 409, { retryable: true });
    throw unavailable();
  }
  // Callers may provide a previously resolved plan.  Every supplied digest and
  // member must match the current resolution; this prevents a stale or mixed
  // namespace plan from being authorized.
  if (requested.digest !== undefined && requested.digest !== result.resolution.digest) {
    throw new RegistryApiError('DIGEST_MISMATCH', 'Resolution digest does not match the current release', 409);
  }
  if (requested.members !== undefined) {
    if (!Array.isArray(requested.members) || requested.members.length !== result.resolution.members.length) {
      throw new RegistryApiError('POLICY_BLOCKED', 'Resolution members do not match the current release', 409);
    }
    for (const [index, rawMember] of requested.members.entries()) {
      if (!isObject(rawMember)) {
        throw new RegistryApiError('INVALID_RESOLUTION', 'Resolution members must be objects', 400);
      }
      const currentMember = result.resolution.members[index];
      const suppliedDigest = isObject(rawMember.artifact) ? stringValue(rawMember.artifact.digest) : undefined;
      if (
        !currentMember ||
        stringValue(rawMember.id) !== currentMember.id ||
        stringValue(rawMember.name) !== currentMember.name ||
        stringValue(rawMember.version) !== currentMember.version ||
        suppliedDigest !== currentMember.artifact.digest
      ) {
        throw new RegistryApiError('DIGEST_MISMATCH', 'Resolution members do not match the current release', 409);
      }
    }
  }
  return result.resolution;
}

function assertCurrentResolution(state: RegistryState, principal: Principal, resolution: Resolution): void {
  const result = resolveResource(state, principal, resolution.kind, resolution.resourceId, resolution.version);
  if (result.kind !== 'resolved' || !sameResolution(result.resolution, resolution)) {
    throw new RegistryApiError('POLICY_BLOCKED', 'Resolution is no longer installable', 409);
  }
}

function sameResolution(a: Resolution, b: Resolution): boolean {
  if (a.kind !== b.kind || a.resourceId !== b.resourceId || a.organizationId !== b.organizationId || a.name !== b.name || a.version !== b.version || a.digest !== b.digest) return false;
  if (a.members.length !== b.members.length) return false;
  return a.members.every((member, index) => {
    const other = b.members[index];
    return !!other && member.id === other.id && member.name === other.name && member.artifact.digest === other.artifact.digest && member.version === other.version;
  });
}

async function createDownloadGrant(
  digest: string,
  body: JsonObject,
  principal: Principal,
  deps: RegistryDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
): Promise<Response> {
  if (!isDigest(digest)) throw new RegistryApiError('INVALID_DIGEST', 'Artifact digest is invalid', 400);
  const resourceId = stringValue(body.resourceId);
  const authorizationId = stringValue(body.authorizationId);
  if (!resourceId || !authorizationId) throw new RegistryApiError('INVALID_REQUEST', 'resourceId and authorizationId are required', 400);
  const state = await readState(deps.repository, config.organizationId);
  const authorization = state.authorizations.find(
    (candidate) => candidate.id === authorizationId && candidate.subject === principal.subject,
  );
  if (!authorization || timestampExpired(authorization.expiresAt)) throw unavailable();
  assertCurrentResolution(state, principal, authorization.resolution);
  const result = await deps.repository.transaction(config.organizationId, (mutableState) => {
    const mutable = ensureState(mutableState, state.policy);
    const currentAuthorization = mutable.authorizations.find(
      (candidate) => candidate.id === authorizationId && candidate.subject === principal.subject,
    );
    if (!currentAuthorization || timestampExpired(currentAuthorization.expiresAt)) throw unavailable();
    assertCurrentResolution(mutable, principal, currentAuthorization.resolution);
    const member = currentAuthorization.resolution.members.find(
      (candidate) => candidate.id === resourceId && candidate.artifact.digest === digest,
    );
    if (!member || member.state !== 'approved') throw unavailable();
    const grant: TransferGrant = {
      id: randomId('grant'),
      organizationId: config.organizationId,
      subject: principal.subject,
      resourceId,
      authorizationId,
      digest: member.artifact.digest,
      expiresAt: new Date(Date.now() + TRANSFER_TTL_SECONDS * 1000).toISOString(),
    };
    mutable.grants.push(grant);
    appendAudit(mutable, audit(principal, 'artifact.download.grant', resourceId, {
      digest,
      authorizationId,
      requestId,
    }, config.organizationId));
    return { grant, size: member.artifact.size };
  });
  const descriptor: TransferDescriptor = {
    mode: 'gateway',
    url: `${config.publicOrigin.replace(/\/$/, '')}/v1/transfers/${encodeURIComponent(result.grant.id)}`,
    method: 'GET',
    headers: {},
    expiresAt: result.grant.expiresAt,
    size: result.size,
    digest,
    rangeSupported: false,
  };
  return jsonResponse(descriptor);
}

async function serveTransferGrant(
  grantIdPart: string,
  principal: Principal,
  deps: RegistryDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
): Promise<Response> {
  const grantId = decodePathPart(grantIdPart);
  const state = await readState(deps.repository, config.organizationId);
  const grant = state.grants.find((candidate) => candidate.id === grantId);
  if (
    !grant ||
    grant.organizationId !== config.organizationId ||
    grant.subject !== principal.subject ||
    timestampExpired(grant.expiresAt)
  ) {
    throw unavailable();
  }
  const authorization = state.authorizations.find((candidate) => candidate.id === grant.authorizationId && candidate.subject === grant.subject);
  if (!authorization || timestampExpired(authorization.expiresAt)) throw unavailable();
  assertCurrentResolution(state, principal, authorization.resolution);
  const skill = state.skills.find((candidate) => candidate.id === grant.resourceId);
  if (!skill || !skillCurrentlyApproved(state, skill) || skill.artifact.digest !== grant.digest) throw unavailable();
  let bytes: Uint8Array;
  try {
    bytes = await deps.blobs.get(skill.artifact.key);
  } catch {
    throw new RegistryApiError('ARTIFACT_UNAVAILABLE', 'Artifact is temporarily unavailable', 503, { retryable: true });
  }
  const actualDigest = await digestBytes(bytes);
  if (actualDigest !== grant.digest) {
    throw new RegistryApiError('DIGEST_MISMATCH', 'Stored artifact digest does not match its release', 409, {
      details: { requestId },
    });
  }
  return new Response(bytes as BodyInit, {
    status: 200,
    headers: {
      'cache-control': 'private, no-store',
      'content-type': 'application/octet-stream',
      'content-length': String(bytes.byteLength),
      'content-disposition': 'attachment',
    },
  });
}

async function handlePacksRoute(
  method: HttpMethod,
  segments: string[],
  request: Request,
  principal: Principal,
  deps: RegistryDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
): Promise<Response> {
  if (segments.length === 2) {
    if (method === 'GET') {
      requireReader(principal);
      const state = await readState(deps.repository, config.organizationId);
      return jsonResponse({
        packs: state.packs.filter((pack) => packVisibleToPrincipal(pack, state, principal)),
      });
    }
    if (method === 'POST') {
      requirePublisher(principal);
      const body = await readJson(request, config.maxBodyBytes);
      return await createPack(body, principal, deps, config, requestId);
    }
    return methodNotAllowed(['GET', 'POST']);
  }
  if (segments.length === 3 && method === 'GET') {
    requireReader(principal);
    const id = decodePathPart(segments[2]);
    const state = await readState(deps.repository, config.organizationId);
    const pack = state.packs.find((candidate) => candidate.id === id && packVisibleToPrincipal(candidate, state, principal));
    if (!pack) throw unavailable();
    return jsonResponse({ pack });
  }
  return methodNotAllowed(['GET']);
}

function packVisibleToPrincipal(pack: PackVersion, state: RegistryState, principal: Principal): boolean {
  if (!canReadNamespace(principal, pack.name)) return false;
  if (hasRole(principal, 'owner') || hasRole(principal, 'admin')) return true;
  return pack.members.every((member) => {
    const skill = state.skills.find((candidate) => candidate.id === member.resourceId);
    return !!skill && canReadNamespace(principal, skill.name);
  });
}

async function createPack(
  body: JsonObject,
  principal: Principal,
  deps: RegistryDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
): Promise<Response> {
  const name = requireSkillName(body.name);
  if (!canPublishName(principal, name)) throw new RegistryApiError('FORBIDDEN', 'Namespace publish denied', 403);
  const version = requireVersion(body.version);
  if (body.description !== undefined && typeof body.description !== 'string') {
    throw new RegistryApiError('INVALID_PACK', 'description must be a string', 400);
  }
  const description = stringValue(body.description) || '';
  if (!Array.isArray(body.skills) || body.skills.length === 0 || body.skills.length > 500) {
    throw new RegistryApiError('INVALID_PACK', 'skills must contain between 1 and 500 members', 400);
  }
  const state = await readState(deps.repository, config.organizationId);
  if (state.packs.some((pack) => pack.name === name && pack.version === version)) {
    throw new RegistryApiError('VERSION_CONFLICT', 'That pack version already exists', 409);
  }
  const members: PackMember[] = [];
  const ids = new Set<string>();
  for (const raw of body.skills) {
    if (!isObject(raw)) throw new RegistryApiError('INVALID_PACK', 'Each pack member must be an object', 400);
    const ref = stringValue(raw.ref);
    const memberVersion = requireVersion(raw.version);
    if (!ref) throw new RegistryApiError('INVALID_PACK', 'Each pack member requires ref', 400);
    const result = resolveResource(state, principal, 'skill', ref, memberVersion);
    if (result.kind !== 'resolved') {
      if (result.kind === 'pending') throw new RegistryApiError('SCAN_PENDING', 'Pack member is still being evaluated', 409, { retryable: true });
      throw new RegistryApiError('POLICY_BLOCKED', 'Pack members must be approved skills', 409);
    }
    if (result.resource.state !== 'approved') throw new RegistryApiError('POLICY_BLOCKED', 'Pack members must be approved skills', 409);
    if (ids.has(result.resource.id)) throw new RegistryApiError('INVALID_PACK', 'Pack members must be unique', 400);
    ids.add(result.resource.id);
    const skill = result.resource as SkillVersion;
    members.push({
      resourceId: skill.id,
      name: skill.name,
      version: skill.version,
      digest: skill.artifact.digest,
    });
  }
  const manifestBytes = new TextEncoder().encode(stableStringify({ name, version, description, members }));
  const manifestDigest = await digestBytes(manifestBytes);
  const pack: PackVersion = {
    id: randomId('pack'),
    organizationId: config.organizationId,
    name,
    version,
    description,
    members,
    manifestDigest,
    state: 'approved',
    createdAt: nowIso(),
    policyRevision: state.policy.revision,
  };
  const result = await deps.repository.transaction(config.organizationId, (current) => {
    const mutable = ensureState(current, state.policy);
    if (mutable.packs.some((candidate) => candidate.name === name && candidate.version === version)) {
      throw new RegistryApiError('VERSION_CONFLICT', 'That pack version already exists', 409);
    }
    // Recheck exact members in the same transaction as publication.  This is
    // the pack-level race/fencing invariant: a member cannot be revoked or
    // replaced between resolution and the immutable manifest commit.
    for (const member of members) {
      const skill = mutable.skills.find((candidate) => candidate.id === member.resourceId);
      if (!skill || skill.state !== 'approved' || skill.artifact.digest !== member.digest || skill.policyRevision !== mutable.policy.revision) {
        throw new RegistryApiError('POLICY_BLOCKED', 'Pack member changed before publication', 409, { retryable: true });
      }
    }
    mutable.packs.push(pack);
    appendAudit(mutable, audit(principal, 'pack.publish', pack.id, {
      manifestDigest,
      memberCount: members.length,
      requestId,
    }, config.organizationId));
    return pack;
  });
  return jsonResponse({ pack: result }, 201);
}

async function updatePolicy(
  body: JsonObject,
  principal: Principal,
  deps: RegistryDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
): Promise<Response> {
  const policy = parsePolicy(body);
  const current = await readState(deps.repository, config.organizationId);
  const next: Policy = {
    ...policy,
    // Revisions are server generated. A caller cannot replay or choose an
    // evidence namespace that was created under a different policy.
    revision: randomId('policy'),
  };
  const result = await deps.repository.transaction(config.organizationId, (mutableState) => {
    const mutable = ensureState(mutableState, current.policy);
    mutable.policy = next;
    appendAudit(mutable, audit(principal, 'policy.update', next.revision, {
      allowUnscanned: next.allowUnscanned,
      scannerCount: next.scanners.length,
      requestId,
    }, config.organizationId));
    return next;
  });
  return jsonResponse({ policy: result });
}

async function rescanSkill(
  id: string,
  principal: Principal,
  deps: RegistryDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
): Promise<Response> {
  const state = await readState(deps.repository, config.organizationId);
  const skill = state.skills.find((candidate) => candidate.id === id && canReadNamespace(principal, candidate.name));
  if (!skill) throw unavailable();
  const now = nowIso();
  const job: Job = {
    id: randomId('job'),
    organizationId: config.organizationId,
    kind: 'scan',
    state: 'queued',
    resourceId: skill.id,
    artifact: skill.artifact,
    policyRevision: state.policy.revision,
    policy: clonePolicy(state.policy),
    createdAt: now,
    updatedAt: now,
    attempts: 0,
  };
  const result = await deps.repository.transaction(config.organizationId, (mutableState) => {
    const mutable = ensureState(mutableState, state.policy);
    const currentSkill = mutable.skills.find((candidate) => candidate.id === id);
    if (!currentSkill || !canReadNamespace(principal, currentSkill.name)) throw unavailable();
    if (currentSkill.state !== 'revoked') currentSkill.state = 'pending';
    mutable.jobs.push(job);
    appendAudit(mutable, audit(principal, 'skill.rescan.queued', id, {
      digest: skill.artifact.digest,
      requestId,
    }, config.organizationId));
    return job;
  });
  return jsonResponse({ operation: result }, 202);
}

async function revokeSkill(
  id: string,
  principal: Principal,
  deps: RegistryDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
): Promise<Response> {
  const state = await readState(deps.repository, config.organizationId);
  const existing = state.skills.find((candidate) => candidate.id === id);
  if (!existing || !canReadNamespace(principal, existing.name)) throw unavailable();
  const result = await deps.repository.transaction(config.organizationId, (mutableState) => {
    const mutable = ensureState(mutableState, state.policy);
    const skill = mutable.skills.find((candidate) => candidate.id === id);
    if (!skill || !canReadNamespace(principal, skill.name)) throw unavailable();
    skill.state = 'revoked';
    for (const pack of mutable.packs) {
      if (pack.members.some((member) => member.resourceId === id)) pack.state = 'revoked';
    }
    appendAudit(mutable, audit(principal, 'skill.revoke', id, {
      digest: skill.artifact.digest,
      requestId,
    }, config.organizationId));
    return skill;
  });
  return jsonResponse({ skill: result });
}

interface PublicFeed {
  id: string;
  name: string;
  kind: Feed['kind'];
  enabled: boolean;
  configRevision: string;
  repositories?: string[];
  baseUrl: string;
  namespace: string;
}

interface NormalizedRegistryOpenClawDependencies extends RegistryOpenClawDependencies {
  enabled: boolean;
  advertisement?: OpenClawFeedAdvertisement;
}

function normalizeOpenClawDependencies(
  value: RegistryOpenClawDependencies | undefined,
): NormalizedRegistryOpenClawDependencies | undefined {
  if (value === undefined) return undefined;
  const enabled = value.enabled !== false;
  if (!enabled) return { ...value, enabled: false };
  if (
    !value.publicationManager ||
    typeof value.publicationManager.get !== 'function' ||
    typeof value.publicationManager.publishNext !== 'function'
  ) {
    throw new RegistryApiError('INVALID_CONFIGURATION', 'OpenClaw publication dependencies are invalid', 500);
  }
  if (value.feedId === 'clawhub-official') {
    throw new RegistryApiError('INVALID_CONFIGURATION', 'The private OpenClaw feed identity is reserved', 500);
  }
  let advertisement: OpenClawFeedAdvertisement;
  try {
    advertisement = createOpenClawFeedAdvertisement({
      feedId: value.feedId,
      feedUrl: value.feedUrl,
    });
  } catch {
    throw new RegistryApiError('INVALID_CONFIGURATION', 'The OpenClaw feed advertisement is invalid', 500);
  }
  return { ...value, enabled: true, advertisement };
}

function openClawCapability(
  openClaw: NormalizedRegistryOpenClawDependencies | undefined,
): Record<string, unknown> {
  if (!openClaw || !openClaw.enabled) return { enabled: false };
  return {
    enabled: true,
    advertisement: openClaw.advertisement,
    trustedFeedPreview: openClaw.trustedFeed !== undefined,
    refresh: typeof openClaw.candidatesForTenant === 'function',
    consumer: typeof openClaw.consumer?.selectAndQueue === 'function',
  };
}

async function handleOpenClawRoute(
  method: HttpMethod,
  segments: string[],
  request: Request,
  principal: Principal,
  deps: RegistryHandlerDependencies,
  config: Required<RegistryConfiguration>,
  openClaw: NormalizedRegistryOpenClawDependencies | undefined,
  requestId: string,
): Promise<Response> {
  if (!openClaw || !openClaw.enabled) {
    return errorResponse(
      new RegistryApiError('OPENCLAW_DISABLED', 'The OpenClaw feed is not configured', 503, { retryable: false }),
      requestId,
    );
  }
  if (segments.length === 3) {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    const route = createOpenClawTenantFeedRoute({
      manager: openClaw.publicationManager,
      authenticate: async () => principal,
      authorize: (candidate) => candidate.organizationId === config.organizationId,
      authorizePublication: (input) => authorizeOpenClawPublication(input, deps, config, openClaw),
      now: openClaw.now,
    });
    return route(request);
  }
  if (segments.length === 4 && segments[3] === 'catalog') {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    requireReader(principal);
    if (!openClaw.consumer?.refresh || !openClaw.trustedFeed) {
      throw new RegistryApiError(
        'OPENCLAW_CONSUMER_UNAVAILABLE',
        'The configured OpenClaw metadata consumer is unavailable',
        503,
        { retryable: true },
      );
    }
    if (openClaw.namespace && !canReadNamespace(principal, openClaw.namespace)) {
      throw new RegistryApiError('FORBIDDEN', 'The OpenClaw feed namespace is denied', 403);
    }
    let refreshed: Awaited<ReturnType<NonNullable<RegistryOpenClawConsumerDependencies['refresh']>>>;
    try {
      refreshed = await openClaw.consumer.refresh(request.signal);
    } catch {
      throw new RegistryApiError(
        'OPENCLAW_TRUSTED_FEED_UNAVAILABLE',
        'The configured OpenClaw metadata feed is unavailable',
        503,
        { retryable: true },
      );
    }
    if (!refreshed.snapshot || (refreshed.kind !== 'accepted' && refreshed.kind !== 'not-modified' && refreshed.kind !== 'stale')) {
      throw new RegistryApiError(
        'OPENCLAW_TRUSTED_FEED_UNAVAILABLE',
        'The configured OpenClaw metadata feed is unavailable',
        503,
        { retryable: true },
      );
    }
    return jsonResponse({
      feed: refreshed.snapshot.feed,
      source: {
        sha256: refreshed.snapshot.sha256,
        etag: refreshed.snapshot.etag,
        ...(refreshed.snapshot.lastModified === undefined ? {} : { lastModified: refreshed.snapshot.lastModified }),
        acceptedAt: new Date(refreshed.snapshot.acceptedAt).toISOString(),
        sourceUrl: refreshed.snapshot.sourceUrl,
        state: refreshed.kind,
      },
    });
  }
  if (segments.length === 4 && segments[3] === 'import') {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    requireReader(principal);
    if (!openClaw.consumer || !openClaw.trustedFeed) {
      throw new RegistryApiError(
        'OPENCLAW_CONSUMER_UNAVAILABLE',
        'The configured OpenClaw consumer is unavailable',
        503,
        { retryable: true },
      );
    }
    if (openClaw.namespace && !canReadNamespace(principal, openClaw.namespace)) {
      throw new RegistryApiError('FORBIDDEN', 'The OpenClaw feed namespace is denied', 403);
    }
    const body = await readJson(request, config.maxBodyBytes);
    const externalId = stringValue(body.externalId);
    if (!externalId || externalId.length > 2_048 || /[\u0000-\u001f\u007f]/u.test(externalId)) {
      throw new RegistryApiError('INVALID_REQUEST', 'externalId is invalid', 400);
    }
    if (openClaw.consumer.refresh) {
      const refreshed = await openClaw.consumer.refresh(request.signal);
      if (
        (refreshed.kind !== 'accepted' && refreshed.kind !== 'not-modified') ||
        refreshed.snapshot === undefined
      ) {
        throw new RegistryApiError(
          'OPENCLAW_TRUSTED_FEED_UNAVAILABLE',
          'The configured OpenClaw metadata feed is unavailable',
          503,
          { retryable: true },
        );
      }
    }
    let operation: OpenClawImportOperation;
    try {
      operation = await openClaw.consumer.selectAndQueue({
        key: {
          tenantId: config.organizationId,
          feedId: openClaw.trustedFeed.expectedFeedId,
          sourceUrl: new URL(openClaw.trustedFeed.url).href,
        },
        externalId,
        principal,
        signal: request.signal,
      });
    } catch (error) {
      throw openClawConsumerApiError(error);
    }
    return jsonResponse({
      feed: openClaw.trustedFeed.expectedFeedId,
      externalId,
      operation,
    }, 202);
  }
  if (segments.length === 4 && segments[3] === 'refresh') {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    requireAdmin(principal);
    return refreshOpenClawPublication(request, principal, deps, config, openClaw, requestId);
  }
  throw new RegistryApiError('NOT_FOUND', 'OpenClaw feed route not found', 404);
}

async function refreshOpenClawPublication(
  request: Request,
  principal: Principal,
  deps: RegistryHandlerDependencies,
  config: Required<RegistryConfiguration>,
  openClaw: NormalizedRegistryOpenClawDependencies,
  requestId: string,
): Promise<Response> {
  const candidateProvider = openClaw.candidatesForTenant;
  if (!candidateProvider) {
    throw new RegistryApiError(
      'OPENCLAW_SOURCE_PROOF_UNAVAILABLE',
      'The OpenClaw source verifier is not configured',
      503,
      { retryable: true },
    );
  }

  let metadata: OpenClawMetadataSnapshot | undefined;
  if (openClaw.trustedFeed) {
    const preview = openClaw.consumer?.refresh
      ? await openClaw.consumer.refresh(request.signal)
      : await previewOpenClawFeed(openClaw.trustedFeed, { signal: request.signal });
    if (
      (preview.kind !== 'accepted' && preview.kind !== 'not-modified') ||
      preview.snapshot === undefined
    ) {
      throw new RegistryApiError(
        'OPENCLAW_TRUSTED_FEED_UNAVAILABLE',
        'The configured OpenClaw metadata feed is unavailable',
        503,
        { retryable: true },
      );
    }
    metadata = preview.snapshot;
  }

  const state = await readState(deps.repository, config.organizationId);
  const provided = await candidateProvider({
    tenantId: config.organizationId,
    principal,
    state,
    ...(metadata === undefined ? {} : { metadata }),
    signal: request.signal,
  });
  if (!Array.isArray(provided) || provided.length > 1_000) {
    throw new RegistryApiError('OPENCLAW_SOURCE_PROOF_INVALID', 'The OpenClaw source verifier returned an invalid candidate set', 503, { retryable: true });
  }

  const currentCandidateSkills = new Set<OpenClawApprovedSkillCandidate['skill']>();
  const candidates: OpenClawApprovedSkillCandidate[] = [];
  for (const candidate of provided) {
    const skill = state.skills.find((entry) => entry.id === candidate?.skillId);
    if (!skill || skill.organizationId !== config.organizationId || !canReadNamespace(principal, skill.name)) continue;
    if (!candidate.skill || candidate.skill.state !== skill.state || candidate.skill.version !== skill.version || candidate.skill.policyRevision !== skill.policyRevision || candidate.skill.artifact.digest !== skill.artifact.digest) continue;
    if (!skillCurrentlyApproved(state, skill, openClaw.now?.() ?? Date.now())) continue;
    const currentEntry = metadata === undefined
      ? candidate.entry
      : openClawCandidateMatchesMetadata(candidate.entry, metadata);
    if (!currentEntry) continue;
    const normalized: OpenClawApprovedSkillCandidate = {
      skill: candidate.skill,
      entry: currentEntry,
      sourceArtifact: candidate.sourceArtifact,
    };
    currentCandidateSkills.add(candidate.skill);
    candidates.push(normalized);
  }
  const records = selectOpenClawEligibleRecords(
    candidates,
    (skill) => currentCandidateSkills.has(skill),
  );
  const generatedAt = new Date(openClaw.now?.() ?? Date.now()).toISOString();
  const expiresAt = new Date((openClaw.now?.() ?? Date.now()) + 24 * 60 * 60 * 1_000).toISOString();
  const publication: Omit<OpenClawFeedPublicationSnapshot, 'sequence'> = {
    id: openClaw.feedId,
    generatedAt,
    expiresAt,
    records,
  };
  const authorized = await authorizeOpenClawPublication({
    tenantId: config.organizationId,
    principal,
    publication,
    signal: request.signal,
    ...(metadata === undefined ? {} : { metadata }),
  }, deps, config, openClaw);
  if (!authorized) {
    throw new RegistryApiError('OPENCLAW_PUBLICATION_DENIED', 'The OpenClaw publication did not pass current registry policy', 403);
  }
  const stored = await openClaw.publicationManager.publishNext({
    tenantId: config.organizationId,
    publication,
  });
  await deps.repository.transaction(config.organizationId, (mutableState) => {
    const mutable = ensureState(mutableState, defaultPolicy());
    appendAudit(mutable, audit(principal, 'openclaw.publication.refresh', stored.id, {
      feedId: stored.id,
      sequence: stored.sequence,
      entryCount: records.length,
      requestId,
    }, config.organizationId));
  });
  return jsonResponse({
    feed: {
      id: stored.id,
      sequence: stored.sequence,
      generatedAt: stored.generatedAt,
      expiresAt: stored.expiresAt,
      sha256: stored.sha256,
      entryCount: records.length,
    },
    ...(metadata === undefined ? {} : {
      source: {
        feedId: metadata.feed.id,
        sequence: metadata.feed.sequence,
        sha256: metadata.sha256,
        acceptedAt: new Date(metadata.acceptedAt).toISOString(),
        entryCount: metadata.feed.entries.length,
      },
    }),
  }, 200);
}

function openClawConsumerApiError(error: unknown): RegistryApiError {
  if (error instanceof OpenClawConsumerSelectionError) {
    if (error.code === 'forbidden') return new RegistryApiError('FORBIDDEN', 'The requested OpenClaw skill is not authorized', 403);
    if (error.code === 'entry-not-found') return new RegistryApiError('NOT_FOUND', 'The requested OpenClaw skill is unavailable', 404);
    if (error.code === 'entry-invalid') return new RegistryApiError('INVALID_REQUEST', 'The requested OpenClaw skill is invalid', 400);
    if (error.code === 'aborted') return new RegistryApiError('REQUEST_ABORTED', 'The OpenClaw selection was cancelled', 400);
    if (error.code === 'snapshot-expired' || error.code === 'snapshot-unavailable' || error.code === 'snapshot-invalid' || error.code === 'queue-unavailable') {
      return new RegistryApiError('OPENCLAW_CONSUMER_UNAVAILABLE', 'The OpenClaw consumer is temporarily unavailable', 503, { retryable: true });
    }
  }
  return new RegistryApiError('OPENCLAW_CONSUMER_UNAVAILABLE', 'The OpenClaw consumer is temporarily unavailable', 503, { retryable: true });
}

type OpenClawQueueNormalizedCandidate = ReturnType<typeof normalizeOpenClawCandidate>;

function normalizeOpenClawQueueEntry(entry: OpenClawFeedEntry): OpenClawQueueNormalizedCandidate {
  if (!entry || entry.type !== 'skill' || entry.state !== 'available' || !Array.isArray(entry.install?.candidates) || entry.install.candidates.length !== 1) {
    throw new RegistryApiError('OPENCLAW_CONSUMER_UNAVAILABLE', 'The trusted OpenClaw entry is not importable', 503, { retryable: true });
  }
  try {
    return normalizeOpenClawCandidate(entry, entry.install.candidates[0]!);
  } catch {
    throw new RegistryApiError('OPENCLAW_CONSUMER_UNAVAILABLE', 'The trusted OpenClaw entry is not importable', 503, { retryable: true });
  }
}

function openClawQueueSourceIdentity(source: OpenClawQueueNormalizedCandidate['source']): string {
  return source.kind === 'public-clawhub'
    ? `${source.kind}:${source.packageName}@${source.version}:${source.artifactDigest}`
    : `${source.kind}:${source.repo}:${source.path}@${source.commit}:${source.contentHash}`;
}

function openClawQueueVersion(
  entryVersion: string,
  source: OpenClawQueueNormalizedCandidate['source'],
): string {
  if (/^(?:0|[1-9]\d*)\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(entryVersion)) return entryVersion;
  const suffix = source.kind === 'public-clawhub'
    ? source.artifactDigest.slice('sha256:'.length, 'sha256:'.length + 32)
    : source.commit.slice(0, 32);
  return `0.0.0+openclaw.${suffix}`;
}

function validateOpenClawQueueNamespace(value: string): string {
  if (typeof value !== 'string' || !/^@[a-z0-9][a-z0-9._-]{0,63}$/u.test(value)) {
    throw new RegistryApiError('INVALID_CONFIGURATION', 'The OpenClaw import namespace is invalid', 500);
  }
  return value;
}

function validateOpenClawSourceProviderOrigin(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new RegistryApiError('INVALID_CONFIGURATION', 'The OpenClaw source provider origin is invalid', 500);
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error('invalid origin');
    }
    return parsed.origin;
  } catch {
    throw new RegistryApiError('INVALID_CONFIGURATION', 'The OpenClaw source provider origin is invalid', 500);
  }
}

/**
 * Validate the immutable feed freshness copied into a queued import.  The
 * consumer validates the complete feed before enqueueing; this second check
 * keeps the durable queue honest if a caller bypasses that adapter and also
 * prevents an old queued job from being accepted after the local one-day
 * compatibility window has elapsed.
 */
function validateOpenClawQueueFeed(
  input: OpenClawImportQueueRequest,
  now: number,
): void {
  let sourceUrl: URL;
  try {
    sourceUrl = new URL(input.sourceUrl);
  } catch {
    throw new RegistryApiError('OPENCLAW_CONSUMER_UNAVAILABLE', 'The trusted OpenClaw feed URL is invalid', 503, { retryable: true });
  }
  if (
    sourceUrl.protocol !== 'https:' ||
    sourceUrl.username ||
    sourceUrl.password ||
    sourceUrl.search ||
    sourceUrl.hash ||
    sourceUrl.href !== input.sourceUrl
  ) {
    throw new RegistryApiError('OPENCLAW_CONSUMER_UNAVAILABLE', 'The trusted OpenClaw feed URL is invalid', 503, { retryable: true });
  }
  if (
    typeof input.feedId !== 'string' ||
    input.feedId.length === 0 ||
    input.feedId.length > 512 ||
    !Number.isSafeInteger(input.feedSequence) ||
    input.feedSequence < 0 ||
    !/^sha256:[0-9a-f]{64}$/u.test(input.feedDigest) ||
    typeof input.feedGeneratedAt !== 'string' ||
    typeof input.feedExpiresAt !== 'string' ||
    !Number.isFinite(now)
  ) {
    throw new RegistryApiError('OPENCLAW_CONSUMER_UNAVAILABLE', 'The trusted OpenClaw feed freshness metadata is invalid', 503, { retryable: true });
  }
  const generatedAt = Date.parse(input.feedGeneratedAt);
  const expiresAt = Date.parse(input.feedExpiresAt);
  const compatibility = isOpenClawClawHubSkillsCompatibilityIdentity(input.feedId, sourceUrl);
  if (
    !Number.isFinite(generatedAt) ||
    !Number.isFinite(expiresAt) ||
    generatedAt > now ||
    expiresAt <= generatedAt ||
    expiresAt - generatedAt > (compatibility ? OPENCLAW_CLAWHUB_SKILLS_MAX_TTL_MS : 24 * 60 * 60 * 1_000)
  ) {
    throw new RegistryApiError('OPENCLAW_CONSUMER_UNAVAILABLE', 'The trusted OpenClaw feed freshness metadata is invalid', 503, { retryable: true });
  }
  if (input.feedId === OPENCLAW_CLAWHUB_SKILLS_FEED_ID && !compatibility) {
    throw new RegistryApiError('OPENCLAW_CONSUMER_UNAVAILABLE', 'The ClawHub skills feed identity is bound to its compatibility URL', 503, { retryable: true });
  }
  if (compatibility && input.feedCompatibilityProfile !== OPENCLAW_CLAWHUB_SKILLS_COMPATIBILITY_PROFILE) {
    throw new RegistryApiError('OPENCLAW_CONSUMER_UNAVAILABLE', 'The OpenClaw compatibility profile is not enabled for this feed', 503, { retryable: true });
  }
  if (!compatibility && input.feedCompatibilityProfile !== undefined) {
    throw new RegistryApiError('OPENCLAW_CONSUMER_UNAVAILABLE', 'The OpenClaw compatibility profile does not match this feed', 503, { retryable: true });
  }
  const effectiveExpiry = effectiveOpenClawFeedExpiry({
    id: input.feedId,
    generatedAt: input.feedGeneratedAt,
    expiresAt: input.feedExpiresAt,
  }, sourceUrl);
  if (!Number.isFinite(effectiveExpiry) || effectiveExpiry <= now) {
    throw new RegistryApiError('OPENCLAW_CONSUMER_UNAVAILABLE', 'The trusted OpenClaw feed has expired', 503, { retryable: true });
  }
}

function sameOpenClawQueueFeed(left: unknown, right: unknown): boolean {
  if (!isObject(left) || !isObject(right)) return false;
  return left.id === right.id &&
    left.sequence === right.sequence &&
    left.digest === right.digest &&
    left.sourceUrl === right.sourceUrl &&
    left.generatedAt === right.generatedAt &&
    left.expiresAt === right.expiresAt &&
    left.compatibilityProfile === right.compatibilityProfile;
}

/** Validate freshness again at completion/proof admission time. */
function validateOpenClawJobFeed(job: Job, now: number): void {
  if (!isObject(job.openclawSource) || job.openclawSource.feed === undefined) return;
  const feed = job.openclawSource.feed;
  if (!isObject(feed)) {
    throw new RegistryApiError('OPENCLAW_CONSUMER_UNAVAILABLE', 'The queued OpenClaw feed metadata is invalid', 503, { retryable: true });
  }
  if (
    typeof feed.id !== 'string' ||
    typeof feed.sourceUrl !== 'string' ||
    typeof feed.sequence !== 'number' ||
    typeof feed.digest !== 'string' ||
    typeof feed.generatedAt !== 'string' ||
    typeof feed.expiresAt !== 'string'
  ) {
    throw new RegistryApiError('OPENCLAW_CONSUMER_UNAVAILABLE', 'The queued OpenClaw feed freshness metadata is invalid', 503, { retryable: true });
  }
  validateOpenClawQueueFeed({
    feedId: feed.id,
    feedSequence: feed.sequence,
    feedDigest: feed.digest as Digest,
    sourceUrl: feed.sourceUrl,
    feedGeneratedAt: feed.generatedAt,
    feedExpiresAt: feed.expiresAt,
    ...(feed.compatibilityProfile === undefined ? {} : { feedCompatibilityProfile: feed.compatibilityProfile }),
  } as OpenClawImportQueueRequest, now);
}

function openClawCandidateMatchesMetadata(
  entry: OpenClawFeedEntry,
  metadata: OpenClawMetadataSnapshot,
  requireCurrentPresentation = false,
): OpenClawFeedEntry | undefined {
  const metadataEntry = metadata.feed.entries.find((candidate) => candidate.id === entry.id && candidate.version === entry.version);
  if (!metadataEntry || entry.type !== 'skill' || metadataEntry.type !== 'skill' || metadataEntry.state !== 'available') return undefined;
  const matches = entry.install.candidates.some((candidate) => metadataEntry.install.candidates.some((expected) =>
    expected.sourceRef === candidate.sourceRef &&
    expected.package === candidate.package &&
    expected.version === candidate.version &&
    expected.integrity === candidate.integrity &&
    JSON.stringify(expected.github) === JSON.stringify(candidate.github),
  ));
  if (matches && requireCurrentPresentation && (
    metadataEntry.title !== entry.title ||
    metadataEntry.description !== entry.description ||
    metadataEntry.icon !== entry.icon ||
    metadataEntry.featured !== entry.featured ||
    metadataEntry.featuredAt !== entry.featuredAt ||
    JSON.stringify(metadataEntry.publisher) !== JSON.stringify(entry.publisher)
  )) return undefined;
  return matches ? metadataEntry as OpenClawFeedEntry : undefined;
}

function openClawTrustedMetadataUsable(
  metadata: OpenClawMetadataSnapshot | undefined,
  expectedFeedId: string,
  expectedSourceUrl: string,
  now: number,
): metadata is OpenClawMetadataSnapshot {
  if (!metadata || metadata.feed.id !== expectedFeedId || metadata.feed.schemaVersion !== 1) return false;
  let sourceUrl: string;
  try {
    sourceUrl = new URL(metadata.sourceUrl).href;
  } catch {
    return false;
  }
  if (sourceUrl !== expectedSourceUrl) return false;
  const generatedAt = Date.parse(metadata.feed.generatedAt);
  const expiresAt = Date.parse(metadata.feed.expiresAt);
  const currentClawHubSkills = isOpenClawClawHubSkillsCompatibilityIdentity(metadata.feed.id, sourceUrl);
  const effectiveExpiry = effectiveOpenClawFeedExpiry(metadata.feed, sourceUrl);
  return Number.isFinite(generatedAt) && Number.isFinite(expiresAt) &&
    generatedAt <= now && expiresAt > now && effectiveExpiry > now &&
    Number.isFinite(metadata.acceptedAt) && metadata.acceptedAt <= now &&
    (!currentClawHubSkills || expiresAt - generatedAt <= OPENCLAW_CLAWHUB_SKILLS_MAX_TTL_MS);
}

async function authorizeOpenClawPublication(
  input: {
    tenantId: string;
    principal: Principal;
    publication: OpenClawStoredPublication | OpenClawFeedPublicationSnapshot | Omit<OpenClawFeedPublicationSnapshot, 'sequence'>;
    signal: AbortSignal;
    metadata?: OpenClawMetadataSnapshot;
  },
  deps: RegistryHandlerDependencies,
  config: Required<RegistryConfiguration>,
  openClaw: NormalizedRegistryOpenClawDependencies,
): Promise<boolean> {
  if (input.signal.aborted || input.tenantId !== config.organizationId || input.principal.organizationId !== config.organizationId) return false;
  const entries = openClawPublicationEntries(input.publication, openClaw.feedId);
  if (!entries) return false;
  let trustedMetadata = input.metadata;
  if (trustedMetadata === undefined && openClaw.trustedFeed !== undefined) {
    if (openClaw.currentTrustedMetadata === undefined) return false;
    try {
      trustedMetadata = await openClaw.currentTrustedMetadata();
    } catch {
      return false;
    }
  }
  if (openClaw.trustedFeed !== undefined &&
      !openClawTrustedMetadataUsable(
        trustedMetadata,
        openClaw.trustedFeed.expectedFeedId,
        new URL(openClaw.trustedFeed.url).href,
        openClaw.now?.() ?? Date.now(),
      )) {
    return false;
  }
  const state = await readState(deps.repository, config.organizationId);
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id) || entry.type !== 'skill' || entry.state !== 'available' || entry.install.candidates.length !== 1) return false;
    seen.add(entry.id);
    let normalized;
    try {
      normalized = normalizeOpenClawCandidate(entry, entry.install.candidates[0]!);
    } catch {
      return false;
    }
    if (trustedMetadata !== undefined && !openClawCandidateMatchesMetadata(entry, trustedMetadata, true)) return false;
    const matches = state.skills.filter((skill) =>
      skill.organizationId === config.organizationId &&
      canReadNamespace(input.principal, skill.name) &&
      skillCurrentlyApproved(state, skill, openClaw.now?.() ?? Date.now()) &&
      openClawProvenanceMatches(skill, normalized),
    );
    if (matches.length !== 1) return false;
  }
  return true;
}

function openClawPublicationEntries(
  publication: OpenClawStoredPublication | OpenClawFeedPublicationSnapshot | Omit<OpenClawFeedPublicationSnapshot, 'sequence'>,
  expectedFeedId: string,
): readonly OpenClawFeedEntry[] | undefined {
  try {
    if ('body' in publication) {
      return parseOpenClawFeed(publication.body, {
        expectedFeedId,
        checkExpiry: false,
      }).entries;
    }
    if (publication.id !== expectedFeedId) return undefined;
    return publication.records.map((record) => record.entry);
  } catch {
    return undefined;
  }
}

function openClawProvenanceMatches(
  skill: SkillVersion,
  normalized: ReturnType<typeof normalizeOpenClawCandidate>,
): boolean {
  const provenance = skill.provenance;
  if (provenance.externalDigest !== normalized.candidate.integrity) return false;
  if (normalized.source.kind === 'public-clawhub') {
    return provenance.kind === 'registry' &&
      provenance.sourceResolutionKind === 'snapshot' &&
      provenance.externalId === normalized.candidate.package &&
      provenance.revision === normalized.candidate.version;
  }
  return provenance.kind === 'github' &&
    provenance.sourceResolutionKind === 'github' &&
    provenance.externalId === normalized.candidate.package &&
    provenance.repository === normalized.source.repo &&
    provenance.path === normalized.source.path &&
    provenance.resolvedCommit === normalized.source.commit &&
    provenance.sourceProviderOrigin === 'https://github.com';
}

/**
 * Reconstruct source-proof material from a server-owned OpenClaw job target.
 * The target is carried through the leased worker job, while the digest and
 * immutable source fields are checked again against worker completion
 * provenance.  A browser cannot submit this extension through a public route.
 */
function openClawCompletionProof(
  job: Job,
  rawProvenance: unknown,
  canonicalArtifactDigest: string | undefined,
): { entry: OpenClawFeedEntry; sourceArtifact: OpenClawSourceArtifactProof } | undefined {
  if (!isObject(job.openclawSource) || !isObject(job.openclawSource.entry) || !isObject(job.openclawSource.source)) return undefined;
  try {
    validateOpenClawJobFeed(job, Date.now());
  } catch {
    // A feed may expire between completion and proof recording. The imported
    // release remains governed by the normal scanner policy, but it cannot be
    // admitted to the OpenClaw publication after its selected feed window.
    return undefined;
  }
  const descriptor = job.openclawSource;
  const entry = descriptor.entry as unknown as OpenClawFeedEntry;
  const source = descriptor.source;
  if (!isObject(source)) return undefined;
  let normalized: ReturnType<typeof normalizeOpenClawCandidate>;
  try {
    if (!Array.isArray(entry.install?.candidates) || entry.install.candidates.length !== 1) return undefined;
    normalized = normalizeOpenClawCandidate(entry, entry.install.candidates[0]!);
  } catch {
    return undefined;
  }
  const provenance = isObject(rawProvenance) ? rawProvenance : undefined;
  if (
    !provenance ||
    canonicalArtifactDigest === undefined ||
    provenance.externalDigest !== normalized.candidate.integrity ||
    provenance.sourceDigest !== canonicalArtifactDigest
  ) return undefined;
  // ImportRequest.version is a server-owned private release version.  Hosted
  // ClawHub candidates may carry SemVer while GitHub candidates carry an
  // immutable commit, so the worker source descriptor and completion proof,
  // rather than the private release version, bind the external entry.
  if (job.import?.externalId !== entry.id) return undefined;

  if (normalized.source.kind === 'public-clawhub') {
    if (
      source.kind !== 'public-clawhub' ||
      source.sourceRef !== 'public-clawhub' ||
      source.packageName !== normalized.source.packageName ||
      source.version !== normalized.source.version ||
      source.artifactDigest !== normalized.source.artifactDigest ||
      provenance.kind !== 'registry' ||
      provenance.sourceResolutionKind !== 'snapshot' ||
      provenance.externalId !== normalized.source.packageName ||
      provenance.revision !== normalized.source.version ||
      provenance.repository !== job.upstream?.baseUrl ||
      provenance.sourceProviderOrigin !== job.upstream?.baseUrl
    ) return undefined;
  } else {
    if (
      source.kind !== 'public-github' ||
      source.sourceRef !== 'public-github' ||
      source.repo !== normalized.source.repo ||
      source.path !== normalized.source.path ||
      source.commit !== normalized.source.commit ||
      source.contentHash !== normalized.source.contentHash ||
      provenance.kind !== 'github' ||
      provenance.sourceResolutionKind !== 'github' ||
      provenance.externalId !== normalized.candidate.package ||
      provenance.repository !== normalized.source.repo ||
      provenance.path !== normalized.source.path ||
      provenance.resolvedCommit !== normalized.source.commit ||
      provenance.sourceProviderOrigin !== 'https://github.com'
    ) return undefined;
  }
  return {
    entry,
    sourceArtifact: {
      verified: true,
      digest: normalized.candidate.integrity,
      format: normalized.source.kind === 'public-clawhub' ? 'clawhub-skill-v1' : 'github-skill-folder-v1',
      identity: normalized.source.kind === 'public-clawhub'
        ? `${normalized.source.packageName}@${normalized.source.version}`
        : `${normalized.source.repo}:${normalized.source.path}@${normalized.source.commit}`,
    },
  };
}

async function handleFeedsRoute(
  method: HttpMethod,
  segments: string[],
  request: Request,
  principal: Principal,
  deps: RegistryDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
): Promise<Response> {
  if (segments.length === 2) {
    if (method === 'GET') {
      requireReader(principal);
      const state = await readState(deps.repository, config.organizationId);
      return jsonResponse({ feeds: (state.feeds ?? [])
        .filter((feed) => canReadNamespace(principal, feedNamespace(feed)))
        .map(publicFeed) });
    }
    if (method === 'POST') {
      requireAdmin(principal);
      const body = await readJson(request, config.maxBodyBytes);
      const candidate = parseFeed(body, config);
      const feed = await deps.repository.transaction(config.organizationId, (mutableState) => {
        const mutable = ensureState(mutableState, defaultPolicy());
        assertFeedNameAvailable(mutable, candidate.name);
        if (mutable.feeds!.some((existing) => existing.name === candidate.name)) {
          throw new RegistryApiError('VERSION_CONFLICT', 'That feed already exists', 409);
        }
        const created: Feed = {
          ...candidate,
          id: randomId('feed'),
          organizationId: config.organizationId,
          configRevision: randomId('feed-config'),
        };
        mutable.feeds!.push(created);
        appendAudit(mutable, audit(principal, 'feed.create', created.id, {
          feed: created.name,
          kind: created.kind,
          requestId,
        }, config.organizationId));
        return created;
      });
      return jsonResponse({ feed: publicFeed(feed) }, 201);
    }
    return methodNotAllowed(['GET', 'POST']);
  }

  if (segments.length === 3) {
    const id = decodePathPart(segments[2]!);
    const state = await readState(deps.repository, config.organizationId);
    const existing = (state.feeds ?? []).find((feed) => feed.id === id);
    if (!existing) throw unavailable();
    if (method === 'GET') {
      requireReader(principal);
      if (!canReadNamespace(principal, feedNamespace(existing))) throw new RegistryApiError('FORBIDDEN', 'Feed namespace denied', 403);
      return jsonResponse({ feed: publicFeed(existing) });
    }
    if (method === 'PATCH') {
      requireAdmin(principal);
      const body = await readJson(request, config.maxBodyBytes);
      const patch = parseFeedPatch(body, config);
      const updated = await deps.repository.transaction(config.organizationId, (mutableState) => {
        const mutable = ensureState(mutableState, defaultPolicy());
        const current = mutable.feeds!.find((feed) => feed.id === id);
        if (!current) throw unavailable();
        const next: Feed = { ...current, ...patch };
        assertFeedNameAvailable(mutable, next.name, current.id);
        mutable.feeds![mutable.feeds!.indexOf(current)] = {
          ...next,
          configRevision: randomId('feed-config'),
        };
        appendAudit(mutable, audit(principal, 'feed.update', current.id, {
          feed: current.name,
          enabled: next.enabled,
          requestId,
        }, config.organizationId));
        return mutable.feeds![mutable.feeds!.indexOf(current)]!;
      });
      return jsonResponse({ feed: publicFeed(updated) });
    }
    return methodNotAllowed(['GET', 'PATCH']);
  }

  throw new RegistryApiError('NOT_FOUND', 'Feed route not found', 404);
}

function publicFeed(feed: Feed): PublicFeed {
  return {
    id: feed.id,
    name: feed.name,
    kind: feed.kind,
    enabled: feed.enabled,
    configRevision: feed.configRevision,
    ...(feed.repositories === undefined ? {} : { repositories: [...feed.repositories] }),
    baseUrl: feed.baseUrl,
    namespace: feedNamespace(feed),
  };
}

function parseFeed(body: JsonObject, config: Required<RegistryConfiguration>): Omit<Feed, 'id' | 'organizationId' | 'configRevision'> {
  const allowed = new Set(['name', 'kind', 'enabled', 'repositories', 'baseUrl', 'namespace']);
  if (Object.keys(body).some((key) => !allowed.has(key))) throw new RegistryApiError('INVALID_FEED', 'Feed contains an unsupported field', 400);
  const name = requireFeedName(body.name);
  if (body.kind !== 'skills-sh') throw new RegistryApiError('INVALID_FEED', 'Only skills.sh feeds are supported', 400);
  const enabled = body.enabled === undefined ? true : body.enabled;
  if (typeof enabled !== 'boolean') throw new RegistryApiError('INVALID_FEED', 'enabled must be a boolean', 400);
  const repositories = parseFeedRepositories(body.repositories);
  const baseUrl = parseFeedBaseUrl(body.baseUrl, config);
  const namespace = parseFeedNamespace(body.namespace === undefined ? `@${name}` : body.namespace);
  return {
    name,
    kind: 'skills-sh',
    enabled,
    ...(repositories === undefined ? {} : { repositories }),
    baseUrl,
    namespace,
  };
}

function parseFeedPatch(body: JsonObject, config: Required<RegistryConfiguration>): Partial<Omit<Feed, 'id' | 'organizationId' | 'name' | 'kind' | 'configRevision'>> {
  const allowed = new Set(['enabled', 'repositories', 'baseUrl', 'namespace']);
  if (Object.keys(body).some((key) => !allowed.has(key))) throw new RegistryApiError('INVALID_FEED', 'Feed update contains an unsupported field', 400);
  const patch: Partial<Omit<Feed, 'id' | 'organizationId' | 'name' | 'kind' | 'configRevision'>> = {};
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw new RegistryApiError('INVALID_FEED', 'enabled must be a boolean', 400);
    patch.enabled = body.enabled;
  }
  if (body.repositories !== undefined) patch.repositories = parseFeedRepositories(body.repositories);
  if (body.baseUrl !== undefined) patch.baseUrl = parseFeedBaseUrl(body.baseUrl, config);
  if (body.namespace !== undefined) patch.namespace = parseFeedNamespace(body.namespace);
  return patch;
}

function requireFeedName(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(value)) {
    throw new RegistryApiError('INVALID_FEED', 'Feed name must be a lowercase identifier', 400);
  }
  return value;
}

function parseFeedRepositories(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((candidate) => typeof candidate !== 'string')) {
    throw new RegistryApiError('INVALID_FEED', 'repositories must be an array of strings', 400);
  }
  const repositories = value as string[];
  if (repositories.some((repository) => repository.length === 0 || repository.length > 2_048 || !isWellFormedUnicodeString(repository) || /[\u0000-\u001f\u007f]/u.test(repository))) {
    throw new RegistryApiError('INVALID_FEED', 'repositories contains an invalid source identity', 400);
  }
  return repositories.map((repository) => normalizeSkillsDirectorySource(repository));
}

function parseFeedBaseUrl(value: unknown, config: Required<RegistryConfiguration>): string {
  const raw = value === undefined ? 'https://skills.sh' : value;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2_048) throw new RegistryApiError('INVALID_FEED', 'baseUrl is invalid', 400);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new RegistryApiError('INVALID_FEED', 'baseUrl is invalid', 400);
  }
  if (parsed.protocol !== 'https:' && !(config.allowLoopbackUpstreams && parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname))) {
    throw new RegistryApiError('INVALID_FEED', 'baseUrl must use HTTPS', 400);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new RegistryApiError('INVALID_FEED', 'baseUrl must not contain credentials or query data', 400);
  if (isLoopbackHost(parsed.hostname) && !config.allowLoopbackUpstreams) throw new RegistryApiError('INVALID_FEED', 'loopback feeds are disabled', 400);
  const normalized = parsed.toString().replace(/\/$/u, '');
  const trusted = config.trustedSkillsShBaseUrls.includes(normalized);
  const loopbackTest = config.allowLoopbackUpstreams && parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname);
  if (!trusted && !loopbackTest) throw new RegistryApiError('INVALID_FEED', 'baseUrl is not an operator-trusted skills.sh endpoint', 400);
  return normalized;
}

function parseFeedNamespace(value: unknown): string {
  if (typeof value !== 'string' || !/^@[a-z0-9][a-z0-9._-]{0,63}$/u.test(value)) {
    throw new RegistryApiError('INVALID_FEED', 'namespace must use @namespace syntax', 400);
  }
  return value;
}

function assertFeedNameAvailable(state: RegistryState, name: string, exceptFeedId?: string): void {
  if ((state.feeds ?? []).some((feed) => feed.id !== exceptFeedId && feed.name === name)) {
    throw new RegistryApiError('VERSION_CONFLICT', 'That feed name is already configured', 409);
  }
}

async function createUpstream(
  body: JsonObject,
  principal: Principal,
  deps: RegistryDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
): Promise<Response> {
  const name = stringValue(body.name);
  const kind = body.kind;
  const namespace = stringValue(body.namespace);
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) {
    throw new RegistryApiError('INVALID_UPSTREAM', 'upstream name is invalid', 400);
  }
  if (kind !== 'github' && kind !== 'registry' && kind !== 'skills-sh') {
    throw new RegistryApiError('INVALID_UPSTREAM', 'kind must be github, registry, or skills-sh', 400);
  }
  if (!namespace || !/^@[a-z0-9][a-z0-9._-]{0,63}$/.test(namespace)) throw new RegistryApiError('INVALID_UPSTREAM', 'namespace is invalid', 400);
  if (!canReadNamespace(principal, namespace)) throw new RegistryApiError('FORBIDDEN', 'Namespace access denied', 403);
  const baseUrl = stringValue(body.baseUrl);
  if (baseUrl) {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new RegistryApiError('INVALID_UPSTREAM', 'baseUrl is invalid', 400);
    }
    if (parsed.username || parsed.password) {
      throw new RegistryApiError('INVALID_UPSTREAM', 'upstream baseUrl must not contain credentials', 400);
    }
    if (parsed.protocol !== 'https:' && !(config.allowLoopbackUpstreams && isLoopbackHost(parsed.hostname) && parsed.protocol === 'http:')) {
      throw new RegistryApiError('INVALID_UPSTREAM', 'upstream baseUrl must use HTTPS', 400);
    }
    if (isLoopbackHost(parsed.hostname) && !config.allowLoopbackUpstreams) {
      throw new RegistryApiError('INVALID_UPSTREAM', 'loopback upstreams are disabled', 400);
    }
  }
  const credentialEnv = stringValue(body.credentialEnv);
  if (credentialEnv && !/^[A-Z_][A-Z0-9_]{0,127}$/.test(credentialEnv)) {
    throw new RegistryApiError('INVALID_UPSTREAM', 'credentialEnv must be an environment variable name', 400);
  }
  const repositoriesInput = body.repositories;
  const repositories = Array.isArray(repositoriesInput)
    ? repositoriesInput.filter((value): value is string => typeof value === 'string')
    : undefined;
  if (Array.isArray(repositoriesInput) && repositories && repositories.length !== repositoriesInput.length) {
    throw new RegistryApiError('INVALID_UPSTREAM', 'repositories must be strings', 400);
  }
  if (kind === 'skills-sh' && (!repositories || repositories.length === 0)) {
    throw new RegistryApiError('INVALID_UPSTREAM', 'skills-sh upstreams require a source allowlist', 400);
  }
  if (repositories?.some((repository) => repository.length === 0 || repository.length > 2_048 || /[\u0000-\u001f\u007f]/u.test(repository))) {
    throw new RegistryApiError('INVALID_UPSTREAM', 'repositories contains an invalid source identity', 400);
  }
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    throw new RegistryApiError('INVALID_UPSTREAM', 'enabled must be a boolean', 400);
  }
  const upstream: Upstream = {
    id: randomId('upstream'),
    organizationId: config.organizationId,
    name,
    kind,
    enabled: body.enabled === undefined ? true : body.enabled,
    repositories,
    baseUrl,
    credentialEnv,
    namespace,
  };
  const result = await deps.repository.transaction(config.organizationId, (mutableState) => {
    const mutable = ensureState(mutableState, defaultPolicy());
    if (mutable.upstreams.some((candidate) => candidate.name === name)) throw new RegistryApiError('VERSION_CONFLICT', 'That upstream already exists', 409);
    mutable.upstreams.push(upstream);
    appendAudit(mutable, audit(principal, 'upstream.create', upstream.id, {
      kind,
      namespace,
      requestId,
    }, config.organizationId));
    return upstream;
  });
  return jsonResponse({ upstream: result }, 201);
}

async function createImportJob(
  body: JsonObject,
  principal: Principal,
  deps: RegistryDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
): Promise<Response> {
  const result = await resolveOrQueueImport(body, principal, deps, config, requestId);
  // Keep the historical `/v1/imports` operation field for callers that use
  // imports as a job API, while also returning the actual resolution on a
  // warm approved cache hit.
  if (result.status === 200) {
    return jsonResponse({ operation: result.job, resolution: result.resolution }, 200);
  }
  return jsonResponse({ operation: result.job }, 202);
}

async function resolveProxyRequest(
  body: JsonObject,
  principal: Principal,
  deps: RegistryDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
): Promise<Response> {
  const result = await resolveOrQueueImport(body, principal, deps, config, requestId);
  if (result.status === 200) {
    return jsonResponse({ resolution: result.resolution }, 200);
  }
  return jsonResponse({ operation: result.job }, 202);
}

interface TransparentProxyRequest {
  feed?: string;
  externalId: string;
  refresh: boolean;
}

/** A canonical source identity is derived from verified worker provenance. */
interface CanonicalSourceIdentity {
  provider: 'github' | 'well-known' | 'snapshot';
  host: string;
  repository: string;
  path: string;
  revision?: string;
  digest?: Digest;
}

interface SourceReferenceRequest {
  reference: string;
  revision?: string;
  refresh: boolean;
}

interface TransparentImportTemplate extends Omit<ImportRequest, 'version'> {
  externalId: string;
  path: string;
}

/**
 * Return true only for the additive, catalog-identity form.  A request that
 * includes a legacy import field is handled by the old publisher-only path so
 * callers cannot smuggle a caller-selected name into transparent resolution.
 */
function isTransparentProxyRequest(body: JsonObject): boolean {
  return (body.externalId !== undefined || body.feed !== undefined) && body.path === undefined;
}

function parseSourceReferenceRequest(body: JsonObject): SourceReferenceRequest {
  const allowed = new Set(['reference', 'revision', 'refresh']);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw new RegistryApiError('INVALID_PROXY_REQUEST', 'Source requests accept only reference, revision, and refresh', 400);
  }
  const reference = stringValue(body.reference);
  if (!reference) throw new RegistryApiError('INVALID_PROXY_REQUEST', 'reference is required', 400);
  parseCanonicalSourceReference(reference);
  const revision = body.revision === undefined ? undefined : stringValue(body.revision);
  if (body.revision !== undefined && (!revision || !/^[0-9a-f]{40}$/iu.test(revision))) {
    throw new RegistryApiError('INVALID_PROXY_REQUEST', 'revision must be a 40-hex immutable source revision', 400);
  }
  if (body.refresh !== undefined && typeof body.refresh !== 'boolean') {
    throw new RegistryApiError('INVALID_PROXY_REQUEST', 'refresh must be a boolean', 400);
  }
  return { reference, ...(revision ? { revision } : {}), refresh: body.refresh === true };
}

function parseCanonicalSourceReference(reference: string): CanonicalSourceIdentity {
  if (reference.length > 2_048 || !isWellFormedUnicodeString(reference) || /[\u0000-\u001f\u007f\\?#%]/u.test(reference) || !reference.startsWith('@')) {
    throw new RegistryApiError('INVALID_PROXY_REQUEST', 'reference is invalid', 400);
  }
  const parts = reference.slice(1).split('/');
  if (parts.length < 3 || parts.some((part) => !part || part === '.' || part === '..' || part.length > 512 || !/^[A-Za-z0-9._~-]+$/u.test(part))) {
    throw new RegistryApiError('INVALID_PROXY_REQUEST', 'reference is invalid', 400);
  }
  if (parts[0] !== 'github') throw new RegistryApiError('INVALID_PROXY_REQUEST', 'Only GitHub source references are supported', 400);
  const repository = `${parts[1]}/${parts[2]}`;
  const path = parts.slice(3).join('/');
  return {
    provider: 'github',
    host: 'github.com',
    repository,
    path,
  };
}

function parseTransparentProxyRequest(body: JsonObject): TransparentProxyRequest {
  const allowed = new Set(['feed', 'externalId', 'refresh']);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw new RegistryApiError(
      'INVALID_PROXY_REQUEST',
      'Transparent proxy requests accept only externalId and refresh',
      400,
    );
  }
  const feed = body.feed === undefined ? undefined : requireFeedName(body.feed);
  const externalId = requireDirectoryId(body.externalId);
  if (body.refresh !== undefined && typeof body.refresh !== 'boolean') {
    throw new RegistryApiError('INVALID_PROXY_REQUEST', 'refresh must be a boolean', 400);
  }
  return { ...(feed === undefined ? {} : { feed }), externalId, refresh: body.refresh === true };
}

async function resolveTransparentProxyRequest(
  body: JsonObject,
  principal: Principal,
  deps: RegistryHandlerDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
  requestSignal?: AbortSignal,
): Promise<Response> {
  const request = parseTransparentProxyRequest(body);
  const state = await readState(deps.repository, config.organizationId);
  const feed = findTransparentFeed(state, request.feed, principal, config);
  const upstream = feedAsUpstream(feed);

  // Cache-first is deliberate.  A normal install must not contact the public
  // catalog when this organization already has a matching pending or approved
  // release.  An explicit refresh is the only way to revalidate the catalog.
  if (!request.refresh) {
    const cached = findTransparentCachedResult(state, request.externalId, upstream, principal, config);
    if (cached) return transparentProxyResponse(cached, feed, request.externalId);
  }

  // The global directory client serves browse/default API routes only. A
  // transparent import must use a client whose origin and configured path are
  // bound to the selected feed; silently reusing a client for another feed
  // could hydrate the wrong catalog row under the caller's external ID.
  const directory = deps.directoryForBase?.(feed.baseUrl);
  if (!directory) throw directoryUnavailable();
  const detail = await directoryRequest(() => directory.detail(request.externalId, { signal: requestSignal }));
  if (
    detail.id !== request.externalId ||
    detail.id !== `${detail.source}/${detail.slug}` ||
    !detail.source ||
    !detail.slug ||
    !isSafeDirectoryExternalValue(detail.source) ||
    !isSafeDirectoryExternalValue(detail.slug)
  ) {
    throw new RegistryApiError('DIRECTORY_INTEGRITY', 'Directory detail identity is inconsistent', 502, { retryable: true });
  }
  if (!upstreamAllowsImport(upstream, detail.source)) throw unavailable();

  // The source type is presentation metadata, not a caller hint.  Rehydrate
  // only the exact trusted row when the detail snapshot is incomplete; the
  // worker performs its own authenticated source resolution before bytes are
  // admitted.
  const trustedRow = detail.hash === null || detail.files === null
    ? await lookupDirectoryCatalogRow(directory, detail, requestSignal)
    : undefined;
  const managedName = await transparentManagedName(upstream.namespace, request.externalId);
  const template: TransparentImportTemplate = {
    upstreamId: upstream.id,
    repository: detail.source,
    path: request.externalId,
    name: managedName,
    externalId: request.externalId,
    feedId: feed.id,
    feedName: feed.name,
    feedConfigRevision: feed.configRevision,
    externalSnapshotHash: detail.hash,
    ...(trustedRow ? { externalSourceType: trustedRow.sourceType } : {}),
  };
  const result = await queueTransparentImport(
    template,
    feed,
    request.refresh,
    principal,
    deps,
    config,
    requestId,
  );
  return transparentProxyResponse(result, feed, request.externalId);
}

/**
 * Resolve a previously verified source reference directly.  Cold source
 * acquisition still requires an administrator-configured GitHub upstream; a
 * caller cannot turn this route into an arbitrary URL fetch.  The source
 * reference is derived again from completion provenance before a warm result
 * is returned.
 */
async function resolveSourceReferenceRequest(
  body: JsonObject,
  principal: Principal,
  deps: RegistryHandlerDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
): Promise<Response> {
  const request = parseSourceReferenceRequest(body);
  const source = parseCanonicalSourceReference(request.reference);
  const state = await readState(deps.repository, config.organizationId);
  const upstream = findSourceReferenceUpstream(state, source, principal);
  const managedName = await sourceManagedName(upstream, source);
  if (!request.refresh) {
    const cached = findSourceCachedResult(state, source, request.revision, upstream, managedName, principal);
    if (cached) return sourceReferenceResponse(cached, source, request.revision);
  }
  const result = await queueSourceReferenceImport(
    source,
    request.revision,
    request.refresh,
    managedName,
    upstream,
    principal,
    deps,
    config,
    requestId,
  );
  return sourceReferenceResponse(result, source, request.revision);
}

function findSourceReferenceUpstream(
  state: RegistryState,
  source: CanonicalSourceIdentity,
  principal: Principal,
): Upstream {
  const candidates = state.upstreams
    .filter((upstream) =>
      upstream.organizationId === principal.organizationId &&
      upstream.kind === source.provider &&
      upstream.enabled &&
      canReadNamespace(principal, upstream.namespace) &&
      upstreamAllowsImport(upstream, source.repository) &&
      sourceHostMatchesUpstream(source.host, upstream),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  if (candidates.length === 0) throw unavailable();
  if (candidates.length > 1) {
    throw new RegistryApiError('UPSTREAM_MAPPING_REQUIRED', 'Multiple authorized source mappings match this reference', 409, {
      details: { upstreams: candidates.map((candidate) => ({ id: candidate.id, name: candidate.name, namespace: candidate.namespace })) },
    });
  }
  return candidates[0]!;
}

function sourceHostMatchesUpstream(host: string, upstream: Upstream): boolean {
  if (!upstream.baseUrl) return host === 'github.com';
  try {
    return new URL(upstream.baseUrl).hostname.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

type SourceCachedResult =
  | { status: 202; job: Job }
  | { status: 200; job: Job; resolution: Resolution; source: CanonicalSourceIdentity };

function findSourceCachedResult(
  state: RegistryState,
  source: CanonicalSourceIdentity,
  requestedRevision: string | undefined,
  upstream: Upstream,
  managedName: string,
  principal: Principal,
): SourceCachedResult | undefined {
  const candidates = state.jobs
    .filter((job) => {
      const request = job.import;
      return job.organizationId === principal.organizationId &&
        job.kind === 'import' &&
        request?.upstreamId === upstream.id &&
        request.repository === source.repository &&
        request.path === source.path &&
        request.name === managedName &&
        !!job.upstream &&
        sameUpstreamOrigin(job.upstream, upstream);
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
  for (const job of candidates) {
    if (job.state === 'queued' || job.state === 'running') return { status: 202, job };
    if (job.state !== 'completed' || !job.resourceId) continue;
    const skill = state.skills.find((candidate) => candidate.id === job.resourceId);
    if (!skill || !canReadNamespace(principal, skill.name) || !skillCurrentlyApproved(state, skill)) continue;
    const canonical = canonicalSourceFromSkill(skill);
    if (!canonical || !sourceIdentityMatches(canonical, source, requestedRevision)) continue;
    return { status: 200, job, resolution: skillResolution(skill), source: canonical };
  }
  return undefined;
}

function sourceReferenceResponse(
  result: SourceCachedResult,
  requested: CanonicalSourceIdentity,
  requestedRevision?: string,
): Response {
  const canonical = result.status === 200 ? result.source : undefined;
  const reference = canonical ? sourceReferenceFromCanonical(canonical) : sourceReferenceFromCanonical({ ...requested, ...(requestedRevision ? { revision: requestedRevision } : {}) });
  const source = canonical
    ? canonicalSourceDto(canonical)
    : requestedRevision
      ? canonicalSourceDto({ ...requested, revision: requestedRevision })
      : undefined;
  if (result.status === 200) return jsonResponse({ reference, ...(source ? { source } : {}), resolution: result.resolution }, 200);
  return jsonResponse({ reference, ...(source ? { source } : {}), operation: result.job }, 202);
}

async function sourceManagedName(upstream: Upstream, source: CanonicalSourceIdentity): Promise<string> {
  const digest = await digestBytes(new TextEncoder().encode(`source:${source.provider}:${source.host}:${source.repository}:${source.path}`));
  const namespace = upstream.namespace.replace(/^@/u, '');
  return `@${namespace}/source-${digest.slice('sha256:'.length, 'sha256:'.length + 48)}`;
}

async function queueSourceReferenceImport(
  source: CanonicalSourceIdentity,
  requestedRevision: string | undefined,
  refresh: boolean,
  managedName: string,
  upstream: Upstream,
  principal: Principal,
  deps: RegistryDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
): Promise<SourceCachedResult> {
  const state = await readState(deps.repository, config.organizationId);
  return await deps.repository.transaction(config.organizationId, (mutableState) => {
    const mutable = ensureState(mutableState, state.policy);
    const current = mutable.upstreams.find((candidate) => candidate.id === upstream.id);
    if (!current || !current.enabled || !sameUpstreamOrigin(current, upstream) || !canReadNamespace(principal, current.namespace)) {
      throw new RegistryApiError('PROVENANCE_CONFLICT', 'The source mapping changed while this import was being resolved', 409);
    }
    const candidates = mutable.jobs
      .filter((job) => {
        const request = job.import;
        return job.organizationId === config.organizationId &&
          job.kind === 'import' &&
          request?.upstreamId === upstream.id &&
          request.repository === source.repository &&
          request.path === source.path &&
          request.name === managedName &&
          !!job.upstream &&
          sameUpstreamOrigin(job.upstream, current);
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
    const active = candidates.find((candidate) => candidate.state === 'queued' || candidate.state === 'running');
    if (active) return { status: 202 as const, job: active };
    for (const candidate of candidates) {
      if (candidate.state !== 'completed' || !candidate.resourceId) continue;
      const skill = mutable.skills.find((value) => value.id === candidate.resourceId);
      if (!skill || !skillCurrentlyApproved(mutable, skill)) continue;
      const canonical = canonicalSourceFromSkill(skill);
      if (canonical && sourceIdentityMatches(canonical, source, requestedRevision) && !refresh) {
        return { status: 200 as const, job: candidate, resolution: skillResolution(skill), source: canonical };
      }
    }
    const version = generatedTransparentVersion();
    const importRequest: ImportRequest = {
      upstreamId: upstream.id,
      repository: source.repository,
      path: source.path,
      ...(requestedRevision ? { ref: requestedRevision } : {}),
      name: managedName,
      version,
      sourceReference: sourceReferenceFromCanonical({ ...source, ...(requestedRevision ? { revision: requestedRevision } : {}) }),
    };
    const job: Job = {
      id: randomId('job'),
      organizationId: config.organizationId,
      kind: 'import',
      state: 'queued',
      policyRevision: mutable.policy.revision,
      policy: clonePolicy(mutable.policy),
      import: importRequest,
      upstream: current,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      attempts: 0,
    };
    mutable.jobs.push(job);
    appendAudit(mutable, audit(principal, 'source.proxy.queued', job.id, {
      reference: sourceReferenceFromCanonical({ ...source, ...(requestedRevision ? { revision: requestedRevision } : {}) }),
      upstreamId: upstream.id,
      refresh,
      requestId,
    }, config.organizationId));
    return { status: 202 as const, job };
  });
}

function canonicalSourceFromSkill(skill: SkillVersion): CanonicalSourceIdentity | undefined {
  const provenance = skill.provenance;
  const origin = verifiedSourceOrigin(provenance.sourceProviderOrigin);
  if (provenance.sourceResolutionKind === 'snapshot' && provenance.kind === 'skills-sh' && provenance.externalId) {
    if (!isSafeDirectoryExternalValue(provenance.externalId)) return undefined;
    if (provenance.path !== provenance.externalId) return undefined;
    return {
      provider: 'snapshot',
      host: 'skills.sh',
      repository: 'skills.sh',
      path: provenance.externalId,
      digest: skill.artifact.digest,
    };
  }

  if (provenance.sourceResolutionKind === 'github' && origin === 'github.com' && provenance.repository && isCommit(provenance.resolvedCommit)) {
    const path = provenance.kind === 'skills-sh' ? provenance.skillPath : provenance.path;
    if (path === undefined || !isSafeSourcePath(path)) return undefined;
    if (!isSafeRepository(provenance.repository)) return undefined;
    return {
      provider: 'github',
      host: origin,
      repository: provenance.repository,
      path,
      revision: provenance.resolvedCommit,
      digest: skill.artifact.digest,
    };
  }

  if (provenance.sourceResolutionKind === 'well-known' && origin && provenance.repository && provenance.wellKnownEntryName && provenance.wellKnownIndexUrl) {
    const canonical = wellKnownCanonicalFromProvenance(provenance);
    if (canonical && (isCommit(provenance.resolvedCommit) || isDigest(provenance.externalDigest ?? ''))) {
      return { ...canonical, digest: skill.artifact.digest };
    }
  }

  // A v1 well-known index can prove the captured bundle and selected entry
  // without advertising an immutable upstream digest. Keep that result under
  // a truthful local snapshot identity instead of inventing a web revision.
  if (provenance.kind === 'skills-sh' && provenance.sourceResolutionKind === 'well-known' && provenance.externalId && provenance.path === provenance.externalId && isSafeDirectoryExternalValue(provenance.externalId)) {
    return {
      provider: 'snapshot',
      host: 'skills.sh',
      repository: 'skills.sh',
      path: provenance.externalId,
      digest: skill.artifact.digest,
    };
  }

  return undefined;
}

function sourceReferenceFromProvenance(provenance: Provenance): string | undefined {
  if (provenance.sourceResolutionKind === 'snapshot' && provenance.kind === 'skills-sh' && provenance.externalId && provenance.path === provenance.externalId && isSafeDirectoryExternalValue(provenance.externalId)) {
    return `@snapshot/skills-sh/${provenance.externalId}`;
  }
  const origin = verifiedSourceOrigin(provenance.sourceProviderOrigin);
  if (provenance.sourceResolutionKind === 'github' && origin === 'github.com' && provenance.repository && isCommit(provenance.resolvedCommit)) {
    const path = provenance.kind === 'skills-sh' ? provenance.skillPath : provenance.path;
    if (path !== undefined && isSafeSourcePath(path) && isSafeRepository(provenance.repository)) {
      return sourceReferenceFromCanonical({ provider: 'github', host: origin, repository: provenance.repository, path, revision: provenance.resolvedCommit });
    }
  }
  if (provenance.sourceResolutionKind === 'well-known' && (isCommit(provenance.resolvedCommit) || isDigest(provenance.externalDigest ?? ''))) {
    const canonical = wellKnownCanonicalFromProvenance(provenance);
    if (canonical) return sourceReferenceFromCanonical(canonical);
  }
  if (provenance.kind === 'skills-sh' && provenance.sourceResolutionKind === 'well-known' && provenance.externalId && provenance.path === provenance.externalId && isSafeDirectoryExternalValue(provenance.externalId)) {
    return `@snapshot/skills-sh/${provenance.externalId}`;
  }
  return undefined;
}

function verifiedSourceOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash) return undefined;
    return parsed.hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function verifiedSourceOriginFromUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return undefined;
    return parsed.hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function wellKnownCanonicalFromProvenance(provenance: Provenance): CanonicalSourceIdentity | undefined {
  if (!provenance.sourceProviderOrigin || !provenance.wellKnownIndexUrl || !provenance.wellKnownEntryName) return undefined;
  const origin = verifiedSourceOrigin(provenance.sourceProviderOrigin);
  const indexOrigin = verifiedSourceOriginFromUrl(provenance.wellKnownIndexUrl);
  const scope = wellKnownScopeFromIndexUrl(provenance.wellKnownIndexUrl);
  if (!origin || !indexOrigin || origin !== indexOrigin || !scope || !isSafeSourcePath(provenance.wellKnownEntryName)) return undefined;
  return {
    provider: 'well-known',
    host: origin,
    repository: scope,
    path: provenance.wellKnownEntryName,
    ...(isCommit(provenance.resolvedCommit) ? { revision: provenance.resolvedCommit } : {}),
  };
}

function wellKnownScopeFromIndexUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) return undefined;
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length < 3 || parts.at(-1) !== 'index.json' || parts.at(-2) !== 'agent-skills' && parts.at(-2) !== 'skills') return undefined;
    const scope = parts.slice(0, -1).join('/');
    return scope && isSafeSourcePath(scope) ? scope : undefined;
  } catch {
    return undefined;
  }
}

function isCommit(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/iu.test(value);
}

function isSafeRepository(value: string): boolean {
  return isWellFormedUnicodeString(value) && value.length > 0 && value.length <= 2_048 && value.split('/').length === 2 && value.split('/').every((part) => /^[A-Za-z0-9._~-]+$/u.test(part));
}

function isSafeSourcePath(value: string): boolean {
  return isWellFormedUnicodeString(value) && value.length <= 4_096 && !value.startsWith('/') && value.split('/').every((part) => part === '' || (part !== '.' && part !== '..' && /^[A-Za-z0-9._~-]+$/u.test(part)));
}

function sourceIdentityMatches(
  actual: CanonicalSourceIdentity,
  requested: CanonicalSourceIdentity,
  requestedRevision?: string,
): boolean {
  return actual.provider === requested.provider &&
    actual.host === requested.host &&
    actual.repository === requested.repository &&
    actual.path === requested.path &&
    (requestedRevision === undefined || actual.revision === requestedRevision);
}

function sourceReferenceFromCanonical(source: CanonicalSourceIdentity): string {
  if (source.provider === 'snapshot') return `@snapshot/skills-sh/${source.path}`;
  if (source.provider === 'github' && source.host === 'github.com' && source.path === '') return `@github/${source.repository}`;
  if (source.provider === 'github' && source.host === 'github.com') return `@github/${source.repository}/${source.path}`;
  if (source.provider === 'well-known') return `@web/${source.host}/${source.repository}/${source.path}`;
  if (source.provider === 'github' && source.path === '') return `@github/${source.host}/${source.repository}`;
  return `@${source.provider}/${source.host}/${source.repository}/${source.path}`;
}

function canonicalSourceDto(source: CanonicalSourceIdentity): CanonicalSourceIdentity {
  return { ...source };
}

function findTransparentFeed(state: RegistryState, name: string | undefined, principal: Principal, config: Required<RegistryConfiguration>): Feed {
  const candidates = (state.feeds ?? []).filter((candidate) =>
    candidate.organizationId === principal.organizationId &&
    candidate.kind === 'skills-sh' &&
    (name === undefined || candidate.name === name),
  );
  const enabledCandidates = candidates.filter((candidate) => candidate.enabled);
  if (name === undefined && enabledCandidates.length > 1) {
    throw new RegistryApiError('FEED_REQUIRED', 'Multiple enabled catalog feeds are configured; specify feed', 409);
  }
  const feed = name === undefined ? enabledCandidates[0] : candidates[0];
  if (!feed) throw new RegistryApiError('FEED_NOT_FOUND', 'The requested feed is not configured', 404);
  if (!feed.enabled) throw new RegistryApiError('FEED_DISABLED', 'The requested feed is disabled', 409);
  assertTrustedFeedBaseUrl(feed, config);
  if (!canReadNamespace(principal, feedNamespace(feed))) throw new RegistryApiError('FORBIDDEN', 'Feed namespace denied', 403);
  return feed;
}

function feedNamespace(feed: Feed): string {
  return feed.namespace ?? `@${feed.name}`;
}

function feedAsUpstream(feed: Feed): Upstream {
  return {
    id: feed.id,
    organizationId: feed.organizationId,
    name: feed.name,
    kind: feed.kind,
    enabled: feed.enabled,
    repositories: feed.repositories === undefined ? ['*'] : [...feed.repositories],
    baseUrl: feed.baseUrl,
    credentialEnv: feed.credentialEnv,
    namespace: feedNamespace(feed),
    configRevision: feed.configRevision,
  };
}

function assertTrustedFeedBaseUrl(feed: Feed, config: Required<RegistryConfiguration>): void {
  if (!isTrustedFeedBaseUrl(feed.baseUrl, config)) {
    throw new RegistryApiError('FEED_UNTRUSTED', 'The configured catalog feed endpoint is not operator-trusted', 503, { retryable: false });
  }
}

function isTrustedFeedBaseUrl(value: string | undefined, config: Required<RegistryConfiguration>): boolean {
  if (!value) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  const normalized = parsed.toString().replace(/\/$/u, '');
  const loopbackTest = config.allowLoopbackUpstreams === true && parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname);
  return config.trustedSkillsShBaseUrls.includes(normalized) || loopbackTest;
}

/**
 * Legacy skills.sh upstreams predate feed records and may omit baseUrl. Keep
 * that documented canonical default while normalizing the exact path handed
 * to the directory-client factory.
 */
function skillsShDirectoryBaseUrl(upstream: Upstream): string {
  const raw = upstream.baseUrl?.trim() || 'https://skills.sh';
  try {
    return new URL(raw).toString().replace(/\/$/u, '');
  } catch {
    return raw;
  }
}

function isTrustedSkillsShBaseUrl(upstream: Upstream, config: Required<RegistryConfiguration>): boolean {
  return isTrustedFeedBaseUrl(skillsShDirectoryBaseUrl(upstream), config);
}

type TransparentCachedResult =
  | { status: 202; job: Job }
  | { status: 200; job: Job; resolution: Resolution };

function findTransparentCachedResult(
  state: RegistryState,
  externalId: string,
  upstream: Upstream,
  principal: Principal,
  config: Required<RegistryConfiguration>,
): TransparentCachedResult | undefined {
  if (!isTrustedFeedBaseUrl(upstream.baseUrl, config)) return undefined;
  const candidates = state.jobs
    .filter((job) => {
      if (job.organizationId !== principal.organizationId || job.kind !== 'import') return false;
      const request = job.import;
      return !!request &&
        request.externalId === externalId &&
        request.path === externalId &&
        request.upstreamId === upstream.id &&
        request.feedId === upstream.id &&
        request.feedName === upstream.name &&
        request.feedConfigRevision === upstream.configRevision &&
        !!job.upstream &&
        sameUpstreamOrigin(job.upstream, upstream) &&
        upstreamAllowsImport(upstream, request.repository) &&
        canReadNamespace(principal, request.name);
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));

  for (const job of candidates) {
    if (job.state === 'queued' || job.state === 'running') return { status: 202, job };
    if (job.state !== 'completed' || !job.resourceId || !job.import) continue;
    const skill = state.skills.find((candidate) => candidate.id === job.resourceId);
    if (!skill || !canReadNamespace(principal, skill.name)) continue;
    if (skill.state === 'pending') {
      const scanJob = state.jobs.find((candidate) =>
        candidate.organizationId === principal.organizationId &&
        candidate.kind === 'scan' &&
        candidate.resourceId === skill.id &&
        (candidate.state === 'queued' || candidate.state === 'running'),
      );
      if (scanJob) return { status: 202, job: scanJob };
    }
    if (!skillCurrentlyApproved(state, skill)) continue;
    if (!importProvenanceMatches(skill, job.import, upstream)) continue;
    return { status: 200, job, resolution: skillResolution(skill) };
  }
  return undefined;
}

function transparentProxyResponse(result: TransparentCachedResult | ImportResolutionResult, feed: Feed, externalId: string): Response {
  const skill = result.status === 200 ? result.resolution.members[0] : undefined;
  const source = skill ? canonicalSourceFromSkill(skill) : undefined;
  const common = {
    feed: feed.name,
    externalId,
    ...(source ? { reference: sourceReferenceFromCanonical(source), source: canonicalSourceDto(source) } : {}),
  };
  if (result.status === 200) return jsonResponse({ ...common, resolution: result.resolution }, 200);
  return jsonResponse({ ...common, operation: result.job }, 202);
}

async function transparentManagedName(namespace: string, externalId: string): Promise<string> {
  const digest = await digestBytes(new TextEncoder().encode(`skills.sh:${externalId}`));
  // Keep the internal name valid and bounded while retaining the full external
  // identity in the operation and provenance returned to callers.
  return `${namespace}/skills-sh-${digest.slice('sha256:'.length, 'sha256:'.length + 48)}`;
}

async function queueTransparentImport(
  template: TransparentImportTemplate,
  feed: Feed,
  refresh: boolean,
  principal: Principal,
  deps: RegistryDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
): Promise<TransparentCachedResult> {
  const state = await readState(deps.repository, config.organizationId);
  const configuredFeed = (state.feeds ?? []).find((candidate) => candidate.id === feed.id);
  if (!configuredFeed || configuredFeed.name !== feed.name || !configuredFeed.enabled) {
    throw new RegistryApiError('PROVENANCE_CONFLICT', 'The feed configuration changed while this import was being resolved', 409);
  }
  const upstream = feedAsUpstream(configuredFeed);
  return await deps.repository.transaction(config.organizationId, (mutableState) => {
    const mutable = ensureState(mutableState, state.policy);
    const currentFeed = (mutable.feeds ?? []).find((candidate) => candidate.id === feed.id);
    if (!currentFeed || currentFeed.name !== feed.name || !currentFeed.enabled || !canReadNamespace(principal, feedNamespace(currentFeed))) {
      throw new RegistryApiError('PROVENANCE_CONFLICT', 'The feed configuration changed while this import was being resolved', 409);
    }
    assertTrustedFeedBaseUrl(currentFeed, config);
    const currentUpstream = feedAsUpstream(currentFeed);
    if (!sameUpstreamOrigin(currentUpstream, upstream)) {
      throw new RegistryApiError('PROVENANCE_CONFLICT', 'The upstream mapping changed while this import was being resolved', 409);
    }
    const candidates = mutable.jobs
      .filter((job) => {
        if (job.organizationId !== config.organizationId || job.kind !== 'import') return false;
        const request = job.import;
        return !!request &&
          request.externalId === template.externalId &&
          request.path === template.path &&
          request.upstreamId === template.upstreamId &&
          request.feedId === template.feedId &&
          request.feedName === template.feedName &&
          request.feedConfigRevision === template.feedConfigRevision &&
          request.repository === template.repository &&
          request.externalSourceType === template.externalSourceType &&
          request.externalSnapshotHash === template.externalSnapshotHash &&
          !!job.upstream &&
          sameUpstreamOrigin(job.upstream, currentUpstream);
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));

    const active = candidates.find((job) => job.state === 'queued' || job.state === 'running');
    if (active) return { status: 202 as const, job: active };

    for (const candidate of candidates) {
      if (candidate.state !== 'completed' || !candidate.resourceId || !candidate.import) continue;
      const skill = mutable.skills.find((value) => value.id === candidate.resourceId);
      if (!skill || !skillCurrentlyApproved(mutable, skill)) {
        const scanJob = skill && mutable.jobs.find((job) =>
          job.organizationId === config.organizationId &&
          job.kind === 'scan' &&
          job.resourceId === skill.id &&
          (job.state === 'queued' || job.state === 'running'),
        );
        if (scanJob) return { status: 202 as const, job: scanJob };
        continue;
      }
      if (importProvenanceMatches(skill, candidate.import, currentUpstream)) {
        // A non-null catalog hash is immutable evidence for this revision. A
        // null hash is deliberately not enough to satisfy an explicit refresh.
        if (!refresh || template.externalSnapshotHash !== null) {
          return { status: 200 as const, job: candidate, resolution: skillResolution(skill) };
        }
      }
    }

    const version = generatedTransparentVersion();
    const importRequest: ImportRequest = { ...template, version };
    const job: Job = {
      id: randomId('job'),
      organizationId: config.organizationId,
      kind: 'import',
      state: 'queued',
      policyRevision: mutable.policy.revision,
      policy: clonePolicy(mutable.policy),
      import: importRequest,
      upstream: currentUpstream,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      attempts: 0,
    };
    mutable.jobs.push(job);
    appendAudit(mutable, audit(principal, 'skill.proxy.queued', job.id, {
      externalId: template.externalId,
      feed: template.feedName,
      feedId: template.feedId,
      feedConfigRevision: template.feedConfigRevision,
      upstreamId: template.upstreamId,
      version,
      refresh,
      requestId,
    }, config.organizationId));
    return { status: 202 as const, job };
  });
}

function generatedTransparentVersion(): string {
  const suffix = randomId('revision').replace(/[^0-9A-Za-z-]/gu, '').toLowerCase().slice(-40);
  return `0.0.0+skills-sh.${suffix || 'revision'}`;
}

type ImportResolutionResult =
  | { status: 202; job: Job }
  | { status: 200; job: Job; resolution: Resolution };

/**
 * Validate a pull-through request and atomically join/cache/queue it.  The
 * cache identity is organization-scoped and includes every caller-selected
 * source field.  The durable job also retains an immutable upstream snapshot;
 * a later mapping change cannot turn a warm hit into a different origin.
 */
async function resolveOrQueueImport(
  body: JsonObject,
  principal: Principal,
  deps: RegistryDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
): Promise<ImportResolutionResult> {
  const importRequest = parseImportRequest(body);
  if (!canPublishName(principal, importRequest.name)) {
    throw new RegistryApiError('FORBIDDEN', 'Namespace publish denied', 403);
  }

  const state = await readState(deps.repository, config.organizationId);
  const upstream = findImportUpstream(state, importRequest, principal);
  // skills.sh IDs are catalog identities rather than arbitrary relative
  // source paths. Validate them with the same bounded, Unicode-safe rules as
  // the directory routes before entering the transaction or any worker fetch.
  if (upstream.kind === 'skills-sh') requireDirectoryId(importRequest.path);
  const cacheKey = importCacheKey(config.organizationId, importRequest);

  return await deps.repository.transaction(config.organizationId, (mutableState) => {
    const mutable = ensureState(mutableState, state.policy);
    const currentUpstream = findImportUpstream(mutable, importRequest, principal);
    if (!sameUpstreamOrigin(currentUpstream, upstream)) {
      throw new RegistryApiError(
        'PROVENANCE_CONFLICT',
        'The upstream mapping changed while this import was being resolved',
        409,
      );
    }

    const sameSource = (candidate: ImportRequest | undefined): boolean =>
      !!candidate && importRequestsMatch(candidate, importRequest);
    const sameJobSource = (candidate: Job): boolean =>
      candidate.organizationId === config.organizationId &&
      candidate.kind === 'import' &&
      sameSource(candidate.import) &&
      !!candidate.upstream &&
      sameUpstreamOrigin(candidate.upstream, currentUpstream);

    const activeTargets = mutable.jobs.filter((candidate) =>
      (candidate.state === 'queued' || candidate.state === 'running') &&
      candidate.kind === 'import' &&
      candidate.import?.name === importRequest.name &&
      candidate.import.version === importRequest.version,
    );
    if (activeTargets.length > 0) {
      const activeTarget = activeTargets.find((candidate) => sameJobSource(candidate));
      if (activeTarget && activeTargets.every((candidate) => sameJobSource(candidate))) {
        appendAudit(mutable, audit(principal, 'skill.import.joined', activeTarget.id, {
          cacheKey,
          upstreamId: importRequest.upstreamId,
          name: importRequest.name,
          version: importRequest.version,
          requestId,
        }, config.organizationId));
        return { job: activeTarget, status: 202 as const };
      }
      throw new RegistryApiError(
        'PROVENANCE_CONFLICT',
        'That skill version is already being imported from another source',
        409,
      );
    }

    const existingSkill = mutable.skills.find(
      (skill) => skill.organizationId === config.organizationId && skill.name === importRequest.name && skill.version === importRequest.version,
    );
    const completedTarget = mutable.jobs.find((candidate) =>
      candidate.state === 'completed' &&
      sameJobSource(candidate) &&
      candidate.resourceId === existingSkill?.id,
    );

    if (existingSkill) {
      if (
        completedTarget &&
        importProvenanceMatches(existingSkill, importRequest, currentUpstream) &&
        skillCurrentlyApproved(mutable, existingSkill)
      ) {
        const resolution = skillResolution(existingSkill);
        appendAudit(mutable, audit(principal, 'skill.import.cache-hit', completedTarget.id, {
          cacheKey,
          upstreamId: importRequest.upstreamId,
          name: importRequest.name,
          version: importRequest.version,
          digest: existingSkill.artifact.digest,
          requestId,
        }, config.organizationId));
        return { job: completedTarget, resolution, status: 200 as const };
      }
      // A name/version is immutable.  This also catches an imported artifact
      // whose worker-reported provenance no longer agrees with its request.
      throw new RegistryApiError(
        'PROVENANCE_CONFLICT',
        'That skill version is already bound to a different source or state',
        409,
      );
    }

    // A completed import without its corresponding skill is an inconsistent
    // durable state.  Do not silently fetch the source a second time.
    const completedWithoutSkill = mutable.jobs.find((candidate) =>
      candidate.state === 'completed' && sameJobSource(candidate) && !candidate.resourceId,
    );
    if (completedWithoutSkill) {
      throw new RegistryApiError(
        'PROVENANCE_CONFLICT',
        'The source import completed without an immutable release',
        409,
      );
    }

    const job: Job = {
      id: randomId('job'),
      organizationId: config.organizationId,
      kind: 'import',
      state: 'queued',
      policyRevision: mutable.policy.revision,
      policy: clonePolicy(mutable.policy),
      import: importRequest,
      upstream: currentUpstream,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      attempts: 0,
    };
    mutable.jobs.push(job);
    appendAudit(mutable, audit(principal, 'skill.import.queued', job.id, {
      cacheKey,
      upstreamId: importRequest.upstreamId,
      name: importRequest.name,
      version: importRequest.version,
      requestId,
    }, config.organizationId));
    return { job, status: 202 as const };
  });
}

function parseImportRequest(body: JsonObject): ImportRequest {
  const upstreamId = stringValue(body.upstreamId);
  const path = stringValue(body.path);
  const name = requireSkillName(body.name);
  const version = requireVersion(body.version);
  if (
    !upstreamId ||
    !path ||
    path.length > 4096 ||
    path.startsWith('/') ||
    path.endsWith('/') ||
    path.includes('\\') ||
    path.includes('\u0000') ||
    /[\u0001-\u001f\u007f]/u.test(path) ||
    path.split('/').some((part) => part.length === 0 || part === '..' || part === '.')
  ) {
    throw new RegistryApiError('INVALID_IMPORT', 'upstreamId and a safe relative path are required', 400);
  }
  const repository = optionalImportField(body.repository, 'repository');
  const ref = optionalImportField(body.ref, 'ref');
  const externalId = optionalImportField(body.externalId, 'externalId');
  const externalSourceType = body.externalSourceType === undefined || body.externalSourceType === null || body.externalSourceType === ''
    ? undefined
    : body.externalSourceType;
  if (externalSourceType !== undefined && externalSourceType !== 'github' && externalSourceType !== 'well-known') {
    throw new RegistryApiError('INVALID_IMPORT', 'externalSourceType is invalid', 400);
  }
  const externalSnapshotHash = parseExternalSnapshotHash(body.externalSnapshotHash);
  if (externalId !== undefined && externalId !== path) {
    throw new RegistryApiError('INVALID_IMPORT', 'externalId must match path', 400);
  }
  return {
    upstreamId,
    repository,
    path,
    ref,
    name,
    version,
    ...(externalId ? { externalId } : {}),
    ...(externalSourceType !== undefined ? { externalSourceType: externalSourceType as ImportRequest['externalSourceType'] } : {}),
    ...(externalSnapshotHash !== undefined ? { externalSnapshotHash } : {}),
  };
}

function parseExternalSnapshotHash(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new RegistryApiError('INVALID_IMPORT', 'externalSnapshotHash is invalid', 400);
  }
  return value;
}

function optionalImportField(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new RegistryApiError('INVALID_IMPORT', `${field} is invalid`, 400);
  }
  return value;
}

function findImportUpstream(
  state: RegistryState,
  request: ImportRequest,
  principal: Principal,
): Upstream {
  // Keep this lookup explicit rather than accepting a caller-provided upstream
  // object.  `readState`/`ensureState` already enforce the organization, and
  // the route only receives the immutable upstream ID from the request.
  const selected = state.upstreams.find((candidate) =>
    candidate.organizationId === principal.organizationId &&
    candidate.id === request.upstreamId &&
    candidate.enabled,
  );
  if (
    !selected ||
    !canReadNamespace(principal, selected.namespace) ||
    !upstreamAllowsImport(selected, request.repository) ||
    (selected.kind === 'skills-sh' && (!request.externalId || request.externalId !== request.path))
  ) {
    throw unavailable();
  }
  return selected;
}

function upstreamAllowsImport(upstream: Upstream, repository: string | undefined): boolean {
  if (upstream.kind === 'skills-sh') {
    const allowlist = upstream.repositories;
    if (!allowlist || allowlist.length === 0) return false;
    if (repository === undefined) return allowlist.length === 1;
    const normalized = normalizeSkillsDirectorySource(repository);
    return allowlist.some((candidate) => candidate === '*' || normalizeSkillsDirectorySource(candidate) === normalized);
  }
  if (upstream.kind !== 'github') return true;
  const allowlist = upstream.repositories;
  if (!allowlist || allowlist.length === 0) return false;
  if (repository === undefined) return allowlist.length === 1;
  const normalized = repository.trim().toLocaleLowerCase('en-US').replace(/^https?:\/\/github\.com\//u, '').replace(/^github\.com\//u, '').replace(/^\/+|\/+$/gu, '').replace(/\.git$/iu, '');
  return allowlist.some((candidate) => candidate.trim().toLocaleLowerCase('en-US').replace(/^https?:\/\/github\.com\//u, '').replace(/^github\.com\//u, '').replace(/^\/+|\/+$/gu, '').replace(/\.git$/iu, '') === normalized);
}

function normalizeSkillsDirectorySource(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/^https?:\/\/(?:www\.)?skills\.sh\//u, '')
    .replace(/^https?:\/\/(?:www\.)?github\.com\//u, '')
    .replace(/^github\.com\//u, '')
    .replace(/^\/+|\/+$/gu, '')
    .replace(/\.git$/iu, '');
}

function importCacheKey(organizationId: string, request: ImportRequest): string {
  return stableStringify({
    organizationId,
    upstreamId: request.upstreamId,
    path: request.path,
    ref: request.ref ?? null,
    name: request.name,
    version: request.version,
    repository: request.repository ?? null,
    externalId: request.externalId ?? null,
    externalSourceType: request.externalSourceType ?? null,
    externalSnapshotHash: request.externalSnapshotHash ?? null,
    feedId: request.feedId ?? null,
    feedName: request.feedName ?? null,
    feedConfigRevision: request.feedConfigRevision ?? null,
    sourceReference: request.sourceReference ?? null,
  });
}

function importRequestsMatch(left: ImportRequest, right: ImportRequest): boolean {
  return importCacheKey('__request__', left) === importCacheKey('__request__', right);
}

function sameUpstreamOrigin(left: Upstream, right: Upstream): boolean {
  return stableStringify({
    id: left.id,
    name: left.name,
    kind: left.kind,
    namespace: left.namespace,
    baseUrl: left.baseUrl ?? null,
    credentialEnv: left.credentialEnv ?? null,
    repositories: [...(left.repositories ?? [])].sort(),
    configRevision: left.configRevision ?? null,
    // skills.sh mappings are identity-bearing policy, so a change cannot
    // turn an existing warm resolution into a different origin.
  }) === stableStringify({
    id: right.id,
    name: right.name,
    kind: right.kind,
    namespace: right.namespace,
    baseUrl: right.baseUrl ?? null,
    credentialEnv: right.credentialEnv ?? null,
    repositories: [...(right.repositories ?? [])].sort(),
    configRevision: right.configRevision ?? null,
  });
}

function importProvenanceMatches(skill: SkillVersion, request: ImportRequest, upstream: Upstream): boolean {
  const provenance = skill.provenance;
  if (
    provenance.kind !== upstream.kind ||
    provenance.upstreamId !== upstream.id ||
    provenance.upstreamId !== request.upstreamId ||
    provenance.path !== request.path ||
    !provenance.repository ||
    !isValidImportRevision(upstream, provenance.revision, request.externalSnapshotHash)
  ) {
    return false;
  }
  if (request.repository !== undefined && provenance.repository !== request.repository) return false;
  if (!provenanceRepositoryMatches(upstream, provenance.repository)) return false;
  if (request.feedId !== undefined && provenance.feedId !== request.feedId) return false;
  if (request.feedName !== undefined && provenance.feedName !== request.feedName) return false;
  if (request.feedConfigRevision !== undefined && provenance.feedConfigRevision !== request.feedConfigRevision) return false;
  if (request.sourceReference !== undefined && provenance.sourceReference !== request.sourceReference) return false;
  if (upstream.kind === 'skills-sh') {
    if (!request.externalId || provenance.externalId !== request.externalId || provenance.path !== request.externalId) return false;
    if (request.externalSourceType !== undefined && provenance.externalSourceType !== request.externalSourceType) return false;
    if (request.externalSnapshotHash !== undefined && provenance.externalSnapshotHash !== request.externalSnapshotHash) return false;
    if (!isValidSkillsShRevision(provenance.revision, request.externalSnapshotHash)) return false;
    if (provenance.external) {
      if (
        provenance.external.provider !== 'skills.sh' ||
        provenance.external.externalId !== request.externalId ||
        provenance.external.source !== provenance.repository ||
        provenance.external.externalId !== `${provenance.external.source}/${provenance.external.slug}` ||
        provenance.external.externalSnapshotHash !== (provenance.externalSnapshotHash ?? null) ||
        (provenance.externalSourceType !== undefined && provenance.external.sourceType !== provenance.externalSourceType)
      ) return false;
    }
  }
  if (provenance.sourceDigest !== undefined && (!isDigest(provenance.sourceDigest) || provenance.sourceDigest !== skill.artifact.digest)) return false;
  return true;
}

function skillResolution(skill: SkillVersion): Resolution {
  return {
    kind: 'skill',
    resourceId: skill.id,
    organizationId: skill.organizationId,
    name: skill.name,
    version: skill.version,
    digest: skill.artifact.digest,
    members: [skill],
  };
}

async function handleJobsRoute(
  method: HttpMethod,
  segments: string[],
  request: Request,
  principal: Principal,
  deps: RegistryDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
): Promise<Response> {
  requireWorker(principal);
  if (segments.length === 4 && segments[3] === 'artifact') {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    return await serveJobArtifact(decodePathPart(segments[2]), request, deps, config, requestId);
  }
  if (segments.length === 3 && segments[2] === 'claim') {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    return await claimJob(principal, deps, config, requestId);
  }
  if (segments.length === 4 && segments[3] === 'complete') {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    const body = await readJson(request, config.maxBodyBytes);
    const headerToken = request.headers.get('x-worker-fencing-token') || undefined;
    const bodyToken = stringValue(body.fencingToken) || stringValue(body.leaseToken);
    if (headerToken && bodyToken && headerToken !== bodyToken) {
      throw new RegistryApiError('LEASE_FENCED', 'Worker fencing token does not match the request body', 409);
    }
    if (headerToken || bodyToken) body.leaseToken = headerToken || bodyToken;
    return await completeJob(decodePathPart(segments[2]), body, principal, deps, config, requestId);
  }
  throw new RegistryApiError('NOT_FOUND', 'Route not found', 404);
}

async function claimJob(
  principal: Principal,
  deps: RegistryDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
): Promise<Response> {
  const now = Date.now();
  const result = await deps.repository.transaction(config.organizationId, (mutableState) => {
    const mutable = ensureState(mutableState, defaultPolicy());
    const candidate = mutable.jobs.find((job) => {
      if (job.organizationId !== config.organizationId) return false;
      if (job.state === 'queued') return true;
      return job.state === 'running' && timestampExpired(job.leaseExpiresAt, now);
    });
    if (!candidate) return null;
    candidate.state = 'running';
    candidate.attempts = (candidate.attempts || 0) + 1;
    candidate.leaseToken = randomId('lease');
    candidate.leaseExpiresAt = new Date(now + config.leaseSeconds * 1000).toISOString();
    candidate.updatedAt = new Date(now).toISOString();
    appendAudit(mutable, audit(principal, 'job.claim', candidate.id, {
      attempt: candidate.attempts,
      requestId,
    }, config.organizationId));
    return serializeJobForWorker(candidate);
  });
  return jsonResponse({ job: result });
}

async function serveJobArtifact(
  id: string,
  request: Request,
  deps: RegistryDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
): Promise<Response> {
  const token = request.headers.get('x-worker-fencing-token');
  const requestedDigest = request.headers.get('x-artifact-digest');
  if (!token || !requestedDigest || !isDigest(requestedDigest)) {
    throw new RegistryApiError('INVALID_LEASE', 'Worker fencing and artifact digest headers are required', 400);
  }
  const state = await readState(deps.repository, config.organizationId);
  const job = state.jobs.find((candidate) => candidate.id === id);
  if (!job) throw unavailable();
  if (job.state !== 'running' || job.leaseToken !== token) {
    throw new RegistryApiError('LEASE_FENCED', 'Job lease is no longer current', 409);
  }
  if (timestampExpired(job.leaseExpiresAt)) {
    throw new RegistryApiError('LEASE_EXPIRED', 'Job lease has expired', 409, { retryable: true });
  }
  if (!job.artifact || job.artifact.digest !== requestedDigest) {
    throw new RegistryApiError('DIGEST_MISMATCH', 'Requested artifact does not match the job', 409);
  }
  let bytes: Uint8Array;
  try {
    bytes = await deps.blobs.get(job.artifact.key);
  } catch {
    throw new RegistryApiError('ARTIFACT_UNAVAILABLE', 'Artifact is temporarily unavailable', 503, { retryable: true });
  }
  const actualDigest = await digestBytes(bytes);
  if (actualDigest !== job.artifact.digest || bytes.byteLength !== job.artifact.size) {
    throw new RegistryApiError('DIGEST_MISMATCH', 'Stored artifact digest does not match the job', 409, {
      details: { requestId },
    });
  }
  return new Response(bytes as BodyInit, {
    status: 200,
    headers: {
      'cache-control': 'private, no-store',
      'content-type': 'application/octet-stream',
      'content-length': String(bytes.byteLength),
      'x-artifact-digest': job.artifact.digest,
    },
  });
}

function serializeJobForWorker(
  job: Job,
): Job & { fencingToken?: string; artifactDigest?: Digest; attempt?: number; expiresAt?: string } {
  return {
    ...job,
    fencingToken: job.leaseToken,
    artifactDigest: job.artifact?.digest,
    attempt: job.attempts,
    expiresAt: job.leaseExpiresAt,
  };
}

async function completeJob(
  id: string,
  body: JsonObject,
  principal: Principal,
  deps: RegistryDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
): Promise<Response> {
  const completionNow = Date.now();
  const leaseToken = stringValue(body.leaseToken);
  if (!leaseToken) throw new RegistryApiError('INVALID_LEASE', 'leaseToken is required', 400);
  const state = await readState(deps.repository, config.organizationId);
  const job = state.jobs.find((candidate) => candidate.id === id);
  if (!job) throw unavailable();
  const requestedDigest = stringValue(body.artifactDigest);
  // Scan jobs already carry an immutable artifact. Import jobs only acquire
  // and canonicalize their artifact during completion, so their digest is
  // checked immediately after the bundle has been validated below.
  if (requestedDigest && job.artifact && requestedDigest !== job.artifact.digest) {
    throw new RegistryApiError('DIGEST_MISMATCH', 'Completion artifact digest does not match the job', 409);
  }
  if (job.state !== 'running' || job.leaseToken !== leaseToken) {
    throw new RegistryApiError('LEASE_FENCED', 'Job lease is no longer current', 409);
  }
  if (timestampExpired(job.leaseExpiresAt)) {
    throw new RegistryApiError('LEASE_EXPIRED', 'Job lease has expired', 409, { retryable: true });
  }
  if (body.error !== undefined && typeof body.error !== 'string') throw new RegistryApiError('INVALID_JOB_RESULT', 'error must be a string', 400);
  if (job.kind === 'import' && !body.error) {
    validateOpenClawJobFeed(job, completionNow);
  }

  let imported: { bundle: SkillBundle; bytes: Uint8Array; stored: StoredBlob; digest: Digest; metadata: { skillName?: string; description?: string } } | undefined;
  if (job.kind === 'import' && !body.error) {
    if (!isObject(body.bundle)) throw new RegistryApiError('INVALID_JOB_RESULT', 'An import completion requires a bundle', 400);
    try {
      const bundle = validateBundle(body.bundle) as SkillBundle;
      const bytes = encodeBundle(bundle);
      const digest = await digestBytes(bytes);
      const stored = await putVerifiedBlob(deps, bytes, digest);
      const metadata = parseSkillMetadata(bundle) as { skillName?: string; description?: string };
      if (requestedDigest && requestedDigest !== digest) {
        throw new RegistryApiError('DIGEST_MISMATCH', 'Completion artifact digest does not match the imported bundle', 409);
      }
      imported = { bundle, bytes, stored, digest, metadata };
    } catch (error) {
      throw bundleError(error);
    }
  }

  const rawScanResults = body.scanResults;
  let scanResults: ScanResult[] = [];
  if (!body.error && rawScanResults !== undefined) {
    if (!Array.isArray(rawScanResults)) throw new RegistryApiError('INVALID_SCAN_RESULT', 'scanResults must be an array', 400);
    const expectedDigest = imported?.digest || job.artifact?.digest;
    if (!expectedDigest) throw new RegistryApiError('INVALID_SCAN_RESULT', 'Scan evidence is missing an artifact digest', 400);
    scanResults = rawScanResults.map((value) => parseScanResult(value, job, config.organizationId, expectedDigest));
    const scannerIds = new Set(scanResults.map((scan) => scan.scannerId));
    if (scannerIds.size !== scanResults.length) throw new RegistryApiError('INVALID_SCAN_RESULT', 'A scanner may return only one result per job', 400);
    const resultIds = new Set(scanResults.map((scan) => scan.id));
    if (resultIds.size !== scanResults.length) throw new RegistryApiError('INVALID_SCAN_RESULT', 'Scan result ids must be unique', 400);
  }

  const result = await deps.repository.transaction(config.organizationId, (mutableState) => {
    const mutable = ensureState(mutableState, state.policy);
    const currentJob = mutable.jobs.find((candidate) => candidate.id === id);
    if (!currentJob || currentJob.state !== 'running' || currentJob.leaseToken !== leaseToken || timestampExpired(currentJob.leaseExpiresAt)) {
      throw new RegistryApiError('LEASE_FENCED', 'Job lease is no longer current', 409);
    }
    if (mutable.policy.revision !== currentJob.policyRevision) {
      currentJob.state = 'queued';
      currentJob.policy = clonePolicy(mutable.policy);
      currentJob.policyRevision = mutable.policy.revision;
      currentJob.updatedAt = nowIso();
      currentJob.leaseToken = undefined;
      currentJob.leaseExpiresAt = undefined;
      if (currentJob.resourceId) {
        const staleSkill = mutable.skills.find((candidate) => candidate.id === currentJob.resourceId);
        if (staleSkill && staleSkill.state !== 'revoked') {
          staleSkill.state = 'pending';
          staleSkill.policyRevision = mutable.policy.revision;
        }
      }
      appendAudit(mutable, audit(principal, 'job.requeue.policy-changed', id, { requestId }, config.organizationId));
      return currentJob;
    }
    if (currentJob.kind === 'import' && !body.error) {
      validateOpenClawJobFeed(currentJob, Date.now());
    }
    if (typeof body.error === 'string' && body.error.length > 0) {
      currentJob.state = 'failed';
      currentJob.error = redactJobError(body.error);
      currentJob.updatedAt = nowIso();
      if (currentJob.resourceId) {
        const skill = mutable.skills.find((candidate) => candidate.id === currentJob.resourceId);
        if (skill && skill.state !== 'revoked') skill.state = 'scan-error';
      }
      appendAudit(mutable, audit(principal, 'job.complete.failed', id, {
        requestId,
      }, config.organizationId));
      return currentJob;
    }

    if (currentJob.kind === 'scan') {
      const skill = currentJob.resourceId ? mutable.skills.find((candidate) => candidate.id === currentJob.resourceId) : undefined;
      if (!skill) throw new RegistryApiError('NOT_AVAILABLE', 'Job resource is unavailable', 404);
      if (!currentJob.artifact || skill.artifact.digest !== currentJob.artifact.digest) throw new RegistryApiError('DIGEST_MISMATCH', 'Job artifact changed', 409);
      const evaluation = evaluatePolicy(currentJob.policy, scanResults, currentJob.artifact.digest);
      mutable.scans.push(...scanResults);
      skill.scanIds = [...new Set([...skill.scanIds, ...scanResults.map((scan) => scan.id)])];
      if (skill.state !== 'revoked') skill.state = evaluation.state;
      skill.policyRevision = currentJob.policyRevision;
      if (evaluation.state === 'approved') skill.approvedAt = nowIso();
      currentJob.state = 'completed';
      currentJob.updatedAt = nowIso();
      currentJob.leaseToken = undefined;
      currentJob.leaseExpiresAt = undefined;
      if (evaluation.error) currentJob.error = evaluation.error;
      appendAudit(mutable, audit(principal, `job.complete.${evaluation.state}`, id, {
        resourceId: skill.id,
        digest: skill.artifact.digest,
        scanCount: scanResults.length,
        requestId,
      }, config.organizationId));
      return currentJob;
    }

    if (!currentJob.import || !imported) throw new RegistryApiError('INVALID_JOB_RESULT', 'Import result is incomplete', 400);
    const request = currentJob.import;
    if (mutable.skills.some((skill) => skill.name === request.name && skill.version === request.version)) {
      throw new RegistryApiError('VERSION_CONFLICT', 'That skill version already exists', 409);
    }
    const evaluation = evaluatePolicy(currentJob.policy, scanResults, imported.digest);
    const skill: SkillVersion = {
      id: randomId('skill'),
      organizationId: config.organizationId,
      name: request.name,
      skillName: normalizeSkillName(imported.metadata.skillName) || request.name.slice(request.name.indexOf('/') + 1),
      version: request.version,
      description: stringValue(imported.metadata.description) || '',
      artifact: imported.stored,
      state: evaluation.state,
      policyRevision: currentJob.policyRevision,
      createdAt: nowIso(),
      approvedAt: evaluation.state === 'approved' ? nowIso() : undefined,
      provenance: normalizeProvenance(body.provenance, request, imported.digest, currentJob.upstream),
      fileCount: imported.bundle.files.length,
      scanIds: scanResults.map((scan) => scan.id),
    };
    mutable.skills.push(skill);
    mutable.scans.push(...scanResults);
    currentJob.resourceId = skill.id;
    currentJob.artifact = imported.stored;
    currentJob.state = 'completed';
    currentJob.updatedAt = nowIso();
    currentJob.leaseToken = undefined;
    currentJob.leaseExpiresAt = undefined;
    if (evaluation.error) currentJob.error = evaluation.error;
    appendAudit(mutable, audit(principal, `job.complete.${evaluation.state}`, id, {
      resourceId: skill.id,
      digest: imported.digest,
      scanCount: scanResults.length,
      requestId,
    }, config.organizationId));
    return currentJob;
  });
  const recordSourceProof = (deps as RegistryHandlerDependencies).openClaw?.recordSourceProof;
  if (recordSourceProof && result.kind === 'import' && result.state === 'completed' && result.resourceId && body.error === undefined) {
    const proof = openClawCompletionProof(job, body.provenance, result.artifact?.digest);
    if (proof) {
      // Proof persistence is deliberately a separate adapter transaction. A
      // failure leaves the approved release intact but unavailable to the
      // OpenClaw publication provider; it must never turn a completed import
      // into an implicitly trusted feed entry.
      try {
        await recordSourceProof({
          tenantId: config.organizationId,
          completionJobId: result.id,
          skillId: result.resourceId,
          entry: proof.entry,
          sourceArtifact: proof.sourceArtifact,
        });
      } catch {
        // The next refresh will omit the unrecorded proof and the durable job
        // remains inspectable through the normal operation endpoint.
      }
    }
  }
  return jsonResponse({ operation: result });
}

function parseScanResult(
  raw: unknown,
  job: Job,
  organizationId: string,
  expectedDigest: Digest,
): ScanResult {
  if (!isObject(raw)) throw new RegistryApiError('INVALID_SCAN_RESULT', 'Each scan result must be an object', 400);
  const status = raw.status;
  if (typeof status !== 'string' || !SCAN_STATUSES.has(status as ScanResult['status'])) {
    throw new RegistryApiError('INVALID_SCAN_RESULT', 'Unknown scanner result status', 400);
  }
  const scannerId = raw.scannerId;
  if (typeof scannerId !== 'string' || !SUPPORTED_SCANNERS.includes(scannerId as ScannerId)) {
    throw new RegistryApiError('INVALID_SCAN_RESULT', 'Unknown scanner id', 400);
  }
  const digest = stringValue(raw.artifactDigest);
  if (!digest || digest !== expectedDigest || !isDigest(digest)) {
    throw new RegistryApiError('DIGEST_MISMATCH', 'Scan result artifact digest does not match the job', 409);
  }
  if (stringValue(raw.organizationId) !== organizationId || stringValue(raw.jobId) !== job.id) {
    throw new RegistryApiError('INVALID_SCAN_RESULT', 'Scan result is bound to a different job', 400);
  }
  const coverage = raw.coverage;
  if (
    !isObject(coverage) ||
    !nonNegativeInteger(coverage.filesEnumerated) ||
    !nonNegativeInteger(coverage.filesAnalyzed) ||
    !nonNegativeInteger(coverage.filesSkipped) ||
    !nonNegativeInteger(coverage.filesUnsupported) ||
    Number(coverage.filesAnalyzed) + Number(coverage.filesSkipped) + Number(coverage.filesUnsupported) > Number(coverage.filesEnumerated) ||
    !Array.isArray(coverage.limitations) ||
    coverage.limitations.length > 100 ||
    coverage.limitations.some((value) => typeof value !== 'string' || value.length === 0 || value.length > 1024) ||
    !Array.isArray(coverage.externalDestinations) ||
    coverage.externalDestinations.length > 100 ||
    coverage.externalDestinations.some((value) => typeof value !== 'string' || value.length === 0 || value.length > 255)
  ) {
    throw new RegistryApiError('INVALID_SCAN_RESULT', 'Scan result coverage is invalid', 400);
  }
  if (!Array.isArray(raw.findings)) throw new RegistryApiError('INVALID_SCAN_RESULT', 'Scan result findings must be an array', 400);
  if (raw.findings.length > 10_000) throw new RegistryApiError('INVALID_SCAN_RESULT', 'Scan result contains too many findings', 400);
  const findings = raw.findings.map((finding) => parseFinding(finding));
  const id = stringValue(raw.id);
  const policyRevision = stringValue(raw.policyRevision);
  const engineVersion = stringValue(raw.engineVersion);
  const rulesRevision = stringValue(raw.rulesRevision);
  const configurationHash = stringValue(raw.configurationHash);
  if (!id || !policyRevision || !engineVersion || !rulesRevision || !configurationHash) {
    throw new RegistryApiError('INVALID_SCAN_RESULT', 'Scan result identity is incomplete', 400);
  }
  if ([id, policyRevision, engineVersion, rulesRevision, configurationHash].some((value) => value.length > 256)) {
    throw new RegistryApiError('INVALID_SCAN_RESULT', 'Scan result identity is too long', 400);
  }
  const createdAt = stringValue(raw.createdAt);
  const durationMs = raw.durationMs;
  const createdAtMs = createdAt ? Date.parse(createdAt) : Number.NaN;
  if (
    !createdAt ||
    !Number.isFinite(createdAtMs) ||
    createdAtMs > Date.now() ||
    !nonNegativeInteger(durationMs)
  ) {
    throw new RegistryApiError('INVALID_SCAN_RESULT', 'Scan result timestamp/duration is invalid', 400);
  }
  if (raw.error !== undefined && (typeof raw.error !== 'string' || raw.error.length > 2_048)) {
    throw new RegistryApiError('INVALID_SCAN_RESULT', 'Scan result error is invalid', 400);
  }
  const result: ScanResult = {
    id,
    organizationId,
    jobId: job.id,
    artifactDigest: digest as Digest,
    policyRevision,
    scannerId: scannerId as ScannerId,
    engineVersion,
    rulesRevision,
    configurationHash,
    status: status as ScanResult['status'],
    findings,
    coverage: {
      filesEnumerated: Number(coverage.filesEnumerated),
      filesAnalyzed: Number(coverage.filesAnalyzed),
      filesSkipped: Number(coverage.filesSkipped),
      filesUnsupported: Number(coverage.filesUnsupported),
      limitations: coverage.limitations.filter((value): value is string => typeof value === 'string'),
      externalDestinations: coverage.externalDestinations.filter((value): value is string => typeof value === 'string'),
    },
    createdAt,
    durationMs: Number(durationMs),
    error: stringValue(raw.error) ? redactJobError(stringValue(raw.error)!).slice(0, 2_048) : undefined,
  };
  if (result.policyRevision !== job.policyRevision) throw new RegistryApiError('POLICY_BLOCKED', 'Scan result policy revision is stale', 409);
  return result;
}

function parseFinding(raw: unknown): Finding {
  if (!isObject(raw)) throw new RegistryApiError('INVALID_SCAN_RESULT', 'Finding must be an object', 400);
  const severity = raw.severity;
  if (typeof severity !== 'string' || !SEVERITIES.has(severity as Finding['severity'])) throw new RegistryApiError('INVALID_SCAN_RESULT', 'Finding severity is invalid', 400);
  const ruleId = stringValue(raw.ruleId);
  const fingerprint = stringValue(raw.fingerprint);
  const category = stringValue(raw.category);
  const message = stringValue(raw.message);
  if (!ruleId || !fingerprint || !category || !message) throw new RegistryApiError('INVALID_SCAN_RESULT', 'Finding fields are incomplete', 400);
  if (ruleId.length > 128 || fingerprint.length > 256 || category.length > 128 || message.length > 4_096) throw new RegistryApiError('INVALID_SCAN_RESULT', 'Finding fields are too long', 400);
  if (
    (raw.file !== undefined && (typeof raw.file !== 'string' || raw.file.length === 0 || raw.file.length > 1_024)) ||
    (raw.redactedEvidence !== undefined && (typeof raw.redactedEvidence !== 'string' || raw.redactedEvidence.length > 2_048))
  ) {
    throw new RegistryApiError('INVALID_SCAN_RESULT', 'Finding optional fields are invalid', 400);
  }
  const line = raw.line === undefined ? undefined : raw.line;
  if (line !== undefined && (typeof line !== 'number' || !Number.isInteger(line) || line < 1)) {
    throw new RegistryApiError('INVALID_SCAN_RESULT', 'Finding line is invalid', 400);
  }
  return {
    ruleId,
    fingerprint,
    severity: severity as Finding['severity'],
    category,
    message: redactJobError(message),
    file: stringValue(raw.file)?.slice(0, 1_024),
    line: line as number | undefined,
    redactedEvidence: stringValue(raw.redactedEvidence)?.slice(0, 2_048),
  };
}

function evaluatePolicy(
  policy: Policy,
  results: ScanResult[],
  digest: Digest,
  now = Date.now(),
): { state: DistributionState; error?: string } {
  const scanners = Array.isArray(policy.scanners) ? policy.scanners : [];
  const relevant = results.filter((result) => result.artifactDigest === digest && result.policyRevision === policy.revision);
  const required = scanners.filter((scanner) => scanner.mode === 'required');
  const enabled = scanners.filter((scanner) => scanner.mode !== 'disabled');
  for (const scanner of required) {
    const result = latestScanForScanner(relevant, scanner.id);
    if (!result) return { state: 'scan-error', error: `Required scanner ${scanner.id} did not return evidence` };
    if (result.status !== 'completed') return { state: 'scan-error', error: `Required scanner ${scanner.id} returned ${result.status}` };
    if (evidenceExpired(result, policy.evidenceMaxAgeSeconds, now)) return { state: 'scan-error', error: `Required scanner ${scanner.id} evidence is stale` };
    if (result.coverage.filesEnumerated <= 0 || result.coverage.filesAnalyzed <= 0) return { state: 'scan-error', error: `Required scanner ${scanner.id} did not analyze any files` };
    if (
      result.coverage.filesSkipped > 0 ||
      result.coverage.filesUnsupported > 0 ||
      result.coverage.filesAnalyzed !== result.coverage.filesEnumerated
    ) return { state: 'scan-error', error: `Required scanner ${scanner.id} did not cover every file` };
    if (result.findings.some((finding) => scanner.blockSeverities.includes(finding.severity))) return { state: 'quarantined', error: `Required scanner ${scanner.id} reported a blocking finding` };
  }
  if (required.length > 0) return { state: 'approved' };
  if (enabled.length === 0) {
    return policy.allowUnscanned
      ? { state: 'approved' }
      : { state: 'scan-error', error: 'No scanner evidence is configured and unscanned distribution is disabled' };
  }
  const missingAdvisory = enabled.some((scanner) => !relevant.some((result) => result.scannerId === scanner.id));
  if (missingAdvisory && !policy.allowUnscanned) return { state: 'scan-error', error: 'Scanner evidence is incomplete and unscanned distribution is disabled' };
  for (const scanner of enabled) {
    const result = latestScanForScanner(relevant, scanner.id);
    if (result && result.status === 'completed' && result.findings.some((finding) => scanner.blockSeverities.includes(finding.severity))) {
      // Advisory scanners record findings but do not block distribution.
      continue;
    }
  }
  return { state: 'approved' };
}

function latestScanForScanner(results: ScanResult[], scannerId: ScannerId): ScanResult | undefined {
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const result = results[index];
    if (result?.scannerId === scannerId) return result;
  }
  return undefined;
}

function evidenceExpired(result: ScanResult, maxAgeSeconds: number, now = Date.now()): boolean {
  const createdAt = Date.parse(result.createdAt);
  if (!Number.isFinite(createdAt)) return true;
  if (createdAt > now) return true;
  return maxAgeSeconds >= 0 && now - createdAt > maxAgeSeconds * 1000;
}

function timestampExpired(value: string | undefined, now = Date.now()): boolean {
  if (!value) return true;
  const timestamp = Date.parse(value);
  return !Number.isFinite(timestamp) || timestamp <= now;
}

function normalizeProvenance(
  raw: unknown,
  request: ImportRequest,
  digest: Digest,
  upstream: Upstream | undefined,
): Provenance {
  if (!upstream || !isObject(raw)) {
    throw new RegistryApiError('PROVENANCE_CONFLICT', 'An import completion requires complete provenance', 409);
  }
  if (upstream.id !== request.upstreamId) {
    throw new RegistryApiError('PROVENANCE_CONFLICT', 'Import job provenance is bound to a different upstream', 409);
  }
  const kind = raw.kind;
  const suppliedUpstreamId = stringValue(raw.upstreamId);
  const suppliedRepository = stringValue(raw.repository);
  const suppliedPath = stringValue(raw.path);
  const suppliedRevision = stringValue(raw.revision);
  if (
    !normalizeProvenanceKind(kind) ||
    kind !== upstream.kind ||
    !suppliedUpstreamId ||
    !suppliedRepository ||
    !suppliedPath ||
    !suppliedRevision
  ) {
    throw new RegistryApiError('PROVENANCE_CONFLICT', 'Imported artifact provenance is incomplete or does not match its upstream', 409);
  }
  if (suppliedUpstreamId !== request.upstreamId) {
    throw new RegistryApiError('PROVENANCE_CONFLICT', 'Imported artifact provenance names a different upstream', 409);
  }
  if (suppliedPath !== request.path) {
    throw new RegistryApiError('PROVENANCE_CONFLICT', 'Imported artifact provenance names a different source path', 409);
  }
  if (request.repository !== undefined && suppliedRepository !== request.repository) {
    throw new RegistryApiError('PROVENANCE_CONFLICT', 'Imported artifact provenance names a different repository', 409);
  }
  if (!provenanceRepositoryMatches(upstream, suppliedRepository)) {
    throw new RegistryApiError('PROVENANCE_CONFLICT', 'Imported artifact provenance names an unapproved repository', 409);
  }
  if (!isValidImportRevision(upstream, suppliedRevision, request.externalSnapshotHash)) {
    throw new RegistryApiError('PROVENANCE_CONFLICT', 'Imported artifact provenance is not pinned to a valid immutable revision', 409);
  }
  const suppliedExternalId = stringValue(raw.externalId);
  const suppliedFeedId = optionalProvenanceString(raw.feedId, 'feedId', 256);
  const suppliedFeedName = optionalProvenanceString(raw.feedName, 'feedName', 128);
  const suppliedFeedConfigRevision = optionalProvenanceString(raw.feedConfigRevision, 'feedConfigRevision', 256);
  const suppliedSourceReference = optionalProvenanceString(raw.sourceReference, 'sourceReference', 2_048);
  const suppliedSourceProviderOrigin = optionalProvenanceString(raw.sourceProviderOrigin, 'sourceProviderOrigin', 512);
  const suppliedFetchedAt = optionalCanonicalProvenanceTimestamp(raw.fetchedAt, 'fetchedAt');
  const suppliedExternalDigest = optionalProvenanceString(raw.externalDigest, 'externalDigest', 128);
  if (suppliedExternalDigest !== undefined && !isDigest(suppliedExternalDigest)) {
    throw new RegistryApiError('PROVENANCE_CONFLICT', 'Imported artifact external digest is invalid', 409);
  }
  // OpenClaw GitHub imports carry the immutable commit resolved by the worker.
  // Preserve that verified claim through completion so source-proof recording
  // and publication can bind the public commit version without conflating it
  // with the registry's private SemVer release version.
  const suppliedResolvedCommit = upstream.kind === 'github'
    ? optionalProvenanceString(raw.resolvedCommit, 'resolvedCommit', 128)
    : undefined;
  if (suppliedResolvedCommit !== undefined && !isCommit(suppliedResolvedCommit)) {
    throw new RegistryApiError('PROVENANCE_CONFLICT', 'Imported artifact resolved commit is invalid', 409);
  }
  if (suppliedResolvedCommit !== undefined && suppliedResolvedCommit !== suppliedRevision) {
    throw new RegistryApiError('PROVENANCE_CONFLICT', 'Imported artifact resolved commit does not match its revision', 409);
  }
  const suppliedSourceResolutionKind = raw.sourceResolutionKind === undefined || raw.sourceResolutionKind === null
    ? undefined
    : raw.sourceResolutionKind;
  const suppliedExternalSourceType = raw.externalSourceType === undefined || raw.externalSourceType === null
    ? undefined
    : raw.externalSourceType;
  const suppliedExternalSnapshotHash = raw.externalSnapshotHash === null
    ? null
    : stringValue(raw.externalSnapshotHash);
  if (
    raw.externalSnapshotHash !== undefined &&
    raw.externalSnapshotHash !== null &&
    (typeof raw.externalSnapshotHash !== 'string' || raw.externalSnapshotHash.length === 0 || raw.externalSnapshotHash.length > 256 || /[\u0000-\u001f\u007f]/u.test(raw.externalSnapshotHash))
  ) {
    throw new RegistryApiError('PROVENANCE_CONFLICT', 'Imported artifact external snapshot hash is invalid', 409);
  }
  if (suppliedExternalSourceType !== undefined && suppliedExternalSourceType !== 'github' && suppliedExternalSourceType !== 'well-known') {
    throw new RegistryApiError('PROVENANCE_CONFLICT', 'Imported artifact external source type is invalid', 409);
  }
  if (suppliedSourceResolutionKind !== undefined && suppliedSourceResolutionKind !== 'snapshot' && suppliedSourceResolutionKind !== 'github' && suppliedSourceResolutionKind !== 'well-known') {
    throw new RegistryApiError('PROVENANCE_CONFLICT', 'Imported artifact source resolution kind is invalid', 409);
  }
  if (suppliedSourceReference !== undefined && request.sourceReference !== undefined && suppliedSourceReference !== request.sourceReference) {
    throw new RegistryApiError('PROVENANCE_CONFLICT', 'Imported artifact source reference is inconsistent', 409);
  }
  if (upstream.kind === 'skills-sh') {
    if (
      !request.externalId ||
      suppliedExternalId !== request.externalId ||
      suppliedExternalId !== suppliedPath ||
      (request.externalSourceType !== undefined && suppliedExternalSourceType !== request.externalSourceType) ||
      (request.externalSnapshotHash !== undefined && suppliedExternalSnapshotHash !== request.externalSnapshotHash) ||
      !isValidSkillsShRevision(suppliedRevision, request.externalSnapshotHash)
    ) {
      throw new RegistryApiError('PROVENANCE_CONFLICT', 'Imported artifact provenance does not match its skills.sh identity', 409);
    }
  }
  if (
    (suppliedFeedId !== undefined && suppliedFeedId !== request.feedId) ||
    (suppliedFeedName !== undefined && suppliedFeedName !== request.feedName) ||
    (suppliedFeedConfigRevision !== undefined && suppliedFeedConfigRevision !== request.feedConfigRevision)
  ) {
    throw new RegistryApiError('PROVENANCE_CONFLICT', 'Imported artifact provenance names a different transparent feed', 409);
  }
  const skillsShEvidence = upstream.kind === 'skills-sh'
    ? normalizeSkillsShEvidence(raw, request, suppliedRepository, suppliedExternalId, suppliedExternalSourceType, suppliedExternalSnapshotHash, suppliedFetchedAt)
    : {};
  const suppliedSourceDigest = stringValue(raw.sourceDigest);
  if (suppliedSourceDigest !== undefined && (!isDigest(suppliedSourceDigest) || suppliedSourceDigest !== digest)) {
    throw new RegistryApiError('DIGEST_MISMATCH', 'Imported artifact provenance digest does not match the canonical bundle', 409);
  }
  const normalized: Provenance = {
    kind,
    upstreamId: suppliedUpstreamId,
    repository: suppliedRepository,
    path: suppliedPath,
    revision: suppliedRevision,
    ...(suppliedExternalId ? { externalId: suppliedExternalId } : {}),
    ...(suppliedExternalSourceType ? { externalSourceType: suppliedExternalSourceType as Provenance['externalSourceType'] } : {}),
    ...(raw.externalSnapshotHash !== undefined ? { externalSnapshotHash: suppliedExternalSnapshotHash } : {}),
    ...(request.feedId ? { feedId: request.feedId } : {}),
    ...(request.feedName ? { feedName: request.feedName } : {}),
    ...(request.feedConfigRevision ? { feedConfigRevision: request.feedConfigRevision } : {}),
    ...(request.sourceReference ? { sourceReference: request.sourceReference } : {}),
    ...(suppliedSourceProviderOrigin ? { sourceProviderOrigin: suppliedSourceProviderOrigin } : {}),
    ...(suppliedFetchedAt === undefined ? {} : { fetchedAt: suppliedFetchedAt }),
    ...(suppliedSourceResolutionKind ? { sourceResolutionKind: suppliedSourceResolutionKind as Provenance['sourceResolutionKind'] } : {}),
    ...(suppliedExternalDigest === undefined ? {} : { externalDigest: suppliedExternalDigest }),
    ...(suppliedResolvedCommit === undefined ? {} : { resolvedCommit: suppliedResolvedCommit }),
    ...skillsShEvidence,
    ...(suppliedSourceDigest ? { sourceDigest: suppliedSourceDigest } : {}),
  };
  const derivedSourceReference = normalized.sourceReference ?? sourceReferenceFromProvenance(normalized);
  if (suppliedSourceReference !== undefined && derivedSourceReference !== suppliedSourceReference) {
    throw new RegistryApiError('PROVENANCE_CONFLICT', 'Imported artifact source reference is not verified', 409);
  }
  return {
    ...normalized,
    ...(derivedSourceReference === undefined ? {} : { sourceReference: derivedSourceReference }),
  };
}

/** Preserve only bounded, identity-checked skills.sh source evidence. */
function normalizeSkillsShEvidence(
  raw: JsonObject,
  request: ImportRequest,
  repository: string,
  externalId: string | undefined,
  sourceType: unknown,
  snapshotHash: string | null | undefined,
  fetchedAt: string | undefined,
): Partial<Provenance> {
  const nestedValue = raw.external;
  if (nestedValue !== undefined && !isObject(nestedValue)) {
    throw new RegistryApiError('PROVENANCE_CONFLICT', 'Imported artifact external provenance is invalid', 409);
  }
  const nested = nestedValue as JsonObject | undefined;
  const provider = nested?.provider ?? raw.provider;
  const nestedExternalId = optionalProvenanceString(nested?.externalId, 'external.externalId', 2_048);
  const nestedSource = optionalProvenanceString(nested?.source ?? raw.source, 'external.source', 2_048);
  const nestedSlug = optionalProvenanceString(nested?.slug ?? raw.slug, 'external.slug', 2_048);
  const nestedSourceType = nested?.sourceType ?? raw.sourceType ?? sourceType;
  const nestedSourceUrl = optionalProvenanceString(nested?.sourceUrl ?? raw.sourceUrl, 'external.sourceUrl', 4_096);
  const sourceProviderOrigin = optionalProvenanceString(nested?.sourceProviderOrigin ?? raw.sourceProviderOrigin, 'sourceProviderOrigin', 512);
  const nestedFetchedAt = optionalCanonicalProvenanceTimestamp(nested?.fetchedAt, 'external.fetchedAt');
  if (nestedFetchedAt !== undefined && fetchedAt !== undefined && nestedFetchedAt !== fetchedAt) {
    throw new RegistryApiError('PROVENANCE_CONFLICT', 'Imported artifact external fetch timestamp is inconsistent', 409);
  }
  const effectiveFetchedAt = nestedFetchedAt ?? fetchedAt;
  const sourceResolutionKind = nested?.sourceResolutionKind ?? raw.sourceResolutionKind;
  if (sourceResolutionKind !== undefined && sourceResolutionKind !== 'snapshot' && sourceResolutionKind !== 'github' && sourceResolutionKind !== 'well-known') {
    throw new RegistryApiError('PROVENANCE_CONFLICT', 'Imported artifact source resolution kind is invalid', 409);
  }
  const nestedPageUrl = optionalProvenanceString(nested?.pageUrl ?? raw.pageUrl, 'external.pageUrl', 4_096);
  const nestedSnapshotHash = nested?.externalSnapshotHash === null
    ? null
    : optionalProvenanceString(nested?.externalSnapshotHash, 'external.externalSnapshotHash', 256);
  const effectiveSnapshotHash = nested?.externalSnapshotHash === undefined ? snapshotHash : nestedSnapshotHash;
  if (provider !== undefined && provider !== 'skills.sh') {
    throw new RegistryApiError('PROVENANCE_CONFLICT', 'Imported artifact external provider is invalid', 409);
  }
  if (nestedExternalId !== undefined && nestedExternalId !== externalId) {
    throw new RegistryApiError('PROVENANCE_CONFLICT', 'Imported artifact external id is inconsistent', 409);
  }
  if (nestedSource !== undefined && nestedSource !== repository) {
    throw new RegistryApiError('PROVENANCE_CONFLICT', 'Imported artifact external source is inconsistent', 409);
  }
  if (nestedSourceType !== undefined && nestedSourceType !== 'github' && nestedSourceType !== 'well-known') {
    throw new RegistryApiError('PROVENANCE_CONFLICT', 'Imported artifact external source type is invalid', 409);
  }
  if (effectiveSnapshotHash !== snapshotHash && snapshotHash !== undefined) {
    throw new RegistryApiError('PROVENANCE_CONFLICT', 'Imported artifact external snapshot is inconsistent', 409);
  }
  if (nestedSource !== undefined && nestedSlug !== undefined && externalId !== `${nestedSource}/${nestedSlug}`) {
    throw new RegistryApiError('PROVENANCE_CONFLICT', 'Imported artifact external identity is inconsistent', 409);
  }

  const externalDigest = optionalProvenanceString(nested?.externalDigest ?? raw.externalDigest, 'externalDigest', 128);
  if (externalDigest !== undefined && !isDigest(externalDigest)) {
    throw new RegistryApiError('PROVENANCE_CONFLICT', 'Imported artifact external digest is invalid', 409);
  }
  const rawSkillPath = nested?.skillPath ?? raw.skillPath;
  const skillPath = rawSkillPath === ''
    ? ''
    : optionalProvenanceString(rawSkillPath, 'skillPath', 4_096);
  const requestedRef = optionalProvenanceString(nested?.requestedRef ?? raw.requestedRef, 'requestedRef', 256);
  const resolvedCommit = optionalProvenanceString(nested?.resolvedCommit ?? raw.resolvedCommit, 'resolvedCommit', 128);
  const resolvedTree = optionalProvenanceString(nested?.resolvedTree ?? raw.resolvedTree, 'resolvedTree', 128);
  if (resolvedCommit !== undefined && !/^[0-9a-f]{40}$/iu.test(resolvedCommit)) {
    throw new RegistryApiError('PROVENANCE_CONFLICT', 'Imported artifact resolved commit is invalid', 409);
  }
  if (resolvedTree !== undefined && !/^[0-9a-f]{40}$/iu.test(resolvedTree)) {
    throw new RegistryApiError('PROVENANCE_CONFLICT', 'Imported artifact resolved tree is invalid', 409);
  }
  if (skillPath === '' && (
    sourceResolutionKind !== 'github' ||
    nestedSourceType !== 'github' ||
    verifiedSourceOrigin(sourceProviderOrigin) !== 'github.com' ||
    !isCommit(resolvedCommit) ||
    !isSafeRepository(repository) ||
    externalId === undefined ||
    nestedSource !== repository ||
    nestedSlug === undefined ||
    externalId !== `${nestedSource}/${nestedSlug}` ||
    nestedSourceUrl === undefined
  )) {
    throw new RegistryApiError('PROVENANCE_CONFLICT', 'An empty GitHub skill path requires verified repository-root evidence', 409);
  }
  const wellKnownIndexUrl = optionalProvenanceString(nested?.wellKnownIndexUrl ?? raw.wellKnownIndexUrl, 'wellKnownIndexUrl', 4_096);
  const wellKnownEntryName = optionalProvenanceString(nested?.wellKnownEntryName ?? raw.wellKnownEntryName, 'wellKnownEntryName', 2_048);
  const artifactUrl = optionalProvenanceString(nested?.artifactUrl ?? raw.artifactUrl, 'artifactUrl', 4_096);
  const sourceUrl = nestedSourceUrl;
  const pageUrl = nestedPageUrl;
  const frontmatterName = optionalProvenanceString(nested?.frontmatterName ?? raw.frontmatterName, 'frontmatterName', 512);
  const frontmatterDescription = optionalProvenanceString(nested?.frontmatterDescription ?? raw.frontmatterDescription, 'frontmatterDescription', 4_096);

  const external: ExternalProvenance | undefined = provider === 'skills.sh' && externalId && nestedSource && nestedSlug && nestedSourceType && sourceUrl
    ? {
      provider: 'skills.sh',
      externalId,
      source: nestedSource,
      slug: nestedSlug,
      sourceType: nestedSourceType,
      sourceUrl,
      ...(sourceProviderOrigin === undefined ? {} : { sourceProviderOrigin }),
      ...(sourceResolutionKind === undefined ? {} : { sourceResolutionKind: sourceResolutionKind as ExternalProvenance['sourceResolutionKind'] }),
      ...(effectiveFetchedAt === undefined ? {} : { fetchedAt: effectiveFetchedAt }),
      ...(pageUrl === undefined ? {} : { pageUrl }),
      externalSnapshotHash: effectiveSnapshotHash ?? null,
      ...(externalDigest === undefined ? {} : { externalDigest }),
      ...(skillPath === undefined ? {} : { skillPath }),
      ...(requestedRef === undefined ? {} : { requestedRef }),
      ...(resolvedCommit === undefined ? {} : { resolvedCommit }),
      ...(resolvedTree === undefined ? {} : { resolvedTree }),
      ...(wellKnownIndexUrl === undefined ? {} : { wellKnownIndexUrl }),
      ...(wellKnownEntryName === undefined ? {} : { wellKnownEntryName }),
      ...(artifactUrl === undefined ? {} : { artifactUrl }),
      ...(frontmatterName === undefined ? {} : { frontmatterName }),
      ...(frontmatterDescription === undefined ? {} : { frontmatterDescription }),
    }
    : undefined;

  return {
    ...(sourceUrl === undefined ? {} : { sourceUrl }),
    ...(sourceProviderOrigin === undefined ? {} : { sourceProviderOrigin }),
    ...(sourceResolutionKind === undefined ? {} : { sourceResolutionKind: sourceResolutionKind as Provenance['sourceResolutionKind'] }),
    ...(effectiveFetchedAt === undefined ? {} : { fetchedAt: effectiveFetchedAt }),
    ...(pageUrl === undefined ? {} : { pageUrl }),
    ...(artifactUrl === undefined ? {} : { artifactUrl }),
    ...(skillPath === undefined ? {} : { skillPath }),
    ...(requestedRef === undefined ? {} : { requestedRef }),
    ...(resolvedCommit === undefined ? {} : { resolvedCommit }),
    ...(resolvedTree === undefined ? {} : { resolvedTree }),
    ...(wellKnownIndexUrl === undefined ? {} : { wellKnownIndexUrl }),
    ...(wellKnownEntryName === undefined ? {} : { wellKnownEntryName }),
    ...(frontmatterName === undefined ? {} : { frontmatterName }),
    ...(frontmatterDescription === undefined ? {} : { frontmatterDescription }),
    ...(externalDigest === undefined ? {} : { externalDigest }),
    ...(external === undefined ? {} : { external }),
  };
}

function optionalProvenanceString(value: unknown, field: string, maximum: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new RegistryApiError('PROVENANCE_CONFLICT', `Imported artifact ${field} is invalid`, 409);
  }
  return value;
}

function optionalCanonicalProvenanceTimestamp(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isCanonicalIsoTimestamp(value)) {
    throw new RegistryApiError('PROVENANCE_CONFLICT', `Imported artifact ${field} is invalid`, 409);
  }
  return value;
}

function provenanceRepositoryMatches(upstream: Upstream, repository: string): boolean {
  if (upstream.kind === 'github' || upstream.kind === 'skills-sh') return upstreamAllowsImport(upstream, repository);
  if (!upstream.baseUrl) return false;
  try {
    return new URL(repository).origin === new URL(upstream.baseUrl).origin;
  } catch {
    return false;
  }
}

function isValidImportRevision(upstream: Upstream, revision: unknown, expectedSnapshotHash?: string | null): revision is string {
  if (typeof revision !== 'string' || revision.length === 0 || revision.length > 256) return false;
  if (upstream.kind === 'github') return /^[0-9a-f]{40}$/iu.test(revision);
  if (upstream.kind === 'skills-sh') return isValidSkillsShRevision(revision, expectedSnapshotHash);
  return isDigest(revision) || /^(?:0|[1-9]\d*)\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(revision);
}

function isValidSkillsShRevision(revision: unknown, expectedSnapshotHash?: string | null): revision is string {
  if (typeof revision !== 'string' || revision.length === 0 || revision.length > 256 || /[\u0000-\u001f\u007f\s]/u.test(revision)) return false;
  // When the detail endpoint supplies a snapshot hash, completion must echo
  // that exact immutable value.  A null hash is allowed only when the worker
  // returns a source-native immutable commit or canonical digest.
  if (expectedSnapshotHash !== undefined && expectedSnapshotHash !== null) return revision === expectedSnapshotHash;
  return isDigest(revision) || /^[0-9a-f]{40,128}$/iu.test(revision);
}

function parsePolicy(body: JsonObject): Policy {
  if (!Array.isArray(body.scanners)) throw new RegistryApiError('INVALID_POLICY', 'scanners must be an array', 400);
  const scanners: ScannerPolicy[] = body.scanners.map((raw) => {
    if (!isObject(raw)) throw new RegistryApiError('INVALID_POLICY', 'scanner policy must be an object', 400);
    const id = raw.id;
    if (typeof id !== 'string' || !SUPPORTED_SCANNERS.includes(id as ScannerId)) throw new RegistryApiError('INVALID_POLICY', 'Unknown scanner id', 400);
    const mode = raw.mode;
    if (typeof mode !== 'string' || !POLICY_MODES.has(mode as ScannerPolicy['mode'])) throw new RegistryApiError('INVALID_POLICY', 'Unknown scanner mode', 400);
    if (!Array.isArray(raw.blockSeverities) || raw.blockSeverities.some((severity) => typeof severity !== 'string' || !SEVERITIES.has(severity as Finding['severity']))) throw new RegistryApiError('INVALID_POLICY', 'blockSeverities is invalid', 400);
    const timeoutSeconds = Number(raw.timeoutSeconds);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 24 * 60 * 60) throw new RegistryApiError('INVALID_POLICY', 'timeoutSeconds is invalid', 400);
    return {
      id: id as ScannerId,
      mode: mode as ScannerPolicy['mode'],
      blockSeverities: raw.blockSeverities as Finding['severity'][],
      timeoutSeconds,
      configuration: isObject(raw.configuration) ? raw.configuration : undefined,
    };
  });
  if (new Set(scanners.map((scanner) => scanner.id)).size !== scanners.length) throw new RegistryApiError('INVALID_POLICY', 'Each scanner may appear once', 400);
  const allowUnscanned = body.allowUnscanned;
  if (typeof allowUnscanned !== 'boolean') throw new RegistryApiError('INVALID_POLICY', 'allowUnscanned must be boolean', 400);
  const evidenceMaxAgeSeconds = Number(body.evidenceMaxAgeSeconds);
  if (!Number.isFinite(evidenceMaxAgeSeconds) || evidenceMaxAgeSeconds < 0) throw new RegistryApiError('INVALID_POLICY', 'evidenceMaxAgeSeconds is invalid', 400);
  const hooks = body.hooks === undefined ? [] : parseHooks(body.hooks);
  return {
    revision: stringValue(body.revision) || '',
    scanners,
    allowUnscanned,
    evidenceMaxAgeSeconds,
    hooks,
  };
}

function parseHooks(raw: unknown): NonNullable<Policy['hooks']> {
  if (!Array.isArray(raw)) throw new RegistryApiError('INVALID_POLICY', 'hooks must be an array', 400);
  const hooks = raw.map((value) => {
    if (!isObject(value)) throw new RegistryApiError('INVALID_POLICY', 'hook must be an object', 400);
    const id = stringValue(value.id) || randomId('hook');
    const event = value.event;
    const mode = value.mode;
    const timeoutSeconds = Number(value.timeoutSeconds);
    if (typeof event !== 'string' || !HOOK_EVENTS.has(event as NonNullable<Policy['hooks']>[number]['event'])) throw new RegistryApiError('INVALID_POLICY', 'hook event is invalid', 400);
    if (typeof mode !== 'string' || !HOOK_MODES.has(mode as NonNullable<Policy['hooks']>[number]['mode'])) throw new RegistryApiError('INVALID_POLICY', 'hook mode is invalid', 400);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 24 * 60 * 60) throw new RegistryApiError('INVALID_POLICY', 'hook timeoutSeconds is invalid', 400);
    const url = stringValue(value.url);
    if (url) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new RegistryApiError('INVALID_POLICY', 'hook url is invalid', 400);
      }
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
        throw new RegistryApiError('INVALID_POLICY', 'hook url must be HTTPS without credentials', 400);
      }
    }
    const secretEnv = stringValue(value.secretEnv);
    if (secretEnv && !/^[A-Z_][A-Z0-9_]{0,127}$/.test(secretEnv)) {
      throw new RegistryApiError('INVALID_POLICY', 'hook secretEnv is invalid', 400);
    }
    return {
      id,
      event: event as NonNullable<Policy['hooks']>[number]['event'],
      mode: mode as NonNullable<Policy['hooks']>[number]['mode'],
      url,
      secretEnv,
      timeoutSeconds,
    };
  });
  if (new Set(hooks.map((hook) => hook.id)).size !== hooks.length) {
    throw new RegistryApiError('INVALID_POLICY', 'Each hook may appear once', 400);
  }
  return hooks;
}

function assertKnownDistributionState(state: string): asserts state is DistributionState {
  if (!DISTRIBUTION_STATES.has(state as DistributionState)) throw new RegistryApiError('INTERNAL_STATE_INVALID', 'Resource state is invalid', 500);
}

async function readState(repository: StateRepository, organizationId: string): Promise<RegistryState> {
  try {
    const state = await repository.read(organizationId);
    const normalized = ensureState(state, defaultPolicy());
    validateStateStatuses(normalized, organizationId);
    return normalized;
  } catch (error) {
    if (error instanceof RegistryApiError) throw error;
    throw new RegistryApiError('PERSISTENCE_UNAVAILABLE', 'Registry state is temporarily unavailable', 503, { retryable: true });
  }
}

function validateStateStatuses(state: RegistryState, organizationId: string): void {
  validatePolicyRuntime(state.policy);
  for (const skill of state.skills) {
    assertOrganization(skill.organizationId, organizationId);
    assertKnownDistributionState(skill.state);
  }
  for (const pack of state.packs) {
    assertOrganization(pack.organizationId, organizationId);
    if (!PACK_STATES.has(pack.state)) throw new RegistryApiError('INTERNAL_STATE_INVALID', 'Pack state is invalid', 500);
  }
  for (const job of state.jobs) {
    assertOrganization(job.organizationId, organizationId);
    if (job.upstream) assertOrganization(job.upstream.organizationId, organizationId);
    if (!JOB_STATES.has(job.state)) throw new RegistryApiError('INTERNAL_STATE_INVALID', 'Job state is invalid', 500);
  }
  for (const scan of state.scans) {
    assertOrganization(scan.organizationId, organizationId);
    if (!SCAN_STATUSES.has(scan.status)) throw new RegistryApiError('INTERNAL_STATE_INVALID', 'Scan result status is invalid', 500);
  }
  for (const upstream of state.upstreams) assertOrganization(upstream.organizationId, organizationId);
  const feedNames = new Set<string>();
  for (const feed of state.feeds ?? []) {
    assertOrganization(feed.organizationId, organizationId);
    validateFeedState(feed);
    if (feedNames.has(feed.name)) throw new RegistryApiError('INTERNAL_STATE_INVALID', 'Duplicate feed prefix is configured', 500);
    feedNames.add(feed.name);
  }
  for (const authorization of state.authorizations) {
    assertOrganization(authorization.organizationId, organizationId);
    if (authorization.resolution.organizationId !== organizationId) throw new RegistryApiError('INTERNAL_STATE_INVALID', 'Authorization resolution organization is invalid', 500);
  }
  for (const ticket of state.installReceiptTickets ?? []) {
    assertOrganization(ticket.organizationId, organizationId);
    if (ticket.resolution.organizationId !== organizationId) throw new RegistryApiError('INTERNAL_STATE_INVALID', 'Receipt ticket resolution organization is invalid', 500);
    if (!ticket.id || !ticket.authorizationId || !ticket.subject || !ticket.issuedAt || !ticket.expiresAt) {
      throw new RegistryApiError('INTERNAL_STATE_INVALID', 'Receipt ticket state is invalid', 500);
    }
  }
  for (const receipt of state.installReceipts ?? []) {
    assertOrganization(receipt.organizationId, organizationId);
    if (receipt.resolution.organizationId !== organizationId) throw new RegistryApiError('INTERNAL_STATE_INVALID', 'Install receipt resolution organization is invalid', 500);
    if (!receipt.id || !receipt.authorizationId || !receipt.ticketId || !receipt.subject || !receipt.createdAt || !receipt.expiresAt) {
      throw new RegistryApiError('INTERNAL_STATE_INVALID', 'Install receipt state is invalid', 500);
    }
    if (typeof receipt.changed !== 'boolean' || !['codex', 'claude', 'universal'].includes(receipt.agent) || !['windows', 'macos', 'linux', 'other'].includes(receipt.platform)) {
      throw new RegistryApiError('INTERNAL_STATE_INVALID', 'Install receipt metadata is invalid', 500);
    }
  }
  for (const grant of state.grants) assertOrganization(grant.organizationId, organizationId);
  for (const event of state.audit) assertOrganization(event.organizationId, organizationId);
}

function assertOrganization(value: unknown, organizationId: string): void {
  if (value !== organizationId) throw new RegistryApiError('INTERNAL_STATE_INVALID', 'Registry state organization is invalid', 500);
}

function validatePolicyRuntime(policy: Policy): void {
  if (!policy || typeof policy.revision !== 'string' || policy.revision.length === 0 || !Array.isArray(policy.scanners) || typeof policy.allowUnscanned !== 'boolean' || !Number.isFinite(policy.evidenceMaxAgeSeconds) || policy.evidenceMaxAgeSeconds < 0) {
    throw new RegistryApiError('INTERNAL_STATE_INVALID', 'Policy state is invalid', 500);
  }
  const seen = new Set<string>();
  for (const scanner of policy.scanners) {
    if (!scanner || !SUPPORTED_SCANNERS.includes(scanner.id) || !POLICY_MODES.has(scanner.mode) || !Array.isArray(scanner.blockSeverities) || scanner.blockSeverities.some((severity) => !SEVERITIES.has(severity)) || !Number.isFinite(scanner.timeoutSeconds) || scanner.timeoutSeconds <= 0 || seen.has(scanner.id)) {
      throw new RegistryApiError('INTERNAL_STATE_INVALID', 'Scanner policy state is invalid', 500);
    }
    seen.add(scanner.id);
  }
}

function validateFeedState(feed: Feed): void {
  if (
    !feed ||
    typeof feed.id !== 'string' ||
    feed.id.length === 0 ||
    typeof feed.organizationId !== 'string' ||
    typeof feed.name !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(feed.name) ||
    feed.kind !== 'skills-sh' ||
    typeof feed.enabled !== 'boolean' ||
    typeof feed.baseUrl !== 'string' ||
    feed.baseUrl.length === 0 ||
    typeof feed.configRevision !== 'string' ||
    feed.configRevision.length === 0
  ) {
    throw new RegistryApiError('INTERNAL_STATE_INVALID', 'Feed state is invalid', 500);
  }
  if (feed.namespace !== undefined && (typeof feed.namespace !== 'string' || !/^@[a-z0-9][a-z0-9._-]{0,63}$/u.test(feed.namespace))) {
    throw new RegistryApiError('INTERNAL_STATE_INVALID', 'Feed namespace is invalid', 500);
  }
  let base: URL;
  try {
    base = new URL(feed.baseUrl);
  } catch {
    throw new RegistryApiError('INTERNAL_STATE_INVALID', 'Feed base URL is invalid', 500);
  }
  const loopbackHttp = base.protocol === 'http:' && isLoopbackHost(base.hostname);
  if ((base.protocol !== 'https:' && !loopbackHttp) || base.username || base.password || base.search || base.hash) {
    throw new RegistryApiError('INTERNAL_STATE_INVALID', 'Feed base URL is invalid', 500);
  }
  if (
    feed.repositories !== undefined &&
    (!Array.isArray(feed.repositories) || feed.repositories.some((repository) =>
      typeof repository !== 'string' ||
      repository.length === 0 ||
      repository.length > 2_048 ||
      !isWellFormedUnicodeString(repository) ||
      /[\u0000-\u001f\u007f]/u.test(repository),
    ))
  ) {
    throw new RegistryApiError('INTERNAL_STATE_INVALID', 'Feed source restrictions are invalid', 500);
  }
  if (feed.credentialEnv !== undefined && !/^[A-Z_][A-Z0-9_]{0,127}$/u.test(feed.credentialEnv)) {
    throw new RegistryApiError('INTERNAL_STATE_INVALID', 'Feed credential reference is invalid', 500);
  }
}

function ensureState(state: RegistryState | undefined, fallbackPolicy: Policy): RegistryState {
  const target = state || createEmptyRegistryState(fallbackPolicy);
  if (target.schemaVersion !== 1) throw new RegistryApiError('CLIENT_UPGRADE_REQUIRED', 'Registry state schema is unsupported', 500);
  target.skills ||= [];
  target.packs ||= [];
  target.jobs ||= [];
  target.scans ||= [];
  target.upstreams ||= [];
  target.feeds ||= [];
  target.authorizations ||= [];
  target.installReceiptTickets ||= [];
  target.installReceipts ||= [];
  target.builderSessions ||= [];
  target.grants ||= [];
  target.audit ||= [];
  if (!target.policy) target.policy = fallbackPolicy;
  return target;
}

function accessibleSkillIds(state: RegistryState, principal: Principal): Set<string> {
  return new Set(state.skills.filter((skill) => canReadNamespace(principal, skill.name)).map((skill) => skill.id));
}

/**
 * Return the skills visible to a principal that are approved under the
 * current policy and still have fresh, complete scanner evidence.
 *
 * This deliberately shares the resolution predicate instead of exposing a
 * second, weaker search predicate.  It is read-only and does not normalize or
 * mutate the supplied state.  Callers that need deterministic tests may pass
 * the evaluation timestamp explicitly.
 */
export function getVisibleApprovedSkills(
  state: RegistryState,
  principal: Principal,
  now = Date.now(),
): SkillVersion[] {
  return state.skills.filter((skill) =>
    canReadNamespace(principal, skill.name) && skillCurrentlyApproved(state, skill, now),
  );
}

function chooseVersion<T extends { version: string }>(candidates: T[], version?: string): T | undefined {
  const matching = version ? candidates.filter((candidate) => candidate.version === version) : candidates;
  return [...matching].sort((a, b) => compareVersions(b.version, a.version))[0];
}

function compareVersions(a: string, b: string): number {
  const parse = (version: string) => {
    const [main, pre = ''] = version.split('-', 2);
    const nums = main.split('.').map((part) => Number(part));
    return { nums, pre };
  };
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < 3; index += 1) {
    if ((left.nums[index] || 0) !== (right.nums[index] || 0)) return (left.nums[index] || 0) - (right.nums[index] || 0);
  }
  if (!left.pre && right.pre) return 1;
  if (left.pre && !right.pre) return -1;
  return left.pre.localeCompare(right.pre);
}

async function putVerifiedBlob(deps: RegistryDependencies, bytes: Uint8Array, digest: Digest): Promise<StoredBlob> {
  let stored: StoredBlob;
  try {
    stored = await deps.blobs.put(bytes);
  } catch {
    throw new RegistryApiError('STORAGE_UNAVAILABLE', 'Artifact storage is temporarily unavailable', 503, { retryable: true });
  }
  if (!stored || stored.digest !== digest || stored.size !== bytes.byteLength || !stored.key) {
    throw new RegistryApiError('DIGEST_MISMATCH', 'Storage returned bytes with an unexpected digest or size', 409);
  }
  return stored;
}

function normalizeSkillName(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) ? value : undefined;
}

function requireSkillName(value: unknown): string {
  const name = stringValue(value);
  if (!name || !/^@[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,127}$/.test(name)) {
    throw new RegistryApiError('INVALID_NAME', 'Skill and pack names must use @namespace/slug', 400);
  }
  return name;
}

function requireVersion(value: unknown): string {
  const version = stringValue(value);
  if (!version || !/^(?:0|[1-9]\d*)\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new RegistryApiError('INVALID_VERSION', 'Version must be SemVer', 400);
  }
  return version;
}

function isDigest(value: string): value is Digest {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return numberValue(value) && Number.isInteger(value);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clonePolicy(policy: Policy): Policy {
  return JSON.parse(JSON.stringify(policy)) as Policy;
}

function cloneResolution(resolution: Resolution): Resolution {
  return JSON.parse(JSON.stringify(resolution)) as Resolution;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function audit(
  principal: Principal,
  action: string,
  resourceId: string | undefined,
  details: Record<string, unknown>,
  organizationId: string,
): AuditEvent {
  return {
    id: randomId('audit'),
    organizationId,
    subject: principal.subject,
    action,
    resourceId,
    createdAt: nowIso(),
    details,
  };
}

function appendAudit(state: RegistryState, event: AuditEvent): void {
  state.audit.push(event);
}

function normalizeProvenanceKind(value: unknown): value is Provenance['kind'] {
  return value === 'native' || value === 'github' || value === 'registry' || value === 'skills-sh';
}

function redactJobError(error: string): string {
  const redacted = error
    .replace(/(authorization|token|secret|password|credential)\s*[:=]\s*[^\s,;]+/giu, '$1=[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gu, 'Bearer [redacted]');
  return redacted.length > 500 ? redacted.slice(0, 500) : redacted;
}

function bundleError(error: unknown): RegistryApiError {
  if (error instanceof RegistryApiError) return error;
  const message = error instanceof Error && error.message ? error.message : 'Bundle validation failed';
  return new RegistryApiError('BUNDLE_INVALID', message.slice(0, 300), 400);
}

function unavailable(): RegistryApiError {
  return new RegistryApiError('NOT_AVAILABLE', 'Resource is not available', 404);
}

function errorResponse(error: unknown, requestId: string): Response {
  const apiError = error instanceof RegistryApiError
    ? error
    : new RegistryApiError('INTERNAL_ERROR', 'An internal error occurred', 500);
  const payload: JsonObject = {
    error: {
      code: apiError.code,
      message: apiError.message,
      requestId,
      retryable: apiError.retryable,
      ...(apiError.details ? { details: apiError.details } : {}),
    },
  };
  return jsonResponse(payload, apiError.status, {
    'cache-control': 'no-store',
    ...(apiError.retryable ? { 'retry-after': '1' } : {}),
  });
}

function jsonResponse(value: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
      ...extraHeaders,
    },
  });
}

function methodNotAllowed(allow: string[]): Response {
  return jsonResponse({
    error: {
      code: 'METHOD_NOT_ALLOWED',
      message: 'HTTP method is not allowed for this route',
      requestId: randomId('req'),
      retryable: false,
    },
  }, 405, { allow: allow.join(', ') });
}

function nowIso(): string {
  return new Date().toISOString();
}

function randomId(prefix: string): string {
  const webCrypto = globalThis.crypto;
  const uuid = webCrypto?.randomUUID?.();
  if (uuid) return `${prefix}_${uuid}`;
  const bytes = new Uint8Array(16);
  webCrypto?.getRandomValues?.(bytes);
  let encoded = '';
  for (const byte of bytes) encoded += byte.toString(16).padStart(2, '0');
  if (!encoded) encoded = Math.random().toString(36).slice(2);
  return `${prefix}_${encoded}`;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '::1' || host === '127.0.0.1' || host.startsWith('127.');
}
