import type {
  BlobStore,
  RecoverableBlobStore,
  StorageAttempt,
  StorageWriteReceipt,
  StoredBlob,
} from '../../contracts/src/index.js';
import { isSha256Digest } from './digest.js';

/** Provider-binding values are bounded configuration identities. */
export const STORAGE_PROVIDER_BINDING_MAX_LENGTH = 256;

/**
 * Accept a bounded identity alphabet that excludes URL/query/header
 * delimiters. Hosts remain responsible for supplying a non-secret value and
 * should change it when the endpoint, account, bucket, or private prefix
 * changes.
 */
export function normalizeStorageProviderBinding(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > STORAGE_PROVIDER_BINDING_MAX_LENGTH ||
    value !== value.trim() ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  ) {
    return undefined;
  }
  return value;
}

/** Read the adapter binding without making legacy BlobStores opt in. */
export function storageProviderBinding(store: BlobStore): string | undefined {
  try {
    return normalizeStorageProviderBinding(
      (store as Partial<RecoverableBlobStore>).providerBinding,
    );
  } catch {
    return undefined;
  }
}

export interface StorageWriteReceiptExpectation {
  providerBinding?: string;
  key?: string;
  digest?: string;
  size?: number;
}

/** Validate a receipt and, when supplied, bind every field to the attempt. */
export function isVerifiedStorageWriteReceipt(
  value: unknown,
  expected?: StorageWriteReceiptExpectation,
): value is StorageWriteReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<StorageWriteReceipt>;
  if (
    candidate.kind !== 'verified' ||
    typeof candidate.providerBinding !== 'string' ||
    normalizeStorageProviderBinding(candidate.providerBinding) !== candidate.providerBinding ||
    typeof candidate.key !== 'string' ||
    candidate.key.length === 0 ||
    candidate.key.length > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(candidate.key) ||
    !isSha256Digest(candidate.digest) ||
    !Number.isSafeInteger(candidate.size) ||
    (candidate.size as number) < 0 ||
    typeof candidate.completedAt !== 'string' ||
    candidate.completedAt.length > 64 ||
    !Number.isFinite(Date.parse(candidate.completedAt))
  ) {
    return false;
  }
  if (expected?.providerBinding !== undefined && candidate.providerBinding !== expected.providerBinding) return false;
  if (expected?.key !== undefined && candidate.key !== expected.key) return false;
  if (expected?.digest !== undefined && candidate.digest !== expected.digest) return false;
  if (expected?.size !== undefined && candidate.size !== expected.size) return false;
  return true;
}

/**
 * Mint a receipt only after the store returned a verified StoredBlob for the
 * same precommitted attempt and the provider binding stayed unchanged.
 */
export function createVerifiedStorageWriteReceipt(
  store: BlobStore,
  attempt: Pick<StorageAttempt, 'providerBinding' | 'objectKey' | 'digest' | 'size'>,
  stored: StoredBlob,
  now: () => Date = () => new Date(),
): StorageWriteReceipt | undefined {
  const binding = storageProviderBinding(store);
  if (!binding || normalizeStorageProviderBinding(attempt.providerBinding) !== attempt.providerBinding) return undefined;
  if (
    attempt.providerBinding !== binding ||
    attempt.objectKey !== stored.key ||
    attempt.digest !== stored.digest ||
    attempt.size !== stored.size ||
    !isSha256Digest(stored.digest) ||
    !Number.isSafeInteger(stored.size) ||
    stored.size < 0
  ) return undefined;
  const completedAt = now();
  if (!(completedAt instanceof Date) || !Number.isFinite(completedAt.getTime())) return undefined;
  const receipt: StorageWriteReceipt = {
    kind: 'verified',
    providerBinding: binding,
    key: stored.key,
    digest: stored.digest,
    size: stored.size,
    completedAt: completedAt.toISOString(),
  };
  return isVerifiedStorageWriteReceipt(receipt, {
    providerBinding: attempt.providerBinding,
    key: attempt.objectKey,
    digest: attempt.digest,
    size: attempt.size,
  })
    ? receipt
    : undefined;
}
