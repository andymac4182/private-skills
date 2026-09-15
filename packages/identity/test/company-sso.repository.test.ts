import { describe, expect, it } from 'vitest';

import {
  COMPANY_SSO_SCHEMA_SQL,
  MemoryCompanySsoRepository,
  PostgresCompanySsoRepository,
  companySsoSchemaSql,
  createPostgresJsCompanySsoRepository,
  type CompanySsoPgPool,
  type CompanySsoProviderRecord,
} from '../src/company-sso.js';

const record: CompanySsoProviderRecord = {
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
    userInfoEndpoint: 'https://idp.example.test/userinfo',
    scopes: ['openid', 'profile', 'email'],
    pkce: true,
  },
  createdBy: 'owner-1',
  updatedBy: 'owner-1',
  revision: 1,
  createdAt: '2026-09-15T00:00:00.000Z',
  updatedAt: '2026-09-15T00:00:00.000Z',
};

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: record.id,
    organization_id: record.organizationId,
    provider_id: record.providerId,
    display_name: record.displayName,
    protocol: record.protocol,
    issuer: record.issuer,
    callback_url: record.callbackUrl,
    status: record.status,
    oidc_config: record.oidc,
    saml_config: null,
    created_by: record.createdBy,
    updated_by: record.updatedBy,
    revision: record.revision,
    created_at: new Date(record.createdAt),
    updated_at: new Date(record.updatedAt),
    ...overrides,
  };
}

class PoolFixture implements CompanySsoPgPool {
  readonly calls: Array<{ text: string; parameters?: readonly unknown[] }> = [];
  responseRows: Record<string, unknown>[] = [];
  rowCount = 0;

  async query<Row = Record<string, unknown>>(text: string, parameters?: readonly unknown[]) {
    this.calls.push({ text, parameters });
    return { rows: this.responseRows as Row[], rowCount: this.rowCount };
  }

  async connect() {
    return {
      query: this.query.bind(this),
      release: () => undefined,
    };
  }
}

describe('company SSO migration and repositories', () => {
  it('defines explicit tenant binding columns without email-domain discovery', () => {
    expect(COMPANY_SSO_SCHEMA_SQL).toContain('organization_id text NOT NULL');
    expect(COMPANY_SSO_SCHEMA_SQL).toContain('provider_id text NOT NULL UNIQUE');
    expect(COMPANY_SSO_SCHEMA_SQL).toContain("protocol IN ('oidc', 'saml')");
    expect(COMPANY_SSO_SCHEMA_SQL).toContain('revision bigint NOT NULL DEFAULT 1');
    expect(COMPANY_SSO_SCHEMA_SQL).not.toContain('domain');
    expect(companySsoSchemaSql('identity_company_sso')).toContain('"identity_company_sso"');
    expect(companySsoSchemaSql('identity_company_sso', 'identity')).toContain('CREATE SCHEMA IF NOT EXISTS "identity"');
    expect(companySsoSchemaSql('identity_company_sso', 'identity')).toContain('"identity"."identity_company_sso"');
    expect(() => companySsoSchemaSql('bad-name')).toThrow();
  });

  it('keeps provider ids globally unique while list/get remain organization scoped', async () => {
    const repository = new MemoryCompanySsoRepository([record]);
    expect(await repository.get('acme', 'acme-oidc')).toEqual(record);
    expect(await repository.get('globex', 'acme-oidc')).toBeNull();
    expect(await repository.list('globex')).toEqual([]);
    await expect(repository.create({ ...record, id: 'row-globex', organizationId: 'globex' })).rejects.toMatchObject({ code: 'COMPANY_SSO_CONFLICT' });
    const changed = await repository.update('acme', 'acme-oidc', { displayName: 'Rotated' }, 1);
    expect(changed).toMatchObject({ displayName: 'Rotated', revision: 2 });
    expect(await repository.update('acme', 'acme-oidc', { displayName: 'Stale' }, 1)).toBeNull();
    expect(await repository.delete('globex', 'acme-oidc')).toBe(false);
  });

  it('maps Postgres rows and uses revision-fenced tenant predicates', async () => {
    const pool = new PoolFixture();
    const repository = new PostgresCompanySsoRepository(pool);
    pool.responseRows = [row()];
    expect(await repository.get('acme', 'acme-oidc')).toEqual(record);
    expect(pool.calls[0]?.text).toContain('organization_id = $1 AND provider_id = $2');
    expect(await repository.getByProviderId('acme-oidc')).toEqual(record);
    expect(await repository.list('acme')).toEqual([record]);
    const created = await repository.create(record);
    expect(created).toEqual(record);
    expect(pool.calls.at(-1)?.parameters?.some((parameter) => typeof parameter === 'string' && parameter.includes('test-client-secret'))).toBe(true);

    pool.responseRows = [row({ revision: 2, display_name: 'Updated', updated_at: new Date('2026-09-15T01:00:00.000Z') })];
    const updated = await repository.update('acme', 'acme-oidc', { displayName: 'Updated', updatedBy: 'admin-1', updatedAt: '2026-09-15T01:00:00.000Z' }, 1);
    expect(updated?.revision).toBe(2);
    expect(pool.calls.at(-1)?.text).toContain('revision = $');
    pool.rowCount = 1;
    expect(await repository.delete('acme', 'acme-oidc', 2)).toBe(true);
    expect(pool.calls.at(-1)?.text).toContain('revision = $3');
  });

  it('adapts postgres.js unsafe queries without exposing a second persistence contract', async () => {
    const calls: Array<{ text: string; parameters?: readonly unknown[] }> = [];
    const client = {
      unsafe: async <Row = Record<string, unknown>>(text: string, parameters?: readonly unknown[]) => {
        calls.push({ text, parameters });
        return [row()] as Row[];
      },
    };
    const repository = createPostgresJsCompanySsoRepository(client);
    expect(await repository.get('acme', 'acme-oidc')).toEqual(record);
    expect(calls[0]?.parameters).toEqual(['acme', 'acme-oidc']);
  });

  it('runs the explicit migration in the configured schema', async () => {
    const pool = new PoolFixture();
    const repository = new PostgresCompanySsoRepository(pool, {
      tableName: 'identity_company_sso',
      schemaName: 'identity',
      autoMigrate: true,
    });

    await repository.runMigrations();
    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0]?.text).toContain('CREATE SCHEMA IF NOT EXISTS "identity"');
    expect(pool.calls[0]?.text).toContain('"identity"."identity_company_sso"');
    // Concurrent repository calls share the one startup migration promise.
    await Promise.all([repository.runMigrations(), repository.list('acme')]);
    expect(pool.calls.filter(({ text }) => text.includes('CREATE SCHEMA IF NOT EXISTS')).length).toBe(1);
  });
});
