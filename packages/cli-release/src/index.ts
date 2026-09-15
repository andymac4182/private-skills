import type { BlobStore, Digest } from '../../contracts/src/index.js';
import { digestBytes, isSha256Digest } from '../../storage/src/digest.js';

/** Version of the authenticated company CLI distribution contract. */
export const CLI_RELEASE_PROTOCOL_VERSION = 1 as const;
export const CLI_RELEASE_VERSION = '0.4.0' as const;

export type CliReleaseTarget =
  | 'aarch64-apple-darwin'
  | 'x86_64-unknown-linux-gnu'
  | 'x86_64-pc-windows-msvc';
export type CliReleasePlatform = 'macos' | 'linux' | 'windows';
export type CliReleaseArchitecture = 'arm64' | 'x86_64';
export type CliReleaseArchive = 'tar.gz' | 'zip';
export type CliReleaseVerification = 'native-smoke-verified' | 'native-test-waived';
/** Availability describes server-side provisioning, not native OS testing. */
export type CliReleaseAvailability = 'ready' | 'unprovisioned' | 'unknown';

/**
 * The target catalog is intentionally closed. A new target requires a new
 * release asset, checksum, and native verification decision rather than a
 * browser-side guess about a compatible executable.
 */
export const CLI_RELEASE_TARGETS = Object.freeze([
  Object.freeze({
    target: 'aarch64-apple-darwin',
    platform: 'macos',
    architecture: 'arm64',
    label: 'macOS · Apple Silicon',
    shortLabel: 'Apple Silicon Mac',
    filename: 'pskills-aarch64-apple-darwin.tar.gz',
    archive: 'tar.gz',
    member: 'pskills',
  }),
  Object.freeze({
    target: 'x86_64-unknown-linux-gnu',
    platform: 'linux',
    architecture: 'x86_64',
    label: 'Linux · x86_64',
    shortLabel: 'Linux x86_64',
    filename: 'pskills-x86_64-unknown-linux-gnu.tar.gz',
    archive: 'tar.gz',
    member: 'pskills',
  }),
  Object.freeze({
    target: 'x86_64-pc-windows-msvc',
    platform: 'windows',
    architecture: 'x86_64',
    label: 'Windows · x86_64',
    shortLabel: 'Windows x86_64',
    filename: 'pskills-x86_64-pc-windows-msvc.zip',
    archive: 'zip',
    member: 'pskills.exe',
  }),
] as const);

export interface CliReleaseSource {
  /** This source descriptor is server-only and is omitted from API output. */
  readonly kind: 'github-release';
  readonly repository: string;
  readonly tag: string;
  readonly tagCommit: string;
}

export interface CliReleaseAsset {
  readonly target: CliReleaseTarget;
  readonly platform: CliReleasePlatform;
  readonly architecture: CliReleaseArchitecture;
  readonly filename: string;
  readonly archive: CliReleaseArchive;
  readonly member: 'pskills' | 'pskills.exe';
  readonly size: number;
  readonly digest: Digest;
  /** Opaque sealed Files SDK key. It is never serialized to a browser. */
  readonly storageKey?: string;
}

export interface CliReleaseChecksums {
  readonly filename: 'SHA256SUMS';
  readonly size: number;
  readonly digest: Digest;
}

export interface CliReleaseManifest {
  readonly protocolVersion: typeof CLI_RELEASE_PROTOCOL_VERSION;
  readonly version: string;
  readonly releaseTag: string;
  /** Server-only release provenance. Private repository details stay here. */
  readonly source: CliReleaseSource;
  readonly checksums: CliReleaseChecksums;
  readonly assets: readonly CliReleaseAsset[];
  readonly verification: {
    readonly nativeProofTargets: readonly CliReleaseTarget[];
    readonly nativeTestWaivedTargets: readonly CliReleaseTarget[];
  };
}

export interface PublicCliReleaseAsset {
  readonly target: CliReleaseTarget;
  readonly platform: CliReleasePlatform;
  readonly architecture: CliReleaseArchitecture;
  readonly filename: string;
  readonly archive: CliReleaseArchive;
  readonly member: 'pskills' | 'pskills.exe';
  readonly size: number;
  readonly digest: Digest;
  readonly verification: CliReleaseVerification;
  /** Private storage state; storage keys themselves never cross this boundary. */
  readonly availability: CliReleaseAvailability;
}

export interface PublicCliReleaseManifest {
  readonly protocolVersion: typeof CLI_RELEASE_PROTOCOL_VERSION;
  readonly version: string;
  readonly releaseTag: string;
  readonly checksums: CliReleaseChecksums;
  readonly assets: readonly PublicCliReleaseAsset[];
  readonly verification: {
    readonly nativeProofTargets: readonly CliReleaseTarget[];
    readonly nativeTestWaivedTargets: readonly CliReleaseTarget[];
  };
}

const PINNED_RELEASE_SOURCE: CliReleaseSource = Object.freeze({
  kind: 'github-release',
  repository: 'andymac4182/private-skills',
  tag: 'v0.4.0',
  // This is the v0.4.0 tag object observed from the private release. It is
  // kept separate from the later production release head documented in the
  // repository evidence.
  tagCommit: '84f712720dba74508d56f0bcb532393dad24324d',
});

/**
 * Release bytes are pinned to the private v0.4.0 release assets. The storage
 * key is deliberately absent until an operator registers the verified asset
 * in the private BlobStore; this prevents the application from silently
 * falling back to a GitHub URL or exposing source-repository credentials.
 */
export const PINNED_CLI_RELEASE_MANIFEST: CliReleaseManifest = Object.freeze({
  protocolVersion: CLI_RELEASE_PROTOCOL_VERSION,
  version: CLI_RELEASE_VERSION,
  releaseTag: 'v0.4.0',
  source: PINNED_RELEASE_SOURCE,
  checksums: Object.freeze({
    filename: 'SHA256SUMS',
    size: 309,
    digest: 'sha256:02c6bf4296ee344aa9d6846e5848ba00920112361093205a7bb95ef688688889' as Digest,
  }),
  assets: Object.freeze([
    Object.freeze({
      target: 'aarch64-apple-darwin',
      platform: 'macos',
      architecture: 'arm64',
      filename: 'pskills-aarch64-apple-darwin.tar.gz',
      archive: 'tar.gz',
      member: 'pskills',
      size: 2_673_030,
      digest: 'sha256:1e5b8119f98644d48cdeab7f6e8b5b338de7bb7b00a73b8382648ef353c4ff37' as Digest,
    }),
    Object.freeze({
      target: 'x86_64-unknown-linux-gnu',
      platform: 'linux',
      architecture: 'x86_64',
      filename: 'pskills-x86_64-unknown-linux-gnu.tar.gz',
      archive: 'tar.gz',
      member: 'pskills',
      size: 2_922_162,
      digest: 'sha256:4c78a26eeb7025dd7293e9e219560624726be359f16f155ac469f38a16ae4bd9' as Digest,
    }),
    Object.freeze({
      target: 'x86_64-pc-windows-msvc',
      platform: 'windows',
      architecture: 'x86_64',
      filename: 'pskills-x86_64-pc-windows-msvc.zip',
      archive: 'zip',
      member: 'pskills.exe',
      size: 2_479_997,
      digest: 'sha256:7212c5d05337286bb3b092a96897d6c6ed626120bde58b42de3ac8e248257d4b' as Digest,
    }),
  ]),
  verification: Object.freeze({
    nativeProofTargets: Object.freeze(['aarch64-apple-darwin'] as CliReleaseTarget[]),
    nativeTestWaivedTargets: Object.freeze(['x86_64-unknown-linux-gnu', 'x86_64-pc-windows-msvc'] as CliReleaseTarget[]),
  }),
});

const VERSION_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/u;
const COMMIT_RE = /^[0-9a-f]{40}$/u;
const SAFE_TEXT_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const SAFE_STORAGE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const MAX_RELEASE_ASSET_BYTES = 100 * 1024 * 1024;

export class CliReleaseManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliReleaseManifestError';
  }
}

export type CliReleaseProviderErrorCode = 'not_configured' | 'invalid' | 'read';

export class CliReleaseProviderError extends Error {
  readonly code: CliReleaseProviderErrorCode;

  constructor(code: CliReleaseProviderErrorCode, message: string) {
    super(message);
    this.name = 'CliReleaseProviderError';
    this.code = code;
  }
}

export class CliReleaseIntegrityError extends Error {
  constructor(message = 'CLI release bytes failed integrity verification') {
    super(message);
    this.name = 'CliReleaseIntegrityError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function keysAre(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const accepted = new Set(allowed);
  return Object.keys(value).every((key) => accepted.has(key));
}

function requiredText(value: unknown, label: string, pattern: RegExp, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || !pattern.test(value)) {
    throw new CliReleaseManifestError(`${label} is invalid`);
  }
  return value;
}

function requiredTarget(value: unknown, label: string): CliReleaseTarget {
  if (typeof value !== 'string' || !CLI_RELEASE_TARGETS.some((entry) => entry.target === value)) {
    throw new CliReleaseManifestError(`${label} is invalid`);
  }
  return value as CliReleaseTarget;
}

function requiredArray(value: unknown, label: string, allowEmpty = false): unknown[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > CLI_RELEASE_TARGETS.length) {
    throw new CliReleaseManifestError(`${label} is invalid`);
  }
  return value;
}

function safeStorageKey(value: unknown): string {
  const key = requiredText(value, 'asset storageKey', SAFE_STORAGE_KEY_RE, 4_096);
  if (
    key.startsWith('/') ||
    key.endsWith('/') ||
    key.includes('//') ||
    key.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    throw new CliReleaseManifestError('asset storageKey is unsafe');
  }
  return key;
}

function cloneAndFreezeManifest(manifest: CliReleaseManifest): CliReleaseManifest {
  const assets = Object.freeze(manifest.assets.map((asset) => Object.freeze({ ...asset })));
  const verification = Object.freeze({
    nativeProofTargets: Object.freeze([...manifest.verification.nativeProofTargets]),
    nativeTestWaivedTargets: Object.freeze([...manifest.verification.nativeTestWaivedTargets]),
  });
  return Object.freeze({
    protocolVersion: manifest.protocolVersion,
    version: manifest.version,
    releaseTag: manifest.releaseTag,
    source: Object.freeze({ ...manifest.source }),
    checksums: Object.freeze({ ...manifest.checksums }),
    assets,
    verification,
  });
}

/** Parse and strictly validate an operator-supplied, server-only manifest. */
export function parseCliReleaseManifest(value: unknown): CliReleaseManifest {
  if (!isRecord(value) || !keysAre(value, ['protocolVersion', 'version', 'releaseTag', 'source', 'checksums', 'assets', 'verification'])) {
    throw new CliReleaseManifestError('CLI release manifest is invalid');
  }
  if (value.protocolVersion !== CLI_RELEASE_PROTOCOL_VERSION) {
    throw new CliReleaseManifestError('CLI release protocol version is unsupported');
  }
  const version = requiredText(value.version, 'release version', VERSION_RE, 64);
  const releaseTag = requiredText(value.releaseTag, 'release tag', SAFE_TEXT_RE, 128);
  if (releaseTag !== `v${version}`) throw new CliReleaseManifestError('release tag does not match release version');

  if (!isRecord(value.source) || !keysAre(value.source, ['kind', 'repository', 'tag', 'tagCommit'])) {
    throw new CliReleaseManifestError('CLI release source is invalid');
  }
  if (value.source.kind !== 'github-release') throw new CliReleaseManifestError('CLI release source kind is unsupported');
  const repository = requiredText(value.source.repository, 'release repository', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u, 256);
  const tag = requiredText(value.source.tag, 'release source tag', SAFE_TEXT_RE, 128);
  if (tag !== releaseTag) throw new CliReleaseManifestError('release source tag does not match release tag');
  const tagCommit = requiredText(value.source.tagCommit, 'release tag commit', COMMIT_RE, 40);

  if (!isRecord(value.checksums) || !keysAre(value.checksums, ['filename', 'size', 'digest']) || value.checksums.filename !== 'SHA256SUMS') {
    throw new CliReleaseManifestError('CLI release checksum file is invalid');
  }
  if (typeof value.checksums.size !== 'number' || !Number.isSafeInteger(value.checksums.size) || value.checksums.size <= 0 || value.checksums.size > 1_048_576) {
    throw new CliReleaseManifestError('CLI release checksum file size is invalid');
  }
  if (typeof value.checksums.digest !== 'string' || !SHA256_RE.test(value.checksums.digest)) {
    throw new CliReleaseManifestError('CLI release checksum file digest is invalid');
  }

  const rawAssets = requiredArray(value.assets, 'CLI release assets');
  const assets: CliReleaseAsset[] = [];
  const targets = new Set<CliReleaseTarget>();
  const filenames = new Set<string>();
  for (const raw of rawAssets) {
    if (!isRecord(raw) || !keysAre(raw, ['target', 'platform', 'architecture', 'filename', 'archive', 'member', 'size', 'digest', 'storageKey'])) {
      throw new CliReleaseManifestError('CLI release asset is invalid');
    }
    const target = requiredTarget(raw.target, 'asset target');
    if (targets.has(target)) throw new CliReleaseManifestError('CLI release has duplicate targets');
    const definition = CLI_RELEASE_TARGETS.find((entry) => entry.target === target)!;
    if (raw.platform !== definition.platform || raw.architecture !== definition.architecture || raw.archive !== definition.archive || raw.member !== definition.member) {
      throw new CliReleaseManifestError(`CLI release asset metadata does not match ${target}`);
    }
    if (raw.filename !== definition.filename) throw new CliReleaseManifestError(`CLI release filename does not match ${target}`);
    const filename = requiredText(raw.filename, 'asset filename', /^[A-Za-z0-9][A-Za-z0-9._-]*$/u, 256);
    if (filenames.has(filename)) throw new CliReleaseManifestError('CLI release has duplicate filenames');
    if (typeof raw.size !== 'number' || !Number.isSafeInteger(raw.size) || raw.size <= 0 || raw.size > MAX_RELEASE_ASSET_BYTES) {
      throw new CliReleaseManifestError('asset size is invalid');
    }
    if (typeof raw.digest !== 'string' || !SHA256_RE.test(raw.digest)) throw new CliReleaseManifestError('asset digest is invalid');
    const storageKey = raw.storageKey === undefined ? undefined : safeStorageKey(raw.storageKey);
    assets.push({
      target,
      platform: definition.platform,
      architecture: definition.architecture,
      filename,
      archive: definition.archive,
      member: definition.member,
      size: raw.size,
      digest: raw.digest as Digest,
      ...(storageKey === undefined ? {} : { storageKey }),
    });
    targets.add(target);
    filenames.add(filename);
  }

  if (!isRecord(value.verification) || !keysAre(value.verification, ['nativeProofTargets', 'nativeTestWaivedTargets'])) {
    throw new CliReleaseManifestError('CLI release verification is invalid');
  }
  const nativeProofTargets = requiredArray(value.verification.nativeProofTargets, 'native proof targets', true).map((entry) => requiredTarget(entry, 'native proof target'));
  const nativeTestWaivedTargets = requiredArray(value.verification.nativeTestWaivedTargets, 'native waived targets', true).map((entry) => requiredTarget(entry, 'native waived target'));
  const allAssets = new Set(assets.map((asset) => asset.target));
  const proofSet = new Set(nativeProofTargets);
  const waivedSet = new Set(nativeTestWaivedTargets);
  if (proofSet.size !== nativeProofTargets.length || waivedSet.size !== nativeTestWaivedTargets.length) throw new CliReleaseManifestError('CLI release verification has duplicate targets');
  if (nativeProofTargets.some((target) => waivedSet.has(target)) || nativeTestWaivedTargets.some((target) => !allAssets.has(target)) || nativeProofTargets.some((target) => !allAssets.has(target)) || assets.some((asset) => !proofSet.has(asset.target) && !waivedSet.has(asset.target))) {
    throw new CliReleaseManifestError('CLI release verification does not cover assets exactly');
  }

  return cloneAndFreezeManifest({
    protocolVersion: CLI_RELEASE_PROTOCOL_VERSION,
    version,
    releaseTag,
    source: { kind: 'github-release', repository, tag, tagCommit },
    checksums: { filename: 'SHA256SUMS', size: value.checksums.size, digest: value.checksums.digest as Digest },
    assets,
    verification: { nativeProofTargets, nativeTestWaivedTargets },
  });
}

/** Resolve the server environment value, defaulting to the pinned metadata. */
export function resolveCliReleaseManifest(raw: string | undefined): CliReleaseManifest {
  if (raw === undefined || raw.trim() === '') return PINNED_CLI_RELEASE_MANIFEST;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliReleaseManifestError('PSKILLS_CLI_RELEASE_MANIFEST is not valid JSON');
  }
  return parseCliReleaseManifest(parsed);
}

/** Strip private source and storage details before returning a manifest. */
export function publicCliReleaseManifest(
  manifest: CliReleaseManifest,
  availability: (asset: CliReleaseAsset) => CliReleaseAvailability = () => 'unknown',
): PublicCliReleaseManifest {
  const nativeProof = new Set(manifest.verification.nativeProofTargets);
  return Object.freeze({
    protocolVersion: manifest.protocolVersion,
    version: manifest.version,
    releaseTag: manifest.releaseTag,
    checksums: Object.freeze({ ...manifest.checksums }),
    assets: Object.freeze(manifest.assets.map((asset) => Object.freeze({
      target: asset.target,
      platform: asset.platform,
      architecture: asset.architecture,
      filename: asset.filename,
      archive: asset.archive,
      member: asset.member,
      size: asset.size,
      digest: asset.digest,
      verification: nativeProof.has(asset.target) ? 'native-smoke-verified' as const : 'native-test-waived' as const,
      availability: availability(asset),
    }))),
    verification: Object.freeze({
      nativeProofTargets: Object.freeze([...manifest.verification.nativeProofTargets]),
      nativeTestWaivedTargets: Object.freeze([...manifest.verification.nativeTestWaivedTargets]),
    }),
  });
}

export interface CliReleaseAssetProvider {
  get(asset: CliReleaseAsset): Promise<Uint8Array>;
  /**
   * Report whether an object is configured before the browser offers a
   * download. Providers may omit this when they cannot answer cheaply; the
   * public manifest then marks the asset as unknown and the app keeps the
   * download action disabled until a server response confirms it.
   */
  availability?(asset: CliReleaseAsset): CliReleaseAvailability;
}

type VerifyingBlobStore = BlobStore & {
  getVerified?: (key: string, expectedDigest: Digest) => Promise<Uint8Array>;
};

/**
 * Read a registered release object through the existing private BlobStore.
 * Files SDK and HTTP BlobStore implementations expose getVerified; the
 * fallback remains protected by verifyCliReleaseAssetBytes in the route.
 */
export function createBlobCliReleaseAssetProvider(store: BlobStore): CliReleaseAssetProvider {
  return {
    availability: (asset) => asset.storageKey === undefined ? 'unprovisioned' : 'ready',
    async get(asset) {
      const key = asset.storageKey;
      if (key === undefined) throw new CliReleaseProviderError('not_configured', 'CLI release asset is not registered in private storage');
      if (!SAFE_STORAGE_KEY_RE.test(key) || key.startsWith('/') || key.endsWith('/') || key.includes('//') || key.split('/').some((segment) => segment === '.' || segment === '..')) {
        throw new CliReleaseProviderError('invalid', 'CLI release asset storage reference is invalid');
      }
      try {
        const candidate = store as VerifyingBlobStore;
        const bytes = candidate.getVerified
          ? await candidate.getVerified(key, asset.digest)
          : await store.get(key);
        if (!(bytes instanceof Uint8Array)) throw new CliReleaseProviderError('read', 'CLI release storage returned an invalid body');
        return bytes.slice();
      } catch (error) {
        if (error instanceof CliReleaseProviderError) throw error;
        throw new CliReleaseProviderError('read', 'CLI release storage could not be read');
      }
    },
  };
}

/** Verify the exact bytes and size promised by the pinned server manifest. */
export async function verifyCliReleaseAssetBytes(asset: CliReleaseAsset, bytes: Uint8Array): Promise<Uint8Array> {
  if (!(bytes instanceof Uint8Array)) throw new CliReleaseIntegrityError('CLI release provider returned a non-byte body');
  if (bytes.byteLength !== asset.size) throw new CliReleaseIntegrityError('CLI release byte length does not match the pinned server manifest');
  const digest = await digestBytes(bytes);
  if (!isSha256Digest(asset.digest) || digest !== asset.digest) throw new CliReleaseIntegrityError('CLI release digest does not match the pinned server manifest');
  return bytes.slice();
}

export function cliReleaseAssetForTarget(manifest: CliReleaseManifest, target: string): CliReleaseAsset | undefined {
  return manifest.assets.find((asset) => asset.target === target);
}
