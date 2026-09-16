import { describe, expect, it } from 'vitest';
import { createMemoryStateRepository, defaultRegistryState } from '../../database/src/index.js';
import {
  BillingService,
  createMemoryBillingRepository,
  createPlanCatalog,
} from '../../billing/src/index.js';
import {
  STORAGE_RECOVERY_CAPABILITY,
  STORAGE_RECOVERY_SCOPE,
  StorageRecoveryService,
  digestBytes,
  encodeBundle,
} from '../../storage/src/index.js';
import type {
  Authenticator,
  RecoverableBlobStore,
  Principal,
  RegistryState,
  StateRepository,
  StorageObjectInspection,
  StoredBlob,
} from '../../contracts/src/index.js';
import { createRegistryHandler } from '../src/index.js';

const ORIGIN = 'https://registry.example.test';
const ORGANIZATION = 'org-storage-receipt-runtime';
const PROVIDER_BINDING = 'files-sdk:receipt:local';

class ReceiptBlobs implements RecoverableBlobStore {
  readonly providerBinding: string;
  readonly objects = new Map<string, Uint8Array>();
  finality = false;
  confirmCalls = 0;
  private sequence = 0;

  constructor(providerBinding = PROVIDER_BINDING) {
    this.providerBinding = providerBinding;
  }

  allocateObjectKey(): string {
    this.sequence += 1;
    return `sealed/receipt-${this.sequence}`;
  }

  async put(bytes: Uint8Array): Promise<StoredBlob> {
    return this.putAtKey(this.allocateObjectKey(), bytes);
  }

  async putAtKey(key: string, bytes: Uint8Array): Promise<StoredBlob> {
    const digest = await digestBytes(bytes);
    const existing = await this.inspectObject(key);
    if (existing.state === 'present') {
      if (existing.digest !== digest || existing.size !== bytes.byteLength) throw new Error('stable key conflict');
      return { key, digest, size: bytes.byteLength };
    }
    if (existing.state === 'unknown') throw new Error('provider state unknown');
    this.objects.set(key, bytes.slice());
    return { key, digest, size: bytes.byteLength };
  }

  /** A receipt is the only finality proof this fixture provides. */
  async confirmWriteTerminated(): Promise<boolean> {
    this.confirmCalls += 1;
    return this.finality;
  }

  async get(key: string): Promise<Uint8Array> {
    const bytes = this.objects.get(key);
    if (!bytes) throw new Error('not found');
    return bytes.slice();
  }

  async remove(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async inspectObject(key: string): Promise<StorageObjectInspection> {
    const bytes = this.objects.get(key);
    if (!bytes) return { state: 'absent', key };
    return { state: 'present', key, digest: await digestBytes(bytes), size: bytes.byteLength };
  }
}

/** Fail the publish metadata transaction after the verified provider write. */
class FailMetadataTransactionRepository implements StateRepository {
  readonly #inner: StateRepository;
  #transactions = 0;

  constructor(inner: StateRepository) {
    this.#inner = inner;
  }

  read(organizationId: string) {
    return this.#inner.read(organizationId);
  }

  async transaction<T>(organizationId: string, updater: (state: RegistryState) => T): Promise<T> {
    this.#transactions += 1;
    if (this.#transactions === 2) throw new Error('metadata transaction failed after provider verification');
    return this.#inner.transaction(organizationId, updater);
  }
}

function bundle() {
  const bytes = new TextEncoder().encode('---\nname: receipt-runtime\ndescription: receipt fixture\n---\n');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return {
    format: 'pskills-bundle-v1' as const,
    files: [{ path: 'SKILL.md', content: btoa(binary) }],
  };
}

function principal(): Principal {
  return {
    organizationId: ORGANIZATION,
    subject: 'publisher',
    roles: ['admin', 'publisher', 'reader'],
    namespaces: ['@team'],
    scopes: ['skills:publish', 'skills:write', 'skills:read', 'registry:read'],
  };
}

function billing() {
  return new BillingService({
    repository: createMemoryBillingRepository({ now: () => Date.parse('2026-09-16T00:00:00.000Z') }),
    catalog: createPlanCatalog({ plans: [{
      id: 'free',
      label: 'Free',
      description: 'Receipt fixture',
      limits: { seats: 2, storageBytes: 1_000_000, scansPerMonth: 2, eveCostCentsPerMonth: 10 },
      public: true,
    }] }),
    enabled: true,
    usageEnabled: true,
    now: () => Date.parse('2026-09-16T00:00:00.000Z'),
  });
}

describe('verified storage receipt runtime integration', () => {
  it('persists a receipt after metadata failure and cleans it up after a restart', async () => {
    const baseRepository = createMemoryStateRepository({
      initial: { [ORGANIZATION]: defaultRegistryState({ production: false, allowUnscanned: true }) },
    });
    const repository = new FailMetadataTransactionRepository(baseRepository);
    const blobs = new ReceiptBlobs();
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
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '@team/receipt-runtime', version: '1.0.0', bundle: bundle() }),
    }));
    expect(response.status).toBe(500);

    const failedState = await baseRepository.read(ORGANIZATION);
    const attempt = failedState.storageAttempts?.[0];
    expect(attempt).toMatchObject({
      state: 'orphaned',
      providerBinding: PROVIDER_BINDING,
      writeReceipt: {
        kind: 'verified',
        providerBinding: PROVIDER_BINDING,
      },
    });
    const objectKey = attempt!.objectKey!;
    expect(blobs.objects.has(objectKey)).toBe(true);

    const recovery = new StorageRecoveryService({
      repository: baseRepository,
      blobs,
      billing: metering,
      verifyProof: ({ request, attempt: proofAttempt }) =>
        request.organizationId === ORGANIZATION &&
        request.actor.capability === STORAGE_RECOVERY_CAPABILITY &&
        request.actor.scopes.includes(STORAGE_RECOVERY_SCOPE) &&
        proofAttempt.id === attempt!.id,
    });
    const result = await recovery.recover({
      organizationId: ORGANIZATION,
      attemptId: attempt!.id,
      actor: {
        organizationId: ORGANIZATION,
        subject: 'platform-operator',
        capability: STORAGE_RECOVERY_CAPABILITY,
        scopes: [STORAGE_RECOVERY_SCOPE],
      },
      proof: { kind: 'writer-terminated', reference: `runtime-storage-attempt:${attempt!.id}` },
      cleanupConfirmed: true,
    });

    expect(result).toMatchObject({ status: 'released', inspection: 'deleted', billing: 'reconciled' });
    expect(blobs.objects.has(objectKey)).toBe(false);
    expect((await baseRepository.read(ORGANIZATION)).storageAttempts?.[0]).toMatchObject({
      state: 'released',
      writeReceipt: expect.objectContaining({ key: objectKey }),
    });
    await expect(metering.usageSnapshot(ORGANIZATION)).resolves.toMatchObject({ usage: { storageBytes: 0, scans: 0 } });
  });

  it('retains a receipt when the configured provider binding changes', async () => {
    const bytes = new TextEncoder().encode('receipt binding mismatch bytes');
    const digest = await digestBytes(bytes);
    const objectKey = 'sealed/receipt-binding-mismatch';
    const blobs = new ReceiptBlobs('files-sdk:other:local');
    blobs.finality = true;
    blobs.objects.set(objectKey, bytes.slice());
    const state = defaultRegistryState({ production: false, allowUnscanned: true });
    state.storageAttempts = [{
      id: 'attempt-binding-mismatch',
      organizationId: ORGANIZATION,
      reservationKey: 'private-skills:publish-storage:binding-mismatch',
      digest,
      size: bytes.byteLength,
      state: 'orphaned',
      reservationGeneration: 1,
      providerBinding: PROVIDER_BINDING,
      writeReceipt: {
        kind: 'verified',
        providerBinding: PROVIDER_BINDING,
        key: objectKey,
        digest,
        size: bytes.byteLength,
        completedAt: '2026-09-16T00:00:00.000Z',
      },
      createdAt: '2026-09-16T00:00:00.000Z',
      updatedAt: '2026-09-16T00:00:00.000Z',
      objectKey,
    }];
    const repository = createMemoryStateRepository({ initial: { [ORGANIZATION]: state } });
    const recovery = new StorageRecoveryService({ repository, blobs, verifyProof: () => true });

    const result = await recovery.recover({
      organizationId: ORGANIZATION,
      attemptId: 'attempt-binding-mismatch',
      actor: {
        organizationId: ORGANIZATION,
        subject: 'platform-operator',
        capability: STORAGE_RECOVERY_CAPABILITY,
        scopes: [STORAGE_RECOVERY_SCOPE],
      },
      proof: { kind: 'known-failure', reference: 'operator-record-binding-mismatch' },
      cleanupConfirmed: true,
    });

    expect(result).toMatchObject({
      status: 'retained',
      reason: 'writer-unconfirmed',
      inspection: { state: 'unknown', key: objectKey },
    });
    expect(blobs.confirmCalls).toBe(0);
    expect(blobs.objects.has(objectKey)).toBe(true);
    expect((await repository.read(ORGANIZATION)).storageAttempts?.[0]).toMatchObject({
      state: 'orphaned',
      providerBinding: PROVIDER_BINDING,
      writeReceipt: expect.objectContaining({ providerBinding: PROVIDER_BINDING }),
    });
  });
});
