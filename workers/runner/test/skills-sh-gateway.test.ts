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

const BASE = 'https://127.0.0.1:32128';

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

  it('keeps incomplete gateway settings fail-closed and ignores the legacy token', async () => {
    const incomplete = workerAcquisitionOptionsFromEnv({
      PSKILLS_DIRECTORY_ENABLED: 'true',
      PSKILLS_DIRECTORY_GATEWAY_URL: `${BASE}/directory`,
      PSKILLS_DIRECTORY_TOKEN: 'legacy-token-must-not-be-used',
    });
    expect(incomplete.skillsShGatewayCredential?.baseUrl).toBe(`${BASE}/directory`);
    await expect(incomplete.skillsShGatewayCredential?.getToken()).rejects.toThrow('gateway credential unavailable');

    const legacyOnly = workerAcquisitionOptionsFromEnv({
      PSKILLS_DIRECTORY_ENABLED: 'true',
      PSKILLS_DIRECTORY_TOKEN: 'legacy-token-must-not-be-used',
    });
    expect(legacyOnly.skillsShGatewayCredential).toBeUndefined();

    const canonical = workerAcquisitionOptionsFromEnv({
      PSKILLS_DIRECTORY_ENABLED: 'true',
      PSKILLS_DIRECTORY_GATEWAY_URL: 'https://skills.sh/catalog',
      PSKILLS_DIRECTORY_GATEWAY_TOKEN: 'gateway-token-must-not-be-used',
    });
    expect(canonical.skillsShGatewayCredential).toBeUndefined();
  });

  it('routes same-ID imports to the matching gateway from the bounded profile', async () => {
    const options = workerAcquisitionOptionsFromEnv({
      PSKILLS_DIRECTORY_ENABLED: 'true',
      PSKILLS_DIRECTORY_GATEWAYS_JSON: JSON.stringify([
        { baseUrl: `${BASE}/directory/a`, tokenEnv: 'PSKILLS_FEED_A_TOKEN' },
        { baseUrl: `${BASE}/directory/b/`, tokenEnv: 'PSKILLS_FEED_B_TOKEN' },
      ]),
      PSKILLS_FEED_A_TOKEN: 'token-a',
      PSKILLS_FEED_B_TOKEN: 'token-b',
    });
    expect(options.skillsShGatewayCredentials).toHaveLength(2);

    const seen: Array<{ path: string; authorization: string; hash: string }> = [];
    const fetchImpl: NonNullable<ReturnType<typeof workerAcquisitionOptionsFromEnv>['fetch']> = async (raw, init) => {
      const url = new URL(raw.toString());
      const authorization = new Headers(init?.headers).get('authorization') ?? '';
      const isA = url.pathname.startsWith('/directory/a/');
      const isB = url.pathname.startsWith('/directory/b/');
      if (!isA && !isB) return jsonResponse({ error: 'unexpected route' }, 404);
      const hash = isA ? 'worker-feed-a' : 'worker-feed-b';
      seen.push({ path: url.pathname, authorization, hash });
      return jsonResponse({
        id: 'octo/repo/demo', source: 'octo/repo', slug: 'demo', name: 'demo', sourceType: 'github', hash,
        files: [{ path: 'SKILL.md', contents: '---\nname: demo\ndescription: worker multi-feed\n---\n# demo\n' }],
      });
    };

    const first = await acquireImportJob(job(`${BASE}/directory/a`), {
      ...options,
      fetch: fetchImpl,
      allowLoopbackForTests: true,
    });
    const second = await acquireImportJob(job(`${BASE}/directory/b`), {
      ...options,
      fetch: fetchImpl,
      allowLoopbackForTests: true,
    });

    expect(first.provenance.externalSnapshotHash).toBe('worker-feed-a');
    expect(second.provenance.externalSnapshotHash).toBe('worker-feed-b');
    expect(seen).toEqual([
      { path: '/directory/a/api/v1/skills/octo/repo/demo', authorization: 'Bearer token-a', hash: 'worker-feed-a' },
      { path: '/directory/b/api/v1/skills/octo/repo/demo', authorization: 'Bearer token-b', hash: 'worker-feed-b' },
    ]);
  });

  it('keeps malformed or conflicting profiles fail-closed with no ambient fallback', async () => {
    const ambientKey = 'PSKILLS_MULTI_FEED_AMBIENT_TOKEN';
    const previous = process.env[ambientKey];
    process.env[ambientKey] = 'ambient-token-must-not-be-used';
    try {
      const malformed = workerAcquisitionOptionsFromEnv({
        PSKILLS_DIRECTORY_ENABLED: 'true',
        PSKILLS_DIRECTORY_GATEWAYS_JSON: '{not-json',
      });
      expect(malformed.skillsShGatewayCredentials).toEqual([]);

      let fetchCalls = 0;
      const fetchImpl: NonNullable<ReturnType<typeof workerAcquisitionOptionsFromEnv>['fetch']> = async () => {
        fetchCalls += 1;
        return jsonResponse({ error: 'unexpected request' }, 500);
      };
      const error = await acquireImportJob({
        ...job(`${BASE}/directory/unconfigured`),
        upstream: { ...job(`${BASE}/directory/unconfigured`).upstream!, credentialEnv: ambientKey },
      }, {
        ...malformed,
        fetch: fetchImpl,
        allowLoopbackForTests: true,
      }).catch((value: unknown) => value);
      expect(error).toMatchObject({ code: 'credential_missing' });
      expect(fetchCalls).toBe(0);

      const duplicate = workerAcquisitionOptionsFromEnv({
        PSKILLS_DIRECTORY_ENABLED: 'true',
        PSKILLS_DIRECTORY_GATEWAYS_JSON: JSON.stringify([
          { baseUrl: `${BASE}/directory/a`, tokenEnv: 'PSKILLS_FEED_A_TOKEN' },
          { baseUrl: `${BASE}/directory/a/`, tokenEnv: 'PSKILLS_FEED_B_TOKEN' },
        ]),
        PSKILLS_FEED_A_TOKEN: 'token-a',
        PSKILLS_FEED_B_TOKEN: 'token-b',
      });
      expect(duplicate.skillsShGatewayCredentials).toEqual([]);

      const conflicting = workerAcquisitionOptionsFromEnv({
        PSKILLS_DIRECTORY_ENABLED: 'true',
        PSKILLS_DIRECTORY_GATEWAYS_JSON: JSON.stringify([{ baseUrl: `${BASE}/directory/a`, tokenEnv: 'PSKILLS_FEED_A_TOKEN' }]),
        PSKILLS_DIRECTORY_GATEWAY_URL: `${BASE}/directory/a`,
        PSKILLS_DIRECTORY_GATEWAY_TOKEN: 'legacy-token-must-not-win',
        PSKILLS_FEED_A_TOKEN: 'token-a',
      });
      expect(conflicting.skillsShGatewayCredentials).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env[ambientKey];
      else process.env[ambientKey] = previous;
    }
  });

  it('uses canonical OIDC for skills.sh even when plural gateways are configured', async () => {
    const options = workerAcquisitionOptionsFromEnv({
      PSKILLS_DIRECTORY_ENABLED: 'true',
      PSKILLS_DIRECTORY_GATEWAYS_JSON: JSON.stringify([{ baseUrl: `${BASE}/directory/a`, tokenEnv: 'PSKILLS_FEED_A_TOKEN' }]),
      PSKILLS_FEED_A_TOKEN: 'gateway-token-must-not-run',
    });
    const authorizations: string[] = [];
    let oidcCalls = 0;
    const fetchImpl: NonNullable<ReturnType<typeof workerAcquisitionOptionsFromEnv>['fetch']> = async (_raw, init) => {
      authorizations.push(new Headers(init?.headers).get('authorization') ?? '');
      return jsonResponse({
        id: 'octo/repo/demo', source: 'octo/repo', slug: 'demo', name: 'demo', sourceType: 'github', hash: 'canonical-feed',
        files: [{ path: 'SKILL.md', contents: '---\nname: demo\ndescription: canonical worker\n---\n# demo\n' }],
      });
    };

    const acquired = await acquireImportJob(job('https://skills.sh'), {
      ...options,
      getSkillsShToken: async () => {
        oidcCalls += 1;
        return 'oidc-token';
      },
      fetch: fetchImpl,
      allowLoopbackForTests: true,
    });
    expect(acquired.provenance.externalSnapshotHash).toBe('canonical-feed');
    expect(oidcCalls).toBe(1);
    expect(authorizations).toEqual(['Bearer oidc-token']);
  });
});
