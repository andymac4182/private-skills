import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  acquirePolyskillSkill,
  fetchPolyskillNativeSkill,
  polyskillNativeToSkillBundle,
  type PolyskillFetchLike,
} from '../src/polyskill.js';
import {
  parsePolyskillNativeSkill,
  serializePolyskillNativeSemanticFields,
} from '../../source-catalog/src/adapters/polyskill-native.js';

const payload = {
  id: 'fixture-id',
  name: '@acme/native-demo',
  version: '1.2.3',
  manifest: {
    name: '@acme/native-demo',
    version: '1.2.3',
    description: 'A native demo skill',
    type: 'prompt',
    skill: { instructions: './instructions.md' },
    author: { name: 'acme' },
  },
  instructions: 'first line\n\nlast line  \n',
  tools: null,
  adapters: { openai: { name: 'native' } },
  verified: true,
};

function digest(value: unknown): `sha256:${string}` {
  const skill = parsePolyskillNativeSkill(value);
  return `sha256:${createHash('sha256').update(serializePolyskillNativeSemanticFields(skill)).digest('hex')}`;
}

function response(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function fixtureFetch(value: unknown, status = 200, headers: Record<string, string> = {}): { fetch: PolyskillFetchLike; calls: Array<{ url: string; init: unknown }> } {
  const calls: Array<{ url: string; init: unknown }> = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return response(value, status, headers);
    },
  };
}

describe('PolySkill native worker acquisition', () => {
  it('fetches the exact version, denies redirects, verifies the digest, and converts all native source files', async () => {
    const fixture = fixtureFetch(payload);
    const result = await acquirePolyskillSkill({
      source: { kind: 'polyskill', name: payload.name, version: payload.version, contentDigest: digest(payload) },
      fetchImpl: fixture.fetch,
      externalId: payload.name,
      upstreamId: 'upstream-polyskill',
    });

    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]?.url).toBe('https://polyskill.ai/api/skills/%40acme%2Fnative-demo/1.2.3');
    expect(fixture.calls[0]?.init).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(fixture.calls[0]?.init).not.toHaveProperty('headers.authorization');
    expect(result.bundle.files.map((file) => file.path)).toEqual(['SKILL.md', 'instructions.md', 'skill.json']);

    const files = new Map(result.bundle.files.map((file) => [file.path, Buffer.from(file.content, 'base64').toString('utf8')]));
    expect(JSON.parse(files.get('skill.json')!)).toEqual(payload.manifest);
    expect(files.get('instructions.md')).toBe(payload.instructions);
    expect(files.get('SKILL.md')).toBe(`---\nname: acme-native-demo\ndescription: "A native demo skill"\n---\n${payload.instructions}`);
    expect(result.provenance).toMatchObject({
      kind: 'native',
      repository: 'https://polyskill.ai',
      path: payload.name,
      revision: payload.version,
      externalDigest: digest(payload),
      sourceProviderOrigin: 'https://polyskill.ai',
      sourceResolutionKind: 'snapshot',
    });
    expect(result.provenance.sourceDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it('rejects digest, identity, missing-version, redirect, malformed, and response-size failures before distribution', async () => {
    const wrongDigest = fixtureFetch(payload);
    await expect(acquirePolyskillSkill({
      source: { kind: 'polyskill', name: payload.name, version: payload.version, contentDigest: `sha256:${'0'.repeat(64)}` },
      fetchImpl: wrongDigest.fetch,
    })).rejects.toMatchObject({ code: 'digest_mismatch' });

    const mismatch = fixtureFetch({ ...payload, manifest: { ...payload.manifest, version: '9.9.9' } });
    await expect(acquirePolyskillSkill({
      source: { kind: 'polyskill', name: payload.name, version: payload.version, contentDigest: digest(payload) },
      fetchImpl: mismatch.fetch,
    })).rejects.toMatchObject({ code: 'identity_mismatch' });

    const missing = fixtureFetch({}, 404);
    await expect(acquirePolyskillSkill({
      source: { kind: 'polyskill', name: payload.name, version: payload.version, contentDigest: digest(payload) },
      fetchImpl: missing.fetch,
    })).rejects.toMatchObject({ code: 'source_not_found' });

    const redirect = fixtureFetch(payload, 302);
    await expect(fetchPolyskillNativeSkill({
      source: { kind: 'polyskill', name: payload.name, version: payload.version, contentDigest: digest(payload) },
      fetchImpl: redirect.fetch,
    })).rejects.toMatchObject({ code: 'redirect_denied' });

    const malformed = fixtureFetch('not-an-object');
    await expect(fetchPolyskillNativeSkill({
      source: { kind: 'polyskill', name: payload.name, version: payload.version, contentDigest: digest(payload) },
      fetchImpl: malformed.fetch,
    })).rejects.toMatchObject({ code: 'invalid_native' });

    const tooLarge = fixtureFetch(payload, 200, { 'content-length': '999999' });
    await expect(fetchPolyskillNativeSkill({
      source: { kind: 'polyskill', name: payload.name, version: payload.version, contentDigest: digest(payload) },
      fetchImpl: tooLarge.fetch,
      limits: { maxResponseBytes: 128 },
    })).rejects.toMatchObject({ code: 'response_too_large' });
  });

  it('does not make a request for malformed source identity and keeps the native converter data-only', async () => {
    const fixture = fixtureFetch(payload);
    await expect(acquirePolyskillSkill({
      source: { kind: 'polyskill', name: '@acme/../native-demo', version: payload.version, contentDigest: digest(payload) },
      fetchImpl: fixture.fetch,
    })).rejects.toMatchObject({ code: 'invalid_source' });
    expect(fixture.calls).toHaveLength(0);

    const bundle = polyskillNativeToSkillBundle(parsePolyskillNativeSkill(payload));
    expect(bundle.files.some((file) => file.path === 'adapters.json')).toBe(false);
    expect(bundle.files.some((file) => file.path === 'tools.json')).toBe(false);
  });

  it('requires a pinned version identity', async () => {
    const fixture = fixtureFetch(payload);
    await expect(fetchPolyskillNativeSkill({
      source: { kind: 'polyskill', name: payload.name, version: 'latest', contentDigest: digest(payload) },
      fetchImpl: fixture.fetch,
    })).rejects.toMatchObject({ code: 'invalid_source' });
    expect(fixture.calls).toHaveLength(0);
  });

  it('allows only explicit loopback test transports, including an ephemeral port', async () => {
    const fixture = fixtureFetch(payload);
    await expect(fetchPolyskillNativeSkill({
      source: { kind: 'polyskill', name: payload.name, version: payload.version, contentDigest: digest(payload) },
      fetchImpl: fixture.fetch,
      apiBaseUrl: 'http://127.0.0.1:43123',
      allowLoopbackForTests: true,
    })).resolves.toBeTruthy();
    expect(fixture.calls[0]?.url).toBe('http://127.0.0.1:43123/api/skills/%40acme%2Fnative-demo/1.2.3');
  });

  it('reports one coarse source attempt without exposing the request URL', async () => {
    const fixture = fixtureFetch(payload);
    const kinds: string[] = [];
    await fetchPolyskillNativeSkill({
      source: { kind: 'polyskill', name: payload.name, version: payload.version, contentDigest: digest(payload) },
      fetchImpl: fixture.fetch,
      upstreamObserver: { record(kind) { kinds.push(kind); } },
    });
    expect(kinds).toEqual(['source']);
  });
});
