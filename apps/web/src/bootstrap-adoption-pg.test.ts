import { describe, expect, it } from 'vitest';

import type {
  PgClientLike,
  PgPoolLike,
  PgQueryResult,
} from '../../../packages/database/src/postgres.js';
import {
  BOOTSTRAP_ADOPTION_METADATA_KEY,
  createPostgresBootstrapAdoptionStore,
  type BootstrapAdoptionBinding,
} from '../server/bootstrap-adoption.js';

const NOW = new Date('2026-09-15T12:00:00.000Z');

interface UserRow {
  id: string;
  emailVerified: boolean;
}

interface SessionRow {
  id: string;
  userId: string;
  expiresAt: string;
  activeOrganizationId: string | null;
}

interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  metadata: unknown;
}

interface MemberRow {
  id: string;
  organizationId: string;
  userId: string;
  role: string;
  createdAt?: string;
}

interface DatabaseSnapshot {
  users: UserRow[];
  sessions: SessionRow[];
  organizations: OrganizationRow[];
  members: MemberRow[];
}

/** Small transaction-aware fake that executes the adapter's actual SQL shape. */
class FakePostgres implements PgPoolLike {
  readonly queries: string[] = [];
  private committed: DatabaseSnapshot;

  constructor(initial: DatabaseSnapshot) {
    this.committed = clone(initial);
  }

  get state(): DatabaseSnapshot {
    return clone(this.committed);
  }

  async query<Row = Record<string, unknown>>(_text: string, _parameters?: readonly unknown[]): Promise<PgQueryResult<Row>> {
    throw new Error('The adoption adapter must use a transaction client');
  }

  async connect(): Promise<PgClientLike> {
    let working: DatabaseSnapshot | undefined;
    let began = false;
    return {
      query: async <Row = Record<string, unknown>>(text: string, parameters: readonly unknown[] = []) => {
        this.queries.push(text);
        const normalized = text.replace(/\s+/gu, ' ').trim();
        if (normalized === 'BEGIN') {
          if (began) throw new Error('nested transaction');
          working = clone(this.committed);
          began = true;
          return { rows: [] } as PgQueryResult<Row>;
        }
        if (normalized === 'COMMIT') {
          if (!began || !working) throw new Error('commit without transaction');
          this.committed = working;
          working = undefined;
          began = false;
          return { rows: [] } as PgQueryResult<Row>;
        }
        if (normalized === 'ROLLBACK') {
          working = undefined;
          began = false;
          return { rows: [] } as PgQueryResult<Row>;
        }
        if (!began || !working) throw new Error('query outside transaction');
        if (normalized.startsWith('SELECT pg_advisory_xact_lock')) {
          return { rows: [] } as PgQueryResult<Row>;
        }
        if (normalized.startsWith('SELECT "id", "emailVerified" FROM "user"')) {
          const [userId] = parameters;
          return rows<Row>(working.users.filter((user) => user.id === userId));
        }
        if (normalized.startsWith('SELECT "id", "userId", "expiresAt", "activeOrganizationId" FROM "session"')) {
          const [sessionId, userId] = parameters;
          return rows<Row>(working.sessions.filter((session) => session.id === sessionId && session.userId === userId));
        }
        if (normalized.startsWith('SELECT "id", "name", "slug", "metadata" FROM "organization"')) {
          const [organizationId] = parameters;
          return rows<Row>(working.organizations.filter((organization) => organization.id === organizationId));
        }
        if (normalized.startsWith('SELECT "id", "organizationId", "userId", "role" FROM "member"')) {
          const [organizationId] = parameters;
          return rows<Row>(working.members.filter((member) => member.organizationId === organizationId));
        }
        if (normalized.startsWith('INSERT INTO "organization"')) {
          const [id, name, slug, createdAt, metadata] = parameters;
          if (working.organizations.some((organization) => organization.id === id)) {
            throw Object.assign(new Error('duplicate organization'), { code: '23505' });
          }
          working.organizations.push({
            id: stringParameter(id),
            name: stringParameter(name),
            slug: stringParameter(slug),
            metadata,
          });
          return { rows: [], rowCount: 1 } as PgQueryResult<Row>;
        }
        if (normalized.startsWith('INSERT INTO "member"')) {
          const [id, organizationId, userId, createdAt] = parameters;
          if (working.members.some((member) => member.id === id)) {
            throw Object.assign(new Error('duplicate member'), { code: '23505' });
          }
          working.members.push({
            id: stringParameter(id),
            organizationId: stringParameter(organizationId),
            userId: stringParameter(userId),
            role: 'owner',
            createdAt: stringParameter(createdAt),
          });
          return { rows: [], rowCount: 1 } as PgQueryResult<Row>;
        }
        if (normalized.startsWith('UPDATE "member" SET "role"')) {
          const [memberId, organizationId] = parameters;
          const member = working.members.find((candidate) => candidate.id === memberId && candidate.organizationId === organizationId);
          if (!member) return { rows: [], rowCount: 0 } as PgQueryResult<Row>;
          member.role = 'owner';
          return { rows: [], rowCount: 1 } as PgQueryResult<Row>;
        }
        if (normalized.startsWith('UPDATE "organization" SET "metadata"')) {
          const [organizationId, metadata] = parameters;
          const organization = working.organizations.find((candidate) => candidate.id === organizationId);
          if (!organization) return { rows: [], rowCount: 0 } as PgQueryResult<Row>;
          organization.metadata = metadata;
          return { rows: [], rowCount: 1 } as PgQueryResult<Row>;
        }
        if (normalized.startsWith('UPDATE "session" SET "activeOrganizationId"')) {
          const [organizationId, sessionId, userId] = parameters;
          const session = working.sessions.find((candidate) => candidate.id === sessionId && candidate.userId === userId);
          if (!session) return { rows: [], rowCount: 0 } as PgQueryResult<Row>;
          session.activeOrganizationId = stringParameter(organizationId);
          return { rows: [], rowCount: 1 } as PgQueryResult<Row>;
        }
        throw new Error(`Unexpected SQL: ${normalized}`);
      },
      release: () => undefined,
    };
  }
}

function rows<Row>(value: unknown[]): PgQueryResult<Row> {
  return { rows: value as Row[] };
}

function stringParameter(value: unknown): string {
  if (typeof value !== 'string') throw new Error('expected string SQL parameter');
  return value;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function database(): DatabaseSnapshot {
  return {
    users: [
      { id: 'user-1', emailVerified: true },
      { id: 'user-2', emailVerified: true },
      { id: 'unverified', emailVerified: false },
    ],
    sessions: [
      { id: 'session-1', userId: 'user-1', expiresAt: '2026-09-15T13:00:00.000Z', activeOrganizationId: null },
      { id: 'session-2', userId: 'user-2', expiresAt: '2026-09-15T13:00:00.000Z', activeOrganizationId: null },
      { id: 'expired', userId: 'user-1', expiresAt: '2026-09-15T11:59:59.000Z', activeOrganizationId: null },
    ],
    organizations: [],
    members: [],
  };
}

function binding(overrides: Partial<BootstrapAdoptionBinding> = {}): BootstrapAdoptionBinding {
  return {
    organizationId: 'default',
    userId: 'user-1',
    sessionId: 'session-1',
    proofTokenId: 'bootstrap-owner',
    proofSubject: 'operator',
    ...overrides,
  };
}

function storeFor(pool: FakePostgres) {
  return createPostgresBootstrapAdoptionStore(pool, {
    organizationId: 'default',
    organizationName: 'Acme',
    organizationSlug: 'acme',
    now: () => NOW,
    generateId: () => 'member-generated',
  });
}

describe('PostgreSQL Better Auth bootstrap adoption', () => {
  it('binds the verified user, owner membership, marker, and active session in one transaction', async () => {
    const pool = new FakePostgres(database());
    const result = await storeFor(pool).bindOwner(binding());

    expect(result).toEqual({ replayed: false, membershipId: 'member-generated' });
    const state = pool.state;
    expect(state.organizations).toHaveLength(1);
    const marker = JSON.parse(String(state.organizations[0]!.metadata))[BOOTSTRAP_ADOPTION_METADATA_KEY];
    expect(marker).toMatchObject({ version: 1, userId: 'user-1', sessionId: 'session-1', proofTokenId: 'bootstrap-owner', proofSubject: 'operator' });
    expect(state.members).toEqual([expect.objectContaining({ id: 'member-generated', organizationId: 'default', userId: 'user-1', role: 'owner' })]);
    expect(state.sessions[0]?.activeOrganizationId).toBe('default');
    expect(pool.queries.filter((query) => query === 'BEGIN')).toHaveLength(1);
    expect(pool.queries.some((query) => query.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(pool.queries.filter((query) => query === 'COMMIT')).toHaveLength(1);
    expect(pool.queries.filter((query) => query === 'ROLLBACK')).toHaveLength(0);
  });

  it('replays the same binding without creating a second owner or marker', async () => {
    const pool = new FakePostgres(database());
    const store = storeFor(pool);
    await store.bindOwner(binding());
    const replay = await store.bindOwner(binding());

    expect(replay).toEqual({ replayed: true, membershipId: 'member-generated' });
    expect(pool.state.members.filter((member) => member.role === 'owner')).toHaveLength(1);
    expect(pool.state.organizations).toHaveLength(1);
    expect(JSON.parse(String(pool.state.organizations[0]!.metadata))[BOOTSTRAP_ADOPTION_METADATA_KEY].adoptedAt)
      .toBe(NOW.toISOString());
  });

  it('rolls back every identity write when existing membership state is corrupt', async () => {
    const initial = database();
    initial.organizations.push({ id: 'default', name: 'Acme', slug: 'acme', metadata: '{}' });
    initial.members.push({ id: 'member-manager', organizationId: 'default', userId: 'user-1', role: 'manager' });
    const pool = new FakePostgres(initial);

    const promise = storeFor(pool).bindOwner(binding());
    await expect(promise).rejects.toMatchObject({ code: 'BOOTSTRAP_ADOPTION_CONFLICT', status: 409 });
    expect(pool.state).toEqual(initial);
    expect(pool.queries.filter((query) => query === 'ROLLBACK')).toHaveLength(1);
    expect(pool.queries.filter((query) => query === 'COMMIT')).toHaveLength(0);
  });

  it.each([
    { userId: 'unverified', sessionId: 'session-1', status: 403 },
    { userId: 'user-1', sessionId: 'expired', status: 401 },
  ])('requires the verified live user session ($status)', async ({ userId, sessionId, status }) => {
    const pool = new FakePostgres(database());
    await expect(storeFor(pool).bindOwner(binding({ userId, sessionId })))
      .rejects.toMatchObject({ status });
    expect(pool.state.organizations).toHaveLength(0);
    expect(pool.state.members).toHaveLength(0);
  });
});
