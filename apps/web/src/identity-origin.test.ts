import { describe, expect, it } from 'vitest';

import { canonicalOriginFromEnv } from '../server/identity-origin.js';

describe('canonical identity origin', () => {
  it('uses deployment configuration precedence and strips URL paths', () => {
    expect(canonicalOriginFromEnv({
      BETTER_AUTH_URL: 'https://identity.example.test/auth',
      PSKILLS_PUBLIC_ORIGIN: 'https://registry.example.test/',
      PSKILLS_API_URL: 'https://api.example.test/',
    })).toBe('https://identity.example.test');
  });

  it.each([
    'not-a-url',
    'https://user:password@example.test',
    'https://example.test/?query=1',
    'https://example.test/#fragment',
  ])('rejects an unsafe configured origin: %s', (value) => {
    expect(() => canonicalOriginFromEnv({ PSKILLS_PUBLIC_ORIGIN: value })).toThrow('Trusted identity origin is invalid');
  });
});
