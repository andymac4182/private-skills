import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

import {
  BillingService,
  PostgresBillingRepository,
  billingPostgresSchemaSql,
  createPlanCatalog,
  type BillingPgPoolLike,
  type PlanDefinition,
  type PlanId,
} from '../packages/billing/src/index.js';
import {
  PostgresStateRepository,
  defaultRegistryState,
  postgresStateSchemaSql,
  type PgPoolLike,
} from '../packages/database/src/index.js';
import {
  STORAGE_RECOVERY_CAPABILITY,
  STORAGE_RECOVERY_SCOPE,
  StorageRecoveryService,
  createDurableStorageRecoveryProofVerifier,
  createVerifiedStorageWriteReceipt,
  digestBytes,
} from '../packages/storage/src/index.js';
import { createNodeFilesSdkBlobStore } from '../packages/storage/src/node.js';
import { createRegistryHandler } from '../packages/core/src/index.js';
import type {
  Authenticator,
  Digest,
  Principal,
  RegistryState,
  StateRepository,
  StorageAttempt,
} from '../packages/contracts/src/index.js';

/**
 * Local-only recovery rehearsal. The database URL is intentionally restricted
 * to loopback so this helper cannot be pointed at a hosted database by
 * accident. The hosted production section in the returned manifest is a
 * proposal boundary only; this module never writes to or deletes from it.
 */

const REHEARSAL_ORIGIN = 'https://storage-receipt-rehearsal.example.test';
const FIXED_NOW = new Date('2026-09-16T00:00:00.000Z');
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

type SqlClient = ReturnType<typeof postgres>;
type SqlExecutor = Pick<SqlClient, 'unsafe'>;

export interface StorageReceiptRecoveryRehearsalOptions {
  /** Must be a loopback PostgreSQL URL; credentials stay in-process. */
  databaseUrl: string;
  /** A stable source SHA may be supplied by the operator for the manifest. */
  sourceRevision?: string;
  /** Override the generated ephemeral root for a caller-owned disposable run. */
  storageRoot?: string;
  /** Override the generated private prefix for a caller-owned disposable run. */
  storagePrefix?: string;
  /** Deterministic timestamp is useful for a reproducible local fixture. */
  now?: Date;
}

export interface StorageReceiptRecoveryScenarioEvidence {
  readonly name: string;
  readonly organizationId: string;
  readonly objectKeyFingerprint: string;
  readonly reservationBytes: number;
  readonly receipt: 'verified' | 'absent' | 'binding-mismatch';
  readonly recoveryStatus: 'released' | 'retained';
  readonly recoveryReason?: string;
  readonly objectAfterRecovery: 'absent' | 'present';
  readonly billingStorageBytesAfterRecovery: number;
  readonly metadataStateAfterRecovery: StorageAttempt['state'];
}

export interface StorageReceiptRecoveryRehearsalEvidence {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly sourceRevision?: string;
  readonly mode: 'local-disposable-only';
  readonly hosted: {
    readonly registryProjectId: 'prj_vw4QlLtnsPaZm8mtms1HuDqpSNti';
    readonly blobStoreId: 'store_C0EMhnU7DH3uSMaw';
    readonly recoveryExecuted: false;
    readonly mutationPerformed: false;
    readonly readOnlyProbe: 'operator-supplied-separately';
    readonly inertPrefixProposal: string;
  };
  readonly local: {
    readonly postgresHost: string;
    readonly stateTable: string;
    readonly billingTablePrefix: string;
    readonly databaseObjectsDropped: boolean;
    readonly storageAdapter: 'files-sdk/fs';
    readonly storageRootEphemeral: boolean;
    readonly storagePrefix: string;
    readonly providerBinding: string;
    readonly freshClientRestart: true;
    readonly receiptWasMintedAfterAwaitedReadback: true;
    readonly scenarios: readonly StorageReceiptRecoveryScenarioEvidence[];
  };
  readonly acceptance: {
    readonly actualHostedRoute: false;
    readonly productionMutation: false;
    readonly localAssertionsPassed: true;
    readonly requiredExternalInputs: readonly string[];
  };
}

interface QueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  rows: Row[];
  rowCount: number;
}

async function query<Row extends Record<string, unknown> = Record<string, unknown>>(
  executor: SqlExecutor,
  statement: string,
  parameters?: readonly unknown[],
): Promise<QueryResult<Row>> {
  const values = parameters === undefined ? undefined : [...parameters] as never;
  const rows = await executor.unsafe<Row[]>(statement, values);
  return { rows: Array.from(rows), rowCount: rows.count };
}

function queryForPool<Row = Record<string, unknown>>(
  executor: SqlExecutor,
  statement: string,
  parameters?: readonly unknown[],
): Promise<{ rows: Row[]; rowCount: number }> {
  // The postgres driver exposes an unconstrained generic row type while the
  // repository adapters use the same structural result. Keep this cast at
  // the host boundary rather than weakening either shared contract.
  return query(executor, statement, parameters) as unknown as Promise<{ rows: Row[]; rowCount: number }>;
}

function assertLoopbackDatabaseUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('storage receipt rehearsal requires a valid PostgreSQL URL');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('storage receipt rehearsal requires a PostgreSQL URL');
  }
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error('storage receipt rehearsal refuses non-loopback PostgreSQL targets');
  }
  return parsed;
}

function safeName(prefix: string, suffix: string): string {
  const value = `${prefix}_${suffix}`;
  assert(value.length <= 54, `generated PostgreSQL identifier is too long: ${value}`);
  assert(/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value), `generated PostgreSQL identifier is unsafe: ${value}`);
  return value;
}

function principal(organizationId: string): Principal {
  return {
    organizationId,
    subject: 'receipt-rehearsal-publisher',
    roles: ['owner', 'admin', 'publisher', 'reader'],
    namespaces: ['@rehearsal'],
    scopes: ['skills:publish', 'skills:write', 'skills:read', 'registry:read'],
  };
}

function bundle(): {
  format: 'pskills-bundle-v1';
  files: Array<{ path: string; content: string }>;
} {
  const bytes = new TextEncoder().encode(
    '---\nname: receipt-rehearsal\ndescription: local storage receipt rehearsal\n---\n',
  );
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return {
    format: 'pskills-bundle-v1',
    files: [{ path: 'SKILL.md', content: btoa(binary) }],
  };
}

function requestFor(
  organizationId: string,
  attemptId: string,
  cleanupConfirmed = true,
) {
  return {
    organizationId,
    attemptId,
    actor: {
      organizationId,
      subject: 'platform-operator',
      capability: STORAGE_RECOVERY_CAPABILITY,
      scopes: [STORAGE_RECOVERY_SCOPE],
    },
    proof: {
      kind: 'writer-terminated' as const,
      reference: `runtime-storage-attempt:${attemptId}`,
    },
    cleanupConfirmed,
  };
}

function billingPlanCatalog() {
  const plans: PlanDefinition[] = [{
    id: 'free' as PlanId,
    label: 'Free',
    description: 'Disposable storage receipt rehearsal plan.',
    limits: { seats: 4, storageBytes: 10_000_000, scansPerMonth: 10, eveCostCentsPerMonth: 100 },
    public: true,
  }];
  return createPlanCatalog({ plans });
}

function makeBilling(pool: BillingPgPoolLike, tablePrefix: string, nowMs: number): BillingService {
  return new BillingService({
    repository: new PostgresBillingRepository(pool, {
      tablePrefix,
      maxUsageOperations: 64,
      now: () => nowMs,
    }),
    catalog: billingPlanCatalog(),
    enabled: true,
    usageEnabled: true,
    now: () => nowMs,
  });
}

function makeAttempt(input: {
  organizationId: string;
  id: string;
  reservationKey: string;
  digest: Digest;
  size: number;
  objectKey: string;
  providerBinding: string;
  reservationGeneration: number;
  writeReceipt?: StorageAttempt['writeReceipt'];
}): StorageAttempt {
  return {
    id: input.id,
    organizationId: input.organizationId,
    reservationKey: input.reservationKey,
    digest: input.digest,
    size: input.size,
    state: 'orphaned',
    reservationGeneration: input.reservationGeneration,
    providerBinding: input.providerBinding,
    ...(input.writeReceipt === undefined ? {} : { writeReceipt: input.writeReceipt }),
    createdAt: FIXED_NOW.toISOString(),
    updatedAt: FIXED_NOW.toISOString(),
    objectKey: input.objectKey,
  };
}

/** Inject the same failure boundary used by the core metadata-commit tests. */
class FailMetadataCommitRepository implements StateRepository {
  #transactionCount = 0;

  constructor(private readonly inner: StateRepository) {}

  read(organizationId: string) {
    return this.inner.read(organizationId);
  }

  async transaction<T>(organizationId: string, updater: (state: RegistryState) => T): Promise<T> {
    this.#transactionCount += 1;
    // Core transaction 1 records the pending storage attempt. Transaction 2
    // is the metadata/job commit after the provider's verified readback. The
    // core catch path then records the durable orphan in transaction 3.
    if (this.#transactionCount === 2) {
      throw new Error('intentional metadata commit failure after verified upload');
    }
    return this.inner.transaction(organizationId, updater);
  }
}

function fingerprint(value: string): string {
  // Object keys and temporary paths are intentionally not emitted. The
  // digest is enough to correlate the local evidence without exposing them.
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

async function scenarioEvidence(input: {
  name: string;
  organizationId: string;
  attempt: StorageAttempt;
  activeProviderBinding: string;
  result: { status: 'released' | 'retained'; reason?: string };
  objectAfterRecovery: 'absent' | 'present';
  billingStorageBytesAfterRecovery: number;
  repository: StateRepository;
}): Promise<StorageReceiptRecoveryScenarioEvidence> {
  const state = await input.repository.read(input.organizationId);
  const persisted = state.storageAttempts?.find((candidate) => candidate.id === input.attempt.id);
  assert(persisted, `scenario ${input.name} did not persist its attempt`);
  return {
    name: input.name,
    organizationId: input.organizationId,
    objectKeyFingerprint: fingerprint(input.attempt.objectKey ?? 'missing'),
    reservationBytes: input.attempt.size,
    receipt: input.attempt.writeReceipt === undefined
      ? 'absent'
      : input.attempt.writeReceipt.providerBinding === input.activeProviderBinding
        ? 'verified'
        : 'binding-mismatch',
    recoveryStatus: input.result.status,
    ...(input.result.reason === undefined ? {} : { recoveryReason: input.result.reason }),
    objectAfterRecovery: input.objectAfterRecovery,
    billingStorageBytesAfterRecovery: input.billingStorageBytesAfterRecovery,
    metadataStateAfterRecovery: persisted.state,
  };
}

/**
 * Run the complete local rehearsal. It uses a real Files SDK filesystem
 * adapter, a real PostgreSQL state repository, and a real PostgreSQL-backed
 * BillingService. The filesystem root and all SQL tables are disposable.
 */
export async function runStorageReceiptRecoveryRehearsal(
  options: StorageReceiptRecoveryRehearsalOptions,
): Promise<StorageReceiptRecoveryRehearsalEvidence> {
  const parsedUrl = assertLoopbackDatabaseUrl(options.databaseUrl);
  const now = options.now ?? FIXED_NOW;
  assert(Number.isFinite(now.getTime()), 'rehearsal clock is invalid');
  const suffix = `${process.pid}_${randomBytes(6).toString('hex')}`;
  const tablePrefix = safeName('receipt_rehearsal', suffix);
  const stateTable = safeName(`${tablePrefix}_registry`, 'state');
  const root = options.storageRoot ?? await mkdtemp(join(tmpdir(), 'private-skills-receipt-rehearsal-'));
  const ownsRoot = options.storageRoot === undefined;
  const storagePrefix = options.storagePrefix ?? `rehearsal-${suffix}`;
  const providerBinding = `rehearsal:fs:${suffix}`;
  const organizations = {
    positive: `org-receipt-positive-${suffix}`,
    unknown: `org-receipt-unknown-${suffix}`,
    mismatch: `org-receipt-mismatch-${suffix}`,
  } as const;
  const sql = postgres(options.databaseUrl, { max: 8, onnotice: () => undefined });
  const pool = {
    query: <Row = Record<string, unknown>>(statement: string, parameters?: readonly unknown[]) => queryForPool<Row>(sql, statement, parameters),
    connect: async () => {
      const reserved = await sql.reserve();
      return {
        query: <Row = Record<string, unknown>>(statement: string, parameters?: readonly unknown[]) => queryForPool<Row>(reserved, statement, parameters),
        release: () => reserved.release(),
      };
    },
  } as unknown as BillingPgPoolLike & PgPoolLike;
  let tablesCreated = false;
  try {
    // Mark cleanup as required before either DDL statement. If the second
    // statement fails, the first table is still part of this disposable run.
    tablesCreated = true;
    await pool.query(postgresStateSchemaSql(stateTable));
    await pool.query(billingPostgresSchemaSql(tablePrefix));
    const stateRepository = new PostgresStateRepository(pool, {
      tableName: stateTable,
      autoMigrate: false,
      stateFactory: () => defaultRegistryState({ production: false, allowUnscanned: true }),
    });
    const positiveBilling = makeBilling(pool, tablePrefix, now.getTime());
    const positiveBlobs = await createNodeFilesSdkBlobStore({
      provider: 'fs',
      root,
      prefix: storagePrefix,
      providerBinding,
    });
    const auth: Authenticator = { authenticate: async () => principal(organizations.positive) };
    const handler = createRegistryHandler({
      repository: new FailMetadataCommitRepository(stateRepository),
      blobs: positiveBlobs,
      auth,
      billing: positiveBilling,
      config: {
        publicOrigin: REHEARSAL_ORIGIN,
        maxBodyBytes: 2 * 1024 * 1024,
        organizationId: organizations.positive,
        leaseSeconds: 30,
      },
    });
    const publish = await handler(new Request(`${REHEARSAL_ORIGIN}/v1/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '@rehearsal/receipt-positive',
        version: '1.0.0',
        bundle: bundle(),
      }),
    }));
    assert.equal(publish.status, 500, 'the injected metadata failure must fail the publish response');
    const failedState = await stateRepository.read(organizations.positive);
    const positiveAttempt = failedState.storageAttempts?.[0];
    assert(positiveAttempt, 'metadata failure did not leave a storage attempt');
    assert.equal(positiveAttempt.state, 'orphaned');
    assert(positiveAttempt.objectKey, 'metadata failure did not preserve the stable object key');
    assert(positiveAttempt.writeReceipt, 'verified upload receipt was not persisted');
    assert.equal(positiveAttempt.writeReceipt.providerBinding, providerBinding);
    assert.equal(positiveAttempt.writeReceipt.key, positiveAttempt.objectKey);

    // A second Files SDK instance represents a process restart. It has no
    // in-memory record cache but points at the same private filesystem root.
    const restartedBlobs = await createNodeFilesSdkBlobStore({
      provider: 'fs',
      root,
      prefix: storagePrefix,
      providerBinding,
    });
    assert.equal(restartedBlobs.providerBinding, positiveBlobs.providerBinding);
    const restartedBilling = makeBilling(pool, tablePrefix, now.getTime());
    const recovery = new StorageRecoveryService({
      repository: stateRepository,
      blobs: restartedBlobs,
      billing: restartedBilling,
      verifyProof: createDurableStorageRecoveryProofVerifier(stateRepository),
    });
    const positiveResult = await recovery.recover(requestFor(organizations.positive, positiveAttempt.id));
    assert.equal(positiveResult.status, 'released');
    assert.equal(positiveResult.inspection, 'deleted');
    assert.equal(positiveResult.billing, 'reconciled');
    const positiveInspection = await restartedBlobs.inspectObject(positiveAttempt.objectKey);
    assert.deepEqual(positiveInspection, { state: 'absent', key: positiveAttempt.objectKey });
    const positiveUsage = await restartedBilling.usageSnapshot(organizations.positive);
    assert.equal(positiveUsage.usage.storageBytes, 0, 'billing may reach zero only after verified cleanup');
    const positiveOperation = await restartedBilling.findUsageOperation(
      organizations.positive,
      `private-skills:storage-recovery:${positiveAttempt.id}:generation:${positiveAttempt.reservationGeneration}`,
    );
    assert.equal(positiveOperation?.status, 'released');

    const scenarios: StorageReceiptRecoveryScenarioEvidence[] = [await scenarioEvidence({
      name: 'metadata-failure-with-verified-receipt-after-client-restart',
      organizationId: organizations.positive,
      attempt: positiveAttempt,
      activeProviderBinding: providerBinding,
      result: positiveResult,
      objectAfterRecovery: 'absent',
      billingStorageBytesAfterRecovery: positiveUsage.usage.storageBytes,
      repository: stateRepository,
    })];

    // Unknown outcome: the bytes are present but no receipt and no provider
    // termination callback exist. Recovery must retain both object and charge.
    const unknownBilling = makeBilling(pool, tablePrefix, now.getTime());
    const unknownBlobs = await createNodeFilesSdkBlobStore({
      provider: 'fs', root, prefix: storagePrefix, providerBinding,
    });
    const unknownBytes = new TextEncoder().encode('unknown provider outcome');
    const unknownStored = await unknownBlobs.put(unknownBytes);
    const unknownReservationKey = `receipt-unknown:${suffix}`;
    const unknownAdmission = await unknownBilling.reserveUsage(
      organizations.unknown,
      { storageBytes: unknownStored.size },
      unknownReservationKey,
    );
    assert(unknownAdmission.reservationGeneration, 'unknown reservation did not return a generation');
    const unknownAttempt = makeAttempt({
      organizationId: organizations.unknown,
      id: `attempt-unknown-${suffix}`,
      reservationKey: unknownReservationKey,
      digest: unknownStored.digest,
      size: unknownStored.size,
      objectKey: unknownStored.key,
      providerBinding,
      reservationGeneration: unknownAdmission.reservationGeneration,
    });
    await stateRepository.transaction(organizations.unknown, (state) => {
      state.storageAttempts = [unknownAttempt];
    });
    const unknownRestarted = await createNodeFilesSdkBlobStore({
      provider: 'fs', root, prefix: storagePrefix, providerBinding,
    });
    const unknownRecovery = new StorageRecoveryService({
      repository: stateRepository,
      blobs: unknownRestarted,
      billing: unknownBilling,
      verifyProof: () => true,
    });
    const unknownResult = await unknownRecovery.recover(requestFor(organizations.unknown, unknownAttempt.id));
    assert.equal(unknownResult.status, 'retained');
    assert.equal(unknownResult.reason, 'writer-unconfirmed');
    const unknownInspection = await unknownRestarted.inspectObject(unknownStored.key);
    assert.equal(unknownInspection.state, 'present');
    const unknownUsage = await unknownBilling.usageSnapshot(organizations.unknown);
    assert.equal(unknownUsage.usage.storageBytes, unknownStored.size);
    scenarios.push(await scenarioEvidence({
      name: 'unknown-provider-outcome-without-receipt',
      organizationId: organizations.unknown,
      attempt: unknownAttempt,
      activeProviderBinding: providerBinding,
      result: unknownResult,
      objectAfterRecovery: 'present',
      billingStorageBytesAfterRecovery: unknownUsage.usage.storageBytes,
      repository: stateRepository,
    }));

    // Binding mismatch: even a structurally valid receipt is not finality for
    // the currently configured provider target. The exact object is retained.
    const mismatchBilling = makeBilling(pool, tablePrefix, now.getTime());
    const mismatchBlobs = await createNodeFilesSdkBlobStore({
      provider: 'fs', root, prefix: storagePrefix, providerBinding,
    });
    const mismatchBytes = new TextEncoder().encode('provider binding mismatch');
    const mismatchStored = await mismatchBlobs.put(mismatchBytes);
    const mismatchReservationKey = `receipt-mismatch:${suffix}`;
    const mismatchAdmission = await mismatchBilling.reserveUsage(
      organizations.mismatch,
      { storageBytes: mismatchStored.size },
      mismatchReservationKey,
    );
    assert(mismatchAdmission.reservationGeneration, 'mismatch reservation did not return a generation');
    const oldBinding = `rehearsal:old:${suffix}`;
    const mismatchAttempt = makeAttempt({
      organizationId: organizations.mismatch,
      id: `attempt-mismatch-${suffix}`,
      reservationKey: mismatchReservationKey,
      digest: mismatchStored.digest,
      size: mismatchStored.size,
      objectKey: mismatchStored.key,
      providerBinding: oldBinding,
      reservationGeneration: mismatchAdmission.reservationGeneration,
      writeReceipt: {
        kind: 'verified',
        providerBinding: oldBinding,
        key: mismatchStored.key,
        digest: mismatchStored.digest,
        size: mismatchStored.size,
        completedAt: now.toISOString(),
      },
    });
    await stateRepository.transaction(organizations.mismatch, (state) => {
      state.storageAttempts = [mismatchAttempt];
    });
    const mismatchRestarted = await createNodeFilesSdkBlobStore({
      provider: 'fs', root, prefix: storagePrefix, providerBinding,
    });
    const mismatchRecovery = new StorageRecoveryService({
      repository: stateRepository,
      blobs: mismatchRestarted,
      billing: mismatchBilling,
      verifyProof: () => true,
    });
    const mismatchResult = await mismatchRecovery.recover(requestFor(organizations.mismatch, mismatchAttempt.id));
    assert.equal(mismatchResult.status, 'retained');
    assert.equal(mismatchResult.reason, 'writer-unconfirmed');
    const mismatchInspection = await mismatchRestarted.inspectObject(mismatchStored.key);
    assert.equal(mismatchInspection.state, 'present');
    const mismatchUsage = await mismatchBilling.usageSnapshot(organizations.mismatch);
    assert.equal(mismatchUsage.usage.storageBytes, mismatchStored.size);
    scenarios.push(await scenarioEvidence({
      name: 'binding-mismatch-receipt-retained',
      organizationId: organizations.mismatch,
      attempt: mismatchAttempt,
      activeProviderBinding: providerBinding,
      result: mismatchResult,
      objectAfterRecovery: 'present',
      billingStorageBytesAfterRecovery: mismatchUsage.usage.storageBytes,
      repository: stateRepository,
    }));

    return {
      schemaVersion: 1,
      generatedAt: now.toISOString(),
      ...(options.sourceRevision === undefined ? {} : { sourceRevision: options.sourceRevision }),
      mode: 'local-disposable-only',
      hosted: {
        registryProjectId: 'prj_vw4QlLtnsPaZm8mtms1HuDqpSNti',
        blobStoreId: 'store_C0EMhnU7DH3uSMaw',
        recoveryExecuted: false,
        mutationPerformed: false,
        readOnlyProbe: 'operator-supplied-separately',
        inertPrefixProposal: `rehearsal/${suffix}/`,
      },
      local: {
        postgresHost: parsedUrl.hostname === '[::1]' ? '::1' : parsedUrl.hostname,
        stateTable,
        billingTablePrefix: tablePrefix,
        // The return is observed only after the finally block has completed;
        // a failed drop rejects the rehearsal rather than producing evidence.
        databaseObjectsDropped: true,
        storageAdapter: 'files-sdk/fs',
        storageRootEphemeral: ownsRoot,
        storagePrefix,
        providerBinding,
        freshClientRestart: true,
        receiptWasMintedAfterAwaitedReadback: true,
        scenarios,
      },
      acceptance: {
        actualHostedRoute: false,
        productionMutation: false,
        localAssertionsPassed: true,
        requiredExternalInputs: [
          'Loopback PostgreSQL URL for a disposable database only',
          'Hosted production Blob metadata probe result (read-only names/counts only)',
          'Operator-owned provider termination/finality evidence before any hosted recovery action',
          'Explicit cleanup and billing-release authorization for any future hosted rehearsal',
        ],
      },
    };
  } finally {
    if (tablesCreated) {
      await pool.query(`DROP TABLE IF EXISTS "${tablePrefix}_usage_operations", "${tablePrefix}_webhook_events", "${tablePrefix}_subscriptions", "${tablePrefix}_customers", "${tablePrefix}_usage", "${stateTable}"`);
      const remaining = await Promise.all([
        `${tablePrefix}_usage_operations`,
        `${tablePrefix}_webhook_events`,
        `${tablePrefix}_subscriptions`,
        `${tablePrefix}_customers`,
        `${tablePrefix}_usage`,
        stateTable,
      ].map(async (table) => (await pool.query<{ name: string | null }>('SELECT to_regclass($1) AS name', [table])).rows[0]?.name ?? null));
      assert(remaining.every((table) => table === null), 'disposable rehearsal tables were not removed');
    }
    await sql.end({ timeout: 5 });
    if (ownsRoot) await rm(root, { recursive: true, force: true });
  }
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const entryPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (entryPath !== undefined && entryPath === fileURLToPath(import.meta.url)) {
  const databaseUrl = argValue('--database-url') ?? process.env.PSKILLS_RECEIPT_REHEARSAL_DATABASE_URL;
  if (!databaseUrl) {
    process.stderr.write('Usage: pnpm exec tsx scripts/storage-receipt-recovery-rehearsal.ts --database-url <loopback-postgres-url> [--source-sha <sha>]\n');
    process.exitCode = 2;
  } else {
    const evidence = await runStorageReceiptRecoveryRehearsal({
      databaseUrl,
      sourceRevision: argValue('--source-sha') ?? process.env.PSKILLS_RECEIPT_REHEARSAL_SOURCE_SHA,
    });
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  }
}
