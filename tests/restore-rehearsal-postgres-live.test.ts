import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { BlobStore, RegistryState, StoredBlob } from '../packages/contracts/src/index.js';
import {
  cloneRegistryState,
  defaultRegistryState,
  postgresStateSchemaSql,
} from '../packages/database/src/index.js';
import { digestBytes } from '../packages/storage/src/index.js';
import { createNodeFilesSdkBlobStore } from '../packages/storage/src/node.js';
import {
  createLogicalBackup,
  type DeletionFenceEvidence,
} from '../scripts/restore-backup.js';
import {
  createPostgresBackupPool,
  createPostgresRestoreTarget,
  readPostgresOrganizationSnapshot,
  restorePostgresLogicalBackup,
  type PostgresBackupPool,
} from '../scripts/restore-backup-postgres.js';

const postgresUrl = process.env.PSKILLS_TEST_POSTGRES_URL;
const describeLive = postgresUrl ? describe : describe.skip;
const ORGANIZATION = 'live-postgres-restore-org';
const SOURCE_IDENTITY = 'live-postgres-source';
const TARGET_IDENTITY = 'live-postgres-target';
const BYTES = new TextEncoder().encode('live PostgreSQL JSONB restore bytes');
const FENCE: DeletionFenceEvidence = {
  scope: 'offline',
  kind: 'offline-test',
  evidenceRef: 'local-postgres-container',
  observedAt: '2026-01-01T00:00:00.000Z',
};

class SourceBlobFixture implements BlobStore {
  constructor(private readonly key: string, private readonly bytes: Uint8Array) {}

  async put(): Promise<StoredBlob> { throw new Error('source fixture must not upload'); }

  async get(key: string): Promise<Uint8Array> {
    if (key !== this.key) throw new Error('source fixture key mismatch');
    return new Uint8Array(this.bytes);
  }

  async remove(): Promise<void> { throw new Error('source fixture must not delete'); }
}

function sourceState(organizationId: string, key: string, digest: `sha256:${string}`): RegistryState {
  const state = defaultRegistryState({ production: true, allowUnscanned: false, policyRevision: 'live-jsonb-policy' });
  state.skills.push({
    id: 'live-jsonb-skill',
    organizationId,
    name: '@live/jsonb',
    skillName: 'jsonb',
    version: '1.0.0',
    description: 'live JSONB restore fixture',
    artifact: { key, digest, size: BYTES.byteLength },
    state: 'revoked',
    policyRevision: state.policy.revision,
    createdAt: '2026-01-01T00:00:00.000Z',
    provenance: { kind: 'native' },
    fileCount: 1,
    scanIds: [],
  });
  state.metadataRevision = 7;
  return state;
}

describeLive('real PostgreSQL restore rehearsal', () => {
  let root: string | undefined;
  let runtime: PostgresBackupPool | undefined;
  const tables: string[] = [];

  afterEach(async () => {
    if (runtime) {
      for (const table of tables) {
        await runtime.pool.query(`DROP TABLE IF EXISTS "${table}"`);
      }
      await runtime.close();
    }
    if (root) await rm(root, { recursive: true, force: true });
    runtime = undefined;
    root = undefined;
    tables.length = 0;
  });

  it('initializes an absent target table and preserves revision zero and revision seven through JSONB', async () => {
    root = await mkdtemp(join(tmpdir(), 'private-skills-live-pg-test-'));
    runtime = createPostgresBackupPool(postgresUrl!);
    const suffix = randomUUID().replaceAll('-', '');
    const tableName = `live_restore_${suffix}`;
    const zeroTable = `live_restore_zero_${suffix}`;
    tables.push(tableName, zeroTable);
    const sourceKey = `sealed/${'a'.repeat(48)}`;
    const digest = await digestBytes(BYTES);
    const state = sourceState(ORGANIZATION, sourceKey, digest);
    const sourceRepository = {
      async read() { return cloneRegistryState(state); },
      async transaction<T>(): Promise<T> { throw new Error('source fixture is read-only'); },
    };
    const backupDirectory = join(root, 'backup');
    await createLogicalBackup({
      sourceRepository,
      sourceBlobs: new SourceBlobFixture(sourceKey, BYTES),
      organizationId: ORGANIZATION,
      sourceIdentity: SOURCE_IDENTITY,
      sourceLocation: { kind: 'composite', identity: SOURCE_IDENTITY },
      backupDirectory,
      captureConsistency: 'offline-filesystem',
      deletionFence: FENCE,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    const targetBlobRoot = join(root, 'target-blobs');
    await mkdir(targetBlobRoot, { recursive: true, mode: 0o700 });
    const targetBlobs = await createNodeFilesSdkBlobStore({ provider: 'fs', root: targetBlobRoot, prefix: 'target' });
    const restored = await restorePostgresLogicalBackup({
      targetPool: runtime.pool,
      targetBlobs,
      organizationId: ORGANIZATION,
      targetIdentity: TARGET_IDENTITY,
      targetLocation: { kind: 'composite', identity: TARGET_IDENTITY },
      backupDirectory,
      targetIsolated: true,
      tableName,
      initializeSchema: true,
    });
    const snapshot = await readPostgresOrganizationSnapshot(runtime.pool, { organizationId: ORGANIZATION, tableName });
    expect(restored.metadataRevision).toBe(7);
    expect(snapshot.revision).toBe(7);
    expect(snapshot.state.policy.revision).toBe('live-jsonb-policy');
    expect(snapshot.state.skills[0]?.state).toBe('revoked');
    await expect(targetBlobs.get(snapshot.state.skills[0]!.artifact.key)).resolves.toEqual(BYTES);

    const zeroTarget = createPostgresRestoreTarget(runtime.pool, { tableName: zeroTable, initializeSchema: true });
    await zeroTarget.targetSeed.seed('live-zero-org', defaultRegistryState({ production: true, allowUnscanned: false }));
    const zero = await readPostgresOrganizationSnapshot(runtime.pool, { organizationId: 'live-zero-org', tableName: zeroTable });
    expect(zero.revision).toBe(0);
  });

  it('rejects an occupied target table, including another organization, before blob writes', async () => {
    root = await mkdtemp(join(tmpdir(), 'private-skills-live-pg-occupied-'));
    runtime = createPostgresBackupPool(postgresUrl!);
    const suffix = randomUUID().replaceAll('-', '');
    const tableName = `live_occupied_${suffix}`;
    tables.push(tableName);
    await runtime.pool.query(postgresStateSchemaSql(tableName));
    await runtime.pool.query(
      `INSERT INTO "${tableName}" (organization_id, revision, state) VALUES ($1, 0, $2::jsonb)`,
      ['other-live-org', JSON.stringify(defaultRegistryState())],
    );
    const backupDirectory = join(root, 'backup');
    const emptyState = defaultRegistryState({ production: true, allowUnscanned: false });
    await createLogicalBackup({
      sourceRepository: {
        async read() { return cloneRegistryState(emptyState); },
        async transaction<T>(): Promise<T> { throw new Error('source fixture is read-only'); },
      },
      sourceBlobs: new SourceBlobFixture(`sealed/${'b'.repeat(48)}`, new Uint8Array()),
      organizationId: ORGANIZATION,
      sourceIdentity: SOURCE_IDENTITY,
      sourceLocation: { kind: 'composite', identity: SOURCE_IDENTITY },
      backupDirectory,
      captureConsistency: 'offline-filesystem',
      deletionFence: FENCE,
    });
    let putCalls = 0;
    const targetBlobs: BlobStore = {
      async put() { putCalls += 1; throw new Error('occupied target must reject before blob writes'); },
      async get() { throw new Error('occupied target must not read blobs'); },
      async remove() { throw new Error('occupied target must not remove blobs'); },
    };
    const target = createPostgresRestoreTarget(runtime.pool, { tableName });
    await expect(target.repository.read(ORGANIZATION)).rejects.toMatchObject({ code: 'TARGET_NOT_EMPTY' });
    await expect(restorePostgresLogicalBackup({
      targetPool: runtime.pool,
      targetBlobs,
      organizationId: ORGANIZATION,
      targetIdentity: TARGET_IDENTITY,
      targetLocation: { kind: 'composite', identity: TARGET_IDENTITY },
      backupDirectory,
      targetIsolated: true,
      tableName,
    })).rejects.toMatchObject({ code: 'TARGET_NOT_EMPTY' });
    expect(putCalls).toBe(0);
  });
});
