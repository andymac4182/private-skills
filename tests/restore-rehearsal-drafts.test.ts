import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  BlobStore,
  Digest,
  RegistryState,
  StateRepository,
  StoredBlob,
} from '../packages/contracts/src/index.js';
import {
  cloneRegistryState,
  createFileStateRepository,
  defaultRegistryState,
} from '../packages/database/src/index.js';
import { digestBytes } from '../packages/storage/src/index.js';
import {
  createFileStateSeed,
  createLogicalBackup,
  restoreLogicalBackup,
} from '../scripts/restore-backup.js';

const ORGANIZATION = 'draft-restore-rehearsal-org';

type DraftFixture = {
  id: string;
  organizationId: string;
  name: string;
  skillName: string;
  description: string;
  baseResourceId: string;
  baseDigest: Digest;
  revision: number;
  digest: Digest;
  artifact: StoredBlob;
  files: Array<{ path: string; size: number; digest: Digest }>;
  status: 'open';
  actor: string;
  createdAt: string;
  updatedAt: string;
  createIdempotency: {
    key: string;
    subject: string;
    requestDigest: Digest;
    revision: number;
    digest: Digest;
    artifact: StoredBlob;
    manifest: Array<{ path: string; size: number; digest: Digest }>;
    updatedAt: string;
  };
  idempotency: Array<{
    key: string;
    subject: string;
    requestDigest: Digest;
    revision: number;
    digest: Digest;
    artifact: StoredBlob;
    manifest: Array<{ path: string; size: number; digest: Digest }>;
    updatedAt: string;
  }>;
  publications: Array<{
    key: string;
    subject: string;
    requestDigest: Digest;
    revision: number;
    digest: Digest;
    version: string;
    resourceId: string;
    jobId: string;
    createdAt: string;
  }>;
};

type DraftState = RegistryState & {
  drafts?: DraftFixture[];
  futureAuthoring?: Array<{
    metadata: { key: string; digest: Digest };
    sealed: { artifact: StoredBlob };
  }>;
};

class MemoryBlobStore implements BlobStore {
  readonly values = new Map<string, Uint8Array>();
  private sequence = 0;

  constructor(private readonly writable: boolean) {}

  async put(bytes: Uint8Array): Promise<StoredBlob> {
    if (!this.writable) throw new Error('source blob store must not upload');
    const copy = new Uint8Array(bytes);
    const key = `target/sealed/${String(this.sequence++).padStart(48, '0')}`;
    const stored = { key, digest: await digestBytes(copy), size: copy.byteLength } satisfies StoredBlob;
    this.values.set(key, copy);
    return stored;
  }

  async get(key: string): Promise<Uint8Array> {
    const bytes = this.values.get(key);
    if (!bytes) throw new Error('blob is missing');
    return new Uint8Array(bytes);
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
}

async function stored(source: MemoryBlobStore, label: string): Promise<StoredBlob> {
  const bytes = new TextEncoder().encode(`draft restore ${label}`);
  const digest = await digestBytes(bytes);
  const record = {
    key: `sealed/${label}`,
    digest,
    size: bytes.byteLength,
  } satisfies StoredBlob;
  source.values.set(record.key, bytes);
  return record;
}

async function fixture(): Promise<{
  root: string;
  state: DraftState;
  source: MemoryBlobStore;
  target: MemoryBlobStore;
  repository: StateRepository;
  stateDirectory: string;
  backupDirectory: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'private-skills-restore-drafts-'));
  const source = new MemoryBlobStore(false);
  const target = new MemoryBlobStore(true);
  const current = await stored(source, 'draft-current');
  const created = await stored(source, 'draft-created');
  const updated = await stored(source, 'draft-updated');
  const future = await stored(source, 'draft-future');
  const now = '2026-09-10T00:00:00.000Z';
  const state = defaultRegistryState({
    production: false,
    allowUnscanned: true,
    policyRevision: 'draft-restore-policy',
  }) as DraftState;
  state.metadataRevision = 8;
  state.drafts = [{
    id: 'draft-1',
    organizationId: ORGANIZATION,
    name: '@team/draft',
    skillName: 'draft',
    description: 'Draft restore fixture',
    baseResourceId: 'release-1',
    baseDigest: created.digest,
    revision: 3,
    digest: current.digest,
    artifact: { ...current },
    files: [{ path: 'SKILL.md', size: current.size, digest: current.digest }],
    status: 'open',
    actor: 'publisher',
    createdAt: now,
    updatedAt: now,
    createIdempotency: {
      key: 'create-request-1',
      subject: 'publisher',
      requestDigest: created.digest,
      revision: 1,
      digest: created.digest,
      artifact: { ...created },
      manifest: [{ path: 'SKILL.md', size: created.size, digest: created.digest }],
      updatedAt: now,
    },
    idempotency: [{
      key: 'update-request-1',
      subject: 'publisher',
      requestDigest: updated.digest,
      revision: 2,
      digest: updated.digest,
      artifact: { ...updated },
      manifest: [{ path: 'SKILL.md', size: updated.size, digest: updated.digest }],
      updatedAt: now,
    }],
    publications: [{
      key: 'publish-request-1',
      subject: 'publisher',
      requestDigest: current.digest,
      revision: 3,
      digest: current.digest,
      version: '1.1.0',
      resourceId: 'release-2',
      jobId: 'job-2',
      createdAt: now,
    }],
  }];
  // This unknown collection models a future authoring extension.  Its
  // metadata has a key/digest pair but is not a StoredBlob; the nested sealed
  // artifact must still be discovered and restored.
  state.futureAuthoring = [{
    metadata: { key: 'future-idempotency-key', digest: future.digest },
    sealed: { artifact: { ...future } },
  }];
  const repository: StateRepository = {
    async read(organizationId) {
      if (organizationId !== ORGANIZATION) throw new Error('organization mismatch');
      return cloneRegistryState(state);
    },
    async transaction() {
      throw new Error('source repository is read-only');
    },
  };
  const stateDirectory = join(root, 'target-state');
  const backupDirectory = join(root, 'backup');
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  return { root, state, source, target, repository, stateDirectory, backupDirectory };
}

describe('logical backup authoring references', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it('captures and restores current, idempotency-history, and unknown-extension artifacts', async () => {
    const fixtureState = await fixture();
    root = fixtureState.root;
    const backup = await createLogicalBackup({
      sourceRepository: fixtureState.repository,
      sourceBlobs: fixtureState.source,
      organizationId: ORGANIZATION,
      sourceIdentity: 'draft-source',
      sourceLocation: { kind: 'composite', identity: 'draft-source' },
      backupDirectory: fixtureState.backupDirectory,
      captureConsistency: 'offline-filesystem',
      deletionFence: {
        scope: 'offline',
        kind: 'offline-test',
        evidenceRef: 'vitest-draft-history',
        observedAt: '2026-09-10T00:00:00.000Z',
      },
      now: () => new Date('2026-09-10T00:00:00.000Z'),
    });

    expect(backup.manifest.metadataRevision).toBe(8);
    expect(backup.manifest.objects).toHaveLength(4);
    const objectFor = (key: string) => backup.manifest.objects.find((entry) => entry.key === key);
    expect(objectFor(fixtureState.state.drafts![0]!.artifact.key)?.references).toEqual([
      'state.drafts[0].artifact',
    ]);
    expect(objectFor(fixtureState.state.drafts![0]!.createIdempotency.artifact.key)?.references).toEqual([
      'state.drafts[0].createIdempotency.artifact',
    ]);
    expect(objectFor(fixtureState.state.drafts![0]!.idempotency[0]!.artifact.key)?.references).toEqual([
      'state.drafts[0].idempotency[0].artifact',
    ]);
    expect(objectFor(fixtureState.state.futureAuthoring![0]!.sealed.artifact.key)?.references).toEqual([
      'state.futureAuthoring[0].sealed.artifact',
    ]);

    const targetRepository = createFileStateRepository({ directory: fixtureState.stateDirectory });
    const restored = await restoreLogicalBackup({
      targetRepository,
      targetBlobs: fixtureState.target,
      organizationId: ORGANIZATION,
      targetIdentity: 'draft-target',
      targetLocation: { kind: 'composite', identity: 'draft-target' },
      backupDirectory: fixtureState.backupDirectory,
      targetIsolated: true,
      targetSeed: createFileStateSeed(fixtureState.stateDirectory),
    });
    expect(restored.metadataRevision).toBe(8);
    expect(restored.objectCount).toBe(4);
    const restoredState = await targetRepository.read(ORGANIZATION) as DraftState;
    expect(restoredState.metadataRevision).toBe(8);
    expect(restoredState.drafts?.[0]?.createIdempotency.key).toBe('create-request-1');
    expect(restoredState.drafts?.[0]?.publications[0]?.key).toBe('publish-request-1');
    expect(restoredState.drafts?.[0]?.files).toEqual(fixtureState.state.drafts![0]!.files);
    expect(restoredState.futureAuthoring?.[0]?.metadata).toEqual(fixtureState.state.futureAuthoring![0]!.metadata);

    const restoredArtifacts = [
      restoredState.drafts?.[0]?.artifact,
      restoredState.drafts?.[0]?.createIdempotency.artifact,
      restoredState.drafts?.[0]?.idempotency[0]?.artifact,
      restoredState.futureAuthoring?.[0]?.sealed.artifact,
    ];
    for (const artifact of restoredArtifacts) {
      expect(artifact).toBeDefined();
      expect(artifact!.key).not.toMatch(/^sealed\//u);
      await expect(fixtureState.target.get(artifact!.key)).resolves.toBeInstanceOf(Uint8Array);
    }
    expect(restoredState.drafts?.[0]?.artifact.digest).toBe(fixtureState.state.drafts![0]!.artifact.digest);
    expect(restoredState.drafts?.[0]?.createIdempotency.artifact.digest).toBe(fixtureState.state.drafts![0]!.createIdempotency.artifact.digest);
    expect(restoredState.drafts?.[0]?.idempotency[0]?.artifact.digest).toBe(fixtureState.state.drafts![0]!.idempotency[0]!.artifact.digest);
    expect(restoredState.futureAuthoring?.[0]?.sealed.artifact.digest).toBe(fixtureState.state.futureAuthoring![0]!.sealed.artifact.digest);
  });
});
