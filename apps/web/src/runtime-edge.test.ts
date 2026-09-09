import { describe, expect, it } from 'vitest';

import { createDirectoryTokenProvider } from '../server/runtime-edge.js';

describe('edge directory token provider', () => {
  it('fails closed without importing or forwarding a gateway credential', async () => {
    const getToken = createDirectoryTokenProvider();

    await expect(getToken()).rejects.toThrow('directory authentication is not configured');
  });

  it('does not accept arbitrary environment secrets as a substitute', async () => {
    const getToken = createDirectoryTokenProvider({ PSKILLS_DIRECTORY_TOKEN: 'secret' });

    await expect(getToken()).rejects.toThrow('directory authentication is not configured');
  });
});
