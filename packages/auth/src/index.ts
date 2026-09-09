import type {
  Authenticator,
  Principal,
  Role,
} from '../../contracts/src/index';

export type AuthEnvironment = 'development' | 'test' | 'production';
export type SessionSameSite = 'Lax' | 'Strict' | 'None';

export interface BootstrapTokenConfig {
  id: string;
  /** Plaintext is accepted only as startup configuration and is hashed before use. */
  token?: string;
  /** A pre-hashed SHA-256 token (`sha256:<64 hex>` or 64 hex characters). */
  tokenHash?: string | Uint8Array;
  organizationId: string;
  subject: string;
  roles: Role[];
  namespaces?: string[];
  scopes?: string[];
  expiresAt?: string | number;
  expiresInSeconds?: number;
  kind?: 'user' | 'worker';
  worker?: boolean;
}

export interface AuthenticatedPrincipal extends Principal {
  scopes: string[];
  /** Worker credentials are never converted to browser sessions. */
  identity: 'user' | 'worker';
  tokenId?: string;
}

export interface TokenAuthenticatorOptions {
  tokens?: readonly BootstrapTokenConfig[];
  bootstrapTokens?: readonly BootstrapTokenConfig[];
  workerTokens?: readonly BootstrapTokenConfig[];
  sessionSecret?: string | Uint8Array;
  sessionTtlSeconds?: number;
  cookieName?: string;
  sameSite?: SessionSameSite;
  secureCookies?: boolean;
  environment?: AuthEnvironment;
  publicOrigin?: string;
  allowedOrigins?: readonly string[];
  now?: () => number;
}

export interface AuthEnvironmentVariables {
  readonly [key: string]: string | undefined;
}

export interface CreateAuthenticatorFromEnvOptions extends TokenAuthenticatorOptions {
  /** Explicitly add startup token records in addition to environment records. */
  additionalTokens?: readonly BootstrapTokenConfig[];
}

export class AuthError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 401) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.status = status;
  }
}

export class AuthConfigurationError extends AuthError {
  constructor(message: string) {
    super('AUTH_CONFIGURATION', message, 500);
    this.name = 'AuthConfigurationError';
  }
}

const COOKIE_DEFAULT = 'pskills_session';
const SESSION_VERSION = 1 as const;
const VALID_ROLES: readonly Role[] = ['owner', 'admin', 'publisher', 'reader', 'worker'];
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

interface PreparedToken {
  readonly id: string;
  readonly hash: Uint8Array;
  readonly principal: AuthenticatedPrincipal;
  readonly expiresAtMs?: number;
}

interface SessionClaims {
  readonly v: typeof SESSION_VERSION;
  readonly kind: 'user';
  readonly sub: string;
  readonly org: string;
  readonly roles: Role[];
  readonly namespaces: string[];
  readonly scopes: string[];
  readonly iat: number;
  readonly exp: number;
  readonly sid: string;
}

function cryptoProvider(): Crypto {
  const candidate = (globalThis as typeof globalThis & { crypto?: Crypto }).crypto;
  if (!candidate?.subtle || typeof candidate.getRandomValues !== 'function') {
    throw new AuthConfigurationError('Web Crypto is required for token verification and sessions');
  }
  return candidate;
}

function encoder(): TextEncoder {
  if (typeof TextEncoder === 'undefined') {
    throw new AuthConfigurationError('TextEncoder is required for token verification and sessions');
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
  const result = new Uint8Array(size);
  cryptoProvider().getRandomValues(result);
  return result;
}

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function base64UrlEncode(bytes: Uint8Array): string {
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    output += BASE64URL[first >> 2]!;
    output += BASE64URL[((first & 3) << 4) | ((second ?? 0) >> 4)]!;
    if (second !== undefined) {
      output += BASE64URL[((second & 15) << 2) | ((third ?? 0) >> 6)]!;
    }
    if (third !== undefined) {
      output += BASE64URL[third & 63]!;
    }
  }
  return output;
}

function base64UrlDecode(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return undefined;
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

/** Constant-time comparison for equal- or unequal-length byte strings. */
export function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function clonePrincipal(principal: AuthenticatedPrincipal): AuthenticatedPrincipal {
  return {
    organizationId: principal.organizationId,
    subject: principal.subject,
    roles: [...principal.roles],
    namespaces: principal.namespaces ? [...principal.namespaces] : undefined,
    scopes: [...principal.scopes],
    identity: principal.identity,
    tokenId: principal.tokenId,
  };
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AuthConfigurationError(`Authentication ${field} is required`);
  }
  return value.trim();
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (typeof value === 'string') {
    return value
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new AuthConfigurationError(`Authentication ${field} must be a string array`);
  }
  return value.map((item) => item.trim());
}

function roles(value: unknown, kind: 'user' | 'worker'): Role[] {
  const supplied = value === undefined ? (kind === 'worker' ? ['worker'] : ['reader']) : value;
  const parsed = Array.isArray(supplied) ? supplied : [supplied];
  if (
    parsed.some(
      (role) => typeof role !== 'string' || !VALID_ROLES.includes(role as Role),
    )
  ) {
    throw new AuthConfigurationError('Authentication roles contain an unsupported role');
  }
  const result = [...new Set(parsed as Role[])];
  if (kind === 'worker' && !result.includes('worker')) result.push('worker');
  if (kind === 'user' && result.includes('worker')) {
    throw new AuthConfigurationError('Worker roles require a separate worker identity');
  }
  return result;
}

function expiryMs(value: unknown, expiresInSeconds: unknown, nowMs = Date.now()): number | undefined {
  if (value !== undefined) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value < 1_000_000_000_000 ? value * 1000 : value;
    }
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    throw new AuthConfigurationError('Authentication token expiry is invalid');
  }
  if (expiresInSeconds !== undefined) {
    if (
      typeof expiresInSeconds !== 'number' ||
      !Number.isFinite(expiresInSeconds) ||
      expiresInSeconds <= 0
    ) {
      throw new AuthConfigurationError('Authentication token expiry duration is invalid');
    }
    return nowMs + expiresInSeconds * 1000;
  }
  return undefined;
}

function hashBytes(value: string | Uint8Array): Promise<Uint8Array> {
  return typeof value === 'string' ? sha256(value) : Promise.resolve(new Uint8Array(value));
}

function parseHash(value: string | Uint8Array): Uint8Array {
  if (value instanceof Uint8Array) {
    if (value.byteLength !== 32) {
      throw new AuthConfigurationError('Authentication token hash must be SHA-256');
    }
    return new Uint8Array(value);
  }
  const normalized = value.trim().replace(/^sha256:/i, '');
  if (!/^[0-9a-f]{64}$/i.test(normalized)) {
    throw new AuthConfigurationError('Authentication token hash must be SHA-256');
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) {
    bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function tokenKind(config: BootstrapTokenConfig): 'user' | 'worker' {
  return config.kind === 'worker' || config.worker === true || (Array.isArray(config.roles) && config.roles.includes('worker'))
    ? 'worker'
    : 'user';
}

function normalizeOrigin(value: string): string {
  try {
    const origin = new URL(value).origin;
    if (origin === 'null') throw new Error('opaque origin');
    return origin;
  } catch {
    throw new AuthConfigurationError('Authentication public origin is invalid');
  }
}

function normalizeCookieName(value: string): string {
  if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(value)) {
    throw new AuthConfigurationError('Authentication cookie name is invalid');
  }
  return value;
}

function parseCookieHeader(header: string | null): Map<string, string> {
  const result = new Map<string, string>();
  if (!header) return result;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (!name) continue;
    const value = part.slice(separator + 1).trim();
    result.set(name, value);
  }
  return result;
}

function bearerToken(request: Request): string | undefined {
  const header = request.headers.get('authorization');
  if (!header) return undefined;
  const match = /^Bearer[ \t]+([^ \t]+)$/i.exec(header);
  return match?.[1];
}

function cookieMutation(request: Request): boolean {
  return MUTATING_METHODS.has(request.method.toUpperCase());
}

function isWorker(principal: Principal | null | undefined): principal is AuthenticatedPrincipal {
  return Boolean(
    principal &&
      ((principal as AuthenticatedPrincipal).identity === 'worker' ||
        principal.roles.includes('worker')),
  );
}

export function isWorkerPrincipal(
  principal: Principal | null | undefined,
): principal is AuthenticatedPrincipal {
  return isWorker(principal);
}

/** Scope matching supports exact names and an explicit `prefix:*` grant. */
export function hasScope(principal: Principal | null | undefined, scope: string): boolean {
  if (!principal || !scope) return false;
  const scopes = (principal as AuthenticatedPrincipal).scopes;
  if (!Array.isArray(scopes)) return false;
  return scopes.some(
    (granted) => granted === '*' || granted === scope || (granted.endsWith(':*') && scope.startsWith(granted.slice(0, -1))),
  );
}

export function requireScope(principal: Principal | null | undefined, scope: string): void {
  if (!hasScope(principal, scope)) {
    throw new AuthError('FORBIDDEN', 'The principal lacks the required scope', 403);
  }
}

export function canAccessNamespace(
  principal: Principal | null | undefined,
  namespace: string,
): boolean {
  if (!principal || !namespace) return false;
  if (principal.roles.includes('owner') || principal.roles.includes('admin')) return true;
  const namespaces = principal.namespaces;
  if (!namespaces || namespaces.length === 0) return true;
  return namespaces.includes(namespace);
}

async function prepareToken(config: BootstrapTokenConfig, nowMs = Date.now()): Promise<PreparedToken> {
  const id = nonEmptyString(config.id, 'token id');
  const organizationId = nonEmptyString(config.organizationId, 'organization id');
  const subject = nonEmptyString(config.subject, 'subject');
  const kind = tokenKind(config);
  const principal: AuthenticatedPrincipal = {
    organizationId,
    subject,
    roles: roles(config.roles, kind),
    namespaces: stringArray(config.namespaces, 'namespaces'),
    scopes: stringArray(config.scopes, 'scopes'),
    identity: kind,
    tokenId: id,
  };
  const hash = config.tokenHash !== undefined
    ? parseHash(config.tokenHash)
    : config.token !== undefined
      ? await hashBytes(config.token)
      : (() => {
          throw new AuthConfigurationError('Authentication token material is required');
        })();
  const expiresAtMs = expiryMs(config.expiresAt, config.expiresInSeconds, nowMs);
  return { id, hash, principal, expiresAtMs };
}

async function hmacKey(secret: Uint8Array): Promise<CryptoKey> {
  return cryptoProvider().subtle.importKey(
    'raw',
    secret as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function parseSessionClaims(value: unknown): SessionClaims | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const claims = value as Partial<SessionClaims>;
  if (
    claims.v !== SESSION_VERSION ||
    claims.kind !== 'user' ||
    typeof claims.sub !== 'string' ||
    typeof claims.org !== 'string' ||
    !Array.isArray(claims.roles) ||
    !Array.isArray(claims.namespaces) ||
    !Array.isArray(claims.scopes) ||
    typeof claims.iat !== 'number' ||
    typeof claims.exp !== 'number' ||
    typeof claims.sid !== 'string' ||
    !claims.roles.every((role) => VALID_ROLES.includes(role as Role) && role !== 'worker') ||
    !claims.namespaces.every((item) => typeof item === 'string') ||
    !claims.scopes.every((item) => typeof item === 'string') ||
    !Number.isFinite(claims.iat) ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= claims.iat
  ) {
    return undefined;
  }
  return {
    v: SESSION_VERSION,
    kind: 'user',
    sub: claims.sub,
    org: claims.org,
    roles: [...claims.roles] as Role[],
    namespaces: [...claims.namespaces] as string[],
    scopes: [...claims.scopes] as string[],
    iat: claims.iat,
    exp: claims.exp,
    sid: claims.sid,
  };
}

/**
 * Bearer-token authenticator with short-lived signed browser sessions.
 *
 * Token material is converted to SHA-256 hashes during asynchronous startup;
 * verification hashes the presented credential and compares every configured
 * record with a constant-time comparison.  Raw tokens are never written to
 * logs, cookies, or session claims.
 */
export class TokenAuthenticator implements Authenticator {
  readonly cookieName: string;
  readonly environment: AuthEnvironment;
  readonly secureCookies: boolean;
  readonly publicOrigin?: string;
  private readonly now: () => number;
  private readonly sessionTtlSeconds: number;
  private readonly sameSite: SessionSameSite;
  private readonly allowedOrigins: Set<string>;
  private readonly recordsPromise: Promise<PreparedToken[]>;
  private readonly secretPromise: Promise<Uint8Array>;
  private readonly keyPromise: Promise<CryptoKey>;

  constructor(options: TokenAuthenticatorOptions = {}) {
    this.environment = options.environment ?? 'development';
    this.now = options.now ?? (() => Date.now());
    this.cookieName = normalizeCookieName(options.cookieName ?? COOKIE_DEFAULT);
    this.sameSite = options.sameSite ?? 'Lax';
    this.secureCookies = options.secureCookies ?? this.environment === 'production';
    if (this.sameSite === 'None' && !this.secureCookies) {
      throw new AuthConfigurationError('SameSite=None cookies require Secure');
    }
    this.publicOrigin = options.publicOrigin ? normalizeOrigin(options.publicOrigin) : undefined;
    this.allowedOrigins = new Set([
      ...(this.publicOrigin ? [this.publicOrigin] : []),
      ...(options.allowedOrigins ?? []).map(normalizeOrigin),
    ]);
    this.sessionTtlSeconds = options.sessionTtlSeconds ?? 3_600;
    if (!Number.isFinite(this.sessionTtlSeconds) || this.sessionTtlSeconds <= 0) {
      throw new AuthConfigurationError('Session lifetime must be positive');
    }
    const userTokens = options.tokens ?? options.bootstrapTokens ?? [];
    const workerTokens = (options.workerTokens ?? []).map((token) => ({ ...token, kind: 'worker' as const, worker: true }));
    const allTokens = [...userTokens, ...workerTokens];
    this.recordsPromise = Promise.all(allTokens.map((token) => prepareToken(token, this.now())));

    const suppliedSecret = options.sessionSecret;
    if (suppliedSecret !== undefined) {
      const bytes = typeof suppliedSecret === 'string' ? utf8(suppliedSecret) : new Uint8Array(suppliedSecret);
      if (bytes.length < 32 && this.environment === 'production') {
        throw new AuthConfigurationError('Production session secret must contain at least 32 bytes');
      }
      this.secretPromise = Promise.resolve(bytes);
    } else if (this.environment === 'production') {
      throw new AuthConfigurationError('Production sessions require a configured session secret');
    } else {
      this.secretPromise = Promise.resolve(randomBytes(32));
    }
    this.keyPromise = this.secretPromise.then((secret) => hmacKey(secret));
  }

  async ready(): Promise<void> {
    await Promise.all([this.recordsPromise, this.keyPromise]);
  }

  private async verifyToken(token: string): Promise<PreparedToken | undefined> {
    if (!token) return undefined;
    const presented = await sha256(token);
    const records = await this.recordsPromise;
    const now = this.now();
    let match: PreparedToken | undefined;
    for (const record of records) {
      if (timingSafeEqual(presented, record.hash) && !match) match = record;
    }
    if (!match || (match.expiresAtMs !== undefined && now >= match.expiresAtMs)) return undefined;
    return match;
  }

  private async sign(value: string): Promise<string> {
    const signature = await cryptoProvider().subtle.sign(
      'HMAC',
      await this.keyPromise,
      utf8(value) as BufferSource,
    );
    return base64UrlEncode(new Uint8Array(signature));
  }

  private async verifySignature(value: string, signature: string): Promise<boolean> {
    const bytes = base64UrlDecode(signature);
    if (!bytes) return false;
    const expected = base64UrlDecode(await this.sign(value));
    return Boolean(expected && timingSafeEqual(bytes, expected));
  }

  private originAllowed(request: Request): boolean {
    const origin = request.headers.get('origin');
    if (!origin || this.allowedOrigins.size === 0) return false;
    try {
      return this.allowedOrigins.has(new URL(origin).origin);
    } catch {
      return false;
    }
  }

  /** Enforce same-origin protection for a request carrying a browser session. */
  assertCsrfOrigin(request: Request): void {
    const cookie = parseCookieHeader(request.headers.get('cookie')).get(this.cookieName);
    if (cookie && cookieMutation(request) && !this.originAllowed(request)) {
      throw new AuthError('CSRF_ORIGIN_MISMATCH', 'Cookie mutation requires a matching Origin', 403);
    }
  }

  async authenticate(request: Request): Promise<AuthenticatedPrincipal | null> {
    await this.ready();
    const authorization = request.headers.get('authorization');
    if (authorization) {
      const token = bearerToken(request);
      if (!token) return null;
      const match = await this.verifyToken(token);
      return match ? clonePrincipal(match.principal) : null;
    }

    const raw = parseCookieHeader(request.headers.get('cookie')).get(this.cookieName);
    if (!raw) return null;
    try {
      this.assertCsrfOrigin(request);
    } catch {
      return null;
    }
    const separator = raw.lastIndexOf('.');
    if (separator <= 0) return null;
    const encoded = raw.slice(0, separator);
    const signature = raw.slice(separator + 1);
    if (!(await this.verifySignature(encoded, signature))) return null;
    const bytes = base64UrlDecode(encoded);
    if (!bytes) return null;
    let claimsValue: unknown;
    try {
      claimsValue = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return null;
    }
    const claims = parseSessionClaims(claimsValue);
    const now = this.now();
    if (!claims || now < claims.iat || now >= claims.exp) return null;
    return {
      organizationId: claims.org,
      subject: claims.sub,
      roles: [...claims.roles],
      namespaces: [...claims.namespaces],
      scopes: [...claims.scopes],
      identity: 'user',
    };
  }

  async authenticateWorker(request: Request): Promise<AuthenticatedPrincipal | null> {
    await this.ready();
    const token = bearerToken(request);
    if (!token) return null;
    const match = await this.verifyToken(token);
    if (!match || match.principal.identity !== 'worker') return null;
    return clonePrincipal(match.principal);
  }

  async requirePrincipal(
    request: Request,
    options: { scope?: string; namespace?: string; worker?: boolean } = {},
  ): Promise<AuthenticatedPrincipal> {
    const principal = options.worker
      ? await this.authenticateWorker(request)
      : await this.authenticate(request);
    if (!principal) throw new AuthError('UNAUTHORIZED', 'Authentication is required');
    if (!options.worker && isWorker(principal)) {
      throw new AuthError('FORBIDDEN', 'Worker identity cannot access this user route', 403);
    }
    if (options.scope) requireScope(principal, options.scope);
    if (options.namespace && !canAccessNamespace(principal, options.namespace)) {
      throw new AuthError('FORBIDDEN', 'The principal cannot access this namespace', 403);
    }
    return principal;
  }

  async createSession(token: string): Promise<{ cookie: string; principal: AuthenticatedPrincipal } | null> {
    const match = await this.verifyToken(token.replace(/^Bearer[ \t]+/i, ''));
    if (!match || match.principal.identity === 'worker') return null;
    const now = this.now();
    const configuredExpiry = match.expiresAtMs ?? Number.POSITIVE_INFINITY;
    const expiresAt = Math.min(configuredExpiry, now + this.sessionTtlSeconds * 1000);
    const claims: SessionClaims = {
      v: SESSION_VERSION,
      kind: 'user',
      sub: match.principal.subject,
      org: match.principal.organizationId,
      roles: [...match.principal.roles],
      namespaces: [...(match.principal.namespaces ?? [])],
      scopes: [...match.principal.scopes],
      iat: now,
      exp: expiresAt,
      sid: base64UrlEncode(randomBytes(18)),
    };
    const encoded = base64UrlEncode(utf8(JSON.stringify(claims)));
    const signature = await this.sign(encoded);
    const cookieParts = [
      `${this.cookieName}=${encoded}.${signature}`,
      'Path=/',
      'HttpOnly',
      `SameSite=${this.sameSite}`,
      `Max-Age=${Math.max(1, Math.floor((expiresAt - now) / 1000))}`,
    ];
    if (this.secureCookies) cookieParts.push('Secure');
    return { cookie: cookieParts.join('; '), principal: clonePrincipal(match.principal) };
  }

  clearSessionCookie(): string {
    const cookieParts = [
      `${this.cookieName}=`,
      'Path=/',
      'HttpOnly',
      `SameSite=${this.sameSite}`,
      'Max-Age=0',
    ];
    if (this.secureCookies) cookieParts.push('Secure');
    return cookieParts.join('; ');
  }
}

function envValue(env: AuthEnvironmentVariables, key: string): string | undefined {
  const value = env[key];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

function parseTokenList(raw: string, source: string, forceKind?: 'user' | 'worker'): BootstrapTokenConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AuthConfigurationError(`${source} must be a JSON token list`);
  }
  const entries = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { tokens?: unknown }).tokens)
      ? (parsed as { tokens: unknown[] }).tokens
      : [parsed];
  return entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new AuthConfigurationError(`${source} contains an invalid token record`);
    }
    const record = entry as Record<string, unknown>;
    const principal = record.principal && typeof record.principal === 'object'
      ? (record.principal as Record<string, unknown>)
      : record;
    const kind = forceKind ?? (record.kind === 'worker' || record.worker === true ? 'worker' : undefined);
    const token = record.token ?? record.secret ?? record.value;
    const tokenHash = record.tokenHash ?? record.hash;
    const rolesValue = record.roles ?? principal.roles ?? (kind === 'worker' ? ['worker'] : ['reader']);
    return {
      id: nonEmptyString(record.id ?? `${source}-${index + 1}`, 'token id'),
      ...(typeof token === 'string' ? { token } : {}),
      ...(typeof tokenHash === 'string' || tokenHash instanceof Uint8Array ? { tokenHash } : {}),
      organizationId: nonEmptyString(record.organizationId ?? record.organization ?? record.org ?? principal.organizationId, 'organization id'),
      subject: nonEmptyString(record.subject ?? record.sub ?? principal.subject ?? principal.sub ?? record.id, 'subject'),
      roles: rolesValue as Role[],
      namespaces: stringArray(record.namespaces ?? principal.namespaces, 'namespaces'),
      scopes: stringArray(record.scopes ?? record.scope ?? principal.scopes, 'scopes'),
      expiresAt: record.expiresAt as string | number | undefined,
      expiresInSeconds: record.expiresInSeconds as number | undefined,
      kind: kind ?? ((Array.isArray(rolesValue) && (rolesValue as unknown[]).includes('worker')) ? 'worker' : 'user'),
      worker: forceKind === 'worker' || record.worker === true,
    };
  });
}

/** Parse JSON token configuration without retaining any hash-derived state. */
export function parseBootstrapTokenEnv(
  env: AuthEnvironmentVariables,
): BootstrapTokenConfig[] {
  const result: BootstrapTokenConfig[] = [];
  const list = envValue(env, 'PSKILLS_BOOTSTRAP_TOKENS');
  if (list) result.push(...parseTokenList(list, 'PSKILLS_BOOTSTRAP_TOKENS', 'user'));
  const workerList = envValue(env, 'PSKILLS_WORKER_TOKENS');
  if (workerList) result.push(...parseTokenList(workerList, 'PSKILLS_WORKER_TOKENS', 'worker'));

  const bootstrapToken = envValue(env, 'PSKILLS_BOOTSTRAP_TOKEN');
  const bootstrapTokenHash = envValue(env, 'PSKILLS_BOOTSTRAP_TOKEN_HASH');
  if (bootstrapToken || bootstrapTokenHash) {
    result.push({
      id: envValue(env, 'PSKILLS_BOOTSTRAP_TOKEN_ID') ?? 'bootstrap',
      ...(bootstrapToken ? { token: bootstrapToken } : { tokenHash: bootstrapTokenHash! }),
      organizationId: envValue(env, 'PSKILLS_ORGANIZATION_ID') ?? 'default',
      subject: envValue(env, 'PSKILLS_BOOTSTRAP_SUBJECT') ?? 'bootstrap',
      roles: (envValue(env, 'PSKILLS_BOOTSTRAP_ROLES')
        ? stringArray(envValue(env, 'PSKILLS_BOOTSTRAP_ROLES'), 'bootstrap roles')
        : ['owner']) as Role[],
      namespaces: stringArray(envValue(env, 'PSKILLS_BOOTSTRAP_NAMESPACES'), 'bootstrap namespaces'),
      scopes: stringArray(envValue(env, 'PSKILLS_BOOTSTRAP_SCOPES'), 'bootstrap scopes'),
      kind: 'user',
    });
  }
  const workerToken = envValue(env, 'PSKILLS_WORKER_TOKEN');
  const workerTokenHash = envValue(env, 'PSKILLS_WORKER_TOKEN_HASH');
  if (workerToken || workerTokenHash) {
    result.push({
      id: envValue(env, 'PSKILLS_WORKER_TOKEN_ID') ?? 'worker',
      ...(workerToken ? { token: workerToken } : { tokenHash: workerTokenHash! }),
      organizationId: envValue(env, 'PSKILLS_WORKER_ORGANIZATION_ID') ?? envValue(env, 'PSKILLS_ORGANIZATION_ID') ?? 'default',
      subject: envValue(env, 'PSKILLS_WORKER_SUBJECT') ?? 'worker',
      roles: ['worker'],
      namespaces: stringArray(envValue(env, 'PSKILLS_WORKER_NAMESPACES'), 'worker namespaces'),
      scopes: stringArray(envValue(env, 'PSKILLS_WORKER_SCOPES'), 'worker scopes'),
      kind: 'worker',
      worker: true,
    });
  }
  return result;
}

function environmentObject(): AuthEnvironmentVariables {
  const candidate = (globalThis as typeof globalThis & { process?: { env?: AuthEnvironmentVariables } }).process;
  return candidate?.env ?? {};
}

/** Async startup factory: hashes configured token material before serving requests. */
export async function createAuthenticatorFromEnv(
  env: AuthEnvironmentVariables = environmentObject(),
  options: CreateAuthenticatorFromEnvOptions = {},
): Promise<TokenAuthenticator> {
  const envTokens = parseBootstrapTokenEnv(env);
  const environment = options.environment
    ?? (envValue(env, 'PSKILLS_ENVIRONMENT') as AuthEnvironment | undefined)
    ?? (envValue(env, 'NODE_ENV') === 'production' ? 'production' : 'development');
  if (!['development', 'test', 'production'].includes(environment)) {
    throw new AuthConfigurationError('Authentication environment is invalid');
  }
  const authenticator = new TokenAuthenticator({
    ...options,
    environment,
    tokens: [...envTokens, ...(options.additionalTokens ?? []), ...(options.tokens ?? options.bootstrapTokens ?? [])],
    workerTokens: options.workerTokens,
    publicOrigin: options.publicOrigin ?? envValue(env, 'PSKILLS_PUBLIC_ORIGIN'),
    sessionSecret: options.sessionSecret ?? envValue(env, 'PSKILLS_SESSION_SECRET'),
    cookieName: options.cookieName ?? envValue(env, 'PSKILLS_SESSION_COOKIE') ?? COOKIE_DEFAULT,
  });
  await authenticator.ready();
  return authenticator;
}

export const createTokenAuthenticator = createAuthenticatorFromEnv;
export const BootstrapTokenAuthenticator = TokenAuthenticator;
