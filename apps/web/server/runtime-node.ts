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
import { createHostedWorkerHandlerFromEnv } from '../../../workers/runner/src/hosted';
import type { SkillsTokenProvider } from '../../../packages/directory/src/index';

export type RuntimeEnvironment = Record<string, string | undefined>;

const DEFAULT_DIRECTORY_BASE_URL = 'https://skills.sh';
const DIRECTORY_AUTH_UNAVAILABLE = 'skills.sh directory authentication is not configured';

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
  if (env.PSKILLS_DIRECTORY_ENABLED !== 'true') return unavailableDirectoryToken;
  const directoryBaseURL = env.PSKILLS_DIRECTORY_GATEWAY_URL
    ?? env.PSKILLS_SKILLS_SH_BASE_URL
    ?? DEFAULT_DIRECTORY_BASE_URL;
  if (!isOfficialSkillsShOrigin(directoryBaseURL)) return unavailableDirectoryToken;

  return async (signal) => {
    throwIfAborted(signal);
    const token = await getVercelOidcToken();
    throwIfAborted(signal);
    if (typeof token !== 'string' || token.trim().length === 0) {
      throw new Error(DIRECTORY_AUTH_UNAVAILABLE);
    }
    return token;
  };
}

async function unavailableDirectoryToken(): Promise<string> {
  throw new Error(DIRECTORY_AUTH_UNAVAILABLE);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
}

function isOfficialSkillsShOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === 'skills.sh'
      && url.username.length === 0
      && url.password.length === 0
      && url.port.length === 0
      && url.search.length === 0
      && url.hash.length === 0;
  } catch {
    return false;
  }
}

function required(env: RuntimeEnvironment, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required setting ${name}`);
  return value;
}

export async function createInfrastructure(env: RuntimeEnvironment): Promise<{ repository: StateRepository; blobs: BlobStore; hostedWorker?: (request: Request) => Promise<Response>; directoryTokenProvider: SkillsTokenProvider; createSearchIndex: (profile: EmbeddingProfile) => SemanticIndex }> {
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
  // into hosted import jobs so each catalog request obtains a fresh project
  // OIDC credential. Disabled directory access leaves existing env-backed
  // upstream credentials untouched.
  const directoryTokenProvider = createDirectoryTokenProvider(env);
  const hostedSkillsShToken = async (signal?: AbortSignal): Promise<string> => {
    const token = await directoryTokenProvider(signal);
    if (typeof token !== 'string' || token.trim().length === 0) {
      throw new Error(DIRECTORY_AUTH_UNAVAILABLE);
    }
    return token;
  };
  const hostedWorker = env.PSKILLS_HOSTED_WORKER === 'true'
    ? createHostedWorkerHandlerFromEnv(
      { ...env, PSKILLS_API_URL: env.PSKILLS_API_URL ?? env.PSKILLS_PUBLIC_ORIGIN },
      env.PSKILLS_DIRECTORY_ENABLED === 'true'
        ? { acquisition: { getSkillsShToken: hostedSkillsShToken } }
        : {},
    )
    : undefined;
  return { repository, blobs, hostedWorker, directoryTokenProvider, createSearchIndex: (profile) => {
    const provider = env.PSKILLS_SEARCH_PROVIDER ?? (postgresPool ? 'pgvector' : 'state');
    if (provider === 'pgvector') {
      if (!postgresPool) throw new Error('pgvector search requires PostgreSQL metadata');
      return new PostgresSemanticIndex(postgresPool, { profile, autoMigrate: true });
    }
    if (provider !== 'state') throw new Error('Unsupported PSKILLS_SEARCH_PROVIDER');
    return new StateSemanticIndex(repository, { profile });
  } };
}
