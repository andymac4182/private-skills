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
  BlobStore,
  Principal,
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

  async put(bytes: Uint8Array): Promise<StoredBlob> {
    this.putCalls += 1;
    const copy = bytes.slice();
    return { key: `blob-${this.putCalls}`, digest: await digestBytes(copy), size: copy.byteLength };
  }

  async get(): Promise<Uint8Array> {
    throw new Error('no draft should have been stored');
  }

  async remove(): Promise<void> {
    return undefined;
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

function billing(): BillingService {
  return new BillingService({
    repository: createMemoryBillingRepository({ now: () => Date.parse('2026-09-15T00:00:00.000Z') }),
    catalog: createPlanCatalog({ plans: [{
      id: 'free',
      label: 'Free',
      description: 'Bounded test plan',
      limits: { seats: 3, storageBytes: 1, scansPerMonth: 1, eveCostCentsPerMonth: 10 },
      public: true,
    }] }),
    provider: provider(),
    enabled: true,
    now: () => Date.parse('2026-09-15T00:00:00.000Z'),
  });
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
});
