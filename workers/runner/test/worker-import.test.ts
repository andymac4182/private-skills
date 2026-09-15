import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { describe, expect, it } from 'vitest';

import { WorkerRunner } from '../src/worker.js';
import type { WorkerClaimedJob } from '../src/client.js';
import type { ScannerAdapter, ScanResult as AdapterScanResult } from '../../../packages/scanners/src/types.js';
import type { BillingUsageAdmission } from '../../../packages/contracts/src/index.js';

const COMMIT = '0123456789012345678901234567890123456789';

function gitBlobSha(bytes: Uint8Array): string {
  return createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), Buffer.from(bytes)])).digest('hex');
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe('worker import acquisition', () => {
  it('acquires, scans, and completes an import with base64 bundle bytes and provenance', async () => {
    const skill = Buffer.from('# imported\n', 'utf8');
    const blobSha = gitBlobSha(skill);
    const base64 = skill.toString('base64');
    const upstreamFetch = async (input: string | URL): Promise<Response> => {
      const url = new URL(input.toString());
      if (url.pathname === '/api/repos/octo/repo/commits/main') return jsonResponse({ sha: COMMIT });
      if (url.pathname === `/api/repos/octo/repo/git/trees/${COMMIT}`) {
        return jsonResponse({ truncated: false, tree: [{ path: 'skills/demo/SKILL.md', type: 'blob', mode: '100644', sha: blobSha, size: skill.length }] });
      }
      if (url.pathname === `/api/repos/octo/repo/git/blobs/${blobSha}`) {
        return jsonResponse({ encoding: 'base64', content: skill.toString('base64'), size: skill.length, sha: blobSha });
      }
      return jsonResponse({ error: 'missing source route' }, 404);
    };

    const job: WorkerClaimedJob = {
      id: 'job-import-1',
      kind: 'import',
      organizationId: 'org-1',
      leaseToken: 'lease-1',
      attempt: 1,
      policyRevision: 'policy-1',
      policy: {
        revision: 'policy-1',
        scanners: [{ id: 'skillsguard', mode: 'required', blockSeverities: ['high', 'critical'], timeoutSeconds: 2 }],
        allowUnscanned: false,
      },
      upstream: {
        id: 'upstream-1', organizationId: 'org-1', name: 'fixture', kind: 'github', enabled: true,
        repositories: ['octo/repo'], baseUrl: 'http://127.0.0.1:1/api', namespace: 'team',
      },
      import: {
        upstreamId: 'upstream-1', repository: 'octo/repo', path: 'skills/demo', ref: 'main', name: '@team/demo', version: '1.0.0',
      },
    };
    let completion: Record<string, unknown> | undefined;
    const apiFetch = async (input: string | URL, init?: { body?: BodyInit | null }): Promise<Response> => {
      const url = new URL(input.toString());
      if (url.pathname === '/internal/jobs/claim') return jsonResponse({ job });
      if (url.pathname === '/internal/jobs/job-import-1/complete') {
        completion = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return jsonResponse({ operation: job });
      }
      return jsonResponse({ error: 'missing worker route' }, 404);
    };
    const adapterResult = (request: { organizationId: string; jobId: string; artifactDigest: `sha256:${string}`; policyRevision: string }): AdapterScanResult => ({
      schemaVersion: 1,
      organizationId: request.organizationId,
      jobId: request.jobId,
      invocationId: 'invocation-1',
      artifactDigest: request.artifactDigest,
      policyRevision: request.policyRevision,
      adapter: { id: 'skillsguard', version: 'fixture', engineVersion: 'fixture', rulesRevision: 'fixture', configurationHash: `sha256:${'1'.repeat(64)}` },
      status: 'completed',
      durationMs: 1,
      coverage: { filesEnumerated: 1, filesAnalyzed: 1, filesSkipped: 0, filesUnsupported: 0, limitations: [], externalDestinations: [] },
      findings: [],
    });
    const adapter: ScannerAdapter = {
      id: 'skillsguard',
      command: 'fixture',
      metadata: { id: 'skillsguard', version: 'fixture', engineVersion: 'fixture', rulesRevision: 'fixture' },
      scan: async (request) => ({ result: adapterResult(request) }),
    };
    const runner = new WorkerRunner({
      baseUrl: 'https://registry.example.test', workerToken: 'worker-token', workerId: 'worker-1', fetch: apiFetch as typeof fetch,
      adapters: [adapter], executor: { run: async () => { throw new Error('executor should not be called'); } },
      acquisition: { fetch: upstreamFetch, allowLoopbackForTests: true },
    });

    const result = await runner.runOnce();
    expect(result.claimed).toBe(true);
    expect(result.allow).toBe(true);
    assert.ok(completion);
    assert.equal(completion.artifactDigest, `sha256:${createHash('sha256').update(JSON.stringify({ format: 'pskills-bundle-v1', files: [{ path: 'SKILL.md', content: base64 }] })).digest('hex')}`);
    assert.deepEqual(completion.provenance && (completion.provenance as { kind?: string }).kind, 'github');
    assert.equal(completion.scanInvocationStarted, true);
    assert.deepEqual(completion.bundle, { format: 'pskills-bundle-v1', files: [{ path: 'SKILL.md', content: base64 }] });
  });

  it('reports a pre-scanner failure without performing an unsafe client-side release', async () => {
    const job: WorkerClaimedJob = {
      id: 'job-import-before-scan-failure',
      kind: 'import',
      organizationId: 'org-1',
      leaseToken: 'lease-1',
      attempt: 1,
      policyRevision: 'policy-1',
      policy: {
        revision: 'policy-1',
        scanners: [{ id: 'skillsguard', mode: 'required', blockSeverities: ['high', 'critical'], timeoutSeconds: 2 }],
        allowUnscanned: false,
      },
      upstream: {
        id: 'upstream-1', organizationId: 'org-1', name: 'fixture', kind: 'github', enabled: true,
        repositories: ['octo/repo'], baseUrl: 'http://127.0.0.1:1/api', namespace: 'team',
      },
      meteredReservationKey: 'private-skills:scan:queue-owner',
      import: {
        upstreamId: 'upstream-1', repository: 'octo/repo', path: 'skills/demo', ref: 'main', name: '@team/demo', version: '1.0.0',
      },
    };
    let completion: Record<string, unknown> | undefined;
    let scannerCalls = 0;
    let reservationKey: string | undefined;
    const reconciles: Array<{ reservationKey: string; actual: unknown; operationKey: string }> = [];
    const billing: BillingUsageAdmission = {
      status: () => ({ enabled: true }),
      reserveUsage: async (_organizationId, _delta, operationKey) => {
        reservationKey = operationKey;
        return { idempotent: false };
      },
      reconcileUsage: async (_organizationId, reservationKey, actual, operationKey) => {
        reconciles.push({ reservationKey, actual, operationKey });
      },
    };
    const apiFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input.toString());
      if (url.pathname === '/internal/jobs/claim') return jsonResponse({ job });
      if (url.pathname === `/internal/jobs/${job.id}/complete`) {
        completion = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return jsonResponse({ operation: job });
      }
      return jsonResponse({ error: 'unexpected worker route' }, 404);
    };
    const adapter: ScannerAdapter = {
      id: 'skillsguard',
      command: 'fixture',
      metadata: { id: 'skillsguard', version: 'fixture', engineVersion: 'fixture', rulesRevision: 'fixture' },
      scan: async () => {
        scannerCalls += 1;
        throw new Error('scanner should not run after acquisition failure');
      },
    };
    const runner = new WorkerRunner({
      baseUrl: 'https://registry.example.test', workerToken: 'worker-token', workerId: 'worker-before-scan',
      fetch: apiFetch, billing, adapters: [adapter],
      acquisition: { fetch: async () => jsonResponse({ error: 'source unavailable' }, 503), allowLoopbackForTests: true },
    });

    const result = await runner.runOnce();
    expect(result.error).toBeDefined();
    expect(scannerCalls).toBe(0);
    expect(reservationKey).toBe('private-skills:scan:queue-owner');
    expect(reconciles).toHaveLength(0);
    expect(completion?.scanInvocationStarted).toBe(false);
    expect(completion?.error).toBeDefined();
  });

  it('keeps a scan reservation when scanner invocation begins and then becomes uncertain', async () => {
    const artifact = new TextEncoder().encode(JSON.stringify({
      format: 'pskills-bundle-v1',
      files: [{ path: 'SKILL.md', content: base64('# scanner input\n') }],
    }));
    const artifactDigest = `sha256:${createHash('sha256').update(artifact).digest('hex')}`;
    const job: WorkerClaimedJob = {
      id: 'job-scan-uncertain',
      kind: 'scan',
      organizationId: 'org-1',
      leaseToken: 'lease-1',
      attempt: 1,
      artifactDigest,
      artifact: { key: 'artifact-1', digest: artifactDigest, size: artifact.byteLength },
      policyRevision: 'policy-1',
      policy: {
        revision: 'policy-1',
        scanners: [{ id: 'skillsguard', mode: 'required', blockSeverities: ['high', 'critical'], timeoutSeconds: 2 }],
        allowUnscanned: false,
      },
    };
    let completion: Record<string, unknown> | undefined;
    let scannerCalls = 0;
    const reconciles: unknown[] = [];
    const billing: BillingUsageAdmission = {
      status: () => ({ enabled: true }),
      reserveUsage: async () => ({ idempotent: false }),
      reconcileUsage: async (...args) => { reconciles.push(args); },
    };
    const apiFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input.toString());
      if (url.pathname === '/internal/jobs/claim') return jsonResponse({ job });
      if (url.pathname === `/internal/jobs/${job.id}/artifact`) {
        return new Response(artifact as BodyInit, {
          status: 200,
          headers: { 'content-type': 'application/octet-stream', 'content-length': String(artifact.byteLength), 'x-artifact-digest': artifactDigest },
        });
      }
      if (url.pathname === `/internal/jobs/${job.id}/complete`) {
        completion = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return jsonResponse({ operation: job });
      }
      return jsonResponse({ error: 'unexpected worker route' }, 404);
    };
    const adapter: ScannerAdapter = {
      id: 'skillsguard',
      command: 'fixture',
      metadata: { id: 'skillsguard', version: 'fixture', engineVersion: 'fixture', rulesRevision: 'fixture' },
      scan: async () => {
        scannerCalls += 1;
        throw new Error('scanner timed out after invocation');
      },
    };
    const runner = new WorkerRunner({
      baseUrl: 'https://registry.example.test', workerToken: 'worker-token', workerId: 'worker-uncertain',
      fetch: apiFetch, billing, adapters: [adapter], executor: { run: async () => { throw new Error('executor should not run'); } },
    });

    const result = await runner.runOnce();
    expect(result.error).toContain('scanner timed out');
    expect(scannerCalls).toBe(1);
    expect(reconciles).toHaveLength(0);
    expect(completion?.scanInvocationStarted).toBe(true);
    expect(completion?.error).toContain('scanner timed out');
  });

  it('rejects scan admission before import acquisition or scanner execution when the allowance is exhausted', async () => {
    const job: WorkerClaimedJob = {
      id: 'job-import-over-quota',
      kind: 'import',
      organizationId: 'org-1',
      leaseToken: 'lease-1',
      attempt: 1,
      import: {
        upstreamId: 'upstream-1',
        repository: 'octo/repo',
        path: 'skills/demo',
        ref: 'main',
        name: '@team/demo',
        version: '1.0.0',
      },
    };
    let acquisitionCalls = 0;
    let scannerCalls = 0;
    let reservationKey: string | undefined;
    let completion: Record<string, unknown> | undefined;
    const billing: BillingUsageAdmission = {
      status: () => ({ enabled: true }),
      reserveUsage: async (_organizationId, _delta, operationKey) => {
        reservationKey = operationKey;
        const error = new Error('scan allowance exhausted') as Error & { code: string; status: number };
        error.code = 'USAGE_LIMIT_EXCEEDED';
        error.status = 429;
        throw error;
      },
      reconcileUsage: async () => undefined,
    };
    const apiFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/internal/jobs/claim') return jsonResponse({ job });
      if (url.pathname === '/internal/jobs/job-import-over-quota/complete') {
        completion = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return jsonResponse({ operation: job });
      }
      return jsonResponse({ error: 'unexpected worker route' }, 404);
    };
    const upstreamFetch = async (): Promise<Response> => {
      acquisitionCalls += 1;
      return jsonResponse({ error: 'source should not be contacted' }, 500);
    };
    const adapter: ScannerAdapter = {
      id: 'skillsguard',
      command: 'fixture',
      metadata: { id: 'skillsguard', version: 'fixture', engineVersion: 'fixture', rulesRevision: 'fixture' },
      scan: async () => {
        scannerCalls += 1;
        throw new Error('scanner should not run');
      },
    };
    const runner = new WorkerRunner({
      baseUrl: 'https://registry.example.test',
      workerToken: 'worker-token',
      workerId: 'worker-over-quota',
      fetch: apiFetch,
      billing,
      adapters: [adapter],
      acquisition: { fetch: upstreamFetch, allowLoopbackForTests: true },
      executor: { run: async () => { throw new Error('executor should not be called'); } },
    });

    const result = await runner.runOnce();
    expect(result).toMatchObject({ claimed: true, jobId: job.id });
    expect(result.error).toContain('scan allowance exhausted');
    expect(reservationKey).toBe('private-skills:scan:job-import-over-quota');
    expect(acquisitionCalls).toBe(0);
    expect(scannerCalls).toBe(0);
    expect(completion?.scanInvocationStarted).toBe(false);
    expect(completion?.error).toContain('scan allowance exhausted');
  });
});
