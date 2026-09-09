import { createAuthenticatorFromEnv } from '../../../packages/auth/src/index';
import { createRegistryHandler } from '../../../packages/core/src/index';
import { createHttpRepositoryHandler } from '../../../packages/database/src/http';
import { createBlobGatewayHandler } from '../../../packages/storage/src/http';
import { createInfrastructure, type RuntimeEnvironment } from '#pskills-infrastructure';

async function createRuntime(env: RuntimeEnvironment) {
  const config = {
    organizationId: env.PSKILLS_ORGANIZATION_ID ?? 'default',
    publicOrigin: env.PSKILLS_PUBLIC_ORIGIN ?? 'http://localhost:5173',
    maxBodyBytes: Number(env.PSKILLS_MAX_BODY_BYTES ?? 3_000_000),
    leaseSeconds: Number(env.PSKILLS_LEASE_SECONDS ?? 300),
    allowLoopbackUpstreams: env.PSKILLS_ENVIRONMENT === 'test',
  };
  const infrastructure = await createInfrastructure(env);
  const auth = await createAuthenticatorFromEnv(env);
  const registry = createRegistryHandler({ ...infrastructure, auth, config });
  const gatewayPrincipal = env.PSKILLS_GATEWAY_TOKEN
    ? await createAuthenticatorFromEnv({ ...env, PSKILLS_BOOTSTRAP_TOKENS: undefined, PSKILLS_BOOTSTRAP_TOKEN: undefined, PSKILLS_WORKER_TOKENS: undefined, PSKILLS_WORKER_TOKEN: env.PSKILLS_GATEWAY_TOKEN })
    : null;
  const authorize = async (request: Request, org?: string) => {
    if (!gatewayPrincipal) return false;
    const principal = await gatewayPrincipal.authenticate(request);
    return !!principal && principal.roles.includes('worker') && (!org || principal.organizationId === org);
  };
  const stateGateway = createHttpRepositoryHandler({ repository: infrastructure.repository, authorize, maxBodyBytes: 20 * 1024 * 1024 });
  const blobGateway = createBlobGatewayHandler({ store: infrastructure.blobs, authorize });
  return (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/v1/internal/state/')) return stateGateway(request);
    if (path === '/internal/blobs' || path.startsWith('/internal/blobs/')) return blobGateway(request);
    return registry(request);
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
