/**
 * A narrow, security-oriented adapter around ComputeSDK's Vercel provider.
 *
 * The generic ComputeSDK contract is intentionally not exposed here. Its
 * command and filesystem methods are string based and the Vercel provider
 * implements those methods through `sh -c` and unbounded string buffering.
 * Scanner callers receive the native Vercel sandbox operations only after the
 * requested capability and provenance checks have passed.
 */

export const COMPUTE_SDK_VERSIONS = Object.freeze({
  computesdk: '4.1.4',
  provider: '2.1.5',
  vercel: '1.7.33',
  nativeVercel: '3.2.2',
} as const);

export type SandboxProviderId = 'vercel';

export type VersionEvidence = Partial<Record<keyof typeof COMPUTE_SDK_VERSIONS, string>>;

export interface VercelAuth {
  /** A Vercel token. Must be supplied together with teamId and projectId. */
  token: string;
  teamId: string;
  projectId: string;
}

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
  readonly capabilities?: SandboxCapabilities;
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

/** Structural SDK shape consumed by `SandboxExecutor.loadSdk`. */
export interface SandboxSdk {
  Sandbox: {
    create(options: SandboxCreateOptions): Promise<SandboxInstance>;
  };
}

export type SandboxSdkLoader = () => Promise<SandboxSdk>;

export interface SandboxCapabilities {
  provider: SandboxProviderId;
  /** Package versions supplied by the loader or caller. */
  versions: VersionEvidence;
  versionStatus: 'verified' | 'unknown' | 'mismatch';
  versionMismatches: string[];
  networkPolicy: 'deny-all';
  persistent: false;
  source: 'snapshot' | 'image';
  argv: true;
  commandTimeout: true;
  boundedLogs: true;
  binaryFiles: true;
  fileModes: true;
  cleanup: 'native-stop-errors-fatal';
}

export interface ComputeSdkProviderSandbox {
  getInstance(): unknown;
  /** The generic destroy method is deliberately not used by this adapter. */
  destroy(): Promise<void>;
  readonly sandboxId?: string;
}

export interface ComputeSdkVercelProvider {
  readonly name?: string;
  readonly sandbox: {
    create(options?: Record<string, unknown>): Promise<ComputeSdkProviderSandbox>;
  };
}

export interface ComputeSdkVercelModule {
  vercel?: (config: Record<string, unknown>) => ComputeSdkVercelProvider;
  default?: { vercel?: (config: Record<string, unknown>) => ComputeSdkVercelProvider };
  versions?: VersionEvidence;
}

export type ComputeSdkVercelModuleLoader = () => Promise<ComputeSdkVercelModule>;
export type ComputeSdkVercelProviderFactory = (config: Record<string, unknown>) => ComputeSdkVercelProvider;

export interface SandboxProviderOptions {
  /** Provider selection is intentionally per client; there is no global registry. */
  provider?: string;
  auth?: VercelAuth;
  /** Permit the ComputeSDK Vercel adapter to resolve its documented environment credentials. */
  allowEnvironmentAuth?: boolean;
  moduleLoader?: ComputeSdkVercelModuleLoader;
  /** Injection seam for tests and for a host that bundles the exact provider itself. */
  providerFactory?: ComputeSdkVercelProviderFactory;
  /** Version evidence is recorded and mismatches are rejected before create. */
  versionEvidence?: VersionEvidence;
}

export interface SandboxProviderHandle {
  readonly id: SandboxProviderId;
  readonly capabilities: Readonly<{
    provider: SandboxProviderId;
    supported: true;
    versions: VersionEvidence;
    versionStatus: 'verified' | 'unknown' | 'mismatch';
    versionMismatches: readonly string[];
    networkPolicy: 'deny-all';
    persistent: false;
    argv: true;
    commandTimeout: true;
    boundedLogs: true;
    binaryFiles: true;
    fileModes: true;
    cleanup: 'native-stop-errors-fatal';
  }>;
  loadSdk(): Promise<SandboxSdk>;
}

export class SandboxProviderError extends Error {
  readonly code:
    | 'unsupported-provider'
    | 'missing-dependency'
    | 'invalid-auth'
    | 'version-mismatch'
    | 'unsupported-capability'
    | 'invalid-create-options'
    | 'cleanup-failed';

  constructor(code: SandboxProviderError['code'], message: string) {
    super(message);
    this.name = 'SandboxProviderError';
    this.code = code;
  }
}

interface NativeSandbox {
  readonly fs?: SandboxFileSystem;
  readonly persistent?: unknown;
  readonly networkPolicy?: unknown;
  readonly image?: unknown;
  readonly sourceSnapshotId?: unknown;
  readonly timeout?: unknown;
  readonly vcpus?: unknown;
  runCommand?: (options: Record<string, unknown>) => Promise<unknown>;
  mkDir?: (path: string, options?: { signal?: AbortSignal }) => Promise<void>;
  writeFiles?: (files: Array<{ path: string; content: Uint8Array; mode?: number }>, options?: { signal?: AbortSignal }) => Promise<void>;
  readFileToBuffer?: (file: { path: string; cwd?: string }, options?: { signal?: AbortSignal }) => Promise<Buffer | null>;
  stop?: (options?: { signal?: AbortSignal }) => Promise<unknown>;
}

interface NativeCommand {
  wait?: (options?: { signal?: AbortSignal }) => Promise<unknown>;
  logs?: (options?: { signal?: AbortSignal }) => AsyncIterable<unknown>;
  kill?: (signal?: 'SIGTERM' | 'SIGKILL', options?: { abortSignal?: AbortSignal }) => Promise<void>;
}

const IMMUTABLE_IMAGE = /^[-A-Za-z0-9._/:]+@sha256:[0-9a-f]{64}$/;
const SNAPSHOT_ID = /^[A-Za-z0-9._:-]{1,256}$/;

/**
 * Build a provider handle without mutating ComputeSDK's singleton. Unsupported
 * provider names fail synchronously, before a client can stage tenant bytes.
 */
export function createSandboxProvider(options: SandboxProviderOptions = {}): SandboxProviderHandle {
  const id = options.provider ?? configuredProviderName();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(id) || id !== 'vercel') {
    throw new SandboxProviderError(
      'unsupported-provider',
      'sandbox provider is unsupported; only the verified Vercel native adapter is enabled',
    );
  }
  return createVercelHandle(options);
}

export function createSandboxProviderLoader(options: SandboxProviderOptions = {}): SandboxSdkLoader {
  const handle = createSandboxProvider(options);
  return () => handle.loadSdk();
}

/** Loader entry point for the current scanner's `loadSdk` option. */
export async function loadConfiguredSandboxSdk(options: SandboxProviderOptions = {}): Promise<SandboxSdk> {
  return createSandboxProvider(options).loadSdk();
}

/**
 * Load a Vercel-compatible SDK directly. The returned SDK is still backed by
 * one provider instance and never falls back to another provider.
 */
export async function createComputeSdkVercelSdk(options: SandboxProviderOptions = {}): Promise<SandboxSdk> {
  const handle = createVercelHandle(options);
  return handle.loadSdk();
}

function createVercelHandle(options: SandboxProviderOptions): SandboxProviderHandle {
  const versionEvidence = { ...(options.versionEvidence ?? {}) };
  const capability = {
    provider: 'vercel' as const,
    supported: true as const,
    versions: versionEvidence,
    versionStatus: versionStatus(versionEvidence),
    versionMismatches: versionMismatches(versionEvidence),
    networkPolicy: 'deny-all' as const,
    persistent: false as const,
    argv: true as const,
    commandTimeout: true as const,
    boundedLogs: true as const,
    binaryFiles: true as const,
    fileModes: true as const,
    cleanup: 'native-stop-errors-fatal' as const,
  };
  let sdkPromise: Promise<SandboxSdk> | undefined;
  return {
    id: 'vercel',
    capabilities: capability,
    loadSdk: () => {
      sdkPromise ??= loadVercelSdk(options, capability);
      return sdkPromise;
    },
  };
}

async function loadVercelSdk(
  options: SandboxProviderOptions,
  initialCapabilities: SandboxProviderHandle['capabilities'],
): Promise<SandboxSdk> {
  const module = options.moduleLoader
    ? await options.moduleLoader()
    : await loadComputeSdkVercelModule();
  const evidence = { ...initialCapabilities.versions, ...(module.versions ?? {}) };
  const mismatches = versionMismatches(evidence);
  Object.assign(initialCapabilities, {
    versions: evidence,
    versionStatus: mismatches.length > 0 ? 'mismatch' : hasAllVersionEvidence(evidence) ? 'verified' : 'unknown',
    versionMismatches: mismatches,
  });
  if (mismatches.length > 0) {
    throw new SandboxProviderError(
      'version-mismatch',
      `sandbox provider package version mismatch: ${mismatches.join('; ')}`,
    );
  }

  const providerFactory = options.providerFactory ?? module.vercel ?? module.default?.vercel;
  if (typeof providerFactory !== 'function') {
    throw new SandboxProviderError('missing-dependency', '@computesdk/vercel did not expose vercel(config)');
  }
  const config = vercelProviderConfig(options);
  const provider = providerFactory(config);
  if (!provider || typeof provider.sandbox?.create !== 'function') {
    throw new SandboxProviderError('missing-dependency', '@computesdk/vercel returned an invalid provider');
  }
  if (provider.name !== undefined && provider.name !== 'vercel') {
    throw new SandboxProviderError('unsupported-provider', `provider factory returned unsupported provider ${provider.name}`);
  }

  return {
    Sandbox: {
      create: async (requested) => {
        const createOptions = normalizedCreateOptions(requested);
        const generated = await provider.sandbox.create(createOptions as unknown as Record<string, unknown>);
        let native: unknown;
        try {
          if (!generated || typeof generated.getInstance !== 'function') {
            throw new SandboxProviderError('unsupported-capability', 'ComputeSDK create returned no native getInstance handle');
          }
          native = generated.getInstance();
          const capabilities = makeCapabilities(evidence, mismatches, createOptions, native);
          assertNativeSandbox(native, createOptions);
          return wrapNativeSandbox(native, capabilities);
        } catch (error) {
          await cleanupRejectedNativeSandbox(generated, native, error);
          throw error;
        }
      },
    },
  };
}

async function loadComputeSdkVercelModule(): Promise<ComputeSdkVercelModule> {
  // Keep provider packages out of edge bundles. This loader is only used by a
  // host that explicitly selected the Node/provider runtime.
  const dynamicImport = new Function('specifier', 'options', 'return import(specifier, options);') as (specifier: string, options?: { with?: { type: string } }) => Promise<unknown>;
  try {
    const module = await dynamicImport('@computesdk/vercel') as ComputeSdkVercelModule;
    const nativeVersion = await loadNativeVercelVersion(dynamicImport);
    return nativeVersion
      ? { ...module, versions: { ...module.versions, nativeVercel: nativeVersion } }
      : module;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new SandboxProviderError('missing-dependency', `unable to load @computesdk/vercel: ${detail}`);
  }
}

async function loadNativeVercelVersion(
  dynamicImport: (specifier: string, options?: { with?: { type: string } }) => Promise<unknown>,
): Promise<string | undefined> {
  try {
    const packageModule = await dynamicImport('@vercel/sandbox/package.json', { with: { type: 'json' } }) as { default?: { version?: unknown } };
    return typeof packageModule.default?.version === 'string' ? packageModule.default.version : undefined;
  } catch {
    // Package metadata is optional evidence. Native capability attestation is
    // still required, and the capability record will remain versionStatus=unknown
    // until the host supplies the other pinned package versions.
    return undefined;
  }
}

function configuredProviderName(): string {
  if (typeof process !== 'undefined' && process.env?.PSKILLS_SANDBOX_PROVIDER) {
    return process.env.PSKILLS_SANDBOX_PROVIDER;
  }
  return 'vercel';
}

function vercelProviderConfig(options: SandboxProviderOptions): Record<string, unknown> {
  if (options.auth) {
    validateAuth(options.auth);
    // ComputeSDK's Vercel adapter otherwise adds its daemon SSE port (38989)
    // to every sandbox. Scanner sandboxes never use that bridge; keep the
    // native network surface explicit and empty.
    return { ...options.auth, ports: [], daemonSsePort: false };
  }
  if (options.allowEnvironmentAuth === false) {
    throw new SandboxProviderError(
      'invalid-auth',
      'Vercel sandbox auth requires explicit token/teamId/projectId when environment auth is disabled',
    );
  }
  // @computesdk/vercel resolves VERCEL_OIDC_TOKEN or the traditional Vercel
  // variables inside its provider instance. No credential value is copied into
  // logs or into tenant-facing sandbox options.
  return { ports: [], daemonSsePort: false };
}

function validateAuth(auth: VercelAuth): void {
  for (const key of Object.keys(auth)) {
    if (key !== 'token' && key !== 'teamId' && key !== 'projectId') {
      throw new SandboxProviderError('invalid-auth', `Vercel auth field ${key} is unsupported`);
    }
  }
  for (const [name, value] of Object.entries(auth)) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new SandboxProviderError('invalid-auth', `Vercel auth field ${name} is invalid`);
    }
  }
}

function normalizedCreateOptions(options: SandboxCreateOptions): SandboxCreateOptions {
  if (!options || typeof options !== 'object') {
    throw new SandboxProviderError('invalid-create-options', 'sandbox create options are required');
  }
  rejectUnknownKeys(options as unknown as Record<string, unknown>, new Set(['image', 'source', 'resources', 'timeout', 'networkPolicy', 'persistent', 'signal']), 'sandbox create');
  if (options.source) {
    rejectUnknownKeys(options.source as unknown as Record<string, unknown>, new Set(['type', 'snapshotId']), 'sandbox source');
  }
  if (options.resources) {
    rejectUnknownKeys(options.resources as unknown as Record<string, unknown>, new Set(['vcpus']), 'sandbox resources');
  }
  if ((options.image && options.source) || (!options.image && !options.source)) {
    throw new SandboxProviderError('invalid-create-options', 'sandbox create requires exactly one immutable image or snapshot source');
  }
  if (options.image && !IMMUTABLE_IMAGE.test(options.image)) {
    throw new SandboxProviderError('invalid-create-options', 'sandbox image must be an immutable @sha256 reference');
  }
  if (options.source && (options.source.type !== 'snapshot' || !SNAPSHOT_ID.test(options.source.snapshotId))) {
    throw new SandboxProviderError('invalid-create-options', 'sandbox snapshot source is invalid');
  }
  if (!Number.isFinite(options.timeout) || options.timeout <= 0) {
    throw new SandboxProviderError('invalid-create-options', 'sandbox timeout must be positive and finite');
  }
  if (!Number.isInteger(options.resources?.vcpus) || options.resources.vcpus <= 0) {
    throw new SandboxProviderError('invalid-create-options', 'sandbox resources.vcpus must be a positive integer');
  }
  if (options.networkPolicy !== 'deny-all') {
    throw new SandboxProviderError('unsupported-capability', 'sandbox provider must receive networkPolicy=deny-all');
  }
  if (options.persistent !== false) {
    throw new SandboxProviderError('unsupported-capability', 'scanner sandboxes must set persistent=false');
  }
  const timeout = Math.floor(options.timeout);
  if (timeout < 1) {
    throw new SandboxProviderError('invalid-create-options', 'sandbox timeout must be at least one millisecond');
  }
  return {
    ...(options.image ? { image: options.image } : {}),
    ...(options.source ? { source: { type: 'snapshot', snapshotId: options.source.snapshotId } } : {}),
    resources: { vcpus: options.resources.vcpus },
    timeout,
    networkPolicy: 'deny-all',
    persistent: false,
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new SandboxProviderError('invalid-create-options', `${label} option ${key} is unsupported`);
    }
  }
}

function makeCapabilities(
  versions: VersionEvidence,
  mismatches: string[],
  options: SandboxCreateOptions,
  native: unknown,
): SandboxCapabilities {
  const candidate = asNativeSandbox(native);
  const status = mismatches.length > 0 ? 'mismatch' : hasAllVersionEvidence(versions) ? 'verified' : 'unknown';
  return {
    provider: 'vercel',
    versions,
    versionStatus: status,
    versionMismatches: mismatches,
    networkPolicy: 'deny-all',
    persistent: false,
    source: options.source ? 'snapshot' : 'image',
    argv: true,
    commandTimeout: true,
    boundedLogs: true,
    binaryFiles: true,
    fileModes: true,
    cleanup: 'native-stop-errors-fatal',
  };
}

function assertNativeSandbox(native: unknown, options: SandboxCreateOptions): asserts native is NativeSandbox {
  const candidate = asNativeSandbox(native);
  const unsupported: string[] = [];
  if (!candidate) unsupported.push('getInstance() did not return a native sandbox');
  if (typeof candidate?.runCommand !== 'function') unsupported.push('native argv runCommand');
  if (typeof candidate?.mkDir !== 'function') unsupported.push('native mkDir');
  if (typeof candidate?.writeFiles !== 'function') unsupported.push('native byte writeFiles');
  if (typeof candidate?.readFileToBuffer !== 'function') unsupported.push('native byte readFileToBuffer');
  if (typeof candidate?.stop !== 'function') unsupported.push('native stop');
  if (!candidate?.fs || typeof candidate.fs.stat !== 'function' || typeof candidate.fs.readFile !== 'function') {
    unsupported.push('native filesystem stats/read');
  }
  if (candidate?.persistent !== false) unsupported.push('persistent=false attestation');
  if (candidate?.networkPolicy !== 'deny-all') unsupported.push('networkPolicy=deny-all attestation');
  if (options.image && candidate?.image !== options.image) unsupported.push('immutable image attestation');
  if (options.source && candidate?.sourceSnapshotId !== options.source.snapshotId) unsupported.push('snapshot source attestation');
  if (typeof candidate?.timeout !== 'number' || candidate.timeout < options.timeout) unsupported.push('sandbox timeout attestation');
  if (typeof candidate?.vcpus !== 'number' || candidate.vcpus !== options.resources.vcpus) unsupported.push('vCPU attestation');
  if (unsupported.length > 0) {
    throw new SandboxProviderError(
      'unsupported-capability',
      `Vercel native sandbox did not attest required scanner capabilities: ${unsupported.join(', ')}`,
    );
  }
}

async function cleanupRejectedNativeSandbox(
  generated: ComputeSdkProviderSandbox,
  native: unknown,
  validationError: unknown,
): Promise<void> {
  const candidate = asNativeSandbox(native);
  if (typeof candidate?.stop === 'function') {
    try {
      await candidate.stop();
      return;
    } catch (cleanupError) {
      const validation = safeErrorMessage(validationError);
      const cleanup = safeErrorMessage(cleanupError);
      throw new SandboxProviderError(
        'cleanup-failed',
        `sandbox capability validation failed (${validation}); native cleanup failed (${cleanup})`,
      );
    }
  }

  // A failing getInstance() leaves no native handle from which stop() can be
  // called. The generated provider destroy is only a last-resort orphan
  // cleanup attempt: the upstream Vercel implementation intentionally swallows
  // its errors, so even a resolved call cannot be treated as verified cleanup.
  const validation = safeErrorMessage(validationError);
  if (typeof generated.destroy !== 'function') {
    throw new SandboxProviderError(
      'cleanup-failed',
      `sandbox capability validation failed (${validation}); no native handle or cleanup method was available`,
    );
  }
  try {
    await generated.destroy();
  } catch (cleanupError) {
    throw new SandboxProviderError(
      'cleanup-failed',
      `sandbox capability validation failed (${validation}); best-effort generic cleanup failed (${safeErrorMessage(cleanupError)})`,
    );
  }
  throw new SandboxProviderError(
    'cleanup-failed',
    `sandbox capability validation failed (${validation}); best-effort generic cleanup completed but cleanup is unverified`,
  );
}

function asNativeSandbox(value: unknown): NativeSandbox | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return value as NativeSandbox;
}

function wrapNativeSandbox(native: NativeSandbox, capabilities: SandboxCapabilities): SandboxInstance {
  const runCommand = native.runCommand!.bind(native);
  const mkDir = native.mkDir!.bind(native);
  const writeFiles = native.writeFiles!.bind(native);
  const readFileToBuffer = native.readFileToBuffer!.bind(native);
  const stop = native.stop!.bind(native);
  const fs = native.fs!;
  return {
    capabilities,
    fs,
    mkDir: (path, options) => mkDir(path, options),
    writeFiles: (files, options) => writeFiles(files.map((file) => ({ ...file, content: file.content })), options),
    readFileToBuffer: (file, options) => readFileToBuffer(file, options),
    runCommand: async (options) => {
      const command = await runCommand({
        cmd: options.cmd,
        args: options.args,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.env ? { env: options.env } : {}),
        detached: true,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      return wrapNativeCommand(command);
    },
    stop: (options) => stop(options),
  };
}

function wrapNativeCommand(value: unknown): SandboxCommand {
  if (!value || typeof value !== 'object') {
    throw new SandboxProviderError('unsupported-capability', 'native runCommand did not return a command handle');
  }
  const command = value as NativeCommand;
  if (typeof command.wait !== 'function' || typeof command.logs !== 'function' || typeof command.kill !== 'function') {
    throw new SandboxProviderError('unsupported-capability', 'native command lacks wait/logs/kill controls');
  }
  return {
    wait: async (options) => normalizeCommandFinished(await command.wait!(options)),
    logs: (options) => normalizeLogs(command.logs!(options)),
    kill: (signal, options) => command.kill!(signal, options),
  };
}

async function* normalizeLogs(source: AsyncIterable<unknown>): AsyncIterable<SandboxLogEntry> {
  for await (const value of source) {
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    if ((record.stream === 'stdout' || record.stream === 'stderr') && typeof record.data === 'string') {
      yield { stream: record.stream, data: record.data };
    }
  }
}

function normalizeCommandFinished(value: unknown): SandboxCommandFinished {
  if (!value || typeof value !== 'object') throw new SandboxProviderError('unsupported-capability', 'native command returned invalid completion');
  const record = value as Record<string, unknown>;
  if (typeof record.exitCode !== 'number' && record.exitCode !== null) {
    throw new SandboxProviderError('unsupported-capability', 'native command completion lacks exitCode');
  }
  return {
    exitCode: record.exitCode as number | null,
    ...(typeof record.durationMs === 'number' ? { durationMs: record.durationMs } : {}),
  };
}

function safeErrorMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 512);
}

function hasAllVersionEvidence(evidence: VersionEvidence): boolean {
  return (Object.keys(COMPUTE_SDK_VERSIONS) as Array<keyof typeof COMPUTE_SDK_VERSIONS>)
    .every((key) => typeof evidence[key] === 'string');
}

function versionStatus(evidence: VersionEvidence): 'verified' | 'unknown' | 'mismatch' {
  const mismatches = versionMismatches(evidence);
  return mismatches.length > 0 ? 'mismatch' : hasAllVersionEvidence(evidence) ? 'verified' : 'unknown';
}

function versionMismatches(evidence: VersionEvidence): string[] {
  return (Object.keys(COMPUTE_SDK_VERSIONS) as Array<keyof typeof COMPUTE_SDK_VERSIONS>)
    .filter((key) => evidence[key] !== undefined && evidence[key] !== COMPUTE_SDK_VERSIONS[key])
    .map((key) => `${key} expected ${COMPUTE_SDK_VERSIONS[key]} but received ${evidence[key]}`);
}
