import { createAuthenticatorFromEnv, parseBootstrapTokenEnv } from '../../../packages/auth/src/index';
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
import { openClawConsumerRefreshResult } from './openclaw-runtime';
import { shouldDrainHostedWorker } from './hosted-worker';
import { createSourceCatalogClientFromEnv } from '../../../packages/source-catalog/src/runtime.js';
import type { Authenticator, Principal } from '../../../packages/contracts/src/index.js';
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
import {
  createTenantHandlerRouter,
  type TenantIdentityRuntime,
  type TenantIdentityRuntimeAdapter,
  type TenantRuntimeContext,
} from './tenant-runtime.js';
import {
  BOOTSTRAP_ADOPTION_PATH,
  createBootstrapAdoptionHandler,
  type BootstrapAdoptionStore,
} from './bootstrap-adoption.js';
import { canonicalOriginFromEnv } from './identity-infrastructure.js';
import { createSignedWorkerAuthenticatorFromEnv } from './worker-identity.js';

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
  // Better Auth is optional and Node-owned. The infrastructure profile may
  // provide it without making the shared runtime import a database driver;
  // edge keeps this value absent and continues to serve legacy tokens.
  const identityRuntime = (infrastructure as typeof infrastructure & {
    identity?: TenantIdentityRuntimeAdapter;
  }).identity;
  const apiTokenRuntime = (infrastructure as typeof infrastructure & {
    apiTokens?: {
      handler: (request: Request) => Promise<Response | undefined>;
      authenticator: Authenticator;
    };
  }).apiTokens;
  const signedWorkerAuthenticator = createSignedWorkerAuthenticatorFromEnv(env);
  // Source discovery is server-owned. The catalog receives only this host's
  // environment snapshot; provider credentials are retained by adapters and
  // are never serialized into RegistryHandlerDependencies or browser data.
  const sourceCatalog = createSourceCatalogClientFromEnv({ env });
  const directoryForBase = createSkillsDirectoryClientResolver({
    gateways: directoryGateways,
    officialAvailable: infrastructure.directoryOfficialAvailable,
    officialTokenProvider: infrastructure.directoryOfficialTokenProvider,
  });
  const auth = await createAuthenticatorFromEnv(env);
  const requestAuthenticator: Authenticator = {
    authenticate: async (request: Request) => {
      // Signed worker delegations are route-specific and must be considered
      // before user/session credentials. They carry the tenant selected by
      // the worker deployment and are rechecked by the tenant router.
      if (signedWorkerAuthenticator) {
        const principal = await signedWorkerAuthenticator.authenticate(request);
        if (principal) return principal;
      }
      // Better Auth owns browser sessions. The API-token authenticator owns
      // durable company credentials, and the legacy authenticator remains the
      // final fallback for bootstrap/session compatibility and worker tokens.
      if (identityRuntime) {
        const principal = await identityRuntime.authenticate(request);
        if (principal) return principal;
      }
      if (apiTokenRuntime) {
        const principal = await apiTokenRuntime.authenticator.authenticate(request);
        if (principal) return principal;
      }
      return auth.authenticate(request);
    },
    // Legacy `/auth/session` remains backed by the existing token
    // authenticator. Better Auth owns `/api/auth/*` and never receives this
    // token exchange callback.
    ...(auth.createSession === undefined ? {} : { createSession: auth.createSession.bind(auth) }),
    ...(auth.clearSessionCookie === undefined ? {} : { clearSessionCookie: auth.clearSessionCookie.bind(auth) }),
  };
  const bootstrapOwnerTokenIds = parseBootstrapTokenEnv(env)
    .filter((token) => token.kind !== 'worker' && token.worker !== true && token.organizationId === config.organizationId && token.roles.includes('owner'))
    .map((token) => token.id);
  const organizationName = optionalEnvironmentValue(env.PSKILLS_ORGANIZATION_NAME);
  const organizationSlug = optionalEnvironmentValue(env.PSKILLS_ORGANIZATION_SLUG);
  const bootstrapAdoption = identityRuntime?.getSession && infrastructure.bootstrapAdoptionStore && bootstrapOwnerTokenIds.length > 0
    ? createBootstrapAdoptionHandler({
      defaultOrganizationId: config.organizationId,
      canonicalOrigin: canonicalOriginFromEnv(env),
      identity: { getSession: identityRuntime.getSession.bind(identityRuntime) },
      authenticator: auth,
      repository: infrastructure.repository,
      store: infrastructure.bootstrapAdoptionStore as BootstrapAdoptionStore,
      allowedBootstrapTokenIds: bootstrapOwnerTokenIds,
      ...(organizationName === undefined ? {} : { organizationName }),
      ...(organizationSlug === undefined ? {} : { organizationSlug }),
    })
    : undefined;
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
  const defaultOrganizationId = config.organizationId;
  const { uploadReview: uploadReviewRuntime, ...baseInfrastructure } = infrastructure;
  const legacyDependencies = {
    sourceCatalog,
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
  const embeddingProvider = createEmbeddingProvider(env);
  const legacySearchIndex = embeddingProvider
    ? infrastructure.createSearchIndex(embeddingProvider.profile)
    : undefined;
  const legacyReviewTrigger = createReviewTrigger(env);

  /**
   * Build the fixed-org domain handlers after the outer identity boundary has
   * selected a tenant. Shared persistence and clients are reused, while
   * credentials and optional integrations remain attached to the legacy org
   * that supplied them. A new org therefore gets its own state namespace and
   * honest unavailable responses until it has separately provisioned services.
   */
  const createTenantHandler = async (context: TenantRuntimeContext) => {
    const tenantConfig = { ...config, organizationId: context.organizationId };
    const isLegacyTenant = context.organizationId === defaultOrganizationId;
    const registry = createRegistryHandler({
      ...baseInfrastructure,
      auth: context.auth,
      config: tenantConfig,
      ...(isLegacyTenant ? legacyDependencies : {}),
    });
    const intelligence = createIntelligenceHandler({
      repository: infrastructure.repository,
      blobs: infrastructure.blobs,
      authenticate: context.auth,
      organizationId: context.organizationId,
      publicOrigin: config.publicOrigin,
      // Provider and reviewer credentials are deployment-owned legacy
      // capabilities. They are not copied into a new tenant handler.
      ...(isLegacyTenant && embeddingProvider === undefined ? {} : isLegacyTenant ? {
        embeddingProvider,
        index: legacySearchIndex,
      } : {}),
      ...(isLegacyTenant && env.PSKILLS_REVIEWER_TOKEN === undefined ? {} : isLegacyTenant ? {
        reviewerToken: env.PSKILLS_REVIEWER_TOKEN,
      } : {}),
      ...(isLegacyTenant ? { triggerReview: legacyReviewTrigger } : {}),
    });
    const tenantHostedWorker = infrastructure.createHostedWorkerForTenant?.(context.organizationId)
      ?? (isLegacyTenant ? infrastructure.hostedWorker : undefined);
    return async (request: Request): Promise<Response> => {
      const intelligenceResponse = await intelligence(request);
      if (intelligenceResponse) return intelligenceResponse;
      const response = await registry(request);
      if (tenantHostedWorker && env.CRON_SECRET && shouldDrainHostedWorker(request, response)) {
        // Nitro forwards the platform waitUntil hook on the Web Request. On
        // hosts without that hook, await the bounded drain before returning.
        const drain = async () => {
          const signal = AbortSignal.timeout(240_000);
          for (let count = 0; count < 2; count++) {
            const result = await tenantHostedWorker(new Request(`${config.publicOrigin}/internal/worker/run`, {
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
  };

  // The default handler is deliberately lazy. It serves health and legacy
  // unauthenticated/session requests without putting a fabricated principal in
  // the tenant router, and it does not become a tenant-cache entry.
  let defaultHandlerPromise: Promise<(request: Request) => Promise<Response>> | undefined;
  const defaultHandler = async (request: Request): Promise<Response> => {
    defaultHandlerPromise ??= createTenantHandler({
      organizationId: defaultOrganizationId,
      provisioned: true,
      auth: requestAuthenticator,
    });
    return (await defaultHandlerPromise)(request);
  };
  const tenantIdentity: TenantIdentityRuntime = {
    authenticate: (request: Request) => requestAuthenticator.authenticate(request),
    getSession: identityRuntime?.getSession,
    // Better Auth's principal is already the live active membership. Legacy
    // bootstrap/API tokens are already organization-scoped. Both paths still
    // pass through the same outer selection and inner recheck.
    resolveTenant: async (_request, principal) => ({
      organizationId: principal.organizationId,
      kind: isBetterAuthPrincipal(principal) ? 'active-membership' : 'scoped-api',
      provisioned: principal.organizationId === defaultOrganizationId,
    }),
  };
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
  const tenantRouter = createTenantHandlerRouter({
    defaultOrganizationId,
    identity: tenantIdentity,
    authenticator: requestAuthenticator,
    createHandler: createTenantHandler,
    defaultHandler,
  });
  return async (request: Request) => {
    const path = new URL(request.url).pathname;
    const identityResponse = await handleIdentityRoute(request, identityRuntime, bootstrapAdoption);
    if (identityResponse) return identityResponse;
    if (path.startsWith('/v1/internal/state/')) return stateGateway(request);
    if (path === '/internal/blobs' || path.startsWith('/internal/blobs/')) return blobGateway(request);
    if (path.startsWith('/internal/upload-review/')) {
      const response = await uploadReviewRuntime?.httpHandler?.(request);
      if (response) return response;
    }
    if (path === '/internal/worker/run') {
      const workerHandler = infrastructure.hostedWorker
        ?? infrastructure.createHostedWorkerForTenant?.(defaultOrganizationId);
      return workerHandler ? workerHandler(request)
        : Response.json({ code: 'WORKER_DISABLED' }, { status: 503, headers: { 'cache-control': 'no-store' } });
    }
    if (path === '/v1/tokens' || path.startsWith('/v1/tokens/')) {
      const response = await apiTokenRuntime?.handler(request);
      if (response) return response;
    }
    return tenantRouter(request);
  };
}

const DISABLED_IDENTITY_PUBLIC_CONFIG = {
  protocolVersion: 1,
  enabled: false,
  basePath: '/api/auth',
  providers: [],
  organization: {
    enabled: false,
    roles: ['owner', 'admin', 'publisher', 'reader'],
    maxOrganizationsPerUser: 10,
    maxMembersPerOrganization: 100,
    maxInvitationsPerMember: 100,
  },
  invitations: {
    mode: 'copy-link',
    emailDelivery: 'disabled',
    requiresVerifiedEmail: true,
    allowedRoles: ['owner', 'admin', 'publisher', 'reader'],
  },
  bootstrap: {
    enabled: false,
    requiresExplicitOwnerClaim: true,
    implicitSocialTenantAdoption: false,
  },
} as const;

/** Route the small public identity surface without exposing the identity SDK. */
async function handleIdentityRoute(
  request: Request,
  identity: TenantIdentityRuntimeAdapter | undefined,
  bootstrapAdoption?: (request: Request) => Promise<Response>,
): Promise<Response | undefined> {
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname.replace(/\/+$/u, '') || '/';
  } catch {
    return undefined;
  }
  const method = request.method.toUpperCase();
  if (pathname === '/auth/identity/config') {
    if (method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } });
    return Response.json(identity?.publicProviderConfig() ?? DISABLED_IDENTITY_PUBLIC_CONFIG, {
      headers: { 'cache-control': 'no-store' },
    });
  }
  if (pathname === '/auth/identity/session') {
    if (method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } });
    try {
      const session = identity?.getSession ? await identity.getSession(request) : null;
      return Response.json({ session: session ?? null }, { headers: { 'cache-control': 'no-store' } });
    } catch {
      return Response.json({ code: 'IDENTITY_UNAVAILABLE', message: 'Identity session is temporarily unavailable.' }, {
        status: 503,
        headers: { 'cache-control': 'no-store' },
      });
    }
  }
  if (pathname === BOOTSTRAP_ADOPTION_PATH) {
    if (!identity) return new Response('Not Found', { status: 404 });
    if (!bootstrapAdoption) {
      return Response.json({ code: 'BOOTSTRAP_ADOPTION_UNAVAILABLE', message: 'Bootstrap adoption is not configured.' }, {
        status: 503,
        headers: { 'cache-control': 'no-store' },
      });
    }
    return bootstrapAdoption(request);
  }
  if (pathname === '/api/auth' || pathname.startsWith('/api/auth/')) {
    if (!identity) return new Response('Not Found', { status: 404 });
    return identity.handler(request);
  }
  return undefined;
}

function isBetterAuthPrincipal(value: Principal & { authMethod?: unknown }): boolean {
  return value.authMethod === 'better-auth';
}

function optionalEnvironmentValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized === '' ? undefined : normalized;
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
