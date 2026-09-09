import type { PackVersion, Policy, Principal, SkillBundle, Upstream } from '../../../../packages/contracts/src/index'
import type {
  AuditListResponse, HealthResponse, ImportResponse, OperationListResponse, OperationResponse, PackCreateResponse,
  InstallAnalytics, PackListResponse, PolicyResponse, PublishResponse, ReviewDecisionResponse, ReviewRunResponse, ReviewsResponse,
  ScanActionResponse, ScanListResponse, SearchReindexResponse, SearchResponse, SearchStatusResponse, SessionResponse,
  SkillListResponse, SkillResponse, UpstreamListResponse, UpstreamResponse,
  CuratedSkillsResponse, DirectorySkillListResponse, SkillAuditResponse, SkillDetailResponse, SkillSearchResponse, SkillView,
  SkillsPackManifest,
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

export const api = {
  health() { return request<HealthResponse>('/health') },
  me() { return request<Principal>('/v1/me').then(unwrap) },
  signIn(token: string) { return request<SessionResponse>('/auth/session', { method: 'POST', body: { token } }).then(unwrap) },
  signOut() { return request<void>('/auth/session', { method: 'DELETE' }) },
  skills(query?: string) { return request<SkillListResponse>('/v1/skills', { query: { q: query } }).then(unwrap) },
  skill(id: string) { return request<SkillResponse>(`/v1/skills/${encodeURIComponent(id)}`).then(unwrap) },
  scans(artifactDigest?: string) { return request<ScanListResponse>('/v1/scans', { query: { artifactDigest } }).then(unwrap) },
  publish(input: { name: string; version: string; description: string; bundle: SkillBundle }) { return request<PublishResponse>('/v1/publish', { method: 'POST', body: input }).then(unwrap) },
  rescan(skillId: string) { return request<ScanActionResponse>(`/v1/skills/${encodeURIComponent(skillId)}/rescan`, { method: 'POST' }).then(unwrap) },
  revoke(skillId: string) { return request<ScanActionResponse>(`/v1/skills/${encodeURIComponent(skillId)}/revoke`, { method: 'POST' }).then(unwrap) },
  packs() { return request<PackListResponse>('/v1/packs').then(unwrap) },
  createPack(input: { name: string; version: string; description: string; skills: Array<{ ref: string; version: string }> }) { return request<PackCreateResponse>('/v1/packs', { method: 'POST', body: input }).then(unwrap) },
  operations() { return request<OperationListResponse>('/v1/operations').then(unwrap) },
  operation(id: string) { return request<OperationResponse>(`/v1/operations/${encodeURIComponent(id)}`).then(unwrap) },
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
  directorySkills(options: { view?: SkillView; page?: number; perPage?: number } = {}) {
    return request<DirectorySkillListResponse>('/v1/directory/skills', { query: {
      view: options.view,
      page: options.page === undefined ? undefined : String(options.page),
      per_page: options.perPage === undefined ? undefined : String(options.perPage),
    } })
  },
  directorySearch(query: string, options: { limit?: number; owner?: string } = {}) {
    return request<SkillSearchResponse>('/v1/directory/search', { query: {
      q: query,
      limit: options.limit === undefined ? undefined : String(options.limit),
      owner: options.owner,
    } })
  },
  directoryOfficial() { return request<CuratedSkillsResponse>('/v1/directory/official') },
  directoryDetail(id: string) { return request<SkillDetailResponse>('/v1/directory/detail', { query: { id } }) },
  directoryAudits(id: string) { return request<SkillAuditResponse>('/v1/directory/audits', { query: { id } }) },
  directoryImport(input: { id: string; name: string; version: string; upstreamId?: string }) {
    return request<OperationResponse>('/v1/directory/import', { method: 'POST', body: input })
  },
  directoryPackPreview(input: { url: string }) {
    return request<SkillsPackManifest>('/v1/directory/packs/preview', { method: 'POST', body: input })
  },
}
