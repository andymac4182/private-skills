declare module '#pskills-infrastructure' {
  export type RuntimeEnvironment = Record<string, string | undefined>;
  export function createInfrastructure(env: RuntimeEnvironment): Promise<{
    repository: import('../../../packages/contracts/src/index').StateRepository;
    blobs: import('../../../packages/contracts/src/index').BlobStore;
  }>;
}
