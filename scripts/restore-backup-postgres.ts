/*
 * Read-only PostgreSQL source capture for the logical backup utility.
 *
 * This adapter deliberately does not use PostgresStateRepository.read(): that
 * method creates a missing organization row and performs its SELECT outside a
 * caller-controlled snapshot.  The source capture instead selects the one
 * organization row in a repeatable-read, read-only transaction, then hands a
 * frozen copy to createLogicalBackup.  Blob reads happen only for references
 * present in that captured state; createLogicalBackup writes the manifest only
 * after every object has passed its digest and size check.
 */

import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import type {
  BlobStore,
  RegistryState,
  StateRepository,
} from '../packages/contracts/src/index.js';
import {
  assertRegistryState,
  cloneRegistryState,
  StateRepositoryError,
  stateRevision,
  type PgClientLike,
  type PgPoolLike,
} from '../packages/database/src/index.js';
import { createNodeFilesSdkBlobStore } from '../packages/storage/src/node.js';
import {
  createLogicalBackup,
  type CaptureConsistency,
  type CreateLogicalBackupResult,
  type DeletionFenceEvidence,
  type QualifiedLocation,
  RestoreBackupError,
} from './restore-backup.js';

export const DEFAULT_POSTGRES_STATE_TABLE = 'private_skills_registry_state';
export const POSTGRES_SNAPSHOT_CONSISTENCY: CaptureConsistency = 'postgres-mvcc-snapshot';

export type PostgresSnapshotErrorCode =
  | 'INVALID_OPTIONS'
  | 'FENCE_REQUIRED'
  | 'SNAPSHOT_MISSING'
  | 'SNAPSHOT_INVALID'
  | 'SNAPSHOT_UNAVAILABLE';

/** Errors are intentionally short and contain no connection or credential data. */
export class PostgresSnapshotError extends Error {
  readonly code: PostgresSnapshotErrorCode;

  constructor(code: PostgresSnapshotErrorCode, message: string) {
    super(message);
    this.name = 'PostgresSnapshotError';
    this.code = code;
  }
}

export interface PostgresSnapshotRow {
  organizationId: string;
  revision: number;
  state: RegistryState;
}

export interface ReadPostgresSnapshotOptions {
  organizationId: string;
  tableName?: string;
}

export interface PostgresLogicalBackupOptions {
  /** Injected pool keeps this source adapter testable without a live service. */
  pool: PgPoolLike;
  sourceBlobs: BlobStore;
  organizationId: string;
  /** Credential-free provider/deployment identity used in the manifest. */
  sourceIdentity: string;
  backupDirectory: string;
  /** Current manifest format records this as an operational availability fence. */
  deletionFence: DeletionFenceEvidence;
  /** Defaults to a composite identity covering PostgreSQL and private blobs. */
  sourceLocation?: QualifiedLocation;
  tableName?: string;
  maxTotalObjectBytes?: number;
  now?: () => Date;
}

export interface PostgresBackupPool {
  pool: PgPoolLike;
  close(): Promise<void>;
}

function boundedString(value: unknown, field: string, maxLength: number): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > maxLength ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new PostgresSnapshotError('INVALID_OPTIONS', `${field} is invalid`);
  }
  return value;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier)) {
    throw new PostgresSnapshotError('INVALID_OPTIONS', 'state table name is invalid');
  }
  return `"${identifier}"`;
}

function parseRevision(value: unknown): number {
  let revision: number;
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new PostgresSnapshotError('SNAPSHOT_INVALID', 'state revision is outside the supported range');
    }
    revision = Number(value);
  } else if (typeof value === 'string') {
    if (!/^\d+$/u.test(value)) {
      throw new PostgresSnapshotError('SNAPSHOT_INVALID', 'state revision is invalid');
    }
    revision = Number(value);
  } else if (typeof value === 'number') {
    revision = value;
  } else {
    throw new PostgresSnapshotError('SNAPSHOT_INVALID', 'state revision is missing');
  }
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new PostgresSnapshotError('SNAPSHOT_INVALID', 'state revision is invalid');
  }
  return revision;
}

function decodeState(value: unknown, revision: number): RegistryState {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new PostgresSnapshotError('SNAPSHOT_INVALID', 'state JSON is invalid');
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PostgresSnapshotError('SNAPSHOT_INVALID', 'state value is invalid');
  }
  let state: RegistryState;
  try {
    state = cloneRegistryState(parsed as RegistryState);
  } catch {
    throw new PostgresSnapshotError('SNAPSHOT_INVALID', 'state value is not cloneable');
  }
  const embeddedRevision = (state as RegistryState & { metadataRevision?: unknown }).metadataRevision;
  if (embeddedRevision !== undefined && embeddedRevision !== revision) {
    throw new PostgresSnapshotError('SNAPSHOT_INVALID', 'state and row revisions differ');
  }
  (state as RegistryState & { metadataRevision?: number }).metadataRevision = revision;
  try {
    assertRegistryState(state);
  } catch {
    throw new PostgresSnapshotError('SNAPSHOT_INVALID', 'state value failed validation');
  }
  if (stateRevision(state) !== revision) {
    throw new PostgresSnapshotError('SNAPSHOT_INVALID', 'state and row revisions differ');
  }
  return state;
}

function asSnapshotRow(row: Record<string, unknown> | undefined, organizationId: string): PostgresSnapshotRow {
  if (!row) throw new PostgresSnapshotError('SNAPSHOT_MISSING', 'organization state row is missing');
  if (row.organization_id !== organizationId) {
    throw new PostgresSnapshotError('SNAPSHOT_INVALID', 'organization state row does not match the requested organization');
  }
  const revision = parseRevision(row.revision);
  return { organizationId, revision, state: decodeState(row.state, revision) };
}

/**
 * Read one organization row without creating rows, running migrations, or
 * exposing a non-snapshot read to the caller.
 */
export async function readPostgresOrganizationSnapshot(
  pool: PgPoolLike,
  options: ReadPostgresSnapshotOptions,
): Promise<PostgresSnapshotRow> {
  const organizationId = boundedString(options.organizationId, 'organizationId', 512);
  const tableName = options.tableName ?? DEFAULT_POSTGRES_STATE_TABLE;
  const table = quoteIdentifier(boundedString(tableName, 'tableName', 128));
  let client: PgClientLike | undefined;
  let inTransaction = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    inTransaction = true;
    const result = await client.query<Record<string, unknown>>(
      `SELECT organization_id, revision, state FROM ${table} WHERE organization_id = $1`,
      [organizationId],
    );
    if (result.rows.length !== 1) {
      throw new PostgresSnapshotError(
        result.rows.length === 0 ? 'SNAPSHOT_MISSING' : 'SNAPSHOT_INVALID',
        result.rows.length === 0 ? 'organization state row is missing' : 'organization state row is ambiguous',
      );
    }
    const snapshot = asSnapshotRow(result.rows[0], organizationId);
    await client.query('COMMIT');
    inTransaction = false;
    return snapshot;
  } catch (error) {
    if (inTransaction) {
      try { await client?.query('ROLLBACK'); } catch { /* retain the sanitized source error */ }
    }
    if (error instanceof PostgresSnapshotError) throw error;
    throw new PostgresSnapshotError('SNAPSHOT_UNAVAILABLE', 'PostgreSQL snapshot could not be read');
  } finally {
    try { await client?.release?.(); } catch { /* release failure cannot expose source details */ }
  }
}

function frozenSnapshotRepository(snapshot: PostgresSnapshotRow): StateRepository {
  return {
    async read(organizationId: string): Promise<RegistryState> {
      if (organizationId !== snapshot.organizationId) {
        throw new StateRepositoryError('ORGANIZATION_MISMATCH', 'snapshot organization does not match the requested organization');
      }
      return cloneRegistryState(snapshot.state);
    },
    async transaction<T>(): Promise<T> {
      throw new StateRepositoryError('READ_ONLY_SNAPSHOT', 'PostgreSQL source snapshots are read-only');
    },
  };
}

/**
 * Capture a logical backup from a PostgreSQL MVCC row and its referenced
 * private objects.  The backup utility owns state/reference traversal,
 * aggregate limits, private files, and final-manifest ordering.
 */
export async function createPostgresLogicalBackup(
  options: PostgresLogicalBackupOptions,
): Promise<CreateLogicalBackupResult> {
  if (!options?.pool || !options.sourceBlobs) {
    throw new PostgresSnapshotError('INVALID_OPTIONS', 'PostgreSQL pool and source blob store are required');
  }
  if (!options.deletionFence) {
    throw new PostgresSnapshotError('FENCE_REQUIRED', 'hosted source capture requires availability evidence in the current manifest format');
  }
  const organizationId = boundedString(options.organizationId, 'organizationId', 512);
  const sourceIdentity = boundedString(options.sourceIdentity, 'sourceIdentity', 512);
  const snapshot = await readPostgresOrganizationSnapshot(options.pool, {
    organizationId,
    tableName: options.tableName,
  });
  return createLogicalBackup({
    sourceRepository: frozenSnapshotRepository(snapshot),
    sourceBlobs: options.sourceBlobs,
    organizationId,
    sourceIdentity,
    sourceLocation: options.sourceLocation ?? { kind: 'composite', identity: sourceIdentity },
    backupDirectory: options.backupDirectory,
    captureConsistency: POSTGRES_SNAPSHOT_CONSISTENCY,
    deletionFence: options.deletionFence,
    maxTotalObjectBytes: options.maxTotalObjectBytes,
    now: options.now,
  });
}

/** Build the same minimal Node pool shape used by the production runtime. */
export function createPostgresBackupPool(databaseUrl: string): PostgresBackupPool {
  if (typeof databaseUrl !== 'string' || databaseUrl.trim().length === 0) {
    throw new PostgresSnapshotError('INVALID_OPTIONS', 'DATABASE_URL is required');
  }
  let sql: ReturnType<typeof postgres>;
  try {
    sql = postgres(databaseUrl, {
      max: 1,
      prepare: false,
      idle_timeout: 20,
      connect_timeout: 10,
    });
  } catch {
    throw new PostgresSnapshotError('INVALID_OPTIONS', 'DATABASE_URL is invalid');
  }
  const query = async (
    connection: typeof sql,
    text: string,
    parameters: readonly unknown[] = [],
  ) => {
    const result = await connection.unsafe(text, [...parameters] as never[]);
    return { rows: [...result], rowCount: result.count };
  };
  const pool = {
    query: (text, parameters) => query(sql, text, parameters),
    connect: async () => {
      const connection = await sql.reserve();
      return {
        query: (text: string, parameters?: readonly unknown[]) => query(connection as unknown as typeof sql, text, parameters),
        release: () => connection.release(),
      };
    },
  } as PgPoolLike;
  return {
    pool,
    close: async () => { await sql.end({ timeout: 1 }); },
  };
}

interface CliArguments {
  command: 'capture';
  values: Map<string, string>;
}

function parseCliArguments(argv: string[]): CliArguments {
  if (argv[0] !== 'capture') throw new PostgresSnapshotError('INVALID_OPTIONS', 'usage: restore-backup-postgres.ts capture --output directory');
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const value = argv[index + 1];
    if (!argument.startsWith('--') || !value || value.startsWith('--')) {
      throw new PostgresSnapshotError('INVALID_OPTIONS', 'every option requires a value');
    }
    values.set(argument.slice(2), value);
    index += 1;
  }
  return { command: 'capture', values };
}

function cliValue(values: Map<string, string>, name: string, environment: Record<string, string | undefined>, envName?: string): string {
  const value = values.get(name) ?? (envName ? environment[envName] : undefined);
  return boundedString(value, `--${name}`, 4_096);
}

function optionalPositiveInteger(value: string | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value)) throw new PostgresSnapshotError('INVALID_OPTIONS', `${field} is invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new PostgresSnapshotError('INVALID_OPTIONS', `${field} is invalid`);
  return parsed;
}

function fenceFromCli(values: Map<string, string>, environment: Record<string, string | undefined>): DeletionFenceEvidence {
  const kind = values.get('fence-kind') ?? environment.PSKILLS_BACKUP_FENCE_KIND;
  const evidenceRef = values.get('fence-evidence') ?? environment.PSKILLS_BACKUP_FENCE_EVIDENCE;
  if (!kind || !evidenceRef) {
    throw new PostgresSnapshotError('FENCE_REQUIRED', 'hosted source capture requires explicit availability evidence');
  }
  const observedAt = values.get('fence-observed-at') ?? environment.PSKILLS_BACKUP_FENCE_OBSERVED_AT ?? new Date().toISOString();
  return {
    scope: 'hosted',
    kind: kind as DeletionFenceEvidence['kind'],
    evidenceRef: boundedString(evidenceRef, 'fence evidence', 2_048),
    observedAt: boundedString(observedAt, 'fence observedAt', 128),
  };
}

/**
 * CLI capture command.  It reads only DATABASE_URL and BLOB_READ_WRITE_TOKEN
 * from the environment and prints status metadata without source IDs, keys,
 * connection strings, object bytes, or manifest contents.
 */
export async function main(
  argv = process.argv.slice(2),
  environment: Record<string, string | undefined> = process.env,
): Promise<void> {
  const parsed = parseCliArguments(argv);
  if (environment.PSKILLS_STATE_PROVIDER && environment.PSKILLS_STATE_PROVIDER !== 'postgres') {
    throw new PostgresSnapshotError('INVALID_OPTIONS', 'PostgreSQL source capture requires PSKILLS_STATE_PROVIDER=postgres');
  }
  const organizationId = cliValue(parsed.values, 'organization', environment, 'PSKILLS_ORGANIZATION_ID');
  const sourceIdentity = cliValue(parsed.values, 'source-id', environment, 'PSKILLS_BACKUP_SOURCE_ID');
  const output = resolve(cliValue(parsed.values, 'output', environment));
  const databaseUrl = boundedString(environment.DATABASE_URL, 'DATABASE_URL', 16_384);
  const blobToken = boundedString(environment.BLOB_READ_WRITE_TOKEN, 'BLOB_READ_WRITE_TOKEN', 32_768);
  const tableName = parsed.values.get('table') ?? environment.PSKILLS_STATE_TABLE ?? DEFAULT_POSTGRES_STATE_TABLE;
  const maxTotalObjectBytes = optionalPositiveInteger(
    parsed.values.get('max-total-object-bytes') ?? environment.PSKILLS_BACKUP_MAX_TOTAL_OBJECT_BYTES,
    'max-total-object-bytes',
  );
  const prefix = parsed.values.get('blob-prefix') ?? environment.PSKILLS_STORAGE_PREFIX;
  const fence = fenceFromCli(parsed.values, environment);
  const runtime = createPostgresBackupPool(databaseUrl);
  try {
    const blobs = await createNodeFilesSdkBlobStore({
      provider: 'vercel-blob',
      prefix,
      credentials: { token: blobToken },
    });
    const result = await createPostgresLogicalBackup({
      pool: runtime.pool,
      sourceBlobs: blobs,
      organizationId,
      sourceIdentity,
      backupDirectory: output,
      tableName,
      maxTotalObjectBytes,
      deletionFence: fence,
    });
    console.log(JSON.stringify({
      ok: true,
      operation: 'postgres-backup',
      organizationId,
      metadataRevision: result.manifest.metadataRevision,
      objectCount: result.objectCount,
    }));
  } finally {
    await runtime.close();
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const code = error instanceof PostgresSnapshotError || error instanceof RestoreBackupError
      ? error.code
      : 'POSTGRES_BACKUP_FAILED';
    console.error(JSON.stringify({ ok: false, code }));
    process.exitCode = 1;
  });
}
