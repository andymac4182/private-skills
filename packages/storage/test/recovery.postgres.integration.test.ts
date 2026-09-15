import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BillingService,
  PostgresBillingRepository,
  billingPostgresSchemaSql,
  createPlanCatalog,
  type BillingPgPoolLike,
  type PlanDefinition,
  type PlanId,
} from "../../billing/src/index.js";
import {
  PostgresStateRepository,
  defaultRegistryState,
  postgresStateSchemaSql,
  type PgPoolLike,
} from "../../database/src/index.js";
import type {
  BillingUsageAdmission,
  Digest,
  MeteredUsageDelta,
  MeteredUsageReservation,
  MeteredStorageRecoveryResolution,
  MeteredUsageRestoration,
  RecoverableBlobStore,
  RegistryState,
  StateRepository,
  StorageAttempt,
  StorageObjectInspection,
  StoredBlob,
} from "../../contracts/src/index.js";
import {
  StorageRecoveryService,
  digestBytes,
  type StorageRecoveryRequest,
} from "../src/index.js";

function localDatabaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") return undefined;
    return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname) ? value : undefined;
  } catch {
    return undefined;
  }
}

const DATABASE_URL = localDatabaseUrl(process.env.PSKILLS_BILLING_POSTGRES_URL);
const describePostgres = DATABASE_URL ? describe : describe.skip;
const NOW = Date.parse("2026-09-15T00:00:00.000Z");
const ORGANIZATION = "org-storage-recovery-pg";
const RESERVATION_KEY = "pg-storage-recovery-reservation";
const REFILL_KEY = "pg-storage-recovery-refill";
const ZERO_KEY = "pg-storage-recovery-zero";
const RESTORE_KEY = "private-skills:storage-recovery-restore:attempt-pg-storage-recovery:generation:1";
const OBJECT_KEY = "sealed/pg-storage-recovery-object";
const BYTES = new TextEncoder().encode("durable storage recovery bytes");

type SqlClient = ReturnType<typeof postgres>;
type SqlExecutor = Pick<SqlClient, "unsafe">;

async function query<Row = Record<string, unknown>>(
  executor: SqlExecutor,
  statement: string,
  parameters?: readonly unknown[],
): Promise<{ rows: Row[]; rowCount: number }> {
  const values = parameters === undefined ? undefined : [...parameters] as never;
  const rows = await executor.unsafe<Row[]>(statement, values);
  return { rows: Array.from(rows), rowCount: rows.count };
}

class MemoryBlobStore implements RecoverableBlobStore {
  readonly objects = new Map<string, Uint8Array>();

  allocateObjectKey(): string {
    return OBJECT_KEY;
  }

  async put(bytes: Uint8Array): Promise<StoredBlob> {
    return this.putAtKey(OBJECT_KEY, bytes);
  }

  async putAtKey(key: string, bytes: Uint8Array): Promise<StoredBlob> {
    const digest = await digestBytes(bytes);
    const existing = this.objects.get(key);
    if (existing && (await digestBytes(existing)) !== digest) throw new Error("stable key conflict");
    this.objects.set(key, bytes.slice());
    return { key, digest, size: bytes.byteLength };
  }

  async get(key: string): Promise<Uint8Array> {
    const value = this.objects.get(key);
    if (!value) throw new Error("not found");
    return value.slice();
  }

  async remove(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async inspectObject(key: string): Promise<StorageObjectInspection> {
    const value = this.objects.get(key);
    if (!value) return { state: "absent", key };
    return { state: "present", key, digest: await digestBytes(value), size: value.byteLength };
  }

  async confirmWriteTerminated(): Promise<boolean> {
    return true;
  }
}

function planCatalog() {
  const plans: PlanDefinition[] = [{
    id: "free" as PlanId,
    label: "Free",
    description: "Bounded storage recovery integration plan.",
    limits: { seats: 2, storageBytes: 100, scansPerMonth: 10, eveCostCentsPerMonth: 10 },
    public: true,
  }];
  return createPlanCatalog({ plans });
}

function referencedSkill(digest: Digest) {
  return {
    id: "pg-late-reference",
    organizationId: ORGANIZATION,
    name: "@team/late-reference",
    skillName: "late-reference",
    version: "1.0.0",
    description: "late storage recovery reference",
    artifact: { key: OBJECT_KEY, digest, size: BYTES.byteLength },
    state: "approved" as const,
    policyRevision: "policy-initial",
    createdAt: "2026-09-15T00:00:00.000Z",
    provenance: { kind: "native" as const },
    fileCount: 1,
    scanIds: [],
  };
}

function attempt(digest: Digest): StorageAttempt {
  return {
    id: "attempt-pg-storage-recovery",
    organizationId: ORGANIZATION,
    reservationKey: RESERVATION_KEY,
    digest,
    size: BYTES.byteLength,
    state: "orphaned",
    reservationGeneration: 1,
    createdAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-15T00:00:00.000Z",
    objectKey: OBJECT_KEY,
  };
}

function request(): StorageRecoveryRequest {
  return {
    organizationId: ORGANIZATION,
    attemptId: "attempt-pg-storage-recovery",
    actor: {
      organizationId: ORGANIZATION,
      subject: "platform-operator",
      capability: "private-skills:storage-recovery-operator",
      scopes: ["storage:recovery"],
    },
    proof: {
      kind: "known-failure",
      reference: "operator-record-pg-storage-recovery",
    },
  };
}

function recoveryRequestFor(organizationId: string, attemptId: string): StorageRecoveryRequest {
  return {
    organizationId,
    attemptId,
    actor: {
      organizationId,
      subject: "platform-operator",
      capability: "private-skills:storage-recovery-operator",
      scopes: ["storage:recovery"],
    },
    proof: {
      kind: "known-failure",
      reference: "operator-record-pg-storage-recovery",
    },
    resume: true,
  };
}

function attemptFor(
  digest: Digest,
  organizationId: string,
  attemptId: string,
  reservationKey: string,
  objectKey: string,
): StorageAttempt {
  return {
    ...attempt(digest),
    id: attemptId,
    organizationId,
    reservationKey,
    objectKey,
    billingCorrection: "release-pending",
  };
}

function referencedSkillFor(
  digest: Digest,
  organizationId: string,
  id: string,
  objectKey: string,
) {
  return {
    ...referencedSkill(digest),
    id,
    organizationId,
    artifact: { key: objectKey, digest, size: BYTES.byteLength },
  };
}

/**
 * Bridges the real billing ledger to the storage recovery service while
 * modelling the late metadata writer and one lost restore response. The
 * billing calls themselves remain the PostgreSQL-backed BillingService.
 */
class RecoveryBillingBridge implements BillingUsageAdmission {
  private lateReferenceAdded = false;
  private lostRestoreResponse: boolean;
  private lostResolutionResponse: boolean;

  constructor(
    private readonly billing: BillingService,
    private readonly repository: StateRepository,
    private readonly digest: Digest,
    options: { loseRestoreResponse: boolean; loseResolutionResponse?: boolean; sharedReferenceState?: { added: boolean } },
  ) {
    this.lostRestoreResponse = options.loseRestoreResponse;
    this.lostResolutionResponse = options.loseResolutionResponse === true;
    this.referenceState = options.sharedReferenceState ?? { added: false };
  }

  private readonly referenceState: { added: boolean };

  status(): { enabled: boolean } {
    return { enabled: this.billing.status().enabled };
  }

  reserveUsage(organizationId: string, delta: MeteredUsageDelta, operationKey: string): Promise<MeteredUsageReservation> {
    return this.billing.reserveUsage(organizationId, delta, operationKey);
  }

  async reconcileUsage(
    organizationId: string,
    reservationKey: string,
    actual: MeteredUsageDelta,
    operationKey: string,
    reservationGeneration?: number,
  ): Promise<unknown> {
    const result = await this.billing.reconcileUsage(organizationId, reservationKey, actual, operationKey, reservationGeneration);
    if (reservationKey === RESERVATION_KEY && actual.storageBytes === 0 && !this.referenceState.added && !this.lateReferenceAdded) {
      this.lateReferenceAdded = true;
      await this.billing.reserveUsage(ORGANIZATION, { storageBytes: 100 }, REFILL_KEY);
      await this.repository.transaction(ORGANIZATION, (state) => {
        state.skills.push(referencedSkill(this.digest));
      });
      this.referenceState.added = true;
    }
    return result;
  }

  async restoreUsage(
    organizationId: string,
    reservationKey: string,
    delta: { storageBytes: number },
    operationKey: string,
    reservationGeneration: number,
  ): Promise<MeteredUsageRestoration> {
    const result = await this.billing.restoreUsage(organizationId, reservationKey, delta, operationKey, reservationGeneration);
    if (this.lostRestoreResponse) {
      this.lostRestoreResponse = false;
      throw new Error("billing restoration response lost");
    }
    return result;
  }

  async resolveStorageRecovery(
    organizationId: string,
    reservationKey: string,
    delta: { storageBytes: number },
    operationKey: string,
    reservationGeneration: number,
  ): Promise<MeteredStorageRecoveryResolution> {
    const result = await this.billing.resolveStorageRecovery(
      organizationId,
      reservationKey,
      delta,
      operationKey,
      reservationGeneration,
    );
    if (this.lostResolutionResponse) {
      this.lostResolutionResponse = false;
      throw new Error("billing storage recovery resolution response lost");
    }
    return result;
  }
}

describePostgres("integrated PostgreSQL storage recovery and billing compensation", () => {
  let sql: SqlClient | undefined;
  let billingPool: BillingPgPoolLike;
  let statePool: PgPoolLike;
  let billingPrefix: string;
  let stateTable: string;

  beforeAll(async () => {
    sql = postgres(DATABASE_URL!, { max: 8 });
    billingPool = {
      query: <Row = Record<string, unknown>>(statement: string, parameters?: readonly unknown[]) => query<Row>(sql!, statement, parameters),
      connect: async () => {
        const reserved = await sql!.reserve();
        return {
          query: <Row = Record<string, unknown>>(statement: string, parameters?: readonly unknown[]) => query<Row>(reserved, statement, parameters),
          release: () => reserved.release(),
        };
      },
    };
    statePool = billingPool;
    billingPrefix = `storage_recovery_${process.pid}_${Math.floor(Math.random() * 10_000)}`;
    stateTable = `${billingPrefix}_registry`;
    await billingPool.query(postgresStateSchemaSql(stateTable));
    await billingPool.query(billingPostgresSchemaSql(billingPrefix));
  });

  afterAll(async () => {
    if (!sql) return;
    try {
      await sql.unsafe(`DROP TABLE IF EXISTS "${billingPrefix}_usage_operations", "${billingPrefix}_webhook_events", "${billingPrefix}_subscriptions", "${billingPrefix}_customers", "${billingPrefix}_usage", "${stateTable}"`);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it("runs recovery through PostgreSQL BillingService across G1, G2, and later cleanup", async () => {
    const digest = await digestBytes(BYTES);
    const stateRepository = new PostgresStateRepository(statePool, {
      tableName: stateTable,
      autoMigrate: true,
      stateFactory: () => defaultRegistryState({ production: false, allowUnscanned: true }),
    });
    const billing = new BillingService({
      repository: new PostgresBillingRepository(billingPool, { tablePrefix: billingPrefix, maxUsageOperations: 1, now: () => NOW }),
      catalog: planCatalog(),
      enabled: true,
      now: () => NOW,
    });
    await stateRepository.transaction(ORGANIZATION, (state) => {
      state.storageAttempts = [attempt(digest)];
    });
    await billing.reserveUsage(ORGANIZATION, { storageBytes: BYTES.byteLength }, RESERVATION_KEY);

    const blobs = new MemoryBlobStore();
    const sharedReferenceState = { added: false };
    const firstBridge = new RecoveryBillingBridge(billing, stateRepository, digest, {
      loseRestoreResponse: true,
      sharedReferenceState,
    });
    const firstRecovery = new StorageRecoveryService({
      repository: stateRepository,
      blobs,
      billing: firstBridge,
      verifyProof: () => true,
    });

    const first = await firstRecovery.recover(request());
    expect(first).toMatchObject({ status: "retained", reason: "billing-failed" });
    expect(await billing.usageSnapshot(ORGANIZATION)).toMatchObject({ usage: { storageBytes: 100 + BYTES.byteLength } });
    expect(await stateRepository.read(ORGANIZATION)).toMatchObject({
      storageAttempts: [{ state: "orphaned", reservationGeneration: 1, billingCorrection: "restore-pending" }],
    });

    // A fresh service and bridge stand in for a host restart. The exact
    // restoration row remains replayable even with maxUsageOperations: 1.
    const restartedBilling = new BillingService({
      repository: new PostgresBillingRepository(billingPool, { tablePrefix: billingPrefix, maxUsageOperations: 1, now: () => NOW }),
      catalog: planCatalog(),
      enabled: true,
      now: () => NOW,
    });
    const restartedBridge = new RecoveryBillingBridge(restartedBilling, stateRepository, digest, {
      loseRestoreResponse: false,
      sharedReferenceState,
    });
    const restartedRecovery = new StorageRecoveryService({
      repository: stateRepository,
      blobs,
      billing: restartedBridge,
      verifyProof: () => true,
    });
    const replayed = await restartedRecovery.recover(request());
    expect(replayed).toMatchObject({ status: "retained", reason: "billing-restored" });
    expect(await restartedBilling.usageSnapshot(ORGANIZATION)).toMatchObject({ usage: { storageBytes: 100 + BYTES.byteLength } });
    expect(await stateRepository.read(ORGANIZATION)).toMatchObject({
      storageAttempts: [{ state: "orphaned", reservationGeneration: 2 }],
    });
    expect((await stateRepository.read(ORGANIZATION)).storageAttempts?.[0]?.billingCorrection).toBeUndefined();

    await expect(restartedBilling.reconcileUsage(ORGANIZATION, RESERVATION_KEY, { storageBytes: 0 }, ZERO_KEY, 1)).rejects.toMatchObject({ code: "STALE_RESERVATION_GENERATION", status: 409 });
    await expect(restartedBilling.usageSnapshot(ORGANIZATION)).resolves.toMatchObject({ usage: { storageBytes: 100 + BYTES.byteLength } });

    await stateRepository.transaction(ORGANIZATION, (state) => {
      state.skills = [];
    });
    const cleaned = await restartedRecovery.recover(request());
    expect(cleaned).toMatchObject({ status: "released", inspection: "absent", billing: "reconciled" });
    expect(await restartedBilling.usageSnapshot(ORGANIZATION)).toMatchObject({ usage: { storageBytes: 100 } });

    await restartedBilling.reconcileUsage(ORGANIZATION, REFILL_KEY, { storageBytes: 0 }, `${REFILL_KEY}:release`, 1);
    await expect(restartedBilling.reserveUsage(ORGANIZATION, { storageBytes: BYTES.byteLength }, RESERVATION_KEY)).resolves.toMatchObject({ idempotent: false, reservationGeneration: 3 });
    const usageBeforeOldCallbacks = await restartedBilling.usageSnapshot(ORGANIZATION);
    await expect(restartedBilling.reconcileUsage(ORGANIZATION, RESERVATION_KEY, { storageBytes: 0 }, ZERO_KEY, 1)).rejects.toMatchObject({ code: "STALE_RESERVATION_GENERATION", status: 409 });
    await expect(restartedBilling.restoreUsage(ORGANIZATION, RESERVATION_KEY, { storageBytes: BYTES.byteLength }, RESTORE_KEY, 1)).resolves.toMatchObject({ idempotent: true, restoredFromGeneration: 1, reservationGeneration: 2 });
    await expect(restartedBilling.usageSnapshot(ORGANIZATION)).resolves.toEqual(usageBeforeOldCallbacks);
  });

  it("uses the PostgreSQL storage recovery resolver for B-only before/after-zero crashes", async () => {
    const digest = await digestBytes(BYTES);
    const stateRepository = new PostgresStateRepository(statePool, {
      tableName: stateTable,
      autoMigrate: true,
      stateFactory: () => defaultRegistryState({ production: false, allowUnscanned: true }),
    });
    const blobs = new MemoryBlobStore();
    const createBilling = () => new BillingService({
      repository: new PostgresBillingRepository(billingPool, { tablePrefix: billingPrefix, maxUsageOperations: 1, now: () => NOW }),
      catalog: planCatalog(),
      enabled: true,
      now: () => NOW,
    });

    // B starts after A's durable release intent, but before A's external zero.
    // The resolver must fence G1 without changing the still-present charge.
    const beforeOrganization = "org-storage-recovery-pg-before-zero";
    const beforeAttemptId = "attempt-pg-storage-recovery-before-zero";
    const beforeReservationKey = "pg-storage-recovery-before-zero";
    const beforeObjectKey = "sealed/pg-storage-recovery-before-zero";
    const beforeBilling = createBilling();
    const beforeAdmission = await beforeBilling.reserveUsage(beforeOrganization, { storageBytes: BYTES.byteLength }, beforeReservationKey);
    expect(beforeAdmission.reservationGeneration).toBe(1);
    await stateRepository.transaction(beforeOrganization, (state) => {
      state.storageAttempts = [attemptFor(digest, beforeOrganization, beforeAttemptId, beforeReservationKey, beforeObjectKey)];
      state.skills.push(referencedSkillFor(digest, beforeOrganization, "skill-pg-before-zero", beforeObjectKey));
    });
    const fencedRecovery = new StorageRecoveryService({
      repository: stateRepository,
      blobs,
      billing: beforeBilling,
      verifyProof: () => true,
    });
    await expect(fencedRecovery.recover(recoveryRequestFor(beforeOrganization, beforeAttemptId))).resolves.toMatchObject({
      status: "retained",
      reason: "metadata-referenced",
      attempt: { state: "orphaned", reservationGeneration: 2 },
    });
    await expect(beforeBilling.usageSnapshot(beforeOrganization)).resolves.toMatchObject({ usage: { storageBytes: BYTES.byteLength } });
    await expect(beforeBilling.findUsageOperation(beforeOrganization, `private-skills:storage-recovery-restore:${beforeAttemptId}:generation:1`))
      .resolves.toMatchObject({ restoration: { action: "fenced", fromGeneration: 1, toGeneration: 2 } });
    await expect(beforeBilling.reconcileUsage(
      beforeOrganization,
      beforeReservationKey,
      { storageBytes: 0 },
      `private-skills:storage-recovery:${beforeAttemptId}:generation:1`,
      1,
    )).rejects.toMatchObject({ code: "STALE_RESERVATION_GENERATION", status: 409 });

    // B starts after A's zero committed but before A's final metadata commit.
    // The first resolver response is lost after the PostgreSQL transaction;
    // the second invocation must replay the exact operation and settle G2.
    const afterOrganization = "org-storage-recovery-pg-after-zero";
    const afterAttemptId = "attempt-pg-storage-recovery-after-zero";
    const afterReservationKey = "pg-storage-recovery-after-zero";
    const afterObjectKey = "sealed/pg-storage-recovery-after-zero";
    const afterBilling = createBilling();
    const afterAdmission = await afterBilling.reserveUsage(afterOrganization, { storageBytes: BYTES.byteLength }, afterReservationKey);
    await afterBilling.reconcileUsage(
      afterOrganization,
      afterReservationKey,
      { storageBytes: 0 },
      `private-skills:storage-recovery:${afterAttemptId}:generation:1`,
      afterAdmission.reservationGeneration,
    );
    await stateRepository.transaction(afterOrganization, (state) => {
      state.storageAttempts = [attemptFor(digest, afterOrganization, afterAttemptId, afterReservationKey, afterObjectKey)];
      state.skills.push(referencedSkillFor(digest, afterOrganization, "skill-pg-after-zero", afterObjectKey));
    });
    const recoveryAfterLostResponse = new StorageRecoveryService({
      repository: stateRepository,
      blobs,
      billing: new RecoveryBillingBridge(afterBilling, stateRepository, digest, {
        loseRestoreResponse: false,
        loseResolutionResponse: true,
      }),
      verifyProof: () => true,
    });
    await expect(recoveryAfterLostResponse.recover(recoveryRequestFor(afterOrganization, afterAttemptId))).resolves.toMatchObject({
      status: "retained",
      reason: "metadata-referenced",
      attempt: { state: "orphaned", reservationGeneration: 1, billingCorrection: "release-pending" },
    });
    await expect(afterBilling.usageSnapshot(afterOrganization)).resolves.toMatchObject({ usage: { storageBytes: BYTES.byteLength } });
    await expect(afterBilling.findUsageOperation(afterOrganization, `private-skills:storage-recovery-restore:${afterAttemptId}:generation:1`))
      .resolves.toMatchObject({ restoration: { action: "restored", fromGeneration: 1, toGeneration: 2 } });

    await expect(recoveryAfterLostResponse.recover(recoveryRequestFor(afterOrganization, afterAttemptId))).resolves.toMatchObject({
      status: "retained",
      reason: "billing-restored",
      attempt: { state: "orphaned", reservationGeneration: 2 },
    });
    await expect(afterBilling.reconcileUsage(
      afterOrganization,
      afterReservationKey,
      { storageBytes: 0 },
      `private-skills:storage-recovery:${afterAttemptId}:generation:1`,
      1,
    )).rejects.toMatchObject({ code: "STALE_RESERVATION_GENERATION", status: 409 });
    await expect(afterBilling.usageSnapshot(afterOrganization)).resolves.toMatchObject({ usage: { storageBytes: BYTES.byteLength } });
  });
});
