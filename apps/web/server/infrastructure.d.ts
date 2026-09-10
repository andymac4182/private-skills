declare module '#pskills-infrastructure' {
  export type RuntimeEnvironment = Record<string, string | undefined>;
  export function createInfrastructure(env: RuntimeEnvironment): Promise<{
    repository: import('../../../packages/contracts/src/index').StateRepository;
    blobs: import('../../../packages/contracts/src/index').BlobStore;
    hostedWorker?: (request: Request) => Promise<Response>;
    directoryTokenProvider: import('../../../packages/directory/src/index').SkillsTokenProvider;
    directoryOfficialTokenProvider: import('../../../packages/directory/src/index').SkillsTokenProvider;
    directoryOfficialAvailable: boolean;
    uploadReview?: {
      service: import('../../../packages/upload-reviews/src/index').UploadReviewPersistenceService;
      trigger?: (organizationId: string, jobId: string, service: import('../../../packages/upload-reviews/src/index').UploadReviewPersistenceService) => Promise<unknown>;
      httpHandler?: (request: Request) => Promise<Response | undefined>;
      configured: boolean;
    };
    directoryPacks?: import('../../../packages/core/src/index').RegistryDirectoryPackClient;
    createSearchIndex: (profile: import('../../../packages/search/src/types').EmbeddingProfile) => import('../../../packages/search/src/types').SemanticIndex;
  }>;
}
