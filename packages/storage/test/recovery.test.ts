import { describe, expect, it } from "vitest";
import { createMemoryStateRepository, defaultRegistryState } from "../../database/src/index.js";
import { BillingService, createMemoryBillingRepository } from "../../billing/src/index.js";
import type {
  BillingUsageAdmission,
  BlobStore,
  Digest,
  MeteredUsageDelta,
  MeteredUsageReservation,
  RecoverableBlobStore,
  RegistryState,
  StorageAttempt,
  StorageObjectInspection,
  StoredBlob,
} from "../../contracts/src/index.js";
import {
  STORAGE_RECOVERY_CAPABILITY,
  STORAGE_RECOVERY_SCOPE,
  createDurableStorageRecoveryProofVerifier,
  StorageRecoveryError,
  StorageRecoveryService,
  type StorageRecoveryActor,
} from "../src/index.js";
import { digestBytes } from "../src/index.js";

const ORGANIZATION = "org-storage-recovery";
const OTHER_ORGANIZATION = "org-other";
const BYTES = new TextEncoder().encode("recoverable sealed bytes");
const KEY = "sealed/recovery-object";

class RecoverableMemoryBlobStore implements RecoverableBlobStore {
  readonly objects = new Map<string, Uint8Array>();
  inspectFailures = 0;
  removeCalls = 0;
  private sequence = 0;

  allocateObjectKey(): string {
    this.sequence += 1;
    return `sealed/generated-${this.sequence}`;
  }

  async put(bytes: Uint8Array): Promise<StoredBlob> {
    return this.putAtKey(this.allocateObjectKey(), bytes);
  }

  async putAtKey(key: string, bytes: Uint8Array): Promise<StoredBlob> {
    const existing = await this.inspectObject(key);
    const digest = await digestBytes(bytes);
    if (existing.state === "present") {
      if (existing.digest !== digest || existing.size !== bytes.byteLength) throw new Error("stable key conflict");
      return { key, digest, size: bytes.byteLength };
    }
    if (existing.state === "unknown") throw new Error("stable key existence is unknown");
    this.objects.set(key, bytes.slice());
    return { key, digest, size: bytes.byteLength };
  }

  async confirmWriteTerminated(): Promise<boolean> {
    return true;
  }

  async get(key: string): Promise<Uint8Array> {
    const value = this.objects.get(key);
    if (!value) throw new Error("not found");
    return value.slice();
  }

  async remove(key: string): Promise<void> {
    this.removeCalls += 1;
    this.objects.delete(key);
  }

  async inspectObject(key: string): Promise<StorageObjectInspection> {
    if (this.inspectFailures > 0) {
      this.inspectFailures -= 1;
      return { state: "unknown", key, reason: "provider-error" };
    }
    const value = this.objects.get(key);
    if (!value) return { state: "absent", key };
    return { state: "present", key, digest: await digestBytes(value), size: value.byteLength };
  }
}

/** Models a provider that accepted a PUT, then lost the local response while
 * the remote write can still materialize the stable object later. */
class DelayedWriteBlobStore extends RecoverableMemoryBlobStore {
  #finish?: () => void;
  terminated = false;

  override putAtKey(key: string, bytes: Uint8Array): Promise<StoredBlob> {
    const payload = bytes.slice();
    return new Promise<StoredBlob>((resolve) => {
      this.#finish = () => {
        void digestBytes(payload).then((digest) => {
          this.objects.set(key, payload);
          this.terminated = true;
          resolve({ key, digest, size: payload.byteLength });
        });
      };
    });
  }

  override async confirmWriteTerminated(): Promise<boolean> {
    return this.terminated;
  }

  finishDelayedWrite(): void {
    if (!this.#finish) throw new Error("delayed write was not started");
    const finish = this.#finish;
    this.#finish = undefined;
    finish();
  }
}

class RecordingBilling implements BillingUsageAdmission {
  readonly reconciliations: Array<{
    organizationId: string;
    reservationKey: string;
    actual: MeteredUsageDelta;
    operationKey: string;
    reservationGeneration?: number;
  }> = [];
  enabled = true;
  fail = false;

  status(): { enabled: boolean } {
    return { enabled: this.enabled };
  }

  async reserveUsage(organizationId: string, delta: MeteredUsageDelta, operationKey: string): Promise<MeteredUsageReservation> {
    void organizationId;
    void delta;
    void operationKey;
    return { idempotent: false, reservationGeneration: 1 };
  }

  async reconcileUsage(
    organizationId: string,
    reservationKey: string,
    actual: MeteredUsageDelta,
    operationKey: string,
    reservationGeneration?: number,
  ): Promise<unknown> {
    if (this.fail) throw new Error("billing unavailable");
    this.reconciliations.push({ organizationId, reservationKey, actual, operationKey, reservationGeneration });
    return undefined;
  }
}

function actor(organizationId = ORGANIZATION): StorageRecoveryActor {
  return {
    organizationId,
    subject: "platform-operator",
    capability: STORAGE_RECOVERY_CAPABILITY,
    scopes: [STORAGE_RECOVERY_SCOPE],
  };
}

function attempt(overrides: Partial<StorageAttempt> = {}): StorageAttempt {
  return {
    id: "attempt-storage-1",
    organizationId: ORGANIZATION,
    reservationKey: "private-skills:publish-storage:job-1",
    digest: "sha256:2c1c1b1576e5c5f4fbde79cb0b1db8ab30c9b4cbe0e4402e5f1b9f9a8f7d5a5b" as Digest,
    size: BYTES.byteLength,
    state: "orphaned",
    reservationGeneration: 1,
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
    objectKey: KEY,
    ...overrides,
  };
}

async function digestForFixture(): Promise<Digest> {
  return digestBytes(BYTES);
}

async function repositoryWithAttempt(
  candidate: StorageAttempt,
  extra?: (state: RegistryState) => void,
) {
  const state = defaultRegistryState({ production: false, allowUnscanned: true });
  state.storageAttempts = [candidate];
  extra?.(state);
  return createMemoryStateRepository({ initial: { [candidate.organizationId]: state } });
}

function request(attemptId = "attempt-storage-1", overrides: Partial<Parameters<StorageRecoveryService["recover"]>[0]> = {}) {
  return {
    organizationId: ORGANIZATION,
    attemptId,
    actor: actor(),
    proof: { kind: "known-failure" as const, reference: "operator-record-1" },
    ...overrides,
  };
}

describe("durable storage-attempt recovery", () => {
  it("cleans an ambiguously written exact object before applying an exact zero", async () => {
    const blobs = new RecoverableMemoryBlobStore();
    blobs.objects.set(KEY, BYTES.slice());
    const billing = new RecordingBilling();
    const repository = await repositoryWithAttempt({ ...(attempt()), digest: await digestForFixture() });
    const service = new StorageRecoveryService({ repository, blobs, billing, verifyProof: () => true });

    const result = await service.recover({ ...request(), cleanupConfirmed: true });

    expect(result).toMatchObject({ status: "released", inspection: "deleted", billing: "reconciled" });
    expect(blobs.removeCalls).toBe(1);
    expect(blobs.objects.has(KEY)).toBe(false);
    expect(billing.reconciliations).toEqual([{
      organizationId: ORGANIZATION,
      reservationKey: "private-skills:publish-storage:job-1",
      actual: { storageBytes: 0 },
      operationKey: "private-skills:storage-recovery:attempt-storage-1",
      reservationGeneration: 1,
    }]);
    expect((await repository.read(ORGANIZATION)).storageAttempts?.[0]).toMatchObject({ state: "released", objectKey: KEY });
  });

  it("releases an already absent object without provider deletion", async () => {
    const blobs = new RecoverableMemoryBlobStore();
    const billing = new RecordingBilling();
    const repository = await repositoryWithAttempt({ ...(attempt()), digest: await digestForFixture() });
    const service = new StorageRecoveryService({ repository, blobs, billing, verifyProof: () => true });

    const result = await service.recover(request());

    expect(result).toMatchObject({ status: "released", inspection: "absent" });
    expect(blobs.removeCalls).toBe(0);
    expect(billing.reconciliations[0]?.actual).toEqual({ storageBytes: 0 });
  });

  it("retains the charge when the provider cannot establish object absence", async () => {
    const blobs = new RecoverableMemoryBlobStore();
    blobs.inspectFailures = 1;
    const billing = new RecordingBilling();
    const repository = await repositoryWithAttempt({ ...(attempt()), digest: await digestForFixture() });
    const service = new StorageRecoveryService({ repository, blobs, billing, verifyProof: () => true });

    const result = await service.recover(request());

    expect(result).toMatchObject({ status: "retained", reason: "provider-unknown", inspection: { state: "unknown" } });
    expect(blobs.removeCalls).toBe(0);
    expect(billing.reconciliations).toHaveLength(0);
    expect((await repository.read(ORGANIZATION)).storageAttempts?.[0]?.state).toBe("orphaned");
  });

  it("requires explicit cleanup and exact digest before releasing a present object", async () => {
    const blobs = new RecoverableMemoryBlobStore();
    blobs.objects.set(KEY, BYTES.slice());
    const billing = new RecordingBilling();
    const repository = await repositoryWithAttempt({
      ...(attempt()),
      digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Digest,
    });
    const service = new StorageRecoveryService({ repository, blobs, billing, verifyProof: () => true });

    const retained = await service.recover({
      ...request(),
      proof: { kind: "writer-terminated", reference: "runtime-storage-attempt:attempt-storage-1" },
    });
    expect(retained).toMatchObject({ status: "retained", reason: "object-digest-mismatch" });
    expect(blobs.removeCalls).toBe(0);
    expect(billing.reconciliations).toHaveLength(0);

    const repository2 = await repositoryWithAttempt({ ...(attempt()), digest: await digestForFixture() });
    const blobs2 = new RecoverableMemoryBlobStore();
    blobs2.objects.set(KEY, BYTES.slice());
    const retainedWithoutConfirmation = await new StorageRecoveryService({ repository: repository2, blobs: blobs2, billing, verifyProof: () => true }).recover(request());
    expect(retainedWithoutConfirmation).toMatchObject({ status: "retained", reason: "cleanup-required" });
    expect(blobs2.removeCalls).toBe(0);
  });

  it("requires a trusted proof and rejects tenant or worker credentials before provider I/O", async () => {
    const blobs = new RecoverableMemoryBlobStore();
    blobs.objects.set(KEY, BYTES.slice());
    const repository = await repositoryWithAttempt({ ...(attempt()), digest: await digestForFixture() });
    const service = new StorageRecoveryService({ repository, blobs, verifyProof: () => true });

    await expect(service.recover({
      ...request(),
      actor: { organizationId: ORGANIZATION, subject: "worker", capability: "worker", scopes: ["storage:recovery"] },
      cleanupConfirmed: true,
    })).rejects.toMatchObject({ code: "RECOVERY_FORBIDDEN" });
    await expect(service.recover({
      ...request(),
      actor: actor(OTHER_ORGANIZATION),
      cleanupConfirmed: true,
    })).rejects.toMatchObject({ code: "RECOVERY_FORBIDDEN" });
    expect(blobs.removeCalls).toBe(0);

    const proofRejected = new StorageRecoveryService({ repository, blobs, verifyProof: () => false });
    await expect(proofRejected.recover({ ...request(), cleanupConfirmed: true })).resolves.toMatchObject({ status: "retained", reason: "proof-rejected" });
    expect(blobs.removeCalls).toBe(0);
  });

  it("does not release an object referenced by registry metadata", async () => {
    const blobs = new RecoverableMemoryBlobStore();
    blobs.objects.set(KEY, BYTES.slice());
    const billing = new RecordingBilling();
    const repository = await repositoryWithAttempt({ ...(attempt()), digest: await digestForFixture() }, (state) => {
      state.skills.push({
        id: "skill-1",
        organizationId: ORGANIZATION,
        name: "@team/referenced",
        skillName: "referenced",
        version: "1.0.0",
        description: "referenced",
        artifact: { key: KEY, digest: "sha256:2c1c1b1576e5c5f4fbde79cb0b1db8ab30c9b4cbe0e4402e5f1b9f9a8f7d5a5b" as Digest, size: BYTES.byteLength },
        state: "approved",
        policyRevision: state.policy.revision,
        createdAt: "2026-09-16T00:00:00.000Z",
        provenance: { kind: "native" },
        fileCount: 1,
        scanIds: [],
      });
    });
    const service = new StorageRecoveryService({ repository, blobs, billing, verifyProof: () => true });

    const result = await service.recover({ ...request(), cleanupConfirmed: true });

    expect(result).toMatchObject({ status: "retained", reason: "metadata-referenced" });
    expect(blobs.removeCalls).toBe(0);
    expect(billing.reconciliations).toHaveLength(0);
  });

  it("can resume a recovery after a crash between billing correction and final state commit", async () => {
    const blobs = new RecoverableMemoryBlobStore();
    blobs.objects.set(KEY, BYTES.slice());
    const billing = new RecordingBilling();
    const inner = await repositoryWithAttempt({ ...(attempt()), digest: await digestForFixture() });
    let transactions = 0;
    const repository = {
      read: (organizationId: string) => inner.read(organizationId),
      transaction: async <T>(organizationId: string, updater: (state: RegistryState) => T): Promise<T> => {
        transactions += 1;
        if (transactions === 3) throw new Error("crash after external correction");
        return inner.transaction(organizationId, updater);
      },
    };
    const service = new StorageRecoveryService({ repository, blobs, billing, verifyProof: () => true });

    await expect(service.recover({ ...request(), cleanupConfirmed: true })).rejects.toMatchObject({ code: "RECOVERY_PERSISTENCE_UNCERTAIN" });
    expect((await inner.read(ORGANIZATION)).storageAttempts?.[0]).toMatchObject({ state: "releasing", recoveryToken: expect.any(String) });
    expect(billing.reconciliations).toHaveLength(1);

    const resumed = await service.recover({ ...request(), cleanupConfirmed: true, resume: true });
    expect(resumed).toMatchObject({ status: "released", inspection: "absent" });
    expect(billing.reconciliations).toHaveLength(2);
    expect(billing.reconciliations[0]?.operationKey).toBe(billing.reconciliations[1]?.operationKey);
    expect((await inner.read(ORGANIZATION)).storageAttempts?.[0]?.state).toBe("released");
  });

  it("requires a durable writer terminal fact and leaves pending attempts unchanged", async () => {
    const blobs = new RecoverableMemoryBlobStore();
    const pending = attempt({ state: "pending", jobId: "job-pending" });
    const repository = await repositoryWithAttempt(pending, (state) => {
      state.jobs.push({
        id: "job-pending",
        organizationId: ORGANIZATION,
        kind: "scan",
        state: "running",
        policyRevision: state.policy.revision,
        policy: state.policy,
        createdAt: pending.createdAt,
        updatedAt: pending.updatedAt,
        attempts: 1,
        leaseToken: "active-writer",
        leaseExpiresAt: "2026-09-16T00:10:00.000Z",
      });
    });
    const verifyProof = createDurableStorageRecoveryProofVerifier(repository);
    const proofRequest = {
      ...request(),
      proof: { kind: "writer-terminated" as const, reference: "runtime-storage-attempt:attempt-storage-1" },
    };
    expect(await verifyProof({ request: proofRequest, attempt: pending })).toBe(false);

    await repository.transaction(ORGANIZATION, (state) => {
      const job = state.jobs.find((candidate) => candidate.id === "job-pending")!;
      job.state = "failed";
      delete job.leaseToken;
      delete job.leaseExpiresAt;
    });
    expect(await verifyProof({ request: proofRequest, attempt: pending })).toBe(true);

    const billing = new RecordingBilling();
    const service = new StorageRecoveryService({ repository, blobs, billing, verifyProof });
    const retained = await service.recover({ ...proofRequest });
    expect(retained).toMatchObject({ status: "released", inspection: "absent" });
    expect((await repository.read(ORGANIZATION)).storageAttempts?.[0]?.state).toBe("released");
  });

  it("retains an absent object while the provider write can still finish later", async () => {
    const blobs = new DelayedWriteBlobStore();
    const delayedWrite = blobs.putAtKey(KEY, BYTES);
    const candidate = attempt({ state: "orphaned", digest: await digestForFixture() });
    const repository = await repositoryWithAttempt(candidate);
    const billing = new RecordingBilling();
    const verifyProof = createDurableStorageRecoveryProofVerifier(repository);
    const service = new StorageRecoveryService({ repository, blobs, billing, verifyProof });

    const retained = await service.recover({
      ...request(),
      proof: { kind: "writer-terminated", reference: "runtime-storage-attempt:attempt-storage-1" },
    });
    expect(retained).toMatchObject({ status: "retained", reason: "writer-unconfirmed" });
    expect(billing.reconciliations).toHaveLength(0);
    expect((await repository.read(ORGANIZATION)).storageAttempts?.[0]?.state).toBe("orphaned");

    // The provider completes the delayed request after the rejected/local
    // failure observation. The object remains discoverable and charged until
    // a second recovery observes the authoritative terminal outcome.
    blobs.finishDelayedWrite();
    await delayedWrite;
    expect((await blobs.inspectObject(KEY)).state).toBe("present");
    expect(billing.reconciliations).toHaveLength(0);

    const released = await service.recover({
      ...request(),
      proof: { kind: "writer-terminated", reference: "runtime-storage-attempt:attempt-storage-1" },
      cleanupConfirmed: true,
    });
    expect(released).toMatchObject({ status: "released", inspection: "deleted" });
    expect(billing.reconciliations).toHaveLength(1);
    expect(billing.reconciliations[0]?.reservationGeneration).toBe(1);
  });

  it("durably retries restoration without reissuing the old zero after a late reference", async () => {
    const blobs = new RecoverableMemoryBlobStore();
    const digest = await digestForFixture();
    const repository = await repositoryWithAttempt(attempt());
    const ledger = new BillingService({
      repository: createMemoryBillingRepository(),
      enabled: true,
      usageEnabled: true,
    });
    const candidate = attempt();
    await ledger.reserveUsage(ORGANIZATION, { storageBytes: BYTES.byteLength }, candidate.reservationKey);
    let failRestoreOnce = true;
    let zeroCorrectionCalls = 0;
    const billing: BillingUsageAdmission & {
      restoreUsage: (
        organizationId: string,
        reservationKey: string,
        delta: MeteredUsageDelta,
        operationKey: string,
        generation?: number,
      ) => Promise<unknown>;
    } = {
      status: () => ledger.status(),
      reserveUsage: (organizationId, delta, operationKey) => ledger.reserveUsage(organizationId, delta, operationKey),
      restoreUsage: async (organizationId, reservationKey, delta, operationKey, generation) => {
        void reservationKey;
        void generation;
        const result = await ledger.reserveUsage(organizationId, delta, operationKey);
        if (operationKey === `private-skills:storage-recovery-restore:${candidate.id}` && failRestoreOnce) {
          failRestoreOnce = false;
          // Model a lost response after the inverse reservation committed.
          // The durable storage marker must make a later retry idempotent.
          throw new Error("billing restoration response lost");
        }
        return result;
      },
      reconcileUsage: async (organizationId, reservationKey, actual, operationKey, generation) => {
        zeroCorrectionCalls += 1;
        const result = await ledger.reconcileUsage(organizationId, reservationKey, actual, operationKey, generation);
        await repository.transaction(ORGANIZATION, (state) => {
          state.skills.push({
            id: "late-reference",
            organizationId: ORGANIZATION,
            name: "@team/late-reference",
            skillName: "late-reference",
            version: "1.0.0",
            description: "late reference",
            artifact: { key: KEY, digest, size: BYTES.byteLength },
            state: "approved",
            policyRevision: state.policy.revision,
            createdAt: "2026-09-16T00:00:00.000Z",
            provenance: { kind: "native" },
            fileCount: 1,
            scanIds: [],
          });
        });
        return result;
      },
    };
    const service = new StorageRecoveryService({ repository, blobs, billing, verifyProof: () => true });

    const result = await service.recover({ ...request(), cleanupConfirmed: false });
    expect(result).toMatchObject({ status: "retained", reason: "billing-failed" });
    expect((await repository.read(ORGANIZATION)).storageAttempts?.[0]).toMatchObject({
      state: "orphaned",
      billingCorrection: "restore-pending",
    });
    await expect(ledger.usageSnapshot(ORGANIZATION)).resolves.toMatchObject({ usage: { storageBytes: BYTES.byteLength } });

    const restored = await service.recover({ ...request(), cleanupConfirmed: false });
    expect(restored).toMatchObject({ status: "retained", reason: "billing-restored" });
    expect(zeroCorrectionCalls).toBe(1);
    expect((await repository.read(ORGANIZATION)).storageAttempts?.[0]).toMatchObject({ state: "orphaned" });
    expect((await repository.read(ORGANIZATION)).storageAttempts?.[0]?.billingCorrection).toBeUndefined();
  });

  it("keeps a restoration marker when the billing ledger has no inverse seam", async () => {
    const blobs = new RecoverableMemoryBlobStore();
    const repository = await repositoryWithAttempt(attempt());
    let referenceAppeared = false;
    let positiveReserveCalls = 0;
    const billing: BillingUsageAdmission = {
      status: () => ({ enabled: true }),
      reserveUsage: async () => {
        positiveReserveCalls += 1;
        return undefined;
      },
      reconcileUsage: async () => {
        referenceAppeared = true;
        return undefined;
      },
    };
    const service = new StorageRecoveryService({
      repository,
      blobs,
      billing,
      verifyProof: () => true,
      isObjectReferenced: () => referenceAppeared,
    });

    const result = await service.recover(request());

    expect(result).toMatchObject({ status: "retained", reason: "billing-failed" });
    expect(positiveReserveCalls).toBe(0);
    expect((await repository.read(ORGANIZATION)).storageAttempts?.[0]).toMatchObject({
      state: "orphaned",
      billingCorrection: "restore-pending",
    });
  });
});
