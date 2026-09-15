import {
  createIdentityRuntimeFromEnv,
  normalizeIdentityRole,
  seatOperationKey,
  type IdentityEnvironment,
  type IdentityBillingAdmission,
  type IdentityRuntimeAdmin,
  PostgresIdentityOperationsEventStore,
  type IdentityOperationsEventSink,
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
  BillingError,
  type BillingSeatRecoveryProof,
  type BillingSeatRecoveryResult,
  type BillingSeatReservation,
  type BillingService,
} from '../../../packages/billing/src/index.js';
import {
  createApiTokenModule,
  createPostgresApiTokenRepository,
  DEFAULT_API_TOKEN_SESSION_COOKIE,
  type ApiTokenModule,
  type ApiTokenPgExecutor,
  type ApiTokenPgPool,
  type IdentityRole as ApiTokenIdentityRole,
  type MembershipAuthorizer,
  type MembershipSnapshot,
  type OrganizationSessionLike,
} from '../../../packages/api-tokens/src/index.js';
import type { PrincipalDisplayMetadata } from '../../../packages/contracts/src/index.js';
import { canonicalOriginFromEnv } from './identity-origin.js';

export { canonicalOriginFromEnv } from './identity-origin.js';

/** The identity package intentionally keeps its database implementation private. */
export interface IdentityInfrastructureOptions {
  /** A PostgreSQL pool shared with the metadata repository when available. */
  postgresPool?: ApiTokenPgPool;
  /** Trusted deployment origin used for cookie-authenticated token mutations. */
  canonicalOrigin?: string;
  /** Optional billing service used for identity seat admission. */
  billing?: BillingService;
  apiTokenTableName?: string;
  /** Optional PostgreSQL schema for API tokens; public remains the default. */
  apiTokenSchemaName?: string;
  apiTokenAutoMigrate?: boolean;
  companySsoTableName?: string;
  companySsoAutoMigrate?: boolean;
  operationsEventsTableName?: string;
  operationsEventsAutoMigrate?: boolean;
  operationsEventsRetentionDays?: number;
  operationsEventsCleanupBatchSize?: number;
}

export interface IdentityInfrastructure {
  identity: IdentityRuntimeAdmin | null;
  apiTokens: ApiTokenModule | null;
  /** Server-only Better Auth hold inspection and recovery. */
  billingRecovery?: IdentitySeatRecovery;
  companySso: CompanySsoModule | null;
  operationsEvents: IdentityOperationsEventSink | null;
  /** Resolves only after opted-in identity, company SSO, API-token, and operations-event migrations finish. */
  ready: Promise<void>;
  /** Runs all reviewed identity and API-token migrations explicitly for a controlled deployment job. */
  runMigrations: () => Promise<void>;
}

export type IdentitySeatSubjectKind = 'member' | 'invitation';

/**
 * The subject is carried by the operator request so the adapter can derive
 * and verify the opaque operation key. It is never accepted from a tenant
 * billing principal.
 */
export interface IdentitySeatRecoveryRequest {
  organizationId: string;
  operationKey: string;
  subjectKind: IdentitySeatSubjectKind;
  subjectId: string;
  proof: BillingSeatRecoveryProof;
}

/**
 * Internal platform recovery capability. Runtime code should expose this only
 * behind an operator or server-worker authenticator; company owner/admin
 * routes deliberately do not receive it.
 */
export interface IdentitySeatRecovery {
  activeSeatReservations(organizationId: string): Promise<readonly BillingSeatReservation[]>;
  recoverFailedSeat(input: IdentitySeatRecoveryRequest): Promise<BillingSeatRecoveryResult>;
}

/**
 * Keep seat admission at the Better Auth boundary. Identity owns the
 * authoritative member and pending-invitation rows; billing owns the durable
 * usage ledger and enforces the configured plan limit.
 */
export class PostgresIdentityBillingAdmission implements IdentityBillingAdmission {
  private readonly billing: BillingService;
  private readonly pool: ApiTokenPgPool;
  private readonly memberTable: string;
  private readonly invitationTable: string;

  constructor(billing: BillingService, pool: ApiTokenPgPool, schemaName?: string) {
    this.billing = billing;
    this.pool = pool;
    this.memberTable = qualifiedMemberTable(schemaName);
    this.invitationTable = qualifiedInvitationTable(schemaName);
  }

  async reserveNewSeat(organizationId: string, operationKey: string): Promise<void> {
    await this.syncSeats(organizationId, `${operationKey}:sync`);
    await this.billing.reserveSeat(organizationId, operationKey, { subjectKey: true });
  }

  async releaseSeat(organizationId: string, operationKey: string): Promise<void> {
    await this.billing.releaseSeat(organizationId, operationKey);
  }

  async commitSeat(organizationId: string, operationKey: string): Promise<void> {
    await this.billing.commitSeat(organizationId, operationKey);
  }

  async activeSeatReservations(organizationId: string): Promise<readonly BillingSeatReservation[]> {
    return this.billing.activeSeatReservations(organizationId);
  }

  async syncSeats(organizationId: string, operationKey: string): Promise<void> {
    const observedRevision = await this.billing.seatRevision(organizationId);
    const result = await this.pool.query<{
      kind?: unknown;
      subjectId?: unknown;
    }>(
      `SELECT 'member' AS "kind", "id" AS "subjectId"
         FROM ${this.memberTable}
        WHERE "organizationId" = $1
       UNION ALL
       SELECT 'invitation' AS "kind", "id" AS "subjectId"
         FROM ${this.invitationTable}
        WHERE "organizationId" = $1
          AND "status" = 'pending'
          AND "expiresAt" > now()`,
      [organizationId],
    );
    const subjectOperationKeys = await Promise.all(result.rows.map(async (row) => {
      if ((row.kind !== 'member' && row.kind !== 'invitation') || typeof row.subjectId !== 'string' || row.subjectId.trim() === '') {
        throw new Error('Better Auth returned an invalid organization seat identity');
      }
      return seatOperationKey(row.kind, organizationId, row.subjectId);
    }));
    await this.billing.syncSeatSubjects(organizationId, subjectOperationKeys, operationKey, observedRevision);
  }

  /**
   * Recover one Better Auth hold after a platform writer has failed. The
   * transaction-scoped advisory lock is the same lock held around every
   * Better Auth organization request by the identity runtime. Holding it
   * across the row check and billing release makes the check authoritative:
   * a committed member/invitation is observed and rejected, while a failed
   * request has no row and can be released safely.
   */
  async recoverFailedSeat(input: IdentitySeatRecoveryRequest): Promise<BillingSeatRecoveryResult> {
    const organizationId = validateIdentityRecoveryOrganization(input.organizationId);
    const operationKey = validateIdentityRecoveryString(input.operationKey, 'operationKey');
    const subjectId = validateIdentityRecoveryString(input.subjectId, 'subjectId');
    if (input.subjectKind !== 'member' && input.subjectKind !== 'invitation') {
      throw new BillingError('INVALID_SEAT_RECOVERY_SUBJECT', 'The Better Auth seat subject kind is invalid', 400);
    }
    if (!input.proof || input.proof.kind !== 'writer-terminated') {
      throw new BillingError('SEAT_RECOVERY_PROOF_UNTRUSTED', 'Only a platform writer-termination proof can recover a seat hold', 403);
    }
    const expectedOperationKey = await seatOperationKey(input.subjectKind, organizationId, subjectId);
    if (expectedOperationKey !== operationKey) {
      throw new BillingError('SEAT_RECOVERY_SUBJECT_MISMATCH', 'The seat hold does not match the requested identity subject', 409);
    }
    return this.withOrganizationMutationLock(async (connection) => {
      const table = input.subjectKind === 'member' ? this.memberTable : this.invitationTable;
      const result = await connection.query<{ present?: unknown }>(
        `SELECT 1 AS "present" FROM ${table} WHERE "organizationId" = $1 AND "id" = $2 LIMIT 1`,
        [organizationId, subjectId],
      );
      if (result.rows.length > 0) {
        throw new BillingError('SEAT_RECOVERY_CONFLICT', 'The Better Auth identity row already exists; use its lifecycle hook', 409);
      }
      return this.billing.releaseSeatAfterFailure(organizationId, operationKey, input.proof);
    });
  }

  /** Keep the lock connection open while the identity row and billing hold are checked. */
  private async withOrganizationMutationLock<T>(operation: (connection: ApiTokenPgExecutor) => Promise<T>): Promise<T> {
    const connection = await this.pool.connect();
    let transactionStarted = false;
    try {
      await connection.query('BEGIN');
      transactionStarted = true;
      await connection.query('SELECT pg_advisory_xact_lock($1)', [IDENTITY_ORGANIZATION_MUTATION_LOCK_KEY]);
      const result = await operation(connection);
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      if (transactionStarted) await connection.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await connection.release?.();
    }
  }
}

function validateIdentityRecoveryOrganization(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new BillingError('INVALID_SEAT_RECOVERY_SUBJECT', 'The Better Auth seat organization is invalid', 400);
  }
  return value.trim();
}

function validateIdentityRecoveryString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new BillingError('INVALID_SEAT_RECOVERY_SUBJECT', `The Better Auth seat ${field} is invalid`, 400);
  }
  return value.trim();
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
  private readonly userTable: string;
  private readonly organizationTable: string;

  constructor(identity: IdentityRuntimeAdmin, pool: ApiTokenPgPool, schemaName?: string) {
    this.identity = identity;
    this.pool = pool;
    this.memberTable = qualifiedMemberTable(schemaName);
    this.userTable = qualifiedIdentityTable(schemaName, 'user');
    this.organizationTable = qualifiedIdentityTable(schemaName, 'organization');
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
        const display = await this.lookupDisplayMetadata(organizationId, userId);
        return { organizationId, userId, role, active: true, ...(display === undefined ? {} : { display }) };
      } catch {
        return null;
      }
    } catch {
      return null;
    }
  }

  /**
   * Resolve labels only after the membership row has passed the live role
   * check. A metadata query failure must not alter an otherwise valid access
   * decision, so this helper intentionally returns no display block on error.
   */
  private async lookupDisplayMetadata(organizationId: string, userId: string): Promise<PrincipalDisplayMetadata | undefined> {
    try {
      const result = await this.pool.query<{
        userName?: unknown;
        userEmail?: unknown;
        organizationName?: unknown;
        organizationSlug?: unknown;
      }>(
        `SELECT u."name" AS "userName", u."email" AS "userEmail", o."name" AS "organizationName", o."slug" AS "organizationSlug" FROM ${this.userTable} AS u JOIN ${this.organizationTable} AS o ON o."id" = $1 WHERE u."id" = $2 LIMIT 1`,
        [organizationId, userId],
      );
      const row = result.rows[0];
      if (!row) return undefined;
      return {
        ...(typeof row.userName === 'string' ? { userName: row.userName } : {}),
        ...(typeof row.userEmail === 'string' ? { userEmail: row.userEmail } : {}),
        ...(typeof row.organizationName === 'string' ? { organizationName: row.organizationName } : {}),
        ...(typeof row.organizationSlug === 'string' ? { organizationSlug: row.organizationSlug } : {}),
      };
    } catch {
      return undefined;
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
    if (!identity) return { identity: null, apiTokens: null, companySso: null, operationsEvents: null, ready: Promise.resolve(), runMigrations: async () => undefined };
    throw new Error('Better Auth API tokens require a shared PostgreSQL pool');
  }

  const configuredCompanySsoTable = companySsoTableName(env, options);
  const companySsoAutoMigrate = options.companySsoAutoMigrate ?? parseBoolean(
    env.PSKILLS_COMPANY_SSO_AUTO_MIGRATE ?? env.COMPANY_SSO_AUTO_MIGRATE,
    false,
  );
  const identitySchemaName = env.PSKILLS_BETTER_AUTH_SCHEMA?.trim() || env.BETTER_AUTH_SCHEMA?.trim();
  const appOrigin = options.canonicalOrigin ?? canonicalOriginFromEnv(env);
  const companySsoRepository = createPostgresCompanySsoRepository(options.postgresPool, {
    ...(configuredCompanySsoTable === undefined ? {} : { tableName: configuredCompanySsoTable }),
    ...(identitySchemaName === undefined ? {} : { schemaName: identitySchemaName }),
    autoMigrate: companySsoAutoMigrate,
  });
  let operationsEvents: IdentityOperationsEventSink | undefined;
  const billingAdmission = options.billing && options.billing.status().usageEnforcement
    ? new PostgresIdentityBillingAdmission(options.billing, options.postgresPool, identitySchemaName)
    : undefined;
  const identity = createIdentityRuntimeFromEnv(env, {
    plugins: [createCompanySsoPlugin({ repository: companySsoRepository })],
    trustedOrigins: (request) => companySsoTrustedOrigins(request, companySsoRepository),
    onOperationalFailure: (failure) => operationsEvents?.recordGlobal(failure),
    ...(billingAdmission === undefined ? {} : { billing: billingAdmission }),
  });
  if (!identity) return { identity: null, apiTokens: null, companySso: null, operationsEvents: null, ready: Promise.resolve(), runMigrations: async () => undefined };

  const schemaName = env.PSKILLS_BETTER_AUTH_SCHEMA?.trim() || env.BETTER_AUTH_SCHEMA?.trim();
  const membershipAuthorizer = new PostgresBetterAuthMembershipAuthorizer(identity, options.postgresPool, schemaName);
  const configuredApiTokenSchema = apiTokenSchemaName(env, options);
  const apiTokenAutoMigrate = options.apiTokenAutoMigrate ?? parseBoolean(
    env.PSKILLS_API_TOKEN_AUTO_MIGRATE ?? env.API_TOKEN_AUTO_MIGRATE,
    false,
  );
  const configuredOperationsEventsTable = operationsEventsTableName(env, options);
  const operationsEventsStore = new PostgresIdentityOperationsEventStore({
    pool: options.postgresPool,
    ...(configuredOperationsEventsTable === undefined ? {} : { tableName: configuredOperationsEventsTable }),
    ...(identitySchemaName === undefined ? {} : { schemaName: identitySchemaName }),
    retentionDays: options.operationsEventsRetentionDays ?? parseBoundedInteger(
      env.PSKILLS_IDENTITY_OPERATIONS_EVENTS_RETENTION_DAYS ?? env.IDENTITY_OPERATIONS_EVENTS_RETENTION_DAYS,
      30,
      1,
      365,
      'identity operations retention days',
    ),
    cleanupBatchSize: options.operationsEventsCleanupBatchSize ?? parseBoundedInteger(
      env.PSKILLS_IDENTITY_OPERATIONS_EVENTS_CLEANUP_BATCH_SIZE ?? env.IDENTITY_OPERATIONS_EVENTS_CLEANUP_BATCH_SIZE,
      1_000,
      1,
      10_000,
      'identity operations cleanup batch size',
    ),
    verifyTenant: async (organizationId, userId) => {
      const membership = await membershipAuthorizer.getMembership(organizationId, userId);
      if (!membership || typeof membership.role !== 'string') return null;
      const role = membership.role;
      return role === 'owner' || role === 'admin' || role === 'publisher' || role === 'reader'
        ? { organizationId, userId, role }
        : null;
    },
  });
  operationsEvents = operationsEventsStore;
  const repository = createPostgresApiTokenRepository(options.postgresPool, {
    ...(options.apiTokenTableName === undefined ? {} : { tableName: options.apiTokenTableName }),
    ...(configuredApiTokenSchema === undefined ? {} : { schemaName: configuredApiTokenSchema }),
    autoMigrate: apiTokenAutoMigrate,
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
  // Better Auth, the private company table, and service-token table are
  // separate reviewed migrations. An explicitly opted-in startup waits for
  // each enabled migration before the Node handler is exposed.
  const runMigrations = async (): Promise<void> => {
    await identity.runMigrations();
    await companySsoRepository.runMigrations();
    await repository.runMigrations();
    await operationsEventsStore.runMigrations();
    await operationsEventsStore.cleanup();
  };
  const ready = identity.ready.then(async () => {
    if (companySsoAutoMigrate) await companySsoRepository.runMigrations();
    if (apiTokenAutoMigrate) await repository.runMigrations();
    if (operationsEventsAutoMigrate(options, env)) {
      await operationsEventsStore.runMigrations();
      await operationsEventsStore.cleanup();
    }
  });
  void ready.catch(() => undefined);
  return {
    identity,
    apiTokens,
    companySso,
    operationsEvents: operationsEventsStore,
    ready,
    runMigrations,
    ...(billingAdmission === undefined ? {} : { billingRecovery: billingAdmission }),
  };
}

function operationsEventsAutoMigrate(options: IdentityInfrastructureOptions, env: IdentityEnvironment): boolean {
  return options.operationsEventsAutoMigrate ?? parseBoolean(
    env.PSKILLS_IDENTITY_OPERATIONS_EVENTS_AUTO_MIGRATE ?? env.IDENTITY_OPERATIONS_EVENTS_AUTO_MIGRATE,
    false,
  );
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

function apiTokenSchemaName(
  env: IdentityEnvironment,
  options: IdentityInfrastructureOptions,
): string | undefined {
  const value = options.apiTokenSchemaName
    ?? env.PSKILLS_API_TOKEN_SCHEMA
    ?? env.API_TOKEN_SCHEMA;
  const normalized = value?.trim();
  return normalized === undefined || normalized === '' ? undefined : normalized;
}

function operationsEventsTableName(
  env: IdentityEnvironment,
  options: IdentityInfrastructureOptions,
): string | undefined {
  const value = options.operationsEventsTableName
    ?? env.PSKILLS_IDENTITY_OPERATIONS_EVENTS_TABLE_NAME
    ?? env.IDENTITY_OPERATIONS_EVENTS_TABLE_NAME;
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
  return qualifiedIdentityTable(schemaName, 'member');
}

function qualifiedInvitationTable(schemaName: string | undefined): string {
  return qualifiedIdentityTable(schemaName, 'invitation');
}

function qualifiedIdentityTable(schemaName: string | undefined, tableName: 'member' | 'user' | 'organization' | 'invitation'): string {
  if (!schemaName) return `"${tableName}"`;
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(schemaName)) throw new Error('Better Auth schema name is invalid');
  return `"${schemaName}"."${tableName}"`;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  throw new Error('Identity infrastructure boolean setting is invalid');
}

function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  if (value === undefined || value.trim() === '') return fallback;
  if (!/^\d+$/u.test(value.trim())) throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  return parsed;
}
