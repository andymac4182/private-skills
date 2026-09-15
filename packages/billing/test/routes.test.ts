import { describe, expect, it } from 'vitest';
import { BILLING_ROUTE_PATHS, createBillingRoutes } from '../../../apps/web/server/routes/billing.js';
import { BillingService, createMemoryBillingRepository, createPlanCatalog } from '../src/index.js';
import type { Principal } from '../../../packages/contracts/src/index.js';

const principal: Principal = { organizationId: 'org-route-recovery', subject: 'user-admin', roles: ['admin'] };

function service(): BillingService {
  return new BillingService({
    repository: createMemoryBillingRepository({ now: () => Date.parse('2026-09-15T00:00:00.000Z') }),
    catalog: createPlanCatalog(),
    enabled: true,
    now: () => Date.parse('2026-09-15T00:00:00.000Z'),
  });
}

describe('company seat recovery routes', () => {
  it('lists and recovers a failed Better Auth hold from the server tenant', async () => {
    const billing = service();
    await billing.reserveSeat(principal.organizationId, 'failed-member-hold', { subjectKey: true });
    const route = createBillingRoutes({
      service: billing,
      authenticate: async () => principal,
    });

    const listed = await route(new Request(`https://private-skills.example${BILLING_ROUTE_PATHS.seatReservations}`));
    expect(listed?.status).toBe(200);
    await expect(listed?.json()).resolves.toMatchObject({
      reservations: [{ operationKey: 'failed-member-hold', status: 'active', subjectKey: true }],
    });

    const recovered = await route(new Request(`https://private-skills.example${BILLING_ROUTE_PATHS.seatRecovery}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org-attacker-supplied',
        operationKey: 'failed-member-hold',
        proof: { kind: 'known-failure', reference: 'better-auth-create-member-err-1' },
      }),
    }));
    expect(recovered?.status).toBe(200);
    await expect(recovered?.json()).resolves.toMatchObject({
      recovery: { reservation: { operationKey: 'failed-member-hold', status: 'settled', committed: false } },
    });
    await expect(billing.usageSnapshot(principal.organizationId)).resolves.toMatchObject({ usage: { seats: 0 } });
  });

  it('requires an owner or admin and derives the company from that principal', async () => {
    const billing = service();
    await billing.reserveSeat(principal.organizationId, 'failed-member-hold', { subjectKey: true });
    const route = createBillingRoutes({
      service: billing,
      authenticate: async () => ({ ...principal, roles: ['reader'] }),
    });
    const response = await route(new Request(`https://private-skills.example${BILLING_ROUTE_PATHS.seatRecovery}`, {
      method: 'POST',
      body: JSON.stringify({ operationKey: 'failed-member-hold', proof: { kind: 'known-failure', reference: 'operator-proof-1' } }),
    }));
    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toMatchObject({ code: 'BILLING_FORBIDDEN' });
    await expect(billing.activeSeatReservations(principal.organizationId)).resolves.toHaveLength(1);
  });
});
