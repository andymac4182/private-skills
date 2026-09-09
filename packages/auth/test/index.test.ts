import { describe, expect, it } from 'vitest';
import {
  TokenAuthenticator,
  canAccessNamespace,
  hasScope,
  parseBootstrapTokenEnv,
  timingSafeEqual,
} from '../src/index.js';

function freshSecret(): string {
  return `${crypto.randomUUID()}${crypto.randomUUID()}`;
}

describe('token and session authentication', () => {
  it('hashes and verifies bearer tokens with organization, namespace, role, and scope metadata', async () => {
    const token = crypto.randomUUID();
    const auth = new TokenAuthenticator({
      tokens: [{
        id: 'user',
        token,
        organizationId: 'org-a',
        subject: 'alice',
        roles: ['publisher'],
        namespaces: ['team-a'],
        scopes: ['skills:*'],
      }],
      sessionSecret: freshSecret(),
      environment: 'test',
    });
    const principal = await auth.authenticate(new Request('https://registry.invalid/v1/me', {
      headers: { authorization: `Bearer ${token}` },
    }));
    expect(principal).toMatchObject({
      organizationId: 'org-a',
      subject: 'alice',
      roles: ['publisher'],
      namespaces: ['team-a'],
      scopes: ['skills:*'],
      identity: 'user',
    });
    expect(hasScope(principal, 'skills:publish')).toBe(true);
    expect(canAccessNamespace(principal, 'team-a')).toBe(true);
    expect(canAccessNamespace(principal, 'team-b')).toBe(false);
    expect(await auth.authenticate(new Request('https://registry.invalid/v1/me', {
      headers: { authorization: `Bearer ${crypto.randomUUID()}` },
    }))).toBeNull();
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
  });

  it('rejects expired token material before creating a session', async () => {
    const token = crypto.randomUUID();
    const clock = Date.now();
    const auth = new TokenAuthenticator({
      now: () => clock,
      tokens: [{
        id: 'expired',
        token,
        organizationId: 'org-a',
        subject: 'expired',
        roles: ['reader'],
        expiresAt: new Date(clock - 1).toISOString(),
      }],
      sessionSecret: freshSecret(),
      environment: 'test',
    });
    expect(await auth.authenticate(new Request('https://registry.invalid/v1/me', {
      headers: { authorization: `Bearer ${token}` },
    }))).toBeNull();
    expect(await auth.createSession(token)).toBeNull();
  });

  it('verifies prehashed credentials and expires signed browser cookies', async () => {
    const token = crypto.randomUUID();
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
    let now = Date.now();
    const auth = new TokenAuthenticator({
      tokens: [{
        id: 'hashed',
        tokenHash: digest,
        organizationId: 'org-a',
        subject: 'hashed-user',
        roles: ['reader'],
      }],
      sessionSecret: freshSecret(),
      sessionTtlSeconds: 2,
      environment: 'test',
      now: () => now,
    });
    expect((await auth.authenticate(new Request('https://registry.invalid/v1/me', {
      headers: { authorization: `Bearer ${token}` },
    })))?.subject).toBe('hashed-user');
    const session = await auth.createSession(token);
    expect(session).not.toBeNull();
    const cookie = session!.cookie.split(';', 1)[0]!;
    expect(await auth.authenticate(new Request('https://registry.invalid/v1/me', {
      headers: { cookie },
    }))).not.toBeNull();
    now += 2_001;
    expect(await auth.authenticate(new Request('https://registry.invalid/v1/me', {
      headers: { cookie },
    }))).toBeNull();
  });

  it('signs secure HttpOnly SameSite sessions and enforces Origin on cookie mutations', async () => {
    const token = crypto.randomUUID();
    const auth = new TokenAuthenticator({
      tokens: [{ id: 'user', token, organizationId: 'org-a', subject: 'alice', roles: ['reader'], scopes: ['registry:read'] }],
      sessionSecret: freshSecret(),
      environment: 'production',
      publicOrigin: 'https://registry.invalid',
    });
    const session = await auth.createSession(token);
    expect(session?.cookie).toMatch(/HttpOnly/u);
    expect(session?.cookie).toMatch(/Secure/u);
    expect(session?.cookie).toMatch(/SameSite=Lax/u);
    const cookie = session!.cookie.split(';', 1)[0]!;
    expect(await auth.authenticate(new Request('https://registry.invalid/v1/me', { headers: { cookie } }))).not.toBeNull();
    expect(await auth.authenticate(new Request('https://registry.invalid/v1/update', {
      method: 'POST',
      headers: { cookie, origin: 'https://evil.invalid' },
    }))).toBeNull();
    expect(await auth.authenticate(new Request('https://registry.invalid/v1/update', {
      method: 'POST',
      headers: { cookie, origin: 'https://registry.invalid' },
    }))).not.toBeNull();
    expect(auth.clearSessionCookie()).toMatch(/Max-Age=0/u);
  });

  it('keeps worker credentials separate from browser sessions and parses env records', async () => {
    const userToken = crypto.randomUUID();
    const workerToken = crypto.randomUUID();
    const auth = new TokenAuthenticator({
      tokens: [{ id: 'user', token: userToken, organizationId: 'org-a', subject: 'alice', roles: ['reader'] }],
      workerTokens: [{ id: 'worker', token: workerToken, organizationId: 'org-a', subject: 'runner', roles: ['worker'], scopes: ['jobs:claim'] }],
      sessionSecret: freshSecret(),
      environment: 'test',
    });
    expect(await auth.authenticateWorker(new Request('https://registry.invalid/internal/jobs', {
      headers: { authorization: `Bearer ${userToken}` },
    }))).toBeNull();
    expect((await auth.authenticateWorker(new Request('https://registry.invalid/internal/jobs', {
      headers: { authorization: `Bearer ${workerToken}` },
    })))?.roles).toContain('worker');
    expect(await auth.createSession(workerToken)).toBeNull();

    const parsed = parseBootstrapTokenEnv({
      PSKILLS_BOOTSTRAP_TOKENS: JSON.stringify([{
        id: 'env-user',
        token: crypto.randomUUID(),
        organizationId: 'org-a',
        subject: 'env-user',
        roles: ['publisher'],
        namespaces: ['team-a'],
        scopes: ['skills:publish'],
        kind: 'user',
      }]),
      PSKILLS_WORKER_TOKEN: crypto.randomUUID(),
      PSKILLS_ORGANIZATION_ID: 'org-a',
    });
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ kind: 'user', roles: ['publisher'], namespaces: ['team-a'] });
    expect(parsed[1]).toMatchObject({ kind: 'worker', roles: ['worker'] });
  });

  it('derives scopes from roles only when scopes are omitted and rejects mixed workers', async () => {
    const token = crypto.randomUUID();
    const defaulted = new TokenAuthenticator({
      tokens: [{ id: 'reader', token, organizationId: 'org-a', subject: 'reader', roles: ['reader'] }],
      sessionSecret: freshSecret(),
      environment: 'test',
    });
    expect((await defaulted.authenticate(new Request('https://registry.invalid/v1/me', {
      headers: { authorization: `Bearer ${token}` },
    })))?.scopes).toContain('skills:read');
    const defaultedPrincipal = await defaulted.requirePrincipal(new Request('https://registry.invalid/v1/install-receipts', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    }), { scope: 'install:receipt' });
    expect(defaultedPrincipal.scopes).not.toContain('analytics:write');

    const publisherToken = crypto.randomUUID();
    const publisher = new TokenAuthenticator({
      tokens: [{ id: 'publisher', token: publisherToken, organizationId: 'org-a', subject: 'publisher', roles: ['publisher'] }],
      sessionSecret: freshSecret(),
      environment: 'test',
    });
    const publisherPrincipal = await publisher.requirePrincipal(new Request('https://registry.invalid/v1/install-receipts', {
      method: 'POST',
      headers: { authorization: `Bearer ${publisherToken}` },
    }), { scope: 'install:receipt' });
    expect(publisherPrincipal.scopes).not.toContain('analytics:write');

    const restrictedToken = crypto.randomUUID();
    const restricted = new TokenAuthenticator({
      tokens: [{ id: 'restricted', token: restrictedToken, organizationId: 'org-a', subject: 'restricted', roles: ['reader'], scopes: [] }],
      sessionSecret: freshSecret(),
      environment: 'test',
    });
    expect((await restricted.authenticate(new Request('https://registry.invalid/v1/me', {
      headers: { authorization: `Bearer ${restrictedToken}` },
    })))?.scopes).toEqual([]);

    const mixedWorker = new TokenAuthenticator({
      workerTokens: [{ id: 'mixed', token: crypto.randomUUID(), organizationId: 'org-a', subject: 'mixed', roles: ['worker', 'reader'] }],
      sessionSecret: freshSecret(),
      environment: 'test',
    });
    await expect(mixedWorker.ready()).rejects.toThrow('Worker credentials cannot include user roles');

    const workerToken = crypto.randomUUID();
    const worker = new TokenAuthenticator({
      workerTokens: [{ id: 'worker', token: workerToken, organizationId: 'org-a', subject: 'worker', roles: ['worker'] }],
      sessionSecret: freshSecret(),
      environment: 'test',
    });
    await expect(worker.requirePrincipal(new Request('https://registry.invalid/v1/install-receipts', {
      method: 'POST',
      headers: { authorization: `Bearer ${workerToken}` },
    }), { scope: 'install:receipt' })).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
  });
});
