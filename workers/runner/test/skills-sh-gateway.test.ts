import { describe, expect, it, vi } from 'vitest';

// The upstream adapter performs DNS rebinding checks. Keep the fixture local
// and deterministic while leaving production URL validation enabled.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '127.0.0.1', family: 4 }]),
}));

import type { WorkerClaimedJob } from '../src/client.js';
import {
  acquireImportJob,
  workerAcquisitionOptionsFromEnv,
} from '../src/acquisition.js';

const BASE = 'http://127.0.0.1:32128';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function job(baseUrl = `${BASE}/directory`): WorkerClaimedJob {
  return {
    id: 'job-gateway-1',
    kind: 'import',
    organizationId: 'org-1',
    fencingToken: 'lease-1',
    attempt: 1,
    upstream: {
      id: 'upstream-gateway',
      organizationId: 'org-1',
      name: 'directory gateway',
      kind: 'skills-sh',
      enabled: true,
      repositories: ['octo/repo'],
      baseUrl,
      namespace: 'team',
    },
    import: {
      upstreamId: 'upstream-gateway',
      path: 'octo/repo/demo',
      name: '@team/demo',
      version: '1.0.0',
    },
  };
}

function detailFetch(seen: string[]): NonNullable<ReturnType<typeof workerAcquisitionOptionsFromEnv>['fetch']> {
  return async (raw, init) => {
    const url = new URL(raw.toString());
    seen.push(new Headers(init?.headers).get('authorization') ?? '');
    if (url.pathname !== '/directory/api/v1/skills/octo/repo/demo') return jsonResponse({ error: 'missing route' }, 404);
    return jsonResponse({
      id: 'octo/repo/demo',
      source: 'octo/repo',
      slug: 'demo',
      name: 'demo',
      sourceType: 'github',
      hash: 'worker-gateway-snapshot',
      files: [{ path: 'SKILL.md', contents: '---\nname: demo\ndescription: worker gateway\n---\n# demo\n' }],
    });
  };
}

describe('portable worker skills.sh gateway credentials', () => {
  it('reads a gateway credential only when directory access is enabled', async () => {
    const enabledSeen: string[] = [];
    const enabled = workerAcquisitionOptionsFromEnv({
      PSKILLS_DIRECTORY_ENABLED: 'true',
      PSKILLS_DIRECTORY_GATEWAY_URL: `${BASE}/directory`,
      PSKILLS_DIRECTORY_GATEWAY_TOKEN: 'gateway-token',
    });
    const acquired = await acquireImportJob(job(), {
      ...enabled,
      fetch: detailFetch(enabledSeen),
      allowLoopbackForTests: true,
    });
    expect(acquired.provenance.externalId).toBe('octo/repo/demo');
    expect(enabledSeen).toEqual(['Bearer gateway-token']);

    const disabledSeen: string[] = [];
    const disabled = workerAcquisitionOptionsFromEnv({
      PSKILLS_DIRECTORY_GATEWAY_URL: `${BASE}/directory`,
      PSKILLS_DIRECTORY_GATEWAY_TOKEN: 'must-not-be-used',
    });
    await acquireImportJob(job(), {
      ...disabled,
      fetch: detailFetch(disabledSeen),
      allowLoopbackForTests: true,
    });
    expect(disabledSeen).toEqual(['']);
  });

  it('fails closed and redacts gateway provider failures at the worker boundary', async () => {
    const secret = 'worker-gateway-provider-secret';
    const seen: string[] = [];
    const error = await acquireImportJob(job(), {
      fetch: detailFetch(seen),
      allowLoopbackForTests: true,
      skillsShGatewayCredential: {
        baseUrl: `${BASE}/directory`,
        getToken: async () => { throw new Error(`provider rejected ${secret}`); },
      },
    }).catch((value: unknown) => value);

    expect(error).toMatchObject({
      message: 'skills.sh catalog authentication unavailable',
      code: 'credential_unavailable',
    });
    expect(String(error)).not.toContain(secret);
    expect(seen).toEqual([]);
  });

  it('does not invoke a gateway callback when the claimed source base differs', async () => {
    let callbackCalls = 0;
    const seen: string[] = [];
    await acquireImportJob(job(), {
      fetch: detailFetch(seen),
      allowLoopbackForTests: true,
      skillsShGatewayCredential: {
        baseUrl: `${BASE}/different-directory`,
        getToken: async () => {
          callbackCalls += 1;
          return 'must-not-be-used';
        },
      },
    });

    expect(callbackCalls).toBe(0);
    expect(seen).toEqual(['']);
  });
});
