import { describe, expect, it, vi } from 'vitest';

// The upstream adapter performs a DNS rebinding check before invoking its
// injected fetch. Keep this fixture deterministic and offline by mocking only
// the module-level resolver for this test file; production DNS/SSRF behavior
// remains unchanged.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '203.0.113.42', family: 4 }]),
}));

import type { WorkerClaimedJob } from '../src/client.js';
import { acquireImportJob, type WorkerAcquisitionOptions } from '../src/acquisition.js';
import { WorkerRunner } from '../src/worker.js';

const DETAIL_PATH = '/api/v1/skills/octo/repo/demo';
const SKILL = '---\nname: demo\ndescription: OIDC fixture\n---\n# demo\n';

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function job(): WorkerClaimedJob {
  return {
    id: 'job-skills-sh-oidc',
    kind: 'import',
    organizationId: 'org-1',
    fencingToken: 'lease-1',
    attempt: 1,
    upstream: {
      id: 'upstream-skills-sh',
      organizationId: 'org-1',
      name: 'skills.sh',
      kind: 'skills-sh',
      enabled: true,
      repositories: ['octo/repo'],
      baseUrl: 'https://skills.sh',
      namespace: 'team',
    },
    import: {
      upstreamId: 'upstream-skills-sh',
      repository: 'octo/repo',
      path: 'octo/repo/demo',
      name: '@team/demo',
      version: '1.0.0',
      externalId: 'octo/repo/demo',
      externalSourceType: 'github',
      externalSnapshotHash: 'snapshot-oidc',
    },
  };
}

function detailFetch(authorization: string, seen: string[]): WorkerAcquisitionOptions['fetch'] {
  return async (input, init) => {
    const url = new URL(input.toString());
    if (url.pathname !== DETAIL_PATH) return jsonResponse({ error: 'missing source route' }, 404);
    seen.push(new Headers(init?.headers).get('authorization') ?? '');
    expect(seen.at(-1)).toBe(authorization);
    return jsonResponse({
      id: 'octo/repo/demo',
      source: 'octo/repo',
      slug: 'demo',
      hash: 'snapshot-oidc',
      files: [{ path: 'SKILL.md', contents: SKILL }],
    });
  };
}

describe('worker skills.sh OIDC acquisition', () => {
  it('invokes the token callback afresh for each import job', async () => {
    let tokenCalls = 0;
    const authorizations: string[] = [];
    const tokenProvider = async (_signal?: AbortSignal): Promise<string> => {
      tokenCalls += 1;
      return `oidc-token-${tokenCalls}`;
    };

    const options = (fetch: WorkerAcquisitionOptions['fetch']): WorkerAcquisitionOptions => ({
      fetch,
      getSkillsShToken: tokenProvider,
    });

    const first = job();
    await acquireImportJob(first, options(detailFetch('Bearer oidc-token-1', authorizations)));
    const second = { ...job(), id: 'job-skills-sh-oidc-2' };
    await acquireImportJob(second, options(detailFetch('Bearer oidc-token-2', authorizations)));

    expect(tokenCalls).toBe(2);
    expect(authorizations).toEqual(['Bearer oidc-token-1', 'Bearer oidc-token-2']);
  });

  it('fails closed and redacts provider failures before worker telemetry', async () => {
    const secret = 'oidc-private-token-that-must-not-escape';
    const tokenProvider = async (): Promise<string> => {
      throw new Error(`provider rejected ${secret}`);
    };
    let sourceCalls = 0;
    const sourceFetch: WorkerAcquisitionOptions['fetch'] = async () => {
      sourceCalls += 1;
      return jsonResponse({ error: 'source should not be queried' }, 500);
    };
    let completion: Record<string, unknown> | undefined;
    const apiFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(input.toString());
      if (url.pathname === '/internal/jobs/claim') return jsonResponse({ job: job() });
      if (url.pathname === '/internal/jobs/job-skills-sh-oidc/complete') {
        completion = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return jsonResponse({ operation: { id: 'job-skills-sh-oidc', state: 'completed' } });
      }
      return jsonResponse({ error: 'unexpected worker route' }, 404);
    };

    const events: Array<{ type: string; error?: string }> = [];
    const result = await new WorkerRunner({
      baseUrl: 'https://registry.example.test',
      workerToken: 'worker-token-fixture',
      workerId: 'worker-fixture',
      fetch: apiFetch,
      acquisition: { fetch: sourceFetch, getSkillsShToken: tokenProvider },
      onEvent: (event) => { events.push(event); },
    }).runOnce();

    expect(result.error).toBe('skills.sh catalog authentication unavailable');
    expect(completion?.error).toBe('skills.sh catalog authentication unavailable');
    expect(JSON.stringify(completion)).not.toContain(secret);
    expect(events.at(-1)?.error).toBe('skills.sh catalog authentication unavailable');
    expect(sourceCalls).toBe(0);
  });
});
