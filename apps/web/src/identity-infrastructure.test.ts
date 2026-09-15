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
});
