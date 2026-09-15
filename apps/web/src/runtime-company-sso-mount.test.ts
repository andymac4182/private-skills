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
});
