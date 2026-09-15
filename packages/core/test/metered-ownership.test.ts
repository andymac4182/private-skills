import { describe, expect, it } from 'vitest';

import {
  claimMeteredReservationOwner,
  releaseMeteredUsageIfUnowned,
} from '../src/index.js';
import {
  cloneRegistryState,
  defaultRegistryState,
} from '../../database/src/index.js';
import type {
  BillingUsageAdmission,
  MeteredUsageDelta,
  RegistryState,
  StateRepository,
} from '../../contracts/src/index.js';

const ORGANIZATION = 'org-metered-ownership';
const RESERVATION_KEY = 'private-skills:scan:ownership-barrier';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
}

/** A repository that holds its organization lock while the updater is paused. */
class TransactionBarrierRepository implements StateRepository {
  private state: RegistryState;
  private tail = Promise.resolve();
  private pauseNext = true;
  private readonly entered = deferred();
  private readonly release = deferred();

  constructor(state: RegistryState) {
    this.state = cloneRegistryState(state);
  }

  async read(_organizationId: string): Promise<RegistryState> {
    return cloneRegistryState(this.state);
  }

  async transaction<T>(_organizationId: string, updater: (state: RegistryState) => T): Promise<T> {
    const previous = this.tail;
    let unlock!: () => void;
    const lock = new Promise<void>((resolve) => { unlock = resolve; });
    this.tail = previous.then(() => lock);
    await previous;
    try {
      const working = cloneRegistryState(this.state);
      const result = updater(working);
      if (this.pauseNext) {
        this.pauseNext = false;
        this.entered.resolve();
        await this.release.promise;
      }
      this.state = working;
      return result;
    } finally {
      unlock();
    }
  }

  firstTransactionEntered(): Promise<void> {
    return this.entered.promise;
  }

  releaseFirstTransaction(): void {
    this.release.resolve();
  }
}

class RecordingBilling implements BillingUsageAdmission {
  readonly reservations = new Set<string>();
  readonly reconciliations: Array<{ key: string; actual: MeteredUsageDelta }> = [];

  status(): { enabled: boolean } {
    return { enabled: true };
  }

  async reserveUsage(_organizationId: string, _delta: MeteredUsageDelta, key: string): Promise<unknown> {
    const idempotent = this.reservations.has(key);
    this.reservations.add(key);
    return { idempotent };
  }

  async reconcileUsage(
    _organizationId: string,
    key: string,
    actual: MeteredUsageDelta,
    _operationKey: string,
  ): Promise<unknown> {
    this.reconciliations.push({ key, actual });
    if (actual.scans === 0) this.reservations.delete(key);
    return {};
  }
}

describe('durable metered reservation ownership', () => {
  it('fences a queue transaction that races an atomic release decision', async () => {
    const repository = new TransactionBarrierRepository(defaultRegistryState({ production: false, allowUnscanned: true }));
    const billing = new RecordingBilling();
    await billing.reserveUsage(ORGANIZATION, { scans: 1 }, RESERVATION_KEY);

    const release = releaseMeteredUsageIfUnowned(
      repository,
      billing,
      ORGANIZATION,
      RESERVATION_KEY,
      { scans: 1 },
    );
    await repository.firstTransactionEntered();

    const queue = repository.transaction(ORGANIZATION, (state) => {
      claimMeteredReservationOwner(state, RESERVATION_KEY, false, 'job-racing');
      state.jobs.push({
        id: 'job-racing',
        organizationId: ORGANIZATION,
        kind: 'scan',
        state: 'queued',
        policyRevision: state.policy.revision,
        policy: state.policy,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attempts: 0,
      });
    });

    repository.releaseFirstTransaction();
    await expect(queue).rejects.toMatchObject({ code: 'METERED_RESERVATION_BUSY' });
    await release;

    expect(billing.reconciliations).toEqual([{
      key: RESERVATION_KEY,
      actual: { scans: 0 },
    }]);
    await expect(repository.read(ORGANIZATION)).resolves.toMatchObject({
      jobs: [],
      meteredReservationOwners: [{
        reservationKey: RESERVATION_KEY,
        state: 'released',
      }],
    });
  });
});
