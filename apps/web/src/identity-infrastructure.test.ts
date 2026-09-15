import { describe, expect, it, vi } from 'vitest';
import type { IdentityRuntimeAdmin } from '../../../packages/identity/src/index.js';
import type { ApiTokenPgPool } from '../../../packages/api-tokens/src/index.js';
import { PostgresBetterAuthMembershipAuthorizer } from '../server/identity-infrastructure.js';

function poolReturningRole(role: unknown): ApiTokenPgPool {
  return {
    query: vi.fn().mockResolvedValue({
      rows: [{ organizationId: 'org-1', userId: 'user-1', role }],
    }),
    connect: vi.fn(),
  };
}

function poolReturningRoleAndDisplay(role: unknown): ApiTokenPgPool {
  return {
    query: vi.fn()
      .mockResolvedValueOnce({ rows: [{ organizationId: 'org-1', userId: 'user-1', role }] })
      .mockResolvedValueOnce({ rows: [{ userName: 'Alice Example', userEmail: 'alice@example.test', organizationName: 'Acme Labs', organizationSlug: 'acme-labs' }] }),
    connect: vi.fn(),
  };
}

describe('Better Auth membership authorization', () => {
  it.each([
    ['member', 'reader'],
    ['owner', 'owner'],
    ['publisher', 'publisher'],
  ])('normalizes the supported %s role for bearer authorization', async (storedRole, expectedRole) => {
    const authorizer = new PostgresBetterAuthMembershipAuthorizer(
      {} as IdentityRuntimeAdmin,
      poolReturningRole(storedRole),
    );

    await expect(authorizer.getMembership('org-1', 'user-1')).resolves.toMatchObject({
      organizationId: 'org-1',
      userId: 'user-1',
      role: expectedRole,
      active: true,
    });
  });

  it('rejects the unsupported manager role instead of granting bearer authority', async () => {
    const authorizer = new PostgresBetterAuthMembershipAuthorizer(
      {} as IdentityRuntimeAdmin,
      poolReturningRole('manager'),
    );

    await expect(authorizer.getMembership('org-1', 'user-1')).resolves.toBeNull();
  });

  it('adds identity-record display labels after the live membership check', async () => {
    const pool = poolReturningRoleAndDisplay('owner');
    const authorizer = new PostgresBetterAuthMembershipAuthorizer(
      {} as IdentityRuntimeAdmin,
      pool,
    );

    await expect(authorizer.getMembership('org-1', 'user-1')).resolves.toMatchObject({
      organizationId: 'org-1',
      userId: 'user-1',
      role: 'owner',
      active: true,
      display: {
        userName: 'Alice Example',
        userEmail: 'alice@example.test',
        organizationName: 'Acme Labs',
        organizationSlug: 'acme-labs',
      },
    });
    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query).toHaveBeenNthCalledWith(2, expect.stringContaining('organization'), ['org-1', 'user-1']);
  });

  it('keeps a valid membership when identity label lookup is unavailable', async () => {
    const pool: ApiTokenPgPool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ organizationId: 'org-1', userId: 'user-1', role: 'reader' }] })
        .mockRejectedValueOnce(new Error('labels unavailable')),
      connect: vi.fn(),
    };
    const authorizer = new PostgresBetterAuthMembershipAuthorizer(
      {} as IdentityRuntimeAdmin,
      pool,
    );

    const membership = await authorizer.getMembership('org-1', 'user-1');
    expect(membership).toMatchObject({
      organizationId: 'org-1', userId: 'user-1', role: 'reader', active: true,
    });
    expect(membership).not.toHaveProperty('display');
  });
});

describe('company SSO identity composition', () => {
  it('installs the SSO plugin and exposes the bridged company API when identity is enabled', async () => {
    const pool: ApiTokenPgPool = {
      query: vi.fn(),
      connect: vi.fn(),
    };
    const infrastructure = (await import('../server/identity-infrastructure.js')).createIdentityInfrastructure({
      PSKILLS_BETTER_AUTH_ENABLED: 'true',
      DATABASE_URL: 'postgres://127.0.0.1:1/identity-composition-test',
      BETTER_AUTH_SECRET: 'identity-composition-test-secret-0123456789',
      BETTER_AUTH_URL: 'http://localhost:5173',
      PSKILLS_ENVIRONMENT: 'test',
    }, {
      postgresPool: pool,
      canonicalOrigin: 'http://localhost:5173',
      companySsoTableName: 'identity_composition_company_sso',
    });

    try {
      expect(infrastructure.companySso).not.toBeNull();
      expect(infrastructure.companySso?.repository).toBeDefined();
      expect(infrastructure.identity?.auth.options.plugins?.some((plugin) => plugin.id === 'sso')).toBe(true);
    } finally {
      await infrastructure.identity?.close();
    }
  });

  it('keeps API-token startup migration opt-in while waiting for it when enabled', async () => {
    const pool: ApiTokenPgPool = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      connect: vi.fn(),
    };
    const infrastructure = (await import('../server/identity-infrastructure.js')).createIdentityInfrastructure({
      PSKILLS_BETTER_AUTH_ENABLED: 'true',
      DATABASE_URL: 'postgres://127.0.0.1:1/identity-composition-test',
      BETTER_AUTH_SECRET: 'identity-composition-test-secret-0123456789',
      BETTER_AUTH_URL: 'http://localhost:5173',
      PSKILLS_ENVIRONMENT: 'test',
      PSKILLS_BETTER_AUTH_AUTO_MIGRATE: 'false',
      PSKILLS_COMPANY_SSO_AUTO_MIGRATE: 'false',
      PSKILLS_API_TOKEN_AUTO_MIGRATE: 'true',
      PSKILLS_API_TOKEN_SCHEMA: 'identity_composition_auth',
      PSKILLS_BETTER_AUTH_SCHEMA: 'identity_composition_auth',
    }, {
      postgresPool: pool,
      canonicalOrigin: 'http://localhost:5173',
      apiTokenTableName: 'identity_composition_tokens',
      companySsoTableName: 'identity_composition_company_sso',
    });

    try {
      await infrastructure.ready;
      const migration = (pool.query as ReturnType<typeof vi.fn>).mock.calls
        .map(([text]) => text as string)
        .find((text) => text.includes('identity_composition_tokens'));
      expect(migration).toContain('CREATE SCHEMA IF NOT EXISTS "identity_composition_auth"');
      expect(migration).toContain('"identity_composition_auth"."identity_composition_tokens"');
    } finally {
      await infrastructure.identity?.close();
    }
  });

  it('does not run the API-token migration when its startup flag is disabled', async () => {
    const pool: ApiTokenPgPool = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      connect: vi.fn(),
    };
    const infrastructure = (await import('../server/identity-infrastructure.js')).createIdentityInfrastructure({
      PSKILLS_BETTER_AUTH_ENABLED: 'true',
      DATABASE_URL: 'postgres://127.0.0.1:1/identity-composition-test',
      BETTER_AUTH_SECRET: 'identity-composition-test-secret-0123456789',
      BETTER_AUTH_URL: 'http://localhost:5173',
      PSKILLS_ENVIRONMENT: 'test',
      PSKILLS_BETTER_AUTH_AUTO_MIGRATE: 'false',
      PSKILLS_COMPANY_SSO_AUTO_MIGRATE: 'false',
      PSKILLS_API_TOKEN_AUTO_MIGRATE: 'false',
      PSKILLS_BETTER_AUTH_SCHEMA: 'identity_composition_auth',
    }, {
      postgresPool: pool,
      canonicalOrigin: 'http://localhost:5173',
      apiTokenTableName: 'identity_composition_tokens',
      companySsoTableName: 'identity_composition_company_sso',
    });

    try {
      await infrastructure.ready;
      expect(pool.query).not.toHaveBeenCalled();
    } finally {
      await infrastructure.identity?.close();
    }
  });
});
