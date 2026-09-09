import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  BlobStore,
  RegistryState,
  SkillVersion,
  StoredBlob,
} from '../packages/contracts/src/index.js';
import {
  defaultRegistryState,
  type PgClientLike,
  type PgPoolLike,
} from '../packages/database/src/index.js';
import { digestBytes } from '../packages/storage/src/index.js';
import {
  createPostgresLogicalBackup,
  readPostgresOrganizationSnapshot,
  PostgresSnapshotError,
} from '../scripts/restore-backup-postgres.js';
import { readLogicalBackup } from '../scripts/restore-backup.js';

const ORGANIZATION = 'postgres-rehearsal-org';
const STATE_TABLE = 'private_skills_registry_state';
const SOURCE_IDENTITY = 'neon-source-rehearsal';
const BYTES = new TextEncoder().encode('postgres snapshot exact bytes');

interface QueryRecord {
  text: string;
  parameters: readonly unknown[];
}

interface MockPool {
  pool: PgPoolLike;
  queries: QueryRecord[];
  releases: number;
}

function mockPool(rows: Record<string, unknown>[]): MockPool {
  const queries: QueryRecord[] = [];
  const state = { releases: 0 };
  const client: PgClientLike = {
    async query<Row = Record<string, unknown>>(text: string, parameters: readonly unknown[] = []) {
      queries.push({ text, parameters });
      if (/^SELECT organization_id, revision, state /u.test(text)) {
        return { rows: rows as Row[], rowCount: rows.length };
      }
      return { rows: [] as Row[], rowCount: 0 };
    },
    release() {
      state.releases += 1;
    },
  };
  return {
    pool: {
      async query() {
        throw new Error('snapshot adapter must not use the pool query path');
      },
      async connect() {
        return client;
      },
    },
    queries,
    get releases() {
      return state.releases;
    },
  };
}

async function stateFixture(revision = 7): Promise<{ state: RegistryState; stored: StoredBlob }> {
  const digest = await digestBytes(BYTES);
  const stored: StoredBlob = {
    key: `sealed/${'a'.repeat(48)}`,
    digest,
    size: BYTES.byteLength,
  };
  const state = defaultRegistryState({
    production: false,
    allowUnscanned: true,
    policyRevision: 'postgres-rehearsal-policy',
  });
  const skill: SkillVersion = {
    id: 'postgres-rehearsal-skill',
    organizationId: ORGANIZATION,
    name: '@rehearsal/postgres',
    skillName: 'postgres',
    version: '1.0.0',
    description: 'PostgreSQL snapshot fixture',
    artifact: stored,
    state: 'revoked',
    policyRevision: state.policy.revision,
    createdAt: '2026-01-01T00:00:00.000Z',
    provenance: { kind: 'native' },
    fileCount: 1,
    scanIds: [],
  };
  state.skills.push(skill);
  (state as RegistryState & { metadataRevision?: number }).metadataRevision = revision;
  return { state, stored };
}

function blobStore(bytes: Uint8Array, calls: string[], fail = false): BlobStore {
  return {
    async put() {
      throw new Error('snapshot source must not upload');
    },
    async get(key) {
      calls.push(key);
      if (fail) throw new Error('source object disappeared during capture');
      return new Uint8Array(bytes);
    },
    async remove() {
      throw new Error('snapshot source must not delete');
    },
  };
}

describe('PostgreSQL logical backup source adapter', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it('reads one organization row in a read-only MVCC transaction without migration or ensureRow', async () => {
    const fixture = await stateFixture();
    const mock = mockPool([{
      organization_id: ORGANIZATION,
      revision: '7',
      state: fixture.state,
    }]);
    const snapshot = await readPostgresOrganizationSnapshot(mock.pool, {
      organizationId: ORGANIZATION,
      tableName: STATE_TABLE,
    });
    expect(snapshot).toMatchObject({
      organizationId: ORGANIZATION,
      revision: 7,
      state: { metadataRevision: 7 },
    });
    expect(mock.queries.map(({ text }) => text)).toEqual([
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      `SELECT organization_id, revision, state FROM "${STATE_TABLE}" WHERE organization_id = $1`,
      'COMMIT',
    ]);
    expect(mock.queries[1]?.parameters).toEqual([ORGANIZATION]);
    expect(mock.releases).toBe(1);
  });

  it('captures only exact referenced objects and preserves the database revision in the manifest', async () => {
    root = await mkdtemp(join(tmpdir(), 'private-skills-postgres-backup-'));
    const fixture = await stateFixture(7);
    const mock = mockPool([{
      organization_id: ORGANIZATION,
      revision: BigInt(7),
      state: JSON.stringify(fixture.state),
    }]);
    const calls: string[] = [];
    const result = await createPostgresLogicalBackup({
      pool: mock.pool,
      sourceBlobs: blobStore(BYTES, calls),
      organizationId: ORGANIZATION,
      sourceIdentity: SOURCE_IDENTITY,
      backupDirectory: join(root, 'backup'),
      sourceLocation: { kind: 'composite', identity: SOURCE_IDENTITY },
      deletionFence: {
        scope: 'hosted',
        kind: 'provider-snapshot',
        evidenceRef: 'mock-read-only-capture',
        observedAt: '2026-01-01T00:00:00.000Z',
      },
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(result.manifest).toMatchObject({
      captureConsistency: 'postgres-mvcc-snapshot',
      metadataRevision: 7,
      organizationId: ORGANIZATION,
      sourceIdentity: SOURCE_IDENTITY,
    });
    expect(result.manifest.objects).toHaveLength(1);
    expect(calls).toEqual([fixture.stored.key]);
    await expect(readLogicalBackup(join(root, 'backup'))).resolves.toMatchObject({
      metadataRevision: 7,
      objects: [{ key: fixture.stored.key, digest: fixture.stored.digest, size: BYTES.byteLength }],
    });
    expect(mock.queries.map(({ text }) => text)).not.toContain(expect.stringMatching(/^INSERT /u));
  });

  it('rolls back and leaves no backup directory when the organization row is missing', async () => {
    root = await mkdtemp(join(tmpdir(), 'private-skills-postgres-backup-missing-'));
    const mock = mockPool([]);
    await expect(readPostgresOrganizationSnapshot(mock.pool, { organizationId: ORGANIZATION }))
      .rejects.toMatchObject({ code: 'SNAPSHOT_MISSING' });
    expect(mock.queries.map(({ text }) => text)).toEqual([
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      `SELECT organization_id, revision, state FROM "${STATE_TABLE}" WHERE organization_id = $1`,
      'ROLLBACK',
    ]);
    await expect(stat(join(root, 'backup'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects cross-organization, mismatched-revision, and malformed source rows', async () => {
    const fixture = await stateFixture();
    const wrongOrganization = mockPool([{
      organization_id: 'another-org',
      revision: 7,
      state: fixture.state,
    }]);
    await expect(readPostgresOrganizationSnapshot(wrongOrganization.pool, { organizationId: ORGANIZATION }))
      .rejects.toMatchObject({ code: 'SNAPSHOT_INVALID' });

    const wrongRevisionState = { ...fixture.state, metadataRevision: 6 };
    const wrongRevision = mockPool([{
      organization_id: ORGANIZATION,
      revision: 7,
      state: wrongRevisionState,
    }]);
    await expect(readPostgresOrganizationSnapshot(wrongRevision.pool, { organizationId: ORGANIZATION }))
      .rejects.toMatchObject({ code: 'SNAPSHOT_INVALID' });

    const malformed = mockPool([{
      organization_id: ORGANIZATION,
      revision: 7,
      state: { schemaVersion: 1 },
    }]);
    await expect(readPostgresOrganizationSnapshot(malformed.pool, { organizationId: ORGANIZATION }))
      .rejects.toMatchObject({ code: 'SNAPSHOT_INVALID' });
  });

  it('does not write a final manifest after an object disappears or exceeds the aggregate budget', async () => {
    root = await mkdtemp(join(tmpdir(), 'private-skills-postgres-backup-failure-'));
    const fixture = await stateFixture();
    const sourceRow = {
      organization_id: ORGANIZATION,
      revision: 7,
      state: fixture.state,
    };
    const missingCalls: string[] = [];
    await expect(createPostgresLogicalBackup({
      pool: mockPool([sourceRow]).pool,
      sourceBlobs: blobStore(BYTES, missingCalls, true),
      organizationId: ORGANIZATION,
      sourceIdentity: SOURCE_IDENTITY,
      backupDirectory: join(root, 'missing'),
      deletionFence: {
        scope: 'hosted',
        kind: 'provider-snapshot',
        evidenceRef: 'mock-read-only-capture',
        observedAt: '2026-01-01T00:00:00.000Z',
      },
    })).rejects.toMatchObject({ code: 'OBJECT_MISSING' });
    expect(missingCalls).toEqual([fixture.stored.key]);
    await expect(stat(join(root, 'missing', 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' });

    const budgetCalls: string[] = [];
    await expect(createPostgresLogicalBackup({
      pool: mockPool([sourceRow]).pool,
      sourceBlobs: blobStore(BYTES, budgetCalls),
      organizationId: ORGANIZATION,
      sourceIdentity: SOURCE_IDENTITY,
      backupDirectory: join(root, 'budget'),
      maxTotalObjectBytes: BYTES.byteLength - 1,
      deletionFence: {
        scope: 'hosted',
        kind: 'provider-snapshot',
        evidenceRef: 'mock-read-only-capture',
        observedAt: '2026-01-01T00:00:00.000Z',
      },
    })).rejects.toMatchObject({ code: 'SIZE_LIMIT' });
    expect(budgetCalls).toEqual([]);
    await expect(stat(join(root, 'budget', 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readdir(join(root, 'budget'))).resolves.toEqual([]);
  });

  it('requires explicit availability evidence for the current manifest format', async () => {
    const fixture = await stateFixture();
    const error = await createPostgresLogicalBackup({
      pool: mockPool([{
        organization_id: ORGANIZATION,
        revision: 7,
        state: fixture.state,
      }]).pool,
      sourceBlobs: blobStore(BYTES, []),
      organizationId: ORGANIZATION,
      sourceIdentity: SOURCE_IDENTITY,
      backupDirectory: '/private/tmp/uncreated-postgres-backup',
      deletionFence: undefined as never,
    }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(PostgresSnapshotError);
    expect(error).toMatchObject({ code: 'FENCE_REQUIRED' });
  });
});
