import { describe, expect, it, vi } from 'vitest';

const infrastructure = vi.hoisted(() => ({
  createInfrastructure: vi.fn(),
}));

vi.mock('#pskills-infrastructure', () => infrastructure);

import { handleRegistryRequest } from '../server/runtime.js';

function fakeInfrastructure(companySso?: { handler: (request: Request) => Promise<Response | undefined> }) {
  return {
    repository: {},
    blobs: {},
    // Newer runtime composition eagerly wires the webhook handler before
    // dispatching any request. Keep the test fixture compatible with that
    // required host-owned service without exercising billing here.
    billing: { service: { webhookBodyLimit: () => 1024 } },
    directoryTokenProvider: async () => 'directory-token',
    directoryOfficialTokenProvider: async () => 'directory-token',
    directoryOfficialAvailable: false,
    ...(companySso === undefined ? {} : { companySso }),
    createSearchIndex: () => ({}),
  };
}

describe('application company SSO route mount', () => {
  it('returns unavailable when the company SSO infrastructure is absent', async () => {
    const environment = { PSKILLS_ENVIRONMENT: 'test' };
    infrastructure.createInfrastructure.mockResolvedValueOnce(fakeInfrastructure());

    const response = await handleRegistryRequest(
      new Request('http://localhost:5173/v1/companies/acme/sso/providers'),
      environment,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: 'COMPANY_SSO_UNAVAILABLE' });
  });

  it('dispatches the mounted company route before tenant routing', async () => {
    const environment = { PSKILLS_ENVIRONMENT: 'test' };
    const request = new Request('http://localhost:5173/v1/companies/acme/sso/providers/okta');
    const handler = vi.fn().mockResolvedValue(Response.json({ provider: { providerId: 'okta' } }));
    infrastructure.createInfrastructure.mockResolvedValueOnce(fakeInfrastructure({ handler }));

    const response = await handleRegistryRequest(request, environment);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ provider: { providerId: 'okta' } });
    expect(handler).toHaveBeenCalledWith(request);
  });

  it('mounts explicit company discovery and sign-in before tenant routing', async () => {
    const environment = { PSKILLS_ENVIRONMENT: 'test' };
    const request = new Request('http://localhost:5173/v1/companies/acme/sso/login', {
      method: 'POST',
      headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: 'acme-oidc', callbackURL: '/app' }),
    });
    const identityHandler = vi.fn().mockResolvedValue(Response.json({ redirect: true }));
    const companySso = {
      handler: vi.fn(),
      listPublicProviders: vi.fn().mockResolvedValue([{ providerId: 'acme-oidc', displayName: 'Acme Identity', protocol: 'oidc', status: 'active' }]),
      getProviderForOrganization: vi.fn().mockResolvedValue({ providerId: 'acme-oidc', organizationId: 'acme', protocol: 'oidc', status: 'active' }),
      selectProvider: vi.fn().mockResolvedValue({ providerId: 'acme-oidc', organizationId: 'acme', callbackURL: 'http://localhost:5173/api/auth/sso/callback/acme-oidc' }),
    };
    infrastructure.createInfrastructure.mockResolvedValueOnce({
      ...fakeInfrastructure(companySso),
      identity: {
        handler: identityHandler,
        authenticate: vi.fn().mockResolvedValue(null),
        publicProviderConfig: () => ({ basePath: '/api/auth' }),
      },
    });

    const response = await handleRegistryRequest(request, environment);

    expect(response.status).toBe(200);
    expect(identityHandler).toHaveBeenCalledOnce();
    expect(companySso.selectProvider).toHaveBeenCalledWith('acme', 'acme-oidc', 'http://localhost:5173', true);
  });
});
