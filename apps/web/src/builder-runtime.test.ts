import { describe, expect, it } from 'vitest';
import { createBuilderBffRuntime } from '../server/builder-runtime';
import { createBuilderBffRuntime as createNodeBuilderBffRuntime } from '../server/runtime-node';
import { createBuilderBffRuntime as createEdgeBuilderBffRuntime } from '../server/runtime-edge';

const TOKENS = {
  PSKILLS_BUILDER_SERVICE_TOKEN: 'service-token',
  PSKILLS_BUILDER_EVE_API_TOKEN: 'eve-token',
};

describe('builder runtime configuration', () => {
  it('resolves the exact production origin and keeps credentials server-side', () => {
    expect(createBuilderBffRuntime({
      ...TOKENS,
      PSKILLS_BUILDER_APP_ORIGIN: 'https://private-skills-builder.vercel.app/',
      PSKILLS_ENVIRONMENT: 'production',
    })).toEqual({
      appOrigin: 'https://private-skills-builder.vercel.app',
      serviceToken: 'service-token',
      eveToken: 'eve-token',
    });
  });

  it.each([
    {},
    { PSKILLS_BUILDER_APP_ORIGIN: 'https://private-skills-builder.vercel.app' },
    { ...TOKENS, PSKILLS_BUILDER_APP_ORIGIN: 'https://private-skills-builder.vercel.app', PSKILLS_BUILDER_SERVICE_TOKEN: undefined },
    { ...TOKENS, PSKILLS_BUILDER_APP_ORIGIN: 'https://private-skills-builder.vercel.app', PSKILLS_BUILDER_SERVICE_TOKEN: '   ' },
    { ...TOKENS, PSKILLS_BUILDER_APP_ORIGIN: 'https://private-skills-builder.vercel.app', PSKILLS_BUILDER_EVE_API_TOKEN: 'eve token' },
  ])('disables an incomplete bridge: %j', (env) => {
    expect(createBuilderBffRuntime(env)).toBeUndefined();
  });

  it.each([
    'http://private-skills-builder.vercel.app',
    'https://other-builder.vercel.app',
    'https://user:password@private-skills-builder.vercel.app',
    'https://private-skills-builder.vercel.app/builder',
    'https://private-skills-builder.vercel.app?token=secret',
    'https://private-skills-builder.vercel.app#token',
    'https://private-skills-builder.vercel.app? ',
    'https://private-skills-builder.vercel.app# ',
  ])('rejects an unsafe production origin: %s', (origin) => {
    expect(createBuilderBffRuntime({
      ...TOKENS,
      PSKILLS_BUILDER_APP_ORIGIN: origin,
      PSKILLS_ENVIRONMENT: 'production',
    })).toBeUndefined();
  });

  it('allows an explicitly configured HTTPS fixture outside production', () => {
    expect(createBuilderBffRuntime({
      ...TOKENS,
      PSKILLS_BUILDER_APP_ORIGIN: 'https://builder.example.test/',
      PSKILLS_ENVIRONMENT: 'test',
    })?.appOrigin).toBe('https://builder.example.test');
  });

  it('is profile-neutral for the Node and edge callers', () => {
    const env = {
      ...TOKENS,
      PSKILLS_BUILDER_APP_ORIGIN: 'https://builder.example.test',
      PSKILLS_ENVIRONMENT: 'test',
    };
    const runtime = createBuilderBffRuntime(env);
    expect(runtime?.appOrigin).toBe('https://builder.example.test');
    expect(runtime?.serviceToken).toBe('service-token');
    expect(runtime?.eveToken).toBe('eve-token');
    expect(createNodeBuilderBffRuntime(env)).toEqual(runtime);
    expect(createEdgeBuilderBffRuntime(env)).toEqual(runtime);
  });
});
