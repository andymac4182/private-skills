import { describe, expect, it } from 'vitest';

import {
  IdentityAuthorizationError,
  IdentityConfigurationError,
  createIdentityPublicConfig,
  createIdentityRuntimeConfig,
  createInvitationLink,
  normalizeIdentityRole,
} from '../src/index';

describe('identity configuration contract', () => {
  it('keeps Better Auth opt-in and preserves the existing deployment defaults', () => {
    const config = createIdentityRuntimeConfig({});

    expect(config.enabled).toBe(false);
    expect(config.baseURL).toBe('http://localhost:5173');
    expect(config.basePath).toBe('/api/auth');
    expect(config.providers).toEqual([]);
    expect(config.bootstrapConfigured).toBe(false);
    expect(config.invitations).toMatchObject({ mode: 'copy-link', requireVerifiedEmail: true, emailDelivery: 'disabled' });
  });

  it('registers configured built-ins and generic OIDC without exposing secrets', () => {
    const config = createIdentityRuntimeConfig({
      PSKILLS_BETTER_AUTH_ENABLED: 'true',
      DATABASE_URL: 'postgresql://user:password@localhost:5432/private_skills',
      BETTER_AUTH_SECRET: '12345678901234567890123456789012',
      GITHUB_CLIENT_ID: 'github-client',
      GITHUB_CLIENT_SECRET: 'github-secret',
      GOOGLE_CLIENT_ID: 'google-client',
      GOOGLE_CLIENT_SECRET: 'google-secret',
      MICROSOFT_CLIENT_ID: 'microsoft-client',
      MICROSOFT_CLIENT_SECRET: 'microsoft-secret',
      PSKILLS_OIDC_PROVIDERS_JSON: JSON.stringify([
        {
          id: 'company-one',
          name: 'Company One',
          clientId: 'oidc-client',
          clientSecret: 'oidc-secret',
          discoveryUrl: 'http://127.0.0.1:9001/.well-known/openid-configuration',
        },
      ]),
    });
    const publicConfig = createIdentityPublicConfig(config);

    expect(config.providers.map((provider) => provider.id)).toEqual(['github', 'google', 'microsoft', 'company-one']);
    expect(publicConfig.providers.map((provider) => provider.id)).toEqual(['github', 'google', 'microsoft', 'company-one']);
    expect(JSON.stringify(publicConfig)).not.toContain('github-secret');
    expect(JSON.stringify(publicConfig)).not.toContain('oidc-secret');
    expect(publicConfig.providers.find((provider) => provider.id === 'company-one')?.label).toBe('Company One');
    expect(publicConfig.organization.roles).toEqual(['owner', 'admin', 'publisher', 'reader']);
    expect(publicConfig.invitations.requiresVerifiedEmail).toBe(true);
    expect(publicConfig.bootstrap.implicitSocialTenantAdoption).toBe(false);
  });

  it('rejects partial provider credentials and unsafe generic provider ids', () => {
    expect(() => createIdentityRuntimeConfig({ GITHUB_CLIENT_ID: 'only-id' })).toThrowError(IdentityConfigurationError);
    expect(() => createIdentityRuntimeConfig({
      PSKILLS_OIDC_PROVIDERS_JSON: JSON.stringify([
        { id: 'google', clientId: 'client', discoveryUrl: 'https://issuer.example/.well-known/openid-configuration' },
      ]),
    })).toThrowError(IdentityConfigurationError);
  });
});

describe('identity authorization boundaries', () => {
  it('maps Better Auth member to reader and rejects unknown roles', () => {
    expect(normalizeIdentityRole('member')).toBe('reader');
    expect(normalizeIdentityRole('publisher')).toBe('publisher');
    expect(() => normalizeIdentityRole('super-admin')).toThrowError(IdentityAuthorizationError);
    expect(() => normalizeIdentityRole('worker')).toThrowError(IdentityAuthorizationError);
  });

  it('builds the copy-link invitation URL from server-owned values', () => {
    expect(createInvitationLink('http://localhost:5173/', 'invite/123')).toBe(
      'http://localhost:5173/organization/accept-invitation?id=invite%2F123',
    );
  });
});
