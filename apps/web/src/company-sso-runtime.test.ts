import { describe, expect, it, vi } from 'vitest';

import { handleCompanySsoRoute } from '../server/company-sso-runtime.js';
import { CompanySsoError } from '../../../packages/identity/src/company-sso-types.js';

describe('company SSO runtime route', () => {
  it('returns an honest unavailable response when identity infrastructure is off', async () => {
    const response = await handleCompanySsoRoute(
      new Request('http://localhost:5173/v1/companies/acme/sso/providers'),
      undefined,
    );

    expect(response?.status).toBe(503);
    await expect(response?.json()).resolves.toMatchObject({ code: 'COMPANY_SSO_UNAVAILABLE' });
  });

  it('delegates the exact company provider route and leaves unrelated routes alone', async () => {
    const handler = vi.fn().mockResolvedValue(Response.json({ providers: [] }));
    const runtime = { handler };
    const request = new Request('http://localhost:5173/v1/companies/acme%2Fwest/sso/providers/okta');

    const response = await handleCompanySsoRoute(request, runtime);
    expect(response?.status).toBe(200);
    expect(handler).toHaveBeenCalledWith(request);
    await expect(handleCompanySsoRoute(new Request('http://localhost:5173/v1/companies/acme/registry'), runtime)).resolves.toBeUndefined();
  });

  it('discovers active providers without exposing configuration and binds sign-in to the selected company', async () => {
    const identityHandler = vi.fn().mockResolvedValue(Response.json({ url: 'https://idp.example/authorize', redirect: true }));
    const listPublicProviders = vi.fn().mockResolvedValue([
      { providerId: 'acme-oidc', displayName: 'Acme Identity', protocol: 'oidc', status: 'active', clientSecret: 'must-not-leak' },
      { providerId: 'acme-old', displayName: 'Old Identity', protocol: 'saml', status: 'disabled' },
    ]);
    const getProviderForOrganization = vi.fn().mockResolvedValue({
      providerId: 'acme-oidc', organizationId: 'acme', protocol: 'oidc', status: 'active',
    });
    const selectProvider = vi.fn().mockResolvedValue({
      providerId: 'acme-oidc', organizationId: 'acme', callbackURL: 'https://registry.example/api/auth/sso/callback/acme-oidc',
    });
    const companySso = {
      handler: vi.fn(), listPublicProviders, getProviderForOrganization, selectProvider,
    };
    const login = { identityHandler, basePath: '/api/auth', appOrigin: 'https://registry.example' };

    const discovered = await handleCompanySsoRoute(
      new Request('https://registry.example/v1/companies/acme/sso/login'),
      companySso,
      login,
    );
    expect(discovered?.status).toBe(200);
    await expect(discovered?.json()).resolves.toEqual({
      organizationId: 'acme',
      providers: [{ providerId: 'acme-oidc', displayName: 'Acme Identity', protocol: 'oidc' }],
    });

    const started = await handleCompanySsoRoute(
      new Request('https://registry.example/v1/companies/acme/sso/login', {
        method: 'POST',
        headers: {
          origin: 'https://registry.example',
          'content-type': 'application/json',
          'x-forwarded-host': 'attacker.example',
          'x-forwarded-proto': 'http',
        },
        body: JSON.stringify({ providerId: 'acme-oidc', callbackURL: '/app/catalog' }),
      }),
      companySso,
      login,
    );
    expect(started?.status).toBe(200);
    const identityRequest = identityHandler.mock.calls[0]?.[0] as Request;
    expect(new URL(identityRequest.url).pathname).toBe('/api/auth/sign-in/sso');
    expect(new URL(identityRequest.url).origin).toBe('https://registry.example');
    expect(await identityRequest.json()).toEqual({
      providerId: 'acme-oidc', providerType: 'oidc', callbackURL: '/app/catalog',
    });
    expect(getProviderForOrganization).toHaveBeenCalledWith('acme', 'acme-oidc');
    expect(selectProvider).toHaveBeenCalledWith('acme', 'acme-oidc', 'https://registry.example', undefined);
  });

  it('rejects a cross-origin callback before invoking Better Auth', async () => {
    const identityHandler = vi.fn();
    const companySso = {
      handler: vi.fn(),
      listPublicProviders: vi.fn().mockResolvedValue([]),
      getProviderForOrganization: vi.fn().mockResolvedValue({ providerId: 'acme-oidc', organizationId: 'acme', protocol: 'oidc', status: 'active' }),
      selectProvider: vi.fn().mockResolvedValue({ providerId: 'acme-oidc', organizationId: 'acme', callbackURL: 'https://registry.example/api/auth/sso/callback/acme-oidc' }),
    };
    const response = await handleCompanySsoRoute(
      new Request('https://registry.example/v1/companies/acme/sso/login', {
        method: 'POST',
        headers: { origin: 'https://registry.example', 'content-type': 'application/json' },
        body: JSON.stringify({ providerId: 'acme-oidc', callbackURL: 'https://attacker.example/app' }),
      }),
      companySso,
      { identityHandler, basePath: '/api/auth', appOrigin: 'https://registry.example' },
    );
    expect(response).toBeDefined();
    if (!response) throw new Error('company SSO login route did not return a response');
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'INVALID_CALLBACK' });
    expect(identityHandler).not.toHaveBeenCalled();
  });

  it('rechecks the path company and refuses disabled providers', async () => {
    const identityHandler = vi.fn();
    const getProviderForOrganization = vi.fn().mockResolvedValue({
      providerId: 'acme-oidc', organizationId: 'acme', protocol: 'oidc', status: 'disabled',
    });
    const selectProvider = vi.fn().mockRejectedValue(new CompanySsoError('PROVIDER_DISABLED', 'The selected SSO provider is disabled', 403));
    const companySso = {
      handler: vi.fn(),
      listPublicProviders: vi.fn().mockResolvedValue([]),
      getProviderForOrganization,
      selectProvider,
    };
    const response = await handleCompanySsoRoute(
      new Request('https://registry.example/v1/companies/acme/sso/login', {
        method: 'POST',
        headers: { origin: 'https://registry.example', 'content-type': 'application/json' },
        body: JSON.stringify({ providerId: 'acme-oidc', organizationId: 'globex', callbackURL: '/app' }),
      }),
      companySso,
      { identityHandler, basePath: '/api/auth', appOrigin: 'https://registry.example' },
    );
    expect(response).toBeDefined();
    if (!response) throw new Error('company SSO login route did not return a response');
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: 'ORGANIZATION_MISMATCH' });
    expect(getProviderForOrganization).not.toHaveBeenCalled();
    expect(selectProvider).not.toHaveBeenCalled();
    expect(identityHandler).not.toHaveBeenCalled();

    const disabledResponse = await handleCompanySsoRoute(
      new Request('https://registry.example/v1/companies/acme/sso/login', {
        method: 'POST',
        headers: { origin: 'https://registry.example', 'content-type': 'application/json' },
        body: JSON.stringify({ providerId: 'acme-oidc', callbackURL: '/app' }),
      }),
      companySso,
      { identityHandler, basePath: '/api/auth', appOrigin: 'https://registry.example' },
    );
    expect(disabledResponse).toBeDefined();
    if (!disabledResponse) throw new Error('company SSO login route did not return a response');
    expect(disabledResponse.status).toBe(403);
    await expect(disabledResponse.json()).resolves.toMatchObject({ code: 'PROVIDER_DISABLED' });
    expect(selectProvider).toHaveBeenCalledWith('acme', 'acme-oidc', 'https://registry.example', undefined);
    expect(identityHandler).not.toHaveBeenCalled();
  });
});
