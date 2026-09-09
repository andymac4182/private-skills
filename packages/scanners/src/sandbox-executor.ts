import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { CommandExecutor, CommandRequest, CommandResult, ScannerId } from './types.js';

/**
 * The Vercel SDK is intentionally kept behind a structural boundary. This
 * keeps the scanner package importable by edge builds that do not bundle the
 * Node-only SDK, while allowing a production Node route to load it lazily.
 */
export interface SandboxFileDescriptor {
  path: string;
  content: Buffer;
  mode?: number;
}

export interface SandboxLogEntry {
  stream: 'stdout' | 'stderr';
  data: string;
}

export interface SandboxStats {
  size: number;
  isFile(): boolean;
  isSymbolicLink?(): boolean;
}

export interface SandboxFileSystem {
  stat(path: string, options?: { signal?: AbortSignal }): Promise<SandboxStats>;
  lstat?(path: string, options?: { signal?: AbortSignal }): Promise<SandboxStats>;
  readFile?(path: string, encoding?: 'utf8' | { encoding?: 'utf8'; signal?: AbortSignal }): Promise<Buffer | string>;
}

export interface SandboxCommandFinished {
  exitCode: number | null;
  durationMs?: number;
}

export interface SandboxCommand {
  wait(options?: { signal?: AbortSignal }): Promise<SandboxCommandFinished>;
  logs(options?: { signal?: AbortSignal }): AsyncIterable<SandboxLogEntry>;
  kill(signal?: 'SIGTERM' | 'SIGKILL', options?: { abortSignal?: AbortSignal }): Promise<void>;
}

export interface SandboxRunCommandOptions {
  cmd: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  detached: true;
  signal?: AbortSignal;
}

export interface SandboxInstance {
  mkDir(path: string, options?: { signal?: AbortSignal }): Promise<void>;
  writeFiles(files: SandboxFileDescriptor[], options?: { signal?: AbortSignal }): Promise<void>;
  runCommand(options: SandboxRunCommandOptions): Promise<SandboxCommand>;
  readFileToBuffer?(file: { path: string; cwd?: string }, options?: { signal?: AbortSignal }): Promise<Buffer | null>;
  fs: SandboxFileSystem;
  stop(options?: { signal?: AbortSignal }): Promise<unknown>;
}

export interface SandboxCreateOptions {
  image?: string;
  source?: { type: 'snapshot'; snapshotId: string };
  resources: { vcpus: number };
  timeout: number;
  networkPolicy: 'deny-all';
  persistent: false;
  signal?: AbortSignal;
}

export interface SandboxSdk {
  Sandbox: {
    create(options: SandboxCreateOptions): Promise<SandboxInstance>;
  };
}

export type SandboxSdkLoader = () => Promise<SandboxSdk>;

export interface TrustedSnapshotReference {
  snapshotId: string;
  /** Exact scanner source revision used to prepare the snapshot. */
  sourceRevision: string;
  /** SHA-256 digest of the prepared scanner tree/runtime evidence. */
  artifactDigest: string;
}

export interface SandboxExecutorOptions {
  /** Test/integration injection; production uses the lazy SDK loader. */
  sdk?: SandboxSdk;
  /** Override the lazy loader without importing the SDK at module load time. */
  loadSdk?: SandboxSdkLoader;
  maxInputBytes?: number;
  maxInputFileBytes?: number;
  maxInputFiles?: number;
  writeBatchBytes?: number;
  sandboxTimeoutGraceMs?: number;
  /** Non-secret scanner configuration keys allowed in CommandRequest.env. */
  allowedEnvKeys?: readonly string[];
  /** Trusted snapshots keyed by their snapshot ID. */
  trustedSnapshots?: Readonly<Record<string, TrustedSnapshotReference>>;
}

export type SandboxImageMap = Partial<Record<ScannerId, string>>;

const DEFAULT_MAX_INPUT_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_INPUT_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_INPUT_FILES = 2_000;
const DEFAULT_WRITE_BATCH_BYTES = 8 * 1024 * 1024;
const DEFAULT_SANDBOX_TIMEOUT_GRACE_MS = 5_000;
const DEFAULT_KILL_GRACE_MS = 1_000;
// A fresh Vercel Sandbox has /vercel/sandbox as its writable workspace. Do
// not create a new root-level /work directory: mkDir is intentionally not
// recursive and the unprivileged sandbox user cannot create root directories.
const SANDBOX_WORK_ROOT = '/vercel/sandbox/private-skills';
const INPUT_ROOT = `${SANDBOX_WORK_ROOT}/input`;
const OUTPUT_ROOT = `${SANDBOX_WORK_ROOT}/output`;
const SNAPSHOT_REF_PREFIX = 'snapshot:';

/**
 * Accept only a VCR image reference whose content is immutable. Scanner tags
 * and mutable registry aliases are deliberately rejected at this boundary.
 */
export function assertImmutableImageRef(value: string): string {
  if (!/^[-A-Za-z0-9._/:]+@sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error('sandbox scanner image must be an immutable @sha256 reference');
  }
  return value;
}

function assertSourceRevision(value: string): string {
  if (!value || value.length > 256 || /[\u0000-\u0020\u007f|]/.test(value)) {
    throw new Error('sandbox snapshot source revision is invalid');
  }
  return value;
}

function assertArtifactDigest(value: string): string {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error('sandbox snapshot artifact digest must be sha256:<64 hex characters>');
  }
  return value;
}

function assertSnapshotId(value: string): string {
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(value)) {
    throw new Error('sandbox snapshot id is invalid');
  }
  return value;
}

export interface ResolvedSandboxImage {
  image?: string;
  source?: { type: 'snapshot'; snapshotId: string };
  imageDigest?: string;
  sourceRevision?: string;
  artifactDigest?: string;
}

/**
 * A snapshot may be supplied as
 * `snapshot:<id>|revision:<source-revision>|artifact:sha256:<digest>`, or as
 * `snapshot:<id>` when the corresponding trustedSnapshots entry is passed to
 * the executor. `source:sha256:<digest>` is accepted as a compact alias for
 * `artifact:sha256:<digest>`. A bare snapshot without immutable provenance is
 * rejected.
 */
export function resolveSandboxImage(
  reference: string,
  trustedSnapshots: Readonly<Record<string, TrustedSnapshotReference>> = {},
): ResolvedSandboxImage {
  if (!reference || /[\u0000-\u001f\u007f\s]/.test(reference)) {
    throw new Error('sandbox scanner image reference is empty or contains control characters');
  }
  if (!reference.startsWith(SNAPSHOT_REF_PREFIX)) {
    const image = assertImmutableImageRef(reference);
    return { image, imageDigest: image.slice(image.indexOf('@') + 1) };
  }

  const encoded = reference.slice(SNAPSHOT_REF_PREFIX.length);
  const segments = encoded.split('|');
  const snapshotId = assertSnapshotId(segments.shift() ?? '');
  let inlineRevision: string | undefined;
  let inlineArtifactDigest: string | undefined;
  for (const segment of segments) {
    const separator = segment.indexOf(':');
    if (separator <= 0) throw new Error(`snapshot ${snapshotId} has an invalid provenance segment`);
    const key = segment.slice(0, separator);
    const value = segment.slice(separator + 1);
    if (key === 'revision' || key === 'commit') inlineRevision = assertSourceRevision(value);
    else if (key === 'artifact') inlineArtifactDigest = assertArtifactDigest(value);
    else if (key === 'source') inlineArtifactDigest = assertArtifactDigest(value);
    else throw new Error(`snapshot ${snapshotId} has an unknown provenance field ${key}`);
  }
  const trusted = trustedSnapshots[snapshotId];
  if (trusted && trusted.snapshotId !== snapshotId) {
    throw new Error(`trusted snapshot map key ${snapshotId} does not match snapshotId`);
  }
  const sourceRevision = inlineRevision ?? trusted?.sourceRevision;
  const artifactDigest = inlineArtifactDigest ?? trusted?.artifactDigest;
  if (!sourceRevision || !artifactDigest) {
    throw new Error(`snapshot ${snapshotId} requires source revision and artifact digest provenance`);
  }
  const normalizedArtifactDigest = assertArtifactDigest(artifactDigest);
  if (trusted && (trusted.sourceRevision !== sourceRevision || assertArtifactDigest(trusted.artifactDigest) !== normalizedArtifactDigest)) {
    throw new Error(`snapshot ${snapshotId} provenance does not match configured source evidence`);
  }
  return {
    source: { type: 'snapshot', snapshotId },
    sourceRevision,
    artifactDigest: normalizedArtifactDigest,
  };
}

export function validateSandboxImageMap(
  images: SandboxImageMap,
  trustedSnapshots: Readonly<Record<string, TrustedSnapshotReference>> = {},
): SandboxImageMap {
  for (const [id, reference] of Object.entries(images)) {
    if (reference !== undefined) resolveSandboxImage(reference, trustedSnapshots);
    if (!id) throw new Error('sandbox scanner image id is empty');
  }
  return images;
}

export class SandboxExecutor implements CommandExecutor {
  readonly isolation = 'container' as const;
  private readonly options: Required<Pick<
    SandboxExecutorOptions,
    'maxInputBytes' | 'maxInputFileBytes' | 'maxInputFiles' | 'writeBatchBytes' | 'sandboxTimeoutGraceMs'
  >> & Pick<SandboxExecutorOptions, 'sdk' | 'loadSdk' | 'trustedSnapshots'> & {
    allowedEnvKeys: ReadonlySet<string>;
  };
  private sdkPromise?: Promise<SandboxSdk>;

  constructor(options: SandboxExecutorOptions = {}) {
    this.options = {
      maxInputBytes: positiveLimit(options.maxInputBytes, DEFAULT_MAX_INPUT_BYTES, 'maxInputBytes'),
      maxInputFileBytes: positiveLimit(options.maxInputFileBytes, DEFAULT_MAX_INPUT_FILE_BYTES, 'maxInputFileBytes'),
      maxInputFiles: positiveLimit(options.maxInputFiles, DEFAULT_MAX_INPUT_FILES, 'maxInputFiles'),
      writeBatchBytes: positiveLimit(options.writeBatchBytes, DEFAULT_WRITE_BATCH_BYTES, 'writeBatchBytes'),
      sandboxTimeoutGraceMs: positiveLimit(options.sandboxTimeoutGraceMs, DEFAULT_SANDBOX_TIMEOUT_GRACE_MS, 'sandboxTimeoutGraceMs'),
      sdk: options.sdk,
      loadSdk: options.loadSdk,
      trustedSnapshots: options.trustedSnapshots,
      allowedEnvKeys: new Set(options.allowedEnvKeys ?? ['NO_COLOR']),
    };
    for (const reference of Object.values(this.options.trustedSnapshots ?? {})) {
      if (reference.snapshotId.length === 0) throw new Error('trusted snapshot id is empty');
      assertSnapshotId(reference.snapshotId);
      assertSourceRevision(reference.sourceRevision);
      assertArtifactDigest(reference.artifactDigest);
    }
  }

  async run(request: CommandRequest): Promise<CommandResult> {
    const started = Date.now();
    const timeoutMs = positiveLimit(request.timeoutMs, 1, 'timeoutMs');
    const maxOutputBytes = positiveLimit(request.maxOutputBytes, 1024, 'maxOutputBytes');
    const inputDir = requireDirectoryPath(request.inputDir, 'inputDir');
    const outputDir = request.outputDir ? requireDirectoryPath(request.outputDir, 'outputDir') : undefined;
    if (!request.image) throw new Error('sandbox scanner image is required');
    const resolvedImage = resolveSandboxImage(request.image, this.options.trustedSnapshots);
    safeExecutable(request.command);
    for (const argument of request.args) {
      if (argument.includes('\u0000')) throw new Error('scanner argument contains NUL');
    }
    if (request.signal?.aborted) return abortedResult(started);

    let sandbox: SandboxInstance | undefined;
    let outcome: CommandResult = {
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      durationMs: 0,
      timedOut: false,
      outputTruncated: false,
      error: 'sandbox scanner did not produce a result',
    };
    try {
      const files = await collectInputFiles(inputDir, {
        maxInputBytes: this.options.maxInputBytes,
        maxInputFileBytes: this.options.maxInputFileBytes,
        maxInputFiles: this.options.maxInputFiles,
      });
      const sdk = await this.getSdk();
      sandbox = await sdk.Sandbox.create({
        ...(resolvedImage.image ? { image: resolvedImage.image } : {}),
        ...(resolvedImage.source ? { source: resolvedImage.source } : {}),
        resources: { vcpus: positiveLimit(request.cpus, 1, 'cpus') },
        timeout: timeoutMs + this.options.sandboxTimeoutGraceMs,
        networkPolicy: 'deny-all',
        persistent: false,
        signal: request.signal,
      });
      await sandbox.mkDir(SANDBOX_WORK_ROOT, { signal: request.signal });
      await sandbox.mkDir(INPUT_ROOT, { signal: request.signal });
      await sandbox.mkDir(OUTPUT_ROOT, { signal: request.signal });
      await writeStagedFiles(sandbox, files, this.options.writeBatchBytes, request.signal);

      const mounts = [
        ...(outputDir ? [{ hostRoot: outputDir, sandboxRoot: OUTPUT_ROOT }] : []),
        { hostRoot: inputDir, sandboxRoot: INPUT_ROOT },
      ] as const;
      const args = mapSandboxScannerArgs(request.args, mounts);
      const cwd = mapSandboxCwd(request.cwd ?? inputDir, mounts);
      const command = await sandbox.runCommand({
        cmd: request.command,
        args,
        cwd,
        env: scannerEnv(request.env, this.options.allowedEnvKeys),
        detached: true,
        signal: request.signal,
      });
      const logsState = { stdout: '', stderr: '', outputTruncated: false };
      let stopReason: StopReason | undefined;
      let stopPromiseResolve!: (reason: StopReason) => void;
      const stopPromise = new Promise<StopReason>((resolveStop) => { stopPromiseResolve = resolveStop; });
      let stopRequested = false;
      let killPromise: Promise<void> | undefined;
      const requestStop = (reason: StopReason): void => {
        if (stopRequested) return;
        stopRequested = true;
        stopReason = reason;
        stopPromiseResolve(reason);
        killPromise = Promise.resolve(command.kill('SIGTERM')).catch(() => undefined);
      };
      const logPromise = collectCommandLogs(command, logsState, maxOutputBytes, () => {
        logsState.outputTruncated = true;
        requestStop('output');
      }).catch(() => {
        // A command can stop while the SDK log stream is being drained. The
        // exit result and bounded buffers remain the source of truth.
      });
      const abort = () => requestStop('abort');
      request.signal?.addEventListener('abort', abort, { once: true });
      const timeoutTimer = setTimeout(() => requestStop('timeout'), timeoutMs);
      let finished: SandboxCommandFinished | undefined;
      let waitError: unknown;
      const waitPromise = command.wait().then((value) => {
        finished = value;
        return value;
      }).catch((error: unknown) => {
        waitError = error;
        return undefined;
      });
      try {
        const first = await Promise.race([
          waitPromise.then(() => undefined as StopReason | undefined),
          stopPromise,
        ]);
        if (first !== undefined && !finished) {
          await Promise.race([waitPromise, delay(DEFAULT_KILL_GRACE_MS)]);
          if (!finished) {
            await Promise.resolve(command.kill('SIGKILL')).catch(() => undefined);
            await Promise.race([waitPromise, delay(DEFAULT_KILL_GRACE_MS)]);
          }
        }
      } finally {
        clearTimeout(timeoutTimer);
        request.signal?.removeEventListener('abort', abort);
        // A misbehaving scanner may ignore both TERM and KILL. Do not let the
        // host function hang forever waiting for a remote command object after
        // the bounded termination window has elapsed; sandbox.stop() below is
        // the final VM-level cleanup boundary.
        if (stopReason) await Promise.race([waitPromise, delay(DEFAULT_KILL_GRACE_MS)]);
        else await waitPromise;
        if (stopReason) await Promise.race([logPromise, delay(DEFAULT_KILL_GRACE_MS)]);
        else await logPromise;
        await killPromise;
      }
      const durationMs = finished?.durationMs ?? Date.now() - started;
      outcome = {
        exitCode: finished?.exitCode ?? null,
        signal: null,
        stdout: logsState.stdout,
        stderr: logsState.stderr,
        durationMs,
        timedOut: stopReason === 'timeout' || stopReason === 'abort',
        outputTruncated: logsState.outputTruncated,
        ...(waitError ? { error: safeError(waitError) } : {}),
      };
      if (stopReason === 'abort' && !outcome.error) outcome.error = 'scan aborted';
      if (stopReason === 'timeout' && !outcome.error) outcome.error = 'scanner timed out';
      if (logsState.outputTruncated && !outcome.error) outcome.error = 'scanner output exceeded the configured limit';

      if (!outcome.timedOut && !outcome.outputTruncated && !outcome.error) {
        const output = outputDir
          ? await copyDeclaredOutputFiles(sandbox, args, outputDir, maxOutputBytes, request.signal)
          : { outputTruncated: false };
        if (output.outputTruncated) {
          outcome = {
            ...outcome,
            outputTruncated: true,
            error: 'scanner output file exceeded the configured limit',
          };
        }
      }
    } catch (error) {
      outcome = {
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        durationMs: Date.now() - started,
        timedOut: request.signal?.aborted === true,
        outputTruncated: false,
        error: safeError(error),
      };
    } finally {
      if (sandbox) {
        try {
          await sandbox.stop();
        } catch (error) {
          const cleanupError = `sandbox cleanup failed: ${safeError(error)}`;
          if (outcome?.error) outcome = { ...outcome, error: `${outcome.error}; ${cleanupError}`.slice(0, 2048) };
          else outcome = { ...outcome, error: cleanupError };
        }
      }
    }
    return outcome;
  }

  private async getSdk(): Promise<SandboxSdk> {
    if (this.options.sdk) return this.options.sdk;
    if (!this.sdkPromise) this.sdkPromise = (this.options.loadSdk ?? loadVercelSandboxSdk)();
    return this.sdkPromise;
  }
}

export const VercelSandboxExecutor = SandboxExecutor;

export async function loadVercelSandboxSdk(): Promise<SandboxSdk> {
  // Keep @vercel/sandbox out of edge bundles. The hosted worker route is the
  // only caller that should load this Node-oriented dependency.
  const dynamicImport = new Function('specifier', 'return import(specifier);') as (specifier: string) => Promise<unknown>;
  const module = await dynamicImport('@vercel/sandbox') as { Sandbox?: SandboxSdk['Sandbox']; default?: { Sandbox?: SandboxSdk['Sandbox'] } };
  const Sandbox = module.Sandbox ?? module.default?.Sandbox;
  if (!Sandbox || typeof Sandbox.create !== 'function') throw new Error('@vercel/sandbox did not expose Sandbox.create');
  return { Sandbox };
}

interface InputFile {
  relativePath: string;
  content: Buffer;
  mode: number;
}

async function collectInputFiles(
  root: string,
  limits: { maxInputBytes: number; maxInputFileBytes: number; maxInputFiles: number },
): Promise<InputFile[]> {
  const files: InputFile[] = [];
  let totalBytes = 0;
  const directories = [root];
  while (directories.length > 0) {
    const directory = directories.pop()!;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`scanner input contains a symbolic link: ${entry.name}`);
      if (entry.isDirectory()) {
        directories.push(absolute);
        continue;
      }
      if (!entry.isFile()) throw new Error(`scanner input contains a non-regular file: ${entry.name}`);
      if (files.length >= limits.maxInputFiles) throw new Error('scanner input contains too many files');
      const metadata = await lstat(absolute);
      if (metadata.size > limits.maxInputFileBytes) throw new Error(`scanner input file exceeds ${limits.maxInputFileBytes} bytes`);
      const content = await readFile(absolute);
      if (content.byteLength !== metadata.size) throw new Error(`scanner input changed while being staged: ${entry.name}`);
      totalBytes += content.byteLength;
      if (totalBytes > limits.maxInputBytes) throw new Error(`scanner input exceeds ${limits.maxInputBytes} bytes`);
      const relativePath = toPosixPath(relative(root, absolute));
      if (!safeRelativePath(relativePath)) throw new Error('scanner input contains an invalid relative path');
      files.push({ relativePath, content, mode: metadata.mode & 0o111 ? 0o755 : 0o644 });
    }
  }
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return files;
}

async function writeStagedFiles(
  sandbox: SandboxInstance,
  files: readonly InputFile[],
  batchLimit: number,
  signal?: AbortSignal,
): Promise<void> {
  const directories = new Set<string>();
  for (const file of files) {
    const relativeDirectory = dirname(file.relativePath);
    if (relativeDirectory !== '.') {
      let current = relativeDirectory;
      while (current && current !== '.') {
        directories.add(`${INPUT_ROOT}/${current}`);
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }
  }
  for (const directory of [...directories].sort((left, right) => left.length - right.length)) {
    await sandbox.mkDir(directory, { signal });
  }
  let batch: SandboxFileDescriptor[] = [];
  let batchBytes = 0;
  for (const file of files) {
    if (batch.length > 0 && batchBytes + file.content.byteLength > batchLimit) {
      await sandbox.writeFiles(batch, { signal });
      batch = [];
      batchBytes = 0;
    }
    batch.push({ path: `${INPUT_ROOT}/${file.relativePath}`, content: file.content, mode: file.mode });
    batchBytes += file.content.byteLength;
  }
  if (batch.length > 0) await sandbox.writeFiles(batch, { signal });
}

type Mount = { hostRoot: string; sandboxRoot: string };

export function mapSandboxScannerArgs(args: readonly string[], mounts: readonly Mount[]): string[] {
  const ordered = [...mounts].map((mount) => ({ hostRoot: resolve(mount.hostRoot), sandboxRoot: mount.sandboxRoot }))
    .sort((left, right) => right.hostRoot.length - left.hostRoot.length);
  return args.map((argument) => {
    const direct = mapMountedPath(argument, ordered);
    if (direct !== undefined) return direct;
    const equals = argument.indexOf('=');
    if (equals > 0) {
      const mapped = mapMountedPath(argument.slice(equals + 1), ordered);
      if (mapped !== undefined) return `${argument.slice(0, equals + 1)}${mapped}`;
    }
    return argument;
  });
}

function mapSandboxCwd(cwd: string, mounts: readonly Mount[]): string {
  if (!isAbsolute(cwd)) {
    if (!cwd || cwd === '.') return INPUT_ROOT;
    if (!safeRelativePath(toPosixPath(cwd))) throw new Error('sandbox scanner cwd escapes its workspace');
    return cwd ? `${INPUT_ROOT}/${toPosixPath(cwd)}` : INPUT_ROOT;
  }
  const mapped = mapMountedPath(cwd, mounts.map((mount) => ({ hostRoot: resolve(mount.hostRoot), sandboxRoot: mount.sandboxRoot })));
  if (!mapped) throw new Error('sandbox scanner cwd must be inside the input or output workspace');
  return mapped;
}

function mapMountedPath(value: string, mounts: readonly Mount[]): string | undefined {
  if (!isAbsolute(value)) return undefined;
  const candidate = resolve(value);
  for (const mount of mounts) {
    const child = relative(mount.hostRoot, candidate);
    if (child === '') return mount.sandboxRoot;
    if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) continue;
    return `${mount.sandboxRoot}/${toPosixPath(child)}`;
  }
  return undefined;
}

function extractOutputPaths(args: readonly string[]): string[] {
  const paths = new Set<string>();
  for (const argument of args) {
    const value = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : argument;
    if (value === OUTPUT_ROOT || value.startsWith(`${OUTPUT_ROOT}/`)) {
      const relativePath = value.slice(`${OUTPUT_ROOT}/`.length);
      if (safeRelativePath(relativePath)) paths.add(value);
    }
  }
  return [...paths];
}

async function copyDeclaredOutputFiles(
  sandbox: SandboxInstance,
  mappedArgs: readonly string[],
  hostOutputDir: string,
  maxOutputBytes: number,
  signal?: AbortSignal,
): Promise<{ outputTruncated: boolean }> {
  let copiedBytes = 0;
  for (const sandboxPath of extractOutputPaths(mappedArgs)) {
    const metadata = await sandboxFileStats(sandbox, sandboxPath, signal);
    if (!metadata) continue;
    if (metadata.isSymbolicLink?.() === true) throw new Error('scanner output may not be a symbolic link');
    if (!metadata.isFile()) throw new Error('scanner output is not a regular file');
    if (metadata.size > maxOutputBytes - copiedBytes) return { outputTruncated: true };
    const content = await readSandboxFile(sandbox, sandboxPath, signal);
    if (!content) continue;
    copiedBytes += content.byteLength;
    if (copiedBytes > maxOutputBytes) return { outputTruncated: true };
    const relativePath = sandboxPath.slice(`${OUTPUT_ROOT}/`.length);
    if (!safeRelativePath(relativePath)) throw new Error('scanner output path escapes its workspace');
    const hostPath = resolve(hostOutputDir, relativePath);
    if (relative(hostOutputDir, hostPath).startsWith('..')) throw new Error('scanner output path escapes its workspace');
    await mkdir(dirname(hostPath), { recursive: true, mode: 0o700 });
    await writeFile(hostPath, content, { mode: 0o600 });
  }
  return { outputTruncated: false };
}

async function sandboxFileStats(sandbox: SandboxInstance, path: string, signal?: AbortSignal): Promise<SandboxStats | undefined> {
  try {
    if (sandbox.fs.lstat) return await sandbox.fs.lstat(path, { signal });
    return await sandbox.fs.stat(path, { signal });
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function readSandboxFile(sandbox: SandboxInstance, path: string, signal?: AbortSignal): Promise<Buffer | undefined> {
  if (sandbox.readFileToBuffer) {
    return (await sandbox.readFileToBuffer({ path }, { signal })) ?? undefined;
  }
  if (!sandbox.fs.readFile) throw new Error('sandbox SDK does not support reading scanner output files');
  const value = await sandbox.fs.readFile(path, { signal });
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

async function collectCommandLogs(
  command: SandboxCommand,
  state: { stdout: string; stderr: string; outputTruncated: boolean },
  maxOutputBytes: number,
  onLimit: () => void,
): Promise<void> {
  if (!command.logs) throw new Error('sandbox SDK command does not support bounded log streaming');
  for await (const log of command.logs()) {
    if (log.stream !== 'stdout' && log.stream !== 'stderr') continue;
    const current = state[log.stream];
    const bytes = Buffer.byteLength(log.data, 'utf8');
    const remaining = Math.max(0, maxOutputBytes - Buffer.byteLength(current, 'utf8'));
    if (bytes > remaining) {
      state[log.stream] = current + truncateUtf8(log.data, remaining);
      state.outputTruncated = true;
      onLimit();
    } else {
      state[log.stream] = current + log.data;
    }
  }
}

const RESERVED_SANDBOX_ENV_KEYS = new Set([
  'HOME',
  'PATH',
  'PWD',
  'SHELL',
  'TMPDIR',
  'NODE_PATH',
  'NODE_OPTIONS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'LANG',
  'LC_ALL',
]);

function scannerEnv(extra: Record<string, string | undefined> | undefined, allowedKeys: ReadonlySet<string>): Record<string, string> {
  const env: Record<string, string> = {
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
  };
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value === undefined) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`scanner environment key is invalid: ${key}`);
    if (RESERVED_SANDBOX_ENV_KEYS.has(key)) throw new Error(`scanner environment key cannot override sandbox runtime: ${key}`);
    if (/(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|AUTH|CREDENTIAL|COOKIE|SESSION)/i.test(key)) {
      throw new Error(`scanner environment key may contain credentials: ${key}`);
    }
    if (!allowedKeys.has(key)) throw new Error(`scanner environment key is not in the non-secret allowlist: ${key}`);
    if (/[\u0000\r\n]/.test(value)) throw new Error(`scanner environment value is invalid: ${key}`);
    env[key] = value;
  }
  return env;
}

function safeExecutable(command: string): void {
  if (!command || command.includes('\u0000') || /[\r\n]/.test(command)) throw new Error('scanner command is empty or invalid');
}

function requireDirectoryPath(path: string | undefined, label: string): string {
  if (!path || !isAbsolute(path) || /[\u0000\r\n]/.test(path)) throw new Error(`sandbox scanner ${label} must be an absolute path`);
  return resolve(path);
}

function safeRelativePath(path: string): boolean {
  const normalized = toPosixPath(path);
  return normalized.length > 0 && normalized !== '.' && normalized !== '..' && !normalized.startsWith('../') && !normalized.startsWith('/') && !normalized.includes('\u0000');
}

function toPosixPath(path: string): string {
  return path.split(sep).join('/');
}

function positiveLimit(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive finite number`);
  return Math.floor(value);
}

function truncateUtf8(value: string, bytes: number): string {
  if (bytes <= 0) return '';
  const buffer = Buffer.from(value, 'utf8');
  return buffer.subarray(0, bytes).toString('utf8');
}

function safeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 2048);
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}

function abortedResult(started: number): CommandResult {
  return {
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    durationMs: Date.now() - started,
    timedOut: true,
    outputTruncated: false,
    error: 'scan aborted',
  };
}

type StopReason = 'timeout' | 'abort' | 'output';

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
