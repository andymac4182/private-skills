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
    /** Optional Node-owned identity runtime; edge leaves Better Auth out. */
    identity?: {
      handler: (request: Request) => Promise<Response>;
      authenticate: (request: Request) => Promise<import('../../../packages/contracts/src/index').Principal | null>;
      getSession?: (request: Request) => Promise<import('./tenant-runtime').TenantSessionSnapshot | null>;
      publicProviderConfig: () => unknown;
      onboarding?: () => unknown;
    };
    apiTokens?: {
      handler: import('../../../packages/api-tokens/src/index').ApiTokenHandler;
      authenticator: import('../../../packages/contracts/src/index').Authenticator;
    };
    directoryPacks?: import('../../../packages/core/src/index').RegistryDirectoryPackClient;
    createSearchIndex: (profile: import('../../../packages/search/src/types').EmbeddingProfile) => import('../../../packages/search/src/types').SemanticIndex;
  }>;
}
