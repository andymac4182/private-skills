/**
 * Host-neutral worker identity and tenant delegation primitives.
 *
 * The worker API uses a short-lived, operation-scoped bearer credential when
 * a hosted worker is serving a tenant.  The credential is deliberately
 * independent of the bootstrap worker token: a deployment-owned internal
 * service can mint it for one tenant, while the API verifies the signature and
 * the route-specific binding before constructing a worker principal.
 *
 * This module only contains Web Crypto and Web APIs.  It is safe to import from
 * a Node, Nitro, or edge runtime.  It does not expose a minting route and it
 * never logs token material.
 */

export const WORKER_DELEGATION_PROTOCOL_VERSION = 1 as const;
export const WORKER_DELEGATION_DEFAULT_TTL_SECONDS = 60;
export const WORKER_DELEGATION_MAX_TTL_SECONDS = 5 * 60;
export const WORKER_DELEGATION_MAX_TOKEN_BYTES = 8 * 1024;
export const WORKER_DELEGATION_CLOCK_SKEW_SECONDS = 30;
/** Optional internal platform secret; it must remain separate from bootstrap/admin tokens. */
export const WORKER_DELEGATION_SECRET_ENV = 'PSKILLS_WORKER_DELEGATION_SECRET';

export type WorkerDelegationAudience =
  | 'worker-claim'
  | 'worker-artifact'
  | 'worker-complete';

export const WORKER_SERVICE_IDENTITY_HEADER = 'X-Worker-Service-Identity';
export const WORKER_OPERATION_AUDIENCE_HEADER = 'X-Worker-Operation-Audience';

export interface WorkerDelegationClaims {
  v: typeof WORKER_DELEGATION_PROTOCOL_VERSION;
  /** The exact trusted registry/API origin that accepts this credential. */
  iss: string;
  aud: WorkerDelegationAudience;
  /** Organization/tenant selected by the authenticated server boundary. */
  tenantId: string;
  /** Stable deployment-owned service identity; it is not a user or tenant id. */
  serviceIdentity: string;
  /** NumericDate values in seconds. */
  iat: number;
  exp: number;
  /** Unique token id; durable lease fencing remains the replay boundary. */
  jti: string;
  /** Required for artifact and completion operations. */
  jobId?: string;
  /** Required for artifact and completion operations; binds the active lease. */
  leaseToken?: string;
}

export interface IssuedWorkerDelegation {
  token: string;
  claims: WorkerDelegationClaims;
}

export interface WorkerTenantDelegationIssuerOptions {
  /** Exact HTTP(S) origin of the registry API. Paths and query strings are rejected. */
  issuer: string;
  /** Deployment-owned secret. It is never serialized into a public response. */
  secret: string | Uint8Array;
  serviceIdentity: string;
  /** Defaults to one minute and cannot exceed five minutes. */
  ttlSeconds?: number;
  /** Testable clock in milliseconds; production callers use Date.now. */
  now?: () => number;
}

export interface WorkerTenantDelegationIssueInput {
  tenantId: string;
  audience: WorkerDelegationAudience;
  jobId?: string;
  leaseToken?: string;
  ttlSeconds?: number;
}

export interface WorkerTenantDelegationVerifierOptions {
  /** Must be the same exact trusted origin configured by the issuer. */
  issuer: string;
  secret: string | Uint8Array;
  /** Route configuration must name the service identity it accepts. */
  expectedServiceIdentity: string;
  now?: () => number;
  clockSkewSeconds?: number;
}

export interface WorkerTenantDelegationVerificationContext {
  audience: WorkerDelegationAudience;
  tenantId?: string;
  jobId?: string;
  leaseToken?: string;
}

export interface WorkerTenantCredentialRequest {
  audience: WorkerDelegationAudience;
  /** The worker deployment's configured tenant, never a browser hint. */
  tenantId?: string;
  jobId?: string;
  leaseToken?: string;
  workerId: string;
  signal?: AbortSignal;
}

export interface WorkerTenantCredential {
  /** Signed delegation accepted by the internal worker routes. */
  token?: string;
  /** Optional complete Authorization value for providers that own header formatting. */
  authorization?: string;
  tenantId: string;
  serviceIdentity: string;
  audience: WorkerDelegationAudience;
  /** Epoch milliseconds; the client refuses already-expired credentials. */
  expiresAt: number;
}

export interface WorkerTenantCredentialProvider {
  /** Resolve a fresh credential for exactly one worker operation. */
  resolve(request: WorkerTenantCredentialRequest): Promise<WorkerTenantCredential>;
}

export interface FixedWorkerTenantCredentialProviderOptions extends WorkerTenantDelegationIssuerOptions {
  /** One provider instance serves one server-selected tenant. */
  tenantId: string;
}

export interface WorkerDelegationIssuerEnvOptions {
  issuer: string;
  serviceIdentity: string;
  ttlSeconds?: number;
  now?: () => number;
}

export type WorkerDelegationEnv = Readonly<Record<string, string | undefined>>;

/**
 * Read the optional internal delegation secret without changing the legacy
 * worker-token path.  This helper only constructs server-owned issuer
 * configuration; it does not expose a route or mint a credential by itself.
 */
export function workerTenantDelegationIssuerOptionsFromEnv(
  env: WorkerDelegationEnv,
  options: WorkerDelegationIssuerEnvOptions,
): WorkerTenantDelegationIssuerOptions | undefined {
  const secret = env[WORKER_DELEGATION_SECRET_ENV];
  if (secret === undefined) return undefined;
  normalizeSecret(secret);
  return {
    issuer: options.issuer,
    secret,
    serviceIdentity: options.serviceIdentity,
    ...(options.ttlSeconds === undefined ? {} : { ttlSeconds: options.ttlSeconds }),
    ...(options.now === undefined ? {} : { now: options.now }),
  };
}

/**
 * Issue an operation-scoped HMAC-SHA-256 delegation.
 *
 * Artifact and completion tokens must carry both the immutable job id and the
 * active lease/fencing token.  Claim tokens are intentionally tenant-scoped
 * and cannot carry stale job metadata.
 */
export async function issueWorkerTenantDelegation(
  options: WorkerTenantDelegationIssuerOptions,
  input: WorkerTenantDelegationIssueInput,
): Promise<IssuedWorkerDelegation> {
  const issuer = normalizeIssuer(options.issuer);
  const secret = normalizeSecret(options.secret);
  const serviceIdentity = normalizeIdentity(options.serviceIdentity, 'service identity');
  const tenantId = normalizeIdentity(input.tenantId, 'tenant id');
  const audience = normalizeAudience(input.audience);
  const nowMs = requireFiniteMilliseconds((options.now ?? Date.now)(), 'issuer clock');
  const nowSeconds = Math.floor(nowMs / 1000);
  const ttlSeconds = normalizeTtl(input.ttlSeconds ?? options.ttlSeconds ?? WORKER_DELEGATION_DEFAULT_TTL_SECONDS);
  const jobId = normalizeOptionalBoundValue(input.jobId, 'job id');
  const leaseToken = normalizeOptionalBoundValue(input.leaseToken, 'lease token');

  if (audience === 'worker-claim') {
    if (jobId !== undefined || leaseToken !== undefined) {
      throw new WorkerDelegationError('claim delegations cannot carry job or lease bindings');
    }
  } else if (jobId === undefined || leaseToken === undefined) {
    throw new WorkerDelegationError(`${audience} delegations require job and lease bindings`);
  }

  const claims: WorkerDelegationClaims = {
    v: WORKER_DELEGATION_PROTOCOL_VERSION,
    iss: issuer,
    aud: audience,
    tenantId,
    serviceIdentity,
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
    jti: randomTokenId(),
    ...(jobId === undefined ? {} : { jobId }),
    ...(leaseToken === undefined ? {} : { leaseToken }),
  };
  const header = { alg: 'HS256' as const, typ: 'PSKILLS-WORKER' as const, v: WORKER_DELEGATION_PROTOCOL_VERSION };
  const encodedHeader = encodeBase64Url(new TextEncoder().encode(JSON.stringify(header)));
  const encodedClaims = encodeBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const key = await importSigningKey(secret);
  const signature = new Uint8Array(await webCrypto().subtle.sign('HMAC', key, encodeText(signingInput)));
  const token = `${signingInput}.${encodeBase64Url(signature)}`;
  if (new TextEncoder().encode(token).byteLength > WORKER_DELEGATION_MAX_TOKEN_BYTES) {
    throw new WorkerDelegationError('worker delegation exceeds the token limit');
  }
  return { token, claims };
}

/**
 * Verify a delegation and, when supplied, its route-specific tenant/job/lease
 * binding.  Callers should pass the audience implied by the route; a token's
 * self-declared audience is never enough to authorize an operation.
 */
export async function verifyWorkerTenantDelegation(
  token: string,
  options: WorkerTenantDelegationVerifierOptions,
  context: WorkerTenantDelegationVerificationContext,
): Promise<WorkerDelegationClaims> {
  if (typeof token !== 'string' || token.length === 0 || token.length > WORKER_DELEGATION_MAX_TOKEN_BYTES) {
    throw new WorkerDelegationError('worker delegation token is invalid');
  }
  const pieces = token.split('.');
  if (pieces.length !== 3) throw new WorkerDelegationError('worker delegation token is malformed');
  const [encodedHeader, encodedClaims, encodedSignature] = pieces;
  const headerBytes = decodeBase64Url(encodedHeader);
  const claimBytes = decodeBase64Url(encodedClaims);
  const signature = decodeBase64Url(encodedSignature);
  const header = parseCanonicalJson(headerBytes, 'worker delegation header');
  if (!isRecord(header) || header.alg !== 'HS256' || header.typ !== 'PSKILLS-WORKER' || header.v !== WORKER_DELEGATION_PROTOCOL_VERSION) {
    throw new WorkerDelegationError('worker delegation header is invalid');
  }
  const parsedClaims = parseCanonicalJson(claimBytes, 'worker delegation claims');
  const claims = normalizeClaims(parsedClaims);
  const issuer = normalizeIssuer(options.issuer);
  const expectedServiceIdentity = normalizeIdentity(options.expectedServiceIdentity, 'expected service identity');
  const secret = normalizeSecret(options.secret);
  const key = await importSigningKey(secret);
  const valid = await webCrypto().subtle.verify(
    'HMAC',
    key,
    signature as BufferSource,
    encodeText(`${encodedHeader}.${encodedClaims}`),
  );
  if (!valid) throw new WorkerDelegationError('worker delegation signature is invalid');

  if (claims.iss !== issuer) throw new WorkerDelegationError('worker delegation issuer is invalid');
  if (claims.serviceIdentity !== expectedServiceIdentity) {
    throw new WorkerDelegationError('worker delegation service identity is invalid');
  }
  const expectedAudience = normalizeAudience(context.audience);
  if (claims.aud !== expectedAudience) throw new WorkerDelegationError('worker delegation audience is invalid');
  if (context.tenantId !== undefined && claims.tenantId !== normalizeIdentity(context.tenantId, 'tenant id')) {
    throw new WorkerDelegationError('worker delegation tenant binding is invalid');
  }
  const expectedJobId = normalizeOptionalBoundValue(context.jobId, 'job id');
  const expectedLeaseToken = normalizeOptionalBoundValue(context.leaseToken, 'lease token');
  if (claims.aud === 'worker-claim') {
    if (expectedJobId !== undefined || expectedLeaseToken !== undefined || claims.jobId !== undefined || claims.leaseToken !== undefined) {
      throw new WorkerDelegationError('claim delegation has an unexpected job or lease binding');
    }
  } else {
    if (claims.jobId === undefined || claims.leaseToken === undefined) {
      throw new WorkerDelegationError('worker delegation omitted its job or lease binding');
    }
    if (expectedJobId !== undefined && claims.jobId !== expectedJobId) {
      throw new WorkerDelegationError('worker delegation job binding is invalid');
    }
    if (expectedLeaseToken !== undefined && claims.leaseToken !== expectedLeaseToken) {
      throw new WorkerDelegationError('worker delegation lease binding is invalid');
    }
    if (expectedJobId === undefined || expectedLeaseToken === undefined) {
      throw new WorkerDelegationError('worker route verification requires job and lease bindings');
    }
  }

  const nowMs = requireFiniteMilliseconds((options.now ?? Date.now)(), 'verifier clock');
  const nowSeconds = Math.floor(nowMs / 1000);
  const clockSkewSeconds = normalizeClockSkew(options.clockSkewSeconds ?? WORKER_DELEGATION_CLOCK_SKEW_SECONDS);
  if (claims.exp <= nowSeconds - clockSkewSeconds) throw new WorkerDelegationError('worker delegation has expired');
  if (claims.iat > nowSeconds + clockSkewSeconds) throw new WorkerDelegationError('worker delegation is not active yet');
  if (claims.exp <= claims.iat || claims.exp - claims.iat > WORKER_DELEGATION_MAX_TTL_SECONDS) {
    throw new WorkerDelegationError('worker delegation lifetime is invalid');
  }
  return claims;
}

/**
 * Build a provider for one server-selected tenant.  The provider is useful in
 * hosted worker composition: a request can ask for a fresh claim/artifact /
 * completion credential, but it can never change the provider's tenant.
 */
export function createWorkerTenantCredentialProvider(
  options: FixedWorkerTenantCredentialProviderOptions,
): WorkerTenantCredentialProvider {
  const tenantId = normalizeIdentity(options.tenantId, 'tenant id');
  const issuerOptions: WorkerTenantDelegationIssuerOptions = {
    issuer: options.issuer,
    secret: options.secret,
    serviceIdentity: options.serviceIdentity,
    ...(options.ttlSeconds === undefined ? {} : { ttlSeconds: options.ttlSeconds }),
    ...(options.now === undefined ? {} : { now: options.now }),
  };
  return {
    async resolve(request) {
      if (request.tenantId !== undefined && normalizeIdentity(request.tenantId, 'tenant id') !== tenantId) {
        throw new WorkerDelegationError('worker credential tenant does not match the provider');
      }
      if (!request.workerId || /[\u0000-\u001f\u007f]/.test(request.workerId) || request.workerId.length > 256) {
        throw new WorkerDelegationError('worker id is invalid');
      }
      const issued = await issueWorkerTenantDelegation(issuerOptions, {
        tenantId,
        audience: request.audience,
        ...(request.jobId === undefined ? {} : { jobId: request.jobId }),
        ...(request.leaseToken === undefined ? {} : { leaseToken: request.leaseToken }),
      });
      return {
        token: issued.token,
        tenantId,
        serviceIdentity: issued.claims.serviceIdentity,
        audience: issued.claims.aud,
        expiresAt: issued.claims.exp * 1000,
      };
    },
  };
}

export class WorkerDelegationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerDelegationError';
  }
}

function normalizeClaims(value: unknown): WorkerDelegationClaims {
  if (!isRecord(value) || value.v !== WORKER_DELEGATION_PROTOCOL_VERSION || typeof value.iss !== 'string' ||
      typeof value.aud !== 'string' || typeof value.tenantId !== 'string' || typeof value.serviceIdentity !== 'string' ||
      typeof value.iat !== 'number' || typeof value.exp !== 'number' || typeof value.jti !== 'string') {
    throw new WorkerDelegationError('worker delegation claims are invalid');
  }
  const claims: WorkerDelegationClaims = {
    v: WORKER_DELEGATION_PROTOCOL_VERSION,
    iss: normalizeIssuer(value.iss),
    aud: normalizeAudience(value.aud),
    tenantId: normalizeIdentity(value.tenantId, 'tenant id'),
    serviceIdentity: normalizeIdentity(value.serviceIdentity, 'service identity'),
    iat: normalizeNumericDate(value.iat, 'issued-at'),
    exp: normalizeNumericDate(value.exp, 'expiry'),
    jti: normalizeIdentity(value.jti, 'token id'),
    ...(value.jobId === undefined ? {} : { jobId: normalizeBoundValue(value.jobId, 'job id') }),
    ...(value.leaseToken === undefined ? {} : { leaseToken: normalizeBoundValue(value.leaseToken, 'lease token') }),
  };
  for (const key of Object.keys(value)) {
    if (!['v', 'iss', 'aud', 'tenantId', 'serviceIdentity', 'iat', 'exp', 'jti', 'jobId', 'leaseToken'].includes(key)) {
      throw new WorkerDelegationError('worker delegation claims contain an unsupported field');
    }
  }
  return claims;
}

function normalizeAudience(value: unknown): WorkerDelegationAudience {
  if (value === 'worker-claim' || value === 'worker-artifact' || value === 'worker-complete') return value;
  throw new WorkerDelegationError('worker delegation audience is invalid');
}

function normalizeIssuer(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new WorkerDelegationError('worker delegation issuer is invalid');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new WorkerDelegationError('worker delegation issuer is invalid');
  }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password ||
      parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new WorkerDelegationError('worker delegation issuer must be an HTTP(S) origin');
  }
  return parsed.origin;
}

function normalizeSecret(value: string | Uint8Array): Uint8Array {
  if (typeof value === 'string' && /[\u0000-\u001f\u007f]/.test(value)) {
    throw new WorkerDelegationError('worker delegation secret contains control characters');
  }
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
  if (bytes.byteLength < 32 || bytes.byteLength > 1024) {
    throw new WorkerDelegationError('worker delegation secret must be 32-1024 bytes');
  }
  return bytes;
}

function normalizeIdentity(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new WorkerDelegationError(`${label} is invalid`);
  }
  return value;
}

function normalizeBoundValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new WorkerDelegationError(`${label} is invalid`);
  }
  return value;
}

function normalizeOptionalBoundValue(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : normalizeBoundValue(value, label);
}

function normalizeTtl(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > WORKER_DELEGATION_MAX_TTL_SECONDS) {
    throw new WorkerDelegationError(`worker delegation ttl must be 1-${WORKER_DELEGATION_MAX_TTL_SECONDS} seconds`);
  }
  return value;
}

function normalizeClockSkew(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 5 * 60) {
    throw new WorkerDelegationError('worker delegation clock skew is invalid');
  }
  return value;
}

function normalizeNumericDate(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new WorkerDelegationError(`worker delegation ${label} is invalid`);
  return value;
}

function requireFiniteMilliseconds(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new WorkerDelegationError(`${label} is invalid`);
  return value;
}

function parseCanonicalJson(bytes: Uint8Array, label: string): unknown {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new WorkerDelegationError(`${label} is invalid`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new WorkerDelegationError(`${label} is invalid`);
  }
  if (JSON.stringify(value) !== text) throw new WorkerDelegationError(`${label} is not canonical`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function webCrypto(): Crypto {
  const cryptoValue = globalThis.crypto;
  if (!cryptoValue?.subtle || typeof cryptoValue.getRandomValues !== 'function') {
    throw new WorkerDelegationError('Web Crypto is required for worker delegation');
  }
  return cryptoValue;
}

async function importSigningKey(secret: Uint8Array): Promise<CryptoKey> {
  return webCrypto().subtle.importKey(
    'raw',
    secret as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function encodeText(value: string): BufferSource {
  return new TextEncoder().encode(value) as BufferSource;
}

function randomTokenId(): string {
  const cryptoValue = webCrypto();
  if (typeof cryptoValue.randomUUID === 'function') return cryptoValue.randomUUID();
  const bytes = new Uint8Array(16);
  cryptoValue.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

function encodeBase64Url(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    output += alphabet[first >> 2];
    output += alphabet[((first & 3) << 4) | ((second ?? 0) >> 4)];
    output += second === undefined ? '=' : alphabet[((second & 15) << 2) | ((third ?? 0) >> 6)];
    output += third === undefined ? '=' : alphabet[third & 63];
  }
  return output.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function decodeBase64Url(value: string): Uint8Array {
  if (!value || value.length > WORKER_DELEGATION_MAX_TOKEN_BYTES || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new WorkerDelegationError('worker delegation encoding is invalid');
  }
  const padding = value.length % 4;
  if (padding === 1) throw new WorkerDelegationError('worker delegation encoding is invalid');
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/') + (padding === 0 ? '' : '='.repeat(4 - padding));
  const output = new Uint8Array((normalized.length / 4) * 3 - (padding === 0 ? 0 : 4 - padding));
  let offset = 0;
  for (let index = 0; index < normalized.length; index += 4) {
    const a = base64Value(normalized[index]!);
    const b = base64Value(normalized[index + 1]!);
    const c = normalized[index + 2] === '=' ? 0 : base64Value(normalized[index + 2]!);
    const d = normalized[index + 3] === '=' ? 0 : base64Value(normalized[index + 3]!);
    if (offset < output.length) output[offset++] = (a << 2) | (b >> 4);
    if (offset < output.length) output[offset++] = ((b & 15) << 4) | (c >> 2);
    if (offset < output.length) output[offset++] = ((c & 3) << 6) | d;
  }
  if (encodeBase64Url(output) !== value) throw new WorkerDelegationError('worker delegation encoding is non-canonical');
  return output;
}

function base64Value(value: string): number {
  const code = value.charCodeAt(0);
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 97 + 26;
  if (code >= 48 && code <= 57) return code - 48 + 52;
  if (value === '+') return 62;
  if (value === '/') return 63;
  throw new WorkerDelegationError('worker delegation encoding is invalid');
}
