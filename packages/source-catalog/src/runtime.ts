/**
 * Portable source-catalog composition.
 *
 * This module is deliberately limited to Web APIs and plain environment
 * records.  The Node and edge Nitro entries both use it, which keeps source
 * credentials and provider configuration on the server while leaving the
 * catalog client itself host-neutral.
 */

import {
  SourceCatalogClient,
  type SourceCatalogClientOptions,
} from './client.js';
import {
  BUILT_IN_SOURCE_IDS,
  SourceCatalogError,
  type SourceCatalogAdapter,
  type SourceCatalogConfiguration,
  type SourceConfiguration,
} from './types.js';
import {
  REGISTRY_ORIGINS,
  createRegistrySourceAdapters,
  type RegistryAdapterOptions,
} from './adapters/registries.js';
import {
  GITHUB_API_ORIGIN,
  GITHUB_SOURCE_ORIGIN,
  createGithubSourceAdapters,
  type GitHubRepositorySpec,
} from './adapters/github.js';
import { TESSL_API_ORIGIN, createTesslSourceAdapter } from './adapters/tessl.js';

/** A host-provided environment snapshot; no request data is read here. */
export type SourceCatalogRuntimeEnvironment = Readonly<Record<string, string | undefined>>;

type FetchLike = typeof fetch;
type GitHubRepositoryInput = string | GitHubRepositorySpec;

export interface SourceCatalogRuntimeOptions {
  /** Explicit environment snapshot. Defaults to the current host environment. */
  env?: SourceCatalogRuntimeEnvironment;
  /** Injected fetch is useful for edge gateways and deterministic tests. */
  fetch?: FetchLike;
  /** Provider adapters use this clock for resolved metadata. */
  now?: () => Date;
  /** Test/host override for the server-owned custom GitHub allowlist. */
  customRepositories?: readonly GitHubRepositoryInput[];
  /** Additional adapter options for bounded provider fixtures. */
  requestTimeoutMs?: number;
  /** Explicit client configuration override; origins remain fixed below. */
  configuration?: SourceCatalogConfiguration;
  /** Test-only composition seam. Production uses the built-in adapter set. */
  adapters?: readonly SourceCatalogAdapter[];
}

interface ParsedSourceEnvironment {
  configuration: SourceCatalogConfiguration;
  customRepositories?: readonly GitHubRepositorySpec[];
}

interface RawSourceSettings {
  enabled?: unknown;
  trustedOrigins?: unknown;
  repositories?: unknown;
  customRepositories?: unknown;
}

interface RawSourceEnvironmentConfig {
  enabled?: unknown;
  sources?: unknown;
  maxQueryLength?: unknown;
  maxResultsPerSource?: unknown;
  maxTotalResults?: unknown;
  requestTimeoutMs?: unknown;
  [key: string]: unknown;
}

const MAX_SOURCE_CONFIG_BYTES = 512 * 1024;
const MAX_CUSTOM_REPOSITORIES = 32;
const REPOSITORY_PART_RE = /^[A-Za-z0-9_.-]{1,100}$/u;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/~+-]{0,255}$/u;
const SOURCE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

/**
 * Provider origins are fixed in code.  Operators may narrow a source's trust
 * list in PSKILLS_SOURCES_JSON, but cannot add an arbitrary outbound origin.
 */
export const SOURCE_TRUSTED_ORIGINS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  skillsmp: Object.freeze([REGISTRY_ORIGINS.skillsmp, GITHUB_SOURCE_ORIGIN]),
  clawhub: Object.freeze([REGISTRY_ORIGINS.clawhub]),
  'skillhub-public': Object.freeze([REGISTRY_ORIGINS.skillhubPublic, GITHUB_SOURCE_ORIGIN]),
  tessl: Object.freeze([TESSL_API_ORIGIN]),
  polyskill: Object.freeze([REGISTRY_ORIGINS.polyskill, GITHUB_SOURCE_ORIGIN]),
  'skills-directory': Object.freeze([REGISTRY_ORIGINS.skillsDirectory, GITHUB_SOURCE_ORIGIN]),
  'skillhub-pro': Object.freeze([REGISTRY_ORIGINS.skillhubPro, GITHUB_SOURCE_ORIGIN]),
  'github-code-search': Object.freeze([GITHUB_SOURCE_ORIGIN]),
  'github-openai-skills': Object.freeze([GITHUB_SOURCE_ORIGIN]),
  'github-anthropics-skills': Object.freeze([GITHUB_SOURCE_ORIGIN]),
  'github-google-skills': Object.freeze([GITHUB_SOURCE_ORIGIN]),
  'github-vercel-agent-skills': Object.freeze([GITHUB_SOURCE_ORIGIN]),
  'github-custom': Object.freeze([GITHUB_SOURCE_ORIGIN]),
});

const FIXED_PROVIDER_ORIGINS = Object.freeze([
  ...new Set([
    ...Object.values(SOURCE_TRUSTED_ORIGINS).flat(),
    GITHUB_API_ORIGIN,
  ]),
]);

/**
 * Parse the portable source-catalog environment contract.
 *
 * `PSKILLS_SOURCES_JSON` accepts either a direct source map, for example
 * `{ "skillsmp": { "enabled": false } }`, or an envelope containing
 * `{ "enabled": true, "sources": { ... } }`.  Invalid configuration fails
 * closed during runtime construction; it is never silently ignored.
 */
export function createSourceCatalogConfigurationFromEnv(
  env: SourceCatalogRuntimeEnvironment = readHostEnvironment(),
  overrides?: SourceCatalogConfiguration,
): SourceCatalogConfiguration {
  return parseSourceEnvironment(env, overrides).configuration;
}

/** Construct all built-in adapters in stable source-id order. */
export function createSourceCatalogAdapters(
  options: SourceCatalogRuntimeOptions = {},
): readonly SourceCatalogAdapter[] {
  const env = options.env ?? readHostEnvironment();
  const parsed = parseSourceEnvironment(env, options.configuration);
  const customRepositories = options.customRepositories ?? parsed.customRepositories;
  const requestTimeoutMs = options.requestTimeoutMs ?? parsed.configuration.requestTimeoutMs;
  const common = {
    env,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
  };

  // Registry adapters share only the fixed provider-origin set.  Individual
  // adapter constructors still select their own credential environment key;
  // no singular token is passed across provider boundaries.
  const registryOptions: RegistryAdapterOptions = {
    ...common,
    trustedOrigins: FIXED_PROVIDER_ORIGINS,
  };
  const registryAdapters = createRegistrySourceAdapters(registryOptions);

  const githubOptions = {
    ...common,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(customRepositories === undefined ? {} : { customRepositories }),
  };
  const githubAdapters = createGithubSourceAdapters(githubOptions);

  const tessl = createTesslSourceAdapter({
    env,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
  });

  const byId = new Map<string, SourceCatalogAdapter>();
  for (const adapter of [...registryAdapters, tessl, ...githubAdapters]) {
    if (!byId.has(adapter.id)) byId.set(adapter.id, adapter);
  }

  // The order is part of the response contract and keeps fan-out results
  // deterministic across hosts and provider factory revisions.
  const ordered = BUILT_IN_SOURCE_IDS.map((id) => {
    const adapter = byId.get(id);
    if (adapter === undefined) {
      throw configurationError(`Built-in source adapter ${id} is not registered`);
    }
    return adapter;
  });
  return Object.freeze(ordered);
}

/** Build the server-only catalog facade used by Node and edge Nitro. */
export function createSourceCatalogClientFromEnv(
  options: SourceCatalogRuntimeOptions = {},
): SourceCatalogClient {
  const env = options.env ?? readHostEnvironment();
  const adapters = options.adapters ?? createSourceCatalogAdapters(options);
  const configuration = createSourceCatalogConfigurationFromEnv(env, options.configuration);
  const clientOptions: SourceCatalogClientOptions = { adapters, configuration };
  return new SourceCatalogClient(clientOptions);
}

/** Concise aliases for hosts that call this seam a runtime factory. */
export const createSourceCatalogRuntime = createSourceCatalogClientFromEnv;
export const createSourceCatalogClient = createSourceCatalogClientFromEnv;
export const createSourceCatalogConfiguration = createSourceCatalogConfigurationFromEnv;

function parseSourceEnvironment(
  env: SourceCatalogRuntimeEnvironment,
  overrides?: SourceCatalogConfiguration,
): ParsedSourceEnvironment {
  const raw = parseSourcesJson(env.PSKILLS_SOURCES_JSON);
  const envelope = normalizeRawEnvironmentConfig(raw);
  const globalEnabled = parseOptionalBoolean(env.PSKILLS_SOURCES_ENABLED, 'PSKILLS_SOURCES_ENABLED');
  const jsonEnabled = parseOptionalJsonBoolean(envelope.enabled, 'PSKILLS_SOURCES_JSON.enabled');
  const sourceEntries = parseSourceEntries(envelope.sources);

  const sourceConfigurations: Record<string, SourceConfiguration> = {};
  const customFromJson = parseCustomRepositoriesFromSourceEntries(sourceEntries);
  for (const id of BUILT_IN_SOURCE_IDS) {
    const configured = sourceEntries[id];
    const trustedOrigins = configured?.trustedOrigins === undefined
      ? [...(SOURCE_TRUSTED_ORIGINS[id] ?? [])]
      : parseTrustedOrigins(configured.trustedOrigins, id);
    sourceConfigurations[id] = {
      ...(configured?.enabled === undefined ? {} : { enabled: configured.enabled as boolean }),
      trustedOrigins,
    };
  }

  const customEnvironmentRaw = env.PSKILLS_GITHUB_CUSTOM_REPOSITORIES;
  if (customEnvironmentRaw !== undefined && typeof customEnvironmentRaw !== 'string') {
    throw configurationError('PSKILLS_GITHUB_CUSTOM_REPOSITORIES is invalid');
  }
  const customEnvironmentValue = customEnvironmentRaw?.trim();
  const customFromEnvironment = customEnvironmentValue === undefined || customEnvironmentValue === ''
    ? undefined
    : parseRepositoriesJson(customEnvironmentValue, 'PSKILLS_GITHUB_CUSTOM_REPOSITORIES');
  const customRepositories = customFromEnvironment ?? customFromJson;

  const configuration: SourceCatalogConfiguration = {
    enabled: globalEnabled ?? jsonEnabled ?? true,
    sources: sourceConfigurations,
    ...(envelope.maxQueryLength === undefined ? {} : { maxQueryLength: positiveInteger(envelope.maxQueryLength, 'maxQueryLength') }),
    ...(envelope.maxResultsPerSource === undefined ? {} : { maxResultsPerSource: positiveInteger(envelope.maxResultsPerSource, 'maxResultsPerSource') }),
    ...(envelope.maxTotalResults === undefined ? {} : { maxTotalResults: positiveInteger(envelope.maxTotalResults, 'maxTotalResults') }),
    ...(envelope.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: positiveInteger(envelope.requestTimeoutMs, 'requestTimeoutMs') }),
  };

  if (overrides !== undefined) {
    mergeConfiguration(configuration, overrides);
  }

  return { configuration, ...(customRepositories === undefined ? {} : { customRepositories }) };
}

function parseSourcesJson(raw: string | undefined): RawSourceEnvironmentConfig {
  if (raw === undefined) return {};
  if (typeof raw !== 'string') throw configurationError('PSKILLS_SOURCES_JSON is invalid');
  if (raw.trim() === '') return {};
  if (new TextEncoder().encode(raw).byteLength > MAX_SOURCE_CONFIG_BYTES) {
    throw configurationError('PSKILLS_SOURCES_JSON is too large');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw configurationError('PSKILLS_SOURCES_JSON is invalid');
  }
  if (!isRecord(parsed)) throw configurationError('PSKILLS_SOURCES_JSON must be an object');
  return parsed as RawSourceEnvironmentConfig;
}

function normalizeRawEnvironmentConfig(raw: RawSourceEnvironmentConfig): RawSourceEnvironmentConfig {
  const keys = Object.keys(raw);
  const envelopeKeys = new Set([
    'enabled',
    'sources',
    'maxQueryLength',
    'maxResultsPerSource',
    'maxTotalResults',
    'requestTimeoutMs',
  ]);
  const hasEnvelopeField = keys.some((key) => envelopeKeys.has(key));
  if (!hasEnvelopeField) {
    for (const key of keys) {
      if (!isKnownSourceId(key)) throw configurationError('PSKILLS_SOURCES_JSON contains an unknown source');
    }
    return { sources: raw };
  }
  if (keys.some((key) => !envelopeKeys.has(key))) {
    throw configurationError('PSKILLS_SOURCES_JSON contains an unknown setting');
  }
  return raw;
}

function parseSourceEntries(value: unknown): Record<string, RawSourceSettings> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw configurationError('PSKILLS_SOURCES_JSON.sources must be an object');
  const entries: Record<string, RawSourceSettings> = {};
  for (const [id, rawSettings] of Object.entries(value)) {
    if (!isKnownSourceId(id)) throw configurationError('PSKILLS_SOURCES_JSON contains an unknown source');
    if (typeof rawSettings === 'boolean') {
      entries[id] = { enabled: rawSettings };
      continue;
    }
    if (!isRecord(rawSettings)) throw configurationError(`Source configuration for ${id} is invalid`);
    const settings = rawSettings as RawSourceSettings;
    const allowed = new Set(['enabled', 'trustedOrigins']);
    if (id === 'github-custom') {
      allowed.add('repositories');
      allowed.add('customRepositories');
    }
    if (Object.keys(settings).some((key) => !allowed.has(key))) {
      throw configurationError(`Source configuration for ${id} contains an unknown setting`);
    }
    if (settings.enabled !== undefined && typeof settings.enabled !== 'boolean') {
      throw configurationError(`Source configuration for ${id}.enabled is invalid`);
    }
    entries[id] = settings;
  }
  return entries;
}

function parseCustomRepositoriesFromSourceEntries(
  entries: Record<string, RawSourceSettings>,
): readonly GitHubRepositorySpec[] | undefined {
  const settings = entries['github-custom'];
  if (!settings) return undefined;
  const value = settings.repositories ?? settings.customRepositories;
  if (value === undefined) return undefined;
  return parseRepositories(value, 'github-custom.repositories');
}

function parseTrustedOrigins(value: unknown, sourceId: string): readonly string[] {
  if (!Array.isArray(value)) throw configurationError(`Source configuration for ${sourceId}.trustedOrigins is invalid`);
  const fixed = new Set(SOURCE_TRUSTED_ORIGINS[sourceId] ?? []);
  const result: string[] = [];
  for (const rawOrigin of value) {
    if (typeof rawOrigin !== 'string' || rawOrigin.length === 0) {
      throw configurationError(`Source configuration for ${sourceId}.trustedOrigins is invalid`);
    }
    let origin: URL;
    try { origin = new URL(rawOrigin); } catch { throw configurationError(`Source configuration for ${sourceId}.trustedOrigins is invalid`); }
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || !fixed.has(origin.origin)) {
      throw configurationError(`Source configuration for ${sourceId}.trustedOrigins is outside the fixed provider boundary`);
    }
    if (!result.includes(origin.origin)) result.push(origin.origin);
  }
  return result;
}

function parseRepositoriesJson(raw: string, label: string): readonly GitHubRepositorySpec[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw configurationError(`${label} is invalid`); }
  return parseRepositories(parsed, label);
}

function parseRepositories(value: unknown, label: string): readonly GitHubRepositorySpec[] {
  if (!Array.isArray(value) || value.length > MAX_CUSTOM_REPOSITORIES) {
    throw configurationError(`${label} must be an array of at most ${MAX_CUSTOM_REPOSITORIES} repositories`);
  }
  const seen = new Set<string>();
  const repositories: GitHubRepositorySpec[] = [];
  for (const raw of value) {
    const repository = typeof raw === 'string' ? raw : isRecord(raw) ? raw.repository : undefined;
    const ref = typeof raw === 'string' ? undefined : isRecord(raw) ? raw.ref : undefined;
    if (typeof repository !== 'string' || !isRepositoryCoordinate(repository) || repository.endsWith('.git')) {
      throw configurationError(`${label} contains an invalid repository`);
    }
    if (ref !== undefined && (typeof ref !== 'string' || !REF_RE.test(ref) || ref.includes('..'))) {
      throw configurationError(`${label} contains an invalid repository ref`);
    }
    const key = repository.toLocaleLowerCase('en-US');
    if (seen.has(key)) continue;
    seen.add(key);
    repositories.push({ repository, ...(ref === undefined ? {} : { ref }) });
  }
  return Object.freeze(repositories);
}

function mergeConfiguration(
  target: SourceCatalogConfiguration,
  override: SourceCatalogConfiguration,
): void {
  if (override.enabled !== undefined) {
    if (typeof override.enabled !== 'boolean') throw configurationError('source catalog enabled configuration is invalid');
    target.enabled = override.enabled;
  }
  for (const key of ['maxQueryLength', 'maxResultsPerSource', 'maxTotalResults', 'requestTimeoutMs'] as const) {
    const value = override[key];
    if (value !== undefined) target[key] = positiveInteger(value, key);
  }
  if (override.sources === undefined) return;
  if (!isRecord(override.sources)) throw configurationError('source catalog sources configuration is invalid');
  for (const [id, value] of Object.entries(override.sources)) {
    if (!isKnownSourceId(id) || !isRecord(value)) throw configurationError(`Source configuration for ${id} is invalid`);
    if (Object.keys(value).some((key) => key !== 'enabled' && key !== 'trustedOrigins')) {
      throw configurationError(`Source configuration for ${id} contains an unknown setting`);
    }
    if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw configurationError(`Source configuration for ${id}.enabled is invalid`);
    const existing = target.sources?.[id] ?? { trustedOrigins: [...(SOURCE_TRUSTED_ORIGINS[id] ?? [])] };
    const configured: SourceConfiguration = {
      ...existing,
      ...(value.enabled === undefined ? {} : { enabled: value.enabled }),
      ...(value.trustedOrigins === undefined ? {} : { trustedOrigins: parseTrustedOrigins(value.trustedOrigins, id) }),
    };
    target.sources = { ...(target.sources ?? {}), [id]: configured };
  }
}

function parseOptionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw configurationError(`${label} must be true or false`);
  if (value.trim() === '') return undefined;
  switch (value.trim().toLocaleLowerCase('en-US')) {
    case 'true':
    case '1':
      return true;
    case 'false':
    case '0':
      return false;
    default:
      throw configurationError(`${label} must be true or false`);
  }
}

function parseOptionalJsonBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw configurationError(`${label} must be a boolean`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw configurationError(`${label} must be a positive integer`);
  return Number(value);
}

function isKnownSourceId(value: string): boolean {
  return SOURCE_ID_RE.test(value) && (BUILT_IN_SOURCE_IDS as readonly string[]).includes(value);
}

function isRepositoryCoordinate(value: string): boolean {
  const parts = value.split('/');
  return parts.length === 2 && parts.every((part) => REPOSITORY_PART_RE.test(part) && part !== '.' && part !== '..');
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function configurationError(message: string): SourceCatalogError {
  return new SourceCatalogError('SOURCE_UNAVAILABLE', message, 500, { retryable: false });
}

function readHostEnvironment(): SourceCatalogRuntimeEnvironment {
  const processLike = (globalThis as { process?: { env?: SourceCatalogRuntimeEnvironment } }).process;
  return processLike?.env ?? {};
}
