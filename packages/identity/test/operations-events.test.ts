import { describe, expect, it, vi } from 'vitest';

import {
  IDENTITY_OPERATIONS_EVENTS_TABLE,
  PostgresIdentityOperationsEventStore,
  identityOperationsEventsSchemaSql,
  type IdentityOperationsEventStoreOptions,
  type IdentityOperationsSummary,
} from '../src/index.js';
import type { PgPoolLike } from '../../database/src/postgres.js';

const NOW = Date.parse('2026-09-16T00:00:00.000Z');

class PoolFixture implements PgPoolLike {
  readonly calls: Array<{ text: string; parameters?: readonly unknown[] }> = [];
  summaryRows: Array<Record<string, unknown>> = [];
  rowCount = 0;

  async query<Row = Record<string, unknown>>(text: string, parameters?: readonly unknown[]) {
    this.calls.push({ text, parameters });
    if (text.startsWith('SELECT event_kind')) return { rows: this.summaryRows as Row[], rowCount: this.summaryRows.length };
    if (text.startsWith('DELETE FROM')) return { rows: [] as Row[], rowCount: this.rowCount };
    return { rows: [] as Row[], rowCount: 0 };
  }

  async connect() {
    return { query: this.query.bind(this), release: vi.fn() };
  }
}

function options(pool: PgPoolLike, verifyTenant: IdentityOperationsEventStoreOptions['verifyTenant']): IdentityOperationsEventStoreOptions {
  return {
    pool,
    verifyTenant,
    now: () => NOW,
  };
}

describe('identity operations event store', () => {
  it('owns a constrained table and rejects unsafe identifiers', () => {
    const schema = identityOperationsEventsSchemaSql('identity_ops_events', 'identity_test');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS "identity_test"."identity_ops_events"');
    expect(schema).toContain('event_kind IN');
    expect(schema).toContain('reason_code IN');
    expect(schema).toContain('role IS NULL OR role IN');
    expect(schema).toContain('organization_time');
    expect(schema).not.toContain('message');
    expect(identityOperationsEventsSchemaSql()).toContain(IDENTITY_OPERATIONS_EVENTS_TABLE);
    expect(() => new PostgresIdentityOperationsEventStore(options(new PoolFixture(), async () => null))).not.toThrow();
    expect(() => identityOperationsEventsSchemaSql('bad-name')).toThrow();
    expect(() => identityOperationsEventsSchemaSql('events', 'bad-name')).toThrow();
  });

  it('keeps unverified tenant attempts out of tenant rows and rechecks role before writing', async () => {
    const pool = new PoolFixture();
    let membership: { organizationId: string; userId: string; role: 'owner' | 'reader' } | null = {
      organizationId: 'org-a',
      userId: 'user-a',
      role: 'reader',
    };
    const verifyTenant = vi.fn(async (organizationId: string, userId: string) => {
      if (!membership || membership.organizationId !== organizationId || membership.userId !== userId) return null;
      return membership;
    });
    const store = new PostgresIdentityOperationsEventStore(options(pool, verifyTenant));

    const context = await store.trustedTenant('org-a', 'user-a');
    expect(context).toEqual({ organizationId: 'org-a', userId: 'user-a', role: 'reader' });
    expect(await store.trustedTenant('org-from-query', 'user-a')).toBeNull();
    expect(await store.recordTenant({ organizationId: 'org-a', userId: 'user-a', role: 'reader' }, {
      kind: 'membership_denial',
      reasonCode: 'membership_role_denied',
    })).toBe(false);
    expect(context).not.toBeNull();
    expect(await store.recordTenant(context!, { kind: 'membership_denial', reasonCode: 'membership_role_denied' })).toBe(true);
    expect(pool.calls.filter((call) => call.text.startsWith('INSERT')).at(-1)?.parameters).toEqual([
      expect.any(String),
      expect.any(Date),
      'membership_denial',
      'membership_role_denied',
      undefined,
      'org-a',
      'reader',
    ]);

    membership = null;
    expect(await store.recordTenant(context!, { kind: 'membership_denial', reasonCode: 'membership_role_denied' })).toBe(false);
    expect(verifyTenant).toHaveBeenCalledTimes(4);
    expect(pool.calls.filter((call) => call.text.startsWith('INSERT'))).toHaveLength(1);
  });

  it('returns bounded aggregate counters without exposing event rows', async () => {
    const pool = new PoolFixture();
    pool.summaryRows = [
      { event_kind: 'authentication_failure', total: '4', recent_count: '2', latest_at: new Date(NOW - 2_000) },
      { event_kind: 'callback_failure', total: 1n, recent_count: 1n, latest_at: '2026-09-15T23:00:00.000Z' },
      { event_kind: 'membership_denial', total: 0, recent_count: 0, latest_at: null },
      { event_kind: 'unrecognized', total: 99, recent_count: 99, latest_at: 'secret' },
    ];
    const store = new PostgresIdentityOperationsEventStore(options(pool, async () => null));
    const summary: IdentityOperationsSummary = await store.summarize('org-a', NOW);
    expect(summary).toEqual({
      authenticationFailures: { total: 4, last24h: 2, latestAt: new Date(NOW - 2_000).toISOString() },
      callbackFailures: { total: 1, last24h: 1, latestAt: '2026-09-15T23:00:00.000Z' },
      membershipDenials: { total: 0, last24h: 0 },
    });
    const query = pool.calls[0];
    expect(query.text).toContain('GROUP BY event_kind');
    expect(query.text).toContain('LIMIT 3');
    expect(query.text).not.toContain('SELECT *');
    expect(JSON.stringify(summary)).not.toContain('secret');
  });

  it('limits cleanup to the configured batch size', async () => {
    const pool = new PoolFixture();
    pool.rowCount = 2;
    const store = new PostgresIdentityOperationsEventStore({
      ...options(pool, async () => null),
      retentionDays: 30,
      cleanupBatchSize: 2,
    });
    await expect(store.cleanup(NOW)).resolves.toBe(2);
    const cleanup = pool.calls[0];
    expect(cleanup.text).toContain('ORDER BY occurred_at ASC');
    expect(cleanup.text).toContain('LIMIT $2');
    expect(cleanup.parameters?.[1]).toBe(2);
  });
});
