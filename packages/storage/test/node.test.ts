import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createMemoryStateRepository, defaultRegistryState } from "../../database/src/index.js";
import type { Digest, StorageAttempt } from "../../contracts/src/index.js";
import {
  STORAGE_RECOVERY_CAPABILITY,
  STORAGE_RECOVERY_SCOPE,
  StorageRecoveryService,
  createVerifiedStorageWriteReceipt,
  digestBytes,
} from "../src/index.js";
import {
  createNodeFilesSdkBlobStore,
  resolveNodeStorageProviderBinding,
} from "../src/node.js";

const ORGANIZATION = "org-node-storage-receipt";
const PROVIDER_BINDING_PATTERN = /^files-sdk:[a-z-]+:sha256:[0-9a-f]{64}$/u;

function recoveryRequest(attemptId: string) {
  return {
    organizationId: ORGANIZATION,
    attemptId,
    actor: {
      organizationId: ORGANIZATION,
      subject: "platform-operator",
      capability: STORAGE_RECOVERY_CAPABILITY,
      scopes: [STORAGE_RECOVERY_SCOPE],
    },
    proof: { kind: "known-failure" as const, reference: "local-files-sdk-proof" },
    cleanupConfirmed: true,
  };
}

function storageAttempt(input: {
  id: string;
  objectKey: string;
  digest: Digest;
  size: number;
  providerBinding: string;
  writeReceipt?: StorageAttempt["writeReceipt"];
}): StorageAttempt {
  return {
    id: input.id,
    organizationId: ORGANIZATION,
    reservationKey: `private-skills:node-receipt:${input.id}`,
    digest: input.digest,
    size: input.size,
    state: "orphaned",
    providerBinding: input.providerBinding,
    ...(input.writeReceipt ? { writeReceipt: input.writeReceipt } : {}),
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
    objectKey: input.objectKey,
  };
}

describe("Node Files SDK provider binding", () => {
  it("derives stable identities from non-secret configuration and validates explicit bindings", async () => {
    const base = {
      provider: "fs" as const,
      root: "/disposable/private-skills-storage",
      prefix: "private-registry",
    };
    const binding = await resolveNodeStorageProviderBinding(base);
    expect(binding).toMatch(PROVIDER_BINDING_PATTERN);
    expect(await resolveNodeStorageProviderBinding({ ...base })).toBe(binding);
    expect(await resolveNodeStorageProviderBinding({ ...base, prefix: "other-registry" })).not.toBe(binding);
    expect(await resolveNodeStorageProviderBinding({
      ...base,
      credentials: { token: "credential-material-is-not-an-identity" },
    })).toBe(binding);

    await expect(resolveNodeStorageProviderBinding({ provider: "vercel-blob", credentials: { token: "credential" } }))
      .rejects.toThrow(/providerBinding|storeId/u);
    await expect(resolveNodeStorageProviderBinding({ provider: "r2", bucket: "private" }))
      .rejects.toThrow(/providerBinding|accountId|endpoint/u);
    await expect(resolveNodeStorageProviderBinding({
      provider: "azure",
      container: "private",
      credentials: { connectionString: "credential" },
    })).rejects.toThrow(/providerBinding|accountName|endpoint/u);

    await expect(resolveNodeStorageProviderBinding({
      provider: "vercel-blob",
      providerBinding: "files-sdk:vercel:team:store",
      credentials: { token: "credential" },
    })).resolves.toBe("files-sdk:vercel:team:store");
    await expect(resolveNodeStorageProviderBinding({
      provider: "vercel-blob",
      providerBinding: "https://storage.example.test/private",
      credentials: { token: "credential" },
    })).rejects.toThrow(/providerBinding/u);
  });

  it("uses the real filesystem adapter binding for restart cleanup and retains unknown writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "private-skills-node-receipt-"));
    try {
      const store = await createNodeFilesSdkBlobStore({
        provider: "fs",
        root,
        prefix: "receipt-runtime",
      });
      const bytes = new TextEncoder().encode("real Files SDK filesystem receipt bytes");
      const stored = await store.put(bytes);
      const attempt = storageAttempt({
        id: "attempt-with-receipt",
        objectKey: stored.key,
        digest: stored.digest,
        size: stored.size,
        providerBinding: store.providerBinding!,
      });
      attempt.writeReceipt = createVerifiedStorageWriteReceipt(store, attempt, stored, () => new Date("2026-09-16T01:02:03.000Z"));
      expect(attempt.writeReceipt).toBeDefined();

      const state = defaultRegistryState({ production: false, allowUnscanned: true });
      state.storageAttempts = [attempt];
      const repository = createMemoryStateRepository({ initial: { [ORGANIZATION]: state } });
      const restartedStore = await createNodeFilesSdkBlobStore({
        provider: "fs",
        root,
        prefix: "receipt-runtime",
      });
      expect(restartedStore.providerBinding).toBe(store.providerBinding);

      const recovery = new StorageRecoveryService({
        repository,
        blobs: restartedStore,
        verifyProof: () => true,
      });
      await expect(recovery.recover(recoveryRequest(attempt.id))).resolves.toMatchObject({
        status: "released",
        inspection: "deleted",
      });
      await expect(restartedStore.inspectObject(stored.key)).resolves.toEqual({ state: "absent", key: stored.key });

      const unknownBytes = new TextEncoder().encode("ambiguous filesystem write");
      const unknownAttemptId = "attempt-without-receipt";
      const unknownObjectKey = restartedStore.allocateObjectKey();
      const unknownAttempt = storageAttempt({
        id: unknownAttemptId,
        objectKey: unknownObjectKey,
        digest: await digestBytes(unknownBytes),
        size: unknownBytes.byteLength,
        providerBinding: restartedStore.providerBinding!,
      });
      await repository.transaction(ORGANIZATION, (current) => {
        current.storageAttempts ??= [];
        current.storageAttempts.push(unknownAttempt);
      });
      await expect(recovery.recover(recoveryRequest(unknownAttemptId))).resolves.toMatchObject({
        status: "retained",
        reason: "writer-unconfirmed",
        inspection: { state: "unknown", key: unknownObjectKey },
      });
      expect((await repository.read(ORGANIZATION)).storageAttempts?.find((candidate) => candidate.id === unknownAttemptId)?.state)
        .toBe("orphaned");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
