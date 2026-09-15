import { describe, expect, it } from 'vitest';
import { createHostedWorkerDispatcherRuntime } from '../apps/web/server/runtime-node.js';
import type { PgClientLike, PgPoolLike } from '../packages/database/src/postgres.js';

const CRON_SECRET = 'runtime-dispatch-test-secret';

class DispatchPool implements PgPoolLike {
  readonly organizations = ['org-a'];
  readonly calls: string[] = [];
  private leaseToken = 'runtime-dispatch-lease-token';
  private cursor: string | null = null;

  async query<Row = Record<string, unknown>>(text: string, _parameters?: readonly unknown[]) {
    if (text.startsWith('CREATE TABLE')) return { rows: [] as Row[], rowCount: 0 };
    if (text.startsWith('SELECT next_attempt_at')) return { rows: [] as Row[], rowCount: 0 };
    if (text.startsWith('SELECT "id" FROM')) return { rows: this.organizations.map((id) => ({ id })) as Row[], rowCount: this.organizations.length };
    if (text.startsWith('UPDATE "private_skills_hosted_worker_dispatch"')) {
      this.cursor = null;
      return { rows: [{ singleton_id: 'default' }] as Row[], rowCount: 1 };
    }
    return { rows: [] as Row[], rowCount: 0 };
  }

  async connect(): Promise<PgClientLike> {
    return {
      query: async <Row = Record<string, unknown>>(text: string, parameters?: readonly unknown[]) => {
        if (text.startsWith('SELECT cursor_org_id')) {
          return {
            rows: [{ cursor_org_id: this.cursor, lease_token: null, lease_expires_at: null }] as Row[],
            rowCount: 1,
          };
        }
        if (text.startsWith('UPDATE "private_skills_hosted_worker_dispatch"')) {
          if (text.includes('lease_token = $1')) {
            return { rows: [{ singleton_id: 'default' }] as Row[], rowCount: 1 };
          }
          this.cursor = typeof parameters?.[1] === 'string' ? parameters[1] : null;
          return { rows: [{ singleton_id: 'default' }] as Row[], rowCount: 1 };
        }
        return { rows: [] as Row[], rowCount: 1 };
      },
      release: () => undefined,
    };
  }
}

describe('Node hosted-worker dispatcher runtime composition', () => {
  it('uses the server catalog and tenant worker factory for the cron route', async () => {
    const pool = new DispatchPool();
    const workerTenants: string[] = [];
    const runtime = createHostedWorkerDispatcherRuntime({
      env: {
        PSKILLS_HOSTED_WORKER: 'true',
        CRON_SECRET,
        PSKILLS_HOSTED_WORKER_DISPATCH_AUTO_MIGRATE: 'true',
      },
      postgresPool: pool,
      catalog: {
        listOrganizations: async ({ after, limit }) => {
          expect(after).toBeNull();
          return pool.organizations.slice(0, limit);
        },
      },
      workerForOrganization: (organizationId) => async () => {
        workerTenants.push(organizationId);
        return Response.json({ ok: true, claimed: false });
      },
    });

    expect(runtime).toBeDefined();
    const response = await runtime!.handler(new Request('https://registry.example.test/internal/worker/run', {
      headers: {
        authorization: `Bearer ${CRON_SECRET}`,
        'x-organization-id': 'attacker-selected-tenant',
      },
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, organizationsVisited: 1, failures: 0 });
    expect(workerTenants).toEqual(['org-a']);
  });

  it('does not compose a dispatcher without every durable server-owned seam', () => {
    expect(createHostedWorkerDispatcherRuntime({
      env: { PSKILLS_HOSTED_WORKER: 'true', CRON_SECRET },
      catalog: { listOrganizations: async () => [] },
      workerForOrganization: () => undefined,
    })).toBeUndefined();
    expect(createHostedWorkerDispatcherRuntime({
      env: { PSKILLS_HOSTED_WORKER: 'true', CRON_SECRET },
      postgresPool: {} as PgPoolLike,
      workerForOrganization: () => undefined,
    })).toBeUndefined();
  });
});
