import { describe, expect, it } from 'vitest';
import { createDraftHandler } from '../src/drafts.js';
import type { AuthoringHandlerDependencies } from '../src/index.js';
import { createMemoryStateRepository, defaultRegistryState } from '../../database/src/index.js';
import { digestBytes, encodeBundle } from '../../storage/src/index.js';
import type {
  Authenticator,
  BlobStore,
  Principal,
  RegistryState,
  SkillBundle,
  SkillVersion,
  StoredBlob,
} from '../../contracts/src/index.js';

const ORIGIN = 'https://registry.example.test';
const ORGANIZATION = 'org-test';

function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

class MemoryBlobs implements BlobStore {
  readonly values = new Map<string, Uint8Array>();
  putCalls = 0;

  async put(bytes: Uint8Array): Promise<StoredBlob> {
    const key = `sealed-${this.putCalls++}`;
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

function user(subject = 'publisher', namespaces = ['@team']): Principal {
  return {
    organizationId: ORGANIZATION,
    subject,
    roles: ['publisher'],
    namespaces,
    scopes: ['skills:publish', 'skills:read'],
  };
}

interface Fixture {
  repository: ReturnType<typeof createMemoryStateRepository>;
  blobs: MemoryBlobs;
  release: SkillVersion;
  bundle: SkillBundle;
  handler: ReturnType<typeof createDraftHandler>;
  setPrincipal(value: Principal | null): void;
  setAdmission(value: boolean): void;
}

async function fixture(): Promise<Fixture> {
  const state = defaultRegistryState({ production: false, allowUnscanned: true });
  const bundle: SkillBundle = {
    format: 'pskills-bundle-v1',
    files: [
      { path: 'SKILL.md', content: base64('---\nname: demo\ndescription: Demo\n---\n# Demo\n') },
      { path: 'docs/guide.md', content: base64('# Guide\n') },
      { path: 'rules.json', content: base64('{"safe":true}\n') },
    ],
  };
  const bytes = encodeBundle(bundle);
  const blobs = new MemoryBlobs();
  const stored = await blobs.put(bytes);
  const release: SkillVersion = {
    id: 'release-1',
    organizationId: ORGANIZATION,
    name: '@team/demo',
    skillName: 'demo',
    version: '1.0.0',
    description: 'Demo',
    artifact: stored,
    state: 'approved',
    policyRevision: state.policy.revision,
    createdAt: '2026-09-10T00:00:00.000Z',
    approvedAt: '2026-09-10T00:00:01.000Z',
    provenance: { kind: 'native' },
    fileCount: bundle.files.length,
    scanIds: [],
  };
  state.skills.push(release);
  const repository = createMemoryStateRepository({ initial: { [ORGANIZATION]: state } });
  let current: Principal | null = user();
  let admitted = true;
  const auth: Authenticator = { authenticate: async () => current };
  const deps: AuthoringHandlerDependencies = {
    repository,
    blobs,
    auth,
    config: { organizationId: ORGANIZATION, maxBodyBytes: 1024 * 1024 },
    releaseAdmission: async () => admitted,
  };
  return {
    repository,
    blobs,
    release,
    bundle,
    handler: createDraftHandler(deps),
    setPrincipal(value) {
      current = value;
    },
    setAdmission(value) {
      admitted = value;
    },
  };
}

async function json(response: Response): Promise<any> {
  return response.json();
}

async function create(test: Fixture, key = 'create-1'): Promise<any> {
  return json(await test.handler(new Request(`${ORIGIN}/v1/skills/release-1/drafts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({ baseDigest: test.release.artifact.digest }),
  })));
}

function updateRequest(
  draftId: string,
  key: string,
  expectedRevision: number,
  files: SkillBundle['files'],
): Request {
  return new Request(`${ORIGIN}/v1/drafts/${draftId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({ expectedRevision, files }),
  });
}

function publishRequest(draftId: string, key: string, expectedRevision: number, version: string): Request {
  return new Request(`${ORIGIN}/v1/drafts/${draftId}/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({ expectedRevision, version }),
  });
}

describe('durable skill drafts', () => {
  it('creates from an approved immutable release and retries idempotently', async () => {
    const test = await fixture();
    const createdResponse = await test.handler(new Request(`${ORIGIN}/v1/skills/release-1/drafts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'create-1' },
      body: JSON.stringify({ baseDigest: test.release.artifact.digest }),
    }));
    expect(createdResponse.status).toBe(201);
    const created = await json(createdResponse);
    expect(created.draft).toMatchObject({
      baseResourceId: 'release-1',
      baseDigest: test.release.artifact.digest,
      revision: 1,
      digest: test.release.artifact.digest,
      status: 'open',
    });
    expect(created.draft.files).toEqual(test.bundle.files);
    expect(created.draft).not.toHaveProperty('artifact.key');

    const retried = await test.handler(new Request(`${ORIGIN}/v1/skills/release-1/drafts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'create-1' },
      body: JSON.stringify({ baseDigest: test.release.artifact.digest }),
    }));
    expect(retried.status).toBe(200);
    expect(await json(retried)).toEqual({ draft: created.draft, idempotent: true });
    expect(test.blobs.putCalls).toBe(2); // original release + one fresh draft object

    const state = await test.repository.read(ORGANIZATION);
    expect(state.drafts).toHaveLength(1);
    expect(state.audit).toHaveLength(1);
    expect(state.skills[0]!.artifact).toEqual(test.release.artifact);
  });

  it('updates with a monotonic CAS revision and preserves the base release', async () => {
    const test = await fixture();
    const created = await create(test);
    const draftId = created.draft.id;
    const changedFiles = [
      { ...test.bundle.files[0]!, content: base64('---\nname: demo\ndescription: Edited\n---\n# Edited\n') },
      { ...test.bundle.files[1]!, content: base64('# Edited guide\n') },
      { ...test.bundle.files[2]!, content: base64('{"safe":false}\n') },
    ];
    const updatedResponse = await test.handler(updateRequest(draftId, 'update-1', 1, changedFiles));
    expect(updatedResponse.status).toBe(200);
    const updated = await json(updatedResponse);
    expect(updated.draft.revision).toBe(2);
    expect(updated.draft.digest).not.toBe(test.release.artifact.digest);
    expect(updated.draft.files).toEqual(changedFiles);

    const loaded = await test.handler(new Request(`${ORIGIN}/v1/drafts/${draftId}`));
    expect(loaded.status).toBe(200);
    expect((await json(loaded)).draft).toEqual(updated.draft);

    const stale = await test.handler(updateRequest(draftId, 'update-stale', 1, test.bundle.files));
    expect(stale.status).toBe(409);
    expect(await json(stale)).toEqual({
      error: {
        code: 'DRAFT_CONFLICT',
        message: 'Draft revision is stale; rebase before saving',
        details: { currentRevision: 2 },
      },
    });
    expect((await test.repository.read(ORGANIZATION)).skills[0]!.artifact).toEqual(test.release.artifact);
  });

  it('makes a successful update retry idempotent and rejects key reuse with another payload', async () => {
    const test = await fixture();
    const created = await create(test);
    const files = test.bundle.files.map((file) => ({ ...file, content: base64(`${file.path}\nchanged\n`) }));
    const first = await test.handler(updateRequest(created.draft.id, 'update-1', 1, files));
    expect(first.status).toBe(200);
    const firstBody = await json(first);
    const retry = await test.handler(updateRequest(created.draft.id, 'update-1', 1, files));
    expect(retry.status).toBe(200);
    expect(await json(retry)).toEqual({ draft: firstBody.draft, idempotent: true });
    expect((await test.repository.read(ORGANIZATION)).drafts![0]!.revision).toBe(2);

    const conflictingReuse = await test.handler(updateRequest(created.draft.id, 'update-1', 1, test.bundle.files));
    expect(conflictingReuse.status).toBe(409);
    expect((await json(conflictingReuse)).error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('rejects unauthorized drafts and unsafe file paths without reading or persisting content', async () => {
    const test = await fixture();
    test.setPrincipal({ ...user('reader', ['@other']), roles: ['reader'], scopes: ['skills:read'] });
    const deniedCreate = await test.handler(new Request(`${ORIGIN}/v1/skills/release-1/drafts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'denied' },
      body: JSON.stringify({ baseDigest: test.release.artifact.digest }),
    }));
    expect(deniedCreate.status).toBe(403);
    expect(test.blobs.putCalls).toBe(1);

    test.setPrincipal(user());
    const created = await create(test);
    const unsafe = await test.handler(updateRequest(created.draft.id, 'unsafe', 1, [
      { path: '../escape.md', content: base64('nope') },
    ]));
    expect(unsafe.status).toBe(400);
    expect((await test.repository.read(ORGANIZATION)).drafts![0]!.revision).toBe(1);
  });

  it('returns an explicit conflict when the selected base digest is stale', async () => {
    const test = await fixture();
    const response = await test.handler(new Request(`${ORIGIN}/v1/skills/release-1/drafts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'stale-base' },
      body: JSON.stringify({ baseDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' }),
    }));
    expect(response.status).toBe(409);
    expect((await json(response)).error.code).toBe('DIGEST_MISMATCH');
    expect((await test.repository.read(ORGANIZATION)).drafts ?? []).toEqual([]);
  });

  it('queues an immutable scanner job for publication and retries idempotently', async () => {
    const test = await fixture();
    const created = await create(test);
    const firstResponse = await test.handler(publishRequest(created.draft.id, 'publish-1', 1, '1.1.0'));
    expect(firstResponse.status).toBe(202);
    const first = await json(firstResponse);
    expect(first).toMatchObject({
      idempotent: false,
      operation: {
        state: 'queued',
        version: '1.1.0',
        revision: 1,
        digest: created.draft.digest,
        scanRequired: true,
      },
    });

    const state = await test.repository.read(ORGANIZATION);
    expect(state.skills).toHaveLength(2);
    const published = state.skills.find((skill) => skill.id === first.operation.resourceId);
    expect(published).toMatchObject({
      name: test.release.name,
      version: '1.1.0',
      state: 'pending',
      policyRevision: state.policy.revision,
      fileCount: test.bundle.files.length,
      authoring: {
        baseResourceId: test.release.id,
        baseDigest: test.release.artifact.digest,
        draftId: created.draft.id,
        draftRevision: 1,
        actor: 'publisher',
      },
    });
    expect(published?.artifact).toEqual(state.drafts![0]!.artifact);
    expect(state.jobs).toHaveLength(1);
    expect(state.jobs[0]).toMatchObject({
      id: first.operation.id,
      kind: 'scan',
      state: 'queued',
      resourceId: first.operation.resourceId,
      artifact: published?.artifact,
      policyRevision: state.policy.revision,
    });
    expect(state.drafts![0]!.publications).toHaveLength(1);
    expect(state.drafts![0]!.status).toBe('open');
    expect(state.skills[0]!.artifact).toEqual(test.release.artifact);

    const retryResponse = await test.handler(publishRequest(created.draft.id, 'publish-1', 1, '1.1.0'));
    expect(retryResponse.status).toBe(200);
    expect(await json(retryResponse)).toEqual({ operation: first.operation, idempotent: true });
    expect((await test.repository.read(ORGANIZATION)).jobs).toHaveLength(1);
  });

  it('rejects publication when the base release loses admission or the CAS revision is stale', async () => {
    const test = await fixture();
    const created = await create(test);
    test.setAdmission(false);
    const denied = await test.handler(publishRequest(created.draft.id, 'publish-denied', 1, '1.1.0'));
    expect(denied.status).toBe(404);
    expect((await json(denied)).error.code).toBe('NOT_FOUND');
    expect((await test.repository.read(ORGANIZATION)).jobs).toHaveLength(0);

    test.setAdmission(true);
    const stale = await test.handler(publishRequest(created.draft.id, 'publish-stale', 2, '1.1.0'));
    expect(stale.status).toBe(409);
    expect((await json(stale)).error.code).toBe('DRAFT_CONFLICT');
  });
});
