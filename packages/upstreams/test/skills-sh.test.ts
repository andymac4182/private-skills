import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { describe, expect, it, vi } from 'vitest';

// The acquisition tests use a fetch fixture, so resolve the canonical origin
// to the loopback fixture without making a network request. This keeps the
// production SSRF checks active while allowLoopbackForTests is enabled.
vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '127.0.0.1' }],
}));

import {
  acquireSkillsShSkill,
  UpstreamAcquisitionError,
} from '../src/index.js';
import type { AcquireSkillInput } from '../src/index.js';

const BASE = 'http://127.0.0.1:32123';
const DISCOVERY_SCHEMA = 'https://schemas.agentskills.io/discovery/0.2.0/schema.json';
const COMMIT = '0123456789012345678901234567890123456789';
const TREE = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function bytes(value: Uint8Array, contentType = 'application/octet-stream'): Response {
  return new Response(Buffer.from(value) as unknown as BodyInit, { status: 200, headers: { 'content-type': contentType } });
}

function digest(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function sha(value: Uint8Array): string {
  return createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${value.length}\0`), Buffer.from(value)])).digest('hex');
}

function crc32(value: Uint8Array): number {
  let result = 0xffffffff;
  for (const byte of value) {
    result ^= byte;
    for (let bit = 0; bit < 8; bit += 1) result = (result >>> 1) ^ (result & 1 ? 0xedb88320 : 0);
  }
  return (result ^ 0xffffffff) >>> 0;
}

function storedZip(files: Array<{ path: string; bytes: Uint8Array }>): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path, 'utf8');
    const data = Buffer.from(file.bytes);
    const crc = crc32(data);
    const local = Buffer.alloc(30 + name.length + data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    data.copy(local, 30 + name.length);
    locals.push(local);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Uint8Array.from(Buffer.concat([...locals, centralBytes, end]));
}

function request(
  path: string,
  fetchImpl: NonNullable<AcquireSkillInput['fetchImpl']>,
): AcquireSkillInput {
  return {
    upstream: {
      id: 'skills-sh-fixture',
      organizationId: 'org-1',
      name: 'skills.sh fixture',
      kind: 'skills-sh',
      enabled: true,
      repositories: ['octo/repo', 'example.test'],
      baseUrl: `${BASE}/catalog`,
      namespace: '@team',
    },
    importRequest: {
      upstreamId: 'skills-sh-fixture',
      path,
      name: '@team/demo',
      version: '1.0.0',
    },
    fetchImpl,
    allowLoopbackForTests: true,
  };
}

describe('skills.sh source acquisition', () => {
  it('uses the detail snapshot and preserves the external hash separately', async () => {
    const skill = Buffer.from('---\nname: demo\ndescription: Fixture demo\n---\n# demo\n', 'utf8');
    const calls: string[] = [];
    const fetchImpl = async (input: string | URL, init?: { headers?: Record<string, string> }): Promise<Response> => {
      const url = new URL(input.toString());
      calls.push(`${url.pathname}${url.search}`);
      assert.equal(init?.headers?.authorization, 'Bearer catalog-token');
      if (url.pathname === '/catalog/api/v1/skills/octo/repo/demo') {
        return json({
          id: 'octo/repo/demo', source: 'octo/repo', slug: 'demo', name: 'demo', sourceType: 'github',
          installUrl: 'https://github.com/octo/repo/tree/main/skills/demo', url: '/site/octo/repo/demo', hash: 'snapshot-123',
          files: [{ path: 'SKILL.md', contents: skill.toString('utf8') }],
        });
      }
      return json({ error: 'not found' }, 404);
    };
    process.env.PSKILLS_SKILLS_SH_TOKEN = 'catalog-token';
    try {
      const result = await acquireSkillsShSkill({
        ...request('octo/repo/demo', fetchImpl),
        upstream: { ...request('octo/repo/demo', fetchImpl).upstream!, credentialEnv: 'PSKILLS_SKILLS_SH_TOKEN' },
      });
      expect(result.bundle.files.map((file) => file.path)).toEqual(['SKILL.md']);
      expect(result.provenance.kind).toBe('skills-sh');
      expect(result.provenance.repository).toBe('octo/repo');
      expect(result.provenance.path).toBe('octo/repo/demo');
      expect(result.provenance.externalId).toBe('octo/repo/demo');
      expect(result.provenance.externalSourceType).toBe('github');
      expect(result.provenance.externalSnapshotHash).toBe('snapshot-123');
      expect(result.provenance.revision).toBe('snapshot-123');
      expect(result.provenance.sourceDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(calls).toEqual(['/catalog/api/v1/skills/octo/repo/demo']);
    } finally {
      delete process.env.PSKILLS_SKILLS_SH_TOKEN;
    }
  });

  it('gets a fresh request-scoped token for each canonical catalog acquisition', async () => {
    const skill = Buffer.from('---\nname: demo\ndescription: Fresh token demo\n---\n# demo\n', 'utf8');
    const seen: Array<{ path: string; authorization: string | undefined }> = [];
    let acquisition = 0;
    let tokenCalls = 0;
    const fetchImpl = async (input: string | URL, init?: { headers?: Record<string, string> }): Promise<Response> => {
      const url = new URL(input.toString());
      seen.push({ path: url.pathname, authorization: init?.headers?.authorization });
      if (url.origin !== 'https://skills.sh' || url.pathname !== '/api/v1/skills/octo/repo/demo') {
        return json({ error: 'unexpected source request' }, 404);
      }
      acquisition += 1;
      return json({
        id: 'octo/repo/demo', source: 'octo/repo', slug: 'demo', name: 'demo', sourceType: 'github',
        installUrl: 'https://github.com/octo/repo/tree/main/skills/demo', url: '/site/octo/repo/demo', hash: `snapshot-${acquisition}`,
        files: [{ path: 'SKILL.md', contents: skill.toString('utf8') }],
      });
    };
    const input = request('octo/repo/demo', fetchImpl);
    input.upstream = { ...input.upstream!, baseUrl: 'https://skills.sh' };
    input.getSkillsShToken = async (signal) => {
      expect(signal?.aborted).toBe(false);
      tokenCalls += 1;
      return `catalog-token-${tokenCalls}`;
    };

    await acquireSkillsShSkill(input);
    await acquireSkillsShSkill(input);

    expect(tokenCalls).toBe(2);
    expect(seen).toEqual([
      { path: '/api/v1/skills/octo/repo/demo', authorization: 'Bearer catalog-token-1' },
      { path: '/api/v1/skills/octo/repo/demo', authorization: 'Bearer catalog-token-2' },
    ]);
  });

  it('keeps the catalog token off GitHub source requests', async () => {
    const skill = Buffer.from('---\nname: demo\ndescription: Catalog credential demo\n---\n# demo\n', 'utf8');
    const skillSha = sha(skill);
    const seen: Array<{ origin: string; path: string; authorization: string | undefined }> = [];
    let tokenCalls = 0;
    const fetchImpl = async (input: string | URL, init?: { headers?: Record<string, string> }): Promise<Response> => {
      const url = new URL(input.toString());
      seen.push({ origin: url.origin, path: url.pathname, authorization: init?.headers?.authorization });
      if (url.origin === 'https://skills.sh' && url.pathname === '/api/v1/skills/octo/repo/demo') {
        return json({
          id: 'octo/repo/demo', source: 'octo/repo', slug: 'demo', name: 'demo', sourceType: 'github',
          installUrl: 'https://github.com/octo/repo/tree/main/skills/demo', url: '/site/octo/repo/demo', hash: null, files: null,
        });
      }
      if (url.pathname === '/github/repos/octo/repo') return json({ default_branch: 'main' });
      if (url.pathname === `/github/repos/octo/repo/commits/main`) return json({ sha: COMMIT });
      if (url.pathname === `/github/repos/octo/repo/git/trees/${COMMIT}`) return json({ sha: TREE, truncated: false, tree: [
        { path: 'skills/demo', mode: '040000', type: 'tree', sha: TREE },
        { path: 'skills/demo/SKILL.md', mode: '100644', type: 'blob', sha: skillSha, size: skill.length },
      ] });
      if (url.pathname === `/github/repos/octo/repo/git/blobs/${skillSha}`) return json({ encoding: 'base64', content: skill.toString('base64'), size: skill.length, sha: skillSha });
      return json({ error: 'not found' }, 404);
    };
    const input = request('octo/repo/demo', fetchImpl);
    input.upstream = { ...input.upstream!, baseUrl: 'https://skills.sh', githubApiBaseUrl: `${BASE}/github` } as AcquireSkillInput['upstream'];
    input.getSkillsShToken = async () => {
      tokenCalls += 1;
      return `catalog-token-${tokenCalls}`;
    };

    const result = await acquireSkillsShSkill(input);

    expect(result.bundle.files).toHaveLength(1);
    expect(tokenCalls).toBe(1);
    expect(seen.find((entry) => entry.origin === 'https://skills.sh')?.authorization).toBe('Bearer catalog-token-1');
    expect(seen.filter((entry) => entry.origin !== 'https://skills.sh').every((entry) => entry.authorization === undefined)).toBe(true);
  });

  it('keeps the catalog token off well-known indexes, artifacts, and artifact redirects', async () => {
    const skill = Buffer.from('---\nname: demo\ndescription: Well-known credential demo\n---\n# demo\n', 'utf8');
    const expected = digest(skill);
    const seen: Array<{ origin: string; path: string; authorization: string | undefined }> = [];
    let tokenCalls = 0;
    const fetchImpl = async (input: string | URL, init?: { headers?: Record<string, string> }): Promise<Response> => {
      const url = new URL(input.toString());
      seen.push({ origin: url.origin, path: url.pathname, authorization: init?.headers?.authorization });
      if (url.origin === 'https://skills.sh' && url.pathname === '/api/v1/skills/example.test/demo') {
        return json({
          id: 'example.test/demo', source: 'example.test', slug: 'demo', name: 'demo', sourceType: 'well-known',
          installUrl: `${BASE}/published/.well-known/agent-skills/demo`, url: '/site/example.test/demo', hash: null, files: null,
        });
      }
      if (url.pathname === '/published/.well-known/agent-skills/index.json') {
        return json({ $schema: DISCOVERY_SCHEMA, skills: [{
          name: 'demo', type: 'skill-md', description: 'Well-known credential demo', url: '/artifact/demo.md', digest: expected,
        }] });
      }
      if (url.pathname === '/artifact/demo.md') return new Response(null, { status: 302, headers: { location: '/artifact/final.md' } });
      if (url.pathname === '/artifact/final.md') return bytes(skill, 'text/markdown');
      return json({ error: 'not found' }, 404);
    };
    const input = request('example.test/demo', fetchImpl);
    input.upstream = { ...input.upstream!, baseUrl: 'https://skills.sh' } as AcquireSkillInput['upstream'];
    input.getSkillsShToken = async () => {
      tokenCalls += 1;
      return `catalog-token-${tokenCalls}`;
    };

    const result = await acquireSkillsShSkill(input);

    expect(result.bundle.files).toHaveLength(1);
    expect(tokenCalls).toBe(1);
    expect(seen.find((entry) => entry.origin === 'https://skills.sh')?.authorization).toBe('Bearer catalog-token-1');
    expect(seen.filter((entry) => entry.origin !== 'https://skills.sh').every((entry) => entry.authorization === undefined)).toBe(true);
  });

  it('does not invoke the request-scoped provider for a custom catalog destination', async () => {
    const skill = Buffer.from('---\nname: demo\ndescription: Custom destination demo\n---\n# demo\n', 'utf8');
    let tokenCalls = 0;
    let authorization: string | undefined;
    const fetchImpl = async (input: string | URL, init?: { headers?: Record<string, string> }): Promise<Response> => {
      authorization = init?.headers?.authorization;
      const url = new URL(input.toString());
      if (url.pathname === '/catalog/api/v1/skills/octo/repo/demo') {
        return json({ id: 'octo/repo/demo', source: 'octo/repo', slug: 'demo', name: 'demo', sourceType: 'github', hash: 'snapshot', files: [{ path: 'SKILL.md', contents: skill.toString('utf8') }] });
      }
      return json({ error: 'not found' }, 404);
    };
    const input = request('octo/repo/demo', fetchImpl);
    input.getSkillsShToken = async () => {
      tokenCalls += 1;
      return 'must-not-be-used';
    };

    await acquireSkillsShSkill(input);

    expect(tokenCalls).toBe(0);
    expect(authorization).toBeUndefined();
  });

  it('accepts bounded Unicode IDs and rejects malformed or over-limit IDs before I/O', async () => {
    const unicodeId = '团队/工具/🔍';
    const unicodeInput = request(unicodeId, async () => json({
      id: unicodeId,
      source: '团队',
      slug: '工具/🔍',
      name: 'unicode-demo',
      sourceType: 'github',
      hash: 'snapshot',
      files: [{ path: 'SKILL.md', contents: '---\nname: unicode-demo\ndescription: Unicode demo\n---\n# demo\n' }],
    }));
    unicodeInput.upstream = { ...unicodeInput.upstream!, repositories: ['团队'] };
    await expect(acquireSkillsShSkill(unicodeInput)).resolves.toMatchObject({ provenance: { path: unicodeId } });

    let fetchCalls = 0;
    let tokenCalls = 0;
    const fetchImpl = async (): Promise<Response> => {
      fetchCalls += 1;
      return json({ error: 'unexpected request' }, 500);
    };
    const template = request('octo/repo/demo', fetchImpl);
    template.upstream = { ...template.upstream!, baseUrl: 'https://skills.sh' };
    template.getSkillsShToken = async () => {
      tokenCalls += 1;
      return 'must-not-be-called';
    };
    const overSegment = `octo/repo/${'a'.repeat(513)}`;
    const overSegments = ['octo', 'repo', ...Array.from({ length: 63 }, () => 'a')].join('/');
    const overTotal = ['octo', 'repo', ...Array.from({ length: 62 }, () => 'a'.repeat(512))].join('/');
    const invalidIds = [
      overSegment,
      overSegments,
      overTotal,
      'octo/repo/../demo',
      'octo/repo/a?b',
      'octo/repo/a#b',
      'octo/repo/a%2Fb',
      'octo/repo/a\\b',
      'octo/repo/\ud800',
    ];

    for (const path of invalidIds) {
      await expect(acquireSkillsShSkill({
        ...template,
        importRequest: { ...template.importRequest!, path },
      })).rejects.toMatchObject({ code: 'invalid_source' });
    }
    expect(fetchCalls).toBe(0);
    expect(tokenCalls).toBe(0);
  });

  it('rejects malformed Unicode before encoding the catalog request', async () => {
    let fetchCalls = 0;
    let tokenCalls = 0;
    const input = request('octo/repo/demo', async () => {
      fetchCalls += 1;
      return json({ error: 'unexpected request' }, 500);
    });
    input.upstream = { ...input.upstream!, baseUrl: 'https://skills.sh' };
    input.getSkillsShToken = async () => {
      tokenCalls += 1;
      return 'must-not-be-called';
    };

    await expect(acquireSkillsShSkill({
      ...input,
      importRequest: { ...input.importRequest!, path: 'octo/repo/\ud800' },
    })).rejects.toMatchObject({ code: 'invalid_source' });
    expect(fetchCalls).toBe(0);
    expect(tokenCalls).toBe(0);
  });

  it('redacts request-scoped credential provider failures and fails closed', async () => {
    let fetchCalls = 0;
    const input = request('octo/repo/demo', async () => {
      fetchCalls += 1;
      return json({ error: 'unexpected request' }, 500);
    });
    input.upstream = { ...input.upstream!, baseUrl: 'https://skills.sh', credentialEnv: 'PSKILLS_SKILLS_SH_FALLBACK_TOKEN' };
    input.getSkillsShToken = async () => {
      throw new Error('provider-secret-must-not-escape');
    };

    process.env.PSKILLS_SKILLS_SH_FALLBACK_TOKEN = 'fallback-token-must-not-be-used';
    let error: unknown;
    try {
      error = await acquireSkillsShSkill(input).catch((value: unknown) => value);
    } finally {
      delete process.env.PSKILLS_SKILLS_SH_FALLBACK_TOKEN;
    }

    expect(error).toMatchObject({ code: 'credential_unavailable', message: 'skills.sh catalog authentication unavailable' });
    expect(String(error)).not.toContain('provider-secret-must-not-escape');
    expect(fetchCalls).toBe(0);
  });

  it('times out a request-scoped credential provider and fails closed', async () => {
    let fetchCalls = 0;
    const input = request('octo/repo/demo', async () => {
      fetchCalls += 1;
      return json({ error: 'unexpected request' }, 500);
    });
    input.upstream = { ...input.upstream!, baseUrl: 'https://skills.sh' };
    input.limits = { requestTimeoutMs: 5 };
    input.getSkillsShToken = async () => new Promise<string>(() => { /* deliberately pending */ });

    const error = await acquireSkillsShSkill(input).catch((value: unknown) => value);

    expect(error).toMatchObject({ code: 'credential_timeout', message: 'skills.sh catalog authentication timed out' });
    expect(fetchCalls).toBe(0);
  });

  it('resolves a null GitHub snapshot by immutable commit and selected path', async () => {
    const skill = Buffer.from('---\nname: demo\ndescription: GitHub demo\n---\n# demo\n', 'utf8');
    const license = Buffer.from('MIT\n', 'utf8');
    const skillSha = sha(skill);
    const licenseSha = sha(license);
    const fetchImpl = async (input: string | URL): Promise<Response> => {
      const url = new URL(input.toString());
      if (url.pathname === '/catalog/api/v1/skills/octo/repo/demo') {
        return json({
          id: 'octo/repo/demo', source: 'octo/repo', slug: 'demo', name: 'demo', sourceType: 'github',
          installUrl: 'https://github.com/octo/repo/tree/main/skills/demo', url: '/site/octo/repo/demo', hash: null, files: null,
        });
      }
      if (url.pathname === '/github/repos/octo/repo') return json({ default_branch: 'main' });
      if (url.pathname === '/github/repos/octo/repo/commits/main') return json({ sha: COMMIT });
      if (url.pathname === `/github/repos/octo/repo/git/trees/${COMMIT}`) {
        return json({ sha: TREE, truncated: false, tree: [
          { path: 'skills/demo', mode: '040000', type: 'tree', sha: TREE },
          { path: 'skills/demo/SKILL.md', mode: '100644', type: 'blob', sha: skillSha, size: skill.length },
          { path: 'skills/demo/LICENSE', mode: '100644', type: 'blob', sha: licenseSha, size: license.length },
        ] });
      }
      if (url.pathname === `/github/repos/octo/repo/git/blobs/${skillSha}`) return json({ encoding: 'base64', content: skill.toString('base64'), size: skill.length, sha: skillSha });
      if (url.pathname === `/github/repos/octo/repo/git/blobs/${licenseSha}`) return json({ encoding: 'base64', content: license.toString('base64'), size: license.length, sha: licenseSha });
      return json({ error: 'not found' }, 404);
    };
    const result = await acquireSkillsShSkill({
      ...request('octo/repo/demo', fetchImpl),
      upstream: {
        ...request('octo/repo/demo', fetchImpl).upstream!,
        githubApiBaseUrl: `${BASE}/github`,
      } as AcquireSkillInput['upstream'],
    });
    expect(result.bundle.files.map((file) => file.path)).toEqual(['LICENSE', 'SKILL.md']);
    expect(result.provenance.repository).toBe('octo/repo');
    expect(result.provenance.revision).toBe(COMMIT);
    const metadata = result.provenance as unknown as Record<string, unknown>;
    expect(metadata.resolvedCommit).toBe(COMMIT);
    expect(metadata.skillPath).toBe('skills/demo');
    expect(metadata.resolvedTree).toBe(TREE);
  });

  it('resolves a repository-root skill with an explicit immutable source ref', async () => {
    const skill = Buffer.from('---\nname: root-skill\ndescription: Root GitHub demo\n---\n# root\n', 'utf8');
    const readme = Buffer.from('support\n', 'utf8');
    const skillSha = sha(skill);
    const readmeSha = sha(readme);
    const fetchImpl = async (input: string | URL): Promise<Response> => {
      const url = new URL(input.toString());
      if (url.pathname === '/catalog/api/v1/skills/octo/repo/root-skill') {
        return json({ id: 'octo/repo/root-skill', source: 'octo/repo', slug: 'root-skill', installs: 1, hash: null, files: null });
      }
      if (url.pathname === `/github/repos/octo/repo/commits/release`) return json({ sha: COMMIT });
      if (url.pathname === `/github/repos/octo/repo/git/trees/${COMMIT}`) {
        return json({ sha: TREE, truncated: false, tree: [
          { path: 'SKILL.md', mode: '100644', type: 'blob', sha: skillSha, size: skill.length },
          { path: 'README.md', mode: '100644', type: 'blob', sha: readmeSha, size: readme.length },
        ] });
      }
      if (url.pathname === `/github/repos/octo/repo/git/blobs/${skillSha}`) return json({ encoding: 'base64', content: skill.toString('base64'), size: skill.length, sha: skillSha });
      if (url.pathname === `/github/repos/octo/repo/git/blobs/${readmeSha}`) return json({ encoding: 'base64', content: readme.toString('base64'), size: readme.length, sha: readmeSha });
      return json({ error: 'not found' }, 404);
    };
    const input = request('octo/repo/root-skill', fetchImpl);
    input.importRequest = {
      ...input.importRequest!,
      externalId: 'octo/repo/root-skill',
      externalSourceType: 'github',
      ref: 'release',
    };
    input.upstream = {
      ...input.upstream!,
      githubApiBaseUrl: `${BASE}/github`,
    } as AcquireSkillInput['upstream'];
    const result = await acquireSkillsShSkill(input);
    expect(result.bundle.files.map((file) => file.path)).toEqual(['README.md', 'SKILL.md']);
    expect(result.provenance.revision).toBe(COMMIT);
    const metadata = result.provenance as unknown as Record<string, unknown>;
    expect(metadata.requestedRef).toBe('release');
    expect(metadata.skillPath).toBeUndefined();
    expect(metadata.resolvedCommit).toBe(COMMIT);
    expect(metadata.resolvedTree).toBe(TREE);
  });

  it('resolves a repository-shaped migrated row while retaining its reported well-known type', async () => {
    const skill = Buffer.from('---\nname: gws-sheets\ndescription: Migrated GitHub demo\n---\n# sheets\n', 'utf8');
    const skillSha = sha(skill);
    const fetchImpl = async (input: string | URL): Promise<Response> => {
      const url = new URL(input.toString());
      if (url.pathname === '/catalog/api/v1/skills/googleworkspace/cli/gws-sheets') {
        return json({ id: 'googleworkspace/cli/gws-sheets', source: 'googleworkspace/cli', slug: 'gws-sheets', installs: 1, hash: null, files: null });
      }
      if (url.pathname === `/github/repos/googleworkspace/cli`) return json({ default_branch: 'main' });
      if (url.pathname === `/github/repos/googleworkspace/cli/commits/main`) return json({ sha: COMMIT });
      if (url.pathname === `/github/repos/googleworkspace/cli/git/trees/${COMMIT}`) return json({ sha: TREE, truncated: false, tree: [
        { path: 'skills/gws-sheets', mode: '040000', type: 'tree', sha: TREE },
        { path: 'skills/gws-sheets/SKILL.md', mode: '100644', type: 'blob', sha: skillSha, size: skill.length },
      ] });
      if (url.pathname === `/github/repos/googleworkspace/cli/git/blobs/${skillSha}`) return json({ encoding: 'base64', content: skill.toString('base64'), size: skill.length, sha: skillSha });
      return json({ error: 'not found' }, 404);
    };
    const input = request('googleworkspace/cli/gws-sheets', fetchImpl);
    input.importRequest = {
      ...input.importRequest!,
      externalId: 'googleworkspace/cli/gws-sheets',
      externalSourceType: 'well-known',
      repository: 'googleworkspace/cli',
    };
    input.upstream = {
      ...input.upstream!,
      repositories: ['*'],
      githubApiBaseUrl: `${BASE}/github`,
    } as AcquireSkillInput['upstream'];
    const result = await acquireSkillsShSkill(input);
    expect(result.bundle.files.map((file) => file.path)).toEqual(['SKILL.md']);
    expect(result.provenance.repository).toBe('googleworkspace/cli');
    expect(result.provenance.externalSourceType).toBe('well-known');
    expect(result.provenance.revision).toBe(COMMIT);
    const metadata = result.provenance as unknown as Record<string, unknown>;
    expect(metadata.skillPath).toBe('skills/gws-sheets');
    expect(metadata.resolvedCommit).toBe(COMMIT);
  });

  it('does not reinterpret dotted hostname paths as GitHub repositories', async () => {
    let githubCalled = false;
    const fetchImpl = async (input: string | URL): Promise<Response> => {
      const url = new URL(input.toString());
      if (url.pathname === '/catalog/api/v1/skills/open.feishu.cn/lark-doc') {
        return json({ id: 'open.feishu.cn/lark-doc', source: 'open.feishu.cn', slug: 'lark-doc', installs: 1, hash: null, files: null });
      }
      if (url.pathname.startsWith('/github/')) githubCalled = true;
      return json({ error: 'unexpected source request' }, 404);
    };
    const input = request('open.feishu.cn/lark-doc', fetchImpl);
    input.importRequest = {
      ...input.importRequest!,
      externalId: 'open.feishu.cn/lark-doc',
      externalSourceType: 'well-known',
      repository: 'open.feishu.cn',
    };
    input.upstream = { ...input.upstream!, repositories: ['*'], wellKnownBaseUrl: `${BASE}/published` } as AcquireSkillInput['upstream'];
    await expect(acquireSkillsShSkill(input)).rejects.toMatchObject({ code: 'source_unavailable' });
    expect(githubCalled).toBe(false);
  });

  it('accepts the documented detail payload without presentation metadata', async () => {
    const skill = Buffer.from('---\nname: minimal\ndescription: Minimal detail\n---\n# minimal\n', 'utf8');
    const fetchImpl = async (input: string | URL): Promise<Response> => {
      const url = new URL(input.toString());
      if (url.pathname === '/catalog/api/v1/skills/octo/repo/minimal') {
        return json({ id: 'octo/repo/minimal', source: 'octo/repo', slug: 'minimal', installs: 1, hash: null, files: [{ path: 'SKILL.md', contents: skill.toString('utf8') }] });
      }
      return json({ error: 'not found' }, 404);
    };
    const base = request('octo/repo/minimal', fetchImpl);
    base.importRequest = { ...base.importRequest!, externalId: 'octo/repo/minimal' };
    const result = await acquireSkillsShSkill(base);
    expect(result.provenance.externalSourceType).toBeUndefined();
    expect(result.provenance.externalSnapshotHash).toBeNull();
    expect(result.provenance.revision).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('uses v0.2 well-known discovery with digest verification', async () => {
    const skill = Buffer.from('---\nname: demo\ndescription: Well-known demo\n---\n# demo\n', 'utf8');
    const expected = digest(skill);
    const fetchImpl = async (input: string | URL): Promise<Response> => {
      const url = new URL(input.toString());
      if (url.pathname === '/catalog/api/v1/skills/example.test/demo') {
        return json({
          id: 'example.test/demo', source: 'example.test', slug: 'demo', name: 'demo', sourceType: 'well-known',
          installUrl: `${BASE}/published/.well-known/agent-skills/demo`, url: '/site/example.test/demo', hash: null, files: null,
        });
      }
      if (url.pathname === '/published/.well-known/agent-skills/index.json') {
        return json({ $schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json', skills: [{
          name: 'demo', type: 'skill-md', description: 'Well-known demo', url: '/published/demo/SKILL.md', digest: expected,
        }] });
      }
      if (url.pathname === '/published/demo/SKILL.md') return bytes(skill, 'text/markdown');
      return json({ error: 'not found' }, 404);
    };
    const result = await acquireSkillsShSkill(request('example.test/demo', fetchImpl));
    expect(result.bundle.files).toEqual([{ path: 'SKILL.md', content: skill.toString('base64') }]);
    expect(result.provenance.externalSourceType).toBe('well-known');
    const metadata = result.provenance as unknown as Record<string, unknown>;
    expect(metadata.externalDigest).toBe(expected);
    expect(metadata.wellKnownIndexUrl).toContain('/published/.well-known/agent-skills/index.json');
    expect(result.provenance.revision).toBe(expected);
  });

  it('preserves an explicit non-marker source-root install URL', async () => {
    const skill = Buffer.from('---\nname: rooted\ndescription: Rooted well-known demo\n---\n# rooted\n', 'utf8');
    const expected = digest(skill);
    const calls: string[] = [];
    const fetchImpl = async (input: string | URL): Promise<Response> => {
      const url = new URL(input.toString());
      calls.push(url.pathname);
      if (url.pathname === '/catalog/api/v1/skills/example.test/rooted') {
        return json({
          id: 'example.test/rooted', source: 'example.test', slug: 'rooted', name: 'rooted',
          sourceType: 'well-known', installUrl: `${BASE}/published`, url: '/site/example.test/rooted', hash: null, files: null,
        });
      }
      if (url.pathname === '/published/.well-known/agent-skills/index.json') {
        return json({ $schema: DISCOVERY_SCHEMA, skills: [{
          name: 'rooted', type: 'skill-md', description: 'Rooted well-known demo', url: '/published/rooted/SKILL.md', digest: expected,
        }] });
      }
      if (url.pathname === '/published/rooted/SKILL.md') return bytes(skill, 'text/markdown');
      return json({ error: 'unexpected source path' }, 404);
    };

    const result = await acquireSkillsShSkill(request('example.test/rooted', fetchImpl));

    expect(result.bundle.files).toEqual([{ path: 'SKILL.md', content: skill.toString('base64') }]);
    expect(calls).toEqual([
      '/catalog/api/v1/skills/example.test/rooted',
      '/published/.well-known/agent-skills/index.json',
      '/published/rooted/SKILL.md',
    ]);
    expect(calls).not.toContain('/.well-known/agent-skills/index.json');
  });

  it('requires skills.sh detail install URLs to be absolute', async () => {
    const fetchImpl = async (input: string | URL): Promise<Response> => {
      const url = new URL(input.toString());
      if (url.pathname === '/catalog/api/v1/skills/example.test/relative') {
        return json({
          id: 'example.test/relative', source: 'example.test', slug: 'relative', name: 'relative',
          sourceType: 'well-known', installUrl: '/published/.well-known/agent-skills/relative', hash: null, files: null,
        });
      }
      throw new Error(`unexpected source request ${url.pathname}`);
    };

    await expect(acquireSkillsShSkill(request('example.test/relative', fetchImpl)))
      .rejects.toMatchObject({ code: 'invalid_source' });
  });

  it('accepts a valid nested external id up to the 2048-byte envelope', async () => {
    const source = `${'s'.repeat(512)}/${'t'.repeat(512)}`;
    const slug = 'u'.repeat(512);
    const id = `${source}/${slug}`;
    const skill = '---\nname: long\ndescription: Long identifier\n---\n# long\n';
    const fetchImpl = async (input: string | URL): Promise<Response> => {
      const url = new URL(input.toString());
      if (url.pathname === `/catalog/api/v1/skills/${source.split('/').join('/')}/${slug}`) {
        return json({
          id, source, slug, name: 'long', sourceType: 'well-known', installUrl: 'https://example.test/published',
          url: '/site/long', hash: null, files: [{ path: 'SKILL.md', contents: skill }],
        });
      }
      throw new Error(`unexpected source request ${url.pathname}`);
    };
    const input = request(id, fetchImpl);
    input.upstream = { ...input.upstream!, repositories: [source] };
    input.importRequest = { ...input.importRequest!, path: id, name: '@team/long' };

    const result = await acquireSkillsShSkill(input);

    expect(result.bundle.files).toEqual([{ path: 'SKILL.md', content: Buffer.from(skill, 'utf8').toString('base64') }]);
  });

  it('rehydrates a scoped well-known location from exact authenticated catalog metadata', async () => {
    const skill = Buffer.from('---\nname: demo\ndescription: Rehydrated well-known demo\n---\n# demo\n', 'utf8');
    const expected = digest(skill);
    const calls: Array<{ path: string; authorization: string | undefined }> = [];
    const fetchImpl = async (input: string | URL, init?: { headers?: Record<string, string> }): Promise<Response> => {
      const url = new URL(input.toString());
      calls.push({ path: `${url.pathname}${url.search}`, authorization: init?.headers?.authorization });
      if (url.pathname === '/catalog/api/v1/skills/example.test/demo') {
        // Match the documented detail payload: presentation metadata is
        // recovered from list/search below, not invented on this response.
        return json({ id: 'example.test/demo', source: 'example.test', slug: 'demo', installs: 1, hash: null, files: null });
      }
      if (url.pathname === '/catalog/api/v1/skills/search') {
        expect(url.searchParams.get('q')).toBe('demo');
        expect(url.searchParams.get('limit')).toBe('200');
        return json({
          data: [{
            id: 'example.test/demo',
            source: 'example.test',
            slug: 'demo',
            name: 'demo',
            installs: 1,
            sourceType: 'well-known',
            installUrl: `${BASE}/published/.well-known/agent-skills/demo`,
            url: '/site/example.test/demo',
          }],
          query: 'demo',
          searchType: 'fuzzy',
          count: 1,
          durationMs: 1,
        });
      }
      if (url.pathname === '/published/.well-known/agent-skills/index.json') {
        return json({ $schema: DISCOVERY_SCHEMA, skills: [{
          name: 'demo',
          type: 'skill-md',
          description: 'Rehydrated well-known demo',
          url: '/published/demo/SKILL.md',
          digest: expected,
        }] });
      }
      if (url.pathname === '/published/demo/SKILL.md') return bytes(skill, 'text/markdown');
      return json({ error: 'unexpected source request' }, 404);
    };
    const input = request('example.test/demo', fetchImpl);
    input.importRequest = {
      ...input.importRequest!,
      externalId: 'example.test/demo',
      externalSourceType: 'well-known',
    };

    const result = await acquireSkillsShSkill(input);

    expect(result.bundle.files).toEqual([{ path: 'SKILL.md', content: skill.toString('base64') }]);
    expect(result.provenance.externalSourceType).toBe('well-known');
    expect((result.provenance as unknown as Record<string, unknown>).wellKnownIndexUrl).toContain('/published/.well-known/agent-skills/index.json');
    expect(calls.map((entry) => entry.path)).toEqual([
      '/catalog/api/v1/skills/example.test/demo',
      '/catalog/api/v1/skills/search?q=demo&limit=200',
      '/published/.well-known/agent-skills/index.json',
      '/published/demo/SKILL.md',
    ]);
  });

  it('rejects conflicting or duplicate exact metadata before well-known source fetches', async () => {
    let sourceFetches = 0;
    const fetchImpl = async (input: string | URL): Promise<Response> => {
      const url = new URL(input.toString());
      if (url.pathname === '/catalog/api/v1/skills/example.test/conflict') {
        return json({ id: 'example.test/conflict', source: 'example.test', slug: 'conflict', installs: 1, hash: null, files: null });
      }
      if (url.pathname === '/catalog/api/v1/skills/search') {
        return json({ data: [
          {
            id: 'example.test/conflict', source: 'example.test', slug: 'conflict', name: 'conflict', installs: 1,
            sourceType: 'github', installUrl: 'https://github.com/example/repo', url: '/site/example.test/conflict',
          },
          {
            id: 'example.test/conflict', source: 'example.test', slug: 'conflict', name: 'conflict', installs: 2,
            sourceType: 'well-known', installUrl: `${BASE}/published/.well-known/agent-skills/conflict`, url: '/site/example.test/conflict',
          },
        ], query: 'conflict', searchType: 'fuzzy', count: 2, durationMs: 1 });
      }
      sourceFetches += 1;
      return json({ error: 'source must not be fetched' }, 500);
    };
    const input = request('example.test/conflict', fetchImpl);
    input.importRequest = {
      ...input.importRequest!,
      externalId: 'example.test/conflict',
      externalSourceType: 'well-known',
    };

    await expect(acquireSkillsShSkill(input)).rejects.toMatchObject({ code: 'ambiguous_source' });
    expect(sourceFetches).toBe(0);
  });

  it('rejects a search metadata response larger than its 200-row request limit', async () => {
    const calls: string[] = [];
    const fetchImpl = async (input: string | URL): Promise<Response> => {
      const url = new URL(input.toString());
      calls.push(`${url.pathname}${url.search}`);
      if (url.pathname === '/catalog/api/v1/skills/example.test/oversized-search') {
        return json({ id: 'example.test/oversized-search', source: 'example.test', slug: 'oversized-search', installs: 0, hash: null, files: null });
      }
      if (url.pathname === '/catalog/api/v1/skills/search') {
        return json({ data: Array.from({ length: 201 }, () => ({})), query: 'oversized-search', searchType: 'fuzzy', count: 201, durationMs: 1 });
      }
      throw new Error(`unexpected post-search request ${url.pathname}`);
    };
    const input = request('example.test/oversized-search', fetchImpl);
    input.importRequest = { ...input.importRequest!, externalSourceType: 'well-known' };

    await expect(acquireSkillsShSkill(input)).rejects.toMatchObject({ code: 'invalid_response' });
    expect(calls).toEqual([
      '/catalog/api/v1/skills/example.test/oversized-search',
      '/catalog/api/v1/skills/search?q=oversized-search&limit=200',
    ]);
  });

  it('bounds metadata rehydration across a non-yielding response body', async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const fetchImpl = async (input: string | URL): Promise<Response> => {
        const url = new URL(input.toString());
        calls.push(`${url.pathname}${url.search}`);
        if (url.pathname === '/catalog/api/v1/skills/example.test/hanging') {
          return json({ id: 'example.test/hanging', source: 'example.test', slug: 'hanging', installs: 0, hash: null, files: null });
        }
        if (url.pathname === '/catalog/api/v1/skills/search') {
          const body = new ReadableStream<Uint8Array>({ start() { /* intentionally never enqueue or close */ } });
          return new Response(body, { headers: { 'content-type': 'application/json' } });
        }
        throw new Error(`unexpected post-deadline request ${url.pathname}`);
      };
      const pending = acquireSkillsShSkill({
        ...request('example.test/hanging', fetchImpl),
        importRequest: {
          ...request('example.test/hanging', fetchImpl).importRequest!,
          externalSourceType: 'well-known',
        },
        limits: { requestTimeoutMs: 30_000 },
      });

      const outcome = expect(pending).rejects.toMatchObject({ code: 'metadata_timeout' });
      await vi.advanceTimersByTimeAsync(30_000);
      await outcome;
      expect(calls).toEqual([
        '/catalog/api/v1/skills/example.test/hanging',
        '/catalog/api/v1/skills/search?q=hanging&limit=200',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates caller cancellation while reading a detail response body', async () => {
    const controller = new AbortController();
    let detailStarted = false;
    let resolveDetailStarted!: () => void;
    let rejectDetailStarted!: (error: Error) => void;
    const detailStartedPromise = new Promise<void>((resolve, reject) => {
      resolveDetailStarted = resolve;
      rejectDetailStarted = reject;
    });
    const detailStartTimeout = setTimeout(
      () => rejectDetailStarted(new Error('detail request did not start')),
      1_000,
    );
    const calls: string[] = [];
    const fetchImpl = async (input: string | URL): Promise<Response> => {
      const url = new URL(input.toString());
      calls.push(url.pathname);
      if (url.pathname === '/catalog/api/v1/skills/example.test/cancelled') {
        detailStarted = true;
        resolveDetailStarted();
        const body = new ReadableStream<Uint8Array>({ start() { /* intentionally never yield */ } });
        return new Response(body, { headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected post-cancellation request ${url.pathname}`);
    };
    const pending = acquireSkillsShSkill({
      ...request('example.test/cancelled', fetchImpl),
      signal: controller.signal,
      limits: { requestTimeoutMs: 1_000 },
    });
    const completion = pending.then(
      () => ({ rejected: false, error: undefined }),
      (error: unknown) => ({ rejected: true, error }),
    );
    try {
      await detailStartedPromise;
    } finally {
      clearTimeout(detailStartTimeout);
    }
    expect(detailStarted).toBe(true);
    controller.abort();
    const result = await completion;
    expect(result.rejected).toBe(true);
    expect(result.error).toMatchObject({ code: 'cancelled' });
    expect(calls).toEqual(['/catalog/api/v1/skills/example.test/cancelled']);
  });

  it('extracts a bounded v0.2 archive and strips its single skill root', async () => {
    const skill = Buffer.from('---\nname: archived\ndescription: Archived demo\n---\n# archived\n', 'utf8');
    const readme = Buffer.from('support\n', 'utf8');
    const archive = storedZip([
      { path: 'archived/SKILL.md', bytes: skill },
      { path: 'archived/README.md', bytes: readme },
    ]);
    const expected = digest(archive);
    const fetchImpl = async (input: string | URL): Promise<Response> => {
      const url = new URL(input.toString());
      if (url.pathname === '/catalog/api/v1/skills/example.test/archived') {
        return json({ id: 'example.test/archived', source: 'example.test', slug: 'archived', installs: 1, hash: null, installUrl: `${BASE}/published/.well-known/agent-skills/archived`, files: null });
      }
      if (url.pathname === '/published/.well-known/agent-skills/index.json') {
        return json({ $schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json', skills: [{
          name: 'archived', type: 'archive', description: 'Archived demo', url: '/published/archived.zip', digest: expected,
        }] });
      }
      if (url.pathname === '/published/archived.zip') return bytes(archive, 'application/zip');
      return json({ error: 'not found' }, 404);
    };
    const input = request('example.test/archived', fetchImpl);
    input.importRequest = { ...input.importRequest!, externalId: 'example.test/archived', externalSourceType: 'well-known' };
    const result = await acquireSkillsShSkill(input);
    expect(result.bundle.files.map((file) => file.path)).toEqual(['README.md', 'SKILL.md']);
  });

  it('falls back to the legacy well-known index and rejects hostile snapshot paths', async () => {
    const skill = Buffer.from('---\nname: legacy\ndescription: Legacy demo\n---\n# legacy\n', 'utf8');
    const fetchImpl = async (input: string | URL): Promise<Response> => {
      const url = new URL(input.toString());
      if (url.pathname === '/catalog/api/v1/skills/example.test/legacy') {
        return json({ id: 'example.test/legacy', source: 'example.test', slug: 'legacy', name: 'legacy', sourceType: 'well-known', installUrl: `${BASE}/published/.well-known/skills/legacy`, url: '/site/example.test/legacy', hash: null, files: null });
      }
      if (url.pathname === '/published/.well-known/agent-skills/index.json') return json({ error: 'missing' }, 404);
      if (url.pathname === '/published/.well-known/skills/index.json') return json({ skills: [{ name: 'legacy', description: 'Legacy demo', files: ['SKILL.md'] }] });
      if (url.pathname === '/published/.well-known/skills/legacy/SKILL.md') return bytes(skill, 'text/markdown');
      return json({ error: 'not found' }, 404);
    };
    const result = await acquireSkillsShSkill(request('example.test/legacy', fetchImpl));
    expect(result.bundle.files[0]?.path).toBe('SKILL.md');
    await expect(acquireSkillsShSkill({
      ...request('octo/repo/demo', async (input: string | URL) => {
        const url = new URL(input.toString());
        if (url.pathname === '/catalog/api/v1/skills/octo/repo/demo') return json({ id: 'octo/repo/demo', source: 'octo/repo', slug: 'demo', name: 'demo', sourceType: 'github', installUrl: null, url: '/site/octo/repo/demo', hash: 'snapshot', files: [{ path: '../SKILL.md', contents: '---\nname: demo\ndescription: bad\n---\n' }] });
        return json({ error: 'not found' }, 404);
      }),
    })).rejects.toMatchObject({ code: 'invalid_path' });
  });

  it('rejects ambiguous GitHub source mappings instead of guessing', async () => {
    const first = Buffer.from('---\nname: demo\ndescription: First\n---\n', 'utf8');
    const second = Buffer.from('---\nname: demo\ndescription: Second\n---\n', 'utf8');
    const firstSha = sha(first);
    const secondSha = sha(second);
    const fetchImpl = async (input: string | URL): Promise<Response> => {
      const url = new URL(input.toString());
      if (url.pathname === '/catalog/api/v1/skills/octo/repo/demo') return json({ id: 'octo/repo/demo', source: 'octo/repo', slug: 'demo', name: 'demo', sourceType: 'github', installUrl: null, url: '/site/octo/repo/demo', hash: null, files: null });
      if (url.pathname === '/github/repos/octo/repo') return json({ default_branch: 'main' });
      if (url.pathname === '/github/repos/octo/repo/commits/main') return json({ sha: COMMIT });
      if (url.pathname === `/github/repos/octo/repo/git/trees/${COMMIT}`) return json({ sha: TREE, truncated: false, tree: [
        { path: 'one/demo/SKILL.md', mode: '100644', type: 'blob', sha: firstSha, size: first.length },
        { path: 'two/demo/SKILL.md', mode: '100644', type: 'blob', sha: secondSha, size: second.length },
      ] });
      if (url.pathname.endsWith(firstSha)) return json({ encoding: 'base64', content: first.toString('base64'), size: first.length, sha: firstSha });
      if (url.pathname.endsWith(secondSha)) return json({ encoding: 'base64', content: second.toString('base64'), size: second.length, sha: secondSha });
      return json({ error: 'not found' }, 404);
    };
    await expect(acquireSkillsShSkill({
      ...request('octo/repo/demo', fetchImpl),
      upstream: { ...request('octo/repo/demo', fetchImpl).upstream!, githubApiBaseUrl: `${BASE}/github` } as AcquireSkillInput['upstream'],
    })).rejects.toMatchObject({ code: 'ambiguous_source' });
  });

  it('does not resolve a catalog source outside the configured allowlist', async () => {
    let githubCalled = false;
    const fetchImpl = async (input: string | URL): Promise<Response> => {
      const url = new URL(input.toString());
      if (url.pathname === '/catalog/api/v1/skills/octo/repo/demo') {
        return json({ id: 'octo/repo/demo', source: 'evil/repo', slug: 'demo', installs: 1, hash: null, files: null });
      }
      githubCalled = true;
      return json({ error: 'unexpected source request' }, 404);
    };
    const base = request('octo/repo/demo', fetchImpl);
    base.importRequest = { ...base.importRequest!, externalId: 'octo/repo/demo', externalSourceType: 'github' };
    await expect(acquireSkillsShSkill(base)).rejects.toMatchObject({ code: 'identity_mismatch' });
    expect(githubCalled).toBe(false);
  });

  it('fails before source resolution when the selected snapshot changed', async () => {
    let sourceCalled = false;
    const fetchImpl = async (input: string | URL): Promise<Response> => {
      const url = new URL(input.toString());
      if (url.pathname === '/catalog/api/v1/skills/octo/repo/demo') {
        return json({ id: 'octo/repo/demo', source: 'octo/repo', slug: 'demo', installs: 1, hash: 'new-hash', files: null });
      }
      sourceCalled = true;
      return json({ error: 'unexpected source request' }, 404);
    };
    const base = request('octo/repo/demo', fetchImpl);
    base.importRequest = {
      ...base.importRequest!,
      externalId: 'octo/repo/demo',
      externalSourceType: 'github',
      externalSnapshotHash: 'old-hash',
    };
    await expect(acquireSkillsShSkill(base)).rejects.toMatchObject({ code: 'source_changed' });
    expect(sourceCalled).toBe(false);
  });

  it('requires an explicit source type when a detail has no snapshot', async () => {
    const fetchImpl = async (input: string | URL): Promise<Response> => {
      const url = new URL(input.toString());
      if (url.pathname === '/catalog/api/v1/skills/octo/repo/unresolved') {
        return json({ id: 'octo/repo/unresolved', source: 'octo/repo', slug: 'unresolved', installs: 0, hash: null, files: null });
      }
      throw new Error(`unexpected source request ${url.pathname}`);
    };
    await expect(acquireSkillsShSkill(request('octo/repo/unresolved', fetchImpl)))
      .rejects.toMatchObject({ code: 'source_unavailable' });
  });

  it('rejects an import external id that is different from its requested path', async () => {
    const fetchImpl = async (input: string | URL): Promise<Response> => {
      const url = new URL(input.toString());
      if (url.pathname === '/catalog/api/v1/skills/octo/repo/demo') {
        return json({ id: 'octo/repo/demo', source: 'octo/repo', slug: 'demo', installs: 1, hash: 'snapshot', files: [{ path: 'SKILL.md', contents: '---\nname: demo\ndescription: demo\n---\n' }] });
      }
      return json({ error: 'not found' }, 404);
    };
    const input = request('octo/repo/demo', fetchImpl);
    input.importRequest = { ...input.importRequest!, externalId: 'octo/repo/other' };
    await expect(acquireSkillsShSkill(input)).rejects.toMatchObject({ code: 'identity_mismatch' });
  });
});
