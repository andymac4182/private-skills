import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  BillingService,
  PostgresBillingRepository,
  billingPostgresSchemaSql,
  type BillingPgPoolLike,
  type BillingPgQueryResult,
  type BillingProvider,
} from '../../../packages/billing/src/index.js';
import { createBillingEveCostReservation } from '../../../apps/web/server/eve-cost-reservation.js';

function localDatabaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') return undefined;
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname) ? value : undefined;
  } catch {
    return undefined;
  }
}

// This proof is intentionally limited to a disposable loopback database.
const DATABASE_URL = localDatabaseUrl(process.env.PSKILLS_BILLING_POSTGRES_URL);
const describePostgres = DATABASE_URL ? describe : describe.skip;
const NOW = Date.parse('2026-09-16T00:00:00.000Z');

type SqlClient = ReturnType<typeof postgres>;
type SqlExecutor = Pick<SqlClient, 'unsafe'>;

async function query<Row = Record<string, unknown>>(
  executor: SqlExecutor,
  statement: string,
  parameters?: readonly unknown[],
): Promise<BillingPgQueryResult<Row>> {
  const values = parameters === undefined ? undefined : [...parameters] as never;
  const rows = await executor.unsafe<Row[]>(statement, values);
  return { rows: Array.from(rows), rowCount: rows.count };
}

function provider(): BillingProvider {
  return {
    id: 'local',
    mode: 'test',
    async createCustomer(input) { return { provider: 'local', customerId: `cus_${input.organizationId}` }; },
    async createCheckoutSession(input) { return { provider: 'local', mode: 'test', id: input.idempotencyKey, url: 'http://localhost:5173/billing/test-checkout' }; },
    async createCustomerPortalSession(input) { return { provider: 'local', mode: 'test', id: input.idempotencyKey, url: 'http://localhost:5173/billing/test-portal' }; },
  };
}

describePostgres('billing-backed Eve reservation recovery (requires PSKILLS_BILLING_POSTGRES_URL)', () => {
  let sql: SqlClient | undefined;
  let pool: BillingPgPoolLike;
  const prefix = `eve_recovery_it_${process.pid}_${Math.floor(Math.random() * 10_000)}`;

  beforeAll(async () => {
    sql = postgres(DATABASE_URL!, { max: 8, prepare: false });
    pool = {
      query: <Row = Record<string, unknown>>(statement: string, parameters?: readonly unknown[]) => query<Row>(sql!, statement, parameters),
      connect: async () => {
        const reserved = await sql!.reserve();
        return {
          query: <Row = Record<string, unknown>>(statement: string, parameters?: readonly unknown[]) => query<Row>(reserved, statement, parameters),
          release: () => reserved.release(),
        };
      },
    };
    await pool.query(billingPostgresSchemaSql(prefix));
  });

  afterAll(async () => {
    if (!sql) return;
    try {
      await sql.unsafe(`DROP TABLE IF EXISTS "${prefix}_usage_operations", "${prefix}_webhook_events", "${prefix}_subscriptions", "${prefix}_customers", "${prefix}_usage"`);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('reconciles a reservation after adapter restart and in-memory eviction', async () => {
    const firstBilling = new BillingService({
      repository: new PostgresBillingRepository(pool, { tablePrefix: prefix, now: () => NOW }),
      provider: provider(),
      enabled: true,
      now: () => NOW,
    });
    const first = createBillingEveCostReservation(firstBilling, { estimateCents: 17, maxInMemoryReservations: 1 });
    const held = await first.reserve({
      tenantId: 'eve-recovery-acme',
      service: 'consolidation-reviewer',
      operation: 'daily-review',
      idempotencyKey: 'common-skill-review:2026-09-16',
    });
    // Evict the only in-memory copy while the durable operation remains in PG.
    await first.reserve({
      tenantId: 'eve-recovery-globex',
      service: 'consolidation-reviewer',
      operation: 'daily-review',
      idempotencyKey: 'common-skill-review:2026-09-16',
    });

    // A new BillingService and adapter model a fresh host process. Recovery
    // must derive the tenant and estimate from the retained billing row.
    const restartedBilling = new BillingService({
      repository: new PostgresBillingRepository(pool, { tablePrefix: prefix, now: () => NOW }),
      provider: provider(),
      enabled: true,
      now: () => NOW,
    });
    const restarted = createBillingEveCostReservation(restartedBilling, { estimateCents: 17, maxInMemoryReservations: 1 });
    await expect(restarted.reconcile?.({
      reservationId: held.reservationId,
      actualCostCents: 11,
      operationKey: 'operator-reconcile-eve-recovery-acme',
    })).resolves.toBeUndefined();

    await expect(restartedBilling.usageSnapshot('eve-recovery-acme')).resolves.toMatchObject({ usage: { eveCostCents: 11 } });
    const rows = await sql!.unsafe<{ eve_cost_cents_delta: number }[]>(
      `SELECT eve_cost_cents_delta FROM "${prefix}_usage_operations" WHERE organization_id = $1 ORDER BY created_at ASC`,
      ['eve-recovery-acme'],
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => Number(row.eve_cost_cents_delta))).toEqual([17, -6]);
  });
});
