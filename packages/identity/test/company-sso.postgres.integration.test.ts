import postgres from 'postgres';
import { describe, expect, it } from 'vitest';

import {
  CompanySsoConflictError,
  createPostgresJsCompanySsoRepository,
  type CompanySsoProviderRecord,
} from '../src/company-sso.js';

const databaseURL = process.env.PSKILLS_IDENTITY_TEST_DATABASE_URL;

function testRecord(overrides: Partial<CompanySsoProviderRecord> = {}): CompanySsoProviderRecord {
  return {
    id: 'row-acme-oidc',
    organizationId: 'acme',
    providerId: 'acme-oidc',
    displayName: 'Acme Identity',
    protocol: 'oidc',
    issuer: 'https://idp.example.test',
    callbackUrl: 'https://app.example.test/api/auth/sso/callback/acme-oidc',
    status: 'active',
    oidc: {
      clientId: 'acme-client-id',
      clientSecret: 'test-client-secret',
      discoveryUrl: 'https://idp.example.test/.well-known/openid-configuration',
      authorizationEndpoint: 'https://idp.example.test/authorize',
      tokenEndpoint: 'https://idp.example.test/token',
      jwksEndpoint: 'https://idp.example.test/jwks',
      scopes: ['openid', 'profile', 'email'],
      pkce: true,
    },
    createdBy: 'owner-1',
    updatedBy: 'owner-1',
    revision: 1,
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:00.000Z',
    ...overrides,
  };
}

describe.skipIf(!databaseURL)('company SSO PostgreSQL persistence', () => {
  it('persists explicit company bindings and keeps foreign-company reads empty', async () => {
    if (!databaseURL) return;
    const tableName = `company_sso_test_${process.pid}_${Date.now()}`;
    const sql = postgres(databaseURL, { max: 4, prepare: false });
    const repository = createPostgresJsCompanySsoRepository(sql, { tableName, autoMigrate: true });
    try {
      const created = await repository.create(testRecord());
      expect(created.providerId).toBe('acme-oidc');
      expect((await repository.list('acme')).map((provider) => provider.providerId)).toEqual(['acme-oidc']);
      expect(await repository.list('globex')).toEqual([]);
      expect(await repository.get('globex', 'acme-oidc')).toBeNull();
      await expect(repository.create(testRecord({ id: 'row-globex', organizationId: 'globex' }))).rejects.toBeInstanceOf(CompanySsoConflictError);
      const updated = await repository.update('acme', 'acme-oidc', { status: 'disabled', updatedBy: 'owner-1', updatedAt: '2026-09-15T01:00:00.000Z' }, 1);
      expect(updated).toMatchObject({ status: 'disabled', revision: 2 });
      expect(await repository.delete('globex', 'acme-oidc')).toBe(false);
      expect(await repository.delete('acme', 'acme-oidc', 2)).toBe(true);
    } finally {
      await sql.unsafe(`DROP TABLE IF EXISTS "${tableName}"`);
      await sql.end({ timeout: 5 });
    }
  }, 30_000);
});

