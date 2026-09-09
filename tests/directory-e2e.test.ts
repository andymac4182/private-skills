import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RegistryDirectoryClient } from '../packages/core/src/index.js';
import type { Job, Policy, Resolution, SkillVersion, Upstream } from '../packages/contracts/src/index.js';
import type { ScannerAdapter } from '../packages/scanners/src/types.js';
import { WorkerRunner } from '../workers/runner/src/worker.js';
import { bearer, createLocalRegistryHarness, jsonResponse, request, type LocalRegistryHarness } from './e2e/harness.js';

const id = 'example/skills/greeting';
const snapshot = {
  id, source: 'example/skills', slug: 'greeting', installs: 10,
  hash: 'a'.repeat(64),
  files: [{ path: 'SKILL.md', contents: '---\nname: greeting\ndescription: A harmless greeting.\n---\n\nSay hello.\n' }],
};
const policy: Policy = {
  revision: 'directory-e2e-required', allowUnscanned: false,
  scanners: [{ id: 'skillsguard', mode: 'required', blockSeverities: ['high', 'critical'], timeoutSeconds: 5 }],
  evidenceMaxAgeSeconds: 3600, hooks: [],
};
function scanner(): ScannerAdapter {
  return {
    id: 'skillsguard', command: 'test-fixture',
    metadata: { id: 'skillsguard', version: 'fixture', engineVersion: 'fixture', rulesRevision: 'fixture' },
    scan: async (input) => ({ result: {
      schemaVersion: 1, organizationId: input.organizationId, jobId: input.jobId,
      invocationId: 'fixture-invocation', artifactDigest: input.artifactDigest,
      policyRevision: input.policyRevision,
      adapter: { id: 'skillsguard', version: 'fixture', engineVersion: 'fixture', rulesRevision: 'fixture', configurationHash: `sha256:${'1'.repeat(64)}` },
      status: 'completed', durationMs: 1,
      coverage: { filesEnumerated: 1, filesAnalyzed: 1, filesSkipped: 0, filesUnsupported: 0, limitations: [], externalDestinations: [] },
      findings: [],
    } }),
  };
}

describe('directory admission across core, worker, and Files SDK', () => {
  let harness: LocalRegistryHarness | undefined;
  afterEach(async () => { await harness?.close(); harness = undefined; });

  async function setup(withScanner = true) {
    const detail = vi.fn(async () => structuredClone(snapshot));
    const unavailable = async (): Promise<never> => { throw new Error('Unexpected metadata request'); };
    const directory: RegistryDirectoryClient = { detail, list: unavailable, search: unavailable, curated: unavailable, audit: unavailable };
    harness = await createLocalRegistryHarness({ policy, directory, allowLoopbackUpstreams: true });
    const { handler, origin, token, workerToken } = harness;
    const call = (path: string, json?: unknown) => request(handler, origin, path, {
      headers: bearer(token), ...(json === undefined ? {} : { method: 'POST', json }),
    });
    const created = await call('/v1/upstreams', { name: 'public-directory', kind: 'skills-sh', namespace: '@acme', repositories: ['*'], enabled: true, baseUrl: 'http://127.0.0.1:5419' });
    expect(created.status, await created.clone().text()).toBe(201);
    const { upstream } = await jsonResponse<{ upstream: Upstream }>(created);
    const sourceFetch = vi.fn(async (input: string | URL) => {
      expect(new URL(String(input)).origin).toBe('http://127.0.0.1:5419');
      expect(new URL(String(input)).pathname).toBe(`/api/v1/skills/${id}`);
      return Response.json(snapshot);
    });
    const runner = new WorkerRunner({
      baseUrl: origin, workerToken, workerId: 'directory-e2e',
      fetch: async (input, init) => handler(new Request(String(input), init as RequestInit)),
      acquisition: { fetchImpl: sourceFetch, allowLoopbackForTests: true }, adapters: withScanner ? [scanner()] : [],
    });
    const body = { id, name: '@acme/greeting', version: '1.0.0', upstreamId: upstream.id };
    return { call, body, detail, sourceFetch, runner };
  }

  it('fetches and scans a cold import, reuses approved bytes warm, and respects revocation', async () => {
    const { call, body, detail, sourceFetch, runner } = await setup();
    const queued = await call('/v1/directory/import', body);
    expect(queued.status, await queued.clone().text()).toBe(202);
    const { operation } = await jsonResponse<{ operation: Job }>(queued);
    const before = await call('/v1/resolve', { kind: 'skill', ref: body.name, version: body.version });
    expect(before.status).toBe(202);
    expect(await before.json()).not.toHaveProperty('resolution');
    const result = await runner.runOnce();
    expect(result.error).toBeUndefined();
    expect(result.allow).toBe(true);
    expect(sourceFetch).toHaveBeenCalledTimes(1);
    const resolved = await call('/v1/resolve', { kind: 'skill', ref: body.name, version: body.version });
    expect(resolved.status, await resolved.clone().text()).toBe(200);
    const { resolution } = await jsonResponse<{ resolution: Resolution }>(resolved);
    expect(resolution.members[0]?.provenance).toMatchObject({ kind: 'skills-sh', externalId: id, externalSnapshotHash: snapshot.hash });
    const detailCalls = detail.mock.calls.length;
    const warm = await call('/v1/directory/import', body);
    expect(warm.status, await warm.clone().text()).toBe(200);
    expect(detail).toHaveBeenCalledTimes(detailCalls);
    expect(sourceFetch).toHaveBeenCalledTimes(1);
    expect(await runner.runOnce()).toMatchObject({ claimed: false });
    const cached = await jsonResponse<{ resolution: Resolution }>(warm);
    expect(cached.resolution.digest).toBe(resolution.digest);
    expect(operation.kind).toBe('import');
    const skill = resolution.members[0] as SkillVersion;
    const revoked = await call(`/v1/skills/${encodeURIComponent(skill.id)}/revoke`, {});
    expect(revoked.status).toBe(200);
    const after = await call('/v1/directory/import', body);
    expect(after.ok).toBe(false);
  });

  it('cannot distribute an import when the required scanner is unavailable', async () => {
    const { call, body, runner } = await setup(false);
    const queued = await call('/v1/directory/import', body);
    expect(queued.status, await queued.clone().text()).toBe(202);
    const result = await runner.runOnce();
    expect(result.error).toBeUndefined();
    expect(result.allow).toBe(false);
    expect(result.scannerResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ scannerId: 'skillsguard', status: 'unsupported' }),
    ]));
    const resolved = await call('/v1/resolve', { kind: 'skill', ref: body.name, version: body.version });
    expect(resolved.status).toBe(404);
  });
});
