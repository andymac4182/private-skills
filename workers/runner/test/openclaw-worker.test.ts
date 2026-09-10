import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { describe, expect, it } from 'vitest';

import { WorkerRunner } from '../src/worker.js';
import type { WorkerClaimedJob } from '../src/client.js';
import type { ScannerAdapter, ScanResult as AdapterScanResult } from '../../../packages/scanners/src/types.js';
import { serializeSkillBundle } from '../../../packages/upstreams/src/index.js';

const SKILL = Buffer.from('---\nname: demo\ndescription: Worker OpenClaw fixture\n---\n# Demo\n', 'utf8');

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

describe('worker OpenClaw source acquisition', () => {
  it('resolves a server-owned source candidate before scanning and returns bound provenance', async () => {
    const bundleBytes = serializeSkillBundle({
      format: 'pskills-bundle-v1',
      files: [{ path: 'SKILL.md', content: SKILL.toString('base64') }],
    });
    const externalDigest = `sha256:${createHash('sha256').update(bundleBytes).digest('hex')}`;
    const source = {
      kind: 'public-clawhub' as const,
      sourceRef: 'public-clawhub' as const,
      packageName: '@acme/demo',
      version: '1.0.0',
      artifactDigest: externalDigest,
    };
    const job: WorkerClaimedJob = {
      id: 'job-openclaw-1',
      kind: 'import',
      organizationId: 'org-1',
      leaseToken: 'lease-openclaw-1',
      attempt: 1,
      policyRevision: 'policy-1',
      policy: {
        revision: 'policy-1',
        scanners: [{ id: 'skillsguard', mode: 'required', blockSeverities: ['high', 'critical'], timeoutSeconds: 2 }],
        allowUnscanned: false,
      },
      upstream: {
        id: 'openclaw-upstream', organizationId: 'org-1', name: 'OpenClaw', kind: 'registry', enabled: true,
        namespace: 'team',
      },
      import: {
        upstreamId: 'openclaw-upstream', path: '@acme/demo', externalId: '@acme/demo', name: '@team/demo', version: '1.0.0',
      },
      openclawSource: {
        source,
        entry: {
          type: 'skill',
          id: '@acme/demo',
          title: 'Demo',
          version: '1.0.0',
          state: 'available',
          publisher: { id: 'acme', trust: 'official' },
          install: { candidates: [{ sourceRef: 'public-clawhub', package: '@acme/demo', version: '1.0.0', integrity: externalDigest }] },
        },
      },
    };
    let completion: Record<string, unknown> | undefined;
    let fetchedSource: unknown;
    let recordedProof: Record<string, unknown> | undefined;
    const apiFetch = async (input: string | URL, init?: { body?: BodyInit | null }): Promise<Response> => {
      const url = new URL(input.toString());
      if (url.pathname === '/internal/jobs/claim') return jsonResponse({ job });
      if (url.pathname === '/internal/jobs/job-openclaw-1/complete') {
        completion = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return jsonResponse({ operation: { ...job, state: 'completed', resourceId: 'skill-openclaw-1' } });
      }
      return jsonResponse({ error: 'missing worker route' }, 404);
    };
    const adapterResult = (request: { organizationId: string; jobId: string; artifactDigest: `sha256:${string}`; policyRevision: string }): AdapterScanResult => ({
      schemaVersion: 1,
      organizationId: request.organizationId,
      jobId: request.jobId,
      invocationId: 'invocation-openclaw-1',
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
      baseUrl: 'https://registry.example.test', workerToken: 'worker-token', workerId: 'worker-openclaw-1', fetch: apiFetch as typeof fetch,
      adapters: [adapter], executor: { run: async () => { throw new Error('executor should not be called'); } },
      acquisition: {
        openClaw: {
          allowedArtifactOrigins: ['https://artifacts.example.test'],
          sourceProviderOrigin: 'https://artifacts.example.test',
          fetcher: {
            fetch: async (candidate) => {
              fetchedSource = candidate;
              return {
                bytes: bundleBytes,
                requestedUrl: 'https://artifacts.example.test/skills/demo.json',
                finalUrl: 'https://artifacts.example.test/skills/demo.json',
                status: 200,
                sourceProviderOrigin: 'https://artifacts.example.test',
                contentType: 'application/json',
              };
            },
          },
        },
      },
      openClawProofRecorder: {
        recordFromCompletion: async (input) => {
          recordedProof = input as unknown as Record<string, unknown>;
        },
      },
    });

    const result = await runner.runOnce();
    expect(result.allow).toBe(true);
    expect(fetchedSource).toEqual(source);
    assert.ok(completion);
    expect(completion.artifactDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(completion.provenance).toMatchObject({
      kind: 'registry',
      externalId: '@acme/demo',
      externalDigest,
      sourceResolutionKind: 'snapshot',
      sourceProviderOrigin: 'https://artifacts.example.test',
    });
    expect(recordedProof).toMatchObject({
      tenantId: 'org-1',
      completionJobId: 'job-openclaw-1',
      skillId: 'skill-openclaw-1',
      sourceArtifact: {
        verified: true,
        digest: externalDigest,
        format: 'clawhub-skill-v1',
        identity: '@acme/demo@1.0.0',
      },
    });
  });
});
