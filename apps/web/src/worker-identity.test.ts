import { describe, expect, it } from 'vitest';

import {
  issueWorkerTenantDelegation,
  WORKER_OPERATION_AUDIENCE_HEADER,
  WORKER_SERVICE_IDENTITY_HEADER,
  type WorkerTenantDelegationIssuerOptions,
} from '../../../workers/runner/src/identity.js';
import { createSignedWorkerAuthenticator, createSignedWorkerAuthenticatorFromEnv } from '../server/worker-identity.js';

const NOW = 1_700_000_000_000;
const issuerOptions: WorkerTenantDelegationIssuerOptions = {
  issuer: 'https://registry.example.test',
  secret: 's'.repeat(32),
  serviceIdentity: 'hosted-worker-service',
  now: () => NOW,
};

async function token(audience: 'worker-claim' | 'worker-artifact' | 'worker-complete', jobId?: string, leaseToken?: string): Promise<string> {
  return (await issueWorkerTenantDelegation(issuerOptions, {
    tenantId: 'tenant-b',
    audience,
    ...(jobId === undefined ? {} : { jobId }),
    ...(leaseToken === undefined ? {} : { leaseToken }),
  })).token;
}

function workerRequest(path: string, audience: string, bearer: string, extra: Record<string, string> = {}): Request {
  return new Request(`https://registry.example.test${path}`, {
    method: path.endsWith('/artifact') ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${bearer}`,
      [WORKER_SERVICE_IDENTITY_HEADER]: 'hosted-worker-service',
      [WORKER_OPERATION_AUDIENCE_HEADER]: audience,
      ...extra,
    },
  });
}

describe('signed worker tenant authentication', () => {
  it('authenticates claim, artifact, and complete with route bindings', async () => {
    const auth = createSignedWorkerAuthenticator({
      issuer: issuerOptions.issuer,
      secret: issuerOptions.secret,
      expectedServiceIdentity: issuerOptions.serviceIdentity,
      now: () => NOW,
    });
    const claim = await auth.authenticate(workerRequest('/internal/jobs/claim', 'worker-claim', await token('worker-claim')));
    expect(claim).toMatchObject({ organizationId: 'tenant-b', subject: 'hosted-worker-service', roles: ['worker'], identity: 'worker' });

    const artifactToken = await token('worker-artifact', 'job-1', 'lease-1');
    const artifact = await auth.authenticate(workerRequest('/internal/jobs/job-1/artifact', 'worker-artifact', artifactToken, { 'X-Worker-Fencing-Token': 'lease-1' }));
    expect(artifact).toMatchObject({ organizationId: 'tenant-b', roles: ['worker'], identity: 'worker' });

    const completeToken = await token('worker-complete', 'job-1', 'lease-1');
    const complete = await auth.authenticate(workerRequest('/internal/jobs/job-1/complete', 'worker-complete', completeToken, { 'X-Worker-Fencing-Token': 'lease-1' }));
    expect(complete).toMatchObject({ organizationId: 'tenant-b', roles: ['worker'], identity: 'worker' });
  });

  it('rejects wrong audience, service, lease, job, and encoded path identities', async () => {
    const auth = createSignedWorkerAuthenticator({
      issuer: issuerOptions.issuer,
      secret: issuerOptions.secret,
      expectedServiceIdentity: issuerOptions.serviceIdentity,
      now: () => NOW,
    });
    const artifactToken = await token('worker-artifact', 'job-1', 'lease-1');
    expect(await auth.authenticate(workerRequest('/internal/jobs/job-1/artifact', 'worker-complete', artifactToken, { 'X-Worker-Fencing-Token': 'lease-1' }))).toBeNull();
    expect(await auth.authenticate(workerRequest('/internal/jobs/job-1/artifact', 'worker-artifact', artifactToken, { 'X-Worker-Fencing-Token': 'lease-2' }))).toBeNull();
    expect(await auth.authenticate(workerRequest('/internal/jobs/job-2/artifact', 'worker-artifact', artifactToken, { 'X-Worker-Fencing-Token': 'lease-1' }))).toBeNull();
    expect(await auth.authenticate(workerRequest('/internal/jobs/job%2F1/artifact', 'worker-artifact', artifactToken, { 'X-Worker-Fencing-Token': 'lease-1' }))).toBeNull();
    const wrongService = new Request('https://registry.example.test/internal/jobs/claim', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await token('worker-claim')}`,
        [WORKER_SERVICE_IDENTITY_HEADER]: 'other-service',
        [WORKER_OPERATION_AUDIENCE_HEADER]: 'worker-claim',
      },
    });
    expect(await auth.authenticate(wrongService)).toBeNull();
  });

  it('does not enable signed workers when the delegation secret is absent', () => {
    expect(createSignedWorkerAuthenticatorFromEnv({ PSKILLS_PUBLIC_ORIGIN: 'https://registry.example.test' })).toBeUndefined();
  });
});
