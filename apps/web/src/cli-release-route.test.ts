import { describe, expect, it } from 'vitest';
import type { Authenticator, BlobStore, Principal, StoredBlob } from '../../../packages/contracts/src/index.js';
import { digestBytes } from '../../../packages/storage/src/digest.js';
import { createCliReleaseRoutes } from '../server/routes/cli-release.js';
import { parseCliReleaseManifest } from '../../../packages/cli-release/src/index.js';

class MemoryBlobStore implements BlobStore {
  readonly values = new Map<string, Uint8Array>();
  async put(bytes: Uint8Array): Promise<StoredBlob> {
    const key = `sealed/${this.values.size + 1}`;
    const copy = bytes.slice();
    this.values.set(key, copy);
    return { key, size: copy.byteLength, digest: await digestBytes(copy) };
  }
  async get(key: string): Promise<Uint8Array> {
    const bytes = this.values.get(key);
    if (bytes === undefined) throw new Error('missing object');
    return bytes.slice();
  }
  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
}

async function fixture(registerStorage = true) {
  const bytes = new Uint8Array([0, 1, 2, 3, 254, 255]);
  const digest = await digestBytes(bytes);
  const manifest = parseCliReleaseManifest({
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
      ...(registerStorage ? { storageKey: 'sealed/cli-mac' } : {}),
    }],
    verification: { nativeProofTargets: ['aarch64-apple-darwin'], nativeTestWaivedTargets: [] },
  });
  const store = new MemoryBlobStore();
  if (registerStorage) store.values.set('sealed/cli-mac', bytes.slice());
  let current: Principal | null = {
    organizationId: 'org-acme',
    subject: 'member-1',
    roles: ['reader'],
    scopes: ['registry:read', 'artifacts:download'],
  };
  const auth: Authenticator = { authenticate: async () => current };
  const route = createCliReleaseRoutes({
    manifest,
    blobs: store,
    authenticate: auth.authenticate,
    organizationId: 'org-acme',
  });
  return {
    bytes,
    digest,
    store,
    route,
    setPrincipal(value: Principal | null) { current = value; },
  };
}

async function body(response: Response): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer());
}

async function status(route: ReturnType<typeof createCliReleaseRoutes>, url: string): Promise<number> {
  const response = await route(new Request(url));
  expect(response).toBeDefined();
  return response!.status;
}

describe('authenticated CLI release routes', () => {
  it('requires authentication before exposing the manifest or reading storage', async () => {
    const test = await fixture();
    test.setPrincipal(null);
    expect(await status(test.route, 'https://registry.example/v1/cli/releases')).toBe(401);
    expect(await status(test.route, 'https://registry.example/v1/cli/releases/1.0.0/aarch64-apple-darwin/download')).toBe(401);
    expect(test.store.values.size).toBe(1);
  });

  it('binds access to the selected company, role, and download scopes', async () => {
    const test = await fixture();
    test.setPrincipal({ organizationId: 'org-other', subject: 'member-2', roles: ['reader'], scopes: ['registry:read', 'artifacts:download'] });
    expect(await status(test.route, 'https://registry.example/v1/cli/releases')).toBe(403);
    test.setPrincipal({ organizationId: 'org-acme', subject: 'member-3', roles: ['worker'], scopes: ['*'] });
    expect(await status(test.route, 'https://registry.example/v1/cli/releases')).toBe(403);
    test.setPrincipal({ organizationId: 'org-acme', subject: 'member-4', roles: ['reader'], scopes: ['registry:read'] });
    expect(await status(test.route, 'https://registry.example/v1/cli/releases')).toBe(403);
  });

  it('returns exact bytes with a pinned-manifest digest and safe attachment headers', async () => {
    const test = await fixture();
    const manifest = await test.route(new Request('https://registry.example/v1/cli/releases'));
    expect(manifest?.status).toBe(200);
    const manifestBody = await manifest!.json() as Record<string, unknown>;
    expect(manifestBody).not.toHaveProperty('source');
    expect(JSON.stringify(manifestBody)).not.toContain('storageKey');

    const response = await test.route(new Request('https://registry.example/v1/cli/releases/1.0.0/aarch64-apple-darwin/download'));
    expect(response?.status).toBe(200);
    expect(await body(response!)).toEqual(test.bytes);
    expect(response!.headers.get('content-length')).toBe(String(test.bytes.byteLength));
    expect(response!.headers.get('content-disposition')).toBe('attachment; filename="pskills-aarch64-apple-darwin.tar.gz"');
    expect(response!.headers.get('x-pskills-release-digest')).toBe(test.digest);
    expect(response!.headers.get('cache-control')).toBe('no-store');
  });

  it('reports an unprovisioned asset without advertising a download', async () => {
    const test = await fixture(false);
    const response = await test.route(new Request('https://registry.example/v1/cli/releases'));
    expect(response?.status).toBe(200);
    const publicManifest = await response!.json() as { assets: Array<{ availability: string }> };
    expect(publicManifest.assets[0]?.availability).toBe('unprovisioned');
  });

  it('fails closed for an unsupported target, wrong version, tampered provider bytes, and missing storage', async () => {
    const test = await fixture();
    expect(await status(test.route, 'https://registry.example/v1/cli/releases/1.0.0/x86_64-unknown-linux-gnu/download')).toBe(404);
    expect(await status(test.route, 'https://registry.example/v1/cli/releases/9.9.9/aarch64-apple-darwin/download')).toBe(404);

    test.store.values.set('sealed/cli-mac', new Uint8Array([9, 9, 9]));
    const mismatch = await test.route(new Request('https://registry.example/v1/cli/releases/1.0.0/aarch64-apple-darwin/download'));
    expect(mismatch?.status).toBe(502);
    await expect(mismatch!.json()).resolves.toMatchObject({ code: 'CLI_RELEASE_INTEGRITY' });

    test.store.values.delete('sealed/cli-mac');
    const missing = await test.route(new Request('https://registry.example/v1/cli/releases/1.0.0/aarch64-apple-darwin/download'));
    expect(missing?.status).toBe(502);
    await expect(missing!.json()).resolves.toMatchObject({ code: 'CLI_RELEASE_PROVIDER_ERROR' });
  });

  it('rejects malformed route components instead of decoding them into storage paths', async () => {
    const test = await fixture();
    const response = await test.route(new Request('https://registry.example/v1/cli/releases/1.0.0/%2e%2e%2fsecrets/download'));
    expect(response?.status).toBe(400);
    await expect(response!.json()).resolves.toMatchObject({ code: 'CLI_RELEASE_INVALID_PATH' });
  });
});
