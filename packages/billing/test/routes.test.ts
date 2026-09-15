import { describe, expect, it } from 'vitest';
import { BILLING_ROUTE_PATHS, BILLING_SEAT_RECOVERY_SCOPE, createBillingRoutes, createBillingSeatRecoveryRoutes } from '../../../apps/web/server/routes/billing.js';
import { BillingService, createMemoryBillingRepository, createPlanCatalog } from '../src/index.js';
import type { Principal } from '../../../packages/contracts/src/index.js';

const principal: Principal = { organizationId: 'org-route-recovery', subject: 'user-admin', roles: ['admin'] };
const ordinaryWorkerPrincipal = { organizationId: principal.organizationId, subject: 'ordinary-worker', roles: ['worker'], identity: 'worker', scopes: ['jobs:claim', 'jobs:artifact', 'jobs:complete'] } as Principal & { identity: 'worker'; scopes: string[] };
const operatorPrincipal = { organizationId: principal.organizationId, subject: 'billing-recovery-operator', roles: ['worker'], identity: 'worker', scopes: [BILLING_SEAT_RECOVERY_SCOPE] } as Principal & { identity: 'worker'; scopes: string[] };

function service(): BillingService {
  return new BillingService({
    repository: createMemoryBillingRepository({ now: () => Date.parse('2026-09-15T00:00:00.000Z') }),
    catalog: createPlanCatalog(),
    enabled: true,
    now: () => Date.parse('2026-09-15T00:00:00.000Z'),
  });
}

describe('company seat recovery routes', () => {
  it('does not expose seat recovery to an owner/admin company principal', async () => {
    const billing = service();
    await billing.reserveSeat(principal.organizationId, 'failed-member-hold', { subjectKey: true });
    const route = createBillingRoutes({
      service: billing,
      authenticate: async () => principal,
    });

    const response = await route(new Request(`https://private-skills.example${BILLING_ROUTE_PATHS.seatRecovery}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operationKey: 'failed-member-hold',
        proof: { kind: 'known-failure', reference: 'better-auth-create-member-err-1' },
      }),
    }));
    expect(response).toBeUndefined();
    await expect(billing.activeSeatReservations(principal.organizationId)).resolves.toHaveLength(1);
  });

  it('requires a server operator authenticator and derives the company from it', async () => {
    const billing = service();
    await billing.reserveSeat(principal.organizationId, 'failed-member-hold', { subjectKey: true });
    const route = createBillingSeatRecoveryRoutes({
      authorizeOperator: async () => ordinaryWorkerPrincipal,
      listReservations: (organizationId) => billing.activeSeatReservations(organizationId),
      recoverSeat: async (input) => billing.releaseSeatAfterFailure(input.organizationId, input.operationKey, input.proof),
    });
    const response = await route(new Request(`https://private-skills.example${BILLING_ROUTE_PATHS.seatRecovery}`, {
      method: 'POST',
      body: JSON.stringify({
        operationKey: 'failed-member-hold',
        subjectKind: 'member',
        subjectId: 'member-failed',
        proof: { kind: 'writer-terminated', reference: 'operator-proof-1' },
      }),
    }));
    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toMatchObject({ code: 'BILLING_FORBIDDEN' });
    await expect(billing.activeSeatReservations(principal.organizationId)).resolves.toHaveLength(1);
  });

  it('accepts only the dedicated recovery capability, even for a worker identity', async () => {
    const billing = service();
    await billing.reserveSeat(principal.organizationId, 'failed-member-hold', { subjectKey: true });
    let currentPrincipal: Principal = ordinaryWorkerPrincipal;
    const recoveredInputs: unknown[] = [];
    const route = createBillingSeatRecoveryRoutes({
      authorizeOperator: async () => currentPrincipal,
      listReservations: (organizationId) => billing.activeSeatReservations(organizationId),
      recoverSeat: async (input) => {
        recoveredInputs.push(input);
        return billing.releaseSeatAfterFailure(input.organizationId, input.operationKey, input.proof);
      },
    });
    const request = () => new Request(`https://private-skills.example${BILLING_ROUTE_PATHS.seatRecovery}`, {
      method: 'POST',
      body: JSON.stringify({
        operationKey: 'failed-member-hold',
        subjectKind: 'member',
        subjectId: 'member-failed',
        proof: { kind: 'writer-terminated', reference: 'operator-proof-1' },
      }),
    });

    const ordinaryWorkerResponse = await route(request());
    expect(ordinaryWorkerResponse?.status).toBe(403);
    expect(recoveredInputs).toEqual([]);

    currentPrincipal = operatorPrincipal;
    const operatorResponse = await route(request());
    expect(operatorResponse?.status).toBe(200);
    expect(recoveredInputs).toHaveLength(1);
  });

  it('passes only the operator-derived company to recovery and rejects tenant proof kinds', async () => {
    const billing = service();
    await billing.reserveSeat(principal.organizationId, 'failed-member-hold', { subjectKey: true });
    const recoveredInputs: unknown[] = [];
    const route = createBillingSeatRecoveryRoutes({
      authorizeOperator: async () => operatorPrincipal,
      listReservations: (organizationId) => billing.activeSeatReservations(organizationId),
      recoverSeat: async (input) => {
        recoveredInputs.push(input);
        return billing.releaseSeatAfterFailure(input.organizationId, input.operationKey, input.proof);
      },
    });

    const rejected = await route(new Request(`https://private-skills.example${BILLING_ROUTE_PATHS.seatRecovery}`, {
      method: 'POST',
      body: JSON.stringify({ operationKey: 'failed-member-hold', subjectKind: 'member', subjectId: 'member-failed', proof: { kind: 'known-failure', reference: 'tenant-proof' } }),
    }));
    expect(rejected?.status).toBe(400);
    expect(recoveredInputs).toEqual([]);

    await billing.reserveSeat(principal.organizationId, 'failed-member-hold', { subjectKey: true });
    const accepted = await route(new Request(`https://private-skills.example${BILLING_ROUTE_PATHS.seatRecovery}`, {
      method: 'POST',
      body: JSON.stringify({ operationKey: 'failed-member-hold', subjectKind: 'member', subjectId: 'member-failed', proof: { kind: 'writer-terminated', reference: 'operator-proof-2' } }),
    }));
    expect(accepted?.status).toBe(200);
    expect(recoveredInputs).toMatchObject([{
      organizationId: principal.organizationId,
      operationKey: 'failed-member-hold',
      subjectKind: 'member',
      subjectId: 'member-failed',
      proof: { kind: 'writer-terminated', reference: 'operator-proof-2' },
    }]);
  });
});
