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

/** A repository that commits the release fence, then loses the terminal commit. */
class FinalTransitionFailureRepository implements StateRepository {
  private state: RegistryState;
  private transactionCount = 0;
  private failTransaction = 2;

  constructor(state: RegistryState) {
    this.state = cloneRegistryState(state);
  }

  async read(_organizationId: string): Promise<RegistryState> {
    return cloneRegistryState(this.state);
  }

  async transaction<T>(_organizationId: string, updater: (state: RegistryState) => T): Promise<T> {
    this.transactionCount += 1;
    const working = cloneRegistryState(this.state);
    const result = updater(working);
    if (this.transactionCount === this.failTransaction) {
      this.failTransaction = -1;
      throw new Error('simulated process loss after external correction');
    }
    this.state = working;
    return result;
  }
}

class RecordingBilling implements BillingUsageAdmission {
  readonly reservations = new Set<string>();
  readonly reconciliations: Array<{ key: string; actual: MeteredUsageDelta }> = [];
  readonly reconciliationOperationKeys: string[] = [];

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
    operationKey: string,
  ): Promise<unknown> {
    this.reconciliations.push({ key, actual });
    this.reconciliationOperationKeys.push(operationKey);
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

  it('replays a committed release fence after the terminal transaction is lost', async () => {
    const repository = new FinalTransitionFailureRepository(defaultRegistryState({ production: false, allowUnscanned: true }));
    const billing = new RecordingBilling();
    await billing.reserveUsage(ORGANIZATION, { scans: 1 }, RESERVATION_KEY);

    await releaseMeteredUsageIfUnowned(
      repository,
      billing,
      ORGANIZATION,
      RESERVATION_KEY,
      { scans: 1 },
    );

    await expect(repository.read(ORGANIZATION)).resolves.toMatchObject({
      meteredReservationOwners: [{
        reservationKey: RESERVATION_KEY,
        state: 'releasing',
        releaseToken: expect.any(String),
      }],
    });
    await expect(repository.transaction(ORGANIZATION, (state) => {
      claimMeteredReservationOwner(state, RESERVATION_KEY, false, 'job-blocked');
    })).rejects.toMatchObject({ code: 'METERED_RESERVATION_BUSY' });

    await releaseMeteredUsageIfUnowned(
      repository,
      billing,
      ORGANIZATION,
      RESERVATION_KEY,
      { scans: 1 },
    );

    expect(billing.reconciliations).toHaveLength(2);
    expect(billing.reconciliationOperationKeys).toEqual([
      `${RESERVATION_KEY}:release`,
      `${RESERVATION_KEY}:release`,
    ]);
    await expect(repository.read(ORGANIZATION)).resolves.toMatchObject({
      meteredReservationOwners: [{
        reservationKey: RESERVATION_KEY,
        state: 'released',
      }],
    });
    await expect(repository.transaction(ORGANIZATION, (state) => {
      claimMeteredReservationOwner(state, RESERVATION_KEY, false, 'job-recovered');
    })).resolves.toBeUndefined();
  });
});
