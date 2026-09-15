import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BillingService,
  PostgresBillingRepository,
  billingPostgresSchemaSql,
  createPlanCatalog,
  createTestSubscriptionEvent,
  signWebhookPayload,
  type BillingPgPoolLike,
  type BillingProvider,
  type BillingPgQueryResult,
  type PlanDefinition,
  type PlanId,
} from '../src/index.js'

function localDatabaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') return undefined
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname) ? value : undefined
  } catch {
    return undefined
  }
}

// This proof is intentionally unable to target a non-loopback database. It
// must remain a disposable local check and never become a production probe.
const DATABASE_URL = localDatabaseUrl(process.env.PSKILLS_BILLING_POSTGRES_URL)
const describePostgres = DATABASE_URL ? describe : describe.skip
const NOW = Date.parse('2026-09-15T00:00:00.000Z')
const NOW_SECONDS = Math.floor(NOW / 1_000)
const SECRET = 'whsec_postgres_integration_secret'

type SqlClient = ReturnType<typeof postgres>
type SqlExecutor = Pick<SqlClient, 'unsafe'>

// Keep the adapter's generic query contract aligned with pg-style callers;
// the repository asks for different row shapes at each read boundary.
async function query<Row = Record<string, unknown>>(
  executor: SqlExecutor,
  statement: string,
  parameters?: readonly unknown[],
): Promise<BillingPgQueryResult<Row>> {
  const values = parameters === undefined ? undefined : [...parameters] as never
  const rows = await executor.unsafe<Row[]>(statement, values)
  return { rows: Array.from(rows), rowCount: rows.count }
}

function planCatalog() {
  const plans: PlanDefinition[] = [
    {
      id: 'free' as PlanId,
      label: 'Free',
      description: 'Small bounded test plan.',
      limits: { seats: 2, storageBytes: 1_000, scansPerMonth: 1, eveCostCentsPerMonth: 10 },
      public: true,
    },
    {
      id: 'team' as PlanId,
      label: 'Team',
      description: 'Bounded integration plan.',
      limits: { seats: 10, storageBytes: 10_000, scansPerMonth: 10, eveCostCentsPerMonth: 100 },
      priceId: 'price_team_pg',
      public: true,
    },
  ]
  return createPlanCatalog({ plans })
}

function provider(): BillingProvider {
  return {
    id: 'local',
    mode: 'test',
    async createCustomer(input) { return { provider: 'local', customerId: `cus_${input.organizationId}` } },
    async createCheckoutSession(input) { return { provider: 'local', mode: 'test', id: input.idempotencyKey, url: 'http://localhost:5173/billing/test-checkout' } },
    async createCustomerPortalSession(input) { return { provider: 'local', mode: 'test', id: input.idempotencyKey, url: 'http://localhost:5173/billing/test-portal' } },
  }
}

describePostgres('billing PostgreSQL durability (requires PSKILLS_BILLING_POSTGRES_URL)', () => {
  let sql: SqlClient | undefined
  let pool: BillingPgPoolLike
  const prefix = `billing_it_${process.pid}_${Math.floor(Math.random() * 10_000)}`

  beforeAll(async () => {
    sql = postgres(DATABASE_URL!, { max: 8 })
    pool = {
      query: <Row = Record<string, unknown>>(statement: string, parameters?: readonly unknown[]) => query<Row>(sql!, statement, parameters),
      connect: async () => {
        const reserved = await sql!.reserve()
        return {
          query: <Row = Record<string, unknown>>(statement: string, parameters?: readonly unknown[]) => query<Row>(reserved, statement, parameters),
          release: () => reserved.release(),
        }
      },
    }
    await pool.query(billingPostgresSchemaSql(prefix))
  })

  afterAll(async () => {
    if (!sql) return
    try {
      await sql.unsafe(`DROP TABLE IF EXISTS "${prefix}_usage_operations", "${prefix}_webhook_events", "${prefix}_subscriptions", "${prefix}_customers", "${prefix}_usage"`)
    } finally {
      await sql.end({ timeout: 5 })
    }
  })

  it('serializes concurrent usage reservations and keeps retries idempotent', async () => {
    const catalog = planCatalog()
    const first = new BillingService({
      repository: new PostgresBillingRepository(pool, { tablePrefix: prefix, now: () => NOW }),
      catalog,
      enabled: false,
      now: () => NOW,
    })
    const second = new BillingService({
      repository: new PostgresBillingRepository(pool, { tablePrefix: prefix, now: () => NOW }),
      catalog,
      enabled: false,
      now: () => NOW,
    })

    const results = await Promise.allSettled([
      first.reserveUsage('org-pg-concurrent', { scans: 1 }, 'pg-scan-a'),
      second.reserveUsage('org-pg-concurrent', { scans: 1 }, 'pg-scan-b'),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect((results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'USAGE_LIMIT_EXCEEDED' })
    await expect(first.reserveUsage('org-pg-concurrent', { scans: 1 }, 'pg-scan-a')).resolves.toMatchObject({ idempotent: true })
    await expect(first.usageSnapshot('org-pg-concurrent')).resolves.toMatchObject({ usage: { scans: 1 } })

    const rows = await sql!.unsafe<Record<string, unknown>[]>(`SELECT operation_key FROM "${prefix}_usage_operations" WHERE organization_id = $1`, ['org-pg-concurrent'])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.operation_key).toBe('pg-scan-a')
  })

  it('keeps the last seat atomic across invite barriers and reuses cancel/remove lifecycles', async () => {
    const catalog = planCatalog()
    const first = new BillingService({
      repository: new PostgresBillingRepository(pool, { tablePrefix: prefix, now: () => NOW }),
      catalog,
      enabled: false,
      now: () => NOW,
    })
    const second = new BillingService({
      repository: new PostgresBillingRepository(pool, { tablePrefix: prefix, now: () => NOW }),
      catalog,
      enabled: false,
      now: () => NOW,
    })
    const organizationId = 'org-pg-seat-barrier'
    await first.syncSeatCount(organizationId, 1, 'pg-seat-seed')

    let arrivals = 0
    let openBarrier!: () => void
    const barrier = new Promise<void>((resolve) => { openBarrier = resolve })
    const reserveAtBarrier = async (service: BillingService, key: string) => {
      arrivals += 1
      if (arrivals === 2) openBarrier()
      await barrier
      return service.reserveSeat(organizationId, key)
    }
    const results = await Promise.allSettled([
      reserveAtBarrier(first, 'pg-invite-a'),
      reserveAtBarrier(second, 'pg-invite-b'),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect((results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'USAGE_LIMIT_EXCEEDED' })
    const winner = (results.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<BillingService['reserveSeat']>>> => result.status === 'fulfilled')!).value.operationKey
    await expect(first.usageSnapshot(organizationId)).resolves.toMatchObject({ usage: { seats: 2 } })

    // Cancel and re-invite the same subject. The settled lifecycle tombstone
    // must reactivate the key and consume the last seat again.
    await expect(first.releaseSeat(organizationId, winner)).resolves.toMatchObject({ idempotent: false })
    await expect(second.reserveSeat(organizationId, winner)).resolves.toMatchObject({ idempotent: false })
    await first.commitSeat(organizationId, winner)
    await first.syncSeatCount(organizationId, 2, 'pg-seat-invite-committed')

    // Remove and re-add the same subject after the committed count falls.
    await first.syncSeatCount(organizationId, 1, 'pg-seat-member-removed')
    await expect(second.reserveSeat(organizationId, winner)).resolves.toMatchObject({ idempotent: false })
    await expect(second.usageSnapshot(organizationId)).resolves.toMatchObject({ usage: { seats: 2 } })
  })

  it('claims one signed webhook delivery across concurrent service instances', async () => {
    const catalog = planCatalog()
    const first = new BillingService({
      repository: new PostgresBillingRepository(pool, { tablePrefix: prefix, now: () => NOW }),
      catalog,
      provider: provider(),
      enabled: true,
      webhookSecret: SECRET,
      now: () => NOW,
    })
    const second = new BillingService({
      repository: new PostgresBillingRepository(pool, { tablePrefix: prefix, now: () => NOW }),
      catalog,
      provider: provider(),
      enabled: true,
      webhookSecret: SECRET,
      now: () => NOW,
    })
    const body = createTestSubscriptionEvent({
      eventId: 'evt_pg_dedupe',
      created: NOW_SECONDS,
      organizationId: 'org-pg-webhook',
      customerId: 'cus_pg_webhook',
      subscriptionId: 'sub_pg_dedupe',
      priceId: 'price_team_pg',
    })
    const signature = await signWebhookPayload(body, SECRET, NOW_SECONDS)
    const results = await Promise.allSettled([first.handleWebhook(body, signature), second.handleWebhook(body, signature)])
    const fulfilled = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<BillingService['handleWebhook']>>> => result.status === 'fulfilled').map((result) => result.value.status)
    expect(fulfilled.sort()).toEqual(['applied', 'duplicate'])
    await expect(first.entitlement('org-pg-webhook')).resolves.toMatchObject({ planId: 'team', state: 'active', customerId: 'cus_pg_webhook', subscriptionId: 'sub_pg_dedupe' })

    const events = await sql!.unsafe<Record<string, unknown>[]>(`SELECT provider, event_id, handled FROM "${prefix}_webhook_events" WHERE organization_id = $1`, ['org-pg-webhook'])
    expect(events).toEqual([{ provider: 'local', event_id: 'evt_pg_dedupe', handled: true }])
  })

  it('keeps the newer subscription event authoritative when deliveries arrive out of order', async () => {
    const catalog = planCatalog()
    const first = new BillingService({
      repository: new PostgresBillingRepository(pool, { tablePrefix: prefix, now: () => NOW }),
      catalog,
      provider: provider(),
      enabled: true,
      webhookSecret: SECRET,
      now: () => NOW,
    })
    const second = new BillingService({
      repository: new PostgresBillingRepository(pool, { tablePrefix: prefix, now: () => NOW }),
      catalog,
      provider: provider(),
      enabled: true,
      webhookSecret: SECRET,
      now: () => NOW,
    })
    const newer = createTestSubscriptionEvent({
      eventId: 'evt_pg_order_new',
      created: NOW_SECONDS + 2,
      organizationId: 'org-pg-order',
      customerId: 'cus_pg_order',
      subscriptionId: 'sub_pg_order',
      priceId: 'price_team_pg',
      status: 'active',
    })
    const older = createTestSubscriptionEvent({
      eventId: 'evt_pg_order_old',
      eventType: 'customer.subscription.deleted',
      created: NOW_SECONDS + 1,
      organizationId: 'org-pg-order',
      customerId: 'cus_pg_order',
      subscriptionId: 'sub_pg_order',
      priceId: 'price_team_pg',
      status: 'canceled',
    })
    const [newerSignature, olderSignature] = await Promise.all([
      signWebhookPayload(newer, SECRET, NOW_SECONDS),
      signWebhookPayload(older, SECRET, NOW_SECONDS),
    ])
    const results = await Promise.allSettled([
      first.handleWebhook(newer, newerSignature),
      second.handleWebhook(older, olderSignature),
    ])
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true)
    await expect(first.entitlement('org-pg-order')).resolves.toMatchObject({ planId: 'team', state: 'active', subscriptionId: 'sub_pg_order' })
    const events = await sql!.unsafe<Record<string, unknown>[]>(`SELECT event_id FROM "${prefix}_webhook_events" WHERE organization_id = $1 ORDER BY event_id`, ['org-pg-order'])
    expect(events.map((event) => event.event_id)).toEqual(['evt_pg_order_new', 'evt_pg_order_old'])
  })
})
