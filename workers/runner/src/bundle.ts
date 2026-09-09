import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';

export const BUNDLE_FORMAT = 'pskills-bundle-v1' as const;
export const BUNDLE_LIMITS = Object.freeze({
  maxExpandedBytes: 100 * 1024 * 1024,
  maxFileBytes: 10 * 1024 * 1024,
  maxFiles: 2000,
});

export interface BundleFileInput {
  path: string;
  /** Canonical base64 bytes required by the pskills-bundle-v1 transport. */
  content: string;
  executable?: boolean;
  contentEncoding?: 'base64' | 'utf8';
}

export interface SkillBundleInput {
  format: typeof BUNDLE_FORMAT;
  files: BundleFileInput[];
  /** Optional explicit encoding accepted only when the worker is explicitly in trusted local test mode. */
  contentEncoding?: 'base64' | 'utf8';
}

export interface MaterializedBundle {
  root: string;
  inputDir: string;
  files: Array<{ path: string; bytes: number; executable: boolean }>;
  expandedBytes: number;
  cleanup(): Promise<void>;
}

export interface MaterializeOptions {
  limits?: Partial<typeof BUNDLE_LIMITS>;
  /** Development-only compatibility for explicit UTF-8 fixtures; production keeps this false. */
  allowUtf8Content?: boolean;
  requireCanonicalOrder?: boolean;
}

export function parseSkillBundle(bytes: Uint8Array, maxJsonBytes = BUNDLE_LIMITS.maxExpandedBytes * 2): SkillBundleInput {
  if (bytes.byteLength > maxJsonBytes) throw new Error('artifact bundle JSON exceeds worker limit');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
  } catch (error) {
    throw new Error(`artifact is not valid UTF-8 JSON: ${String(error)}`);
  }
  if (!isObject(parsed) || parsed.format !== BUNDLE_FORMAT || !Array.isArray(parsed.files)) {
    throw new Error('artifact is not a pskills-bundle-v1 JSON bundle');
  }
  return parsed as unknown as SkillBundleInput;
}

export async function materializeBundle(bundle: SkillBundleInput, options: MaterializeOptions = {}): Promise<MaterializedBundle> {
  const limits = { ...BUNDLE_LIMITS, ...(options.limits ?? {}) };
  if (!isObject(bundle) || bundle.format !== BUNDLE_FORMAT || !Array.isArray(bundle.files)) {
    throw new Error('invalid pskills-bundle-v1 payload');
  }
  if (bundle.files.length > limits.maxFiles) throw new Error(`bundle contains more than ${limits.maxFiles} files`);
  const root = await mkdtemp(join(tmpdir(), 'pskills-worker-'));
  const inputDir = join(root, 'input');
  const outputDir = join(root, 'output');
  await mkdir(inputDir, { recursive: true, mode: 0o700 });
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const files: MaterializedBundle['files'] = [];
  const seen = new Set<string>();
  let expandedBytes = 0;
  const requireCanonicalOrder = options.requireCanonicalOrder ?? true;
  let previousPath = '';
  try {
    for (const file of bundle.files) {
      if (!isObject(file) || typeof file.path !== 'string' || typeof file.content !== 'string') {
        throw new Error('bundle file must contain path and content');
      }
      const path = validateRelativePath(file.path);
      if (seen.has(path)) throw new Error(`bundle contains duplicate path: ${path}`);
      if (requireCanonicalOrder && previousPath && comparePath(previousPath, path) >= 0) {
        throw new Error(`bundle files are not in canonical path order near ${path}`);
      }
      previousPath = path;
      seen.add(path);
      const encoding = file.contentEncoding ?? bundle.contentEncoding ?? 'base64';
      const bytes = decodeContent(file.content, encoding, options.allowUtf8Content === true);
      if (bytes.byteLength > limits.maxFileBytes) throw new Error(`bundle file exceeds ${limits.maxFileBytes} bytes: ${path}`);
      expandedBytes += bytes.byteLength;
      if (expandedBytes > limits.maxExpandedBytes) throw new Error(`bundle exceeds ${limits.maxExpandedBytes} expanded bytes`);
      const target = join(inputDir, ...path.split('/'));
      if (!isContained(inputDir, target)) throw new Error(`bundle path escapes input directory: ${path}`);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await ensureNoSymlinkSegments(inputDir, target);
      await writeFile(target, bytes, { flag: 'wx', mode: file.executable === true ? 0o700 : 0o600 });
      if (file.executable === true) await chmod(target, 0o700);
      files.push({ path, bytes: bytes.byteLength, executable: file.executable === true });
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    root,
    inputDir,
    files,
    expandedBytes,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

export function bundleDigest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function validateArtifactDigest(bytes: Uint8Array, expected: string): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(expected)) throw new Error('job artifact digest is not a sha256 digest');
  const actual = bundleDigest(bytes);
  if (actual !== expected) throw new Error(`artifact digest mismatch: expected ${expected}, received ${actual}`);
}

function decodeContent(value: string, encoding: 'base64' | 'utf8', allowUtf8: boolean): Uint8Array {
  if (encoding === 'utf8') {
    if (!allowUtf8) throw new Error('UTF-8 bundle content is disabled; transport requires base64 bytes');
    return Buffer.from(value, 'utf8');
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('bundle file content is not canonical base64');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error('bundle file content is not canonical base64');
  return bytes;
}

function validateRelativePath(value: string): string {
  if (!value || value.length > 1024 || value.includes('\u0000') || value.includes('\\') || value.startsWith('/')) {
    throw new Error(`invalid bundle path: ${value}`);
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error(`invalid bundle path: ${value}`);
  if (/^[A-Za-z]:$/.test(parts[0])) throw new Error(`invalid bundle path: ${value}`);
  return parts.join('/');
}

function comparePath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isContained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
}

async function ensureNoSymlinkSegments(root: string, target: string): Promise<void> {
  const rel = relative(root, target).split(sep).filter(Boolean);
  let current = root;
  for (const segment of rel) {
    current = join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`bundle path traverses symlink: ${segment}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
