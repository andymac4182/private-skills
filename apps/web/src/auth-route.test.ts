import { describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  handleRegistryRequest: vi.fn(),
}));

vi.mock('../server/runtime', () => runtime);

import authHandler from '../server/routes/api/auth/[...path].js';

describe('Better Auth Nitro route', () => {
  it('exports a catchall handler that forwards the request and Cloudflare bindings', async () => {
    const response = Response.json({ ok: true });
    runtime.handleRegistryRequest.mockResolvedValue(response);
    const request = new Request('http://localhost:5173/api/auth/sign-in/social');
    const bindings = { PSKILLS_BETTER_AUTH_ENABLED: 'true' };

    const actual = await authHandler({
      req: request,
      context: { cloudflare: { env: bindings } },
    } as never);

    expect(runtime.handleRegistryRequest).toHaveBeenCalledWith(request, bindings);
    expect(actual).toBe(response);
  });
});
