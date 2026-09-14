import { describe, expect, it } from 'vitest';

import {
  POLYSKILL_API_ORIGIN,
  canonicalPolyskillFileJson,
  parsePolyskillNativeSkill,
  polyskillContentDigest,
  polyskillNativeIdentity,
  polyskillSkillSlug,
  serializePolyskillNativeSemanticFields,
} from '../src/adapters/polyskill-native.js';

const manifest = {
  name: '@acme/native-demo',
  version: '1.2.3',
  description: 'A native demo skill',
  type: 'prompt',
  skill: { instructions: './instructions.md' },
  author: { name: 'acme' },
  keywords: ['demo'],
};

const payload = {
  name: manifest.name,
  version: manifest.version,
  manifest,
  instructions: 'first line\n\nlast line  \n',
  tools: null,
  adapters: { anthropic: { name: 'native' }, openai: { name: 'native' } },
  verified: true,
  created_at: '2026-09-14T00:00:00.000Z',
};

describe('PolySkill native semantic helpers', () => {
  it('normalizes the documented native response and ignores listing metadata', async () => {
    const native = parsePolyskillNativeSkill(payload);
    expect(native.manifest).toEqual(manifest);
    expect(native.instructions).toBe(payload.instructions);
    expect(native.tools).toBeUndefined();
    expect(native.adapters).toEqual(payload.adapters);
    expect(await polyskillContentDigest(payload)).toBe(await polyskillContentDigest({
      adapters: payload.adapters,
      tools: null,
      instructions: payload.instructions,
      manifest: { ...manifest },
      name: manifest.name,
      version: manifest.version,
      verified: false,
    }));
  });

  it('uses sorted semantic JSON keys while preserving array order and instruction bytes', () => {
    const first = serializePolyskillNativeSemanticFields(payload);
    const second = serializePolyskillNativeSemanticFields({
      adapters: { openai: { name: 'native' }, anthropic: { name: 'native' } },
      instructions: payload.instructions,
      tools: null,
      manifest: { ...manifest },
    });
    expect(new TextDecoder().decode(first)).toContain('"instructions":"first line\\n\\nlast line  \\n"');
    expect(new TextDecoder().decode(first)).toBe(new TextDecoder().decode(second));
    const changedArray = serializePolyskillNativeSemanticFields({
      ...payload,
      manifest: { ...manifest, keywords: ['different'] },
    });
    expect(new TextDecoder().decode(first)).not.toBe(new TextDecoder().decode(changedArray));
    expect(canonicalPolyskillFileJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('rejects external references, composites, and remote tool definitions', () => {
    expect(() => parsePolyskillNativeSkill({
      ...payload,
      manifest: { ...manifest, skill: { instructions: 'https://evil.example/instructions.md' } },
    })).toThrow(/instructions reference/i);
    expect(() => parsePolyskillNativeSkill({
      ...payload,
      manifest: { ...manifest, type: 'composite' },
    })).toThrow(/composite/i);
    expect(() => parsePolyskillNativeSkill({
      ...payload,
      tools: { tools: [{ name: 'remote', url: 'https://evil.example/tool' }] },
    })).toThrow(/tool field/i);
    expect(() => parsePolyskillNativeSkill({
      ...payload,
      tools: { tools: [], endpoint: 'https://evil.example/tool' },
    })).toThrow(/tools.json field/i);
    expect(() => parsePolyskillNativeSkill({
      ...payload,
      manifest: { ...manifest, skill: { instructions: './instructions.md' } },
      instructions: null,
    })).toThrow(/missing/i);
  });

  it('requires exact native identity fields and gives a safe wrapper slug', () => {
    expect(() => parsePolyskillNativeSkill({ ...payload, name: '@other/native-demo' })).toThrow(/name/i);
    expect(() => parsePolyskillNativeSkill({ ...payload, manifest: { ...manifest, description: '' } })).toThrow(/description/i);
    expect(() => polyskillSkillSlug('@Acme/native-demo')).toThrow();
    expect(polyskillSkillSlug('@acme/native.demo')).toBe('acme-native-demo');
    expect(POLYSKILL_API_ORIGIN).toBe('https://polyskill.ai');
  });

  it('validates plain API input before extracting its identity', async () => {
    await expect(polyskillNativeIdentity(payload)).resolves.toMatchObject({
      name: manifest.name,
      version: manifest.version,
      contentDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    await expect(polyskillNativeIdentity({ ...payload, manifest: { ...manifest, name: '@bad/../name' } })).rejects.toThrow(/name/i);
  });

  it('does not coerce non-JSON object instances into native metadata', () => {
    expect(() => parsePolyskillNativeSkill({ ...payload, manifest: new Date() })).toThrow(/manifest/i);
  });
});
