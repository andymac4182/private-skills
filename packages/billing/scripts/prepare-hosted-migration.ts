/*
 * Prepare (and, only with an explicit operator confirmation, apply) the
 * additive billing schema migration to a hosted PostgreSQL database.
 *
 * The default operation is plan-only. It acquires the billing migration
 * advisory lock in a repeatable-read, read-only transaction, captures bounded
 * identity/registry/billing baselines, and performs an independent readback.
 * The apply path is intentionally explicit and is not used by the review
 * workflow. It performs the catalog shape and zero-row checks before commit,
 * then repeats the readback on a fresh connection.
 */

import { createHash } from 'node:crypto';
import { chmod, open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import postgres from 'postgres';

import { billingPostgresSchemaSql } from '../src/repository.js';
import {
  billingSchemaIndexSpecs,
  billingSchemaManifest,
  billingSchemaTableSpecs,
  DEFAULT_BILLING_TABLE_PREFIX,
  type BillingSchemaTableSpec,
} from '../src/schema-review.js';
import {
  readBillingSchema,
  type BillingSchemaTargetReadback,
} from './schema-migration-review.js';

export const HOSTED_BILLING_MIGRATION_SQL_SHA256 = 'sha256:4386cbcd2982545c14ea9df580a34a5fb052c2441c0e8369c779c9dec851d880';
export const HOSTED_BILLING_MIGRATION_SQL_BYTE_LENGTH = 4_705;
export const HOSTED_BILLING_MIGRATION_LOCK_KEY = 'private-skills.billing-schema.v1';
export const HOSTED_BILLING_MIGRATION_CONFIRMATION = 'APPLY_PRIVATE_SKILLS_BILLING_SCHEMA_20260916';
export const HOSTED_BILLING_MIGRATION_STATEMENT_TIMEOUT_MS = 15_000;
export const HOSTED_BILLING_MIGRATION_LOCK_TIMEOUT_MS = 3_000;
export const HOSTED_BILLING_MIGRATION_IDLE_TIMEOUT_MS = 30_000;
export const HOSTED_BILLING_MIGRATION_SCHEMA = 'public';

export const HOSTED_IDENTITY_TABLE_NAMES = Object.freeze([
  'user',
  'account',
  'session',
  'verification',
  'organization',
  'member',
  'invitation',
  'rateLimit',
  'ssoProvider',
  'private_skills_company_sso_providers',
  'private_skills_identity_operations_events',
  'private_skills_service_tokens',
] as const);

export const HOSTED_REGISTRY_TABLE_NAME = 'private_skills_registry_state';

type SqlRow = Record<string, unknown>;

export interface HostedMigrationSqlExecutor {
  unsafe<Row = SqlRow>(statement: string, parameters?: readonly unknown[]): Promise<readonly Row[]>;
}

export interface HostedMigrationSqlClient extends HostedMigrationSqlExecutor {
  begin<T>(callback: (transaction: HostedMigrationSqlExecutor) => Promise<T>): Promise<T>;
  end(options?: { timeout?: number }): Promise<void>;
}

export interface HostedRelationCount {
  expectedName: string;
  schema: string | null;
  present: boolean;
  rowCount: number;
}

export interface HostedRegistryBaseline {
  schema: typeof HOSTED_BILLING_MIGRATION_SCHEMA;
  table: typeof HOSTED_REGISTRY_TABLE_NAME;
  present: boolean;
  rowCount: number;
  minimumRevision: number | null;
  maximumRevision: number | null;
  minimumStateJsonType: string | null;
  maximumStateJsonType: string | null;
  stateSqlType: string | null;
  minimumStateBytes: number | null;
  maximumStateBytes: number | null;
  stateDigest: string | null;
}

export interface HostedBillingBaseline {
  capturedUnderAdvisoryLock: true;
  readOnly: boolean;
  namespace: {
    currentSchema: string | null;
    currentSchemas: readonly string[];
    searchPath: string | null;
  };
  identity: readonly HostedRelationCount[];
  registry: HostedRegistryBaseline;
  billing: BillingSchemaTargetReadback;
}

export interface HostedBillingShapeSummary {
  tableCount: 5;
  columnCount: 51;
  checkCount: 13;
  physicalIndexCount: 9;
  zeroRows: true;
}

export interface HostedBillingMigrationManifest {
  schemaVersion: 1;
  migrationFile: 'packages/billing/migrations/0001_billing_schema.sql';
  tablePrefix: typeof DEFAULT_BILLING_TABLE_PREFIX;
  sqlSha256: typeof HOSTED_BILLING_MIGRATION_SQL_SHA256;
  sqlByteLength: typeof HOSTED_BILLING_MIGRATION_SQL_BYTE_LENGTH;
  targetSchema: typeof HOSTED_BILLING_MIGRATION_SCHEMA;
  advisoryLock: {
    function: 'pg_advisory_xact_lock(hashtextextended(text, integer))';
    key: typeof HOSTED_BILLING_MIGRATION_LOCK_KEY;
    scope: 'transaction';
    timeoutMs: typeof HOSTED_BILLING_MIGRATION_LOCK_TIMEOUT_MS;
  };
  transaction: {
    isolation: 'repeatable read';
    statementTimeoutMs: typeof HOSTED_BILLING_MIGRATION_STATEMENT_TIMEOUT_MS;
    lockTimeoutMs: typeof HOSTED_BILLING_MIGRATION_LOCK_TIMEOUT_MS;
    idleInTransactionTimeoutMs: typeof HOSTED_BILLING_MIGRATION_IDLE_TIMEOUT_MS;
    searchPath: readonly ['public', 'pg_catalog'];
  };
  expectedShape: HostedBillingShapeSummary;
  catalogValidation: {
    exactColumns: true;
    exactDefaults: true;
    exactNullability: true;
    exactConstraintDefinitions: true;
    exactIndexColumns: true;
    exactIndexDefinitions: true;
  };
  baselineDomains: readonly ['identity', 'registry', 'billing'];
  safety: {
    defaultMode: 'plan-only';
    applyRequires: readonly ['--apply', 'PSKILLS_BILLING_MIGRATION_CONFIRM=APPLY_PRIVATE_SKILLS_BILLING_SCHEMA_20260916', '--baseline-output PATH'];
    noDestructiveStatements: true;
    noApplicationRowWrites: true;
    independentPostApplyConnection: true;
  };
}

export interface HostedBillingMigrationPlan {
  status: 'ready' | 'blocked';
  mode: 'plan-only';
  readOnly: true;
  migration: HostedBillingMigrationManifest;
  baseline: HostedBillingBaseline;
  independentReadback: HostedBillingBaseline;
  independentReadbackStable: boolean;
  exactAdditiveSqlApplicable: boolean;
  baselineArtifact: {
    status: 'not-requested' | 'written';
    mode: '0600' | null;
    encrypted: false;
  };
  limitations: readonly string[];
}

export interface HostedBillingMigrationApplyResult {
  status: 'committed' | 'blocked';
  mode: 'apply';
  readOnly: false;
  migration: HostedBillingMigrationManifest;
  baseline: HostedBillingBaseline;
  inTransactionReadback: HostedBillingBaseline;
  inTransactionShape: HostedBillingShapeSummary;
  independentReadback: HostedBillingBaseline;
  independentReadbackStable: boolean;
  baselineArtifact: {
    status: 'written';
    mode: '0600';
    encrypted: false;
  };
  limitations: readonly string[];
}

const BILLING_MANIFEST = billingSchemaManifest();

function quoteCatalogIdentifier(value: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 63 || value.includes('\u0000')) {
    throw new Error('catalog identifier is invalid');
  }
  return `"${value.replaceAll('"', '""')}"`;
}

function numericValue(value: unknown, field: string, allowNull = false): number | null {
  if (value === null || value === undefined) {
    if (allowNull) return null;
    throw new Error(`${field} is missing`);
  }
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${field} is invalid`);
  return number;
}

function textValue(value: unknown, field: string, allowNull = false): string | null {
  if (value === null || value === undefined) {
    if (allowNull) return null;
    throw new Error(`${field} is missing`);
  }
  if (typeof value !== 'string' || value.length > 512) throw new Error(`${field} is invalid`);
  return value;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertReviewedMigration(): HostedBillingMigrationManifest {
  if (BILLING_MANIFEST.sqlSha256 !== HOSTED_BILLING_MIGRATION_SQL_SHA256
    || BILLING_MANIFEST.sqlByteLength !== HOSTED_BILLING_MIGRATION_SQL_BYTE_LENGTH
    || BILLING_MANIFEST.sqlInventory.createTables !== 5
    || BILLING_MANIFEST.sqlInventory.addColumnsIfMissing !== 7
    || BILLING_MANIFEST.sqlInventory.guardedConstraints !== 2
    || BILLING_MANIFEST.sqlInventory.createIndexesIfMissing !== 2) {
    throw new Error('billing migration artifact does not match the reviewed digest');
  }
  return {
    schemaVersion: 1,
    migrationFile: 'packages/billing/migrations/0001_billing_schema.sql',
    tablePrefix: DEFAULT_BILLING_TABLE_PREFIX,
    sqlSha256: HOSTED_BILLING_MIGRATION_SQL_SHA256,
    sqlByteLength: HOSTED_BILLING_MIGRATION_SQL_BYTE_LENGTH,
    targetSchema: HOSTED_BILLING_MIGRATION_SCHEMA,
    advisoryLock: {
      function: 'pg_advisory_xact_lock(hashtextextended(text, integer))',
      key: HOSTED_BILLING_MIGRATION_LOCK_KEY,
      scope: 'transaction',
      timeoutMs: HOSTED_BILLING_MIGRATION_LOCK_TIMEOUT_MS,
    },
    transaction: {
      isolation: 'repeatable read',
      statementTimeoutMs: HOSTED_BILLING_MIGRATION_STATEMENT_TIMEOUT_MS,
      lockTimeoutMs: HOSTED_BILLING_MIGRATION_LOCK_TIMEOUT_MS,
      idleInTransactionTimeoutMs: HOSTED_BILLING_MIGRATION_IDLE_TIMEOUT_MS,
      searchPath: ['public', 'pg_catalog'],
    },
    expectedShape: {
      tableCount: 5,
      columnCount: 51,
      checkCount: 13,
      physicalIndexCount: 9,
      zeroRows: true,
    },
    catalogValidation: {
      exactColumns: true,
      exactDefaults: true,
      exactNullability: true,
      exactConstraintDefinitions: true,
      exactIndexColumns: true,
      exactIndexDefinitions: true,
    },
    baselineDomains: ['identity', 'registry', 'billing'],
    safety: {
      defaultMode: 'plan-only',
      applyRequires: ['--apply', 'PSKILLS_BILLING_MIGRATION_CONFIRM=APPLY_PRIVATE_SKILLS_BILLING_SCHEMA_20260916', '--baseline-output PATH'],
      noDestructiveStatements: true,
      noApplicationRowWrites: true,
      independentPostApplyConnection: true,
    },
  };
}

export function hostedBillingMigrationManifest(): HostedBillingMigrationManifest {
  return assertReviewedMigration();
}

async function reviewedMigrationSql(): Promise<string> {
  const migrationSql = await readFile(new URL('../migrations/0001_billing_schema.sql', import.meta.url), 'utf8');
  const digest = `sha256:${createHash('sha256').update(migrationSql, 'utf8').digest('hex')}`;
  if (digest !== HOSTED_BILLING_MIGRATION_SQL_SHA256 || Buffer.byteLength(migrationSql, 'utf8') !== HOSTED_BILLING_MIGRATION_SQL_BYTE_LENGTH) {
    throw new Error('billing migration file does not match the reviewed digest');
  }
  const generatedSql = billingPostgresSchemaSql(DEFAULT_BILLING_TABLE_PREFIX);
  if (migrationSql !== generatedSql) throw new Error('billing migration file differs from the authoritative helper');
  return migrationSql;
}

async function queryRows<Row extends SqlRow = SqlRow>(executor: HostedMigrationSqlExecutor, statement: string, parameters?: readonly unknown[]): Promise<Row[]> {
  return Array.from(await executor.unsafe<Row>(statement, parameters));
}

async function configureTransaction(executor: HostedMigrationSqlExecutor, readOnly: boolean): Promise<void> {
  await executor.unsafe(`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ${readOnly ? ' READ ONLY' : ''}`);
  await executor.unsafe(`SET LOCAL statement_timeout = '${HOSTED_BILLING_MIGRATION_STATEMENT_TIMEOUT_MS}ms'`);
  await executor.unsafe(`SET LOCAL lock_timeout = '${HOSTED_BILLING_MIGRATION_LOCK_TIMEOUT_MS}ms'`);
  await executor.unsafe(`SET LOCAL idle_in_transaction_session_timeout = '${HOSTED_BILLING_MIGRATION_IDLE_TIMEOUT_MS}ms'`);
  await executor.unsafe('SET LOCAL search_path TO "public", pg_catalog');
}

async function acquireMigrationLock(executor: HostedMigrationSqlExecutor): Promise<void> {
  await executor.unsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [HOSTED_BILLING_MIGRATION_LOCK_KEY]);
}

async function readNamespace(executor: HostedMigrationSqlExecutor): Promise<HostedBillingBaseline['namespace']> {
  const rows = await queryRows<{
    current_schema: unknown;
    current_schemas: unknown;
    search_path: unknown;
  }>(executor, `SELECT current_schema() AS current_schema, current_schemas(false) AS current_schemas, current_setting('search_path') AS search_path`);
  const row = rows[0];
  const currentSchemas = Array.isArray(row?.current_schemas)
    ? row.current_schemas.filter((value): value is string => typeof value === 'string')
    : [];
  return {
    currentSchema: textValue(row?.current_schema, 'current schema', true),
    currentSchemas,
    searchPath: textValue(row?.search_path, 'search path', true),
  };
}

async function relationNames(executor: HostedMigrationSqlExecutor, names: readonly string[]): Promise<readonly { schema: string; name: string }[]> {
  const rows = await queryRows<{ schema_name: unknown; table_name: unknown }>(executor, `
    SELECT n.nspname AS schema_name, c.relname AS table_name
      FROM pg_catalog.pg_class AS c
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
     WHERE c.relname = ANY($1::text[]) AND c.relkind IN ('r', 'p')
     ORDER BY n.nspname, c.relname
  `, [names]);
  return rows.map((row) => ({
    schema: textValue(row.schema_name, 'schema')!,
    name: textValue(row.table_name, 'table')!,
  }));
}

async function readRelationCount(executor: HostedMigrationSqlExecutor, schema: string, name: string): Promise<number> {
  const rows = await queryRows<{ row_count: unknown }>(executor, `SELECT count(*)::text AS row_count FROM ${quoteCatalogIdentifier(schema)}.${quoteCatalogIdentifier(name)}`);
  return numericValue(rows[0]?.row_count, `${schema}.${name} row count`)!;
}

async function readIdentityCounts(executor: HostedMigrationSqlExecutor): Promise<readonly HostedRelationCount[]> {
  const names = await relationNames(executor, HOSTED_IDENTITY_TABLE_NAMES);
  const result: HostedRelationCount[] = [];
  for (const expectedName of HOSTED_IDENTITY_TABLE_NAMES) {
    const matches = names.filter((entry) => entry.name === expectedName);
    if (matches.length === 0) {
      result.push({ expectedName, schema: null, present: false, rowCount: 0 });
      continue;
    }
    for (const match of matches) {
      result.push({ expectedName, schema: match.schema, present: true, rowCount: await readRelationCount(executor, match.schema, match.name) });
    }
  }
  return result;
}

async function readRegistryBaseline(executor: HostedMigrationSqlExecutor): Promise<HostedRegistryBaseline> {
  const names = await relationNames(executor, [HOSTED_REGISTRY_TABLE_NAME]);
  const match = names.find((entry) => entry.schema === HOSTED_BILLING_MIGRATION_SCHEMA && entry.name === HOSTED_REGISTRY_TABLE_NAME);
  if (!match) {
    return {
      schema: HOSTED_BILLING_MIGRATION_SCHEMA,
      table: HOSTED_REGISTRY_TABLE_NAME,
      present: false,
      rowCount: 0,
      minimumRevision: null,
      maximumRevision: null,
      minimumStateJsonType: null,
      maximumStateJsonType: null,
      stateSqlType: null,
      minimumStateBytes: null,
      maximumStateBytes: null,
      stateDigest: null,
    };
  }
  const table = `${quoteCatalogIdentifier(match.schema)}.${quoteCatalogIdentifier(match.name)}`;
  const rows = await queryRows<{
    row_count: unknown;
    minimum_revision: unknown;
    maximum_revision: unknown;
    minimum_state_json_type: unknown;
    maximum_state_json_type: unknown;
    state_sql_type: unknown;
    minimum_state_bytes: unknown;
    maximum_state_bytes: unknown;
    state_digest: unknown;
  }>(executor, `
    SELECT count(*)::text AS row_count,
           min(revision)::text AS minimum_revision,
           max(revision)::text AS maximum_revision,
           min(jsonb_typeof(state)) AS minimum_state_json_type,
           max(jsonb_typeof(state)) AS maximum_state_json_type,
           min(pg_typeof(state)::text) AS state_sql_type,
           min(octet_length(state::text))::text AS minimum_state_bytes,
           max(octet_length(state::text))::text AS maximum_state_bytes,
           md5(coalesce(string_agg(md5(state::text), ',' ORDER BY organization_id), '')) AS state_digest
      FROM ${table}
  `);
  const row = rows[0];
  return {
    schema: HOSTED_BILLING_MIGRATION_SCHEMA,
    table: HOSTED_REGISTRY_TABLE_NAME,
    present: true,
    rowCount: numericValue(row?.row_count, 'registry row count')!,
    minimumRevision: numericValue(row?.minimum_revision, 'minimum registry revision', true),
    maximumRevision: numericValue(row?.maximum_revision, 'maximum registry revision', true),
    minimumStateJsonType: textValue(row?.minimum_state_json_type, 'minimum registry JSON type', true),
    maximumStateJsonType: textValue(row?.maximum_state_json_type, 'maximum registry JSON type', true),
    stateSqlType: textValue(row?.state_sql_type, 'registry SQL type', true),
    minimumStateBytes: numericValue(row?.minimum_state_bytes, 'minimum registry state bytes', true),
    maximumStateBytes: numericValue(row?.maximum_state_bytes, 'maximum registry state bytes', true),
    stateDigest: textValue(row?.state_digest, 'registry state digest', true),
  };
}

// Every caller captures this after acquireMigrationLock() in the same
// transaction. Keep the function private so the lock-backed provenance on the
// returned baseline cannot be bypassed by an unguarded external call.
async function captureHostedBillingBaseline(executor: HostedMigrationSqlExecutor, readOnly: boolean): Promise<HostedBillingBaseline> {
  return {
    capturedUnderAdvisoryLock: true,
    readOnly,
    namespace: await readNamespace(executor),
    identity: await readIdentityCounts(executor),
    registry: await readRegistryBaseline(executor),
    billing: await readBillingSchema(executor, DEFAULT_BILLING_TABLE_PREFIX),
  };
}

function expectedPhysicalIndexCount(spec: BillingSchemaTableSpec): number {
  return 1 + spec.uniqueConstraints.length + (spec.logicalName === 'events' || spec.logicalName === 'operations' ? 1 : 0);
}

function normalizeSql(value: string): string {
  return value.replaceAll(/\s+/gu, ' ').replaceAll('::text', '').trim().toLowerCase();
}

function migrationIndexSpecsForTable(logicalName: BillingSchemaTableSpec['logicalName']): readonly { name: string; columns: readonly string[]; descendingColumns: readonly string[] }[] {
  return billingSchemaIndexSpecs()
    .filter((index) => index.table === logicalName)
    .map((index) => ({ name: index.name, columns: index.columns, descendingColumns: index.descendingColumns ?? [] }));
}

function checkDefinitionMatches(definition: string, expected: string): boolean {
  const actual = normalizeSql(definition);
  const normalizedExpected = normalizeSql(expected);
  if (normalizedExpected === "status in ('reserved', 'committed', 'released')") {
    return actual.includes("status = any (array['reserved', 'committed', 'released'])")
      || actual.includes(normalizedExpected);
  }
  return actual.includes(normalizedExpected);
}

export function validateBillingCreationReadback(target: BillingSchemaTargetReadback): HostedBillingShapeSummary {
  const specs = billingSchemaTableSpecs(DEFAULT_BILLING_TABLE_PREFIX);
  if (target.status !== 'ready' || target.schemaNames.length !== 1 || target.schemaNames[0] !== HOSTED_BILLING_MIGRATION_SCHEMA) {
    throw new Error('billing readback is not one complete public schema');
  }
  if (target.tables.length !== specs.length || target.missingTables.length !== 0) throw new Error('billing table count is incorrect');
  let columnCount = 0;
  let checkCount = 0;
  let physicalIndexCount = 0;
  for (const spec of specs) {
    const table = target.tables.find((candidate) => candidate.name === spec.name);
    if (!table || table.schema !== HOSTED_BILLING_MIGRATION_SCHEMA) throw new Error(`billing table ${spec.name} is missing`);
    if (table.rowCount !== 0) throw new Error(`billing table ${spec.name} is not empty`);
    if (table.columns.length !== spec.columns.length) throw new Error(`billing table ${spec.name} column count is incorrect`);
    for (const [index, expected] of spec.columns.entries()) {
      const actual = table.columns[index];
      const expectedDefault = expected.defaultExpression === undefined ? undefined : normalizeSql(expected.defaultExpression);
      const actualDefault = actual?.defaultExpression === undefined ? undefined : normalizeSql(actual.defaultExpression);
      if (!actual || actual.name !== expected.name || actual.dataType !== expected.dataType || actual.nullable !== expected.nullable || actualDefault !== expectedDefault) {
        throw new Error(`billing table ${spec.name} column shape is incorrect`);
      }
    }
    // Some PostgreSQL catalog versions expose implicit NOT NULL entries as
    // pg_constraint rows (contype = 'n'). Nullability is checked from
    // pg_attribute above; only user-defined keys and checks belong in this
    // migration shape gate.
    const actualConstraints = table.constraints.filter((constraint) => constraint.type !== 'n');
    const actualChecks = actualConstraints.filter((constraint) => constraint.type === 'check');
    const expectedConstraintCount = 1 + spec.uniqueConstraints.length + spec.checks.length;
    if (actualChecks.length !== spec.checks.length || actualConstraints.length !== expectedConstraintCount) {
      throw new Error(`billing table ${spec.name} constraint shape is incorrect`);
    }
    if (!actualChecks.every((constraint) => spec.checks.some((expected) => checkDefinitionMatches(constraint.definition, expected)))) {
      throw new Error(`billing table ${spec.name} check definitions are incorrect`);
    }
    const primary = table.constraints.find((constraint) => constraint.type === 'primary');
    if (!primary || !normalizeSql(primary.definition).includes(`primary key (${spec.primaryKey.join(', ')})`)) {
      throw new Error(`billing table ${spec.name} primary key is incorrect`);
    }
    for (const uniqueColumns of spec.uniqueConstraints) {
      if (!table.constraints.some((constraint) => constraint.type === 'unique' && normalizeSql(constraint.definition).includes(`unique (${uniqueColumns.join(', ')})`))) {
        throw new Error(`billing table ${spec.name} unique key is incorrect`);
      }
    }
    const expectedIndexes = expectedPhysicalIndexCount(spec);
    if (table.indexes.length !== expectedIndexes) throw new Error(`billing table ${spec.name} index shape is incorrect`);
    const primaryIndex = table.indexes.find((index) => index.primary);
    if (!primaryIndex || !sameJson(primaryIndex.columns, spec.primaryKey)) throw new Error(`billing table ${spec.name} primary index is incorrect`);
    for (const uniqueColumns of spec.uniqueConstraints) {
      if (!table.indexes.some((index) => index.unique && !index.primary && sameJson(index.columns, uniqueColumns))) {
        throw new Error(`billing table ${spec.name} unique index is incorrect`);
      }
    }
    for (const expectedIndex of migrationIndexSpecsForTable(spec.logicalName)) {
      const actualIndex = table.indexes.find((index) => index.name === expectedIndex.name);
      if (!actualIndex || actualIndex.primary || actualIndex.unique || !sameJson(actualIndex.columns, expectedIndex.columns)) {
        throw new Error(`billing table ${spec.name} secondary index is incorrect`);
      }
      const indexDefinition = normalizeSql(actualIndex.definition);
      if (!indexDefinition.startsWith(`create index ${expectedIndex.name.toLowerCase()}`)
        || expectedIndex.columns.some((column) => !indexDefinition.includes(column.toLowerCase()))
        || expectedIndex.descendingColumns.some((column) => !indexDefinition.includes(`${column.toLowerCase()} desc`))) {
        throw new Error(`billing table ${spec.name} secondary index definition is incorrect`);
      }
    }
    columnCount += table.columns.length;
    checkCount += actualChecks.length;
    physicalIndexCount += table.indexes.length;
  }
  if (columnCount !== 51 || checkCount !== 13 || physicalIndexCount !== 9) throw new Error('billing catalog shape totals are incorrect');
  return { tableCount: 5, columnCount: 51, checkCount: 13, physicalIndexCount: 9, zeroRows: true };
}

function unchangedOutsideBilling(before: HostedBillingBaseline, after: HostedBillingBaseline): boolean {
  return sameJson(before.namespace, after.namespace)
    && sameJson(before.identity, after.identity)
    && sameJson(before.registry, after.registry);
}

function sameReadback(left: HostedBillingBaseline, right: HostedBillingBaseline): boolean {
  return sameJson({ ...left, readOnly: true }, { ...right, readOnly: true });
}

function billingIsCreateOnly(target: BillingSchemaTargetReadback): boolean {
  return target.status === 'absent'
    && target.schemaNames.length === 0
    && target.foundTables.length === 0
    && target.missingTables.length === 5;
}

async function readOnlyConnection(connectionString: string): Promise<HostedBillingBaseline> {
  const sql = postgres(connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: Math.ceil(HOSTED_BILLING_MIGRATION_STATEMENT_TIMEOUT_MS / 1_000),
    idle_timeout: Math.ceil(HOSTED_BILLING_MIGRATION_IDLE_TIMEOUT_MS / 1_000),
    onnotice: () => undefined,
  }) as unknown as HostedMigrationSqlClient;
  try {
    return await sql.begin(async (transaction) => {
      await configureTransaction(transaction, true);
      await acquireMigrationLock(transaction);
      return captureHostedBillingBaseline(transaction, true);
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function writeSecureBaseline(path: string, baseline: HostedBillingBaseline): Promise<void> {
  const output = resolve(path);
  const handle = await open(output, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({
      schemaVersion: 1,
      kind: 'billing-hosted-migration-baseline',
      encrypted: false,
      capturedUnderAdvisoryLock: true,
      baseline,
    }, null, 2)}\n`, 'utf8');
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
  await chmod(output, 0o600);
}

export async function prepareHostedBillingMigration(
  connectionString: string,
  options: { baselineOutput?: string } = {},
): Promise<HostedBillingMigrationPlan> {
  const migration = assertReviewedMigration();
  await reviewedMigrationSql();
  const sql = postgres(connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: Math.ceil(HOSTED_BILLING_MIGRATION_STATEMENT_TIMEOUT_MS / 1_000),
    idle_timeout: Math.ceil(HOSTED_BILLING_MIGRATION_IDLE_TIMEOUT_MS / 1_000),
    onnotice: () => undefined,
  }) as unknown as HostedMigrationSqlClient;
  try {
    const baseline = await sql.begin(async (transaction) => {
      await configureTransaction(transaction, true);
      await acquireMigrationLock(transaction);
      return captureHostedBillingBaseline(transaction, true);
    });
    if (options.baselineOutput !== undefined) await writeSecureBaseline(options.baselineOutput, baseline);
    const independentReadback = await readOnlyConnection(connectionString);
    const independentReadbackStable = sameReadback(baseline, independentReadback);
    const exactAdditiveSqlApplicable = billingIsCreateOnly(baseline.billing) && independentReadbackStable && billingIsCreateOnly(independentReadback.billing);
    return {
      status: exactAdditiveSqlApplicable ? 'ready' : 'blocked',
      mode: 'plan-only',
      readOnly: true,
      migration,
      baseline,
      independentReadback,
      independentReadbackStable,
      exactAdditiveSqlApplicable,
      baselineArtifact: {
        status: options.baselineOutput === undefined ? 'not-requested' : 'written',
        mode: options.baselineOutput === undefined ? null : '0600',
        encrypted: false,
      },
      limitations: [
        'The baseline artifact contains bounded counts, catalog shape, and digests; it is not a complete encrypted PostgreSQL backup.',
        'No application row writes or webhook/storage fences are synthesized because the target has no billing relations or billing data.',
        'An external encrypted backup must cover current identity, registry, objects, and all existing durable domains before any apply window.',
      ],
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function applyHostedBillingMigration(
  connectionString: string,
  baselineOutput: string,
): Promise<HostedBillingMigrationApplyResult> {
  const migration = assertReviewedMigration();
  const migrationSql = await reviewedMigrationSql();
  const sql = postgres(connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: Math.ceil(HOSTED_BILLING_MIGRATION_STATEMENT_TIMEOUT_MS / 1_000),
    idle_timeout: Math.ceil(HOSTED_BILLING_MIGRATION_IDLE_TIMEOUT_MS / 1_000),
    onnotice: () => undefined,
  }) as unknown as HostedMigrationSqlClient;
  try {
    const transactionResult = await sql.begin(async (transaction) => {
      await configureTransaction(transaction, false);
      await acquireMigrationLock(transaction);
      const baseline = await captureHostedBillingBaseline(transaction, false);
      if (!billingIsCreateOnly(baseline.billing)) throw new Error('billing target is not create-only');
      // The secure baseline is written while the transaction lock is held and
      // before any DDL. A failed file write therefore aborts before mutation.
      await writeSecureBaseline(baselineOutput, baseline);
      await transaction.unsafe(migrationSql);
      const inTransactionReadback = await captureHostedBillingBaseline(transaction, false);
      const inTransactionShape = validateBillingCreationReadback(inTransactionReadback.billing);
      if (!unchangedOutsideBilling(baseline, inTransactionReadback)) throw new Error('identity or registry baseline changed during billing migration');
      return { baseline, inTransactionReadback, inTransactionShape };
    });
    const independentReadback = await readOnlyConnection(connectionString);
    const independentReadbackStable = sameReadback(transactionResult.inTransactionReadback, independentReadback)
      && validateBillingCreationReadback(independentReadback.billing).zeroRows;
    if (!independentReadbackStable) {
      return {
        status: 'blocked',
        mode: 'apply',
        readOnly: false,
        migration,
        ...transactionResult,
        independentReadback,
        independentReadbackStable: false,
        baselineArtifact: { status: 'written', mode: '0600', encrypted: false },
        limitations: ['The transaction committed, but the independent post-commit readback did not match; keep traffic fenced and investigate without a destructive down migration.'],
      };
    }
    return {
      status: 'committed',
      mode: 'apply',
      readOnly: false,
      migration,
      ...transactionResult,
      independentReadback,
      independentReadbackStable: true,
      baselineArtifact: { status: 'written', mode: '0600', encrypted: false },
      limitations: [
        'The baseline artifact contains bounded counts, catalog shape, and digests; it is not a complete encrypted PostgreSQL backup.',
        'An external encrypted backup must cover current identity, registry, objects, and all existing durable domains.',
      ],
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function parseArguments(argv: readonly string[]): { apply: boolean; baselineOutput?: string; environmentName: string; json: boolean } {
  let apply = false;
  let baselineOutput: string | undefined;
  let environmentName = 'DATABASE_URL';
  let json = true;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') apply = true;
    else if (argument === '--human') json = false;
    else if (argument === '--baseline-output') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--baseline-output requires a path');
      baselineOutput = value;
      index += 1;
    } else if (argument === '--env') {
      const value = argv[index + 1];
      if (!value || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(value)) throw new Error('--env requires a valid environment name');
      environmentName = value;
      index += 1;
    } else if (argument !== '--plan') {
      throw new Error('unsupported hosted billing migration option');
    }
  }
  return { apply, ...(baselineOutput === undefined ? {} : { baselineOutput }), environmentName, json };
}

async function main(argv: readonly string[]): Promise<number> {
  const options = parseArguments(argv);
  const connectionString = process.env[options.environmentName];
  if (!connectionString || connectionString.trim() === '') throw new Error('database environment is unset');
  if (options.apply) {
    if (process.env.PSKILLS_BILLING_MIGRATION_CONFIRM !== HOSTED_BILLING_MIGRATION_CONFIRMATION) throw new Error('apply confirmation is missing');
    if (!options.baselineOutput) throw new Error('--baseline-output is required for apply');
    const report = await applyHostedBillingMigration(connectionString, options.baselineOutput);
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else console.log(`billing hosted migration: ${report.status}`);
    return report.status === 'committed' ? 0 : 2;
  }
  const report = await prepareHostedBillingMigration(connectionString, options);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else console.log(`billing hosted migration plan: ${report.status}`);
  return report.status === 'ready' ? 0 : 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main(process.argv.slice(2)).catch(() => {
    console.error('billing hosted migration preparation failed');
    process.exitCode = 1;
  });
}
