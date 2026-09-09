import { describe, expect, it } from 'vitest';
import {
  createEmptyRegistryState,
  createRegistryHandler,
} from '../src/index.js';
import { digestBytes, encodeBundle } from '../../storage/src/index.js';
import type {
  Authenticator,
  BlobStore,
  Principal,
  RegistryDependencies,
  RegistryState,
  StateRepository,
} from '../../contracts/src/index.js';

const ORIGIN = 'https://registry.example.test';

function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const bundle = (name: string) => ({
  format: 'pskills-bundle-v1' as const,
  files: [{
    path: 'SKILL.md',
    content: base64(`---\nname: ${name}\ndescription: Test skill ${name}\n---\n# ${name}\n`),
  }],
});

class MemoryRepository implements StateRepository {
  state: RegistryState;

  constructor(allowUnscanned = true) {
    this.state = createEmptyRegistryState({
      revision: 'policy-test',
      scanners: [],
      allowUnscanned,
      evidenceMaxAgeSeconds: 3600,
    });
  }

  async read(): Promise<RegistryState> {
    return structuredClone(this.state);
  }

  async transaction<T>(_organizationId: string, update: (state: RegistryState) => T): Promise<T> {
    const working = structuredClone(this.state);
    const result = update(working);
    this.state = working;
    return result;
  }
}

class MemoryBlobs implements BlobStore {
  readonly values = new Map<string, Uint8Array>();
  nextKey = 0;

  async put(bytes: Uint8Array) {
    const key = `blob-${this.nextKey++}`;
    const copy = bytes.slice();
    this.values.set(key, copy);
    return { key, digest: await digestBytes(copy), size: copy.byteLength };
  }

  async get(key: string): Promise<Uint8Array> {
    const value = this.values.get(key);
    if (!value) throw new Error('missing blob');
    return value.slice();
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
}

function principalFor(subject: string, roles: Principal['roles'], namespaces?: string[]): Principal {
  return { organizationId: 'org-test', subject, roles, namespaces };
}

function setup(options: { allowUnscanned?: boolean; principal?: Principal | null } = {}) {
  const repository = new MemoryRepository(options.allowUnscanned ?? true);
  const blobs = new MemoryBlobs();
  let principal = options.principal === undefined
    ? principalFor('publisher', ['publisher'], ['@team'])
    : options.principal;
  const auth: Authenticator = {
    authenticate: async () => principal,
    createSession: async (token) => token === 'session-token'
      ? {
          cookie: 'pskills_session=session; HttpOnly; SameSite=Lax',
          principal: principalFor('session-user', ['reader'], ['@team']),
        }
      : null,
    clearSessionCookie: () => 'pskills_session=; Max-Age=0; HttpOnly; SameSite=Lax',
  };
  const deps: RegistryDependencies = {
    repository,
    blobs,
    auth,
    config: {
      publicOrigin: ORIGIN,
      maxBodyBytes: 1024 * 1024,
      organizationId: 'org-test',
      leaseSeconds: 30,
    },
  };
  const handler = createRegistryHandler(deps);
  return {
    repository,
    blobs,
    handler,
    setPrincipal(value: Principal | null) {
      principal = value;
    },
  };
}

async function json(response: Response): Promise<any> {
  return response.json();
}

describe('registry core handler', () => {
  it('keeps health public while protecting registry routes and namespaces', async () => {
    const test = setup({ principal: null });
    const health = await test.handler(new Request(`${ORIGIN}/health`));
    expect(health.status).toBe(200);
    expect(await json(health)).toEqual({ ok: true, service: 'private-skills', version: '0.1.1' });

    const me = await test.handler(new Request(`${ORIGIN}/v1/me`));
    expect(me.status).toBe(401);

    test.setPrincipal(principalFor('publisher', ['publisher'], ['@other']));
    const denied = await test.handler(new Request(`${ORIGIN}/v1/publish`, {
      method: 'POST',
      body: JSON.stringify({ name: '@team/demo', version: '1.0.0', bundle: bundle('demo') }),
    }));
    expect(denied.status).toBe(403);

    test.setPrincipal({
      ...principalFor('mixed-worker', ['worker', 'reader']),
      identity: 'worker',
      scopes: ['registry:*'],
    } as Principal);
    const workerUserRoute = await test.handler(new Request(`${ORIGIN}/v1/me`));
    expect(workerUserRoute.status).toBe(403);
  });

  it('enforces explicit scopes while retaining role-only adapter compatibility', async () => {
    const test = setup();
    test.setPrincipal({
      ...principalFor('scoped-publisher', ['publisher'], ['@team']),
      identity: 'user',
      scopes: ['skills:publish'],
    } as Principal);
    const publish = await test.handler(new Request(`${ORIGIN}/v1/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '@team/scoped', version: '1.0.0', bundle: bundle('scoped') }),
    }));
    expect(publish.status).toBe(202);
    const list = await test.handler(new Request(`${ORIGIN}/v1/skills`));
    expect(list.status).toBe(403);

    test.setPrincipal({
      ...principalFor('empty-scopes', ['publisher'], ['@team']),
      scopes: [],
    } as Principal);
    const emptyScopeList = await test.handler(new Request(`${ORIGIN}/v1/skills`));
    expect(emptyScopeList.status).toBe(403);

    test.setPrincipal(principalFor('role-only', ['publisher'], ['@team']));
    const roleOnlyList = await test.handler(new Request(`${ORIGIN}/v1/skills`));
    expect(roleOnlyList.status).toBe(200);
  });

  it('rejects cross-site login and logout mutations while allowing a CLI token exchange', async () => {
    const test = setup();
    const attackerLogin = await test.handler(new Request(`${ORIGIN}/auth/session`, {
      method: 'POST',
      headers: { origin: 'https://attacker.example' },
      body: JSON.stringify({ token: 'session-token' }),
    }));
    expect(attackerLogin.status).toBe(403);
    expect((await json(attackerLogin)).error.code).toBe('CSRF_DENIED');

    const cliLogin = await test.handler(new Request(`${ORIGIN}/auth/session`, {
      method: 'POST',
      body: JSON.stringify({ token: 'session-token' }),
    }));
    expect(cliLogin.status).toBe(200);

    const attackerLogout = await test.handler(new Request(`${ORIGIN}/auth/session`, {
      method: 'DELETE',
      headers: { cookie: 'pskills_session=session', origin: 'https://attacker.example' },
    }));
    expect(attackerLogout.status).toBe(403);
    const cookieLogout = await test.handler(new Request(`${ORIGIN}/auth/session`, {
      method: 'DELETE',
      headers: { cookie: 'pskills_session=session', origin: ORIGIN },
    }));
    expect(cookieLogout.status).toBe(204);
  });

  it('publishes canonical bundles and makes an explicit unscanned policy visible in the state', async () => {
    const test = setup({ allowUnscanned: true });
    const response = await test.handler(new Request(`${ORIGIN}/v1/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '@team/demo', version: '1.0.0', description: 'demo', bundle: bundle('demo') }),
    }));
    expect(response.status).toBe(202);
    const operation = (await json(response)).operation;

    test.setPrincipal(principalFor('worker', ['worker']));
    const claim = await test.handler(new Request(`${ORIGIN}/internal/jobs/claim`, { method: 'POST' }));
    const job = (await json(claim)).job;
    expect(job.id).toBe(operation.id);
    const workerArtifact = await test.handler(new Request(`${ORIGIN}/internal/jobs/${job.id}/artifact`, {
      headers: {
        'x-worker-fencing-token': job.fencingToken ?? job.leaseToken,
        'x-artifact-digest': job.artifactDigest ?? job.artifact.digest,
      },
    }));
    expect(workerArtifact.status).toBe(200);
    expect(workerArtifact.headers.get('x-artifact-digest')).toBe(job.artifact.digest);
    const complete = await test.handler(new Request(`${ORIGIN}/internal/jobs/${job.id}/complete`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-worker-fencing-token': job.fencingToken ?? job.leaseToken,
      },
      body: JSON.stringify({ fencingToken: job.fencingToken ?? job.leaseToken }),
    }));
    expect(complete.status).toBe(200);

    const stored = test.repository.state.skills[0];
    expect(stored?.state).toBe('approved');
    expect(stored?.scanIds).toEqual([]);
    expect(stored?.artifact.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('fences stale workers when a lease is reclaimed', async () => {
    const test = setup();
    const publish = await test.handler(new Request(`${ORIGIN}/v1/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '@team/lease', version: '1.0.0', bundle: bundle('lease') }),
    }));
    const operation = (await json(publish)).operation;
    test.setPrincipal(principalFor('worker', ['worker']));
    const firstClaim = await test.handler(new Request(`${ORIGIN}/internal/jobs/claim`, { method: 'POST' }));
    const first = (await json(firstClaim)).job;
    test.repository.state.jobs[0]!.leaseExpiresAt = new Date(Date.now() - 1_000).toISOString();
    const secondClaim = await test.handler(new Request(`${ORIGIN}/internal/jobs/claim`, { method: 'POST' }));
    const second = (await json(secondClaim)).job;
    expect(second.id).toBe(operation.id);
    expect(second.leaseToken).not.toBe(first.leaseToken);

    const stale = await test.handler(new Request(`${ORIGIN}/internal/jobs/${operation.id}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ leaseToken: first.leaseToken }),
    }));
    expect(stale.status).toBe(409);
    expect((await json(stale)).error.code).toBe('LEASE_FENCED');
  });

  it('binds an import completion to the digest of its newly acquired bundle', async () => {
    const test = setup();
    test.setPrincipal(principalFor('admin', ['admin']));
    const upstream = await test.handler(new Request(`${ORIGIN}/v1/upstreams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'trusted-source',
        kind: 'registry',
        namespace: '@team',
        baseUrl: 'https://source.example.test',
      }),
    }));
    expect(upstream.status).toBe(201);
    const upstreamId = (await json(upstream)).upstream.id;

    test.setPrincipal(principalFor('publisher', ['publisher'], ['@team']));
    const importedBundle = bundle('imported');
    const queued = await test.handler(new Request(`${ORIGIN}/v1/imports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        upstreamId,
        path: 'skills/imported',
        name: '@team/imported',
        version: '1.0.0',
      }),
    }));
    expect(queued.status).toBe(202);
    const operation = (await json(queued)).operation;

    test.setPrincipal(principalFor('worker', ['worker']));
    const claim = await test.handler(new Request(`${ORIGIN}/internal/jobs/claim`, { method: 'POST' }));
    const job = (await json(claim)).job;
    const bytes = encodeBundle(importedBundle);
    const digest = await digestBytes(bytes);
    const complete = await test.handler(new Request(`${ORIGIN}/internal/jobs/${job.id}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        leaseToken: job.leaseToken,
        artifactDigest: digest,
        bundle: importedBundle,
        provenance: {
          kind: 'registry',
          upstreamId,
          repository: 'https://source.example.test',
          path: 'skills/imported',
          revision: digest,
        },
      }),
    }));
    expect(complete.status).toBe(200);
    expect((await json(complete)).operation.id).toBe(operation.id);
    expect(test.repository.state.skills[0]?.artifact.digest).toBe(digest);
    expect(test.repository.state.skills[0]?.state).toBe('approved');
  });

  it('pins exact approved pack members and blocks grants after revocation', async () => {
    const test = setup();
    for (const [slug, version] of [['one', '1.0.0'], ['two', '2.0.0']]) {
      const publish = await test.handler(new Request(`${ORIGIN}/v1/publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: `@team/${slug}`, version, bundle: bundle(slug) }),
      }));
      const operation = (await json(publish)).operation;
      test.setPrincipal(principalFor('worker', ['worker']));
      const claim = await test.handler(new Request(`${ORIGIN}/internal/jobs/claim`, { method: 'POST' }));
      const job = (await json(claim)).job;
      expect(job.id).toBe(operation.id);
      await test.handler(new Request(`${ORIGIN}/internal/jobs/${job.id}/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ leaseToken: job.leaseToken }),
      }));
      test.setPrincipal(principalFor('publisher', ['publisher'], ['@team']));
    }

    const packResponse = await test.handler(new Request(`${ORIGIN}/v1/packs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '@team/pack', version: '1.0.0', skills: [
        { ref: '@team/one', version: '1.0.0' },
        { ref: '@team/two', version: '2.0.0' },
      ] }),
    }));
    expect(packResponse.status).toBe(201);
    const pack = (await json(packResponse)).pack;
    expect(pack.members.map((member: { name: string }) => member.name)).toEqual(['@team/one', '@team/two']);
    expect(pack.members.every((member: { digest: string }) => /^sha256:[0-9a-f]{64}$/.test(member.digest))).toBe(true);

    const authResponse = await test.handler(new Request(`${ORIGIN}/v1/install-authorizations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'skill', ref: '@team/one', version: '1.0.0' }),
    }));
    const authorization = (await json(authResponse)).authorization;
    const skill = test.repository.state.skills.find((item) => item.name === '@team/one')!;
    const descriptor = await test.handler(new Request(`${ORIGIN}/v1/artifacts/${encodeURIComponent(skill.artifact.digest)}/download`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resourceId: skill.id, authorizationId: authorization.id }),
    }));
    expect(descriptor.status).toBe(200);
    const transferUrl = (await json(descriptor)).url as string;
    test.setPrincipal(null);
    const unauthenticatedTransfer = await test.handler(new Request(transferUrl));
    expect(unauthenticatedTransfer.status).toBe(401);
    test.setPrincipal(principalFor('publisher', ['publisher'], ['@team']));

    test.setPrincipal(principalFor('admin', ['admin']));
    const revoked = await test.handler(new Request(`${ORIGIN}/v1/skills/${skill.id}/revoke`, { method: 'POST' }));
    expect(revoked.status).toBe(200);
    test.setPrincipal(principalFor('publisher', ['publisher'], ['@team']));
    const afterRevoke = await test.handler(new Request(`${ORIGIN}/v1/artifacts/${encodeURIComponent(skill.artifact.digest)}/download`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resourceId: skill.id, authorizationId: authorization.id }),
    }));
    expect(afterRevoke.status).toBe(409);
  });
});
