import { describe, expect, it } from 'vitest';

import {
  createWorkerTenantCredentialProvider,
  issueWorkerTenantDelegation,
  verifyWorkerTenantDelegation,
  workerTenantDelegationIssuerOptionsFromEnv,
  type WorkerTenantDelegationIssuerOptions,
} from './src/identity.js';

const SECRET = 'tenant-worker-delegation-secret-0123456789abcdef';
const ISSUER = 'https://registry.example.test';
const NOW = 1_800_000_000_000;

const issuer: WorkerTenantDelegationIssuerOptions = {
  issuer: ISSUER,
  secret: SECRET,
  serviceIdentity: 'hosted-worker-service',
  now: () => NOW,
};

describe('tenant worker delegation', () => {
  it('issues and verifies an operation-scoped claim credential', async () => {
    const issued = await issueWorkerTenantDelegation(issuer, {
      tenantId: 'company-a',
      audience: 'worker-claim',
    });

    await expect(verifyWorkerTenantDelegation(issued.token, {
      ...issuer,
      expectedServiceIdentity: 'hosted-worker-service',
    }, {
      audience: 'worker-claim',
      tenantId: 'company-a',
    })).resolves.toMatchObject({
      iss: ISSUER,
      aud: 'worker-claim',
      tenantId: 'company-a',
      serviceIdentity: 'hosted-worker-service',
      iat: Math.floor(NOW / 1000),
      exp: Math.floor(NOW / 1000) + 60,
    });
  });

  it('binds artifact and completion credentials to the exact job and lease', async () => {
    const issued = await issueWorkerTenantDelegation(issuer, {
      tenantId: 'company-a',
      audience: 'worker-complete',
      jobId: 'job-a',
      leaseToken: 'lease-a',
    });

    await expect(verifyWorkerTenantDelegation(issued.token, { ...issuer, expectedServiceIdentity: 'hosted-worker-service' }, {
      audience: 'worker-complete',
      tenantId: 'company-a',
      jobId: 'job-a',
      leaseToken: 'lease-a',
    })).resolves.toMatchObject({ jobId: 'job-a', leaseToken: 'lease-a' });

    await expect(verifyWorkerTenantDelegation(issued.token, { ...issuer, expectedServiceIdentity: 'hosted-worker-service' }, {
      audience: 'worker-complete',
      tenantId: 'company-a',
      jobId: 'job-a',
      leaseToken: 'lease-b',
    })).rejects.toThrow('lease binding');
    await expect(verifyWorkerTenantDelegation(issued.token, { ...issuer, expectedServiceIdentity: 'hosted-worker-service' }, {
      audience: 'worker-artifact',
      tenantId: 'company-a',
      jobId: 'job-a',
      leaseToken: 'lease-a',
    })).rejects.toThrow('audience');
    await expect(verifyWorkerTenantDelegation(issued.token, { ...issuer, expectedServiceIdentity: 'hosted-worker-service' }, {
      audience: 'worker-complete',
      tenantId: 'company-b',
      jobId: 'job-a',
      leaseToken: 'lease-a',
    })).rejects.toThrow('tenant binding');
  });

  it('rejects a signature made with another platform secret or origin', async () => {
    const issued = await issueWorkerTenantDelegation(issuer, {
      tenantId: 'company-a',
      audience: 'worker-claim',
    });
    await expect(verifyWorkerTenantDelegation(issued.token, {
      issuer: ISSUER,
      secret: 'another-platform-secret-0123456789abcdef',
      expectedServiceIdentity: 'hosted-worker-service',
      now: () => NOW,
    }, { audience: 'worker-claim', tenantId: 'company-a' })).rejects.toThrow('signature');
    await expect(verifyWorkerTenantDelegation(issued.token, {
      issuer: 'https://another-registry.example.test',
      secret: SECRET,
      expectedServiceIdentity: 'hosted-worker-service',
      now: () => NOW,
    }, { audience: 'worker-claim', tenantId: 'company-a' })).rejects.toThrow('issuer');
  });

  it('rejects replay against a new lease and expired credentials', async () => {
    const issued = await issueWorkerTenantDelegation({ ...issuer, ttlSeconds: 1 }, {
      tenantId: 'company-a',
      audience: 'worker-complete',
      jobId: 'job-a',
      leaseToken: 'lease-a',
    });

    await expect(verifyWorkerTenantDelegation(issued.token, {
      ...issuer,
      expectedServiceIdentity: 'hosted-worker-service',
      now: () => NOW + 2_000,
    }, {
      audience: 'worker-complete',
      tenantId: 'company-a',
      jobId: 'job-a',
      leaseToken: 'lease-a',
      })).resolves.toBeDefined();
    await expect(verifyWorkerTenantDelegation(issued.token, {
      ...issuer,
      expectedServiceIdentity: 'hosted-worker-service',
      now: () => NOW + 32_000,
      clockSkewSeconds: 0,
    }, {
      audience: 'worker-complete',
      tenantId: 'company-a',
      jobId: 'job-a',
      leaseToken: 'lease-a',
    })).rejects.toThrow('expired');
    await expect(verifyWorkerTenantDelegation(issued.token, { ...issuer, expectedServiceIdentity: 'hosted-worker-service' }, {
      audience: 'worker-complete',
      tenantId: 'company-a',
      jobId: 'job-a',
      leaseToken: 'lease-b',
    })).rejects.toThrow('lease binding');
  });

  it('creates a fixed tenant provider that cannot be switched by a request', async () => {
    const provider = createWorkerTenantCredentialProvider({
      ...issuer,
      tenantId: 'company-a',
    });
    const credential = await provider.resolve({
      workerId: 'worker-a',
      tenantId: 'company-a',
      audience: 'worker-artifact',
      jobId: 'job-a',
      leaseToken: 'lease-a',
    });
    await expect(verifyWorkerTenantDelegation(credential.token!, { ...issuer, expectedServiceIdentity: 'hosted-worker-service' }, {
      audience: 'worker-artifact',
      tenantId: 'company-a',
      jobId: 'job-a',
      leaseToken: 'lease-a',
    })).resolves.toMatchObject({ serviceIdentity: 'hosted-worker-service' });
    await expect(provider.resolve({
      workerId: 'worker-a',
      tenantId: 'company-b',
      audience: 'worker-claim',
    })).rejects.toThrow('provider');
  });

  it('rejects malformed issuer and oversized lifetimes before issuing', async () => {
    await expect(issueWorkerTenantDelegation({ ...issuer, issuer: `${ISSUER}/internal` }, {
      tenantId: 'company-a', audience: 'worker-claim',
    })).rejects.toThrow('HTTP(S) origin');
    await expect(issueWorkerTenantDelegation(issuer, {
      tenantId: 'company-a', audience: 'worker-claim', ttlSeconds: 301,
    })).rejects.toThrow('ttl');
    await expect(issueWorkerTenantDelegation(issuer, {
      tenantId: 'company-a', audience: 'worker-complete', jobId: 'job-a',
    })).rejects.toThrow('job and lease');
  });

  it('keeps delegation secret configuration optional and separate from bootstrap tokens', () => {
    expect(workerTenantDelegationIssuerOptionsFromEnv({}, {
      issuer: ISSUER,
      serviceIdentity: 'hosted-worker-service',
    })).toBeUndefined();
    expect(workerTenantDelegationIssuerOptionsFromEnv({
      PSKILLS_WORKER_DELEGATION_SECRET: SECRET,
    }, {
      issuer: ISSUER,
      serviceIdentity: 'hosted-worker-service',
    })).toMatchObject({ issuer: ISSUER, serviceIdentity: 'hosted-worker-service', secret: SECRET });
    expect(() => workerTenantDelegationIssuerOptionsFromEnv({
      PSKILLS_WORKER_DELEGATION_SECRET: 'short',
    }, {
      issuer: ISSUER,
      serviceIdentity: 'hosted-worker-service',
    })).toThrow('32-1024 bytes');
  });
});
