import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BlobStore, StoredBlob } from '../../contracts/src/index.js';
import { digestBytes } from '../../storage/src/digest.js';
import type { CliReleaseAsset } from '../src/index.js';
import { createLocalCliReleaseAssetProvider, createNodeCliReleaseAssetProvider } from '../src/node.js';

const assetBase: Omit<CliReleaseAsset, 'size' | 'digest'> = {
  target: 'aarch64-apple-darwin',
  platform: 'macos',
  architecture: 'arm64',
  filename: 'pskills-aarch64-apple-darwin.tar.gz',
  archive: 'tar.gz',
  member: 'pskills',
};

class MemoryStore implements BlobStore {
  readonly values = new Map<string, Uint8Array>();
  async put(bytes: Uint8Array): Promise<StoredBlob> {
    const copy = bytes.slice();
    const key = 'sealed/registered';
    this.values.set(key, copy);
    return { key, size: copy.byteLength, digest: await digestBytes(copy) };
  }
  async get(key: string): Promise<Uint8Array> {
    const value = this.values.get(key);
    if (!value) throw new Error('missing');
    return value.slice();
  }
  async remove(key: string): Promise<void> { this.values.delete(key); }
}

describe('Node CLI release providers', () => {
  it('reads an exact local fixture and rejects a symlink escape', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pskills-cli-release-'));
    const outside = await mkdtemp(join(tmpdir(), 'pskills-cli-release-outside-'));
    const bytes = new TextEncoder().encode('fixture bytes');
    const asset = { ...assetBase, size: bytes.byteLength, digest: await digestBytes(bytes) };
    try {
      await writeFile(join(root, asset.filename), bytes);
      const provider = createLocalCliReleaseAssetProvider({ root });
      await expect(provider.get(asset)).resolves.toEqual(bytes);

      await writeFile(join(outside, 'secret'), new Uint8Array([7, 7, 7]));
      await rm(join(root, asset.filename));
      await symlink(join(outside, 'secret'), join(root, asset.filename));
      await expect(provider.get(asset)).rejects.toMatchObject({ code: 'invalid' });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('selects the registered BlobStore object before an optional local fixture', async () => {
    const store = new MemoryStore();
    const bytes = new TextEncoder().encode('registered bytes');
    store.values.set('sealed/registered', bytes);
    const asset = { ...assetBase, size: bytes.byteLength, digest: await digestBytes(bytes), storageKey: 'sealed/registered' };
    const provider = createNodeCliReleaseAssetProvider({ store, localRoot: '/path/that/is/not/read' });
    await expect(provider.get(asset)).resolves.toEqual(bytes);
  });
});
