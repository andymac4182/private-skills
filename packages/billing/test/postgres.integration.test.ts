import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PostgresIdentityBillingAdmission } from '../../../apps/web/server/identity-infrastructure.js'
import { IDENTITY_ORGANIZATION_MUTATION_LOCK_KEY, seatOperationKey } from '../../../packages/identity/src/index.js'
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

/**
 * Expose the point at which a real Postgres transaction has reached the
 * organization usage-row lock. The test holds that row in another reserved
 * connection, starts both operations in a chosen order, and then releases it
 * so the database—not an in-memory scheduler—decides the serialized result.
 */
function usageLockBarrier(base: BillingPgPoolLike, usageTable: string): { pool: BillingPgPoolLike; waitForUsageLock(): Promise<void> } {
  const waiters: Array<() => void> = []
  const pool: BillingPgPoolLike = {
    query: <Row = Record<string, unknown>>(statement: string, parameters?: readonly unknown[]) => base.query<Row>(statement, parameters),
    connect: async () => {
      const client = await base.connect()
      return {
        query: async <Row = Record<string, unknown>>(statement: string, parameters?: readonly unknown[]) => {
          if (statement.includes(`FROM ${usageTable}`) && statement.includes('FOR UPDATE')) waiters.shift()?.()
          return client.query<Row>(statement, parameters)
        },
        release: () => client.release?.(),
      }
    },
  }
  return {
    pool,
    waitForUsageLock: () => new Promise<void>((resolve) => waiters.push(resolve)),
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

    const firstReopen = await first.reserveUsage('org-pg-reopen', { storageBytes: 40 }, 'pg-import-stable')
    expect(firstReopen).toMatchObject({ idempotent: false, reservationGeneration: 1 })
    await expect(first.reconcileUsage('org-pg-reopen', 'pg-import-stable', { storageBytes: 0 }, 'pg-import-release', firstReopen.reservationGeneration)).resolves.toMatchObject({ idempotent: false, reservationGeneration: 1 })
    const secondReopen = await second.reserveUsage('org-pg-reopen', { storageBytes: 40 }, 'pg-import-stable')
    expect(secondReopen).toMatchObject({ idempotent: false, reservationGeneration: 2 })
    await expect(second.usageSnapshot('org-pg-reopen')).resolves.toMatchObject({ usage: { storageBytes: 40 } })
    const usageBeforeStale = await second.usageSnapshot('org-pg-reopen')
    const staleCallback = Promise.resolve().then(() => first.reconcileUsage('org-pg-reopen', 'pg-import-stable', { storageBytes: 0 }, 'pg-import-release', firstReopen.reservationGeneration))
    await expect(staleCallback).rejects.toMatchObject({ code: 'STALE_RESERVATION_GENERATION', status: 409 })
    await expect(second.usageSnapshot('org-pg-reopen')).resolves.toEqual(usageBeforeStale)
    await expect(first.reconcileUsage('org-pg-reopen', 'pg-import-stable', { storageBytes: 0 }, 'pg-import-release', secondReopen.reservationGeneration)).resolves.toMatchObject({ idempotent: false, reservationGeneration: 2 })
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

    const firstAged = await service.reserveUsage(organizationId, { storageBytes: 40 }, 'pg-aged-stable')
    expect(firstAged).toMatchObject({ idempotent: false, reservationGeneration: 1 })
    await expect(service.reconcileUsage(organizationId, 'pg-aged-stable', { storageBytes: 0 }, 'pg-aged-release', firstAged.reservationGeneration)).resolves.toMatchObject({ idempotent: false, reservationGeneration: 1 })
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
    const secondAged = await service.reserveUsage(organizationId, { storageBytes: 40 }, 'pg-aged-stable')
    expect(secondAged).toMatchObject({ idempotent: false, reservationGeneration: 2 })
    await expect(service.reserveUsage(organizationId, { storageBytes: 40 }, 'pg-aged-stable')).resolves.toMatchObject({ idempotent: true })
    const agedBeforeStale = await service.usageSnapshot(organizationId)
    await expect(service.reconcileUsage(organizationId, 'pg-aged-stable', { storageBytes: 0 }, 'pg-aged-release', firstAged.reservationGeneration)).rejects.toMatchObject({ code: 'STALE_RESERVATION_GENERATION', status: 409 })
    await expect(service.usageSnapshot(organizationId)).resolves.toEqual(agedBeforeStale)
    await expect(service.findUsageOperation(organizationId, 'pg-aged-stable')).resolves.toMatchObject({ operationKey: 'pg-aged-stable', status: 'reserved', reservationGeneration: 2 })
  })

  it('durably restores exact released storage above a refilled cap and fences delayed zero callbacks', async () => {
    let now = NOW
    const catalog = planCatalog()
    const repository = new PostgresBillingRepository(pool, { tablePrefix: prefix, maxUsageOperations: 1, now: () => now })
    const service = new BillingService({ repository, catalog, enabled: true, now: () => now })
    const organizationId = 'org-pg-storage-restoration'
    const initial = await service.reserveUsage(organizationId, { storageBytes: 40 }, 'pg-storage-reservation')
    expect(initial.reservationGeneration).toBe(1)
    await service.reconcileUsage(organizationId, 'pg-storage-reservation', { storageBytes: 0 }, 'pg-storage-zero', initial.reservationGeneration)

    // A separate admission can refill the cap after the original zero. A
    // normal positive reserve is denied at this point, proving why recovery
    // must use the inverse seam rather than ordinary quota admission.
    await service.reserveUsage(organizationId, { storageBytes: 1_000 }, 'pg-storage-refill')
    await expect(service.reserveUsage(organizationId, { storageBytes: 1 }, 'pg-storage-would-not-fit')).rejects.toMatchObject({ code: 'USAGE_LIMIT_EXCEEDED', status: 429 })
    await expect(service.restoreUsage(organizationId, 'pg-storage-reservation', { storageBytes: 39 }, 'pg-storage-wrong-delta', initial.reservationGeneration!)).rejects.toMatchObject({ code: 'USAGE_RESTORATION_INVALID', status: 409 })
    await expect(service.restoreUsage(organizationId, 'pg-storage-reservation', { storageBytes: 40 }, 'pg-storage-wrong-generation', 2)).rejects.toMatchObject({ code: 'STALE_RESERVATION_GENERATION', status: 409 })

    const restored = await service.restoreUsage(organizationId, 'pg-storage-reservation', { storageBytes: 40 }, 'pg-storage-restore', initial.reservationGeneration!)
    expect(restored).toMatchObject({ idempotent: false, restoredFromGeneration: 1, reservationGeneration: 2, snapshot: { usage: { storageBytes: 1_040 } } })
    const persisted = await sql!.unsafe<Record<string, unknown>[]>(`SELECT status, reservation_generation::int AS reservation_generation, restoration FROM "${prefix}_usage_operations" WHERE organization_id = $1 AND operation_key = $2`, [organizationId, 'pg-storage-restore'])
    expect(persisted[0]).toMatchObject({ status: 'committed', reservation_generation: 2, restoration: { action: 'restored', reservationKey: 'pg-storage-reservation', fromGeneration: 1, toGeneration: 2, delta: { storageBytes: 40 } } })
    await expect(service.usageSnapshot(organizationId)).resolves.toMatchObject({ usage: { storageBytes: 1_040 } })
    await expect(service.reserveUsage(organizationId, { storageBytes: 1 }, 'pg-storage-future-admission')).rejects.toMatchObject({ code: 'USAGE_LIMIT_EXCEEDED', status: 429 })
    const usageBeforeDelayedZero = await service.usageSnapshot(organizationId)
    await expect(service.reconcileUsage(organizationId, 'pg-storage-reservation', { storageBytes: 0 }, 'pg-storage-zero', initial.reservationGeneration)).rejects.toMatchObject({ code: 'STALE_RESERVATION_GENERATION', status: 409 })
    await expect(service.usageSnapshot(organizationId)).resolves.toEqual(usageBeforeDelayedZero)

    // Release the independent refill so a harmless metric admission can age
    // the restoration operation out of the bounded recent window.
    await service.reconcileUsage(organizationId, 'pg-storage-refill', { storageBytes: 0 }, 'pg-storage-refill-release', 1)
    now += 1_000
    await service.reserveUsage(organizationId, { scans: 1 }, 'pg-storage-age')
    const bounded = await repository.read(organizationId)
    expect(bounded.usageOperations).toHaveLength(1)
    expect(bounded.usageOperations[0]?.operationKey).toBe('pg-storage-age')

    // A fresh repository instance exercises the durable exact-key path after
    // the restoration operation has aged out of the bounded read window.
    const restarted = new BillingService({
      repository: new PostgresBillingRepository(pool, { tablePrefix: prefix, maxUsageOperations: 1, now: () => now }),
      catalog,
      enabled: true,
      now: () => now,
    })
    const usageBeforeRestartedDelayedZero = await restarted.usageSnapshot(organizationId)
    await expect(restarted.reconcileUsage(organizationId, 'pg-storage-reservation', { storageBytes: 0 }, 'pg-storage-zero', initial.reservationGeneration)).rejects.toMatchObject({ code: 'STALE_RESERVATION_GENERATION', status: 409 })
    await expect(restarted.usageSnapshot(organizationId)).resolves.toEqual(usageBeforeRestartedDelayedZero)
    await expect(restarted.restoreUsage(organizationId, 'pg-storage-reservation', { storageBytes: 40 }, 'pg-storage-restore', initial.reservationGeneration!)).resolves.toMatchObject({ idempotent: true, restoredFromGeneration: 1, reservationGeneration: 2 })
    await expect(restarted.usageSnapshot(organizationId)).resolves.toEqual(usageBeforeRestartedDelayedZero)

    // The returned G2 is the only generation that may perform later cleanup.
    // Once that lifecycle is cleaned and reopened as G3, replaying the old
    // inverse is still a no-write result and cannot affect the new admission.
    await restarted.reconcileUsage(organizationId, 'pg-storage-reservation', { storageBytes: 0 }, 'pg-storage-cleanup', 2)
    await expect(restarted.reserveUsage(organizationId, { storageBytes: 40 }, 'pg-storage-reservation')).resolves.toMatchObject({ idempotent: false, reservationGeneration: 3 })
    const usageBeforeOldReplay = await restarted.usageSnapshot(organizationId)
    await expect(restarted.restoreUsage(organizationId, 'pg-storage-reservation', { storageBytes: 40 }, 'pg-storage-restore', 1)).resolves.toMatchObject({ idempotent: true, restoredFromGeneration: 1, reservationGeneration: 2 })
    await expect(restarted.usageSnapshot(organizationId)).resolves.toEqual(usageBeforeOldReplay)
    await expect(restarted.reconcileUsage(organizationId, 'pg-storage-reservation', { storageBytes: 0 }, 'pg-storage-zero', 1)).rejects.toMatchObject({ code: 'STALE_RESERVATION_GENERATION', status: 409 })
  })

  it('resolves storage recovery under a real usage-row lock in either operation order', async () => {
    let now = NOW
    const catalog = planCatalog()
    const baseService = new BillingService({
      repository: new PostgresBillingRepository(pool, { tablePrefix: prefix, maxUsageOperations: 1, now: () => now }),
      catalog,
      enabled: true,
      now: () => now,
    })
    const usageTable = `"${prefix}_usage"`

    async function runOrdered(
      organizationId: string,
      first: (service: BillingService) => Promise<unknown>,
      second: (service: BillingService) => Promise<unknown>,
    ): Promise<PromiseSettledResult<unknown>[]> {
      const barrier = usageLockBarrier(pool, usageTable)
      const firstService = new BillingService({
        repository: new PostgresBillingRepository(barrier.pool, { tablePrefix: prefix, maxUsageOperations: 1, now: () => now }),
        catalog,
        enabled: true,
        now: () => now,
      })
      const secondService = new BillingService({
        repository: new PostgresBillingRepository(barrier.pool, { tablePrefix: prefix, maxUsageOperations: 1, now: () => now }),
        catalog,
        enabled: true,
        now: () => now,
      })
      const holder = await sql!.reserve()
      let committed = false
      try {
        await holder.unsafe('BEGIN')
        await holder.unsafe(`SELECT organization_id FROM ${usageTable} WHERE organization_id = $1 FOR UPDATE`, [organizationId])
        const firstResult = first(firstService)
        await barrier.waitForUsageLock()
        const secondResult = second(secondService)
        await barrier.waitForUsageLock()
        await holder.unsafe('COMMIT')
        committed = true
        return await Promise.allSettled([firstResult, secondResult])
      } finally {
        if (!committed) {
          try { await holder.unsafe('ROLLBACK') } catch { /* preserve the test failure */ }
        }
        await holder.release()
      }
    }

    const fencedOrganizationId = 'org-pg-storage-resolution-fenced'
    const fencedAdmission = await baseService.reserveUsage(fencedOrganizationId, { storageBytes: 40 }, 'pg-resolution-fenced-reservation')
    const fencedResults = await runOrdered(
      fencedOrganizationId,
      (service) => service.resolveStorageRecovery(fencedOrganizationId, 'pg-resolution-fenced-reservation', { storageBytes: 40 }, 'pg-resolution-fenced-operation', fencedAdmission.reservationGeneration!),
      (service) => service.reconcileUsage(fencedOrganizationId, 'pg-resolution-fenced-reservation', { storageBytes: 0 }, 'pg-resolution-fenced-zero', fencedAdmission.reservationGeneration!),
    )
    expect(fencedResults[0]).toMatchObject({ status: 'fulfilled', value: { action: 'fenced', idempotent: false, restoredFromGeneration: 1, reservationGeneration: 2 } })
    expect(fencedResults[1]).toMatchObject({ status: 'rejected', reason: { code: 'STALE_RESERVATION_GENERATION', status: 409 } })
    const persistedFence = await sql!.unsafe<Record<string, unknown>[]>(`SELECT status, reservation_generation::int AS reservation_generation, restoration FROM "${prefix}_usage_operations" WHERE organization_id = $1 AND operation_key = $2`, [fencedOrganizationId, 'pg-resolution-fenced-operation'])
    expect(persistedFence[0]).toMatchObject({ status: 'committed', reservation_generation: 2, restoration: { action: 'fenced', reservationKey: 'pg-resolution-fenced-reservation', fromGeneration: 1, toGeneration: 2, delta: { storageBytes: 40 } } })
    await expect(baseService.usageSnapshot(fencedOrganizationId)).resolves.toMatchObject({ usage: { storageBytes: 40 } })

    const measuredOrganizationId = 'org-pg-storage-resolution-measured'
    const measuredAdmission = await baseService.reserveUsage(measuredOrganizationId, { storageBytes: 40 }, 'pg-resolution-measured-reservation')
    await baseService.reconcileUsage(measuredOrganizationId, 'pg-resolution-measured-reservation', { storageBytes: 40 }, 'pg-resolution-measured-actual', measuredAdmission.reservationGeneration!)
    await expect(baseService.resolveStorageRecovery(measuredOrganizationId, 'pg-resolution-measured-reservation', { storageBytes: 40 }, 'pg-resolution-measured-operation', measuredAdmission.reservationGeneration!)).resolves.toMatchObject({ action: 'fenced', idempotent: false, restoredFromGeneration: 1, reservationGeneration: 2 })
    await expect(baseService.reconcileUsage(measuredOrganizationId, 'pg-resolution-measured-reservation', { storageBytes: 0 }, 'pg-resolution-measured-cleanup', 2)).resolves.toMatchObject({ idempotent: false, reservationGeneration: 2 })
    await expect(baseService.usageSnapshot(measuredOrganizationId)).resolves.toMatchObject({ usage: { storageBytes: 0 } })
    await expect(baseService.reconcileUsage(measuredOrganizationId, 'pg-resolution-measured-reservation', { storageBytes: 0 }, 'pg-resolution-measured-late-zero', 1)).rejects.toMatchObject({ code: 'STALE_RESERVATION_GENERATION', status: 409 })

    const mismatchedOrganizationId = 'org-pg-storage-resolution-mismatched'
    const mismatchedAdmission = await baseService.reserveUsage(mismatchedOrganizationId, { storageBytes: 40 }, 'pg-resolution-mismatched-reservation')
    await baseService.reconcileUsage(mismatchedOrganizationId, 'pg-resolution-mismatched-reservation', { storageBytes: 30 }, 'pg-resolution-mismatched-actual', mismatchedAdmission.reservationGeneration!)
    const mismatchedBefore = await baseService.usageSnapshot(mismatchedOrganizationId)
    await expect(baseService.resolveStorageRecovery(mismatchedOrganizationId, 'pg-resolution-mismatched-reservation', { storageBytes: 40 }, 'pg-resolution-mismatched-operation', mismatchedAdmission.reservationGeneration!)).rejects.toMatchObject({ code: 'USAGE_RESTORATION_INVALID', status: 409 })
    await expect(baseService.usageSnapshot(mismatchedOrganizationId)).resolves.toEqual(mismatchedBefore)
    await expect(baseService.findUsageOperation(mismatchedOrganizationId, 'pg-resolution-mismatched-reservation')).resolves.toMatchObject({ status: 'committed', reservationGeneration: 1, reconciled: { storageBytes: 30 } })

    // Finish the fenced lifecycle, reopen it, and age the resolution out of
    // the bounded read window before replaying it through a new repository.
    await baseService.reconcileUsage(fencedOrganizationId, 'pg-resolution-fenced-reservation', { storageBytes: 0 }, 'pg-resolution-fenced-cleanup', 2)
    await baseService.reserveUsage(fencedOrganizationId, { storageBytes: 40 }, 'pg-resolution-fenced-reservation')
    now += 1_000
    await baseService.reserveUsage(fencedOrganizationId, { scans: 1 }, 'pg-resolution-fenced-age')
    const fencedRestarted = new BillingService({
      repository: new PostgresBillingRepository(pool, { tablePrefix: prefix, maxUsageOperations: 1, now: () => now }),
      catalog,
      enabled: true,
      now: () => now,
    })
    const fencedBeforeReplay = await fencedRestarted.usageSnapshot(fencedOrganizationId)
    await expect(fencedRestarted.resolveStorageRecovery(fencedOrganizationId, 'pg-resolution-fenced-reservation', { storageBytes: 40 }, 'pg-resolution-fenced-operation', 1)).resolves.toMatchObject({ action: 'fenced', idempotent: true, restoredFromGeneration: 1, reservationGeneration: 2 })
    await expect(fencedRestarted.usageSnapshot(fencedOrganizationId)).resolves.toEqual(fencedBeforeReplay)

    const restoredOrganizationId = 'org-pg-storage-resolution-restored'
    const restoredAdmission = await baseService.reserveUsage(restoredOrganizationId, { storageBytes: 40 }, 'pg-resolution-restored-reservation')
    const restoredResults = await runOrdered(
      restoredOrganizationId,
      (service) => service.reconcileUsage(restoredOrganizationId, 'pg-resolution-restored-reservation', { storageBytes: 0 }, 'pg-resolution-restored-zero', restoredAdmission.reservationGeneration!),
      (service) => service.resolveStorageRecovery(restoredOrganizationId, 'pg-resolution-restored-reservation', { storageBytes: 40 }, 'pg-resolution-restored-operation', restoredAdmission.reservationGeneration!),
    )
    expect(restoredResults[0]).toMatchObject({ status: 'fulfilled', value: { reservationGeneration: 1 } })
    expect(restoredResults[1]).toMatchObject({ status: 'fulfilled', value: { action: 'restored', idempotent: false, restoredFromGeneration: 1, reservationGeneration: 2 } })
    await expect(baseService.usageSnapshot(restoredOrganizationId)).resolves.toMatchObject({ usage: { storageBytes: 40 } })
    await expect(baseService.reconcileUsage(restoredOrganizationId, 'pg-resolution-restored-reservation', { storageBytes: 0 }, 'pg-resolution-restored-late-zero', 1)).rejects.toMatchObject({ code: 'STALE_RESERVATION_GENERATION', status: 409 })

    await baseService.reconcileUsage(restoredOrganizationId, 'pg-resolution-restored-reservation', { storageBytes: 0 }, 'pg-resolution-restored-cleanup', 2)
    await baseService.reserveUsage(restoredOrganizationId, { storageBytes: 40 }, 'pg-resolution-restored-reservation')
    now += 1_000
    await baseService.reserveUsage(restoredOrganizationId, { scans: 1 }, 'pg-resolution-restored-age')
    const restoredRestarted = new BillingService({
      repository: new PostgresBillingRepository(pool, { tablePrefix: prefix, maxUsageOperations: 1, now: () => now }),
      catalog,
      enabled: true,
      now: () => now,
    })
    const restoredBeforeReplay = await restoredRestarted.usageSnapshot(restoredOrganizationId)
    await expect(restoredRestarted.resolveStorageRecovery(restoredOrganizationId, 'pg-resolution-restored-reservation', { storageBytes: 40 }, 'pg-resolution-restored-operation', 1)).resolves.toMatchObject({ action: 'restored', idempotent: true, restoredFromGeneration: 1, reservationGeneration: 2 })
    await expect(restoredRestarted.usageSnapshot(restoredOrganizationId)).resolves.toEqual(restoredBeforeReplay)
  })

  it('scopes operation constraints to the target schema when prefixes repeat', async () => {
    const schemaBase = `billing_it_schema_${process.pid}_${Math.floor(Math.random() * 10_000)}`
    const schemas = [`${schemaBase}_a`, `${schemaBase}_b`]
    const generationConstraint = `${prefix}_op_generation_check`
    try {
      for (const schema of schemas) await sql!.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      for (const schema of schemas) await sql!.unsafe(`CREATE SCHEMA "${schema}"`)

      for (const schema of schemas) {
        const client = await sql!.reserve()
        try {
          await client.unsafe(`SET search_path TO "${schema}", public`)
          await client.unsafe(billingPostgresSchemaSql(prefix))
        } finally {
          await client.release()
        }
      }

      const constraints = await sql!.unsafe<{ schema_name: string; table_name: string }[]>(
        `SELECT target_schema.nspname AS schema_name, target_table.relname AS table_name
           FROM pg_constraint AS existing_constraint
           JOIN pg_class AS target_table ON target_table.oid = existing_constraint.conrelid
           JOIN pg_namespace AS target_schema ON target_schema.oid = target_table.relnamespace
          WHERE existing_constraint.conname = $1
          ORDER BY target_schema.nspname`,
        [generationConstraint],
      )
      expect(constraints.filter(({ schema_name }) => schemas.includes(schema_name))).toEqual(
        schemas.map((schema) => ({ schema_name: schema, table_name: `${prefix}_usage_operations` })),
      )
    } finally {
      for (const schema of schemas) await sql!.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    }
  })

  it('reruns safely when an empty search-path schema precedes the resolved table schema', async () => {
    const schemaBase = `billing_it_search_path_${process.pid}_${Math.floor(Math.random() * 10_000)}`
    const emptySchema = `${schemaBase}_empty`
    const existingSchema = `${schemaBase}_existing`
    try {
      await sql!.unsafe(`DROP SCHEMA IF EXISTS "${emptySchema}" CASCADE`)
      await sql!.unsafe(`DROP SCHEMA IF EXISTS "${existingSchema}" CASCADE`)
      await sql!.unsafe(`CREATE SCHEMA "${emptySchema}"`)
      await sql!.unsafe(`CREATE SCHEMA "${existingSchema}"`)

      const existingClient = await sql!.reserve()
      try {
        await existingClient.unsafe(`SET search_path TO "${existingSchema}", public`)
        await existingClient.unsafe(billingPostgresSchemaSql(prefix))
      } finally {
        await existingClient.unsafe('SET search_path TO public')
        await existingClient.release()
      }

      const emptyFirstClient = await sql!.reserve()
      try {
        await emptyFirstClient.unsafe(`SET search_path TO "${emptySchema}", "${existingSchema}", public`)
        await emptyFirstClient.unsafe(billingPostgresSchemaSql(prefix))
        await emptyFirstClient.unsafe(billingPostgresSchemaSql(prefix))
      } finally {
        await emptyFirstClient.unsafe('SET search_path TO public')
        await emptyFirstClient.release()
      }

      const constraints = await sql!.unsafe<{ schema_name: string; constraint_name: string }[]>(
        `SELECT target_schema.nspname AS schema_name, existing_constraint.conname AS constraint_name
           FROM pg_constraint AS existing_constraint
           JOIN pg_class AS target_table ON target_table.oid = existing_constraint.conrelid
           JOIN pg_namespace AS target_schema ON target_schema.oid = target_table.relnamespace
          WHERE target_schema.nspname = $1
            AND target_table.relname = $2
            AND existing_constraint.conname IN ($3, $4)
          ORDER BY existing_constraint.conname`,
        [
          existingSchema,
          `${prefix}_usage_operations`,
          `${prefix}_op_generation_check`,
          `${prefix}_operations_status_check`,
        ],
      )
      expect(constraints).toEqual([
        { schema_name: existingSchema, constraint_name: `${prefix}_op_generation_check` },
        { schema_name: existingSchema, constraint_name: `${prefix}_operations_status_check` },
      ])
    } finally {
      await sql!.unsafe(`DROP SCHEMA IF EXISTS "${emptySchema}" CASCADE`)
      await sql!.unsafe(`DROP SCHEMA IF EXISTS "${existingSchema}" CASCADE`)
    }
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

  it('durably recovers an aborted Better Auth hold only with matching proof', async () => {
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
    const organizationId = 'org-pg-seat-recovery'
    const proof = { kind: 'known-failure' as const, reference: 'better-auth-member-write-err-pg' }
    await first.reserveSeat(organizationId, 'pg-aborted-member', { subjectKey: true })
    await expect(second.activeSeatReservations(organizationId)).resolves.toMatchObject([
      { operationKey: 'pg-aborted-member', status: 'active', subjectKey: true },
    ])
    await expect(second.releaseSeatAfterFailure(organizationId, 'pg-aborted-member', proof)).resolves.toMatchObject({
      idempotent: false,
      reservation: { operationKey: 'pg-aborted-member', status: 'settled', committed: false, recoveryProof: proof },
    })
    await expect(first.releaseSeatAfterFailure(organizationId, 'pg-aborted-member', proof)).resolves.toMatchObject({ idempotent: true })
    await expect(first.usageSnapshot(organizationId)).resolves.toMatchObject({ usage: { seats: 0 } })

    await first.reserveSeat(organizationId, 'pg-committed-member', { subjectKey: true })
    await first.commitSeat(organizationId, 'pg-committed-member')
    await expect(second.releaseSeatAfterFailure(organizationId, 'pg-committed-member', { kind: 'writer-terminated', reference: 'writer-terminated-pg' })).rejects.toMatchObject({ code: 'SEAT_RESERVATION_SETTLED' })
  })

  it('fences recovery behind Better Auth writes and rechecks the committed identity row', async () => {
    const catalog = planCatalog()
    const service = new BillingService({
      repository: new PostgresBillingRepository(pool, { tablePrefix: prefix, now: () => NOW }),
      catalog,
      enabled: false,
      now: () => NOW,
    })
    const schema = `billing_identity_recovery_${process.pid}_${Math.floor(Math.random() * 10_000)}`
    const quotedSchema = `"${schema}"`
    const memberTable = `${quotedSchema}."member"`
    const invitationTable = `${quotedSchema}."invitation"`
    await sql!.unsafe(`CREATE SCHEMA ${quotedSchema}`)
    await sql!.unsafe(`CREATE TABLE ${memberTable} ("id" text PRIMARY KEY, "organizationId" text NOT NULL, "userId" text NOT NULL, "role" text NOT NULL)`)
    await sql!.unsafe(`CREATE TABLE ${invitationTable} ("id" text PRIMARY KEY, "organizationId" text NOT NULL, "status" text NOT NULL, "expiresAt" timestamptz NOT NULL)`)

    const organizationId = 'org-pg-recovery-fence'
    const subjectId = 'member-pg-recovery-fence'
    const operationKey = await seatOperationKey('member', organizationId, subjectId)
    const proof = { kind: 'writer-terminated' as const, reference: 'operator-termination-pg-fence' }
    await service.reserveSeat(organizationId, operationKey, { subjectKey: true })
    const identityPool = pool
    const admission = new PostgresIdentityBillingAdmission(service, identityPool, schema)

    // The runtime's Better Auth request holds this same transaction lock
    // across its before hook, adapter write, and after hook. Start a writer
    // that owns it, then prove recovery cannot inspect a partial snapshot.
    const writer = await identityPool.connect()
    let writerTransaction = false
    try {
      await writer.query('BEGIN')
      writerTransaction = true
      await writer.query('SELECT pg_advisory_xact_lock($1)', [IDENTITY_ORGANIZATION_MUTATION_LOCK_KEY])
      let recoveryConnected!: () => void
      const recoveryStarted = new Promise<void>((resolve) => { recoveryConnected = resolve })
      const recoveryPool: BillingPgPoolLike = {
        query: <Row = Record<string, unknown>>(statement: string, parameters?: readonly unknown[]) => identityPool.query<Row>(statement, parameters),
        connect: async () => {
          recoveryConnected()
          return identityPool.connect()
        },
      }
      const recoveryAdmission = new PostgresIdentityBillingAdmission(service, recoveryPool, schema)
      const recovery = recoveryAdmission.recoverFailedSeat({ organizationId, operationKey, subjectKind: 'member', subjectId, proof })
      await recoveryStarted
      // The advisory lock is held by the writer, so this operation remains
      // pending until the writer transaction commits or rolls back.
      const beforeCommit = await Promise.race([
        recovery.then(() => 'finished', () => 'finished'),
        Promise.resolve('still-waiting'),
      ])
      expect(beforeCommit).toBe('still-waiting')
      await writer.query(`INSERT INTO ${memberTable} ("id", "organizationId", "userId", "role") VALUES ($1, $2, $3, $4)`, [subjectId, organizationId, 'user-pg-recovery-fence', 'reader'])
      await writer.query('COMMIT')
      writerTransaction = false
      await expect(recovery).rejects.toMatchObject({ code: 'SEAT_RECOVERY_CONFLICT' })
      // A committed identity row cannot be released by the recovery path.
      await expect(service.usageSnapshot(organizationId)).resolves.toMatchObject({ usage: { seats: 1 } })

      // A failed writer leaves no identity row. Once the same platform lock is
      // available, the exact subject check permits one durable release.
      await sql!.unsafe(`DELETE FROM ${memberTable} WHERE "organizationId" = $1 AND "id" = $2`, [organizationId, subjectId])
      const failedOrganizationId = 'org-pg-recovery-failed'
      const failedSubjectId = 'member-pg-recovery-failed'
      const failedOperationKey = await seatOperationKey('member', failedOrganizationId, failedSubjectId)
      await service.reserveSeat(failedOrganizationId, failedOperationKey, { subjectKey: true })
      await expect(admission.recoverFailedSeat({
        organizationId: failedOrganizationId,
        operationKey: failedOperationKey,
        subjectKind: 'member',
        subjectId: failedSubjectId,
        proof,
      })).resolves.toMatchObject({
        reservation: { operationKey: failedOperationKey, status: 'settled', committed: false, recoveryProof: proof },
      })
      await expect(service.usageSnapshot(failedOrganizationId)).resolves.toMatchObject({ usage: { seats: 0 } })
    } finally {
      if (writerTransaction) await writer.query('ROLLBACK').catch(() => undefined)
      await writer.release?.()
      await sql!.unsafe(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`)
    }
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
