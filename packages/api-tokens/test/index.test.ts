import { describe, expect, it } from 'vitest';
import {
  ApiTokenError,
  createApiTokenModule,
  createMemoryApiTokenRepository,
  type ApiTokenAuditEvent,
  type MembershipAuthorizer,
  type MembershipSnapshot,
  type OrganizationSession,
} from '../src/index.js';

const NOW = Date.parse('2026-09-15T10:00:00.000Z');

function bearer(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

function sessionCookie(id: string): HeadersInit {
  return { cookie: `better-auth.session=${id}`, origin: 'https://registry.invalid' };
}

class IdentityFixture implements MembershipAuthorizer {
  readonly sessions = new Map<string, OrganizationSession>();
  readonly memberships = new Map<string, MembershipSnapshot>();

  getOrganizationSession(request: Request): Promise<OrganizationSession | null> {
    const cookie = request.headers.get('cookie');
    return Promise.resolve(cookie === null ? null : this.sessions.get(cookie.split('=', 2)[1] ?? '') ?? null);
  }

  getMembership(organizationId: string, userId: string): Promise<MembershipSnapshot | null> {
    return Promise.resolve(this.memberships.get(`${organizationId}/${userId}`) ?? null);
  }

  setSession(cookieId: string, session: OrganizationSession): void {
    this.sessions.set(cookieId, session);
  }

  setMembership(membership: MembershipSnapshot): void {
    this.memberships.set(`${membership.organizationId}/${membership.userId}`, membership);
  }

  removeMembership(organizationId: string, userId: string): void {
    this.memberships.delete(`${organizationId}/${userId}`);
  }
}

function fixture() {
  const identity = new IdentityFixture();
  identity.setSession('a-owner', { userId: 'alice', organizationId: 'tenant-a', sessionId: 'sess-a' });
  identity.setSession('a-reader', { userId: 'amanda', organizationId: 'tenant-a', sessionId: 'sess-amanda' });
  identity.setSession('b-owner', { userId: 'bob', organizationId: 'tenant-b', sessionId: 'sess-b' });
  identity.setMembership({ userId: 'alice', organizationId: 'tenant-a', roles: ['owner'] });
  identity.setMembership({ userId: 'amanda', organizationId: 'tenant-a', roles: ['reader'] });
  identity.setMembership({ userId: 'bob', organizationId: 'tenant-b', roles: ['owner'] });
  const repository = createMemoryApiTokenRepository();
  const audit: ApiTokenAuditEvent[] = [];
  const module = createApiTokenModule({
    repository,
    membershipAuthorizer: identity,
    audit: { append: (event) => { audit.push(event); } },
    now: () => NOW,
    tokenGenerator: (() => {
      const values = ['psk_alice-token-with-enough-entropy-001', 'psk_bob-token-with-enough-entropy-002', 'psk_reader-token-with-enough-entropy-003'];
      return () => values.shift() ?? `psk_generated-token-with-enough-entropy-${crypto.randomUUID()}`;
    })(),
    defaultTtlSeconds: 3_600,
    maxTtlSeconds: 86_400,
    canonicalOrigin: 'https://registry.invalid',
  });
  return { identity, repository, audit, module };
}

async function json(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

describe('company-scoped API tokens', () => {
  it('creates a hash-only token and shows the raw secret once', async () => {
    const { module, repository, audit } = fixture();
    const response = await module.handler(new Request('https://registry.invalid/v1/tokens', {
      method: 'POST',
      headers: { ...sessionCookie('a-owner'), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Alice CLI', roleCeiling: 'reader', scopes: ['skills:read'], expiresInSeconds: 3_600 }),
    }));
    expect(response?.status).toBe(201);
    const created = await json(response!);
    expect(created).toMatchObject({
      id: expect.any(String),
      organizationId: 'tenant-a',
      userId: 'alice',
      name: 'Alice CLI',
      roleCeiling: 'reader',
      scopes: ['skills:read'],
      token: 'psk_alice-token-with-enough-entropy-001',
    });
    expect(created.expiresAt).toBe('2026-09-15T11:00:00.000Z');

    const rows = await repository.list('tenant-a');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(rows[0]!.tokenHash).not.toContain(created.token);
    const listed = await module.handler(new Request('https://registry.invalid/v1/tokens', {
      headers: sessionCookie('a-owner'),
    }));
    const listBody = await json(listed!);
    expect(listBody.tokens[0]).not.toHaveProperty('token');
    expect(JSON.stringify(listBody)).not.toContain(created.token);
    expect(JSON.stringify(audit)).not.toContain(created.token);
    expect(JSON.stringify(audit)).not.toContain(rows[0]!.tokenHash);
    expect(audit[0]).toMatchObject({ action: 'api_token.created', tokenId: created.id, organizationId: 'tenant-a', actorId: 'alice' });
  });

  it('rejects role and scope escalation from the current membership', async () => {
    const { module } = fixture();
    await expect(module.service.createToken(
      { userId: 'amanda', organizationId: 'tenant-a' },
      { name: 'admin attempt', roleCeiling: 'admin', scopes: ['registry:read'] },
    )).rejects.toMatchObject({ code: 'ROLE_ESCALATION', status: 403 });
    await expect(module.service.createToken(
      { userId: 'amanda', organizationId: 'tenant-a' },
      { name: 'write attempt', roleCeiling: 'reader', scopes: ['skills:publish'] },
    )).rejects.toMatchObject({ code: 'SCOPE_ESCALATION', status: 403 });
    await expect(module.service.createToken(
      { userId: 'alice', organizationId: 'tenant-a' },
      { name: 'worker attempt', roleCeiling: 'worker' },
    )).rejects.toMatchObject({ code: 'ROLE_ESCALATION', status: 403 });
  });

  it('keeps tenant A and tenant B isolated in list, revoke, and bearer auth', async () => {
    const { module, identity } = fixture();
    const createdA = await module.service.createToken({ userId: 'alice', organizationId: 'tenant-a' }, {
      name: 'A token', roleCeiling: 'reader', scopes: ['skills:read'], expiresInSeconds: 3_600,
    });
    const createdB = await module.service.createToken({ userId: 'bob', organizationId: 'tenant-b' }, {
      name: 'B token', roleCeiling: 'reader', scopes: ['skills:read'], expiresInSeconds: 3_600,
    });
    expect((await module.service.listTokens({ userId: 'alice', organizationId: 'tenant-a' }))).toHaveLength(1);
    expect((await module.service.listTokens({ userId: 'bob', organizationId: 'tenant-b' }))).toHaveLength(1);
    await expect(module.service.revokeToken({ userId: 'alice', organizationId: 'tenant-a' }, createdB.id)).rejects.toMatchObject({ code: 'TOKEN_NOT_FOUND', status: 404 });
    expect((await module.service.authenticateBearerToken(createdA.token))).toMatchObject({ organizationId: 'tenant-a', subject: 'alice', tokenId: createdA.id });
    expect((await module.service.authenticateBearerToken(createdB.token))).toMatchObject({ organizationId: 'tenant-b', subject: 'bob', tokenId: createdB.id });
    // The record is bound to A even if a caller later tries to make A's user
    // appear as a member of B; the identity callback's exact org lookup wins.
    identity.setMembership({ userId: 'alice', organizationId: 'tenant-b', roles: ['owner'] });
    expect((await module.service.authenticateBearerToken(createdA.token))?.organizationId).toBe('tenant-a');
  });

  it('allows a reader to list/revoke its own tokens and prevents cross-member revoke', async () => {
    const { module } = fixture();
    const readerToken = await module.service.createToken({ userId: 'amanda', organizationId: 'tenant-a' }, {
      name: 'reader token', roleCeiling: 'reader', scopes: ['skills:read'], expiresInSeconds: 3_600,
    });
    const ownerToken = await module.service.createToken({ userId: 'alice', organizationId: 'tenant-a' }, {
      name: 'owner token', roleCeiling: 'reader', scopes: ['skills:read'], expiresInSeconds: 3_600,
    });
    expect((await module.service.listTokens({ userId: 'amanda', organizationId: 'tenant-a' }))).toHaveLength(1);
    await expect(module.service.revokeToken({ userId: 'amanda', organizationId: 'tenant-a' }, ownerToken.id)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await module.service.revokeToken({ userId: 'amanda', organizationId: 'tenant-a' }, readerToken.id);
    expect(await module.service.authenticateBearerToken(readerToken.token)).toBeNull();
  });

  it('lets an owner-ceiling CLI token manage organization tokens after membership recheck', async () => {
    const { module } = fixture();
    const owner = await module.service.createToken({ userId: 'alice', organizationId: 'tenant-a' }, {
      name: 'owner CLI', roleCeiling: 'owner', scopes: ['*'], expiresInSeconds: 3_600,
    });
    const reader = await module.service.createToken({ userId: 'amanda', organizationId: 'tenant-a' }, {
      name: 'reader CLI', roleCeiling: 'reader', scopes: ['skills:read'], expiresInSeconds: 3_600,
    });
    const list = await module.handler(new Request('https://registry.invalid/v1/tokens', { headers: bearer(owner.token) }));
    expect((await json(list!)).tokens).toHaveLength(2);
    const revoke = await module.handler(new Request(`https://registry.invalid/v1/tokens/${reader.id}`, { method: 'DELETE', headers: bearer(owner.token) }));
    expect(revoke?.status).toBe(200);
    expect(await module.service.authenticateBearerToken(reader.token)).toBeNull();
  });

  it('keeps a reader-ceiling bearer listing self-only under an owner membership', async () => {
    const { module } = fixture();
    const readerCeiling = await module.service.createToken({ userId: 'alice', organizationId: 'tenant-a' }, {
      name: 'limited owner CLI', roleCeiling: 'reader', scopes: ['skills:read'], expiresInSeconds: 3_600,
    });
    await module.service.createToken({ userId: 'amanda', organizationId: 'tenant-a' }, {
      name: 'another reader CLI', roleCeiling: 'reader', scopes: ['skills:read'], expiresInSeconds: 3_600,
    });
    const response = await module.handler(new Request('https://registry.invalid/v1/tokens', { headers: bearer(readerCeiling.token) }));
    expect(response?.status).toBe(200);
    const listed = await json(response!);
    expect(listed.tokens).toMatchObject([{ id: readerCeiling.id, userId: 'alice' }]);
    expect(listed.tokens).toHaveLength(1);
  });

  it('rechecks membership role and removal on every bearer request', async () => {
    const { module, identity } = fixture();
    const token = await module.service.createToken({ userId: 'alice', organizationId: 'tenant-a' }, {
      name: 'publisher token', roleCeiling: 'publisher', scopes: ['skills:publish'], expiresInSeconds: 3_600,
    });
    expect(await module.service.authenticateBearerToken(token.token)).toMatchObject({ roles: ['publisher'], scopes: ['skills:publish'] });
    identity.setMembership({ userId: 'alice', organizationId: 'tenant-a', roles: ['reader'] });
    const downgraded = await module.service.authenticateBearerToken(token.token);
    expect(downgraded).toMatchObject({ roles: ['reader'], scopes: [] });
    identity.removeMembership('tenant-a', 'alice');
    expect(await module.service.authenticateBearerToken(token.token)).toBeNull();
  });

  it('narrows wildcard token grants after a membership downgrade', async () => {
    const { module, identity } = fixture();
    const token = await module.service.createToken({ userId: 'alice', organizationId: 'tenant-a' }, {
      name: 'wildcard token', roleCeiling: 'owner', scopes: ['*'], expiresInSeconds: 3_600,
    });
    expect(await module.service.authenticateBearerToken(token.token)).toMatchObject({ scopes: ['*'] });
    identity.setMembership({ userId: 'alice', organizationId: 'tenant-a', roles: ['reader'] });
    const narrowed = await module.service.authenticateBearerToken(token.token);
    expect(narrowed?.roles).toEqual(['reader']);
    expect(narrowed?.scopes).toContain('skills:read');
    expect(narrowed?.scopes).not.toContain('*');
  });

  it('fails closed when the identity backend returns a malformed membership', async () => {
    const { module, identity } = fixture();
    const token = await module.service.createToken({ userId: 'alice', organizationId: 'tenant-a' }, {
      name: 'membership check', roleCeiling: 'reader', scopes: ['skills:read'], expiresInSeconds: 3_600,
    });
    identity.memberships.set('tenant-a/alice', { userId: 'alice', organizationId: 'tenant-a' });
    expect(await module.service.authenticateBearerToken(token.token)).toBeNull();
  });

  it('does not allow a bearer credential to mint another token', async () => {
    const { module, identity } = fixture();
    const token = await module.service.createToken({ userId: 'alice', organizationId: 'tenant-a' }, {
      name: 'CLI token', roleCeiling: 'reader', scopes: ['skills:read'], expiresInSeconds: 3_600,
    });
    const response = await module.handler(new Request('https://registry.invalid/v1/tokens', {
      method: 'POST',
      headers: { ...bearer(token.token), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'nested token' }),
    }));
    expect(response?.status).toBe(401);
    expect(await json(response!)).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(identity.sessions.size).toBeGreaterThan(0);
  });

  it('enforces expiry and returns a composable no-op for other routes', async () => {
    const identity = new IdentityFixture();
    identity.setMembership({ userId: 'alice', organizationId: 'tenant-a', roles: ['owner'] });
    const repository = createMemoryApiTokenRepository();
    let now = NOW;
    const module = createApiTokenModule({
      repository,
      membershipAuthorizer: identity,
      now: () => now,
      tokenGenerator: () => 'psk_expiry-token-with-enough-entropy-001',
      defaultTtlSeconds: 60,
      maxTtlSeconds: 3_600,
    });
    const token = await module.service.createToken({ userId: 'alice', organizationId: 'tenant-a' }, { name: 'expiring', roleCeiling: 'reader', scopes: ['skills:read'], expiresInSeconds: 60 });
    expect(await module.handler(new Request('https://registry.invalid/health'))).toBeUndefined();
    now += 60_001;
    expect(await module.service.authenticateBearerToken(token.token)).toBeNull();
    await expect(module.service.createToken({ userId: 'alice', organizationId: 'tenant-a' }, { name: 'too long', roleCeiling: 'reader', expiresInSeconds: 3_601 })).rejects.toMatchObject({ code: 'INVALID_EXPIRY' });
  });

  it('requires the active Better Auth cookie session for create/list/revoke', async () => {
    const { module } = fixture();
    const noCookie = await module.handler(new Request('https://registry.invalid/v1/tokens', { method: 'GET' }));
    expect(noCookie?.status).toBe(401);
    const mismatchedOrg = await module.handler(new Request('https://registry.invalid/v1/tokens', {
      method: 'POST', headers: { ...sessionCookie('a-owner'), 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId: 'tenant-b', name: 'wrong org' }),
    }));
    expect(mismatchedOrg?.status).toBe(403);
    await expect(module.service.resolveManagementContext(new Request('https://registry.invalid/v1/tokens', { headers: sessionCookie('unknown') }))).rejects.toBeInstanceOf(ApiTokenError);
  });

  it('requires a trusted Origin for cookie mutations and permits bearer CLI revoke without Origin', async () => {
    const { module } = fixture();
    const created = await module.handler(new Request('https://registry.invalid/v1/tokens', {
      method: 'POST',
      headers: { ...sessionCookie('a-owner'), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'origin checked', roleCeiling: 'reader', scopes: ['skills:read'], expiresInSeconds: 3_600 }),
    }));
    expect(created?.status).toBe(201);
    const createdBody = await json(created!);
    const token = createdBody.token as string;
    const tokenId = createdBody.id as string;

    const crossOriginCreate = await module.handler(new Request('https://registry.invalid/v1/tokens', {
      method: 'POST',
      headers: { cookie: 'better-auth.session=a-owner', origin: 'https://evil.invalid', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'cross site', roleCeiling: 'reader', scopes: ['skills:read'], expiresInSeconds: 3_600 }),
    }));
    expect(crossOriginCreate?.status).toBe(403);
    expect(await json(crossOriginCreate!)).toMatchObject({ code: 'CSRF_ORIGIN_MISMATCH' });

    const missingOriginCreate = await module.handler(new Request('https://registry.invalid/v1/tokens', {
      method: 'POST',
      headers: { cookie: 'better-auth.session=a-owner', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'missing origin', roleCeiling: 'reader', scopes: ['skills:read'], expiresInSeconds: 3_600 }),
    }));
    expect(missingOriginCreate?.status).toBe(403);
    expect(await json(missingOriginCreate!)).toMatchObject({ code: 'CSRF_ORIGIN_MISSING' });

    const crossOriginRevoke = await module.handler(new Request(`https://registry.invalid/v1/tokens/${tokenId}`, {
      method: 'DELETE',
      headers: { cookie: 'better-auth.session=a-owner', origin: 'https://evil.invalid' },
    }));
    expect(crossOriginRevoke?.status).toBe(403);
    expect(await json(crossOriginRevoke!)).toMatchObject({ code: 'CSRF_ORIGIN_MISMATCH' });

    const bearerRevoke = await module.handler(new Request(`https://registry.invalid/v1/tokens/${tokenId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    }));
    expect(bearerRevoke?.status).toBe(200);
  });
});
