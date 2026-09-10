import { describe, expect, it } from 'vitest';

import {
  createSkillsShGatewayCredential,
  createUnavailableSkillsDirectoryTokenProvider,
  MAX_SKILLS_DIRECTORY_GATEWAYS,
  MAX_SKILLS_DIRECTORY_GATEWAYS_JSON_BYTES,
  normalizeDirectoryBaseURL,
  resolveSkillsDirectoryGateways,
  resolveSkillsDirectoryConnection,
  SKILLS_DIRECTORY_AUTH_UNAVAILABLE,
} from '../src/index.js';

describe('portable skills.sh gateway configuration', () => {
  it('keeps directory disabled even when gateway settings are present', () => {
    expect(resolveSkillsDirectoryConnection({
      PSKILLS_DIRECTORY_GATEWAY_URL: 'https://gateway.example.test/catalog',
      PSKILLS_DIRECTORY_GATEWAY_TOKEN: 'gateway-secret',
    })).toEqual({ kind: 'disabled' });
  });

  it('selects the official origin without reading a gateway token', () => {
    expect(resolveSkillsDirectoryConnection({
      PSKILLS_DIRECTORY_ENABLED: 'true',
      PSKILLS_DIRECTORY_GATEWAY_TOKEN: 'wrong\r\nvalue',
    })).toEqual({ kind: 'official', baseURL: 'https://skills.sh' });
  });

  it('normalizes a complete custom gateway and binds its token to the callback', async () => {
    const connection = resolveSkillsDirectoryConnection({
      PSKILLS_DIRECTORY_ENABLED: 'true',
      PSKILLS_DIRECTORY_GATEWAY_URL: 'https://gateway.example.test/catalog///',
      PSKILLS_DIRECTORY_GATEWAY_TOKEN: 'gateway-secret',
      PSKILLS_DIRECTORY_TOKEN: 'legacy-secret',
    });

    expect(connection.kind).toBe('gateway');
    if (connection.kind !== 'gateway') throw new Error('expected gateway connection');
    expect(connection.gateway.baseUrl).toBe('https://gateway.example.test/catalog');
    await expect(connection.gateway.getToken()).resolves.toBe('gateway-secret');
    expect('token' in connection.gateway).toBe(false);
  });

  it('resolves multiple JSON profiles with exact normalized bases and callback-only tokens', async () => {
    const resolution = resolveSkillsDirectoryGateways({
      PSKILLS_DIRECTORY_ENABLED: 'true',
      PSKILLS_DIRECTORY_GATEWAYS_JSON: JSON.stringify([
        { baseUrl: 'https://catalog-a.example.test/api///', tokenEnv: 'PSKILLS_GATEWAY_A' },
        { baseUrl: 'https://catalog-b.example.test/catalog', tokenEnv: 'PSKILLS_GATEWAY_B' },
      ]),
      PSKILLS_GATEWAY_A: 'token-a',
      PSKILLS_GATEWAY_B: 'token-b',
    });

    expect(resolution.kind).toBe('ready');
    if (resolution.kind !== 'ready') throw new Error('expected ready gateway profiles');
    expect(resolution.gateways.map((gateway) => gateway.baseUrl)).toEqual([
      'https://catalog-a.example.test/api',
      'https://catalog-b.example.test/catalog',
    ]);
    await expect(resolution.gateways[0]!.getToken()).resolves.toBe('token-a');
    await expect(resolution.gateways[1]!.getToken()).resolves.toBe('token-b');
    expect(JSON.stringify(resolution)).not.toContain('token-a');
    expect(JSON.stringify(resolution)).not.toContain('token-b');
  });

  it('keeps the legacy gateway profile and rejects duplicate normalized bases', () => {
    const duplicate = resolveSkillsDirectoryGateways({
      PSKILLS_DIRECTORY_ENABLED: 'true',
      PSKILLS_DIRECTORY_GATEWAY_URL: 'https://catalog.example.test/api/',
      PSKILLS_DIRECTORY_GATEWAY_TOKEN: 'legacy-token',
      PSKILLS_DIRECTORY_GATEWAYS_JSON: JSON.stringify([
        { baseUrl: 'https://catalog.example.test/api///', tokenEnv: 'PSKILLS_GATEWAY_DUPLICATE' },
      ]),
      PSKILLS_GATEWAY_DUPLICATE: 'profile-token',
    });
    expect(duplicate).toEqual({ kind: 'unavailable', reason: 'duplicate_gateway_base' });
  });

  it('uses a JSON profile for the backwards-compatible configured UI base', async () => {
    const connection = resolveSkillsDirectoryConnection({
      PSKILLS_DIRECTORY_ENABLED: 'true',
      PSKILLS_SKILLS_SH_BASE_URL: 'https://catalog.example.test/api/',
      PSKILLS_DIRECTORY_GATEWAYS_JSON: JSON.stringify([
        { baseUrl: 'https://catalog.example.test/api', tokenEnv: 'PSKILLS_GATEWAY_PROFILE' },
      ]),
      PSKILLS_GATEWAY_PROFILE: 'profile-token',
    });

    expect(connection.kind).toBe('gateway');
    if (connection.kind !== 'gateway') throw new Error('expected JSON gateway profile');
    expect(connection.gateway.baseUrl).toBe('https://catalog.example.test/api');
    await expect(connection.gateway.getToken()).resolves.toBe('profile-token');
  });

  it.each([
    ['invalid JSON', '{'],
    ['non-object profile', JSON.stringify(['profile'])],
    ['extra profile field', JSON.stringify([{ baseUrl: 'https://catalog.example.test', tokenEnv: 'PSKILLS_GATEWAY', extra: true }])],
    ['invalid token environment name', JSON.stringify([{ baseUrl: 'https://catalog.example.test', tokenEnv: 'gateway_token' }])],
    ['missing token environment value', JSON.stringify([{ baseUrl: 'https://catalog.example.test', tokenEnv: 'PSKILLS_GATEWAY_MISSING' }])],
    ['official gateway host', JSON.stringify([{ baseUrl: 'https://www.skills.sh/catalog', tokenEnv: 'PSKILLS_GATEWAY' }])],
  ])('fails closed for %s gateway profiles', (_label, encoded) => {
    const resolution = resolveSkillsDirectoryGateways({
      PSKILLS_DIRECTORY_ENABLED: 'true',
      PSKILLS_DIRECTORY_GATEWAYS_JSON: encoded,
      PSKILLS_GATEWAY: 'should-not-be-used',
    });
    expect(resolution.kind).toBe('unavailable');
    expect(JSON.stringify(resolution)).not.toContain('should-not-be-used');
  });

  it('enforces profile count and UTF-8 JSON byte bounds', () => {
    const profiles = Array.from({ length: MAX_SKILLS_DIRECTORY_GATEWAYS + 1 }, (_, index) => ({
      baseUrl: `https://catalog-${index}.example.test`,
      tokenEnv: `PSKILLS_GATEWAY_${index}`,
    }));
    const env: Record<string, string> = {
      PSKILLS_DIRECTORY_ENABLED: 'true',
      PSKILLS_DIRECTORY_GATEWAYS_JSON: JSON.stringify(profiles),
    };
    for (const profile of profiles) env[profile.tokenEnv] = 'token';
    expect(resolveSkillsDirectoryGateways(env)).toEqual({ kind: 'unavailable', reason: 'gateway_profile_limit' });

    expect(resolveSkillsDirectoryGateways({
      PSKILLS_DIRECTORY_ENABLED: 'true',
      PSKILLS_DIRECTORY_GATEWAYS_JSON: '🛡️'.repeat(Math.ceil(MAX_SKILLS_DIRECTORY_GATEWAYS_JSON_BYTES / 4)),
    })).toEqual({ kind: 'unavailable', reason: 'gateway_profiles_too_large' });
  });

  it.each([
    ['missing token', { PSKILLS_DIRECTORY_GATEWAY_URL: 'https://gateway.example.test' }, 'missing_gateway_token'],
    ['legacy token only', { PSKILLS_DIRECTORY_GATEWAY_URL: 'https://gateway.example.test', PSKILLS_DIRECTORY_TOKEN: 'legacy-secret' }, 'missing_gateway_token'],
    ['invalid protocol', { PSKILLS_DIRECTORY_GATEWAY_URL: 'http://gateway.example.test', PSKILLS_DIRECTORY_GATEWAY_TOKEN: 'secret' }, 'invalid_gateway_url'],
    ['credentials in URL', { PSKILLS_DIRECTORY_GATEWAY_URL: 'https://user:password@gateway.example.test', PSKILLS_DIRECTORY_GATEWAY_TOKEN: 'secret' }, 'invalid_gateway_url'],
    ['query in URL', { PSKILLS_DIRECTORY_GATEWAY_URL: 'https://gateway.example.test?token=secret', PSKILLS_DIRECTORY_GATEWAY_TOKEN: 'secret' }, 'invalid_gateway_url'],
    ['fragment in URL', { PSKILLS_DIRECTORY_GATEWAY_URL: 'https://gateway.example.test#secret', PSKILLS_DIRECTORY_GATEWAY_TOKEN: 'secret' }, 'invalid_gateway_url'],
    ['official www alias', { PSKILLS_DIRECTORY_GATEWAY_URL: 'https://www.skills.sh', PSKILLS_DIRECTORY_GATEWAY_TOKEN: 'secret' }, 'invalid_gateway_url'],
    ['official trailing-dot alias', { PSKILLS_DIRECTORY_GATEWAY_URL: 'https://skills.sh.', PSKILLS_DIRECTORY_GATEWAY_TOKEN: 'secret' }, 'invalid_gateway_url'],
    ['official repeated trailing-dot alias', { PSKILLS_DIRECTORY_GATEWAY_URL: 'https://skills.sh..', PSKILLS_DIRECTORY_GATEWAY_TOKEN: 'secret' }, 'invalid_gateway_url'],
  ])('fails closed for %s', (_label, settings, reason) => {
    expect(resolveSkillsDirectoryConnection({ PSKILLS_DIRECTORY_ENABLED: 'true', ...settings })).toEqual({ kind: 'unavailable', reason });
  });

  it.each([
    ['whitespace-only', '   '],
    ['leading whitespace', ' secret'],
    ['control character', 'secret\nvalue'],
    ['oversized UTF-8 token', '🛡️'.repeat(2_000)],
    ['unpaired surrogate', 'secret\ud800'],
  ])('rejects %s gateway tokens without exposing the value', (_label, token) => {
    const connection = resolveSkillsDirectoryConnection({
      PSKILLS_DIRECTORY_ENABLED: 'true',
      PSKILLS_DIRECTORY_GATEWAY_URL: 'https://gateway.example.test',
      PSKILLS_DIRECTORY_GATEWAY_TOKEN: token,
    });
    expect(connection).toEqual({ kind: 'unavailable', reason: 'invalid_gateway_token' });
    expect(JSON.stringify(connection)).not.toContain(token);
  });

  it('honors cancellation before returning a bound gateway token', async () => {
    const gateway = createSkillsShGatewayCredential({ baseUrl: 'https://gateway.example.test/base', token: 'secret' });
    const controller = new AbortController();
    controller.abort();
    await expect(gateway.getToken(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('returns a stable sanitized unavailable error', async () => {
    const provider = createUnavailableSkillsDirectoryTokenProvider();
    await expect(provider()).rejects.toThrow(SKILLS_DIRECTORY_AUTH_UNAVAILABLE);
  });

  it('normalizes only safe HTTPS bases', () => {
    expect(normalizeDirectoryBaseURL('https://gateway.example.test/a/../catalog///')).toBe('https://gateway.example.test/catalog');
    expect(normalizeDirectoryBaseURL('https://gateway.example.test')).toBe('https://gateway.example.test');
    expect(normalizeDirectoryBaseURL('https://gateway.example.test/path?token=secret')).toBeUndefined();
    expect(normalizeDirectoryBaseURL('https://gateway.example.test/path#fragment')).toBeUndefined();
    expect(normalizeDirectoryBaseURL('https://gateway.example.test/path\n')).toBeUndefined();
  });
});
