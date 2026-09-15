import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PostgresIdentityBillingAdmission } from '../../../apps/web/server/identity-infrastructure.js'
import { seatOperationKey } from '../../../packages/identity/src/index.js'
import {
  BillingService,
  createBillingServiceFromEnv,
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

    await expect(first.reserveUsage('org-pg-reopen', { storageBytes: 40 }, 'pg-import-stable')).resolves.toMatchObject({ idempotent: false })
    await expect(first.reconcileUsage('org-pg-reopen', 'pg-import-stable', { storageBytes: 0 }, 'pg-import-release')).resolves.toMatchObject({ idempotent: false })
    await expect(second.reserveUsage('org-pg-reopen', { storageBytes: 40 }, 'pg-import-stable')).resolves.toMatchObject({ idempotent: false })
    await expect(second.usageSnapshot('org-pg-reopen')).resolves.toMatchObject({ usage: { storageBytes: 40 } })
    await expect(first.reconcileUsage('org-pg-reopen', 'pg-import-stable', { storageBytes: 0 }, 'pg-import-release')).resolves.toMatchObject({ idempotent: false })
    await expect(second.usageSnapshot('org-pg-reopen')).resolves.toMatchObject({ usage: { storageBytes: 0 } })
  })

  it('enforces finite providerless usage in an explicitly configured production PostgreSQL profile', async () => {
    const repository = new PostgresBillingRepository(pool, { tablePrefix: prefix, now: () => NOW })
    const service = createBillingServiceFromEnv({
      repository,
      catalog: planCatalog(),
      env: {
        PSKILLS_ENVIRONMENT: 'production',
        PSKILLS_BILLING_ENABLED: 'true',
        PSKILLS_BILLING_METERED_EVALUATION: 'true',
      },
    })
    expect(service.status()).toMatchObject({
      enabled: true,
      usageEnforcement: true,
      providerReady: false,
      provider: null,
      mode: 'test',
      checkout: false,
      portal: false,
      webhookVerification: false,
    })

    await expect(service.reserveUsage('org-pg-providerless-production', { scans: 1 }, 'providerless-production-scan')).resolves.toMatchObject({ idempotent: false })
    await expect(service.reserveUsage('org-pg-providerless-production', { scans: 1 }, 'providerless-production-over-limit')).rejects.toMatchObject({ code: 'USAGE_LIMIT_EXCEEDED' })
    await expect(service.usageSnapshot('org-pg-providerless-production')).resolves.toMatchObject({ usage: { scans: 1 }, entitlement: { state: 'inactive', source: 'no-subscription' } })
    await expect(service.findUsageOperation('org-pg-providerless-production', 'providerless-production-scan')).resolves.toMatchObject({ organizationId: 'org-pg-providerless-production', status: 'reserved' })
    await expect(service.findUsageOperation('providerless-production-scan')).resolves.toMatchObject({ organizationId: 'org-pg-providerless-production', status: 'reserved' })

    await expect(service.reserveUsage('org-pg-global-a', { storageBytes: 1 }, 'global-operation-key')).resolves.toMatchObject({ idempotent: false })
    await expect(service.reserveUsage('org-pg-global-b', { storageBytes: 1 }, 'global-operation-key')).resolves.toMatchObject({ idempotent: false })
    await expect(service.findUsageOperation('org-pg-global-a', 'global-operation-key')).resolves.toMatchObject({ organizationId: 'org-pg-global-a' })
    await expect(service.findUsageOperation('global-operation-key')).rejects.toMatchObject({ code: 'AMBIGUOUS_OPERATION' })
  })

  it('replays an aged usage key through the durable exact-key ledger', async () => {
    let now = NOW
    const catalog = planCatalog()
    const repository = new PostgresBillingRepository(pool, { tablePrefix: prefix, maxUsageOperations: 1, now: () => now })
    const service = new BillingService({ repository, catalog, enabled: false, now: () => now })
    const organizationId = 'org-pg-aged-operation'

    await expect(service.reserveUsage(organizationId, { storageBytes: 40 }, 'pg-aged-stable')).resolves.toMatchObject({ idempotent: false })
    await expect(service.reconcileUsage(organizationId, 'pg-aged-stable', { storageBytes: 0 }, 'pg-aged-release')).resolves.toMatchObject({ idempotent: false })
    now += 1_000
    await expect(service.reserveUsage(organizationId, { scans: 1 }, 'pg-aged-newer')).resolves.toMatchObject({ idempotent: false })

    // Ordinary reads are intentionally bounded and no longer contain the old
    // key. The repository's exact primary-key lookup still finds its durable
    // released lifecycle row, and reserveUsage reopens it atomically while
    // preserving its original createdAt.
    const recent = await repository.read(organizationId)
    expect(recent.usageOperations).toHaveLength(1)
    expect(recent.usageOperations[0]?.operationKey).toBe('pg-aged-newer')
    await expect(repository.findUsageOperation(organizationId, 'pg-aged-stable')).resolves.toMatchObject({
      operationKey: 'pg-aged-stable',
      status: 'released',
      createdAt: new Date(NOW).toISOString(),
    })
    now += 1_000
    await expect(service.reserveUsage(organizationId, { storageBytes: 40 }, 'pg-aged-stable')).resolves.toMatchObject({ idempotent: false })
    await expect(service.reserveUsage(organizationId, { storageBytes: 40 }, 'pg-aged-stable')).resolves.toMatchObject({ idempotent: true })
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

    // A stale lower count cannot lower the committed baseline. The explicit
    // remove lifecycle then frees the seat before the same subject is re-added.
    await first.syncSeatCount(organizationId, 1, 'pg-seat-member-stale-read')
    await expect(first.usageSnapshot(organizationId)).resolves.toMatchObject({ usage: { seats: 2 } })
    await expect(first.releaseSeat(organizationId, winner)).resolves.toMatchObject({ idempotent: false })
    await expect(second.reserveSeat(organizationId, winner)).resolves.toMatchObject({ idempotent: false })
    await expect(second.usageSnapshot(organizationId)).resolves.toMatchObject({ usage: { seats: 2 } })
  })

  it('does not let a stale Better Auth count undo a committed seat', async () => {
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
    const organizationId = 'org-pg-stale-identity-count'
    const schema = `billing_identity_it_${process.pid}_${Math.floor(Math.random() * 10_000)}`
    const quotedSchema = `"${schema}"`
    const memberTable = `${quotedSchema}."member"`
    const invitationTable = `${quotedSchema}."invitation"`
    await sql!.unsafe(`CREATE SCHEMA ${quotedSchema}`)
    await sql!.unsafe(`CREATE TABLE ${memberTable} ("id" text PRIMARY KEY, "organizationId" text NOT NULL, "userId" text NOT NULL, "role" text NOT NULL)`)
    await sql!.unsafe(`CREATE TABLE ${invitationTable} ("id" text PRIMARY KEY, "organizationId" text NOT NULL, "status" text NOT NULL, "expiresAt" timestamptz NOT NULL)`)
    await sql!.unsafe(`INSERT INTO ${memberTable} ("id", "organizationId", "userId", "role") VALUES ($1, $2, $3, $4)`, ['member-existing', organizationId, 'user-existing', 'owner'])

    const identityPool = pool
    const firstAdmission = new PostgresIdentityBillingAdmission(first, identityPool, schema)
    await firstAdmission.syncSeats(organizationId, 'pg-stale-seed')

    let releaseCountRead!: () => void
    const countReadBarrier = new Promise<void>((resolve) => { releaseCountRead = resolve })
    let countReadObserved!: () => void
    const countRead = new Promise<void>((resolve) => { countReadObserved = resolve })
    let delayed = false
    const delayedIdentityPool: BillingPgPoolLike = {
      query: async <Row = Record<string, unknown>>(statement: string, parameters?: readonly unknown[]) => {
        if (!delayed && statement.includes(`FROM ${memberTable}`) && statement.includes('UNION ALL')) {
          delayed = true
          const result = await identityPool.query<Row>(statement, parameters)
          countReadObserved()
          await countReadBarrier
          return result
        }
        return identityPool.query<Row>(statement, parameters)
      },
      connect: identityPool.connect.bind(identityPool),
    }
    const secondAdmission = new PostgresIdentityBillingAdmission(second, delayedIdentityPool, schema)
    let staleSync: Promise<void> | undefined
    try {
      // Capture the identity snapshot (one member) and hold before its billing
      // transaction. A concurrent member then commits both identity and
      // billing state while this sync still owns the stale count.
      staleSync = secondAdmission.syncSeats(organizationId, 'pg-stale-count')
      await countRead
      await first.reserveSeat(organizationId, 'pg-stale-member')
      await sql!.unsafe(`INSERT INTO ${memberTable} ("id", "organizationId", "userId", "role") VALUES ($1, $2, $3, $4)`, ['member-new', organizationId, 'user-new', 'reader'])
      await first.commitSeat(organizationId, 'pg-stale-member')
      releaseCountRead()
      await staleSync

      // The stale lower observation must leave the committed baseline at two;
      // a third member is rejected before Better Auth can write its row.
      await expect(second.reserveSeat(organizationId, 'pg-stale-third')).rejects.toMatchObject({ code: 'USAGE_LIMIT_EXCEEDED' })
      await expect(first.usageSnapshot(organizationId)).resolves.toMatchObject({ usage: { seats: 2 } })
      const members = await sql!.unsafe<Record<string, unknown>[]>(`SELECT count(*)::int AS count FROM ${memberTable} WHERE "organizationId" = $1`, [organizationId])
      expect(members[0]?.count).toBe(2)
    } finally {
      releaseCountRead()
      await staleSync?.catch(() => undefined)
      await sql!.unsafe(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`)
    }
  })

  it('reconciles subject lifecycle truth across expiry, missed hooks, removals, and stale high snapshots', async () => {
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
    const schema = `billing_identity_lifecycle_${process.pid}_${Math.floor(Math.random() * 10_000)}`
    const quotedSchema = `"${schema}"`
    const memberTable = `${quotedSchema}."member"`
    const invitationTable = `${quotedSchema}."invitation"`
    const identityPool = pool
    await sql!.unsafe(`CREATE SCHEMA ${quotedSchema}`)
    await sql!.unsafe(`CREATE TABLE ${memberTable} ("id" text PRIMARY KEY, "organizationId" text NOT NULL, "userId" text NOT NULL, "role" text NOT NULL)`)
    await sql!.unsafe(`CREATE TABLE ${invitationTable} ("id" text PRIMARY KEY, "organizationId" text NOT NULL, "status" text NOT NULL, "expiresAt" timestamptz NOT NULL)`)
    const firstAdmission = new PostgresIdentityBillingAdmission(first, identityPool, schema)

    try {
      // A member that predates billing has no reservation key. Reconciliation
      // creates a durable subject row, and a later removal releases it.
      const baselineOrganization = 'org-pg-lifecycle-baseline'
      await sql!.unsafe(`INSERT INTO ${memberTable} ("id", "organizationId", "userId", "role") VALUES ($1, $2, $3, $4)`, ['member-baseline', baselineOrganization, 'user-baseline', 'owner'])
      await firstAdmission.syncSeats(baselineOrganization, 'lifecycle-baseline-add')
      await expect(first.usageSnapshot(baselineOrganization)).resolves.toMatchObject({ usage: { seats: 1 } })
      await sql!.unsafe(`DELETE FROM ${memberTable} WHERE "organizationId" = $1 AND "id" = $2`, [baselineOrganization, 'member-baseline'])
      await firstAdmission.syncSeats(baselineOrganization, 'lifecycle-baseline-remove')
      await expect(first.usageSnapshot(baselineOrganization)).resolves.toMatchObject({ usage: { seats: 0 } })

      // An expired pending invitation is excluded from the identity snapshot.
      // Its committed billing row is therefore released during reconciliation.
      const expiryOrganization = 'org-pg-lifecycle-expiry'
      const invitationId = 'inv-expired'
      const expiryKey = await seatOperationKey('invitation', expiryOrganization, invitationId)
      await sql!.unsafe(`INSERT INTO ${invitationTable} ("id", "organizationId", "status", "expiresAt") VALUES ($1, $2, $3, $4)`, [invitationId, expiryOrganization, 'pending', new Date(NOW - 60_000)])
      await first.reserveSeat(expiryOrganization, expiryKey, { subjectKey: true })
      await first.commitSeat(expiryOrganization, expiryKey)
      await firstAdmission.syncSeats(expiryOrganization, 'lifecycle-expired')
      await expect(first.usageSnapshot(expiryOrganization)).resolves.toMatchObject({ usage: { seats: 0 } })

      // If an after-hook is lost after Better Auth commits, the next snapshot
      // settles the active hold without charging a second seat.
      const hookOrganization = 'org-pg-lifecycle-hook'
      const hookMemberId = 'member-hook'
      const hookKey = await seatOperationKey('member', hookOrganization, hookMemberId)
      await first.reserveSeat(hookOrganization, hookKey, { subjectKey: true })
      await sql!.unsafe(`INSERT INTO ${memberTable} ("id", "organizationId", "userId", "role") VALUES ($1, $2, $3, $4)`, [hookMemberId, hookOrganization, 'user-hook', 'reader'])
      await firstAdmission.syncSeats(hookOrganization, 'lifecycle-missed-hook')
      await expect(first.usageSnapshot(hookOrganization)).resolves.toMatchObject({ usage: { seats: 1 } })
      const hookUsage = await sql!.unsafe<Record<string, unknown>[]>(`SELECT seat_reservations FROM "${prefix}_usage" WHERE organization_id = $1`, [hookOrganization])
      const hookReservations = hookUsage[0]?.seat_reservations as Array<Record<string, unknown>>
      expect(hookReservations).toEqual(expect.arrayContaining([
        expect.objectContaining({ operationKey: hookKey, subjectKey: true, committed: true, status: 'settled' }),
      ]))

      // A failed/aborted Better Auth write has no identity row for a snapshot
      // to prove. The active subject hold therefore remains fail-closed, but
      // the exact generated key provides an explicit abort/release path so a
      // sequence of failed writes cannot exhaust the organization forever.
      const abortedOrganization = 'org-pg-lifecycle-aborted'
      const abortedSubject = 'member-aborted'
      const abortedKey = await seatOperationKey('member', abortedOrganization, abortedSubject)
      await first.syncSeatCount(abortedOrganization, 1, 'lifecycle-aborted-seed')
      await first.reserveSeat(abortedOrganization, abortedKey, { subjectKey: true })
      await firstAdmission.syncSeats(abortedOrganization, 'lifecycle-aborted-missing')
      await expect(first.usageSnapshot(abortedOrganization)).resolves.toMatchObject({ usage: { seats: 2 } })
      await expect(second.reserveSeat(abortedOrganization, 'lifecycle-aborted-third')).rejects.toMatchObject({ code: 'USAGE_LIMIT_EXCEEDED' })
      await expect(firstAdmission.releaseSeat(abortedOrganization, abortedKey)).resolves.toBeUndefined()
      await expect(firstAdmission.reserveNewSeat(abortedOrganization, 'lifecycle-aborted-retry')).resolves.toBeUndefined()

      // Start from two committed subjects. A stale snapshot still contains B,
      // while a concurrent remove lifecycle has already released B. Revision
      // fencing must keep the stale read from re-adding the removed seat.
      const staleOrganization = 'org-pg-lifecycle-stale-high'
      const memberA = 'member-stale-a'
      const memberB = 'member-stale-b'
      await sql!.unsafe(`INSERT INTO ${memberTable} ("id", "organizationId", "userId", "role") VALUES ($1, $2, $3, $4), ($5, $2, $6, $4)`, [memberA, staleOrganization, 'user-stale-a', 'reader', memberB, 'user-stale-b'])
      await firstAdmission.syncSeats(staleOrganization, 'lifecycle-stale-seed')
      const keyB = await seatOperationKey('member', staleOrganization, memberB)
      let releaseSnapshot!: () => void
      const snapshotBarrier = new Promise<void>((resolve) => { releaseSnapshot = resolve })
      let snapshotRead!: () => void
      const snapshotReady = new Promise<void>((resolve) => { snapshotRead = resolve })
      let delayed = false
      const delayedIdentityPool: BillingPgPoolLike = {
        query: async <Row = Record<string, unknown>>(statement: string, parameters?: readonly unknown[]) => {
          if (!delayed && statement.includes(`FROM ${memberTable}`) && statement.includes('UNION ALL')) {
            delayed = true
            const result = await identityPool.query<Row>(statement, parameters)
            snapshotRead()
            await snapshotBarrier
            return result
          }
          return identityPool.query<Row>(statement, parameters)
        },
        connect: identityPool.connect.bind(identityPool),
      }
      const secondAdmission = new PostgresIdentityBillingAdmission(second, delayedIdentityPool, schema)
      let staleSync: Promise<void> | undefined
      try {
        staleSync = secondAdmission.syncSeats(staleOrganization, 'lifecycle-stale-high')
        await snapshotReady
        await sql!.unsafe(`DELETE FROM ${memberTable} WHERE "organizationId" = $1 AND "id" = $2`, [staleOrganization, memberB])
        await first.releaseSeat(staleOrganization, keyB)
        releaseSnapshot()
        await staleSync
      } finally {
        releaseSnapshot()
        await staleSync?.catch(() => undefined)
      }
      await expect(second.reserveSeat(staleOrganization, 'lifecycle-stale-third')).resolves.toMatchObject({ idempotent: false })
      await expect(second.usageSnapshot(staleOrganization)).resolves.toMatchObject({ usage: { seats: 2 } })
    } finally {
      await sql!.unsafe(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`)
    }
  })

  it('keeps an active seat hold until its identity lifecycle resolves', async () => {
    let now = NOW
    const catalog = planCatalog()
    const first = new BillingService({
      repository: new PostgresBillingRepository(pool, { tablePrefix: prefix, now: () => now }),
      catalog,
      enabled: false,
      now: () => now,
    })
    const second = new BillingService({
      repository: new PostgresBillingRepository(pool, { tablePrefix: prefix, now: () => now }),
      catalog,
      enabled: false,
      now: () => now,
    })
    const organizationId = 'org-pg-inflight-seat'
    await first.syncSeatCount(organizationId, 1, 'pg-inflight-seed')
    await first.reserveSeat(organizationId, 'pg-inflight-member')

    // A Better Auth write can outlive any fixed lease. Keeping the hold active
    // until its after-hook/release is explicit prevents a late insert from
    // racing a newly admitted member past the limit.
    now += 2 * 60 * 60 * 1_000
    await expect(second.reserveSeat(organizationId, 'pg-inflight-third')).rejects.toMatchObject({ code: 'USAGE_LIMIT_EXCEEDED' })
    await expect(first.releaseSeat(organizationId, 'pg-inflight-member')).resolves.toMatchObject({ idempotent: false })
    await expect(second.reserveSeat(organizationId, 'pg-inflight-third')).resolves.toMatchObject({ idempotent: false })
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
