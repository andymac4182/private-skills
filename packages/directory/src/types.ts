/**
 * Host-neutral contracts for the public skills.sh directory API.
 *
 * The directory is a discovery source.  The files returned by the detail
 * endpoint are text data and are deliberately not interpreted or executed by
 * this package.  The registry's storage/import boundary owns any later
 * canonicalisation and policy decisions.
 */

export const SKILLS_DIRECTORY_DEFAULT_BASE_URL = 'https://skills.sh' as const;

export type SkillView = 'all-time' | 'trending' | 'hot';

export type SkillSourceType = 'github' | 'well-known';

export interface V1Skill {
  id: string;
  slug: string;
  name: string;
  source: string;
  installs: number;
  sourceType: SkillSourceType;
  installUrl: string | null;
  url: string;
  isDuplicate?: boolean;
  /** Present for the `hot` leaderboard view. */
  installsYesterday?: number;
  /** Present for the `hot` leaderboard view. */
  change?: number;
}

export interface SkillPagination {
  page: number;
  perPage: number;
  total: number;
  hasMore: boolean;
}

export interface SkillListResponse {
  data: V1Skill[];
  pagination: SkillPagination;
}

export interface ListSkillsOptions extends RequestOptions {
  view?: SkillView;
  /** Zero-indexed page number. */
  page?: number;
  /** Number of records to request, bounded to 1..500. */
  perPage?: number;
}

export type SkillSearchType = 'fuzzy' | 'semantic';

export interface SearchSkillsOptions extends RequestOptions {
  /** Minimum two Unicode code points after trimming. */
  q: string;
  /** Maximum number of records to request, bounded to 1..200. */
  limit?: number;
  /** Optional GitHub owner filter. */
  owner?: string;
}

export interface SkillSearchResponse {
  data: V1Skill[];
  query: string;
  searchType: SkillSearchType;
  count: number;
  durationMs: number;
}

export interface CuratedOwner {
  owner: string;
  totalInstalls: number;
  featuredRepo: string;
  featuredSkill: string;
  skills: V1Skill[];
}

export interface CuratedSkillsResponse {
  data: CuratedOwner[];
  totalOwners: number;
  totalSkills: number;
  generatedAt: string;
}

export interface SkillDetailFile {
  /** Relative path supplied by skills.sh. */
  path: string;
  /** Text content supplied by skills.sh; never executed by this client. */
  contents: string;
}

export interface SkillDetailResponse {
  id: string;
  source: string;
  slug: string;
  installs: number;
  /** SHA-256-like source snapshot identifier, or null when unavailable. */
  hash: string | null;
  /** Null means the upstream has no available file snapshot. */
  files: SkillDetailFile[] | null;
}

export type SkillAuditStatus = 'pass' | 'warn' | 'fail';
export type SkillAuditRiskLevel = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/**
 * Evidence from one independent skills.sh audit partner.  A partner `pass`
 * remains external evidence and is never treated as this registry's approval.
 */
export interface SkillAuditEntry {
  provider: string;
  slug: string;
  status: SkillAuditStatus;
  summary: string;
  auditedAt: string;
  riskLevel?: SkillAuditRiskLevel | null;
  categories?: string[] | null;
}

export interface SkillAuditResponse {
  id: string;
  source: string;
  slug: string;
  audits: SkillAuditEntry[];
}

export interface RequestOptions {
  /** Optional caller cancellation signal for this one request. */
  signal?: AbortSignal;
}

export interface DirectoryLimits {
  /** Maximum decoded JSON response bytes retained in memory. */
  maxResponseBytes: number;
  /** Maximum number of detail files in one response. */
  maxFiles: number;
  /** Maximum UTF-8 bytes in one relative path. */
  maxPathBytes: number;
  /** Maximum UTF-8 bytes in one text file. */
  maxTextBytes: number;
  /** Maximum UTF-8 bytes across all detail file contents. */
  maxTotalTextBytes: number;
  /** Maximum UTF-8 bytes for one metadata string. */
  maxStringBytes: number;
  /** Maximum number of attempts for one request, including the first. */
  maxAttempts: number;
  /** Maximum delay observed from Retry-After or backoff. */
  maxRetryAfterMs: number;
  /** Request deadline. */
  requestTimeoutMs: number;
}

export type SkillsFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Called for each public API request; the returned bearer is never cached. */
export type SkillsTokenProvider = (signal?: AbortSignal) => Promise<string | null | undefined>;

export type Sleep = (milliseconds: number) => Promise<void>;

export interface SkillsDirectoryClientOptions {
  /** Fixed server-configured root. Defaults to https://skills.sh. */
  baseURL?: string | URL;
  /** Injected fetch implementation, primarily for host adapters and tests. */
  fetch?: SkillsFetch;
  /** Backwards-compatible explicit name for the injected fetch. */
  fetchImpl?: SkillsFetch;
  /** Request-scoped OIDC/bearer provider. Never read at module scope. */
  getToken?: SkillsTokenProvider;
  limits?: Partial<DirectoryLimits>;
  /** Convenience alias for limits.requestTimeoutMs. */
  requestTimeoutMs?: number;
  /** Convenience alias for limits.maxAttempts. */
  maxAttempts?: number;
  /** Convenience alias for limits.maxRetryAfterMs. */
  maxRetryAfterMs?: number;
  /** Injected delay function so callers/tests can avoid wall-clock waits. */
  sleep?: Sleep;
}

export type SkillsDirectoryErrorCode =
  | 'invalid_input'
  | 'invalid_response'
  | 'unavailable'
  | 'not_found'
  | 'rate_limited'
  | 'unauthorized'
  | 'redirect_denied'
  | 'request_timeout'
  | 'http_error';

export interface SkillsDirectoryErrorOptions {
  status?: number;
  retryAfterMs?: number;
  cause?: unknown;
}

/** Sanitized, stable error returned by the directory client. */
export class SkillsDirectoryError extends Error {
  readonly code: SkillsDirectoryErrorCode;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    code: SkillsDirectoryErrorCode,
    message: string,
    options: SkillsDirectoryErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SkillsDirectoryError';
    this.code = code;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}
