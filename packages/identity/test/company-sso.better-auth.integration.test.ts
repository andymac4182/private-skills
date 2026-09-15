import { createSign, generateKeyPairSync } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { organization } from 'better-auth/plugins';
import postgres from 'postgres';
import { PostgresJSDialect } from 'kysely-postgres-js';
import { describe, expect, it } from 'vitest';

import {
  COMPANY_SSO_CALLBACK_PATH,
  MemoryCompanySsoRepository,
  companySsoCallbackUrl,
  createCompanySsoPlugin,
  syncCompanySsoProvider,
  validateCompanySsoRegistration,
  type CompanySsoProviderRecord,
} from '../src/company-sso.js';

const databaseURL = process.env.PSKILLS_IDENTITY_TEST_DATABASE_URL;

function base64url(value: string | Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

function signedIdToken(
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  issuer: string,
  clientId: string,
  subject: string,
  nonce: string | null,
): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', kid: 'company-sso-fixture', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss: issuer,
    sub: subject,
    aud: clientId,
    ...(nonce ? { nonce } : {}),
    email: 'alice@acme.test',
    email_verified: true,
    name: 'Alice Acme',
    iat: Math.floor(Date.now() / 1_000),
    exp: Math.floor(Date.now() / 1_000) + 600,
  }));
  const signingInput = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${base64url(signer.sign(privateKey))}`;
}

interface OidcFixture {
  issuer: string;
  server: Server;
  close(): Promise<void>;
}

async function createOidcFixture(): Promise<OidcFixture> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2_048 });
  const exportedJwk = publicKey.export({ format: 'jwk' });
  const jwk = { ...exportedJwk, alg: 'RS256', kid: 'company-sso-fixture', use: 'sig' };
  let issuer = '';
  let authorization: { code: string; redirectUri: string; clientId: string; nonce: string | null } | undefined;
  const server = createServer((request, response) => {
    void handleFixtureRequest(request, response);
  });

  async function handleFixtureRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestUrl = new URL(request.url ?? '/', issuer || 'http://127.0.0.1/');
    if (requestUrl.pathname === '/.well-known/openid-configuration' && request.method === 'GET') {
      return sendJson(response, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
      });
    }
    if (requestUrl.pathname === '/jwks' && request.method === 'GET') return sendJson(response, { keys: [jwk] });
    if (requestUrl.pathname === '/authorize' && request.method === 'GET') {
      const redirectUri = requestUrl.searchParams.get('redirect_uri');
      const state = requestUrl.searchParams.get('state');
      const clientId = requestUrl.searchParams.get('client_id');
      if (!redirectUri || !state || !clientId) return sendText(response, 400, 'authorization request is incomplete');
      authorization = {
        code: 'company-sso-fixture-code',
        redirectUri,
        clientId,
        nonce: requestUrl.searchParams.get('nonce'),
      };
      const callback = new URL(redirectUri);
      callback.searchParams.set('code', authorization.code);
      callback.searchParams.set('state', state);
      response.writeHead(302, { location: callback.toString() });
      response.end();
      return;
    }
    if (requestUrl.pathname === '/token' && request.method === 'POST') {
      const body = await readBody(request);
      const form = new URLSearchParams(body);
      const basicCredentials = request.headers.authorization?.startsWith('Basic ')
        ? Buffer.from(request.headers.authorization.slice('Basic '.length), 'base64').toString('utf8')
        : '';
      const clientAuthenticated = form.get('client_id') === authorization?.clientId
        || basicCredentials === `${authorization?.clientId}:company-fixture-secret`;
      if (!authorization || form.get('code') !== authorization.code || form.get('redirect_uri') !== authorization.redirectUri || !clientAuthenticated) {
        return sendJson(response, { error: 'invalid_grant' }, 400);
      }
      return sendJson(response, {
        access_token: 'company-sso-fixture-access-token',
        token_type: 'Bearer',
        expires_in: 600,
        id_token: signedIdToken(privateKey, issuer, authorization.clientId, 'alice-acme-subject', authorization.nonce),
      });
    }
    sendText(response, 404, 'not found');
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('OIDC fixture did not bind a TCP port');
  issuer = `http://127.0.0.1:${address.port}`;
  return {
    issuer,
    server,
    close: async () => await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function sendJson(response: ServerResponse, value: unknown, status = 200): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

function sendText(response: ServerResponse, status: number, value: string): void {
  response.writeHead(status, { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(value) });
  response.end(value);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function cookieHeader(response: Response): string {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.() ?? (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')!] : []);
  return values.map((cookie) => cookie.split(';', 1)[0]).join('; ');
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function testRecord(
  issuer: string,
  appOrigin: string,
  validated: Awaited<ReturnType<typeof validateCompanySsoRegistration>>,
): CompanySsoProviderRecord {
  const now = new Date('2026-09-15T00:00:00.000Z').toISOString();
  return {
    id: 'company-sso-row-acme-oidc',
    ...validated,
    issuer,
    callbackUrl: companySsoCallbackUrl(appOrigin, 'acme-oidc', true),
    createdBy: 'company-sso-admin',
    updatedBy: 'company-sso-admin',
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
}

describe.skipIf(!databaseURL)('company SSO Better Auth OIDC callback', () => {
  it('looks up the bridged persisted provider and assigns the verified user to its organization', async () => {
    if (!databaseURL) return;
    const fixture = await createOidcFixture();
    const appOrigin = 'http://127.0.0.1:57639';
    const schema = `company_sso_callback_${process.pid}_${Date.now()}`;
    const sql = postgres(databaseURL, { max: 8, prepare: false });
    const repository = new MemoryCompanySsoRepository();
    const auth = betterAuth({
      appName: 'Company SSO callback test',
      baseURL: appOrigin,
      basePath: '/api/auth',
      secret: 'company-sso-integration-test-secret-0123456789',
      database: {
        dialect: new PostgresJSDialect({ postgres: sql }),
        type: 'postgres',
        transaction: true,
        schemaName: schema,
      },
      plugins: [
        organization({ allowUserToCreateOrganization: false }),
        createCompanySsoPlugin({ repository }),
      ],
      trustedOrigins: [appOrigin, fixture.issuer],
      advanced: {
        database: { validateSchema: false },
        useSecureCookies: false,
        skipTrailingSlashes: true,
      },
      account: {
        accountLinking: {
          enabled: true,
          disableImplicitLinking: true,
          requireLocalEmailVerified: true,
        },
      },
    });
    const direct = postgres(databaseURL, { max: 2, prepare: false });
    try {
      await direct.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      await (await getMigrations(auth.options)).runMigrations();
      const context = await auth.$context;
      const now = new Date();
      await context.adapter.create({
        model: 'user',
        data: {
          id: 'company-sso-admin',
          name: 'Company SSO Admin',
          email: 'admin@acme.test',
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        },
        forceAllowId: true,
      });
      await context.adapter.create({
        model: 'organization',
        data: { id: 'acme', name: 'Acme Labs', slug: 'acme', createdAt: now },
        forceAllowId: true,
      });
      const providerInput = await validateCompanySsoRegistration('acme', {
        providerId: 'acme-oidc',
        displayName: 'Acme Identity',
        protocol: 'oidc',
        issuer: fixture.issuer,
        callbackUrl: companySsoCallbackUrl(appOrigin, 'acme-oidc', true),
        oidc: {
          clientId: 'company-fixture-client',
          clientSecret: 'company-fixture-secret',
          discoveryUrl: `${fixture.issuer}/.well-known/openid-configuration`,
          scopes: ['openid', 'profile', 'email'],
        },
      }, {
        appOrigin,
        allowLoopbackHttp: true,
      });
      const record = testRecord(fixture.issuer, appOrigin, providerInput);
      await repository.create(record);
      await syncCompanySsoProvider(auth, record);
      const bridged = await context.adapter.findOne<Record<string, unknown>>({
        model: 'ssoProvider',
        where: [{ field: 'providerId', value: record.providerId }],
      });
      expect(bridged).toMatchObject({ id: record.id, providerId: record.providerId, organizationId: record.organizationId, userId: record.createdBy });
      expect(JSON.parse(String(bridged?.oidcConfig))).toMatchObject({ issuer: fixture.issuer, discoveryEndpoint: `${fixture.issuer}/.well-known/openid-configuration` });

      const signIn = await auth.handler(new Request(`${appOrigin}/api/auth/sign-in/sso`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: appOrigin },
        body: JSON.stringify({ providerId: record.providerId, providerType: 'oidc', callbackURL: `${appOrigin}/after` }),
      }));
      expect(signIn.status).toBe(200);
      const signInBody = await signIn.json() as { url?: string; redirect?: boolean };
      expect(signInBody.redirect).toBe(true);
      expect(signInBody.url).toContain(`${fixture.issuer}/authorize`);
      expect(new URL(signInBody.url!).searchParams.get('redirect_uri')).toBe(record.callbackUrl);
      const providerRedirect = await fetch(signInBody.url!, { redirect: 'manual' });
      expect(providerRedirect.status).toBe(302);
      const callbackLocation = providerRedirect.headers.get('location');
      expect(callbackLocation).toBeTruthy();
      const callback = await auth.handler(new Request(callbackLocation!, {
        headers: { cookie: cookieHeader(signIn), origin: appOrigin },
      }));
      expect(callback.status).toBe(302);
      expect(callback.headers.get('location')).toBe(`${appOrigin}/after`);
      expect(cookieHeader(callback)).toContain('better-auth.session_token');

      const user = await context.adapter.findOne<Record<string, unknown>>({ model: 'user', where: [{ field: 'email', value: 'alice@acme.test' }] });
      expect(user).toMatchObject({ email: 'alice@acme.test', name: 'Alice Acme' });
      const account = await context.adapter.findOne<Record<string, unknown>>({ model: 'account', where: [{ field: 'providerId', value: record.providerId }, { field: 'accountId', value: 'alice-acme-subject' }] });
      expect(account).toMatchObject({ providerId: record.providerId, accountId: 'alice-acme-subject' });
      const userId = typeof user?.id === 'string' ? user.id : '';
      const member = await context.adapter.findOne<Record<string, unknown>>({ model: 'member', where: [{ field: 'organizationId', value: 'acme' }, { field: 'userId', value: userId }] });
      expect(member).toMatchObject({ organizationId: 'acme', userId, role: 'member' });
    } finally {
      await direct.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      await auth.$context.then(() => undefined).catch(() => undefined);
      await sql.end({ timeout: 5 });
      await direct.end({ timeout: 5 });
      await fixture.close();
    }
  }, 45_000);
});
