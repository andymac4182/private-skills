import { HttpStateRepository } from '../../../packages/database/src/http';
import { HttpBlobStore } from '../../../packages/storage/src/http';
import type { BlobStore, StateRepository } from '../../../packages/contracts/src/index';
import { StateSemanticIndex } from '../../../packages/search/src/state';
import type { EmbeddingProfile, SemanticIndex } from '../../../packages/search/src/types';
import {
  createSkillsDirectoryGatewayTokenProvider,
  createUnavailableSkillsDirectoryTokenProvider,
  resolveSkillsDirectoryConnection,
  type SkillsTokenProvider,
} from '../../../packages/directory/src/index';
export type RuntimeEnvironment = Record<string, string | undefined>;

/** Edge does not import the Vercel OIDC or provider SDK; custom gateway auth is explicit and separate. */
export function createDirectoryTokenProvider(env: RuntimeEnvironment = {}): SkillsTokenProvider {
  const connection = resolveSkillsDirectoryConnection(env);
  if (connection.kind === 'gateway') return createSkillsDirectoryGatewayTokenProvider(connection.gateway);
  return createUnavailableSkillsDirectoryTokenProvider();
}

export async function createInfrastructure(env: RuntimeEnvironment): Promise<{ repository: StateRepository; blobs: BlobStore; directoryTokenProvider: SkillsTokenProvider; createSearchIndex: (profile: EmbeddingProfile) => SemanticIndex }> {
  for (const name of ['PSKILLS_STATE_ENDPOINT', 'PSKILLS_STATE_TOKEN', 'PSKILLS_STORAGE_ENDPOINT', 'PSKILLS_STORAGE_TOKEN']) {
    if (!env[name]) throw new Error(`Edge runtime requires ${name}`);
  }
  const repository = new HttpStateRepository({ baseUrl: env.PSKILLS_STATE_ENDPOINT!, headers: { authorization: `Bearer ${env.PSKILLS_STATE_TOKEN}` } });
  return {
    repository,
    directoryTokenProvider: createDirectoryTokenProvider(env),
    createSearchIndex: (profile) => new StateSemanticIndex(repository, { profile }),
    blobs: new HttpBlobStore({ baseUrl: env.PSKILLS_STORAGE_ENDPOINT!, token: env.PSKILLS_STORAGE_TOKEN!, allowLoopback: env.PSKILLS_ENVIRONMENT === 'development' }),
  };
}
