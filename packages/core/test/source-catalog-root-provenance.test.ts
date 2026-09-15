import { describe, expect, it } from 'vitest';

import { createMemoryStateRepository, defaultRegistryState } from '../../database/src/index.js';
import { createRegistryHandler } from '../src/index.js';
import { digestBytes, encodeBundle } from '../../storage/src/index.js';
import type {
  Authenticator,
  Job,
  Principal,
  RecoverableBlobStore,
  RegistryConfiguration,
  SkillBundle,
  StorageObjectInspection,
  StoredBlob,
  Upstream,
} from '../../contracts/src/index.js';

const ORIGIN = 'https://source-root-provenance.test';
const ORGANIZATION_ID = 'source-root-org';
const UPSTREAM_ID = 'source-root-upstream';
const JOB_ID = 'source-root-job';
const LEASE_TOKEN = 'source-root-lease';
const COMMIT = 'a'.repeat(40);
const EXTERNAL_ID = 'acme/root';

class MemoryBlobs implements RecoverableBlobStore {
  private readonly values = new Map<string, Uint8Array>();
  private nextKey = 0;

  async put(bytes: Uint8Array): Promise<StoredBlob> {
    return this.putAtKey(this.allocateObjectKey(), bytes);
  }

  allocateObjectKey(): string {
    return `root-${this.nextKey++}`;
  }

  async putAtKey(key: string, bytes: Uint8Array): Promise<StoredBlob> {
    const copy = bytes.slice();
    const stored = { key, digest: await digestBytes(copy), size: copy.byteLength } satisfies StoredBlob;
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

  async inspectObject(key: string): Promise<StorageObjectInspection> {
    const bytes = this.values.get(key);
    if (!bytes) return { state: 'absent', key };
    return { state: 'present', key, digest: await digestBytes(bytes), size: bytes.byteLength };
  }

  async confirmWriteTerminated(key: string): Promise<boolean> {
    return !this.values.has(key);
  }
}

function bundle(): SkillBundle {
  return {
    format: 'pskills-bundle-v1',
    files: [{
      path: 'SKILL.md',
      content: Buffer.from('---\nname: root\ndescription: root fixture\n---\n\n# Root\n', 'utf8').toString('base64'),
    }],
  };
}

function principal(): Principal {
  return {
    organizationId: ORGANIZATION_ID,
    subject: 'root-worker',
    roles: ['worker'],
    scopes: ['*'],
  };
}

function rootUpstream(): Upstream {
  return {
    id: UPSTREAM_ID,
    organizationId: ORGANIZATION_ID,
    name: 'root-source',
    kind: 'github',
    enabled: true,
    repositories: ['acme/root'],
    baseUrl: 'https://api.github.com',
    namespace: '@team',
    configRevision: 'root-revision-1',
  };
}

function rootJob(policy: Job['policy']): Job {
  const now = new Date().toISOString();
  const upstream = rootUpstream();
  return {
    id: JOB_ID,
    organizationId: ORGANIZATION_ID,
    kind: 'import',
    state: 'running',
    policyRevision: policy.revision,
    policy,
    import: {
      upstreamId: UPSTREAM_ID,
      repository: 'acme/root',
      path: '',
      ref: COMMIT,
      name: '@team/root',
      version: '1.0.0',
      externalId: EXTERNAL_ID,
      sourceReference: '@github/acme/root',
      sourceCatalogId: 'github-custom',
      sourceCatalogConfigRevision: 'github-custom:revision-1',
    },
    upstream,
    createdAt: now,
    updatedAt: now,
    attempts: 1,
    leaseToken: LEASE_TOKEN,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

async function complete(handler: ReturnType<typeof createRegistryHandler>, provenance: Record<string, unknown>): Promise<Response> {
  const bytes = encodeBundle(bundle());
  const digest = await digestBytes(bytes);
  return handler(new Request(`${ORIGIN}/internal/jobs/${JOB_ID}/complete`, {
    method: 'POST',
    headers: { authorization: 'Bearer worker', 'content-type': 'application/json' },
    body: JSON.stringify({
      leaseToken: LEASE_TOKEN,
      artifactDigest: digest,
      bundle: bundle(),
      provenance: { kind: 'github', upstreamId: UPSTREAM_ID, repository: 'acme/root', revision: COMMIT, sourceReference: '@github/acme/root', ...provenance },
    }),
  }));
}

describe('GitHub repository-root completion provenance', () => {
  it('requires an explicit empty path for a root-bound job and preserves it', async () => {
    const policy = defaultRegistryState({ production: false, allowUnscanned: true }).policy;
    const repository = createMemoryStateRepository({
      stateFactory: () => {
        const state = defaultRegistryState({ production: false, allowUnscanned: true });
        state.policy = policy;
        state.jobs.push(rootJob(policy));
        return state;
      },
    });
    const worker = principal();
    const auth: Authenticator = { authenticate: async () => worker };
    const config: RegistryConfiguration = { publicOrigin: ORIGIN, organizationId: ORGANIZATION_ID, maxBodyBytes: 2 * 1024 * 1024, leaseSeconds: 60 };
    const handler = createRegistryHandler({ repository, blobs: new MemoryBlobs(), auth, config });

    const omitted = await complete(handler, {});
    expect(omitted.status).toBe(409);
    const mismatch = await complete(handler, { path: 'skills/root' });
    expect(mismatch.status).toBe(409);
    const accepted = await complete(handler, { path: '', externalId: EXTERNAL_ID });
    expect(accepted.status).toBe(200);

    const state = await repository.read(ORGANIZATION_ID);
    const skill = state.skills[0];
    expect(skill?.provenance).toMatchObject({ path: '', externalSource: 'github-custom', externalId: EXTERNAL_ID });
  });
});
