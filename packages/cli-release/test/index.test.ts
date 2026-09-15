import { describe, expect, it } from 'vitest';
import type { BlobStore, StoredBlob } from '../../contracts/src/index.js';
import {
  CLI_RELEASE_TARGETS,
  CliReleaseManifestError,
  PINNED_CLI_RELEASE_MANIFEST,
  createBlobCliReleaseAssetProvider,
  parseCliReleaseManifest,
  publicCliReleaseManifest,
  verifyCliReleaseAssetBytes,
} from '../src/index.js';
import { digestBytes } from '../../storage/src/digest.js';

class MemoryBlobStore implements BlobStore {
  readonly values = new Map<string, Uint8Array>();

  async put(bytes: Uint8Array): Promise<StoredBlob> {
    const key = `sealed/${this.values.size + 1}`;
    const copy = bytes.slice();
    const digest = await digestBytes(copy);
    this.values.set(key, copy);
    return { key, digest, size: copy.byteLength };
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

async function manifestFor(bytes: Uint8Array) {
  return parseCliReleaseManifest({
    protocolVersion: 1,
    version: '1.0.0',
    releaseTag: 'v1.0.0',
    source: {
      kind: 'github-release',
      repository: 'private/example',
      tag: 'v1.0.0',
      tagCommit: '0123456789012345678901234567890123456789',
    },
    checksums: {
      filename: 'SHA256SUMS',
      size: 1,
      digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    },
    assets: [{
      target: 'aarch64-apple-darwin',
      platform: 'macos',
      architecture: 'arm64',
      filename: 'pskills-aarch64-apple-darwin.tar.gz',
      archive: 'tar.gz',
      member: 'pskills',
      size: bytes.byteLength,
      digest: await digestBytes(bytes),
      storageKey: 'sealed/cli-mac',
    }],
    verification: {
      nativeProofTargets: ['aarch64-apple-darwin'],
      nativeTestWaivedTargets: [],
    },
  });
}

describe('CLI release manifest contract', () => {
  it('pins the verified v0.4.0 archive inventory and qualifications', () => {
    expect(PINNED_CLI_RELEASE_MANIFEST).toMatchObject({
      version: '0.4.0',
      releaseTag: 'v0.4.0',
      source: {
        repository: 'andymac4182/private-skills',
        tag: 'v0.4.0',
        tagCommit: '84f712720dba74508d56f0bcb532393dad24324d',
      },
      checksums: {
        filename: 'SHA256SUMS',
        size: 309,
        digest: 'sha256:02c6bf4296ee344aa9d6846e5848ba00920112361093205a7bb95ef688688889',
      },
      verification: {
        nativeProofTargets: ['aarch64-apple-darwin'],
        nativeTestWaivedTargets: ['x86_64-unknown-linux-gnu', 'x86_64-pc-windows-msvc'],
      },
    });
    expect(PINNED_CLI_RELEASE_MANIFEST.assets.map((asset) => [asset.target, asset.size, asset.digest])).toEqual([
      ['aarch64-apple-darwin', 2_673_030, 'sha256:1e5b8119f98644d48cdeab7f6e8b5b338de7bb7b00a73b8382648ef353c4ff37'],
      ['x86_64-unknown-linux-gnu', 2_922_162, 'sha256:4c78a26eeb7025dd7293e9e219560624726be359f16f155ac469f38a16ae4bd9'],
      ['x86_64-pc-windows-msvc', 2_479_997, 'sha256:7212c5d05337286bb3b092a96897d6c6ed626120bde58b42de3ac8e248257d4b'],
    ]);
  });

  it('rejects a tampered asset descriptor and never serializes private storage/source data', () => {
    const tampered = structuredClone(PINNED_CLI_RELEASE_MANIFEST) as unknown as Record<string, unknown>;
    const assets = tampered.assets as Array<Record<string, unknown>>;
    assets[0]!.filename = 'private/escape.tar.gz';
    expect(() => parseCliReleaseManifest(tampered)).toThrow(CliReleaseManifestError);

    const publicManifest = publicCliReleaseManifest(PINNED_CLI_RELEASE_MANIFEST);
    const serialized = JSON.stringify(publicManifest);
    expect(serialized).not.toContain('andymac4182/private-skills');
    expect(serialized).not.toContain('storageKey');
    expect(publicManifest.assets[0]).toMatchObject({ verification: 'native-smoke-verified' });
    expect(publicManifest.assets[1]).toMatchObject({ verification: 'native-test-waived' });
  });

  it('reads the exact registered BlobStore bytes and rejects a digest mismatch', async () => {
    const bytes = new TextEncoder().encode('private release fixture bytes');
    const manifest = await manifestFor(bytes);
    const store = new MemoryBlobStore();
    store.values.set('sealed/cli-mac', bytes.slice());
    const provider = createBlobCliReleaseAssetProvider(store);
    await expect(provider.get(manifest.assets[0]!)).resolves.toEqual(bytes);
    await expect(verifyCliReleaseAssetBytes(manifest.assets[0]!, bytes)).resolves.toEqual(bytes);
    await expect(verifyCliReleaseAssetBytes(manifest.assets[0]!, new Uint8Array(bytes.byteLength).fill(9))).rejects.toThrow(/digest|integrity/u);
  });

  it('keeps the target catalog closed to unsupported platforms', () => {
    expect(CLI_RELEASE_TARGETS.map((target) => target.target)).toEqual([
      'aarch64-apple-darwin',
      'x86_64-unknown-linux-gnu',
      'x86_64-pc-windows-msvc',
    ]);
    const unsupported = {
      ...PINNED_CLI_RELEASE_MANIFEST,
      assets: PINNED_CLI_RELEASE_MANIFEST.assets,
    };
    expect(() => parseCliReleaseManifest({
      ...unsupported,
      assets: [{ ...PINNED_CLI_RELEASE_MANIFEST.assets[0]!, target: 'x86_64-apple-darwin' }],
      verification: { nativeProofTargets: [], nativeTestWaivedTargets: ['x86_64-apple-darwin'] },
    })).toThrow(CliReleaseManifestError);
  });
});
