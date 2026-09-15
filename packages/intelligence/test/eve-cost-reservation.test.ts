import { describe, expect, it } from 'vitest';

import {
  EveCostReservationError,
  runWithEveCostReservation,
  type EveTenantCostReservation,
} from '../src/eve-cost-reservation.js';
import { createBillingEveCostReservation } from '../../../apps/web/server/eve-cost-reservation.js';

function billingHarness(enabled = true) {
  const calls: Array<{ kind: string; organizationId?: string; reservationKey?: string; actual?: number; operationKey?: string; delta?: unknown; reservationGeneration?: number }> = [];
  const durableReservations = new Map<string, { organizationId: string; operationKey: string; delta: { eveCostCents: number }; reservationGeneration: number; status: 'reserved' | 'committed' | 'released' }>();
  return {
    calls,
    status: () => ({ enabled }),
    async reserveUsage(organizationId: string, delta: unknown, operationKey: string) {
      const existing = durableReservations.get(operationKey);
      const reservationGeneration = existing === undefined
        ? 1
        : existing.status === 'released' ? existing.reservationGeneration + 1 : existing.reservationGeneration;
      calls.push({ kind: 'reserve', organizationId, delta, operationKey, reservationGeneration });
      durableReservations.set(operationKey, {
        organizationId,
        operationKey,
        delta: delta as { eveCostCents: number },
        reservationGeneration,
        status: 'reserved',
      });
      return { operationKey, reservationGeneration };
    },
    async reconcileUsage(organizationId: string, reservationKey: string, actual: { eveCostCents: number }, operationKey: string, reservationGeneration?: number) {
      calls.push({ kind: 'reconcile', organizationId, reservationKey, actual: actual.eveCostCents, operationKey, reservationGeneration });
      const current = durableReservations.get(reservationKey);
      if (current && reservationGeneration !== undefined && current.reservationGeneration !== reservationGeneration) {
        throw Object.assign(new Error('stale reservation generation'), { status: 409 });
      }
      if (current) current.status = actual.eveCostCents === 0 ? 'released' : 'committed';
      return { operationKey, reservationGeneration: current?.reservationGeneration ?? reservationGeneration ?? 1 };
    },
    async findUsageOperation(operationKey: string) {
      return durableReservations.get(operationKey);
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
    await adapter.settle({ reservationId: held.reservationId, reservationGeneration: held.reservationGeneration, actualCostCents: 17 });

    expect(billing.calls).toHaveLength(2);
    expect(billing.calls[0]).toMatchObject({ kind: 'reserve', organizationId: 'acme', delta: { eveCostCents: 40 } });
    expect(billing.calls[1]).toMatchObject({ kind: 'reconcile', organizationId: 'acme', reservationKey: held.reservationId, actual: 17, reservationGeneration: 1 });
    expect((billing.calls[0]?.operationKey ?? '')).toContain('acme');
    expect(billing.calls[0]?.operationKey).not.toBe(billing.calls[1]?.operationKey);
  });

  it('recovers a durable reservation after adapter restart and in-memory eviction', async () => {
    const billing = billingHarness();
    const first = createBillingEveCostReservation(billing, { estimateCents: 40, maxInMemoryReservations: 1 });
    const held = await first.reserve({
      tenantId: 'acme',
      service: 'consolidation-reviewer',
      operation: 'daily-review',
      idempotencyKey: 'common-skill-review:2026-09-16',
    });
    await first.reserve({
      tenantId: 'globex',
      service: 'consolidation-reviewer',
      operation: 'daily-review',
      idempotencyKey: 'common-skill-review:2026-09-16',
    });

    const restarted = createBillingEveCostReservation(billing, { estimateCents: 40, maxInMemoryReservations: 1 });
    await expect(restarted.reconcile?.({
      reservationId: held.reservationId,
      reservationGeneration: held.reservationGeneration,
      actualCostCents: 17,
      operationKey: 'operator-reconcile-acme',
    })).resolves.toBeUndefined();
    expect(billing.calls.at(-1)).toMatchObject({
      kind: 'reconcile',
      organizationId: 'acme',
      reservationKey: held.reservationId,
      actual: 17,
      reservationGeneration: 1,
    });
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

    await adapter.release({ reservationId: held.reservationId, reservationGeneration: held.reservationGeneration });
    await adapter.release({ reservationId: held.reservationId, reservationGeneration: held.reservationGeneration });
    expect(billing.calls.filter((call) => call.kind === 'reconcile')).toHaveLength(2);
    expect(billing.calls.slice(-1)[0]).toMatchObject({ organizationId: 'globex', actual: 0 });
    expect(billing.calls.slice(-1)[0]?.reservationGeneration).toBe(1);
    expect(billing.calls.slice(-2)[0]?.operationKey).toBe(billing.calls.slice(-1)[0]?.operationKey);
  });

  it('fences a delayed callback from a reopened reservation lifecycle', async () => {
    const billing = billingHarness();
    const adapter = createBillingEveCostReservation(billing, { estimateCents: 40 });
    const first = await adapter.reserve({
      tenantId: 'acme',
      service: 'consolidation-reviewer',
      operation: 'daily-review',
      idempotencyKey: 'common-skill-review:2026-09-16',
    });

    await adapter.release({ reservationId: first.reservationId, reservationGeneration: first.reservationGeneration });
    const second = await adapter.reserve({
      tenantId: 'acme',
      service: 'consolidation-reviewer',
      operation: 'daily-review',
      idempotencyKey: 'common-skill-review:2026-09-16',
    });
    expect(second).toMatchObject({ reservationId: first.reservationId, reservationGeneration: 2 });

    // A fresh adapter must recover the current durable row without replacing
    // the callback's retained G1. Billing rejects that stale generation
    // without changing the active G2 lifecycle.
    const restarted = createBillingEveCostReservation(billing, { estimateCents: 40 });
    await expect(restarted.reconcile?.({
      reservationId: first.reservationId,
      reservationGeneration: first.reservationGeneration,
      actualCostCents: 7,
      operationKey: 'late-g1-callback',
    })).rejects.toMatchObject({ code: 'COST_RECONCILIATION_REQUIRED', reservationGeneration: 1 });
    expect(billing.calls.at(-1)).toMatchObject({ reservationGeneration: 1 });
    expect(billing.calls.at(-1)?.operationKey).not.toBe(billing.calls.at(-2)?.operationKey);

    await adapter.settle({ reservationId: second.reservationId, reservationGeneration: second.reservationGeneration, actualCostCents: 12 });
    expect(billing.calls.at(-1)).toMatchObject({ reservationGeneration: 2, actual: 12 });
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
      reserve: overrides.reserve ?? (async () => { calls.push('reserve'); return { reservationId: 'reservation-a', reservationGeneration: 1 }; }),
      settle: overrides.settle ?? (async ({ reservationGeneration }) => { calls.push(`settle:${reservationGeneration}`); }),
      release: overrides.release ?? (async ({ reservationGeneration }) => { calls.push(`release:${reservationGeneration}`); }),
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
    expect(calls).toEqual(['reserve', 'action', 'settle:1']);
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
    expect(knownCalls).toEqual(['reserve', 'release:1']);

    const uncertain = fakeReservation();
    const uncertainCalls = (uncertain as EveTenantCostReservation & { calls: string[] }).calls;
    await expect(runWithEveCostReservation({
      reservation: uncertain,
      tenantId: 'acme',
      service: 'consolidation-reviewer',
      operation: 'daily-review',
      idempotencyKey: 'review:uncertain',
      action: async () => { throw new TypeError('network'); },
    })).rejects.toMatchObject({ code: 'COST_RECONCILIATION_REQUIRED', uncertain: true, reservationId: 'reservation-a', reservationGeneration: 1 });
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
    })).rejects.toMatchObject({ code: 'COST_RECONCILIATION_REQUIRED', uncertain: true, reservationGeneration: 1 });
    expect(calls).toEqual(['reserve', 'action']);
  });
});
