import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { betterAuth } from 'better-auth';
import { makeSignature } from 'better-auth/crypto';
import { getMigrations } from 'better-auth/db/migration';
import { PostgresJSDialect } from 'kysely-postgres-js';
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createIdentityRuntime,
  createIdentityRuntimeConfig,
  PostgresIdentityOperationsEventStore,
  type IdentityRuntimeAdmin,
  type IdentityOperationsRole,
} from '../packages/identity/src/index.js';
import {
  companySsoSchemaSql,
  createPostgresCompanySsoRepository,
  createCompanySsoPlugin,
  MemoryCompanySsoRepository,
  type CompanySsoPgPool,
  type CompanySsoProviderRecord,
} from '../packages/identity/src/company-sso.js';
import {
  DefaultApiTokenService,
  PostgresApiTokenRepository,
  postgresApiTokenSchemaSql,
  type ApiTokenPgPool,
  type ApiTokenRecord,
  type IdentityRole,
  type MembershipAuthorizer,
} from '../packages/api-tokens/src/index.js';
import {
  BillingService,
  PostgresBillingRepository,
  billingPostgresSchemaSql,
  createPlanCatalog,
  createTestSubscriptionEvent,
  signWebhookPayload,
  type BillingPgPoolLike,
  type BillingProvider,
  type PlanCatalog,
} from '../packages/billing/src/index.js';
import {
  HostedWorkerDispatchLeaseError,
  PostgresStateRepository,
  defaultRegistryState,
  PostgresHostedWorkerDispatchStore,
  hostedWorkerDispatchSchemaSql,
  postgresStateSchemaSql,
  type PgPoolLike,
} from '../packages/database/src/index.js';
import { createRegistryHandler, type RegistryHandler } from '../packages/core/src/index.js';
import { createTenantHandlerRouter } from '../apps/web/server/tenant-runtime.js';
import { StateRepositoryTenantReviewDispatchLedger } from '../apps/web/server/tenant-review-dispatch.js';
import { FilesSdkBlobStore, digestBytes } from '../packages/storage/src/index.js';
import { createNodeFilesClient } from '../packages/storage/src/node.js';
import type {
  Authenticator,
  BlobStore,
  RegistryConfiguration,
  RegistryState,
  SkillVersion,
  StoredBlob,
} from '../packages/contracts/src/index.js';

/**
 * This is an opt-in, loopback-only rehearsal. A production or non-loopback
 * URL is intentionally treated as absent so the test cannot become a remote
 * backup or restore probe.
 */
function loopbackDatabaseUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') return undefined;
    if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname.toLowerCase())) return undefined;
    return value.trim();
  } catch {
    return undefined;
  }
}

const DATABASE_URL = loopbackDatabaseUrl(process.env.PSKILLS_OPERATIONS_POSTGRES_URL)
  ?? loopbackDatabaseUrl(process.env.PSKILLS_IDENTITY_TEST_DATABASE_URL);
const local = describe.skipIf(!DATABASE_URL);

const ORIGIN = 'http://127.0.0.1:5173';
const IDENTITY_SECRET = 'operations-postgres-rehearsal-secret-0123456789';
const BILLING_SECRET = 'operations-postgres-webhook-secret';
const NOW = Date.now();
const ORG_A = 'operations-org-a';
const ORG_B = 'operations-org-b';
const USER_A = 'operations-user-a';
const USER_B = 'operations-user-b';
const SESSION_A = 'operations-session-a';
const SESSION_B = 'operations-session-b';
const TOKEN_A = 'psk_operations_token_a';
const TOKEN_B = 'psk_operations_token_b';
const WORKER_TOKEN_A = 'operations-worker-token-a';
const WORKER_JOB_A = 'operations-worker-job-a';
const WORKER_JOB_B = 'operations-worker-job-b';
const STORAGE_ATTEMPT_A = 'operations-storage-attempt-a';
const STORAGE_ATTEMPT_B = 'operations-storage-attempt-b';
const DISPATCH_CURSOR_ORGANIZATION_ID = '__private_skills_tenant_review_dispatch__';
const DISPATCH_DAY = new Date(NOW).toISOString().slice(0, 10);
const DISPATCH_OPERATION_A = `common-skill-review:${DISPATCH_DAY}`;

type SqlClient = ReturnType<typeof postgres>;
type QueryResult<Row = Record<string, unknown>> = { rows: Row[]; rowCount?: number };

interface TableSnapshot {
  count: number;
  digest: string;
}

/** Compatibility view for the billing/worker owner field until all hosts
 * consume the durable metered reservation key. */
type RehearsalJob = RegistryState['jobs'][number] & { meteredReservationKey?: string };
type RehearsalStorageAttempt = {
  id: string;
  organizationId: string;
  reservationKey: string;
  digest: StoredBlob['digest'];
  size: number;
  state: 'pending' | 'committed' | 'orphaned' | 'released';
  createdAt: string;
  updatedAt: string;
  objectKey?: string;
  jobId?: string;
};
type RecoveryRegistryState = RegistryState & { storageAttempts?: RehearsalStorageAttempt[] };

async function objectManifest(store: FilesSdkBlobStore, objects: readonly StoredBlob[]): Promise<TableSnapshot> {
  const rows: string[] = [];
  for (const object of objects) {
    const bytes = await store.getVerified(object.key, object.digest);
    rows.push(JSON.stringify({ key: object.key, digest: object.digest, size: bytes.byteLength }));
  }
  rows.sort();
  return { count: rows.length, digest: createHash('sha256').update(rows.join('\n')).digest('hex') };
}

function identifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value) || value.length > 63) throw new Error('invalid rehearsal identifier');
  return `"${value}"`;
}

function qualifiedSchema(schema: string, table: string): string {
  return `${identifier(schema)}.${identifier(table)}`;
}

function publicTable(table: string): string {
  return identifier(table);
}

async function query<Row = Record<string, unknown>>(
  connection: SqlClient,
  statement: string,
  parameters: readonly unknown[] = [],
): Promise<QueryResult<Row>> {
  const rows = await connection.unsafe<Row[]>(statement, [...parameters] as never[]);
  return { rows: [...rows], rowCount: rows.count };
}

function pgPool(sql: SqlClient): PgPoolLike & ApiTokenPgPool & BillingPgPoolLike & CompanySsoPgPool {
  const pool = {
    query: <Row = Record<string, unknown>>(statement: string, parameters?: readonly unknown[]) => query<Row>(sql, statement, parameters),
    connect: async () => {
      const reserved = await sql.reserve();
      return {
        query: <Row = Record<string, unknown>>(statement: string, parameters?: readonly unknown[]) => query<Row>(reserved as unknown as SqlClient, statement, parameters),
        release: () => reserved.release(),
      };
    },
  };
  return pool as PgPoolLike & ApiTokenPgPool & BillingPgPoolLike & CompanySsoPgPool;
}

function name(prefix: string, runId: string, suffix: string): string {
  const value = `${prefix}_${runId}_${suffix}`;
  if (value.length > 63) throw new Error(`rehearsal identifier is too long: ${value.length}`);
  return value;
}

async function tableSnapshot(sql: SqlClient, table: string): Promise<TableSnapshot> {
  const result = await sql.unsafe<Record<string, unknown>[]>(`SELECT * FROM ${table}`);
  const rows = result.map((row) => JSON.stringify(row)).sort();
  return { count: rows.length, digest: createHash('sha256').update(rows.join('\n')).digest('hex') };
}

async function copyTable(sql: SqlClient, source: string, target: string): Promise<void> {
  await sql.unsafe(`INSERT INTO ${target} SELECT * FROM ${source}`);
}

async function identityTables(sql: SqlClient, schema: string): Promise<string[]> {
  const result = await sql.unsafe<{ tablename: string }[]>(
    `SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = $1 ORDER BY tablename`,
    [schema],
  );
  return result.map((row) => row.tablename);
}

async function copyIdentitySchema(sql: SqlClient, sourceSchema: string, targetSchema: string): Promise<Map<string, TableSnapshot>> {
  const sourceTables = await identityTables(sql, sourceSchema);
  const targetTables = await identityTables(sql, targetSchema);
  expect(targetTables).toEqual(sourceTables);
  const order = ['user', 'organization', 'account', 'session', 'verification', 'member', 'invitation', 'rateLimit', 'ssoProvider'];
  const ordered = [...order.filter((table) => sourceTables.includes(table)), ...sourceTables.filter((table) => !order.includes(table))];
  const manifest = new Map<string, TableSnapshot>();
  for (const table of ordered) {
    const source = qualifiedSchema(sourceSchema, table);
    const target = qualifiedSchema(targetSchema, table);
    manifest.set(`identity:${table}`, await tableSnapshot(sql, source));
    await copyTable(sql, source, target);
  }
  return manifest;
}

async function copyPublicTables(
  sql: SqlClient,
  sourceTables: readonly [string, string][],
): Promise<Map<string, TableSnapshot>> {
  const manifest = new Map<string, TableSnapshot>();
  for (const [sourceName, targetName] of sourceTables) {
    const source = publicTable(sourceName);
    const target = publicTable(targetName);
    manifest.set(targetName, await tableSnapshot(sql, source));
    await copyTable(sql, source, target);
  }
  return manifest;
}

async function compareManifest(
  sql: SqlClient,
  manifest: ReadonlyMap<string, TableSnapshot>,
  targetNames: ReadonlyMap<string, string>,
): Promise<void> {
  for (const [logical, expected] of manifest) {
    const target = targetNames.get(logical);
    if (!target) throw new Error(`missing target for ${logical}`);
    await expect(tableSnapshot(sql, target)).resolves.toEqual(expected);
  }
}

function identity(schema: string, databaseURL: string): IdentityRuntimeAdmin {
  return createIdentityRuntime(createIdentityRuntimeConfig({
    PSKILLS_BETTER_AUTH_ENABLED: 'true',
    DATABASE_URL: databaseURL,
    BETTER_AUTH_SECRET: IDENTITY_SECRET,
    BETTER_AUTH_URL: ORIGIN,
    PSKILLS_BETTER_AUTH_SCHEMA: schema,
    PSKILLS_BETTER_AUTH_VALIDATE_SCHEMA: 'false',
  }));
}

/** Mount the adopted Better Auth SSO schema so the mirror row is part of the rehearsal. */
function ssoMirrorAuth(schema: string, sql: SqlClient) {
  return betterAuth({
    appName: 'Operations SSO mirror rehearsal',
    baseURL: ORIGIN,
    basePath: '/api/auth',
    secret: IDENTITY_SECRET,
    database: {
      dialect: new PostgresJSDialect({ postgres: sql }),
      type: 'postgres',
      transaction: true,
      schemaName: schema,
    },
    plugins: [createCompanySsoPlugin({ repository: new MemoryCompanySsoRepository() })],
    trustedOrigins: [ORIGIN],
    advanced: {
      database: { validateSchema: false },
      useSecureCookies: false,
      skipTrailingSlashes: true,
    },
  });
}

interface SsoMirrorHandle {
  $context: PromiseLike<{
    adapter: {
      create(input: { model: string; data: Record<string, unknown>; forceAllowId?: boolean }): Promise<unknown>;
    };
  }>;
}

async function seedIdentity(runtime: IdentityRuntimeAdmin): Promise<void> {
  const context = await runtime.auth.$context;
  const now = new Date(NOW);
  for (const [id, email] of [[USER_A, 'owner-a@operations.test'], [USER_B, 'owner-b@operations.test']] as const) {
    await context.adapter.create({
      model: 'user',
      data: { id, name: id, email, emailVerified: true, createdAt: now, updatedAt: now },
      forceAllowId: true,
    });
  }
  for (const [id, nameValue, userId, sessionId, token] of [
    [ORG_A, 'Operations A', USER_A, SESSION_A, 'operations-session-token-a'],
    [ORG_B, 'Operations B', USER_B, SESSION_B, 'operations-session-token-b'],
  ] as const) {
    await context.adapter.create({
      model: 'organization',
      data: { id, name: nameValue, slug: id, createdAt: now },
      forceAllowId: true,
    });
    await context.adapter.create({
      model: 'member',
      data: { id: `${id}-member`, organizationId: id, userId, role: 'owner', createdAt: now },
      forceAllowId: true,
    });
    await context.adapter.create({
      model: 'session',
      data: {
        id: sessionId,
        expiresAt: new Date(NOW + 60 * 60 * 1_000),
        token,
        createdAt: now,
        updatedAt: now,
        userId,
        activeOrganizationId: id,
      },
      forceAllowId: true,
    });
  }
}

/** Seed the adopted Better Auth mirror row through its real adapter. */
async function seedBetterAuthSsoMirror(runtime: SsoMirrorHandle, record: CompanySsoProviderRecord): Promise<void> {
  if (!record.oidc) throw new Error('operations rehearsal expects an OIDC SSO fixture');
  const context = await runtime.$context;
  await context.adapter.create({
    model: 'ssoProvider',
    data: {
      id: record.id,
      issuer: record.issuer,
      oidcConfig: JSON.stringify({
        issuer: record.issuer,
        pkce: true,
        clientId: record.oidc.clientId,
        clientSecret: record.oidc.clientSecret,
        authorizationEndpoint: record.oidc.authorizationEndpoint,
        discoveryEndpoint: record.oidc.discoveryUrl,
        tokenEndpoint: record.oidc.tokenEndpoint,
        jwksEndpoint: record.oidc.jwksEndpoint,
        scopes: [...record.oidc.scopes],
        tokenEndpointAuthentication: 'client_secret_basic',
      }),
      samlConfig: null,
      userId: record.createdBy,
      providerId: record.providerId,
      organizationId: record.organizationId,
      domain: 'company-sso.invalid',
    },
    forceAllowId: true,
  });
}

function tokenHash(token: string): string {
  return `sha256:${createHash('sha256').update(token).digest('hex')}`;
}

function tokenRecord(
  organizationId: string,
  userId: string,
  id: string,
  token: string,
  revokedAt?: string,
): ApiTokenRecord {
  return {
    id,
    organizationId,
    userId,
    name: id,
    tokenHash: tokenHash(token),
    roleCeiling: 'owner',
    scopes: ['registry:*'],
    expiresAt: new Date(NOW + 60 * 60 * 1_000).toISOString(),
    createdAt: new Date(NOW).toISOString(),
    ...(revokedAt ? { revokedAt } : {}),
  };
}

function catalog(): PlanCatalog {
  return createPlanCatalog({
    plans: [
      {
        id: 'free',
        label: 'Free',
        description: 'Operations rehearsal free plan.',
        limits: { seats: 2, storageBytes: 10_000, scansPerMonth: 10, eveCostCentsPerMonth: 100 },
        public: true,
      },
      {
        id: 'team',
        label: 'Team',
        description: 'Operations rehearsal team plan.',
        limits: { seats: 10, storageBytes: 100_000, scansPerMonth: 100, eveCostCentsPerMonth: 10_000 },
        priceId: 'price_operations_team',
        public: true,
      },
    ],
  });
}

function localBillingProvider(): BillingProvider {
  return {
    id: 'local',
    mode: 'test',
    async createCustomer(input) { return { provider: 'local', customerId: `cus_${input.organizationId}` }; },
    async createCheckoutSession(input) { return { provider: 'local', mode: 'test', id: input.idempotencyKey, url: `${ORIGIN}/billing/test` }; },
    async createCustomerPortalSession(input) { return { provider: 'local', mode: 'test', id: input.idempotencyKey, url: `${ORIGIN}/billing/test-portal` }; },
  };
}

async function signedSubscriptionEvent(
  organizationId: string,
  customerId: string,
  subscriptionId: string,
  eventId: string,
): Promise<{ body: string; signature: string }> {
  const body = createTestSubscriptionEvent({
    eventId,
    created: Math.floor(NOW / 1_000),
    organizationId,
    customerId,
    subscriptionId,
    priceId: 'price_operations_team',
    currentPeriodStart: Math.floor(NOW / 1_000),
    currentPeriodEnd: Math.floor((NOW + 30 * 24 * 60 * 60 * 1_000) / 1_000),
  });
  return { body, signature: await signWebhookPayload(body, BILLING_SECRET, Math.floor(NOW / 1_000)) };
}

async function membershipAuthorizer(sql: SqlClient, schema: string): Promise<MembershipAuthorizer> {
  return {
    async getOrganizationSession() { return null; },
    async getMembership(organizationId, userId) {
      const rows = await sql.unsafe<{ organizationId: string; userId: string; role: string }[]>(
        `SELECT "organizationId", "userId", role FROM ${qualifiedSchema(schema, 'member')} WHERE "organizationId" = $1 AND "userId" = $2 LIMIT 1`,
        [organizationId, userId],
      );
      const row = rows[0];
      return row ? { organizationId: row.organizationId, userId: row.userId, role: row.role as IdentityRole, scopes: ['registry:*'], active: true } : null;
    },
  };
}

async function identityOperationsEventStore(
  sql: SqlClient,
  tableName: string,
  authSchema: string,
): Promise<PostgresIdentityOperationsEventStore> {
  return new PostgresIdentityOperationsEventStore({
    pool: pgPool(sql),
    tableName,
    now: () => NOW,
    verifyTenant: async (organizationId, userId) => {
      const rows = await sql.unsafe<{ organizationId: string; userId: string; role: string }[]>(
        `SELECT "organizationId", "userId", role FROM ${qualifiedSchema(authSchema, 'member')} WHERE "organizationId" = $1 AND "userId" = $2 LIMIT 1`,
        [organizationId, userId],
      );
      const row = rows[0];
      if (!row || !['owner', 'admin', 'publisher', 'reader'].includes(row.role)) return null;
      return {
        organizationId: row.organizationId,
        userId: row.userId,
        role: row.role as IdentityOperationsRole,
      };
    },
  });
}

function sessionRequest(cookieValue: string, cookieName: string): Request {
  return new Request(`${ORIGIN}/v1/me`, {
    headers: { cookie: `${cookieName}=${cookieValue}` },
  });
}

async function signedSessionRequest(runtime: IdentityRuntimeAdmin, token: string): Promise<Request> {
  const context = await runtime.auth.$context;
  const cookieName = context.authCookies.sessionToken.name;
  const signature = await makeSignature(token, context.secret);
  return sessionRequest(`${token}.${signature}`, cookieName);
}

function skill(organizationId: string, resourceId: string, artifact: StoredBlob): SkillVersion {
  return {
    id: resourceId,
    organizationId,
    name: '@operations/shared',
    skillName: 'shared',
    version: '1.0.0',
    description: 'Restored operations rehearsal skill.',
    artifact,
    state: 'approved',
    policyRevision: 'operations-rehearsal-policy',
    createdAt: new Date(NOW).toISOString(),
    approvedAt: new Date(NOW).toISOString(),
    provenance: { kind: 'native' },
    fileCount: 1,
    scanIds: [],
  };
}

function registryConfig(organizationId: string): RegistryConfiguration {
  return { publicOrigin: ORIGIN, maxBodyBytes: 2 * 1024 * 1024, organizationId, leaseSeconds: 60 };
}

async function registryHandler(
  context: { organizationId: string; auth: Authenticator },
  repository: PostgresStateRepository,
  blobs: BlobStore,
): Promise<RegistryHandler> {
  return createRegistryHandler({
    repository,
    blobs,
    auth: context.auth,
    config: registryConfig(context.organizationId),
  });
}

local('full tenant PostgreSQL backup and restore rehearsal', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('copies current identity, SSO, token, billing, registry, hosted-worker dispatch, and sealed-object state through the Files SDK filesystem provider', async () => {
    if (!DATABASE_URL) return;
    const runId = `${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const billingRunId = `${process.pid}_${randomUUID().slice(0, 8)}`;
    const sourceAuthSchema = name('ops_auth', runId, 'src');
    const targetAuthSchema = name('ops_auth', runId, 'dst');
    const sourceSso = name('ops_sso', billingRunId, 'src');
    const targetSso = name('ops_sso', billingRunId, 'dst');
    const sourceTokens = name('ops_tokens', runId, 'src');
    const targetTokens = name('ops_tokens', runId, 'dst');
    const sourceRegistry = name('ops_registry', runId, 'src');
    const targetRegistry = name('ops_registry', runId, 'dst');
    const sourceIdentityEvents = name('opsid_events', runId, 'src');
    const targetIdentityEvents = name('opsid_events', runId, 'dst');
    const sourceHostedWorkerDispatch = name('opsw_dispatch', runId, 'src');
    const targetHostedWorkerDispatch = name('opsw_dispatch', runId, 'dst');
    const sourceHostedWorkerRetry = name('opsw_retry', runId, 'src');
    const targetHostedWorkerRetry = name('opsw_retry', runId, 'dst');
    const sourceBillingTable = name('opsbill', billingRunId, 'src');
    const targetBillingTable = name('opsbill', billingRunId, 'dst');
    const sql = postgres(DATABASE_URL, { max: 20, prepare: false });
    const pool = pgPool(sql);
    const sourceIdentity = identity(sourceAuthSchema, DATABASE_URL);
    const targetIdentity = identity(targetAuthSchema, DATABASE_URL);
    const sourceSsoAuth = ssoMirrorAuth(sourceAuthSchema, sql);
    const targetSsoAuth = ssoMirrorAuth(targetAuthSchema, sql);
    const sourceOperationsEvents = await identityOperationsEventStore(sql, sourceIdentityEvents, sourceAuthSchema);
    const targetOperationsEvents = await identityOperationsEventStore(sql, targetIdentityEvents, targetAuthSchema);
    let sourceHostedLeaseSequence = 0;
    let targetHostedLeaseSequence = 0;
    const sourceHostedWorkerStore = new PostgresHostedWorkerDispatchStore({
      pool,
      tableName: sourceHostedWorkerDispatch,
      retryTableName: sourceHostedWorkerRetry,
      leaseTokenFactory: () => `operations-hosted-source-${++sourceHostedLeaseSequence}`,
    });
    const targetHostedWorkerStore = new PostgresHostedWorkerDispatchStore({
      pool,
      tableName: targetHostedWorkerDispatch,
      retryTableName: targetHostedWorkerRetry,
      leaseTokenFactory: () => `operations-hosted-target-${++targetHostedLeaseSequence}`,
    });
    const storageRoot = await mkdtemp(join(tmpdir(), 'private-skills-operations-files-'));
    cleanups.push(async () => {
      await rm(storageRoot, { recursive: true, force: true });
    });
    const sourceStorageRoot = join(storageRoot, 'source');
    const targetStorageRoot = join(storageRoot, 'target');
    await Promise.all([
      mkdir(sourceStorageRoot, { recursive: true }),
      mkdir(targetStorageRoot, { recursive: true }),
    ]);
    const sourceClient = await createNodeFilesClient({ provider: 'fs', root: sourceStorageRoot });
    const targetClient = await createNodeFilesClient({ provider: 'fs', root: targetStorageRoot });
    const sourceBlobs = new FilesSdkBlobStore({ client: sourceClient, prefix: 'operations' });
    const targetBlobs = new FilesSdkBlobStore({ client: targetClient, prefix: 'operations' });

    cleanups.push(async () => {
      await sourceIdentity.close().catch(() => undefined);
      await targetIdentity.close().catch(() => undefined);
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${identifier(sourceAuthSchema)} CASCADE`);
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${identifier(targetAuthSchema)} CASCADE`);
      await sql.unsafe(`DROP TABLE IF EXISTS ${[targetSso, sourceSso, targetTokens, sourceTokens, targetRegistry, sourceRegistry, targetIdentityEvents, sourceIdentityEvents, targetHostedWorkerRetry, sourceHostedWorkerRetry, targetHostedWorkerDispatch, sourceHostedWorkerDispatch, `${targetBillingTable}_usage_operations`, `${targetBillingTable}_webhook_events`, `${targetBillingTable}_subscriptions`, `${targetBillingTable}_customers`, `${targetBillingTable}_usage`, `${sourceBillingTable}_usage_operations`, `${sourceBillingTable}_webhook_events`, `${sourceBillingTable}_subscriptions`, `${sourceBillingTable}_customers`, `${sourceBillingTable}_usage`].map(identifier).join(', ')}`);
      await sql.end({ timeout: 5 });
    });

    await sourceIdentity.runMigrations();
    await targetIdentity.runMigrations();
    await (await getMigrations(sourceSsoAuth.options)).runMigrations();
    await (await getMigrations(targetSsoAuth.options)).runMigrations();
    const sourceIdentityTableNames = await identityTables(sql, sourceAuthSchema);
    expect(sourceIdentityTableNames).toContain('ssoProvider');
    await sql.unsafe(companySsoSchemaSql(sourceSso));
    await sql.unsafe(companySsoSchemaSql(targetSso));
    await sql.unsafe(postgresApiTokenSchemaSql(sourceTokens));
    await sql.unsafe(postgresApiTokenSchemaSql(targetTokens));
    await sql.unsafe(postgresStateSchemaSql(sourceRegistry));
    await sql.unsafe(postgresStateSchemaSql(targetRegistry));
    await sql.unsafe(billingPostgresSchemaSql(sourceBillingTable));
    await sql.unsafe(billingPostgresSchemaSql(targetBillingTable));
    await sql.unsafe(hostedWorkerDispatchSchemaSql(sourceHostedWorkerDispatch, sourceHostedWorkerRetry));
    await sql.unsafe(hostedWorkerDispatchSchemaSql(targetHostedWorkerDispatch, targetHostedWorkerRetry));
    await sourceOperationsEvents.runMigrations();
    await targetOperationsEvents.runMigrations();

    await seedIdentity(sourceIdentity);
    const sourceSession = await signedSessionRequest(sourceIdentity, 'operations-session-token-a');
    await expect(sourceIdentity.getSession(sourceSession)).resolves.toMatchObject({ activeOrganizationId: ORG_A });

    await sourceOperationsEvents.recordGlobal({
      kind: 'callback_failure',
      reasonCode: 'callback_unavailable',
      providerId: 'operations-oidc',
      occurredAt: new Date(NOW - 2 * 60 * 60 * 1_000),
    });
    const trustedA = await sourceOperationsEvents.trustedTenant(ORG_A, USER_A);
    expect(trustedA).toMatchObject({ organizationId: ORG_A, userId: USER_A, role: 'owner' });
    if (!trustedA) throw new Error('operations rehearsal could not establish tenant A identity context');
    await expect(sourceOperationsEvents.recordTenant(trustedA, {
      kind: 'membership_denial',
      reasonCode: 'membership_role_denied',
      occurredAt: new Date(NOW - 60 * 60 * 1_000),
    })).resolves.toBe(true);
    const trustedB = await sourceOperationsEvents.trustedTenant(ORG_B, USER_B);
    expect(trustedB).toMatchObject({ organizationId: ORG_B, userId: USER_B, role: 'owner' });
    if (!trustedB) throw new Error('operations rehearsal could not establish tenant B identity context');
    await expect(sourceOperationsEvents.recordTenant(trustedB, {
      kind: 'authentication_failure',
      reasonCode: 'authentication_rejected',
      occurredAt: new Date(NOW - 30 * 60 * 1_000),
    })).resolves.toBe(true);

    const sourceSsoRepository = createPostgresCompanySsoRepository(pool, { tableName: sourceSso });
    const ssoRecord: CompanySsoProviderRecord = {
      id: `${ORG_A}-sso-row`,
      organizationId: ORG_A,
      providerId: 'operations-oidc',
      displayName: 'Operations OIDC',
      protocol: 'oidc',
      issuer: 'https://idp.operations.test',
      callbackUrl: `${ORIGIN}/api/auth/sso/callback/operations-oidc`,
      status: 'active',
      oidc: {
        clientId: 'operations-client',
        clientSecret: 'operations-test-secret',
        discoveryUrl: 'https://idp.operations.test/.well-known/openid-configuration',
        authorizationEndpoint: 'https://idp.operations.test/authorize',
        tokenEndpoint: 'https://idp.operations.test/token',
        jwksEndpoint: 'https://idp.operations.test/jwks',
        scopes: ['openid', 'profile', 'email'],
        pkce: true,
      },
      createdBy: USER_A,
      updatedBy: USER_A,
      revision: 1,
      createdAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
    };
    await sourceSsoRepository.create(ssoRecord);
    await seedBetterAuthSsoMirror(sourceSsoAuth, ssoRecord);

    const sourceTokenRepository = new PostgresApiTokenRepository(pool, { tableName: sourceTokens });
    await sourceTokenRepository.create(tokenRecord(ORG_A, USER_A, 'operations-token-a', TOKEN_A));
    await sourceTokenRepository.create(tokenRecord(ORG_B, USER_B, 'operations-token-b', TOKEN_B, new Date(NOW - 1_000).toISOString()));

    const planCatalog = catalog();
    const sourceBillingRepository = new PostgresBillingRepository(pool, { tablePrefix: sourceBillingTable, now: () => NOW });
    const sourceBillingService = new BillingService({
      repository: sourceBillingRepository,
      catalog: planCatalog,
      provider: localBillingProvider(),
      enabled: true,
      webhookSecret: BILLING_SECRET,
      now: () => NOW,
    });
    for (const [organizationId, customerId, subscriptionId, eventId] of [
      [ORG_A, 'cus_operations_a', 'sub_operations_a', 'evt_operations_a'],
      [ORG_B, 'cus_operations_b', 'sub_operations_b', 'evt_operations_b'],
    ] as const) {
      const event = await signedSubscriptionEvent(organizationId, customerId, subscriptionId, eventId);
      await sourceBillingService.handleWebhook(event.body, event.signature);
    }
    await sourceBillingService.reserveUsage(ORG_A, { scans: 2, eveCostCents: 17 }, 'ops-reservation-a');
    await sourceBillingService.reconcileUsage(ORG_A, 'ops-reservation-a', { scans: 1, eveCostCents: 9 }, 'ops-reconcile-a');
    await sourceBillingService.reserveUsage(ORG_B, { scans: 1, eveCostCents: 11 }, 'ops-reservation-b');
    await sourceBillingService.reserveSeat(ORG_A, 'ops-seat-a', { subjectKey: true });
    await sourceBillingService.commitSeat(ORG_A, 'ops-seat-a');
    await sourceBillingService.reserveSeat(ORG_B, 'ops-seat-b', { subjectKey: true });

    const sourceRegistryRepository = new PostgresStateRepository(pool, {
      tableName: sourceRegistry,
      stateFactory: () => defaultRegistryState({ production: false, allowUnscanned: true, policyRevision: 'operations-rehearsal-policy' }),
    });
    const targetRegistryRepository = new PostgresStateRepository(pool, {
      tableName: targetRegistry,
      stateFactory: () => defaultRegistryState({ production: false, allowUnscanned: true, policyRevision: 'operations-rehearsal-policy' }),
    });
    const artifactBytesA = new TextEncoder().encode('tenant A restored operations object');
    const artifactBytesB = new TextEncoder().encode('tenant B restored operations object');
    const artifactA = await sourceBlobs.put(artifactBytesA);
    const artifactB = await sourceBlobs.put(artifactBytesB);
    await sourceRegistryRepository.transaction(ORG_A, (state) => state.skills.push(skill(ORG_A, 'operations-skill-a', artifactA)));
    await sourceRegistryRepository.transaction(ORG_B, (state) => state.skills.push(skill(ORG_B, 'operations-skill-b', artifactB)));
    const recoveryCreatedAt = new Date(NOW - 10 * 60 * 1_000).toISOString();
    const recoveryUpdatedAt = new Date(NOW).toISOString();
    const recoveryLeaseExpiresAt = new Date(NOW + 5 * 60 * 1_000).toISOString();
    await sourceRegistryRepository.transaction(ORG_A, (state) => {
      const mutable = state as RecoveryRegistryState;
      (mutable.jobs as RehearsalJob[]).push({
        id: WORKER_JOB_A,
        organizationId: ORG_A,
        kind: 'scan',
        state: 'queued',
        resourceId: 'operations-skill-a',
        artifact: artifactA,
        policyRevision: mutable.policy.revision,
        policy: mutable.policy,
        createdAt: recoveryCreatedAt,
        updatedAt: recoveryUpdatedAt,
        attempts: 1,
        meteredReservationKey: 'ops-reservation-a',
      });
      mutable.storageAttempts ??= [];
      mutable.storageAttempts.push({
        id: STORAGE_ATTEMPT_A,
        organizationId: ORG_A,
        reservationKey: 'ops-reservation-a',
        digest: artifactA.digest,
        size: artifactBytesA.byteLength,
        state: 'committed',
        createdAt: recoveryCreatedAt,
        updatedAt: recoveryUpdatedAt,
        objectKey: artifactA.key,
        jobId: WORKER_JOB_A,
      });
    });
    await sourceRegistryRepository.transaction(ORG_B, (state) => {
      const mutable = state as RecoveryRegistryState;
      (mutable.jobs as RehearsalJob[]).push({
        id: WORKER_JOB_B,
        organizationId: ORG_B,
        kind: 'scan',
        state: 'failed',
        resourceId: 'operations-skill-b',
        artifact: artifactB,
        policyRevision: mutable.policy.revision,
        policy: mutable.policy,
        createdAt: recoveryCreatedAt,
        updatedAt: recoveryUpdatedAt,
        attempts: 3,
        meteredReservationKey: 'ops-reservation-b',
        error: 'operations scanner retry exhausted',
      });
      mutable.storageAttempts ??= [];
      mutable.storageAttempts.push({
        id: STORAGE_ATTEMPT_B,
        organizationId: ORG_B,
        reservationKey: 'ops-reservation-b',
        digest: artifactB.digest,
        size: artifactBytesB.byteLength,
        state: 'orphaned',
        createdAt: recoveryCreatedAt,
        updatedAt: recoveryUpdatedAt,
        objectKey: artifactB.key,
        jobId: WORKER_JOB_B,
      });
    });
    const sourceDispatchLedger = new StateRepositoryTenantReviewDispatchLedger(sourceRegistryRepository);
    const dispatchClaimA = await sourceDispatchLedger.claim({
      organizationId: ORG_A,
      operationKey: DISPATCH_OPERATION_A,
      now: new Date(NOW),
      leaseMs: 5 * 60 * 1_000,
    });
    expect(dispatchClaimA.claimed).toBe(true);
    if (!dispatchClaimA.claimToken) throw new Error('operations rehearsal did not obtain tenant A dispatch claim');
    await expect(sourceDispatchLedger.markStarting({
      organizationId: ORG_A,
      operationKey: DISPATCH_OPERATION_A,
      claimToken: dispatchClaimA.claimToken,
      now: new Date(NOW),
    })).resolves.toBe(true);
    const dispatchClaimB = await sourceDispatchLedger.claim({
      organizationId: ORG_B,
      operationKey: DISPATCH_OPERATION_A,
      now: new Date(NOW),
      leaseMs: 5 * 60 * 1_000,
    });
    expect(dispatchClaimB.claimed).toBe(true);
    if (!dispatchClaimB.claimToken) throw new Error('operations rehearsal did not obtain tenant B dispatch claim');
    await expect(sourceDispatchLedger.markUncertain({
      organizationId: ORG_B,
      operationKey: DISPATCH_OPERATION_A,
      claimToken: dispatchClaimB.claimToken,
      sessionId: 'operations-eve-session-b',
      now: new Date(NOW),
    })).resolves.toBe(true);
    await sourceDispatchLedger.cursorStore.write({ cursor: {
      day: DISPATCH_DAY,
      pendingOrganizationIds: [ORG_A],
      completedOrganizationIds: [],
      blockedOrganizationIds: [ORG_B],
      updatedAt: recoveryUpdatedAt,
    } });
    const sourceHostedLease = await sourceHostedWorkerStore.acquireLease(NOW, 5 * 60 * 1_000);
    expect(sourceHostedLease).toMatchObject({ cursor: null, expiresAt: NOW + 5 * 60 * 1_000 });
    if (!sourceHostedLease) throw new Error('operations rehearsal did not acquire the hosted worker dispatch lease');
    await sourceHostedWorkerStore.advance(sourceHostedLease, ORG_A, NOW);
    await sourceHostedWorkerStore.recordFailure(sourceHostedLease, ORG_B, ORG_A, 'tenant_worker_unavailable', NOW);
    await expect(sourceHostedWorkerStore.isRetryReady(ORG_B, NOW)).resolves.toBe(false);

    const identitySourceManifest = await copyIdentitySchema(sql, sourceAuthSchema, targetAuthSchema);
    const publicSourceManifest = await copyPublicTables(sql, [
      [sourceSso, targetSso],
      [sourceTokens, targetTokens],
      [sourceRegistry, targetRegistry],
      [sourceIdentityEvents, targetIdentityEvents],
      [sourceHostedWorkerDispatch, targetHostedWorkerDispatch],
      [sourceHostedWorkerRetry, targetHostedWorkerRetry],
      [`${sourceBillingTable}_customers`, `${targetBillingTable}_customers`],
      [`${sourceBillingTable}_subscriptions`, `${targetBillingTable}_subscriptions`],
      [`${sourceBillingTable}_usage`, `${targetBillingTable}_usage`],
      [`${sourceBillingTable}_webhook_events`, `${targetBillingTable}_webhook_events`],
      [`${sourceBillingTable}_usage_operations`, `${targetBillingTable}_usage_operations`],
    ]);
    for (const artifact of [artifactA, artifactB]) {
      const bytes = await sourceBlobs.getVerified(artifact.key, artifact.digest);
      await targetClient.upload(artifact.key, bytes, { contentType: 'application/octet-stream' });
    }
    const targetIdentityTables = await identityTables(sql, targetAuthSchema);
    expect(targetIdentityTables).toEqual(await identityTables(sql, sourceAuthSchema));
    const identityTargetNames = new Map([...identitySourceManifest.keys()].map((logical) => [logical, qualifiedSchema(targetAuthSchema, logical.slice('identity:'.length))]));
    const publicTargetNames = new Map<string, string>([
      [targetSso, publicTable(targetSso)],
      [targetTokens, publicTable(targetTokens)],
      [targetRegistry, publicTable(targetRegistry)],
      [targetIdentityEvents, publicTable(targetIdentityEvents)],
      [targetHostedWorkerDispatch, publicTable(targetHostedWorkerDispatch)],
      [targetHostedWorkerRetry, publicTable(targetHostedWorkerRetry)],
      [`${targetBillingTable}_customers`, publicTable(`${targetBillingTable}_customers`)],
      [`${targetBillingTable}_subscriptions`, publicTable(`${targetBillingTable}_subscriptions`)],
      [`${targetBillingTable}_usage`, publicTable(`${targetBillingTable}_usage`)],
      [`${targetBillingTable}_webhook_events`, publicTable(`${targetBillingTable}_webhook_events`)],
      [`${targetBillingTable}_usage_operations`, publicTable(`${targetBillingTable}_usage_operations`)],
    ]);
    await compareManifest(sql, identitySourceManifest, identityTargetNames);
    await compareManifest(sql, publicSourceManifest, publicTargetNames);
    await expect(objectManifest(targetBlobs, [artifactA, artifactB])).resolves.toEqual(await objectManifest(sourceBlobs, [artifactA, artifactB]));
    await expect(targetBlobs.getVerified(artifactA.key, artifactA.digest)).resolves.toEqual(artifactBytesA);
    await expect(targetBlobs.getVerified(artifactB.key, artifactB.digest)).resolves.toEqual(artifactBytesB);
    const restoredHostedDispatch = await sql.unsafe<{
      cursor_org_id: string | null;
      lease_token: string | null;
      lease_expires_ms: string | null;
    }[]>(
      `SELECT cursor_org_id, lease_token,
        (extract(epoch FROM lease_expires_at) * 1000)::bigint::text AS lease_expires_ms
       FROM ${publicTable(targetHostedWorkerDispatch)} WHERE singleton_id = 'default'`,
    );
    expect(restoredHostedDispatch).toEqual([{
      cursor_org_id: ORG_A,
      lease_token: sourceHostedLease.token,
      lease_expires_ms: String(NOW + 5 * 60 * 1_000),
    }]);
    const restoredHostedRetry = await sql.unsafe<{
      organization_id: string;
      attempts: string;
      next_attempt_ms: string;
      last_error: string;
    }[]>(
      `SELECT organization_id, attempts::text AS attempts,
        (extract(epoch FROM next_attempt_at) * 1000)::bigint::text AS next_attempt_ms,
        last_error
       FROM ${publicTable(targetHostedWorkerRetry)} ORDER BY organization_id`,
    );
    expect(restoredHostedRetry).toEqual([{
      organization_id: ORG_B,
      attempts: '1',
      next_attempt_ms: String(NOW + 30 * 1_000),
      last_error: 'tenant_worker_unavailable',
    }]);
    await expect(targetHostedWorkerStore.acquireLease(NOW, 5 * 60 * 1_000)).resolves.toBeNull();
    await expect(targetHostedWorkerStore.isRetryReady(ORG_B, NOW)).resolves.toBe(false);
    await expect(targetHostedWorkerStore.isRetryReady(ORG_B, NOW + 60 * 1_000)).resolves.toBe(true);
    const takeoverNow = NOW + 6 * 60 * 1_000;
    const targetTakeoverLease = await targetHostedWorkerStore.acquireLease(takeoverNow, 5 * 60 * 1_000);
    expect(targetTakeoverLease).toMatchObject({
      cursor: ORG_A,
      expiresAt: takeoverNow + 5 * 60 * 1_000,
    });
    if (!targetTakeoverLease) throw new Error('operations rehearsal did not take over the expired hosted worker lease');
    await expect(targetHostedWorkerStore.advance(
      { ...targetTakeoverLease, token: sourceHostedLease.token },
      ORG_B,
      takeoverNow,
    )).rejects.toBeInstanceOf(HostedWorkerDispatchLeaseError);
    await expect(targetHostedWorkerStore.isRetryReady(ORG_B, takeoverNow)).resolves.toBe(true);
    await targetHostedWorkerStore.release(targetTakeoverLease, ORG_A);
    const restoredRegistryA = await targetRegistryRepository.read(ORG_A) as RecoveryRegistryState;
    expect(restoredRegistryA.jobs).toEqual([
      expect.objectContaining({
        id: WORKER_JOB_A,
        organizationId: ORG_A,
        state: 'queued',
        attempts: 1,
        meteredReservationKey: 'ops-reservation-a',
      }),
    ]);
    expect(restoredRegistryA.storageAttempts).toEqual([
      {
        id: STORAGE_ATTEMPT_A,
        organizationId: ORG_A,
        reservationKey: 'ops-reservation-a',
        digest: artifactA.digest,
        size: artifactBytesA.byteLength,
        state: 'committed',
        createdAt: recoveryCreatedAt,
        updatedAt: recoveryUpdatedAt,
        objectKey: artifactA.key,
        jobId: WORKER_JOB_A,
      },
    ]);
    expect(restoredRegistryA.tenantReviewDispatches).toEqual([
      {
        operationKey: DISPATCH_OPERATION_A,
        state: 'starting',
        claimToken: expect.any(String),
        leaseExpiresAt: recoveryLeaseExpiresAt,
        updatedAt: recoveryUpdatedAt,
        startingAt: recoveryUpdatedAt,
      },
    ]);
    const restoredRegistryB = await targetRegistryRepository.read(ORG_B) as RecoveryRegistryState;
    expect(restoredRegistryB.jobs).toEqual([
      expect.objectContaining({
        id: WORKER_JOB_B,
        organizationId: ORG_B,
        state: 'failed',
        attempts: 3,
        meteredReservationKey: 'ops-reservation-b',
        error: 'operations scanner retry exhausted',
      }),
    ]);
    expect(restoredRegistryB.storageAttempts).toEqual([
      {
        id: STORAGE_ATTEMPT_B,
        organizationId: ORG_B,
        reservationKey: 'ops-reservation-b',
        digest: artifactB.digest,
        size: artifactBytesB.byteLength,
        state: 'orphaned',
        createdAt: recoveryCreatedAt,
        updatedAt: recoveryUpdatedAt,
        objectKey: artifactB.key,
        jobId: WORKER_JOB_B,
      },
    ]);
    expect(restoredRegistryB.tenantReviewDispatches).toEqual([
      {
        operationKey: DISPATCH_OPERATION_A,
        state: 'uncertain',
        leaseExpiresAt: recoveryLeaseExpiresAt,
        sessionId: 'operations-eve-session-b',
        updatedAt: recoveryUpdatedAt,
        uncertainAt: recoveryUpdatedAt,
      },
    ]);
    const restoredDispatchCursor = await targetRegistryRepository.read(DISPATCH_CURSOR_ORGANIZATION_ID) as RegistryState;
    expect(restoredDispatchCursor.tenantReviewDispatchCursor).toEqual({
      day: DISPATCH_DAY,
      pendingOrganizationIds: [ORG_A],
      completedOrganizationIds: [],
      blockedOrganizationIds: [ORG_B],
      updatedAt: recoveryUpdatedAt,
    });
    const targetDispatchLedger = new StateRepositoryTenantReviewDispatchLedger(targetRegistryRepository);
    await expect(targetDispatchLedger.claim({
      organizationId: ORG_A,
      operationKey: DISPATCH_OPERATION_A,
      now: new Date(NOW),
      leaseMs: 5 * 60 * 1_000,
    })).resolves.toEqual({ claimed: false, reason: 'in-progress' });
    await expect(targetDispatchLedger.claim({
      organizationId: ORG_B,
      operationKey: DISPATCH_OPERATION_A,
      now: new Date(NOW),
      leaseMs: 5 * 60 * 1_000,
    })).resolves.toEqual({ claimed: false, reason: 'in-progress' });
    await expect(targetDispatchLedger.cursorStore.read({ day: DISPATCH_DAY })).resolves.toEqual({
      day: DISPATCH_DAY,
      pendingOrganizationIds: [ORG_A],
      completedOrganizationIds: [],
      blockedOrganizationIds: [ORG_B],
      updatedAt: recoveryUpdatedAt,
    });
    const workerAuthenticator: Authenticator = {
      async authenticate(request) {
        return request.headers.get('authorization') === `Bearer ${WORKER_TOKEN_A}`
          ? { organizationId: ORG_A, subject: 'operations-worker', roles: ['worker'], scopes: ['jobs:claim', 'jobs:complete'] }
          : null;
      },
    };
    const restoredWorkerHandler = await registryHandler({ organizationId: ORG_A, auth: workerAuthenticator }, targetRegistryRepository, targetBlobs);
    const workerClaim = await restoredWorkerHandler(new Request(`${ORIGIN}/internal/jobs/claim`, {
      method: 'POST',
      headers: { authorization: `Bearer ${WORKER_TOKEN_A}` },
    }));
    expect(workerClaim.status).toBe(200);
    const claimedWorkerJob = (await workerClaim.json()) as { job?: { id?: string; state?: string; attempts?: number; meteredReservationKey?: string; fencingToken?: string } };
    expect(claimedWorkerJob.job).toMatchObject({
      id: WORKER_JOB_A,
      state: 'running',
      attempts: 2,
      meteredReservationKey: 'ops-reservation-a',
    });
    expect(claimedWorkerJob.job?.fencingToken).toEqual(expect.any(String));
    const staleWorkerCompletion = await restoredWorkerHandler(new Request(`${ORIGIN}/internal/jobs/${WORKER_JOB_A}/complete`, {
      method: 'POST',
      headers: { authorization: `Bearer ${WORKER_TOKEN_A}`, 'content-type': 'application/json' },
      body: JSON.stringify({ leaseToken: 'operations-worker-lease-stale', error: 'stale worker retry' }),
    }));
    expect(staleWorkerCompletion.status).toBe(409);
    const foreignWorkerCompletion = await restoredWorkerHandler(new Request(`${ORIGIN}/internal/jobs/${WORKER_JOB_B}/complete`, {
      method: 'POST',
      headers: { authorization: `Bearer ${WORKER_TOKEN_A}`, 'content-type': 'application/json' },
      body: JSON.stringify({ leaseToken: 'operations-worker-lease-foreign', error: 'foreign worker retry' }),
    }));
    expect(foreignWorkerCompletion.status).toBe(404);
    const restoredIdentityRows = await sql.unsafe<{ users: string; organizations: string; members: string; sessions: string }[]>(
      `SELECT
        (SELECT count(*)::text FROM ${qualifiedSchema(targetAuthSchema, 'user')}) AS users,
        (SELECT count(*)::text FROM ${qualifiedSchema(targetAuthSchema, 'organization')}) AS organizations,
        (SELECT count(*)::text FROM ${qualifiedSchema(targetAuthSchema, 'member')}) AS members,
        (SELECT count(*)::text FROM ${qualifiedSchema(targetAuthSchema, 'session')}) AS sessions`,
    );
    expect(restoredIdentityRows[0]).toEqual({ users: '2', organizations: '2', members: '2', sessions: '2' });
    const restoredSessionRows = await sql.unsafe<{ id: string; tokenLength: string; userId: string; activeOrganizationId: string }[]>(
      `SELECT "id", length("token")::text AS "tokenLength", "userId", "activeOrganizationId" FROM ${qualifiedSchema(targetAuthSchema, 'session')} ORDER BY "id"`,
    );
    expect(restoredSessionRows).toEqual([
      { id: SESSION_A, tokenLength: '26', userId: USER_A, activeOrganizationId: ORG_A },
      { id: SESSION_B, tokenLength: '26', userId: USER_B, activeOrganizationId: ORG_B },
    ]);

    const targetSession = await signedSessionRequest(targetIdentity, 'operations-session-token-a');
    const restoredSession = await targetIdentity.getSession(targetSession);
    expect(restoredSession).toMatchObject({ activeOrganizationId: ORG_A, organizations: [{ organizationId: ORG_A, role: 'owner' }] });

    const memberAuthorizer = await membershipAuthorizer(sql, targetAuthSchema);
    const targetTokenRepository = new PostgresApiTokenRepository(pool, { tableName: targetTokens });
    const targetTokenService = new DefaultApiTokenService({ repository: targetTokenRepository, membershipAuthorizer: memberAuthorizer, now: () => NOW });
    await expect(targetTokenService.authenticateBearerToken(TOKEN_A)).resolves.toMatchObject({ organizationId: ORG_A, subject: USER_A });
    await expect(targetTokenService.authenticateBearerToken(TOKEN_B)).resolves.toBeNull();
    await expect(targetTokenRepository.findById(ORG_B, 'operations-token-a')).resolves.toBeNull();
    await expect(targetOperationsEvents.summarize(ORG_A)).resolves.toMatchObject({
      authenticationFailures: { total: 0, last24h: 0 },
      callbackFailures: { total: 0, last24h: 0 },
      membershipDenials: { total: 1, last24h: 1 },
    });
    await expect(targetOperationsEvents.summarize(ORG_B)).resolves.toMatchObject({
      authenticationFailures: { total: 1, last24h: 1 },
      callbackFailures: { total: 0, last24h: 0 },
      membershipDenials: { total: 0, last24h: 0 },
    });
    await expect(targetOperationsEvents.trustedTenant(ORG_B, USER_A)).resolves.toBeNull();
    const restoredOperationsRows = await sql.unsafe<{
      organization_id: string | null;
      role: string | null;
      event_kind: string;
      reason_code: string;
      provider_id: string | null;
    }[]>(
      `SELECT organization_id, role, event_kind, reason_code, provider_id FROM ${publicTable(targetIdentityEvents)} ORDER BY event_kind, organization_id NULLS FIRST`,
    );
    expect(restoredOperationsRows).toEqual([
      { organization_id: ORG_B, role: 'owner', event_kind: 'authentication_failure', reason_code: 'authentication_rejected', provider_id: null },
      { organization_id: null, role: null, event_kind: 'callback_failure', reason_code: 'callback_unavailable', provider_id: 'operations-oidc' },
      { organization_id: ORG_A, role: 'owner', event_kind: 'membership_denial', reason_code: 'membership_role_denied', provider_id: null },
    ]);
    await sql.unsafe(`DELETE FROM ${qualifiedSchema(targetAuthSchema, 'member')} WHERE "organizationId" = $1 AND "userId" = $2`, [ORG_A, USER_A]);
    await expect(targetIdentity.authenticate(targetSession)).resolves.toBeNull();
    await sql.unsafe(`INSERT INTO ${qualifiedSchema(targetAuthSchema, 'member')} ("id", "organizationId", "userId", "role", "createdAt") VALUES ($1, $2, $3, $4, $5)`, [`${ORG_A}-member-restored`, ORG_A, USER_A, 'owner', new Date(NOW)]);

    const targetSsoRepository = createPostgresCompanySsoRepository(pool, { tableName: targetSso });
    await expect(targetSsoRepository.get(ORG_A, 'operations-oidc')).resolves.toMatchObject({ organizationId: ORG_A, providerId: 'operations-oidc' });
    await expect(targetSsoRepository.get(ORG_B, 'operations-oidc')).resolves.toBeNull();
    const restoredSsoMirror = await sql.unsafe<{ id: string; providerId: string; organizationId: string; userId: string; issuer: string; oidcConfig: string }[]>(
      `SELECT "id", "providerId", "organizationId", "userId", issuer, "oidcConfig" FROM ${qualifiedSchema(targetAuthSchema, 'ssoProvider')} WHERE "providerId" = $1`,
      [ssoRecord.providerId],
    );
    expect(restoredSsoMirror[0]).toMatchObject({
      id: ssoRecord.id,
      providerId: ssoRecord.providerId,
      organizationId: ssoRecord.organizationId,
      userId: ssoRecord.createdBy,
      issuer: ssoRecord.issuer,
    });
    if (!ssoRecord.oidc) throw new Error('operations rehearsal expects an OIDC SSO fixture');
    expect(JSON.parse(restoredSsoMirror[0]?.oidcConfig ?? '{}')).toMatchObject({
      issuer: ssoRecord.issuer,
      clientId: ssoRecord.oidc.clientId,
      discoveryEndpoint: ssoRecord.oidc.discoveryUrl,
    });

    const targetBillingRepository = new PostgresBillingRepository(pool, { tablePrefix: targetBillingTable, now: () => NOW });
    const targetBillingService = new BillingService({
      repository: targetBillingRepository,
      catalog: planCatalog,
      provider: localBillingProvider(),
      enabled: true,
      webhookSecret: BILLING_SECRET,
      now: () => NOW,
    });
    await expect(targetBillingService.entitlement(ORG_A)).resolves.toMatchObject({ organizationId: ORG_A, state: 'active', customerId: 'cus_operations_a', subscriptionId: 'sub_operations_a' });
    await expect(targetBillingService.entitlement(ORG_B)).resolves.toMatchObject({ organizationId: ORG_B, state: 'active', customerId: 'cus_operations_b', subscriptionId: 'sub_operations_b' });
    await expect(targetBillingRepository.findOrganizationByCustomerId('local', 'cus_operations_a')).resolves.toBe(ORG_A);
    await expect(targetBillingRepository.findOrganizationByCustomerId('local', 'cus_operations_b')).resolves.toBe(ORG_B);
    const restoredUsageOperations = await sql.unsafe<{
      organization_id: string;
      operation_key: string;
      scans_delta: number;
      eve_cost_cents_delta: number;
      status: string;
      reconciled: { scans?: number; eveCostCents?: number } | null;
    }[]>(
      `SELECT organization_id, operation_key, scans_delta::int AS scans_delta, eve_cost_cents_delta::int AS eve_cost_cents_delta, status, reconciled FROM ${publicTable(`${targetBillingTable}_usage_operations`)} WHERE organization_id = $1 ORDER BY operation_key`,
      [ORG_A],
    );
    expect(restoredUsageOperations).toEqual([
      { organization_id: ORG_A, operation_key: 'ops-reconcile-a', scans_delta: -1, eve_cost_cents_delta: -8, status: 'committed', reconciled: null },
      { organization_id: ORG_A, operation_key: 'ops-reservation-a', scans_delta: 2, eve_cost_cents_delta: 17, status: 'committed', reconciled: { scans: 1, eveCostCents: 9 } },
    ]);
    const restoredAUsage = await targetBillingService.usageSnapshot(ORG_A);
    expect(restoredAUsage).toMatchObject({ organizationId: ORG_A, usage: { seats: 1, scans: 1, eveCostCents: 9 } });
    const restoredBUsage = await targetBillingService.usageSnapshot(ORG_B);
    expect(restoredBUsage).toMatchObject({ organizationId: ORG_B, usage: { seats: 1, scans: 1, eveCostCents: 11 } });
    const restoredABillingState = await targetBillingRepository.read(ORG_A);
    expect(restoredABillingState.seatBaseline).toBe(1);
    expect(restoredABillingState.seatRevision).toBeGreaterThan(0);
    expect(restoredABillingState.seatReservations).toEqual([
      expect.objectContaining({ operationKey: 'ops-seat-a', status: 'settled', committed: true, subjectKey: true }),
    ]);
    const restoredBBillingState = await targetBillingRepository.read(ORG_B);
    expect(restoredBBillingState.seatBaseline).toBe(0);
    expect(restoredBBillingState.seatRevision).toBeGreaterThan(0);
    expect(restoredBBillingState.seatReservations).toEqual([
      expect.objectContaining({ operationKey: 'ops-seat-b', status: 'active', committed: false, subjectKey: true }),
    ]);
    const usageBeforeReplay = await targetBillingService.usageSnapshot(ORG_A);
    await expect(targetBillingService.reserveUsage(ORG_A, { scans: 2, eveCostCents: 17 }, 'ops-reservation-a')).resolves.toMatchObject({ idempotent: true });
    await expect(targetBillingService.reconcileUsage(ORG_A, 'ops-reservation-a', { scans: 1, eveCostCents: 9 }, 'ops-reconcile-a')).resolves.toMatchObject({ idempotent: true });
    await expect(targetBillingService.usageSnapshot(ORG_A)).resolves.toEqual(usageBeforeReplay);

    const targetBlobsRepository = targetRegistryRepository;
    const router = createTenantHandlerRouter({
      defaultOrganizationId: ORG_A,
      identity: targetIdentity,
      createHandler: async (context) => await registryHandler(context, targetBlobsRepository, targetBlobs),
    });
    const restoredARequest = new Request(`${ORIGIN}/v1/skills/operations-skill-a`, { headers: { cookie: targetSession.headers.get('cookie') ?? '' } });
    const restoredA = await router(restoredARequest);
    expect(restoredA.status).toBe(200);
    const sessionCookie = targetSession.headers.get('cookie') ?? '';
    const restoredResolutionResponse = await router(new Request(`${ORIGIN}/v1/resolve`, {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'skill', ref: '@operations/shared', version: '1.0.0' }),
    }));
    expect(restoredResolutionResponse.status).toBe(200);
    const restoredResolution = (await restoredResolutionResponse.json()) as { resolution: { digest: string } };
    expect(restoredResolution.resolution.digest).toBe(artifactA.digest);
    const restoredAuthorizationResponse = await router(new Request(`${ORIGIN}/v1/install-authorizations`, {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ resolution: restoredResolution.resolution }),
    }));
    expect(restoredAuthorizationResponse.status).toBe(201);
    const restoredAuthorization = (await restoredAuthorizationResponse.json()) as { authorization: { id: string } };
    const restoredDescriptorResponse = await router(new Request(`${ORIGIN}/v1/artifacts/${encodeURIComponent(artifactA.digest)}/download`, {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ resourceId: 'operations-skill-a', authorizationId: restoredAuthorization.authorization.id }),
    }));
    expect(restoredDescriptorResponse.status).toBe(200);
    const restoredDescriptor = (await restoredDescriptorResponse.json()) as { url: string; digest: string };
    expect(restoredDescriptor.digest).toBe(artifactA.digest);
    const restoredTransfer = await router(new Request(restoredDescriptor.url, { headers: { cookie: sessionCookie } }));
    expect(restoredTransfer.status).toBe(200);
    const restoredBytes = new Uint8Array(await restoredTransfer.arrayBuffer());
    expect(restoredBytes).toEqual(artifactBytesA);
    expect(await digestBytes(restoredBytes)).toBe(artifactA.digest);
    const foreignArtifactDownload = await router(new Request(`${ORIGIN}/v1/artifacts/${encodeURIComponent(artifactB.digest)}/download`, {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ resourceId: 'operations-skill-b', authorizationId: restoredAuthorization.authorization.id }),
    }));
    expect(foreignArtifactDownload.status).toBe(404);
    await expect(foreignArtifactDownload.text()).resolves.not.toContain(artifactB.digest);
    const foreignRequest = new Request(`${ORIGIN}/v1/skills/operations-skill-b`, {
      headers: { cookie: sessionCookie, 'x-organization-id': ORG_B },
    });
    const foreign = await router(foreignRequest);
    expect(foreign.status).toBe(404);
    await expect(foreign.text()).resolves.not.toContain('operations-skill-b');
  }, 60_000);
});
