import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  createWorkerTenantCredentialProvider,
  verifyWorkerTenantDelegation,
} from './src/identity.js';
import { WorkerApiClient } from './src/client.js';

const SECRET = 'tenant-worker-client-secret-0123456789abcdef';
const ISSUER = 'https://registry.example.test';
const NOW = 1_800_000_000_000;

function digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function fixtureJob(organizationId: string, leaseToken = 'lease-a') {
  const bytes = new TextEncoder().encode('{"format":"pskills-bundle-v1","files":[]}');
  const artifactDigest = digest(bytes);
  return {
    id: 'job-a',
    kind: 'scan' as const,
    organizationId,
    leaseToken,
    artifactDigest,
    artifact: { digest: artifactDigest, size: bytes.byteLength },
    bytes,
  };
}

describe('tenant-aware worker API client', () => {
  it('uses fresh operation credentials and verifies the job organization before processing', async () => {
    const job = fixtureJob('company-a');
    const provider = createWorkerTenantCredentialProvider({
      issuer: ISSUER,
      secret: SECRET,
      serviceIdentity: 'hosted-worker-service',
      tenantId: 'company-a',
      now: () => NOW,
    });
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      calls.push({ url, headers: new Headers(init?.headers) });
      if (url.endsWith('/internal/jobs/claim')) return Response.json({ job });
      if (url.endsWith('/internal/jobs/job-a/artifact')) {
        return new Response(job.bytes, { headers: { 'content-type': 'application/octet-stream', 'x-artifact-digest': job.artifactDigest } });
      }
      if (url.endsWith('/internal/jobs/job-a/complete')) return Response.json({ operation: { id: job.id } });
      return Response.json({ error: 'unexpected route' }, { status: 404 });
    };
    const client = new WorkerApiClient({
      baseUrl: ISSUER,
      workerId: 'worker-a',
      tenantId: 'company-a',
      tenantCredentialProvider: provider,
      fetch,
    });

    const claimed = await client.claim();
    expect(claimed.job?.organizationId).toBe('company-a');
    await client.downloadArtifact(claimed.job!);
    await client.complete(claimed.job!, { scanResults: [] });

    expect(calls).toHaveLength(3);
    expect(calls.every(({ headers }) => headers.get('authorization')?.startsWith('Bearer ey'))).toBe(true);
    expect(calls.every(({ headers }) => headers.get('x-worker-service-identity') === 'hosted-worker-service')).toBe(true);
    expect(calls.map(({ headers }) => headers.get('x-worker-operation-audience'))).toEqual([
      'worker-claim', 'worker-artifact', 'worker-complete',
    ]);
    const claim = await verifyWorkerTenantDelegation(calls[0]!.headers.get('authorization')!.slice('Bearer '.length), {
      issuer: ISSUER,
      secret: SECRET,
      expectedServiceIdentity: 'hosted-worker-service',
      now: () => NOW,
    }, { audience: 'worker-claim', tenantId: 'company-a' });
    expect(claim.tenantId).toBe('company-a');
    const completion = await verifyWorkerTenantDelegation(calls[2]!.headers.get('authorization')!.slice('Bearer '.length), {
      issuer: ISSUER,
      secret: SECRET,
      expectedServiceIdentity: 'hosted-worker-service',
      now: () => NOW,
    }, { audience: 'worker-complete', tenantId: 'company-a', jobId: 'job-a', leaseToken: 'lease-a' });
    expect(completion.leaseToken).toBe('lease-a');
  });

  it('rejects a cross-company claim before any artifact or completion work', async () => {
    const foreignJob = fixtureJob('company-b');
    let calls = 0;
    const provider = createWorkerTenantCredentialProvider({
      issuer: ISSUER,
      secret: SECRET,
      serviceIdentity: 'hosted-worker-service',
      tenantId: 'company-a',
      now: () => NOW,
    });
    const client = new WorkerApiClient({
      baseUrl: ISSUER,
      workerId: 'worker-a',
      tenantId: 'company-a',
      tenantCredentialProvider: provider,
      fetch: async () => {
        calls += 1;
        return Response.json({ job: foreignJob });
      },
    });

    await expect(client.claim()).rejects.toThrow('organization does not match');
    expect(calls).toBe(1);
  });

  it('rejects a foreign job before asking the provider for a credential or fetching bytes', async () => {
    const foreignJob = fixtureJob('company-b');
    let providerCalls = 0;
    let fetchCalls = 0;
    const provider = {
      resolve: async () => {
        providerCalls += 1;
        throw new Error('provider must not be called for a foreign job');
      },
    };
    const client = new WorkerApiClient({
      baseUrl: ISSUER,
      workerId: 'worker-a',
      tenantId: 'company-a',
      tenantCredentialProvider: provider,
      fetch: async () => {
        fetchCalls += 1;
        return Response.json({ job: null });
      },
    });

    await expect(client.downloadArtifact(foreignJob)).rejects.toThrow('job organization');
    expect(providerCalls).toBe(0);
    expect(fetchCalls).toBe(0);
  });

  it('keeps completion lease metadata aligned with the signed lease binding', async () => {
    const job = fixtureJob('company-a');
    const provider = createWorkerTenantCredentialProvider({
      issuer: ISSUER,
      secret: SECRET,
      serviceIdentity: 'hosted-worker-service',
      tenantId: 'company-a',
      now: () => NOW,
    });
    let fetchCalls = 0;
    const client = new WorkerApiClient({
      baseUrl: ISSUER,
      workerId: 'worker-a',
      tenantId: 'company-a',
      tenantCredentialProvider: provider,
      fetch: async () => {
        fetchCalls += 1;
        return Response.json({ operation: { id: job.id } });
      },
    });

    await expect(client.complete(job, { leaseToken: 'lease-b' })).rejects.toThrow('lease metadata');
    expect(fetchCalls).toBe(0);
  });

  it('does not permit ambiguous or default-token tenant configuration', () => {
    const provider = createWorkerTenantCredentialProvider({
      issuer: ISSUER,
      secret: SECRET,
      serviceIdentity: 'hosted-worker-service',
      tenantId: 'company-a',
    });
    expect(() => new WorkerApiClient({
      baseUrl: ISSUER,
      workerId: 'worker-a',
      tenantId: 'company-a',
      workerToken: 'default-company-token',
      tenantCredentialProvider: provider,
    })).toThrow('mutually exclusive');
    expect(() => new WorkerApiClient({
      baseUrl: ISSUER,
      workerId: 'worker-a',
      tenantCredentialProvider: provider,
    })).toThrow('tenant id');
  });

  it('accepts a provider-owned Bearer authorization value without trusting arbitrary headers', async () => {
    const signed = await createWorkerTenantCredentialProvider({
      issuer: ISSUER,
      secret: SECRET,
      serviceIdentity: 'hosted-worker-service',
      tenantId: 'company-a',
      now: () => NOW,
    }).resolve({ workerId: 'worker-a', tenantId: 'company-a', audience: 'worker-claim' });
    let seen: Headers | undefined;
    const client = new WorkerApiClient({
      baseUrl: ISSUER,
      workerId: 'worker-a',
      tenantId: 'company-a',
      tenantCredentialProvider: {
        resolve: async () => ({
          ...signed,
          token: undefined,
          authorization: `Bearer ${signed.token}`,
        }),
      },
      fetch: async (_input, init) => {
        seen = new Headers(init?.headers);
        return Response.json({ job: null });
      },
    });
    await client.claim();
    expect(seen?.get('authorization')).toBe(`Bearer ${signed.token}`);
  });
});
