import { describe, expect, it } from 'vitest';

import {
  runStorageReceiptRecoveryRehearsal,
} from '../../../scripts/storage-receipt-recovery-rehearsal.js';

function loopbackDatabaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') return undefined;
    if (!new Set(['localhost', '127.0.0.1', '::1', '[::1]']).has(parsed.hostname)) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

const databaseUrl = loopbackDatabaseUrl(
  process.env.PSKILLS_RECEIPT_REHEARSAL_DATABASE_URL ?? process.env.PSKILLS_BILLING_POSTGRES_URL,
);
const describeLocalPostgres = databaseUrl ? describe : describe.skip;

describeLocalPostgres('known-completed storage receipt recovery rehearsal', () => {
  it('uses a fresh Files SDK client and real PostgreSQL billing/state to release only verified writes', async () => {
    const evidence = await runStorageReceiptRecoveryRehearsal({
      databaseUrl: databaseUrl!,
      sourceRevision: process.env.PSKILLS_RECEIPT_REHEARSAL_SOURCE_SHA,
    });

    expect(evidence.mode).toBe('local-disposable-only');
    expect(evidence.local.storageAdapter).toBe('files-sdk/fs');
    expect(evidence.local.freshClientRestart).toBe(true);
    expect(evidence.local.receiptWasMintedAfterAwaitedReadback).toBe(true);
    expect(evidence.local.databaseObjectsDropped).toBe(true);
    expect(evidence.hosted.recoveryExecuted).toBe(false);
    expect(evidence.hosted.mutationPerformed).toBe(false);
    expect(evidence.acceptance.actualHostedRoute).toBe(false);
    expect(evidence.acceptance.productionMutation).toBe(false);
    expect(evidence.acceptance.localAssertionsPassed).toBe(true);

    expect(evidence.local.scenarios).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'metadata-failure-with-verified-receipt-after-client-restart',
        receipt: 'verified',
        recoveryStatus: 'released',
        objectAfterRecovery: 'absent',
        billingStorageBytesAfterRecovery: 0,
        metadataStateAfterRecovery: 'released',
      }),
      expect.objectContaining({
        name: 'unknown-provider-outcome-without-receipt',
        receipt: 'absent',
        recoveryStatus: 'retained',
        recoveryReason: 'writer-unconfirmed',
        objectAfterRecovery: 'present',
        metadataStateAfterRecovery: 'orphaned',
      }),
      expect.objectContaining({
        name: 'binding-mismatch-receipt-retained',
        receipt: 'binding-mismatch',
        recoveryStatus: 'retained',
        recoveryReason: 'writer-unconfirmed',
        objectAfterRecovery: 'present',
        metadataStateAfterRecovery: 'orphaned',
      }),
    ]));
  });
});
