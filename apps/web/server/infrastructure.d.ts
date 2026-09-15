declare module '#pskills-infrastructure' {
  export type RuntimeEnvironment = Record<string, string | undefined>;
  export function createInfrastructure(env: RuntimeEnvironment): Promise<{
    repository: import('../../../packages/contracts/src/index').StateRepository;
    blobs: import('../../../packages/contracts/src/index').BlobStore;
    billing: {
      service: import('../../../packages/billing/src/index').BillingService;
      invoiceHistory?: (lookup: import('../../../packages/billing/src/index').BillingInvoiceLookup) => Promise<readonly import('../../../packages/billing/src/index').BillingProviderInvoice[]>;
    };
    hostedWorker?: (request: Request) => Promise<Response>;
    /** Optional signed worker factory bound to one server-selected tenant. */
    createHostedWorkerForTenant?: (organizationId: string) => ((request: Request) => Promise<Response>) | undefined;
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
    /** Optional Node-owned company SSO registry and Better Auth bridge. */
    companySso?: {
      handler: (request: Request) => Promise<Response | undefined>;
      listPublicProviders?: (organizationId: string) => Promise<readonly {
        providerId: string;
        displayName: string;
        protocol: 'oidc' | 'saml';
        status: 'active' | 'disabled';
      }[]>;
      getProviderForOrganization?: (organizationId: string, providerId: string) => Promise<{
        providerId: string;
        organizationId: string;
        protocol: 'oidc' | 'saml';
        status: 'active' | 'disabled';
      } | null>;
      selectProvider?: (organizationId: string, providerId: string, appOrigin: string, allowLoopbackHttp?: boolean) => Promise<{
        organizationId: string;
        providerId: string;
        callbackURL: string;
      } | null>;
    };
    /** Explicit Better Auth user + bootstrap-owner adoption transaction. */
    bootstrapAdoptionStore?: import('./bootstrap-adoption').BootstrapAdoptionStore;
    directoryPacks?: import('../../../packages/core/src/index').RegistryDirectoryPackClient;
    createSearchIndex: (profile: import('../../../packages/search/src/types').EmbeddingProfile) => import('../../../packages/search/src/types').SemanticIndex;
  }>;
}
