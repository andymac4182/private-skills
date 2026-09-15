import { makeSignature } from 'better-auth/crypto';
import { describe, expect, it } from 'vitest';
import postgres from 'postgres';

import type { AuditEvent, SkillVersion } from '../../../packages/contracts/src/index.js';
import { createAuthenticatorFromEnv } from '../../../packages/auth/src/index.js';
import {
  createPostgresStateRepository,
  type PgPoolLike,
  type PgQueryResult,
  type PostgresStateRepository,
} from '../../../packages/database/src/postgres.js';
import {
  createIdentityRuntime,
  createIdentityRuntimeConfig,
  type IdentityRuntimeAdmin,
} from '../../../packages/identity/src/index.js';
import {
  BOOTSTRAP_ADOPTION_ACTION,
  BOOTSTRAP_ADOPTION_METADATA_KEY,
  BOOTSTRAP_ADOPTION_PATH,
  createBootstrapAdoptionHandler,
  createPostgresBootstrapAdoptionStore,
  type BootstrapAdoptionBinding,
  type BootstrapAdoptionStore,
} from '../server/bootstrap-adoption.js';

/** The integration suite is intentionally limited to a disposable loopback database. */
const databaseURL = process.env.PSKILLS_IDENTITY_TEST_DATABASE_URL;
const canUseDisposableDatabase = isLoopbackDatabaseURL(databaseURL);

const TEST_BOOTSTRAP_TOKEN = 'local-disposable-bootstrap-token';
const TEST_BOOTSTRAP_TOKEN_ID = 'local-disposable-owner-proof';
const TEST_ORGANIZATION_ID = 'default';
const TEST_SECRET = 'local-disposable-better-auth-secret-0123456789';

interface AdoptionFixture {
  appOrigin: string;
  schema: string;
  runtime: IdentityRuntimeAdmin;
  direct: ReturnType<typeof postgres>;
  stateSql: ReturnType<typeof postgres>;
  statePool: PgPoolLike;
  repository: PostgresStateRepository;
  store: BootstrapAdoptionStore;
  handler: (request: Request) => Promise<Response>;
  cookieFor(sessionToken: string): Promise<string>;
  cleanup(): Promise<void>;
}

function isLoopbackDatabaseURL(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
  } catch {
    return false;
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function qualifiedTable(schema: string, name: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}

function uniqueSuffix(): string {
  return `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Adapt PostgreSQL.js to the small pool contract used by registry adapters. */
function createPgPool(sql: ReturnType<typeof postgres>): PgPoolLike {
  const query = async <Row = Record<string, unknown>>(
    connection: ReturnType<typeof postgres>,
    text: string,
    parameters: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> => {
    const result = await connection.unsafe(text, [...parameters] as never[]);
    return { rows: [...result] as unknown as Row[], rowCount: result.count };
  };
  return {
    query: <Row = Record<string, unknown>>(text: string, parameters?: readonly unknown[]) => query<Row>(sql, text, parameters),
    connect: async () => {
      const connection = await sql.reserve();
      return {
        query: <Row = Record<string, unknown>>(text: string, parameters?: readonly unknown[]) => query<Row>(connection as unknown as ReturnType<typeof postgres>, text, parameters),
        release: () => connection.release(),
      };
    },
  };
}

async function queryRows<Row>(
  sql: ReturnType<typeof postgres>,
  text: string,
  parameters: readonly unknown[] = [],
): Promise<Row[]> {
  const result = await sql.unsafe(text, [...parameters] as never[]);
  return [...result] as unknown as Row[];
}

function adoptionRequest(appOrigin: string, cookie?: string, bootstrapToken = TEST_BOOTSTRAP_TOKEN): Request {
  const headers = new Headers({
    origin: appOrigin,
    'content-type': 'application/json',
  });
  if (cookie) headers.set('cookie', cookie);
  return new Request(`${appOrigin}${BOOTSTRAP_ADOPTION_PATH}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ bootstrapToken }),
  });
}

function ownerBinding(overrides: Partial<BootstrapAdoptionBinding> = {}): BootstrapAdoptionBinding {
  return {
    organizationId: TEST_ORGANIZATION_ID,
    userId: 'adoption-owner',
    sessionId: 'adoption-session-owner',
    proofTokenId: TEST_BOOTSTRAP_TOKEN_ID,
    proofSubject: 'legacy-bootstrap-owner',
    ...overrides,
  };
}

const legacySkill: SkillVersion = {
  id: 'legacy-release-1',
  organizationId: TEST_ORGANIZATION_ID,
  name: '@acme/legacy',
  skillName: 'legacy',
  version: '1.2.3',
  description: 'Existing registry release',
  artifact: { key: 'legacy-release-1', digest: 'sha256:legacy-release-digest', size: 42 },
  state: 'approved',
  policyRevision: 'policy-initial',
  createdAt: '2026-09-15T00:00:00.000Z',
  approvedAt: '2026-09-15T00:00:00.000Z',
  provenance: { kind: 'native' },
  fileCount: 1,
  scanIds: [],
};

const legacyAudit: AuditEvent = {
  id: 'legacy-audit-1',
  organizationId: TEST_ORGANIZATION_ID,
  subject: 'legacy-operator',
  action: 'legacy.registry-imported',
  createdAt: '2026-09-15T00:00:00.000Z',
  details: { preserved: true },
};

async function createFixture(): Promise<AdoptionFixture> {
  if (!databaseURL) throw new Error('A loopback PostgreSQL URL is required for this integration test');
  const suffix = uniqueSuffix();
  const schema = `bootstrap_adoption_${suffix}`;
  const registryTable = `ps_state_${suffix}`;
  const table = (name: string) => `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
  const appOrigin = `http://127.0.0.1:${57_000 + (process.pid % 500)}`;
  const direct = postgres(databaseURL, { max: 4, prepare: false });
  const stateSql = postgres(databaseURL, { max: 4, prepare: false });
  const statePool = createPgPool(stateSql);
  const runtime = createIdentityRuntime(createIdentityRuntimeConfig({
    PSKILLS_BETTER_AUTH_ENABLED: 'true',
    DATABASE_URL: databaseURL,
    BETTER_AUTH_SECRET: TEST_SECRET,
    BETTER_AUTH_URL: appOrigin,
    PSKILLS_BETTER_AUTH_SCHEMA: schema,
    PSKILLS_BETTER_AUTH_VALIDATE_SCHEMA: 'false',
  }));
  let schemaDropped = false;
  let tableDropped = false;
  const cleanup = async (): Promise<void> => {
    await runtime.close().catch(() => undefined);
    if (!schemaDropped) {
      await direct.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch(() => undefined);
      schemaDropped = true;
    }
    if (!tableDropped) {
      await direct.unsafe(`DROP TABLE IF EXISTS ${quoteIdentifier(registryTable)}`).catch(() => undefined);
      tableDropped = true;
    }
    await stateSql.end({ timeout: 5 }).catch(() => undefined);
    await direct.end({ timeout: 5 }).catch(() => undefined);
  };

  try {
    await runtime.runMigrations();
    const context = await runtime.auth.$context;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60 * 60 * 1000);
    const users = [
      { id: 'adoption-owner', name: 'Adoption Owner', email: 'owner@acme.test' },
      { id: 'adoption-other', name: 'Other User', email: 'other@acme.test' },
    ];
    for (const user of users) {
      await context.adapter.create({
        model: 'user',
        data: {
          ...user,
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        },
        forceAllowId: true,
      });
    }
    await context.adapter.create({
      model: 'session',
      data: {
        id: 'adoption-session-owner',
        expiresAt,
        token: 'adoption-session-token-owner',
        createdAt: now,
        updatedAt: now,
        userId: 'adoption-owner',
      },
      forceAllowId: true,
    });
    await context.adapter.create({
      model: 'session',
      data: {
        id: 'adoption-session-other',
        expiresAt,
        token: 'adoption-session-token-other',
        createdAt: now,
        updatedAt: now,
        userId: 'adoption-other',
      },
      forceAllowId: true,
    });

    const repository = createPostgresStateRepository(statePool, {
      tableName: registryTable,
      autoMigrate: true,
    });
    await repository.transaction(TEST_ORGANIZATION_ID, (state) => {
      state.skills.push(legacySkill);
      state.audit.push(legacyAudit);
    });

    const store = createPostgresBootstrapAdoptionStore(statePool, {
      organizationId: TEST_ORGANIZATION_ID,
      schemaName: schema,
      organizationName: 'Acme Skills',
      organizationSlug: 'acme-skills',
      generateId: () => 'adoption-member-owner',
    });
    const authenticator = await createAuthenticatorFromEnv({}, {
      environment: 'test',
      publicOrigin: appOrigin,
      allowedOrigins: [appOrigin],
      additionalTokens: [{
        id: TEST_BOOTSTRAP_TOKEN_ID,
        token: TEST_BOOTSTRAP_TOKEN,
        organizationId: TEST_ORGANIZATION_ID,
        subject: 'legacy-bootstrap-owner',
        roles: ['owner'],
        scopes: ['*'],
        kind: 'user',
      }],
    });
    const handler = createBootstrapAdoptionHandler({
      defaultOrganizationId: TEST_ORGANIZATION_ID,
      canonicalOrigin: appOrigin,
      identity: { getSession: runtime.getSession },
      authenticator,
      repository,
      store,
      allowedBootstrapTokenIds: [TEST_BOOTSTRAP_TOKEN_ID],
      organizationName: 'Acme Skills',
      organizationSlug: 'acme-skills',
    });
    const cookieName = context.authCookies.sessionToken.name;
    const cookieFor = async (sessionToken: string): Promise<string> => (
      `${cookieName}=${sessionToken}.${await makeSignature(sessionToken, context.secret)}`
    );
    return {
      appOrigin,
      schema,
      runtime,
      direct,
      stateSql,
      statePool,
      repository,
      store,
      handler,
      cookieFor,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

describe.skipIf(!canUseDisposableDatabase)('PostgreSQL Better Auth bootstrap adoption', () => {
  it('binds an authenticated owner, preserves registry data, denies invalid sessions, and fences replay/concurrent claims', async () => {
    const fixture = await createFixture();
    try {
      const ownerCookie = await fixture.cookieFor('adoption-session-token-owner');
      const valid = await fixture.handler(adoptionRequest(fixture.appOrigin, ownerCookie));
      expect(valid.status).toBe(201);
      await expect(valid.json()).resolves.toMatchObject({
        ok: true,
        organizationId: TEST_ORGANIZATION_ID,
        userId: 'adoption-owner',
        replayed: false,
      });

      const organizations = await queryRows<{ id: string; name: string; slug: string; metadata: unknown }>(fixture.direct,
        `SELECT "id", "name", "slug", "metadata" FROM ${qualifiedTable(fixture.schema, 'organization')} WHERE "id" = $1`,
        [TEST_ORGANIZATION_ID],
      );
      expect(organizations).toHaveLength(1);
      expect(organizations[0]).toMatchObject({ id: TEST_ORGANIZATION_ID, name: 'Acme Skills', slug: 'acme-skills' });
      const marker = JSON.parse(String(organizations[0]?.metadata))[BOOTSTRAP_ADOPTION_METADATA_KEY];
      expect(marker).toMatchObject({
        version: 1,
        userId: 'adoption-owner',
        sessionId: 'adoption-session-owner',
        proofTokenId: TEST_BOOTSTRAP_TOKEN_ID,
        proofSubject: 'legacy-bootstrap-owner',
      });

      const members = await queryRows<{ id: string; organizationId: string; userId: string; role: string }>(fixture.direct,
        `SELECT "id", "organizationId", "userId", "role" FROM ${qualifiedTable(fixture.schema, 'member')} WHERE "organizationId" = $1`,
        [TEST_ORGANIZATION_ID],
      );
      expect(members).toEqual([{
        id: 'adoption-member-owner',
        organizationId: TEST_ORGANIZATION_ID,
        userId: 'adoption-owner',
        role: 'owner',
      }]);

      const sessions = await queryRows<{ id: string; userId: string; activeOrganizationId: string | null }>(fixture.direct,
        `SELECT "id", "userId", "activeOrganizationId" FROM ${qualifiedTable(fixture.schema, 'session')} WHERE "id" IN ($1, $2) ORDER BY "id"`,
        ['adoption-session-owner', 'adoption-session-other'],
      );
      expect(sessions).toEqual([
        { id: 'adoption-session-other', userId: 'adoption-other', activeOrganizationId: null },
        { id: 'adoption-session-owner', userId: 'adoption-owner', activeOrganizationId: TEST_ORGANIZATION_ID },
      ]);

      const session = await fixture.runtime.getSession(new Request(`${fixture.appOrigin}/auth/identity/session`, {
        headers: { cookie: ownerCookie },
      }));
      expect(session).toMatchObject({
        user: { id: 'adoption-owner', emailVerified: true },
        sessionId: 'adoption-session-owner',
        activeOrganizationId: TEST_ORGANIZATION_ID,
        activeMembership: {
          id: 'adoption-member-owner',
          organizationId: TEST_ORGANIZATION_ID,
          role: 'owner',
        },
        needsOnboarding: false,
      });

      const registryBeforeReplay = await fixture.repository.read(TEST_ORGANIZATION_ID);
      expect(registryBeforeReplay.skills).toEqual([legacySkill]);
      expect(registryBeforeReplay.audit).toEqual([
        legacyAudit,
        expect.objectContaining({
          action: BOOTSTRAP_ADOPTION_ACTION,
          organizationId: TEST_ORGANIZATION_ID,
          subject: 'adoption-owner',
          details: expect.objectContaining({
            userId: 'adoption-owner',
            sessionId: 'adoption-session-owner',
            proofTokenId: TEST_BOOTSTRAP_TOKEN_ID,
          }),
        }),
      ]);

      const noSession = await fixture.handler(adoptionRequest(fixture.appOrigin));
      expect(noSession.status).toBe(401);
      const wrongProof = await fixture.handler(adoptionRequest(fixture.appOrigin, ownerCookie, 'wrong-proof'));
      expect(wrongProof.status).toBe(403);
      const otherCookie = await fixture.cookieFor('adoption-session-token-other');
      const conflictingCaller = await fixture.handler(adoptionRequest(fixture.appOrigin, otherCookie));
      expect(conflictingCaller.status).toBe(409);

      await expect(fixture.store.bindOwner(ownerBinding({ sessionId: 'adoption-session-other' })))
        .rejects.toMatchObject({ code: 'BOOTSTRAP_ADOPTION_UNAUTHORIZED', status: 401 });

      const replay = await fixture.handler(adoptionRequest(fixture.appOrigin, ownerCookie));
      expect(replay.status).toBe(200);
      await expect(replay.json()).resolves.toMatchObject({ replayed: true, userId: 'adoption-owner' });

      const concurrent = await Promise.allSettled([
        fixture.store.bindOwner(ownerBinding()),
        fixture.store.bindOwner(ownerBinding({
          userId: 'adoption-other',
          sessionId: 'adoption-session-other',
          proofSubject: 'other-claimant',
        })),
      ]);
      expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(concurrent.filter((result) => result.status === 'rejected')).toHaveLength(1);
      const successfulConcurrent = concurrent.find((result): result is PromiseFulfilledResult<{ replayed: boolean; membershipId?: string }> => result.status === 'fulfilled');
      expect(successfulConcurrent?.value.replayed).toBe(true);
      const rejectedConcurrent = concurrent.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      expect(rejectedConcurrent?.reason).toMatchObject({ code: 'BOOTSTRAP_ADOPTION_CONFLICT', status: 409 });

      const stateAfterReplay = await fixture.repository.read(TEST_ORGANIZATION_ID);
      expect(stateAfterReplay.skills).toEqual([legacySkill]);
      expect(stateAfterReplay.audit).toHaveLength(2);
      expect(stateAfterReplay.audit[0]).toEqual(legacyAudit);
      expect(stateAfterReplay.audit[1]).toMatchObject({ subject: 'adoption-owner', action: BOOTSTRAP_ADOPTION_ACTION });

      const finalMembers = await queryRows<{ id: string; organizationId: string; userId: string; role: string }>(fixture.direct,
        `SELECT "id", "organizationId", "userId", "role" FROM ${qualifiedTable(fixture.schema, 'member')} WHERE "organizationId" = $1`,
        [TEST_ORGANIZATION_ID],
      );
      expect(finalMembers).toEqual([{
        id: 'adoption-member-owner',
        organizationId: TEST_ORGANIZATION_ID,
        userId: 'adoption-owner',
        role: 'owner',
      }]);
      const finalSessions = await queryRows<{ id: string; activeOrganizationId: string | null }>(fixture.direct,
        `SELECT "id", "activeOrganizationId" FROM ${qualifiedTable(fixture.schema, 'session')} WHERE "id" IN ($1, $2) ORDER BY "id"`,
        ['adoption-session-owner', 'adoption-session-other'],
      );
      expect(finalSessions).toEqual([
        { id: 'adoption-session-other', activeOrganizationId: null },
        { id: 'adoption-session-owner', activeOrganizationId: TEST_ORGANIZATION_ID },
      ]);

      const finalOrganizations = await queryRows<{ id: string; metadata: unknown }>(fixture.direct,
        `SELECT "id", "metadata" FROM ${qualifiedTable(fixture.schema, 'organization')} WHERE "id" = $1`,
        [TEST_ORGANIZATION_ID],
      );
      expect(finalOrganizations).toHaveLength(1);
      expect(JSON.parse(String(finalOrganizations[0]?.metadata))[BOOTSTRAP_ADOPTION_METADATA_KEY].userId)
        .toBe('adoption-owner');
    } finally {
      await fixture.cleanup();
    }
  }, 45_000);
});
