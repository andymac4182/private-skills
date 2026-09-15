import postgres from 'postgres';
import { makeSignature } from 'better-auth/crypto';
import { describe, expect, it } from 'vitest';

import {
  createRegistryHandler,
} from '../../../packages/core/src/index.js';
import {
  createMemoryStateRepository,
  defaultRegistryState,
} from '../../../packages/database/src/index.js';
import {
  digestBytes,
} from '../../../packages/storage/src/index.js';
import type {
  ApiTokenPgPool,
} from '../../../packages/api-tokens/src/index.js';
import type {
  Authenticator,
  BlobStore,
  Principal,
  RegistryConfiguration,
  StoredBlob,
} from '../../../packages/contracts/src/index.js';
import {
  createIdentityInfrastructure,
} from '../server/identity-infrastructure.js';
import { isIdentityPrincipal } from '../../../packages/identity/src/index.js';
import {
  createTenantHandlerRouter,
  type TenantIdentityRuntime,
  type TenantRuntimeContext,
} from '../server/tenant-runtime.js';
import { readSessionExchangeToken } from '../server/session-exchange.js';

const databaseURL = process.env.PSKILLS_IDENTITY_TEST_DATABASE_URL ?? process.env.PSKILLS_TEST_POSTGRES_URL;
const ORIGIN = 'https://tenant-route-boundary.test';

function isLoopbackDatabase(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const hostname = new URL(value).hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
  } catch {
    return false;
  }
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) throw new Error('invalid test identifier');
  return `"${value}"`;
}

function table(schema: string, name: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}

function createPool(sql: ReturnType<typeof postgres>): ApiTokenPgPool {
  const query = async <Row = Record<string, unknown>>(
    connection: typeof sql,
    text: string,
    parameters: readonly unknown[] = [],
  ) => {
    const result = await connection.unsafe(text, [...parameters] as never[]);
    return { rows: [...result] as unknown as Row[], rowCount: result.count };
  };
  return {
    query: (text, parameters) => query(sql, text, parameters),
    connect: async () => {
      const connection = await sql.reserve();
      return {
        query: (text, parameters) => query(connection as unknown as typeof sql, text, parameters),
        release: () => connection.release(),
      };
    },
  };
}

class MemoryBlobs implements BlobStore {
  private readonly values = new Map<string, Uint8Array>();

  async put(bytes: Uint8Array): Promise<StoredBlob> {
    const digest = await digestBytes(bytes);
    const key = `route-boundary/${digest}`;
    this.values.set(key, new Uint8Array(bytes));
    return { key, digest, size: bytes.byteLength };
  }

  async get(key: string): Promise<Uint8Array> {
    const value = this.values.get(key);
    if (!value) throw new Error('blob not found');
    return new Uint8Array(value);
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
}

function json(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

function sessionCookie(cookieName: string, token: string, secret: string): Promise<string> {
  return makeSignature(token, secret).then((signature) => `${cookieName}=${token}.${signature}`);
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`${ORIGIN}${path}`, init);
}

describe.skipIf(!isLoopbackDatabase(databaseURL))('composed Better Auth and API-token tenant route boundary', () => {
  it('keeps two live companies isolated across sessions, token endpoints, and core routes', async () => {
    if (!databaseURL) return;

    const suffix = `${process.pid}_${Date.now().toString(36)}`;
    const schema = `l10_route_${suffix}`;
    const tokenTable = `l10_tokens_${suffix}`;
    const direct = postgres(databaseURL, { max: 20, prepare: false });
    const pool = createPool(direct);
    const environment = {
      PSKILLS_BETTER_AUTH_ENABLED: 'true',
      DATABASE_URL: databaseURL,
      BETTER_AUTH_SECRET: 'route-boundary-test-secret-0123456789012345',
      BETTER_AUTH_URL: ORIGIN,
      PSKILLS_PUBLIC_ORIGIN: ORIGIN,
      PSKILLS_BETTER_AUTH_SCHEMA: schema,
      PSKILLS_BETTER_AUTH_VALIDATE_SCHEMA: 'false',
      PSKILLS_BETTER_AUTH_AUTO_MIGRATE: 'false',
    };
    const infrastructure = createIdentityInfrastructure(environment, {
      postgresPool: pool,
      canonicalOrigin: ORIGIN,
      apiTokenTableName: tokenTable,
      apiTokenAutoMigrate: true,
    });
    const identity = infrastructure.identity;
    const apiTokens = infrastructure.apiTokens;
    if (!identity || !apiTokens) throw new Error('identity infrastructure did not initialize');

    try {
      await direct.unsafe(`drop schema if exists ${quoteIdentifier(schema)} cascade`);
      await direct.unsafe(`drop table if exists ${quoteIdentifier(tokenTable)}`);
      await identity.runMigrations();

      const nowDate = new Date();
      const now = nowDate.toISOString();
      const expiresAt = new Date(nowDate.getTime() + 60 * 60 * 1000).toISOString();
      await direct.unsafe(
        `insert into ${table(schema, 'user')} ("id","name","email","emailVerified","createdAt","updatedAt") values ($1,$2,$3,true,$4,$4),($5,$6,$7,true,$4,$4)`,
        ['route-user-a', 'Route User A', 'route-user-a@example.test', now, 'route-user-b', 'Route User B', 'route-user-b@example.test'],
      );
      await direct.unsafe(
        `insert into ${table(schema, 'organization')} ("id","name","slug","createdAt") values ($1,$2,$3,$4),($5,$6,$7,$4)`,
        ['tenant-a', 'Tenant A', 'tenant-a', now, 'tenant-b', 'Tenant B', 'tenant-b'],
      );
      await direct.unsafe(
        `insert into ${table(schema, 'member')} ("id","organizationId","userId","role","createdAt") values ($1,$2,$3,'owner',$4),($5,$6,$7,'owner',$4)`,
        ['route-member-a', 'tenant-a', 'route-user-a', now, 'route-member-b', 'tenant-b', 'route-user-b'],
      );
      await direct.unsafe(
        `insert into ${table(schema, 'session')} ("id","expiresAt","token","createdAt","updatedAt","userId","activeOrganizationId") values ($1,$2,$3,$4,$4,$5,$6),($7,$2,$8,$4,$4,$9,$10)`,
        ['route-session-a', expiresAt, 'route-session-token-a', now, 'route-user-a', 'tenant-a', 'route-session-b', 'route-session-token-b', 'route-user-b', 'tenant-b'],
      );

      const context = await identity.auth.$context;
      const cookieName = context.authCookies.sessionToken.name;
      const cookieA = await sessionCookie(cookieName, 'route-session-token-a', context.secret);
      const cookieB = await sessionCookie(cookieName, 'route-session-token-b', context.secret);

      const requestAuthenticator: Authenticator = {
        authenticate: async (incoming) => {
          const browserPrincipal = await identity.authenticate(incoming);
          return browserPrincipal ?? await apiTokens.authenticator.authenticate(incoming);
        },
        createSession: (token) => apiTokens.authenticator.createSession!(token),
        clearSessionCookie: () => apiTokens.authenticator.clearSessionCookie!(),
      };
      const tenantIdentity: TenantIdentityRuntime = {
        authenticate: requestAuthenticator.authenticate,
        getSession: identity.getSession,
        resolveTenant: async (_incoming, principal) => ({
          organizationId: principal.organizationId,
          kind: isIdentityPrincipal(principal) ? 'active-membership' : 'scoped-api',
          provisioned: true,
        }),
      };
      const repository = createMemoryStateRepository({
        stateFactory: () => defaultRegistryState({
          production: false,
          allowUnscanned: true,
          policyRevision: 'route-boundary-test',
        }),
      });
      const blobs = new MemoryBlobs();
      const contexts: TenantRuntimeContext[] = [];
      const registryConfig = (organizationId: string): RegistryConfiguration => ({
        organizationId,
        publicOrigin: ORIGIN,
        maxBodyBytes: 2 * 1024 * 1024,
        leaseSeconds: 60,
        allowLoopbackUpstreams: true,
      });
      const tenantRouter = createTenantHandlerRouter({
        defaultOrganizationId: 'tenant-a',
        identity: tenantIdentity,
        authenticator: requestAuthenticator,
        createHandler: (tenantContext) => {
          contexts.push(tenantContext);
          return createRegistryHandler({
            repository,
            blobs,
            auth: tenantContext.auth,
            config: registryConfig(tenantContext.organizationId),
          });
        },
        defaultHandler: async () => Response.json({ code: 'UNAUTHENTICATED' }, { status: 401 }),
        resolveSessionTenant: async (incoming) => {
          const token = await readSessionExchangeToken(incoming);
          if (token === undefined) return undefined;
          const principal = await apiTokens.authenticator.authenticate(new Request(incoming.url, {
            method: 'GET',
            headers: { authorization: `Bearer ${token}` },
          }));
          const tokenId = (principal as (Principal & { tokenId?: unknown }) | null)?.tokenId;
          return principal && typeof tokenId === 'string'
            ? { organizationId: principal.organizationId, kind: 'scoped-api' as const, roles: principal.roles, scopes: principal.scopes, provisioned: true }
            : undefined;
        },
      });

      // This is the same outer route composition used by the Node runtime:
      // token management is handled by the API-token module, while every
      // registry route crosses the verified tenant router before core.
      const dispatch = async (incoming: Request): Promise<Response> => {
        const path = new URL(incoming.url).pathname;
        if (path === '/v1/tokens' || path.startsWith('/v1/tokens/')) {
          const tokenResponse = await apiTokens.handler(incoming);
          if (tokenResponse) return tokenResponse;
        }
        return tenantRouter(incoming);
      };

      const createToken = async (
        cookie: string,
        name: string,
        roleCeiling: 'reader' | 'publisher' = 'reader',
        scopes: readonly string[] = ['registry:read'],
      ) => dispatch(request('/v1/tokens', {
        method: 'POST',
        headers: {
          cookie,
          origin: ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name, roleCeiling, scopes, expiresInSeconds: 3_600 }),
      }));
      const tokenResponseA = await createToken(cookieA, 'tenant-a cli', 'publisher', ['skills:publish']);
      const tokenResponseB = await createToken(cookieB, 'tenant-b cli');
      expect(tokenResponseA.status).toBe(201);
      expect(tokenResponseB.status).toBe(201);
      const tokenBodyA = await json(tokenResponseA);
      const tokenBodyB = await json(tokenResponseB);
      expect(tokenBodyA).not.toHaveProperty('tokenHash');
      expect(tokenBodyB).not.toHaveProperty('tokenHash');
      const tokenA = tokenBodyA.token;
      const tokenB = tokenBodyB.token;
      expect(typeof tokenA).toBe('string');
      expect(typeof tokenB).toBe('string');

      const exchange = async (token: string): Promise<string> => {
        const response = await dispatch(request('/auth/session', {
          method: 'POST',
          headers: { origin: ORIGIN, 'content-type': 'application/json' },
          body: JSON.stringify({ token }),
        }));
        expect(response.status).toBe(200);
        const cookie = response.headers.get('set-cookie');
        expect(cookie).toMatch(/^pskills_session=api-token-session-v1\./u);
        return cookie!.split(';', 1)[0]!;
      };
      const apiSessionA = await exchange(String(tokenA));
      const apiSessionB = await exchange(String(tokenB));
      const exchangedA = await dispatch(request('/v1/me', { headers: { cookie: apiSessionA, 'x-organization-id': 'tenant-b' } }));
      const exchangedB = await dispatch(request('/v1/me', { headers: { cookie: apiSessionB, 'x-organization-id': 'tenant-a' } }));
      expect(await json(exchangedA)).toMatchObject({ organizationId: 'tenant-a', subject: 'route-user-a', roles: ['publisher'], scopes: ['skills:publish'] });
      expect(await json(exchangedB)).toMatchObject({ organizationId: 'tenant-b', subject: 'route-user-b' });

      await direct.unsafe(`update ${table(schema, 'member')} set "role" = 'reader' where "id" = $1`, ['route-member-a']);
      const downgradedA = await dispatch(request('/v1/me', { headers: { cookie: apiSessionA } }));
      expect(downgradedA.status).toBe(200);
      expect(await json(downgradedA)).toMatchObject({ organizationId: 'tenant-a', subject: 'route-user-a', roles: ['reader'], scopes: [] });

      const sessionA = await dispatch(request('/v1/me', {
        headers: { cookie: cookieA, 'x-organization-id': 'tenant-b' },
      }));
      const sessionB = await dispatch(request('/v1/me', {
        headers: { cookie: cookieB, 'x-organization-id': 'tenant-a' },
      }));
      const bearerA = await dispatch(request('/v1/me', {
        headers: { authorization: `Bearer ${String(tokenA)}`, 'x-organization-id': 'tenant-b' },
      }));
      const bearerB = await dispatch(request('/v1/me', {
        headers: { authorization: `Bearer ${String(tokenB)}`, 'x-organization-id': 'tenant-a' },
      }));
      expect(await json(sessionA)).toMatchObject({ organizationId: 'tenant-a', subject: 'route-user-a' });
      expect(await json(sessionB)).toMatchObject({ organizationId: 'tenant-b', subject: 'route-user-b' });
      expect(await json(bearerA)).toMatchObject({ organizationId: 'tenant-a', subject: 'route-user-a' });
      expect(await json(bearerB)).toMatchObject({ organizationId: 'tenant-b', subject: 'route-user-b' });
      expect(contexts.map(({ organizationId }) => organizationId)).toEqual(['tenant-a', 'tenant-b']);

      const listA = await dispatch(request('/v1/tokens', { headers: { cookie: cookieA } }));
      const listB = await dispatch(request('/v1/tokens', { headers: { cookie: cookieB } }));
      expect((await json(listA)).tokens).toMatchObject([{ organizationId: 'tenant-a', userId: 'route-user-a' }]);
      expect((await json(listB)).tokens).toMatchObject([{ organizationId: 'tenant-b', userId: 'route-user-b' }]);

      const crossCompanyCreate = await dispatch(request('/v1/tokens', {
        method: 'POST',
        headers: { cookie: cookieA, origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ organizationId: 'tenant-b', name: 'cross-company', scopes: ['registry:read'] }),
      }));
      expect(crossCompanyCreate.status).toBe(403);
      expect(await json(crossCompanyCreate)).toMatchObject({ code: 'FORBIDDEN' });

      const revokeA = await dispatch(request(`/v1/tokens/${String(tokenBodyA.id)}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${String(tokenA)}` },
      }));
      expect(revokeA.status).toBe(200);
      expect((await dispatch(request('/v1/me', { headers: { cookie: apiSessionA } }))).status).toBe(401);

      await direct.unsafe(`delete from ${table(schema, 'member')} where "id" = $1`, ['route-member-a']);
      const revokedSession = await dispatch(request('/v1/me', { headers: { cookie: cookieA } }));
      const revokedBearer = await dispatch(request('/v1/me', { headers: { authorization: `Bearer ${String(tokenA)}` } }));
      expect(revokedSession.status).toBe(409);
      expect(await json(revokedSession)).toMatchObject({ code: 'TENANT_ONBOARDING' });
      expect(revokedBearer.status).toBe(401);
      expect(await json(revokedBearer)).toMatchObject({ code: 'UNAUTHENTICATED' });
      expect(await json(await dispatch(request('/v1/me', { headers: { cookie: cookieB } })))).toMatchObject({ organizationId: 'tenant-b' });
      expect((await dispatch(request('/v1/me', { headers: { cookie: apiSessionA } }))).status).toBe(401);
      expect((await dispatch(request('/v1/me', { headers: { cookie: apiSessionB } }))).status).toBe(200);

      await direct.unsafe(`delete from ${table(schema, 'member')} where "id" = $1`, ['route-member-b']);
      expect((await dispatch(request('/v1/me', { headers: { cookie: apiSessionB } }))).status).toBe(401);
    } finally {
      await identity.close();
      await direct.unsafe(`drop schema if exists ${quoteIdentifier(schema)} cascade`);
      await direct.unsafe(`drop table if exists ${quoteIdentifier(tokenTable)}`);
      await direct.end();
    }
  }, 30_000);
});
