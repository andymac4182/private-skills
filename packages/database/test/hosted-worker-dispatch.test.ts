import { describe, expect, it } from 'vitest';
import {
  HostedWorkerDispatchLeaseError,
  HostedWorkerDispatchStore,
  HostedWorkerDispatcher,
  PostgresHostedWorkerDispatchStore,
  hostedWorkerDispatchSchemaSql,
  type HostedWorkerDispatchCatalog,
  type HostedWorkerDispatchLease,
} from '../src/index.js';
import type { PgPoolLike } from '../src/index.js';

const CRON_SECRET = 'dispatcher-test-secret';

interface RetryRecord { attempts: number; nextAttemptAt: number; reason: string }

class MemoryDispatchStore implements HostedWorkerDispatchStore {
  lease?: HostedWorkerDispatchLease;
  cursor: string | null = null;
  readonly retries = new Map<string, RetryRecord>();
  private sequence = 0;

  async acquireLease(now: number, leaseDurationMs: number): Promise<HostedWorkerDispatchLease | null> {
    if (this.lease && this.lease.expiresAt > now) return null;
    const lease = { token: `dispatch-lease-${++this.sequence}`, cursor: this.cursor, expiresAt: now + leaseDurationMs };
    this.lease = lease;
    return { ...lease };
  }

  async advance(lease: HostedWorkerDispatchLease, cursor: string | null, now: number): Promise<void> {
    this.assertOwned(lease, now);
    this.lease!.cursor = cursor;
    this.cursor = cursor;
  }

  async recordSuccess(lease: HostedWorkerDispatchLease, organizationId: string, cursor: string | null, now: number): Promise<void> {
    this.assertOwned(lease, now);
    this.lease!.cursor = cursor;
    this.cursor = cursor;
    this.retries.delete(organizationId);
  }

  async recordFailure(lease: HostedWorkerDispatchLease, organizationId: string, cursor: string | null, reason: string, now: number): Promise<void> {
    this.assertOwned(lease, now);
    this.lease!.cursor = cursor;
    this.cursor = cursor;
    const attempts = Math.min(16, (this.retries.get(organizationId)?.attempts ?? 0) + 1);
    this.retries.set(organizationId, { attempts, nextAttemptAt: now + Math.min(60 * 60_000, 30_000 * (2 ** (attempts - 1))), reason });
  }

  async release(lease: HostedWorkerDispatchLease, cursor: string | null): Promise<void> {
    if (this.lease?.token !== lease.token) return;
    this.lease.cursor = cursor;
    this.cursor = cursor;
    this.lease = undefined;
  }

  async isRetryReady(organizationId: string, now: number): Promise<boolean> {
    return (this.retries.get(organizationId)?.nextAttemptAt ?? 0) <= now;
  }

  expire(): void {
    if (this.lease) this.lease.expiresAt = 0;
  }

  private assertOwned(lease: HostedWorkerDispatchLease, now: number): void {
    if (!this.lease || this.lease.token !== lease.token || this.lease.expiresAt <= now) throw new HostedWorkerDispatchLeaseError();
  }
}

class MemoryCatalog implements HostedWorkerDispatchCatalog {
  readonly listCalls: Array<{ after: string | null; limit: number }> = [];
  readonly pending = new Set<string>();

  constructor(readonly organizations: readonly string[]) {}

  async listOrganizations(input: { after: string | null; limit: number }): Promise<readonly string[]> {
    this.listCalls.push({ after: input.after, limit: input.limit });
    const start = input.after === null ? 0 : this.organizations.indexOf(input.after) + 1;
    return this.organizations.slice(Math.max(0, start), Math.max(0, start) + input.limit);
  }

  async hasPendingJobs(organizationId: string): Promise<boolean> {
    return this.pending.has(organizationId);
  }
}

function request(init: RequestInit = {}): Request {
  return new Request('https://registry.example.test/internal/worker/run', {
    ...init,
    headers: { authorization: `Bearer ${CRON_SECRET}`, ...(init.headers ?? {}) },
  });
}

function workerResponse(claimed: boolean, status = 200): Response {
  return Response.json({ ok: status >= 200 && status < 300, claimed }, { status });
}

describe('hosted worker dispatcher', () => {
  it('authenticates the operator cron before looking up any organization', async () => {
    const store = new MemoryDispatchStore();
    const catalog = new MemoryCatalog(['tenant-a']);
    const dispatcher = new HostedWorkerDispatcher({
      cronSecret: CRON_SECRET,
      store,
      catalog,
      workerForOrganization: () => async () => workerResponse(false),
    });

    expect((await dispatcher.handle(new Request('https://registry.example.test/internal/worker/run'))).status).toBe(401);
    expect((await dispatcher.handle(new Request('https://registry.example.test/internal/worker/run', { method: 'POST', headers: { authorization: `Bearer ${CRON_SECRET}` } }))).status).toBe(405);
    expect(catalog.listCalls).toHaveLength(0);
  });

  it('walks companies with a durable cursor and recovers a failed company after backoff', async () => {
    let now = 1_000_000;
    const store = new MemoryDispatchStore();
    const catalog = new MemoryCatalog(['tenant-a', 'tenant-b']);
    catalog.pending.add('tenant-a');
    catalog.pending.add('tenant-b');
    const calls: string[] = [];
    let failedA = false;
    const dispatcher = new HostedWorkerDispatcher({
      cronSecret: CRON_SECRET,
      store,
      catalog,
      now: () => now,
      maxOrganizations: 2,
      pageSize: 2,
      maxJobsPerOrganization: 1,
      workerForOrganization: (organizationId) => async () => {
        calls.push(organizationId);
        if (!catalog.pending.has(organizationId)) return workerResponse(false);
        if (organizationId === 'tenant-a' && !failedA) {
          failedA = true;
          return workerResponse(false, 503);
        }
        catalog.pending.delete(organizationId);
        return workerResponse(true);
      },
    });

    const first = await dispatcher.handle(request());
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ claimed: true, organizationsVisited: 2, failures: 1, truncated: false });
    expect(calls).toEqual(['tenant-a', 'tenant-b']);
    expect(store.retries.get('tenant-a')?.attempts).toBe(1);

    now += 1;
    const suppressed = await dispatcher.handle(request());
    expect(suppressed.status).toBe(200);
    expect(calls).toEqual(['tenant-a', 'tenant-b']);

    now += 30_000;
    const recovered = await dispatcher.handle(request());
    expect(recovered.status).toBe(200);
    await expect(recovered.json()).resolves.toMatchObject({ claimed: true, failures: 0 });
    expect(calls).toEqual(['tenant-a', 'tenant-b', 'tenant-a']);
    expect(store.retries.has('tenant-a')).toBe(false);
    expect(catalog.listCalls.slice(0, 3).map((call) => call.after)).toEqual([null, 'tenant-b', null]);
    expect(catalog.listCalls.slice(3).some((call) => call.after === null)).toBe(true);
  });

  it('does not use a default worker for a tenant without a server factory', async () => {
    const store = new MemoryDispatchStore();
    const catalog = new MemoryCatalog(['tenant-a', 'tenant-b']);
    catalog.pending.add('tenant-a');
    catalog.pending.add('tenant-b');
    const workerTenants: string[] = [];
    const dispatcher = new HostedWorkerDispatcher({
      cronSecret: CRON_SECRET,
      store,
      catalog,
      workerForOrganization: (organizationId) => organizationId === 'tenant-a'
        ? async () => { workerTenants.push(organizationId); return workerResponse(false); }
        : undefined,
      maxOrganizations: 2,
      pageSize: 2,
    });

    const response = await dispatcher.handle(request({ headers: { 'x-organization-id': 'attacker-selected-tenant' } }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ failures: 1 });
    expect(workerTenants).toEqual(['tenant-a']);
    expect(store.retries.has('tenant-b')).toBe(true);
  });

  it('isolates a tenant credential factory failure and records a retry', async () => {
    const store = new MemoryDispatchStore();
    const catalog = new MemoryCatalog(['tenant-a', 'tenant-b']);
    catalog.pending.add('tenant-a');
    catalog.pending.add('tenant-b');
    const calls: string[] = [];
    const dispatcher = new HostedWorkerDispatcher({
      cronSecret: CRON_SECRET,
      store,
      catalog,
      maxOrganizations: 2,
      pageSize: 2,
      workerForOrganization: (organizationId) => {
        if (organizationId === 'tenant-b') throw new Error('provider credential unavailable');
        return async () => {
          calls.push(organizationId);
          return workerResponse(false);
        };
      },
    });

    const response = await dispatcher.handle(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ failures: 1, organizationsVisited: 2 });
    expect(calls).toEqual(['tenant-a']);
    expect(store.retries.get('tenant-b')).toMatchObject({ attempts: 1, reason: 'tenant_worker_unavailable' });
  });

  it('persists fair progress when the time budget is exhausted', async () => {
    let now = 50_000;
    const store = new MemoryDispatchStore();
    const catalog = new MemoryCatalog(['tenant-a', 'tenant-b']);
    catalog.pending.add('tenant-a');
    catalog.pending.add('tenant-b');
    const dispatcher = new HostedWorkerDispatcher({
      cronSecret: CRON_SECRET,
      store,
      catalog,
      now: () => now,
      maxOrganizations: 2,
      pageSize: 2,
      maxDurationMs: 1_000,
      leaseDurationMs: 2_000,
      workerForOrganization: (organizationId) => async () => {
        catalog.pending.delete(organizationId);
        now += 1_000;
        return workerResponse(false);
      },
    });

    const response = await dispatcher.handle(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ organizationsVisited: 1, truncated: true });
    expect(store.lease).toBeUndefined();
    expect(catalog.listCalls[0]?.after).toBeNull();
    expect(catalog.pending.has('tenant-b')).toBe(true);
  });

  it('bounds a stalled catalog or queue probe and releases a recoverable lease', async () => {
    const store = new MemoryDispatchStore();
    const catalog: HostedWorkerDispatchCatalog = {
      async listOrganizations(input) {
        return input.after === null ? ['tenant-a'] : [];
      },
      async hasPendingJobs(_organizationId, input) {
        return new Promise<boolean>((_resolve, reject) => {
          input.signal?.addEventListener('abort', () => reject(new Error('probe aborted')), { once: true });
        });
      },
    };
    let workerCalled = false;
    const dispatcher = new HostedWorkerDispatcher({
      cronSecret: CRON_SECRET,
      store,
      catalog,
      maxOrganizations: 1,
      pageSize: 1,
      maxDurationMs: 1_000,
      leaseDurationMs: 2_000,
      workerForOrganization: () => async () => {
        workerCalled = true;
        return workerResponse(true);
      },
    });

    const started = Date.now();
    const response = await dispatcher.handle(request());
    const elapsed = Date.now() - started;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ truncated: true, organizationsVisited: 1, failures: 0 });
    expect(elapsed).toBeLessThan(1_500);
    expect(workerCalled).toBe(false);
    expect(store.lease).toBeUndefined();
    expect(store.retries.has('tenant-a')).toBe(false);
  });

  it('passes the dispatch deadline to a stalled organization listing', async () => {
    const store = new MemoryDispatchStore();
    let listCalled = false;
    const catalog: HostedWorkerDispatchCatalog = {
      async listOrganizations(input) {
        listCalled = true;
        expect(input.after).toBeNull();
        expect(input.deadline).toBeGreaterThan(Date.now());
        expect(input.timeoutMs).toBeGreaterThan(0);
        return new Promise<readonly string[]>((_resolve, reject) => {
          input.signal?.addEventListener('abort', () => reject(new Error('catalog aborted')), { once: true });
        });
      },
    };
    let workerCalled = false;
    const dispatcher = new HostedWorkerDispatcher({
      cronSecret: CRON_SECRET,
      store,
      catalog,
      maxOrganizations: 1,
      pageSize: 1,
      maxDurationMs: 1_000,
      leaseDurationMs: 2_000,
      workerForOrganization: () => async () => {
        workerCalled = true;
        return workerResponse(true);
      },
    });

    const started = Date.now();
    const response = await dispatcher.handle(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ organizationsVisited: 0, truncated: true });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(listCalled).toBe(true);
    expect(workerCalled).toBe(false);
    expect(store.lease).toBeUndefined();
  });

  it('records a queue probe failure for retry without invoking a tenant worker', async () => {
    const store = new MemoryDispatchStore();
    const catalog: HostedWorkerDispatchCatalog = {
      async listOrganizations() { return ['tenant-a']; },
      async hasPendingJobs() { throw new Error('catalog unavailable'); },
    };
    let workerCalled = false;
    const dispatcher = new HostedWorkerDispatcher({
      cronSecret: CRON_SECRET,
      store,
      catalog,
      maxOrganizations: 1,
      pageSize: 1,
      workerForOrganization: () => async () => {
        workerCalled = true;
        return workerResponse(true);
      },
    });

    const response = await dispatcher.handle(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ failures: 1 });
    expect(workerCalled).toBe(false);
    expect(store.retries.get('tenant-a')).toMatchObject({ attempts: 1, reason: 'queue_probe_failed' });
  });

  it('fences an expired lease before accepting cursor or retry writes', async () => {
    const store = new MemoryDispatchStore();
    const lease = await store.acquireLease(1_000, 1_000);
    expect(lease).not.toBeNull();
    store.expire();
    await expect(store.advance(lease!, 'tenant-a', 2_000)).rejects.toBeInstanceOf(HostedWorkerDispatchLeaseError);
    const replacement = await store.acquireLease(2_000, 1_000);
    expect(replacement?.token).not.toBe(lease?.token);
    await expect(store.recordFailure(lease!, 'tenant-a', 'tenant-a', 'stale', 2_000)).rejects.toBeInstanceOf(HostedWorkerDispatchLeaseError);
    expect(store.retries.has('tenant-a')).toBe(false);
  });
});

describe('PostgresHostedWorkerDispatchStore', () => {
  it('keeps dispatch metadata in dedicated bounded tables', () => {
    const sql = hostedWorkerDispatchSchemaSql('worker_dispatch_test', 'worker_retry_test');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "worker_dispatch_test"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "worker_retry_test"');
    expect(sql).toContain('attempts BETWEEN 0 AND 16');
    expect(sql).toContain('char_length(last_error) BETWEEN 1 AND 512');
    expect(() => new PostgresHostedWorkerDispatchStore({ pool: {} as PgPoolLike, tableName: 'bad-name' })).toThrow('table name');
  });

  it.skipIf(!(process.env.PSKILLS_TEST_POSTGRES_URL ?? process.env.DATABASE_URL))('recovers two PostgreSQL company queues after an initial worker failure', async () => {
    const databaseUrl = process.env.PSKILLS_TEST_POSTGRES_URL ?? process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('PostgreSQL test URL is unavailable');
    const postgres = (await import('postgres')).default;
    const sql = postgres(databaseUrl, { max: 4, prepare: false });
    const suffix = crypto.randomUUID().replaceAll('-', '');
    const registryTable = `pskills_dispatch_registry_${suffix}`;
    const dispatchTable = `pskills_dispatch_${suffix}`;
    const retryTable = `pskills_dispatch_retry_${suffix}`;
    const query = async (text: string, parameters: readonly unknown[] = []) => {
      const result = await sql.unsafe(text, [...parameters] as never[]);
      return { rows: [...result], rowCount: result.count };
    };
    const pool = {
      query: (text: string, parameters?: readonly unknown[]) => query(text, parameters),
      connect: async () => {
        const connection = await sql.reserve();
        return {
          query: (text: string, parameters?: readonly unknown[]) => {
            const result = connection.unsafe(text, [...(parameters ?? [])] as never[]);
            return result.then((rows) => ({ rows: [...rows], rowCount: rows.count }));
          },
          release: () => connection.release(),
        };
      },
    } as PgPoolLike;
    const repository = new (await import('../src/index.js')).PostgresStateRepository(pool, {
      tableName: registryTable,
      autoMigrate: true,
    });
    const store = new PostgresHostedWorkerDispatchStore({
      pool,
      tableName: dispatchTable,
      retryTableName: retryTable,
      autoMigrate: true,
    });
    let now = Date.now();
    const jobs = new Map<string, string>([['tenant-a', 'job-a'], ['tenant-b', 'job-b']]);
    const job = (organizationId: string, id: string) => ({
      id,
      organizationId,
      kind: 'import' as const,
      state: 'queued' as const,
      policyRevision: 'policy-test',
      policy: { revision: 'policy-test', scanners: [], allowUnscanned: true, evidenceMaxAgeSeconds: 60 },
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      attempts: 0,
    });
    try {
      for (const [organizationId, id] of jobs) {
        await repository.transaction(organizationId, (state) => { state.jobs.push(job(organizationId, id)); });
      }
      const catalog: HostedWorkerDispatchCatalog = {
        async listOrganizations(input) {
          const result = await pool.query<{ organization_id?: unknown }>(
            `SELECT organization_id FROM "${registryTable}" WHERE ($1::text IS NULL OR organization_id > $1) ORDER BY organization_id ASC LIMIT $2`,
            [input.after, input.limit],
          );
          return result.rows.map((row) => row.organization_id as string);
        },
        async hasPendingJobs(organizationId) {
          const state = await repository.read(organizationId);
          return state.jobs.some((candidate) => candidate.state === 'queued' || (candidate.state === 'running' && candidate.leaseExpiresAt !== undefined && Date.parse(candidate.leaseExpiresAt) <= now));
        },
      };
      const calls: string[] = [];
      let failedA = false;
      const dispatcher = new HostedWorkerDispatcher({
        cronSecret: CRON_SECRET,
        store,
        catalog,
        now: () => now,
        maxOrganizations: 2,
        pageSize: 2,
        maxJobsPerOrganization: 1,
        workerForOrganization: (organizationId) => async () => {
          calls.push(organizationId);
          if (organizationId === 'tenant-a' && !failedA) {
            failedA = true;
            return workerResponse(false, 503);
          }
          await repository.transaction(organizationId, (state) => {
            state.jobs = state.jobs.map((candidate) => ({ ...candidate, state: 'completed', updatedAt: new Date(now).toISOString() }));
          });
          return workerResponse(true);
        },
      });

      const first = await dispatcher.handle(request());
      expect(first.status).toBe(200);
      await expect(first.json()).resolves.toMatchObject({ organizationsVisited: 2, failures: 1, claimed: true });
      expect(calls).toEqual(['tenant-a', 'tenant-b']);
      const retry = await pool.query<{ attempts?: unknown }>(`SELECT attempts FROM "${retryTable}" WHERE organization_id = $1`, ['tenant-a']);
      expect(retry.rows[0]?.attempts).toBe(1);

      now += 1;
      const suppressed = await dispatcher.handle(request());
      expect(suppressed.status).toBe(200);
      expect(calls).toEqual(['tenant-a', 'tenant-b']);

      now += 30_000;
      const recovered = await dispatcher.handle(request());
      expect(recovered.status).toBe(200);
      await expect(recovered.json()).resolves.toMatchObject({ failures: 0, claimed: true });
      expect(calls).toEqual(['tenant-a', 'tenant-b', 'tenant-a']);
      expect((await repository.read('tenant-a')).jobs[0]?.state).toBe('completed');
      expect((await repository.read('tenant-b')).jobs[0]?.state).toBe('completed');
      const cleared = await pool.query(`SELECT organization_id FROM "${retryTable}" WHERE organization_id = $1`, ['tenant-a']);
      expect(cleared.rows).toHaveLength(0);

      const stale = await store.acquireLease(now, 1_000);
      expect(stale).not.toBeNull();
      const replacement = await store.acquireLease(now + 2_000, 1_000);
      expect(replacement?.token).not.toBe(stale?.token);
      await expect(store.advance(stale!, 'tenant-a', now + 2_000)).rejects.toBeInstanceOf(HostedWorkerDispatchLeaseError);
      await expect(store.recordFailure(stale!, 'tenant-a', 'tenant-a', 'stale-owner', now + 2_000)).rejects.toBeInstanceOf(HostedWorkerDispatchLeaseError);
      expect((await pool.query(`SELECT organization_id FROM "${retryTable}" WHERE organization_id = $1`, ['tenant-a'])).rows).toHaveLength(0);
      await store.release(replacement!, replacement!.cursor);
    } finally {
      await sql.unsafe(`DROP TABLE IF EXISTS "${retryTable}"`);
      await sql.unsafe(`DROP TABLE IF EXISTS "${dispatchTable}"`);
      await sql.unsafe(`DROP TABLE IF EXISTS "${registryTable}"`);
      await sql.end({ timeout: 1 });
    }
  }, 30_000);
});
