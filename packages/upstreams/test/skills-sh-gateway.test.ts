import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

// Keep these tests offline while exercising the production URL validation and
// request routing.  The injected fetch below is the only network boundary.
vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '127.0.0.1', family: 4 }],
}));

import {
  acquireSkillsShSkill,
  type AcquireSkillInput,
} from '../src/index.js';

const BASE = 'http://127.0.0.1:32127';
const COMMIT = '0123456789012345678901234567890123456789';
const TREE = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';

function gitBlobSha(bytes: Uint8Array): string {
  return createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), Buffer.from(bytes)]))
    .digest('hex');
}

function json(value: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function input(fetchImpl: NonNullable<AcquireSkillInput['fetchImpl']>): AcquireSkillInput {
  return {
    upstream: {
      id: 'skills-sh-gateway-fixture',
      organizationId: 'org-1',
      name: 'skills.sh gateway fixture',
      kind: 'skills-sh',
      enabled: true,
      repositories: ['octo/repo'],
      baseUrl: `${BASE}/directory`,
      namespace: '@team',
    },
    importRequest: {
      upstreamId: 'skills-sh-gateway-fixture',
      path: 'octo/repo/demo',
      name: '@team/demo',
      version: '1.0.0',
    },
    fetchImpl,
    allowLoopbackForTests: true,
  };
}

function detail(files: unknown = [{
  path: 'SKILL.md',
  contents: '---\nname: demo\ndescription: Gateway fixture\n---\n# demo\n',
}]): Record<string, unknown> {
  return {
    id: 'octo/repo/demo',
    source: 'octo/repo',
    slug: 'demo',
    name: 'demo',
    sourceType: 'github',
    installUrl: 'https://github.com/octo/repo/tree/main/skills/demo',
    url: '/site/octo/repo/demo',
    hash: 'gateway-snapshot',
    files,
  };
}

describe('skills.sh gateway credentials', () => {
  it('sends a bound gateway token to the custom catalog base only', async () => {
    const seen: Array<{ path: string; authorization: string | undefined }> = [];
    let gatewayCalls = 0;
    let canonicalCalls = 0;
    const fetchImpl: NonNullable<AcquireSkillInput['fetchImpl']> = async (raw, init) => {
      const url = new URL(raw.toString());
      seen.push({ path: url.pathname, authorization: init?.headers?.authorization });
      expect(url.origin).toBe(new URL(BASE).origin);
      expect(url.pathname).toBe('/directory/api/v1/skills/octo/repo/demo');
      return json(detail());
    };
    const result = await acquireSkillsShSkill({
      ...input(fetchImpl),
      getSkillsShToken: async () => {
        canonicalCalls += 1;
        throw new Error('canonical provider must not run for a gateway');
      },
      skillsShGatewayCredential: {
        baseUrl: `${BASE}/directory/`,
        getToken: async (signal) => {
          expect(signal?.aborted).toBe(false);
          gatewayCalls += 1;
          return 'gateway-token';
        },
      },
    });

    expect(result.provenance.externalId).toBe('octo/repo/demo');
    expect(gatewayCalls).toBe(1);
    expect(canonicalCalls).toBe(0);
    expect(seen).toEqual([{
      path: '/directory/api/v1/skills/octo/repo/demo',
      authorization: 'Bearer gateway-token',
    }]);
  });

  it('does not invoke a gateway provider for a sibling base or fall back to its token', async () => {
    let gatewayCalls = 0;
    let authorization: string | undefined;
    const fetchImpl: NonNullable<AcquireSkillInput['fetchImpl']> = async (_raw, init) => {
      authorization = init?.headers?.authorization;
      return json(detail());
    };
    const key = 'PSKILLS_TEST_AMBIENT_GATEWAY_TOKEN';
    const previous = process.env[key];
    process.env[key] = 'ambient-token-must-not-be-forwarded';
    let result;
    try {
      const request = input(fetchImpl);
      request.upstream = { ...request.upstream!, credentialEnv: key };
      request.skillsShGatewayCredential = {
        baseUrl: `${BASE}/other-directory`,
        getToken: async () => {
          gatewayCalls += 1;
          return 'must-not-be-sent';
        },
      };
      result = await acquireSkillsShSkill(request);
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }

    expect(result.bundle.files).toHaveLength(1);
    expect(gatewayCalls).toBe(0);
    expect(authorization).toBeUndefined();
  });

  it.each([
    'https://skills.sh/catalog',
    'https://www.skills.sh/catalog',
    'https://skills.sh./catalog',
  ])('rejects a gateway credential targeting the canonical skills.sh aliases: %s', async (baseUrl) => {
    let gatewayCalls = 0;
    let fetchCalls = 0;
    const request = input(async () => {
      fetchCalls += 1;
      return json(detail());
    });
    request.skillsShGatewayCredential = {
      baseUrl,
      getToken: async () => {
        gatewayCalls += 1;
        return 'must-not-be-used';
      },
    };

    await expect(acquireSkillsShSkill(request)).rejects.toMatchObject({
      code: 'invalid_credential_ref',
      message: 'skills.sh gateway credential cannot target the canonical skills.sh origin',
    });
    expect(gatewayCalls).toBe(0);
    expect(fetchCalls).toBe(0);
  });

  it('keeps a gateway token off GitHub source requests', async () => {
    const skill = Buffer.from('---\nname: demo\ndescription: Gateway GitHub fixture\n---\n# demo\n', 'utf8');
    const skillSha = gitBlobSha(skill);
    const seen: Array<{ origin: string; path: string; authorization: string | undefined }> = [];
    let gatewayCalls = 0;
    const fetchImpl: NonNullable<AcquireSkillInput['fetchImpl']> = async (raw, init) => {
      const url = new URL(raw.toString());
      seen.push({ origin: url.origin, path: url.pathname, authorization: init?.headers?.authorization });
      if (url.pathname === '/directory/api/v1/skills/octo/repo/demo') {
        return json({ ...detail(null), hash: null, files: null });
      }
      if (url.pathname === '/github/repos/octo/repo') return json({ default_branch: 'main' });
      if (url.pathname === `/github/repos/octo/repo/commits/main`) return json({ sha: COMMIT });
      if (url.pathname === `/github/repos/octo/repo/git/trees/${COMMIT}`) {
        return json({ truncated: false, tree: [
          { path: 'skills/demo/SKILL.md', type: 'blob', mode: '100644', sha: skillSha, size: skill.length },
        ] });
      }
      if (url.pathname === `/github/repos/octo/repo/git/blobs/${skillSha}`) {
        return json({ encoding: 'base64', content: skill.toString('base64'), size: skill.length, sha: skillSha });
      }
      return json({ error: 'not found' }, 404);
    };
    const request = input(fetchImpl);
    request.upstream = {
      ...request.upstream!,
      baseUrl: `${BASE}/directory`,
      githubApiBaseUrl: `${BASE}/github`,
    } as AcquireSkillInput['upstream'];
    request.skillsShGatewayCredential = {
      baseUrl: `${BASE}/directory`,
      getToken: async () => {
        gatewayCalls += 1;
        return 'gateway-token';
      },
    };

    const result = await acquireSkillsShSkill(request);

    expect(result.bundle.files).toHaveLength(1);
    expect(gatewayCalls).toBe(1);
    expect(seen.find((entry) => entry.path.startsWith('/directory/api/'))?.authorization).toBe('Bearer gateway-token');
    expect(seen.filter((entry) => !entry.path.startsWith('/directory/api/')).every((entry) => entry.authorization === undefined)).toBe(true);
  });

  it('strips a gateway token before following a same-origin catalog redirect', async () => {
    const authorizations: Array<string | undefined> = [];
    const fetchImpl: NonNullable<AcquireSkillInput['fetchImpl']> = async (raw, init) => {
      const url = new URL(raw.toString());
      authorizations.push(init?.headers?.authorization);
      if (url.pathname.endsWith('/demo')) {
        return new Response(null, {
          status: 302,
          headers: { location: `${BASE}/directory/api/v1/skills/octo/repo/demo-redirect` },
        });
      }
      if (url.pathname.endsWith('/demo-redirect')) return json(detail());
      return json({ error: 'not found' }, 404);
    };
    const request = input(fetchImpl);
    request.skillsShGatewayCredential = {
      baseUrl: `${BASE}/directory`,
      getToken: async () => 'gateway-token',
    };

    await expect(acquireSkillsShSkill(request)).resolves.toMatchObject({ provenance: { externalId: 'octo/repo/demo' } });
    expect(authorizations).toEqual(['Bearer gateway-token', undefined]);
  });

  it('redacts gateway provider failures and fails closed before catalog I/O', async () => {
    const secret = 'gateway-provider-secret';
    let fetchCalls = 0;
    const request = input(async () => {
      fetchCalls += 1;
      return json(detail());
    });
    request.skillsShGatewayCredential = {
      baseUrl: `${BASE}/directory`,
      getToken: async () => { throw new Error(`provider rejected ${secret}`); },
    };

    const error = await acquireSkillsShSkill(request).catch((value: unknown) => value);
    expect(error).toMatchObject({
      code: 'credential_unavailable',
      message: 'skills.sh catalog authentication unavailable',
    });
    expect(String(error)).not.toContain(secret);
    expect(fetchCalls).toBe(0);
  });

  it('cancels a pending gateway provider without attempting the catalog request', async () => {
    const controller = new AbortController();
    let fetchCalls = 0;
    let providerSignal: AbortSignal | undefined;
    const request = input(async () => {
      fetchCalls += 1;
      return json(detail());
    });
    request.signal = controller.signal;
    request.limits = { requestTimeoutMs: 1000 };
    request.skillsShGatewayCredential = {
      baseUrl: `${BASE}/directory`,
      getToken: async (signal) => {
        providerSignal = signal;
        return new Promise<string>(() => { /* deliberately pending */ });
      },
    };

    const pending = acquireSkillsShSkill(request);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(providerSignal?.aborted).toBe(true);
    expect(fetchCalls).toBe(0);
  });
});
