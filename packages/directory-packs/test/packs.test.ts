import { describe, expect, it, vi } from 'vitest';

import {
  SKILLS_DISCOVERY_SCHEMA_V2,
  SkillsPackClient,
} from '../src/index.js';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const preferredIndex = '/p/fixture-unlisted/.well-known/agent-skills/index.json';

describe('SkillsPackClient C1 pack acceptance fixtures', () => {
  it('previews an unlisted manifest without fetching any member artifact', async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith(preferredIndex)) {
        return jsonResponse({
          $schema: SKILLS_DISCOVERY_SCHEMA_V2,
          skills: [{
            name: 'preview-skill',
            type: 'skill-md',
            description: 'Metadata-only preview fixture',
            url: 'artifact/preview-skill.md',
            digest: `sha256:${'a'.repeat(64)}`,
          }],
        });
      }
      throw new Error('member bytes must not be fetched during inspect');
    });

    const manifest = await new SkillsPackClient({ fetch }).inspect('https://skills.sh/p/fixture-unlisted');

    expect(manifest.packUrl).toBe('https://skills.sh/p/fixture-unlisted');
    expect(manifest.schema).toBe('0.2.0');
    expect(manifest.members).toEqual([expect.objectContaining({
      name: 'preview-skill',
      type: 'skill-md',
      artifactUrl: 'https://skills.sh/p/fixture-unlisted/.well-known/agent-skills/artifact/preview-skill.md',
      externalDigest: `sha256:${'a'.repeat(64)}`,
      files: null,
    })]);
    expect(calls).toEqual(['https://skills.sh/p/fixture-unlisted/.well-known/agent-skills/index.json']);
  });

  it('reports a deleted unlisted pack as not found without widening to the host root', async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (input: string | URL) => {
      calls.push(String(input));
      return new Response('', { status: 404 });
    });

    await expect(new SkillsPackClient({ fetch }).inspect('https://skills.sh/p/fixture-deleted'))
      .rejects.toMatchObject({ code: 'not_found', status: 404 });
    expect(calls).toEqual([
      'https://skills.sh/p/fixture-deleted/.well-known/agent-skills/index.json',
      'https://skills.sh/p/fixture-deleted/.well-known/skills/index.json',
    ]);
    expect(calls.some((url) => url === 'https://skills.sh/.well-known/agent-skills/index.json')).toBe(false);
    expect(calls.some((url) => url === 'https://skills.sh/.well-known/skills/index.json')).toBe(false);
  });

  it.each([
    ['malformed JSON', () => new Response('{', { status: 200 }), 'invalid_manifest'],
    ['unsupported schema', () => jsonResponse({ $schema: 'https://schemas.agentskills.io/discovery/0.3.0/schema.json', skills: [] }), 'invalid_manifest'],
    ['empty skills', () => jsonResponse({ skills: [] }), 'invalid_manifest'],
    ['invalid v2 digest', () => jsonResponse({
      $schema: SKILLS_DISCOVERY_SCHEMA_V2,
      skills: [{ name: 'bad-digest', type: 'skill-md', description: 'bad', url: 'skill.md', digest: 'sha256:not-a-digest' }],
    }), 'invalid_manifest'],
    ['duplicate member names', () => jsonResponse({
      $schema: SKILLS_DISCOVERY_SCHEMA_V2,
      skills: [
        { name: 'duplicate', type: 'skill-md', description: 'one', url: 'one.md', digest: `sha256:${'b'.repeat(64)}` },
        { name: 'duplicate', type: 'skill-md', description: 'two', url: 'two.md', digest: `sha256:${'c'.repeat(64)}` },
      ],
    }), 'invalid_manifest'],
    ['legacy files without SKILL.md', () => jsonResponse({
      skills: [{ name: 'legacy', description: 'missing entry point', files: ['README.md'] }],
    }), 'invalid_manifest'],
  ] as const)('rejects %s as a bounded malformed manifest', async (_label, response, code) => {
    const fetch = vi.fn(async () => response());
    await expect(new SkillsPackClient({ fetch }).inspect('https://skills.sh/p/fixture-malformed'))
      .rejects.toMatchObject({ code });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('falls back from a malformed preferred index only to the same pack legacy index', async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/.well-known/agent-skills/index.json')) return jsonResponse({ skills: [] });
      if (url.endsWith('/.well-known/skills/index.json')) {
        return jsonResponse({ skills: [{ name: 'legacy-skill', description: 'legacy fallback', files: ['SKILL.md'] }] });
      }
      throw new Error('unexpected host-wide or artifact request');
    });

    const manifest = await new SkillsPackClient({ fetch }).inspect('https://skills.sh/p/fixture-legacy-fallback');

    expect(manifest.schema).toBe('0.1.0');
    expect(manifest.members[0]).toEqual(expect.objectContaining({ name: 'legacy-skill', type: 'files', files: ['SKILL.md'] }));
    expect(calls).toEqual([
      'https://skills.sh/p/fixture-legacy-fallback/.well-known/agent-skills/index.json',
      'https://skills.sh/p/fixture-legacy-fallback/.well-known/skills/index.json',
    ]);
  });
});
