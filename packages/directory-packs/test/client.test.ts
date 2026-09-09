import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  SKILLS_DISCOVERY_SCHEMA_V2,
  SkillsPackClient,
  SkillsPackError,
} from '../src/index.js';

function jsonResponse(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function bytesResponse(bytes: Uint8Array, status = 200, headers: HeadersInit = {}): Response {
  return new Response(bytes.buffer as ArrayBuffer, {
    status,
    headers: { 'content-type': 'application/octet-stream', ...headers },
  });
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

const skillBytes = new TextEncoder().encode(
  '---\nname: safe-skill\ndescription: Safe test skill\n---\n\nUse as data only.\n',
);
const archiveBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02]);

describe('SkillsPackClient', () => {
  it('resolves the scoped v0.2 index, verifies the artifact, and never forwards credentials', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/p/demo/.well-known/agent-skills/index.json')) {
        return jsonResponse({
          $schema: SKILLS_DISCOVERY_SCHEMA_V2,
          skills: [{
            name: 'safe-skill',
            type: 'skill-md',
            description: 'Safe test skill',
            url: 'artifact/safe-skill.md',
            digest: digest(skillBytes),
          }],
        });
      }
      if (url.endsWith('/p/demo/.well-known/agent-skills/artifact/safe-skill.md')) {
        return bytesResponse(skillBytes);
      }
      return new Response('', { status: 404 });
    });

    const client = new SkillsPackClient({ fetch });
    const manifest = await client.inspect('https://skills.sh/p/demo/');
    const [candidate] = await client.fetchMembers(manifest, ['safe-skill']);

    expect(manifest.schema).toBe('0.2.0');
    expect(manifest.packUrl).toBe('https://skills.sh/p/demo');
    expect(candidate?.source.kind).toBe('skill-md');
    expect(candidate && 'bytes' in candidate.source && candidate.source.bytes).toEqual(skillBytes);
    expect(calls[0]?.url).toBe('https://skills.sh/p/demo/.well-known/agent-skills/index.json');
    expect(calls[1]?.init?.redirect).toBe('manual');
    expect((calls[1]?.init?.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('uses the legacy scoped index and fetches only declared safe relative files', async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/p/legacy/.well-known/agent-skills/index.json')) return new Response('', { status: 404 });
      if (url.endsWith('/p/legacy/.well-known/skills/index.json')) {
        return jsonResponse({ skills: [{ name: 'legacy-skill', description: 'Legacy', files: ['SKILL.md', 'docs/readme.txt'] }] });
      }
      if (url.endsWith('/p/legacy/.well-known/skills/legacy-skill/SKILL.md')) return bytesResponse(skillBytes);
      if (url.endsWith('/p/legacy/.well-known/skills/legacy-skill/docs/readme.txt')) return bytesResponse(new TextEncoder().encode('read me'));
      return new Response('', { status: 404 });
    });

    const client = new SkillsPackClient({ fetch });
    const manifest = await client.inspect('https://www.skills.sh/p/legacy');
    const [candidate] = await client.fetchMembers(manifest, ['legacy-skill']);

    expect(manifest.schema).toBe('0.1.0');
    expect(candidate?.source.kind).toBe('files');
    expect(candidate && 'files' in candidate.source && candidate.source.files.map((file) => file.path)).toEqual([
      'SKILL.md',
      'docs/readme.txt',
    ]);
    expect(calls).not.toContain('https://skills.sh/.well-known/agent-skills/index.json');
    expect(calls).not.toContain('https://skills.sh/.well-known/skills/index.json');
  });

  it('rejects unlisted pack URLs that can widen scope or carry credentials', async () => {
    const client = new SkillsPackClient({ fetch: vi.fn() });
    await expect(client.inspect('http://skills.sh/p/demo')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(client.inspect('https://skills.sh/p/demo/other')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(client.inspect('https://skills.sh/p/demo?token=secret')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(client.inspect('https://user:pass@skills.sh/p/demo')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(client.inspect('https://skills.sh/p/a%2Fb')).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('does not fall back from a missing scoped pack index to a host-wide index', async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (input: string | URL) => {
      calls.push(String(input));
      if (calls.at(-1)?.includes('/p/demo/')) return new Response('', { status: 404 });
      return jsonResponse({ skills: [{ name: 'should-not-be-read', description: 'wrong', files: ['SKILL.md'] }] });
    });
    const client = new SkillsPackClient({ fetch });
    await expect(client.inspect('https://skills.sh/p/demo')).rejects.toMatchObject({ code: 'not_found' });
    expect(calls).toEqual([
      'https://skills.sh/p/demo/.well-known/agent-skills/index.json',
      'https://skills.sh/p/demo/.well-known/skills/index.json',
    ]);
  });

  it('verifies v0.2 archive bytes but leaves extraction to the governed worker', async () => {
    const fetch = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/p/archive/.well-known/agent-skills/index.json')) {
        return jsonResponse({
          $schema: SKILLS_DISCOVERY_SCHEMA_V2,
          skills: [{
            name: 'archive-skill',
            type: 'archive',
            description: 'Archive',
            url: 'artifact/archive.zip',
            digest: digest(archiveBytes),
          }],
        });
      }
      if (url.endsWith('/p/archive/.well-known/agent-skills/artifact/archive.zip')) return bytesResponse(archiveBytes);
      return new Response('', { status: 404 });
    });

    const client = new SkillsPackClient({ fetch });
    const manifest = await client.inspect('https://skills.sh/p/archive');
    const candidate = await client.fetchMember(manifest, 'archive-skill');
    expect(candidate.source.kind).toBe('archive');
    expect('bytes' in candidate.source && candidate.source.bytes).toEqual(archiveBytes);
  });

  it('previews an absolute CDN artifact but requires origin approval before fetching it', async () => {
    const cdnUrl = 'https://cdn.example.invalid/private-skill.md';
    const fetch = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/p/cdn/.well-known/agent-skills/index.json')) {
        return jsonResponse({
          $schema: SKILLS_DISCOVERY_SCHEMA_V2,
          skills: [{
            name: 'cdn-skill',
            type: 'skill-md',
            description: 'CDN',
            url: cdnUrl,
            digest: digest(skillBytes),
          }],
        });
      }
      if (url === cdnUrl) return bytesResponse(skillBytes);
      return new Response('', { status: 404 });
    });

    const previewClient = new SkillsPackClient({ fetch });
    const preview = await previewClient.inspect('https://skills.sh/p/cdn');
    expect(preview.members[0]?.artifactUrl).toBe(cdnUrl);
    await expect(previewClient.fetchMember(preview, 'cdn-skill')).rejects.toMatchObject({ code: 'unsafe_origin' });

    const client = new SkillsPackClient({ fetch, allowedArtifactOrigins: ['https://cdn.example.invalid'] });
    const manifest = await client.inspect('https://skills.sh/p/cdn');
    const candidate = await client.fetchMember(manifest, 'cdn-skill');
    expect(candidate.source.kind).toBe('skill-md');
    expect(fetch).toHaveBeenCalledWith(cdnUrl, expect.objectContaining({ redirect: 'manual' }));
  });

  it('fails closed on digest, origin, path, redirect, and response-size violations', async () => {
    const wrongDigestFetch = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/p/bad/.well-known/agent-skills/index.json')) {
        return jsonResponse({
          $schema: SKILLS_DISCOVERY_SCHEMA_V2,
          skills: [{ name: 'bad-skill', type: 'skill-md', description: 'bad', url: 'bad.md', digest: digest(skillBytes) }],
        });
      }
      return bytesResponse(new TextEncoder().encode('different'));
    });
    const wrongDigest = new SkillsPackClient({ fetch: wrongDigestFetch });
    const badManifest = await wrongDigest.inspect('https://skills.sh/p/bad');
    await expect(wrongDigest.fetchMember(badManifest, 'bad-skill')).rejects.toMatchObject({ code: 'artifact_digest_mismatch' });

    const unsafeOriginFetch = vi.fn(async () => jsonResponse({
      $schema: SKILLS_DISCOVERY_SCHEMA_V2,
      skills: [{ name: 'unsafe', type: 'skill-md', description: 'unsafe', url: 'https://evil.invalid/a', digest: digest(skillBytes) }],
    }));
    const unsafeOriginClient = new SkillsPackClient({ fetch: unsafeOriginFetch });
    const unsafeOriginManifest = await unsafeOriginClient.inspect('https://skills.sh/p/unsafe');
    await expect(unsafeOriginClient.fetchMember(unsafeOriginManifest, 'unsafe')).rejects.toMatchObject({ code: 'unsafe_origin' });

    const unsafePathFetch = vi.fn(async () => jsonResponse({ skills: [{ name: 'legacy', description: 'legacy', files: ['../SKILL.md'] }] }));
    await expect(new SkillsPackClient({ fetch: unsafePathFetch }).inspect('https://skills.sh/p/path')).rejects.toMatchObject({ code: 'unsafe_path' });

    const redirectFetch = vi.fn(async () => new Response('', { status: 302, headers: { location: 'https://evil.invalid' } }));
    await expect(new SkillsPackClient({ fetch: redirectFetch }).inspect('https://skills.sh/p/redirect')).rejects.toMatchObject({ code: 'redirect_denied' });

    const oversizedFetch = vi.fn(async () => bytesResponse(new Uint8Array([1, 2, 3, 4]), 200, { 'content-length': '4' }));
    await expect(new SkillsPackClient({ fetch: oversizedFetch, limits: { maxManifestBytes: 3 } }).inspect('https://skills.sh/p/large')).rejects.toMatchObject({ code: 'size_limit' });
  });

  it('returns no partial selected-member result when one member fails', async () => {
    const first = new TextEncoder().encode('---\nname: first\ndescription: first\n---\n');
    const second = new TextEncoder().encode('---\nname: second\ndescription: second\n---\n');
    const fetch = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/p/multi/.well-known/agent-skills/index.json')) {
        return jsonResponse({
          $schema: SKILLS_DISCOVERY_SCHEMA_V2,
          skills: [
            { name: 'first', type: 'skill-md', description: 'first', url: 'first.md', digest: digest(first) },
            { name: 'second', type: 'skill-md', description: 'second', url: 'second.md', digest: digest(second) },
          ],
        });
      }
      if (url.endsWith('/p/multi/.well-known/agent-skills/first.md')) return bytesResponse(first);
      return new Response('', { status: 404 });
    });
    const client = new SkillsPackClient({ fetch });
    const manifest = await client.inspect('https://skills.sh/p/multi');
    await expect(client.fetchMembers(manifest, ['first', 'second'])).rejects.toMatchObject({ code: 'not_found' });
  });
});
