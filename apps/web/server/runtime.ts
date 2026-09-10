import { createAuthenticatorFromEnv } from '../../../packages/auth/src/index';
import {
  createRegistryHandler,
  canReadOpenClawNamespace,
  canReadSkillForPrincipal,
  createOpenClawImportQueue,
  isSkillCurrentlyApproved,
} from '../../../packages/core/src/index';
import { createHttpRepositoryHandler } from '../../../packages/database/src/http';
import { createBlobGatewayHandler } from '../../../packages/storage/src/http';
import { createInfrastructure, type RuntimeEnvironment } from '#pskills-infrastructure';
import { createEmbeddingProvider } from '../../../packages/intelligence/src/embeddings';
import { createReviewTrigger } from '../../../packages/intelligence/src/reviewer-client';
import { resolveUploadReviewModel, resolveUploadReviewRevision } from '../../../packages/upload-reviews/src/index';
import { createIntelligenceHandler } from '../../../packages/intelligence/src/handler';
import { createOpenClawTrustedFeedProfile } from './openclaw-profile';
import {
  createSkillsDirectoryClient,
  createSkillsDirectoryClientResolver,
  resolveSkillsDirectoryConnection,
  resolveSkillsDirectoryGateways,
  SKILLS_DIRECTORY_OFFICIAL_BASE_URL,
} from '../../../packages/directory/src/index';
import { createSkillsPackClient } from '../../../packages/directory-packs/src/index';
import { createBuilderBffRuntime } from './builder-runtime';
import {
  createOpenClawCandidateProvider,
  OpenClawPublicationManager,
  OpenClawTrustedSnapshotImportService,
  PersistentOpenClawFeedCache,
  StateRepositoryOpenClawConsumerSnapshotStore,
  StateRepositoryOpenClawSourceProofStore,
  StateRepositoryOpenClawPublicationStore,
  type OpenClawMetadataPreviewResult,
  type OpenClawMetadataSnapshot,
} from '../../../packages/openclaw-adapter/src/index';
import type { OpenClawRefreshResult } from '../../../packages/openclaw/src/index';

async function createRuntime(env: RuntimeEnvironment) {
  const directoryConnection = resolveSkillsDirectoryConnection(env);
  const directoryGateways = resolveSkillsDirectoryGateways(env);
  const configuredDirectoryBaseURL = directoryConnection.kind === 'official'
    ? directoryConnection.baseURL
    : directoryConnection.kind === 'gateway'
      ? directoryConnection.gateway.baseUrl
      : undefined;
  const configuredGatewayBases = directoryGateways.kind === 'ready'
    ? directoryGateways.gateways.map((gateway) => gateway.baseUrl)
    : [];
  const trustedDirectoryBaseURL = configuredDirectoryBaseURL !== undefined &&
    (directoryConnection.kind === 'gateway' ||
      (directoryConnection.kind === 'official' && configuredDirectoryBaseURL === SKILLS_DIRECTORY_OFFICIAL_BASE_URL))
    ? configuredDirectoryBaseURL
    : undefined;
  const config = {
    organizationId: env.PSKILLS_ORGANIZATION_ID ?? 'default',
    publicOrigin: env.PSKILLS_PUBLIC_ORIGIN ?? 'http://localhost:5173',
    maxBodyBytes: Number(env.PSKILLS_MAX_BODY_BYTES ?? 3_000_000),
    leaseSeconds: Number(env.PSKILLS_LEASE_SECONDS ?? 300),
    allowLoopbackUpstreams: env.PSKILLS_ENVIRONMENT === 'test',
    trustedSkillsShBaseUrls: [...new Set([
      'https://skills.sh',
      ...(trustedDirectoryBaseURL === undefined ? [] : [trustedDirectoryBaseURL]),
      ...configuredGatewayBases,
    ])],
  };
  const infrastructure = await createInfrastructure(env);
  const directoryForBase = createSkillsDirectoryClientResolver({
    gateways: directoryGateways,
    officialAvailable: infrastructure.directoryOfficialAvailable,
    officialTokenProvider: infrastructure.directoryOfficialTokenProvider,
  });
  const auth = await createAuthenticatorFromEnv(env);
  const builder = createBuilderBffRuntime(env);
  const openClawFeedId = env.PSKILLS_OPENCLAW_FEED_ID?.trim();
  const openClawFeedUrl = env.PSKILLS_OPENCLAW_FEED_URL?.trim() || `${config.publicOrigin}/v1/feeds/skills`;
  const openClawTrustedFeed = createOpenClawTrustedFeedProfile(env);
  const openClawProofStore = openClawFeedId
    ? new StateRepositoryOpenClawSourceProofStore(infrastructure.repository, {
      isCurrentPolicyApproved: isSkillCurrentlyApproved,
    })
    : undefined;
  const openClawCandidateProvider = openClawProofStore
    ? createOpenClawCandidateProvider({
      proofs: openClawProofStore,
      canReadSkill: canReadSkillForPrincipal,
      isCurrentPolicyApproved: isSkillCurrentlyApproved,
    })
    : undefined;
  const openClawNamespace = env.PSKILLS_OPENCLAW_NAMESPACE?.trim();
  const openClawSourceOrigin = env.PSKILLS_OPENCLAW_SOURCE_ORIGIN?.trim();
  const openClawConsumerStore = openClawFeedId
    ? new StateRepositoryOpenClawConsumerSnapshotStore(infrastructure.repository)
    : undefined;
  const openClawCache = openClawConsumerStore
    ? new PersistentOpenClawFeedCache({ store: openClawConsumerStore, tenantId: config.organizationId })
    : undefined;
  const openClawQueue = openClawNamespace && openClawSourceOrigin
    ? (() => {
      try {
        return createOpenClawImportQueue({
          repository: infrastructure.repository,
          organizationId: config.organizationId,
          namespace: openClawNamespace,
          sourceProviderOrigin: openClawSourceOrigin,
        });
      } catch {
        return undefined;
      }
    })()
    : undefined;
  const refreshOpenClawMetadata = openClawTrustedFeed && openClawCache
    ? async (signal: AbortSignal): Promise<Pick<OpenClawMetadataPreviewResult, 'kind' | 'snapshot'>> => {
      const result = await openClawCache.refresh({
        url: openClawTrustedFeed.url,
        expectedFeedId: openClawTrustedFeed.expectedFeedId,
        allowedOrigins: openClawTrustedFeed.allowedOrigins,
        ...(openClawTrustedFeed.compatibilityProfile === undefined
          ? {}
          : { compatibilityProfile: openClawTrustedFeed.compatibilityProfile }),
        ...(openClawTrustedFeed.fetcher === undefined ? {} : { fetcher: openClawTrustedFeed.fetcher }),
        signal,
      });
      return openClawConsumerRefreshResult(result);
    }
    : undefined;
  const openClawConsumerService = openClawConsumerStore && openClawQueue && openClawNamespace
    ? new OpenClawTrustedSnapshotImportService({
      store: openClawConsumerStore,
      queue: openClawQueue,
      ...(refreshOpenClawMetadata === undefined ? {} : { refresh: refreshOpenClawMetadata }),
      authorize: ({ principal }) => canReadOpenClawNamespace(principal, openClawNamespace),
    })
    : undefined;
  const openClawConsumer = openClawTrustedFeed && openClawCache && openClawConsumerService
    ? {
      refresh: refreshOpenClawMetadata!,
      selectAndQueue: openClawConsumerService.selectAndQueue.bind(openClawConsumerService),
    }
    : undefined;
  const currentTrustedMetadata = openClawTrustedFeed && openClawConsumerStore
    ? async (): Promise<OpenClawMetadataSnapshot | undefined> => {
      try {
        const snapshot = await openClawConsumerStore.read({
          tenantId: config.organizationId,
          feedId: openClawTrustedFeed.expectedFeedId,
          sourceUrl: new URL(openClawTrustedFeed.url).href,
        });
        return snapshot === undefined
          ? undefined
          : openClawConsumerRefreshResult({ kind: 'not-modified', status: 304, snapshot }).snapshot;
      } catch {
        // A missing or malformed durable snapshot must fail closed for
        // publication reads; it must never turn into a network refresh here.
        return undefined;
      }
    }
    : undefined;
  // Publication persistence is always the injected StateRepository. The
  // feed remains disabled unless an operator supplies a non-reserved feed ID.
  // Candidate projection is deliberately read-only: it can expose only
  // releases whose worker-produced provenance, artifact digest, current
  // policy, and namespace access all match the trusted metadata snapshot.
  // Source acquisition stays in the hosted worker; this construction is
  // Web API-only and safe for Nitro edge composition.
  const openClaw = openClawFeedId
    ? {
      enabled: true,
      feedId: openClawFeedId,
      feedUrl: openClawFeedUrl,
      publicationManager: new OpenClawPublicationManager(
        new StateRepositoryOpenClawPublicationStore(infrastructure.repository),
      ),
      ...(openClawTrustedFeed === undefined ? {} : { trustedFeed: openClawTrustedFeed }),
      ...(openClawCandidateProvider === undefined ? {} : { candidatesForTenant: openClawCandidateProvider }),
      ...(openClawProofStore === undefined ? {} : { recordSourceProof: openClawProofStore.recordFromCompletion.bind(openClawProofStore) }),
      ...(openClawNamespace === undefined ? {} : { namespace: openClawNamespace }),
      ...(openClawSourceOrigin === undefined ? {} : { sourceProviderOrigin: openClawSourceOrigin }),
      ...(openClawConsumer === undefined ? {} : { consumer: openClawConsumer }),
      ...(currentTrustedMetadata === undefined ? {} : { currentTrustedMetadata }),
    }
    : undefined;
  // Directory access is an explicit server-side opt-in. The selected
  // infrastructure profile owns the credential callback: Node resolves the
  // official Vercel OIDC helper per request for skills.sh, while edge keeps
  // custom gateway authentication disconnected until separately configured.
  // The callback is never exposed to browser code.
  const directory = configuredDirectoryBaseURL !== undefined &&
    (directoryConnection.kind === 'gateway' || infrastructure.directoryOfficialAvailable)
    ? createSkillsDirectoryClient({
      baseURL: configuredDirectoryBaseURL,
      getToken: infrastructure.directoryTokenProvider,
    })
    : undefined;
  // Unlisted pack discovery is public and never uses a directory bearer token.
  const directoryPacks = env.PSKILLS_PACK_DIRECTORY_ENABLED === 'true' || env.PSKILLS_DIRECTORY_ENABLED === 'true'
    ? createSkillsPackClient() : undefined;
  const { uploadReview: uploadReviewRuntime, ...baseInfrastructure } = infrastructure;
  const registryDependencies = {
    ...baseInfrastructure,
    auth,
    config,
    directory,
    directoryPacks,
    directoryForBase,
    openClaw,
    ...(builder === undefined ? {} : { builder }),
    ...(uploadReviewRuntime?.configured !== true ? {} : {
      uploadReview: {
        service: uploadReviewRuntime.service,
        model: resolveUploadReviewModel(env),
        reviewerRevision: resolveUploadReviewRevision(env),
        configured: uploadReviewRuntime.configured,
        ...(uploadReviewRuntime.trigger === undefined ? {} : { trigger: uploadReviewRuntime.trigger }),
      },
    }),
  };
  const registry = createRegistryHandler(registryDependencies);
  const embeddingProvider = createEmbeddingProvider(env);
  const intelligence = createIntelligenceHandler({
    repository: infrastructure.repository, blobs: infrastructure.blobs,
    authenticate: (request: Request) => auth.authenticate(request),
    organizationId: config.organizationId, publicOrigin: config.publicOrigin,
    embeddingProvider,
    index: embeddingProvider ? infrastructure.createSearchIndex(embeddingProvider.profile) : undefined,
    reviewerToken: env.PSKILLS_REVIEWER_TOKEN,
    triggerReview: createReviewTrigger(env),
  });
  const gatewayPrincipal = env.PSKILLS_GATEWAY_TOKEN
    ? await createAuthenticatorFromEnv({ ...env, PSKILLS_BOOTSTRAP_TOKENS: undefined, PSKILLS_BOOTSTRAP_TOKEN: undefined, PSKILLS_WORKER_TOKENS: undefined, PSKILLS_WORKER_TOKEN: env.PSKILLS_GATEWAY_TOKEN })
    : null;
  const authorize = async (request: Request, org?: string) => {
    if (!gatewayPrincipal) return false;
    const principal = await gatewayPrincipal.authenticate(request);
    return !!principal && principal.roles.includes('worker') && (!org || principal.organizationId === org);
  };
  const stateGateway = createHttpRepositoryHandler({ repository: infrastructure.repository, authorize, maxBodyBytes: 20 * 1024 * 1024 });
  const blobGateway = createBlobGatewayHandler({ store: infrastructure.blobs, authorize, baseOrigin: config.publicOrigin, allowLoopback: env.PSKILLS_ENVIRONMENT === 'development' || env.PSKILLS_ENVIRONMENT === 'test' });
  return async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/v1/internal/state/')) return stateGateway(request);
    if (path === '/internal/blobs' || path.startsWith('/internal/blobs/')) return blobGateway(request);
    if (path.startsWith('/internal/upload-review/')) {
      const response = await uploadReviewRuntime?.httpHandler?.(request);
      if (response) return response;
    }
    if (path === '/internal/worker/run') {
      return infrastructure.hostedWorker ? infrastructure.hostedWorker(request)
        : Response.json({ code: 'WORKER_DISABLED' }, { status: 503, headers: { 'cache-control': 'no-store' } });
    }
    const intelligenceResponse = await intelligence(request);
    if (intelligenceResponse) return intelligenceResponse;
    const response = await registry(request);
    if (infrastructure.hostedWorker && env.CRON_SECRET && (response.status === 201 || response.status === 202) && request.method === 'POST' &&
        (path === '/v1/publish' || path === '/v1/imports' || path === '/v1/directory/import' || path === '/v1/proxy/resolve' || path === '/v1/feeds/skills/import' || /^\/v1\/skills\/[^/]+\/rescan$/.test(path) || /^\/v1\/drafts\/[^/]+\/publish$/.test(path))) {
      // Nitro forwards the platform waitUntil hook on the Web Request. On
      // hosts without that hook, await the bounded drain before returning.
      const drain = async () => {
        const signal = AbortSignal.timeout(240_000);
        for (let count = 0; count < 2; count++) {
          const result = await infrastructure.hostedWorker!(new Request(`${config.publicOrigin}/internal/worker/run`, {
            headers: { authorization: `Bearer ${env.CRON_SECRET}` },
            signal,
          }));
          if (!result.ok) break;
          const outcome = await result.json() as { claimed?: boolean };
          if (!outcome.claimed) break;
        }
      };
      const pending = drain().catch(() => console.error('Hosted worker drain failed; the durable queue retains pending jobs.'));
      const platformRequest = request as Request & { waitUntil?: (task: Promise<unknown>) => void };
      if (platformRequest.waitUntil) platformRequest.waitUntil(pending);
      else await pending;
    }
    return response;
  };
}

function openClawConsumerRefreshResult(result: OpenClawRefreshResult): {
  kind: OpenClawMetadataPreviewResult['kind'];
  snapshot?: OpenClawMetadataSnapshot;
} {
  if (result.kind === 'rejected') return { kind: result.kind };
  const snapshot = result.snapshot;
  return {
    kind: result.kind,
    snapshot: {
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
    },
  };
}

// A stable environment object is cached on Node; worker bindings are per-request.
const runtimes = new WeakMap<object, ReturnType<typeof createRuntime>>();
export async function handleRegistryRequest(request: Request, bindings?: RuntimeEnvironment): Promise<Response> {
  // Nitro 3 exposes Cloudflare bindings on the incoming server request.
  const runtimeRequest = request as Request & { runtime?: { cloudflare?: { env?: RuntimeEnvironment } } };
  const env = bindings ?? runtimeRequest.runtime?.cloudflare?.env ?? process.env;
  let runtime = runtimes.get(env);
  if (!runtime) {
    runtime = createRuntime(env);
    runtimes.set(env, runtime);
    runtime.catch(() => runtimes.delete(env));
  }
  try { return await (await runtime)(request); }
  catch (error) {
    console.error('Registry runtime unavailable:', error instanceof Error ? error.name : 'UnknownError');
    return Response.json({ code: 'REGISTRY_UNAVAILABLE', message: 'Registry configuration or backing services are unavailable.' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }
}
