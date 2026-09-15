import type {
  Authenticator,
  Principal,
} from '../../../packages/contracts/src/index.js';
import {
  WORKER_DELEGATION_SECRET_ENV,
  WORKER_OPERATION_AUDIENCE_HEADER,
  WORKER_SERVICE_IDENTITY_HEADER,
  verifyWorkerTenantDelegation,
  workerTenantDelegationIssuerOptionsFromEnv,
  type WorkerDelegationAudience,
  type WorkerDelegationEnv,
  type WorkerTenantDelegationVerifierOptions,
} from '../../../workers/runner/src/identity.js';

const WORKER_FENCING_TOKEN_HEADER = 'x-worker-fencing-token';
const DEFAULT_SERVICE_IDENTITY = 'hosted-worker-service';
const WORKER_SCOPES = ['jobs:claim', 'jobs:artifact', 'jobs:complete'] as const;

export interface SignedWorkerAuthenticatorOptions extends Omit<WorkerTenantDelegationVerifierOptions, 'expectedServiceIdentity'> {
  /** Exact service identity accepted in both the token and request header. */
  expectedServiceIdentity: string;
}

/** Environment snapshot used by the Node and Nitro host adapters. */
export type SignedWorkerAuthenticatorEnvironment = WorkerDelegationEnv;

interface WorkerRoute {
  audience: WorkerDelegationAudience;
  jobId?: string;
}

/**
 * Authenticate only the three internal worker routes using a signed,
 * operation-scoped tenant credential. Other paths return null so the normal
 * Better Auth/API-token/legacy chain remains authoritative for user traffic.
 */
export function createSignedWorkerAuthenticator(
  options: SignedWorkerAuthenticatorOptions,
): Authenticator {
  const expectedServiceIdentity = boundedIdentity(options.expectedServiceIdentity, 'worker service identity');
  const issuer = normalizeIssuer(options.issuer);
  const secret = normalizeSecret(options.secret);
  const verifierOptions: WorkerTenantDelegationVerifierOptions = {
    issuer,
    secret,
    expectedServiceIdentity,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.clockSkewSeconds === undefined ? {} : { clockSkewSeconds: options.clockSkewSeconds }),
  };

  return {
    authenticate: async (request: Request): Promise<Principal | null> => {
      const route = workerRoute(request);
      if (!route) return null;
      const token = bearerToken(request);
      if (!token) return null;
      if (request.headers.get(WORKER_SERVICE_IDENTITY_HEADER) !== expectedServiceIdentity) return null;
      if (request.headers.get(WORKER_OPERATION_AUDIENCE_HEADER) !== route.audience) return null;

      const leaseToken = route.audience === 'worker-claim'
        ? undefined
        : request.headers.get(WORKER_FENCING_TOKEN_HEADER) ?? undefined;
      if (route.audience !== 'worker-claim' && (!leaseToken || /[\u0000-\u001f\u007f]/u.test(leaseToken))) return null;
      try {
        const claims = await verifyWorkerTenantDelegation(token, verifierOptions, {
          audience: route.audience,
          ...(route.jobId === undefined ? {} : { jobId: route.jobId }),
          ...(leaseToken === undefined ? {} : { leaseToken }),
        });
        return {
          organizationId: claims.tenantId,
          subject: claims.serviceIdentity,
          roles: ['worker'],
          scopes: [...WORKER_SCOPES],
          identity: 'worker',
        } as Principal;
      } catch {
        // Invalid signatures, stale leases, wrong audiences, and malformed
        // paths all fail closed without returning a verification oracle.
        return null;
      }
    },
  };
}

/**
 * Construct the verifier from deployment-owned settings. A missing secret
 * leaves signed workers disabled, preserving the explicit legacy worker-token
 * path; a present but malformed secret is a configuration error.
 */
export function createSignedWorkerAuthenticatorFromEnv(
  env: SignedWorkerAuthenticatorEnvironment,
): Authenticator | undefined {
  const secret = env[WORKER_DELEGATION_SECRET_ENV];
  if (secret === undefined) return undefined;
  const issuer = env.PSKILLS_API_URL?.trim() || env.PSKILLS_PUBLIC_ORIGIN?.trim();
  if (!issuer) throw new Error('Signed worker identity requires PSKILLS_API_URL or PSKILLS_PUBLIC_ORIGIN');
  const expectedServiceIdentity = env.PSKILLS_WORKER_SERVICE_IDENTITY?.trim() || DEFAULT_SERVICE_IDENTITY;
  const issuerOptions = workerTenantDelegationIssuerOptionsFromEnv(env, {
    issuer,
    serviceIdentity: expectedServiceIdentity,
  });
  if (!issuerOptions) return undefined;
  return createSignedWorkerAuthenticator({
    ...issuerOptions,
    expectedServiceIdentity,
  });
}

function workerRoute(request: Request): WorkerRoute | undefined {
  let url: URL;
  try { url = new URL(request.url); } catch { return undefined; }
  const method = request.method.toUpperCase();
  if (url.pathname === '/internal/jobs/claim') {
    return method === 'POST' ? { audience: 'worker-claim' } : undefined;
  }

  const match = /^\/internal\/jobs\/([^/]+)\/(artifact|complete)$/u.exec(url.pathname);
  if (!match) return undefined;
  const encodedJobId = match[1]!;
  let jobId: string;
  try { jobId = decodeURIComponent(encodedJobId); } catch { return undefined; }
  // A job id is one path component. Reject encoded separators and alternate
  // encodings so a verifier can never validate a different route identity.
  if (!jobId || jobId.includes('/') || jobId.includes('\\') || /[\u0000-\u001f\u007f]/u.test(jobId) || encodeURIComponent(jobId) !== encodedJobId) {
    return undefined;
  }
  if (match[2] === 'artifact') return method === 'GET' ? { audience: 'worker-artifact', jobId } : undefined;
  return method === 'POST' ? { audience: 'worker-complete', jobId } : undefined;
}

function bearerToken(request: Request): string | undefined {
  const value = request.headers.get('authorization');
  if (!value) return undefined;
  const match = /^Bearer[ \t]+([^ \t]+)$/iu.exec(value);
  return match?.[1];
}

function normalizeIssuer(value: string): string {
  if (typeof value !== 'string' || value.trim() === '' || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('Signed worker issuer is invalid');
  }
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error('Signed worker issuer is invalid'); }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.origin === 'null' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('Signed worker issuer must be an HTTP(S) origin');
  }
  return parsed.origin;
}

function boundedIdentity(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function normalizeSecret(value: string | Uint8Array): string | Uint8Array {
  if (typeof value === 'string' && /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('Signed worker secret is invalid');
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
  if (bytes.byteLength < 32 || bytes.byteLength > 1024) throw new Error('Signed worker secret is invalid');
  return value;
}
