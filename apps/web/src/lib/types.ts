import type {
  AuditEvent,
  CurrentSkillAdmission,
  InstallAnalytics,
  Job,
  PackVersion,
  Policy,
  Principal,
  PrincipalDisplayMetadata,
  Resolution,
  ScanResult,
  SkillBundle,
  SkillVersion,
  Upstream,
} from '../../../../packages/contracts/src/index'
import type { ReviewRun, ReviewSkillSnapshot, ReviewSuggestion } from '../../../../packages/reviews/src/index'
import type {
  CuratedOwner as CuratedOwnerBase,
  CuratedSkillsResponse as CuratedSkillsResponseBase,
  SkillAuditEntry,
  SkillAuditResponse as SkillAuditResponseBase,
  SkillDetailFile,
  SkillDetailMetadataResponse as SkillDetailMetadataResponseBase,
  SkillDetailResponse,
  SkillListResponse as DirectorySkillListResponseBase,
  SkillPagination,
  SkillSearchResponse as SkillSearchResponseBase,
  SkillSearchType,
  SkillSourceType,
  SkillsTopicLink,
  SkillsTopicResponse,
  SkillsTopicSkill,
  SkillView,
  V1Skill as V1SkillBase,
} from '../../../../packages/directory/src/index'
import type { SkillsPackManifest, SkillsPackMember } from '../../../../packages/directory-packs/src/index'
import type {
  SourceDescriptor as SourceDescriptorBase,
  SourceSearchResult as SourceSearchResultBase,
  SourceSearchResponse as SourceSearchResponseBase,
  SourceSearchSourceStatus,
  SourceCatalogListResponse,
} from '../../../../packages/source-catalog/src/types'
import type {
  IdentityMembership,
  IdentityOrganization,
  IdentityPrincipal,
  IdentityProviderPublicConfig,
  IdentityPublicConfig,
  IdentityRole,
  IdentitySession,
  IdentityUser,
} from '../../../../packages/identity/src/index'

export type {
  AuditEvent,
  CurrentSkillAdmission,
  InstallAnalytics,
  Job,
  PackVersion,
  Policy,
  Principal,
  Resolution,
  ScanResult,
  SkillBundle,
  SkillVersion,
  Upstream,
}

export type ReviewRunView = Omit<ReviewRun, 'leaseToken' | 'leaseExpiresAt'> & { snapshotValid: boolean }
export type ReviewSuggestionView = ReviewSuggestion & { snapshotValid: boolean }
export type { ReviewSkillSnapshot }

/**
 * Metadata owned by the directory adapter.  These fields describe the
 * discovery response and source freshness; they never imply private scan or
 * approval state.
 */
export interface DirectoryFreshnessMetadata {
  provider?: string
  fetchedAt?: string
  sourceStatus?: string
  sourceReason?: string
  feedName?: string | null
}

export type V1Skill = V1SkillBase & DirectoryFreshnessMetadata
export type CuratedOwner = Omit<CuratedOwnerBase, 'skills'> & { skills: V1Skill[] }
export type CuratedSkillsResponse = Omit<CuratedSkillsResponseBase, 'data'> & {
  data: CuratedOwner[]
  feedName?: string | null
}
export type DirectorySkillListResponse = Omit<DirectorySkillListResponseBase, 'data'> & {
  data: V1Skill[]
  feedName?: string | null
}
export type SkillSearchResponse = Omit<SkillSearchResponseBase, 'data'> & {
  data: V1Skill[]
  feedName?: string | null
}
export type SkillAuditResponse = SkillAuditResponseBase & { feedName?: string | null }
export type SkillDetailMetadataResponse = SkillDetailMetadataResponseBase & DirectoryFreshnessMetadata

export type {
  SkillAuditEntry,
  SkillDetailFile,
  SkillDetailResponse,
  SkillPagination,
  SkillSearchType,
  SkillSourceType,
  SkillsTopicLink,
  SkillsTopicResponse,
  SkillsTopicSkill,
  SkillView,
}
export type { SkillsPackManifest, SkillsPackMember }
export type {
  IdentityMembership,
  IdentityOrganization,
  IdentityPrincipal,
  IdentityProviderPublicConfig,
  IdentityPublicConfig,
  IdentityRole,
  IdentitySession,
  IdentityUser,
}

export interface ApiErrorShape {
  code?: string
  message?: string
  requestId?: string
  details?: unknown
  retryable?: boolean
}

/** Browser-safe identity aliases. The server-owned definitions live in packages/identity. */
export type IdentityProviderId = IdentityProviderPublicConfig['id']
export type IdentityProviderDescriptor = IdentityProviderPublicConfig
export type PublicProviderConfig = IdentityPublicConfig
export type OrganizationSummary = IdentityOrganization
export type AuthUser = IdentityUser
export type OrganizationRole = IdentityRole
export type AuthSession = IdentitySession
export type BrowserPrincipal = Principal & { display?: PrincipalDisplayMetadata }

export interface ProviderSignInResponse {
  redirect?: boolean
  url?: string
  token?: string
}

export interface TeamMember {
  id: string
  userId?: string
  user?: Pick<AuthUser, 'id' | 'name' | 'email' | 'image'>
  name?: string | null
  email?: string | null
  role: OrganizationRole
  status?: string
  createdAt?: string
  image?: string | null
}

export interface OrganizationInvitation {
  id: string
  email: string
  role: OrganizationRole
  url?: string
  status?: string
  expiresAt?: string
  createdAt?: string
  organizationId?: string
  organizationName?: string
  organizationSlug?: string
  inviterEmail?: string
}

export interface OrganizationMembersResponse { members: TeamMember[] }
export interface OrganizationInvitationsResponse { invitations: OrganizationInvitation[] }
export interface OrganizationInvitationAcceptanceResponse { invitation: OrganizationInvitation; member: TeamMember }
export interface OrganizationResponse { organization: OrganizationSummary }
export interface OrganizationListResponse { organizations: OrganizationSummary[] }

export type CatalogSkillVersion = SkillVersion & { currentAdmission?: CurrentSkillAdmission }
export interface SkillListResponse { skills: CatalogSkillVersion[] }
export interface SkillResponse { skill: CatalogSkillVersion }
export interface PackListResponse { packs: PackVersion[] }
export interface OperationListResponse { operations: Job[] }
export interface OperationsStatusResponse {
  protocolVersion: 1
  organizationId: string
  generatedAt: string
  queue: {
    state: 'clear' | 'active' | 'attention' | 'empty'
    queued: number
    running: number
    failed: number
    oldestActiveAt?: string
    oldestActiveAgeSeconds?: number
  }
  scans: {
    state: 'current' | 'attention' | 'empty'
    skills: { total: number; current: number; stale: number; failed: number; blocked: number; unavailable: number }
    enabledScannerCount: number
    requiredScannerCount: number
    evidenceMaxAgeSeconds: number
    latestCompletedAt?: string
  }
  auth: {
    state: 'unavailable'
    authenticationFailures: null
    callbackFailures: null
    reason: string
  }
  billing: {
    state: 'available' | 'unconfigured' | 'disabled' | 'unavailable'
    provider: 'stripe' | 'local' | null
    mode: 'disabled' | 'test' | 'live'
    webhookVerification: boolean
    checkout: boolean
    portal: boolean
    usageState: 'available' | 'empty' | 'unavailable'
    usage: {
      periodStart: string
      periodEnd: string
      updatedAt: string
      seats: number
      storageBytes: number
      scans: number
      eveCostCents: number
      limits: { seats: number; storageBytes: number; scansPerMonth: number; eveCostCentsPerMonth: number }
    } | null
    failureCount: null
    failureState: 'unavailable'
    reason: string
  }
  eve: {
    state: 'current' | 'attention' | 'empty' | 'unavailable'
    consolidationRuns: { total: number; running: number; completed: number; failed: number }
    uploadReviews: { total: number; pending: number; running: number; passed: number; failed: number; stale: number }
    latestFailureAt?: string
    reason?: string
  }
}
export interface ScanListResponse { scans: ScanResult[] }
export interface PolicyResponse { policy: Policy }
export interface UpstreamListResponse { upstreams: Upstream[] }
export interface AuditListResponse { events: AuditEvent[] }
export interface HealthResponse { ok: boolean; service: string; version: string }
export interface OperationResponse { operation: Job }
export interface ResolveResponse { operation?: Job; resolution?: Resolution }
export interface PublishResponse { operation?: Job; skill?: SkillVersion }
export interface ScanActionResponse { operation?: Job; skill?: SkillVersion }
export interface PackCreateResponse { pack: PackVersion }
export interface UpstreamResponse { upstream: Upstream }
export interface ImportResponse { operation: Job }
export interface DirectoryFeed {
  id: string
  name: string
  kind: 'skills-sh'
  enabled: boolean
  configRevision: string
  repositories?: string[]
  baseUrl: string
  namespace?: string
}
export interface FeedListResponse { feeds: DirectoryFeed[] }
export interface ProxyResolveResponse {
  feed: string
  externalId: string
  reference?: string
  operation?: Job
  resolution?: Resolution
}

/**
 * A source descriptor is a server-owned capability record.  It tells the
 * discovery UI whether a provider can be queried or resolved for this
 * organization; it never contains a browser credential or a direct artifact
 * URL.
 */
export type SourceDescriptor = SourceDescriptorBase
export type SourceSearchResult = SourceSearchResultBase
export type SourceSearchStatus = SourceSearchSourceStatus
export type SourceStatus = SourceDescriptorBase['availability']['state']
export type SourceCapability = SourceDescriptorBase['capabilities'][number]
export interface SourceListResponse extends SourceCatalogListResponse {}
export interface SourceSearchResponse extends SourceSearchResponseBase {}
export interface SourceResolveResponse {
  sourceId: string
  externalId: string
  reference?: string
  operation?: Job
  resolution?: Resolution
}
export interface SessionResponse { principal?: BrowserPrincipal }
export interface ReviewsResponse { runs: ReviewRunView[]; suggestions: ReviewSuggestionView[] }
export interface ReviewRunResponse { sessionId: string; status: 'started' }
export interface ReviewDecisionResponse { suggestion: ReviewSuggestionView }
export interface SemanticSearchResult {
  resourceId: string
  name: string
  skillName: string
  version: string
  description: string
  artifactDigest: `sha256:${string}`
  contentDigest: `sha256:${string}`
  score: number
  text: string
}
export interface SearchResponse { results: SemanticSearchResult[] }
export interface SearchStatusResponse { status: 'ok' | 'degraded'; provider: string; profileId?: string; error?: string }
export interface SearchReindexResponse { indexed: number; profileId: string; truncated: boolean; nextCursor?: string }

/**
 * The immutable release-file view is deliberately separate from directory
 * metadata. The manifest never includes file contents; the singular file
 * route returns bounded text only after the release has passed the server's
 * current admission checks.
 */
export type ReleaseFilePreviewState = 'text' | 'binary' | 'unsupported' | 'oversize'
export interface ReleaseFileView {
  path: string
  size: number
  contentDigest: `sha256:${string}`
  previewState: ReleaseFilePreviewState
  executable?: boolean
  contents?: string
}
export interface ReleaseFilesResponse {
  release: {
    id: string
    name: string
    skillName: string
    version: string
    digest: `sha256:${string}`
    fileCount: number
  }
  files: ReleaseFileView[]
}

export interface DraftView {
  id: string
  origin?: 'release' | 'upload'
  name: string
  skillName: string
  description?: string
  baseResourceId?: string
  baseDigest?: `sha256:${string}`
  revision: number
  digest: `sha256:${string}`
  size: number
  /** File metadata only. File bytes are fetched for one selected path. */
  files: DraftFileMetadata[]
  status: 'open' | 'publishing' | 'published' | 'discarded'
  actor: string
  createdAt: string
  updatedAt: string
  publications?: Array<{ resourceId: string; jobId: string; version: string; revision: number; digest: `sha256:${string}`; createdAt: string }>
}

/** Metadata returned for every draft path without transferring file bytes. */
export interface DraftFileMetadata {
  path: string
  size: number
  digest: `sha256:${string}`
  executable?: boolean
}

/** One selected draft file, with a bounded optional base64 text payload. */
export interface DraftFileResponseEntry extends DraftFileMetadata {
  previewState: ReleaseFilePreviewState
  content?: string
}
export interface DraftFileResponse { file: DraftFileResponseEntry }
/**
 * PUT entries for a draft revision. Inline files carry changed/new bytes;
 * references let the server copy bytes from the saved revision without
 * sending them through the browser again.
 */
export interface DraftFileReference {
  path: string
  sourcePath?: string
  digest: `sha256:${string}`
}
export type DraftFileUpdate = SkillBundle['files'][number] | DraftFileReference
export interface DraftResponse { draft: DraftView; idempotent?: boolean }
export interface DraftPublishOperation {
  id: string
  resourceId: string
  state: 'queued'
  version: string
  revision: number
  digest: `sha256:${string}`
  scanRequired: true
}
export interface DraftPublishResponse { operation: DraftPublishOperation; idempotent?: boolean }

export type BuilderConversationState = 'active' | 'stale' | 'closed'
export type BuilderMessageRole = 'user' | 'assistant' | 'system'
export type BuilderMessageState = 'queued' | 'running' | 'complete' | 'failed'
export type BuilderProposalState = 'pending' | 'proposed' | 'applied' | 'rejected' | 'stale'
export type BuilderOperationKind = 'add' | 'edit' | 'rename' | 'delete'

export interface BuilderMessage {
  id: string
  role: BuilderMessageRole
  content: string
  state?: BuilderMessageState
  createdAt: string
  proposalId?: string
}

export interface BuilderOperation {
  kind?: BuilderOperationKind
  op?: BuilderOperationKind
  path: string
  toPath?: string
  newPath?: string
  content?: string
  contentBytes?: number
  expectedPathDigest?: `sha256:${string}`
}

export interface BuilderProposal {
  id: string
  conversationId?: string
  draftId: string
  baseRevision: number
  baseDigest: `sha256:${string}`
  proposedDigest?: `sha256:${string}`
  diffDigest?: `sha256:${string}`
  operations: BuilderOperation[]
  rationale?: string
  model?: string
  builderRevision?: string
  state: BuilderProposalState
  createdAt: string
}

export interface BuilderConversation {
  id: string
  draftId: string
  draftRevision: number
  draftDigest: `sha256:${string}`
  baseResourceId?: string
  baseDigest?: `sha256:${string}`
  gateway?: string
  model?: string
  toolRevision?: string
  state: BuilderConversationState
  messages?: BuilderMessage[]
  proposals?: BuilderProposal[]
  createdAt?: string
  updatedAt?: string
}

export interface BuilderConversationResponse { conversation?: BuilderConversation; messages?: BuilderMessage[]; proposals?: BuilderProposal[] }
export interface BuilderMessageResponse { conversation?: BuilderConversation; message?: BuilderMessage; proposal?: BuilderProposal; status?: BuilderMessageState }
export interface BuilderProposalResponse { proposal?: BuilderProposal; draft?: DraftView; idempotent?: boolean }

/** Same-origin builder BFF DTOs. The browser only sees registry session data. */
export type BuilderSessionState = 'ready' | 'running' | 'stopped' | 'failed' | 'completed'
export interface BuilderSessionBinding {
  draftId: string
  revision: number
  digest: `sha256:${string}`
}
export interface BuilderSessionTurn {
  id: string
  role: BuilderMessageRole
  content: string
  createdAt: string
}
export interface BuilderSessionView {
  id: string
  binding: BuilderSessionBinding
  state: BuilderSessionState
  turns: BuilderSessionTurn[]
  proposal?: BuilderProposal | null
}
export interface BuilderSessionResponse { session: BuilderSessionView }
export interface BuilderAvailabilityResponse { enabled: boolean; reason?: string; model?: string }

export type DraftReviewState = 'pending' | 'running' | 'passed' | 'failed' | 'stale'
export type DraftReviewFindingSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical'
export type DraftReviewFindingDecision = 'open' | 'acknowledged' | 'dismissed'
export interface DraftReviewBinding {
  draftId: string
  draftRevision: number
  contentDigest: `sha256:${string}`
  baseReleaseId?: string
  baseReleaseVersion?: string
  baseDigest?: `sha256:${string}`
  policyRevision: string
}
export interface DraftReviewJob {
  id: string
  binding: DraftReviewBinding
  model: string
  reviewerRevision: string
  state: DraftReviewState
  createdAt: string
  updatedAt: string
  startedAt?: string
  finishedAt?: string
  error?: string
  staleReason?: string
  resultId?: string
}
export interface DraftReviewFinding {
  id: string
  severity: DraftReviewFindingSeverity
  category: string
  title: string
  summary: string
  evidence?: string
  recommendation?: string
  path?: string
  line?: number
  decision: DraftReviewFindingDecision
  decisionReason?: string
}
export interface DraftReviewResult {
  id: string
  jobId: string
  binding: DraftReviewBinding
  model: string
  reviewerRevision: string
  state: Extract<DraftReviewState, 'passed' | 'failed' | 'stale'>
  findings: DraftReviewFinding[]
  createdAt: string
  finishedAt: string
  error?: string
  staleReason?: string
}
export interface DraftReviewsResponse { reviews: DraftReviewJob[]; results: DraftReviewResult[] }
export interface DraftReviewResponse { review: DraftReviewJob | DraftReviewResult }
