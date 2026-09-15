import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillsDirectoryClient } from '../../../packages/directory/src/index.js';

const oidc = vi.hoisted(() => ({
  getVercelOidcToken: vi.fn(),
}));

vi.mock('@vercel/oidc', () => oidc);

import {
  createDirectoryTokenProvider,
  createHostedOpenClawSourceConfigFromEnv,
  createOfficialDirectoryTokenProvider,
  createTenantStateFactory,
} from '../server/runtime-node.js';
import { openClawConsumerRefreshResult } from '../server/openclaw-runtime.js';
import type { OpenClawNormalizedSource } from '../../../packages/openclaw/src/types.js';
import {
  OPENCLAW_CLAWHUB_SKILLS_COMPATIBILITY_PROFILE,
  OPENCLAW_CLAWHUB_SKILLS_FEED_ID,
  type OpenClawCacheSnapshot,
} from '../../../packages/openclaw/src/index.js';

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

  it('uses the explicit gateway credential without invoking OIDC', async () => {
    const getToken = createDirectoryTokenProvider({
      PSKILLS_DIRECTORY_ENABLED: 'true',
      PSKILLS_DIRECTORY_GATEWAY_URL: 'https://gateway.example.test/catalog/',
      PSKILLS_DIRECTORY_GATEWAY_TOKEN: 'gateway-token',
    });

    await expect(getToken()).resolves.toBe('gateway-token');
    expect(oidc.getVercelOidcToken).not.toHaveBeenCalled();
  });

  it('keeps canonical OIDC available when the UI default is a custom gateway', async () => {
    oidc.getVercelOidcToken.mockResolvedValue('canonical-project-token');
    const env = {
      PSKILLS_DIRECTORY_ENABLED: 'true',
      PSKILLS_DIRECTORY_GATEWAY_URL: 'https://gateway.example.test/catalog',
      PSKILLS_DIRECTORY_GATEWAY_TOKEN: 'gateway-token',
    };
    const uiToken = createDirectoryTokenProvider(env);
    const canonicalToken = createOfficialDirectoryTokenProvider(env);

    await expect(uiToken()).resolves.toBe('gateway-token');
    await expect(canonicalToken()).resolves.toBe('canonical-project-token');
    expect(oidc.getVercelOidcToken).toHaveBeenCalledTimes(1);
  });

  it('keeps the official OIDC provider separate when a gateway token is also present', async () => {
    oidc.getVercelOidcToken.mockResolvedValue('project-token');
    const getToken = createDirectoryTokenProvider({
      PSKILLS_DIRECTORY_ENABLED: 'true',
      PSKILLS_DIRECTORY_GATEWAY_URL: 'https://skills.sh/catalog',
      PSKILLS_DIRECTORY_GATEWAY_TOKEN: 'gateway-token',
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
  ])('fails closed for incomplete or unsafe gateway configuration: %s', async (baseURL) => {
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

  it('fails closed for malformed multi-gateway configuration', async () => {
    const env = {
      PSKILLS_DIRECTORY_ENABLED: 'true',
      PSKILLS_DIRECTORY_GATEWAYS_JSON: '{',
    };
    const getToken = createDirectoryTokenProvider(env);
    const canonicalToken = createOfficialDirectoryTokenProvider(env);

    await expect(getToken()).rejects.toThrow('directory authentication is not configured');
    await expect(canonicalToken()).rejects.toThrow('directory authentication is not configured');
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

  it('builds the hosted OpenClaw source locator only from an exact operator mapping', () => {
    const source: OpenClawNormalizedSource = {
      kind: 'public-clawhub',
      sourceRef: 'public-clawhub',
      packageName: '@acme/demo',
      version: '1.0.0',
      artifactDigest: `sha256:${'a'.repeat(64)}`,
    };
    const config = createHostedOpenClawSourceConfigFromEnv({
      PSKILLS_OPENCLAW_SOURCE_LOCATOR_JSON: JSON.stringify({
        sourceProviderOrigin: 'https://clawhub.example.test',
        allowedArtifactOrigins: ['https://artifacts.example.test'],
        bindings: [{ source, url: 'https://artifacts.example.test/acme-demo.json' }],
      }),
    });

    expect(config).toBeDefined();
    expect(config?.allowedArtifactOrigins).toEqual(['https://artifacts.example.test']);
    expect(config?.sourceProviderOrigin).toBe('https://clawhub.example.test');
    expect(config?.locator.locate(source)).toMatchObject({
      url: 'https://artifacts.example.test/acme-demo.json',
      allowedArtifactOrigins: ['https://artifacts.example.test'],
      sourceProviderOrigin: 'https://clawhub.example.test',
    });
    expect(() => config?.locator.locate({ ...source, version: '1.0.1' })).toThrow('not configured');
  });

  it('uses reviewed public locators for both source families without per-skill bindings', () => {
    const config = createHostedOpenClawSourceConfigFromEnv({});
    const clawHub: OpenClawNormalizedSource = {
      kind: 'public-clawhub',
      sourceRef: 'public-clawhub',
      packageName: '@acme/agent-skill',
      version: '2.4.0',
      artifactDigest: `sha256:${'b'.repeat(64)}`,
    };
    const github: OpenClawNormalizedSource = {
      kind: 'public-github',
      sourceRef: 'public-github',
      repo: 'acme/agent-skills',
      path: 'skills/agent-skill',
      commit: '0123456789012345678901234567890123456789',
      contentHash: 'c'.repeat(64),
    };

    expect(config?.sourceProfiles?.['public-clawhub']).toMatchObject({
      allowedArtifactOrigins: ['https://clawhub.ai'],
      sourceProviderOrigin: 'https://clawhub.ai',
    });
    expect(config?.sourceProfiles?.['public-github']).toMatchObject({
      allowedArtifactOrigins: ['https://codeload.github.com'],
      sourceProviderOrigin: 'https://github.com',
    });
    expect(config?.locator.locate(clawHub)).toMatchObject({
      url: 'https://clawhub.ai/api/v1/download?slug=agent-skill&ownerHandle=acme&version=2.4.0',
    });
    expect(config?.locator.locate(github)).toMatchObject({
      url: 'https://codeload.github.com/acme/agent-skills/tar.gz/0123456789012345678901234567890123456789',
    });
  });

  it('keeps unknown source identities unavailable and keeps the configured ClawHub origin scoped', () => {
    const config = createHostedOpenClawSourceConfigFromEnv({
      PSKILLS_OPENCLAW_SOURCE_ORIGIN: 'https://clawhub.gateway.example',
    });
    const clawHub: OpenClawNormalizedSource = {
      kind: 'public-clawhub',
      sourceRef: 'public-clawhub',
      packageName: 'agent-skill',
      version: '1.0.0',
      artifactDigest: `sha256:${'d'.repeat(64)}`,
    };
    expect(config?.locator.locate(clawHub)).toMatchObject({
      url: 'https://clawhub.gateway.example/api/v1/download?slug=agent-skill&version=1.0.0',
    });
    expect(config?.sourceProfiles?.['public-clawhub']?.sourceProviderOrigin).toBe('https://clawhub.gateway.example');
    expect(config?.sourceProfiles?.['public-github']?.sourceProviderOrigin).toBe('https://github.com');
    expect(() => config?.locator.locate({
      kind: 'public-clawhub',
      sourceRef: 'public-clawhub',
      packageName: '@acme/../other',
      version: '1.0.0',
      artifactDigest: `sha256:${'d'.repeat(64)}`,
    })).toThrow('invalid');
  });

  it.each([
    { label: 'malformed JSON', value: '{' },
    {
      label: 'untrusted URL',
      value: JSON.stringify({
        sourceProviderOrigin: 'https://clawhub.example.test',
        allowedArtifactOrigins: ['https://artifacts.example.test'],
        bindings: [{
          source: {
            kind: 'public-clawhub', sourceRef: 'public-clawhub', packageName: '@acme/demo', version: '1.0.0', artifactDigest: `sha256:${'a'.repeat(64)}`,
          },
          url: 'https://evil.example.test/artifact.json',
        }],
      }),
    },
  ])('rejects unsafe hosted OpenClaw source configuration: $label', ({ value }) => {
    expect(() => createHostedOpenClawSourceConfigFromEnv({
      PSKILLS_OPENCLAW_SOURCE_LOCATOR_JSON: value,
    })).toThrow('OpenClaw');
  });

  it('preserves the server-selected compatibility profile for refresh and durable metadata projections', () => {
    const digest = `sha256:${'a'.repeat(64)}` as `sha256:${string}`;
    const snapshot: OpenClawCacheSnapshot = {
      feed: {
        schemaVersion: 1,
        id: OPENCLAW_CLAWHUB_SKILLS_FEED_ID,
        generatedAt: '2030-01-01T00:00:00.000Z',
        sequence: 1,
        expiresAt: '2030-01-02T00:00:00.000Z',
        entries: [],
      },
      body: '{}',
      bytes: new Uint8Array(),
      sha256: digest,
      etag: `"${digest}"`,
      compatibilityProfile: OPENCLAW_CLAWHUB_SKILLS_COMPATIBILITY_PROFILE,
      acceptedAt: Date.parse('2030-01-01T01:00:00.000Z'),
      sourceUrl: 'https://clawhub.ai/api/v1/feeds/skills',
    };

    expect(openClawConsumerRefreshResult({ kind: 'accepted', status: 200, snapshot }).snapshot)
      .toMatchObject({ compatibilityProfile: OPENCLAW_CLAWHUB_SKILLS_COMPATIBILITY_PROFILE });
    expect(openClawConsumerRefreshResult({ kind: 'not-modified', status: 304, snapshot }).snapshot)
      .toMatchObject({ compatibilityProfile: OPENCLAW_CLAWHUB_SKILLS_COMPATIBILITY_PROFILE });
  });
});

describe('tenant initial state policy', () => {
  it('keeps the legacy override while giving new organizations a required scanner policy', () => {
    const factory = createTenantStateFactory({
      PSKILLS_ENVIRONMENT: 'development',
      PSKILLS_ORGANIZATION_ID: 'legacy-org',
      PSKILLS_ALLOW_UNSCANNED: 'true',
    });

    const legacy = factory('legacy-org');
    expect(legacy.policy.allowUnscanned).toBe(true);
    expect(legacy.policy.scanners.every((scanner) => scanner.mode === 'disabled')).toBe(true);

    const newTenant = factory('new-org');
    expect(newTenant.policy.allowUnscanned).toBe(false);
    expect(newTenant.policy.scanners.find((scanner) => scanner.id === 'cisco-skill-scanner')?.mode).toBe('required');
    expect(newTenant.policy.scanners.filter((scanner) => scanner.mode === 'required')).toHaveLength(1);
  });

  it('uses the configured hosted SkillsGuard as the required scanner for new organizations', () => {
    const factory = createTenantStateFactory({
      PSKILLS_ENVIRONMENT: 'production',
      PSKILLS_ORGANIZATION_ID: 'legacy-org',
      PSKILLS_HOSTED_SKILLSGUARD: 'true',
    });

    const newTenant = factory('new-org');
    expect(newTenant.policy.allowUnscanned).toBe(false);
    expect(newTenant.policy.scanners.find((scanner) => scanner.id === 'skillsguard')?.mode).toBe('required');
    expect(newTenant.policy.scanners.find((scanner) => scanner.id === 'cisco-skill-scanner')?.mode).toBe('advisory');
  });
});
