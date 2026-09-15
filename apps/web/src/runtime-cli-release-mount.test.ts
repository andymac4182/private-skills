import { describe, expect, it, vi } from 'vitest';
import type { CliReleaseAssetProvider } from '../../../packages/cli-release/src/index.js';
import { digestBytes } from '../../../packages/storage/src/digest.js';

const infrastructure = vi.hoisted(() => ({
  createInfrastructure: vi.fn(),
}));

vi.mock('#pskills-infrastructure', () => infrastructure);

import { handleRegistryRequest } from '../server/runtime.js';

function fakeInfrastructure(provider: CliReleaseAssetProvider) {
  return {
    repository: { read: async () => ({}) },
    blobs: {},
    billing: {
      service: {
        webhookBodyLimit: () => 1024,
        status: () => ({ enabled: false, provider: null, mode: 'disabled', webhookVerification: false, checkout: false, portal: false }),
        usageSnapshot: async () => ({}),
      },
    },
    directoryTokenProvider: async () => 'directory-token',
    directoryOfficialTokenProvider: async () => 'directory-token',
    directoryOfficialAvailable: false,
    cliReleaseProvider: provider,
    identity: {
      handler: async () => Response.json({}),
      authenticate: async () => ({
        organizationId: 'default',
        subject: 'member-1',
        roles: ['reader'] as const,
        scopes: ['registry:read', 'artifacts:download'],
      }),
      publicProviderConfig: () => ({ basePath: '/api/auth' }),
    },
    createSearchIndex: () => ({}),
  };
}

describe('application CLI release route mount', () => {
  it('dispatches the authenticated company download before registry routing', async () => {
    const bytes = new TextEncoder().encode('runtime-mounted-cli');
    const digest = await digestBytes(bytes);
    const manifest = JSON.stringify({
      protocolVersion: 1,
      version: '1.0.0',
      releaseTag: 'v1.0.0',
      source: { kind: 'github-release', repository: 'private/example', tag: 'v1.0.0', tagCommit: '0123456789012345678901234567890123456789' },
      checksums: { filename: 'SHA256SUMS', size: 1, digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' },
      assets: [{
        target: 'aarch64-apple-darwin',
        platform: 'macos',
        architecture: 'arm64',
        filename: 'pskills-aarch64-apple-darwin.tar.gz',
        archive: 'tar.gz',
        member: 'pskills',
        size: bytes.byteLength,
        digest,
        storageKey: 'sealed/runtime-cli',
      }],
      verification: { nativeProofTargets: ['aarch64-apple-darwin'], nativeTestWaivedTargets: [] },
    });
    const provider: CliReleaseAssetProvider = {
      get: async () => bytes.slice(),
    };
    const environment = { PSKILLS_ENVIRONMENT: 'test', PSKILLS_CLI_RELEASE_MANIFEST: manifest };
    infrastructure.createInfrastructure.mockResolvedValueOnce(fakeInfrastructure(provider));

    const response = await handleRegistryRequest(
      new Request('http://localhost:5173/v1/cli/releases/1.0.0/aarch64-apple-darwin/download'),
      environment,
    );

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get('x-pskills-release-digest')).toBe(digest);
  });
});
