import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { TokenAuthenticator, type BootstrapTokenConfig } from '../../packages/auth/src/index.js';
import { createMemoryStateRepository, defaultRegistryState } from '../../packages/database/src/index.js';
import { createRegistryHandler, type RegistryHandler } from '../../packages/core/src/index.js';
import { SkillsDirectoryClient } from '../../packages/directory/src/index.js';
import { createNodeFilesSdkBlobStore } from '../../packages/storage/src/node.js';
import type {
  InstallAuthorization,
  Job,
  PackVersion,
  RegistryConfiguration,
  Resolution,
  ScanResult,
  SkillVersion,
  TransferDescriptor,
} from '../../packages/contracts/src/index.js';
import {
  bearer,
  bundleFor,
  createLocalRegistryHarness,
  jsonResponse,
  request,
  scannerResult,
} from './harness.js';

const ORIGIN = 'http://directory-security.test';

type FailureCase = {
  name: string;
  response?: Response;
  getToken?: () => Promise<string>;
  expectedRetryable: boolean;
  expectedFetches: number;
};

describe('directory HTTP security boundaries', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('maps bounded directory auth/rate/outage failures without exposing credentials', async () => {
    const upstreamCredential = 'directory-upstream-bearer-sentinel';
    const providerFailure = new Error(`provider failure ${upstreamCredential}`);
    const cases: FailureCase[] = [
      {
        name: '401 unauthorized',
        response: new Response(JSON.stringify({ message: upstreamCredential }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
        expectedRetryable: false,
        expectedFetches: 1,
      },
      {
        name: '429 rate limited',
        response: new Response(JSON.stringify({ message: upstreamCredential }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '999999' },
        }),
        expectedRetryable: true,
        expectedFetches: 1,
      },
      {
        name: '503 unavailable',
        response: new Response(JSON.stringify({ message: upstreamCredential }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
        expectedRetryable: true,
        expectedFetches: 1,
      },
      {
        name: 'malformed success body',
        response: new Response('{"data":', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
        expectedRetryable: false,
        expectedFetches: 1,
      },
      {
        name: 'credential provider absence',
        getToken: async () => {
          throw providerFailure;
        },
        expectedRetryable: true,
        expectedFetches: 0,
      },
    ];

    for (const failureCase of cases) {
      const fetch = vi.fn(async () => failureCase.response!);
      const directory = new SkillsDirectoryClient({
        fetch,
        getToken: failureCase.getToken ?? (async () => upstreamCredential),
        maxAttempts: 1,
        requestTimeoutMs: 100,
      });
      const harness = await createLocalRegistryHarness({ origin: ORIGIN, directory });
      cleanups.push(harness.close);

      const browserRequest = new Request(`${ORIGIN}/v1/directory/skills`, {
        headers: { authorization: `Bearer ${harness.token}`, 'sec-fetch-site': 'same-origin' },
      });
      expect(browserRequest.headers.get('authorization')).toBe(`Bearer ${harness.token}`);

      const logs: string[] = [];
      const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        logs.push(args.map((value) => String(value)).join(' '));
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        logs.push(args.map((value) => String(value)).join(' '));
      });
      try {
        const response = await harness.handler(browserRequest);
        const body = await response.text();
        const responseHeaders = [...response.headers.entries()].map(([key, value]) => `${key}: ${value}`).join('\n');

        expect(response.status, failureCase.name).toBe(503);
        expect(body, failureCase.name).toContain('DIRECTORY_UNAVAILABLE');
        expect(body, failureCase.name).not.toContain(upstreamCredential);
        expect(responseHeaders, failureCase.name).not.toContain(upstreamCredential);
        expect(logs.join('\n'), failureCase.name).not.toContain(upstreamCredential);
        expect(fetch, failureCase.name).toHaveBeenCalledTimes(failureCase.expectedFetches);
        const envelope = JSON.parse(body) as { error?: { code?: string; retryable?: boolean } };
        expect(envelope.error).toMatchObject({
          code: 'DIRECTORY_UNAVAILABLE',
          retryable: failureCase.expectedRetryable,
        });
      } finally {
        errorSpy.mockRestore();
        warnSpy.mockRestore();
      }
    }
  });

  it('keeps private operations and transfer capabilities isolated between tenants', async () => {
    const metadata = createMemoryStateRepository({
      stateFactory: () => defaultRegistryState({
        production: false,
        allowUnscanned: true,
        policyRevision: 'two-tenant-development',
      }),
    });
    const blobRoot = await mkdtemp(join(tmpdir(), 'private-skills-two-tenant-'));
    const blobs = await createNodeFilesSdkBlobStore({ provider: 'fs', root: blobRoot, prefix: 'private-registry' });
    cleanups.push(async () => rm(blobRoot, { recursive: true, force: true }));

    const tenantAToken = 'tenant-a-user-token';
    const tenantAWorkerToken = 'tenant-a-worker-token';
    const tenantBToken = 'tenant-b-user-token';
    const tenantAUser: BootstrapTokenConfig = {
      id: 'tenant-a-user',
      token: tenantAToken,
      organizationId: 'tenant-a',
      subject: 'tenant-a-user',
      roles: ['owner', 'admin', 'publisher', 'reader'],
      namespaces: ['@acme'],
      scopes: ['registry:*'],
    };
    const tenantAWorker: BootstrapTokenConfig = {
      id: 'tenant-a-worker',
      token: tenantAWorkerToken,
      organizationId: 'tenant-a',
      subject: 'tenant-a-worker',
      roles: ['worker'],
      kind: 'worker',
      worker: true,
      scopes: ['jobs:*'],
    };
    const tenantBUser: BootstrapTokenConfig = {
      id: 'tenant-b-user',
      token: tenantBToken,
      organizationId: 'tenant-b',
      subject: 'tenant-b-user',
      roles: ['owner', 'admin', 'publisher', 'reader'],
      namespaces: ['@acme'],
      scopes: ['registry:*'],
    };
    const authA = new TokenAuthenticator({
      environment: 'test',
      tokens: [tenantAUser],
      workerTokens: [tenantAWorker],
      sessionSecret: 'tenant-a-session-secret-that-is-long-enough',
      publicOrigin: ORIGIN,
      allowedOrigins: [ORIGIN],
    });
    const authB = new TokenAuthenticator({
      environment: 'test',
      tokens: [tenantBUser],
      sessionSecret: 'tenant-b-session-secret-that-is-long-enough',
      publicOrigin: ORIGIN,
      allowedOrigins: [ORIGIN],
    });
    await Promise.all([authA.ready(), authB.ready()]);

    const config = (organizationId: string): RegistryConfiguration => ({
      publicOrigin: ORIGIN,
      maxBodyBytes: 2 * 1024 * 1024,
      organizationId,
      leaseSeconds: 60,
    });
    const handlerA: RegistryHandler = createRegistryHandler({
      repository: metadata,
      blobs,
      auth: authA,
      config: config('tenant-a'),
    });
    const handlerB: RegistryHandler = createRegistryHandler({
      repository: metadata,
      blobs,
      auth: authB,
      config: config('tenant-b'),
    });
    const handlerAWithTenantBPrincipal: RegistryHandler = createRegistryHandler({
      repository: metadata,
      blobs,
      auth: authB,
      config: config('tenant-a'),
    });
    const userA = bearer(tenantAToken);
    const workerA = bearer(tenantAWorkerToken);

    const publish = await request(handlerA, ORIGIN, '/v1/publish', {
      method: 'POST',
      headers: userA,
      json: {
        name: '@acme/tenant-private',
        version: '1.0.0',
        description: 'Private tenant isolation fixture',
        bundle: bundleFor('tenant-private', 'Private tenant isolation fixture'),
      },
    });
    expect(publish.status).toBe(202);
    const queued = (await jsonResponse<{ operation: Job }>(publish)).operation;
    const claim = await request(handlerA, ORIGIN, '/internal/jobs/claim', { method: 'POST', headers: workerA });
    expect(claim.status).toBe(200);
    const claimed = (await jsonResponse<{ job: Job }>(claim)).job;
    expect(claimed.id).toBe(queued.id);
    const complete = await request(handlerA, ORIGIN, `/internal/jobs/${encodeURIComponent(queued.id)}/complete`, {
      method: 'POST',
      headers: workerA,
      json: {
        leaseToken: claimed.leaseToken,
        scanResults: [
          scannerResult(
            queued.artifact!.digest,
            queued.id,
            'cisco-skill-scanner',
            'completed',
            'tenant-a',
            'two-tenant-development',
          ),
        ],
      },
    });
    expect(complete.status).toBe(200);

    const skillResponse = await request(handlerA, ORIGIN, `/v1/skills/${encodeURIComponent(queued.resourceId!)}`, { headers: userA });
    expect(skillResponse.status).toBe(200);
    const skill = (await jsonResponse<{ skill: SkillVersion }>(skillResponse)).skill;
    expect(skill.state).toBe('approved');

    const tenantAScansResponse = await request(
      handlerA,
      ORIGIN,
      `/v1/scans?artifactDigest=${encodeURIComponent(skill.artifact.digest)}`,
      { headers: userA },
    );
    expect(tenantAScansResponse.status).toBe(200);
    const tenantAScans = (await jsonResponse<{ scans: ScanResult[] }>(tenantAScansResponse)).scans;
    expect(tenantAScans).toHaveLength(1);
    expect(tenantAScans[0]).toMatchObject({
      organizationId: 'tenant-a',
      artifactDigest: skill.artifact.digest,
      jobId: queued.id,
      scannerId: 'cisco-skill-scanner',
      status: 'completed',
    });

    const packResponse = await request(handlerA, ORIGIN, '/v1/packs', {
      method: 'POST',
      headers: userA,
      json: {
        name: '@acme/tenant-private-pack',
        version: '1.0.0',
        skills: [{ ref: skill.name, version: skill.version }],
      },
    });
    expect(packResponse.status).toBe(201);
    const pack = (await jsonResponse<{ pack: PackVersion }>(packResponse)).pack;

    const resolutionResponse = await request(handlerA, ORIGIN, '/v1/resolve', {
      method: 'POST',
      headers: userA,
      json: { kind: 'skill', ref: skill.name, version: skill.version },
    });
    expect(resolutionResponse.status).toBe(200);
    const resolution = (await jsonResponse<{ resolution: Resolution }>(resolutionResponse)).resolution;
    const authorizationResponse = await request(handlerA, ORIGIN, '/v1/install-authorizations', {
      method: 'POST',
      headers: userA,
      json: { resolution },
    });
    expect(authorizationResponse.status).toBe(201);
    const authorization = (await jsonResponse<{ authorization: InstallAuthorization }>(authorizationResponse)).authorization;
    const descriptorResponse = await request(handlerA, ORIGIN, `/v1/artifacts/${encodeURIComponent(skill.artifact.digest)}/download`, {
      method: 'POST',
      headers: userA,
      json: { resourceId: skill.id, authorizationId: authorization.id },
    });
    expect(descriptorResponse.status).toBe(200);
    const descriptor = await jsonResponse<TransferDescriptor>(descriptorResponse);
    const transferPath = new URL(descriptor.url).pathname;

    const foreignBoundaryPaths: Array<{ label: string; path: string; init?: RequestInit & { json?: unknown } }> = [
      { label: 'operation', path: `/v1/operations/${encodeURIComponent(queued.id)}` },
      { label: 'private detail', path: `/v1/skills/${encodeURIComponent(skill.id)}` },
      { label: 'private pack', path: `/v1/packs/${encodeURIComponent(pack.id)}` },
      { label: 'transfer grant', path: transferPath },
    ];
    for (const foreign of foreignBoundaryPaths) {
      const response = await request(handlerAWithTenantBPrincipal, ORIGIN, foreign.path, {
        ...foreign.init,
        headers: bearer(tenantBToken),
      });
      const body = await response.text();
      expect(response.status, foreign.label).toBe(403);
      expect(body, foreign.label).not.toContain(skill.artifact.digest);
      expect(body, foreign.label).not.toContain(queued.id);
    }

    const foreignDownload = await request(handlerAWithTenantBPrincipal, ORIGIN, `/v1/artifacts/${encodeURIComponent(skill.artifact.digest)}/download`, {
      method: 'POST',
      headers: bearer(tenantBToken),
      json: { resourceId: skill.id, authorizationId: authorization.id },
    });
    expect(foreignDownload.status).toBe(403);
    expect(await foreignDownload.text()).not.toContain(skill.artifact.digest);

    // Tenant-B must not mint a capability from tenant-A's resolution or
    // authorization. These requests remain metadata-only failures and must
    // never reach the filesystem blob store.
    const blobReads = vi.spyOn(blobs, 'get');
    try {
      const foreignAuthorization = await request(handlerB, ORIGIN, '/v1/install-authorizations', {
        method: 'POST',
        headers: bearer(tenantBToken),
        json: { resolution },
      });
      expect(foreignAuthorization.status).toBe(404);
      const foreignAuthorizationBody = await foreignAuthorization.text();
      expect(foreignAuthorizationBody).not.toContain(skill.artifact.digest);
      expect(foreignAuthorizationBody).not.toContain(queued.id);

      const foreignGrant = await request(
        handlerB,
        ORIGIN,
        `/v1/artifacts/${encodeURIComponent(skill.artifact.digest)}/download`,
        {
          method: 'POST',
          headers: bearer(tenantBToken),
          json: { resourceId: skill.id, authorizationId: authorization.id },
        },
      );
      expect(foreignGrant.status).toBe(404);
      const foreignGrantBody = await foreignGrant.text();
      expect(foreignGrantBody).not.toContain(skill.artifact.digest);
      expect(foreignGrantBody).not.toContain(queued.id);
      expect(blobReads).not.toHaveBeenCalled();
    } finally {
      blobReads.mockRestore();
    }

    // A valid tenant-B principal gets an empty tenant-B view for tenant-A IDs;
    // these reads must not turn an existence check into a cross-tenant leak.
    const isolatedReads: Array<{ label: string; path: string; status: number; emptyField?: 'operations' | 'scans' | 'events' }> = [
      { label: 'operation in tenant-B state', path: `/v1/operations/${encodeURIComponent(queued.id)}`, status: 404 },
      { label: 'scan in tenant-B state', path: `/v1/scans?artifactDigest=${encodeURIComponent(skill.artifact.digest)}`, status: 200, emptyField: 'scans' },
      { label: 'private detail in tenant-B state', path: `/v1/skills/${encodeURIComponent(skill.id)}`, status: 404 },
      { label: 'private pack in tenant-B state', path: `/v1/packs/${encodeURIComponent(pack.id)}`, status: 404 },
      { label: 'transfer in tenant-B state', path: transferPath, status: 404 },
      { label: 'audit in tenant-B state', path: '/v1/audit', status: 200, emptyField: 'events' },
    ];
    for (const read of isolatedReads) {
      const response = await request(handlerB, ORIGIN, read.path, { headers: bearer(tenantBToken) });
      const body = await response.text();
      expect(response.status, read.label).toBe(read.status);
      expect(body, read.label).not.toContain(skill.artifact.digest);
      expect(body, read.label).not.toContain(queued.id);
      if (read.emptyField) {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        expect(parsed[read.emptyField], read.label).toEqual([]);
      }
    }

    const tenantAState = await metadata.read('tenant-a');
    expect(tenantAState.skills).toHaveLength(1);
    expect(tenantAState.packs).toHaveLength(1);
    expect(tenantAState.scans).toHaveLength(1);
    expect(tenantAState.grants).toHaveLength(1);
    const tenantBState = await metadata.read('tenant-b');
    expect(tenantBState.skills).toHaveLength(0);
    expect(tenantBState.packs).toHaveLength(0);
    expect(tenantBState.jobs).toHaveLength(0);
    expect(tenantBState.grants).toHaveLength(0);
  });
});
