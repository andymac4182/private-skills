import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  BUILT_IN_GITHUB_REPOSITORIES,
  GitHubSourceAdapter,
  createGitHubSourceAdapters,
} from '../src/adapters/github.js';
import { TesslSourceAdapter } from '../src/adapters/tessl.js';

const GITHUB_REPOSITORY = BUILT_IN_GITHUB_REPOSITORIES['github-openai-skills'];
const GITHUB_COMMIT = 'a'.repeat(40);
const GITHUB_TREE = 'b'.repeat(40);
const GITHUB_SKILL_PATH = 'skills/review/SKILL.md';
const GITHUB_SKILL = `---\nname: review-helper\ndescription: Review pull requests carefully.\n---\n\n# Instructions\n`;

function githubBlobIdentity(content: string): { bytes: Uint8Array; sha: string } {
  const bytes = new TextEncoder().encode(content);
  const framing = Buffer.concat([Buffer.from(`blob ${bytes.byteLength}\u0000`), Buffer.from(bytes)]);
  return { bytes, sha: createHash('sha1').update(framing).digest('hex') };
}

function jsonResponse(value: unknown, status = 200, contentType = 'application/json'): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': contentType } });
}

function githubFetchFixture(options: { globalSearch?: boolean } = {}): {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  calls: Array<{ url: URL; init?: RequestInit }>;
  blobSha: string;
} {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const blob = githubBlobIdentity(GITHUB_SKILL);
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input.toString());
    calls.push({ url, init });
    if (url.pathname === '/search/code') {
      if (!options.globalSearch) return jsonResponse({ message: 'unexpected code search' }, 500);
      return jsonResponse({
        total_count: 1,
        incomplete_results: false,
        items: [{
          path: GITHUB_SKILL_PATH,
          sha: blob.sha,
          // GitHub returns the search result's human URL with a branch/ref;
          // the blob SHA is the immutable field used for verification.
          html_url: `https://github.com/${GITHUB_REPOSITORY}/blob/main/${GITHUB_SKILL_PATH}`,
          repository: { private: false, full_name: GITHUB_REPOSITORY },
        }],
      });
    }
    const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/u.exec(url.pathname);
    if (!repoMatch) return jsonResponse({ message: 'not found' }, 404);
    const repository = `${repoMatch[1]}/${repoMatch[2]}`;
    const rest = repoMatch[3] ?? '';
    if (rest === '') return jsonResponse({ private: false, default_branch: 'main', full_name: repository });
    if (rest === 'commits/main' || rest === `commits/${GITHUB_COMMIT}`) return jsonResponse({ sha: GITHUB_COMMIT });
    if (rest === `git/trees/${GITHUB_COMMIT}`) return jsonResponse({ truncated: false, sha: GITHUB_TREE, tree: [{ path: GITHUB_SKILL_PATH, type: 'blob', sha: blob.sha, size: blob.bytes.byteLength }] });
    if (rest === `git/blobs/${blob.sha}`) return jsonResponse({ sha: blob.sha, size: blob.bytes.byteLength, encoding: 'base64', content: Buffer.from(blob.bytes).toString('base64') });
    return jsonResponse({ message: 'not found' }, 404);
  };
  return { fetch, calls, blobSha: blob.sha };
}

describe('GitHub source adapters', () => {
  it('discovers and resolves an exact curated repository skill through the public tree/blob fallback', async () => {
    const fixture = githubFetchFixture();
    const adapter = new GitHubSourceAdapter({ id: 'github-openai-skills', fetch: fixture.fetch });
    const rows = await adapter.search({ query: 'review', limit: 5, organizationId: 'org' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceId: 'github-openai-skills',
      externalId: `github:${GITHUB_REPOSITORY}@${GITHUB_COMMIT}#skills/review`,
      repository: GITHUB_REPOSITORY,
      path: 'skills/review',
      ref: GITHUB_COMMIT,
      installable: true,
    });
    const resolved = await adapter.resolve({ sourceId: adapter.id, externalId: rows[0]!.externalId, organizationId: 'org' });
    expect(resolved.acquisition).toMatchObject({
      kind: 'github',
      repository: GITHUB_REPOSITORY,
      path: 'skills/review',
      ref: GITHUB_COMMIT,
      contentDigest: rows[0]!.snapshotDigest,
    });
    expect(resolved.row.externalId).toBe(rows[0]!.externalId);
    expect(fixture.calls.every(({ url }) => url.origin === 'https://api.github.com')).toBe(true);
    expect(fixture.calls.every(({ init }) => init?.redirect === 'error')).toBe(true);
  });

  it('keeps global code search public and sends the optional token only to code search', async () => {
    const fixture = githubFetchFixture({ globalSearch: true });
    const adapter = new GitHubSourceAdapter({ id: 'github-code-search', token: 'server-token', fetch: fixture.fetch });
    expect(adapter.availability({ organizationId: 'org' }).state).toBe('available');
    const rows = await adapter.search({ query: 'review', limit: 1, organizationId: 'org' });
    expect(rows[0]?.repository).toBe(GITHUB_REPOSITORY);
    const searchCall = fixture.calls.find(({ url }) => url.pathname === '/search/code');
    expect(searchCall?.url.searchParams.get('q')).toContain('is:public');
    expect(searchCall?.init?.headers).toMatchObject({ Authorization: 'Bearer server-token' });
    const nonSearchCalls = fixture.calls.filter(({ url }) => url.pathname !== '/search/code');
    expect(nonSearchCalls.every(({ init }) => !(init?.headers as Record<string, string> | undefined)?.Authorization)).toBe(true);
  });

  it('always describes the global and custom sources, with safe unavailable states when unconfigured', () => {
    const adapters = createGitHubSourceAdapters({ env: {} });
    expect(adapters.map((adapter) => adapter.id)).toEqual([
      'github-code-search',
      'github-openai-skills',
      'github-anthropics-skills',
      'github-google-skills',
      'github-vercel-agent-skills',
      'github-custom',
    ]);
    expect(adapters[0]!.availability({ organizationId: 'org' })).toMatchObject({ state: 'unavailable', code: 'MISSING_TOKEN' });
    expect(adapters.at(-1)!.availability({ organizationId: 'org' })).toMatchObject({ state: 'unavailable', code: 'NO_REPOSITORIES' });
  });

  it('does not allow a curated adapter to resolve a repository outside its configured set', async () => {
    const adapter = new GitHubSourceAdapter({ id: 'github-openai-skills', fetch: githubFetchFixture().fetch });
    await expect(adapter.resolve({
      sourceId: adapter.id,
      externalId: 'github:someone/else@main#skills/review',
      organizationId: 'org',
    })).rejects.toMatchObject({ code: 'SOURCE_INVALID_EXTERNAL_ID' });
  });
});

const TESSL_WORKSPACE = 'demo';
const TESSL_TILE = 'review';
const TESSL_VERSION = '1.2.3';
const TESSL_FINGERPRINT = 'c'.repeat(64);
const TESSL_SKILL_FILE = 'skills/reviewer/SKILL.md';

function tesslSearchPayload(skillPaths: readonly string[] = [TESSL_SKILL_FILE]): Record<string, unknown> {
  return {
    links: { self: 'https://api.tessl.io/experimental/search', first: 'https://api.tessl.io/experimental/search', last: null, next: null, prev: null },
    meta: { pagination: { total: 1, pages: 1, number: 1, size: 20 } },
    data: [{
      id: '00000000-0000-0000-0000-000000000001',
      type: 'tile',
      attributes: {
        name: TESSL_TILE,
        fullName: `${TESSL_WORKSPACE}/${TESSL_TILE}`,
        isPrivate: false,
        scores: { version: TESSL_VERSION },
        versions: [{
          fingerprint: TESSL_FINGERPRINT,
          version: TESSL_VERSION,
          hasSkills: true,
          archived: false,
          summary: 'Review skills from Tessl.',
          skills: skillPaths.map((path) => ({ path, name: 'reviewer', description: 'Review with a Tessl skill.' })),
        }],
      },
      relationships: { workspace: { data: { id: '00000000-0000-0000-0000-000000000002', type: 'workspace', attributes: { name: TESSL_WORKSPACE } } } },
    }],
  };
}

function tesslVersionPayload(): Record<string, unknown> {
  return {
    links: { self: `https://api.tessl.io/v1/tiles/${TESSL_WORKSPACE}/${TESSL_TILE}/versions/${TESSL_VERSION}` },
    data: {
      id: '00000000-0000-0000-0000-000000000003',
      type: 'tile-version',
      attributes: {
        fingerprint: TESSL_FINGERPRINT,
        version: TESSL_VERSION,
        hasSkills: true,
        archived: false,
        summary: 'Review skills from Tessl.',
        moderationStatus: 'pass',
        moderationPassed: true,
      },
    },
  };
}

function tesslFetchFixture(options: { paths?: readonly string[]; html?: boolean } = {}): {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  calls: Array<{ url: URL; init?: RequestInit }>;
} {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const paths = options.paths ?? [TESSL_SKILL_FILE];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input.toString());
    calls.push({ url, init });
    if (options.html) return new Response('<html>not a tile</html>', { headers: { 'content-type': 'text/html' } });
    if (url.pathname === '/experimental/search') return jsonResponse(tesslSearchPayload(paths));
    if (url.pathname.endsWith(`/versions/${TESSL_VERSION}`)) return jsonResponse(tesslVersionPayload());
    if (url.pathname.endsWith(`/versions/${TESSL_VERSION}/files`)) {
      return jsonResponse({ links: { self: url.href, next: null, prev: null }, meta: { count: paths.length }, data: paths.map((path, index) => ({ id: String(index), type: 'file', attributes: { path } })) });
    }
    return jsonResponse({ error: 'not found' }, 404);
  };
  return { fetch, calls };
}

describe('Tessl source adapter', () => {
  it('uses documented JSON search and manifest endpoints and emits a native Tessl acquisition', async () => {
    const fixture = tesslFetchFixture();
    const adapter = new TesslSourceAdapter({ fetch: fixture.fetch });
    const rows = await adapter.search({ query: 'review', limit: 5, organizationId: 'org' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceId: 'tessl',
      externalId: `tessl:${TESSL_WORKSPACE}/${TESSL_TILE}@${TESSL_VERSION}#${TESSL_SKILL_FILE}`,
      path: 'skills/reviewer',
      version: TESSL_VERSION,
      installable: true,
    });
    const resolved = await adapter.resolve({ sourceId: 'tessl', externalId: rows[0]!.externalId, organizationId: 'org' });
    expect(resolved.acquisition).toEqual({
      kind: 'tessl',
      workspace: TESSL_WORKSPACE,
      tile: TESSL_TILE,
      version: TESSL_VERSION,
      fingerprint: TESSL_FINGERPRINT,
      skillPath: 'skills/reviewer',
      sourceProviderOrigin: 'https://api.tessl.io',
    });
    expect(fixture.calls.every(({ url }) => url.origin === 'https://api.tessl.io')).toBe(true);
    expect(fixture.calls.every(({ init }) => init?.redirect === 'error')).toBe(true);
    const filesCall = fixture.calls.find(({ url }) => url.pathname.endsWith('/files'));
    expect(filesCall?.init?.headers).toMatchObject({ accept: 'application/json' });
  });

  it('requires an explicit skill path when a tile contains multiple SKILL.md files', async () => {
    const fixture = tesslFetchFixture({ paths: ['skills/one/SKILL.md', 'skills/two/SKILL.md'] });
    const adapter = new TesslSourceAdapter({ fetch: fixture.fetch });
    await expect(adapter.resolve({ sourceId: 'tessl', externalId: `tessl:${TESSL_WORKSPACE}/${TESSL_TILE}@${TESSL_VERSION}`, organizationId: 'org' })).rejects.toMatchObject({ code: 'SOURCE_RESOLUTION_INVALID' });
  });

  it('rejects HTML or other registry pages instead of treating them as a Tessl bundle', async () => {
    const adapter = new TesslSourceAdapter({ fetch: tesslFetchFixture({ html: true }).fetch });
    await expect(adapter.search({ query: 'review', organizationId: 'org' })).rejects.toMatchObject({ code: 'SOURCE_RESOLUTION_INVALID' });
  });
});
