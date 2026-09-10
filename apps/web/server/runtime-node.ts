import postgres from 'postgres';
import { getVercelOidcToken } from '@vercel/oidc';
import { FileStateRepository } from '../../../packages/database/src/file';
import { PostgresStateRepository, type PgPoolLike } from '../../../packages/database/src/postgres';
import { HttpStateRepository } from '../../../packages/database/src/http';
import { createNodeFilesSdkBlobStore, type FilesProvider } from '../../../packages/storage/src/node';
import { HttpBlobStore } from '../../../packages/storage/src/http';
import type { BlobStore, StateRepository } from '../../../packages/contracts/src/index';
import { defaultRegistryState } from '../../../packages/database/src/state';
import { PostgresSemanticIndex } from '../../../packages/search/src/postgres';
import { StateSemanticIndex } from '../../../packages/search/src/state';
import type { EmbeddingProfile, SemanticIndex } from '../../../packages/search/src/types';
import {
  createHostedWorkerHandlerFromEnv,
  type HostedOpenClawSourceConfig,
} from '../../../workers/runner/src/hosted';
import { resolveCurrentUploadReviewBinding } from '../../../packages/core/src/index';
import {
  createUploadReviewPersistenceService,
  resolveUploadReviewModel,
  resolveUploadReviewRevision,
  type UploadReviewPersistenceService,
} from '../../../packages/upload-reviews/src/index';
import { createUploadReviewHttpHandler } from '../../../packages/upload-reviews/src/http';
import { createUploadReviewTrigger } from '../../../packages/upload-reviews/src/trigger';
import { createDefaultOpenClawSourceConfiguration } from '../../../packages/upstreams/src/index';
import type { OpenClawNormalizedSource } from '../../../packages/openclaw/src/types';
import {
  createSkillsDirectoryGatewayTokenProvider,
  createUnavailableSkillsDirectoryTokenProvider,
  resolveSkillsDirectoryGateways,
  resolveSkillsDirectoryConnection,
  SKILLS_DIRECTORY_AUTH_UNAVAILABLE,
  type SkillsTokenProvider,
} from '../../../packages/directory/src/index';

export { createBuilderBffRuntime } from './builder-runtime';

export type RuntimeEnvironment = Record<string, string | undefined>;

export interface UploadReviewRuntime {
  service: UploadReviewPersistenceService;
  trigger?: ReturnType<typeof createUploadReviewTrigger>;
  httpHandler?: (request: Request) => Promise<Response | undefined>;
  configured: boolean;

}

const OPENCLAW_SOURCE_CONFIG_MAX_BYTES = 512 * 1024;
const OPENCLAW_SOURCE_CONFIG_MAX_BINDINGS = 256;
const OPENCLAW_SOURCE_URL_MAX_BYTES = 8_192;
const OPENCLAW_SOURCE_STRING_MAX_BYTES = 4_096;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/u;
const HEX40_RE = /^[0-9a-f]{40}$/u;
const HEX64_RE = /^[0-9a-f]{64}$/u;

/**
 * Build the deployment-owned OpenClaw source locator. Supported public
 * OpenClaw source identities use the reviewed default locator, so a hosted
 * worker does not need a per-skill binding map. The optional map remains a
 * server-only operator override/restriction; the worker job supplies only a
 * normalized source identity and can never choose a URL or widen an allowlist.
 *
 * The reviewed default is deliberately limited to the two normalized public
 * source families. An absent override uses those profiles; an unrecognized or
 * malformed identity still fails closed instead of reaching a guessed URL.
 */
export function createHostedOpenClawSourceConfigFromEnv(
  env: RuntimeEnvironment,
): HostedOpenClawSourceConfig {
  const configuredClawHubOrigin = env.PSKILLS_OPENCLAW_SOURCE_ORIGIN?.trim();
  const defaults = createDefaultOpenClawSourceConfiguration(
    configuredClawHubOrigin === undefined || configuredClawHubOrigin.length === 0
      ? {}
      : { clawHubOrigin: configuredClawHubOrigin },
  );
  const raw = env.PSKILLS_OPENCLAW_SOURCE_LOCATOR_JSON?.trim();
  if (!raw) {
    return {
      locator: defaults.locator,
      sourceProfiles: defaults.profiles,
    };
  }
  if (new TextEncoder().encode(raw).byteLength > OPENCLAW_SOURCE_CONFIG_MAX_BYTES) {
    throw new Error('OpenClaw source locator configuration is too large');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('OpenClaw source locator configuration is invalid');
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.bindings)) {
    throw new Error('OpenClaw source locator configuration is invalid');
  }
  const sourceProviderOrigin = strictHttpsOrigin(parsed.sourceProviderOrigin);
  const allowedArtifactOrigins = strictHttpsOrigins(parsed.allowedArtifactOrigins);
  if (parsed.bindings.length === 0 || parsed.bindings.length > OPENCLAW_SOURCE_CONFIG_MAX_BINDINGS) {
    throw new Error('OpenClaw source locator configuration has an invalid binding count');
  }

  const locations = new Map<string, string>();
  for (const rawBinding of parsed.bindings) {
    if (!isRecord(rawBinding)) throw new Error('OpenClaw source locator binding is invalid');
    const source = parseHostedOpenClawSource(rawBinding.source);
    const url = strictHttpsURL(rawBinding.url, allowedArtifactOrigins);
    const key = hostedOpenClawSourceKey(source);
    if (locations.has(key)) throw new Error('OpenClaw source locator contains duplicate identities');
    locations.set(key, url);
  }

  return {
    locator: {
      locate(source) {
        const url = locations.get(hostedOpenClawSourceKey(source));
        if (url === undefined) throw new Error('OpenClaw source location is not configured');
        return { url, allowedArtifactOrigins, sourceProviderOrigin };
      },
    },
    allowedArtifactOrigins,
    sourceProviderOrigin,
  };
}

/**
 * Resolve one server-side directory bearer. The official helper is invoked
 * for every directory API call; only the resolver function is retained by
 * the long-lived runtime, never the token itself.
 *
 * OIDC is deliberately restricted to the fixed skills.sh origin. A custom
 * gateway must provide its own approved credential integration rather than
 * receiving the Vercel project token.
 */
export function createDirectoryTokenProvider(env: RuntimeEnvironment): SkillsTokenProvider {
  const connection = resolveSkillsDirectoryConnection(env);
  if (connection.kind === 'gateway') return createSkillsDirectoryGatewayTokenProvider(connection.gateway);
  if (connection.kind !== 'official') return createUnavailableSkillsDirectoryTokenProvider();

  return createOfficialDirectoryTokenProvider(env);
}

/** Resolve a fresh OIDC token for the fixed canonical catalog feed. */
export function createOfficialDirectoryTokenProvider(env: RuntimeEnvironment): SkillsTokenProvider {
  const gateways = resolveSkillsDirectoryGateways(env);
  if (gateways.kind !== 'ready') return createUnavailableSkillsDirectoryTokenProvider();

  return async (signal) => {
    throwIfAborted(signal);
    const token = await getVercelOidcToken();
    throwIfAborted(signal);
    if (typeof token !== 'string' || token.trim().length === 0) {
      throw new Error(SKILLS_DIRECTORY_AUTH_UNAVAILABLE);
    }
    return token;
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedSourceString(value: unknown, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new Error('OpenClaw source identity is invalid');
  }
  if (new TextEncoder().encode(value).byteLength > OPENCLAW_SOURCE_STRING_MAX_BYTES || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('OpenClaw source identity is invalid');
  }
  // JSON.parse can create lone UTF-16 surrogates. Reject them before any URL
  // or identity construction so the locator never normalizes malformed input.
  try {
    encodeURIComponent(value);
  } catch {
    throw new Error('OpenClaw source identity is invalid');
  }
  return value;
}

function parseHostedOpenClawSource(value: unknown): OpenClawNormalizedSource {
  if (!isRecord(value)) throw new Error('OpenClaw source identity is invalid');
  const kind = boundedSourceString(value.kind);
  const sourceRef = boundedSourceString(value.sourceRef);
  if (kind === 'public-clawhub' && sourceRef === 'public-clawhub') {
    const packageName = boundedSourceString(value.packageName);
    const version = boundedSourceString(value.version);
    const artifactDigest = boundedSourceString(value.artifactDigest);
    if (!SHA256_RE.test(artifactDigest)) throw new Error('OpenClaw source identity is invalid');
    return { kind: 'public-clawhub', sourceRef: 'public-clawhub', packageName, version, artifactDigest };
  }
  if (kind === 'public-github' && sourceRef === 'public-github') {
    const repo = boundedSourceString(value.repo);
    const path = boundedSourceString(value.path, true);
    const commit = boundedSourceString(value.commit);
    const contentHash = boundedSourceString(value.contentHash);
    if (!HEX40_RE.test(commit) || !HEX64_RE.test(contentHash)) {
      throw new Error('OpenClaw source identity is invalid');
    }
    return { kind: 'public-github', sourceRef: 'public-github', repo, path, commit, contentHash };
  }
  throw new Error('OpenClaw source identity is invalid');
}

function hostedOpenClawSourceKey(source: OpenClawNormalizedSource): string {
  if (source.kind === 'public-clawhub') {
    return JSON.stringify(['public-clawhub', source.packageName, source.version, source.artifactDigest]);
  }
  return JSON.stringify(['public-github', source.repo, source.path, source.commit, source.contentHash]);
}

function strictHttpsOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new Error('OpenClaw source origin is invalid');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('OpenClaw source origin is invalid');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('OpenClaw source origin is invalid');
  }
  return parsed.origin;
}

function strictHttpsOrigins(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
    throw new Error('OpenClaw artifact origins are invalid');
  }
  const origins = [...new Set(value.map((item) => strictHttpsOrigin(item)))];
  if (origins.length === 0) throw new Error('OpenClaw artifact origins are invalid');
  return origins;
}

function strictHttpsURL(value: unknown, allowedOrigins: readonly string[]): string {
  if (typeof value !== 'string' || value.length === 0 || new TextEncoder().encode(value).byteLength > OPENCLAW_SOURCE_URL_MAX_BYTES) {
    throw new Error('OpenClaw source URL is invalid');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('OpenClaw source URL is invalid');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || !allowedOrigins.includes(parsed.origin)) {
    throw new Error('OpenClaw source URL is invalid');
  }
  return parsed.href;
}

function required(env: RuntimeEnvironment, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required setting ${name}`);
  return value;
}

export async function createInfrastructure(env: RuntimeEnvironment): Promise<{ repository: StateRepository; blobs: BlobStore; hostedWorker?: (request: Request) => Promise<Response>; directoryTokenProvider: SkillsTokenProvider; directoryOfficialTokenProvider: SkillsTokenProvider; directoryOfficialAvailable: boolean; uploadReview?: UploadReviewRuntime; createSearchIndex: (profile: EmbeddingProfile) => SemanticIndex }> {
  const production = env.PSKILLS_ENVIRONMENT !== 'development' && env.PSKILLS_ENVIRONMENT !== 'test';
  const stateFactory = () => defaultRegistryState({ production, allowUnscanned: env.PSKILLS_ALLOW_UNSCANNED === 'true' });
  const stateProvider = env.PSKILLS_STATE_PROVIDER ?? (production ? 'postgres' : 'file');
  let repository: StateRepository;
  let postgresPool: PgPoolLike | undefined;
  if (stateProvider === 'file') {
    if (production && env.PSKILLS_SINGLE_PROCESS !== 'true') throw new Error('File metadata requires PSKILLS_SINGLE_PROCESS=true or a development environment');
    repository = new FileStateRepository({ directory: env.PSKILLS_STATE_PATH ?? './work/data/state', stateFactory });
  } else if (stateProvider === 'postgres') {
    const sql = postgres(required(env, 'DATABASE_URL'), { max: 5, prepare: false, idle_timeout: 20, connect_timeout: 10 });
    const query = async (connection: typeof sql, text: string, parameters: readonly unknown[] = []) => {
      const result = await connection.unsafe(text, [...parameters] as never[]);
      return { rows: [...result], rowCount: result.count };
    };
    const pool = {
      query: (text: string, parameters?: readonly unknown[]) => query(sql, text, parameters),
      connect: async () => {
        const connection = await sql.reserve();
        return { query: (text: string, parameters?: readonly unknown[]) => query(connection as unknown as typeof sql, text, parameters), release: () => connection.release() };
      },
    } as PgPoolLike;
    postgresPool = pool;
    repository = new PostgresStateRepository(pool, { autoMigrate: true, stateFactory });
  } else if (stateProvider === 'http') {
    repository = new HttpStateRepository({ baseUrl: required(env, 'PSKILLS_STATE_ENDPOINT'), headers: { authorization: `Bearer ${required(env, 'PSKILLS_STATE_TOKEN')}` } });
  } else throw new Error('Unsupported PSKILLS_STATE_PROVIDER');

  const provider = env.PSKILLS_STORAGE_PROVIDER ?? (production ? 's3' : 'filesystem');
  const blobs = provider === 'http'
    ? new HttpBlobStore({ baseUrl: required(env, 'PSKILLS_STORAGE_ENDPOINT'), token: required(env, 'PSKILLS_STORAGE_TOKEN'), allowLoopback: !production })
    : await createNodeFilesSdkBlobStore({
      provider: (provider === 'filesystem' ? 'fs' : provider) as FilesProvider,
      root: env.PSKILLS_STORAGE_ROOT ?? './work/data/blobs',
      bucket: env.PSKILLS_STORAGE_BUCKET, container: env.PSKILLS_STORAGE_CONTAINER,
      region: env.PSKILLS_STORAGE_REGION ?? env.AWS_REGION, endpoint: env.PSKILLS_STORAGE_ENDPOINT,
      forcePathStyle: env.PSKILLS_STORAGE_PATH_STYLE === 'true', projectId: env.PSKILLS_STORAGE_PROJECT_ID,
      credentials: {
        accessKeyId: env.PSKILLS_STORAGE_ACCESS_KEY_ID ?? env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.PSKILLS_STORAGE_SECRET_ACCESS_KEY ?? env.AWS_SECRET_ACCESS_KEY,
        sessionToken: env.AWS_SESSION_TOKEN, accountId: env.PSKILLS_STORAGE_ACCOUNT_ID,
        accountName: env.PSKILLS_STORAGE_ACCOUNT_NAME, accountKey: env.PSKILLS_STORAGE_ACCOUNT_KEY,
        connectionString: env.PSKILLS_STORAGE_CONNECTION_STRING, sasToken: env.PSKILLS_STORAGE_SAS_TOKEN,
        clientEmail: env.PSKILLS_STORAGE_CLIENT_EMAIL, privateKey: env.PSKILLS_STORAGE_PRIVATE_KEY,
        token: env.BLOB_READ_WRITE_TOKEN,
      },
    });
  // The official skills.sh token provider is request-scoped. Keep the
  // resolver function in the long-lived runtime, never its token, and pass it
  // into hosted import jobs so each canonical catalog request obtains a fresh
  // project OIDC credential. Disabled directory access leaves existing
  // env-backed upstream credentials untouched. The hosted worker wires an
  // explicitly configured gateway through its separate, base-bound credential
  // seam; this callback remains the root official-origin OIDC path only.
  const directoryTokenProvider = createDirectoryTokenProvider(env);
  const directoryOfficialTokenProvider = createOfficialDirectoryTokenProvider(env);
  const directoryGateways = resolveSkillsDirectoryGateways(env);
  const directoryOfficialAvailable = directoryGateways.kind === 'ready';
  const hostedSkillsShToken = async (signal?: AbortSignal): Promise<string> => {
    const token = await directoryOfficialTokenProvider(signal);
    if (typeof token !== 'string' || token.trim().length === 0) {
      throw new Error(SKILLS_DIRECTORY_AUTH_UNAVAILABLE);
    }
    return token;
  };
  const hostedOpenClawSource = env.PSKILLS_HOSTED_WORKER === 'true'
    ? createHostedOpenClawSourceConfigFromEnv(env)
    : undefined;
  const hostedWorker = env.PSKILLS_HOSTED_WORKER === 'true'
    ? createHostedWorkerHandlerFromEnv(
      { ...env, PSKILLS_API_URL: env.PSKILLS_API_URL ?? env.PSKILLS_PUBLIC_ORIGIN },
      {
        ...(directoryOfficialAvailable ? { acquisition: { getSkillsShToken: hostedSkillsShToken } } : {}),
        ...(hostedOpenClawSource === undefined ? {} : { openClawSource: hostedOpenClawSource }),
      },
    )
    : undefined;
  const uploadReviewEnabled = env.PSKILLS_UPLOAD_REVIEW_ENABLED === 'true';
  const uploadReview = uploadReviewEnabled
    ? createUploadReviewRuntime(env, repository)
    : undefined;
  return { repository, blobs, hostedWorker, directoryTokenProvider, directoryOfficialTokenProvider, directoryOfficialAvailable, ...(uploadReview === undefined ? {} : { uploadReview }), createSearchIndex: (profile) => {
    const provider = env.PSKILLS_SEARCH_PROVIDER ?? (postgresPool ? 'pgvector' : 'state');
    if (provider === 'pgvector') {
      if (!postgresPool) throw new Error('pgvector search requires PostgreSQL metadata');
      return new PostgresSemanticIndex(postgresPool, { profile, autoMigrate: true });
    }
    if (provider !== 'state') throw new Error('Unsupported PSKILLS_SEARCH_PROVIDER');
    return new StateSemanticIndex(repository, { profile });
  } };
}

function createUploadReviewRuntime(
  env: RuntimeEnvironment,
  repository: StateRepository,
): UploadReviewRuntime {
  const organizationId = env.PSKILLS_ORGANIZATION_ID ?? 'default';
  const model = resolveUploadReviewModel(env);
  const reviewerRevision = resolveUploadReviewRevision(env);
  const resolveCurrentBinding = (state: Parameters<typeof resolveCurrentUploadReviewBinding>[0], draftId: string) =>
    resolveCurrentUploadReviewBinding(state, draftId);
  const service = createUploadReviewPersistenceService(repository, {
    resolveCurrentBinding,
    resolveCurrentContract: () => ({ model, reviewerRevision }),
  });
  const reviewerToken = env.PSKILLS_UPLOAD_REVIEW_REGISTRY_TOKEN?.trim();
  const trigger = createUploadReviewTrigger(env);
  const configured = reviewerToken !== undefined && trigger !== undefined;
  const httpHandler = configured && reviewerToken
    ? createUploadReviewHttpHandler({
      repository,
      organizationId,
      reviewerToken,
      resolveCurrentBinding,
      service,
    })
    : undefined;
  return {
    service,
    ...(trigger === undefined ? {} : { trigger }),
    ...(httpHandler === undefined ? {} : { httpHandler }),
    configured: configured && httpHandler !== undefined,
  };
}
