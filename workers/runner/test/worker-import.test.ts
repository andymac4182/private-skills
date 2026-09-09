import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { describe, expect, it } from 'vitest';

import { WorkerRunner } from '../src/worker.js';
import type { WorkerClaimedJob } from '../src/client.js';
import type { ScannerAdapter, ScanResult as AdapterScanResult } from '../../../packages/scanners/src/types.js';

const COMMIT = '0123456789012345678901234567890123456789';

function gitBlobSha(bytes: Uint8Array): string {
  return createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), Buffer.from(bytes)])).digest('hex');
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
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
    assert.deepEqual(completion.bundle, { format: 'pskills-bundle-v1', files: [{ path: 'SKILL.md', content: base64 }] });
  });
});
