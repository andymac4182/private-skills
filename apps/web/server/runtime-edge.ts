import { HttpStateRepository } from '../../../packages/database/src/http';
import { HttpBlobStore } from '../../../packages/storage/src/http';
import type { BlobStore, StateRepository } from '../../../packages/contracts/src/index';
export type RuntimeEnvironment = Record<string, string | undefined>;
export async function createInfrastructure(env: RuntimeEnvironment): Promise<{ repository: StateRepository; blobs: BlobStore }> {
  for (const name of ['PSKILLS_STATE_ENDPOINT', 'PSKILLS_STATE_TOKEN', 'PSKILLS_STORAGE_ENDPOINT', 'PSKILLS_STORAGE_TOKEN']) {
    if (!env[name]) throw new Error(`Edge runtime requires ${name}`);
  }
  return {
    repository: new HttpStateRepository({ baseUrl: env.PSKILLS_STATE_ENDPOINT!, headers: { authorization: `Bearer ${env.PSKILLS_STATE_TOKEN}` } }),
    blobs: new HttpBlobStore({ baseUrl: env.PSKILLS_STORAGE_ENDPOINT!, token: env.PSKILLS_STORAGE_TOKEN!, allowLoopback: env.PSKILLS_ENVIRONMENT === 'development' }),
  };
}
