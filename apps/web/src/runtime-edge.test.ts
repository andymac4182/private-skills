import { describe, expect, it } from 'vitest';

import { createDirectoryTokenProvider } from '../server/runtime-edge.js';

describe('edge directory token provider', () => {
  it('fails closed without importing or forwarding a gateway credential', async () => {
    const getToken = createDirectoryTokenProvider();

    await expect(getToken()).rejects.toThrow('directory authentication is not configured');
  });

  it('supports only the explicit complete gateway pair', async () => {
    const getToken = createDirectoryTokenProvider({
      PSKILLS_DIRECTORY_ENABLED: 'true',
      PSKILLS_DIRECTORY_GATEWAY_URL: 'https://gateway.example.test/catalog/',
      PSKILLS_DIRECTORY_GATEWAY_TOKEN: 'gateway-token',
    });

    await expect(getToken()).resolves.toBe('gateway-token');
  });

  it('keeps the official skills.sh path unavailable on edge', async () => {
    const getToken = createDirectoryTokenProvider({ PSKILLS_DIRECTORY_ENABLED: 'true' });

    await expect(getToken()).rejects.toThrow('directory authentication is not configured');
  });

  it('rejects an incomplete gateway pair and honors cancellation', async () => {
    const incomplete = createDirectoryTokenProvider({
      PSKILLS_DIRECTORY_ENABLED: 'true',
      PSKILLS_DIRECTORY_GATEWAY_URL: 'https://gateway.example.test',
    });
    await expect(incomplete()).rejects.toThrow('directory authentication is not configured');

    const complete = createDirectoryTokenProvider({
      PSKILLS_DIRECTORY_ENABLED: 'true',
      PSKILLS_DIRECTORY_GATEWAY_URL: 'https://gateway.example.test',
      PSKILLS_DIRECTORY_GATEWAY_TOKEN: 'gateway-token',
    });
    const controller = new AbortController();
    controller.abort();
    await expect(complete(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not accept arbitrary environment secrets as a substitute', async () => {
    const getToken = createDirectoryTokenProvider({ PSKILLS_DIRECTORY_TOKEN: 'secret' });

    await expect(getToken()).rejects.toThrow('directory authentication is not configured');
  });
});
