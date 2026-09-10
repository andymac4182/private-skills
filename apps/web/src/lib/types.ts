import type {
  AuditEvent,
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

export type {
  AuditEvent,
  InstallAnalytics,
  Job,
  PackVersion,
  Policy,
  Principal,
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

export interface ApiErrorShape {
  code?: string
  message?: string
  requestId?: string
  details?: unknown
  retryable?: boolean
}

export interface SkillListResponse { skills: SkillVersion[] }
export interface SkillResponse { skill: SkillVersion }
export interface PackListResponse { packs: PackVersion[] }
export interface OperationListResponse { operations: Job[] }
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
export interface SessionResponse { principal?: Principal }
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
