import type { PackVersion, Policy, Principal, SkillBundle, Upstream } from '../../../../packages/contracts/src/index'
import type {
  AuditListResponse, HealthResponse, ImportResponse, OperationListResponse, OperationResponse, PackCreateResponse,
  InstallAnalytics, PackListResponse, PolicyResponse, PublishResponse, ReviewDecisionResponse, ReviewRunResponse, ReviewsResponse,
  ResolveResponse, ScanActionResponse, ScanListResponse, SearchReindexResponse, SearchResponse, SearchStatusResponse, SessionResponse,
  SkillListResponse, SkillResponse, UpstreamListResponse, UpstreamResponse,
  CuratedSkillsResponse, DirectorySkillListResponse, SkillAuditResponse, SkillDetailMetadataResponse, SkillSearchResponse, SkillsTopicResponse, SkillView,
  SkillsPackManifest, FeedListResponse, ProxyResolveResponse, ReleaseFilesResponse, DraftResponse, DraftPublishResponse,
  SourceListResponse, SourceSearchResponse, SourceResolveResponse,
  BuilderAvailabilityResponse, BuilderProposalResponse, BuilderSessionResponse,
  DraftFileUpdate, DraftFileResponse, DraftReviewsResponse, DraftReviewResponse,
  AuthSession, OrganizationInvitation, OrganizationInvitationsResponse, OrganizationListResponse,
  OrganizationMembersResponse, OrganizationResponse, OrganizationSummary, PublicProviderConfig,
  ProviderSignInResponse,
} from './types'

export class ApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly requestId?: string
  readonly retryable?: boolean
  readonly details?: unknown
  constructor(status: number, body: unknown, fallbackMessage = 'The registry request failed.') {
    const value = isRecord(body) && isRecord(body.error) ? body.error : isRecord(body) ? body : {}
    super(typeof value.message === 'string' ? value.message : fallbackMessage)
    this.name = 'ApiError'; this.status = status
    this.code = typeof value.code === 'string' ? value.code : undefined
    this.requestId = typeof value.requestId === 'string' ? value.requestId : undefined
    this.retryable = typeof value.retryable === 'boolean' ? value.retryable : undefined
    this.details = value.details
  }
}

export function isApiErrorCode(error: unknown, code: string): error is ApiError {
  return error instanceof ApiError && error.code === code
}

type RequestOptions = Omit<RequestInit, 'body'> & { body?: unknown; query?: Record<string, string | undefined> }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null }
async function readBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return undefined
  try { return JSON.parse(text) } catch { return { message: text } }
}
function withQuery(path: string, query?: Record<string, string | undefined>) {
  if (!query) return path
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') params.set(key, value)
  const suffix = params.toString()
  return suffix ? `${path}?${suffix}` : path
}
async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers)
  headers.set('accept', 'application/json')
  if (options.body !== undefined) headers.set('content-type', 'application/json')
  const response = await fetch(withQuery(path, options.query), { ...options, body: options.body === undefined ? undefined : JSON.stringify(options.body), credentials: 'include', headers })
  const body = await readBody(response)
  if (!response.ok) throw new ApiError(response.status, body)
  return body as T
}
function unwrap<T>(value: T | { data: T }): T { return isRecord(value) && 'data' in value ? value.data as T : value as T }

function unwrapSession(value: unknown): AuthSession | null {
  const payload = unwrap(value as AuthSession | { session?: AuthSession } | null)
  if (!payload) return null
  return isRecord(payload) && 'session' in payload ? payload.session as AuthSession | null : payload as AuthSession
}

function unwrapProviders(value: unknown): PublicProviderConfig {
  const payload = unwrap(value as PublicProviderConfig | { config?: PublicProviderConfig })
  if (isRecord(payload) && 'config' in payload && isRecord(payload.config)) return payload.config as PublicProviderConfig
  return payload as PublicProviderConfig
}

function identityBasePath(value: string): string {
  if (value.startsWith('//') || !/^\/[a-z0-9/_-]*$/iu.test(value)) throw new Error('The identity authentication base path is invalid.')
  const normalized = value.replace(/\/+$/u, '')
  return normalized || identityRoutes.betterAuthBase
}

/**
 * Keep identity endpoints in one place. `/auth/session` remains the legacy
 * registry-token exchange; identity session/config are sanitized Nitro
 * routes, while organization actions are Better Auth organization plugin
 * endpoints under its configured handler.
 */
export const identityRoutes = {
  config: '/auth/identity/config',
  session: '/auth/identity/session',
  betterAuthBase: '/api/auth',
  createOrganization: '/api/auth/organization/create',
  listOrganizations: '/api/auth/organization/list',
  activeOrganization: '/api/auth/organization/set-active',
  members: '/api/auth/organization/list-members',
  invitations: '/api/auth/organization/list-invitations',
  inviteMember: '/api/auth/organization/invite-member',
  updateMemberRole: '/api/auth/organization/update-member-role',
} as const

export const api = {
  health() { return request<HealthResponse>('/health') },
  me() { return request<Principal>('/v1/me').then(unwrap) },
  signIn(token: string) { return request<SessionResponse>('/auth/session', { method: 'POST', body: { token } }).then(unwrap) },
  signOut() { return request<void>('/auth/session', { method: 'DELETE' }) },
  /** Public metadata only; provider credentials never cross this boundary. */
  authProviders() { return request<PublicProviderConfig>(identityRoutes.config).then(unwrapProviders) },
  /** Better Auth session data is sanitized by the server before it reaches the browser. */
  authSession() { return request<AuthSession | { session?: AuthSession }>(identityRoutes.session).then(unwrapSession) },
  authSignIn(provider: string, callbackURL: string, basePath: string = identityRoutes.betterAuthBase) {
    return request<ProviderSignInResponse>(`${identityBasePath(basePath)}/sign-in/social`, {
      method: 'POST', body: { provider, callbackURL },
    }).then(unwrap)
  },
  authSignOut(basePath: string = identityRoutes.betterAuthBase) {
    return request<void>(`${identityBasePath(basePath)}/sign-out`, { method: 'POST' })
  },
  listOrganizations() {
    return request<OrganizationSummary[] | OrganizationListResponse>(identityRoutes.listOrganizations).then((value) => {
      const payload = unwrap(value)
      return Array.isArray(payload) ? { organizations: payload } : payload
    })
  },
  createOrganization(input: { name: string; slug?: string }) {
    return request<OrganizationSummary | OrganizationResponse>(identityRoutes.createOrganization, { method: 'POST', body: input }).then((value) => {
      const payload = unwrap(value)
      if (isRecord(payload) && 'organization' in payload && isRecord(payload.organization)) return payload as OrganizationResponse
      return { organization: payload as OrganizationSummary }
    })
  },
  switchOrganization(organizationId: string) {
    return request<OrganizationSummary | null>(identityRoutes.activeOrganization, { method: 'POST', body: { organizationId } }).then(unwrap)
  },
  organizationMembers() { return request<OrganizationMembersResponse>(identityRoutes.members).then(unwrap) },
  organizationInvitations() {
    return request<OrganizationInvitation[] | OrganizationInvitationsResponse>(identityRoutes.invitations).then((value) => {
      const payload = unwrap(value)
      return Array.isArray(payload) ? { invitations: payload } : payload
    })
  },
  inviteOrganizationMember(input: { email: string; role: string }) {
    return request<OrganizationInvitation | { invitation: OrganizationInvitation }>(identityRoutes.inviteMember, { method: 'POST', body: input }).then((value) => {
      const payload = unwrap(value)
      if (isRecord(payload) && 'invitation' in payload && isRecord(payload.invitation)) return payload.invitation as OrganizationInvitation
      return payload as OrganizationInvitation
    })
  },
  updateOrganizationMemberRole(memberId: string, role: string) {
    return request<void>(identityRoutes.updateMemberRole, { method: 'POST', body: { memberId, role } })
  },
  skills(query?: string) { return request<SkillListResponse>('/v1/skills', { query: { q: query } }).then(unwrap) },
  skill(id: string) { return request<SkillResponse>(`/v1/skills/${encodeURIComponent(id)}`).then(unwrap) },
  resolve(input: { kind: 'skill' | 'pack'; ref: string; version?: string }) { return request<ResolveResponse>('/v1/resolve', { method: 'POST', body: input }).then(unwrap) },
  scans(artifactDigest?: string) { return request<ScanListResponse>('/v1/scans', { query: { artifactDigest } }).then(unwrap) },
  publish(input: { name: string; version: string; description: string; bundle: SkillBundle }) { return request<PublishResponse>('/v1/publish', { method: 'POST', body: input }).then(unwrap) },
  rescan(skillId: string) { return request<ScanActionResponse>(`/v1/skills/${encodeURIComponent(skillId)}/rescan`, { method: 'POST' }).then(unwrap) },
  revoke(skillId: string) { return request<ScanActionResponse>(`/v1/skills/${encodeURIComponent(skillId)}/revoke`, { method: 'POST' }).then(unwrap) },
  packs() { return request<PackListResponse>('/v1/packs').then(unwrap) },
  createPack(input: { name: string; version: string; description: string; skills: Array<{ ref: string; version: string }> }) { return request<PackCreateResponse>('/v1/packs', { method: 'POST', body: input }).then(unwrap) },
  operations() { return request<OperationListResponse>('/v1/operations').then(unwrap) },
  operation(id: string) { return request<OperationResponse>(`/v1/operations/${encodeURIComponent(id)}`).then(unwrap) },
  releaseFiles(resourceId: string, signal?: AbortSignal) { return request<ReleaseFilesResponse>(`/v1/skills/${encodeURIComponent(resourceId)}/files`, { signal }).then(unwrap) },
  releaseFile(resourceId: string, path: string, signal?: AbortSignal) { return request<ReleaseFilesResponse>(`/v1/skills/${encodeURIComponent(resourceId)}/file`, { query: { path }, signal }).then(unwrap) },
  createDraft(resourceId: string, baseDigest: `sha256:${string}`, idempotencyKey: string) {
    return request<DraftResponse>(`/v1/skills/${encodeURIComponent(resourceId)}/drafts`, { method: 'POST', body: { baseDigest }, headers: { 'idempotency-key': idempotencyKey } }).then(unwrap)
  },
  createUploadDraft(input: { name: string; files: SkillBundle['files']; idempotencyKey: string }) {
    return request<DraftResponse>('/v1/drafts', { method: 'POST', body: { name: input.name, files: input.files }, headers: { 'idempotency-key': input.idempotencyKey } }).then(unwrap)
  },
  draft(draftId: string, signal?: AbortSignal) { return request<DraftResponse>(`/v1/drafts/${encodeURIComponent(draftId)}`, { signal }).then(unwrap) },
  draftFile(draftId: string, path: string, input: { revision: number; digest: `sha256:${string}` }, signal?: AbortSignal) {
    return request<DraftFileResponse>(`/v1/drafts/${encodeURIComponent(draftId)}/files`, {
      query: { path, revision: String(input.revision), digest: input.digest },
      signal,
    }).then(unwrap)
  },
  updateDraft(draftId: string, input: { expectedRevision: number; expectedDigest?: `sha256:${string}`; files: DraftFileUpdate[]; idempotencyKey: string }) {
    return request<DraftResponse>(`/v1/drafts/${encodeURIComponent(draftId)}`, {
      method: 'PUT',
      body: {
        expectedRevision: input.expectedRevision,
        ...(input.expectedDigest === undefined ? {} : { expectedDigest: input.expectedDigest }),
        files: input.files,
      },
      headers: { 'idempotency-key': input.idempotencyKey },
    }).then(unwrap)
  },
  publishDraft(draftId: string, input: { expectedRevision: number; version: string; idempotencyKey: string }) {
    return request<DraftPublishResponse>(`/v1/drafts/${encodeURIComponent(draftId)}/publish`, { method: 'POST', body: { expectedRevision: input.expectedRevision, version: input.version }, headers: { 'idempotency-key': input.idempotencyKey } }).then(unwrap)
  },
  draftReviews(draftId: string) {
    return request<DraftReviewsResponse>(`/v1/drafts/${encodeURIComponent(draftId)}/reviews`)
  },
  requestDraftReview(draftId: string) {
    return request<DraftReviewResponse>(`/v1/drafts/${encodeURIComponent(draftId)}/reviews`, { method: 'POST', body: {} }).then(unwrap)
  },
  retryDraftReview(draftId: string, jobId: string) {
    return request<DraftReviewResponse>(`/v1/drafts/${encodeURIComponent(draftId)}/reviews/${encodeURIComponent(jobId)}/retry`, { method: 'POST', body: {} }).then(unwrap)
  },
  decideDraftReview(draftId: string, resultId: string, input: { findingId: string; decision: 'open' | 'acknowledged' | 'dismissed'; reason?: string }) {
    return request<DraftReviewResponse>(`/v1/drafts/${encodeURIComponent(draftId)}/reviews/${encodeURIComponent(resultId)}/decisions`, { method: 'POST', body: input }).then(unwrap)
  },
  builderAvailability(draftId: string, signal?: AbortSignal) {
    return request<BuilderAvailabilityResponse>(`/v1/drafts/${encodeURIComponent(draftId)}/builder/availability`, { signal }).then(unwrap)
  },
  builderCreateSession(draftId: string, input: { revision: number; digest: `sha256:${string}`; requestId: string }, signal?: AbortSignal) {
    return request<BuilderSessionResponse>(`/v1/drafts/${encodeURIComponent(draftId)}/builder/session`, {
      method: 'POST',
      query: { revision: String(input.revision), digest: input.digest },
      body: input,
      signal,
    }).then(unwrap)
  },
  builderSession(draftId: string, sessionId: string, input: { revision: number; digest: `sha256:${string}` }, signal?: AbortSignal) {
    return request<BuilderSessionResponse>(`/v1/drafts/${encodeURIComponent(draftId)}/builder/session/${encodeURIComponent(sessionId)}`, { query: { revision: String(input.revision), digest: input.digest }, signal }).then(unwrap)
  },
  builderPrompt(draftId: string, sessionId: string, input: { revision: number; digest: `sha256:${string}`; prompt: string; requestId: string; selectedPath?: string }, signal?: AbortSignal) {
    return request<BuilderSessionResponse>(`/v1/drafts/${encodeURIComponent(draftId)}/builder/session/${encodeURIComponent(sessionId)}/prompt`, { method: 'POST', query: { revision: String(input.revision), digest: input.digest }, body: { prompt: input.prompt, requestId: input.requestId, ...(input.selectedPath ? { selectedPath: input.selectedPath } : {}) }, signal }).then(unwrap)
  },
  builderStop(draftId: string, sessionId: string, input: { revision: number; digest: `sha256:${string}`; requestId: string }, signal?: AbortSignal) {
    return request<void>(`/v1/drafts/${encodeURIComponent(draftId)}/builder/session/${encodeURIComponent(sessionId)}/stop`, { method: 'POST', query: { revision: String(input.revision), digest: input.digest }, body: { requestId: input.requestId }, signal })
  },
  applyBuilderProposal(draftId: string, proposalId: string, input: { revision: number; digest: `sha256:${string}`; sessionId: string; idempotencyKey: string; signal?: AbortSignal }) {
    return request<BuilderProposalResponse>(`/v1/drafts/${encodeURIComponent(draftId)}/proposals/${encodeURIComponent(proposalId)}/apply`, { method: 'POST', body: { revision: input.revision, digest: input.digest, sessionId: input.sessionId }, headers: { 'idempotency-key': input.idempotencyKey }, signal: input.signal }).then(unwrap)
  },
  rejectBuilderProposal(draftId: string, proposalId: string, input: { revision: number; digest: `sha256:${string}`; sessionId: string; idempotencyKey: string; signal?: AbortSignal }) {
    return request<BuilderProposalResponse>(`/v1/drafts/${encodeURIComponent(draftId)}/proposals/${encodeURIComponent(proposalId)}/reject`, { method: 'POST', body: { revision: input.revision, digest: input.digest, sessionId: input.sessionId }, headers: { 'idempotency-key': input.idempotencyKey }, signal: input.signal }).then(unwrap)
  },
  policy() { return request<PolicyResponse>('/v1/policy').then(unwrap) },
  updatePolicy(policy: Policy) {
    const { revision: _revision, ...next } = policy
    return request<PolicyResponse>('/v1/policy', { method: 'PUT', body: next }).then(unwrap)
  },
  upstreams() { return request<UpstreamListResponse>('/v1/upstreams').then(unwrap) },
  createUpstream(input: Omit<Upstream, 'id' | 'organizationId' | 'enabled'> & { enabled?: boolean }) { return request<UpstreamResponse>('/v1/upstreams', { method: 'POST', body: input }).then(unwrap) },
  importUpstream(input: { upstreamId: string; repository?: string; path: string; ref?: string; name: string; version: string }) { return request<ImportResponse>('/v1/imports', { method: 'POST', body: input }).then(unwrap) },
  audit() { return request<AuditListResponse>('/v1/audit').then(unwrap) },
  analytics(days = 30) { return request<InstallAnalytics>('/v1/analytics', { query: { days: String(days) } }).then(unwrap) },
  reviews() { return request<ReviewsResponse>('/v1/reviews').then(unwrap) },
  startReview() { return request<ReviewRunResponse>('/v1/reviews/run', { method: 'POST', body: {} }).then(unwrap) },
  decideReview(suggestionId: string, decision: 'accepted' | 'dismissed') { return request<ReviewDecisionResponse>(`/v1/reviews/${encodeURIComponent(suggestionId)}/decision`, { method: 'POST', body: { decision } }).then(unwrap) },
  search(query: string) { return request<SearchResponse>('/v1/search', { query: { q: query } }).then(unwrap) },
  searchStatus() { return request<SearchStatusResponse>('/v1/search/status').then(unwrap) },
  reindexSearch(cursor?: string) { return request<SearchReindexResponse>('/v1/search/reindex', { method: 'POST', body: cursor ? { cursor } : {} }).then(unwrap) },
  directorySkills(options: { view?: SkillView; page?: number; perPage?: number; feed?: string } = {}) {
    return request<DirectorySkillListResponse>('/v1/directory/skills', { query: {
      view: options.view,
      page: options.page === undefined ? undefined : String(options.page),
      per_page: options.perPage === undefined ? undefined : String(options.perPage),
      feed: options.feed,
    } })
  },
  directorySearch(query: string, options: { limit?: number; owner?: string; feed?: string } = {}) {
    return request<SkillSearchResponse>('/v1/directory/search', { query: {
      q: query,
      limit: options.limit === undefined ? undefined : String(options.limit),
      owner: options.owner,
      feed: options.feed,
    } })
  },
  directoryOfficial(options: { feed?: string } = {}) { return request<CuratedSkillsResponse>('/v1/directory/official', { query: { feed: options.feed } }) },
  directoryTopic(slug: string) { return request<SkillsTopicResponse>('/v1/directory/topic', { query: { slug } }) },
  directoryDetail(id: string, options: { feed?: string } = {}) { return request<SkillDetailMetadataResponse>('/v1/directory/detail', { query: { id, feed: options.feed } }) },
  directoryAudits(id: string, options: { feed?: string } = {}) { return request<SkillAuditResponse>('/v1/directory/audits', { query: { id, feed: options.feed } }) },
  feeds() { return request<FeedListResponse>('/v1/feeds') },
  sources() { return request<SourceListResponse>('/v1/sources') },
  sourceSearch(query: string, options: { source?: string; limit?: number } = {}) {
    return request<SourceSearchResponse>('/v1/sources/search', { query: {
      q: query,
      source: options.source,
      limit: options.limit === undefined ? undefined : String(options.limit),
    } })
  },
  sourceResolve(sourceId: string, input: { externalId: string; refresh?: boolean }) {
    return request<SourceResolveResponse>(`/v1/sources/${encodeURIComponent(sourceId)}/resolve`, { method: 'POST', body: input })
  },
  directoryImport(input: { id: string; name: string; version: string; upstreamId?: string }) {
    return request<OperationResponse>('/v1/directory/import', { method: 'POST', body: input })
  },
  proxyResolve(input: { feed: string; externalId: string; refresh?: boolean }) {
    return request<ProxyResolveResponse>('/v1/proxy/resolve', { method: 'POST', body: input })
  },
  directoryPackPreview(input: { url: string }) {
    return request<SkillsPackManifest>('/v1/directory/packs/preview', { method: 'POST', body: input })
  },
}
