import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  BlobStore,
  RegistryState,
  StoredBlob,
} from '../packages/contracts/src/index.js';
import {
  cloneRegistryState,
  defaultRegistryState,
  type PgClientLike,
  type PgPoolLike,
} from '../packages/database/src/index.js';
import { digestBytes } from '../packages/storage/src/index.js';
import { createNodeFilesSdkBlobStore } from '../packages/storage/src/node.js';
import {
  createLogicalBackup,
  type DeletionFenceEvidence,
  type QualifiedLocation,
} from '../scripts/restore-backup.js';
import {
  createPostgresRestoreTarget,
  createPostgresStateSeed,
  main,
  restorePostgresLogicalBackup,
  PostgresSnapshotError,
} from '../scripts/restore-backup-postgres.js';

const ORGANIZATION = 'postgres-target-rehearsal-org';
const OTHER_ORGANIZATION = 'postgres-target-other-org';
const SOURCE_IDENTITY = 'neon-source-rehearsal';
const TARGET_IDENTITY = 'neon-isolated-target-rehearsal';
const SOURCE_LOCATION: QualifiedLocation = { kind: 'composite', identity: SOURCE_IDENTITY };
const TARGET_LOCATION: QualifiedLocation = { kind: 'composite', identity: TARGET_IDENTITY };
const FENCE: DeletionFenceEvidence = {
  scope: 'offline',
  kind: 'offline-test',
  evidenceRef: 'local-postgres-target-rehearsal',
  observedAt: '2026-01-01T00:00:00.000Z',
};
const BYTES = new TextEncoder().encode('isolated PostgreSQL target exact bytes');

interface Row {
  organization_id: string;
  revision: number;
  state: unknown;
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Disposable in-memory SQL fixture with transaction commit/rollback semantics. */
class TargetPgFixture implements PgPoolLike {
  readonly rows = new Map<string, Row>();
  readonly queries: string[] = [];
  commits = 0;
  rollbacks = 0;
  corruptUpdate = false;

  async query(): Promise<never> {
    throw new Error('target adapter must use a dedicated transaction connection');
  }

  setRow(row: Row): void {
    this.rows.set(row.organization_id, copy(row));
  }

  getRow(organizationId: string): Row | undefined {
    const row = this.rows.get(organizationId);
    return row ? copy(row) : undefined;
  }

  async connect(): Promise<PgClientLike> {
    const transactionRows = new Map<string, Row>([...this.rows].map(([key, row]) => [key, copy(row)]));
    let active = false;
    return {
      query: async <RowType = Record<string, unknown>>(text: string, parameters: readonly unknown[] = []) => {
        this.queries.push(text);
        if (/^BEGIN/u.test(text)) {
          active = true;
          return { rows: [] as RowType[], rowCount: 0 };
        }
        if (text === 'COMMIT') {
          if (!active) throw new Error('commit without transaction');
          this.rows.clear();
          for (const [key, row] of transactionRows) this.rows.set(key, copy(row));
          active = false;
          this.commits += 1;
          return { rows: [] as RowType[], rowCount: 0 };
        }
        if (text === 'ROLLBACK') {
          active = false;
          this.rollbacks += 1;
          return { rows: [] as RowType[], rowCount: 0 };
        }
        if (!active) throw new Error('query outside transaction');
        if (/^INSERT INTO /u.test(text)) {
          const organizationId = String(parameters[0]);
          if (transactionRows.has(organizationId)) return { rows: [] as RowType[], rowCount: 0 };
          transactionRows.set(organizationId, {
            organization_id: organizationId,
            revision: 0,
            state: JSON.parse(String(parameters[1])) as unknown,
          });
          return { rows: [] as RowType[], rowCount: 1 };
        }
        if (/^SELECT organization_id, revision, state /u.test(text)) {
          const organizationId = String(parameters[0]);
          const row = transactionRows.get(organizationId);
          return {
            rows: (row ? [copy(row)] : []) as RowType[],
            rowCount: row ? 1 : 0,
          };
        }
        if (/^UPDATE /u.test(text)) {
          const organizationId = String(parameters[0]);
          const row = transactionRows.get(organizationId);
          const expectedRevision = 0;
          if (!row || row.revision !== expectedRevision) return { rows: [] as RowType[], rowCount: 0 };
          row.state = JSON.parse(String(parameters[1])) as unknown;
          row.revision = Number(parameters[2]);
          if (this.corruptUpdate) {
            row.state = { schemaVersion: 1 };
            this.corruptUpdate = false;
          }
          return { rows: [] as RowType[], rowCount: 1 };
        }
        throw new Error('unexpected target SQL');
      },
      release() {
        // The real pool releases the connection; no state mutation is needed here.
      },
    };
  }
}

class FixtureBlobStore implements BlobStore {
  readonly objects = new Map<string, Uint8Array>();
  putCalls = 0;
  onPut?: () => void;

  constructor(private readonly prefix = 'sealed') {}

  async put(bytes: Uint8Array): Promise<StoredBlob> {
    this.putCalls += 1;
    this.onPut?.();
    const key = `${this.prefix}/${'b'.repeat(48 - String(this.putCalls).length)}${this.putCalls}`;
    const stored = new Uint8Array(bytes);
    this.objects.set(key, stored);
    return { key, digest: await digestBytes(stored), size: stored.byteLength };
  }

  async get(key: string): Promise<Uint8Array> {
    const value = this.objects.get(key);
    if (!value) throw new Error('object missing');
    return new Uint8Array(value);
  }

  async remove(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

function stateFixture(revision: number): RegistryState {
  const state = defaultRegistryState({
    production: true,
    allowUnscanned: false,
    policyRevision: 'hosted-target-policy',
  });
  if (revision > 0) {
    state.skills.push({
      id: 'hosted-target-skill',
      organizationId: ORGANIZATION,
      name: '@rehearsal/target',
      skillName: 'target',
      version: '1.0.0',
      description: 'target seed fixture',
      artifact: {
        key: `sealed/${'a'.repeat(48)}`,
        digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        size: BYTES.byteLength,
      },
      state: 'revoked',
      policyRevision: state.policy.revision,
      createdAt: '2026-01-01T00:00:00.000Z',
      provenance: { kind: 'native' },
      fileCount: 1,
      scanIds: [],
    });
  }
  (state as RegistryState & { metadataRevision?: number }).metadataRevision = revision;
  return state;
}

async function makeBackup(root: string, revision: number): Promise<{ directory: string; state: RegistryState; source: FixtureBlobStore }> {
  const state = stateFixture(revision);
  const source = new FixtureBlobStore();
  if (revision > 0) {
    const digest = await digestBytes(BYTES);
    state.skills[0]!.artifact.digest = digest;
    source.objects.set(state.skills[0]!.artifact.key, new Uint8Array(BYTES));
  }
  const sourceRepository = {
    async read() { return cloneRegistryState(state); },
    async transaction<T>(): Promise<T> { throw new Error('source fixture is read-only'); },
  };
  const directory = join(root, `backup-${revision}`);
  await createLogicalBackup({
    sourceRepository,
    sourceBlobs: source,
    organizationId: ORGANIZATION,
    sourceIdentity: SOURCE_IDENTITY,
    sourceLocation: SOURCE_LOCATION,
    backupDirectory: directory,
    captureConsistency: 'offline-filesystem',
    deletionFence: FENCE,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  });
  return { directory, state, source };
}

describe('PostgreSQL isolated restore target', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it.each([0, 7])('seeds an empty target with exact revision %s', async (revision) => {
    const pool = new TargetPgFixture();
    const target = createPostgresRestoreTarget(pool);
    await target.targetSeed.seed(ORGANIZATION, stateFixture(revision));
    const restored = await target.repository.read(ORGANIZATION);
    expect((restored as RegistryState & { metadataRevision?: number }).metadataRevision).toBe(revision);
    expect(restored.policy.revision).toBe('hosted-target-policy');
    expect(pool.commits).toBe(2);
  });

  it('restores metadata, revocation, policy, object bytes, and revision through the target adapter', async () => {
    root = await mkdtemp(join(tmpdir(), 'private-skills-postgres-target-'));
    const backup = await makeBackup(root, 7);
    const pool = new TargetPgFixture();
    const targetBlobRoot = join(root, 'target-privatefs');
    await mkdir(targetBlobRoot, { recursive: true, mode: 0o700 });
    const targetBlobs = await createNodeFilesSdkBlobStore({
      provider: 'fs',
      root: targetBlobRoot,
      prefix: 'target',
    });
    const result = await restorePostgresLogicalBackup({
      targetPool: pool,
      targetBlobs,
      organizationId: ORGANIZATION,
      targetIdentity: TARGET_IDENTITY,
      targetLocation: TARGET_LOCATION,
      backupDirectory: backup.directory,
      targetIsolated: true,
    });
    expect(result).toMatchObject({ metadataRevision: 7, objectCount: 1, remappedObjectCount: 1 });
    const row = pool.getRow(ORGANIZATION)!;
    expect(row.revision).toBe(7);
    const restored = row.state as RegistryState;
    expect(restored.policy).toEqual(backup.state.policy);
    expect(restored.skills[0]).toMatchObject({ state: 'revoked', policyRevision: 'hosted-target-policy' });
    const object = restored.skills[0]!.artifact;
    await expect(targetBlobs.get(object.key)).resolves.toEqual(BYTES);
    expect(await digestBytes(await targetBlobs.get(object.key))).toBe(backup.state.skills[0]!.artifact.digest);
  });

  it('rejects an occupied organization before any target blob write', async () => {
    root = await mkdtemp(join(tmpdir(), 'private-skills-postgres-target-occupied-'));
    const backup = await makeBackup(root, 7);
    const pool = new TargetPgFixture();
    const occupied = stateFixture(2);
    pool.setRow({ organization_id: ORGANIZATION, revision: 2, state: occupied });
    const targetBlobs = new FixtureBlobStore('sealed-target');
    await expect(restorePostgresLogicalBackup({
      targetPool: pool,
      targetBlobs,
      organizationId: ORGANIZATION,
      targetIdentity: TARGET_IDENTITY,
      targetLocation: TARGET_LOCATION,
      backupDirectory: backup.directory,
      targetIsolated: true,
    })).rejects.toMatchObject({ code: 'TARGET_NOT_EMPTY' });
    expect(targetBlobs.putCalls).toBe(0);
    expect(pool.getRow(ORGANIZATION)).toEqual({ organization_id: ORGANIZATION, revision: 2, state: occupied });
  });

  it('does not overwrite another organization while seeding the requested tenant', async () => {
    root = await mkdtemp(join(tmpdir(), 'private-skills-postgres-target-other-org-'));
    const backup = await makeBackup(root, 7);
    const pool = new TargetPgFixture();
    const other = stateFixture(4);
    other.skills[0]!.organizationId = OTHER_ORGANIZATION;
    pool.setRow({ organization_id: OTHER_ORGANIZATION, revision: 4, state: other });
    await restorePostgresLogicalBackup({
      targetPool: pool,
      targetBlobs: new FixtureBlobStore('sealed-target'),
      organizationId: ORGANIZATION,
      targetIdentity: TARGET_IDENTITY,
      targetLocation: TARGET_LOCATION,
      backupDirectory: backup.directory,
      targetIsolated: true,
    });
    expect(pool.getRow(OTHER_ORGANIZATION)).toEqual({ organization_id: OTHER_ORGANIZATION, revision: 4, state: other });
  });

  it('rechecks target occupation after preflight and rolls back without overwriting a race', async () => {
    root = await mkdtemp(join(tmpdir(), 'private-skills-postgres-target-race-'));
    const backup = await makeBackup(root, 7);
    const pool = new TargetPgFixture();
    const occupied = stateFixture(3);
    pool.setRow({
      organization_id: ORGANIZATION,
      revision: 0,
      state: defaultRegistryState({ production: false, allowUnscanned: true }),
    });
    const targetBlobs = new FixtureBlobStore('sealed-target');
    targetBlobs.onPut = () => pool.setRow({ organization_id: ORGANIZATION, revision: 3, state: occupied });
    await expect(restorePostgresLogicalBackup({
      targetPool: pool,
      targetBlobs,
      organizationId: ORGANIZATION,
      targetIdentity: TARGET_IDENTITY,
      targetLocation: TARGET_LOCATION,
      backupDirectory: backup.directory,
      targetIsolated: true,
    })).rejects.toMatchObject({ code: 'TARGET_NOT_EMPTY' });
    expect(pool.getRow(ORGANIZATION)).toEqual({ organization_id: ORGANIZATION, revision: 3, state: occupied });
    expect(pool.rollbacks).toBe(1);
  });

  it('rolls back malformed and post-update target state without committing metadata', async () => {
    const pool = new TargetPgFixture();
    const malformed = { schemaVersion: 1 };
    pool.setRow({ organization_id: ORGANIZATION, revision: 0, state: malformed });
    const seed = createPostgresStateSeed(pool);
    await expect(seed.seed(ORGANIZATION, stateFixture(7))).rejects.toMatchObject({ code: 'SNAPSHOT_INVALID' });
    expect(pool.commits).toBe(0);
    expect(pool.rollbacks).toBe(1);
    expect(pool.getRow(ORGANIZATION)).toEqual({ organization_id: ORGANIZATION, revision: 0, state: malformed });

    const second = new TargetPgFixture();
    second.corruptUpdate = true;
    await expect(createPostgresStateSeed(second).seed(ORGANIZATION, stateFixture(7)))
      .rejects.toMatchObject({ code: 'SNAPSHOT_INVALID' });
    expect(second.commits).toBe(0);
    expect(second.rollbacks).toBe(1);
    expect(second.getRow(ORGANIZATION)).toBeUndefined();
  });

  it('rejects an exact source URL in the restore CLI before constructing a target client', async () => {
    await expect(main([
      'restore',
      '--target-isolated', 'true',
      '--backup', '/private/tmp/does-not-matter',
      '--target-id', TARGET_IDENTITY,
      '--target-database-url', 'postgres://same-target',
    ], {
      PSKILLS_ORGANIZATION_ID: ORGANIZATION,
      DATABASE_URL: 'postgres://same-target',
      PSKILLS_TARGET_DATABASE_URL: undefined,
    })).rejects.toMatchObject({ code: 'TARGET_NOT_ISOLATED' });
  });

  it('requires the explicit isolated-target attestation in the CLI', async () => {
    await expect(main([
      'restore',
      '--backup', '/private/tmp/does-not-matter',
      '--target-id', TARGET_IDENTITY,
      '--target-database-url', 'postgres://isolated-target',
    ], { PSKILLS_ORGANIZATION_ID: ORGANIZATION }))
      .rejects.toMatchObject({ code: 'TARGET_NOT_ISOLATED' });
  });

  it('uses sanitized target errors without including database URLs', async () => {
    const error = new PostgresSnapshotError('TARGET_NOT_ISOLATED', 'target database must not equal the source database URL');
    expect(error.message).not.toContain('postgres://');
  });
});
