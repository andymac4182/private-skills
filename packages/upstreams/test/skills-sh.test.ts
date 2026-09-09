import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { describe, expect, it } from 'vitest';

import {
  acquireSkillsShSkill,
  UpstreamAcquisitionError,
} from '../src/index.js';
import type { AcquireSkillInput } from '../src/index.js';

const BASE = 'http://127.0.0.1:32123';
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
