import { describe, expect, it } from 'vitest';
import type { StoredBlob, StorageAttempt } from '../../contracts/src/index.js';
import {
  FilesSdkBlobStore,
  createVerifiedStorageWriteReceipt,
  digestBytes,
  isVerifiedStorageWriteReceipt,
  storageProviderBinding,
} from '../src/index.js';

class InMemoryFilesClient {
  readonly objects = new Map<string, Uint8Array>();

  async upload(key: string, body: Uint8Array): Promise<void> {
    if (this.objects.has(key)) throw new Error('overwrite');
    this.objects.set(key, body.slice());
  }

  async download(key: string): Promise<{ size: number; arrayBuffer: () => Promise<ArrayBuffer> }> {
    const body = this.objects.get(key);
    if (!body) throw Object.assign(new Error('not found'), { status: 404 });
    return { size: body.byteLength, arrayBuffer: async () => body.slice().buffer };
  }

  async head(key: string): Promise<{ size: number }> {
    const body = this.objects.get(key);
    if (!body) throw Object.assign(new Error('not found'), { status: 404 });
    return { size: body.byteLength };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

async function storedAttempt(store: FilesSdkBlobStore): Promise<{
  attempt: StorageAttempt;
  stored: StoredBlob;
}> {
  const bytes = new TextEncoder().encode('verified receipt bytes');
  const stored = await store.put(bytes);
  return {
    stored,
    attempt: {
      id: 'attempt-receipt',
      organizationId: 'org-receipt',
      reservationKey: 'reservation-receipt',
      digest: stored.digest,
      size: stored.size,
      state: 'pending',
      providerBinding: store.providerBinding,
      objectKey: stored.key,
      createdAt: '2026-09-16T00:00:00.000Z',
      updatedAt: '2026-09-16T00:00:00.000Z',
    },
  };
}

describe('verified storage write receipts', () => {
  it('binds a receipt to the exact adapter configuration and stored bytes', async () => {
    const store = new FilesSdkBlobStore({
      client: new InMemoryFilesClient(),
      prefix: 'private',
      providerBinding: 'files-sdk:local:private',
    });
    const { attempt, stored } = await storedAttempt(store);
    const receipt = createVerifiedStorageWriteReceipt(
      store,
      attempt,
      stored,
      () => new Date('2026-09-16T01:02:03.000Z'),
    );

    expect(storageProviderBinding(store)).toBe('files-sdk:local:private');
    expect(receipt).toEqual({
      kind: 'verified',
      providerBinding: 'files-sdk:local:private',
      key: stored.key,
      digest: stored.digest,
      size: stored.size,
      completedAt: '2026-09-16T01:02:03.000Z',
    });
    expect(isVerifiedStorageWriteReceipt(receipt, {
      providerBinding: attempt.providerBinding,
      key: attempt.objectKey,
      digest: attempt.digest,
      size: attempt.size,
    })).toBe(true);
  });

  it('does not mint a receipt for an unbound legacy store or a switched binding', async () => {
    const bytes = new TextEncoder().encode('legacy bytes');
    const unbound = new FilesSdkBlobStore({ client: new InMemoryFilesClient() });
    const stored = await unbound.put(bytes);
    const attempt: StorageAttempt = {
      id: 'attempt-legacy',
      organizationId: 'org-receipt',
      reservationKey: 'reservation-legacy',
      digest: await digestBytes(bytes),
      size: bytes.byteLength,
      state: 'pending',
      objectKey: stored.key,
      createdAt: '2026-09-16T00:00:00.000Z',
      updatedAt: '2026-09-16T00:00:00.000Z',
    };
    expect(createVerifiedStorageWriteReceipt(unbound, attempt, stored)).toBeUndefined();

    const bound = new FilesSdkBlobStore({
      client: new InMemoryFilesClient(),
      providerBinding: 'files-sdk:local:other',
    });
    expect(createVerifiedStorageWriteReceipt(bound, {
      ...attempt,
      providerBinding: 'files-sdk:local:private',
    }, stored)).toBeUndefined();
  });

  it('rejects malformed or mismatched receipt fields', () => {
    expect(isVerifiedStorageWriteReceipt({
      kind: 'verified',
      providerBinding: 'files-sdk:local:private',
      key: 'sealed/key',
      digest: 'sha256:bad',
      size: 4,
      completedAt: '2026-09-16T00:00:00.000Z',
    })).toBe(false);
    expect(isVerifiedStorageWriteReceipt({
      kind: 'verified',
      providerBinding: 'files-sdk:local:private',
      key: 'sealed/key',
      digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      size: 4,
      completedAt: '2026-09-16T00:00:00.000Z',
    }, { providerBinding: 'files-sdk:local:other' })).toBe(false);
  });
});
