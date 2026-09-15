declare module '#pskills-infrastructure' {
  export type RuntimeEnvironment = Record<string, string | undefined>;
  export function createInfrastructure(env: RuntimeEnvironment): Promise<{
    repository: import('../../../packages/contracts/src/index').StateRepository;
    blobs: import('../../../packages/contracts/src/index').BlobStore;
    billing: {
      service: import('../../../packages/billing/src/index').BillingService;
      invoiceHistory?: (lookup: import('../../../packages/billing/src/index').BillingInvoiceLookup) => Promise<readonly import('../../../packages/billing/src/index').BillingProviderInvoice[]>;
    };
    /** Optional Node-owned durable storage-attempt reconciler. */
    storageRecovery?: import('../../../packages/storage/src/index').StorageRecoveryService;
    hostedWorker?: (request: Request) => Promise<Response>;
    /** Optional durable cross-company worker dispatcher for the cron route. */
    hostedWorkerDispatcher?: (request: Request) => Promise<Response>;
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
    /** Optional platform-only Better Auth seat recovery capability. */
    billingRecovery?: {
      activeSeatReservations: (organizationId: string) => Promise<readonly import('../../../packages/billing/src/index').BillingSeatReservation[]>;
      recoverFailedSeat: (input: {
        organizationId: string;
        operationKey: string;
        subjectKind: 'member' | 'invitation';
        subjectId: string;
        proof: import('../../../packages/billing/src/index').BillingSeatRecoveryProof;
      }) => Promise<import('../../../packages/billing/src/index').BillingSeatRecoveryResult>;
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
    /** Optional durable identity operations counters and event sink. */
    operationsEvents?: import('../../../packages/identity/src/index').IdentityOperationsEventSink;
    /** Explicit Better Auth user + bootstrap-owner adoption transaction. */
    bootstrapAdoptionStore?: import('./bootstrap-adoption').BootstrapAdoptionStore;
    /** Optional Node-owned provider for verified private CLI release archives. */
    cliReleaseProvider?: import('../../../packages/cli-release/src/index').CliReleaseAssetProvider;
    /** Server-owned Better Auth organization enumeration for daily Eve dispatch. */
    listTenantReviewTargets?: () => Promise<readonly import('./tenant-review-dispatch').TenantReviewTarget[]>;
    directoryPacks?: import('../../../packages/core/src/index').RegistryDirectoryPackClient;
    createSearchIndex: (profile: import('../../../packages/search/src/types').EmbeddingProfile) => import('../../../packages/search/src/types').SemanticIndex;
  }>;
}
