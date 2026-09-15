#!/usr/bin/env node

/**
 * Disposable two-provider OIDC and BetterAuth integration fixture.
 *
 * The providers in this file are intentionally local-only protocol fixtures.
 * They have no password form, no arbitrary account input, and no connection to
 * a real identity provider. Their users and companies are the fixed records in
 * tests/fixtures/local-identity-demo-providers.json. Every launch gets fresh
 * client credentials, signing keys, authorization codes, and access tokens.
 *
 * `launch` starts the two providers and builds the app from a working-tree
 * snapshot. The snapshot copies tracked and untracked files so an in-progress
 * packages/identity integration is included; it does not use `git archive`.
 * The app receives a versioned PSKILLS_IDENTITY_PROVIDERS_JSON envelope for
 * the fixture harness. BetterAuth receives the frozen
 * PSKILLS_OIDC_PROVIDERS_JSON array contract used by packages/identity.
 *
 * This utility is a test fixture. It refuses a production environment and only
 * binds HTTP servers to 127.0.0.1. Do not use its configuration for a deployed
 * service.
 */

import {
  chmodSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { Writable } from 'node:stream';
import { execFileSync, spawn } from 'node:child_process';
import {
  createHash,
  createPublicKey,
  createSign,
  createVerify,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const FIXTURE_PATH = path.join(REPO_ROOT, 'tests', 'fixtures', 'local-identity-demo-providers.json');
const RUN_ROOT_PREFIX = '/private/tmp/private-skills-identity-local-';
const DEFAULT_APP_PORT = 5297;
const DEFAULT_LOGIN_PATH = '/login';
const STOP_PROTOCOL_VERSION = 1;
const IDENTITY_DEMO_SCHEMA_VERSION = 1;
const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const MAX_QUERY_VALUE_BYTES = 8 * 1024;
const MAX_SOURCE_FILES = 20_000;
const MAX_SOURCE_BYTES = 300 * 1024 * 1024;
const MAX_SECRET_LENGTH_TO_RETAIN = 512;
const DEFAULT_CALLBACK_PATHS = Object.freeze([
  '/api/auth/callback/{provider}',
  '/auth/callback/{provider}',
  '/api/identity/callback/{provider}',
  '/identity/callback/{provider}',
  '/api/auth/callback/oidc/{provider}',
]);
const EXCLUDED_SOURCE_DIRECTORY_NAMES = new Set([
  '.git',
  'node_modules',
  '.output',
  'dist',
  '.next',
  '.turbo',
  '.wrangler',
  'coverage',
  '.vercel',
]);
const EXCLUDED_SOURCE_FILE_NAMES = new Set(['.env']);

const FIXTURE = loadFixture();
const FIXTURE_PROVIDERS = Object.freeze(FIXTURE.providers.map((provider) => Object.freeze({
  ...provider,
  users: Object.freeze(provider.users.map((user) => Object.freeze({ ...user }))),
  companies: Object.freeze(provider.companies.map((company) => Object.freeze({ ...company }))),
})));
const FIXTURE_BY_ID = new Map(FIXTURE_PROVIDERS.map((provider) => [provider.id, provider]));

if (FIXTURE.schemaVersion !== IDENTITY_DEMO_SCHEMA_VERSION || FIXTURE_PROVIDERS.length !== 2) {
  throw new Error('local identity fixture catalog is invalid');
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === SCRIPT_PATH;

if (isMain) {
  void main().catch((error) => {
    // Errors are deliberately reduced to their static message. In particular,
    // do not print environment values, OAuth codes, or database URLs.
    const message = error instanceof Error ? error.message : 'local identity demo failed';
    process.stderr.write(`local-identity-demo-error:${sanitizeLogText(message)}\n`);
    process.exitCode = 1;
  });
}

function loadFixture() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
  } catch {
    throw new Error('local identity fixture catalog could not be loaded');
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== IDENTITY_DEMO_SCHEMA_VERSION || !Array.isArray(parsed.providers)) {
    throw new Error('local identity fixture catalog is invalid');
  }
  for (const provider of parsed.providers) {
    if (!isRecord(provider) || !isSafeIdentifier(provider.id) || typeof provider.label !== 'string' || !Array.isArray(provider.users) || !Array.isArray(provider.companies)) {
      throw new Error('local identity fixture catalog is invalid');
    }
    for (const user of provider.users) {
      if (!isRecord(user) || !isSafeIdentifier(user.id) || !isSafeIdentifier(user.subject) || typeof user.username !== 'string' || typeof user.name !== 'string' || typeof user.email !== 'string' || !isSafeIdentifier(user.defaultCompanyId)) {
        throw new Error('local identity fixture catalog is invalid');
      }
    }
    for (const company of provider.companies) {
      if (!isRecord(company) || !isSafeIdentifier(company.id) || typeof company.name !== 'string' || !isSafeIdentifier(company.tenantId)) {
        throw new Error('local identity fixture catalog is invalid');
      }
    }
  }
  return parsed;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeIdentifier(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/u.test(value);
}

function sanitizeLogText(value) {
  return String(value).replace(/[\u0000-\u001f\u007f\r\n]+/gu, ' ').slice(0, 512);
}

function bytes(value) {
  return Buffer.byteLength(value, 'utf8');
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString('base64url');
}

function base64UrlDecode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) return undefined;
  try {
    return Buffer.from(value, 'base64url');
  } catch {
    return undefined;
  }
}

function encodeJson(value) {
  return base64UrlEncode(JSON.stringify(value));
}

function decodeJson(value) {
  const decoded = base64UrlDecode(value);
  if (!decoded) return undefined;
  try {
    const parsed = JSON.parse(decoded.toString('utf8'));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function sha256Base64Url(value) {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

export function createPkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: sha256Base64Url(verifier), method: 'S256' };
}

function randomSecret(label) {
  return `identity-demo-${label}-${randomBytes(32).toString('base64url')}`;
}

function writePrivate(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, filePath);
    chmodSync(filePath, 0o600);
  } finally {
    try { unlinkSync(temporaryPath); } catch { /* renamed or already absent */ }
  }
}

function readPrivateJson(filePath) {
  const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  if (!isRecord(parsed)) throw new Error(`private metadata is invalid at ${filePath}`);
  return parsed;
}

function makePrivateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
}

export function assertLoopbackOrigin(value, label = 'origin') {
  if (typeof value !== 'string' || value.length === 0 || bytes(value) > 2_048) {
    throw new Error(`${label} must be a loopback URL`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a loopback URL`);
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.hostname !== '127.0.0.1' ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    (parsed.port !== '' && (!/^\d+$/u.test(parsed.port) || Number(parsed.port) < 1_024 || Number(parsed.port) > 65_535))
  ) {
    throw new Error(`${label} must be a plain 127.0.0.1 URL`);
  }
  return parsed;
}

export function assertDemoEnvironment(environment = process.env) {
  const nodeEnvironment = String(environment.NODE_ENV ?? '').trim().toLowerCase();
  const registryEnvironment = String(environment.PSKILLS_ENVIRONMENT ?? '').trim().toLowerCase();
  if (nodeEnvironment === 'production' || registryEnvironment === 'production') {
    throw new Error('local identity demo refuses a production environment');
  }
  if (String(environment.PSKILLS_IDENTITY_DEMO ?? '').trim().toLowerCase() === 'false') {
    throw new Error('local identity demo requires PSKILLS_IDENTITY_DEMO=true');
  }
}

function assertLoopbackDatabaseUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || bytes(value) > 4_096) {
    throw new Error('identity demo PostgreSQL URL is invalid');
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('identity demo PostgreSQL URL is invalid');
  }
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    !['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
    (parsed.port !== '' && (!/^\d+$/u.test(parsed.port) || Number(parsed.port) < 1 || Number(parsed.port) > 65_535)) ||
    parsed.hash
  ) {
    throw new Error('identity demo PostgreSQL URL must target a local PostgreSQL server');
  }
  return value;
}

function assertSafeRunRoot(runRoot) {
  if (typeof runRoot !== 'string' || !path.isAbsolute(runRoot) || !runRoot.startsWith(RUN_ROOT_PREFIX) || runRoot.includes('..')) {
    throw new Error(`run root must be a disposable path under ${RUN_ROOT_PREFIX}`);
  }
}

function parsePort(value, name, allowZero = false) {
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) throw new Error(`${name} must be a numeric port`);
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < (allowZero ? 0 : 1_024) || port > 65_535) throw new Error(`${name} is outside the local port range`);
  return port;
}

function parseLoginPath(value) {
  if (typeof value !== 'string' || value.length === 0 || bytes(value) > 512 || !value.startsWith('/') || value.startsWith('//') || /[\u0000-\u001f\u007f\\]/u.test(value)) {
    throw new Error('--login-path must be a local app path');
  }
  const parsed = new URL(value, 'http://127.0.0.1');
  if (parsed.origin !== 'http://127.0.0.1' || parsed.username || parsed.password || parsed.hash) throw new Error('--login-path must be a local app path');
  return `${parsed.pathname}${parsed.search}`;
}

export function parseLaunchOptions(args) {
  const values = {
    sourceRoot: REPO_ROOT,
    appPort: DEFAULT_APP_PORT,
    acmePort: 0,
    globexPort: 0,
    databaseUrl: undefined,
    identityAdapter: 'auto',
    loginPath: DEFAULT_LOGIN_PATH,
  };
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    const value = args[index + 1];
    if (name === '--source') {
      if (typeof value !== 'string' || value.startsWith('--')) throw new Error('--source requires a checkout directory');
      values.sourceRoot = path.resolve(value);
      index += 1;
    } else if (name === '--app-port') {
      values.appPort = parsePort(value, name);
      index += 1;
    } else if (name === '--acme-port') {
      values.acmePort = parsePort(value, name, true);
      index += 1;
    } else if (name === '--globex-port') {
      values.globexPort = parsePort(value, name, true);
      index += 1;
    } else if (name === '--database-url') {
      if (typeof value !== 'string' || value.startsWith('--')) throw new Error('--database-url requires a local PostgreSQL URL');
      values.databaseUrl = assertLoopbackDatabaseUrl(value);
      index += 1;
    } else if (name === '--identity-adapter') {
      if (!['auto', 'postgres', 'test'].includes(value)) throw new Error('--identity-adapter must be auto, postgres, or test');
      values.identityAdapter = value;
      index += 1;
    } else if (name === '--login-path') {
      values.loginPath = parseLoginPath(value);
      index += 1;
    } else {
      throw new Error(`unknown launch option ${JSON.stringify(name)}`);
    }
  }
  if (values.acmePort !== 0 && values.acmePort === values.globexPort) throw new Error('provider ports must be distinct');
  if (values.appPort === values.acmePort || values.appPort === values.globexPort) throw new Error('app and provider ports must be distinct');
  return values;
}

function resolveIdentityPersistence(options, environment = process.env) {
  const configuredUrl = options.databaseUrl ?? environment.IDENTITY_DEMO_DATABASE_URL ?? environment.DATABASE_URL;
  if (options.identityAdapter === 'test') {
    return { adapter: 'test', databaseConfigured: false };
  }
  if (configuredUrl !== undefined && configuredUrl.trim() !== '') {
    return { adapter: 'postgres', databaseConfigured: true, databaseUrl: assertLoopbackDatabaseUrl(configuredUrl) };
  }
  if (options.identityAdapter === 'postgres') throw new Error('identity demo PostgreSQL adapter requires --database-url or DATABASE_URL');
  // Without a local database the launcher can still run the provider protocol
  // fixture and the app smoke surface, but it leaves the PostgreSQL-backed
  // BetterAuth runtime disabled. A session proof requires --identity-adapter
  // postgres with a loopback DATABASE_URL.
  return { adapter: 'test', databaseConfigured: false };
}

function redirectPaths(appOrigin, providerId) {
  return [...new Set(DEFAULT_CALLBACK_PATHS.map((template) => `${appOrigin}${template.replace('{provider}', providerId)}`))];
}

function fixedProvider(providerId) {
  const provider = FIXTURE_BY_ID.get(providerId);
  if (!provider) throw new Error('unknown local identity provider');
  return provider;
}

function providerClaims(provider, userId, companyId, issuer) {
  const user = provider.users.find((candidate) => candidate.id === userId);
  const company = provider.companies.find((candidate) => candidate.id === companyId);
  if (!user || !company) throw new Error('local identity selection is invalid');
  return {
    iss: issuer,
    sub: user.subject,
    name: user.name,
    preferred_username: user.username,
    email: user.email,
    email_verified: true,
    company_id: company.id,
    company_name: company.name,
    tenant_id: company.tenantId,
    provider: provider.id,
  };
}

function signJwt(privateKey, header, payload) {
  const encodedHeader = encodeJson(header);
  const encodedPayload = encodeJson(payload);
  const input = `${encodedHeader}.${encodedPayload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(input);
  signer.end();
  return `${input}.${signer.sign(privateKey).toString('base64url')}`;
}

export function decodeJwt(token) {
  if (typeof token !== 'string') return undefined;
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  const header = decodeJson(parts[0]);
  const payload = decodeJson(parts[1]);
  const signature = base64UrlDecode(parts[2]);
  if (!header || !payload || !signature) return undefined;
  return { header, payload, signature, signingInput: `${parts[0]}.${parts[1]}` };
}

export function verifyJwtSignature(token, jwk) {
  const decoded = decodeJwt(token);
  if (!decoded || !isRecord(jwk)) return false;
  try {
    const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
    return requireVerify(decoded.signingInput, decoded.signature, publicKey);
  } catch {
    return false;
  }
}

function requireVerify(input, signature, publicKey) {
  // Keeping this helper separate makes it obvious that signature verification
  // never falls back to claim parsing alone.
  const verifier = createVerify('RSA-SHA256');
  verifier.update(input);
  verifier.end();
  return verifier.verify(publicKey, signature);
}

function publicJwk(publicKey, kid) {
  const exported = publicKey.export({ format: 'jwk' });
  return { ...exported, kid, alg: 'RS256', use: 'sig', kty: 'RSA' };
}

function safeParam(value, field, required = false) {
  if (value === undefined || value === null) {
    if (required) throw new OAuthRequestError('invalid_request', `${field} is required`);
    return undefined;
  }
  if (typeof value !== 'string' || bytes(value) > MAX_QUERY_VALUE_BYTES || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new OAuthRequestError('invalid_request', `invalid ${field}`);
  }
  return value;
}

class OAuthRequestError extends Error {
  constructor(code, description) {
    super(description);
    this.name = 'OAuthRequestError';
    this.code = code;
  }
}

function sendJson(response, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  response.end(body);
}

function sendOAuthError(response, error) {
  const oauthError = error instanceof OAuthRequestError ? error : new OAuthRequestError('invalid_request', 'request rejected');
  sendJson(response, oauthError.code === 'invalid_client' ? 401 : 400, {
    error: oauthError.code,
    error_description: oauthError.message,
  }, oauthError.code === 'invalid_client' ? { 'www-authenticate': 'Basic realm="local-identity-demo"' } : {});
}

function sendMethod(response, methods) {
  sendJson(response, 405, { error: 'method_not_allowed' }, { allow: methods });
}

function sendNotFound(response) {
  sendJson(response, 404, { error: 'not_found' });
}

async function readBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_REQUEST_BODY_BYTES) throw new OAuthRequestError('invalid_request', 'request body is too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function formValues(request) {
  const contentType = request.headers['content-type'] ?? '';
  if (!String(contentType).toLowerCase().startsWith('application/x-www-form-urlencoded')) {
    throw new OAuthRequestError('invalid_request', 'form encoding is required');
  }
  let body;
  try {
    body = await readBody(request);
  } catch (error) {
    if (error instanceof OAuthRequestError) throw error;
    throw new OAuthRequestError('invalid_request', 'request body is invalid');
  }
  return new URLSearchParams(body);
}

function valuesFromUrl(url) {
  return new URLSearchParams(url.search);
}

function valueFrom(values, names, field, required = false) {
  let found;
  for (const name of names) {
    const rawValues = values.getAll(name);
    if (rawValues.length === 0) continue;
    if (rawValues.length !== 1) throw new OAuthRequestError('invalid_request', `${field} is ambiguous`);
    const candidate = safeParam(rawValues[0], field, required);
    if (found !== undefined && candidate !== found) throw new OAuthRequestError('invalid_request', `${field} is ambiguous`);
    found = candidate;
  }
  if (required && found === undefined) throw new OAuthRequestError('invalid_request', `${field} is required`);
  return found;
}

function exactClientCredentials(values, clientId, clientSecret, request) {
  let basicId;
  let basicSecret;
  const authorization = request.headers.authorization;
  if (typeof authorization === 'string' && authorization.startsWith('Basic ')) {
    const encoded = authorization.slice('Basic '.length);
    const decoded = base64UrlDecode(encoded.replace(/=+$/u, '').replace(/\+/gu, '-').replace(/\//gu, '_'));
    if (decoded) {
      const separator = decoded.indexOf(':'.charCodeAt(0));
      if (separator > 0) {
        basicId = decoded.slice(0, separator).toString('utf8');
        basicSecret = decoded.slice(separator + 1).toString('utf8');
      }
    }
  }
  const suppliedId = valueFrom(values, ['client_id'], 'client_id');
  const suppliedSecret = valueFrom(values, ['client_secret'], 'client_secret');
  const effectiveId = suppliedId ?? basicId;
  const effectiveSecret = suppliedSecret ?? basicSecret;
  if (effectiveId !== clientId || effectiveSecret !== clientSecret) throw new OAuthRequestError('invalid_client', 'client authentication failed');
}

function validateRedirect(values, redirectUris) {
  const redirectUri = valueFrom(values, ['redirect_uri'], 'redirect_uri', true);
  if (!redirectUris.includes(redirectUri)) throw new OAuthRequestError('invalid_request', 'redirect URI is not registered');
  return redirectUri;
}

function validateAuthorizationRequest(values, redirectUris, clientId) {
  const suppliedClientId = valueFrom(values, ['client_id'], 'client_id', true);
  if (suppliedClientId !== clientId) throw new OAuthRequestError('invalid_request', 'client is not registered');
  const redirectUri = validateRedirect(values, redirectUris);
  if (valueFrom(values, ['response_type'], 'response_type', true) !== 'code') throw new OAuthRequestError('unsupported_response_type', 'authorization code flow is required');
  const scope = valueFrom(values, ['scope'], 'scope', true);
  if (!scope.split(/[\s]+/u).includes('openid')) throw new OAuthRequestError('invalid_scope', 'openid scope is required');
  const state = valueFrom(values, ['state'], 'state', true);
  const codeChallenge = valueFrom(values, ['code_challenge'], 'code_challenge', true);
  if (!/^[A-Za-z0-9_-]{43,128}$/u.test(codeChallenge)) throw new OAuthRequestError('invalid_request', 'S256 PKCE challenge is required');
  if (valueFrom(values, ['code_challenge_method'], 'code_challenge_method', true) !== 'S256') throw new OAuthRequestError('invalid_request', 'S256 PKCE challenge is required');
  const nonce = valueFrom(values, ['nonce'], 'nonce');
  return { redirectUri, state, codeChallenge, nonce, scope };
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function renderChoicePage(response, provider, issuer, redirectUris, values) {
  const hiddenFields = ['client_id', 'redirect_uri', 'response_type', 'scope', 'state', 'code_challenge', 'code_challenge_method', 'nonce']
    .map((field) => values.has(field) ? `<input type="hidden" name="${field}" value="${htmlEscape(values.get(field))}">` : '')
    .join('');
  const firstUser = provider.users[0];
  const firstCompany = provider.companies.find((company) => company.id === firstUser.defaultCompanyId) ?? provider.companies[0];
  const userOptions = provider.users.map((user) => `<option value="${htmlEscape(user.id)}"${user.id === firstUser.id ? ' selected' : ''}>${htmlEscape(user.name)} (${htmlEscape(user.email)})</option>`).join('');
  const companyOptions = provider.companies.map((company) => `<option value="${htmlEscape(company.id)}"${company.id === firstCompany.id ? ' selected' : ''}>${htmlEscape(company.name)}</option>`).join('');
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${htmlEscape(provider.label)} local sign-in</title></head><body><main><h1>${htmlEscape(provider.label)}</h1><p>Local test identity selector. No real account is used.</p><form method="post" action="${htmlEscape(`${issuer}/authorize`)}">${hiddenFields}<label>User <select name="demo_user" required>${userOptions}</select></label><label>Company <select name="demo_company" required>${companyOptions}</select></label><button type="submit">Continue</button></form></main></body></html>`;
  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-type': 'text/html; charset=utf-8',
    // Chromium treats the loopback fixture as an opaque origin in the
    // embedded browser, so `'self'` alone rejects the otherwise same-origin
    // form POST. Keep the policy strict by allowing only the exact fixture
    // issuer and validated application callback origins for this run.
    'content-security-policy': `default-src 'none'; form-action 'self' ${[issuer, ...redirectUris.map((redirectUri) => new URL(redirectUri).origin)].join(' ')}; style-src 'unsafe-inline'`,
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function createProviderHandler({ provider, issuer, clientId, clientSecret, redirectUris, privateKey, publicKey, kid }) {
  const authorizationCodes = new Map();
  const accessTokens = new Map();
  const pruneRecords = () => {
    const now = Date.now();
    for (const [code, record] of authorizationCodes) {
      if (record.expiresAt <= now) authorizationCodes.delete(code);
    }
    for (const [token, record] of accessTokens) {
      if (record.expiresAt <= now) accessTokens.delete(token);
    }
    while (authorizationCodes.size > 128) authorizationCodes.delete(authorizationCodes.keys().next().value);
    while (accessTokens.size > 128) accessTokens.delete(accessTokens.keys().next().value);
  };
  const jwk = publicJwk(publicKey, kid);

  const discovery = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    userinfo_endpoint: `${issuer}/userinfo`,
    jwks_uri: `${issuer}/jwks.json`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    scopes_supported: ['openid', 'profile', 'email'],
    claims_supported: ['iss', 'sub', 'name', 'preferred_username', 'email', 'email_verified', 'company_id', 'company_name', 'tenant_id', 'provider'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
  };

  async function handle(request, response) {
    pruneRecords();
    let url;
    try {
      url = new URL(request.url ?? '/', issuer);
    } catch {
      sendJson(response, 400, { error: 'invalid_request' });
      return;
    }
    const endpoint = url.pathname;
    try {
      if (request.method === 'GET' && endpoint === '/.well-known/openid-configuration') {
        sendJson(response, 200, discovery);
        return;
      }
      if (request.method === 'GET' && endpoint === '/.well-known/oauth-authorization-server') {
        sendJson(response, 200, discovery);
        return;
      }
      if (request.method === 'GET' && ['/jwks.json', '/.well-known/jwks.json', '/oauth/jwks'].includes(endpoint)) {
        sendJson(response, 200, { keys: [jwk] });
        return;
      }
      if (endpoint === '/health' && request.method === 'GET') {
        sendJson(response, 200, { status: 'ok', provider: provider.id, issuer });
        return;
      }
      if (['/authorize', '/oauth/authorize'].includes(endpoint)) {
        if (!['GET', 'POST'].includes(request.method)) {
          sendMethod(response, 'GET, POST');
          return;
        }
        const values = request.method === 'GET' ? valuesFromUrl(url) : await formValues(request);
        const requestDetails = validateAuthorizationRequest(values, redirectUris, clientId);
        const selectedUser = valueFrom(values, ['demo_user', 'demoUser', 'user_id', 'user'], 'user');
        const selectedCompany = valueFrom(values, ['demo_company', 'demoCompany', 'company_id', 'company'], 'company');
        if (selectedUser === undefined || selectedCompany === undefined) {
          renderChoicePage(response, provider, issuer, redirectUris, values);
          return;
        }
        const user = provider.users.find((candidate) => candidate.id === selectedUser);
        const company = provider.companies.find((candidate) => candidate.id === selectedCompany);
        if (!user || !company) throw new OAuthRequestError('invalid_request', 'local identity selection is not available');
        const code = randomBytes(32).toString('base64url');
        authorizationCodes.set(code, {
          clientId,
          redirectUri: requestDetails.redirectUri,
          codeChallenge: requestDetails.codeChallenge,
          nonce: requestDetails.nonce,
          userId: user.id,
          companyId: company.id,
          expiresAt: Date.now() + 60_000,
        });
        const callback = new URL(requestDetails.redirectUri);
        callback.searchParams.set('code', code);
        callback.searchParams.set('state', requestDetails.state);
        response.writeHead(302, { location: callback.href, 'cache-control': 'no-store' });
        response.end();
        return;
      }
      if (['/token', '/oauth/token'].includes(endpoint)) {
        if (request.method !== 'POST') {
          sendMethod(response, 'POST');
          return;
        }
        const values = await formValues(request);
        if (valueFrom(values, ['grant_type'], 'grant_type', true) !== 'authorization_code') throw new OAuthRequestError('unsupported_grant_type', 'authorization code flow is required');
        exactClientCredentials(values, clientId, clientSecret, request);
        const redirectUri = validateRedirect(values, redirectUris);
        const code = valueFrom(values, ['code'], 'code', true);
        const codeVerifier = valueFrom(values, ['code_verifier'], 'code_verifier', true);
        if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(codeVerifier)) throw new OAuthRequestError('invalid_grant', 'PKCE verification failed');
        const record = authorizationCodes.get(code);
        if (!record || record.expiresAt <= Date.now() || record.clientId !== clientId || record.redirectUri !== redirectUri || sha256Base64Url(codeVerifier) !== record.codeChallenge) {
          throw new OAuthRequestError('invalid_grant', 'authorization code or PKCE verification failed');
        }
        authorizationCodes.delete(code);
        const now = Math.floor(Date.now() / 1_000);
        const accessToken = randomBytes(32).toString('base64url');
        const claims = providerClaims(provider, record.userId, record.companyId, issuer);
        const idToken = signJwt(privateKey, { typ: 'JWT', alg: 'RS256', kid }, {
          ...claims,
          aud: clientId,
          iat: now,
          exp: now + 300,
          ...(record.nonce === undefined ? {} : { nonce: record.nonce }),
        });
        accessTokens.set(accessToken, { claims, expiresAt: Date.now() + 300_000 });
        sendJson(response, 200, {
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: 300,
          id_token: idToken,
          scope: 'openid profile email',
        });
        return;
      }
      if (['/userinfo', '/oauth/userinfo'].includes(endpoint)) {
        if (request.method !== 'GET' && request.method !== 'POST') {
          sendMethod(response, 'GET, POST');
          return;
        }
        const authorization = request.headers.authorization;
        const match = typeof authorization === 'string' ? /^Bearer ([A-Za-z0-9_-]+)$/u.exec(authorization) : null;
        if (!match) {
          sendJson(response, 401, { error: 'invalid_token' }, { 'www-authenticate': 'Bearer' });
          return;
        }
        const record = accessTokens.get(match[1]);
        if (!record || record.expiresAt <= Date.now()) {
          sendJson(response, 401, { error: 'invalid_token' }, { 'www-authenticate': 'Bearer' });
          return;
        }
        sendJson(response, 200, record.claims);
        return;
      }
      sendNotFound(response);
    } catch (error) {
      if (error instanceof OAuthRequestError) sendOAuthError(response, error);
      else sendJson(response, 400, { error: 'invalid_request', error_description: 'request rejected' });
    }
  }
  return handle;
}

export async function startLocalOidcProvider({ providerId, id, appOrigin, port = 0, clientId, clientSecret, callbackPaths = DEFAULT_CALLBACK_PATHS } = {}) {
  assertDemoEnvironment({ NODE_ENV: 'test', PSKILLS_ENVIRONMENT: 'test', PSKILLS_IDENTITY_DEMO: 'true' });
  const provider = fixedProvider(providerId ?? id);
  const app = assertLoopbackOrigin(appOrigin, 'app origin');
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error('identity provider port is invalid');
  if (!Array.isArray(callbackPaths) || callbackPaths.length === 0 || callbackPaths.length > 16) throw new Error('identity callback path configuration is invalid');
  const redirectUris = [...new Set(callbackPaths.map((template) => {
    if (typeof template !== 'string' || !template.startsWith('/') || template.includes('?') || template.includes('#') || /[\u0000-\u001f\u007f]/u.test(template)) throw new Error('identity callback path configuration is invalid');
    const route = template.includes('{provider}') ? template.replaceAll('{provider}', provider.id) : template;
    if (route.startsWith('//')) throw new Error('identity callback path configuration is invalid');
    return `${app.origin}${route}`;
  }))];
  const resolvedClientId = clientId ?? `local-${provider.id}-${randomBytes(12).toString('base64url')}`;
  const resolvedClientSecret = clientSecret ?? randomSecret(provider.id);
  if (typeof resolvedClientId !== 'string' || !/^[A-Za-z0-9._~-]{8,128}$/u.test(resolvedClientId)) throw new Error('identity provider client ID is invalid');
  if (typeof resolvedClientSecret !== 'string' || bytes(resolvedClientSecret) < 32 || bytes(resolvedClientSecret) > 512) throw new Error('identity provider client secret is invalid');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2_048 });
  const kid = `local-${provider.id}-signing-v1`;
  let issuer;
  let handler;
  const server = createServer((request, response) => {
    if (!handler) {
      sendJson(response, 503, { error: 'temporarily_unavailable' });
      return;
    }
    void handler(request, response);
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
  const address = server.address();
  if (!address || typeof address === 'string' || address.address !== '127.0.0.1') {
    await closeServer(server);
    throw new Error('identity provider did not bind to loopback');
  }
  issuer = `http://127.0.0.1:${address.port}`;
  handler = createProviderHandler({
    provider,
    issuer,
    clientId: resolvedClientId,
    clientSecret: resolvedClientSecret,
    redirectUris,
    privateKey,
    publicKey,
    kid,
  });
  const descriptor = {
    schemaVersion: IDENTITY_DEMO_SCHEMA_VERSION,
    id: provider.id,
    label: provider.label,
    issuer,
    issuerUrl: issuer,
    discoveryUrl: `${issuer}/.well-known/openid-configuration`,
    authorizationEndpoint: `${issuer}/authorize`,
    authorizationUri: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`,
    tokenUri: `${issuer}/token`,
    userinfoEndpoint: `${issuer}/userinfo`,
    userinfoUri: `${issuer}/userinfo`,
    jwksUri: `${issuer}/jwks.json`,
    jwksUrl: `${issuer}/jwks.json`,
    redirectUri: redirectUris[0],
    redirectUris,
    clientId: resolvedClientId,
    users: provider.users.map((user) => ({ id: user.id, subject: user.subject, name: user.name, email: user.email, defaultCompanyId: user.defaultCompanyId })),
    companies: provider.companies.map((company) => ({ id: company.id, name: company.name, tenantId: company.tenantId })),
  };
  const clientConfiguration = {
    ...descriptor,
    clientSecret: resolvedClientSecret,
    scopes: ['openid', 'profile', 'email'],
    responseType: 'code',
    codeChallengeMethod: 'S256',
  };
  return {
    id: provider.id,
    label: provider.label,
    issuer,
    clientId: resolvedClientId,
    clientSecret: resolvedClientSecret,
    redirectUris,
    descriptor,
    clientConfiguration,
    fixture: provider,
    server,
    async close() { await closeServer(server); },
  };
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => error ? reject(error) : resolve());
  });
}

export async function startLocalOidcProviders({ appOrigin, acmePort = 0, globexPort = 0 } = {}) {
  const providers = [];
  try {
    providers.push(await startLocalOidcProvider({ providerId: 'acme', appOrigin, port: acmePort }));
    providers.push(await startLocalOidcProvider({ providerId: 'globex', appOrigin, port: globexPort }));
    return providers;
  } catch (error) {
    await Promise.allSettled(providers.map((provider) => provider.close()));
    throw error;
  }
}

export function buildIdentityProviderEnvironment(providers, persistence = { adapter: 'test', databaseConfigured: false }) {
  if (!Array.isArray(providers) || providers.length !== 2 || providers.some((provider) => !provider?.clientConfiguration?.clientSecret)) throw new Error('identity provider configuration is incomplete');
  const envelope = {
    schemaVersion: IDENTITY_DEMO_SCHEMA_VERSION,
    mode: 'local-loopback-test',
    loopbackOnly: true,
    persistence: { adapter: persistence.adapter, databaseConfigured: persistence.databaseConfigured === true },
    providers: providers.map((provider) => provider.clientConfiguration),
  };
  const serialized = JSON.stringify(envelope);
  const betterAuthProviders = providers.map((provider) => ({
    id: provider.id,
    name: provider.label,
    clientId: provider.clientConfiguration.clientId,
    clientSecret: provider.clientConfiguration.clientSecret,
    discoveryUrl: provider.clientConfiguration.discoveryUrl,
    redirectURI: provider.clientConfiguration.redirectUris[0],
    scopes: ['openid', 'profile', 'email'],
  }));
  const betterAuthProvidersSerialized = JSON.stringify(betterAuthProviders);
  return {
    PSKILLS_IDENTITY_DEMO: 'true',
    PSKILLS_IDENTITY_LOOPBACK_ONLY: 'true',
    PSKILLS_IDENTITY_ENVIRONMENT: 'test',
    PSKILLS_IDENTITY_MODE: 'better-auth',
    PSKILLS_AUTH_BACKEND: 'packages/identity',
    PSKILLS_IDENTITY_DATABASE_ADAPTER: persistence.adapter,
    PSKILLS_IDENTITY_DATABASE_CONFIGURED: persistence.databaseConfigured === true ? 'true' : 'false',
    PSKILLS_IDENTITY_PROVIDERS_JSON: serialized,
    PSKILLS_IDENTITY_CONFIG: serialized,
    PSKILLS_AUTH_PROVIDERS_JSON: serialized,
    PSKILLS_OIDC_PROVIDERS_JSON: betterAuthProvidersSerialized,
    BETTER_AUTH_SOCIAL_PROVIDERS_JSON: betterAuthProvidersSerialized,
    BETTER_AUTH_OIDC_PROVIDERS_JSON: betterAuthProvidersSerialized,
    BETTER_AUTH_PROVIDERS_JSON: betterAuthProvidersSerialized,
    PSKILLS_IDENTITY_STORAGE_ADAPTER: persistence.adapter,
    PSKILLS_AUTH_DATABASE_ADAPTER: persistence.adapter,
  };
}

function excludedSourceEntry(name, relativePath) {
  return EXCLUDED_SOURCE_DIRECTORY_NAMES.has(name) || EXCLUDED_SOURCE_FILE_NAMES.has(name) || name.startsWith('.env.') || relativePath.split(path.sep).some((part) => EXCLUDED_SOURCE_DIRECTORY_NAMES.has(part));
}

function gitSourceState(sourceRoot) {
  let head = null;
  let status = [];
  try { head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { /* source may be an untracked fixture */ }
  try {
    const output = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: sourceRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    status = output.split('\n').map((line) => line.trimEnd()).filter(Boolean).map((line) => ({ state: line.slice(0, 2), path: line.slice(3).replace(/^"|"$/gu, '').slice(0, 1_024) }));
  } catch { /* source may be an untracked fixture */ }
  return { head, status };
}

export function createSourceSnapshot({ sourceRoot, destinationRoot } = {}) {
  const source = path.resolve(sourceRoot ?? REPO_ROOT);
  const destination = path.resolve(destinationRoot ?? mkdtempSync(path.join('/private/tmp', 'private-skills-identity-source-')));
  if (!existsSync(source) || !lstatSync(source).isDirectory()) throw new Error('source checkout directory is required');
  if (source === destination || destination.startsWith(`${source}${path.sep}`)) throw new Error('source snapshot destination must be outside the source checkout');
  makePrivateDirectory(destination);
  const files = [];
  const excluded = [];
  let totalBytes = 0;
  function copyDirectory(currentSource, currentDestination, relativeDirectory) {
    for (const entry of readdirSync(currentSource, { withFileTypes: true })) {
      const relativePath = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
      if (excludedSourceEntry(entry.name, relativePath)) {
        excluded.push({ path: relativePath, reason: 'private-or-generated' });
        continue;
      }
      const sourcePath = path.join(currentSource, entry.name);
      const destinationPath = path.join(currentDestination, entry.name);
      const stat = lstatSync(sourcePath);
      if (stat.isDirectory()) {
        mkdirSync(destinationPath, { recursive: true, mode: stat.mode & 0o777 });
        chmodSync(destinationPath, stat.mode & 0o777);
        copyDirectory(sourcePath, destinationPath, relativePath);
      } else if (stat.isFile()) {
        if (files.length >= MAX_SOURCE_FILES || totalBytes + stat.size > MAX_SOURCE_BYTES) throw new Error('source checkout exceeds the bounded local identity snapshot');
        writeFileSync(destinationPath, readFileSync(sourcePath), { mode: stat.mode & 0o777 });
        chmodSync(destinationPath, stat.mode & 0o777);
        const digest = createHash('sha256').update(readFileSync(sourcePath)).digest('hex');
        files.push({ path: relativePath, bytes: stat.size, sha256: `sha256:${digest}` });
        totalBytes += stat.size;
      } else if (stat.isSymbolicLink()) {
        excluded.push({ path: relativePath, reason: 'symlink' });
      } else {
        excluded.push({ path: relativePath, reason: 'unsupported-file' });
      }
    }
  }
  copyDirectory(source, destination, '');
  const sourceState = gitSourceState(source);
  const treeDigest = createHash('sha256').update(files.slice().sort((left, right) => left.path.localeCompare(right.path)).map((file) => `${file.path}\0${file.sha256}\0${file.bytes}\n`).join('')).digest('hex');
  const manifest = {
    schemaVersion: IDENTITY_DEMO_SCHEMA_VERSION,
    snapshotMode: 'working-tree-copy',
    sourceRoot: source,
    sourceHead: sourceState.head,
    createdAt: new Date().toISOString(),
    fileCount: files.length,
    totalBytes,
    treeDigest: `sha256:${treeDigest}`,
    workingTreeChanges: sourceState.status,
    excluded,
    files,
  };
  return { sourceRoot: source, destinationRoot: destination, manifest };
}

function redactionPattern(secret) {
  return new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'gu');
}

export function redactSecrets(value, secrets) {
  let result = String(value);
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 8) continue;
    result = result.replace(redactionPattern(secret), '[redacted]');
  }
  return result;
}

function createRedactingLogWriter(filePath, secrets) {
  // createWriteStream creates the file asynchronously. Create it first so the
  // permission hardening is synchronous and a child can never race a broader
  // default mode.
  if (!existsSync(filePath)) writeFileSync(filePath, '', { encoding: 'utf8', mode: 0o600 });
  chmodSync(filePath, 0o600);
  const destination = createWriteStream(filePath, { flags: 'a', mode: 0o600 });
  let pending = '';
  const retain = Math.min(MAX_SECRET_LENGTH_TO_RETAIN, Math.max(32, ...secrets.filter((secret) => typeof secret === 'string').map((secret) => secret.length)));
  return new Writable({
    write(chunk, encoding, callback) {
      pending += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : Buffer.from(chunk, encoding).toString('utf8');
      const cut = Math.max(0, pending.length - retain);
      if (cut > 0) {
        destination.write(redactSecrets(pending.slice(0, cut), secrets));
        pending = pending.slice(cut);
      }
      callback();
    },
    final(callback) {
      destination.end(redactSecrets(pending, secrets), callback);
    },
  });
}

function routeChildLogs(child, writer) {
  // Child-process stdio accepts real pipes, while the redacting Writable is
  // intentionally stream-only. Pipe both child streams through that writer so
  // credentials are scrubbed before anything reaches the private log file.
  child.stdout?.pipe(writer, { end: false });
  child.stderr?.pipe(writer, { end: false });
  child.once('close', () => writer.end());
}

function resolveInstalledViteEntry(buildRoot) {
  const entry = path.join(buildRoot, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!existsSync(entry)) throw new Error(`the pinned Vite entrypoint is unavailable in the source snapshot`);
  return entry;
}

async function linkDependenciesAsync(sourceRoot, buildRoot) {
  const rootDependencies = path.join(sourceRoot, 'node_modules');
  if (!existsSync(rootDependencies)) throw new Error('source checkout node_modules is required for the local build');
  const { symlinkSync } = await import('node:fs');
  const rootTarget = path.join(buildRoot, 'node_modules');
  if (existsSync(rootTarget)) throw new Error('source snapshot unexpectedly contains node_modules');
  symlinkSync(rootDependencies, rootTarget, 'dir');
  const appsRoot = path.join(sourceRoot, 'apps');
  if (!existsSync(appsRoot)) return;
  for (const entry of readdirSync(appsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dependencies = path.join(appsRoot, entry.name, 'node_modules');
    if (!existsSync(dependencies)) continue;
    const target = path.join(buildRoot, 'apps', entry.name, 'node_modules');
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    symlinkSync(dependencies, target, 'dir');
  }
}

function buildAppEnvironment({ origin, stateRoot, blobRoot, sessionSecret, identitySecret, bootstrapToken, providerEnvironment, persistence, databaseUrl }) {
  const pathValue = typeof process.env.PATH === 'string' && process.env.PATH.length > 0 ? process.env.PATH : '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';
  return {
    PATH: pathValue,
    TMPDIR: '/private/tmp',
    CI: 'true',
    NODE_ENV: 'test',
    PSKILLS_ENVIRONMENT: 'test',
    PSKILLS_PUBLIC_ORIGIN: origin,
    PSKILLS_API_URL: origin,
    PSKILLS_ORGANIZATION_ID: 'identity-demo',
    PSKILLS_BOOTSTRAP_TOKEN: '',
    PSKILLS_BOOTSTRAP_TOKENS: JSON.stringify([{ id: 'identity-demo-owner', token: bootstrapToken, organizationId: 'identity-demo', subject: 'identity-demo-owner', roles: ['owner', 'admin', 'publisher', 'reader'], namespaces: ['@local'], kind: 'user' }]),
    PSKILLS_WORKER_TOKEN: '',
    PSKILLS_WORKER_TOKENS: '[]',
    PSKILLS_SESSION_SECRET: sessionSecret,
    PSKILLS_STATE_PROVIDER: 'file',
    PSKILLS_STATE_PATH: stateRoot,
    PSKILLS_SINGLE_PROCESS: 'true',
    PSKILLS_STORAGE_PROVIDER: 'filesystem',
    PSKILLS_STORAGE_ROOT: blobRoot,
    PSKILLS_STORAGE_BUILD_PROFILE: 'filesystem',
    PSKILLS_RUNTIME_PROFILE: 'node',
    PSKILLS_HOSTED_WORKER: 'false',
    PSKILLS_AI_ENABLED: 'false',
    PSKILLS_DIRECTORY_ENABLED: 'false',
    PSKILLS_PACK_DIRECTORY_ENABLED: 'false',
    PSKILLS_SOURCES_ENABLED: 'false',
    PSKILLS_UPLOAD_REVIEW_ENABLED: 'false',
    BETTER_AUTH_SECRET: identitySecret,
    PSKILLS_BETTER_AUTH_ENABLED: persistence.databaseConfigured === true ? 'true' : 'false',
    PSKILLS_BETTER_AUTH_AUTO_MIGRATE: persistence.databaseConfigured === true ? 'true' : 'false',
    // The disposable PostgreSQL path owns its schema for the run. Disable
    // Better Auth's preflight validator so startup can finish the documented
    // auto-migration before serving browser requests.
    PSKILLS_BETTER_AUTH_VALIDATE_SCHEMA: persistence.databaseConfigured === true ? 'false' : 'true',
    PSKILLS_API_TOKEN_AUTO_MIGRATE: persistence.databaseConfigured === true ? 'true' : 'false',
    BETTER_AUTH_URL: origin,
    BETTER_AUTH_TRUSTED_ORIGINS: origin,
    ...(databaseUrl === undefined ? {} : { BETTER_AUTH_DATABASE_URL: databaseUrl, DATABASE_URL: databaseUrl }),
    ...providerEnvironment,
    PSKILLS_IDENTITY_DATABASE_ADAPTER: persistence.adapter,
    ...(databaseUrl === undefined ? {} : { PSKILLS_IDENTITY_DATABASE_URL: databaseUrl }),
    HOST: '127.0.0.1',
    PORT: String(DEFAULT_APP_PORT),
    NITRO_HOST: '127.0.0.1',
    NITRO_PORT: String(DEFAULT_APP_PORT),
  };
}

function readMetadata(runRoot) {
  assertSafeRunRoot(runRoot);
  const metadataPath = path.join(runRoot, 'work', 'launch-metadata.json');
  if (!existsSync(metadataPath)) throw new Error(`launch metadata is missing at ${metadataPath}`);
  const metadata = readPrivateJson(metadataPath);
  if (metadata.runRoot !== runRoot || metadata.schemaVersion !== IDENTITY_DEMO_SCHEMA_VERSION || !isRecord(metadata.paths) || typeof metadata.paths.stopRequest !== 'string' || typeof metadata.origins?.origin !== 'string') throw new Error('launch metadata is invalid');
  assertLoopbackOrigin(metadata.origins.origin, 'app origin');
  return { metadata, metadataPath };
}

async function requestJson(url, timeoutMs = 2_000) {
  try {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    const value = await response.json().catch(() => ({}));
    return { status: response.status, ok: response.ok, value };
  } catch {
    return { status: 0, ok: false, value: { error: 'unavailable' } };
  }
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function writeStopRequest(stopRequestPath) {
  writePrivate(stopRequestPath, { protocolVersion: STOP_PROTOCOL_VERSION, kind: 'shutdown', requestedAt: new Date().toISOString() });
}

async function launch(options) {
  assertDemoEnvironment();
  const sourceRoot = path.resolve(options.sourceRoot);
  if (!existsSync(sourceRoot) || !lstatSync(sourceRoot).isDirectory()) throw new Error('--source must point to a checkout directory');
  const persistence = resolveIdentityPersistence(options);
  const runId = `${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  const runRoot = `${RUN_ROOT_PREFIX}${runId}`;
  const workRoot = path.join(runRoot, 'work');
  const dataRoot = path.join(workRoot, 'data');
  const stateRoot = path.join(dataRoot, 'state');
  const blobRoot = path.join(dataRoot, 'blobs');
  const logRoot = path.join(workRoot, 'logs');
  for (const directory of [runRoot, workRoot, dataRoot, stateRoot, blobRoot, logRoot]) makePrivateDirectory(directory);
  const sourceSnapshot = createSourceSnapshot({ sourceRoot, destinationRoot: path.join(runRoot, 'source') });
  await linkDependenciesAsync(sourceRoot, sourceSnapshot.destinationRoot);
  const manifestPath = path.join(workRoot, 'source-overlay-manifest.json');
  writePrivate(manifestPath, sourceSnapshot.manifest);
  const origin = `http://127.0.0.1:${options.appPort}`;
  const providers = await startLocalOidcProviders({ appOrigin: origin, acmePort: options.acmePort, globexPort: options.globexPort });
  const providerEnvironment = buildIdentityProviderEnvironment(providers, persistence);
  const sessionSecret = randomSecret('registry-session');
  const identitySecret = randomSecret('better-auth');
  const bootstrapToken = randomSecret('bootstrap');
  const appEnvironment = buildAppEnvironment({
    origin,
    stateRoot,
    blobRoot,
    sessionSecret,
    identitySecret,
    bootstrapToken,
    providerEnvironment,
    persistence,
    databaseUrl: persistence.databaseUrl,
  });
  appEnvironment.PORT = String(options.appPort);
  appEnvironment.NITRO_PORT = String(options.appPort);
  const credentialsPath = path.join(workRoot, 'local-browser-credentials.json');
  // This file only carries a disposable bootstrap token for legacy smoke
  // routes. It is private and never printed; OAuth browser proof uses the two
  // provider links in the metadata instead.
  writePrivate(credentialsPath, { origin, token: bootstrapToken, organizationId: 'identity-demo', namespace: '@local' });
  const metadataPath = path.join(workRoot, 'launch-metadata.json');
  const processesPath = path.join(workRoot, 'processes.json');
  const stopRequestPath = path.join(workRoot, 'stop-request.json');
  const appLogPath = path.join(logRoot, 'app.log');
  const buildLogPath = path.join(logRoot, 'build.log');
  const viteEntry = resolveInstalledViteEntry(sourceSnapshot.destinationRoot);
  const seedUrl = new URL(`${options.loginPath}${options.loginPath.includes('?') ? '&' : '?'}provider=acme`, origin).href;
  const publicProviders = providers.map((provider) => provider.descriptor);
  writePrivate(metadataPath, {
    schemaVersion: IDENTITY_DEMO_SCHEMA_VERSION,
    runRoot,
    runId,
    createdAt: new Date().toISOString(),
    launcherRoot: REPO_ROOT,
    sourceRoot,
    sourceSnapshotRoot: sourceSnapshot.destinationRoot,
    sourceOverlayManifest: manifestPath,
    sourceHead: sourceSnapshot.manifest.sourceHead,
    origins: {
      origin,
      acme: providers[0].issuer,
      globex: providers[1].issuer,
    },
    providers: publicProviders,
    persistence: { adapter: persistence.adapter, databaseConfigured: persistence.databaseConfigured },
    seedUrl,
    seedProvider: 'acme',
    oauthStartUrls: providers.map((provider) => ({
      provider: provider.id,
      loginUrl: new URL(`${options.loginPath}${options.loginPath.includes('?') ? '&' : '?'}provider=${encodeURIComponent(provider.id)}`, origin).href,
      betterAuthSocialStartUrl: new URL(`/api/auth/sign-in/social?provider=${encodeURIComponent(provider.id)}`, origin).href,
      callbackUrl: provider.redirectUris[0],
    })),
    paths: {
      credentials: credentialsPath,
      metadata: metadataPath,
      manifest: manifestPath,
      processes: processesPath,
      stopRequest: stopRequestPath,
      logs: logRoot,
      state: stateRoot,
      blobs: blobRoot,
    },
    stopProtocolVersion: STOP_PROTOCOL_VERSION,
    boundary: {
      real: [
        'built app from the supplied working-tree snapshot',
        'BetterAuth identity backend and its configured persistence adapter',
        'Nitro HTTP routes and browser session callback',
      ],
      deterministic: 'Two fixed local OIDC issuers implement discovery, authorization code, state echo, S256 PKCE, token, userinfo, and RS256 JWKS endpoints.',
      limitations: [
        'The identity provider users and companies are synthetic fixture records only.',
        'The test adapter is provider/app smoke only; use --identity-adapter postgres with a local DATABASE_URL for BetterAuth session evidence.',
        'This launcher is loopback-only and refuses production environments.',
      ],
    },
  });

  const secrets = [sessionSecret, identitySecret, bootstrapToken, ...providers.map((provider) => provider.clientSecret)];
  const appLog = createRedactingLogWriter(appLogPath, secrets);
  const buildLog = createRedactingLogWriter(buildLogPath, secrets);
  // React's SSR transform selects the development jsxDEV runtime whenever the
  // build process sees a non-production NODE_ENV. Keep the running fixture in
  // test mode while building optimized server output so Nitro can render it.
  const buildEnvironment = { ...appEnvironment, NODE_ENV: 'production' };
  const build = spawn(process.execPath, [viteEntry, 'build'], {
    cwd: path.join(sourceSnapshot.destinationRoot, 'apps', 'web'),
    env: buildEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  routeChildLogs(build, buildLog);
  let app;
  let stopping = false;
  let stopRequestPoller;
  let exitCode = 0;
  const writeProcesses = () => writePrivate(processesPath, {
    launcherPid: process.pid,
    buildPid: build.pid ?? null,
    appPid: app?.pid ?? null,
    startedAt: new Date().toISOString(),
  });
  writeProcesses();
  const stopChildren = () => {
    for (const child of [app, build]) {
      if (!child || child.killed) continue;
      try { child.kill('SIGTERM'); } catch { /* already exited */ }
    }
  };
  const shutdown = (code = 0) => {
    if (stopping) return;
    stopping = true;
    exitCode = code;
    if (stopRequestPoller) clearInterval(stopRequestPoller);
    stopChildren();
    void Promise.allSettled(providers.map((provider) => provider.close())).finally(() => {
      setTimeout(() => {
        appLog.end();
        buildLog.end();
        process.exit(exitCode);
      }, 100).unref();
    });
  };
  const fail = (label, detail) => {
    process.stdout.write(`local-identity-${label}-${detail}\n`);
    shutdown(1);
  };
  build.once('error', () => fail('build', 'spawn-failed'));
  build.once('exit', (code, signal) => {
    if (stopping) return;
    if (code !== 0) {
      fail('build', `failed:${code ?? signal}`);
      return;
    }
    app = spawn(process.execPath, [path.join('apps', 'web', '.output', 'server', 'index.mjs')], {
      cwd: sourceSnapshot.destinationRoot,
      env: appEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    routeChildLogs(app, appLog);
    writeProcesses();
    process.stdout.write(`local-identity-app-started:${origin}\n`);
    app.once('error', () => fail('app', 'spawn-failed'));
    app.once('exit', (appCode, appSignal) => {
      if (!stopping && appCode !== 0) fail('app', `failed:${appCode ?? appSignal}`);
    });
  });
  const pollStopRequest = () => {
    if (stopping || !existsSync(stopRequestPath)) return;
    let request;
    try { request = readPrivateJson(stopRequestPath); } catch { fail('stop-request', 'invalid'); return; }
    if (request.protocolVersion !== STOP_PROTOCOL_VERSION || request.kind !== 'shutdown' || typeof request.requestedAt !== 'string') {
      fail('stop-request', 'unsupported-protocol');
      return;
    }
    process.stdout.write('local-identity-stop-request-accepted\n');
    shutdown(0);
  };
  stopRequestPoller = setInterval(pollStopRequest, 250);
  stopRequestPoller.unref();
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.stdout.write([
    `local-identity-run-root:${runRoot}`,
    `local-identity-app:${origin}`,
    `local-identity-acme:${providers[0].issuer}`,
    `local-identity-globex:${providers[1].issuer}`,
    `local-identity-seed-url:${seedUrl}`,
    `local-identity-metadata:${metadataPath}`,
    `local-identity-manifest:${manifestPath}`,
    `local-identity-stop-request:${stopRequestPath}`,
    `local-identity-persistence:${persistence.adapter}`,
    'local-identity-loopback-only:true',
    'local-identity-secrets:ephemeral-private',
  ].join('\n') + '\n');
}

async function seed(runRoot, providerId = 'acme') {
  const { metadata } = readMetadata(runRoot);
  if (!['acme', 'globex'].includes(providerId)) throw new Error('seed provider must be acme or globex');
  const selected = metadata.oauthStartUrls?.find((entry) => entry.provider === providerId);
  if (!selected) throw new Error('seed provider is not available');
  const seedPath = path.join(runRoot, 'work', 'identity-demo-seed.json');
  writePrivate(seedPath, {
    schemaVersion: IDENTITY_DEMO_SCHEMA_VERSION,
    provider: providerId,
    loginUrl: selected.loginUrl,
    betterAuthSocialStartUrl: selected.betterAuthSocialStartUrl,
    callbackUrl: selected.callbackUrl,
    users: metadata.providers.find((provider) => provider.id === providerId)?.users ?? [],
    companies: metadata.providers.find((provider) => provider.id === providerId)?.companies ?? [],
  });
  process.stdout.write(`local-identity-seed-url:${selected.loginUrl}\nlocal-identity-seed:${seedPath}\n`);
}

async function status(runRoot) {
  const { metadata } = readMetadata(runRoot);
  const checks = await Promise.all([
    requestJson(new URL('/health', metadata.origins.origin).href),
    ...Object.entries(metadata.origins).filter(([name]) => name !== 'origin').map(async ([name, issuer]) => [name, await requestJson(new URL('/health', issuer).href)]),
  ]);
  const appCheck = checks[0];
  const providers = Object.fromEntries(checks.slice(1));
  const processes = existsSync(metadata.paths.processes) ? readPrivateJson(metadata.paths.processes) : {};
  process.stdout.write(`${JSON.stringify({
    schemaVersion: IDENTITY_DEMO_SCHEMA_VERSION,
    runRoot,
    app: { origin: metadata.origins.origin, ...appCheck },
    providers,
    persistence: metadata.persistence,
    processes: {
      launcherAlive: processAlive(processes.launcherPid),
      buildAlive: processAlive(processes.buildPid),
      appAlive: processAlive(processes.appPid),
    },
  }, null, 2)}\n`);
}

async function stop(runRoot) {
  const { metadata } = readMetadata(runRoot);
  writeStopRequest(metadata.paths.stopRequest);
  process.stdout.write(`local-identity-stop-request:${metadata.paths.stopRequest}\n`);
}

async function teardown(runRoot) {
  const { metadata } = readMetadata(runRoot);
  writeStopRequest(metadata.paths.stopRequest);
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    const processes = existsSync(metadata.paths.processes) ? readPrivateJson(metadata.paths.processes) : {};
    if (!processAlive(processes.launcherPid)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const processes = existsSync(metadata.paths.processes) ? readPrivateJson(metadata.paths.processes) : {};
  if (processAlive(processes.launcherPid) || processAlive(processes.appPid) || processAlive(processes.buildPid)) throw new Error('identity demo processes did not stop; run stop and inspect status before teardown');
  assertSafeRunRoot(runRoot);
  rmSync(runRoot, { recursive: true, force: true });
  process.stdout.write(`local-identity-teardown:${runRoot}\n`);
}

function printHelp() {
  process.stdout.write([
    'Disposable local BetterAuth identity demo:',
    '',
    '  node scripts/local-identity-demo.mjs launch [--source CHECKOUT] [--app-port 5297] [--acme-port 0] [--globex-port 0] [--identity-adapter auto|postgres|test] [--database-url LOCAL_POSTGRES_URL] [--login-path /login]',
    '  node scripts/local-identity-demo.mjs seed <run-root> [acme|globex]',
    '  node scripts/local-identity-demo.mjs status <run-root>',
    '  node scripts/local-identity-demo.mjs stop <run-root>',
    '  node scripts/local-identity-demo.mjs teardown <run-root>',
    '',
    'launch copies the supplied working tree, including uncommitted files, and writes a private source-overlay manifest.',
    'The app receives two fixed local OIDC providers through PSKILLS_IDENTITY_PROVIDERS_JSON.',
    'Use --identity-adapter postgres with a loopback DATABASE_URL for real BetterAuth PostgreSQL persistence; auto uses the agreed disposable test adapter when no URL is supplied.',
    'The launcher refuses production environments, binds every provider to 127.0.0.1, and keeps generated secrets out of output and logs.',
  ].join('\n') + '\n');
}

async function main() {
  const command = process.argv[2] ?? 'help';
  if (command === 'launch') {
    await launch(parseLaunchOptions(process.argv.slice(3)));
    return;
  }
  if (command === 'seed') {
    const runRoot = process.argv[3];
    if (typeof runRoot !== 'string' || runRoot.length === 0) throw new Error('a disposable run root is required');
    await seed(runRoot, process.argv[4] ?? 'acme');
    return;
  }
  if (command === 'status') {
    const runRoot = process.argv[3];
    if (typeof runRoot !== 'string' || runRoot.length === 0) throw new Error('a disposable run root is required');
    await status(runRoot);
    return;
  }
  if (command === 'stop') {
    const runRoot = process.argv[3];
    if (typeof runRoot !== 'string' || runRoot.length === 0) throw new Error('a disposable run root is required');
    await stop(runRoot);
    return;
  }
  if (command === 'teardown') {
    const runRoot = process.argv[3];
    if (typeof runRoot !== 'string' || runRoot.length === 0) throw new Error('a disposable run root is required');
    await teardown(runRoot);
    return;
  }
  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }
  throw new Error(`unknown command ${JSON.stringify(command)}; use help`);
}
