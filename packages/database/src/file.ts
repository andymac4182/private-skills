/* eslint-disable import/no-nodejs-modules -- native I/O is isolated in this adapter. */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { RegistryState, StateRepository } from '../../contracts/src/index';
import {
  assertRegistryState,
  assertSynchronousResult,
  advanceStateRevision,
  cloneRegistryState,
  defaultRegistryState,
  OrganizationMutex,
  StateRepositoryError,
  type RepositoryFactory,
  type StateRepositoryConstructorOptions,
} from './state';

export interface FileStateRepositoryOptions extends StateRepositoryConstructorOptions {
  directory: string;
  initial?: Readonly<Record<string, RegistryState>>;
}

/** Durable local JSON state for one API owner. Workers should use HTTP. */
export class FileStateRepository implements StateRepository {
  private readonly directory: string;
  private readonly stateFactory: RepositoryFactory;
  private readonly mutex = new OrganizationMutex();
  private readonly pendingSeeds = new Map<string, Promise<void>>();

  constructor(directory: string);
  constructor(options: FileStateRepositoryOptions);
  constructor(directoryOrOptions: string | FileStateRepositoryOptions, legacyOptions: StateRepositoryConstructorOptions = {}) {
    const options: FileStateRepositoryOptions = typeof directoryOrOptions === 'string'
      ? { directory: directoryOrOptions, ...legacyOptions }
      : directoryOrOptions;
    this.directory = resolve(options.directory);
    this.stateFactory = options.stateFactory ?? (() => defaultRegistryState());
    for (const [organizationId, state] of Object.entries(options.initial ?? {})) {
      const copy = cloneRegistryState(state);
      assertRegistryState(copy);
      this.pendingSeeds.set(organizationId, this.writeAtomically(organizationId, copy));
    }
  }

  private statePath(organizationId: string): string {
    if (!organizationId || organizationId.includes('\0')) {
      throw new StateRepositoryError('INVALID_ORGANIZATION', 'Organization id is invalid');
    }
    const digest = createHash('sha256').update(organizationId, 'utf8').digest('hex');
    return join(this.directory, `state-${digest}.json`);
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try { await chmod(this.directory, 0o700); } catch { /* portable filesystem */ }
  }

  private async load(organizationId: string): Promise<RegistryState | undefined> {
    try {
      const text = await readFile(this.statePath(organizationId), 'utf8');
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch {
        throw new StateRepositoryError('CORRUPT_STATE', 'Persisted registry state is not valid JSON');
      }
      assertRegistryState(parsed);
      return cloneRegistryState(parsed);
    } catch (error) {
      if ((error as { code?: unknown } | undefined)?.code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async writeAtomically(organizationId: string, state: RegistryState): Promise<void> {
    await this.ensureDirectory();
    const destination = this.statePath(organizationId);
    const temporary = `${destination}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(state), 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, destination);
      try { await chmod(destination, 0o600); } catch { /* portable filesystem */ }
    } catch (error) {
      if (handle) { try { await handle.close(); } catch { /* preserve failure */ } }
      try { await rm(temporary, { force: true }); } catch { /* orphan cleanup is safe later */ }
      throw error;
    }
  }

  async read(organizationId: string): Promise<RegistryState> {
    return this.mutex.run(organizationId, async () => {
      await this.pendingSeeds.get(organizationId);
      const loaded = await this.load(organizationId);
      if (loaded) return cloneRegistryState(loaded);
      const created = cloneRegistryState(this.stateFactory(organizationId));
      assertRegistryState(created);
      await this.writeAtomically(organizationId, created);
      return cloneRegistryState(created);
    });
  }

  async transaction<T>(organizationId: string, update: (state: RegistryState) => T): Promise<T> {
    return this.mutex.run(organizationId, async () => {
      await this.pendingSeeds.get(organizationId);
      const loaded = await this.load(organizationId);
      const working = loaded ? cloneRegistryState(loaded) : cloneRegistryState(this.stateFactory(organizationId));
      assertRegistryState(working);
      const previousRevision = (working as RegistryState & { metadataRevision?: number }).metadataRevision ?? 0;
      const result = update(working);
      assertSynchronousResult(result);
      advanceStateRevision(working, previousRevision);
      assertRegistryState(working);
      await this.writeAtomically(organizationId, working);
      return result;
    });
  }

  async clear(organizationId: string): Promise<void> {
    await this.mutex.run(organizationId, async () => {
      await this.pendingSeeds.get(organizationId);
      try { await rm(this.statePath(organizationId), { force: true }); }
      catch { throw new StateRepositoryError('REMOVE_FAILED', 'Unable to remove local registry state'); }
      this.pendingSeeds.delete(organizationId);
    });
  }
}

export function createFileStateRepository(options: FileStateRepositoryOptions): FileStateRepository {
  return new FileStateRepository(options);
}

export const createDurableFileStateRepository = createFileStateRepository;
