declare module '#pskills-infrastructure' {
  export type RuntimeEnvironment = Record<string, string | undefined>;
  export function createInfrastructure(env: RuntimeEnvironment): Promise<{
    repository: import('../../../packages/contracts/src/index').StateRepository;
    blobs: import('../../../packages/contracts/src/index').BlobStore;
    hostedWorker?: (request: Request) => Promise<Response>;
    directoryTokenProvider: import('../../../packages/directory/src/index').SkillsTokenProvider;
    directoryPacks?: import('../../../packages/core/src/index').RegistryDirectoryPackClient;
    createSearchIndex: (profile: import('../../../packages/search/src/types').EmbeddingProfile) => import('../../../packages/search/src/types').SemanticIndex;
  }>;
}
