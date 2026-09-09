import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillsDirectoryClient } from '../../../packages/directory/src/index.js';

const oidc = vi.hoisted(() => ({
  getVercelOidcToken: vi.fn(),
}));

vi.mock('@vercel/oidc', () => oidc);

import { createDirectoryTokenProvider } from '../server/runtime-node.js';

describe('node directory token provider', () => {
  beforeEach(() => {
    oidc.getVercelOidcToken.mockReset();
  });

  it('resolves a fresh official OIDC token for each request', async () => {
    oidc.getVercelOidcToken
      .mockResolvedValueOnce('project-token-1')
      .mockResolvedValueOnce('project-token-2');

    const getToken = createDirectoryTokenProvider({ PSKILLS_DIRECTORY_ENABLED: 'true' });

    await expect(getToken()).resolves.toBe('project-token-1');
    await expect(getToken()).resolves.toBe('project-token-2');
    expect(oidc.getVercelOidcToken).toHaveBeenCalledTimes(2);
  });

  it('keeps a configured path on the official skills.sh origin', async () => {
    oidc.getVercelOidcToken.mockResolvedValue('project-token');
    const getToken = createDirectoryTokenProvider({
      PSKILLS_DIRECTORY_ENABLED: 'true',
      PSKILLS_SKILLS_SH_BASE_URL: 'https://skills.sh/catalog',
    });

    await expect(getToken()).resolves.toBe('project-token');
    expect(oidc.getVercelOidcToken).toHaveBeenCalledTimes(1);
  });

  it.each([
    'https://gateway.example.test',
    'https://skills.sh.evil.example.test',
    'http://skills.sh',
    'https://skills.sh?forward=token',
    'https://skills.sh#fragment',
    'https://user:password@skills.sh',
  ])('fails closed for an unapproved directory destination: %s', async (baseURL) => {
    const getToken = createDirectoryTokenProvider({ PSKILLS_DIRECTORY_ENABLED: 'true', PSKILLS_DIRECTORY_GATEWAY_URL: baseURL });

    await expect(getToken()).rejects.toThrow('directory authentication is not configured');
    expect(oidc.getVercelOidcToken).not.toHaveBeenCalled();
  });

  it('checks abort before invoking the OIDC helper', async () => {
    const controller = new AbortController();
    controller.abort();
    const getToken = createDirectoryTokenProvider({ PSKILLS_DIRECTORY_ENABLED: 'true' });

    await expect(getToken(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(oidc.getVercelOidcToken).not.toHaveBeenCalled();
  });

  it('rejects an empty helper result without returning a credential', async () => {
    oidc.getVercelOidcToken.mockResolvedValue('   ');
    const getToken = createDirectoryTokenProvider({ PSKILLS_DIRECTORY_ENABLED: 'true' });

    await expect(getToken()).rejects.toThrow('directory authentication is not configured');
  });

  it('does not resolve or invoke OIDC while directory access is disabled', async () => {
    const getToken = createDirectoryTokenProvider({});

    await expect(getToken()).rejects.toThrow('directory authentication is not configured');
    expect(oidc.getVercelOidcToken).not.toHaveBeenCalled();
  });

  it('does not expose helper failures through the directory client', async () => {
    oidc.getVercelOidcToken.mockRejectedValue(new Error('token=credential-material'));
    const getToken = createDirectoryTokenProvider({ PSKILLS_DIRECTORY_ENABLED: 'true' });
    const client = new SkillsDirectoryClient({ getToken, maxAttempts: 1 });

    await expect(client.list()).rejects.toMatchObject({
      code: 'unavailable',
      message: 'skills.sh is temporarily unavailable',
    });
  });
});
