import { describe, expect, it } from 'vitest';

import {
  ClawHubAdapter,
  PolySkillAdapter,
  SkillHubProAdapter,
  SkillHubPublicAdapter,
  SkillsDirectoryAdapter,
  SkillsMpAdapter,
  createRegistrySourceAdapters,
  type VerifiedGithubIdentity,
} from '../src/adapters/registries.js';

const COMMIT = 'c'.repeat(40);
const HASH = 'a'.repeat(64);

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function request(input: RequestInfo | URL, init?: RequestInit): { url: URL; init?: RequestInit } {
  return { url: new URL(input.toString()), init };
}

function resolvedGithub(identity: { repository: string; path?: string; ref?: string; skillHint?: string }): VerifiedGithubIdentity {
  return {
    repository: identity.repository,
    path: identity.path ?? '',
    ref: COMMIT,
    sourceUrl: `https://github.com/${identity.repository}/tree/${COMMIT}${identity.path ? `/${identity.path}` : ''}`,
  };
}

const commonRequest = { query: 'testing', limit: 5, organizationId: 'org' } as const;

describe('external registry source adapters', () => {
  it('constructs all six adapters in stable order and scopes factory credentials', () => {
    const adapters = createRegistrySourceAdapters({
      env: {},
      // A legacy common key must not be broadcast to all providers.
      apiKey: 'wrong-common-key',
      apiKeys: { skillsmp: 'skillsmp-key', 'skillhub-pro': 'skillhub-pro-key' },
    });
    expect(adapters.map((adapter) => adapter.id)).toEqual([
      'skillsmp',
      'clawhub',
      'skillhub-public',
      'polyskill',
      'skills-directory',
      'skillhub-pro',
    ]);
    expect(adapters.find((adapter) => adapter.id === 'skillsmp')?.availability({ organizationId: 'org' })).toEqual({ state: 'available' });
    expect(adapters.find((adapter) => adapter.id === 'clawhub')?.availability({ organizationId: 'org' })).toEqual({ state: 'available' });
    expect(adapters.find((adapter) => adapter.id === 'skills-directory')?.availability({ organizationId: 'org' })).toMatchObject({ state: 'unavailable', code: 'auth_missing' });
    expect(adapters.find((adapter) => adapter.id === 'skillhub-pro')?.availability({ organizationId: 'org' })).toEqual({ state: 'available' });
  });

  it('does not borrow an ambient required credential when env is explicitly empty', () => {
    const key = 'SKILLS_DIRECTORY_API_KEY';
    const previous = process.env[key];
    process.env[key] = 'ambient-secret';
    try {
      expect(new SkillsDirectoryAdapter({ env: {} }).availability({ organizationId: 'org' })).toMatchObject({
        state: 'unavailable',
        code: 'auth_missing',
      });
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  it('resolves a SkillsMP GitHub record by bounded re-search and keeps the key at its origin', async () => {
    const calls: Array<{ url: URL; init?: RequestInit }> = [];
    const record = {
      id: 'skillsmp-testing-id',
      name: 'testing',
      description: 'Testing skill',
      githubUrl: 'https://github.com/acme/skills/tree/main/skills/testing/SKILL.md',
      stars: 7,
    };
    const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push(request(input, init));
      return jsonResponse({ success: true, data: { skills: [record] } });
    };
    const adapter = new SkillsMpAdapter({
      env: { SKILLSMP_API_KEY: 'skillsmp-secret' },
      fetch,
      githubResolver: async (identity) => {
        expect(identity).toMatchObject({ repository: 'acme/skills', path: 'skills/testing', ref: 'main', skillHint: 'testing' });
        return resolvedGithub(identity);
      },
    });
    const rows = await adapter.search(commonRequest);
    expect(rows[0]).toMatchObject({
      sourceId: 'skillsmp',
      title: 'testing',
      externalId: expect.stringMatching(/^pskills-lookup-v1:/u),
      repository: 'acme/skills',
      path: 'skills/testing',
      installable: true,
    });
    const resolved = await adapter.resolve({ sourceId: 'skillsmp', externalId: rows[0]!.externalId, organizationId: 'org' });
    expect(resolved.acquisition).toMatchObject({ kind: 'github', repository: 'acme/skills', path: 'skills/testing', ref: COMMIT });
    expect(calls.every(({ url }) => url.origin === 'https://skillsmp.com')).toBe(true);
    expect(calls.every(({ init }) => (init?.headers as Headers).get('authorization') === 'Bearer skillsmp-secret')).toBe(true);
  });

  it('filters ClawHub unified skills.sh rows and resolves the native version manifest', async () => {
    const calls: Array<{ url: URL; init?: RequestInit }> = [];
    const searchRows = [
      { id: 'skills-sh:acme/repo/testing', source: 'skills-sh', slug: 'testing', ownerHandle: 'acme' },
      {
        id: 'clawhub:opaque-id',
        source: 'clawhub',
        slug: 'e2e-testing-patterns',
        ownerHandle: 'wpank',
        install: { kind: 'clawhub', reference: 'wpank/e2e-testing-patterns' },
        summary: 'Build reliable end-to-end tests.',
      },
    ];
    const detail = {
      skill: {
        slug: 'e2e-testing-patterns',
        displayName: 'E2E Testing Patterns',
        summary: 'Build reliable end-to-end tests.',
        description: `---\n${'full instructions '.repeat(500)}`,
      },
      latestVersion: { version: '1.0.0' },
      owner: { handle: 'wpank' },
    };
    const version = {
      skill: { slug: 'e2e-testing-patterns' },
      version: {
        version: '1.0.0',
        files: [
          { path: 'SKILL.md', size: 10, sha256: HASH, contentType: 'text/markdown' },
          { path: 'README.md', size: 4, sha256: HASH, contentType: 'text/markdown' },
        ],
      },
    };
    const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const call = request(input, init);
      calls.push(call);
      if (call.url.pathname === '/api/v1/search') return jsonResponse({ results: searchRows });
      if (call.url.pathname === '/api/v1/skills/e2e-testing-patterns') return jsonResponse(detail);
      if (call.url.pathname === '/api/v1/skills/e2e-testing-patterns/versions/1.0.0') return jsonResponse(version);
      return jsonResponse({ error: 'not found' }, 404);
    };
    const adapter = new ClawHubAdapter({ fetch });
    const rows = await adapter.search(commonRequest);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      externalId: 'wpank/e2e-testing-patterns',
      title: 'e2e-testing-patterns',
      description: 'Build reliable end-to-end tests.',
      sourceType: 'clawhub',
      installable: true,
    });
    const resolved = await adapter.resolve({ sourceId: 'clawhub', externalId: rows[0]!.externalId, organizationId: 'org' });
    expect(resolved.acquisition).toMatchObject({
      kind: 'clawhub',
      owner: 'wpank',
      slug: 'e2e-testing-patterns',
      version: '1.0.0',
      files: [{ path: 'README.md', size: 4, sha256: HASH }, { path: 'SKILL.md', size: 10, sha256: HASH }],
    });
    expect(resolved.description).toBe('Build reliable end-to-end tests.');
    expect(calls.map(({ url }) => url.origin)).toEqual(['https://clawhub.ai', 'https://clawhub.ai', 'https://clawhub.ai']);

    // A direct unscoped slug is bound to the publisher returned by detail.
    const unscoped = await adapter.resolve({ sourceId: 'clawhub', externalId: 'e2e-testing-patterns', organizationId: 'org' });
    expect(unscoped.acquisition).toMatchObject({ kind: 'clawhub', owner: 'wpank' });
  });

  it('resolves SkillHub Public repository-only records with exact catalog disambiguation input', async () => {
    const calls: Array<{ url: URL; init?: RequestInit }> = [];
    const record = {
      id: 'citypaul/.dotfiles/testing',
      name: 'testing',
      description: 'Testing procedures.',
      githubOwner: 'citypaul',
      githubRepo: '.dotfiles',
      sourceFormat: 'skill.md',
    };
    const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push(request(input, init));
      return jsonResponse({ skills: [record] });
    };
    const adapter = new SkillHubPublicAdapter({
      fetch,
      githubResolver: async (identity) => {
        expect(identity).toMatchObject({ repository: 'citypaul/.dotfiles', skillHint: 'testing' });
        return resolvedGithub({ ...identity, path: 'testing' });
      },
    });
    const rows = await adapter.search(commonRequest);
    expect(rows[0]).toMatchObject({ repository: 'citypaul/.dotfiles', installable: true, externalId: expect.stringMatching(/^pskills-lookup-v1:/u) });
    const resolved = await adapter.resolve({ sourceId: 'skillhub-public', externalId: rows[0]!.externalId, organizationId: 'org' });
    expect(resolved.acquisition).toMatchObject({ kind: 'github', repository: 'citypaul/.dotfiles', path: 'testing', ref: COMMIT });
    expect(calls.every(({ url }) => url.pathname === '/api/skills')).toBe(true);
  });

  it('resolves a documented PolySkill native package by namespaced name and version', async () => {
    const calls: Array<{ url: URL; init?: RequestInit }> = [];
    const record = {
      id: 'provider-database-id',
      name: '@acme/testing',
      version: '1.2.3',
      description: 'A native testing helper.',
      manifest: {
        name: '@acme/testing',
        version: '1.2.3',
        description: 'A native testing helper.',
        type: 'prompt',
        skill: { instructions: './instructions.md' },
      },
      instructions: 'Use this guidance as data only.',
      tools: null,
    };
    const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const call = request(input, init);
      calls.push(call);
      return call.url.pathname === '/api/skills'
        ? jsonResponse({ skills: [record] })
        : jsonResponse(record);
    };
    const adapter = new PolySkillAdapter({ fetch });
    const rows = await adapter.search(commonRequest);
    expect(rows[0]).toMatchObject({
      externalId: '@acme/testing@1.2.3',
      sourceType: 'polyskill',
      installable: true,
    });
    expect(rows[0]?.metadata).not.toHaveProperty('instructions');
    const resolved = await adapter.resolve({ sourceId: 'polyskill', externalId: rows[0]!.externalId, organizationId: 'org' });
    expect(resolved.acquisition).toMatchObject({ kind: 'polyskill', name: '@acme/testing', version: '1.2.3' });
    expect(resolved.acquisition).toHaveProperty('contentDigest', expect.stringMatching(/^sha256:[0-9a-f]{64}$/u));
    expect(calls[1]?.url.pathname).toBe('/api/skills/%40acme%2Ftesting/1.2.3');
  });

  it('uses the documented keyed directory endpoints and re-queries SkillHub Pro by original query', async () => {
    const directoryRecord = {
      id: 'directory-testing',
      name: 'testing',
      description: 'Directory testing skill.',
      githubUrl: 'https://github.com/acme/skills/tree/main/skills/testing/SKILL.md',
    };
    const directoryCalls: Array<{ url: URL; init?: RequestInit }> = [];
    const directory = new SkillsDirectoryAdapter({
      env: { SKILLS_DIRECTORY_API_KEY: 'directory-key' },
      fetch: async (input, init) => {
        const call = request(input, init);
        directoryCalls.push(call);
        return call.url.pathname === '/api/v1/skills'
          ? jsonResponse({ data: [directoryRecord] })
          : jsonResponse(directoryRecord);
      },
      githubResolver: async (identity) => resolvedGithub(identity),
    });
    const directoryRows = await directory.search(commonRequest);
    expect(directoryRows[0]).toMatchObject({ externalId: 'directory-testing', installable: true });
    await directory.resolve({ sourceId: 'skills-directory', externalId: 'directory-testing', organizationId: 'org' });
    expect(directoryCalls.every(({ init }) => (init?.headers as Headers).get('authorization') === 'Bearer directory-key')).toBe(true);

    const proCalls: Array<{ url: URL; init?: RequestInit }> = [];
    const proRecord = {
      id: 'skillhub-pro-testing',
      name: 'testing',
      description: 'Pro testing skill.',
      githubOwner: 'acme',
      githubRepo: 'skills',
      skillPath: 'skills/testing',
    };
    const pro = new SkillHubProAdapter({
      env: { SKILLHUB_API_KEY: 'pro-key' },
      fetch: async (input, init) => {
        const call = request(input, init);
        proCalls.push(call);
        return jsonResponse({ data: [proRecord] });
      },
      githubResolver: async (identity) => resolvedGithub(identity),
    });
    const proRows = await pro.search(commonRequest);
    expect(proRows[0]?.externalId).toMatch(/^pskills-lookup-v1:/u);
    await pro.resolve({ sourceId: 'skillhub-pro', externalId: proRows[0]!.externalId, organizationId: 'org' });
    expect(proCalls).toHaveLength(2);
    const resolveBody = JSON.parse(String(proCalls[1]?.init?.body));
    expect(resolveBody).toMatchObject({ query: 'testing', limit: 5, method: 'hybrid' });
    expect(proCalls.every(({ init }) => (init?.headers as Headers).get('authorization') === 'Bearer pro-key')).toBe(true);
  });

  it('denies redirects and oversized responses at the fixed-origin transport boundary', async () => {
    const redirected = new SkillsMpAdapter({
      env: {},
      fetch: async (_input, init) => {
        expect(init?.redirect).toBe('error');
        return new Response(null, { status: 302, headers: { location: 'https://evil.example/next' } });
      },
    });
    await expect(redirected.search(commonRequest)).rejects.toMatchObject({ code: 'SOURCE_ORIGIN_UNTRUSTED' });

    const oversized = new SkillsMpAdapter({
      env: {},
      maxResponseBytes: 32,
      fetch: async () => new Response('x'.repeat(128), { headers: { 'content-length': '128', 'content-type': 'application/json' } }),
    });
    await expect(oversized.search(commonRequest)).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
  });
});
