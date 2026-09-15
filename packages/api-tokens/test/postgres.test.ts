import { describe, expect, it } from 'vitest';
import {
  API_TOKEN_SCHEMA_SQL,
  PostgresApiTokenRepository,
  postgresApiTokenSchemaSql,
  type ApiTokenPgPool,
  type ApiTokenRecord,
} from '../src/index.js';

const record: ApiTokenRecord = {
  id: 'st_one',
  organizationId: 'tenant-a',
  userId: 'alice',
  name: 'CLI',
  tokenHash: 'sha256:' + 'a'.repeat(64),
  roleCeiling: 'reader',
  scopes: ['skills:read'],
  expiresAt: '2026-09-15T11:00:00.000Z',
  createdAt: '2026-09-15T10:00:00.000Z',
};

class PoolFixture implements ApiTokenPgPool {
  readonly calls: Array<{ text: string; parameters?: readonly unknown[] }> = [];
  row: Record<string, unknown> | undefined;

  async query<Row = Record<string, unknown>>(text: string, parameters?: readonly unknown[]) {
    this.calls.push({ text, parameters });
    if (text.startsWith('SELECT') || text.startsWith('UPDATE')) {
      if (parameters?.includes('tenant-b')) return { rows: [] as Row[] };
      return { rows: this.row === undefined ? [] : [this.row as Row] };
    }
    return { rows: [] as Row[] };
  }

  async connect() {
    return {
      query: this.query.bind(this),
      release: () => undefined,
    };
  }
}

function dbRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: record.id,
    organization_id: record.organizationId,
    user_id: record.userId,
    name: record.name,
    token_hash: record.tokenHash,
    role_ceiling: record.roleCeiling,
    scopes: record.scopes,
    expires_at: new Date(record.expiresAt),
    created_at: new Date(record.createdAt),
    revoked_at: null,
    ...overrides,
  };
}

describe('PostgreSQL API token repository', () => {
  it('exports a migration-safe service token schema with a collision-resistant prefix', () => {
    expect(API_TOKEN_SCHEMA_SQL).toContain('private_skills_service_tokens');
    expect(API_TOKEN_SCHEMA_SQL).toContain('token_hash text NOT NULL UNIQUE');
    expect(API_TOKEN_SCHEMA_SQL).toContain('organization_id text NOT NULL');
    expect(API_TOKEN_SCHEMA_SQL).toContain('role_ceiling');
    expect(postgresApiTokenSchemaSql('identity_service_tokens')).toContain('"identity_service_tokens"');
    expect(() => postgresApiTokenSchemaSql('bad-name')).toThrow();
  });

  it('writes and reads tenant-scoped records without exposing raw token material', async () => {
    const pool = new PoolFixture();
    const repository = new PostgresApiTokenRepository(pool);
    await repository.create(record);
    expect(pool.calls[0]!.text).toContain('organization_id');
    expect(pool.calls[0]!.parameters).toContain(record.tokenHash);

    pool.row = dbRow();
    expect(await repository.findByHash(record.tokenHash)).toEqual(record);
    expect(await repository.findById('tenant-a', 'st_one')).toEqual(record);
    expect(await repository.findById('tenant-b', 'st_one')).toBeNull();
    expect(await repository.list('tenant-a', { subject: 'alice', limit: 10 })).toEqual([record]);
    // The repository's internal record necessarily carries the hash for
    // authentication; the service/HTTP metadata projection is what omits it.
    expect((await repository.list('tenant-a'))[0]!.tokenHash).toBe(record.tokenHash);
  });

  it('maps revocation idempotently and supports opt-in schema setup', async () => {
    const pool = new PoolFixture();
    const repository = new PostgresApiTokenRepository(pool, { autoMigrate: true });
    pool.row = dbRow({ revoked_at: new Date('2026-09-15T10:30:00.000Z') });
    const revoked = await repository.revoke('tenant-a', 'st_one', '2026-09-15T10:30:00.000Z');
    expect(revoked?.revokedAt).toBe('2026-09-15T10:30:00.000Z');
    expect(pool.calls[0]!.text).toContain('CREATE TABLE IF NOT EXISTS');
    expect(pool.calls.at(-1)?.text).toContain('COALESCE(revoked_at');
  });
});
