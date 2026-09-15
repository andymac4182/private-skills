import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { defaultRegistryState, MemoryStateRepository } from '../../../packages/database/src/index.js';
import {
  createPostgresTenantReviewTargetLister,
  createTenantReviewRuntime,
} from '../server/tenant-review-runtime.js';
import {
  createTenantReviewCronHandler,
  dispatchTenantDailyReviews,
  StateRepositoryTenantReviewDispatchLedger,
  TENANT_REVIEW_DISPATCH_CRON,
  type TenantReviewTarget,
} from '../server/tenant-review-dispatch.js';

const DAY = new Date('2026-09-16T00:00:00.000Z');

function repository() {
  return new MemoryStateRepository({
    stateFactory: () => defaultRegistryState({ production: false, allowUnscanned: true }),
  });
}

function target(organizationId: string, provisioned = true, enabled?: boolean): TenantReviewTarget {
  return {
    organizationId,
    provisioned,
    ...(enabled === undefined ? {} : { enabled }),
  };
}

describe('tenant review dispatch', () => {
  it('configures a repeated host liveness trigger for same-day cursor draining', () => {
    const config = JSON.parse(readFileSync(new URL('../../../vercel.json', import.meta.url), 'utf8')) as {
      crons?: Array<{ path?: string; schedule?: string }>;
    };
    expect(config.crons?.find((cron) => cron.path === '/internal/reviewer/dispatch')?.schedule)
      .toBe(TENANT_REVIEW_DISPATCH_CRON);
  });

  it('runs each explicitly provisioned company once and keeps completion idempotent', async () => {
    const repo = repository();
    const ledger = new StateRepositoryTenantReviewDispatchLedger(repo);
    const calls: string[] = [];
    const dispatch = () => dispatchTenantDailyReviews({
      listTenants: async () => [target('globex'), target('acme')],
      triggerForTenant: async (organizationId) => async (requestedOrganizationId) => {
        expect(requestedOrganizationId).toBe(organizationId);
        calls.push(requestedOrganizationId ?? 'missing');
        return { sessionId: `eve-${organizationId}`, status: 'started' };
      },
      ledger,
      now: () => DAY,
    });

    await expect(dispatch()).resolves.toMatchObject({ attempted: 2, started: 2, truncated: 0 });
    await expect(dispatch()).resolves.toMatchObject({ attempted: 0, started: 0, outcomes: [
      { organizationId: 'acme', status: 'already-completed' },
      { organizationId: 'globex', status: 'already-completed' },
    ] });
    expect(calls).toEqual(['acme', 'globex']);
  });

  it('skips unprovisioned or disabled companies without falling back to a default trigger', async () => {
    const repo = repository();
    const ledger = new StateRepositoryTenantReviewDispatchLedger(repo);
    const calls: string[] = [];
    const result = await dispatchTenantDailyReviews({
      listTenants: async () => [target('default', false), target('disabled', true, false), target('acme')],
      triggerForTenant: async (organizationId) => async () => {
        calls.push(organizationId);
        return { sessionId: 'tenant-session', status: 'started' };
      },
      ledger,
      now: () => DAY,
    });

    expect(result.outcomes).toEqual([
      { organizationId: 'acme', operationKey: 'common-skill-review:2026-09-16', status: 'started', sessionId: 'tenant-session' },
      { organizationId: 'default', operationKey: 'common-skill-review:2026-09-16', status: 'unavailable', reason: 'not-provisioned' },
      { organizationId: 'disabled', operationKey: 'common-skill-review:2026-09-16', status: 'unavailable', reason: 'not-provisioned' },
    ]);
    expect(calls).toEqual(['acme']);
  });

  it('fences concurrent dispatchers and allows a definite provider rejection to retry', async () => {
    const repo = repository();
    const ledger = new StateRepositoryTenantReviewDispatchLedger(repo);
    let calls = 0;
    let releaseProvider!: () => void;
    const providerReady = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const triggerForTenant = async () => async () => {
      calls += 1;
      await providerReady;
      return { sessionId: `session-${calls}`, status: 'started' as const };
    };
    const options = {
      listTenants: async () => [target('acme')],
      triggerForTenant,
      ledger,
      now: () => DAY,
    };
    const first = dispatchTenantDailyReviews(options);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const second = await dispatchTenantDailyReviews(options);
    expect(second.outcomes).toEqual([{ organizationId: 'acme', operationKey: 'common-skill-review:2026-09-16', status: 'in-progress' }]);
    releaseProvider();
    await expect(first).resolves.toMatchObject({ started: 1 });
    expect(calls).toBe(1);

    const rejectRepo = repository();
    const rejectLedger = new StateRepositoryTenantReviewDispatchLedger(rejectRepo);
    let rejectCalls = 0;
    const rejectThenStart = async () => async () => {
      rejectCalls += 1;
      if (rejectCalls === 1) throw Object.assign(new Error('provider rejected'), { status: 400 });
      return { sessionId: 'accepted', status: 'started' as const };
    };
    const retryOptions = { listTenants: async () => [target('acme')], triggerForTenant: rejectThenStart, ledger: rejectLedger, now: () => DAY };
    await expect(dispatchTenantDailyReviews(retryOptions)).resolves.toMatchObject({ started: 0, outcomes: [{ status: 'failed', reason: 'provider-rejected' }] });
    await expect(dispatchTenantDailyReviews(retryOptions)).resolves.toMatchObject({ started: 1, outcomes: [{ status: 'started', sessionId: 'accepted' }] });
  });

  it('fences an uncertain provider result instead of retrying a duplicate session', async () => {
    const repo = repository();
    const ledger = new StateRepositoryTenantReviewDispatchLedger(repo);
    let now = DAY;
    let calls = 0;
    const triggerForTenant = async () => async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('network timeout');
      return { sessionId: 'retry-session', status: 'started' as const };
    };
    const options = { listTenants: async () => [target('acme')], triggerForTenant, ledger, now: () => now };
    await expect(dispatchTenantDailyReviews(options)).resolves.toMatchObject({ outcomes: [{ status: 'failed', reason: 'uncertain' }] });
    const held = await repo.read('acme') as { tenantReviewDispatches?: Array<{ state: string; uncertainAt?: string }> };
    expect(held.tenantReviewDispatches).toEqual([
      expect.objectContaining({ state: 'uncertain', uncertainAt: DAY.toISOString() }),
    ]);
    now = new Date(DAY.getTime() + 15 * 60 * 1_000 + 1);
    await expect(dispatchTenantDailyReviews(options)).resolves.toMatchObject({ outcomes: [{ status: 'in-progress' }] });
    expect(calls).toBe(1);
  });

  it('fences a durable starting record after a crash between provider start and completion', async () => {
    const repo = repository();
    const ledger = new StateRepositoryTenantReviewDispatchLedger(repo);
    const operationKey = 'common-skill-review:2026-09-16';
    const claim = await ledger.claim({
      organizationId: 'acme',
      operationKey,
      now: DAY,
      leaseMs: 5_000,
    });
    expect(claim.claimed).toBe(true);
    await expect(ledger.markStarting({
      organizationId: 'acme',
      operationKey,
      claimToken: claim.claimToken!,
      now: DAY,
    })).resolves.toBe(true);

    // Model the provider accepting the session immediately before the host
    // crashes, leaving the durable starting row without a completion write.
    let providerStarts = 1;
    let duplicateAttempts = 0;
    const afterCrash = new Date(DAY.getTime() + 10_000);
    const result = await dispatchTenantDailyReviews({
      listTenants: async () => [target('acme')],
      triggerForTenant: async () => async () => {
        duplicateAttempts += 1;
        providerStarts += 1;
        return { sessionId: 'duplicate', status: 'started' as const };
      },
      ledger,
      leaseMs: 5_000,
      maxDurationMs: 1_000,
      now: () => afterCrash,
    });

    expect(result.outcomes).toEqual([{
      organizationId: 'acme',
      operationKey,
      status: 'in-progress',
    }]);
    expect(duplicateAttempts).toBe(0);
    expect(providerStarts).toBe(1);
    const held = await repo.read('acme') as {
      tenantReviewDispatches?: Array<{ state: string; startingAt?: string; leaseExpiresAt?: string }>;
    };
    expect(held.tenantReviewDispatches).toEqual([
      expect.objectContaining({
        state: 'starting',
        startingAt: DAY.toISOString(),
        leaseExpiresAt: new Date(DAY.getTime() + 5_000).toISOString(),
      }),
    ]);
  });

  it('refreshes the lease clock and fences a provider that returns after its lease', async () => {
    const repo = repository();
    const ledger = new StateRepositoryTenantReviewDispatchLedger(repo);
    let now = DAY;
    let calls = 0;
    const result = await dispatchTenantDailyReviews({
      listTenants: async () => [target('acme')],
      triggerForTenant: async () => async () => {
        calls += 1;
        now = new Date(DAY.getTime() + 2_001);
        return { sessionId: 'late-session', status: 'started' as const };
      },
      ledger,
      leaseMs: 2_000,
      now: () => now,
    });
    expect(result.outcomes).toEqual([{
      organizationId: 'acme',
      operationKey: 'common-skill-review:2026-09-16',
      status: 'failed',
      reason: 'lease-lost',
      sessionId: 'late-session',
    }]);
    const held = await repo.read('acme') as { tenantReviewDispatches?: Array<{ state: string; sessionId?: string }> };
    expect(held.tenantReviewDispatches).toEqual([
      expect.objectContaining({ state: 'uncertain', sessionId: 'late-session' }),
    ]);
    now = new Date(DAY.getTime() + 20_000);
    await expect(dispatchTenantDailyReviews({
      listTenants: async () => [target('acme')],
      triggerForTenant: async () => async () => {
        calls += 1;
        return { sessionId: 'duplicate', status: 'started' as const };
      },
      ledger,
      leaseMs: 2_000,
      now: () => now,
    })).resolves.toMatchObject({ outcomes: [{ status: 'in-progress' }] });
    expect(calls).toBe(1);
  });

  it('persists the remaining page before the invocation budget expires', async () => {
    const repo = repository();
    const ledger = new StateRepositoryTenantReviewDispatchLedger(repo);
    let now = DAY;
    const calls: string[] = [];
    const options = {
      listTenants: async () => [target('acme'), target('globex'), target('initech')],
      triggerForTenant: async (organizationId: string) => async () => {
        calls.push(organizationId);
        if (organizationId === 'acme') now = new Date(DAY.getTime() + 1_001);
        return { sessionId: `eve-${organizationId}`, status: 'started' as const };
      },
      ledger,
      maxTenants: 3,
      maxDurationMs: 1_000,
      leaseMs: 5_000,
      now: () => now,
    };
    const first = await dispatchTenantDailyReviews(options);
    expect(first.started).toBe(1);
    expect(first.truncated).toBe(2);
    expect(calls).toEqual(['acme']);
    const cursor = await ledger.cursorStore.read({ day: '2026-09-16' });
    expect(cursor).toMatchObject({ pendingOrganizationIds: ['globex', 'initech'] });

    now = new Date(DAY.getTime() + 2_000);
    const second = await dispatchTenantDailyReviews(options);
    expect(second.started).toBe(2);
    expect(second.truncated).toBe(0);
    expect(calls).toEqual(['acme', 'globex', 'initech']);
  });

  it('times out a provider call before the host deadline and fences its reservation', async () => {
    const repo = repository();
    const ledger = new StateRepositoryTenantReviewDispatchLedger(repo);
    let calls = 0;
    const options = {
      listTenants: async () => [target('acme')],
      triggerForTenant: async () => async () => {
        calls += 1;
        return await new Promise<never>(() => undefined);
      },
      ledger,
      maxDurationMs: 500,
      leaseMs: 5_000,
      now: () => DAY,
    };
    await expect(dispatchTenantDailyReviews(options)).resolves.toMatchObject({
      truncated: 0,
      outcomes: [{ organizationId: 'acme', status: 'failed', reason: 'uncertain' }],
    });
    await expect(dispatchTenantDailyReviews(options)).resolves.toMatchObject({
      outcomes: [{ organizationId: 'acme', status: 'in-progress' }],
    });
    expect(calls).toBe(1);
  });

  it('bounds target fan-out and requires the exact cron bearer', async () => {
    const repo = repository();
    const ledger = new StateRepositoryTenantReviewDispatchLedger(repo);
    let calls = 0;
    const dispatch = () => dispatchTenantDailyReviews({
      listTenants: async () => [target('zeta'), target('beta'), target('alpha')],
      triggerForTenant: async () => async () => {
        calls += 1;
        return { sessionId: `session-${calls}`, status: 'started' };
      },
      ledger,
      maxTenants: 2,
      now: () => DAY,
    });
    const handler = createTenantReviewCronHandler({ dispatch, cronSecret: 'cron-secret-for-test' });
    const path = 'https://registry.example.test/internal/reviewer/dispatch';
    await expect(handler(new Request(path))).resolves.toMatchObject({ status: 401 });
    await expect(handler(new Request(path, { headers: { authorization: 'Bearer wrong' } }))).resolves.toMatchObject({ status: 401 });
    const response = await handler(new Request(path, { headers: { authorization: 'Bearer cron-secret-for-test' } }));
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({ attempted: 2, started: 2, truncated: 1 });
    expect(calls).toBe(2);
  });

  it('advances a durable cursor so a later bounded invocation reaches every company', async () => {
    const repo = repository();
    const ledger = new StateRepositoryTenantReviewDispatchLedger(repo);
    const calls: string[] = [];
    const options = {
      listTenants: async () => [target('company-04'), target('company-02'), target('company-01'), target('company-03'), target('company-05')],
      triggerForTenant: async (organizationId: string) => async () => {
        calls.push(organizationId);
        return { sessionId: `eve-${organizationId}`, status: 'started' as const };
      },
      ledger,
      maxTenants: 2,
      now: () => DAY,
    };

    const pages = [
      await dispatchTenantDailyReviews(options),
      await dispatchTenantDailyReviews(options),
      await dispatchTenantDailyReviews(options),
    ];
    expect(pages.map((page) => page.outcomes.map((outcome) => outcome.organizationId))).toEqual([
      ['company-01', 'company-02'],
      ['company-03', 'company-04'],
      ['company-05'],
    ]);
    expect(pages.map((page) => page.truncated)).toEqual([3, 1, 0]);
    expect(calls).toEqual(['company-01', 'company-02', 'company-03', 'company-04', 'company-05']);

    const persistedCursor = await repo.read('__private_skills_tenant_review_dispatch__') as { tenantReviewDispatchCursor?: { pendingOrganizationIds: string[]; completedOrganizationIds: string[] } };
    expect(persistedCursor.tenantReviewDispatchCursor).toMatchObject({ pendingOrganizationIds: [], completedOrganizationIds: ['company-01', 'company-02', 'company-03', 'company-04', 'company-05'] });
    await expect(dispatchTenantDailyReviews(options)).resolves.toMatchObject({ attempted: 0, started: 0 });
    expect(calls).toHaveLength(5);
  });

  it('enumerates Better Auth organizations from a trusted pool with an explicit bound', async () => {
    const queries: Array<{ text: string; parameters?: readonly unknown[] }> = [];
    const listTenants = createPostgresTenantReviewTargetLister({
      async query(text, parameters) {
        queries.push({ text, parameters });
        return { rows: [{ id: 'acme' }, { id: 'globex' }] } as never;
      },
    }, { schemaName: 'auth', isProvisioned: (organizationId) => organizationId === 'acme' });
    await expect(listTenants()).resolves.toEqual([
      { organizationId: 'acme', provisioned: true },
      { organizationId: 'globex', provisioned: false },
    ]);
    expect(queries).toEqual([{ text: 'SELECT "id" FROM "auth"."organization" ORDER BY "id" ASC LIMIT $1', parameters: [4097] }]);
  });

  it('shares a keyset organization page with the hosted worker dispatcher', async () => {
    const queries: Array<{ text: string; parameters?: readonly unknown[] }> = [];
    const listTenants = createPostgresTenantReviewTargetLister({
      async query(text, parameters) {
        queries.push({ text, parameters });
        return { rows: [{ id: 'company-03' }, { id: 'company-04' }] } as never;
      },
    }, { schemaName: 'auth' });
    await expect(listTenants.listOrganizations({ after: 'company-02', limit: 2 })).resolves.toEqual(['company-03', 'company-04']);
    expect(queries).toEqual([{
      text: 'SELECT "id" FROM "auth"."organization" WHERE ($1::text IS NULL OR "id" > $1) ORDER BY "id" ASC LIMIT $2',
      parameters: ['company-02', 2],
    }]);
  });

  it('does not compose a cron route without the host-owned cron secret', () => {
    const repo = repository();
    const runtime = createTenantReviewRuntime({
      env: { PSKILLS_AI_ENABLED: 'true' },
      repository: repo,
      billing: { status: () => ({ enabled: true }), reserveUsage: async () => ({}), reconcileUsage: async () => ({}), findUsageOperation: async () => undefined },
      eveTenant: {} as never,
      listTenants: async () => [],
    });
    expect(runtime).toBeUndefined();
  });

  it('composes the host route with tenant delegation and reserves before the Eve session request', async () => {
    const repo = repository();
    const calls: string[] = [];
    const billing = {
      status: () => ({ enabled: true }),
      reserveUsage: async (organizationId: string, delta: unknown, operationKey: string) => {
        calls.push(`reserve:${organizationId}:${JSON.stringify(delta)}`);
        return { operationKey };
      },
      reconcileUsage: async (organizationId: string, _reservationKey: string, actual: { eveCostCents: number }) => {
        calls.push(`reconcile:${organizationId}:${actual.eveCostCents}`);
        return {};
      },
      findUsageOperation: async () => undefined,
    };
    const eveTenant = {
      providerFor: () => ({
        tenantId: 'acme',
        service: 'consolidation-reviewer' as const,
        headers: async () => new Headers({ authorization: 'Bearer tenant-delegation' }),
      }),
    } as never;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      calls.push('eve-session');
      return new Response(JSON.stringify({ sessionId: 'eve-acme' }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const handler = createTenantReviewRuntime({
        env: {
          CRON_SECRET: 'cron-secret',
          PSKILLS_AI_ENABLED: 'true',
          PSKILLS_REVIEWER_URL: 'http://127.0.0.1:5397',
          PSKILLS_ENVIRONMENT: 'test',
        },
        repository: repo,
        billing,
        eveTenant,
        listTenants: async () => [target('acme')],
        now: () => DAY,
      });
      const response = await handler!(new Request('https://registry.example.test/internal/reviewer/dispatch', { headers: { authorization: 'Bearer cron-secret' } }));
      expect(response?.status).toBe(200);
      await expect(response?.json()).resolves.toMatchObject({ started: 1, outcomes: [{ organizationId: 'acme', sessionId: 'eve-acme' }] });
      expect(calls).toEqual(['reserve:acme:{"eveCostCents":50}', 'eve-session', 'reconcile:acme:50']);
      const eveRequest = fetchMock.mock.calls[0]?.[0];
      expect(String(eveRequest)).toBe('http://127.0.0.1:5397/eve/v1/session');
      const eveInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
      expect(new Headers(eveInit?.headers).get('authorization')).toBe('Bearer tenant-delegation');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
