import {
  SandboxExecutor,
  type SandboxExecutorOptions,
  type SandboxImageMap,
  validateSandboxImageMap,
} from '../../../packages/scanners/src/index.js';
import type { CommandExecutor, ScannerAdapter } from '../../../packages/scanners/src/index.js';
import { createSandboxProviderLoader } from '../../../packages/sandbox-provider/src/index.js';
import {
  workerAcquisitionOptionsFromEnv,
  type WorkerAcquisitionOptions,
  type WorkerOpenClawAcquisitionOptions,
} from './acquisition.js';
import {
  createOpenClawHttpFetcher,
  type OpenClawSourceKind,
  type OpenClawSourceLocator,
  type OpenClawSourceTransportProfile,
} from '../../../packages/upstreams/src/index.js';
import {
  WorkerRunner,
  type LocalStageHook,
  type RunOnceResult,
  type WorkerEvent,
  type WorkerOpenClawSourceProofRecorder,
  type WorkerRunnerOptions,
} from './worker.js';

/**
 * Configuration for a single protected worker invocation. The route remains
 * a Web Request handler so Nitro can expose it on Node or another compatible
 * server target without changing the worker protocol.
 *
 * Required environment names when using createHostedWorkerHandlerFromEnv:
 * PSKILLS_API_URL, PSKILLS_WORKER_TOKEN, CRON_SECRET, and any configured
 * scanner image references in PSKILLS_IMAGE_CISCO, PSKILLS_IMAGE_NVIDIA, and
 * PSKILLS_IMAGE_SKILLSGUARD. PSKILLS_SANDBOX_DRIVER defaults to computesdk;
 * set it to native only for an explicit regression fallback. The provider
 * defaults to Vercel and is selected with PSKILLS_SANDBOX_PROVIDER. Image values must be immutable @sha256 refs, or
 * trusted source-built snapshot refs of the form
 * snapshot:<id>|revision:<source-revision>|source:sha256:<artifact-digest>.
 */
export interface HostedWorkerOptions {
  apiUrl: string;
  workerToken: string;
  cronSecret: string;
  scannerImages: SandboxImageMap;
  /** ComputeSDK is the production driver; native is an explicit regression fallback. */
  sandboxDriver?: HostedSandboxDriver;
  /** Provider selected by PSKILLS_SANDBOX_PROVIDER; currently Vercel is supported. */
  sandboxProvider?: string;
  executor?: CommandExecutor;
  sandbox?: SandboxExecutorOptions;
  fetch?: typeof fetch;
  workerId?: string | (() => string);
  adapters?: Map<string, ScannerAdapter> | ScannerAdapter[];
  maxBundleJsonBytes?: number;
  acquisition?: WorkerAcquisitionOptions;
  /**
   * Deployment-owned OpenClaw source binding. Feed/job data contains only a
   * verified source identity; it never supplies an artifact URL. When this is
   * present the hosted worker creates the bounded HTTPS fetcher from this
   * locator and refuses a second caller-supplied OpenClaw transport.
   */
  openClawSource?: HostedOpenClawSourceConfig;
  /** Durable registry-owned sink for verified OpenClaw source proofs. */
  openClawProofRecorder?: WorkerOpenClawSourceProofRecorder;
  stageHooks?: LocalStageHook[];
  onEvent?: (event: WorkerEvent) => void | Promise<void>;
  /** Allows route tests or deployment wrappers to decorate WorkerRunner. */
  createRunner?: (options: WorkerRunnerOptions) => WorkerRunner;
}

export interface HostedOpenClawSourceConfig {
  /** Maps a server-selected source identity to an operator-approved URL. */
  locator: OpenClawSourceLocator;
  /**
   * Legacy one-profile binding. It remains supported for custom adapters, but
   * a default public configuration should use sourceProfiles because GitHub's
   * provider and codeload transport have different trusted origins.
   */
  allowedArtifactOrigins?: readonly string[];
  /** Verified source identity origin, separate from the transport endpoint. */
  sourceProviderOrigin?: string;
  /**
   * Per-source-family bindings. A family absent from this map is unavailable;
   * no claimed job may provide a replacement origin or URL.
   */
  sourceProfiles?: Readonly<Partial<Record<OpenClawSourceKind, OpenClawSourceTransportProfile>>>;
}

export type HostedSandboxDriver = 'computesdk' | 'native';

export interface HostedWorkerResponse {
  ok: boolean;
  claimed: boolean;
  jobId?: string;
  allow?: boolean;
  error?: 'worker scan failed' | 'worker route failed';
}

/**
 * Create a one-shot handler for a Vercel Cron or equivalent scheduler. A
 * Nitro route can expose this handler at `/api/internal/worker-once` (or a
 * deployment-specific internal path) without changing the protocol.
 * Authorization is an exact Bearer CRON_SECRET match; the cron user-agent is
 * deliberately not treated as authentication. The response contains only
 * queue metadata and never scanner reports, artifacts, or transport tokens.
 */
export function createHostedWorkerHandler(options: HostedWorkerOptions): (request: Request) => Promise<Response> {
  validateHostedOptions(options);
  validateSandboxDriverOptions(options);
  const scannerImages = validateSandboxImageMap(options.scannerImages, options.sandbox?.trustedSnapshots);
  const executor = options.executor ?? new SandboxExecutor(sandboxExecutorOptions(options));
  const acquisition = hostedAcquisitionOptions(options);

  return async (request: Request): Promise<Response> => {
    if (request.method.toUpperCase() !== 'GET') {
      return jsonResponse({ ok: false, claimed: false, error: 'worker route failed' }, 405, { Allow: 'GET' });
    }
    if (!authorizedCronRequest(request, options.cronSecret)) {
      return jsonResponse({ ok: false, claimed: false, error: 'worker route failed' }, 401);
    }

    const runnerOptions: WorkerRunnerOptions = {
      baseUrl: options.apiUrl,
      workerToken: options.workerToken,
      workerId: resolveWorkerId(options.workerId),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      executor,
      scannerImages,
      ...(options.adapters ? { adapters: options.adapters } : {}),
      ...(options.maxBundleJsonBytes === undefined ? {} : { maxBundleJsonBytes: options.maxBundleJsonBytes }),
      ...(acquisition ? { acquisition } : {}),
      ...(options.openClawProofRecorder ? { openClawProofRecorder: options.openClawProofRecorder } : {}),
      ...(options.stageHooks ? { stageHooks: options.stageHooks } : {}),
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    };
    const runner = options.createRunner?.(runnerOptions) ?? new WorkerRunner(runnerOptions);
    try {
      const result = await runner.runOnce(request.signal);
      return responseForRunOnce(result);
    } catch {
      // Route responses are third-party visible. Keep scanner stderr, report
      // excerpts, artifact paths, and transport errors in server-side telemetry
      // owned by the deployment wrapper rather than returning them here.
      return jsonResponse({ ok: false, claimed: false, error: 'worker route failed' }, 500);
    }
  };
}

/**
 * Construct the OpenClaw worker seam once at route creation. This keeps the
 * source locator and origin allowlist deployment-owned while reusing the
 * shared bounded transport implementation. In particular, no URL is derived
 * from a claimed package name, repository, or path.
 */
export function createHostedOpenClawAcquisition(
  config: HostedOpenClawSourceConfig,
  fetchImpl?: typeof fetch,
): WorkerOpenClawAcquisitionOptions {
  const normalized = normalizeHostedOpenClawSourceConfig(config);
  const boundedLocator: OpenClawSourceLocator = {
    async locate(source, signal) {
      const profile = hostedOpenClawProfileForSource(normalized.profiles, source);
      if (profile === undefined) {
        throw new Error('hosted OpenClaw source kind is not configured');
      }
      const location = await config.locator.locate(source, signal);
      if (!location || typeof location.url !== 'string') {
        throw new Error('hosted OpenClaw source locator returned an invalid location');
      }
      // The locator chooses a path; deployment configuration chooses the
      // transport and identity boundaries. Do not let a locator result widen
      // either allowlist, even when it is supplied by another adapter.
      return {
        url: location.url,
        allowedArtifactOrigins: profile.allowedArtifactOrigins,
        sourceProviderOrigin: profile.sourceProviderOrigin,
      };
    },
  };
  return {
    fetcher: createOpenClawHttpFetcher({
      locator: boundedLocator,
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    }),
    allowedArtifactOrigins: normalized.allowedArtifactOrigins,
    ...(normalized.sourceProviderOrigin === undefined ? {} : { sourceProviderOrigin: normalized.sourceProviderOrigin }),
  };
}

function hostedAcquisitionOptions(options: HostedWorkerOptions): WorkerAcquisitionOptions | undefined {
  if (options.openClawSource === undefined) return options.acquisition;
  if (options.acquisition?.openClaw !== undefined) {
    throw new Error('hosted OpenClaw source configuration cannot be combined with a caller-supplied OpenClaw fetcher');
  }
  return {
    ...(options.acquisition ?? {}),
    openClaw: createHostedOpenClawAcquisition(options.openClawSource, options.fetch),
  };
}

export type HostedWorkerEnv = Readonly<Record<string, string | undefined>>;

export function hostedWorkerOptionsFromEnv(
  env: HostedWorkerEnv,
  overrides: HostedWorkerOverrides = {},
): HostedWorkerOptions {
  const acquisition = {
    ...workerAcquisitionOptionsFromEnv(env),
    ...(overrides.acquisition ?? {}),
  };
  const baseImages: SandboxImageMap = {
    'cisco-skill-scanner': env.PSKILLS_IMAGE_CISCO,
    'nvidia-skillspector': env.PSKILLS_IMAGE_NVIDIA,
    skillsguard: env.PSKILLS_IMAGE_SKILLSGUARD,
  };
  return {
    ...overrides,
    apiUrl: requiredEnv(env, 'PSKILLS_API_URL'),
    workerToken: requiredEnv(env, 'PSKILLS_WORKER_TOKEN'),
    cronSecret: requiredEnv(env, 'CRON_SECRET'),
    scannerImages: { ...baseImages, ...(overrides.scannerImages ?? {}) },
    sandboxDriver: resolveSandboxDriver(overrides.sandboxDriver ?? env.PSKILLS_SANDBOX_DRIVER),
    sandboxProvider: overrides.sandboxProvider ?? env.PSKILLS_SANDBOX_PROVIDER ?? 'vercel',
    ...(Object.keys(acquisition).length === 0 ? {} : { acquisition }),
  };
}

export type HostedWorkerOverrides = Omit<Partial<HostedWorkerOptions>, 'apiUrl' | 'workerToken' | 'cronSecret' | 'scannerImages'> & {
  scannerImages?: SandboxImageMap;
};

export function createHostedWorkerHandlerFromEnv(
  env: HostedWorkerEnv,
  overrides: HostedWorkerOverrides = {},
): (request: Request) => Promise<Response> {
  return createHostedWorkerHandler(hostedWorkerOptionsFromEnv(env, overrides));
}

function validateHostedOptions(options: HostedWorkerOptions): void {
  if (!isHttpOrigin(options.apiUrl)) throw new Error('hosted worker API URL must be an HTTP(S) origin');
  if (!options.workerToken || /[\u0000\r\n]/.test(options.workerToken)) throw new Error('hosted worker token is required');
  if (!options.cronSecret || options.cronSecret.length < 16 || options.cronSecret.length > 4096 || /[\u0000\r\n]/.test(options.cronSecret)) {
    throw new Error('CRON_SECRET must be 16-4096 characters without control characters');
  }
}

interface NormalizedHostedOpenClawSourceConfig {
  profiles: Readonly<Partial<Record<OpenClawSourceKind, OpenClawSourceTransportProfile>>>;
  allowedArtifactOrigins: readonly string[];
  sourceProviderOrigin?: string;
}

function normalizeHostedOpenClawSourceConfig(config: HostedOpenClawSourceConfig): NormalizedHostedOpenClawSourceConfig {
  if (!config || typeof config.locator?.locate !== 'function') {
    throw new Error('hosted OpenClaw source locator is required');
  }

  const hasLegacyProfile = config.allowedArtifactOrigins !== undefined || config.sourceProviderOrigin !== undefined;
  const hasSourceProfiles = config.sourceProfiles !== undefined;
  if (hasLegacyProfile && hasSourceProfiles) {
    throw new Error('hosted OpenClaw source cannot combine legacy and per-kind profiles');
  }

  if (hasLegacyProfile) {
    if (config.allowedArtifactOrigins === undefined || config.sourceProviderOrigin === undefined) {
      throw new Error('hosted OpenClaw legacy profile requires artifact and provider origins');
    }
    const profile = normalizeHostedOpenClawSourceProfile({
      allowedArtifactOrigins: config.allowedArtifactOrigins,
      sourceProviderOrigin: config.sourceProviderOrigin,
    });
    const profiles = Object.freeze({
      'public-clawhub': profile,
      'public-github': profile,
    });
    return {
      profiles,
      allowedArtifactOrigins: profile.allowedArtifactOrigins,
      sourceProviderOrigin: profile.sourceProviderOrigin,
    };
  }

  if (!isRecord(config.sourceProfiles)) {
    throw new Error('hosted OpenClaw source requires one or more per-kind profiles');
  }
  const profileKeys = Object.keys(config.sourceProfiles);
  if (profileKeys.length === 0 || profileKeys.length > 2) {
    throw new Error('hosted OpenClaw source requires one or two per-kind profiles');
  }
  const profiles: Partial<Record<OpenClawSourceKind, OpenClawSourceTransportProfile>> = {};
  const origins = new Set<string>();
  for (const key of profileKeys) {
    if (key !== 'public-clawhub' && key !== 'public-github') {
      throw new Error('hosted OpenClaw source profile kind is invalid');
    }
    const profile = normalizeHostedOpenClawSourceProfile(config.sourceProfiles[key]);
    profiles[key] = profile;
    for (const origin of profile.allowedArtifactOrigins) origins.add(origin);
  }
  return {
    profiles: Object.freeze(profiles),
    allowedArtifactOrigins: Object.freeze([...origins]),
  };
}

function normalizeHostedOpenClawSourceProfile(value: unknown): OpenClawSourceTransportProfile {
  if (!isRecord(value) || !Array.isArray(value.allowedArtifactOrigins) || value.allowedArtifactOrigins.length === 0 || value.allowedArtifactOrigins.length > 8) {
    throw new Error('hosted OpenClaw source requires 1-8 artifact origins');
  }
  const origins = [...new Set(value.allowedArtifactOrigins.map((origin) => {
    if (typeof origin !== 'string' || !isStrictHttpsOrigin(origin)) {
      throw new Error('hosted OpenClaw artifact origins must be HTTPS origins');
    }
    return new URL(origin).origin;
  }))];
  if (typeof value.sourceProviderOrigin !== 'string' || !isStrictHttpsOrigin(value.sourceProviderOrigin)) {
    throw new Error('hosted OpenClaw source provider must be an HTTPS origin');
  }
  return Object.freeze({
    allowedArtifactOrigins: Object.freeze(origins),
    sourceProviderOrigin: new URL(value.sourceProviderOrigin).origin,
  });
}

function hostedOpenClawProfileForSource(
  profiles: Readonly<Partial<Record<OpenClawSourceKind, OpenClawSourceTransportProfile>>>,
  source: unknown,
): OpenClawSourceTransportProfile | undefined {
  if (!isRecord(source)) return undefined;
  const kind = source.kind;
  if (kind !== 'public-clawhub' && kind !== 'public-github') return undefined;
  return profiles[kind];
}

function sandboxExecutorOptions(options: HostedWorkerOptions): SandboxExecutorOptions | undefined {
  const sandbox = options.sandbox;
  const { driver, provider } = validateSandboxDriverOptions(options);
  if (sandbox?.sdk || sandbox?.loadSdk || driver === 'native') return sandbox;
  if (driver !== 'computesdk') return sandbox;
  return {
    ...sandbox,
    loadSdk: createSandboxProviderLoader({ provider }),
  };
}

function validateSandboxDriverOptions(options: HostedWorkerOptions): { driver: HostedSandboxDriver; provider: string } {
  const driver = resolveSandboxDriver(options.sandboxDriver);
  const provider = options.sandboxProvider ?? 'vercel';
  if (driver === 'computesdk' && provider !== 'vercel') {
    throw new Error(`Unsupported PSKILLS_SANDBOX_PROVIDER: ${provider}`);
  }
  return { driver, provider };
}

function resolveSandboxDriver(value: string | undefined): HostedSandboxDriver {
  const driver = value ?? 'computesdk';
  if (driver === 'computesdk' || driver === 'native') return driver;
  throw new Error(`PSKILLS_SANDBOX_DRIVER must be computesdk or native; found ${driver}`);
}

function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:')
      && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStrictHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && url.pathname === '/';
  } catch {
    return false;
  }
}

function authorizedCronRequest(request: Request, expected: string): boolean {
  const authorization = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match ? constantTimeEqual(match[1].trim(), expected) : false;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function resolveWorkerId(value: HostedWorkerOptions['workerId']): string {
  const workerId = typeof value === 'function' ? value() : value;
  if (workerId) return workerId;
  const randomUuid = globalThis.crypto?.randomUUID?.();
  return `vercel-cron-${randomUuid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
}

function responseForRunOnce(result: RunOnceResult): Response {
  const payload: HostedWorkerResponse = {
    ok: !result.error,
    claimed: result.claimed,
    ...(result.jobId ? { jobId: result.jobId } : {}),
    ...(result.allow === undefined ? {} : { allow: result.allow }),
    ...(result.error ? { error: 'worker scan failed' as const } : {}),
  };
  return jsonResponse(payload, result.error ? 500 : 200);
}

function jsonResponse(payload: HostedWorkerResponse, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      ...headers,
    },
  });
}

function requiredEnv(env: HostedWorkerEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required for the hosted worker route`);
  return value;
}
