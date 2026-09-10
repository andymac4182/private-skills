import { describe, expect, it } from 'vitest';
import { createMemoryStateRepository, defaultRegistryState } from '../../database/src/index.js';
import { digestBytes, encodeBundle } from '../../storage/src/index.js';
import type {
  Authenticator,
  BlobStore,
  Principal,
  RegistryState,
  ScanResult,
  SkillBundle,
  SkillVersion,
  StoredBlob,
} from '../../contracts/src/index.js';
import { createRegistryHandler } from '../src/index.js';

const ORIGIN = 'https://registry.example.test';
const ORGANIZATION = 'org-test';

function base64Text(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

class MemoryBlobs implements BlobStore {
  readonly values = new Map<string, Uint8Array>();

  async put(bytes: Uint8Array): Promise<StoredBlob> {
    const copy = bytes.slice();
    const stored: StoredBlob = {
      key: `blob-${this.values.size}`,
      digest: await digestBytes(copy),
      size: copy.byteLength,
    };
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

function publisher(namespaces: string[] = ['@team']): Principal {
  return {
    organizationId: ORGANIZATION,
    subject: 'publisher',
    roles: ['publisher', 'reader'],
    namespaces,
    scopes: ['skills:read', 'registry:read', 'skills:write', 'skills:publish'],
  };
}

function worker(): Principal {
  return {
    organizationId: ORGANIZATION,
    subject: 'scanner-worker',
    roles: ['worker'],
    scopes: ['jobs:claim', 'jobs:artifact', 'jobs:complete'],
    identity: 'worker',
  } as Principal;
}

function requiredScan(
  jobId: string,
  digest: SkillVersion['artifact']['digest'],
  policyRevision: string,
  id: string,
): ScanResult {
  return {
    id,
    organizationId: ORGANIZATION,
    jobId,
    artifactDigest: digest,
    policyRevision,
    scannerId: 'cisco-skill-scanner',
    engineVersion: 'test-engine',
    rulesRevision: 'test-rules',
    configurationHash: 'test-config',
    status: 'completed',
    findings: [],
    coverage: {
      filesEnumerated: 1,
      filesAnalyzed: 1,
      filesSkipped: 0,
      filesUnsupported: 0,
      limitations: [],
      externalDestinations: [],
    },
    createdAt: new Date().toISOString(),
    durationMs: 1,
  };
}

interface Fixture {
  state: RegistryState;
  repository: ReturnType<typeof createMemoryStateRepository>;
  blobs: MemoryBlobs;
  handler: ReturnType<typeof createRegistryHandler>;
  setPrincipal(value: Principal | null): void;
}

async function fixture(): Promise<Fixture> {
  const state = defaultRegistryState({
    production: false,
    allowUnscanned: false,
    policyRevision: 'policy-authoring',
  });
  state.policy.scanners = [{
    id: 'cisco-skill-scanner',
    mode: 'required',
    blockSeverities: ['high', 'critical'],
    timeoutSeconds: 60,
  }];

  const bundle: SkillBundle = {
    format: 'pskills-bundle-v1',
    files: [{
      path: 'SKILL.md',
      content: base64Text('---\nname: base\ndescription: Base release\n---\n# Base\n'),
    }],
  };
  const bytes = encodeBundle(bundle);
  const blobs = new MemoryBlobs();
  const artifact = await blobs.put(bytes);
  const baseScan = requiredScan('base-scan-job', artifact.digest, state.policy.revision, 'base-scan');
  state.scans.push(baseScan);
  const base: SkillVersion = {
    id: 'release-1',
    organizationId: ORGANIZATION,
    name: '@team/base',
    skillName: 'base',
    version: '1.0.0',
    description: 'Base release',
    artifact,
    state: 'approved',
    policyRevision: state.policy.revision,
    createdAt: '2026-09-10T00:00:00.000Z',
    approvedAt: '2026-09-10T00:00:01.000Z',
    provenance: { kind: 'native' },
    fileCount: bundle.files.length,
    scanIds: [baseScan.id],
  };
  state.skills.push(base);

  const repository = createMemoryStateRepository({ initial: { [ORGANIZATION]: state } });
  let current: Principal | null = publisher();
  const auth: Authenticator = { authenticate: async () => current };
  const handler = createRegistryHandler({
    repository,
    blobs,
    auth,
    config: {
      publicOrigin: ORIGIN,
      maxBodyBytes: 1024 * 1024,
      organizationId: ORGANIZATION,
      leaseSeconds: 30,
    },
  });
  return {
    state,
    repository,
    blobs,
    handler,
    setPrincipal(value) {
      current = value;
    },
  };
}

async function json(response: Response): Promise<any> {
  return response.json();
}

describe('core authoring composition', () => {
  it('runs draft create/update/publish through core, then scanner completion approves the immutable revision', async () => {
    const test = await fixture();
    const baseDigest = test.state.skills[0]!.artifact.digest;

    const created = await test.handler(new Request(`${ORIGIN}/v1/skills/release-1/drafts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'draft-create-1' },
      body: JSON.stringify({ baseDigest }),
    }));
    expect(created.status).toBe(201);
    const draft = (await json(created)).draft as { id: string; revision: number; digest: string };
    expect(draft.revision).toBe(1);
    expect(draft.digest).toBe(baseDigest);

    const loaded = await test.handler(new Request(`${ORIGIN}/v1/drafts/${encodeURIComponent(draft.id)}`));
    expect(loaded.status).toBe(200);
    expect((await json(loaded)).draft).toMatchObject({ id: draft.id, revision: 1, baseResourceId: 'release-1' });

    const updatedBundle: SkillBundle = {
      format: 'pskills-bundle-v1',
      files: [{
        path: 'SKILL.md',
        content: base64Text('---\nname: edited\ndescription: Edited release\n---\n# Edited\n'),
      }],
    };
    const updatedDigest = await digestBytes(encodeBundle(updatedBundle));
    const updated = await test.handler(new Request(`${ORIGIN}/v1/drafts/${encodeURIComponent(draft.id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'draft-update-1' },
      body: JSON.stringify({ expectedRevision: 1, files: updatedBundle.files }),
    }));
    expect(updated.status).toBe(200);
    expect((await json(updated)).draft).toMatchObject({ id: draft.id, revision: 2, digest: updatedDigest });

    const published = await test.handler(new Request(`${ORIGIN}/v1/drafts/${encodeURIComponent(draft.id)}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'draft-publish-1' },
      body: JSON.stringify({ expectedRevision: 2, version: '1.1.0' }),
    }));
    expect(published.status).toBe(202);
    const operation = (await json(published)).operation as { id: string; resourceId: string; digest: string; state: string };
    expect(operation).toMatchObject({ state: 'queued', digest: updatedDigest, scanRequired: true });

    const queuedState = await test.repository.read(ORGANIZATION);
    const pending = queuedState.skills.find((skill) => skill.id === operation.resourceId);
    const pendingJob = queuedState.jobs.find((job) => job.id === operation.id);
    expect(pending).toMatchObject({ state: 'pending', artifact: { digest: updatedDigest }, policyRevision: queuedState.policy.revision });
    expect(pending?.authoring).toMatchObject({ baseResourceId: 'release-1', draftId: draft.id, draftRevision: 2 });
    expect(pendingJob).toMatchObject({ state: 'queued', kind: 'scan', resourceId: operation.resourceId, artifact: { digest: updatedDigest } });

    test.setPrincipal(worker());
    const claim = await test.handler(new Request(`${ORIGIN}/internal/jobs/claim`, { method: 'POST' }));
    expect(claim.status).toBe(200);
    const claimed = (await json(claim)).job as { id: string; leaseToken: string; artifact: StoredBlob };
    expect(claimed.id).toBe(operation.id);
    expect(claimed.artifact.digest).toBe(updatedDigest);

    const artifact = await test.handler(new Request(`${ORIGIN}/internal/jobs/${encodeURIComponent(operation.id)}/artifact`, {
      headers: {
        'x-worker-fencing-token': claimed.leaseToken,
        'x-artifact-digest': claimed.artifact.digest,
      },
    }));
    expect(artifact.status).toBe(200);
    expect(artifact.headers.get('x-artifact-digest')).toBe(updatedDigest);
    expect(await artifact.arrayBuffer()).toEqual(encodeBundle(updatedBundle).buffer);

    const scan = requiredScan(operation.id, updatedDigest as SkillVersion['artifact']['digest'], queuedState.policy.revision, 'published-scan');
    const completed = await test.handler(new Request(`${ORIGIN}/internal/jobs/${encodeURIComponent(operation.id)}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-worker-fencing-token': claimed.leaseToken },
      body: JSON.stringify({
        leaseToken: claimed.leaseToken,
        artifactDigest: updatedDigest,
        scanResults: [scan],
      }),
    }));
    expect(completed.status).toBe(200);
    expect((await json(completed)).operation.state).toBe('completed');

    test.setPrincipal(publisher());
    const finalState = await test.repository.read(ORGANIZATION);
    const approved = finalState.skills.find((skill) => skill.id === operation.resourceId);
    expect(approved).toMatchObject({ state: 'approved', artifact: { digest: updatedDigest }, scanIds: ['published-scan'] });
  });

  it('keeps draft routes publisher-scoped and denies other namespaces before authoring writes', async () => {
    const test = await fixture();
    const before = await test.repository.read(ORGANIZATION);

    test.setPrincipal({
      organizationId: ORGANIZATION,
      subject: 'reader',
      roles: ['reader'],
      namespaces: ['@team'],
      scopes: ['skills:read', 'registry:read'],
    });
    const readerWrite = await test.handler(new Request(`${ORIGIN}/v1/skills/release-1/drafts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'reader-write' },
      body: JSON.stringify({ baseDigest: before.skills[0]!.artifact.digest }),
    }));
    expect(readerWrite.status).toBe(403);

    test.setPrincipal({ ...publisher(['@other']), subject: 'other-publisher' });
    const otherNamespace = await test.handler(new Request(`${ORIGIN}/v1/skills/release-1/drafts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'other-write' },
      body: JSON.stringify({ baseDigest: before.skills[0]!.artifact.digest }),
    }));
    expect(otherNamespace.status).toBe(404);

    test.setPrincipal(worker());
    const workerWrite = await test.handler(new Request(`${ORIGIN}/v1/drafts/missing`, {
      headers: { authorization: 'Bearer worker' },
    }));
    expect(workerWrite.status).toBe(403);

    expect(await test.repository.read(ORGANIZATION)).toEqual(before);
  });

  it('does not publish a draft when the current scanner admission is lost', async () => {
    const test = await fixture();
    const baseDigest = test.state.skills[0]!.artifact.digest;
    const created = await test.handler(new Request(`${ORIGIN}/v1/skills/release-1/drafts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'admission-create' },
      body: JSON.stringify({ baseDigest }),
    }));
    const draftId = (await json(created)).draft.id as string;
    await test.repository.transaction(ORGANIZATION, (state) => {
      state.policy.revision = 'policy-changed';
    });
    const response = await test.handler(new Request(`${ORIGIN}/v1/drafts/${encodeURIComponent(draftId)}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'admission-publish' },
      body: JSON.stringify({ expectedRevision: 1, version: '1.1.0' }),
    }));
    expect(response.status).toBe(404);
    const after = await test.repository.read(ORGANIZATION);
    expect(after.jobs).toHaveLength(0);
    expect(after.skills).toHaveLength(1);
  });
});
