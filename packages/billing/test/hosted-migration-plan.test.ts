import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { billingSchemaIndexSpecs, billingSchemaTableSpecs } from '../src/schema-review.js';
import {
  HOSTED_BILLING_MIGRATION_CONFIRMATION,
  HOSTED_BILLING_MIGRATION_LOCK_KEY,
  HOSTED_BILLING_MIGRATION_SCHEMA,
  HOSTED_BILLING_MIGRATION_SQL_BYTE_LENGTH,
  HOSTED_BILLING_MIGRATION_SQL_SHA256,
  HOSTED_BILLING_MIGRATION_STATEMENT_TIMEOUT_MS,
  HOSTED_BILLING_MIGRATION_LOCK_TIMEOUT_MS,
  HOSTED_BILLING_MIGRATION_IDLE_TIMEOUT_MS,
  HOSTED_IDENTITY_TABLE_NAMES,
  hostedBillingMigrationManifest,
  validateBillingCreationReadback,
  writeSecureBaseline,
  type HostedBillingBaseline,
} from '../scripts/prepare-hosted-migration.js';

describe('hosted billing migration plan', () => {
  it('pins the reviewed SQL digest, lock, timeout, shape, and apply guard', async () => {
    const manifest = hostedBillingMigrationManifest();
    const staticManifest = JSON.parse(await readFile(new URL('../migrations/0001_billing_hosted_execution.manifest.json', import.meta.url), 'utf8')) as typeof manifest & { identityTables: readonly string[] };
    expect(manifest).toMatchObject({
      sqlSha256: HOSTED_BILLING_MIGRATION_SQL_SHA256,
      sqlByteLength: HOSTED_BILLING_MIGRATION_SQL_BYTE_LENGTH,
      targetSchema: HOSTED_BILLING_MIGRATION_SCHEMA,
      advisoryLock: { key: HOSTED_BILLING_MIGRATION_LOCK_KEY, timeoutMs: HOSTED_BILLING_MIGRATION_LOCK_TIMEOUT_MS },
      transaction: {
        statementTimeoutMs: HOSTED_BILLING_MIGRATION_STATEMENT_TIMEOUT_MS,
        lockTimeoutMs: HOSTED_BILLING_MIGRATION_LOCK_TIMEOUT_MS,
        idleInTransactionTimeoutMs: HOSTED_BILLING_MIGRATION_IDLE_TIMEOUT_MS,
        searchPath: ['public', 'pg_catalog'],
      },
      expectedShape: { tableCount: 5, columnCount: 51, checkCount: 13, physicalIndexCount: 9, zeroRows: true },
      safety: { defaultMode: 'plan-only', noDestructiveStatements: true, noApplicationRowWrites: true, independentPostApplyConnection: true },
    });
    expect(staticManifest).toMatchObject(manifest);
    expect(staticManifest.identityTables).toEqual(HOSTED_IDENTITY_TABLE_NAMES);
    expect(HOSTED_BILLING_MIGRATION_CONFIRMATION).toBe('APPLY_PRIVATE_SKILLS_BILLING_SCHEMA_20260916');
  });

  it('accepts only the complete public five-table empty shape', () => {
    const specs = billingSchemaTableSpecs();
    const indexesFor = (spec: (typeof specs)[number]) => {
      const secondary = billingSchemaIndexSpecs().filter((index) => index.table === spec.logicalName);
      return [
        { name: `${spec.name}_pkey`, unique: true, primary: true, columns: spec.primaryKey, definition: `CREATE UNIQUE INDEX ${spec.name}_pkey ON ${spec.name} (${spec.primaryKey.join(', ')})` },
        ...spec.uniqueConstraints.map((columns, index) => ({ name: `${spec.name}_unique_${index}`, unique: true, primary: false, columns, definition: `CREATE UNIQUE INDEX ${spec.name}_unique_${index} ON ${spec.name} (${columns.join(', ')})` })),
        ...secondary.map((index) => ({
          name: index.name,
          unique: false,
          primary: false,
          columns: index.columns.map((column) => index.descendingColumns?.includes(column) ? `${column} DESC` : column),
          definition: `CREATE INDEX ${index.name} ON ${spec.name} (${index.columns.map((column) => index.descendingColumns?.includes(column) ? `${column} DESC` : column).join(', ')})`,
        })),
      ];
    };
    const target = {
      status: 'ready' as const,
      readOnly: true as const,
      tablePrefix: 'private_skills_billing',
      schemaNames: [HOSTED_BILLING_MIGRATION_SCHEMA],
      expectedTables: specs.map((spec) => spec.name),
      foundTables: specs.map((spec) => spec.name),
      missingTables: [],
      schemaDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      tables: specs.map((spec) => ({
        schema: HOSTED_BILLING_MIGRATION_SCHEMA,
        name: spec.name,
        rowCount: 0,
        columns: spec.columns,
        constraints: [
          { name: `${spec.name}_pkey`, type: 'primary', definition: `PRIMARY KEY (${spec.primaryKey.join(', ')})` },
          ...spec.uniqueConstraints.map((columns, index) => ({ name: `${spec.name}_unique_${index}`, type: 'unique', definition: `UNIQUE (${columns.join(', ')})` })),
          ...spec.checks.map((check, index) => ({ name: `${spec.name}_check_${index}`, type: 'check', definition: `CHECK (${check})` })),
        ],
        indexes: indexesFor(spec),
      })),
    };
    expect(validateBillingCreationReadback(target)).toEqual({ tableCount: 5, columnCount: 51, checkCount: 13, physicalIndexCount: 9, zeroRows: true });
    expect(() => validateBillingCreationReadback({ ...target, tables: target.tables.map((table, index) => index === 0 ? { ...table, rowCount: 1 } : table) })).toThrow(/not empty/u);
    expect(() => validateBillingCreationReadback({ ...target, schemaNames: ['billing_shadow'] })).toThrow(/public schema/u);
  });

  it('writes a bounded baseline artifact with mode 0600', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pskills-billing-plan-'));
    const output = join(root, 'baseline.json');
    const baseline = {
      capturedUnderAdvisoryLock: true,
      readOnly: true,
      namespace: { currentSchema: 'public', currentSchemas: ['public'], searchPath: 'public, pg_catalog' },
      identity: HOSTED_IDENTITY_TABLE_NAMES.map((expectedName) => ({ expectedName, schema: null, present: false, rowCount: 0 })),
      registry: {
        schema: 'public', table: 'private_skills_registry_state', present: true, rowCount: 1,
        minimumRevision: 1, maximumRevision: 1, minimumStateJsonType: 'object', maximumStateJsonType: 'object',
        stateSqlType: 'jsonb', minimumStateBytes: 2, maximumStateBytes: 2, stateDigest: 'md5:fixture',
      },
      billing: {
        status: 'absent', readOnly: true, tablePrefix: 'private_skills_billing', schemaNames: [], expectedTables: [], foundTables: [], missingTables: [],
        schemaDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000', tables: [],
      },
    } as HostedBillingBaseline;
    try {
      await writeSecureBaseline(output, baseline);
      expect((await stat(output)).mode & 0o777).toBe(0o600);
      const text = await readFile(output, 'utf8');
      expect(text).toContain('billing-hosted-migration-baseline');
      expect(text).not.toMatch(/postgres(?:ql)?:\/\//u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
