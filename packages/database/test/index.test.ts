import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConcurrentStateUpdateError,
  FileStateRepository,
  HttpRepositoryServer,
  HttpStateRepository,
  MemoryStateRepository,
  PostgresStateRepository,
  StateRepositoryError,
  UnsupportedTransportError,
  defaultRegistryState,
  validateAndCloneState,
} from '../src/index.js';
import type { PgPoolLike } from '../src/index.js';

function audit(id: string, organizationId: string) {
  return {
    id,
    organizationId,
    subject: 'test',
    action: 'test',
    createdAt: new Date().toISOString(),
  };
}

function revision(state: { metadataRevision?: number }): number {
  return state.metadataRevision ?? 0;
}

describe('state repositories', () => {
  it('starts with three production scanner policies and fails closed', () => {
    const state = defaultRegistryState();
    expect(state.policy.scanners).toHaveLength(3);
    expect(state.policy.allowUnscanned).toBe(false);
    expect(defaultRegistryState({ production: false, allowUnscanned: true }).policy.allowUnscanned).toBe(true);
  });

  it('preserves bounded tenant review dispatch state through clone and validation', async () => {
    const state = defaultRegistryState();
    state.tenantReviewDispatches = [{
      operationKey: 'common-skill-review:2026-09-16',
      state: 'completed',
      leaseExpiresAt: '2026-09-16T00:15:00.000Z',
      sessionId: 'eve-session',
      updatedAt: '2026-09-16T00:01:00.000Z',
      completedAt: '2026-09-16T00:01:00.000Z',
    }];
    state.tenantReviewDispatchCursor = {
      day: '2026-09-16',
      pendingOrganizationIds: ['globex'],
      completedOrganizationIds: ['acme'],
      updatedAt: '2026-09-16T00:01:00.000Z',
    };
    expect(validateAndCloneState(state)).toEqual(state);
    const repository = new MemoryStateRepository({ initial: { acme: state } });
    const read = await repository.read('acme');
    expect(read.tenantReviewDispatches).toEqual(state.tenantReviewDispatches);
    expect(read.tenantReviewDispatchCursor).toEqual(state.tenantReviewDispatchCursor);
    await expect(repository.transaction('acme', (mutable) => {
      mutable.tenantReviewDispatchCursor!.pendingOrganizationIds.push('other');
    })).resolves.toBeUndefined();
  });

  it('isolates organizations and rolls back failed transactions', async () => {
    const repository = new MemoryStateRepository();
    await repository.transaction('org-a', (state) => { state.audit.push(audit('a', 'org-a')); });
    await repository.transaction('org-b', (state) => { state.audit.push(audit('b', 'org-b')); });
    expect((await repository.read('org-a')).audit.map((event) => event.id)).toEqual(['a']);
    expect((await repository.read('org-b')).audit.map((event) => event.id)).toEqual(['b']);

    await expect(repository.transaction('org-a', (state) => {
      state.audit.push(audit('rollback', 'org-a'));
      throw new Error('deliberate test failure');
    })).rejects.toThrow('deliberate test failure');
    expect((await repository.read('org-a')).audit.map((event) => event.id)).toEqual(['a']);
  });

  it('serializes concurrent organization updates and advances the durable revision', async () => {
    const repository = new MemoryStateRepository();
    await Promise.all(Array.from({ length: 24 }, (_, index) => repository.transaction('org', (state) => {
      state.audit.push(audit(String(index), 'org'));
    })));
    const state = await repository.read('org');
    expect(state.audit).toHaveLength(24);
    expect(revision(state)).toBe(24);
  });

  it('reloads atomic file state and does not commit failed writes', async () => {
    const directory = await mkdtemp(join(tmpdir(), `private-skills-${crypto.randomUUID()}-`));
    try {
      const first = new FileStateRepository(directory);
      await first.transaction('org/file', (state) => { state.audit.push(audit('one', 'org/file')); });

      const second = new FileStateRepository(directory);
      expect((await second.read('org/file')).audit.map((event) => event.id)).toEqual(['one']);
      await expect(second.transaction('org/file', (state) => {
        state.audit.push(audit('bad', 'org/file'));
        throw new Error('deliberate file failure');
      })).rejects.toThrow('deliberate file failure');
      const reloaded = await second.read('org/file');
      expect(reloaded.audit.map((event) => event.id)).toEqual(['one']);
      expect(revision(reloaded)).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('uses persisted CAS revisions across handlers and rejects stale replacement', async () => {
    const repository = new MemoryStateRepository();
    const firstServer = new HttpRepositoryServer({ repository });
    const secondServer = new HttpRepositoryServer({ repository });
    const fetchFor = (server: HttpRepositoryServer): typeof fetch =>
      (async (input: RequestInfo | URL, init?: RequestInit) =>
        server.handle(new Request(String(input), init))) as typeof fetch;
    const first = new HttpStateRepository({ baseUrl: 'https://state.invalid', fetch: fetchFor(firstServer) });
    const second = new HttpStateRepository({ baseUrl: 'https://state.invalid', fetch: fetchFor(secondServer) });

    await first.transaction('org', (state) => { state.audit.push(audit('one', 'org')); });
    const stale = await first.read('org');
    await repository.transaction('org', (state) => { state.audit.push(audit('direct', 'org')); });
    await second.transaction('org', (state) => { state.audit.push(audit('two', 'org')); });
    expect((await repository.read('org')).audit.map((event) => event.id)).toEqual(['one', 'direct', 'two']);

    const staleResponse = await secondServer.handle(new Request(
      'https://state.invalid/v1/internal/state/transaction/org',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ protocolVersion: 1, expectedVersion: revision(stale), state: stale }),
      },
    ));
    expect(staleResponse.status).toBe(409);
    expect(revision(await repository.read('org'))).toBe(3);
  });

  it('reports an HTTP transport that has no repository protocol instead of using memory', async () => {
    const unsupported = new HttpStateRepository({
      baseUrl: 'https://state.invalid',
      fetch: (async () => new Response('not supported', { status: 501 })) as typeof fetch,
    });
    await expect(unsupported.read('org')).rejects.toBeInstanceOf(UnsupportedTransportError);
  });

  it.skipIf(!process.env.DATABASE_URL)('serializes real PostgreSQL transactions when DATABASE_URL is configured', async () => {
    const postgres = (await import('postgres')).default;
    const sql = postgres(process.env.DATABASE_URL!, { max: 4, prepare: false });
    const tableName = `private_skills_test_${crypto.randomUUID().replaceAll('-', '')}`;
    const query = async (connection: typeof sql, text: string, parameters: readonly unknown[] = []) => {
      const result = await connection.unsafe(text, [...parameters] as never[]);
      return { rows: [...result], rowCount: result.count };
    };
    const pool = {
      query: (text: string, parameters?: readonly unknown[]) => query(sql, text, parameters),
      connect: async () => {
        const connection = await sql.reserve();
        return {
          query: (text: string, parameters?: readonly unknown[]) => query(connection as unknown as typeof sql, text, parameters),
          release: () => connection.release(),
        };
      },
    } as PgPoolLike;
    try {
      const repository = new PostgresStateRepository(pool, { tableName, autoMigrate: true });
      await Promise.all(Array.from({ length: 8 }, (_, index) => repository.transaction('org', (state) => {
        state.audit.push(audit(String(index), 'org'));
      })));
      const state = await repository.read('org');
      expect(state.audit).toHaveLength(8);
      expect(revision(state)).toBe(8);
    } finally {
      await sql.unsafe(`DROP TABLE "${tableName}"`);
      await sql.end({ timeout: 1 });
    }
  }, 30_000);

  it('exposes conflict errors as repository errors', () => {
    expect(new ConcurrentStateUpdateError().code).toBe('VERSION_CONFLICT');
    expect(new StateRepositoryError('TEST', 'test').code).toBe('TEST');
  });
});
