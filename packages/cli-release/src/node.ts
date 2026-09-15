import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { BlobStore } from '../../contracts/src/index.js';
import {
  createBlobCliReleaseAssetProvider,
  CliReleaseProviderError,
  type CliReleaseAsset,
  type CliReleaseAssetProvider,
} from './index.js';

export interface LocalCliReleaseAssetProviderOptions {
  /** A server-owned directory containing verified release archives. */
  root: string;
  /** Test hook; production callers use the native fs reader above. */
  read?: (path: string) => Promise<Uint8Array>;
}

function within(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === '' || (!isAbsolute(relation) && relation !== '..' && !relation.startsWith(`..${sep}`));
}

/**
 * Read a development-only local fixture without allowing a manifest filename
 * or symlink to escape its configured directory. Production deployments should
 * register immutable objects in the private BlobStore instead.
 */
export function createLocalCliReleaseAssetProvider(options: LocalCliReleaseAssetProviderOptions): CliReleaseAssetProvider {
  const root = resolve(options.root);
  const reader = options.read ?? (async (path: string) => new Uint8Array(await readFile(path)));
  return {
    availability: () => 'ready',
    async get(asset: CliReleaseAsset): Promise<Uint8Array> {
      const candidate = resolve(root, asset.filename);
      if (!within(root, candidate)) throw new CliReleaseProviderError('invalid', 'CLI release fixture path is outside its configured root');
      try {
        const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
        if (!within(realRoot, realCandidate)) throw new CliReleaseProviderError('invalid', 'CLI release fixture path is outside its configured root');
        const bytes = await reader(realCandidate);
        if (!(bytes instanceof Uint8Array)) throw new CliReleaseProviderError('read', 'CLI release fixture returned an invalid body');
        return bytes.slice();
      } catch (error) {
        if (error instanceof CliReleaseProviderError) throw error;
        throw new CliReleaseProviderError('read', 'CLI release fixture could not be read');
      }
    },
  };
}

export interface NodeCliReleaseAssetProviderOptions {
  /** First-class private Files SDK/HTTP BlobStore used by hosted deployments. */
  store?: BlobStore;
  /** Optional local fixture root; only selected when an asset has no storageKey. */
  localRoot?: string;
}

/**
 * Prefer a registered private BlobStore object and fall back to a local
 * fixture only when explicitly configured. This keeps hosted launch paths
 * independent of local filesystem state while preserving disposable demos.
 */
export function createNodeCliReleaseAssetProvider(options: NodeCliReleaseAssetProviderOptions): CliReleaseAssetProvider {
  const blobProvider = options.store === undefined ? undefined : createBlobCliReleaseAssetProvider(options.store);
  const localProvider = options.localRoot === undefined || options.localRoot.trim() === ''
    ? undefined
    : createLocalCliReleaseAssetProvider({ root: options.localRoot });
  return {
    availability: (asset) => asset.storageKey !== undefined
      ? (blobProvider === undefined ? 'unprovisioned' : 'ready')
      : (localProvider === undefined ? 'unprovisioned' : 'ready'),
    async get(asset: CliReleaseAsset): Promise<Uint8Array> {
      if (asset.storageKey !== undefined) {
        if (blobProvider === undefined) throw new CliReleaseProviderError('not_configured', 'CLI release private storage is not configured');
        return blobProvider.get(asset);
      }
      if (localProvider !== undefined) return localProvider.get(asset);
      throw new CliReleaseProviderError('not_configured', 'CLI release asset has no registered private storage object');
    },
  };
}
