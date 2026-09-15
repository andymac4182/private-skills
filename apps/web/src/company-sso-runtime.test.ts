import { describe, expect, it, vi } from 'vitest';

import { handleCompanySsoRoute } from '../server/company-sso-runtime.js';

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
});
