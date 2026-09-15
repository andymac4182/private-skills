import postgres from 'postgres';
import { describe, expect, it } from 'vitest';

import type { PgPoolLike } from '../../database/src/postgres.js';
import {
  createIdentityRuntime,
  createIdentityRuntimeConfig,
  PostgresIdentityOperationsEventStore,
  type IdentityOperationsRole,
} from '../src/index.js';
import { loopbackDatabaseURL } from './loopback-database.js';

const databaseURL = loopbackDatabaseURL(
  ['PSKILLS_IDENTITY_TEST_DATABASE_URL', process.env.PSKILLS_IDENTITY_TEST_DATABASE_URL],
  ['PSKILLS_TEST_POSTGRES_URL', process.env.PSKILLS_TEST_POSTGRES_URL],
);
const NOW = Date.parse('2026-09-16T00:00:00.000Z');

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function poolFor(direct: ReturnType<typeof postgres>): PgPoolLike {
  return {
    query: async <Row = Record<string, unknown>>(text: string, parameters?: readonly unknown[]) => {
      const result = await direct.unsafe(text, [...(parameters ?? [])] as never[]);
      return { rows: [...result] as Row[], rowCount: (result as unknown as { count?: number }).count };
    },
    connect: async () => {
      const connection = await direct.reserve();
      return {
        query: async <Row = Record<string, unknown>>(text: string, parameters?: readonly unknown[]) => {
          const result = await connection.unsafe(text, [...(parameters ?? [])] as never[]);
          return { rows: [...result] as Row[], rowCount: (result as unknown as { count?: number }).count };
        },
        release: () => connection.release(),
      };
    },
  };
}

describe.skipIf(!databaseURL)('identity operations PostgreSQL persistence', () => {
  it('persists only live member role context and keeps global failures out of tenant summaries', async () => {
    if (!databaseURL) return;
    const schema = `identity_ops_test_${process.pid}_${Date.now()}`;
    const table = (name: string) => `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
    const direct = postgres(databaseURL, { max: 6, prepare: false });
    const pool = poolFor(direct);
    try {
      await direct.unsafe(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
      await direct.unsafe(`CREATE TABLE ${table('membership_probe')} (organization_id text NOT NULL, user_id text NOT NULL, role text NOT NULL)`);
      await direct.unsafe(`INSERT INTO ${table('membership_probe')} (organization_id, user_id, role) VALUES ($1, $2, $3), ($4, $5, $6)`, [
        'org-a', 'user-a', 'reader', 'org-a', 'user-owner', 'owner',
      ]);
      const store = new PostgresIdentityOperationsEventStore({
        pool,
        schemaName: schema,
        now: () => NOW,
        cleanupBatchSize: 1,
        verifyTenant: async (organizationId, userId) => {
          const result = await direct.unsafe(
            `SELECT organization_id, user_id, role FROM ${table('membership_probe')} WHERE organization_id = $1 AND user_id = $2 LIMIT 1`,
            [organizationId, userId],
          );
          const row = result[0] as { organization_id?: unknown; user_id?: unknown; role?: unknown } | undefined;
          const role = row?.role;
          const supported: readonly IdentityOperationsRole[] = ['owner', 'admin', 'publisher', 'reader'];
          if (!row || row.organization_id !== organizationId || row.user_id !== userId || typeof role !== 'string' || !supported.includes(role as IdentityOperationsRole)) return null;
          return { organizationId, userId, role: role as IdentityOperationsRole };
        },
      });
      await store.runMigrations();
      await store.recordGlobal({
        kind: 'callback_failure',
        reasonCode: 'callback_rejected',
        occurredAt: new Date(NOW - 2_000),
      });
      const reader = await store.trustedTenant('org-a', 'user-a');
      expect(reader?.role).toBe('reader');
      expect(await store.recordTenant(reader!, {
        kind: 'membership_denial',
        reasonCode: 'membership_role_denied',
        occurredAt: new Date(NOW - 1_000),
      })).toBe(true);
      expect(await store.trustedTenant('org-from-request', 'user-a')).toBeNull();
      expect(await store.summarize('org-a', NOW)).toEqual({
        authenticationFailures: { total: 0, last24h: 0 },
        callbackFailures: { total: 0, last24h: 0 },
        membershipDenials: { total: 1, last24h: 1, latestAt: new Date(NOW - 1_000).toISOString() },
      });
      const rows = await direct.unsafe(`SELECT organization_id, role, event_kind, reason_code FROM ${table('private_skills_identity_operations_events')} ORDER BY occurred_at`);
      expect(rows).toEqual([
        { organization_id: null, role: null, event_kind: 'callback_failure', reason_code: 'callback_rejected' },
        { organization_id: 'org-a', role: 'reader', event_kind: 'membership_denial', reason_code: 'membership_role_denied' },
      ]);

      // A role change invalidates the previously trusted context before the
      // event write, so a denial cannot retain stale tenant authority.
      await direct.unsafe(`UPDATE ${table('membership_probe')} SET role = $1 WHERE organization_id = $2 AND user_id = $3`, ['owner', 'org-a', 'user-a']);
      expect(await store.recordTenant(reader!, {
        kind: 'membership_denial',
        reasonCode: 'membership_role_denied',
        occurredAt: new Date(NOW - 500),
      })).toBe(false);

      await direct.unsafe(`INSERT INTO ${table('membership_probe')} (organization_id, user_id, role) VALUES ($1, $2, $3)`, ['org-a', 'user-old', 'reader']);
      const oldContext = await store.trustedTenant('org-a', 'user-old');
      expect(oldContext).not.toBeNull();
      await direct.unsafe(`DELETE FROM ${table('membership_probe')} WHERE user_id = $1`, ['user-old']);
      expect(await store.recordTenant(oldContext!, { kind: 'membership_denial', reasonCode: 'membership_missing' })).toBe(false);

      await store.recordGlobal({ kind: 'authentication_failure', reasonCode: 'authentication_rejected', occurredAt: new Date(NOW - 31 * 24 * 60 * 60 * 1_000) });
      await store.recordGlobal({ kind: 'authentication_failure', reasonCode: 'authentication_rejected', occurredAt: new Date(NOW - 31 * 24 * 60 * 60 * 1_000 - 1) });
      expect(await store.cleanup(NOW)).toBe(1);
      const oldRows = await direct.unsafe(`SELECT count(*)::int AS count FROM ${table('private_skills_identity_operations_events')} WHERE occurred_at < $1`, [new Date(NOW - 30 * 24 * 60 * 60 * 1_000)]);
      expect(Number((oldRows[0] as unknown as { count: number }).count)).toBe(1);
    } finally {
      await direct.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      await direct.end();
    }
  }, 30_000);

  it('awaits handler failure capture and removes expired rows on a bounded record trigger', async () => {
    if (!databaseURL) return;
    const schema = `identity_ops_lifecycle_${process.pid}_${Date.now()}`;
    const table = (name: string) => `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
    const direct = postgres(databaseURL, { max: 20, prepare: false });
    const pool = poolFor(direct);
    const store = new PostgresIdentityOperationsEventStore({
      pool,
      schemaName: schema,
      now: () => NOW,
      retentionDays: 30,
      cleanupBatchSize: 10,
      cleanupIntervalMs: 1_000,
      verifyTenant: async () => null,
    });
    const runtime = createIdentityRuntime(createIdentityRuntimeConfig({
      PSKILLS_BETTER_AUTH_ENABLED: 'true',
      DATABASE_URL: databaseURL,
      BETTER_AUTH_SECRET: '01234567890123456789012345678901',
      BETTER_AUTH_URL: 'http://localhost:5173',
      PSKILLS_BETTER_AUTH_SCHEMA: schema,
      PSKILLS_BETTER_AUTH_VALIDATE_SCHEMA: 'false',
    }), {
      onOperationalFailure: (failure) => store.recordGlobal(failure),
    });
    try {
      await direct.unsafe(`drop schema if exists ${quoteIdentifier(schema)} cascade`);
      await direct.unsafe(`create schema ${quoteIdentifier(schema)}`);
      await store.runMigrations();
      await direct.unsafe(
        `insert into ${table('private_skills_identity_operations_events')} (id, occurred_at, event_kind, reason_code, organization_id, role)
         values ($1, $2, $3, $4, $5, $6)`,
        ['expired-event', new Date(NOW - 31 * 24 * 60 * 60 * 1_000), 'authentication_failure', 'authentication_rejected', 'expired-org', 'reader'],
      );

      // The first record after the interval boundary schedules one bounded
      // cleanup query. Its inserted event remains available immediately.
      await store.recordGlobal({ kind: 'authentication_failure', reasonCode: 'authentication_rejected', occurredAt: new Date(NOW) });
      const expiredRows = await direct.unsafe(
        `select count(*)::int as count from ${table('private_skills_identity_operations_events')} where id = $1`,
        ['expired-event'],
      );
      expect(Number((expiredRows[0] as unknown as { count: number }).count)).toBe(0);

      let response: Response | undefined;
      let threw = false;
      try {
        response = await runtime.handler(new Request('http://localhost:5173/api/auth/callback/not-configured'));
      } catch {
        threw = true;
      }
      expect(threw || (response?.status ?? 0) >= 400).toBe(true);

      // No waitUntil hook is present, so the portable bounded fallback waits
      // for the real INSERT before handler() resolves.
      const failureRows = await direct.unsafe(
        `select event_kind, reason_code, organization_id, role
           from ${table('private_skills_identity_operations_events')}
          where event_kind = 'callback_failure'`,
      );
      expect(failureRows).toHaveLength(1);
      expect(failureRows[0]).toMatchObject({
        event_kind: 'callback_failure',
        organization_id: null,
        role: null,
      });
      expect(['callback_rejected', 'callback_unavailable']).toContain((failureRows[0] as unknown as { reason_code: string }).reason_code);
    } finally {
      await runtime.close();
      await direct.unsafe(`drop schema if exists ${quoteIdentifier(schema)} cascade`);
      await direct.end();
    }
  }, 30_000);
});
