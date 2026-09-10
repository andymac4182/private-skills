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
  CuratedOwner,
  CuratedSkillsResponse,
  SkillAuditEntry,
  SkillAuditResponse,
  SkillDetailFile,
  SkillDetailResponse,
  SkillListResponse as DirectorySkillListResponse,
  SkillPagination,
  SkillSearchResponse,
  SkillSearchType,
  SkillSourceType,
  SkillsTopicLink,
  SkillsTopicResponse,
  SkillsTopicSkill,
  SkillView,
  V1Skill,
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
export type {
  CuratedOwner,
  CuratedSkillsResponse,
  SkillAuditEntry,
  SkillAuditResponse,
  SkillDetailFile,
  SkillDetailResponse,
  DirectorySkillListResponse,
  SkillPagination,
  SkillSearchResponse,
  SkillSearchType,
  SkillSourceType,
  SkillsTopicLink,
  SkillsTopicResponse,
  SkillsTopicSkill,
  SkillView,
  V1Skill,
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
