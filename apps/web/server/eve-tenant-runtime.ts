import type { Principal, Role } from '../../../packages/contracts/src/index.js';
import {
  authenticateEveTenantRequest,
  bindEveTenantService,
  createEveTenantCredentialProvider,
  eveTenantDelegationIssuerOptionsFromEnv,
  EVE_TENANT_DELEGATION_SECRET_ENV,
  EVE_TENANT_ID_HEADER,
  EVE_TENANT_SERVICE_HEADER,
  type BoundEveTenantService,
  type EveTenantDelegationBinding,
  type EveTenantDelegationClaims,
  type EveTenantDelegationVerifierOptions,
  type EveTenantService,
} from '../../../packages/eve-tenant/src/index.js';

export type EveTenantRuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export interface EveTenantPrincipal extends Principal {
  readonly authMethod: 'eve-tenant';
  readonly eveTenant: {
    readonly service: EveTenantService;
    readonly serviceIdentity: string;
    readonly delegationId: string;
    readonly binding?: EveTenantDelegationBinding;
  };
}

export interface EveTenantHostRuntime {
  readonly issuer: string;
  readonly serviceIdentity: string;
  readonly verifier: EveTenantDelegationVerifierOptions;
  readonly providerFor: (tenantId: string, service: EveTenantService) => BoundEveTenantService;
  readonly verify: (
    request: Request,
    service: EveTenantService,
    context?: { tenantId?: string; binding?: EveTenantDelegationBinding },
  ) => Promise<EveTenantDelegationClaims | null>;
  readonly authenticatePrincipal: (
    request: Request,
    service: EveTenantService,
    context?: { tenantId?: string; binding?: EveTenantDelegationBinding },
  ) => Promise<EveTenantPrincipal | null>;
}

const TENANT_ISSUER_ENV = 'PSKILLS_EVE_TENANT_DELEGATION_ISSUER';
const TENANT_SERVICE_IDENTITY_ENV = 'PSKILLS_EVE_TENANT_SERVICE_IDENTITY';
const MAX_IDENTITY_LENGTH = 256;

/**
 * Build the registry host's tenant credential boundary. The secret is an
 * opt-in deployment setting; when present, an incomplete configuration throws
 * rather than causing a new company to inherit a default-company credential.
 */
export function createEveTenantHostRuntime(
  env: EveTenantRuntimeEnvironment,
  trustedIssuer: string,
): EveTenantHostRuntime | undefined {
  if (env[EVE_TENANT_DELEGATION_SECRET_ENV] === undefined) return undefined;
  const issuer = boundedOrigin(env[TENANT_ISSUER_ENV]?.trim() || trustedIssuer);
  const serviceIdentity = boundedIdentity(env[TENANT_SERVICE_IDENTITY_ENV], 'PSKILLS_EVE_TENANT_SERVICE_IDENTITY');
  const issuerOptions = eveTenantDelegationIssuerOptionsFromEnv(env, { issuer, serviceIdentity });
  if (issuerOptions === undefined) {
    throw new Error('PSKILLS_EVE_TENANT_DELEGATION_SECRET is not configured');
  }
  const verifier: EveTenantDelegationVerifierOptions = {
    ...issuerOptions,
    expectedServiceIdentity: serviceIdentity,
  };
  const verify = async (
    request: Request,
    service: EveTenantService,
    context: { tenantId?: string; binding?: EveTenantDelegationBinding } = {},
  ): Promise<EveTenantDelegationClaims | null> => {
    const supplied = request.headers.get('authorization')?.match(/^Bearer[ \t]+([^ \t]+)$/iu)?.[1];
    if (!supplied) return null;
    const authenticated = await authenticateEveTenantRequest(request, verifier, {
      service,
      ...(context.tenantId === undefined ? {} : { tenantId: context.tenantId }),
      ...(context.binding === undefined ? {} : { binding: context.binding }),
    });
    if (!authenticated || !routingHeadersMatch(request, authenticated.claims)) return null;
    return authenticated.claims;
  };
  const authenticatePrincipal = async (
    request: Request,
    service: EveTenantService,
    context: { tenantId?: string; binding?: EveTenantDelegationBinding } = {},
  ): Promise<EveTenantPrincipal | null> => {
    const claims = await verify(request, service, context);
    if (!claims) return null;
    return principalForClaims(claims);
  };
  return {
    issuer,
    serviceIdentity,
    verifier,
    providerFor: (tenantId, service) => bindEveTenantService(
      createEveTenantCredentialProvider({
        issuer,
        secret: issuerOptions.secret,
        serviceIdentity,
        tenantId,
        service,
      }),
      { tenantId, service },
    ),
    verify,
    authenticatePrincipal,
  };
}

function principalForClaims(claims: EveTenantDelegationClaims): EveTenantPrincipal {
  const access = serviceAccess(claims.aud);
  return {
    organizationId: claims.tenantId,
    subject: `eve:${claims.serviceIdentity}`,
    roles: [...access.roles],
    scopes: [...access.scopes],
    authMethod: 'eve-tenant',
    eveTenant: {
      service: claims.aud,
      serviceIdentity: claims.serviceIdentity,
      delegationId: claims.jti,
      ...(claims.binding === undefined ? {} : { binding: claims.binding }),
    },
  };
}

function serviceAccess(service: EveTenantService): { roles: readonly Role[]; scopes: readonly string[] } {
  if (service === 'skill-builder') {
    return {
      roles: ['publisher'],
      scopes: ['registry:read', 'skills:read', 'skills:builder', 'skills:write', 'skills:publish'],
    };
  }
  if (service === 'consolidation-reviewer') {
    return {
      roles: ['owner'],
      scopes: ['registry:read', 'skills:read', 'reviews:read', 'reviews:write', 'registry:admin'],
    };
  }
  return {
    roles: ['reader'],
    scopes: ['registry:read', 'skills:read', 'reviews:read'],
  };
}

function routingHeadersMatch(request: Request, claims: EveTenantDelegationClaims): boolean {
  const tenant = request.headers.get(EVE_TENANT_ID_HEADER);
  const service = request.headers.get(EVE_TENANT_SERVICE_HEADER);
  return (tenant === null || tenant === claims.tenantId) &&
    (service === null || service === claims.aud);
}

function boundedIdentity(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length > MAX_IDENTITY_LENGTH || /[\u0000-\u001f\u007f\s]/u.test(normalized)) {
    throw new Error(`${name} is invalid`);
  }
  return normalized;
}

function boundedOrigin(value: string): string {
  if (!value || /[?#\s]/u.test(value)) throw new Error('Eve tenant delegation issuer is invalid');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Eve tenant delegation issuer is invalid');
  }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.origin === 'null' ||
      parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('Eve tenant delegation issuer is invalid');
  }
  return parsed.origin;
}
