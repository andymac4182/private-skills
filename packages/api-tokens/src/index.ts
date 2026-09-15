import { normalizePrincipalDisplayMetadata, type Authenticator, type Principal, type Role, type PrincipalDisplayMetadata } from '../../contracts/src/index.js';

/**
 * Company scoped API tokens are deliberately independent from the bootstrap
 * token authenticator. Better Auth (or another identity provider) remains
 * authoritative for browser sessions and memberships; this package only
 * consumes a small identity interface and persists hashed service-token
 * records.
 */

export const API_TOKEN_PROTOCOL_VERSION = 1 as const;
export const DEFAULT_API_TOKEN_TABLE = 'private_skills_service_tokens';
export const DEFAULT_API_TOKEN_PREFIX = 'psk_';
export const DEFAULT_API_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;
export const DEFAULT_API_TOKEN_MAX_TTL_SECONDS = 365 * 24 * 60 * 60;
export const DEFAULT_API_TOKEN_MAX_LIST = 100;
export const API_TOKEN_ID_MAX_LENGTH = 128;
export const API_TOKEN_NAME_MAX_LENGTH = 128;
export const API_TOKEN_SCOPE_MAX_LENGTH = 128;
export const API_TOKEN_MAX_SCOPES = 64;
export const API_TOKEN_SESSION_PROTOCOL_VERSION = 1 as const;
export const DEFAULT_API_TOKEN_SESSION_COOKIE = 'pskills_session';

const API_TOKEN_SESSION_AUDIENCE = 'private-skills-api-token';
const API_TOKEN_SESSION_COOKIE_PREFIX = 'api-token-session-v1';
const API_TOKEN_SESSION_COOKIE_MAX_LENGTH = 8_192;

const VALID_ROLES: readonly Role[] = ['owner', 'admin', 'publisher', 'reader'];
const ROLE_NAMES: readonly Role[] = [...VALID_ROLES, 'worker'];
const ROLE_RANK: Readonly<Record<Role, number>> = {
  owner: 4,
  admin: 3,
  publisher: 2,
  reader: 1,
  worker: 0,
};

/** Better Auth's organization plugin commonly uses member/manager names. */
export type IdentityRole = Role | 'member' | 'manager';

export interface OrganizationSession {
  /** Better Auth user id. */
  userId: string;
  /** Better Auth active organization id. */
  organizationId: string;
  sessionId?: string;
}

/** Raw session shapes accepted at the Better Auth adapter boundary. */
export interface OrganizationSessionLike extends Partial<OrganizationSession> {
  subject?: string;
  orgId?: string;
  activeOrganizationId?: string;
  user?: { id?: string };
  session?: { userId?: string; activeOrganizationId?: string; id?: string };
}

export interface MembershipSnapshot {
  userId: string;
  organizationId: string;
  roles?: readonly IdentityRole[];
  role?: IdentityRole;
  scopes?: readonly string[];
  active?: boolean;
  /** Server-derived labels used only for authenticated UI display. */
  display?: PrincipalDisplayMetadata;
}

/** Identity provider seam. Better Auth owns both methods in the runtime. */
export interface MembershipAuthorizer {
  getOrganizationSession(request: Request): Promise<OrganizationSessionLike | null>;
  getMembership(organizationId: string, userId: string): Promise<MembershipSnapshot | null>;
}

export type OrganizationIdentity = MembershipAuthorizer;
export type BetterAuthOrganizationSession = OrganizationSession;

export interface ApiTokenRecord {
  id: string;
  organizationId: string;
  userId: string;
  name: string;
  /** SHA-256 token hash in `sha256:<64 lowercase hex>` form. */
  tokenHash: string;
  roleCeiling: Role;
  scopes: string[];
  expiresAt: string;
  createdAt: string;
  revokedAt?: string;
}

export interface ApiTokenPrincipal extends Principal {
  identity: 'user';
  tokenId: string;
}

/** Metadata safe to return from list operations. It intentionally has no hash. */
export interface ApiTokenMetadata {
  id: string;
  organizationId: string;
  userId: string;
  name: string;
  roleCeiling: Role;
  scopes: string[];
  expiresAt: string;
  createdAt: string;
  revokedAt?: string;
}

export interface CreateApiTokenInput {
  name: string;
  roleCeiling?: IdentityRole;
  role?: IdentityRole;
  scopes?: readonly string[];
  expiresAt?: string | number;
  expiresInSeconds?: number;
  /** Optional compatibility field; it must match the active session org. */
  organizationId?: string;
}

export interface CreateApiTokenResult extends ApiTokenMetadata {
  /** The only response that contains the raw secret. It is never persisted. */
  token: string;
}

/** Browser session material returned after a verified API-token exchange. */
export interface ApiTokenSessionResult {
  /** Signed cookie value; the raw API-token secret is never included. */
  cookie: string;
  principal: Principal;
}

export interface ApiTokenListOptions {
  includeRevoked?: boolean;
  subject?: string;
  limit?: number;
}

export interface NormalizedMembership {
  userId: string;
  organizationId: string;
  roles: Role[];
  scopes: string[];
  display?: PrincipalDisplayMetadata;
}

export interface ApiTokenManagementContext extends OrganizationSession {
  membership: NormalizedMembership;
}

export interface ApiTokenAuditEvent {
  action: 'api_token.created' | 'api_token.revoked';
  organizationId: string;
  actorId: string;
  /** Existing registry audit adapters can map these aliases directly. */
  subject?: string;
  resourceId?: string;
  tokenId: string;
  createdAt: string;
  /** Safe metadata only: no token, hash, credentials, or report contents. */
  details: {
    roleCeiling?: Role;
    expiresAt?: string;
    scopeCount?: number;
  };
}

export interface ApiTokenAuditSink {
  append(event: ApiTokenAuditEvent): Promise<void> | void;
}

export interface ApiTokenRepository {
  create(record: ApiTokenRecord): Promise<void>;
  findByHash(tokenHash: string): Promise<ApiTokenRecord | null>;
  findById(organizationId: string, tokenId: string): Promise<ApiTokenRecord | null>;
  list(organizationId: string, options?: { subject?: string; limit?: number }): Promise<ApiTokenRecord[]>;
  revoke(organizationId: string, tokenId: string, revokedAt: string): Promise<ApiTokenRecord | null>;
}

export class ApiTokenError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'ApiTokenError';
    this.code = code;
    this.status = status;
  }
}

export class ApiTokenConfigurationError extends ApiTokenError {
  constructor(message: string) {
    super('API_TOKEN_CONFIGURATION', message, 500);
    this.name = 'ApiTokenConfigurationError';
  }
}

export class ApiTokenRepositoryError extends ApiTokenError {
  constructor(message: string) {
    super('API_TOKEN_REPOSITORY', message, 500);
    this.name = 'ApiTokenRepositoryError';
  }
}

export type ApiTokenGenerator = () => string | Promise<string>;

export interface ApiTokenServiceOptions {
  repository: ApiTokenRepository;
  membershipAuthorizer: MembershipAuthorizer;
  audit?: ApiTokenAuditSink;
  now?: () => number;
  tokenGenerator?: ApiTokenGenerator;
  tokenPrefix?: string;
  defaultTtlSeconds?: number;
  maxTtlSeconds?: number;
  maxList?: number;
  /** Durable secret used to sign the optional browser session reference. */
  sessionSecret?: string | Uint8Array;
  /** Cookie name shared with the legacy registry session. */
  sessionCookieName?: string;
  /** Secure flag for the browser session cookie. Defaults to true. */
  sessionSecureCookies?: boolean;
}

export interface ApiTokenService {
  createToken(context: OrganizationSession, input: CreateApiTokenInput): Promise<CreateApiTokenResult>;
  listTokens(context: OrganizationSession, options?: ApiTokenListOptions): Promise<ApiTokenMetadata[]>;
  revokeToken(context: OrganizationSession, tokenId: string): Promise<ApiTokenMetadata>;
  authenticateBearerToken(rawToken: string): Promise<Principal | null>;
  authenticate(request: Request): Promise<Principal | null>;
  /** Exchange a verified persisted token for a revocation-aware browser session. */
  createSession(rawToken: string): Promise<ApiTokenSessionResult | null>;
  clearSessionCookie(): string;
  resolveManagementContext(request: Request, options?: { requireCookie?: boolean }): Promise<ApiTokenManagementContext>;
}

export interface ApiTokenModule {
  service: ApiTokenService;
  authenticator: Authenticator;
  handler: ApiTokenHandler;
}

export type ApiTokenHandler = (request: Request) => Promise<Response | undefined>;

export interface CreateApiTokenModuleOptions extends ApiTokenServiceOptions {
  routePrefix?: string;
  maxBodyBytes?: number;
  /** The canonical browser origin allowed to mutate cookie-authenticated tokens. */
  canonicalOrigin?: string;
  /** Additional exact origins trusted for cookie-authenticated mutations. */
  trustedOrigins?: readonly string[];
  /** Default `deny` protects cookie mutations when browsers omit Origin. */
  missingOrigin?: 'deny' | 'allow';
}

function cryptoProvider(): Crypto {
  const candidate = (globalThis as typeof globalThis & { crypto?: Crypto }).crypto;
  if (!candidate?.subtle || typeof candidate.getRandomValues !== 'function') {
    throw new ApiTokenConfigurationError('Web Crypto is required for API token generation and verification');
  }
  return candidate;
}

function encoder(): TextEncoder {
  if (typeof TextEncoder === 'undefined') {
    throw new ApiTokenConfigurationError('TextEncoder is required for API token generation and verification');
  }
  return new TextEncoder();
}

function utf8(value: string): Uint8Array {
  return encoder().encode(value);
}

async function sha256(value: string): Promise<Uint8Array> {
  const digest = await cryptoProvider().subtle.digest('SHA-256', utf8(value) as BufferSource);
  return new Uint8Array(digest);
}

function randomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  cryptoProvider().getRandomValues(bytes);
  return bytes;
}

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function base64UrlEncode(bytes: Uint8Array): string {
  let result = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    result += BASE64URL[first >> 2]!;
    result += BASE64URL[((first & 3) << 4) | ((second ?? 0) >> 4)]!;
    if (second !== undefined) result += BASE64URL[((second & 15) << 2) | ((third ?? 0) >> 6)]!;
    if (third !== undefined) result += BASE64URL[third & 63]!;
  }
  return result;
}

function base64UrlDecode(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]*$/u.test(value) || value.length % 4 === 1) return undefined;
  const output: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of value) {
    const digit = BASE64URL.indexOf(character);
    if (digit < 0) return undefined;
    buffer = (buffer << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(output);
}

/** Constant-time comparison that remains safe when an attacker controls length. */
function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function hmacKey(secret: Uint8Array): Promise<CryptoKey> {
  return cryptoProvider().subtle.importKey(
    'raw',
    secret as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

function parseCookieHeader(header: string | null): Map<string, string> {
  const result = new Map<string, string>();
  if (!header) return result;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (!name) continue;
    result.set(name, part.slice(separator + 1).trim());
  }
  return result;
}

function normalizeCookieName(value: string): string {
  if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u.test(value)) {
    throw new ApiTokenConfigurationError('API token session cookie name is invalid');
  }
  return value;
}

interface ApiTokenSessionClaims {
  readonly v: typeof API_TOKEN_SESSION_PROTOCOL_VERSION;
  readonly aud: typeof API_TOKEN_SESSION_AUDIENCE;
  readonly tokenId: string;
  readonly organizationId: string;
  readonly userId: string;
  /** Epoch seconds. It is always no later than the persisted token expiry. */
  readonly exp: number;
}

function sessionClaimString(value: unknown, maxLength = 256): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) return undefined;
  if ([...value].some((character) => character < ' ' || character === '\u007f')) return undefined;
  return value;
}

function parseApiTokenSessionClaims(value: unknown): ApiTokenSessionClaims | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const claims = value as Partial<ApiTokenSessionClaims>;
  const tokenId = sessionClaimString(claims.tokenId, API_TOKEN_ID_MAX_LENGTH);
  const organizationId = sessionClaimString(claims.organizationId);
  const userId = sessionClaimString(claims.userId);
  const exp = claims.exp;
  if (
    claims.v !== API_TOKEN_SESSION_PROTOCOL_VERSION ||
    claims.aud !== API_TOKEN_SESSION_AUDIENCE ||
    tokenId === undefined ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(tokenId) ||
    organizationId === undefined ||
    userId === undefined ||
    typeof exp !== 'number' ||
    !Number.isSafeInteger(exp) ||
    exp <= 0
  ) return undefined;
  return { v: API_TOKEN_SESSION_PROTOCOL_VERSION, aud: API_TOKEN_SESSION_AUDIENCE, tokenId, organizationId, userId, exp };
}

function defaultTokenGenerator(prefix: string): string {
  return `${prefix}${base64UrlEncode(randomBytes(32))}`;
}

function nonEmptyString(value: unknown, field: string, maxLength = 256): string {
  if (typeof value !== 'string') throw new ApiTokenError('INVALID_REQUEST', `${field} is required`, 400);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new ApiTokenError('INVALID_REQUEST', `${field} is invalid`, 400);
  return normalized;
}

function boundedId(value: unknown, field: string): string {
  const id = nonEmptyString(value, field, API_TOKEN_ID_MAX_LENGTH);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(id)) throw new ApiTokenError('INVALID_REQUEST', `${field} is invalid`, 400);
  return id;
}

function normalizeName(value: unknown): string {
  return nonEmptyString(value, 'Token name', API_TOKEN_NAME_MAX_LENGTH);
}

function normalizeScope(value: unknown): string {
  const scope = nonEmptyString(value, 'Token scope', API_TOKEN_SCOPE_MAX_LENGTH);
  if (scope !== '*' && !/^[A-Za-z0-9][A-Za-z0-9:_.*-]*$/u.test(scope)) throw new ApiTokenError('INVALID_SCOPE', 'Token scope is invalid', 400);
  return scope;
}

function normalizeScopes(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > API_TOKEN_MAX_SCOPES) throw new ApiTokenError('INVALID_SCOPE', 'Token scopes must be a bounded array', 400);
  return [...new Set(value.map(normalizeScope))];
}

function normalizeRole(value: unknown): Role {
  const role = value === 'member' ? 'reader' : value === 'manager' ? 'admin' : value;
  if (typeof role !== 'string' || !ROLE_NAMES.includes(role as Role)) throw new ApiTokenError('INVALID_ROLE', 'Token role ceiling is invalid', 400);
  if (role === 'worker') throw new ApiTokenError('ROLE_ESCALATION', 'API tokens cannot use the worker role', 403);
  return role as Role;
}

function normalizeIdentityRole(value: unknown): Role | undefined {
  return value === undefined ? undefined : normalizeRole(value);
}

function normalizeRoleList(value: unknown): Role[] {
  const supplied = value === undefined ? [] : Array.isArray(value) ? value : [value];
  const roles = [...new Set(supplied.map(normalizeRole))];
  return roles;
}

function highestRole(roles: readonly Role[]): Role {
  return roles.reduce<Role>((highest, role) => ROLE_RANK[role] > ROLE_RANK[highest] ? role : highest, 'reader');
}

function roleAtMost(requested: Role, maximum: Role): boolean {
  return ROLE_RANK[requested] <= ROLE_RANK[maximum];
}

function hasScope(granted: readonly string[], required: string): boolean {
  return granted.some((scope) => scope === '*' || scope === required || (scope.endsWith(':*') && required.startsWith(scope.slice(0, -1))));
}

const ROLE_SCOPES: Readonly<Record<Role, readonly string[]>> = {
  owner: ['*'],
  admin: ['*'],
  publisher: [
    'registry:read', 'skills:read', 'skills:publish', 'resolve:read', 'operations:read',
    'install:authorize', 'install:receipt', 'artifacts:download', 'packs:read', 'packs:publish',
    'scans:read', 'upstreams:read', 'imports:create',
  ],
  reader: [
    'registry:read', 'skills:read', 'resolve:read', 'operations:read', 'install:authorize',
    'install:receipt', 'artifacts:download', 'packs:read', 'scans:read', 'upstreams:read',
  ],
  worker: [],
};

function roleScopes(role: Role): string[] {
  return [...(ROLE_SCOPES[role] ?? [])];
}

function intersectScopes(left: readonly string[], right: readonly string[]): string[] {
  const result = new Set<string>();
  for (const leftScope of left) {
    for (const rightScope of right) {
      if (leftScope === '*') result.add(rightScope);
      else if (rightScope === '*') result.add(leftScope);
      else if (leftScope === rightScope) result.add(leftScope);
      else if (leftScope.endsWith(':*') && rightScope.startsWith(leftScope.slice(0, -1))) result.add(rightScope);
      else if (rightScope.endsWith(':*') && leftScope.startsWith(rightScope.slice(0, -1))) result.add(leftScope);
    }
  }
  return [...result];
}

function normalizeMembership(value: MembershipSnapshot | null, organizationId: string, userId: string): NormalizedMembership | null {
  if (!value || value.active === false || value.organizationId !== organizationId || value.userId !== userId) return null;
  const sourceRoles = value.roles ?? (value.role === undefined ? undefined : [value.role]);
  let roles: Role[];
  try { roles = normalizeRoleList(sourceRoles); } catch { return null; }
  if (roles.length === 0) return null;
  let scopes: string[];
  if (value.scopes === undefined) scopes = roleScopes(highestRole(roles));
  else { try { scopes = normalizeScopes(value.scopes); } catch { return null; } }
  const display = normalizePrincipalDisplayMetadata(value.display);
  return { userId, organizationId, roles, scopes, ...(display === undefined ? {} : { display }) };
}

function normalizeSession(value: OrganizationSessionLike | null): OrganizationSession | null {
  if (!value || typeof value !== 'object') return null;
  try {
    const candidate = value;
    const userId = candidate.userId ?? candidate.subject ?? candidate.user?.id ?? candidate.session?.userId;
    const organizationId = candidate.organizationId ?? candidate.orgId ?? candidate.activeOrganizationId ?? candidate.session?.activeOrganizationId;
    if (!userId || !organizationId) return null;
    const sessionId = candidate.sessionId ?? candidate.session?.id;
    return {
      userId: nonEmptyString(userId, 'session user id'),
      organizationId: nonEmptyString(organizationId, 'session organization id'),
      ...(sessionId === undefined ? {} : { sessionId: nonEmptyString(sessionId, 'session id') }),
    };
  } catch { return null; }
}

function parseExpiry(value: unknown, expiresInSeconds: unknown, nowMs: number, defaultTtl: number, maxTtl: number): string {
  let expiryMs: number;
  if (value !== undefined) {
    if (typeof value === 'number' && Number.isFinite(value)) expiryMs = value < 1_000_000_000_000 ? value * 1000 : value;
    else if (typeof value === 'string' && Number.isFinite(Date.parse(value))) expiryMs = Date.parse(value);
    else throw new ApiTokenError('INVALID_EXPIRY', 'Token expiry is invalid', 400);
  } else if (expiresInSeconds !== undefined) {
    if (typeof expiresInSeconds !== 'number' || !Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) throw new ApiTokenError('INVALID_EXPIRY', 'Token expiry duration is invalid', 400);
    expiryMs = nowMs + expiresInSeconds * 1000;
  } else expiryMs = nowMs + defaultTtl * 1000;
  const lifetime = expiryMs - nowMs;
  if (!Number.isFinite(expiryMs) || lifetime <= 0) throw new ApiTokenError('INVALID_EXPIRY', 'Token expiry must be in the future', 400);
  if (lifetime > maxTtl * 1000 + 999) throw new ApiTokenError('INVALID_EXPIRY', 'Token expiry exceeds the maximum lifetime', 400);
  return new Date(expiryMs).toISOString();
}

function hashString(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return `sha256:${hex}`;
}

function cloneRecord(record: ApiTokenRecord): ApiTokenRecord {
  return { ...record, scopes: [...record.scopes] };
}

function metadata(record: ApiTokenRecord): ApiTokenMetadata {
  return {
    id: record.id,
    organizationId: record.organizationId,
    userId: record.userId,
    name: record.name,
    roleCeiling: record.roleCeiling,
    scopes: [...record.scopes],
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
    ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }),
  };
}

function cloneMetadataWithToken(record: ApiTokenRecord, token: string): CreateApiTokenResult {
  return { ...metadata(record), token };
}

function bearerToken(request: Request): string | undefined {
  const header = request.headers.get('authorization');
  if (!header) return undefined;
  const match = /^Bearer[ \t]+([^ \t]+)$/iu.exec(header);
  return match?.[1];
}

function hasCookie(request: Request): boolean {
  const cookie = request.headers.get('cookie');
  return typeof cookie === 'string' && cookie.trim() !== '';
}

function bodyJson(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiTokenError('INVALID_REQUEST', 'Request body must be an object', 400);
  return value as Record<string, unknown>;
}

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function errorResponse(error: unknown): Response {
  if (error instanceof ApiTokenError) return jsonResponse({ code: error.code, message: error.message }, error.status);
  return jsonResponse({ code: 'API_TOKEN_ERROR', message: 'API token operation failed' }, 500);
}

function methodNotAllowed(allow: string[]): Response {
  return jsonResponse({ code: 'METHOD_NOT_ALLOWED', message: 'Method is not allowed' }, 405, { allow: allow.join(', ') });
}

function requestPath(request: Request): string {
  try {
    const path = new URL(request.url).pathname.replace(/\/+$/u, '');
    return path || '/';
  } catch { throw new ApiTokenError('INVALID_REQUEST', 'Request URL is invalid', 400); }
}

function safeRoutePrefix(value: string | undefined): string {
  const prefix = (value ?? '/v1/tokens').replace(/\/+$/u, '') || '/v1/tokens';
  if (!prefix.startsWith('/') || prefix.includes('..') || !/^\/[A-Za-z0-9/_-]+$/u.test(prefix)) throw new ApiTokenConfigurationError('API token route prefix is invalid');
  return prefix;
}

function normalizeTrustedOrigin(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new ApiTokenConfigurationError(`${field} is required`);
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new ApiTokenConfigurationError(`${field} is invalid`); }
  if (parsed.origin === 'null' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new ApiTokenConfigurationError(`${field} must be an origin URL`);
  return parsed.origin;
}

function configuredTrustedOrigins(options: CreateApiTokenModuleOptions): ReadonlySet<string> {
  const values: unknown[] = [];
  if (options.canonicalOrigin !== undefined) values.push(options.canonicalOrigin);
  if (options.trustedOrigins !== undefined) {
    if (!Array.isArray(options.trustedOrigins)) throw new ApiTokenConfigurationError('Trusted API token origins must be an array');
    values.push(...options.trustedOrigins);
  }
  const origins = new Set(values.map((value, index) => normalizeTrustedOrigin(value, index === 0 && options.canonicalOrigin !== undefined ? 'Canonical API token origin' : 'Trusted API token origin')));
  return origins;
}

function enforceCookieMutationOrigin(request: Request, trustedOrigins: ReadonlySet<string>, missingOrigin: 'deny' | 'allow'): void {
  if (trustedOrigins.size === 0) throw new ApiTokenError('API_TOKEN_ORIGIN_NOT_CONFIGURED', 'A trusted origin is required for cookie-authenticated token mutations', 500);
  const supplied = request.headers.get('origin');
  if (supplied === null || supplied.trim() === '') {
    if (missingOrigin === 'allow') return;
    throw new ApiTokenError('CSRF_ORIGIN_MISSING', 'An Origin header is required for cookie-authenticated token mutations', 403);
  }
  let origin: string;
  try { origin = normalizeRequestOrigin(supplied); } catch { throw new ApiTokenError('CSRF_ORIGIN_MISMATCH', 'Request origin is not trusted', 403); }
  if (!trustedOrigins.has(origin)) throw new ApiTokenError('CSRF_ORIGIN_MISMATCH', 'Request origin is not trusted', 403);
}

function normalizeRequestOrigin(value: string): string {
  const parsed = new URL(value);
  if (parsed.origin === 'null' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('invalid origin');
  return parsed.origin;
}

function isManagementRole(role: Role): boolean {
  return role === 'owner' || role === 'admin';
}

function canManageAll(membership: NormalizedMembership): boolean {
  return membership.roles.some(isManagementRole);
}

function effectiveRole(membership: NormalizedMembership, ceiling: Role): Role | null {
  const highest = highestRole(membership.roles);
  // A higher role includes the capabilities of lower roles.  A token issued
  // with a reader ceiling therefore remains a reader when its owner/admin
  // membership is looked up, while a later downgrade computes the lower
  // current role and can only reduce access.
  return ROLE_RANK[highest] >= ROLE_RANK[ceiling] ? ceiling : highest;
}

function scopesForToken(record: ApiTokenRecord, membership: NormalizedMembership): string[] {
  const role = effectiveRole(membership, record.roleCeiling);
  if (!role) return [];
  return intersectScopes(intersectScopes(record.scopes, membership.scopes), roleScopes(role));
}

function clonePrincipal(principal: ApiTokenPrincipal): ApiTokenPrincipal {
  const display = normalizePrincipalDisplayMetadata(principal.display);
  return {
    organizationId: principal.organizationId,
    subject: principal.subject,
    roles: [...principal.roles],
    ...(principal.namespaces === undefined ? {} : { namespaces: [...principal.namespaces] }),
    ...(principal.scopes === undefined ? {} : { scopes: [...principal.scopes] }),
    ...(display === undefined ? {} : { display }),
    identity: 'user',
    tokenId: principal.tokenId,
  };
}

export class DefaultApiTokenService implements ApiTokenService {
  private readonly repository: ApiTokenRepository;
  private readonly identity: MembershipAuthorizer;
  private readonly audit?: ApiTokenAuditSink;
  private readonly now: () => number;
  private readonly tokenGenerator: ApiTokenGenerator;
  private readonly tokenPrefix: string;
  private readonly defaultTtlSeconds: number;
  private readonly maxTtlSeconds: number;
  private readonly maxList: number;
  private readonly sessionCookieName: string;
  private readonly sessionSecureCookies: boolean;
  private readonly sessionKeyPromise?: Promise<CryptoKey>;

  constructor(options: ApiTokenServiceOptions) {
    this.repository = options.repository;
    this.identity = options.membershipAuthorizer;
    this.audit = options.audit;
    this.now = options.now ?? (() => Date.now());
    this.tokenPrefix = options.tokenPrefix ?? DEFAULT_API_TOKEN_PREFIX;
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,15}$/u.test(this.tokenPrefix)) throw new ApiTokenConfigurationError('API token prefix is invalid');
    this.tokenGenerator = options.tokenGenerator ?? (() => defaultTokenGenerator(this.tokenPrefix));
    this.defaultTtlSeconds = options.defaultTtlSeconds ?? DEFAULT_API_TOKEN_TTL_SECONDS;
    this.maxTtlSeconds = options.maxTtlSeconds ?? DEFAULT_API_TOKEN_MAX_TTL_SECONDS;
    this.maxList = options.maxList ?? DEFAULT_API_TOKEN_MAX_LIST;
    this.sessionCookieName = normalizeCookieName(options.sessionCookieName ?? DEFAULT_API_TOKEN_SESSION_COOKIE);
    this.sessionSecureCookies = options.sessionSecureCookies ?? true;
    if (typeof this.sessionSecureCookies !== 'boolean') throw new ApiTokenConfigurationError('API token session secure-cookie setting is invalid');
    if (options.sessionSecret !== undefined) {
      const secret = typeof options.sessionSecret === 'string' ? utf8(options.sessionSecret) : new Uint8Array(options.sessionSecret);
      if (secret.byteLength < 32) throw new ApiTokenConfigurationError('API token session secret must contain at least 32 bytes');
      this.sessionKeyPromise = hmacKey(secret);
    }
    if (!Number.isFinite(this.defaultTtlSeconds) || this.defaultTtlSeconds <= 0 || !Number.isFinite(this.maxTtlSeconds) || this.maxTtlSeconds <= 0 || this.defaultTtlSeconds > this.maxTtlSeconds || !Number.isSafeInteger(this.maxList) || this.maxList <= 0 || this.maxList > 1_000) throw new ApiTokenConfigurationError('API token lifetime or list limits are invalid');
  }

  async resolveManagementContext(request: Request, options: { requireCookie?: boolean } = {}): Promise<ApiTokenManagementContext> {
    if (options.requireCookie !== false && (!hasCookie(request) || request.headers.has('authorization'))) throw new ApiTokenError('UNAUTHORIZED', 'A Better Auth organization session is required', 401);
    let session: OrganizationSession | null;
    try { session = normalizeSession(await this.identity.getOrganizationSession(request)); } catch { session = null; }
    if (!session) throw new ApiTokenError('UNAUTHORIZED', 'A Better Auth organization session is required', 401);
    let membership: MembershipSnapshot | null;
    try { membership = await this.identity.getMembership(session.organizationId, session.userId); } catch { membership = null; }
    const normalized = normalizeMembership(membership, session.organizationId, session.userId);
    if (!normalized) throw new ApiTokenError('FORBIDDEN', 'The current organization membership is not active', 403);
    return { ...session, membership: normalized };
  }

  private async membershipFor(organizationId: string, userId: string): Promise<NormalizedMembership | null> {
    try { return normalizeMembership(await this.identity.getMembership(organizationId, userId), organizationId, userId); } catch { return null; }
  }

  async createToken(context: OrganizationSession, input: CreateApiTokenInput): Promise<CreateApiTokenResult> {
    const session = normalizeSession(context);
    if (!session) throw new ApiTokenError('UNAUTHORIZED', 'A Better Auth organization session is required', 401);
    const membership = await this.membershipFor(session.organizationId, session.userId);
    if (!membership) throw new ApiTokenError('FORBIDDEN', 'The current organization membership is not active', 403);
    if (input.organizationId !== undefined && input.organizationId !== session.organizationId) throw new ApiTokenError('FORBIDDEN', 'Token organization must match the active organization session', 403);
    const name = normalizeName(input.name);
    const requestedRole = normalizeIdentityRole(input.roleCeiling ?? input.role) ?? highestRole(membership.roles);
    const highest = highestRole(membership.roles);
    if (!roleAtMost(requestedRole, highest)) throw new ApiTokenError('ROLE_ESCALATION', 'Token role exceeds the current membership role', 403);
    const requestedScopes = input.scopes === undefined ? roleScopes(requestedRole) : normalizeScopes(input.scopes);
    const roleCap = roleScopes(requestedRole);
    if (requestedScopes.some((scope) => !hasScope(membership.scopes, scope) || !hasScope(roleCap, scope))) throw new ApiTokenError('SCOPE_ESCALATION', 'Token scopes exceed the current membership grants', 403);
    const nowMs = this.now();
    const expiresAt = parseExpiry(input.expiresAt, input.expiresInSeconds, nowMs, this.defaultTtlSeconds, this.maxTtlSeconds);
    const createdAt = new Date(nowMs).toISOString();
    const id = boundedId(`st_${cryptoProvider().randomUUID?.() ?? base64UrlEncode(randomBytes(18))}`, 'Token id');
    let rawToken: string | undefined;
    let record: ApiTokenRecord | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const candidate = await this.tokenGenerator();
      if (typeof candidate !== 'string' || candidate.length < 20 || candidate.length > 512 || /[\r\n\t ]/u.test(candidate)) throw new ApiTokenConfigurationError('API token generator returned invalid material');
      const next: ApiTokenRecord = { id, organizationId: session.organizationId, userId: session.userId, name, tokenHash: hashString(await sha256(candidate)), roleCeiling: requestedRole, scopes: [...requestedScopes], expiresAt, createdAt };
      try {
        await this.repository.create(next);
        rawToken = candidate;
        record = next;
        break;
      } catch (error) {
        if (attempt >= 2) throw error;
      }
    }
    if (!record || rawToken === undefined) throw new ApiTokenRepositoryError('API token could not be created');
    await this.emitAudit({ action: 'api_token.created', organizationId: session.organizationId, actorId: session.userId, subject: session.userId, resourceId: record.id, tokenId: record.id, createdAt, details: { roleCeiling: record.roleCeiling, expiresAt: record.expiresAt, scopeCount: record.scopes.length } });
    return cloneMetadataWithToken(record, rawToken);
  }

  async listTokens(context: OrganizationSession, options: ApiTokenListOptions = {}): Promise<ApiTokenMetadata[]> {
    const session = normalizeSession(context);
    if (!session) throw new ApiTokenError('UNAUTHORIZED', 'A Better Auth organization session is required', 401);
    const membership = await this.membershipFor(session.organizationId, session.userId);
    if (!membership) throw new ApiTokenError('FORBIDDEN', 'The current organization membership is not active', 403);
    const requestedSubject = options.subject === undefined ? undefined : nonEmptyString(options.subject, 'Token subject', 256);
    const subject = canManageAll(membership) ? requestedSubject : session.userId;
    const limit = options.limit === undefined ? this.maxList : Math.min(this.maxList, Math.max(1, Math.floor(options.limit)));
    const rows = await this.repository.list(session.organizationId, { subject, limit });
    return rows.filter((record) => options.includeRevoked === true || record.revokedAt === undefined).map(metadata);
  }

  async revokeToken(context: OrganizationSession, tokenId: string): Promise<ApiTokenMetadata> {
    const session = normalizeSession(context);
    if (!session) throw new ApiTokenError('UNAUTHORIZED', 'A Better Auth organization session is required', 401);
    const cleanId = boundedId(tokenId, 'Token id');
    const membership = await this.membershipFor(session.organizationId, session.userId);
    if (!membership) throw new ApiTokenError('FORBIDDEN', 'The current organization membership is not active', 403);
    const existing = await this.repository.findById(session.organizationId, cleanId);
    if (!existing) throw new ApiTokenError('TOKEN_NOT_FOUND', 'Token was not found', 404);
    if (existing.userId !== session.userId && !canManageAll(membership)) throw new ApiTokenError('FORBIDDEN', 'Only organization administrators can revoke another member token', 403);
    const revokedAt = existing.revokedAt ?? new Date(this.now()).toISOString();
    const revoked = await this.repository.revoke(session.organizationId, cleanId, revokedAt);
    if (!revoked) throw new ApiTokenError('TOKEN_NOT_FOUND', 'Token was not found', 404);
    await this.emitAudit({ action: 'api_token.revoked', organizationId: session.organizationId, actorId: session.userId, subject: session.userId, resourceId: cleanId, tokenId: cleanId, createdAt: new Date(this.now()).toISOString(), details: {} });
    return metadata(revoked);
  }

  private async recordForRawToken(rawToken: string): Promise<ApiTokenRecord | null> {
    const token = rawToken.replace(/^Bearer[ \t]+/iu, '');
    if (token.length < 20 || token.length > 512 || /[\r\n\t ]/u.test(token)) return null;
    try { return await this.repository.findByHash(hashString(await sha256(token))); } catch { return null; }
  }

  private async principalForRecord(record: ApiTokenRecord): Promise<ApiTokenPrincipal | null> {
    if (record.revokedAt !== undefined) return null;
    const expiry = Date.parse(record.expiresAt);
    if (!Number.isFinite(expiry) || this.now() >= expiry) return null;
    const membership = await this.membershipFor(record.organizationId, record.userId);
    if (!membership) return null;
    const role = effectiveRole(membership, record.roleCeiling);
    if (!role) return null;
    return clonePrincipal({ organizationId: record.organizationId, subject: record.userId, roles: [role], scopes: scopesForToken(record, membership), ...(membership.display === undefined ? {} : { display: membership.display }), identity: 'user', tokenId: record.id });
  }

  async authenticateBearerToken(rawToken: string): Promise<ApiTokenPrincipal | null> {
    const record = await this.recordForRawToken(rawToken);
    return record ? this.principalForRecord(record) : null;
  }

  private async signSession(value: string): Promise<string> {
    if (!this.sessionKeyPromise) return '';
    const signature = await cryptoProvider().subtle.sign('HMAC', await this.sessionKeyPromise, utf8(value) as BufferSource);
    return base64UrlEncode(new Uint8Array(signature));
  }

  private async verifySession(value: string, suppliedSignature: string): Promise<boolean> {
    if (!this.sessionKeyPromise) return false;
    const supplied = base64UrlDecode(suppliedSignature);
    if (!supplied || supplied.byteLength !== 32) return false;
    const expected = new Uint8Array(await cryptoProvider().subtle.sign('HMAC', await this.sessionKeyPromise, utf8(value) as BufferSource));
    return timingSafeEqual(supplied, expected);
  }

  private async browserSessionPrincipal(request: Request): Promise<ApiTokenPrincipal | null> {
    if (!this.sessionKeyPromise) return null;
    const raw = parseCookieHeader(request.headers.get('cookie')).get(this.sessionCookieName);
    if (!raw || raw.length > API_TOKEN_SESSION_COOKIE_MAX_LENGTH) return null;
    const parts = raw.split('.');
    if (parts.length !== 3 || parts[0] !== API_TOKEN_SESSION_COOKIE_PREFIX || !parts[1] || !parts[2]) return null;
    const signedValue = `${parts[0]}.${parts[1]}`;
    try {
      if (!(await this.verifySession(signedValue, parts[2]!))) return null;
      const encodedClaims = base64UrlDecode(parts[1]!);
      if (!encodedClaims) return null;
      const claimsValue = JSON.parse(new TextDecoder().decode(encodedClaims)) as unknown;
      const claims = parseApiTokenSessionClaims(claimsValue);
      if (!claims || Math.floor(this.now() / 1000) >= claims.exp) return null;
      const record = await this.repository.findById(claims.organizationId, claims.tokenId);
      if (!record || record.organizationId !== claims.organizationId || record.userId !== claims.userId) return null;
      return await this.principalForRecord(record);
    } catch {
      return null;
    }
  }

  async createSession(rawToken: string): Promise<ApiTokenSessionResult | null> {
    if (!this.sessionKeyPromise) return null;
    const record = await this.recordForRawToken(rawToken);
    if (!record) return null;
    const principal = await this.principalForRecord(record);
    if (!principal) return null;
    const expiresAtMs = Date.parse(record.expiresAt);
    const nowMs = this.now();
    const exp = Math.floor(expiresAtMs / 1000);
    if (!Number.isFinite(expiresAtMs) || exp <= Math.floor(nowMs / 1000)) return null;
    const claims: ApiTokenSessionClaims = {
      v: API_TOKEN_SESSION_PROTOCOL_VERSION,
      aud: API_TOKEN_SESSION_AUDIENCE,
      tokenId: record.id,
      organizationId: record.organizationId,
      userId: record.userId,
      exp,
    };
    const encodedClaims = base64UrlEncode(utf8(JSON.stringify(claims)));
    const signedValue = `${API_TOKEN_SESSION_COOKIE_PREFIX}.${encodedClaims}`;
    const signature = await this.signSession(signedValue);
    const maxAge = Math.max(1, Math.floor((expiresAtMs - nowMs) / 1000));
    const cookieParts = [
      `${this.sessionCookieName}=${signedValue}.${signature}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${maxAge}`,
      `Expires=${new Date(expiresAtMs).toUTCString()}`,
    ];
    if (this.sessionSecureCookies) cookieParts.push('Secure');
    return { cookie: cookieParts.join('; '), principal: clonePrincipal(principal) };
  }

  clearSessionCookie(): string {
    const cookieParts = [
      `${this.sessionCookieName}=`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      'Max-Age=0',
      'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    ];
    if (this.sessionSecureCookies) cookieParts.push('Secure');
    return cookieParts.join('; ');
  }

  async authenticate(request: Request): Promise<ApiTokenPrincipal | null> {
    if (request.headers.has('authorization')) {
      const token = bearerToken(request);
      return token === undefined ? null : this.authenticateBearerToken(token);
    }
    return this.browserSessionPrincipal(request);
  }

  private async emitAudit(event: ApiTokenAuditEvent): Promise<void> {
    if (!this.audit) return;
    try { await this.audit.append(event); } catch { /* host monitors its audit sink; never echo secrets */ }
  }
}

export class ApiTokenAuthenticator implements Authenticator {
  constructor(private readonly service: ApiTokenService) {}
  authenticate(request: Request): Promise<Principal | null> { return this.service.authenticate(request); }
  createSession(token: string): Promise<ApiTokenSessionResult | null> { return this.service.createSession(token); }
  clearSessionCookie(): string { return this.service.clearSessionCookie(); }
}

function principalTokenId(principal: Principal | null): string | undefined {
  const candidate = principal as (Principal & { tokenId?: unknown }) | null;
  return typeof candidate?.tokenId === 'string' ? candidate.tokenId : undefined;
}

function sessionFromPrincipal(principal: Principal): OrganizationSession {
  return { userId: principal.subject, organizationId: principal.organizationId };
}

function isTokenRoute(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

async function readBoundedJson(request: Request, maxBodyBytes: number): Promise<Record<string, unknown>> {
  const length = request.headers.get('content-length');
  if (length !== null && Number.isFinite(Number(length)) && Number(length) > maxBodyBytes) throw new ApiTokenError('PAYLOAD_TOO_LARGE', 'Request body is too large', 413);
  let text = '';
  if (request.body) {
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = next.value;
        total += chunk.byteLength;
        if (total > maxBodyBytes) {
          await reader.cancel();
          throw new ApiTokenError('PAYLOAD_TOO_LARGE', 'Request body is too large', 413);
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    text = new TextDecoder().decode(bytes);
  }
  try { return bodyJson(JSON.parse(text)); } catch (error) {
    if (error instanceof ApiTokenError) throw error;
    throw new ApiTokenError('INVALID_REQUEST', 'Request body is invalid JSON', 400);
  }
}

function parseCreateInput(body: Record<string, unknown>): CreateApiTokenInput {
  return {
    name: body.name as string,
    ...(body.roleCeiling === undefined ? {} : { roleCeiling: body.roleCeiling as IdentityRole }),
    ...(body.role === undefined ? {} : { role: body.role as IdentityRole }),
    ...(body.scopes === undefined ? {} : { scopes: body.scopes as string[] }),
    ...(body.expiresAt === undefined ? {} : { expiresAt: body.expiresAt as string | number }),
    ...(body.expiresInSeconds === undefined ? {} : { expiresInSeconds: body.expiresInSeconds as number }),
    ...(body.organizationId === undefined ? {} : { organizationId: body.organizationId as string }),
  };
}

function createHandler(options: CreateApiTokenModuleOptions, service: ApiTokenService): ApiTokenHandler {
  const prefix = safeRoutePrefix(options.routePrefix);
  const maxBodyBytes = options.maxBodyBytes ?? 64 * 1024;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0 || maxBodyBytes > 1_000_000) throw new ApiTokenConfigurationError('API token request body limit is invalid');
  const trustedOrigins = configuredTrustedOrigins(options);
  const missingOrigin = options.missingOrigin ?? 'deny';
  if (missingOrigin !== 'deny' && missingOrigin !== 'allow') throw new ApiTokenConfigurationError('Missing API token origin policy is invalid');
  return async (request: Request): Promise<Response | undefined> => {
    let path: string;
    try { path = requestPath(request); } catch (error) { return errorResponse(error); }
    if (!isTokenRoute(path, prefix)) return undefined;
    try {
      const suffix = path.slice(prefix.length).replace(/^\//u, '');
      const method = request.method.toUpperCase();
      if (!suffix) {
        if (method === 'POST') {
          if (bearerToken(request) === undefined) enforceCookieMutationOrigin(request, trustedOrigins, missingOrigin);
          const context = await service.resolveManagementContext(request, { requireCookie: true });
          const created = await service.createToken(context, parseCreateInput(await readBoundedJson(request, maxBodyBytes)));
          return jsonResponse(created, 201);
        }
        if (method === 'GET') {
          const bearer = bearerToken(request);
          if (bearer !== undefined) {
            const principal = await service.authenticate(request);
            if (!principal) throw new ApiTokenError('UNAUTHORIZED', 'Authentication is required', 401);
            const includeRevoked = new URL(request.url).searchParams.get('includeRevoked') === 'true';
            // The bearer token's effective role is the authority for this
            // request.  A reader-ceiling token can belong to an owner/admin,
            // but it must still see only its own token metadata.
            const subject = principal.roles.some(isManagementRole) ? undefined : principal.subject;
            return jsonResponse({ tokens: await service.listTokens(sessionFromPrincipal(principal), { includeRevoked, subject }) });
          }
          const context = await service.resolveManagementContext(request, { requireCookie: true });
          const includeRevoked = new URL(request.url).searchParams.get('includeRevoked') === 'true';
          return jsonResponse({ tokens: await service.listTokens(context, { includeRevoked }) });
        }
        return methodNotAllowed(['GET', 'POST']);
      }
      const methodIsRevokeAlias = method === 'POST' && suffix.endsWith('/revoke');
      const rawId = methodIsRevokeAlias ? suffix.slice(0, -'/revoke'.length).replace(/\/$/u, '') : suffix;
      if (!rawId || rawId.includes('/')) throw new ApiTokenError('TOKEN_NOT_FOUND', 'Token was not found', 404);
      const tokenId = boundedId(rawId, 'Token id');
      if (method !== 'DELETE' && !methodIsRevokeAlias) return methodNotAllowed(['DELETE', 'POST']);
      let context: OrganizationSession;
      const bearer = bearerToken(request);
      if (bearer !== undefined) {
        const principal = await service.authenticate(request);
        if (!principal) throw new ApiTokenError('UNAUTHORIZED', 'Authentication is required', 401);
        if (principalTokenId(principal) !== tokenId && !principal.roles.some(isManagementRole)) throw new ApiTokenError('FORBIDDEN', 'A bearer token can revoke only itself', 403);
        context = sessionFromPrincipal(principal);
      } else {
        enforceCookieMutationOrigin(request, trustedOrigins, missingOrigin);
        context = await service.resolveManagementContext(request, { requireCookie: true });
      }
      return jsonResponse({ revoked: true, token: await service.revokeToken(context, tokenId) }, 200);
    } catch (error) { return errorResponse(error); }
  };
}

export function createApiTokenModule(options: CreateApiTokenModuleOptions): ApiTokenModule {
  const service = new DefaultApiTokenService(options);
  return { service, authenticator: new ApiTokenAuthenticator(service), handler: createHandler(options, service) };
}

export function createApiTokenService(options: ApiTokenServiceOptions): ApiTokenService {
  return new DefaultApiTokenService(options);
}

export const createServiceTokenModule = createApiTokenModule;

// ---------------------------------------------------------------------------
// In-memory repository for unit/integration tests and local compositions.
// ---------------------------------------------------------------------------

export interface MemoryApiTokenRepositoryOptions { initial?: readonly ApiTokenRecord[]; }

export class MemoryApiTokenRepository implements ApiTokenRepository {
  private readonly records = new Map<string, ApiTokenRecord>();
  private readonly hashes = new Map<string, string>();

  constructor(options: MemoryApiTokenRepositoryOptions = {}) {
    for (const input of options.initial ?? []) {
      const record = cloneRecord(input);
      if (this.records.has(record.id) || this.hashes.has(record.tokenHash)) throw new ApiTokenRepositoryError('Duplicate initial API token record');
      this.records.set(record.id, record);
      this.hashes.set(record.tokenHash, record.id);
    }
  }

  async create(input: ApiTokenRecord): Promise<void> {
    const record = cloneRecord(input);
    if (this.records.has(record.id) || this.hashes.has(record.tokenHash)) throw new ApiTokenRepositoryError('API token record already exists');
    this.records.set(record.id, record);
    this.hashes.set(record.tokenHash, record.id);
  }

  async findByHash(tokenHash: string): Promise<ApiTokenRecord | null> {
    const id = this.hashes.get(tokenHash);
    return id === undefined ? null : cloneRecord(this.records.get(id)!);
  }

  async findById(organizationId: string, tokenId: string): Promise<ApiTokenRecord | null> {
    const record = this.records.get(tokenId);
    return record && record.organizationId === organizationId ? cloneRecord(record) : null;
  }

  async list(organizationId: string, options: { subject?: string; limit?: number } = {}): Promise<ApiTokenRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.organizationId === organizationId && (options.subject === undefined || record.userId === options.subject))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, options.limit ?? Number.POSITIVE_INFINITY)
      .map(cloneRecord);
  }

  async revoke(organizationId: string, tokenId: string, revokedAt: string): Promise<ApiTokenRecord | null> {
    const record = this.records.get(tokenId);
    if (!record || record.organizationId !== organizationId) return null;
    if (record.revokedAt === undefined) record.revokedAt = revokedAt;
    return cloneRecord(record);
  }
}

export const createMemoryApiTokenRepository = (options: MemoryApiTokenRepositoryOptions = {}): MemoryApiTokenRepository => new MemoryApiTokenRepository(options);
export const createMemoryServiceTokenRepository = createMemoryApiTokenRepository;

// ---------------------------------------------------------------------------
// PostgreSQL adapter. Better Auth owns identity/membership migration; this
// adapter exposes service-token DDL and CRUD only. `autoMigrate` is opt-in.
// ---------------------------------------------------------------------------

export interface ApiTokenPgQueryResult<Row = Record<string, unknown>> { rows: Row[]; rowCount?: number; }
export interface ApiTokenPgExecutor { query<Row = Record<string, unknown>>(text: string, parameters?: readonly unknown[]): Promise<ApiTokenPgQueryResult<Row>>; }
export interface ApiTokenPgPool extends ApiTokenPgExecutor { connect(): Promise<ApiTokenPgExecutor & { release?: () => void | Promise<void> }>; }
export interface PostgresApiTokenRepositoryOptions { tableName?: string; autoMigrate?: boolean; }

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier)) throw new ApiTokenConfigurationError('API token PostgreSQL table name is invalid');
  return `"${identifier}"`;
}

export function postgresApiTokenSchemaSql(tableName = DEFAULT_API_TOKEN_TABLE): string {
  const table = quoteIdentifier(tableName);
  const index = quoteIdentifier(`${tableName}_org_created_idx`);
  const hashIndex = quoteIdentifier(`${tableName}_hash_idx`);
  return `
CREATE TABLE IF NOT EXISTS ${table} (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  user_id text NOT NULL,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  role_ceiling text NOT NULL CHECK (role_ceiling IN ('owner', 'admin', 'publisher', 'reader')),
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz NULL
);
CREATE INDEX IF NOT EXISTS ${index} ON ${table} (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ${hashIndex} ON ${table} (token_hash);
`;
}

export const API_TOKEN_SCHEMA_SQL = postgresApiTokenSchemaSql();
export const SERVICE_TOKEN_SCHEMA_SQL = API_TOKEN_SCHEMA_SQL;

function dbString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new ApiTokenRepositoryError(`Stored API token ${field} is invalid`);
  return value;
}

function dbDate(value: unknown, field: string): string {
  const date = value instanceof Date ? value : typeof value === 'string' || typeof value === 'number' ? new Date(value) : undefined;
  if (!date || !Number.isFinite(date.getTime())) throw new ApiTokenRepositoryError(`Stored API token ${field} is invalid`);
  return date.toISOString();
}

function dbScopes(value: unknown): string[] {
  let parsed: unknown = value;
  if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch { throw new ApiTokenRepositoryError('Stored API token scopes are invalid'); } }
  if (!Array.isArray(parsed)) throw new ApiTokenRepositoryError('Stored API token scopes are invalid');
  try { return normalizeScopes(parsed); } catch { throw new ApiTokenRepositoryError('Stored API token scopes are invalid'); }
}

function rowToRecord(row: Record<string, unknown>): ApiTokenRecord {
  const record: ApiTokenRecord = {
    id: boundedId(row.id, 'stored token id'),
    organizationId: dbString(row.organization_id, 'organization id'),
    userId: dbString(row.user_id, 'user id'),
    name: nonEmptyString(row.name, 'stored token name', API_TOKEN_NAME_MAX_LENGTH),
    tokenHash: dbString(row.token_hash, 'hash'),
    roleCeiling: normalizeRole(row.role_ceiling),
    scopes: dbScopes(row.scopes),
    expiresAt: dbDate(row.expires_at, 'expiry'),
    createdAt: dbDate(row.created_at, 'creation time'),
    ...(row.revoked_at === null || row.revoked_at === undefined ? {} : { revokedAt: dbDate(row.revoked_at, 'revocation time') }),
  };
  if (!/^sha256:[0-9a-f]{64}$/u.test(record.tokenHash)) throw new ApiTokenRepositoryError('Stored API token hash is invalid');
  return record;
}

const TOKEN_COLUMNS = 'id, organization_id, user_id, name, token_hash, role_ceiling, scopes, expires_at, created_at, revoked_at';

export class PostgresApiTokenRepository implements ApiTokenRepository {
  private readonly pool: ApiTokenPgPool;
  private readonly table: string;
  private readonly autoMigrate: boolean;
  private migration?: Promise<void>;

  constructor(pool: ApiTokenPgPool, options?: PostgresApiTokenRepositoryOptions);
  constructor(options: PostgresApiTokenRepositoryOptions & { pool: ApiTokenPgPool });
  constructor(poolOrOptions: ApiTokenPgPool | (PostgresApiTokenRepositoryOptions & { pool: ApiTokenPgPool }), options: PostgresApiTokenRepositoryOptions = {}) {
    const supplied = 'pool' in poolOrOptions ? poolOrOptions : options;
    this.pool = 'pool' in poolOrOptions ? poolOrOptions.pool : poolOrOptions;
    this.table = quoteIdentifier(supplied.tableName ?? DEFAULT_API_TOKEN_TABLE);
    this.autoMigrate = supplied.autoMigrate ?? false;
  }

  private async ensureSchema(): Promise<void> {
    if (!this.autoMigrate) return;
    this.migration ??= this.pool.query(postgresApiTokenSchemaSql(this.table.slice(1, -1))).then(() => undefined);
    await this.migration;
  }

  async create(record: ApiTokenRecord): Promise<void> {
    await this.ensureSchema();
    try {
      await this.pool.query(`INSERT INTO ${this.table} (id, organization_id, user_id, name, token_hash, role_ceiling, scopes, expires_at, created_at, revoked_at) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)`, [record.id, record.organizationId, record.userId, record.name, record.tokenHash, record.roleCeiling, JSON.stringify(record.scopes), record.expiresAt, record.createdAt, record.revokedAt ?? null]);
    } catch (error) {
      if (error instanceof ApiTokenError) throw error;
      throw new ApiTokenRepositoryError('API token record could not be created');
    }
  }

  async findByHash(tokenHash: string): Promise<ApiTokenRecord | null> {
    await this.ensureSchema();
    const result = await this.pool.query<Record<string, unknown>>(`SELECT ${TOKEN_COLUMNS} FROM ${this.table} WHERE token_hash = $1 LIMIT 1`, [tokenHash]);
    return result.rows[0] === undefined ? null : rowToRecord(result.rows[0]);
  }

  async findById(organizationId: string, tokenId: string): Promise<ApiTokenRecord | null> {
    await this.ensureSchema();
    const result = await this.pool.query<Record<string, unknown>>(`SELECT ${TOKEN_COLUMNS} FROM ${this.table} WHERE organization_id = $1 AND id = $2 LIMIT 1`, [organizationId, tokenId]);
    return result.rows[0] === undefined ? null : rowToRecord(result.rows[0]);
  }

  async list(organizationId: string, options: { subject?: string; limit?: number } = {}): Promise<ApiTokenRecord[]> {
    await this.ensureSchema();
    const limit = Math.min(1_000, Math.max(1, Math.floor(options.limit ?? DEFAULT_API_TOKEN_MAX_LIST)));
    const parameters: unknown[] = [organizationId];
    const predicates = ['organization_id = $1'];
    if (options.subject !== undefined) { parameters.push(options.subject); predicates.push(`user_id = $${parameters.length}`); }
    parameters.push(limit);
    const result = await this.pool.query<Record<string, unknown>>(`SELECT ${TOKEN_COLUMNS} FROM ${this.table} WHERE ${predicates.join(' AND ')} ORDER BY created_at DESC LIMIT $${parameters.length}`, parameters);
    return result.rows.map(rowToRecord);
  }

  async revoke(organizationId: string, tokenId: string, revokedAt: string): Promise<ApiTokenRecord | null> {
    await this.ensureSchema();
    const result = await this.pool.query<Record<string, unknown>>(`UPDATE ${this.table} SET revoked_at = COALESCE(revoked_at, $3) WHERE organization_id = $1 AND id = $2 RETURNING ${TOKEN_COLUMNS}`, [organizationId, tokenId, revokedAt]);
    return result.rows[0] === undefined ? null : rowToRecord(result.rows[0]);
  }
}

export const createPostgresApiTokenRepository = (pool: ApiTokenPgPool, options: PostgresApiTokenRepositoryOptions = {}): PostgresApiTokenRepository => new PostgresApiTokenRepository(pool, options);
export const createPostgresServiceTokenRepository = createPostgresApiTokenRepository;
