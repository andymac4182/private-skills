import { describe, expect, it } from 'vitest';

import {
  EveCostReservationError,
  runWithEveCostReservation,
  type EveTenantCostReservation,
} from '../src/eve-cost-reservation.js';
import { createBillingEveCostReservation } from '../../../apps/web/server/eve-cost-reservation.js';

function billingHarness(enabled = true) {
  const calls: Array<{ kind: string; organizationId?: string; reservationKey?: string; actual?: number; operationKey?: string; delta?: unknown }> = [];
  return {
    calls,
    status: () => ({ enabled }),
    async reserveUsage(organizationId: string, delta: unknown, operationKey: string) {
      calls.push({ kind: 'reserve', organizationId, delta, operationKey });
      return { operationKey };
    },
    async reconcileUsage(organizationId: string, reservationKey: string, actual: { eveCostCents: number }, operationKey: string) {
      calls.push({ kind: 'reconcile', organizationId, reservationKey, actual: actual.eveCostCents, operationKey });
      return { operationKey };
    },
  };
}

describe('billing-backed Eve cost reservations', () => {
  it('reserves only the tenant Eve budget before settling measured cost', async () => {
    const billing = billingHarness();
    const adapter = createBillingEveCostReservation(billing, { estimateCents: 40 });

    const held = await adapter.reserve({
      tenantId: 'acme',
      service: 'consolidation-reviewer',
      operation: 'daily-review',
      idempotencyKey: 'common-skill-review:2026-09-16',
    });
    await adapter.settle({ reservationId: held.reservationId, actualCostCents: 17 });

    expect(billing.calls).toHaveLength(2);
    expect(billing.calls[0]).toMatchObject({ kind: 'reserve', organizationId: 'acme', delta: { eveCostCents: 40 } });
    expect(billing.calls[1]).toMatchObject({ kind: 'reconcile', organizationId: 'acme', reservationKey: held.reservationId, actual: 17 });
    expect((billing.calls[0]?.operationKey ?? '')).toContain('acme');
    expect(billing.calls[0]?.operationKey).not.toBe(billing.calls[1]?.operationKey);
  });

  it('releases a failed session with an idempotent zero-cost correction', async () => {
    const billing = billingHarness();
    const adapter = createBillingEveCostReservation(billing);
    const held = await adapter.reserve({
      tenantId: 'globex',
      service: 'consolidation-reviewer',
      operation: 'daily-review',
      idempotencyKey: 'common-skill-review:2026-09-16',
    });

    await adapter.release({ reservationId: held.reservationId });
    await adapter.release({ reservationId: held.reservationId });
    expect(billing.calls.filter((call) => call.kind === 'reconcile')).toHaveLength(2);
    expect(billing.calls.slice(-1)[0]).toMatchObject({ organizationId: 'globex', actual: 0 });
    expect(billing.calls.slice(-2)[0]?.operationKey).toBe(billing.calls.slice(-1)[0]?.operationKey);
  });

  it('fails closed when billing is disabled and never invokes the admission call', async () => {
    const billing = billingHarness(false);
    const adapter = createBillingEveCostReservation(billing);

    await expect(adapter.reserve({
      tenantId: 'acme',
      service: 'consolidation-reviewer',
      operation: 'daily-review',
      idempotencyKey: 'common-skill-review:2026-09-16',
    })).rejects.toMatchObject({ code: 'BILLING_DISABLED', uncertain: false });
    expect(billing.calls).toEqual([]);
  });
});

describe('runWithEveCostReservation', () => {
  function fakeReservation(overrides: Partial<{
    reserve: EveTenantCostReservation['reserve'];
    settle: EveTenantCostReservation['settle'];
    release: EveTenantCostReservation['release'];
  }> = {}): EveTenantCostReservation {
    const calls: string[] = [];
    return {
      calls,
      reserve: overrides.reserve ?? (async () => { calls.push('reserve'); return { reservationId: 'reservation-a' }; }),
      settle: overrides.settle ?? (async () => { calls.push('settle'); }),
      release: overrides.release ?? (async () => { calls.push('release'); }),
    } as EveTenantCostReservation & { calls: string[] };
  }

  it('reserves before the action and settles after an accepted result', async () => {
    const reservation = fakeReservation();
    const calls = (reservation as EveTenantCostReservation & { calls: string[] }).calls;
    await expect(runWithEveCostReservation({
      reservation,
      tenantId: 'acme',
      service: 'consolidation-reviewer',
      operation: 'daily-review',
      idempotencyKey: 'review:2026-09-16',
      action: async () => { calls.push('action'); return 'ok'; },
    })).resolves.toBe('ok');
    expect(calls).toEqual(['reserve', 'action', 'settle']);
  });

  it('releases a definite provider rejection and retains an uncertain transport failure', async () => {
    const known = fakeReservation();
    const knownCalls = (known as EveTenantCostReservation & { calls: string[] }).calls;
    await expect(runWithEveCostReservation({
      reservation: known,
      tenantId: 'acme',
      service: 'consolidation-reviewer',
      operation: 'daily-review',
      idempotencyKey: 'review:known',
      action: async () => { throw { status: 400 }; },
    })).rejects.toMatchObject({ status: 400 });
    expect(knownCalls).toEqual(['reserve', 'release']);

    const uncertain = fakeReservation();
    const uncertainCalls = (uncertain as EveTenantCostReservation & { calls: string[] }).calls;
    await expect(runWithEveCostReservation({
      reservation: uncertain,
      tenantId: 'acme',
      service: 'consolidation-reviewer',
      operation: 'daily-review',
      idempotencyKey: 'review:uncertain',
      action: async () => { throw new TypeError('network'); },
    })).rejects.toMatchObject({ code: 'COST_RECONCILIATION_REQUIRED', uncertain: true, reservationId: 'reservation-a' });
    expect(uncertainCalls).toEqual(['reserve']);
  });

  it('retains a reservation when settlement fails after the provider accepted the session', async () => {
    const reservation = fakeReservation({ settle: async () => { throw new Error('billing timeout'); } });
    const calls = (reservation as EveTenantCostReservation & { calls: string[] }).calls;
    await expect(runWithEveCostReservation({
      reservation,
      tenantId: 'acme',
      service: 'consolidation-reviewer',
      operation: 'daily-review',
      idempotencyKey: 'review:settle',
      action: async () => { calls.push('action'); return 'session'; },
    })).rejects.toMatchObject({ code: 'COST_RECONCILIATION_REQUIRED', uncertain: true });
    expect(calls).toEqual(['reserve', 'action']);
  });
});
