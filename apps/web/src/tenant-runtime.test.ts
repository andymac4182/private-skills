import { describe, expect, it } from 'vitest';

import type { Authenticator, Principal } from '../../../packages/contracts/src/index.js';
import {
  createTenantHandlerRouter,
  resolveTenantSelection,
  type TenantIdentityRuntime,
  type TenantRuntimeContext,
} from '../server/tenant-runtime.js';

function principal(organizationId: string, subject: string): Principal {
  return { organizationId, subject, roles: ['reader'], scopes: ['registry:read'] };
}

function request(token?: string, headers: Record<string, string> = {}): Request {
  return new Request('https://registry.example.test/v1/registry', {
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...headers,
    },
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

describe('tenant runtime routing', () => {
  it('routes only from a verified principal and ignores an untrusted tenant header', async () => {
    const principals: Record<string, Principal> = {
      alice: principal('org-a', 'alice'),
      bob: principal('org-b', 'bob'),
    };
    const auth: Authenticator = {
      authenticate: async (request) => {
        const token = request.headers.get('authorization')?.replace(/^Bearer\s+/u, '');
        return token === undefined ? null : principals[token] ?? null;
      },
    };
    const identity: TenantIdentityRuntime = {
      authenticate: auth.authenticate,
      resolveTenant: async (_request, verifiedPrincipal) => ({
        organizationId: verifiedPrincipal.organizationId,
        kind: 'scoped-api',
      }),
    };
    const contexts: TenantRuntimeContext[] = [];
    const router = createTenantHandlerRouter({
      defaultOrganizationId: 'org-a',
      identity,
      authenticator: auth,
      createHandler: (context) => {
        contexts.push(context);
        return async (request) => {
          const current = await context.auth.authenticate(request);
          return Response.json({
            organizationId: context.organizationId,
            subject: current?.subject ?? null,
          });
        };
      },
      defaultHandler: async () => Response.json({ code: 'UNAUTHENTICATED' }, { status: 401 }),
    });

    const routedA = await router(request('alice', { 'x-organization-id': 'org-b' }));
    const routedB = await router(request('bob', { 'x-organization-id': 'org-a' }));
    expect(await json(routedA)).toEqual({ organizationId: 'org-a', subject: 'alice' });
    expect(await json(routedB)).toEqual({ organizationId: 'org-b', subject: 'bob' });
    expect(contexts.map(({ organizationId }) => organizationId)).toEqual(['org-a', 'org-b']);
  });

  it('does not cache the first user principal inside a tenant handler', async () => {
    const users: Record<string, Principal> = {
      first: principal('org-a', 'first-user'),
      second: principal('org-a', 'second-user'),
    };
    const auth: Authenticator = {
      authenticate: async (request) => users[request.headers.get('authorization')?.slice(7) ?? ''] ?? null,
    };
    const identity: TenantIdentityRuntime = {
      authenticate: auth.authenticate,
      resolveTenant: async (_request, verifiedPrincipal) => ({
        organizationId: verifiedPrincipal.organizationId,
        kind: 'scoped-api',
      }),
    };
    let factoryCalls = 0;
    const router = createTenantHandlerRouter({
      defaultOrganizationId: 'org-a',
      identity,
      authenticator: auth,
      createHandler: (context) => {
        factoryCalls += 1;
        return async (request) => Response.json({ subject: (await context.auth.authenticate(request))?.subject });
      },
    });

    expect(await json(await router(request('first')))).toEqual({ subject: 'first-user' });
    expect(await json(await router(request('second')))).toEqual({ subject: 'second-user' });
    expect(factoryCalls).toBe(1);
  });

  it('returns onboarding for an authenticated social user with no active membership', async () => {
    const auth: Authenticator = {
      authenticate: async () => principal('identity-only', 'social-user'),
    };
    const identity: TenantIdentityRuntime = {
      authenticate: auth.authenticate,
      resolveTenant: async () => null,
    };
    let factoryCalls = 0;
    const router = createTenantHandlerRouter({
      defaultOrganizationId: 'legacy-org',
      identity,
      createHandler: () => {
        factoryCalls += 1;
        return async () => Response.json({ ok: true });
      },
    });

    const response = await router(request('ignored'));
    expect(response.status).toBe(409);
    expect(await json(response)).toMatchObject({ code: 'TENANT_ONBOARDING' });
    expect(factoryCalls).toBe(0);
  });

  it('returns onboarding for a valid Better Auth session whose active organization is absent', async () => {
    const auth: Authenticator = { authenticate: async () => null };
    const identity: TenantIdentityRuntime = {
      authenticate: auth.authenticate,
      getSession: async () => ({ activeOrganizationId: null, needsOnboarding: true }),
    };
    let factoryCalls = 0;
    const router = createTenantHandlerRouter({
      defaultOrganizationId: 'legacy-org',
      identity,
      createHandler: () => {
        factoryCalls += 1;
        return async () => Response.json({ ok: true });
      },
    });

    const response = await router(request('ignored'));
    expect(response.status).toBe(409);
    expect(await json(response)).toMatchObject({ code: 'TENANT_ONBOARDING' });
    expect(factoryCalls).toBe(0);
  });

  it('routes a persisted-token session exchange from its verified body token without consuming the core body', async () => {
    const issued = {
      ...principal('org-b', 'api-user'),
      display: {
        userName: 'API User',
        organizationName: 'Tenant B',
      },
    };
    const auth: Authenticator = {
      authenticate: async (incoming) => incoming.headers.get('authorization') === 'Bearer issued-api-token' ? issued : null,
      createSession: async (token) => token === 'issued-api-token'
        ? { cookie: 'pskills_session=signed-reference', principal: issued }
        : null,
    };
    const identity: TenantIdentityRuntime = { authenticate: auth.authenticate };
    const router = createTenantHandlerRouter({
      defaultOrganizationId: 'org-a',
      identity,
      authenticator: auth,
      resolveSessionTenant: async (incoming) => {
        const body = await incoming.clone().json() as { token?: unknown };
        if (body.token !== 'issued-api-token') return undefined;
        const verified = await auth.authenticate(new Request(incoming.url, {
          headers: { authorization: `Bearer ${body.token}` },
        }));
        return verified ? { organizationId: verified.organizationId, kind: 'scoped-api' } : undefined;
      },
      createHandler: (context) => async (incoming) => {
        const body = await incoming.json() as { token?: unknown };
        const session = await context.auth.createSession?.(String(body.token));
        return session
          ? Response.json({ organizationId: context.organizationId, subject: session.principal.subject, display: session.principal.display })
          : Response.json({ code: 'UNAUTHORIZED' }, { status: 401 });
      },
      defaultHandler: async () => Response.json({ code: 'UNAUTHENTICATED' }, { status: 401 }),
    });

    const response = await router(new Request('https://registry.example.test/auth/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'issued-api-token' }),
    }));
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      organizationId: 'org-b',
      subject: 'api-user',
      display: { userName: 'API User', organizationName: 'Tenant B' },
    });
  });

  it('sends unauthenticated requests to the default handler without fabricating a principal', async () => {
    const auth: Authenticator = { authenticate: async () => null };
    const identity: TenantIdentityRuntime = { authenticate: auth.authenticate };
    let factoryCalls = 0;
    const router = createTenantHandlerRouter({
      defaultOrganizationId: 'legacy-org',
      identity,
      authenticator: auth,
      createHandler: () => {
        factoryCalls += 1;
        return async () => Response.json({ ok: true });
      },
      defaultHandler: async (request) => {
        expect(await auth.authenticate(request)).toBeNull();
        return Response.json({ code: 'UNAUTHENTICATED' }, { status: 401 });
      },
    });

    const response = await router(request());
    expect(response.status).toBe(401);
    expect(await json(response)).toEqual({ code: 'UNAUTHENTICATED' });
    expect(factoryCalls).toBe(0);
  });

  it('rejects a scoped principal when a resolver tries to move it to another organization', async () => {
    const auth: Authenticator = { authenticate: async () => principal('org-a', 'user') };
    const identity: TenantIdentityRuntime = {
      authenticate: auth.authenticate,
      resolveTenant: async () => ({ organizationId: 'org-b', kind: 'scoped-api' }),
    };
    let factoryCalls = 0;
    const router = createTenantHandlerRouter({
      defaultOrganizationId: 'org-a',
      identity,
      createHandler: () => {
        factoryCalls += 1;
        return async () => Response.json({ ok: true });
      },
    });

    const response = await router(request('anything'));
    expect(response.status).toBe(403);
    expect(await json(response)).toMatchObject({ code: 'TENANT_FORBIDDEN' });
    expect(factoryCalls).toBe(0);
  });

  it('also rejects an active-membership claim that disagrees with the authenticated principal', async () => {
    const auth: Authenticator = { authenticate: async () => principal('org-a', 'user') };
    const identity: TenantIdentityRuntime = {
      authenticate: auth.authenticate,
      resolveTenant: async () => ({ organizationId: 'org-b', kind: 'active-membership' }),
    };
    let factoryCalls = 0;
    const router = createTenantHandlerRouter({
      defaultOrganizationId: 'org-a',
      identity,
      createHandler: () => {
        factoryCalls += 1;
        return async () => Response.json({ ok: true });
      },
    });

    const response = await router(request('anything'));
    expect(response.status).toBe(403);
    expect(await json(response)).toMatchObject({ code: 'TENANT_FORBIDDEN' });
    expect(factoryCalls).toBe(0);
  });

  it('does not expose a mismatched selection through the standalone resolver', async () => {
    const identity: TenantIdentityRuntime = {
      authenticate: async () => principal('org-a', 'user'),
      resolveTenant: async () => ({ organizationId: 'org-b', kind: 'active-membership' }),
    };

    await expect(resolveTenantSelection(request('anything'), identity)).rejects.toThrow('authenticated organization');
  });

  it('fails closed when the active organization changes during the second core authentication pass', async () => {
    let calls = 0;
    const auth: Authenticator = {
      authenticate: async () => {
        calls += 1;
        return principal(calls === 1 ? 'org-a' : 'org-b', 'user');
      },
    };
    const identity: TenantIdentityRuntime = {
      authenticate: auth.authenticate,
      resolveTenant: async (_request, verifiedPrincipal) => ({
        organizationId: verifiedPrincipal.organizationId,
        kind: 'active-membership',
      }),
    };
    const router = createTenantHandlerRouter({
      defaultOrganizationId: 'org-a',
      identity,
      authenticator: auth,
      createHandler: (context) => async (request) => {
        const current = await context.auth.authenticate(request);
        return current ? Response.json({ ok: true }) : Response.json({ code: 'UNAUTHORIZED' }, { status: 401 });
      },
    });

    const response = await router(request('anything'));
    expect(response.status).toBe(401);
    expect(calls).toBe(2);
  });

  it('bounds the tenant handler cache and supports explicit invalidation', async () => {
    const auth: Authenticator = {
      authenticate: async (request) => {
        const organizationId = request.headers.get('x-authenticated-org');
        return organizationId === null ? null : principal(organizationId, organizationId);
      },
    };
    const identity: TenantIdentityRuntime = {
      authenticate: auth.authenticate,
      resolveTenant: async (_request, verifiedPrincipal) => ({
        organizationId: verifiedPrincipal.organizationId,
        kind: 'scoped-api',
      }),
    };
    const factoryCalls = new Map<string, number>();
    const router = createTenantHandlerRouter({
      defaultOrganizationId: 'org-a',
      identity,
      authenticator: auth,
      maxCachedTenants: 2,
      createHandler: (context) => {
        factoryCalls.set(context.organizationId, (factoryCalls.get(context.organizationId) ?? 0) + 1);
        return async () => Response.json({ organizationId: context.organizationId });
      },
    });
    const forOrg = (organizationId: string) => request(undefined, { 'x-authenticated-org': organizationId });

    await router(forOrg('org-a'));
    await router(forOrg('org-b'));
    await router(forOrg('org-c'));
    expect(router.cachedOrganizations()).toEqual(['org-b', 'org-c']);
    await router(forOrg('org-a'));
    expect(factoryCalls.get('org-a')).toBe(2);
    router.invalidateTenant('org-b');
    expect(router.cachedOrganizations()).toEqual(['org-a', 'org-c']);
  });

  it('rebuilds a tenant handler when its provisioning claim changes', async () => {
    let provisioned = false;
    const identity: TenantIdentityRuntime = {
      authenticate: async () => principal('org-b', 'user'),
      resolveTenant: async () => ({ organizationId: 'org-b', kind: 'active-membership', provisioned }),
    };
    const contexts: boolean[] = [];
    const router = createTenantHandlerRouter({
      defaultOrganizationId: 'org-a',
      identity,
      createHandler: (context) => {
        contexts.push(context.provisioned);
        return async () => Response.json({ ok: true });
      },
    });

    await router(request('anything'));
    provisioned = true;
    await router(request('anything'));
    expect(contexts).toEqual([false, true]);
  });
});
