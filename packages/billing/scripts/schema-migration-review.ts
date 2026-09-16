/*
 * Billing schema review utility.
 *
 * The default operation only renders credential-free metadata.  Database
 * inspection requires --inspect-env and runs in a repeatable-read, read-only
 * transaction.  The rehearsal mode accepts loopback PostgreSQL only and
 * creates/drops uniquely named temporary schemas; it never accepts a hosted
 * database URL.
 */

import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import postgres from 'postgres';

import {
  billingPostgresSchemaSql,
} from '../src/repository.js';
import {
  DEFAULT_BILLING_TABLE_PREFIX,
  billingSchemaManifest,
  billingSchemaTableSpecs,
  type BillingSchemaTableSpec,
} from '../src/schema-review.js';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

type SqlExecutor = {
  unsafe<Row = Record<string, unknown>>(statement: string, parameters?: readonly unknown[]): Promise<readonly Row[]>;
};

export interface BillingTableReadback {
  schema: string;
  name: string;
  rowCount: number;
  /** Present only for the disposable local rehearsal, never for target reads. */
  rowDigest?: string;
  columns: readonly {
    name: string;
    dataType: string;
    nullable: boolean;
    defaultExpression?: string;
  }[];
  constraints: readonly {
    name: string;
    type: string;
    definition: string;
  }[];
  indexes: readonly {
    name: string;
    unique: boolean;
    primary: boolean;
    columns: readonly string[];
    definition: string;
  }[];
}

export interface BillingSchemaTargetReadback {
  status: 'ready' | 'partial' | 'absent' | 'ambiguous';
  readOnly: true;
  tablePrefix: string;
  schemaNames: readonly string[];
  expectedTables: readonly string[];
  foundTables: readonly string[];
  missingTables: readonly string[];
  schemaDigest: string;
  tables: readonly BillingTableReadback[];
}

export interface BillingSchemaTargetResult {
  configured: boolean;
  readOnly: true;
  target?: BillingSchemaTargetReadback;
  errorCode?: 'INVALID_URL' | 'TARGET_UNAVAILABLE';
}

export interface BillingSchemaLoopbackRehearsal {
  status: 'passed';
  mode: 'loopback-disposable-schema';
  tablePrefix: string;
  schema: BillingSchemaTargetReadback;
  populated: {
    tableCount: number;
    allTablesPopulated: true;
    unboundWebhookRetained: true;
    migrationLoopCount: number;
    before: readonly { table: string; rowCount: number; rowDigest: string }[];
    after: readonly { table: string; rowCount: number; rowDigest: string }[];
    backupManifestDigest: string;
  };
  backupRestore: {
    isolatedSchema: true;
    allTablesRestored: true;
    restored: readonly { table: string; rowCount: number; rowDigest: string }[];
  };
  legacyUpgrade: {
    existingRowsPreserved: true;
    before: readonly { table: string; rowCount: number; rowDigest: string }[];
    after: readonly { table: string; rowCount: number; rowDigest: string }[];
  };
  rollback: {
    transactionRolledBack: true;
    objectsRemaining: 0;
  };
}

function quoteIdentifier(value: string): string {
  if (!IDENTIFIER.test(value) || value.length > 63) throw new Error('identifier is invalid');
  return `"${value}"`;
}

function quoteCatalogIdentifier(value: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 63 || value.includes('\u0000')) {
    throw new Error('catalog identifier is invalid');
  }
  return `"${value.replaceAll('"', '""')}"`;
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function asRows<Row>(value: readonly Row[]): Row[] {
  return Array.from(value);
}

async function queryRows<Row>(executor: SqlExecutor, statement: string, parameters?: readonly unknown[]): Promise<Row[]> {
  return asRows(await executor.unsafe<Row>(statement, parameters));
}

function tableNames(tablePrefix: string): readonly string[] {
  return billingSchemaTableSpecs(tablePrefix).map((table) => table.name);
}

function tableSpecByName(tablePrefix: string): ReadonlyMap<string, BillingSchemaTableSpec> {
  return new Map(billingSchemaTableSpecs(tablePrefix).map((table) => [table.name, table]));
}

function isLoopbackDatabaseUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:') && LOOPBACK_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

function canonicalReadback(readback: readonly BillingTableReadback[]): string {
  return JSON.stringify(readback.map((table) => ({
    schema: table.schema,
    name: table.name,
    rowCount: table.rowCount,
    ...(table.rowDigest === undefined ? {} : { rowDigest: table.rowDigest }),
    columns: table.columns,
    constraints: table.constraints,
    indexes: table.indexes,
  })));
}

async function readTable(executor: SqlExecutor, schema: string, table: string, includeRowDigest = false): Promise<BillingTableReadback> {
  const qualifiedTable = `${quoteCatalogIdentifier(schema)}.${quoteCatalogIdentifier(table)}`;
  const relationRows = await queryRows<{ relation_oid: string }>(executor, `
    SELECT c.oid::text AS relation_oid
      FROM pg_catalog.pg_class AS c
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p')
  `, [schema, table]);
  if (relationRows.length !== 1) throw new Error('billing relation disappeared during readback');
  const relationOid = relationRows[0]!.relation_oid;
  const columns = await queryRows<{
    name: string;
    data_type: string;
    nullable: boolean;
    default_expression: string | null;
  }>(executor, `
    SELECT a.attname AS name,
           pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
           NOT a.attnotnull AS nullable,
           pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) AS default_expression
      FROM pg_catalog.pg_attribute AS a
      LEFT JOIN pg_catalog.pg_attrdef AS ad
        ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
     WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attnum
  `, [relationOid]);
  const constraints = await queryRows<{
    name: string;
    type: string;
    definition: string;
  }>(executor, `
    SELECT conname AS name,
           CASE contype WHEN 'p' THEN 'primary' WHEN 'u' THEN 'unique' WHEN 'c' THEN 'check' ELSE contype::text END AS type,
           pg_catalog.pg_get_constraintdef(oid, true) AS definition
      FROM pg_catalog.pg_constraint
     WHERE conrelid = $1::oid
     ORDER BY conname
  `, [relationOid]);
  const indexes = await queryRows<{
    name: string;
    unique: boolean;
    primary: boolean;
    index_columns: readonly string[];
    definition: string;
  }>(executor, `
    SELECT index_class.relname AS name,
           index_info.indisunique AS unique,
           index_info.indisprimary AS primary,
           ARRAY(
             SELECT pg_catalog.pg_get_indexdef(index_info.indexrelid, key.ordinality, true)
               FROM generate_series(1, index_info.indnkeyatts) AS key(ordinality)
              ORDER BY key.ordinality
           ) AS index_columns,
           pg_catalog.pg_get_indexdef(index_info.indexrelid) AS definition
      FROM pg_catalog.pg_index AS index_info
      JOIN pg_catalog.pg_class AS index_class ON index_class.oid = index_info.indexrelid
     WHERE index_info.indrelid = $1::oid
     ORDER BY index_class.relname
  `, [relationOid]);
  const countRows = await queryRows<{ row_count: string | number }>(executor, `SELECT count(*)::text AS row_count FROM ${qualifiedTable}`);
  const rowCount = Number(countRows[0]?.row_count ?? 0);
  if (!Number.isSafeInteger(rowCount) || rowCount < 0) throw new Error('row count is invalid');
  let rowDigest: string | undefined;
  if (includeRowDigest) {
    const dataRows = await queryRows<{ payload: string }>(executor, `
      SELECT COALESCE(jsonb_agg(row_json ORDER BY row_json::text), '[]'::jsonb)::text AS payload
        FROM (
          SELECT pg_catalog.to_jsonb(row_data) AS row_json
            FROM ${qualifiedTable} AS row_data
        ) AS ordered_rows
    `);
    rowDigest = sha256(dataRows[0]?.payload ?? '[]');
  }
  return {
    schema,
    name: table,
    rowCount,
    ...(rowDigest === undefined ? {} : { rowDigest }),
    columns: columns.map((column) => ({
      name: column.name,
      dataType: column.data_type,
      nullable: column.nullable,
      ...(column.default_expression === null ? {} : { defaultExpression: column.default_expression }),
    })),
    constraints,
    indexes: indexes.map((index) => ({
      name: index.name,
      unique: index.unique,
      primary: index.primary,
      columns: Array.from(index.index_columns),
      definition: index.definition,
    })),
  };
}

export async function readBillingSchema(
  executor: SqlExecutor,
  tablePrefix = DEFAULT_BILLING_TABLE_PREFIX,
  options: { includeRowDigests?: boolean } = {},
): Promise<BillingSchemaTargetReadback> {
  const expectedTables = tableNames(tablePrefix);
  const found = await queryRows<{ schema_name: string; table_name: string }>(executor, `
    SELECT n.nspname AS schema_name, c.relname AS table_name
      FROM pg_catalog.pg_class AS c
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
     WHERE c.relname = ANY($1::text[]) AND c.relkind IN ('r', 'p')
     ORDER BY n.nspname, c.relname
  `, [expectedTables]);
  const expectedByName = tableSpecByName(tablePrefix);
  const relevant = found.filter((row) => expectedByName.has(row.table_name));
  const grouped = new Map<string, typeof relevant>();
  for (const row of relevant) grouped.set(row.schema_name, [...(grouped.get(row.schema_name) ?? []), row]);
  const completeSchemas = Array.from(grouped.entries())
    .filter(([, rows]) => new Set(rows.map((row) => row.table_name)).size === expectedTables.length)
    .map(([schema]) => schema);
  const selected = completeSchemas.length === 1 ? grouped.get(completeSchemas[0]!) ?? [] : relevant;
  const tables: BillingTableReadback[] = [];
  for (const row of selected) tables.push(await readTable(executor, row.schema_name, row.table_name, options.includeRowDigests === true));
  const foundNames = Array.from(new Set(tables.map((table) => table.name))).sort();
  const missingTables = expectedTables.filter((name) => !foundNames.includes(name));
  const canonical = canonicalReadback(tables.sort((a, b) => `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`)));
  return {
    status: foundNames.length === 0 ? 'absent' : completeSchemas.length > 1 ? 'ambiguous' : missingTables.length === 0 ? 'ready' : 'partial',
    readOnly: true,
    tablePrefix,
    schemaNames: Array.from(grouped.keys()).sort(),
    expectedTables,
    foundTables: foundNames,
    missingTables,
    schemaDigest: sha256(canonical),
    tables,
  };
}

export async function inspectConfiguredDatabase(
  connectionString: string | undefined,
  tablePrefix = DEFAULT_BILLING_TABLE_PREFIX,
): Promise<BillingSchemaTargetResult> {
  if (connectionString === undefined || connectionString.trim() === '') return { configured: false, readOnly: true };
  try {
    const parsed = new URL(connectionString);
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') return { configured: true, readOnly: true, errorCode: 'INVALID_URL' };
  } catch {
    return { configured: true, readOnly: true, errorCode: 'INVALID_URL' };
  }
  const sql = postgres(connectionString, { max: 1, prepare: false, connect_timeout: 5, onnotice: () => undefined });
  try {
    const target = await sql.begin(async (transaction) => {
      await transaction.unsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      return readBillingSchema(transaction, tablePrefix);
    });
    return { configured: true, readOnly: true, target };
  } catch {
    return { configured: true, readOnly: true, errorCode: 'TARGET_UNAVAILABLE' };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function capturePopulatedTables(executor: SqlExecutor, schema: string, tablePrefix: string): Promise<readonly { table: string; rowCount: number; rowDigest: string }[]> {
  const tables = billingSchemaTableSpecs(tablePrefix);
  const captured: { table: string; rowCount: number; rowDigest: string }[] = [];
  for (const table of tables) {
    const qualifiedTable = `${quoteIdentifier(schema)}.${quoteIdentifier(table.name)}`;
    const countRows = await queryRows<{ row_count: string }>(executor, `SELECT count(*)::text AS row_count FROM ${qualifiedTable}`);
    const dataRows = await queryRows<{ payload: string }>(executor, `
      SELECT COALESCE(jsonb_agg(row_json ORDER BY row_json::text), '[]'::jsonb)::text AS payload
        FROM (SELECT pg_catalog.to_jsonb(row_data) AS row_json FROM ${qualifiedTable} AS row_data) AS ordered_rows
    `);
    captured.push({ table: table.name, rowCount: Number(countRows[0]?.row_count ?? 0), rowDigest: sha256(dataRows[0]?.payload ?? '[]') });
  }
  return captured;
}

async function insertPopulatedFixture(executor: SqlExecutor, tablePrefix: string): Promise<void> {
  const customers = quoteIdentifier(`${tablePrefix}_customers`);
  const subscriptions = quoteIdentifier(`${tablePrefix}_subscriptions`);
  const usage = quoteIdentifier(`${tablePrefix}_usage`);
  const events = quoteIdentifier(`${tablePrefix}_webhook_events`);
  const operations = quoteIdentifier(`${tablePrefix}_usage_operations`);
  const timestamp = '2026-09-16T00:00:00.000Z';
  await executor.unsafe(`INSERT INTO ${customers} (organization_id, provider, customer_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)`, ['schema-review-org', 'stripe', 'cus_schema_review', timestamp]);
  await executor.unsafe(`INSERT INTO ${subscriptions} (organization_id, provider, subscription_id, customer_id, price_id, plan_id, status, current_period_start, current_period_end, cancel_at_period_end, event_created_at, last_event_id, source, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, $10, $11, 'verified-webhook', $8)`, ['schema-review-org', 'stripe', 'sub_schema_review', 'cus_schema_review', 'price_team_review', 'team', 'active', timestamp, '2026-10-16T00:00:00.000Z', 1_758_000_000, 'evt_schema_review']);
  await executor.unsafe(`INSERT INTO ${usage} (organization_id, period_start, period_end, seats, storage_bytes, scans, eve_cost_cents, seat_baseline, seat_reservations, seat_revision, updated_at) VALUES ($1, $2, $3, 1, 128, 1, 3, 1, '[]'::jsonb, 0, $2)`, ['schema-review-org', timestamp, '2026-10-16T00:00:00.000Z']);
  await executor.unsafe(`INSERT INTO ${events} (provider, event_id, event_type, organization_id, created_at, received_at, payload_digest, handled) VALUES ($1, $2, $3, $4, $5, $6, $7, true), ($1, $8, $9, NULL, $5, $6, $10, false)`, ['stripe', 'evt_schema_review', 'customer.subscription.created', 'schema-review-org', 1_758_000_000, timestamp, 'sha256:review-event-tenant', 'evt_schema_review_unbound', 'customer.subscription.updated', 'sha256:review-event-unbound']);
  await executor.unsafe(`INSERT INTO ${operations} (organization_id, operation_key, storage_bytes_delta, usage_snapshot, created_at, status, reconciled, reservation_generation) VALUES ($1, $2, 128, '{"storageBytes":128}'::jsonb, $3, 'committed', '{"storageBytes":128}'::jsonb, 1)`, ['schema-review-org', 'schema-review-import', timestamp]);
}

function legacyBillingSchemaSql(tablePrefix: string): string {
  const customers = quoteIdentifier(`${tablePrefix}_customers`);
  const subscriptions = quoteIdentifier(`${tablePrefix}_subscriptions`);
  const usage = quoteIdentifier(`${tablePrefix}_usage`);
  const events = quoteIdentifier(`${tablePrefix}_webhook_events`);
  const operations = quoteIdentifier(`${tablePrefix}_usage_operations`);
  return `
CREATE TABLE IF NOT EXISTS ${customers} (
  organization_id text PRIMARY KEY,
  provider text NOT NULL,
  customer_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, customer_id)
);
CREATE TABLE IF NOT EXISTS ${subscriptions} (
  organization_id text PRIMARY KEY,
  provider text NOT NULL,
  subscription_id text NOT NULL,
  customer_id text NOT NULL,
  price_id text NOT NULL,
  plan_id text NOT NULL,
  status text NOT NULL,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  event_created_at bigint NOT NULL,
  last_event_id text NOT NULL,
  source text NOT NULL DEFAULT 'verified-webhook',
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, subscription_id),
  CHECK (event_created_at >= 0),
  CHECK (source = 'verified-webhook')
);
CREATE TABLE IF NOT EXISTS ${usage} (
  organization_id text PRIMARY KEY,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  seats bigint NOT NULL DEFAULT 0,
  storage_bytes bigint NOT NULL DEFAULT 0,
  scans bigint NOT NULL DEFAULT 0,
  eve_cost_cents bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end > period_start),
  CHECK (seats >= 0),
  CHECK (storage_bytes >= 0),
  CHECK (scans >= 0),
  CHECK (eve_cost_cents >= 0)
);
CREATE TABLE IF NOT EXISTS ${events} (
  provider text NOT NULL,
  event_id text NOT NULL,
  event_type text NOT NULL,
  organization_id text,
  created_at bigint NOT NULL,
  received_at timestamptz NOT NULL,
  payload_digest text NOT NULL,
  handled boolean NOT NULL DEFAULT false,
  ignored_reason text,
  PRIMARY KEY (provider, event_id),
  CHECK (created_at >= 0)
);
CREATE TABLE IF NOT EXISTS ${operations} (
  organization_id text NOT NULL,
  operation_key text NOT NULL,
  seats_delta bigint,
  storage_bytes_delta bigint,
  scans_delta bigint,
  eve_cost_cents_delta bigint,
  usage_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, operation_key)
);
CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tablePrefix}_events_org_idx`)}
  ON ${events} (organization_id, received_at DESC);
CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tablePrefix}_operations_org_idx`)}
  ON ${operations} (organization_id, created_at DESC);
`;
}

async function insertLegacyFixture(executor: SqlExecutor, tablePrefix: string): Promise<void> {
  const customers = quoteIdentifier(`${tablePrefix}_customers`);
  const subscriptions = quoteIdentifier(`${tablePrefix}_subscriptions`);
  const usage = quoteIdentifier(`${tablePrefix}_usage`);
  const events = quoteIdentifier(`${tablePrefix}_webhook_events`);
  const operations = quoteIdentifier(`${tablePrefix}_usage_operations`);
  const timestamp = '2026-09-16T00:00:00.000Z';
  await executor.unsafe(`INSERT INTO ${customers} (organization_id, provider, customer_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)`, ['legacy-schema-review-org', 'stripe', 'cus_legacy_schema_review', timestamp]);
  await executor.unsafe(`INSERT INTO ${subscriptions} (organization_id, provider, subscription_id, customer_id, price_id, plan_id, status, current_period_start, current_period_end, cancel_at_period_end, event_created_at, last_event_id, source, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, $10, $11, 'verified-webhook', $8)`, ['legacy-schema-review-org', 'stripe', 'sub_legacy_schema_review', 'cus_legacy_schema_review', 'price_team_review', 'team', 'active', timestamp, '2026-10-16T00:00:00.000Z', 1_758_000_000, 'evt_legacy_schema_review']);
  await executor.unsafe(`INSERT INTO ${usage} (organization_id, period_start, period_end, seats, storage_bytes, scans, eve_cost_cents, updated_at) VALUES ($1, $2, $3, 1, 256, 2, 4, $2)`, ['legacy-schema-review-org', timestamp, '2026-10-16T00:00:00.000Z']);
  await executor.unsafe(`INSERT INTO ${events} (provider, event_id, event_type, organization_id, created_at, received_at, payload_digest, handled) VALUES ($1, $2, $3, $4, $5, $6, $7, true), ($1, $8, $9, NULL, $5, $6, $10, false)`, ['stripe', 'evt_legacy_schema_review', 'customer.subscription.created', 'legacy-schema-review-org', 1_758_000_000, timestamp, 'sha256:legacy-review-event-tenant', 'evt_legacy_schema_review_unbound', 'customer.subscription.updated', 'sha256:legacy-review-event-unbound']);
  await executor.unsafe(`INSERT INTO ${operations} (organization_id, operation_key, storage_bytes_delta, usage_snapshot, created_at) VALUES ($1, $2, 256, '{"storageBytes":256}'::jsonb, $3)`, ['legacy-schema-review-org', 'legacy-schema-review-import', timestamp]);
}

async function captureStableLegacyTables(executor: SqlExecutor, schema: string, tablePrefix: string): Promise<readonly { table: string; rowCount: number; rowDigest: string }[]> {
  const tables: readonly { name: string; columns: readonly string[] }[] = [
    { name: `${tablePrefix}_customers`, columns: ['organization_id', 'provider', 'customer_id', 'created_at', 'updated_at'] },
    { name: `${tablePrefix}_subscriptions`, columns: ['organization_id', 'provider', 'subscription_id', 'customer_id', 'price_id', 'plan_id', 'status', 'current_period_start', 'current_period_end', 'cancel_at_period_end', 'event_created_at', 'last_event_id', 'source', 'updated_at'] },
    { name: `${tablePrefix}_usage`, columns: ['organization_id', 'period_start', 'period_end', 'seats', 'storage_bytes', 'scans', 'eve_cost_cents', 'updated_at'] },
    { name: `${tablePrefix}_webhook_events`, columns: ['provider', 'event_id', 'event_type', 'organization_id', 'created_at', 'received_at', 'payload_digest', 'handled', 'ignored_reason'] },
    { name: `${tablePrefix}_usage_operations`, columns: ['organization_id', 'operation_key', 'seats_delta', 'storage_bytes_delta', 'scans_delta', 'eve_cost_cents_delta', 'usage_snapshot', 'created_at'] },
  ];
  const captured: { table: string; rowCount: number; rowDigest: string }[] = [];
  for (const table of tables) {
    const qualifiedTable = `${quoteIdentifier(schema)}.${quoteIdentifier(table.name)}`;
    const countRows = await queryRows<{ row_count: string }>(executor, `SELECT count(*)::text AS row_count FROM ${qualifiedTable}`);
    const selectedColumns = table.columns.map((column) => `row_data.${quoteIdentifier(column)} AS ${quoteIdentifier(column)}`).join(', ');
    const dataRows = await queryRows<{ payload: string }>(executor, `
      SELECT COALESCE(jsonb_agg(row_json ORDER BY row_json::text), '[]'::jsonb)::text AS payload
        FROM (SELECT pg_catalog.to_jsonb(selected_rows) AS row_json FROM (SELECT ${selectedColumns} FROM ${qualifiedTable} AS row_data) AS selected_rows) AS ordered_rows
    `);
    captured.push({ table: table.name, rowCount: Number(countRows[0]?.row_count ?? 0), rowDigest: sha256(dataRows[0]?.payload ?? '[]') });
  }
  return captured;
}

async function countSchemaObjects(executor: SqlExecutor, schema: string): Promise<number> {
  const rows = await queryRows<{ object_count: string }>(executor, `
    SELECT count(*)::text AS object_count
      FROM pg_catalog.pg_class AS c
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
     WHERE n.nspname = $1
  `, [schema]);
  return Number(rows[0]?.object_count ?? 0);
}

export async function runLoopbackRehearsal(
  connectionString: string,
  tablePrefix = `billing_review_${process.pid}_${Math.floor(Math.random() * 10_000)}`,
): Promise<BillingSchemaLoopbackRehearsal> {
  if (!isLoopbackDatabaseUrl(connectionString)) throw new Error('loopback PostgreSQL URL is required');
  const schema = `billing_review_schema_${process.pid}_${Math.floor(Math.random() * 10_000)}`;
  const restoreSchema = `${schema}_restore`;
  const rollbackSchema = `${schema}_rollback`;
  const legacySchema = `${schema}_legacy`;
  const legacyPrefix = `${tablePrefix}_legacy`;
  const sql = postgres(connectionString, { max: 2, prepare: false, connect_timeout: 5, onnotice: () => undefined });
  try {
    await sql.unsafe(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await sql.begin(async (transaction) => {
      await transaction.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, public`);
      await transaction.unsafe(billingPostgresSchemaSql(tablePrefix));
      await insertPopulatedFixture(transaction, tablePrefix);
    });
    const before = await sql.begin(async (transaction) => {
      await transaction.unsafe(`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      await transaction.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, public`);
      return capturePopulatedTables(transaction, schema, tablePrefix);
    });
    for (let iteration = 0; iteration < 3; iteration += 1) {
      await sql.begin(async (transaction) => {
        await transaction.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, public`);
        await transaction.unsafe(billingPostgresSchemaSql(tablePrefix));
      });
    }
    const after = await sql.begin(async (transaction) => {
      await transaction.unsafe(`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      await transaction.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, public`);
      return capturePopulatedTables(transaction, schema, tablePrefix);
    });
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('migration loop changed populated billing rows');
    const schemaReadback = await sql.begin(async (transaction) => {
      await transaction.unsafe(`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      return readBillingSchema(transaction, tablePrefix);
    });
    await sql.unsafe(`CREATE SCHEMA ${quoteIdentifier(restoreSchema)}`);
    await sql.begin(async (transaction) => {
      await transaction.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(restoreSchema)}, public`);
      await transaction.unsafe(billingPostgresSchemaSql(tablePrefix));
      for (const table of billingSchemaTableSpecs(tablePrefix)) {
        await transaction.unsafe(`INSERT INTO ${quoteIdentifier(table.name)} SELECT * FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table.name)}`);
      }
    });
    const restored = await sql.begin(async (transaction) => {
      await transaction.unsafe(`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      await transaction.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(restoreSchema)}, public`);
      return capturePopulatedTables(transaction, restoreSchema, tablePrefix);
    });
    if (JSON.stringify(before) !== JSON.stringify(restored)) throw new Error('isolated billing backup restore changed populated rows');
    await sql.unsafe(`CREATE SCHEMA ${quoteIdentifier(legacySchema)}`);
    await sql.begin(async (transaction) => {
      await transaction.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(legacySchema)}, public`);
      await transaction.unsafe(legacyBillingSchemaSql(legacyPrefix));
      await insertLegacyFixture(transaction, legacyPrefix);
    });
    const legacyBefore = await sql.begin(async (transaction) => {
      await transaction.unsafe(`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      return captureStableLegacyTables(transaction, legacySchema, legacyPrefix);
    });
    await sql.begin(async (transaction) => {
      await transaction.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(legacySchema)}, public`);
      await transaction.unsafe(billingPostgresSchemaSql(legacyPrefix));
    });
    const legacyAfter = await sql.begin(async (transaction) => {
      await transaction.unsafe(`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      return captureStableLegacyTables(transaction, legacySchema, legacyPrefix);
    });
    if (JSON.stringify(legacyBefore) !== JSON.stringify(legacyAfter)) throw new Error('legacy billing rows changed during additive upgrade');
    await sql.unsafe(`CREATE SCHEMA ${quoteIdentifier(rollbackSchema)}`);
    let transactionRolledBack = false;
    try {
      await sql.begin(async (transaction) => {
        await transaction.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(rollbackSchema)}, public`);
        await transaction.unsafe(billingPostgresSchemaSql(tablePrefix));
        await transaction.unsafe(`INSERT INTO ${quoteIdentifier(`${tablePrefix}_customers`)} (organization_id, provider, customer_id) VALUES ('rollback-only', 'stripe', 'cus_rollback')`);
        throw new Error('intentional migration review rollback');
      });
    } catch {
      transactionRolledBack = true;
    }
    const objectsRemaining = await countSchemaObjects(sql, rollbackSchema);
    if (!transactionRolledBack || objectsRemaining !== 0) throw new Error('migration rollback left objects behind');
    const allTablesPopulated = before.every((table) => table.rowCount > 0);
    const unboundWebhookRetained = before.find((table) => table.table.endsWith('_webhook_events'))?.rowCount === 2;
    if (!allTablesPopulated || !unboundWebhookRetained) throw new Error('populated billing fixture is incomplete');
    return {
      status: 'passed',
      mode: 'loopback-disposable-schema',
      tablePrefix,
      schema: schemaReadback,
      populated: {
        tableCount: before.length,
        allTablesPopulated: true,
        unboundWebhookRetained: true,
        migrationLoopCount: 3,
        before,
        after,
        backupManifestDigest: sha256(JSON.stringify(before)),
      },
      backupRestore: { isolatedSchema: true, allTablesRestored: true, restored },
      legacyUpgrade: { existingRowsPreserved: true, before: legacyBefore, after: legacyAfter },
      rollback: { transactionRolledBack: true, objectsRemaining: 0 },
    };
  } finally {
    try { await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`); } catch { /* best effort cleanup */ }
    try { await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdentifier(restoreSchema)} CASCADE`); } catch { /* best effort cleanup */ }
    try { await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdentifier(legacySchema)} CASCADE`); } catch { /* best effort cleanup */ }
    try { await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdentifier(rollbackSchema)} CASCADE`); } catch { /* best effort cleanup */ }
    await sql.end({ timeout: 5 });
  }
}

function usage(): never {
  console.error('Usage: schema-migration-review.ts [--manifest] [--inspect-env ENV_NAME] [--rehearse-loopback ENV_NAME]');
  process.exit(2);
}

async function main(argv: readonly string[]): Promise<void> {
  if (argv.length === 0 || argv.includes('--manifest')) {
    console.log(JSON.stringify(billingSchemaManifest(), null, 2));
    if (argv.length === 0 || argv.length === 1) return;
  }
  const inspectIndex = argv.indexOf('--inspect-env');
  if (inspectIndex >= 0) {
    const environmentName = argv[inspectIndex + 1];
    if (!environmentName || !IDENTIFIER.test(environmentName)) usage();
    console.log(JSON.stringify(await inspectConfiguredDatabase(process.env[environmentName]), null, 2));
    return;
  }
  const rehearsalIndex = argv.indexOf('--rehearse-loopback');
  if (rehearsalIndex >= 0) {
    const environmentName = argv[rehearsalIndex + 1];
    if (!environmentName || !IDENTIFIER.test(environmentName)) usage();
    const connectionString = process.env[environmentName];
    if (!connectionString) {
      console.log(JSON.stringify({ status: 'skipped', reason: 'loopback database environment is unset' }));
      return;
    }
    console.log(JSON.stringify(await runLoopbackRehearsal(connectionString), null, 2));
    return;
  }
  usage();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main(process.argv.slice(2)).catch(() => {
    // Keep connection details and provider errors out of review output.
    console.error('billing schema review failed');
    process.exitCode = 1;
  });
}
