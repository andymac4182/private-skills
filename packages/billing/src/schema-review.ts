import { createHash } from 'node:crypto';

import { billingPostgresSchemaSql } from './repository.js';

export const DEFAULT_BILLING_TABLE_PREFIX = 'private_skills_billing';

export type BillingSchemaTableName =
  | 'customers'
  | 'subscriptions'
  | 'usage'
  | 'events'
  | 'operations';

export interface BillingSchemaColumnSpec {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultExpression?: string;
}

export interface BillingSchemaTableSpec {
  logicalName: BillingSchemaTableName;
  name: string;
  columns: readonly BillingSchemaColumnSpec[];
  primaryKey: readonly string[];
  uniqueConstraints: readonly (readonly string[])[];
  checks: readonly string[];
}

export interface BillingSchemaIndexSpec {
  name: string;
  table: BillingSchemaTableName;
  columns: readonly string[];
  descendingColumns?: readonly string[];
}

export interface BillingSchemaSqlInventory {
  createTables: number;
  addColumnsIfMissing: number;
  guardedConstraints: number;
  createIndexesIfMissing: number;
}

export interface BillingSchemaManifest {
  schemaVersion: 1;
  tablePrefix: string;
  sqlSha256: string;
  sqlByteLength: number;
  sqlInventory: BillingSchemaSqlInventory;
  tables: readonly BillingSchemaTableSpec[];
  indexes: readonly BillingSchemaIndexSpec[];
  migrationSafety: {
    additiveOnly: true;
    destructiveStatements: readonly [];
    existingTableShapeMustBeCompared: true;
  };
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function assertIdentifier(value: string, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 40 ||
    !IDENTIFIER.test(value)
  ) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function tableName(prefix: string, suffix: string): string {
  const name = `${prefix}_${suffix}`;
  if (name.length > 63) throw new Error('billing table name is too long');
  return name;
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

const tableColumns: Record<BillingSchemaTableName, readonly BillingSchemaColumnSpec[]> = {
  customers: [
    { name: 'organization_id', dataType: 'text', nullable: false },
    { name: 'provider', dataType: 'text', nullable: false },
    { name: 'customer_id', dataType: 'text', nullable: false },
    { name: 'created_at', dataType: 'timestamp with time zone', nullable: false, defaultExpression: 'now()' },
    { name: 'updated_at', dataType: 'timestamp with time zone', nullable: false, defaultExpression: 'now()' },
  ],
  subscriptions: [
    { name: 'organization_id', dataType: 'text', nullable: false },
    { name: 'provider', dataType: 'text', nullable: false },
    { name: 'subscription_id', dataType: 'text', nullable: false },
    { name: 'customer_id', dataType: 'text', nullable: false },
    { name: 'price_id', dataType: 'text', nullable: false },
    { name: 'plan_id', dataType: 'text', nullable: false },
    { name: 'status', dataType: 'text', nullable: false },
    { name: 'current_period_start', dataType: 'timestamp with time zone', nullable: true },
    { name: 'current_period_end', dataType: 'timestamp with time zone', nullable: true },
    { name: 'cancel_at_period_end', dataType: 'boolean', nullable: false, defaultExpression: 'false' },
    { name: 'event_created_at', dataType: 'bigint', nullable: false },
    { name: 'last_event_id', dataType: 'text', nullable: false },
    { name: 'source', dataType: 'text', nullable: false, defaultExpression: "'verified-webhook'" },
    { name: 'updated_at', dataType: 'timestamp with time zone', nullable: false, defaultExpression: 'now()' },
  ],
  usage: [
    { name: 'organization_id', dataType: 'text', nullable: false },
    { name: 'period_start', dataType: 'timestamp with time zone', nullable: false },
    { name: 'period_end', dataType: 'timestamp with time zone', nullable: false },
    { name: 'seats', dataType: 'bigint', nullable: false, defaultExpression: '0' },
    { name: 'storage_bytes', dataType: 'bigint', nullable: false, defaultExpression: '0' },
    { name: 'scans', dataType: 'bigint', nullable: false, defaultExpression: '0' },
    { name: 'eve_cost_cents', dataType: 'bigint', nullable: false, defaultExpression: '0' },
    { name: 'seat_baseline', dataType: 'bigint', nullable: false, defaultExpression: '0' },
    { name: 'seat_reservations', dataType: 'jsonb', nullable: false, defaultExpression: "'[]'::jsonb" },
    { name: 'seat_revision', dataType: 'bigint', nullable: false, defaultExpression: '0' },
    { name: 'updated_at', dataType: 'timestamp with time zone', nullable: false, defaultExpression: 'now()' },
  ],
  events: [
    { name: 'provider', dataType: 'text', nullable: false },
    { name: 'event_id', dataType: 'text', nullable: false },
    { name: 'event_type', dataType: 'text', nullable: false },
    { name: 'organization_id', dataType: 'text', nullable: true },
    { name: 'created_at', dataType: 'bigint', nullable: false },
    { name: 'received_at', dataType: 'timestamp with time zone', nullable: false },
    { name: 'payload_digest', dataType: 'text', nullable: false },
    { name: 'handled', dataType: 'boolean', nullable: false, defaultExpression: 'false' },
    { name: 'ignored_reason', dataType: 'text', nullable: true },
  ],
  operations: [
    { name: 'organization_id', dataType: 'text', nullable: false },
    { name: 'operation_key', dataType: 'text', nullable: false },
    { name: 'seats_delta', dataType: 'bigint', nullable: true },
    { name: 'storage_bytes_delta', dataType: 'bigint', nullable: true },
    { name: 'scans_delta', dataType: 'bigint', nullable: true },
    { name: 'eve_cost_cents_delta', dataType: 'bigint', nullable: true },
    { name: 'usage_snapshot', dataType: 'jsonb', nullable: false },
    { name: 'created_at', dataType: 'timestamp with time zone', nullable: false },
    { name: 'status', dataType: 'text', nullable: false, defaultExpression: "'reserved'" },
    { name: 'reconciled', dataType: 'jsonb', nullable: true },
    { name: 'restoration', dataType: 'jsonb', nullable: true },
    { name: 'reservation_generation', dataType: 'bigint', nullable: false, defaultExpression: '1' },
  ],
};

function createTableSpec(prefix: string, logicalName: BillingSchemaTableName): BillingSchemaTableSpec {
  const suffix = logicalName === 'events'
    ? 'webhook_events'
    : logicalName === 'operations'
      ? 'usage_operations'
      : logicalName;
  const name = tableName(prefix, suffix);
  switch (logicalName) {
    case 'customers':
      return { logicalName, name, columns: tableColumns[logicalName], primaryKey: ['organization_id'], uniqueConstraints: [['provider', 'customer_id']], checks: [] };
    case 'subscriptions':
      return { logicalName, name, columns: tableColumns[logicalName], primaryKey: ['organization_id'], uniqueConstraints: [['provider', 'subscription_id']], checks: ['event_created_at >= 0', "source = 'verified-webhook'"] };
    case 'usage':
      return { logicalName, name, columns: tableColumns[logicalName], primaryKey: ['organization_id'], uniqueConstraints: [], checks: ['period_end > period_start', 'seats >= 0', 'storage_bytes >= 0', 'scans >= 0', 'eve_cost_cents >= 0', 'seat_baseline >= 0', 'seat_revision >= 0', "jsonb_typeof(seat_reservations) = 'array'"] };
    case 'events':
      return { logicalName, name, columns: tableColumns[logicalName], primaryKey: ['provider', 'event_id'], uniqueConstraints: [], checks: ['created_at >= 0'] };
    case 'operations':
      return { logicalName, name, columns: tableColumns[logicalName], primaryKey: ['organization_id', 'operation_key'], uniqueConstraints: [], checks: ["status IN ('reserved', 'committed', 'released')", 'reservation_generation >= 1'] };
  }
}

export function billingSchemaTableSpecs(tablePrefix = DEFAULT_BILLING_TABLE_PREFIX): readonly BillingSchemaTableSpec[] {
  const prefix = assertIdentifier(tablePrefix.trim(), 'tablePrefix');
  return (['customers', 'subscriptions', 'usage', 'events', 'operations'] as const).map((logicalName) => createTableSpec(prefix, logicalName));
}

export function billingSchemaIndexSpecs(tablePrefix = DEFAULT_BILLING_TABLE_PREFIX): readonly BillingSchemaIndexSpec[] {
  const prefix = assertIdentifier(tablePrefix.trim(), 'tablePrefix');
  return [
    { name: `${prefix}_events_org_idx`, table: 'events', columns: ['organization_id', 'received_at'], descendingColumns: ['received_at'] },
    { name: `${prefix}_operations_org_idx`, table: 'operations', columns: ['organization_id', 'created_at'], descendingColumns: ['created_at'] },
  ];
}

export function billingSchemaManifest(tablePrefix = DEFAULT_BILLING_TABLE_PREFIX): BillingSchemaManifest {
  const prefix = assertIdentifier(tablePrefix.trim(), 'tablePrefix');
  const sql = billingPostgresSchemaSql(prefix);
  return {
    schemaVersion: 1,
    tablePrefix: prefix,
    sqlSha256: sha256(sql),
    sqlByteLength: Buffer.byteLength(sql, 'utf8'),
    sqlInventory: {
      createTables: (sql.match(/CREATE TABLE IF NOT EXISTS/gu) ?? []).length,
      addColumnsIfMissing: (sql.match(/ADD COLUMN IF NOT EXISTS/gu) ?? []).length,
      guardedConstraints: (sql.match(/ADD CONSTRAINT/gu) ?? []).length,
      createIndexesIfMissing: (sql.match(/CREATE INDEX IF NOT EXISTS/gu) ?? []).length,
    },
    tables: billingSchemaTableSpecs(prefix),
    indexes: billingSchemaIndexSpecs(prefix),
    migrationSafety: {
      additiveOnly: true,
      destructiveStatements: [],
      existingTableShapeMustBeCompared: true,
    },
  };
}
