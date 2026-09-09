import { describe, expect, it } from 'vitest';
import { createEmptyRegistryState, createRegistryHandler } from '../src/index.js';
import { digestBytes } from '../../storage/src/index.js';
import type {
  Authenticator,
  BlobStore,
  Principal,
  RegistryDependencies,
  RegistryState,
  SkillVersion,
  StateRepository,
} from '../../contracts/src/index.js';

const ORIGIN = 'https://registry.example.test';
const DIGEST = `sha256:${'a'.repeat(64)}` as `sha256:${string}`;

class MemoryRepository implements StateRepository {
  state: RegistryState;

  constructor() {
    this.state = createEmptyRegistryState({
      revision: 'policy-test',
      scanners: [],
      allowUnscanned: true,
      evidenceMaxAgeSeconds: 3_600,
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
  async put(bytes: Uint8Array) {
    return { key: 'memory-key', digest: await digestBytes(bytes), size: bytes.byteLength };
  }

  async get(): Promise<Uint8Array> {
    return new Uint8Array();
  }

  async remove(): Promise<void> {}
}

function principal(subject: string, roles: Principal['roles'], namespaces?: string[]): Principal {
  return { organizationId: 'org-test', subject, roles, namespaces };
}

function skill(name: string, id = 'skill-team') : SkillVersion {
  return {
    id,
    organizationId: 'org-test',
    name,
    skillName: name.slice(name.indexOf('/') + 1),
    version: '1.0.0',
    description: 'analytics test skill',
    artifact: { key: 'memory-key', digest: DIGEST, size: 1 },
    state: 'approved',
    policyRevision: 'policy-test',
    createdAt: new Date().toISOString(),
    approvedAt: new Date().toISOString(),
    provenance: { kind: 'native' },
    fileCount: 1,
    scanIds: [],
  };
}

function setup() {
  const repository = new MemoryRepository();
  const blobs = new MemoryBlobs();
  let current: Principal | null = principal('publisher', ['publisher'], ['@team']);
  const auth: Authenticator = { authenticate: async () => current };
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
  repository.state.skills.push(skill('@team/analytics'));
  const handler = createRegistryHandler(deps);
  return {
    repository,
    handler,
    setPrincipal(value: Principal | null) {
      current = value;
    },
  };
}

async function json(response: Response): Promise<any> {
  return response.json();
}

function post(url: string, value: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
}

describe('installation receipts and analytics', () => {
  it('requires an authenticated user and rejects workers', async () => {
    const test = setup();
    test.setPrincipal(null);
    const unauthenticated = await test.handler(post(`${ORIGIN}/v1/install-receipts`, {
      authorizationId: 'authz_missing', changed: true, agent: 'codex', platform: 'macos', clientVersion: '1.0.0',
    }));
    expect(unauthenticated.status).toBe(401);

    test.setPrincipal({ ...principal('worker', ['worker']), identity: 'worker' } as Principal);
    const worker = await test.handler(post(`${ORIGIN}/v1/install-receipts`, {
      authorizationId: 'authz_missing', changed: true, agent: 'codex', platform: 'macos', clientVersion: '1.0.0',
    }));
    expect(worker.status).toBe(403);
  });

  it('issues an authorization-bound 24-hour ticket and deduplicates receipt replay', async () => {
    const test = setup();
    const authorizationResponse = await test.handler(post(`${ORIGIN}/v1/install-authorizations`, {
      kind: 'skill', ref: '@team/analytics', version: '1.0.0',
    }));
    expect(authorizationResponse.status).toBe(201);
    const authorizationPayload = await json(authorizationResponse);
    expect(authorizationPayload.receipt).toEqual(expect.objectContaining({
      authorizationId: authorizationPayload.authorization.id,
    }));
    const body = {
      authorizationId: authorizationPayload.authorization.id,
      changed: true,
      agent: 'codex',
      platform: 'macos',
      clientVersion: '1.0.0',
    };
    const first = await test.handler(post(`${ORIGIN}/v1/install-receipts`, body));
    expect(first.status).toBe(201);
    const firstPayload = await json(first);
    expect(firstPayload.receipt.resolution).toEqual(expect.objectContaining({
      name: '@team/analytics', version: '1.0.0', digest: DIGEST,
    }));
    const replay = await test.handler(post(`${ORIGIN}/v1/install-receipts`, body));
    expect(replay.status).toBe(200);
    expect((await json(replay)).receipt.id).toBe(firstPayload.receipt.id);

    const conflict = await test.handler(post(`${ORIGIN}/v1/install-receipts`, { ...body, changed: false }));
    expect(conflict.status).toBe(409);
    expect((await json(conflict)).error.code).toBe('RECEIPT_CONFLICT');
  });

  it('keeps authorization and receipt resolution namespace-bound', async () => {
    const test = setup();
    test.setPrincipal(principal('other-namespace', ['reader'], ['@other']));
    const authorization = await test.handler(post(`${ORIGIN}/v1/install-authorizations`, {
      kind: 'skill', ref: '@team/analytics', version: '1.0.0',
    }));
    expect(authorization.status).toBe(404);
  });

  it('does not disclose another subject receipt or accept an expired ticket', async () => {
    const test = setup();
    const authorizationResponse = await test.handler(post(`${ORIGIN}/v1/install-authorizations`, {
      kind: 'skill', ref: '@team/analytics', version: '1.0.0',
    }));
    const authorization = (await json(authorizationResponse)).authorization;
    test.setPrincipal(principal('different-subject', ['reader'], ['@team']));
    const mismatched = await test.handler(post(`${ORIGIN}/v1/install-receipts`, {
      authorizationId: authorization.id,
      changed: true,
      agent: 'codex',
      platform: 'linux',
      clientVersion: '1.0.0',
    }));
    expect(mismatched.status).toBe(404);

    test.setPrincipal(principal('publisher', ['publisher'], ['@team']));
    test.repository.state.installReceiptTickets![0]!.expiresAt = new Date(Date.now() - 1_000).toISOString();
    const expired = await test.handler(post(`${ORIGIN}/v1/install-receipts`, {
      authorizationId: authorization.id,
      changed: true,
      agent: 'codex',
      platform: 'linux',
      clientVersion: '1.0.0',
    }));
    expect(expired.status).toBe(404);
  });

  it('aggregates only client-confirmed receipts and protects the analytics route', async () => {
    const test = setup();
    const authorizationResponse = await test.handler(post(`${ORIGIN}/v1/install-authorizations`, {
      kind: 'skill', ref: '@team/analytics', version: '1.0.0',
    }));
    const authorization = (await json(authorizationResponse)).authorization;
    const first = await test.handler(post(`${ORIGIN}/v1/install-receipts`, {
      authorizationId: authorization.id,
      changed: false,
      agent: 'universal',
      platform: 'other',
      clientVersion: '2.0.0',
    }));
    expect(first.status).toBe(201);

    test.setPrincipal(principal('reader', ['reader'], ['@team']));
    const reader = await test.handler(new Request(`${ORIGIN}/v1/analytics?days=30`));
    expect(reader.status).toBe(403);
    test.setPrincipal(principal('admin', ['admin']));
    const analytics = await test.handler(new Request(`${ORIGIN}/v1/analytics?days=30`));
    expect(analytics.status).toBe(200);
    const payload = await json(analytics);
    expect(payload.totals).toEqual({ installOperations: 1, skillInstalls: 0, packInstalls: 0, upToDateChecks: 1 });
    expect(payload.daily).toHaveLength(30);
    expect(payload.topSkills).toEqual([]);
  });
});
