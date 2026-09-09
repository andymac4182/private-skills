import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { WorkerRunner } from './src/worker.js';

function base64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

describe('worker API protocol', () => {
  it('claims, downloads, materializes, and completes a disabled-scanner job with fencing', async () => {
    const bundle = {
      format: 'pskills-bundle-v1' as const,
      files: [{ path: 'SKILL.md', content: base64('# fixture\n') }],
    };
    const bytes = new TextEncoder().encode(JSON.stringify(bundle));
    const artifactDigest = digest(bytes);
    const job = {
      id: 'job-scan-fixture',
      kind: 'scan' as const,
      organizationId: 'org-fixture',
      leaseToken: 'lease-fixture',
      artifactDigest,
      artifact: { digest: artifactDigest, size: bytes.byteLength },
      attempt: 1,
      policyRevision: 'policy-fixture',
      policy: {
        revision: 'policy-fixture',
        allowUnscanned: true,
        scanners: [
          { id: 'cisco-skill-scanner' as const, mode: 'disabled' as const, blockSeverities: ['high' as const, 'critical' as const], timeoutSeconds: 5 },
          { id: 'nvidia-skillspector' as const, mode: 'disabled' as const, blockSeverities: ['high' as const, 'critical' as const], timeoutSeconds: 5 },
          { id: 'skillsguard' as const, mode: 'disabled' as const, blockSeverities: ['high' as const, 'critical' as const], timeoutSeconds: 5 },
        ],
      },
    };
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let claimCount = 0;
    let completion: Record<string, unknown> | undefined;
    const hookStages: string[] = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/internal/jobs/claim')) {
        claimCount += 1;
        return Response.json({ job });
      }
      if (url.endsWith(`/internal/jobs/${job.id}/artifact`)) {
        return new Response(bytes, { status: 200, headers: { 'content-type': 'application/octet-stream', 'x-artifact-digest': artifactDigest } });
      }
      if (url.endsWith(`/internal/jobs/${job.id}/complete`)) {
        completion = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ operation: { id: job.id, state: 'completed' } });
      }
      return Response.json({ error: 'unexpected route' }, { status: 404 });
    };

    const result = await new WorkerRunner({
      baseUrl: 'https://registry.example.test',
      workerToken: 'worker-token-fixture',
      workerId: 'worker-fixture',
      fetch,
      stageHooks: [
        { id: 'local-ingest', stage: 'ingest.validate', mode: 'required', run: async (context) => { hookStages.push(context.stage); expect(context.artifactDigest).toBe(artifactDigest); return true; } },
        { id: 'local-evaluate', stage: 'artifact.evaluate', mode: 'advisory', run: async (context) => { hookStages.push(context.stage); expect(context.files[0]?.path).toBe('SKILL.md'); return true; } },
      ],
    }).runOnce();

    expect(result.claimed).toBe(true);
    expect(result.allow).toBe(true);
    expect(result.scannerResults).toHaveLength(0);
    expect(claimCount).toBe(1);
    const artifactHeaders = new Headers(calls[1]?.init?.headers);
    const completionHeaders = new Headers(calls[2]?.init?.headers);
    expect(artifactHeaders.get('x-worker-fencing-token')).toBe('lease-fixture');
    expect(artifactHeaders.get('x-artifact-digest')).toBe(artifactDigest);
    expect(completionHeaders.get('x-worker-fencing-token')).toBe('lease-fixture');
    expect(completion?.fencingToken).toBe('lease-fixture');
    expect(completion?.leaseToken).toBe('lease-fixture');
    expect(hookStages).toEqual(['ingest.validate', 'artifact.evaluate']);
    const scanResults = completion?.scanResults as Array<Record<string, unknown>>;
    expect(scanResults).toHaveLength(0);
  });

  it('treats an explicit {job:null} claim as idle', async () => {
    const fetch = async (): Promise<Response> => Response.json({ job: null });
    const result = await new WorkerRunner({
      baseUrl: 'https://registry.example.test',
      workerToken: 'worker-token-fixture',
      workerId: 'worker-fixture',
      fetch,
    }).runOnce();
    expect(result).toEqual({ claimed: false });
  });
});
