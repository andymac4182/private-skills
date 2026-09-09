import { describe, expect, it } from 'vitest';

import {
  createMemoryStateRepository,
  defaultRegistryState,
} from '../../database/src/index.js';
import {
  createRegistryHandler,
} from '../src/index.js';
import {
  digestBytes,
  encodeBundle,
} from '../../storage/src/index.js';
import type {
  Authenticator,
  BlobStore,
  Principal,
  RegistryConfiguration,
  SkillBundle,
  StoredBlob,
} from '../../contracts/src/index.js';

const ORIGIN = 'https://registry.example.test';

function principal(subject: string, roles: Principal['roles']): Principal & { scopes: string[] } {
  return { organizationId: 'org-cache', subject, roles, namespaces: ['@team'], scopes: ['*'] };
}

function bundle(): SkillBundle {
  return {
    format: 'pskills-bundle-v1',
    files: [{
      path: 'SKILL.md',
      content: Buffer.from('---\nname: cached\ndescription: cache fixture\n---\n# cached\n', 'utf8').toString('base64'),
    }],
  };
}

class MemoryBlobs implements BlobStore {
  readonly values = new Map<string, Uint8Array>();
  private nextKey = 0;

  async put(bytes: Uint8Array): Promise<StoredBlob> {
    const copy = bytes.slice();
    const stored = {
      key: `cache-${this.nextKey++}`,
      digest: await digestBytes(copy),
      size: copy.byteLength,
    } satisfies StoredBlob;
    this.values.set(stored.key, copy);
    return stored;
  }

  async get(key: string): Promise<Uint8Array> {
    const bytes = this.values.get(key);
    if (!bytes) throw new Error('missing blob');
    return bytes.slice();
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe('import pull-through cache identity', () => {
  it('joins pending imports and serves an approved hit without a second job', async () => {
    const repository = createMemoryStateRepository({
      stateFactory: () => defaultRegistryState({ production: false, allowUnscanned: true }),
    });
    const blobs = new MemoryBlobs();
    const user = principal('publisher', ['owner', 'admin', 'publisher', 'reader']);
    const worker = principal('worker', ['worker']);
    const auth: Authenticator = {
      authenticate: async (request) => request.headers.get('authorization') === 'Bearer worker'
        ? worker
        : request.headers.get('authorization') === 'Bearer user'
          ? user
          : null,
    };
    const config: RegistryConfiguration = {
      publicOrigin: ORIGIN,
      maxBodyBytes: 2 * 1024 * 1024,
      organizationId: 'org-cache',
      leaseSeconds: 60,
    };
    const handler = createRegistryHandler({ repository, blobs, auth, config });
    const userHeaders = { authorization: 'Bearer user', 'content-type': 'application/json' };
    const workerHeaders = { authorization: 'Bearer worker', 'content-type': 'application/json' };
    const source = {
      upstreamId: '',
      repository: undefined,
      path: 'skills/cached',
      ref: 'main',
      name: '@team/cached',
      version: '1.0.0',
    };

    const upstreamResponse = await handler(new Request(`${ORIGIN}/v1/upstreams`, {
      method: 'POST',
      headers: userHeaders,
      body: JSON.stringify({ name: 'offline-source', kind: 'registry', namespace: '@team', baseUrl: 'https://offline.example' }),
    }));
    expect(upstreamResponse.status).toBe(201);
    source.upstreamId = (await json<{ upstream: { id: string } }>(upstreamResponse)).upstream.id;

    const first = await handler(new Request(`${ORIGIN}/v1/imports`, {
      method: 'POST',
      headers: userHeaders,
      body: JSON.stringify(source),
    }));
    expect(first.status).toBe(202);
    const firstOperation = (await json<{ operation: { id: string } }>(first)).operation;

    const joined = await handler(new Request(`${ORIGIN}/v1/imports`, {
      method: 'POST',
      headers: userHeaders,
      body: JSON.stringify(source),
    }));
    expect(joined.status).toBe(202);
    expect((await json<{ operation: { id: string } }>(joined)).operation.id).toBe(firstOperation.id);
    expect((await repository.read('org-cache')).jobs.filter((job) => job.kind === 'import')).toHaveLength(1);

    const proxyJoined = await handler(new Request(`${ORIGIN}/v1/proxy/resolve`, {
      method: 'POST',
      headers: userHeaders,
      body: JSON.stringify(source),
    }));
    expect(proxyJoined.status).toBe(202);
    expect((await json<{ operation: { id: string } }>(proxyJoined)).operation.id).toBe(firstOperation.id);

    // The public pull-through endpoint shares the same durable identity.  A
    // concurrent proxy caller joins the pending operation instead of
    // enqueueing another source fetch.
    const proxyPending = await handler(new Request(`${ORIGIN}/v1/proxy/resolve`, {
      method: 'POST',
      headers: userHeaders,
      body: JSON.stringify(source),
    }));
    expect(proxyPending.status).toBe(202);
    expect((await json<{ operation: { id: string } }>(proxyPending)).operation.id).toBe(firstOperation.id);

    const claim = await handler(new Request(`${ORIGIN}/internal/jobs/claim`, { method: 'POST', headers: workerHeaders }));
    const job = (await json<{ job: { id: string; leaseToken: string } }>(claim)).job;
    const imported = bundle();
    const digest = await digestBytes(encodeBundle(imported));
    const complete = await handler(new Request(`${ORIGIN}/internal/jobs/${job.id}/complete`, {
      method: 'POST',
      headers: workerHeaders,
      body: JSON.stringify({ leaseToken: job.leaseToken, artifactDigest: digest, bundle: imported, provenance: { kind: 'registry', repository: 'https://offline.example', path: source.path, revision: digest } }),
    }));
    expect(complete.status).toBe(200);

    // The source is deliberately an unreachable registry.  A warm request
    // must resolve to the sealed artifact and never enqueue a new fetch.
    const warm = await handler(new Request(`${ORIGIN}/v1/imports`, {
      method: 'POST',
      headers: userHeaders,
      body: JSON.stringify(source),
    }));
    expect(warm.status).toBe(200);
    expect((await json<{ operation: { id: string; state: string } }>(warm)).operation).toMatchObject({ id: firstOperation.id, state: 'completed' });
    expect((await repository.read('org-cache')).jobs.filter((candidate) => candidate.kind === 'import')).toHaveLength(1);

    const proxyWarm = await handler(new Request(`${ORIGIN}/v1/proxy/resolve`, {
      method: 'POST',
      headers: userHeaders,
      body: JSON.stringify(source),
    }));
    expect(proxyWarm.status).toBe(200);
    expect((await json<{ resolution: { name: string; version: string; digest: string } }>(proxyWarm)).resolution).toMatchObject({
      name: source.name,
      version: source.version,
      digest,
    });

    const otherUpstreamResponse = await handler(new Request(`${ORIGIN}/v1/upstreams`, {
      method: 'POST',
      headers: userHeaders,
      body: JSON.stringify({ name: 'another-source', kind: 'registry', namespace: '@team', baseUrl: 'https://another.example' }),
    }));
    expect(otherUpstreamResponse.status).toBe(201);
    const otherUpstreamId = (await json<{ upstream: { id: string } }>(otherUpstreamResponse)).upstream.id;
    const provenanceConflict = await handler(new Request(`${ORIGIN}/v1/proxy/resolve`, {
      method: 'POST',
      headers: userHeaders,
      body: JSON.stringify({ ...source, upstreamId: otherUpstreamId }),
    }));
    expect(provenanceConflict.status).toBe(409);
    expect((await json<{ error: { code: string } }>(provenanceConflict)).error.code).toBe('PROVENANCE_CONFLICT');

    const refConflict = await handler(new Request(`${ORIGIN}/v1/proxy/resolve`, {
      method: 'POST',
      headers: userHeaders,
      body: JSON.stringify({ ...source, ref: 'different-ref' }),
    }));
    expect(refConflict.status).toBe(409);
    expect((await json<{ error: { code: string } }>(refConflict)).error.code).toBe('PROVENANCE_CONFLICT');

    await repository.transaction('org-cache', (state) => {
      const current = state.upstreams.find((candidate) => candidate.id === source.upstreamId);
      if (current) current.baseUrl = 'https://switched.example';
    });
    const switchedOrigin = await handler(new Request(`${ORIGIN}/v1/proxy/resolve`, {
      method: 'POST',
      headers: userHeaders,
      body: JSON.stringify(source),
    }));
    expect(switchedOrigin.status).toBe(409);
    expect((await json<{ error: { code: string } }>(switchedOrigin)).error.code).toBe('PROVENANCE_CONFLICT');

    const resolved = await handler(new Request(`${ORIGIN}/v1/resolve`, {
      method: 'POST',
      headers: userHeaders,
      body: JSON.stringify({ kind: 'skill', ref: source.name, version: source.version }),
    }));
    expect(resolved.status).toBe(200);
    expect((await json<{ resolution: { digest: string } }>(resolved)).resolution.digest).toBe(digest);
  });
});
