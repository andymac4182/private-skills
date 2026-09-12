import { describe, expect, it, vi } from 'vitest';

import {
  classifyNestedDetailFallback,
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
    expect(result.data[0]).toMatchObject({ provider: 'skills.sh', sourceStatus: 'metadata-only', feedName: null });
    expect(result.data[0]?.fetchedAt).toEqual(expect.any(String));
    expect(String(fetch.mock.calls[0]?.[0])).toBe('https://skills.sh/api/v1/skills/search?q=react+native&limit=5&owner=expo');
    await expect(client.search({ q: 'x' })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(client.list({ perPage: 501 })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('assigns bounded server-owned provenance instead of trusting upstream fields', async () => {
    const now = Date.parse('2026-04-20T12:34:56.000Z');
    const fetch = vi.fn(async () => response({
      data: [{
        ...skill,
        provider: 'attacker.example',
        fetchedAt: '2000-01-01T00:00:00.000Z',
        sourceStatus: 'source-resolved',
        sourceReason: 'approved by an upstream party',
        feedName: 'untrusted-feed',
      }],
      pagination: { page: 0, perPage: 100, total: 1, hasMore: false },
    }));
    const client = new SkillsDirectoryClient({ fetch, now: () => now, cache: false });

    const result = await client.list();
    const row = result.data[0]!;
    expect(row).toMatchObject({
      provider: 'skills.sh',
      fetchedAt: '2026-04-20T12:34:56.000Z',
      sourceStatus: 'metadata-only',
      feedName: null,
    });
    expect(row.sourceReason).toBe('Catalog metadata has no validated source snapshot; source resolution may still be available.');
    expect(JSON.stringify(row)).not.toContain('attacker.example');
    expect(JSON.stringify(row)).not.toContain('untrusted-feed');
    expect(JSON.stringify(row)).not.toContain('approved by an upstream party');
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
          }, {
            provider: 'Agent Trust Hub',
            slug: 'agent-trust-hub',
            status: 'pass',
            summary: 'No risks detected',
            auditedAt: '2026-04-15T12:00:00.000Z',
            riskLevel: 'SAFE',
            categories: ['NO_CODE'],
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
    expect(curated.data[0]?.skills[0]).toMatchObject({ provider: 'skills.sh', sourceStatus: 'metadata-only', feedName: null });
    expect(detail.files).toBeNull();
    expect(detail.hash).toBeNull();
    expect(detail).toMatchObject({ provider: 'skills.sh', sourceStatus: 'metadata-only', feedName: null });
    expect(detail.sourceReason).toBe('Catalog metadata has no validated source snapshot; source resolution may still be available.');
    expect(audits.audits[0]?.provider).toBe('Socket');
    expect(audits.audits[0]?.status).toBe('pass');
    expect(audits.audits[0]?.riskLevel).toBeNull();
    expect(audits.audits[0]?.categories).toBeNull();
    expect(audits.audits[1]?.riskLevel).toBe('SAFE');
    expect(audits.audits[1]?.categories).toEqual(['NO_CODE']);
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
    expect(detail).toMatchObject({ provider: 'skills.sh', sourceStatus: 'snapshot-available', feedName: null });

    const emptySnapshotClient = new SkillsDirectoryClient({
      fetch: vi.fn(async () => response({
        id: skill.id,
        source: skill.source,
        slug: skill.slug,
        installs: 1,
        hash: 'empty-snapshot',
        files: [],
      })),
    });
    const emptySnapshot = await emptySnapshotClient.detail(skill.id);
    expect(emptySnapshot).toMatchObject({ provider: 'skills.sh', sourceStatus: 'metadata-only', feedName: null });
    expect(emptySnapshot.sourceReason).toBe('skills.sh returned no source files; source resolution is required.');

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

  it('supports bounded nested slugs for GitHub and well-known identities', async () => {
    const githubSkill = {
      id: 'claude-office-skills/skills/facebook/meta-ads',
      slug: 'facebook/meta-ads',
      name: 'meta-ads',
      source: 'claude-office-skills/skills',
      installs: 240,
      sourceType: 'github' as const,
      installUrl: 'https://github.com/claude-office-skills/skills',
      url: 'https://skills.sh/claude-office-skills/skills/facebook/meta-ads',
    };
    const wellKnownSkill = {
      id: 'example.com/team/tool',
      slug: 'team/tool',
      name: 'tool',
      source: 'example.com',
      installs: 12,
      sourceType: 'well-known' as const,
      installUrl: null,
      url: 'https://skills.sh/example.com/team/tool',
    };
    const fetch = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/audit/')) {
        return response({
          id: githubSkill.id,
          source: githubSkill.source,
          slug: githubSkill.slug,
          audits: [{
            provider: 'Socket',
            slug: 'socket',
            status: 'pass',
            summary: 'No alerts',
            auditedAt: '2026-04-15T12:05:00.000Z',
          }],
        });
      }
      if (url.includes('/claude-office-skills/skills/facebook/meta-ads')) {
        return response({
          id: githubSkill.id,
          source: githubSkill.source,
          slug: githubSkill.slug,
          installs: githubSkill.installs,
          hash: null,
          files: null,
        });
      }
      return response({
        data: [githubSkill, wellKnownSkill],
        pagination: { page: 0, perPage: 100, total: 2, hasMore: false },
      });
    });
    const client = new SkillsDirectoryClient({ fetch });

    const listed = await client.list();
    const detail = await client.detail(githubSkill.id);
    const audits = await client.audit(githubSkill.id);

    expect(listed.data.map((entry) => entry.id)).toEqual([githubSkill.id, wellKnownSkill.id]);
    expect(listed.data[1]).toMatchObject({ sourceType: 'well-known', source: 'example.com', slug: 'team/tool' });
    expect(detail).toMatchObject({ id: githubSkill.id, source: githubSkill.source, slug: githubSkill.slug });
    expect(audits).toMatchObject({ id: githubSkill.id, source: githubSkill.source, slug: githubSkill.slug });
    expect(String(fetch.mock.calls[1]?.[0])).toBe('https://skills.sh/api/v1/skills/claude-office-skills/skills/facebook/meta-ads');
    expect(String(fetch.mock.calls[2]?.[0])).toBe('https://skills.sh/api/v1/skills/audit/claude-office-skills/skills/facebook/meta-ads');
  });

  it('rejects nested traversal, encoded delimiters, and excessive identifier depth', async () => {
    const fetch = vi.fn(async () => response({}));
    const client = new SkillsDirectoryClient({ fetch });
    const tooDeep = Array.from({ length: 65 }, (_, index) => `segment-${index}`).join('/');
    for (const id of [
      'claude-office-skills/skills/facebook/../meta-ads',
      'claude-office-skills/skills/facebook/%2e%2e/meta-ads',
      'claude-office-skills/skills/facebook/%252fmeta-ads',
      'claude-office-skills/skills/facebook//meta-ads',
      tooDeep,
    ]) {
      await expect(client.detail(id)).rejects.toMatchObject({ code: 'invalid_input' });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects lone surrogates before URL encoding but preserves paired Unicode IDs', async () => {
    const invalidFetch = vi.fn(async () => response({}));
    const invalidClient = new SkillsDirectoryClient({ fetch: invalidFetch });
    await expect(invalidClient.detail('example.com/\ud800')).rejects.toMatchObject({ code: 'invalid_input' });
    expect(invalidFetch).not.toHaveBeenCalled();

    const validId = 'example.com/😀';
    const validFetch = vi.fn(async (input: string | URL) => {
      expect(String(input)).toBe('https://skills.sh/api/v1/skills/example.com/%F0%9F%98%80');
      return response({ id: validId, source: 'example.com', slug: '😀', installs: 1, hash: null, files: null });
    });
    const validClient = new SkillsDirectoryClient({ fetch: validFetch });
    await expect(validClient.detail(validId)).resolves.toMatchObject({ id: validId, source: 'example.com', slug: '😀' });
  });

  it('preserves bounded pagination metadata across pages and accepts duplicate, null-snapshot, and well-known rows', async () => {
    const duplicate = {
      id: 'catalog-owner/skills/facebook/meta-ads',
      slug: 'facebook/meta-ads',
      name: 'meta-ads',
      source: 'catalog-owner/skills',
      installs: 320,
      sourceType: 'github' as const,
      installUrl: 'https://github.com/catalog-owner/skills',
      url: 'https://skills.sh/catalog-owner/skills/facebook/meta-ads',
    };
    const nullSnapshotWellKnown = {
      id: 'open.feishu.cn/lark-doc',
      slug: 'lark-doc',
      name: 'lark-doc',
      source: 'open.feishu.cn',
      installs: 675_505,
      sourceType: 'well-known' as const,
      installUrl: null,
      url: 'https://www.skills.sh/site/open.feishu.cn/lark-doc',
      files: null,
    };
    const pages = new Map([
      [0, { data: [duplicate], pagination: { page: 0, perPage: 2, total: 3, hasMore: true } }],
      [1, { data: [nullSnapshotWellKnown, duplicate], pagination: { page: 1, perPage: 2, total: 3, hasMore: true } }],
      [2, { data: [], pagination: { page: 2, perPage: 2, total: 3, hasMore: false } }],
    ]);
    const fetch = vi.fn(async (input: string | URL) => {
      const page = Number(new URL(String(input)).searchParams.get('page'));
      const fixture = pages.get(page);
      if (!fixture) throw new Error(`unexpected page ${page}`);
      return response(fixture);
    });
    const client = new SkillsDirectoryClient({ fetch });

    const first = await client.list({ page: 0, perPage: 2 });
    const second = await client.list({ page: 1, perPage: 2 });
    const third = await client.list({ page: 2, perPage: 2 });

    expect(first.pagination).toEqual({ page: 0, perPage: 2, total: 3, hasMore: true });
    expect(second.pagination).toEqual({ page: 1, perPage: 2, total: 3, hasMore: true });
    expect(third.pagination).toEqual({ page: 2, perPage: 2, total: 3, hasMore: false });
    expect(first.data[0]?.id).toBe('catalog-owner/skills/facebook/meta-ads');
    expect(second.data[1]?.id).toBe(first.data[0]?.id);
    expect(second.data[0]).toMatchObject({
      id: 'open.feishu.cn/lark-doc',
      source: 'open.feishu.cn',
      slug: 'lark-doc',
      sourceType: 'well-known',
      installUrl: null,
    });
    expect(second.data[0]).not.toHaveProperty('files');
    expect(fetch).toHaveBeenCalledTimes(3);
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

  it('caches normalized metadata per client while authenticating every lookup', async () => {
    let tokenNumber = 0;
    const getToken = vi.fn(async () => `request-token-${++tokenNumber}`);
    const fetch = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer request-token-1');
      return response({
        data: [{ ...skill }],
        pagination: { page: 0, perPage: 100, total: 1, hasMore: false },
      });
    });
    const client = new SkillsDirectoryClient({ fetch, getToken });

    const first = await client.list();
    first.data[0]!.name = 'mutated by caller';
    const second = await client.list();

    expect(second.data[0]?.name).toBe(skill.name);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(client.cacheStats()).toMatchObject({ hits: 1, misses: 1, stores: 1, entries: 1, totalBytes: expect.any(Number) });
  });

  it('stamps fetchedAt once and preserves it across coalesced and warm reads', async () => {
    let now = Date.parse('2026-04-20T12:00:00.000Z');
    let releaseResponse!: () => void;
    const responseReady = new Promise<void>((resolve) => { releaseResponse = resolve; });
    const fetch = vi.fn(async () => {
      await responseReady;
      return response({
        data: [{ ...skill }],
        pagination: { page: 0, perPage: 100, total: 1, hasMore: false },
      });
    });
    const client = new SkillsDirectoryClient({
      fetch,
      now: () => now,
      cache: { now: () => now },
    });

    const firstPromise = client.list();
    await Promise.resolve();
    const secondPromise = client.list();
    releaseResponse();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(first.data[0]?.fetchedAt).toBe('2026-04-20T12:00:00.000Z');
    expect(second.data[0]?.fetchedAt).toBe(first.data[0]?.fetchedAt);

    now += 5_000;
    const warm = await client.list();
    expect(warm.data[0]?.fetchedAt).toBe(first.data[0]?.fetchedAt);
    expect(client.cacheStats()).toMatchObject({ hits: 1, coalesced: 1, stores: 1 });
    expect(client.cacheStats()?.cached[0]?.ageMs).toBe(5_000);
  });

  it('keeps the metadata wall clock independent from a monotonic cache clock', async () => {
    const fetch = vi.fn(async () => response({
      data: [{ ...skill }],
      pagination: { page: 0, perPage: 100, total: 1, hasMore: false },
    }));
    const client = new SkillsDirectoryClient({ fetch, cache: { now: () => 12_345 } });

    const result = await client.list();
    const fetchedAt = result.data[0]?.fetchedAt;
    expect(fetchedAt).toEqual(expect.any(String));
    expect(Date.parse(fetchedAt!)).toBeGreaterThan(1_000_000_000_000);
    expect(fetchedAt).not.toBe(new Date(12_345).toISOString());
  });

  it('does not cache detail snapshots while keeping each request authenticated', async () => {
    let responseNumber = 0;
    const getToken = vi.fn(async () => `detail-token-${responseNumber + 1}`);
    const fetch = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const authorization = (init?.headers as Record<string, string>).authorization;
      const current = responseNumber;
      responseNumber += 1;
      expect(authorization).toBe(`Bearer detail-token-${current + 1}`);
      return response({
        id: skill.id,
        source: skill.source,
        slug: skill.slug,
        installs: current + 1,
        hash: current === 0 ? 'snapshot-one' : null,
        files: current === 0 ? [{ path: 'SKILL.md', contents: '---\nname: find-skills\ndescription: first snapshot\n---\n' }] : null,
      });
    });
    const client = new SkillsDirectoryClient({ fetch, getToken });

    const first = await client.detail(skill.id);
    const second = await client.detail(skill.id);

    expect(first.files?.[0]?.contents).toContain('first snapshot');
    expect(second.files).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(client.cacheStats()).toMatchObject({ hits: 0, misses: 0, stores: 0, entries: 0, totalBytes: 0 });
    expect(client.cacheStats()?.cached).toEqual([]);
  });

  it('fails a warm lookup when its fresh credential provider fails', async () => {
    let unavailable = false;
    const getToken = vi.fn(async () => {
      if (unavailable) throw new Error('credential-secret-must-not-escape');
      return 'request-token';
    });
    const fetch = vi.fn(async () => response({
      data: [{ ...skill }],
      pagination: { page: 0, perPage: 100, total: 1, hasMore: false },
    }));
    const client = new SkillsDirectoryClient({ fetch, getToken });

    await client.list();
    unavailable = true;
    const error = await client.list().catch((value: unknown) => value);

    expect(error).toMatchObject({ code: 'unavailable' });
    expect((error as Error).message).not.toContain('credential-secret-must-not-escape');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(client.cacheStats()).toMatchObject({ authFailures: 1, hits: 0, stores: 1 });
  });

  it('allows explicit cache disabling without changing request semantics', async () => {
    const fetch = vi.fn(async () => response({
      data: [{ ...skill }],
      pagination: { page: 0, perPage: 100, total: 1, hasMore: false },
    }));
    const client = new SkillsDirectoryClient({ fetch, cache: false });

    await client.list();
    await client.list();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(client.cacheStats()).toBeNull();
  });

  it('bypasses only the cache for valid queries whose encoded identity is too large', async () => {
    const longAscii = 'a'.repeat(12_000);
    const unicodeQuery = '😀'.repeat(1_500);
    const invalidQuery = 'b'.repeat(17_000);
    let tokenNumber = 0;
    const events: unknown[] = [];
    const getToken = vi.fn(async () => `long-query-token-${++tokenNumber}`);
    const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const query = new URL(String(input)).searchParams.get('q');
      expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer long-query-token-${tokenNumber}`);
      return response({
        data: [{ ...skill }],
        query,
        searchType: 'fuzzy',
        count: 1,
        durationMs: 1,
      });
    });
    const client = new SkillsDirectoryClient({
      fetch,
      getToken,
      maxAttempts: 1,
      cache: { observe: (event) => events.push(event) },
    });

    await expect(client.search({ q: longAscii })).resolves.toMatchObject({ query: longAscii });
    await expect(client.search({ q: longAscii })).resolves.toMatchObject({ query: longAscii });
    await expect(client.search({ q: unicodeQuery })).resolves.toMatchObject({ query: unicodeQuery });
    await expect(client.search({ q: invalidQuery })).rejects.toMatchObject({ code: 'invalid_input' });

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(getToken).toHaveBeenCalledTimes(3);
    expect(events).toEqual([]);
    expect(JSON.stringify({ events, stats: client.cacheStats() })).not.toContain('long-query-token');
    expect(JSON.stringify({ events, stats: client.cacheStats() })).not.toContain(longAscii);
  });

  it('finds a fresh exact nested row without using the shared metadata cache', async () => {
    const nested = {
      ...skill,
      id: 'claude-office-skills/skills/facebook/meta-ads',
      source: 'claude-office-skills/skills',
      slug: 'facebook/meta-ads',
      name: 'meta-ads',
    };
    let tokenNumber = 0;
    const getToken = vi.fn(async () => `fresh-token-${++tokenNumber}`);
    const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer fresh-token-${tokenNumber}`);
      const url = new URL(String(input));
      expect(url.pathname).toBe('/api/v1/skills/search');
      expect(url.searchParams.get('q')).toBe(nested.id);
      expect(url.searchParams.get('limit')).toBe('200');
      return response({ data: [nested], query: nested.id, searchType: 'fuzzy', count: 1, durationMs: 1 });
    });
    const client = new SkillsDirectoryClient({ fetch, getToken });

    const first = await client.findExact(nested.id);
    const second = await client.findExact(nested.id);

    expect(first).toMatchObject({ id: nested.id, source: nested.source, slug: nested.slug, feedName: null });
    expect(second.id).toBe(nested.id);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(client.cacheStats()).toMatchObject({ hits: 0, misses: 0, stores: 0, entries: 0 });
  });

  it('walks bounded list pages when search does not return the exact nested row', async () => {
    const nested = {
      ...skill,
      id: 'catalog-owner/skills/facebook/meta-ads',
      source: 'catalog-owner/skills',
      slug: 'facebook/meta-ads',
      name: 'meta-ads',
    };
    const fetch = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/search')) {
        return response({ data: [], query: url.searchParams.get('q'), searchType: 'fuzzy', count: 0, durationMs: 1 });
      }
      const page = Number(url.searchParams.get('page'));
      return response({
        data: page === 1 ? [nested] : [],
        pagination: { page, perPage: 500, total: 1, hasMore: page === 0 },
      });
    });
    const client = new SkillsDirectoryClient({ fetch, cache: false });

    await expect(client.findExact(nested.id)).resolves.toMatchObject({ id: nested.id, source: nested.source, slug: nested.slug });
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      'https://skills.sh/api/v1/skills/search?q=catalog-owner%2Fskills%2Ffacebook%2Fmeta-ads&limit=200',
      'https://skills.sh/api/v1/skills/search?q=meta-ads&limit=200',
      'https://skills.sh/api/v1/skills?view=all-time&page=0&per_page=500',
      'https://skills.sh/api/v1/skills?view=all-time&page=1&per_page=500',
    ]);
  });

  it('classifies only nested detail route failures eligible for exact-row recovery', async () => {
    const nested = 'catalog-owner/skills/facebook/meta-ads';
    expect(classifyNestedDetailFallback(new SkillsDirectoryError('http_error', 'rejected', { status: 400 }), nested)).toBeUndefined();
    expect(classifyNestedDetailFallback(new SkillsDirectoryError('http_error', 'rejected', { status: 400, detailInvalidPath: true }), nested)).toBe('invalid_path');
    expect(classifyNestedDetailFallback(new SkillsDirectoryError('not_found', 'missing', { status: 404 }), nested)).toBe('not_found');
    expect(classifyNestedDetailFallback(new SkillsDirectoryError('invalid_response', 'wrong', { detailIdentityMismatch: true }), nested)).toBe('identity_mismatch');
    expect(classifyNestedDetailFallback(new SkillsDirectoryError('unavailable', 'temporary', { status: 503 }), nested)).toBeUndefined();
    expect(classifyNestedDetailFallback(new SkillsDirectoryError('unauthorized', 'denied', { status: 401 }), nested)).toBeUndefined();
    expect(classifyNestedDetailFallback(new SkillsDirectoryError('http_error', 'rejected', { status: 400 }), 'owner/repo')).toBeUndefined();
  });

  it('rejects a list response whose page does not match the requested exact lookup page', async () => {
    const nested = 'catalog-owner/skills/facebook/meta-ads';
    const fetch = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/search')) {
        return response({ data: [], query: url.searchParams.get('q'), searchType: 'fuzzy', count: 0, durationMs: 1 });
      }
      return response({
        data: [],
        pagination: { page: 9, perPage: 500, total: 0, hasMore: false },
      });
    });
    const client = new SkillsDirectoryClient({ fetch, cache: false });

    await expect(client.findExact(nested)).rejects.toMatchObject({ code: 'invalid_response' });
  });
});
