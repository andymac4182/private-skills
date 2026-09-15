import { describe, expect, it } from 'vitest';

import { createMemoryStateRepository, defaultRegistryState } from '../../database/src/index.js';
import {
  BillingService,
  createMemoryBillingRepository,
  createPlanCatalog,
  type BillingProvider,
} from '../../billing/src/index.js';
import { digestBytes, encodeBundle } from '../../storage/src/index.js';
import type {
  Authenticator,
  BlobStore,
  Principal,
  RegistryState,
  SkillVersion,
  StoredBlob,
} from '../../contracts/src/index.js';
import { createRegistryHandler } from '../src/index.js';

const ORIGIN = 'https://registry.example.test';
const ORGANIZATION = 'org-billing-enforcement';

function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bundle(name = 'metered-demo') {
  return {
    format: 'pskills-bundle-v1' as const,
    files: [{
      path: 'SKILL.md',
      content: base64(`---\nname: ${name}\ndescription: Metered fixture\n---\n# ${name}\n`),
    }],
  };
}

class CountingBlobs implements BlobStore {
  putCalls = 0;
  readonly values = new Map<string, Uint8Array>();

  async put(bytes: Uint8Array): Promise<StoredBlob> {
    this.putCalls += 1;
    const copy = bytes.slice();
    const stored = { key: `blob-${this.putCalls}`, digest: await digestBytes(copy), size: copy.byteLength };
    this.values.set(stored.key, copy);
    return stored;
  }

  async get(key: string): Promise<Uint8Array> {
    const value = this.values.get(key);
    if (!value) throw new Error('blob not found');
    return value.slice();
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
}

function provider(): BillingProvider {
  return {
    id: 'local',
    mode: 'test',
    async createCustomer(input) {
      return { provider: 'local', customerId: `cus_${input.organizationId}` };
    },
    async createCheckoutSession(input) {
      return { provider: 'local', mode: 'test', id: input.idempotencyKey, url: 'http://localhost:5173/billing/test-checkout' };
    },
    async createCustomerPortalSession(input) {
      return { provider: 'local', mode: 'test', id: input.idempotencyKey, url: 'http://localhost:5173/billing/test-portal' };
    },
  };
}

function billing(limits: { storageBytes: number; scansPerMonth: number }): BillingService {
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

function principal(): Principal {
  return {
    organizationId: ORGANIZATION,
    subject: 'publisher',
    roles: ['admin', 'publisher', 'reader'],
    namespaces: ['@team'],
    scopes: ['skills:publish', 'skills:write', 'skills:read', 'registry:read', 'skills:rescan', 'upstreams:write', 'imports:create', 'proxy:resolve'],
  };
}

interface Fixture {
  repository: ReturnType<typeof createMemoryStateRepository>;
  blobs: CountingBlobs;
  handler: ReturnType<typeof createRegistryHandler>;
  billing: BillingService;
}

function fixture(limits: { storageBytes: number; scansPerMonth: number }): Fixture {
  const state = defaultRegistryState({ production: false, allowUnscanned: true });
  const repository = createMemoryStateRepository({ initial: { [ORGANIZATION]: state } });
  const blobs = new CountingBlobs();
  const billingService = billing(limits);
  const auth: Authenticator = { authenticate: async () => principal() };
  const handler = createRegistryHandler({
    repository,
    blobs,
    auth,
    billing: billingService,
    config: {
      publicOrigin: ORIGIN,
      maxBodyBytes: 1024 * 1024,
      organizationId: ORGANIZATION,
      leaseSeconds: 30,
    },
  });
  return { repository, blobs, handler, billing: billingService };
}

async function json(response: Response): Promise<Record<string, any>> {
  return response.json() as Promise<Record<string, any>>;
}

describe('runtime billing admission', () => {
  it('rejects an over-storage publish before writing a blob or queueing scanner work', async () => {
    const test = fixture({ storageBytes: 1, scansPerMonth: 1 });
    const response = await test.handler(new Request(`${ORIGIN}/v1/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '@team/metered-demo', version: '1.0.0', bundle: bundle() }),
    }));

    expect(response.status).toBe(429);
    expect((await json(response)).error).toMatchObject({ code: 'USAGE_LIMIT_EXCEEDED' });
    expect(test.blobs.putCalls).toBe(0);
    const state = await test.repository.read(ORGANIZATION);
    expect(state.skills).toHaveLength(0);
    expect(state.jobs).toHaveLength(0);
    await expect(test.billing.usageSnapshot(ORGANIZATION)).resolves.toMatchObject({
      usage: { storageBytes: 0, scans: 0 },
    });
  });

  it('uses the same scan reservation key at publish admission and worker retry', async () => {
    const test = fixture({ storageBytes: 100_000, scansPerMonth: 1 });
    const response = await test.handler(new Request(`${ORIGIN}/v1/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '@team/metered-demo', version: '1.0.0', bundle: bundle() }),
    }));
    expect(response.status).toBe(202);
    const operation = (await json(response)).operation as { id: string };

    await expect(test.billing.reserveUsage(
      ORGANIZATION,
      { scans: 1 },
      `private-skills:scan:${operation.id}`,
    )).resolves.toMatchObject({ idempotent: true });
    await expect(test.billing.usageSnapshot(ORGANIZATION)).resolves.toMatchObject({
      usage: { scans: 1 },
    });
  });

  it('rejects a rescan at admission without adding a job when the scan allowance is exhausted', async () => {
    const test = fixture({ storageBytes: 100_000, scansPerMonth: 1 });
    const bytes = encodeBundle(bundle('existing'));
    const artifact = await test.blobs.put(bytes);
    const state = await test.repository.read(ORGANIZATION);
    const skill: SkillVersion = {
      id: 'skill-existing',
      organizationId: ORGANIZATION,
      name: '@team/existing',
      skillName: 'existing',
      version: '1.0.0',
      description: 'Existing',
      artifact,
      state: 'approved',
      policyRevision: state.policy.revision,
      createdAt: new Date().toISOString(),
      approvedAt: new Date().toISOString(),
      provenance: { kind: 'native' },
      fileCount: 1,
      scanIds: [],
    };
    await test.repository.transaction(ORGANIZATION, (mutable) => {
      mutable.skills.push(skill);
    });
    await test.billing.reserveUsage(ORGANIZATION, { scans: 1 }, 'existing-scan');
    const putCalls = test.blobs.putCalls;

    const response = await test.handler(new Request(`${ORIGIN}/v1/skills/${skill.id}/rescan`, { method: 'POST' }));
    expect(response.status).toBe(429);
    expect((await json(response)).error).toMatchObject({ code: 'USAGE_LIMIT_EXCEEDED' });
    expect(test.blobs.putCalls).toBe(putCalls);
    const finalState = await test.repository.read(ORGANIZATION);
    expect(finalState.jobs).toHaveLength(0);
    expect(finalState.skills[0]?.state).toBe('approved');
  });

  it('rejects a source import before queueing work when the scan allowance is exhausted', async () => {
    const test = fixture({ storageBytes: 100_000, scansPerMonth: 1 });
    const upstreamResponse = await test.handler(new Request(`${ORIGIN}/v1/upstreams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'offline-source', kind: 'registry', namespace: '@team', baseUrl: 'https://offline.example' }),
    }));
    expect(upstreamResponse.status).toBe(201);
    const upstream = (await json(upstreamResponse)).upstream as { id: string };
    await test.billing.reserveUsage(ORGANIZATION, { scans: 1 }, 'existing-scan');

    const response = await test.handler(new Request(`${ORIGIN}/v1/imports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        upstreamId: upstream.id,
        path: 'skills/metered-demo',
        ref: 'main',
        name: '@team/metered-demo',
        version: '1.0.0',
      }),
    }));
    expect(response.status).toBe(429);
    expect((await json(response)).error).toMatchObject({ code: 'USAGE_LIMIT_EXCEEDED' });
    expect((await test.repository.read(ORGANIZATION)).jobs).toHaveLength(0);
  });
});
