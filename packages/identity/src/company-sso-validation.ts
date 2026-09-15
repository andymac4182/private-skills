import {
  deriveSAMLIdentityProviderEntityID,
  deriveSAMLServiceProviderPolicy,
} from '@better-auth/sso';

import {
  COMPANY_SSO_CALLBACK_PATH,
  COMPANY_SSO_MAX_DISCOVERY_BYTES,
  COMPANY_SSO_MAX_DISPLAY_NAME_LENGTH,
  COMPANY_SSO_MAX_METADATA_BYTES,
  COMPANY_SSO_MAX_ORGANIZATION_ID_LENGTH,
  COMPANY_SSO_MAX_PROVIDER_ID_LENGTH,
  CompanySsoValidationError,
  type CompanySsoOidcConfig,
  type CompanySsoProviderCreateInput,
  type CompanySsoProviderRecord,
  type CompanySsoProtocol,
  type CompanySsoSamlConfig,
  type CompanySsoSamlIdpMetadata,
  type CompanySsoValidationPolicy,
} from './company-sso-types.js';

const PROVIDER_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u;
const ORGANIZATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DISPLAY_NAME_FALLBACK = 'Company SSO';
const RESERVED_PROVIDER_IDS = new Set(['github', 'google', 'microsoft', 'credential', 'email', 'password']);
const OIDC_SCOPES_DEFAULT = ['openid', 'profile', 'email'] as const;
const OIDC_DISCOVERY_SUFFIX = '/.well-known/openid-configuration';
const SAML_ALLOWED_BINDINGS = new Set([
  'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect',
  'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST',
]);

export interface ValidatedCompanySsoRegistration {
  organizationId: string;
  providerId: string;
  displayName: string;
  protocol: CompanySsoProtocol;
  issuer: string;
  callbackUrl: string;
  status: 'active' | 'disabled';
  oidc?: CompanySsoOidcConfig;
  saml?: CompanySsoSamlConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function boundedString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw new CompanySsoValidationError('INVALID_REQUEST', `${field} is required`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new CompanySsoValidationError('INVALID_REQUEST', `${field} is invalid`);
  }
  return normalized;
}

export function normalizeCompanyOrganizationId(value: unknown, field = 'organizationId'): string {
  const id = boundedString(value, field, COMPANY_SSO_MAX_ORGANIZATION_ID_LENGTH);
  if (!ORGANIZATION_ID_PATTERN.test(id)) {
    throw new CompanySsoValidationError('INVALID_ORGANIZATION', `${field} is invalid`);
  }
  return id;
}

export function normalizeCompanyProviderId(value: unknown, field = 'providerId'): string {
  const id = boundedString(value, field, COMPANY_SSO_MAX_PROVIDER_ID_LENGTH);
  if (!PROVIDER_ID_PATTERN.test(id) || RESERVED_PROVIDER_IDS.has(id.toLowerCase())) {
    throw new CompanySsoValidationError('INVALID_PROVIDER_ID', `${field} is invalid or reserved`);
  }
  return id;
}

function normalizeDisplayName(value: unknown): string {
  if (value === undefined) return DISPLAY_NAME_FALLBACK;
  return boundedString(value, 'displayName', COMPANY_SSO_MAX_DISPLAY_NAME_LENGTH);
}

export function normalizeCompanySsoDisplayName(value: unknown): string {
  return normalizeDisplayName(value);
}

export function normalizeCompanySsoStatus(value: unknown): 'active' | 'disabled' {
  if (value === undefined) return 'active';
  if (value === 'active' || value === 'disabled') return value;
  throw new CompanySsoValidationError('INVALID_STATUS', 'status must be active or disabled');
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function parseSafeUrl(value: unknown, field: string, policy: CompanySsoValidationPolicy, options: { allowPath?: boolean } = {}): URL {
  const raw = boundedString(value, field, 2_048);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new CompanySsoValidationError('INVALID_URL', `${field} must be an absolute URL`);
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && policy.allowLoopbackHttp === true && isLoopback(parsed.hostname))) {
    throw new CompanySsoValidationError('INSECURE_URL', `${field} must use HTTPS`);
  }
  if (parsed.username || parsed.password || parsed.hash || (!options.allowPath && parsed.pathname !== '/')) {
    throw new CompanySsoValidationError('INVALID_URL', `${field} contains unsupported URL components`);
  }
  return parsed;
}

export function normalizeCompanyIssuer(value: unknown, policy: CompanySsoValidationPolicy): string {
  const parsed = parseSafeUrl(value, 'issuer', policy, { allowPath: true });
  if (parsed.search) throw new CompanySsoValidationError('INVALID_ISSUER', 'issuer must not contain a query string');
  const path = parsed.pathname.replace(/\/+$/u, '');
  return `${parsed.origin}${path}`;
}

export function normalizeCompanyAppOrigin(value: string, allowLoopbackHttp = false): string {
  const policy: CompanySsoValidationPolicy = { appOrigin: value, allowLoopbackHttp };
  const parsed = parseSafeUrl(value, 'appOrigin', policy);
  return parsed.origin;
}

export function companySsoCallbackUrl(appOrigin: string, providerId: string, allowLoopbackHttp = false): string {
  const origin = normalizeCompanyAppOrigin(appOrigin, allowLoopbackHttp);
  const normalizedProviderId = normalizeCompanyProviderId(providerId);
  return `${origin}${COMPANY_SSO_CALLBACK_PATH}/${encodeURIComponent(normalizedProviderId)}`;
}

function assertExactCallback(callbackValue: unknown, expected: string, policy: CompanySsoValidationPolicy): string {
  if (callbackValue === undefined) return expected;
  const callback = parseSafeUrl(callbackValue, 'callbackUrl', policy, { allowPath: true });
  if (callback.search || callback.hash || callback.origin !== new URL(expected).origin || callback.toString() !== expected) {
    throw new CompanySsoValidationError('CALLBACK_MISMATCH', 'callbackUrl must exactly match the generated company callback');
  }
  return expected;
}

function assertNoEmailDomainDiscovery(input: Record<string, unknown>): void {
  for (const key of ['domain', 'organizationSlug', 'emailDomain', 'email']) {
    if (key in input) throw new CompanySsoValidationError('DOMAIN_DISCOVERY_DISABLED', 'Company SSO requires an explicit provider selection');
  }
}

function validateScopes(value: unknown): string[] {
  if (value === undefined) return [...OIDC_SCOPES_DEFAULT];
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new CompanySsoValidationError('INVALID_SCOPES', 'OIDC scopes must be a bounded non-empty array');
  }
  const scopes = value.map((scope) => boundedString(scope, 'OIDC scope', 128));
  return [...new Set(scopes)];
}

function normalizedEndpoint(value: unknown, field: string, policy: CompanySsoValidationPolicy): string {
  const endpoint = parseSafeUrl(value, field, policy, { allowPath: true });
  if (endpoint.search || endpoint.hash) throw new CompanySsoValidationError('INVALID_DISCOVERY', `${field} must not contain query or fragment`);
  return endpoint.toString();
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && /^\d+$/u.test(declaredLength) && Number(declaredLength) > maximumBytes) {
    throw new CompanySsoValidationError('DISCOVERY_TOO_LARGE', 'OIDC discovery response exceeds the configured size limit');
  }
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maximumBytes) {
      throw new CompanySsoValidationError('DISCOVERY_TOO_LARGE', 'OIDC discovery response exceeds the configured size limit');
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      length += chunk.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new CompanySsoValidationError('DISCOVERY_TOO_LARGE', 'OIDC discovery response exceeds the configured size limit');
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(merged);
}

function discoveryString(document: Record<string, unknown>, field: string): string {
  return boundedString(document[field], `OIDC discovery ${field}`, 2_048);
}

export interface CompanySsoOidcDiscoveryResult {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksEndpoint: string;
  userInfoEndpoint?: string;
}

/**
 * Fetch and validate discovery at registration time. Redirects, issuer drift,
 * missing JWKS, and insecure endpoints fail before any provider is persisted.
 */
export async function discoverCompanyOidc(
  issuer: string,
  discoveryUrl: unknown,
  policy: CompanySsoValidationPolicy,
): Promise<CompanySsoOidcDiscoveryResult> {
  const normalizedIssuer = normalizeCompanyIssuer(issuer, policy);
  const parsedDiscoveryUrl = parseSafeUrl(discoveryUrl, 'discoveryUrl', policy, { allowPath: true });
  const expectedDiscovery = `${normalizedIssuer}${OIDC_DISCOVERY_SUFFIX}`;
  if (parsedDiscoveryUrl.search || parsedDiscoveryUrl.hash || parsedDiscoveryUrl.toString() !== expectedDiscovery) {
    throw new CompanySsoValidationError('DISCOVERY_MISMATCH', 'discoveryUrl must be the issuer well-known endpoint');
  }
  const fetcher = policy.fetch ?? globalThis.fetch;
  if (typeof fetcher !== 'function') throw new CompanySsoValidationError('DISCOVERY_UNAVAILABLE', 'OIDC discovery is unavailable');
  let response: Response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    response = await fetcher(parsedDiscoveryUrl.toString(), {
      method: 'GET',
      redirect: 'error',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
  } catch {
    throw new CompanySsoValidationError('DISCOVERY_UNAVAILABLE', 'OIDC discovery could not be fetched');
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new CompanySsoValidationError('DISCOVERY_UNAVAILABLE', 'OIDC discovery returned an error');
  if (response.url && response.url !== parsedDiscoveryUrl.toString()) {
    throw new CompanySsoValidationError('DISCOVERY_REDIRECT', 'OIDC discovery redirected away from the exact endpoint');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(await readBoundedResponse(response, policy.maxDiscoveryBytes ?? COMPANY_SSO_MAX_DISCOVERY_BYTES));
  } catch (error) {
    if (error instanceof CompanySsoValidationError) throw error;
    throw new CompanySsoValidationError('DISCOVERY_INVALID', 'OIDC discovery returned invalid JSON');
  }
  if (!isRecord(decoded)) throw new CompanySsoValidationError('DISCOVERY_INVALID', 'OIDC discovery must be a JSON object');
  const documentIssuer = normalizeCompanyIssuer(discoveryString(decoded, 'issuer'), policy);
  if (documentIssuer !== normalizedIssuer) throw new CompanySsoValidationError('ISSUER_MISMATCH', 'OIDC discovery issuer does not match the configured issuer');
  const authorizationEndpoint = normalizedEndpoint(discoveryString(decoded, 'authorization_endpoint'), 'authorization_endpoint', policy);
  const tokenEndpoint = normalizedEndpoint(discoveryString(decoded, 'token_endpoint'), 'token_endpoint', policy);
  const jwksEndpoint = normalizedEndpoint(discoveryString(decoded, 'jwks_uri'), 'jwks_uri', policy);
  const userInfoEndpoint = decoded.userinfo_endpoint === undefined
    ? undefined
    : normalizedEndpoint(decoded.userinfo_endpoint, 'userinfo_endpoint', policy);
  return { issuer: normalizedIssuer, authorizationEndpoint, tokenEndpoint, jwksEndpoint, ...(userInfoEndpoint ? { userInfoEndpoint } : {}) };
}

function assertMetadataSize(metadata: string | undefined, field: string): void {
  if (metadata !== undefined && new TextEncoder().encode(metadata).byteLength > COMPANY_SSO_MAX_METADATA_BYTES) {
    throw new CompanySsoValidationError('SAML_METADATA_TOO_LARGE', `${field} metadata exceeds the configured size limit`);
  }
}

function normalizedCerts(value: unknown, field: string): string | readonly string[] | undefined {
  if (value === undefined) return undefined;
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0 || values.length > 8) throw new CompanySsoValidationError('INVALID_SAML_CERTIFICATE', `${field} must contain a bounded certificate list`);
  const normalized = values.map((cert) => boundedString(cert, field, 16_384));
  return Array.isArray(value) ? normalized : normalized[0];
}

function normalizeSamlMetadata(value: unknown, policy: CompanySsoValidationPolicy): CompanySsoSamlIdpMetadata {
  if (!isRecord(value)) throw new CompanySsoValidationError('INVALID_SAML_METADATA', 'saml.idpMetadata is required');
  const metadata = value.metadata === undefined ? undefined : boundedString(value.metadata, 'SAML IdP metadata', COMPANY_SSO_MAX_METADATA_BYTES);
  assertMetadataSize(metadata, 'SAML IdP');
  const entityID = value.entityID === undefined ? undefined : boundedString(value.entityID, 'SAML IdP entityID', 2_048);
  const cert = normalizedCerts(value.cert, 'SAML IdP certificate');
  const services = value.singleSignOnService === undefined ? undefined : value.singleSignOnService;
  if (services !== undefined) {
    if (!Array.isArray(services) || services.length === 0 || services.length > 4) throw new CompanySsoValidationError('INVALID_SAML_METADATA', 'SAML SSO services are invalid');
    for (const service of services) {
      if (!isRecord(service) || typeof service.Binding !== 'string' || !SAML_ALLOWED_BINDINGS.has(service.Binding)) {
        throw new CompanySsoValidationError('INVALID_SAML_METADATA', 'SAML SSO binding is invalid');
      }
      normalizedEndpoint(service.Location, 'SAML SSO Location', policy);
    }
  }
  if (!metadata && !entityID) throw new CompanySsoValidationError('INVALID_SAML_METADATA', 'SAML IdP metadata needs metadata XML or entityID');
  if (!metadata && !cert) throw new CompanySsoValidationError('INVALID_SAML_CERTIFICATE', 'Manual SAML metadata needs a signing certificate');
  if (metadata && !/<(?:[A-Za-z_][\w.-]*:)?X509Certificate[\s>]/u.test(metadata)) {
    throw new CompanySsoValidationError('INVALID_SAML_CERTIFICATE', 'SAML metadata must contain a signing certificate');
  }
  return {
    ...(metadata ? { metadata } : {}),
    ...(entityID ? { entityID } : {}),
    ...(cert ? { cert } : {}),
    ...(services ? { singleSignOnService: services as CompanySsoSamlIdpMetadata['singleSignOnService'] } : {}),
  };
}

function normalizeSaml(input: unknown, issuer: string, callbackUrl: string, policy: CompanySsoValidationPolicy): CompanySsoSamlConfig {
  if (!isRecord(input)) throw new CompanySsoValidationError('INVALID_SAML_CONFIG', 'saml configuration is required');
  const entryPoint = normalizedEndpoint(input.entryPoint, 'SAML entryPoint', policy);
  const idpMetadata = normalizeSamlMetadata(input.idpMetadata, policy);
  const wantAssertionsSigned = input.wantAssertionsSigned === undefined ? true : input.wantAssertionsSigned;
  if (wantAssertionsSigned !== true) throw new CompanySsoValidationError('SAML_SIGNED_ASSERTIONS_REQUIRED', 'Company SSO requires signed SAML assertions');
  if ('idpInitiatedCallbackUrl' in input || 'allowIdpInitiated' in input) {
    throw new CompanySsoValidationError('SAML_IDP_INITIATED_DISABLED', 'IdP-initiated SAML is disabled for company SSO');
  }
  const authnRequestsSigned = input.authnRequestsSigned === undefined ? undefined : input.authnRequestsSigned;
  if (authnRequestsSigned !== undefined && typeof authnRequestsSigned !== 'boolean') throw new CompanySsoValidationError('INVALID_SAML_CONFIG', 'authnRequestsSigned must be boolean');
  const privateKey = input.privateKey === undefined ? undefined : boundedString(input.privateKey, 'SAML privateKey', 32_768);
  if (authnRequestsSigned === true && !privateKey) throw new CompanySsoValidationError('SAML_KEY_REQUIRED', 'Signed SAML AuthnRequests require a private key');
  const audience = input.audience === undefined ? undefined : boundedString(input.audience, 'SAML audience', 2_048);
  const identifierFormat = input.identifierFormat === undefined ? undefined : boundedString(input.identifierFormat, 'SAML identifierFormat', 512);
  const signatureAlgorithm = input.signatureAlgorithm === undefined ? undefined : boundedString(input.signatureAlgorithm, 'SAML signatureAlgorithm', 256);
  const digestAlgorithm = input.digestAlgorithm === undefined ? undefined : boundedString(input.digestAlgorithm, 'SAML digestAlgorithm', 256);
  const config = {
    issuer,
    entryPoint,
    idpMetadata,
    callbackUrl,
    wantAssertionsSigned: true as const,
    ...(audience ? { audience } : {}),
    ...(authnRequestsSigned === undefined ? {} : { authnRequestsSigned }),
    ...(privateKey ? { privateKey } : {}),
    ...(identifierFormat ? { identifierFormat } : {}),
    ...(signatureAlgorithm ? { signatureAlgorithm } : {}),
    ...(digestAlgorithm ? { digestAlgorithm } : {}),
  } satisfies CompanySsoSamlConfig & { issuer: string };
  try {
    const idpEntityID = deriveSAMLIdentityProviderEntityID(config as Parameters<typeof deriveSAMLIdentityProviderEntityID>[0]);
    if (idpMetadata.entityID !== undefined && idpEntityID !== idpMetadata.entityID) {
      throw new CompanySsoValidationError('SAML_ISSUER_MISMATCH', 'SAML metadata entityID changed during validation');
    }
    const policyResult = deriveSAMLServiceProviderPolicy(config as Parameters<typeof deriveSAMLServiceProviderPolicy>[0]);
    if (!policyResult.wantAssertionsSigned) throw new CompanySsoValidationError('SAML_SIGNED_ASSERTIONS_REQUIRED', 'SAML service provider metadata does not require signed assertions');
  } catch (error) {
    if (error instanceof CompanySsoValidationError) throw error;
    throw new CompanySsoValidationError('INVALID_SAML_METADATA', 'SAML metadata could not be parsed');
  }
  return config;
}

export async function validateCompanySsoRegistration(
  organizationIdValue: unknown,
  input: CompanySsoProviderCreateInput,
  policy: CompanySsoValidationPolicy,
): Promise<ValidatedCompanySsoRegistration> {
  const organizationId = normalizeCompanyOrganizationId(organizationIdValue);
  if (!isRecord(input)) throw new CompanySsoValidationError('INVALID_REQUEST', 'Company SSO body must be an object');
  assertNoEmailDomainDiscovery(input);
  if (input.organizationId !== undefined && normalizeCompanyOrganizationId(input.organizationId) !== organizationId) {
    throw new CompanySsoValidationError('ORGANIZATION_MISMATCH', 'The request organization does not match the company portal', 403);
  }
  const providerId = normalizeCompanyProviderId(input.providerId);
  const displayName = normalizeDisplayName(input.displayName);
  const protocol = input.protocol;
  if (protocol !== 'oidc' && protocol !== 'saml') throw new CompanySsoValidationError('INVALID_PROTOCOL', 'protocol must be oidc or saml');
  const issuer = normalizeCompanyIssuer(input.issuer, policy);
  const callbackUrl = companySsoCallbackUrl(policy.appOrigin, providerId, policy.allowLoopbackHttp === true);
  assertExactCallback(input.callbackUrl, callbackUrl, policy);
  const status = normalizeCompanySsoStatus(input.status);
  if (protocol === 'oidc') {
    if (!isRecord(input.oidc) || input.saml !== undefined) throw new CompanySsoValidationError('INVALID_OIDC_CONFIG', 'OIDC providers require only oidc configuration');
    const clientId = boundedString(input.oidc.clientId, 'OIDC clientId', 512);
    const clientSecret = boundedString(input.oidc.clientSecret, 'OIDC clientSecret', 4_096);
    const discovery = await discoverCompanyOidc(issuer, input.oidc.discoveryUrl, policy);
    const scopes = validateScopes(input.oidc.scopes);
    return {
      organizationId,
      providerId,
      displayName,
      protocol,
      issuer,
      callbackUrl,
      status,
      oidc: {
        clientId,
        clientSecret,
        discoveryUrl: `${issuer}${OIDC_DISCOVERY_SUFFIX}`,
        authorizationEndpoint: discovery.authorizationEndpoint,
        tokenEndpoint: discovery.tokenEndpoint,
        jwksEndpoint: discovery.jwksEndpoint,
        ...(discovery.userInfoEndpoint ? { userInfoEndpoint: discovery.userInfoEndpoint } : {}),
        scopes,
        pkce: true,
      },
    };
  }
  if (input.oidc !== undefined || !isRecord(input.saml)) throw new CompanySsoValidationError('INVALID_SAML_CONFIG', 'SAML providers require only saml configuration');
  return {
    organizationId,
    providerId,
    displayName,
    protocol,
    issuer,
    callbackUrl,
    status,
    saml: normalizeSaml(input.saml, issuer, callbackUrl, policy),
  };
}

export function validateCompanySsoRecord(record: CompanySsoProviderRecord): void {
  if (!normalizeCompanyOrganizationId(record.organizationId)) throw new CompanySsoValidationError('INVALID_RECORD', 'Stored organization id is invalid', 500);
  if (!normalizeCompanyProviderId(record.providerId)) throw new CompanySsoValidationError('INVALID_RECORD', 'Stored provider id is invalid', 500);
  if (record.protocol !== 'oidc' && record.protocol !== 'saml') throw new CompanySsoValidationError('INVALID_RECORD', 'Stored protocol is invalid', 500);
  if (record.protocol === 'oidc' && !record.oidc) throw new CompanySsoValidationError('INVALID_RECORD', 'Stored OIDC configuration is missing', 500);
  if (record.protocol === 'saml' && !record.saml) throw new CompanySsoValidationError('INVALID_RECORD', 'Stored SAML configuration is missing', 500);
}

export const COMPANY_SSO_SYNTHETIC_DOMAIN = 'company-sso.invalid';

/** Convert a validated company row into the Better Auth SSO provider shape. */
export function toBetterAuthCompanySsoProvider(record: CompanySsoProviderRecord) {
  validateCompanySsoRecord(record);
  return {
    issuer: record.issuer,
    providerId: record.providerId,
    organizationId: record.organizationId,
    userId: record.createdBy,
    domain: COMPANY_SSO_SYNTHETIC_DOMAIN,
    ...(record.oidc ? { oidcConfig: record.oidc } : {}),
    ...(record.saml ? { samlConfig: record.saml } : {}),
  };
}

/**
 * Resolve the explicit portal choice into the callback passed to Better Auth.
 * Callers must obtain the row by this organization and provider id; no domain
 * or organization slug can be substituted.
 */
export function explicitCompanySsoSelection(
  record: CompanySsoProviderRecord,
  organizationIdValue: unknown,
  providerIdValue: unknown,
  appOrigin: string,
  allowLoopbackHttp = false,
): { organizationId: string; providerId: string; callbackURL: string } {
  const organizationId = normalizeCompanyOrganizationId(organizationIdValue);
  const providerId = normalizeCompanyProviderId(providerIdValue);
  if (record.organizationId !== organizationId || record.providerId !== providerId) {
    throw new CompanySsoValidationError('COMPANY_PROVIDER_MISMATCH', 'The selected SSO provider is not bound to this company', 403);
  }
  if (record.status !== 'active') throw new CompanySsoValidationError('PROVIDER_DISABLED', 'The selected SSO provider is disabled', 403);
  const callbackURL = companySsoCallbackUrl(appOrigin, providerId, allowLoopbackHttp);
  if (record.callbackUrl !== callbackURL) throw new CompanySsoValidationError('CALLBACK_MISMATCH', 'The stored company callback does not match the generated callback', 500);
  return { organizationId, providerId, callbackURL };
}
