/**
 * Host-neutral tenant delegation primitives for the Private Skills Eve apps.
 *
 * The registry host selects a tenant after authenticating the caller. It then
 * creates one short-lived credential for one Eve service and one tenant. Eve
 * uses the credential only for route authentication and for its server-side
 * callback requests. Tenant ids are claims, never prompt or tool input.
 *
 * This module deliberately contains only Web Crypto and Web APIs so the same
 * contract can be used by the Node registry host, an Eve deployment, and a
 * Nitro edge adapter. It never logs or returns a secret in a model-facing
 * value.
 */

export const EVE_TENANT_DELEGATION_PROTOCOL_VERSION = 1 as const;
export const EVE_TENANT_DELEGATION_DEFAULT_TTL_SECONDS = 60;
export const EVE_TENANT_DELEGATION_MAX_TTL_SECONDS = 5 * 60;
export const EVE_TENANT_DELEGATION_MAX_TOKEN_BYTES = 8 * 1024;
export const EVE_TENANT_DELEGATION_CLOCK_SKEW_SECONDS = 30;
/** Optional platform secret. It is separate from every legacy static token. */
export const EVE_TENANT_DELEGATION_SECRET_ENV = 'PSKILLS_EVE_TENANT_DELEGATION_SECRET';
export const EVE_TENANT_SERVICE_HEADER = 'X-PSkills-Eve-Service';
export const EVE_TENANT_ID_HEADER = 'X-PSkills-Tenant-Id';

/** Names of the independently deployed Eve services. */
export type EveTenantService =
  | 'upload-reviewer'
  | 'skill-builder'
  | 'consolidation-reviewer';

const EVE_TENANT_SERVICES: readonly EveTenantService[] = [
  'upload-reviewer',
  'skill-builder',
  'consolidation-reviewer',
];

/**
 * Optional server-owned binding carried by a delegation. Lease tokens and
 * source/artifact bytes are intentionally excluded. Internal routes must
 * still validate their own lease and draft state after checking this binding.
 */
export interface EveTenantDelegationBinding {
  readonly sessionId?: string;
  readonly jobId?: string;
  readonly runId?: string;
  readonly registrySessionId?: string;
  readonly draftId?: string;
  readonly draftRevision?: number;
  readonly draftDigest?: string;
}

export interface EveTenantDelegationClaims {
  readonly v: typeof EVE_TENANT_DELEGATION_PROTOCOL_VERSION;
  /** Exact trusted registry origin; paths, queries, and fragments are invalid. */
  readonly iss: string;
  /** Service audience. The receiver must compare this to its configured service. */
  readonly aud: EveTenantService;
  /** Tenant selected by the authenticated registry host. */
  readonly tenantId: string;
  /** Stable deployment-owned service identity, never a user or tenant id. */
  readonly serviceIdentity: string;
  /** NumericDate values in seconds. */
  readonly iat: number;
  readonly exp: number;
  /** Unique token id; route state remains the replay/fencing boundary. */
  readonly jti: string;
  readonly binding?: EveTenantDelegationBinding;
}

export interface EveTenantDelegationIssuerOptions {
  /** Exact HTTP(S) origin of the registry API. */
  readonly issuer: string;
  /** Deployment-owned HMAC secret. Never put it in a request body or tool result. */
  readonly secret: string | Uint8Array;
  readonly serviceIdentity: string;
  readonly ttlSeconds?: number;
  /** Testable clock in milliseconds; production callers use Date.now. */
  readonly now?: () => number;
}

export interface EveTenantDelegationIssueInput {
  readonly tenantId: string;
  readonly service: EveTenantService;
  readonly binding?: EveTenantDelegationBinding;
  readonly ttlSeconds?: number;
}

export interface IssuedEveTenantDelegation {
  readonly token: string;
  readonly claims: EveTenantDelegationClaims;
}

export interface EveTenantDelegationVerifierOptions {
  /** Must be exactly the trusted origin used by the issuer. */
  readonly issuer: string;
  readonly secret: string | Uint8Array;
  /** Route configuration must name the service identity it accepts. */
  readonly expectedServiceIdentity: string;
  readonly now?: () => number;
  readonly clockSkewSeconds?: number;
}

export interface EveTenantDelegationVerificationContext {
  readonly service: EveTenantService;
  /** Pass the server-selected tenant when verifying a callback. */
  readonly tenantId?: string;
  /** Pass the exact route-owned resource binding when one is known. */
  readonly binding?: EveTenantDelegationBinding;
}

/** A fresh credential returned by a deployment-owned tenant provider. */
export interface EveTenantCredential {
  /** Signed delegation accepted by the selected Eve service. */
  readonly token?: string;
  /** Provider-owned complete Authorization value, if it does not return token. */
  readonly authorization?: string;
  readonly tenantId: string;
  readonly service: EveTenantService;
  readonly serviceIdentity: string;
  /** Epoch milliseconds; callers must reject an already expired value. */
  readonly expiresAt: number;
}

export interface EveTenantCredentialRequest {
  readonly tenantId: string;
  readonly service: EveTenantService;
  readonly binding?: EveTenantDelegationBinding;
  readonly signal?: AbortSignal;
}

/** The host can implement this with a secret manager or token broker. */
export interface EveTenantCredentialProvider {
  /** Resolve a fresh credential for exactly one service and tenant. */
  resolve(request: EveTenantCredentialRequest): Promise<EveTenantCredential>;
}

export interface FixedEveTenantCredentialProviderOptions extends EveTenantDelegationIssuerOptions {
  /** One provider instance serves one server-selected tenant and service. */
  readonly tenantId: string;
  readonly service: EveTenantService;
}

export interface EveTenantDelegationEnvOptions {
  readonly issuer: string;
  readonly serviceIdentity: string;
  readonly ttlSeconds?: number;
  readonly now?: () => number;
}

/** Error class with safe, non-secret messages suitable for server logs. */
export class EveTenantDelegationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EveTenantDelegationError';
  }
}

/**
 * Read optional delegation configuration without changing the legacy static
 * token path. Absence means tenant mode is unavailable and the host must not
 * silently fall back to a default-company token for a non-default tenant.
 */
export function eveTenantDelegationIssuerOptionsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  options: EveTenantDelegationEnvOptions,
): EveTenantDelegationIssuerOptions | undefined {
  const secret = env[EVE_TENANT_DELEGATION_SECRET_ENV];
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

/** Issue a short-lived HMAC-SHA-256 credential bound to one tenant/service. */
export async function issueEveTenantDelegation(
  options: EveTenantDelegationIssuerOptions,
  input: EveTenantDelegationIssueInput,
): Promise<IssuedEveTenantDelegation> {
  const issuer = normalizeIssuer(options.issuer);
  const secret = normalizeSecret(options.secret);
  const serviceIdentity = normalizeIdentity(options.serviceIdentity, 'service identity');
  const tenantId = normalizeIdentity(input.tenantId, 'tenant id');
  const service = normalizeService(input.service);
  const binding = input.binding === undefined ? undefined : normalizeBinding(input.binding);
  const nowMs = requireFiniteMilliseconds((options.now ?? Date.now)(), 'issuer clock');
  const nowSeconds = Math.floor(nowMs / 1000);
  const ttlSeconds = normalizeTtl(input.ttlSeconds ?? options.ttlSeconds ?? EVE_TENANT_DELEGATION_DEFAULT_TTL_SECONDS);
  const claims: EveTenantDelegationClaims = {
    v: EVE_TENANT_DELEGATION_PROTOCOL_VERSION,
    iss: issuer,
    aud: service,
    tenantId,
    serviceIdentity,
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
    jti: randomTokenId(),
    ...(binding === undefined ? {} : { binding }),
  };
  const header = {
    alg: 'HS256' as const,
    typ: 'PSKILLS-EVE-TENANT' as const,
    v: EVE_TENANT_DELEGATION_PROTOCOL_VERSION,
  };
  const encodedHeader = encodeBase64Url(new TextEncoder().encode(JSON.stringify(header)));
  const encodedClaims = encodeBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const key = await importSigningKey(secret);
  const signature = new Uint8Array(await webCrypto().subtle.sign('HMAC', key, encodeText(signingInput)));
  const token = `${signingInput}.${encodeBase64Url(signature)}`;
  if (new TextEncoder().encode(token).byteLength > EVE_TENANT_DELEGATION_MAX_TOKEN_BYTES) {
    throw new EveTenantDelegationError('Eve tenant delegation exceeds the token limit');
  }
  return { token, claims };
}

/**
 * Verify the signature and every route-relevant binding. A self-declared
 * audience or tenant is never sufficient: callers pass the expected service
 * and, for callbacks, the exact tenant/job/draft binding from trusted state.
 */
export async function verifyEveTenantDelegation(
  token: string,
  options: EveTenantDelegationVerifierOptions,
  context: EveTenantDelegationVerificationContext,
): Promise<EveTenantDelegationClaims> {
  if (typeof token !== 'string' || token.length === 0 || token.length > EVE_TENANT_DELEGATION_MAX_TOKEN_BYTES) {
    throw new EveTenantDelegationError('Eve tenant delegation token is invalid');
  }
  const pieces = token.split('.');
  if (pieces.length !== 3) throw new EveTenantDelegationError('Eve tenant delegation token is malformed');
  const [encodedHeader, encodedClaims, encodedSignature] = pieces;
  const headerBytes = decodeBase64Url(encodedHeader);
  const claimBytes = decodeBase64Url(encodedClaims);
  const signature = decodeBase64Url(encodedSignature);
  const header = parseCanonicalJson(headerBytes, 'Eve tenant delegation header');
  if (!isRecord(header) || header.alg !== 'HS256' || header.typ !== 'PSKILLS-EVE-TENANT' || header.v !== EVE_TENANT_DELEGATION_PROTOCOL_VERSION) {
    throw new EveTenantDelegationError('Eve tenant delegation header is invalid');
  }
  const claims = normalizeClaims(parseCanonicalJson(claimBytes, 'Eve tenant delegation claims'));
  const issuer = normalizeIssuer(options.issuer);
  const expectedServiceIdentity = normalizeIdentity(options.expectedServiceIdentity, 'expected service identity');
  const expectedService = normalizeService(context.service);
  const secret = normalizeSecret(options.secret);
  const key = await importSigningKey(secret);
  const valid = await webCrypto().subtle.verify(
    'HMAC',
    key,
    signature as BufferSource,
    encodeText(`${encodedHeader}.${encodedClaims}`),
  );
  if (!valid) throw new EveTenantDelegationError('Eve tenant delegation signature is invalid');
  if (claims.iss !== issuer) throw new EveTenantDelegationError('Eve tenant delegation issuer is invalid');
  if (claims.aud !== expectedService) throw new EveTenantDelegationError('Eve tenant delegation service audience is invalid');
  if (claims.serviceIdentity !== expectedServiceIdentity) throw new EveTenantDelegationError('Eve tenant delegation service identity is invalid');
  if (context.tenantId !== undefined && claims.tenantId !== normalizeIdentity(context.tenantId, 'tenant id')) {
    throw new EveTenantDelegationError('Eve tenant delegation tenant binding is invalid');
  }
  if (context.binding !== undefined) assertBindingMatches(claims.binding, context.binding);

  const nowMs = requireFiniteMilliseconds((options.now ?? Date.now)(), 'verifier clock');
  const nowSeconds = Math.floor(nowMs / 1000);
  const clockSkewSeconds = normalizeClockSkew(options.clockSkewSeconds ?? EVE_TENANT_DELEGATION_CLOCK_SKEW_SECONDS);
  if (claims.exp <= nowSeconds - clockSkewSeconds) throw new EveTenantDelegationError('Eve tenant delegation has expired');
  if (claims.iat > nowSeconds + clockSkewSeconds) throw new EveTenantDelegationError('Eve tenant delegation is not active yet');
  if (claims.exp <= claims.iat || claims.exp - claims.iat > EVE_TENANT_DELEGATION_MAX_TTL_SECONDS) {
    throw new EveTenantDelegationError('Eve tenant delegation lifetime is invalid');
  }
  return claims;
}

/**
 * Build a provider that is permanently pinned to one tenant/service. The
 * provider checks the returned credential as well, so a faulty external token
 * broker cannot accidentally hand a company-A caller company-B material.
 */
export function createEveTenantCredentialProvider(
  options: FixedEveTenantCredentialProviderOptions,
): EveTenantCredentialProvider {
  const tenantId = normalizeIdentity(options.tenantId, 'tenant id');
  const service = normalizeService(options.service);
  const issuerOptions: EveTenantDelegationIssuerOptions = {
    issuer: options.issuer,
    secret: options.secret,
    serviceIdentity: options.serviceIdentity,
    ...(options.ttlSeconds === undefined ? {} : { ttlSeconds: options.ttlSeconds }),
    ...(options.now === undefined ? {} : { now: options.now }),
  };
  return {
    async resolve(request) {
      if (normalizeIdentity(request.tenantId, 'tenant id') !== tenantId) {
        throw new EveTenantDelegationError('Eve tenant credential tenant does not match the provider');
      }
      if (normalizeService(request.service) !== service) {
        throw new EveTenantDelegationError('Eve tenant credential service does not match the provider');
      }
      const issued = await issueEveTenantDelegation(issuerOptions, {
        tenantId,
        service,
        ...(request.binding === undefined ? {} : { binding: request.binding }),
      });
      return {
        token: issued.token,
        tenantId,
        service,
        serviceIdentity: issued.claims.serviceIdentity,
        expiresAt: issued.claims.exp * 1000,
      };
    },
  };
}

/**
 * Bind any deployment-owned provider to one fixed tenant/service. This is the
 * seam for secret-manager/token-broker implementations; no caller can change
 * the tenant by changing a path, body, or tool argument.
 */
export function bindEveTenantService(
  provider: EveTenantCredentialProvider,
  options: { readonly tenantId: string; readonly service: EveTenantService },
): BoundEveTenantService {
  const tenantId = normalizeIdentity(options.tenantId, 'tenant id');
  const service = normalizeService(options.service);
  if (!provider || typeof provider.resolve !== 'function') {
    throw new EveTenantDelegationError('Eve tenant credential provider is invalid');
  }
  const bound: BoundEveTenantService = {
    tenantId,
    service,
    async credential(binding, signal) {
      const credential = await provider.resolve({
        tenantId,
        service,
        ...(binding === undefined ? {} : { binding }),
        ...(signal === undefined ? {} : { signal }),
      });
      validateCredential(credential, tenantId, service);
      return credential;
    },
    async headers(init, binding, signal) {
      const credential = await bound.credential(binding, signal);
      const headers = new Headers(init);
      headers.set('authorization', credentialAuthorization(credential));
      // These headers are routing metadata only. The receiver must verify the
      // signed bearer before trusting either value.
      headers.set(EVE_TENANT_ID_HEADER, tenantId);
      headers.set(EVE_TENANT_SERVICE_HEADER, service);
      return headers;
    },
  };
  return bound;
}

/**
 * Construct a callback credential service from a deployment environment. Eve
 * apps use this only after reading their active verified caller; the caller's
 * tenant id is therefore input from signed session metadata, never a body or
 * prompt value. Missing delegation configuration returns undefined so the
 * caller can retain its explicitly supported legacy static path.
 */
export function createEveTenantServiceFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  options: {
    readonly issuer: string;
    readonly tenantId: string;
    readonly service: EveTenantService;
    readonly serviceIdentity?: string;
  },
): BoundEveTenantService | undefined {
  const serviceIdentity = options.serviceIdentity ?? env['PSKILLS_EVE_TENANT_SERVICE_IDENTITY'];
  if (serviceIdentity === undefined || serviceIdentity.trim() === '') {
    if (env[EVE_TENANT_DELEGATION_SECRET_ENV] === undefined) return undefined;
    throw new EveTenantDelegationError('Eve tenant service identity is not configured');
  }
  const issuerOptions = eveTenantDelegationIssuerOptionsFromEnv(env, {
    issuer: options.issuer,
    serviceIdentity,
  });
  if (issuerOptions === undefined) return undefined;
  return bindEveTenantService(
    createEveTenantCredentialProvider({
      ...issuerOptions,
      tenantId: options.tenantId,
      service: options.service,
    }),
    { tenantId: options.tenantId, service: options.service },
  );
}

export interface BoundEveTenantService {
  readonly tenantId: string;
  readonly service: EveTenantService;
  readonly credential: (
    binding?: EveTenantDelegationBinding,
    signal?: AbortSignal,
  ) => Promise<EveTenantCredential>;
  readonly headers: (
    init?: HeadersInit,
    binding?: EveTenantDelegationBinding,
    signal?: AbortSignal,
  ) => Promise<Headers>;
}

/** Return a complete Authorization value after validating provider output. */
export function credentialAuthorization(credential: EveTenantCredential): string {
  if (!credential || typeof credential !== 'object') {
    throw new EveTenantDelegationError('Eve tenant credential is invalid');
  }
  const token = credential.token;
  const authorization = credential.authorization;
  if (token !== undefined && authorization !== undefined) {
    throw new EveTenantDelegationError('Eve tenant credential has ambiguous authorization');
  }
  if (token !== undefined) {
    validateBearerToken(token);
    return `Bearer ${token}`;
  }
  if (authorization === undefined || !/^Bearer\s+[^\s]+$/u.test(authorization)) {
    throw new EveTenantDelegationError('Eve tenant credential authorization is invalid');
  }
  return authorization;
}

/**
 * Authenticate a bearer request at an Eve or internal route. The returned
 * principal is deliberately sanitized and contains no credential material.
 */
export async function authenticateEveTenantRequest(
  request: Request,
  options: EveTenantDelegationVerifierOptions,
  context: EveTenantDelegationVerificationContext,
): Promise<EveTenantPrincipal | null> {
  const supplied = extractBearerToken(request.headers.get('authorization'));
  if (!supplied) return null;
  try {
    const claims = await verifyEveTenantDelegation(supplied, options, context);
    return { claims };
  } catch {
    return null;
  }
}

/**
 * Convenience route-auth factory for an Eve channel. It intentionally returns
 * a structural session-auth value so callers can pass it directly to Eve's
 * `AuthFn<Request>` without making this shared package depend on a specific
 * Eve type export.
 */
export function createEveTenantAuth(
  options: EveTenantDelegationVerifierOptions & { readonly service: EveTenantService },
): (request: Request) => Promise<ReturnType<typeof sessionAuthFromEveTenantPrincipal> | null> {
  return async (request) => {
    const principal = await authenticateEveTenantRequest(request, options, { service: options.service });
    return principal === null ? null : sessionAuthFromEveTenantPrincipal(principal);
  };
}

export interface EveTenantPrincipal {
  readonly claims: EveTenantDelegationClaims;
}

/** Convert verified claims into an Eve route-auth session context. */
export function sessionAuthFromEveTenantPrincipal(
  principal: EveTenantPrincipal,
): {
  readonly attributes: Readonly<Record<string, string | readonly string[]>>;
  readonly authenticator: string;
  readonly principalId: string;
  readonly principalType: 'service';
  readonly subject: string;
} {
  const { claims } = principal;
  return {
    attributes: {
      tenantId: claims.tenantId,
      service: claims.aud,
      serviceIdentity: claims.serviceIdentity,
      delegationId: claims.jti,
      ...(claims.binding?.sessionId === undefined ? {} : { delegationSessionId: claims.binding.sessionId }),
      ...(claims.binding?.jobId === undefined ? {} : { delegationJobId: claims.binding.jobId }),
      ...(claims.binding?.runId === undefined ? {} : { delegationRunId: claims.binding.runId }),
      ...(claims.binding?.registrySessionId === undefined ? {} : { delegationRegistrySessionId: claims.binding.registrySessionId }),
      ...(claims.binding?.draftId === undefined ? {} : { delegationDraftId: claims.binding.draftId }),
      ...(claims.binding?.draftRevision === undefined ? {} : { delegationDraftRevision: String(claims.binding.draftRevision) }),
      ...(claims.binding?.draftDigest === undefined ? {} : { delegationDraftDigest: claims.binding.draftDigest }),
    },
    authenticator: 'pskills-eve-tenant-delegation',
    principalId: claims.serviceIdentity,
    principalType: 'service',
    subject: claims.serviceIdentity,
  };
}

export interface EveSessionAuthShape {
  readonly current: {
    readonly principalType?: string;
    readonly principalId?: string;
    readonly authenticator?: string;
    readonly attributes?: Readonly<Record<string, unknown>>;
  } | null;
}

export interface EveTenantCaller {
  readonly tenantId: string;
  readonly service?: EveTenantService;
  readonly principalId: string;
  readonly binding?: EveTenantDelegationBinding;
}

/**
 * Read only the active caller. Eve intentionally clears `auth.current` on
 * internal delivery; falling back to `initiator` there would reuse a prior
 * tenant's credential, so this helper fails closed instead.
 */
export function requireEveTenantCaller(
  context: { readonly session: { readonly auth: EveSessionAuthShape } } | { readonly auth: EveSessionAuthShape },
  service?: EveTenantService,
): EveTenantCaller {
  const auth = 'session' in context ? context.session.auth : context.auth;
  const caller = auth.current;
  const tenantId = caller?.attributes?.tenantId;
  if (!caller || caller.principalType !== 'service' || typeof tenantId !== 'string') {
    throw new EveTenantDelegationError('An authenticated tenant Eve service caller is required');
  }
  const normalizedTenant = normalizeIdentity(tenantId, 'tenant id');
  const rawService = caller.attributes?.service;
  const callerService = rawService === undefined ? undefined : normalizeService(rawService);
  if (service !== undefined && callerService !== service) {
    throw new EveTenantDelegationError('Eve tenant service does not match the active caller');
  }
  if (typeof caller.principalId !== 'string' || caller.principalId.trim().length === 0) {
    throw new EveTenantDelegationError('The tenant Eve service caller has no principal id');
  }
  const principalId = normalizeIdentity(caller.principalId, 'service principal id');
  const binding = eveTenantBindingFromAuthAttributes(caller.attributes);
  return {
    tenantId: normalizedTenant,
    ...(callerService === undefined ? {} : { service: callerService }),
    principalId,
    ...(binding === undefined ? {} : { binding }),
  };
}

/**
 * Recover the optional route binding projected by
 * `sessionAuthFromEveTenantPrincipal`. Unknown application attributes are
 * ignored; a partial known binding fails closed rather than being treated as
 * an unbound caller.
 */
export function eveTenantBindingFromAuthAttributes(
  attributes: Readonly<Record<string, unknown>> | undefined,
): EveTenantDelegationBinding | undefined {
  if (!attributes) return undefined;
  const sessionId = boundAttribute(attributes.delegationSessionId, 'session id');
  const jobId = boundAttribute(attributes.delegationJobId, 'job id');
  const runId = boundAttribute(attributes.delegationRunId, 'run id');
  const registrySessionId = boundAttribute(attributes.delegationRegistrySessionId, 'registry session id');
  const draftId = boundAttribute(attributes.delegationDraftId, 'draft id');
  const draftRevision = attributes.delegationDraftRevision === undefined
    ? undefined
    : normalizeRevisionAttribute(attributes.delegationDraftRevision);
  const draftDigest = attributes.delegationDraftDigest === undefined
    ? undefined
    : normalizeDigest(attributes.delegationDraftDigest);
  if (sessionId === undefined && jobId === undefined && runId === undefined && registrySessionId === undefined &&
      draftId === undefined && draftRevision === undefined && draftDigest === undefined) {
    return undefined;
  }
  return normalizeBinding({
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(jobId === undefined ? {} : { jobId }),
    ...(runId === undefined ? {} : { runId }),
    ...(registrySessionId === undefined ? {} : { registrySessionId }),
    ...(draftId === undefined ? {} : { draftId }),
    ...(draftRevision === undefined ? {} : { draftRevision }),
    ...(draftDigest === undefined ? {} : { draftDigest }),
  });
}

/** True for a token-shaped value so a configured tenant route can refuse legacy fallback. */
export function looksLikeEveTenantDelegation(value: string | undefined): boolean {
  return typeof value === 'string' && value.split('.').length === 3;
}

function validateCredential(
  credential: EveTenantCredential,
  tenantId: string,
  service: EveTenantService,
): void {
  if (!credential || typeof credential !== 'object') throw new EveTenantDelegationError('Eve tenant credential is invalid');
  if (normalizeIdentity(credential.tenantId, 'credential tenant id') !== tenantId) {
    throw new EveTenantDelegationError('Eve tenant credential tenant does not match the bound tenant');
  }
  if (normalizeService(credential.service) !== service) {
    throw new EveTenantDelegationError('Eve tenant credential service does not match the bound service');
  }
  normalizeIdentity(credential.serviceIdentity, 'credential service identity');
  if (!Number.isFinite(credential.expiresAt) || credential.expiresAt <= Date.now()) {
    throw new EveTenantDelegationError('Eve tenant credential has expired');
  }
  credentialAuthorization(credential);
}

function normalizeClaims(value: unknown): EveTenantDelegationClaims {
  if (!isRecord(value) || value.v !== EVE_TENANT_DELEGATION_PROTOCOL_VERSION || typeof value.iss !== 'string' ||
      typeof value.aud !== 'string' || typeof value.tenantId !== 'string' || typeof value.serviceIdentity !== 'string' ||
      typeof value.iat !== 'number' || typeof value.exp !== 'number' || typeof value.jti !== 'string') {
    throw new EveTenantDelegationError('Eve tenant delegation claims are invalid');
  }
  const binding = value.binding === undefined ? undefined : normalizeBinding(value.binding);
  const claims: EveTenantDelegationClaims = {
    v: EVE_TENANT_DELEGATION_PROTOCOL_VERSION,
    iss: normalizeIssuer(value.iss),
    aud: normalizeService(value.aud),
    tenantId: normalizeIdentity(value.tenantId, 'tenant id'),
    serviceIdentity: normalizeIdentity(value.serviceIdentity, 'service identity'),
    iat: normalizeNumericDate(value.iat, 'issued-at'),
    exp: normalizeNumericDate(value.exp, 'expiry'),
    jti: normalizeIdentity(value.jti, 'token id'),
    ...(binding === undefined ? {} : { binding }),
  };
  for (const key of Object.keys(value)) {
    if (!['v', 'iss', 'aud', 'tenantId', 'serviceIdentity', 'iat', 'exp', 'jti', 'binding'].includes(key)) {
      throw new EveTenantDelegationError('Eve tenant delegation claims contain an unsupported field');
    }
  }
  return claims;
}

function normalizeBinding(value: unknown): EveTenantDelegationBinding {
  if (!isRecord(value)) throw new EveTenantDelegationError('Eve tenant delegation binding is invalid');
  const binding: EveTenantDelegationBinding = {
    ...(value.sessionId === undefined ? {} : { sessionId: normalizeBoundValue(value.sessionId, 'session id') }),
    ...(value.jobId === undefined ? {} : { jobId: normalizeBoundValue(value.jobId, 'job id') }),
    ...(value.runId === undefined ? {} : { runId: normalizeBoundValue(value.runId, 'run id') }),
    ...(value.registrySessionId === undefined ? {} : { registrySessionId: normalizeBoundValue(value.registrySessionId, 'registry session id') }),
    ...(value.draftId === undefined ? {} : { draftId: normalizeBoundValue(value.draftId, 'draft id') }),
    ...(value.draftRevision === undefined ? {} : { draftRevision: normalizeRevision(value.draftRevision) }),
    ...(value.draftDigest === undefined ? {} : { draftDigest: normalizeDigest(value.draftDigest) }),
  };
  if (Object.keys(binding).length === 0) throw new EveTenantDelegationError('Eve tenant delegation binding is empty');
  if ((binding.draftId === undefined) !== (binding.draftRevision === undefined) ||
      (binding.draftId === undefined) !== (binding.draftDigest === undefined)) {
    throw new EveTenantDelegationError('Eve tenant delegation draft binding is incomplete');
  }
  for (const key of Object.keys(value)) {
    if (!['sessionId', 'jobId', 'runId', 'registrySessionId', 'draftId', 'draftRevision', 'draftDigest'].includes(key)) {
      throw new EveTenantDelegationError('Eve tenant delegation binding contains an unsupported field');
    }
  }
  return binding;
}

function assertBindingMatches(
  actual: EveTenantDelegationBinding | undefined,
  expected: EveTenantDelegationBinding,
): void {
  if (actual === undefined) throw new EveTenantDelegationError('Eve tenant delegation omitted its route binding');
  const normalizedExpected = normalizeBinding(expected);
  for (const key of Object.keys(normalizedExpected) as (keyof EveTenantDelegationBinding)[]) {
    if (actual[key] !== normalizedExpected[key]) {
      throw new EveTenantDelegationError(`Eve tenant delegation ${key} binding is invalid`);
    }
  }
}

function normalizeService(value: unknown): EveTenantService {
  if (typeof value !== 'string' || !EVE_TENANT_SERVICES.includes(value as EveTenantService)) {
    throw new EveTenantDelegationError('Eve tenant service is invalid');
  }
  return value as EveTenantService;
}

function normalizeIssuer(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new EveTenantDelegationError('Eve tenant delegation issuer is invalid');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new EveTenantDelegationError('Eve tenant delegation issuer is invalid');
  }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password ||
      parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new EveTenantDelegationError('Eve tenant delegation issuer must be an HTTP(S) origin');
  }
  return parsed.origin;
}

function normalizeSecret(value: string | Uint8Array): Uint8Array {
  if (typeof value === 'string' && /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new EveTenantDelegationError('Eve tenant delegation secret contains control characters');
  }
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
  if (bytes.byteLength < 32 || bytes.byteLength > 1024) {
    throw new EveTenantDelegationError('Eve tenant delegation secret must be 32-1024 bytes');
  }
  return bytes;
}

function normalizeIdentity(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new EveTenantDelegationError(`${label} is invalid`);
  }
  return value.trim();
}

function normalizeBoundValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new EveTenantDelegationError(`${label} is invalid`);
  }
  return value.trim();
}

function normalizeRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1_000_000_000) {
    throw new EveTenantDelegationError('draft revision is invalid');
  }
  return value as number;
}

function normalizeDigest(value: unknown): string {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new EveTenantDelegationError('draft digest is invalid');
  }
  return value;
}

function boundAttribute(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : normalizeBoundValue(value, label);
}

function normalizeRevisionAttribute(value: unknown): number {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new EveTenantDelegationError('draft revision attribute is invalid');
  }
  return normalizeRevision(Number(value));
}

function normalizeTtl(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > EVE_TENANT_DELEGATION_MAX_TTL_SECONDS) {
    throw new EveTenantDelegationError(`Eve tenant delegation ttl must be 1-${EVE_TENANT_DELEGATION_MAX_TTL_SECONDS} seconds`);
  }
  return value;
}

function normalizeClockSkew(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 5 * 60) {
    throw new EveTenantDelegationError('Eve tenant delegation clock skew is invalid');
  }
  return value;
}

function normalizeNumericDate(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new EveTenantDelegationError(`Eve tenant delegation ${label} is invalid`);
  return value;
}

function requireFiniteMilliseconds(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new EveTenantDelegationError(`${label} is invalid`);
  return value;
}

function extractBearerToken(header: string | null): string | null {
  const match = header?.match(/^Bearer\s+([^\s]+)$/u);
  return match?.[1] ?? null;
}

function validateBearerToken(token: unknown): asserts token is string {
  if (typeof token !== 'string' || token.length === 0 || token.length > EVE_TENANT_DELEGATION_MAX_TOKEN_BYTES || /\s/u.test(token)) {
    throw new EveTenantDelegationError('Eve tenant credential token is invalid');
  }
}

function parseCanonicalJson(bytes: Uint8Array, label: string): unknown {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new EveTenantDelegationError(`${label} is invalid`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new EveTenantDelegationError(`${label} is invalid`);
  }
  if (JSON.stringify(value) !== text) throw new EveTenantDelegationError(`${label} is not canonical`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function webCrypto(): Crypto {
  const cryptoValue = globalThis.crypto;
  if (!cryptoValue?.subtle || typeof cryptoValue.getRandomValues !== 'function') {
    throw new EveTenantDelegationError('Web Crypto is required for Eve tenant delegation');
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
  if (!value || value.length > EVE_TENANT_DELEGATION_MAX_TOKEN_BYTES || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new EveTenantDelegationError('Eve tenant delegation encoding is invalid');
  }
  const padding = value.length % 4;
  if (padding === 1) throw new EveTenantDelegationError('Eve tenant delegation encoding is invalid');
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
  if (encodeBase64Url(output) !== value) throw new EveTenantDelegationError('Eve tenant delegation encoding is non-canonical');
  return output;
}

function base64Value(value: string): number {
  const code = value.charCodeAt(0);
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 97 + 26;
  if (code >= 48 && code <= 57) return code - 48 + 52;
  if (value === '+') return 62;
  if (value === '/') return 63;
  throw new EveTenantDelegationError('Eve tenant delegation encoding is invalid');
}
