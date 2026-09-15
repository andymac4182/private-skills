import { createServer } from 'node:http';

import { makeSignature } from 'better-auth/crypto';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';

import {
  createInfrastructure,
} from '../server/runtime-node.js';
import { handleCompanySsoRoute } from '../server/company-sso-runtime.js';
import type { ApiTokenPgPool } from '../../../packages/api-tokens/src/index.js';

const databaseURL = process.env.PSKILLS_IDENTITY_TEST_DATABASE_URL ?? process.env.PSKILLS_TEST_POSTGRES_URL;
const ORIGIN = 'https://company-sso-runtime.test';

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

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`${ORIGIN}${path}`, init);
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('SSO fixture did not expose a port');
  return address.port;
}

describe.skipIf(!isLoopbackDatabase(databaseURL))('composed company SSO runtime', () => {
  it('waits for opted-in Better Auth and private SSO migrations before returning infrastructure', async () => {
    if (!databaseURL) return;
    const suffix = `${process.pid}_${Date.now().toString(36)}`;
    const schema = `sso_startup_${suffix}`;
    const companyTable = `sso_startup_registry_${suffix}`;
    const statePath = `/tmp/private-skills-sso-startup-state-${suffix}`;
    const storagePath = `/tmp/private-skills-sso-startup-storage-${suffix}`;
    const direct = postgres(databaseURL, { max: 20, prepare: false });
    let infrastructure: Awaited<ReturnType<typeof createInfrastructure>> | undefined;
    try {
      await direct.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      infrastructure = await createInfrastructure({
        PSKILLS_BETTER_AUTH_ENABLED: 'true',
        DATABASE_URL: databaseURL,
        BETTER_AUTH_SECRET: 'company-sso-startup-test-secret-0123456789',
        BETTER_AUTH_URL: ORIGIN,
        PSKILLS_PUBLIC_ORIGIN: ORIGIN,
        PSKILLS_ENVIRONMENT: 'test',
        PSKILLS_STATE_PROVIDER: 'file',
        PSKILLS_SINGLE_PROCESS: 'true',
        PSKILLS_STATE_PATH: statePath,
        PSKILLS_STORAGE_PROVIDER: 'filesystem',
        PSKILLS_STORAGE_ROOT: storagePath,
        PSKILLS_BETTER_AUTH_SCHEMA: schema,
        PSKILLS_BETTER_AUTH_VALIDATE_SCHEMA: 'false',
        PSKILLS_BETTER_AUTH_AUTO_MIGRATE: 'true',
        PSKILLS_COMPANY_SSO_AUTO_MIGRATE: 'true',
        PSKILLS_COMPANY_SSO_TABLE_NAME: companyTable,
      });

      const tables = await direct.unsafe(
        'SELECT to_regclass($1) AS better_auth_table, to_regclass($2) AS company_sso_table',
        [`${schema}.user`, `${schema}.${companyTable}`],
      );
      expect(tables[0] as unknown as { better_auth_table: string | null; company_sso_table: string | null }).toEqual({
        better_auth_table: `${schema}."user"`,
        company_sso_table: `${schema}.${companyTable}`,
      });
    } finally {
      await infrastructure?.identity?.close();
      await direct.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      await direct.end({ timeout: 5 });
    }
  }, 45_000);

  it('serves the mounted admin route from PostgreSQL and mirrors a provider into Better Auth', async () => {
    if (!databaseURL) return;
    const suffix = `${process.pid}_${Date.now().toString(36)}`;
    const schema = `sso_runtime_${suffix}`;
    const companyTable = `sso_registry_${suffix}`;
    const statePath = `/tmp/private-skills-sso-state-${suffix}`;
    const storagePath = `/tmp/private-skills-sso-storage-${suffix}`;
    const direct = postgres(databaseURL, { max: 20, prepare: false });
    const pool = createPool(direct);
    const environment = {
      PSKILLS_BETTER_AUTH_ENABLED: 'true',
      DATABASE_URL: databaseURL,
      BETTER_AUTH_SECRET: 'company-sso-runtime-test-secret-0123456789',
      BETTER_AUTH_URL: ORIGIN,
      PSKILLS_PUBLIC_ORIGIN: ORIGIN,
      PSKILLS_ENVIRONMENT: 'test',
      PSKILLS_STATE_PROVIDER: 'file',
      PSKILLS_SINGLE_PROCESS: 'true',
      PSKILLS_STATE_PATH: statePath,
      PSKILLS_STORAGE_PROVIDER: 'filesystem',
      PSKILLS_STORAGE_ROOT: storagePath,
      PSKILLS_BETTER_AUTH_SCHEMA: schema,
      PSKILLS_BETTER_AUTH_VALIDATE_SCHEMA: 'false',
      PSKILLS_BETTER_AUTH_AUTO_MIGRATE: 'true',
      PSKILLS_COMPANY_SSO_AUTO_MIGRATE: 'true',
      PSKILLS_COMPANY_SSO_TABLE_NAME: companyTable,
    };
    await direct.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    const infrastructure = await createInfrastructure(environment);
    const identity = infrastructure.identity;
    const companySso = infrastructure.companySso;
    if (!identity || !companySso) throw new Error('company SSO infrastructure did not initialize');
    const loginRuntime = {
      identityHandler: identity.handler,
      basePath: identity.publicProviderConfig().basePath,
      appOrigin: ORIGIN,
      allowLoopbackHttp: true,
    };

    let fixture: ReturnType<typeof createServer> | undefined;
    try {
      const nowDate = new Date();
      const now = nowDate.toISOString();
      const expiresAt = new Date(nowDate.getTime() + 60 * 60 * 1000).toISOString();
      await direct.unsafe(
        `INSERT INTO ${table(schema, 'user')} ("id","name","email","emailVerified","createdAt","updatedAt") VALUES ($1,$2,$3,true,$4,$4)`,
        ['sso-runtime-admin', 'SSO Runtime Admin', 'sso-runtime-admin@example.test', now],
      );
      await direct.unsafe(
        `INSERT INTO ${table(schema, 'organization')} ("id","name","slug","createdAt") VALUES ($1,$2,$3,$4)`,
        ['sso-runtime-acme', 'SSO Runtime Acme', 'sso-runtime-acme', now],
      );
      await direct.unsafe(
        `INSERT INTO ${table(schema, 'member')} ("id","organizationId","userId","role","createdAt") VALUES ($1,$2,$3,'owner',$4)`,
        ['sso-runtime-member', 'sso-runtime-acme', 'sso-runtime-admin', now],
      );
      await direct.unsafe(
        `INSERT INTO ${table(schema, 'session')} ("id","expiresAt","token","createdAt","updatedAt","userId","activeOrganizationId") VALUES ($1,$2,$3,$4,$4,$5,$6)`,
        ['sso-runtime-session', expiresAt, 'sso-runtime-session-token', now, 'sso-runtime-admin', 'sso-runtime-acme'],
      );

      const context = await identity.auth.$context;
      const cookieName = context.authCookies.sessionToken.name;
      const signature = await makeSignature('sso-runtime-session-token', context.secret);
      const cookie = `${cookieName}=sso-runtime-session-token.${signature}`;

      const listed = await handleCompanySsoRoute(
        request('/v1/companies/sso-runtime-acme/sso/providers', { headers: { cookie } }),
        companySso,
      );
      expect(listed?.status).toBe(200);
      await expect(listed?.json()).resolves.toMatchObject({ providers: [] });

      const unauthenticated = await handleCompanySsoRoute(
        request('/v1/companies/sso-runtime-acme/sso/providers'),
        companySso,
      );
      expect(unauthenticated?.status).toBe(403);
      const wrongCompany = await handleCompanySsoRoute(
        request('/v1/companies/sso-runtime-other/sso/providers', { headers: { cookie } }),
        companySso,
      );
      expect(wrongCompany?.status).toBe(403);

      let issuer = '';
      fixture = createServer((incoming, response) => {
        const url = new URL(incoming.url ?? '/', issuer || 'http://127.0.0.1/');
        if (url.pathname === '/.well-known/openid-configuration' && incoming.method === 'GET') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            jwks_uri: `${issuer}/jwks`,
          }));
          return;
        }
        response.writeHead(404);
        response.end();
      });
      const port = await listen(fixture);
      issuer = `http://127.0.0.1:${port}`;

      const created = await handleCompanySsoRoute(
        request('/v1/companies/sso-runtime-acme/sso/providers', {
          method: 'POST',
          headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
          body: JSON.stringify({
            providerId: 'acme-runtime-oidc',
            displayName: 'Acme Runtime OIDC',
            protocol: 'oidc',
            issuer,
            oidc: {
              clientId: 'runtime-client',
              clientSecret: 'runtime-secret',
              discoveryUrl: `${issuer}/.well-known/openid-configuration`,
            },
          }),
        }),
        companySso,
      );
      expect(created?.status).toBe(201);
      const createdBody = await created?.json() as { provider?: { callbackUrl?: string; providerId?: string; organizationId?: string } };
      expect(createdBody).toMatchObject({ provider: { providerId: 'acme-runtime-oidc', organizationId: 'sso-runtime-acme' } });
      expect(createdBody.provider?.callbackUrl).toBe(`${ORIGIN}/api/auth/sso/callback/acme-runtime-oidc`);

      const discovered = await handleCompanySsoRoute(
        request('/v1/companies/sso-runtime-acme/sso/login'),
        companySso,
        loginRuntime,
      );
      expect(discovered?.status).toBe(200);
      await expect(discovered?.json()).resolves.toMatchObject({
        organizationId: 'sso-runtime-acme',
        providers: [{ providerId: 'acme-runtime-oidc', displayName: 'Acme Runtime OIDC', protocol: 'oidc' }],
      });

      const signIn = await handleCompanySsoRoute(
        request('/v1/companies/sso-runtime-acme/sso/login', {
          method: 'POST',
          headers: { origin: ORIGIN, 'content-type': 'application/json' },
          body: JSON.stringify({ providerId: 'acme-runtime-oidc', callbackURL: '/app' }),
        }),
        companySso,
        loginRuntime,
      );
      expect(signIn?.status).toBe(200);
      const signInBody = await signIn?.json() as { url?: string; redirect?: boolean };
      expect(signInBody.redirect).toBe(true);
      expect(signInBody.url).toContain(`${issuer}/authorize`);
      expect(new URL(signInBody.url!).searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/sso/callback/acme-runtime-oidc`);

      const mirrored = await context.adapter.findOne<Record<string, unknown>>({
        model: 'ssoProvider',
        where: [{ field: 'providerId', value: 'acme-runtime-oidc' }],
      });
      expect(mirrored).toMatchObject({
        providerId: 'acme-runtime-oidc',
        organizationId: 'sso-runtime-acme',
        userId: 'sso-runtime-admin',
      });

    } finally {
      fixture?.close();
      await identity.close();
      await direct.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      await direct.end({ timeout: 5 });
    }
  }, 45_000);
});
