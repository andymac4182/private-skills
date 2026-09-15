import {
  createIdentityRuntimeFromEnv,
  normalizeIdentityRole,
  type IdentityEnvironment,
  type IdentityRuntimeAdmin,
} from '../../../packages/identity/src/index.js';
import {
  createApiTokenModule,
  createPostgresApiTokenRepository,
  type ApiTokenModule,
  type ApiTokenPgPool,
  type IdentityRole as ApiTokenIdentityRole,
  type MembershipAuthorizer,
  type MembershipSnapshot,
  type OrganizationSessionLike,
} from '../../../packages/api-tokens/src/index.js';

/** The identity package intentionally keeps its database implementation private. */
export interface IdentityInfrastructureOptions {
  /** A PostgreSQL pool shared with the metadata repository when available. */
  postgresPool?: ApiTokenPgPool;
  /** Trusted deployment origin used for cookie-authenticated token mutations. */
  canonicalOrigin?: string;
  apiTokenTableName?: string;
  apiTokenAutoMigrate?: boolean;
}

export interface IdentityInfrastructure {
  identity: IdentityRuntimeAdmin | null;
  apiTokens: ApiTokenModule | null;
}

/**
 * Resolve the origin used by server-side CSRF checks from deployment
 * configuration. A request Host or Origin header is never used as the
 * canonical value.
 */
export function canonicalOriginFromEnv(env: IdentityEnvironment): string {
  const value = env.BETTER_AUTH_URL?.trim() || env.PSKILLS_PUBLIC_ORIGIN?.trim() || env.PSKILLS_API_URL?.trim() || 'http://localhost:5173';
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Trusted identity origin is invalid');
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.origin === 'null' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Trusted identity origin is invalid');
  }
  return parsed.origin;
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
  const identity = createIdentityRuntimeFromEnv(env);
  if (!identity) return { identity: null, apiTokens: null };
  if (!options.postgresPool) {
    throw new Error('Better Auth API tokens require a shared PostgreSQL pool');
  }

  const schemaName = env.PSKILLS_BETTER_AUTH_SCHEMA?.trim() || env.BETTER_AUTH_SCHEMA?.trim();
  const membershipAuthorizer = new PostgresBetterAuthMembershipAuthorizer(identity, options.postgresPool, schemaName);
  const repository = createPostgresApiTokenRepository(options.postgresPool, {
    ...(options.apiTokenTableName === undefined ? {} : { tableName: options.apiTokenTableName }),
    autoMigrate: options.apiTokenAutoMigrate ?? parseBoolean(env.PSKILLS_API_TOKEN_AUTO_MIGRATE ?? env.API_TOKEN_AUTO_MIGRATE, false),
  });
  const apiTokens = createApiTokenModule({
    repository,
    membershipAuthorizer,
    canonicalOrigin: options.canonicalOrigin ?? canonicalOriginFromEnv(env),
    missingOrigin: 'deny',
  });
  return { identity, apiTokens };
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
