import { describe, expect, it } from 'vitest';

import {
  createSkillsShGatewayCredential,
  createUnavailableSkillsDirectoryTokenProvider,
  normalizeDirectoryBaseURL,
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
