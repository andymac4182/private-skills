import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { describe, expect, it } from 'vitest';

import { acquireImportJob } from '../src/acquisition.js';
import { WorkerRunner } from '../src/worker.js';
import type { WorkerClaimedJob } from '../src/client.js';
import type { ScannerAdapter, ScanResult as AdapterScanResult } from '../../../packages/scanners/src/types.js';
import { parseSkillMetadata } from '../../../packages/storage/src/index.js';
import { serializeSkillBundle } from '../../../packages/upstreams/src/index.js';

const SKILL = Buffer.from([
  '---',
  'name: demo',
  'description: Worker OpenClaw fixture',
  'metadata:',
  '  openclaw:',
  '    primaryEnv: DEMO_TOKEN',
  '    requires:',
  '      env:',
  '        - DEMO_TOKEN',
  '      bins:',
  '        - node',
  '---',
  '# Demo',
  '',
].join('\n'), 'utf8');

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
    let coreValidated = false;
    let fetchedSource: unknown;
    let recordedProof: Record<string, unknown> | undefined;
    const apiFetch = async (input: string | URL, init?: { body?: BodyInit | null }): Promise<Response> => {
      const url = new URL(input.toString());
      if (url.pathname === '/internal/jobs/claim') return jsonResponse({ job });
      if (url.pathname === '/internal/jobs/job-openclaw-1/complete') {
        completion = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        const canonicalBundle = completion.bundle;
        const metadata = parseSkillMetadata(canonicalBundle);
        expect(metadata.frontmatter.metadata).toMatchObject({
          openclaw: { requires: { env: ['DEMO_TOKEN'], bins: ['node'] } },
        });
        const scans = completion.scanResults;
        if (!Array.isArray(scans) || scans.length !== 1 || (scans[0] as Record<string, unknown>).status !== 'completed') {
          return jsonResponse({ error: 'required scan evidence missing' }, 422);
        }
        coreValidated = true;
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
    expect(coreValidated).toBe(true);
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

  it('rejects an expired queued feed before invoking the source fetcher', async () => {
    const sourceDigest = `sha256:${'b'.repeat(64)}`;
    const job: WorkerClaimedJob = {
      id: 'job-openclaw-expired',
      kind: 'import',
      organizationId: 'org-1',
      import: {
        upstreamId: 'openclaw-upstream',
        path: '@acme/demo',
        externalId: '@acme/demo',
        name: '@team/demo',
        version: '1.0.0',
      },
      upstream: {
        id: 'openclaw-upstream',
        organizationId: 'org-1',
        name: 'OpenClaw',
        kind: 'registry',
        enabled: true,
        namespace: 'team',
      },
      openclawSource: {
        source: {
          kind: 'public-clawhub',
          sourceRef: 'public-clawhub',
          packageName: '@acme/demo',
          version: '1.0.0',
          artifactDigest: sourceDigest,
        },
        feed: {
          id: 'clawhub-official-skills',
          sequence: 7,
          digest: `sha256:${'c'.repeat(64)}`,
          sourceUrl: 'https://clawhub.ai/api/v1/feeds/skills',
          generatedAt: '2030-01-01T00:00:00.000Z',
          expiresAt: '2030-01-02T00:00:00.000Z',
          compatibilityProfile: 'clawhub-live-skills-694ff719',
        },
      },
    };
    let fetches = 0;
    await expect(acquireImportJob(job, {
      openClaw: {
        allowedArtifactOrigins: ['https://clawhub.ai'],
        sourceProviderOrigin: 'https://clawhub.ai',
        now: () => Date.parse('2030-01-02T00:00:00.001Z'),
        fetcher: {
          fetch: async () => {
            fetches += 1;
            throw new Error('source fetch must not run');
          },
        },
      },
    })).rejects.toThrow('OpenClaw feed has expired');
    expect(fetches).toBe(0);
  });

  it('rechecks feed freshness after scanning before submitting a successful completion', async () => {
    const bundleBytes = serializeSkillBundle({
      format: 'pskills-bundle-v1',
      files: [{ path: 'SKILL.md', content: Buffer.from('---\nname: demo\ndescription: fixture\n---\n# Demo\n', 'utf8').toString('base64') }],
    });
    const sourceDigest = `sha256:${createHash('sha256').update(bundleBytes).digest('hex')}`;
    const feedNow = Date.parse('2030-01-01T00:00:00.000Z');
    const job: WorkerClaimedJob = {
      id: 'job-openclaw-expires-during-scan',
      kind: 'import',
      organizationId: 'org-1',
      leaseToken: 'lease-openclaw-expires-during-scan',
      attempt: 1,
      policyRevision: 'policy-1',
      policy: {
        revision: 'policy-1',
        scanners: [{ id: 'skillsguard', mode: 'required', blockSeverities: ['high', 'critical'], timeoutSeconds: 2 }],
        allowUnscanned: false,
      },
      upstream: {
        id: 'openclaw-upstream', organizationId: 'org-1', name: 'OpenClaw', kind: 'registry', enabled: true, namespace: 'team',
      },
      import: { upstreamId: 'openclaw-upstream', path: '@acme/demo', externalId: '@acme/demo', name: '@team/demo', version: '1.0.0' },
      openclawSource: {
        source: {
          kind: 'public-clawhub', sourceRef: 'public-clawhub', packageName: '@acme/demo', version: '1.0.0', artifactDigest: sourceDigest,
        },
        feed: {
          id: 'clawhub-official', sequence: 9, digest: `sha256:${'c'.repeat(64)}`,
          sourceUrl: 'https://feed.example/v1/feeds/skills',
          generatedAt: new Date(feedNow - 1_000).toISOString(),
          expiresAt: new Date(feedNow + 60 * 60 * 1_000).toISOString(),
        },
      },
    };
    let workerNow = feedNow;
    let sourceFetches = 0;
    let successfulCompletions = 0;
    let failedCompletion: Record<string, unknown> | undefined;
    const apiFetch = async (input: string | URL, init?: { body?: BodyInit | null }): Promise<Response> => {
      const url = new URL(input.toString());
      if (url.pathname === '/internal/jobs/claim') return jsonResponse({ job });
      if (url.pathname === '/internal/jobs/job-openclaw-expires-during-scan/complete') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        if (typeof body.error === 'string') failedCompletion = body;
        else successfulCompletions += 1;
        return jsonResponse({ operation: { ...job, state: 'failed' } });
      }
      return jsonResponse({ error: 'missing worker route' }, 404);
    };
    const adapter: ScannerAdapter = {
      id: 'skillsguard',
      command: 'fixture',
      metadata: { id: 'skillsguard', version: 'fixture', engineVersion: 'fixture', rulesRevision: 'fixture' },
      scan: async (request) => {
        workerNow = feedNow + 2 * 60 * 60 * 1_000;
        return {
          result: {
            schemaVersion: 1,
            organizationId: request.organizationId,
            jobId: request.jobId,
            invocationId: 'invocation-openclaw-expires-during-scan',
            artifactDigest: request.artifactDigest,
            policyRevision: request.policyRevision,
            adapter: { id: 'skillsguard', version: 'fixture', engineVersion: 'fixture', rulesRevision: 'fixture', configurationHash: `sha256:${'1'.repeat(64)}` },
            status: 'completed',
            durationMs: 1,
            coverage: { filesEnumerated: 1, filesAnalyzed: 1, filesSkipped: 0, filesUnsupported: 0, limitations: [], externalDestinations: [] },
            findings: [],
          },
        };
      },
    };
    const runner = new WorkerRunner({
      baseUrl: 'https://registry.example.test',
      workerToken: 'worker-token',
      workerId: 'worker-openclaw-expires-during-scan',
      fetch: apiFetch as typeof fetch,
      adapters: [adapter],
      executor: { run: async () => { throw new Error('executor should not be called'); } },
      acquisition: {
        openClaw: {
          allowedArtifactOrigins: ['https://artifacts.example.test'],
          sourceProviderOrigin: 'https://artifacts.example.test',
          now: () => workerNow,
          fetcher: {
            fetch: async () => {
              sourceFetches += 1;
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
    });

    const result = await runner.runOnce();
    expect(result.error).toBe('OpenClaw feed has expired');
    expect(sourceFetches).toBe(1);
    expect(successfulCompletions).toBe(0);
    expect(failedCompletion).toMatchObject({ error: 'OpenClaw feed has expired' });
  });
});
