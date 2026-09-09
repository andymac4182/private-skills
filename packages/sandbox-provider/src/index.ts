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
  /**
   * A Vercel token. Must be supplied together with teamId and projectId.
   * Callers using a traditional PAT must provide all three fields explicitly;
   * ambient process PAT variables are never used as a request fallback.
   */
  token: string;
  teamId: string;
  projectId: string;
}

/**
 * Resolves one request-scoped Vercel OIDC token. Implementations must return
 * the raw token from the current request context and must not cache it.
 */
export type VercelOidcTokenResolver = () => Promise<string>;

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
  /** Test/host injection seam; production uses the official @vercel/oidc helper. */
  oidcTokenResolver?: VercelOidcTokenResolver;
}

export type ComputeSdkVercelModuleLoader = () => Promise<ComputeSdkVercelModule>;
export type ComputeSdkVercelProviderFactory = (config: Record<string, unknown>) => ComputeSdkVercelProvider;

export interface SandboxProviderOptions {
  /** Provider selection is intentionally per client; there is no global registry. */
  provider?: string;
  auth?: VercelAuth;
  /** Permit request-scoped official Vercel OIDC resolution from the current context. */
  allowEnvironmentAuth?: boolean;
  moduleLoader?: ComputeSdkVercelModuleLoader;
  /** Injection seam for tests and for a host that bundles the exact provider itself. */
  providerFactory?: ComputeSdkVercelProviderFactory;
  /** Request-scoped OIDC injection seam; the token is resolved for each create. */
  oidcTokenResolver?: VercelOidcTokenResolver;
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

const PROVIDER_MODULE_LOAD_ERROR = 'sandbox provider module could not be loaded';
const PROVIDER_FACTORY_ERROR = 'Vercel sandbox provider could not be initialized';
const PROVIDER_CREATE_ERROR = 'Vercel sandbox could not be created';

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

class SandboxProviderNotFoundError extends Error {
  readonly code = 'ENOENT' as const;

  constructor() {
    super('Vercel native filesystem entry was not found');
    this.name = 'SandboxProviderNotFoundError';
  }
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
  const module = await loadProviderModule(options);
  let evidence: VersionEvidence;
  try {
    evidence = { ...initialCapabilities.versions, ...(module.versions ?? {}) };
  } catch {
    throw new SandboxProviderError('missing-dependency', PROVIDER_MODULE_LOAD_ERROR);
  }
  const mismatches = versionMismatches(evidence);
  Object.assign(initialCapabilities, {
    versions: evidence,
    versionStatus: mismatches.length > 0 ? 'mismatch' : hasAllVersionEvidence(evidence) ? 'verified' : 'unknown',
    versionMismatches: mismatches,
  });
  if (mismatches.length > 0) {
    throw new SandboxProviderError(
      'version-mismatch',
      'sandbox provider package version mismatch: ' + mismatches.join('; '),
    );
  }

  let providerFactory: ComputeSdkVercelProviderFactory | undefined;
  try {
    providerFactory = options.providerFactory ?? module.vercel ?? module.default?.vercel;
  } catch {
    throw new SandboxProviderError('missing-dependency', PROVIDER_FACTORY_ERROR);
  }
  if (typeof providerFactory !== 'function') {
    throw new SandboxProviderError('missing-dependency', '@computesdk/vercel did not expose vercel(config)');
  }

  // Validate the opt-out during SDK loading, while deferring ambient
  // credential resolution until each Sandbox.create call.
  const baseConfig = vercelProviderConfig(options);
  let fixedProvider: ComputeSdkVercelProvider | undefined;
  if (options.auth) {
    fixedProvider = createVercelProvider(providerFactory, baseConfig);
  }

  let oidcResolverPromise: Promise<VercelOidcTokenResolver> | undefined;
  const loadOidcResolver = (): Promise<VercelOidcTokenResolver> => {
    try {
      if (options.oidcTokenResolver) return Promise.resolve(options.oidcTokenResolver);
      if (module.oidcTokenResolver) return Promise.resolve(module.oidcTokenResolver);
      oidcResolverPromise ??= loadOfficialVercelOidcTokenResolver();
      return oidcResolverPromise;
    } catch {
      return Promise.reject(new SandboxProviderError('missing-dependency', PROVIDER_MODULE_LOAD_ERROR));
    }
  };

  return {
    Sandbox: {
      create: async (requested) => {
        const createOptions = normalizedCreateOptions(requested);
        const provider = fixedProvider ?? createVercelProvider(
          providerFactory,
          vercelProviderConfig(
            options,
            await resolveAmbientVercelAuth(options, await loadOidcResolver()),
          ),
        );
        let generated: ComputeSdkProviderSandbox | undefined;
        try {
          generated = await provider.sandbox.create(createOptions as unknown as Record<string, unknown>);
        } catch {
          throw new SandboxProviderError('missing-dependency', PROVIDER_CREATE_ERROR);
        }
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
          const validationFailure = error instanceof SandboxProviderError
            ? error
            : new SandboxProviderError('unsupported-capability', 'Vercel native sandbox capability validation failed');
          await cleanupRejectedNativeSandbox(generated, native);
          throw validationFailure;
        }
      },
    },
  };
}

async function loadProviderModule(options: SandboxProviderOptions): Promise<ComputeSdkVercelModule> {
  try {
    return options.moduleLoader
      ? await options.moduleLoader()
      : await loadComputeSdkVercelModule();
  } catch {
    throw new SandboxProviderError('missing-dependency', PROVIDER_MODULE_LOAD_ERROR);
  }
}

function createVercelProvider(
  providerFactory: ComputeSdkVercelProviderFactory,
  config: Record<string, unknown>,
): ComputeSdkVercelProvider {
  let value: unknown;
  try {
    value = providerFactory(config);
  } catch {
    throw new SandboxProviderError('missing-dependency', PROVIDER_FACTORY_ERROR);
  }
  try {
    return assertProvider(value);
  } catch (error) {
    if (error instanceof SandboxProviderError) throw error;
    throw new SandboxProviderError('missing-dependency', PROVIDER_FACTORY_ERROR);
  }
}

async function loadComputeSdkVercelModule(): Promise<ComputeSdkVercelModule> {
  // Keep provider packages out of edge bundles. This loader is only used by a
  // host that explicitly selected the Node/provider runtime.
  let dynamicImport: DynamicModuleImport;
  try {
    dynamicImport = new Function(
      'specifier',
      'options',
      'return import(specifier, options);',
    ) as DynamicModuleImport;
    const module = await dynamicImport('@computesdk/vercel') as ComputeSdkVercelModule;
    const nativeVersion = await loadNativeVercelVersion(dynamicImport);
    return nativeVersion
      ? { ...module, versions: { ...module.versions, nativeVercel: nativeVersion } }
      : module;
  } catch {
    throw new SandboxProviderError('missing-dependency', PROVIDER_MODULE_LOAD_ERROR);
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

type DynamicModuleImport = (
  specifier: string,
  options?: { with?: { type: string } },
) => Promise<unknown>;

async function loadOfficialVercelOidcTokenResolver(): Promise<VercelOidcTokenResolver> {
  let dynamicImport: DynamicModuleImport;
  let loaded: unknown;
  try {
    dynamicImport = new Function(
      'specifier',
      'options',
      'return import(specifier, options);',
    ) as DynamicModuleImport;
    loaded = await dynamicImport('@vercel/oidc');
  } catch {
    throw new SandboxProviderError(
      'missing-dependency',
      'the pinned @vercel/oidc helper could not be loaded',
    );
  }
  let helper: unknown;
  try {
    const module = loaded as {
      getVercelOidcToken?: unknown;
      default?: { getVercelOidcToken?: unknown };
    };
    helper = module.getVercelOidcToken ?? module.default?.getVercelOidcToken;
  } catch {
    throw new SandboxProviderError(
      'missing-dependency',
      '@vercel/oidc did not expose getVercelOidcToken',
    );
  }
  if (typeof helper !== 'function') {
    throw new SandboxProviderError(
      'missing-dependency',
      '@vercel/oidc did not expose getVercelOidcToken',
    );
  }
  return async () => {
    try {
      const token = await (helper as () => Promise<unknown>)();
      if (typeof token !== 'string') {
        throw new Error('OIDC helper returned a non-string token');
      }
      return token;
    } catch {
      // Do not copy helper errors into responses: they may include request
      // context or provider details.
      throw new SandboxProviderError(
        'invalid-auth',
        'Vercel OIDC credentials were unavailable for this request',
      );
    }
  };
}

async function resolveAmbientVercelAuth(
  options: SandboxProviderOptions,
  resolveToken: VercelOidcTokenResolver,
): Promise<VercelAuth> {
  if (options.allowEnvironmentAuth === false) {
    throw new SandboxProviderError(
      'invalid-auth',
      'Vercel sandbox auth requires explicit token/teamId/projectId when environment auth is disabled',
    );
  }

  let token: string;
  try {
    token = await resolveToken();
  } catch {
    // A request that has no OIDC context must fail closed. Falling back to a
    // process-wide PAT here could bind one tenant's request to another tenant.
    throw new SandboxProviderError(
      'invalid-auth',
      'Vercel OIDC credentials were unavailable for this request',
    );
  }
  return credentialsFromOidcToken(token);
}

function credentialsFromOidcToken(token: unknown): VercelAuth {
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096 || /[\u0000-\u001f\u007f]/u.test(token)) {
    throw new SandboxProviderError('invalid-auth', 'Vercel OIDC token is invalid');
  }
  const segments = token.split('.');
  if (
    segments.length !== 3 ||
    segments.some((segment) => segment.length === 0 || !/^[A-Za-z0-9_-]+$/u.test(segment))
  ) {
    throw new SandboxProviderError('invalid-auth', 'Vercel OIDC token is invalid');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(decodeOidcPayload(segments[1]!)) as unknown;
  } catch {
    throw new SandboxProviderError('invalid-auth', 'Vercel OIDC token is invalid');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new SandboxProviderError('invalid-auth', 'Vercel OIDC token is invalid');
  }
  const claims = payload as Record<string, unknown>;
  if (typeof claims.owner_id !== 'string' || typeof claims.project_id !== 'string') {
    throw new SandboxProviderError(
      'invalid-auth',
      'Vercel OIDC token lacks owner_id and project_id claims',
    );
  }
  const auth = {
    token,
    teamId: claims.owner_id,
    projectId: claims.project_id,
  };
  validateAuth(auth);
  return auth;
}

function decodeOidcPayload(segment: string): string {
  if (segment.length % 4 === 1 || typeof globalThis.atob !== 'function') {
    throw new Error('invalid OIDC payload encoding');
  }
  const base64 = segment.replaceAll('-', '+').replaceAll('_', '/');
  const binary = globalThis.atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function assertProvider(value: unknown): ComputeSdkVercelProvider {
  if (!value || typeof value !== 'object') {
    throw new SandboxProviderError('missing-dependency', '@computesdk/vercel returned an invalid provider');
  }
  const provider = value as Partial<ComputeSdkVercelProvider>;
  if (typeof provider.sandbox?.create !== 'function') {
    throw new SandboxProviderError('missing-dependency', '@computesdk/vercel returned an invalid provider');
  }
  if (provider.name !== 'vercel') {
    throw new SandboxProviderError(
      'unsupported-provider',
      'provider factory did not identify the Vercel provider',
    );
  }
  return provider as ComputeSdkVercelProvider;
}

function configuredProviderName(): string {
  if (typeof process !== 'undefined' && process.env?.PSKILLS_SANDBOX_PROVIDER) {
    return process.env.PSKILLS_SANDBOX_PROVIDER;
  }
  return 'vercel';
}

function vercelProviderConfig(
  options: SandboxProviderOptions,
  auth?: VercelAuth,
): Record<string, unknown> {
  const resolvedAuth = auth ?? options.auth;
  if (resolvedAuth) {
    validateAuth(resolvedAuth);
    // ComputeSDK's Vercel adapter otherwise adds its daemon SSE port (38989)
    // to every sandbox. Scanner sandboxes never use that bridge; keep the
    // native network surface explicit and empty.
    return { ...resolvedAuth, ports: [], daemonSsePort: false };
  }
  if (options.allowEnvironmentAuth === false) {
    throw new SandboxProviderError(
      'invalid-auth',
      'Vercel sandbox auth requires explicit token/teamId/projectId when environment auth is disabled',
    );
  }
  // Ambient OIDC credentials are resolved immediately before each create by
  // resolveAmbientVercelAuth. The provider never receives a mutable env proxy.
  return { ports: [], daemonSsePort: false };
}

function validateAuth(auth: VercelAuth): void {
  if (!auth || typeof auth !== 'object') {
    throw new SandboxProviderError('invalid-auth', 'Vercel auth must be an object');
  }
  for (const key of Object.keys(auth)) {
    if (key !== 'token' && key !== 'teamId' && key !== 'projectId') {
      throw new SandboxProviderError('invalid-auth', 'Vercel auth field ' + key + ' is unsupported');
    }
  }
  for (const name of ['token', 'teamId', 'projectId'] as const) {
    if (!Object.prototype.hasOwnProperty.call(auth, name)) {
      throw new SandboxProviderError('invalid-auth', 'Vercel auth field ' + name + ' is invalid');
    }
    const value = auth[name];
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > 4096 ||
      /[\u0000-\u001f\u007f]/u.test(value)
    ) {
      throw new SandboxProviderError('invalid-auth', 'Vercel auth field ' + name + ' is invalid');
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
  generated: ComputeSdkProviderSandbox | undefined,
  native: unknown,
): Promise<void> {
  const candidate = asNativeSandbox(native);
  let nativeStop: ((options?: { signal?: AbortSignal }) => Promise<unknown>) | undefined;
  try {
    nativeStop = typeof candidate?.stop === 'function' ? candidate.stop.bind(candidate) : undefined;
  } catch {
    nativeStop = undefined;
  }
  if (nativeStop) {
    try {
      await nativeStop();
      return;
    } catch {
      throw new SandboxProviderError('cleanup-failed', 'Vercel native sandbox cleanup failed');
    }
  }

  // A failing getInstance() leaves no native handle from which stop() can be
  // called. The generated provider destroy is only a last-resort orphan
  // cleanup attempt: the upstream Vercel implementation intentionally swallows
  // its errors, so even a resolved call cannot be treated as verified cleanup.
  let genericDestroy: (() => Promise<void>) | undefined;
  try {
    genericDestroy = typeof generated?.destroy === 'function' ? generated.destroy.bind(generated) : undefined;
  } catch {
    genericDestroy = undefined;
  }
  if (!genericDestroy) {
    throw new SandboxProviderError(
      'cleanup-failed',
      'Vercel native sandbox cleanup was unavailable',
    );
  }
  try {
    await genericDestroy();
  } catch {
    throw new SandboxProviderError('cleanup-failed', 'Vercel native sandbox cleanup failed');
  }
  throw new SandboxProviderError(
    'cleanup-failed',
    'Vercel native sandbox cleanup completed through an unverified fallback',
  );
}

function asNativeSandbox(value: unknown): NativeSandbox | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return value as NativeSandbox;
}

async function guardedNativeOperation<T>(
  operation: () => Promise<T>,
  code: SandboxProviderError['code'],
  message: string,
  options: { preserveNotFound?: boolean } = {},
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (options.preserveNotFound && isNotFoundError(error)) {
      throw new SandboxProviderNotFoundError();
    }
    throw new SandboxProviderError(code, message);
  }
}

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  try {
    return (error as { code?: unknown }).code === 'ENOENT';
  } catch {
    return false;
  }
}

function wrapNativeSandbox(native: NativeSandbox, capabilities: SandboxCapabilities): SandboxInstance {
  const runCommand = native.runCommand!.bind(native);
  const mkDir = native.mkDir!.bind(native);
  const writeFiles = native.writeFiles!.bind(native);
  const readFileToBuffer = native.readFileToBuffer!.bind(native);
  const stop = native.stop!.bind(native);
  const nativeFs = native.fs!;
  const nativeStat = nativeFs.stat.bind(nativeFs);
  const fs: SandboxFileSystem = {
    stat: (path, options) => guardedNativeOperation(
      () => nativeStat(path, options),
      'unsupported-capability',
      'Vercel native filesystem stat failed',
      { preserveNotFound: true },
    ),
  };
  if (nativeFs.lstat) {
    const nativeLstat = nativeFs.lstat.bind(nativeFs);
    fs.lstat = (path, options) => guardedNativeOperation(
      () => nativeLstat(path, options),
      'unsupported-capability',
      'Vercel native filesystem lstat failed',
      { preserveNotFound: true },
    );
  }
  if (nativeFs.readFile) {
    const nativeReadFile = nativeFs.readFile.bind(nativeFs);
    fs.readFile = (path, encoding) => guardedNativeOperation(
      () => nativeReadFile(path, encoding),
      'unsupported-capability',
      'Vercel native filesystem read failed',
    );
  }
  return {
    capabilities,
    fs,
    mkDir: (path, options) => guardedNativeOperation(
      () => mkDir(path, options),
      'unsupported-capability',
      'Vercel native sandbox directory operation failed',
    ),
    writeFiles: (files, options) => guardedNativeOperation(
      () => writeFiles(files.map((file) => ({ ...file, content: file.content })), options),
      'unsupported-capability',
      'Vercel native sandbox file write failed',
    ),
    readFileToBuffer: (file, options) => guardedNativeOperation(
      () => readFileToBuffer(file, options),
      'unsupported-capability',
      'Vercel native sandbox file read failed',
    ),
    runCommand: async (options) => {
      const command = await guardedNativeOperation(
        () => runCommand({
          cmd: options.cmd,
          args: options.args,
          ...(options.cwd ? { cwd: options.cwd } : {}),
          ...(options.env ? { env: options.env } : {}),
          detached: true,
          ...(options.signal ? { signal: options.signal } : {}),
        }),
        'unsupported-capability',
        'Vercel native sandbox command creation failed',
      );
      return wrapNativeCommand(command);
    },
    stop: (options) => guardedNativeOperation(
      () => stop(options),
      'cleanup-failed',
      'Vercel native sandbox cleanup failed',
    ),
  };
}

function wrapNativeCommand(value: unknown): SandboxCommand {
  let wait: NonNullable<NativeCommand['wait']>;
  let logs: NonNullable<NativeCommand['logs']>;
  let kill: NonNullable<NativeCommand['kill']>;
  try {
    if (!value || typeof value !== 'object') {
      throw new SandboxProviderError('unsupported-capability', 'native runCommand did not return a command handle');
    }
    const command = value as NativeCommand;
    if (typeof command.wait !== 'function' || typeof command.logs !== 'function' || typeof command.kill !== 'function') {
      throw new SandboxProviderError('unsupported-capability', 'native command lacks wait/logs/kill controls');
    }
    wait = command.wait.bind(command);
    logs = command.logs.bind(command);
    kill = command.kill.bind(command);
  } catch (error) {
    if (error instanceof SandboxProviderError) throw error;
    throw new SandboxProviderError('unsupported-capability', 'Vercel native command controls could not be attached');
  }
  return {
    wait: async (options) => normalizeCommandFinished(await guardedNativeOperation(
      () => wait(options),
      'unsupported-capability',
      'Vercel native command wait failed',
    )),
    logs: (options) => normalizeLogs(
      () => logs(options),
    ),
    kill: (signal, options) => guardedNativeOperation(
      () => kill(signal, options),
      'unsupported-capability',
      'Vercel native command termination failed',
    ),
  };
}

async function* normalizeLogs(sourceFactory: () => AsyncIterable<unknown>): AsyncIterable<SandboxLogEntry> {
  try {
    for await (const value of sourceFactory()) {
      if (!value || typeof value !== 'object') continue;
      const record = value as Record<string, unknown>;
      if ((record.stream === 'stdout' || record.stream === 'stderr') && typeof record.data === 'string') {
        yield { stream: record.stream, data: record.data };
      }
    }
  } catch {
    throw new SandboxProviderError('unsupported-capability', 'Vercel native command log streaming failed');
  }
}

function normalizeCommandFinished(value: unknown): SandboxCommandFinished {
  try {
    if (!value || typeof value !== 'object') throw new SandboxProviderError('unsupported-capability', 'native command returned invalid completion');
    const record = value as Record<string, unknown>;
    if (typeof record.exitCode !== 'number' && record.exitCode !== null) {
      throw new SandboxProviderError('unsupported-capability', 'native command completion lacks exitCode');
    }
    return {
      exitCode: record.exitCode as number | null,
      ...(typeof record.durationMs === 'number' ? { durationMs: record.durationMs } : {}),
    };
  } catch {
    throw new SandboxProviderError('unsupported-capability', 'Vercel native command returned invalid completion');
  }
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
