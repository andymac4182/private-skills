import { describe, expect, it, vi } from 'vitest';

import {
  SkillsDirectoryClient,
  SkillsDirectoryError,
} from '../src/index.js';

function response(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const skill = {
  id: 'vercel-labs/skills/find-skills',
  slug: 'find-skills',
  name: 'Find Skills',
  source: 'vercel-labs/skills',
  installs: 24_531,
  sourceType: 'github',
  installUrl: 'https://github.com/vercel-labs/skills',
  url: 'https://skills.sh/vercel-labs/skills/find-skills',
};

describe('SkillsDirectoryClient', () => {
  it('requests bounded leaderboard pages with a fresh token per API call', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const getToken = vi.fn(async () => 'request-token');
    const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return response({
        data: [skill],
        pagination: { page: 1, perPage: 2, total: 1, hasMore: false },
      });
    });
    const client = new SkillsDirectoryClient({ fetch, getToken });

    const first = await client.list({ view: 'trending', page: 1, perPage: 2 });
    const second = await client.list({ view: 'hot', page: 0, perPage: 1 });

    expect(first.data[0]?.id).toBe(skill.id);
    expect(second.pagination.perPage).toBe(2);
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(calls[0]?.url).toBe('https://skills.sh/api/v1/skills?view=trending&page=1&per_page=2');
    expect(calls[0]?.init?.redirect).toBe('manual');
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe('Bearer request-token');
  });

  it('supports search filters and rejects unbounded input before fetching', async () => {
    const fetch = vi.fn(async (_input: string | URL) => response({
      data: [skill],
      query: 'react native',
      searchType: 'semantic',
      count: 1,
      durationMs: 12,
    }));
    const client = new SkillsDirectoryClient({ fetch });

    const result = await client.search({ q: '  react native ', limit: 5, owner: 'expo' });
    expect(result.query).toBe('react native');
    expect(String(fetch.mock.calls[0]?.[0])).toBe('https://skills.sh/api/v1/skills/search?q=react+native&limit=5&owner=expo');
    await expect(client.search({ q: 'x' })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(client.list({ perPage: 501 })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('normalizes curated, detail, and external partner-audit shapes', async () => {
    const fetch = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/curated')) {
        return response({
          data: [{ owner: 'vercel-labs', totalInstalls: 24_531, featuredRepo: 'skills', featuredSkill: 'find-skills', skills: [skill] }],
          totalOwners: 1,
          totalSkills: 1,
          generatedAt: '2026-03-31T08:00:00.000Z',
        });
      }
      if (url.includes('/audit/')) {
        return response({
          id: skill.id,
          source: skill.source,
          slug: skill.slug,
          audits: [{
            provider: 'Socket',
            slug: 'socket',
            status: 'pass',
            summary: 'No alerts',
            auditedAt: '2026-04-15T12:05:00.000Z',
            riskLevel: null,
            categories: null,
          }],
        });
      }
      return response({
        id: 'mintlify.com/mintlify',
        source: 'mintlify.com',
        slug: 'mintlify',
        installs: 3,
        hash: null,
        files: null,
      });
    });
    const client = new SkillsDirectoryClient({ fetch });

    const curated = await client.curated();
    const detail = await client.detail('mintlify.com/mintlify');
    const audits = await client.audit(skill.id);

    expect(curated.data[0]?.skills[0]?.sourceType).toBe('github');
    expect(detail.files).toBeNull();
    expect(detail.hash).toBeNull();
    expect(audits.audits[0]?.provider).toBe('Socket');
    expect(audits.audits[0]?.status).toBe('pass');
    expect(audits.audits[0]?.riskLevel).toBeNull();
    expect(audits.audits[0]?.categories).toBeNull();
    expect(String(fetch.mock.calls[1]?.[0])).toBe('https://skills.sh/api/v1/skills/mintlify.com/mintlify');
    expect(String(fetch.mock.calls[2]?.[0])).toBe('https://skills.sh/api/v1/skills/audit/vercel-labs/skills/find-skills');
  });

  it('keeps detail files bounded and treats them as text data', async () => {
    const fetch = vi.fn(async () => response({
      id: skill.id,
      source: skill.source,
      slug: skill.slug,
      installs: 1,
      hash: 'snapshot-hash',
      files: [{ path: 'SKILL.md', contents: '# Safe text\n' }],
    }));
    const client = new SkillsDirectoryClient({ fetch, limits: { maxTextBytes: 128 } });
    const detail = await client.detail(skill.id);
    expect(detail.files).toEqual([{ path: 'SKILL.md', contents: '# Safe text\n' }]);

    const traversalFetch = vi.fn(async () => response({
      id: skill.id,
      source: skill.source,
      slug: skill.slug,
      installs: 1,
      hash: null,
      files: [{ path: '../SKILL.md', contents: 'text' }],
    }));
    const traversalClient = new SkillsDirectoryClient({ fetch: traversalFetch });
    await expect(traversalClient.detail(skill.id)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('bounds Retry-After retries and exposes a distinct rate-limit error', async () => {
    const sleep = vi.fn(async () => undefined);
    const fetch = vi
      .fn<(...args: Parameters<typeof globalThis.fetch>) => ReturnType<typeof globalThis.fetch>>()
      .mockResolvedValueOnce(response({ error: 'secret body' }, 429, { 'retry-after': '0.001' }))
      .mockResolvedValueOnce(response({ data: [], pagination: { page: 0, perPage: 100, total: 0, hasMore: false } }));
    const client = new SkillsDirectoryClient({ fetch, sleep, maxAttempts: 2, maxRetryAfterMs: 25 });

    await client.list();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1);

    fetch.mockReset().mockResolvedValue(response({ error: 'secret body' }, 429, { 'retry-after': '999999' }));
    const limitedClient = new SkillsDirectoryClient({ fetch, sleep, maxAttempts: 1, maxRetryAfterMs: 25 });
    await expect(limitedClient.list()).rejects.toMatchObject({ code: 'rate_limited', retryAfterMs: 25 });

    fetch.mockReset().mockResolvedValue(response({ error: 'secret body' }, 429, { 'retry-after': '999999' }));
    const cooldownClient = new SkillsDirectoryClient({ fetch, sleep, maxAttempts: 2, maxRetryAfterMs: 25 });
    await expect(cooldownClient.list()).rejects.toMatchObject({ code: 'rate_limited', retryAfterMs: 25 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects redirects before a credential can be forwarded and sanitizes API errors', async () => {
    const fetch = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual');
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer secret-token');
      return new Response('redirect-secret', { status: 302, headers: { location: 'https://evil.invalid/collect' } });
    });
    const client = new SkillsDirectoryClient({ fetch, getToken: async () => 'secret-token', maxAttempts: 1 });
    const redirectError = await client.list().catch((error: unknown) => error);
    expect(redirectError).toBeInstanceOf(SkillsDirectoryError);
    expect(redirectError).toMatchObject({ code: 'redirect_denied', status: 302 });
    expect(fetch).toHaveBeenCalledTimes(1);

    const apiErrorClient = new SkillsDirectoryClient({
      fetch: vi.fn(async () => response({ message: 'https://secret.invalid/?token=do-not-reflect' }, 400)),
      maxAttempts: 1,
    });
    const apiError = await apiErrorClient.list().catch((error: unknown) => error);
    expect(apiError).toMatchObject({ code: 'http_error', status: 400 });
    expect((apiError as Error).message).not.toContain('secret.invalid');
    expect((apiError as Error).message).not.toContain('do-not-reflect');
  });

  it('maps 404 separately and requires an HTTPS configured base URL', async () => {
    const fetch = vi.fn(async () => new Response('', { status: 404 }));
    const client = new SkillsDirectoryClient({ fetch, maxAttempts: 1 });
    await expect(client.detail('mintlify.com/mintlify')).rejects.toMatchObject({ code: 'not_found', status: 404 });
    expect(() => new SkillsDirectoryClient({ baseURL: 'http://skills.invalid', fetch })).toThrowError(/baseURL/iu);
  });

  it('accepts safe root-relative page URLs from a configured API origin', async () => {
    const fetch = vi.fn(async () => response({
      data: [{ ...skill, url: '/site/vercel-labs/skills/find-skills' }],
      pagination: { page: 0, perPage: 100, total: 1, hasMore: false },
    }));
    const client = new SkillsDirectoryClient({ baseURL: 'https://directory.example.test', fetch });
    const result = await client.list();
    expect(result.data[0]?.url).toBe('https://directory.example.test/site/vercel-labs/skills/find-skills');
  });

  it('preserves well-known source metadata and alternate skills.sh page hosts', async () => {
    const fetch = vi.fn(async () => response({
      data: [{
        id: 'open.feishu.cn/lark-doc',
        slug: 'lark-doc',
        name: 'lark-doc',
        source: 'open.feishu.cn',
        installs: 675_505,
        sourceType: 'well-known',
        installUrl: null,
        url: 'https://www.skills.sh/site/open.feishu.cn/lark-doc',
      }],
      pagination: { page: 0, perPage: 100, total: 1, hasMore: false },
    }));
    const client = new SkillsDirectoryClient({ fetch });
    const result = await client.list();
    expect(result.data[0]).toMatchObject({ sourceType: 'well-known', installUrl: null, installs: 675_505 });
  });

  it('cancels a never-closing response stream at the request deadline', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const client = new SkillsDirectoryClient({
      fetch: vi.fn(async () => new Response(stream)),
      maxAttempts: 1,
      requestTimeoutMs: 10,
    });

    await expect(client.list()).rejects.toMatchObject({ code: 'request_timeout' });
    expect(cancelled).toBe(true);
  });
});
