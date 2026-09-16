import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { list } from '@vercel/blob';

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
} from '../packages/storage/src/index.js';
import { createRegistryHandler } from '../packages/core/src/index.js';
import {
  createNodeFilesSdkBlobStore,
} from '../packages/storage/src/node.js';
import {
  digestBytes,
  encodeBundle,
} from '../packages/storage/src/index.js';
import type {
  Authenticator,
  Digest,
  Principal,
  RecoverableBlobStore,
  RegistryState,
  StateRepository,
  StorageAttempt,
  StorageObjectInspection,
  StoredBlob,
} from '../packages/contracts/src/index.js';

/**
 * Guarded production-Blob rehearsal. Plan generation is inert. Execution is
 * intentionally impossible without an explicit acknowledgement and a plan
 * whose exact fresh prefix was reviewed by the operator. The only database
 * accepted by the executor is a loopback disposable PostgreSQL target.
 */

export const HOSTED_REGISTRY_PROJECT_ID = 'prj_vw4QlLtnsPaZm8mtms1HuDqpSNti';
export const HOSTED_BLOB_STORE_ID = 'store_C0EMhnU7DH3uSMaw';
export const HOSTED_PROVIDER_BINDING = `files-sdk:vercel-blob:${HOSTED_BLOB_STORE_ID}`;
export const HOSTED_EXECUTION_ACK = 'I_UNDERSTAND_NEW_PREFIX_ONLY';
const HOSTED_PREFIX_ROOT = 'rehearsal/tenant-runtime';
const REHEARSAL_ORIGIN = 'https://storage-receipt-rehearsal.example.test';
const FIXED_NOW = new Date('2026-09-16T00:00:00.000Z');
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

type SqlClient = ReturnType<typeof postgres>;
type SqlExecutor = Pick<SqlClient, 'unsafe'>;

interface QueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  rows: Row[];
  rowCount: number;
}

export interface HostedStorageReceiptPlan {
  schemaVersion: 1;
  mode: 'hosted-execution-plan';
  generatedAt: string;
  sourceRevision?: string;
  target: {
    registryProjectId: typeof HOSTED_REGISTRY_PROJECT_ID;
    blobStoreId: typeof HOSTED_BLOB_STORE_ID;
    provider: 'vercel-blob';
    access: 'private';
    prefix: string;
    objectKey: string;
    providerBinding: typeof HOSTED_PROVIDER_BINDING;
  };
  payload: {
    fixture: 'canonical-receipt-rehearsal-bundle-v1';
    digest: Digest;
    size: number;
  };
  local: {
    database: 'loopback-postgresql-only';
    metadataFailure: 'core-commit-failure-leaves-durable-orphan';
    billing: 'postgresql-backed-billing-service';
    freshClientRecovery: true;
  };
  safety: {
    exactPrefixMustBeEmptyBeforeUpload: true;
    cleanupConfirmedRequired: true;
    deleteOnlyPlanObject: true;
    noExistingObjectMutation: true;
    credentialsReadInProcessOnly: true;
    productionAcceptanceClaim: false;
  };
}

export interface HostedStorageReceiptEvidence {
  schemaVersion: 1;
  mode: 'hosted-execution-evidence';
  sourceRevision?: string;
  target: Pick<HostedStorageReceiptPlan['target'], 'registryProjectId' | 'blobStoreId' | 'provider' | 'access' | 'prefix' | 'objectKey' | 'providerBinding'>;
  preflight: {
    exactPrefixMatches: number;
    exactPrefixHasMore: boolean;
    keysEmitted: false;
    credentialsEmitted: false;
  };
  local: {
    postgresHost: string;
    metadataFailureProducedOrphan: true;
    receiptPersisted: true;
    freshClientRestart: true;
    negativeRetentionScenarios: Array<{
      name: 'unknown-provider-outcome-without-receipt' | 'binding-mismatch-receipt-retained';
      recoveryStatus: 'retained';
      objectAfterRecovery: 'present';
      billingStorageBytesRetained: number;
    }>;
  };
  recovery: {
    receipt: 'verified';
    status: 'released';
    inspection: 'deleted';
    objectAbsentAfterDelete: true;
    exactPrefixMatchesAfterDelete: 0;
    billingStorageBytesAfterRelease: 0;
    metadataState: 'released';
  };
  safety: {
    hostedRecoveryExecuted: true;
    mutationLimitedToPlanObject: true;
    existingObjectMutation: false;
    defaultRegistryMutation: false;
    productionAcceptanceClaim: false;
  };
}

type HostedFailureStage =
  | 'plan-guard'
  | 'database-preflight'
  | 'blob-preflight'
  | 'database-setup'
  | 'publish'
  | 'orphan-verification'
  | 'client-restart'
  | 'recovery'
  | 'post-recovery-verification'
  | 'local-negative'
  | 'local-cleanup';

/**
 * Sanitized recovery instructions emitted when an execution cannot prove
 * that its exact hosted object and local durable metadata were settled. The
 * object key and generated SQL names are intentional operator identifiers;
 * provider credentials and raw error messages are never included.
 */
export interface HostedStorageReceiptFailure {
  schemaVersion: 1;
  mode: 'hosted-recovery-failure';
  sourceRevision?: string;
  target: HostedStorageReceiptPlan['target'];
  failure: {
    stage: HostedFailureStage;
    hostedWriteStarted: boolean;
    hostedRecoveryStarted: boolean;
    mutationMayHaveOccurred: boolean;
  };
  local: {
    databaseHost: string | null;
    stateTable: string | null;
    billingTablePrefix: string | null;
    organizationId: string | null;
    tableDisposition: 'retained-for-recovery' | 'not-created';
  };
  recovery: {
    exactPrefix: string;
    exactObjectKey: string;
    providerBinding: string;
    nextAction: 'inspect-durable-attempt-and-exact-object-before-retry';
  };
  safety: {
    credentialsEmitted: false;
    existingObjectMutation: false;
    defaultRegistryMutation: false;
    productionAcceptanceClaim: false;
  };
}

export class HostedStorageReceiptExecutionError extends Error {
  readonly manifest: HostedStorageReceiptFailure;

  constructor(manifest: HostedStorageReceiptFailure) {
    super(`hosted storage receipt rehearsal stopped at ${manifest.failure.stage}; inspect the retained recovery manifest before retrying`);
    this.name = 'HostedStorageReceiptExecutionError';
    this.manifest = manifest;
  }
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
  return query(executor, statement, parameters) as unknown as Promise<{ rows: Row[]; rowCount: number }>;
}

function loopbackDatabaseUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('hosted receipt rehearsal requires a valid PostgreSQL URL');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('hosted receipt rehearsal requires a PostgreSQL URL');
  }
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error('hosted receipt rehearsal refuses a non-loopback PostgreSQL target');
  }
  return parsed;
}

function safeIdentifier(value: string): string {
  assert(value.length <= 54 && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value), 'generated SQL identifier is unsafe');
  return value;
}

function fixtureBundle(): {
  format: 'pskills-bundle-v1';
  files: Array<{ path: string; content: string }>;
} {
  const bytes = new TextEncoder().encode(
    '---\nname: receipt-rehearsal\ndescription: hosted storage receipt rehearsal\n---\n',
  );
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return {
    format: 'pskills-bundle-v1',
    files: [{ path: 'SKILL.md', content: btoa(binary) }],
  };
}

async function fixtureDigest(): Promise<{ digest: Digest; size: number }> {
  const bytes = encodeBundle(fixtureBundle());
  return { digest: await digestBytes(bytes), size: bytes.byteLength };
}

/** Generate a fresh plan without contacting Vercel or PostgreSQL. */
export async function createHostedStorageReceiptPlan(sourceRevision?: string): Promise<HostedStorageReceiptPlan> {
  const nonce = randomUUID();
  const prefix = `${HOSTED_PREFIX_ROOT}/${nonce}`;
  const objectKey = `${prefix}/sealed/${randomBytes(24).toString('hex')}`;
  const payload = await fixtureDigest();
  return {
    schemaVersion: 1,
    mode: 'hosted-execution-plan',
    generatedAt: new Date().toISOString(),
    ...(sourceRevision === undefined ? {} : { sourceRevision }),
    target: {
      registryProjectId: HOSTED_REGISTRY_PROJECT_ID,
      blobStoreId: HOSTED_BLOB_STORE_ID,
      provider: 'vercel-blob',
      access: 'private',
      prefix,
      objectKey,
      providerBinding: HOSTED_PROVIDER_BINDING,
    },
    payload: {
      fixture: 'canonical-receipt-rehearsal-bundle-v1',
      digest: payload.digest,
      size: payload.size,
    },
    local: {
      database: 'loopback-postgresql-only',
      metadataFailure: 'core-commit-failure-leaves-durable-orphan',
      billing: 'postgresql-backed-billing-service',
      freshClientRecovery: true,
    },
    safety: {
      exactPrefixMustBeEmptyBeforeUpload: true,
      cleanupConfirmedRequired: true,
      deleteOnlyPlanObject: true,
      noExistingObjectMutation: true,
      credentialsReadInProcessOnly: true,
      productionAcceptanceClaim: false,
    },
  };
}

function validatePlan(plan: HostedStorageReceiptPlan): void {
  assert(plan && plan.schemaVersion === 1 && plan.mode === 'hosted-execution-plan', 'hosted receipt plan schema is invalid');
  assert(plan.target.registryProjectId === HOSTED_REGISTRY_PROJECT_ID, 'hosted receipt plan project does not match the reviewed target');
  assert(plan.target.blobStoreId === HOSTED_BLOB_STORE_ID, 'hosted receipt plan store does not match the reviewed target');
  assert(plan.target.provider === 'vercel-blob' && plan.target.access === 'private', 'hosted receipt plan provider/access is invalid');
  assert(plan.target.providerBinding === HOSTED_PROVIDER_BINDING, 'hosted receipt plan provider binding is invalid');
  assert(plan.target.prefix.startsWith(`${HOSTED_PREFIX_ROOT}/`), 'hosted receipt plan prefix is outside the rehearsal namespace');
  assert(/^rehearsal\/tenant-runtime\/[0-9a-f-]{36}$/u.test(plan.target.prefix), 'hosted receipt plan prefix must be one fresh UUID namespace');
  assert(plan.target.objectKey === `${plan.target.prefix}/sealed/${plan.target.objectKey.slice(plan.target.prefix.length + '/sealed/'.length)}`, 'hosted receipt plan key is outside its prefix');
  assert(/^[0-9a-f]{48}$/u.test(plan.target.objectKey.slice(plan.target.prefix.length + '/sealed/'.length)), 'hosted receipt plan key is not a sealed object key');
  assert(plan.safety.exactPrefixMustBeEmptyBeforeUpload && plan.safety.cleanupConfirmedRequired && plan.safety.deleteOnlyPlanObject && plan.safety.noExistingObjectMutation, 'hosted receipt plan safety flags are invalid');
  assert(/^sha256:[0-9a-f]{64}$/u.test(plan.payload.digest) && Number.isSafeInteger(plan.payload.size) && plan.payload.size > 0, 'hosted receipt plan payload identity is invalid');
}

function principal(organizationId: string): Principal {
  return {
    organizationId,
    subject: 'hosted-receipt-rehearsal-publisher',
    roles: ['owner', 'admin', 'publisher', 'reader'],
    namespaces: ['@rehearsal'],
    scopes: ['skills:publish', 'skills:write', 'skills:read', 'registry:read'],
  };
}

function billingPlanCatalog() {
  const plans: PlanDefinition[] = [{
    id: 'free' as PlanId,
    label: 'Free',
    description: 'Disposable hosted receipt rehearsal plan.',
    limits: { seats: 4, storageBytes: 10_000_000, scansPerMonth: 10, eveCostCentsPerMonth: 100 },
    public: true,
  }];
  return createPlanCatalog({ plans });
}

function makeBilling(pool: BillingPgPoolLike, tablePrefix: string): BillingService {
  return new BillingService({
    repository: new PostgresBillingRepository(pool, {
      tablePrefix,
      maxUsageOperations: 64,
      now: () => FIXED_NOW.getTime(),
    }),
    catalog: billingPlanCatalog(),
    enabled: true,
    usageEnabled: true,
    now: () => FIXED_NOW.getTime(),
  });
}

/** Fail only the post-upload metadata/job transaction, matching core's catch path. */
class FailMetadataCommitRepository implements StateRepository {
  #transactionCount = 0;

  constructor(private readonly inner: StateRepository) {}

  read(organizationId: string) {
    return this.inner.read(organizationId);
  }

  async transaction<T>(organizationId: string, updater: (state: RegistryState) => T): Promise<T> {
    this.#transactionCount += 1;
    if (this.#transactionCount === 2) throw new Error('intentional metadata commit failure after verified upload');
    return this.inner.transaction(organizationId, updater);
  }
}

/** Force core to use the reviewed plan key while retaining the real store adapter. */
class FixedKeyBlobStore implements RecoverableBlobStore {
  readonly providerBinding: string | undefined;
  #allocated = false;

  constructor(
    private readonly inner: RecoverableBlobStore,
    private readonly key: string,
  ) {
    this.providerBinding = inner.providerBinding;
  }

  allocateObjectKey(): string {
    assert(!this.#allocated, 'hosted receipt plan attempted a second provider writer');
    this.#allocated = true;
    return this.key;
  }

  put(bytes: Uint8Array): Promise<StoredBlob> {
    return this.inner.putAtKey(this.key, bytes);
  }

  putAtKey(key: string, bytes: Uint8Array): Promise<StoredBlob> {
    assert(key === this.key, 'hosted receipt plan key changed during upload');
    return this.inner.putAtKey(key, bytes);
  }

  get(key: string): Promise<Uint8Array> {
    return this.inner.get(key);
  }

  remove(key: string): Promise<void> {
    assert(key === this.key, 'hosted receipt rehearsal attempted to delete another key');
    return this.inner.remove(key);
  }

  inspectObject(key: string): Promise<StorageObjectInspection> {
    return this.inner.inspectObject(key);
  }

  confirmWriteTerminated(key: string): Promise<boolean> {
    return this.inner.confirmWriteTerminated(key);
  }
}

function recoveryRequest(organizationId: string, attemptId: string) {
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
    cleanupConfirmed: true,
  };
}

async function exactPrefixListing(prefix: string): Promise<{ matches: number; hasMore: boolean }> {
  const page = await list({ prefix, limit: 1 });
  return { matches: page.blobs.length, hasMore: page.hasMore === true };
}

type HostedPgPool = BillingPgPoolLike & PgPoolLike;

async function dropLocalTables(
  pool: HostedPgPool,
  tablePrefix: string,
  stateTable: string,
): Promise<void> {
  const tables = [
    `${tablePrefix}_usage_operations`,
    `${tablePrefix}_webhook_events`,
    `${tablePrefix}_subscriptions`,
    `${tablePrefix}_customers`,
    `${tablePrefix}_usage`,
    stateTable,
  ];
  await pool.query(`DROP TABLE IF EXISTS "${tablePrefix}_usage_operations", "${tablePrefix}_webhook_events", "${tablePrefix}_subscriptions", "${tablePrefix}_customers", "${tablePrefix}_usage", "${stateTable}"`);
  const remaining = await Promise.all(
    tables.map(async (table) =>
      (await pool.query<{ name: string | null }>('SELECT to_regclass($1) AS name', [table])).rows[0]?.name ?? null,
    ),
  );
  assert(remaining.every((table) => table === null), 'disposable hosted rehearsal tables were not removed');
}

function databaseHost(parsedUrl: URL | undefined): string | null {
  if (parsedUrl === undefined) return null;
  return parsedUrl.hostname === '[::1]' ? '::1' : parsedUrl.hostname;
}

function makeFailureManifest(
  plan: HostedStorageReceiptPlan,
  input: {
    stage: HostedFailureStage;
    parsedUrl?: URL;
    tablePrefix?: string;
    stateTable?: string;
    organizationId?: string;
    tablesCreated: boolean;
    hostedWriteStarted: boolean;
    hostedRecoveryStarted: boolean;
  },
): HostedStorageReceiptFailure {
  return {
    schemaVersion: 1,
    mode: 'hosted-recovery-failure',
    ...(plan.sourceRevision === undefined ? {} : { sourceRevision: plan.sourceRevision }),
    target: plan.target,
    failure: {
      stage: input.stage,
      hostedWriteStarted: input.hostedWriteStarted,
      hostedRecoveryStarted: input.hostedRecoveryStarted,
      mutationMayHaveOccurred: input.hostedWriteStarted || input.hostedRecoveryStarted,
    },
    local: {
      databaseHost: databaseHost(input.parsedUrl),
      stateTable: input.stateTable ?? null,
      billingTablePrefix: input.tablePrefix ?? null,
      organizationId: input.organizationId ?? null,
      tableDisposition: input.tablesCreated ? 'retained-for-recovery' : 'not-created',
    },
    recovery: {
      exactPrefix: plan.target.prefix,
      exactObjectKey: plan.target.objectKey,
      providerBinding: plan.target.providerBinding,
      nextAction: 'inspect-durable-attempt-and-exact-object-before-retry',
    },
    safety: {
      credentialsEmitted: false,
      existingObjectMutation: false,
      defaultRegistryMutation: false,
      productionAcceptanceClaim: false,
    },
  };
}

async function positiveHostedRecovery(
  plan: HostedStorageReceiptPlan,
  databaseUrl: string,
): Promise<HostedStorageReceiptEvidence> {
  let parsedUrl: URL | undefined;
  let prefixBefore = { matches: 0, hasMore: false };
  let prefixAfter = { matches: 0, hasMore: false };
  let tablePrefix: string | undefined;
  let stateTable: string | undefined;
  let organizationId: string | undefined;
  let sql: SqlClient | undefined;
  let pool: HostedPgPool | undefined;
  let tablesCreated = false;
  let cleanupVerified = false;
  let hostedWriteStarted = false;
  let hostedRecoveryStarted = false;
  let stage: HostedFailureStage = 'database-preflight';
  let caughtError: unknown;
  let cleanupError: unknown;
  let evidence: HostedStorageReceiptEvidence | undefined;

  try {
    parsedUrl = loopbackDatabaseUrl(databaseUrl);
    stage = 'blob-preflight';
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    if (!token) throw new Error('hosted receipt rehearsal requires BLOB_READ_WRITE_TOKEN in process');
    prefixBefore = await exactPrefixListing(plan.target.prefix);
    assert.equal(prefixBefore.matches, 0, 'reviewed hosted prefix is not empty');
    assert.equal(prefixBefore.hasMore, false, 'reviewed hosted prefix has more objects than the bounded probe');

    const payload = encodeBundle(fixtureBundle());
    assert.equal(payload.byteLength, plan.payload.size, 'plan payload size does not match the fixture');
    assert.equal(await digestBytes(payload), plan.payload.digest, 'plan payload digest does not match the fixture');
    const store = await createNodeFilesSdkBlobStore({
      provider: 'vercel-blob',
      prefix: plan.target.prefix,
      providerBinding: plan.target.providerBinding,
      credentials: { token, storeId: plan.target.blobStoreId },
    });
    assert.equal(store.providerBinding, plan.target.providerBinding);
    const beforeObject = await store.inspectObject(plan.target.objectKey);
    assert.deepEqual(beforeObject, { state: 'absent', key: plan.target.objectKey });

    stage = 'database-setup';
    const suffix = `${process.pid}_${randomBytes(6).toString('hex')}`;
    tablePrefix = safeIdentifier(`hosted_receipt_${suffix}`);
    stateTable = safeIdentifier(`${tablePrefix}_registry`);
    organizationId = `org-hosted-receipt-${suffix}`;
    sql = postgres(databaseUrl, { max: 8, onnotice: () => undefined });
    pool = {
      query: <Row = Record<string, unknown>>(statement: string, parameters?: readonly unknown[]) => queryForPool<Row>(sql as SqlClient, statement, parameters),
      connect: async () => {
        const reserved = await (sql as SqlClient).reserve();
        return {
          query: <Row = Record<string, unknown>>(statement: string, parameters?: readonly unknown[]) => queryForPool<Row>(reserved, statement, parameters),
          release: () => reserved.release(),
        };
      },
    } as unknown as HostedPgPool;
    tablesCreated = true;
    await pool.query(postgresStateSchemaSql(stateTable));
    await pool.query(billingPostgresSchemaSql(tablePrefix));
    const stateRepository = new PostgresStateRepository(pool, {
      tableName: stateTable,
      autoMigrate: false,
      stateFactory: () => defaultRegistryState({ production: false, allowUnscanned: true }),
    });
    const billing = makeBilling(pool, tablePrefix);
    const plannedStore = new FixedKeyBlobStore(store, plan.target.objectKey);
    const auth: Authenticator = { authenticate: async () => principal(organizationId as string) };
    const handler = createRegistryHandler({
      repository: new FailMetadataCommitRepository(stateRepository),
      blobs: plannedStore,
      auth,
      billing,
      config: {
        publicOrigin: REHEARSAL_ORIGIN,
        maxBodyBytes: 2 * 1024 * 1024,
        organizationId,
        leaseSeconds: 30,
      },
    });
    stage = 'publish';
    hostedWriteStarted = true;
    const publish = await handler(new Request(`${REHEARSAL_ORIGIN}/v1/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '@rehearsal/hosted-receipt', version: '1.0.0', bundle: fixtureBundle() }),
    }));
    assert.equal(publish.status, 500, 'the injected metadata failure must fail the hosted rehearsal publish');

    stage = 'orphan-verification';
    const failedState = await stateRepository.read(organizationId);
    const attempt = failedState.storageAttempts?.[0];
    assert(attempt, 'hosted metadata failure did not leave a storage attempt');
    assert.equal(attempt.state, 'orphaned');
    assert.equal(attempt.objectKey, plan.target.objectKey);
    assert.equal(attempt.providerBinding, plan.target.providerBinding);
    assert(attempt.writeReceipt, 'hosted awaited upload did not persist a verified receipt');
    assert.deepEqual({
      kind: attempt.writeReceipt.kind,
      providerBinding: attempt.writeReceipt.providerBinding,
      key: attempt.writeReceipt.key,
      digest: attempt.writeReceipt.digest,
      size: attempt.writeReceipt.size,
    }, {
      kind: 'verified',
      providerBinding: plan.target.providerBinding,
      key: plan.target.objectKey,
      digest: plan.payload.digest,
      size: plan.payload.size,
    });
    const billedBefore = await billing.usageSnapshot(organizationId);
    assert.equal(billedBefore.usage.storageBytes, plan.payload.size);

    // New provider client and new BillingService model a process restart while
    // retaining only the same private Blob store and durable local metadata.
    stage = 'client-restart';
    const restartedStore = await createNodeFilesSdkBlobStore({
      provider: 'vercel-blob',
      prefix: plan.target.prefix,
      providerBinding: plan.target.providerBinding,
      credentials: { token, storeId: plan.target.blobStoreId },
    });
    const recoveryStore = new FixedKeyBlobStore(restartedStore, plan.target.objectKey);
    const restartedBilling = makeBilling(pool, tablePrefix);
    const recovery = new StorageRecoveryService({
      repository: stateRepository,
      blobs: recoveryStore,
      billing: restartedBilling,
      verifyProof: createDurableStorageRecoveryProofVerifier(stateRepository),
    });
    stage = 'recovery';
    hostedRecoveryStarted = true;
    const result = await recovery.recover(recoveryRequest(organizationId, attempt.id));
    assert.equal(result.status, 'released');
    assert.equal(result.inspection, 'deleted');
    assert.equal(result.billing, 'reconciled');
    stage = 'post-recovery-verification';
    assert.deepEqual(await restartedStore.inspectObject(plan.target.objectKey), { state: 'absent', key: plan.target.objectKey });
    prefixAfter = await exactPrefixListing(plan.target.prefix);
    assert.equal(prefixAfter.matches, 0);
    assert.equal(prefixAfter.hasMore, false);
    assert.equal((await restartedBilling.usageSnapshot(organizationId)).usage.storageBytes, 0);
    assert.equal((await stateRepository.read(organizationId)).storageAttempts?.[0]?.state, 'released');

    // The local half exercises both fail-closed retention branches without
    // creating extra hosted objects in the reviewed prefix.
    stage = 'local-negative';
    const { runStorageReceiptRecoveryRehearsal } = await import('./storage-receipt-recovery-rehearsal.js');
    const local = await runStorageReceiptRecoveryRehearsal({ databaseUrl, sourceRevision: plan.sourceRevision });
    const negativeRetentionScenarios = local.local.scenarios
      .filter((scenario): scenario is typeof scenario & { name: 'unknown-provider-outcome-without-receipt' | 'binding-mismatch-receipt-retained' } => scenario.name === 'unknown-provider-outcome-without-receipt' || scenario.name === 'binding-mismatch-receipt-retained')
      .map((scenario) => ({
        name: scenario.name,
        recoveryStatus: 'retained' as const,
        objectAfterRecovery: 'present' as const,
        billingStorageBytesRetained: scenario.billingStorageBytesAfterRecovery,
      }));
    assert.equal(negativeRetentionScenarios.length, 2);
    cleanupVerified = true;
    evidence = {
      schemaVersion: 1,
      mode: 'hosted-execution-evidence',
      ...(plan.sourceRevision === undefined ? {} : { sourceRevision: plan.sourceRevision }),
      target: plan.target,
      preflight: {
        exactPrefixMatches: prefixBefore.matches,
        exactPrefixHasMore: prefixBefore.hasMore,
        keysEmitted: false,
        credentialsEmitted: false,
      },
      local: {
        postgresHost: databaseHost(parsedUrl) as string,
        metadataFailureProducedOrphan: true,
        receiptPersisted: true,
        freshClientRestart: true,
        negativeRetentionScenarios,
      },
      recovery: {
        receipt: 'verified',
        status: 'released',
        inspection: 'deleted',
        objectAbsentAfterDelete: true,
        exactPrefixMatchesAfterDelete: prefixAfter.matches,
        billingStorageBytesAfterRelease: 0,
        metadataState: 'released',
      },
      safety: {
        hostedRecoveryExecuted: true,
        mutationLimitedToPlanObject: true,
        existingObjectMutation: false,
        defaultRegistryMutation: false,
        productionAcceptanceClaim: false,
      },
    };
  } catch (error) {
    caughtError = error;
  } finally {
    if (tablesCreated && cleanupVerified && pool !== undefined && tablePrefix !== undefined && stateTable !== undefined) {
      try {
        stage = 'local-cleanup';
        await dropLocalTables(pool, tablePrefix, stateTable);
        // A successful, verified drop means there is no local durable state
        // left to recover. Keep the failure manifest's disposition truthful if
        // the connection close itself later fails.
        tablesCreated = false;
      } catch (error) {
        cleanupError = error;
      }
    }
    if (sql !== undefined) {
      try {
        await sql.end({ timeout: 5 });
      } catch (error) {
        cleanupError ??= error;
      }
    }
  }

  if (caughtError !== undefined || cleanupError !== undefined || evidence === undefined) {
    throw new HostedStorageReceiptExecutionError(makeFailureManifest(plan, {
      stage: cleanupError === undefined ? stage : 'local-cleanup',
      parsedUrl,
      tablePrefix,
      stateTable,
      organizationId,
      tablesCreated,
      hostedWriteStarted,
      hostedRecoveryStarted,
    }));
  }
  return evidence;
}

/** Execute only an exact, reviewed plan and only after the explicit acknowledgement. */
export async function executeHostedStorageReceiptPlan(
  plan: HostedStorageReceiptPlan,
  options: { databaseUrl: string; acknowledgement?: string },
): Promise<HostedStorageReceiptEvidence> {
  validatePlan(plan);
  if (options.acknowledgement !== HOSTED_EXECUTION_ACK) {
    throw new Error(`hosted receipt rehearsal is guarded; set acknowledgement to ${HOSTED_EXECUTION_ACK}`);
  }
  return positiveHostedRecovery(plan, options.databaseUrl);
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const entryPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (entryPath !== undefined && entryPath === fileURLToPath(import.meta.url)) {
  const executePath = argValue('--execute-plan');
  const writePath = argValue('--write-plan');
  const evidencePath = argValue('--write-evidence');
  const sourceRevision = argValue('--source-sha') ?? process.env.PSKILLS_RECEIPT_REHEARSAL_SOURCE_SHA;
  if (executePath) {
    // Keep the disposable database credential in the process environment. A
    // command-line URL can be exposed by process listings and shell history.
    const databaseUrl = process.env.PSKILLS_RECEIPT_REHEARSAL_DATABASE_URL;
    if (!databaseUrl) {
      process.stderr.write('Usage: PSKILLS_RECEIPT_REHEARSAL_DATABASE_URL=<loopback-postgres-url> ... --execute-plan <plan.json>\n');
      process.exitCode = 2;
    } else {
      let plan: HostedStorageReceiptPlan | undefined;
      try {
        plan = JSON.parse(await readFile(executePath, 'utf8')) as HostedStorageReceiptPlan;
        const evidence = await executeHostedStorageReceiptPlan(plan, {
          databaseUrl,
          acknowledgement: process.env.PSKILLS_ALLOW_HOSTED_STORAGE_RECEIPT_REHEARSAL,
        });
        if (evidencePath) await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
        process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
      } catch (error) {
        // A failed hosted write or recovery must leave the local durable
        // metadata available for inspection. Emit only the exact reviewed key
        // and generated table names, never the raw provider/DB error.
        const manifest = error instanceof HostedStorageReceiptExecutionError
          ? error.manifest
          : plan === undefined
            ? undefined
            : makeFailureManifest(plan, {
                stage: 'plan-guard',
                tablesCreated: false,
                hostedWriteStarted: false,
                hostedRecoveryStarted: false,
              });
        if (manifest !== undefined) {
          if (evidencePath) await writeFile(evidencePath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
          process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
        } else {
          process.stderr.write('hosted receipt rehearsal stopped before a validated plan was available\n');
        }
        process.exitCode = 1;
      }
    }
  } else {
    const plan = await createHostedStorageReceiptPlan(sourceRevision);
    if (writePath) await writeFile(writePath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  }
}
