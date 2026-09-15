import type {
  Authenticator,
  Principal,
  Role,
} from '../../../packages/contracts/src/index.js';
import type { RegistryHandler } from '../../../packages/core/src/index.js';

/**
 * A tenant selection returned by the identity boundary after authentication
 * and membership checks have completed.  A request header or query parameter
 * is not a selection: the identity boundary must return one of these claims.
 */
export interface VerifiedTenantSelection {
  organizationId: string;
  kind: 'active-membership' | 'scoped-api';
  roles?: readonly Role[];
  namespaces?: readonly string[];
  scopes?: readonly string[];
  /** True only when this tenant's private service configuration is provisioned. */
  provisioned?: boolean;
}

/**
 * Sanitized session data an identity adapter may expose to web code.  Keeping
 * the shape structural lets better-auth adapters implement it without making
 * the registry runtime depend on an identity package.
 */
export interface TenantSessionSnapshot {
  user?: unknown;
  organizations?: readonly unknown[];
  activeOrganizationId?: string | null;
  needsOnboarding?: boolean;
}

/** Provider-neutral seam implemented by the authenticated identity boundary. */
export interface TenantIdentityRuntime extends Pick<Authenticator, 'authenticate'> {
  /** Resolve the request's active membership or scoped credential. */
  resolveTenant?: (
    request: Request,
    principal: Principal,
  ) => Promise<VerifiedTenantSelection | undefined | null> | VerifiedTenantSelection | undefined | null;
  /** Optional sanitized interactive session lookup for auth/session adapters. */
  getSession?: (request: Request) => Promise<TenantSessionSnapshot | null> | TenantSessionSnapshot | null;
}

/** Optional Better Auth surface composed by the Node infrastructure adapter. */
export interface TenantIdentityRuntimeAdapter extends TenantIdentityRuntime {
  handler(request: Request): Promise<Response>;
  publicProviderConfig(): unknown;
  onboarding?(): unknown;
}

/**
 * The factory receives tenant configuration and a request-local auth facade.
 * It intentionally does not receive a principal: handlers are cached by
 * organization, so caching a first user's identity here would be a data leak.
 */
export interface TenantRuntimeContext {
  readonly organizationId: string;
  readonly provisioned: boolean;
  readonly auth: Authenticator;
}

export interface TenantOnboardingResponse {
  status?: number;
  code?: string;
  message?: string;
}

export interface TenantHandlerRouterOptions {
  /** Existing deployment default; legacy scoped tokens keep using this org. */
  defaultOrganizationId: string;
  identity: TenantIdentityRuntime;
  /** Authenticator that exposes session and cookie methods for legacy routes. */
  authenticator?: Authenticator;
  /** Build one fixed-org core handler with tenant-safe dependencies. */
  createHandler: (context: TenantRuntimeContext) => Promise<RegistryHandler> | RegistryHandler;
  /** Handler for health and unauthenticated legacy routes. */
  defaultHandler?: RegistryHandler;
  /** Trusted token-to-session resolver. The callback must verify the token. */
  resolveSessionTenant?: (
    request: Request,
  ) => Promise<VerifiedTenantSelection | undefined | null> | VerifiedTenantSelection | undefined | null;
  onboarding?: TenantOnboardingResponse;
  /** Maximum number of tenant handlers retained in this process. */
  maxCachedTenants?: number;
}

export interface TenantHandlerRouter {
  (request: Request): Promise<Response>;
  invalidateTenant(organizationId: string): void;
  clearTenants(): void;
  cachedOrganizations(): readonly string[];
}

const DEFAULT_ONBOARDING: Required<TenantOnboardingResponse> = {
  status: 409,
  code: 'TENANT_ONBOARDING',
  message: 'Choose or create an active organization before using the registry.',
};

/**
 * Create a router that authenticates and selects a tenant before dispatching
 * to a fixed-org core handler.  The cache key is only the verified tenant id;
 * principals and request objects never enter the cache.
 */
export function createTenantHandlerRouter(options: TenantHandlerRouterOptions): TenantHandlerRouter {
  const defaultOrganizationId = boundedOrganizationId(options.defaultOrganizationId);
  const identity = options.identity;
  const authenticator = options.authenticator ?? identity;
  const maxCachedTenants = boundedCacheSize(options.maxCachedTenants);
  interface CachedHandler {
    readonly provisioned: boolean;
    readonly promise: Promise<RegistryHandler>;
  }
  const handlers = new Map<string, CachedHandler>();
  const onboarding = { ...DEFAULT_ONBOARDING, ...(options.onboarding ?? {}) };

  const handlerFor = (organizationId: string, provisioned: boolean): Promise<RegistryHandler> => {
    const existing = handlers.get(organizationId);
    if (existing?.provisioned === provisioned) {
      // Map insertion order is used as a small LRU. Touching the promise does
      // not change its tenant-bound configuration or principal state.
      handlers.delete(organizationId);
      handlers.set(organizationId, existing);
      return existing.promise;
    }
    // Provisioning is part of tenant configuration. If it changes while a
    // process is warm, replace the old entry rather than retaining a handler
    // built with stale capability gates.
    if (existing) handlers.delete(organizationId);

    const context: TenantRuntimeContext = {
      organizationId,
      provisioned,
      auth: bindAuthenticatorToTenant(authenticator, identity, organizationId),
    };
    const pending = Promise.resolve(options.createHandler(context));
    const cached: CachedHandler = { provisioned, promise: pending };
    handlers.set(organizationId, cached);
    pending.catch(() => {
      if (handlers.get(organizationId) === cached) handlers.delete(organizationId);
    });
    while (handlers.size > maxCachedTenants) {
      const oldest = handlers.keys().next().value;
      if (oldest === undefined) break;
      handlers.delete(oldest);
    }
    return pending;
  };

  const defaultDispatch = async (request: Request): Promise<Response> => {
    if (options.defaultHandler) return options.defaultHandler(request);
    return Response.json(
      { code: 'UNAUTHENTICATED', message: 'Authentication required.' },
      { status: 401, headers: { 'cache-control': 'no-store' } },
    );
  };

  const router = (async (request: Request): Promise<Response> => {
    let resolved: RequestTenant;
    try {
      resolved = await resolveRequestTenant(request, identity, defaultOrganizationId, options.resolveSessionTenant);
    } catch (error) {
      console.error('Tenant identity resolution failed:', error instanceof Error ? error.name : 'UnknownError');
      return invalidTenantResponse();
    }

    if (resolved.kind === 'default' || resolved.kind === 'unauthenticated') {
      return defaultDispatch(request);
    }
    if (resolved.kind === 'onboarding') {
      return onboardingResponse(onboarding);
    }

    let organizationId: string;
    let provisioned: boolean;
    try {
      const selection = validateSelection(resolved.selection);
      if (resolved.principal !== undefined && resolved.principal.organizationId !== selection.organizationId) {
        return invalidTenantResponse();
      }
      organizationId = boundedOrganizationId(selection.organizationId);
      // The legacy org is provisioned by definition. New orgs need an
      // explicit identity-side provisioning claim; it is never copied from
      // the default org's credentials by this router.
      provisioned = selection.provisioned === true || organizationId === defaultOrganizationId;
    } catch (error) {
      console.error('Tenant identity selection is invalid:', error instanceof Error ? error.name : 'UnknownError');
      return invalidTenantResponse();
    }

    try {
      const handler = await handlerFor(organizationId, provisioned);
      return await handler(request);
    } catch (error) {
      console.error('Tenant registry handler unavailable:', error instanceof Error ? error.name : 'UnknownError');
      return Response.json(
        { code: 'REGISTRY_UNAVAILABLE', message: 'Registry configuration or backing services are unavailable.' },
        { status: 503, headers: { 'cache-control': 'no-store' } },
      );
    }
  }) as TenantHandlerRouter;

  router.invalidateTenant = (organizationId: string): void => {
    try {
      handlers.delete(boundedOrganizationId(organizationId));
    } catch {
      // Invalidation is best effort and must not turn a config refresh into a
      // request failure.
    }
  };
  router.clearTenants = (): void => {
    handlers.clear();
  };
  router.cachedOrganizations = (): readonly string[] => Object.freeze([...handlers.keys()].sort());
  return router;
}

type RequestTenant =
  | { kind: 'default' }
  | { kind: 'unauthenticated' }
  | { kind: 'onboarding' }
  | { kind: 'selected'; principal?: Principal; selection: VerifiedTenantSelection };

async function resolveRequestTenant(
  request: Request,
  identity: TenantIdentityRuntime,
  defaultOrganizationId: string,
  resolveSessionTenant?: TenantHandlerRouterOptions['resolveSessionTenant'],
): Promise<RequestTenant> {
  const path = safePath(request);
  if (path === '/health') return { kind: 'default' };

  // A session token is commonly in the request body and therefore cannot be
  // authenticated by the normal header principal callback. A trusted adapter
  // may verify it and return the selected org; without one the legacy handler
  // handles the exchange against the configured default organization.
  if (path === '/auth/session' && request.method.toUpperCase() === 'POST') {
    if (!resolveSessionTenant) return { kind: 'default' };
    const selection = await resolveSessionTenant(request);
    if (selection === null) return { kind: 'onboarding' };
    if (selection !== undefined) {
      const checked = validateSelection(selection);
      // The callback is an identity-boundary operation. It must authenticate
      // the body token and verify membership before returning this selection.
      const principal = await identity.authenticate(request);
      if (principal) return { kind: 'selected', principal, selection: checked };
      // If authenticate() cannot inspect body tokens, dispatching to the
      // trusted resolver's selected handler remains valid; its auth facade
      // will revalidate any subsequent core request.
      return { kind: 'selected', selection: checked };
    }
    return { kind: 'default' };
  }

  const principal = await identity.authenticate(request);
  if (!principal) {
    if (await sessionNeedsOnboarding(identity, request)) return { kind: 'onboarding' };
    return { kind: 'unauthenticated' };
  }
  const selection = identity.resolveTenant
    ? await identity.resolveTenant(request, principal)
    : scopedSelection(principal);
  if (selection === null || selection === undefined) return { kind: 'onboarding' };
  const checked = validateSelection(selection);
  if (checked.organizationId !== principal.organizationId) throw new TenantRuntimeError('Tenant selection does not match the authenticated organization');
  return { kind: 'selected', principal, selection: checked };
}

/** Resolve only a verified active membership or scoped API credential. */
export async function resolveTenantSelection(
  request: Request,
  identity: TenantIdentityRuntime,
  _defaultOrganizationId?: string,
): Promise<
  | { kind: 'selected'; principal: Principal; selection: VerifiedTenantSelection }
  | { kind: 'onboarding'; principal: Principal }
  | { kind: 'unauthenticated' }
> {
  const principal = await identity.authenticate(request);
  if (!principal) return { kind: 'unauthenticated' };
  const selection = identity.resolveTenant
    ? await identity.resolveTenant(request, principal)
    : scopedSelection(principal);
  if (selection === null || selection === undefined) return { kind: 'onboarding', principal };
  const checked = validateSelection(selection);
  if (checked.organizationId !== principal.organizationId) throw new TenantRuntimeError('Tenant selection does not match the authenticated organization');
  return { kind: 'selected', principal, selection: checked };
}

/**
 * Bind a core Authenticator to one tenant while retaining per-request
 * identity checks. If a user's active organization changes between the outer
 * router and core's authentication pass, authentication fails closed.
 */
export function bindAuthenticatorToTenant(
  authenticator: Authenticator,
  identity: TenantIdentityRuntime,
  organizationId: string,
): Authenticator {
  const fixedOrganizationId = boundedOrganizationId(organizationId);
  return {
    authenticate: async (request: Request): Promise<Principal | null> => {
      const principal = await authenticator.authenticate(request);
      if (!principal) return null;
      const selection = identity.resolveTenant
        ? await identity.resolveTenant(request, principal)
        : scopedSelection(principal);
      if (!selection) return null;
      const checked = validateSelection(selection);
      if (checked.organizationId !== fixedOrganizationId) return null;
      if (principal.organizationId !== fixedOrganizationId) return null;
      return principalForSelection(principal, checked);
    },
    ...(authenticator.createSession === undefined
      ? {}
      : {
          createSession: async (token: string) => {
            const result = await authenticator.createSession!(token);
            if (!result || result.principal.organizationId !== fixedOrganizationId) return null;
            return { ...result, principal: clonePrincipal(result.principal) };
          },
        }),
    ...(authenticator.clearSessionCookie === undefined
      ? {}
      : { clearSessionCookie: () => authenticator.clearSessionCookie!() }),
  };
}

function scopedSelection(principal: Principal): VerifiedTenantSelection | null {
  const organizationId = typeof principal.organizationId === 'string' ? principal.organizationId.trim() : '';
  return organizationId === '' ? null : { organizationId, kind: 'scoped-api' };
}

async function sessionNeedsOnboarding(identity: TenantIdentityRuntime, request: Request): Promise<boolean> {
  if (!identity.getSession) return false;
  try {
    const session = await identity.getSession(request);
    if (!session) return false;
    return session.needsOnboarding === true || session.activeOrganizationId === null;
  } catch {
    // Session lookup failures do not grant a tenant. The normal unauthenticated
    // path will let the default handler return its established response.
    return false;
  }
}

function validateSelection(value: VerifiedTenantSelection): VerifiedTenantSelection {
  if (!value || typeof value !== 'object') throw new TenantRuntimeError('Tenant selection is invalid');
  const organizationId = boundedOrganizationId(value.organizationId);
  if (value.kind !== 'active-membership' && value.kind !== 'scoped-api') {
    throw new TenantRuntimeError('Tenant selection provenance is invalid');
  }
  for (const [label, values] of [
    ['roles', value.roles],
    ['namespaces', value.namespaces],
    ['scopes', value.scopes],
  ] as const) {
    if (values !== undefined && (!Array.isArray(values) || values.some((item) => typeof item !== 'string' || item.trim() === ''))) {
      throw new TenantRuntimeError(`Tenant selection ${label} is invalid`);
    }
  }
  if (value.provisioned !== undefined && typeof value.provisioned !== 'boolean') {
    throw new TenantRuntimeError('Tenant selection provisioning state is invalid');
  }
  return {
    organizationId,
    kind: value.kind,
    ...(value.roles === undefined ? {} : { roles: [...value.roles] }),
    ...(value.namespaces === undefined ? {} : { namespaces: [...value.namespaces] }),
    ...(value.scopes === undefined ? {} : { scopes: [...value.scopes] }),
    ...(value.provisioned === undefined ? {} : { provisioned: value.provisioned }),
  };
}

function principalForSelection(principal: Principal, selection: VerifiedTenantSelection): Principal {
  return {
    ...clonePrincipal(principal),
    organizationId: selection.organizationId,
    ...(selection.roles === undefined ? {} : { roles: [...selection.roles] }),
    ...(selection.namespaces === undefined ? {} : { namespaces: [...selection.namespaces] }),
    ...(selection.scopes === undefined ? {} : { scopes: [...selection.scopes] }),
  };
}

function clonePrincipal(principal: Principal): Principal {
  return {
    organizationId: principal.organizationId,
    subject: principal.subject,
    roles: [...principal.roles],
    ...(principal.namespaces === undefined ? {} : { namespaces: [...principal.namespaces] }),
    ...(principal.scopes === undefined ? {} : { scopes: [...principal.scopes] }),
  };
}

function boundedOrganizationId(value: unknown): string {
  if (typeof value !== 'string') throw new TenantRuntimeError('Tenant organization is invalid');
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 256 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new TenantRuntimeError('Tenant organization is invalid');
  }
  return normalized;
}

function boundedCacheSize(value: unknown): number {
  if (value === undefined) return 64;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 1024) {
    throw new TenantRuntimeError('Tenant handler cache size is invalid');
  }
  return value;
}

function safePath(request: Request): string {
  try {
    return new URL(request.url).pathname.replace(/\/+$/u, '') || '/';
  } catch {
    return '';
  }
}

function onboardingResponse(options: Required<TenantOnboardingResponse>): Response {
  return Response.json(
    { code: options.code, message: options.message },
    { status: options.status, headers: { 'cache-control': 'no-store' } },
  );
}

function invalidTenantResponse(): Response {
  return Response.json(
    { code: 'TENANT_FORBIDDEN', message: 'The authenticated organization is not available.' },
    { status: 403, headers: { 'cache-control': 'no-store' } },
  );
}

export class TenantRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantRuntimeError';
  }
}
