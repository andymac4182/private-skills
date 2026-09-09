import type { RegistryState, StateRepository } from '../../contracts/src/index';
import {
  assertRegistryState,
  assertSynchronousResult,
  advanceStateRevision,
  cloneRegistryState,
  defaultRegistryState,
  OrganizationMutex,
  type RepositoryFactory,
  type StateRepositoryConstructorOptions,
} from './state';

export interface MemoryStateRepositoryOptions extends StateRepositoryConstructorOptions {
  initial?: Readonly<Record<string, RegistryState>>;
}

/** In-memory repository for development/tests with per-organization rollback. */
export class MemoryStateRepository implements StateRepository {
  private readonly states = new Map<string, RegistryState>();
  private readonly mutex = new OrganizationMutex();
  private readonly stateFactory: RepositoryFactory;

  constructor(options: MemoryStateRepositoryOptions = {}) {
    this.stateFactory = options.stateFactory ?? (() => defaultRegistryState());
    for (const [organizationId, state] of Object.entries(options.initial ?? {})) {
      const copy = cloneRegistryState(state);
      assertRegistryState(copy);
      this.states.set(organizationId, copy);
    }
  }

  async read(organizationId: string): Promise<RegistryState> {
    return this.mutex.run(organizationId, () => {
      const current = this.states.get(organizationId);
      if (!current) {
        const created = cloneRegistryState(this.stateFactory(organizationId));
        assertRegistryState(created);
        this.states.set(organizationId, created);
        return cloneRegistryState(created);
      }
      return cloneRegistryState(current);
    });
  }

  async transaction<T>(organizationId: string, update: (state: RegistryState) => T): Promise<T> {
    return this.mutex.run(organizationId, () => {
      const committed = this.states.get(organizationId);
      const working = committed
        ? cloneRegistryState(committed)
        : cloneRegistryState(this.stateFactory(organizationId));
      assertRegistryState(working);
      const previousRevision = (working as RegistryState & { metadataRevision?: number }).metadataRevision ?? 0;
      const result = update(working);
      assertSynchronousResult(result);
      advanceStateRevision(working, previousRevision);
      assertRegistryState(working);
      this.states.set(organizationId, cloneRegistryState(working));
      return result;
    });
  }

  async clear(organizationId: string): Promise<void> {
    await this.mutex.run(organizationId, () => this.states.delete(organizationId));
  }
}

export function createMemoryStateRepository(options: MemoryStateRepositoryOptions = {}): MemoryStateRepository {
  return new MemoryStateRepository(options);
}

export const createMemoryRepository = createMemoryStateRepository;
