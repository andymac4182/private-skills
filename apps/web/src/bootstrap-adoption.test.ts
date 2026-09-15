import { describe, expect, it, vi } from 'vitest';

import type { Authenticator, Principal } from '../../../packages/contracts/src/index.js';
import { createMemoryStateRepository } from '../../../packages/database/src/memory.js';
import {
  BOOTSTRAP_ADOPTION_ACTION,
  BOOTSTRAP_ADOPTION_PATH,
  createBootstrapAdoptionHandler,
  type BootstrapAdoptionStore,
} from '../server/bootstrap-adoption.js';

function request(token = 'bootstrap-secret', headers: Record<string, string> = {}): Request {
  return new Request(`https://registry.example.test${BOOTSTRAP_ADOPTION_PATH}`, {
    method: 'POST',
    headers: {
      Origin: 'https://registry.example.test',
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify({ bootstrapToken: token }),
  });
}

function proof(principal: Principal & { identity: 'user'; tokenId: string }): Authenticator {
  return {
    authenticate: async () => null,
    createSession: async () => ({ cookie: '', principal }),
  };
}

function fixture(options: { session?: unknown; proof?: Principal & { identity: 'user'; tokenId: string }; store?: BootstrapAdoptionStore } = {}) {
  const repository = createMemoryStateRepository();
  const store = options.store ?? {
    bindOwner: vi.fn().mockResolvedValue({ replayed: false, membershipId: 'member-1' }),
  } satisfies BootstrapAdoptionStore;
  const handler = createBootstrapAdoptionHandler({
    defaultOrganizationId: 'default',
    canonicalOrigin: 'https://registry.example.test',
    identity: {
      getSession: async () => options.session !== undefined
        ? options.session
        : { user: { id: 'social-user', emailVerified: true }, sessionId: 'session-1' },
    },
    authenticator: proof(options.proof ?? {
      organizationId: 'default',
      subject: 'bootstrap-owner',
      roles: ['owner'],
      scopes: ['*'],
      identity: 'user',
      tokenId: 'bootstrap-owner-token',
    }),
    repository,
    store,
    allowedBootstrapTokenIds: ['bootstrap-owner-token'],
  });
  return { handler, repository, store };
}

describe('explicit Better Auth bootstrap adoption', () => {
  it('requires a verified Better Auth session and an exact configured owner proof', async () => {
    const { handler, repository, store } = fixture();
    const response = await handler(request());
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      ok: true,
      organizationId: 'default',
      userId: 'social-user',
      replayed: false,
    });
    expect(store.bindOwner).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'default',
      userId: 'social-user',
      sessionId: 'session-1',
      proofTokenId: 'bootstrap-owner-token',
      proofSubject: 'bootstrap-owner',
    }));
    const state = await repository.read('default');
    expect(state.audit).toHaveLength(1);
    expect(state.audit[0]).toMatchObject({
      action: BOOTSTRAP_ADOPTION_ACTION,
      organizationId: 'default',
      subject: 'social-user',
      details: {
        userId: 'social-user',
        sessionId: 'session-1',
        proofTokenId: 'bootstrap-owner-token',
        proofSubject: 'bootstrap-owner',
      },
    });
  });

  it('rejects first-login and domain-only claims without the Better Auth session', async () => {
    const noSession = fixture({ session: null });
    expect((await noSession.handler(request())).status).toBe(401);

    const unverified = fixture({ session: { user: { id: 'social-user', emailVerified: false }, sessionId: 'session-1' } });
    expect((await unverified.handler(request())).status).toBe(403);

    const wrongProof = fixture({
      proof: {
        organizationId: 'default', subject: 'first-user', roles: ['owner'], scopes: ['*'], identity: 'user', tokenId: 'unlisted',
      },
    });
    expect((await wrongProof.handler(request())).status).toBe(403);
    expect(wrongProof.store.bindOwner).not.toHaveBeenCalled();
  });

  it('rejects mismatched origins and worker or cross-tenant proofs', async () => {
    const origin = fixture();
    expect((await origin.handler(request('bootstrap-secret', { Origin: 'https://evil.example.test' }))).status).toBe(403);

    const worker = fixture({
      proof: {
        organizationId: 'default', subject: 'worker', roles: ['worker'], scopes: ['jobs:claim'], identity: 'worker', tokenId: 'bootstrap-owner-token',
      } as never,
    });
    expect((await worker.handler(request())).status).toBe(403);

    const otherTenant = fixture({
      proof: {
        organizationId: 'other', subject: 'bootstrap-owner', roles: ['owner'], scopes: ['*'], identity: 'user', tokenId: 'bootstrap-owner-token',
      },
    });
    expect((await otherTenant.handler(request())).status).toBe(403);

    const unsupportedRole = fixture({
      proof: {
        organizationId: 'default', subject: 'bootstrap-owner', roles: ['owner', 'manager'] as never, scopes: ['*'], identity: 'user', tokenId: 'bootstrap-owner-token',
      },
    });
    expect((await unsupportedRole.handler(request())).status).toBe(403);
  });

  it('returns a replay response while keeping one registry audit marker', async () => {
    const store: BootstrapAdoptionStore = { bindOwner: vi.fn().mockResolvedValue({ replayed: true, membershipId: 'member-1' }) };
    const { handler, repository } = fixture({ store });
    const first = await handler(request());
    const second = await handler(request());
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await repository.read('default')).audit).toHaveLength(1);
  });

  it('does not let a conflicting duplicate audit marker hide behind a matching first row', async () => {
    const { handler, repository } = fixture();
    await repository.transaction('default', (state) => {
      state.audit.push({
        id: 'audit-same',
        organizationId: 'default',
        subject: 'social-user',
        action: BOOTSTRAP_ADOPTION_ACTION,
        createdAt: new Date().toISOString(),
        details: { userId: 'social-user' },
      });
      state.audit.push({
        id: 'audit-other',
        organizationId: 'default',
        subject: 'other-user',
        action: BOOTSTRAP_ADOPTION_ACTION,
        createdAt: new Date().toISOString(),
        details: { userId: 'other-user' },
      });
    });
    expect((await handler(request())).status).toBe(409);
  });
});
