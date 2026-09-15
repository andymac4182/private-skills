import { describe, expect, it } from 'vitest';

import {
  BillingService,
  createMemoryBillingRepository,
  createPlanCatalog,
  type BillingProvider,
} from '../../billing/src/index.js';
import { createMemoryStateRepository, defaultRegistryState } from '../../database/src/index.js';
import { digestBytes } from '../../storage/src/index.js';
import type {
  Authenticator,
  BillingUsageAdmission,
  BlobStore,
  MeteredUsageDelta,
  Principal,
  RegistryState,
  StateRepository,
  StoredBlob,
} from '../../contracts/src/index.js';
import { createDraftHandler } from '../src/drafts.js';
import type { AuthoringHandlerDependencies } from '../src/index.js';

const ORGANIZATION = 'org-authoring-billing';
const ORIGIN = 'https://registry.example.test';

function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

class CountingBlobs implements BlobStore {
  putCalls = 0;
  readonly values = new Map<string, Uint8Array>();

  async put(bytes: Uint8Array): Promise<StoredBlob> {
    this.putCalls += 1;
    const copy = bytes.slice();
    const key = `blob-${this.putCalls}`;
    this.values.set(key, copy);
    return { key, digest: await digestBytes(copy), size: copy.byteLength };
  }

  async get(key: string): Promise<Uint8Array> {
    const value = this.values.get(key);
    if (!value) throw new Error('missing blob');
    return value.slice();
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
}

class FailNextTransactionRepository implements StateRepository {
  failNext = false;

  constructor(private readonly inner: StateRepository) {}

  read(organizationId: string): Promise<RegistryState> {
    return this.inner.read(organizationId);
  }

  transaction<T>(organizationId: string, updater: (state: RegistryState) => T): Promise<T> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('simulated publication transaction outage'));
    }
    return this.inner.transaction(organizationId, updater);
  }
}

function provider(): BillingProvider {
  return {
    id: 'local',
    mode: 'test',
    async createCustomer(input) { return { provider: 'local', customerId: `cus_${input.organizationId}` }; },
    async createCheckoutSession(input) { return { provider: 'local', mode: 'test', id: input.idempotencyKey, url: 'http://localhost:5173/billing/test-checkout' }; },
    async createCustomerPortalSession(input) { return { provider: 'local', mode: 'test', id: input.idempotencyKey, url: 'http://localhost:5173/billing/test-portal' }; },
  };
}

function billing(limits: { storageBytes: number; scansPerMonth: number } = { storageBytes: 1, scansPerMonth: 1 }): BillingService {
  return new BillingService({
    repository: createMemoryBillingRepository({ now: () => Date.parse('2026-09-15T00:00:00.000Z') }),
    catalog: createPlanCatalog({ plans: [{
      id: 'free',
      label: 'Free',
      description: 'Bounded test plan',
      limits: { seats: 3, storageBytes: limits.storageBytes, scansPerMonth: limits.scansPerMonth, eveCostCentsPerMonth: 10 },
      public: true,
    }] }),
    provider: provider(),
    enabled: true,
    now: () => Date.parse('2026-09-15T00:00:00.000Z'),
  });
}

class RecordingGenerationBilling implements BillingUsageAdmission {
  readonly generations: Array<number | undefined> = [];

  constructor(private readonly inner: BillingService) {}

  status(): { enabled: boolean } {
    return { enabled: this.inner.status().enabled };
  }

  reserveUsage(organizationId: string, delta: MeteredUsageDelta, operationKey: string): Promise<unknown> {
    return this.inner.reserveUsage(organizationId, delta, operationKey);
  }

  async reconcileUsage(
    organizationId: string,
    reservationKey: string,
    actual: MeteredUsageDelta,
    operationKey: string,
    reservationGeneration?: number,
  ): Promise<unknown> {
    this.generations.push(reservationGeneration);
    return this.inner.reconcileUsage(organizationId, reservationKey, actual, operationKey, reservationGeneration);
  }
}

function publisher(): Principal {
  return {
    organizationId: ORGANIZATION,
    subject: 'publisher',
    roles: ['publisher'],
    namespaces: ['@team'],
    scopes: ['skills:publish', 'skills:read'],
  };
}

describe('authoring billing admission', () => {
  it('rejects upload draft storage before the blob write and draft transaction', async () => {
    const repository = createMemoryStateRepository({
      initial: { [ORGANIZATION]: defaultRegistryState({ production: false, allowUnscanned: true }) },
    });
    const blobs = new CountingBlobs();
    const service = billing();
    const auth: Authenticator = { authenticate: async () => publisher() };
    const deps: AuthoringHandlerDependencies = {
      repository,
      blobs,
      auth,
      billing: service,
      config: { organizationId: ORGANIZATION, maxBodyBytes: 1024 * 1024 },
      releaseAdmission: () => true,
    };
    const handler = createDraftHandler(deps);
    const response = await handler(new Request(`${ORIGIN}/v1/drafts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'draft-over-storage' },
      body: JSON.stringify({
        name: '@team/over-storage',
        files: [{ path: 'SKILL.md', content: base64('---\nname: over-storage\ndescription: fixture\n---\n# Fixture\n') }],
      }),
    }));

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { code: 'USAGE_LIMIT_EXCEEDED' } });
    expect(blobs.putCalls).toBe(0);
    const state = await repository.read(ORGANIZATION);
    expect(state.drafts ?? []).toHaveLength(0);
    await expect(service.usageSnapshot(ORGANIZATION)).resolves.toMatchObject({ usage: { storageBytes: 0 } });
  });

  it('forwards the exact reservation generation when a publication admission is released', async () => {
    const inner = createMemoryStateRepository({
      initial: { [ORGANIZATION]: defaultRegistryState({ production: false, allowUnscanned: true }) },
    });
    const repository = new FailNextTransactionRepository(inner);
    const blobs = new CountingBlobs();
    const recording = new RecordingGenerationBilling(billing({ storageBytes: 100_000, scansPerMonth: 1 }));
    const auth: Authenticator = { authenticate: async () => publisher() };
    const deps: AuthoringHandlerDependencies = {
      repository,
      blobs,
      auth,
      billing: recording,
      config: { organizationId: ORGANIZATION, maxBodyBytes: 1024 * 1024 },
      releaseAdmission: () => true,
    };
    const handler = createDraftHandler(deps);
    const created = await handler(new Request(`${ORIGIN}/v1/drafts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'generation-draft' },
      body: JSON.stringify({
        name: '@team/generation',
        files: [{ path: 'SKILL.md', content: base64('---\nname: generation\ndescription: fixture\n---\n# Fixture\n') }],
      }),
    }));
    expect(created.status).toBe(201);
    const draft = await created.json() as { draft: { id: string } };

    repository.failNext = true;
    const rejected = await handler(new Request(`${ORIGIN}/v1/drafts/${draft.draft.id}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'generation-publish' },
      body: JSON.stringify({ expectedRevision: 1, version: '1.0.0' }),
    }));
    expect(rejected.status).toBe(500);
    expect(recording.generations).toEqual([1]);
  });
});
