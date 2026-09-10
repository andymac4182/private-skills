import { createAuthenticatorFromEnv } from '../../../packages/auth/src/index';
import { createRegistryHandler } from '../../../packages/core/src/index';
import { createHttpRepositoryHandler } from '../../../packages/database/src/http';
import { createBlobGatewayHandler } from '../../../packages/storage/src/http';
import { createInfrastructure, type RuntimeEnvironment } from '#pskills-infrastructure';
import { createEmbeddingProvider } from '../../../packages/intelligence/src/embeddings';
import { createReviewTrigger } from '../../../packages/intelligence/src/reviewer-client';
import { createIntelligenceHandler } from '../../../packages/intelligence/src/handler';
import {
  createSkillsDirectoryClient,
  createSkillsDirectoryClientResolver,
  resolveSkillsDirectoryConnection,
  resolveSkillsDirectoryGateways,
} from '../../../packages/directory/src/index';
import { createSkillsPackClient } from '../../../packages/directory-packs/src/index';

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
  const config = {
    organizationId: env.PSKILLS_ORGANIZATION_ID ?? 'default',
    publicOrigin: env.PSKILLS_PUBLIC_ORIGIN ?? 'http://localhost:5173',
    maxBodyBytes: Number(env.PSKILLS_MAX_BODY_BYTES ?? 3_000_000),
    leaseSeconds: Number(env.PSKILLS_LEASE_SECONDS ?? 300),
    allowLoopbackUpstreams: env.PSKILLS_ENVIRONMENT === 'test',
    trustedSkillsShBaseUrls: [...new Set([
      'https://skills.sh',
      ...(configuredDirectoryBaseURL === undefined ? [] : [configuredDirectoryBaseURL]),
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
  const registryDependencies = {
    ...infrastructure,
    auth,
    config,
    directory,
    directoryPacks,
    directoryForBase,
  } as Parameters<typeof createRegistryHandler>[0];
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
    if (path === '/internal/worker/run') {
      return infrastructure.hostedWorker ? infrastructure.hostedWorker(request)
        : Response.json({ code: 'WORKER_DISABLED' }, { status: 503, headers: { 'cache-control': 'no-store' } });
    }
    const intelligenceResponse = await intelligence(request);
    if (intelligenceResponse) return intelligenceResponse;
    const response = await registry(request);
    if (infrastructure.hostedWorker && env.CRON_SECRET && (response.status === 201 || response.status === 202) && request.method === 'POST' &&
        (path === '/v1/publish' || path === '/v1/imports' || path === '/v1/directory/import' || path === '/v1/proxy/resolve' || /^\/v1\/skills\/[^/]+\/rescan$/.test(path))) {
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
