import { describe, expect, it } from 'vitest';

import {
  createSkillsDirectoryClientResolver,
  resolveSkillsDirectoryGateways,
} from '../src/index.js';

function detail(id: string): Record<string, unknown> {
  const [source, ...slugParts] = id.split('/');
  return {
    id,
    source: source ?? '',
    slug: slugParts.join('/'),
    installs: 1,
    hash: null,
    files: null,
  };
}

describe('directory client feed resolver', () => {
  it('routes identical external IDs to distinct exact gateway bases and tokens', async () => {
    const resolution = resolveSkillsDirectoryGateways({
      PSKILLS_DIRECTORY_ENABLED: 'true',
      PSKILLS_DIRECTORY_GATEWAYS_JSON: JSON.stringify([
        { baseUrl: 'https://catalog-a.example.test/api', tokenEnv: 'PSKILLS_FEED_A' },
        { baseUrl: 'https://catalog-b.example.test/catalog', tokenEnv: 'PSKILLS_FEED_B' },
      ]),
      PSKILLS_FEED_A: 'feed-token-a',
      PSKILLS_FEED_B: 'feed-token-b',
    });
    const requests: Array<{ url: string; authorization: string | undefined }> = [];
    const fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      requests.push({
        url: input.toString(),
        authorization: (init?.headers as Record<string, string> | undefined)?.authorization,
      });
      const url = new URL(input.toString());
      return new Response(JSON.stringify(detail('same/repo/skill')), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-source-base': url.origin + url.pathname },
      });
    };
    const resolver = createSkillsDirectoryClientResolver({
      gateways: resolution,
      officialAvailable: false,
      fetch,
    });
    const first = resolver('https://catalog-a.example.test/api/');
    const second = resolver('https://catalog-b.example.test/catalog');

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).not.toBe(second);
    expect(resolver('https://unknown.example.test')).toBeUndefined();

    await expect(first!.detail('same/repo/skill')).resolves.toMatchObject({ id: 'same/repo/skill' });
    await expect(second!.detail('same/repo/skill')).resolves.toMatchObject({ id: 'same/repo/skill' });
    expect(requests).toEqual([
      { url: 'https://catalog-a.example.test/api/api/v1/skills/same/repo/skill', authorization: 'Bearer feed-token-a' },
      { url: 'https://catalog-b.example.test/catalog/api/v1/skills/same/repo/skill', authorization: 'Bearer feed-token-b' },
    ]);
    expect(resolver('https://catalog-a.example.test/api')).toBe(first);
  });

  it('keeps canonical OIDC separate and unavailable on edge', async () => {
    const resolution = resolveSkillsDirectoryGateways({ PSKILLS_DIRECTORY_ENABLED: 'true' });
    const tokens: string[] = [];
    const fetch = async (_input: string | URL, init?: RequestInit): Promise<Response> => {
      tokens.push((init?.headers as Record<string, string> | undefined)?.authorization ?? '');
      return new Response(JSON.stringify(detail('same/repo/skill')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const edgeResolver = createSkillsDirectoryClientResolver({
      gateways: resolution,
      officialAvailable: false,
      fetch,
    });
    expect(edgeResolver('https://skills.sh')).toBeUndefined();

    const nodeResolver = createSkillsDirectoryClientResolver({
      gateways: resolution,
      officialAvailable: true,
      officialTokenProvider: async () => 'fresh-oidc-token',
      fetch,
    });
    const official = nodeResolver('https://skills.sh');
    expect(official).toBeDefined();
    await official!.detail('same/repo/skill');
    expect(tokens).toEqual(['Bearer fresh-oidc-token']);
  });

  it('does not construct clients from an invalid profile resolution', () => {
    const resolution = resolveSkillsDirectoryGateways({
      PSKILLS_DIRECTORY_ENABLED: 'true',
      PSKILLS_DIRECTORY_GATEWAYS_JSON: '{',
    });
    const resolver = createSkillsDirectoryClientResolver({
      gateways: resolution,
      officialAvailable: true,
      officialTokenProvider: async () => 'must-not-run',
    });
    expect(resolver('https://catalog-a.example.test/api')).toBeUndefined();
    expect(resolver('https://skills.sh')).toBeUndefined();
  });
});
