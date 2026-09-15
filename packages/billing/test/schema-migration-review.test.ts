import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { billingPostgresSchemaSql } from '../src/repository.js';
import {
  billingSchemaIndexSpecs,
  billingSchemaManifest,
  billingSchemaTableSpecs,
} from '../src/schema-review.js';
import { inspectConfiguredDatabase } from '../scripts/schema-migration-review.js';

const STATIC_SQL_PATH = fileURLToPath(new URL('../migrations/0001_billing_schema.sql', import.meta.url));
const STATIC_MANIFEST_PATH = fileURLToPath(new URL('../migrations/0001_billing_schema.manifest.json', import.meta.url));
const EVIDENCE_PATH = fileURLToPath(new URL('../../../docs/evidence/billing-schema-migration-review-20260916.json', import.meta.url));

describe('billing migration review package', () => {
  it('keeps the checked-in additive SQL and digest manifest tied to the authoritative helper', async () => {
    const sql = await readFile(STATIC_SQL_PATH, 'utf8');
    const manifestText = await readFile(STATIC_MANIFEST_PATH, 'utf8');
    const manifest = JSON.parse(manifestText) as ReturnType<typeof billingSchemaManifest>;
    const generated = billingSchemaManifest();
    expect(sql).toBe(billingPostgresSchemaSql());
    expect(manifest).toEqual(generated);
    expect(Buffer.byteLength(sql, 'utf8')).toBe(generated.sqlByteLength);
    expect(generated.sqlSha256).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(sql).not.toMatch(/\b(DROP|TRUNCATE|DELETE|UPDATE|INSERT)\b/iu);
    expect(sql.match(/CREATE TABLE IF NOT EXISTS/gu)).toHaveLength(5);
    expect(sql.match(/ADD COLUMN IF NOT EXISTS/gu)).toHaveLength(7);
    expect(sql.match(/CREATE INDEX IF NOT EXISTS/gu)).toHaveLength(2);
  });

  it('describes every billing relation, constraint, and secondary index without auth or registry tables', () => {
    const tables = billingSchemaTableSpecs();
    expect(tables.map((table) => table.name)).toEqual([
      'private_skills_billing_customers',
      'private_skills_billing_subscriptions',
      'private_skills_billing_usage',
      'private_skills_billing_webhook_events',
      'private_skills_billing_usage_operations',
    ]);
    expect(tables.reduce((count, table) => count + table.columns.length, 0)).toBe(51);
    expect(tables.flatMap((table) => table.checks)).toEqual([
      'event_created_at >= 0',
      "source = 'verified-webhook'",
      'period_end > period_start',
      'seats >= 0',
      'storage_bytes >= 0',
      'scans >= 0',
      'eve_cost_cents >= 0',
      'seat_baseline >= 0',
      'seat_revision >= 0',
      "jsonb_typeof(seat_reservations) = 'array'",
      'created_at >= 0',
      "status IN ('reserved', 'committed', 'released')",
      'reservation_generation >= 1',
    ]);
    expect(billingSchemaIndexSpecs()).toEqual([
      { name: 'private_skills_billing_events_org_idx', table: 'events', columns: ['organization_id', 'received_at'], descendingColumns: ['received_at'] },
      { name: 'private_skills_billing_operations_org_idx', table: 'operations', columns: ['organization_id', 'created_at'], descendingColumns: ['created_at'] },
    ]);
    expect(JSON.stringify(tables)).not.toMatch(/better.?auth|registry_state|company_sso/iu);
  });

  it('binds custom prefixes without interpolating arbitrary identifiers', () => {
    const custom = billingSchemaManifest('billing_review');
    expect(custom.tables[0]?.name).toBe('billing_review_customers');
    expect(billingPostgresSchemaSql('billing_review')).toContain('"billing_review_usage_operations"');
    expect(() => billingSchemaManifest('billing review')).toThrow();
    expect(() => billingSchemaManifest('billing_review;drop')).toThrow();
  });

  it('does not probe a database when the configured target is absent or malformed', async () => {
    await expect(inspectConfiguredDatabase(undefined)).resolves.toEqual({ configured: false, readOnly: true });
    await expect(inspectConfiguredDatabase('not-a-database-url')).resolves.toEqual({ configured: true, readOnly: true, errorCode: 'INVALID_URL' });
  });

  it('keeps the committed evidence credential-free', async () => {
    const evidence = await readFile(EVIDENCE_PATH, 'utf8');
    expect(evidence).not.toMatch(/postgres(?:ql)?:\/\/|sk_(?:live|test)_|whsec_/iu);
  });
});
