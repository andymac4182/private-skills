import { describe, expect, it } from "vitest";
import { createMemoryStateRepository, defaultRegistryState } from "../../database/src/index.js";
import {
  BillingService,
  createMemoryBillingRepository,
  createPlanCatalog,
} from "../../billing/src/index.js";
import {
  STORAGE_RECOVERY_CAPABILITY,
  STORAGE_RECOVERY_SCOPE,
  StorageRecoveryService,
  digestBytes,
  encodeBundle,
} from "../../storage/src/index.js";
import type {
  Authenticator,
  RecoverableBlobStore,
  Principal,
  StorageObjectInspection,
  StoredBlob,
} from "../../contracts/src/index.js";
import { createRegistryHandler } from "../src/index.js";

const ORIGIN = "https://registry.example.test";
const ORGANIZATION = "org-storage-recovery-runtime";

class AmbiguousBlobs implements RecoverableBlobStore {
  readonly objects = new Map<string, Uint8Array>();
  putCalls = 0;
  removeCalls = 0;
  private sequence = 0;
  failOnce = true;

  allocateObjectKey(): string {
    this.sequence += 1;
    return `sealed/runtime-${this.sequence}`;
  }

  async put(bytes: Uint8Array): Promise<StoredBlob> {
    return this.putAtKey(this.allocateObjectKey(), bytes);
  }

  async putAtKey(key: string, bytes: Uint8Array): Promise<StoredBlob> {
    this.putCalls += 1;
    const digest = await digestBytes(bytes);
    const current = await this.inspectObject(key);
    if (current.state === "present") {
      if (current.digest !== digest || current.size !== bytes.byteLength) throw new Error("stable key conflict");
      return { key, digest, size: bytes.byteLength };
    }
    if (current.state === "unknown") throw new Error("provider state unknown");
    this.objects.set(key, bytes.slice());
    if (this.failOnce) {
      this.failOnce = false;
      throw new Error("provider response lost after write");
    }
    return { key, digest, size: bytes.byteLength };
  }

  async confirmWriteTerminated(): Promise<boolean> {
    return true;
  }

  async get(key: string): Promise<Uint8Array> {
    const bytes = this.objects.get(key);
    if (!bytes) throw new Error("not found");
    return bytes.slice();
  }

  async remove(key: string): Promise<void> {
    this.removeCalls += 1;
    this.objects.delete(key);
  }

  async inspectObject(key: string): Promise<StorageObjectInspection> {
    const bytes = this.objects.get(key);
    if (!bytes) return { state: "absent", key };
    return { state: "present", key, digest: await digestBytes(bytes), size: bytes.byteLength };
  }
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function requestBundle() {
  return {
    format: "pskills-bundle-v1" as const,
    files: [{
      path: "SKILL.md",
      content: base64(new TextEncoder().encode("---\nname: recovery-runtime\ndescription: recovery fixture\n---\n")),
    }],
  };
}

function principal(): Principal {
  return {
    organizationId: ORGANIZATION,
    subject: "publisher",
    roles: ["admin", "publisher", "reader"],
    namespaces: ["@team"],
    scopes: ["skills:publish", "skills:write", "skills:read", "registry:read"],
  };
}

function billing() {
  return new BillingService({
    repository: createMemoryBillingRepository({ now: () => Date.parse("2026-09-16T00:00:00.000Z") }),
    catalog: createPlanCatalog({ plans: [{
      id: "free",
      label: "Free",
      description: "Recovery fixture",
      limits: { seats: 2, storageBytes: 1_000_000, scansPerMonth: 2, eveCostCentsPerMonth: 10 },
      public: true,
    }] }),
    enabled: true,
    usageEnabled: true,
    now: () => Date.parse("2026-09-16T00:00:00.000Z"),
  });
}

describe("runtime stable storage-attempt integration", () => {
  it("retains an ambiguous provider write, then recovers it through verified cleanup and exact billing zero", async () => {
    const repository = createMemoryStateRepository({
      initial: { [ORGANIZATION]: defaultRegistryState({ production: false, allowUnscanned: true }) },
    });
    const blobs = new AmbiguousBlobs();
    const metering = billing();
    const auth: Authenticator = { authenticate: async () => principal() };
    const handler = createRegistryHandler({
      repository,
      blobs,
      auth,
      billing: metering,
      config: {
        publicOrigin: ORIGIN,
        maxBodyBytes: 1024 * 1024,
        organizationId: ORGANIZATION,
        leaseSeconds: 30,
      },
    });

    const response = await handler(new Request(`${ORIGIN}/v1/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "@team/recovery-runtime", version: "1.0.0", bundle: requestBundle() }),
    }));
    expect(response.status).toBe(503);
    expect(blobs.putCalls).toBe(1);

    const failedState = await repository.read(ORGANIZATION);
    const attempt = failedState.storageAttempts?.[0];
    expect(attempt).toMatchObject({
      state: "orphaned",
      objectKey: expect.stringMatching(/^sealed\/runtime-/u),
      reservationGeneration: 1,
    });
    expect(failedState.skills).toHaveLength(0);
    expect(await metering.usageSnapshot(ORGANIZATION)).toMatchObject({
      usage: { storageBytes: encodeBundle(requestBundle()).byteLength },
    });
    const objectKey = attempt!.objectKey!;
    expect(blobs.objects.has(objectKey)).toBe(true);

    const recovery = new StorageRecoveryService({
      repository,
      blobs,
      billing: metering,
      verifyProof: ({ request, attempt: proofAttempt }) =>
        request.actor.capability === STORAGE_RECOVERY_CAPABILITY &&
        request.actor.scopes.includes(STORAGE_RECOVERY_SCOPE) &&
        proofAttempt.id === attempt!.id,
    });
    const result = await recovery.recover({
      organizationId: ORGANIZATION,
      attemptId: attempt!.id,
      actor: {
        organizationId: ORGANIZATION,
        subject: "platform-operator",
        capability: STORAGE_RECOVERY_CAPABILITY,
        scopes: [STORAGE_RECOVERY_SCOPE],
      },
      proof: { kind: "known-failure", reference: "runtime-write-record-1" },
      cleanupConfirmed: true,
    });

    expect(result).toMatchObject({ status: "released", inspection: "deleted", billing: "reconciled" });
    expect(blobs.removeCalls).toBe(1);
    expect(blobs.objects.has(objectKey)).toBe(false);
    expect((await repository.read(ORGANIZATION)).storageAttempts?.[0]?.state).toBe("released");
    await expect(metering.usageSnapshot(ORGANIZATION)).resolves.toMatchObject({ usage: { storageBytes: 0, scans: 0 } });
  });
});
