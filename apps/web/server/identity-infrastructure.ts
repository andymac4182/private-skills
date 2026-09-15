import {
  createIdentityRuntimeFromEnv,
  normalizeIdentityRole,
  type IdentityEnvironment,
  type IdentityRuntimeAdmin,
} from '../../../packages/identity/src/index.js';
import {
  createCompanySsoBetterAuthBridge,
  createCompanySsoModule,
  createCompanySsoPlugin,
  createPostgresCompanySsoRepository,
  type CompanySsoAuthorizer,
  type CompanySsoModule,
} from '../../../packages/identity/src/company-sso.js';
import {
  createApiTokenModule,
  createPostgresApiTokenRepository,
  DEFAULT_API_TOKEN_SESSION_COOKIE,
  type ApiTokenModule,
  type ApiTokenPgPool,
  type IdentityRole as ApiTokenIdentityRole,
  type MembershipAuthorizer,
  type MembershipSnapshot,
  type OrganizationSessionLike,
} from '../../../packages/api-tokens/src/index.js';
import { canonicalOriginFromEnv } from './identity-origin.js';

export { canonicalOriginFromEnv } from './identity-origin.js';

/** The identity package intentionally keeps its database implementation private. */
export interface IdentityInfrastructureOptions {
  /** A PostgreSQL pool shared with the metadata repository when available. */
  postgresPool?: ApiTokenPgPool;
  /** Trusted deployment origin used for cookie-authenticated token mutations. */
  canonicalOrigin?: string;
  apiTokenTableName?: string;
  apiTokenAutoMigrate?: boolean;
  companySsoTableName?: string;
  companySsoAutoMigrate?: boolean;
}

export interface IdentityInfrastructure {
  identity: IdentityRuntimeAdmin | null;
  apiTokens: ApiTokenModule | null;
  companySso: CompanySsoModule | null;
}

/** Keep the API-token browser exchange on the same durable secret boundary as identity. */
function sessionSecretFromEnv(env: IdentityEnvironment): string | undefined {
  return env.BETTER_AUTH_SECRET?.trim()
    || env.PSKILLS_BETTER_AUTH_SECRET?.trim()
    || env.PSKILLS_SESSION_SECRET?.trim();
}

/**
 * Better Auth exposes a live session view, while API-token bearer requests do
 * not carry that session cookie. This adapter therefore reads the exact
 * Better Auth membership row on every bearer verification. Presence of the
 * row is the active-membership signal; role changes and removals take effect
 * on the next request.
 */
export class PostgresBetterAuthMembershipAuthorizer implements MembershipAuthorizer {
  private readonly identity: IdentityRuntimeAdmin;
  private readonly pool: ApiTokenPgPool;
  private readonly memberTable: string;

  constructor(identity: IdentityRuntimeAdmin, pool: ApiTokenPgPool, schemaName?: string) {
    this.identity = identity;
    this.pool = pool;
    this.memberTable = qualifiedMemberTable(schemaName);
  }

  async getOrganizationSession(request: Request): Promise<OrganizationSessionLike | null> {
    try {
      const session = await this.identity.getSession(request);
      const membership = session?.activeMembership;
      if (!session || !membership || session.activeOrganizationId !== membership.organizationId) return null;
      return {
        userId: session.user.id,
        organizationId: membership.organizationId,
        sessionId: session.sessionId,
      };
    } catch {
      return null;
    }
  }

  async getMembership(organizationId: string, userId: string): Promise<MembershipSnapshot | null> {
    try {
      const result = await this.pool.query<{
        organizationId?: unknown;
        userId?: unknown;
        role?: unknown;
      }>(
        `SELECT "organizationId", "userId", "role" FROM ${this.memberTable} WHERE "organizationId" = $1 AND "userId" = $2 LIMIT 1`,
        [organizationId, userId],
      );
      const row = result.rows[0];
      if (!row || row.organizationId !== organizationId || row.userId !== userId || typeof row.role !== 'string') return null;
      try {
        // Keep bearer authorization on the same role vocabulary as browser
        // sessions. Better Auth's built-in member role is normalized to
        // reader; unknown roles, including manager, fail closed.
        const role: ApiTokenIdentityRole = normalizeIdentityRole(row.role);
        return { organizationId, userId, role, active: true };
      } catch {
        return null;
      }
    } catch {
      return null;
    }
  }
}

/**
 * Compose the opt-in Better Auth runtime and company-scoped API-token module
 * for the Node host. Better Auth remains disabled unless explicitly enabled.
 */
export function createIdentityInfrastructure(
  env: IdentityEnvironment,
  options: IdentityInfrastructureOptions = {},
): IdentityInfrastructure {
  if (!options.postgresPool) {
    const identity = createIdentityRuntimeFromEnv(env);
    if (!identity) return { identity: null, apiTokens: null, companySso: null };
    throw new Error('Better Auth API tokens require a shared PostgreSQL pool');
  }

  const configuredCompanySsoTable = companySsoTableName(env, options);
  const companySsoAutoMigrate = options.companySsoAutoMigrate ?? parseBoolean(
    env.PSKILLS_COMPANY_SSO_AUTO_MIGRATE ?? env.COMPANY_SSO_AUTO_MIGRATE,
    false,
  );
  const appOrigin = options.canonicalOrigin ?? canonicalOriginFromEnv(env);
  const companySsoRepository = createPostgresCompanySsoRepository(options.postgresPool, {
    ...(configuredCompanySsoTable === undefined ? {} : { tableName: configuredCompanySsoTable }),
    autoMigrate: companySsoAutoMigrate,
  });
  const identity = createIdentityRuntimeFromEnv(env, {
    plugins: [createCompanySsoPlugin({ repository: companySsoRepository })],
    trustedOrigins: (request) => companySsoTrustedOrigins(request, companySsoRepository),
  });
  if (!identity) return { identity: null, apiTokens: null, companySso: null };

  const schemaName = env.PSKILLS_BETTER_AUTH_SCHEMA?.trim() || env.BETTER_AUTH_SCHEMA?.trim();
  const membershipAuthorizer = new PostgresBetterAuthMembershipAuthorizer(identity, options.postgresPool, schemaName);
  const repository = createPostgresApiTokenRepository(options.postgresPool, {
    ...(options.apiTokenTableName === undefined ? {} : { tableName: options.apiTokenTableName }),
    autoMigrate: options.apiTokenAutoMigrate ?? parseBoolean(env.PSKILLS_API_TOKEN_AUTO_MIGRATE ?? env.API_TOKEN_AUTO_MIGRATE, false),
  });
  const apiTokens = createApiTokenModule({
    repository,
    membershipAuthorizer,
    canonicalOrigin: appOrigin,
    missingOrigin: 'deny',
    sessionSecret: sessionSecretFromEnv(env),
    sessionCookieName: env.PSKILLS_SESSION_COOKIE?.trim() || DEFAULT_API_TOKEN_SESSION_COOKIE,
    sessionSecureCookies: env.PSKILLS_ENVIRONMENT?.trim().toLowerCase() !== 'development'
      && env.PSKILLS_ENVIRONMENT?.trim().toLowerCase() !== 'test',
  });
  const companySso = createCompanySsoModule({
    repository: companySsoRepository,
    authorizer: createCompanySsoAuthorizer(identity),
    appOrigin,
    allowLoopbackHttp: env.PSKILLS_ENVIRONMENT === 'development' || env.PSKILLS_ENVIRONMENT === 'test',
    autoMigrate: companySsoAutoMigrate,
    bridge: createCompanySsoBetterAuthBridge(identity.auth),
  });
  return { identity, apiTokens, companySso };
}

function createCompanySsoAuthorizer(identity: IdentityRuntimeAdmin): CompanySsoAuthorizer {
  return {
    authorize: async ({ request, organizationId }) => {
      try {
        const session = await identity.getSession(request);
        const membership = session?.activeMembership;
        if (!session || !membership || session.activeOrganizationId !== organizationId || membership.organizationId !== organizationId) return null;
        if (membership.role !== 'owner' && membership.role !== 'admin') return null;
        return {
          principalId: session.user.id,
          organizationId,
          role: membership.role,
          mode: 'member',
        };
      } catch {
        return null;
      }
    },
  };
}

function companySsoTableName(
  env: IdentityEnvironment,
  options: IdentityInfrastructureOptions,
): string | undefined {
  const value = options.companySsoTableName
    ?? env.PSKILLS_COMPANY_SSO_TABLE_NAME
    ?? env.COMPANY_SSO_TABLE_NAME;
  const normalized = value?.trim();
  return normalized === undefined || normalized === '' ? undefined : normalized;
}

/**
 * Resolve only the configured company's IdP origins for Better Auth's SSO
 * request. The initial sign-in body and both protocol callback paths carry
 * the server-issued provider id; no request-supplied issuer or domain is
 * accepted as a trusted origin.
 */
async function companySsoTrustedOrigins(
  request: Request | undefined,
  repository: ReturnType<typeof createPostgresCompanySsoRepository>,
): Promise<string[]> {
  const providerId = await providerIdFromSsoRequest(request);
  if (!providerId) return [];
  let record;
  try {
    record = await repository.getByProviderId(providerId);
  } catch {
    return [];
  }
  if (!record || record.status !== 'active') return [];
  const candidates = record.protocol === 'oidc'
    ? [record.issuer, record.oidc?.discoveryUrl, record.oidc?.authorizationEndpoint, record.oidc?.tokenEndpoint, record.oidc?.jwksEndpoint, record.oidc?.userInfoEndpoint]
    : [record.saml?.entryPoint, record.issuer];
  const origins = new Set<string>();
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    try {
      const parsed = new URL(candidate);
      if ((parsed.protocol === 'https:' || parsed.protocol === 'http:') && !parsed.username && !parsed.password) origins.add(parsed.origin);
    } catch {
      // The registry validator rejects malformed provider URLs. A malformed
      // row is not allowed to widen the Better Auth trusted-origin set.
    }
  }
  return [...origins];
}

async function providerIdFromSsoRequest(request: Request | undefined): Promise<string | undefined> {
  if (!request) return undefined;
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return undefined;
  }
  const callback = /\/sso\/(?:callback|saml2\/sp\/acs)\/([^/]+)$/u.exec(url.pathname);
  if (callback?.[1]) {
    try {
      return decodeURIComponent(callback[1]);
    } catch {
      return undefined;
    }
  }
  if (!url.pathname.endsWith('/sign-in/sso')) return undefined;
  try {
    const body = await request.clone().json() as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
    const providerId = (body as { providerId?: unknown }).providerId;
    return typeof providerId === 'string' && providerId.trim() !== '' ? providerId.trim() : undefined;
  } catch {
    return undefined;
  }
}

function qualifiedMemberTable(schemaName: string | undefined): string {
  if (!schemaName) return '"member"';
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(schemaName)) throw new Error('Better Auth schema name is invalid');
  return `"${schemaName}"."member"`;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  throw new Error('API token auto-migration setting is invalid');
}
