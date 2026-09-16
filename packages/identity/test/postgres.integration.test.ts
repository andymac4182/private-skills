import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { makeSignature } from 'better-auth/crypto';
import { describe, expect, it } from 'vitest';

import {
  createIdentityRuntime,
  createIdentityRuntimeConfig,
} from '../src/index';
import { loopbackDatabaseURL } from './loopback-database.js';

const databaseURL = loopbackDatabaseURL(
  ['PSKILLS_IDENTITY_TEST_DATABASE_URL', process.env.PSKILLS_IDENTITY_TEST_DATABASE_URL],
);

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

describe.skipIf(!databaseURL)('identity PostgreSQL integration', () => {
  it('persists Better Auth memberships, observes revocation, and serializes owner demotions', async () => {
    if (!databaseURL) return;
    const schema = `identity_test_${randomUUID().replaceAll('-', '')}`;
    const table = (name: string) => `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
    const direct = postgres(databaseURL, { max: 20, prepare: false });
    const runtime = createIdentityRuntime(createIdentityRuntimeConfig({
      PSKILLS_BETTER_AUTH_ENABLED: 'true',
      DATABASE_URL: databaseURL,
      BETTER_AUTH_SECRET: '01234567890123456789012345678901',
      BETTER_AUTH_URL: 'http://localhost:5173',
      PSKILLS_BETTER_AUTH_SCHEMA: schema,
      PSKILLS_BETTER_AUTH_VALIDATE_SCHEMA: 'false',
    }));
    try {
      await direct.unsafe(`drop schema if exists ${quoteIdentifier(schema)} cascade`);
      await runtime.runMigrations();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 60 * 60 * 1000);
      const users = Array.from({ length: 13 }, (_, index) => ({
        id: `identity-test-user-${index}`,
        name: `Identity Test ${index}`,
        email: `identity-test-${index}@example.test`,
      }));
      await direct.unsafe(
        `insert into ${table('user')} ("id","name","email","emailVerified","createdAt","updatedAt") values ${users.map((_, index) => `($${index * 3 + 1},$${index * 3 + 2},$${index * 3 + 3},true,$${users.length * 3 + 1},$${users.length * 3 + 1})`).join(',')}`,
        [...users.flatMap((user) => [user.id, user.name, user.email]), now],
      );
      await direct.unsafe(
        `insert into ${table('organization')} ("id","name","slug","createdAt") values ($1,$2,$3,$4)`,
        ['identity-test-org', 'Identity Test Org', 'identity-test-org', now],
      );
      await direct.unsafe(
        `insert into ${table('member')} ("id","organizationId","userId","role","createdAt") values ${users.map((_, index) => `($${index * 3 + 1},$${index * 3 + 2},$${index * 3 + 3},'owner',$${users.length * 3 + 1})`).join(',')}`,
        [
          ...users.flatMap((user, index) => [`identity-test-member-${index}`, 'identity-test-org', user.id]),
          now,
        ],
      );
      await direct.unsafe(
        `insert into ${table('session')} ("id","expiresAt","token","createdAt","updatedAt","userId","activeOrganizationId") values ${users.map((user, index) => `($${index * 2 + 1},$${index * 2 + 2},$${users.length * 2 + 1 + index},$${users.length * 3 + 1},$${users.length * 3 + 1},$${users.length * 3 + 2 + index},$${users.length * 4 + 2 + index})`).join(',')}`,
        [
          ...users.flatMap((_, index) => [`identity-test-session-${index}`, expiresAt]),
          ...users.map((_, index) => `identity-test-token-${index}`),
          now,
          ...users.map((user) => user.id),
          ...users.map(() => 'identity-test-org'),
        ],
      );

      const context = await runtime.auth.$context;
      const cookieName = context.authCookies.sessionToken.name;
      const requestFor = async (index: number, memberIndex = index): Promise<Request> => new Request(
        'http://localhost:5173/api/auth/organization/update-member-role',
        {
          method: 'POST',
          headers: {
            cookie: `${cookieName}=identity-test-token-${index}.${await makeSignature(`identity-test-token-${index}`, context.secret)}`,
            origin: 'http://localhost:5173',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            role: 'reader',
            memberId: `identity-test-member-${memberIndex}`,
            organizationId: 'identity-test-org',
          }),
        },
      );
      const sessionHeaders = new Headers({
        cookie: `${cookieName}=identity-test-token-0.${await makeSignature('identity-test-token-0', context.secret)}`,
      });
      const before = await runtime.handler(new Request('http://localhost:5173/auth/identity/session', { headers: sessionHeaders }));
      expect(before.status).toBe(200);
      const beforeBody = await before.json() as { session: { organizations: Array<{ role: string }>; activeOrganizationId: string | null } | null };
      expect(beforeBody.session?.organizations).toEqual([{
        id: 'identity-test-member-0',
        organizationId: 'identity-test-org',
        role: 'owner',
        organization: { id: 'identity-test-org', name: 'Identity Test Org', slug: 'identity-test-org' },
      }]);
      expect(beforeBody.session?.activeOrganizationId).toBe('identity-test-org');

      const demotionRequests = await Promise.all(users.map((_, index) => requestFor(index)));
      const demotionResponses = await Promise.all(demotionRequests.map((request) => runtime.handler(request)));
      expect(demotionResponses.filter((response) => response.status === 200)).toHaveLength(12);
      expect(demotionResponses.filter((response) => response.status === 400)).toHaveLength(1);
      const ownerRows = await direct.unsafe(`select "id" from ${table('member')} where "organizationId"='identity-test-org' and "role"='owner'`);
      expect(ownerRows).toHaveLength(1);

      await direct.unsafe(`delete from ${table('member')} where "id"=$1`, ['identity-test-member-0']);
      const after = await runtime.getSession(new Request('http://localhost:5173/auth/identity/session', { headers: sessionHeaders }));
      expect(after?.organizations).toEqual([]);
      expect(after?.needsOnboarding).toBe(true);
      expect(after?.activeOrganizationId).toBeNull();
      expect(await runtime.authenticate(new Request('http://localhost:5173/auth/identity/session', { headers: sessionHeaders }))).toBeNull();
    } finally {
      await runtime.close();
      await direct.unsafe(`drop schema if exists ${quoteIdentifier(schema)} cascade`);
      await direct.end();
    }
  }, 30_000);

  it('enforces Better Auth invitation permissions for owner and admin members', async () => {
    if (!databaseURL) return;
    const schema = `identity_invitation_test_${randomUUID().replaceAll('-', '')}`;
    const table = (name: string) => `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
    const direct = postgres(databaseURL, { max: 20, prepare: false });
    const runtime = createIdentityRuntime(createIdentityRuntimeConfig({
      PSKILLS_BETTER_AUTH_ENABLED: 'true',
      DATABASE_URL: databaseURL,
      BETTER_AUTH_SECRET: '01234567890123456789012345678901',
      BETTER_AUTH_URL: 'http://localhost:5173',
      PSKILLS_BETTER_AUTH_SCHEMA: schema,
      PSKILLS_BETTER_AUTH_VALIDATE_SCHEMA: 'false',
    }));
    try {
      await direct.unsafe(`drop schema if exists ${quoteIdentifier(schema)} cascade`);
      await runtime.runMigrations();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 60 * 60 * 1000);
      const users = [
        { id: 'identity-invite-owner', name: 'Invitation Owner', email: 'invite-owner@example.test' },
        { id: 'identity-invite-admin', name: 'Invitation Admin', email: 'invite-admin@example.test' },
        { id: 'identity-invite-reader', name: 'Invitation Reader', email: 'invite-reader@example.test' },
      ];
      await direct.unsafe(
        `insert into ${table('user')} ("id","name","email","emailVerified","createdAt","updatedAt") values ${users.map((_, index) => `($${index * 3 + 1},$${index * 3 + 2},$${index * 3 + 3},true,$${users.length * 3 + 1},$${users.length * 3 + 1})`).join(',')}`,
        [...users.flatMap((user) => [user.id, user.name, user.email]), now],
      );
      await direct.unsafe(
        `insert into ${table('organization')} ("id","name","slug","createdAt") values ($1,$2,$3,$4)`,
        ['identity-invite-org', 'Invitation Test Org', 'identity-invite-org', now],
      );
      await direct.unsafe(
        `insert into ${table('member')} ("id","organizationId","userId","role","createdAt") values ${users.map((_, index) => `($${index * 4 + 1},$${index * 4 + 2},$${index * 4 + 3},$${index * 4 + 4},$${users.length * 4 + 1})`).join(',')}`,
        [
          ...users.flatMap((user, index) => [
            `identity-invite-member-${index}`,
            'identity-invite-org',
            user.id,
            index === 0 ? 'owner' : index === 1 ? 'admin' : 'reader',
          ]),
          now,
        ],
      );
      await direct.unsafe(
        `insert into ${table('session')} ("id","expiresAt","token","createdAt","updatedAt","userId","activeOrganizationId") values ${users.map((user, index) => `($${index * 2 + 1},$${index * 2 + 2},$${users.length * 2 + 1 + index},$${users.length * 3 + 1},$${users.length * 3 + 1},$${users.length * 3 + 2 + index},$${users.length * 4 + 2 + index})`).join(',')}`,
        [
          ...users.flatMap((_, index) => [`identity-invite-session-${index}`, expiresAt]),
          ...users.map((_, index) => `identity-invite-token-${index}`),
          now,
          ...users.map((user) => user.id),
          ...users.map(() => 'identity-invite-org'),
        ],
      );

      const context = await runtime.auth.$context;
      const cookieName = context.authCookies.sessionToken.name;
      const requestFor = async (index: number): Promise<Request> => new Request(
        'http://localhost:5173/api/auth/organization/invite-member',
        {
          method: 'POST',
          headers: {
            cookie: `${cookieName}=identity-invite-token-${index}.${await makeSignature(`identity-invite-token-${index}`, context.secret)}`,
            origin: 'http://localhost:5173',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            email: `invited-${index}@example.test`,
            role: 'reader',
            organizationId: 'identity-invite-org',
          }),
        },
      );

      const ownerResponse = await runtime.handler(await requestFor(0));
      expect(ownerResponse.status).toBe(200);
      const ownerInvitation = await ownerResponse.json() as { organizationId?: string; status?: string };
      expect(ownerInvitation).toMatchObject({ organizationId: 'identity-invite-org', status: 'pending' });

      const adminResponse = await runtime.handler(await requestFor(1));
      expect(adminResponse.status).toBe(200);
      const adminInvitation = await adminResponse.json() as { organizationId?: string; status?: string };
      expect(adminInvitation).toMatchObject({ organizationId: 'identity-invite-org', status: 'pending' });

      const readerResponse = await runtime.handler(await requestFor(2));
      expect(readerResponse.status).toBe(403);
      await expect(readerResponse.json()).resolves.toMatchObject({
        code: 'YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION',
      });

      const invitations = await direct.unsafe(`select "email","status" from ${table('invitation')} where "organizationId"=$1 order by "email"`, ['identity-invite-org']);
      expect(invitations).toEqual([
        { email: 'invited-0@example.test', status: 'pending' },
        { email: 'invited-1@example.test', status: 'pending' },
      ]);
    } finally {
      await runtime.close();
      await direct.unsafe(`drop schema if exists ${quoteIdentifier(schema)} cascade`);
      await direct.end();
    }
  }, 30_000);
});
