import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import type { PgClientLike, PgPoolLike, PgQueryResult } from '../../database/src/postgres';
import { PostgresSemanticIndex } from '../src/index';

const connectionString = process.env.PSKILLS_TEST_PGVECTOR_URL;
const integration = connectionString ? describe : describe.skip;

const profile = { id: 'integration-v1', model: 'integration-model', dimensions: 3 } as const;
const alternateProfile = { id: 'integration-v2', model: 'integration-model-v2', dimensions: 2 } as const;
const timestamp = '2026-09-09T00:00:00.000Z';

function digest(letter: string): `sha256:${string}` {
  return `sha256:${letter.repeat(64).slice(0, 64)}`;
}

function makeDocument(
  organizationId: string,
  resourceId: string,
  profileId: string,
  vector: number[],
  artifact: string,
  content: string,
) {
  return {
    organizationId,
    resourceId,
    artifactDigest: digest(artifact),
    contentDigest: digest(content),
    text: `${resourceId} approved integration content`,
    vector,
    profileId,
    indexedAt: timestamp,
  };
}

/** Adapt postgres.js 3.4.9 to the repository's small pool/client contract. */
function poolFor(sql: ReturnType<typeof postgres>): PgPoolLike {
  const query = async <Row = Record<string, unknown>>(text: string, parameters?: readonly unknown[]): Promise<PgQueryResult<Row>> => ({
    rows: await sql.unsafe<Row[]>(text, parameters ? [...parameters] as never[] : []),
  });
  return {
    query,
    async connect(): Promise<PgClientLike> {
      const reserved = await sql.reserve();
      return {
        query: async <Row = Record<string, unknown>>(text: string, parameters?: readonly unknown[]): Promise<PgQueryResult<Row>> => ({
          rows: await reserved.unsafe<Row[]>(text, parameters ? [...parameters] as never[] : []),
        }),
        release: () => reserved.release(),
      };
    },
  };
}

integration('PostgresSemanticIndex with real pgvector', () => {
  if (!connectionString) return;
  const sql = postgres(connectionString, { max: 2, connect_timeout: 5, onnotice: () => undefined });
  const index = new PostgresSemanticIndex({
    pool: poolFor(sql),
    profiles: [profile, alternateProfile],
    tableName: 'private_skills_semantic_index_it',
    autoMigrate: true,
  });

  afterAll(async () => {
    try {
      await sql.unsafe('DROP TABLE IF EXISTS "private_skills_semantic_index_it"');
    }
    finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('migrates, writes, scopes exact search by organization/allowlist/profile, and revokes', async () => {
    await index.upsert([
      makeDocument('org-a', 'r1', profile.id, [1, 0, 0], 'a', 'b'),
      makeDocument('org-a', 'r2', profile.id, [0, 1, 0], 'c', 'd'),
      makeDocument('org-b', 'r1', profile.id, [1, 0, 0], 'e', 'f'),
      makeDocument('org-a', 'r1', alternateProfile.id, [1, 0], '1', '2'),
    ]);

    await expect(index.health()).resolves.toMatchObject({ status: 'ok', provider: 'postgres-pgvector' });
    await expect(index.search({
      organizationId: 'org-a',
      allowedResourceIds: ['r1', 'r2'],
      profileId: profile.id,
      vector: [1, 0, 0],
      limit: 10,
    })).resolves.toEqual([
      { resourceId: 'r1', artifactDigest: digest('a'), contentDigest: digest('b'), score: 1 },
      { resourceId: 'r2', artifactDigest: digest('c'), contentDigest: digest('d'), score: 0 },
    ]);

    await expect(index.search({
      organizationId: 'org-a',
      allowedResourceIds: ['r1'],
      profileId: alternateProfile.id,
      vector: [1, 0],
      limit: 10,
    })).resolves.toEqual([
      { resourceId: 'r1', artifactDigest: digest('1'), contentDigest: digest('2'), score: 1 },
    ]);

    await index.remove('org-a', ['r1']);
    await expect(index.search({
      organizationId: 'org-a',
      allowedResourceIds: ['r1', 'r2'],
      profileId: profile.id,
      vector: [1, 0, 0],
      limit: 10,
    })).resolves.toEqual([
      { resourceId: 'r2', artifactDigest: digest('c'), contentDigest: digest('d'), score: 0 },
    ]);
    await expect(index.search({
      organizationId: 'org-a',
      allowedResourceIds: ['r1'],
      profileId: alternateProfile.id,
      vector: [1, 0],
      limit: 10,
    })).resolves.toEqual([]);
  });
});
