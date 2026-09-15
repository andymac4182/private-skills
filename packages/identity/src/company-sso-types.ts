/**
 * Company-managed SSO contracts.
 *
 * A company SSO connection is an explicit provider-to-organization binding.
 * There is intentionally no email-domain field in these contracts. The
 * Better Auth SSO plugin can support domain discovery, but this launch seam
 * only permits a company portal to select a server-owned provider id.
 */

export const COMPANY_SSO_PROTOCOL_VERSION = 1 as const;
export const DEFAULT_COMPANY_SSO_TABLE = 'private_skills_company_sso_providers';
export const COMPANY_SSO_CALLBACK_PATH = '/api/auth/sso/callback';
export const COMPANY_SSO_MAX_PROVIDER_ID_LENGTH = 64;
export const COMPANY_SSO_MAX_ORGANIZATION_ID_LENGTH = 128;
export const COMPANY_SSO_MAX_DISPLAY_NAME_LENGTH = 160;
export const COMPANY_SSO_MAX_METADATA_BYTES = 100 * 1024;
export const COMPANY_SSO_MAX_DISCOVERY_BYTES = 128 * 1024;

export type CompanySsoProtocol = 'oidc' | 'saml';
export type CompanySsoProviderStatus = 'active' | 'disabled';
export type CompanySsoAdminRole = 'owner' | 'admin';

export interface CompanySsoOidcConfig {
  /** Server-side OIDC client id. Never returned by the company API. */
  clientId: string;
  /** Server-side OIDC client secret. Never returned or logged. */
  clientSecret: string;
  /** Exact issuer discovery URL validated against `issuer`. */
  discoveryUrl: string;
  /** Hydrated endpoints from the validated discovery document. */
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksEndpoint: string;
  userInfoEndpoint?: string;
  scopes: readonly string[];
  pkce: true;
}

export interface CompanySsoSamlIdpMetadata {
  /** Metadata XML is retained server-side for Better Auth's signed parser. */
  metadata?: string;
  /** Required when metadata XML is omitted. */
  entityID?: string;
  /** Explicit trust anchor for manually configured metadata. */
  cert?: string | readonly string[];
  singleSignOnService?: readonly { Binding: string; Location: string }[];
}

export interface CompanySsoSamlConfig {
  /** IdP SSO endpoint. */
  entryPoint: string;
  idpMetadata: CompanySsoSamlIdpMetadata;
  /** Callback is always the generated company provider callback. */
  callbackUrl: string;
  /** Launch policy requires cryptographically signed assertions. */
  wantAssertionsSigned: true;
  audience?: string;
  authnRequestsSigned?: boolean;
  /** Server-side SP key material, when signed AuthnRequests are enabled. */
  privateKey?: string;
  identifierFormat?: string;
  signatureAlgorithm?: string;
  digestAlgorithm?: string;
  mapping?: {
    email?: string;
    emailVerified?: string;
    name?: string;
    firstName?: string;
    lastName?: string;
    extraFields?: Readonly<Record<string, string>>;
  };
}

export interface CompanySsoProviderRecord {
  /** Storage row id. It is distinct from Better Auth's provider id. */
  id: string;
  /** Server-owned organization binding. */
  organizationId: string;
  /** Server-owned provider id used by the company portal. */
  providerId: string;
  displayName: string;
  protocol: CompanySsoProtocol;
  /** Exact IdP issuer (OIDC) or SP entity id (SAML). */
  issuer: string;
  /** Generated callback URL; never accepted as an arbitrary redirect. */
  callbackUrl: string;
  status: CompanySsoProviderStatus;
  oidc?: CompanySsoOidcConfig;
  saml?: CompanySsoSamlConfig;
  createdBy: string;
  updatedBy: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** Public response projection. Secret and provider configuration material is absent by construction. */
export interface CompanySsoProviderPublic {
  id: string;
  organizationId: string;
  providerId: string;
  displayName: string;
  protocol: CompanySsoProtocol;
  issuer: string;
  callbackUrl: string;
  status: CompanySsoProviderStatus;
  /** Useful for rotation UX without exposing the secret itself. */
  hasClientSecret: boolean;
  hasSigningCertificate: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CompanySsoProviderCreateInput {
  /** This is checked against the route organization id and cannot override it. */
  organizationId?: unknown;
  providerId?: unknown;
  displayName?: unknown;
  protocol?: unknown;
  issuer?: unknown;
  callbackUrl?: unknown;
  status?: unknown;
  oidc?: unknown;
  saml?: unknown;
  /** Domain discovery is deliberately not part of the launch contract. */
  domain?: unknown;
  organizationSlug?: unknown;
}

export interface CompanySsoProviderUpdateInput {
  providerId?: unknown;
  displayName?: unknown;
  issuer?: unknown;
  callbackUrl?: unknown;
  status?: unknown;
  oidc?: unknown;
  saml?: unknown;
  organizationId?: unknown;
  domain?: unknown;
  organizationSlug?: unknown;
}

export interface CompanySsoProviderRepository {
  create(record: CompanySsoProviderRecord): Promise<CompanySsoProviderRecord>;
  get(organizationId: string, providerId: string): Promise<CompanySsoProviderRecord | null>;
  /** Provider ids are Better Auth-global, so collision checks are global too. */
  getByProviderId(providerId: string): Promise<CompanySsoProviderRecord | null>;
  list(organizationId: string): Promise<CompanySsoProviderRecord[]>;
  update(
    organizationId: string,
    providerId: string,
    patch: Partial<CompanySsoProviderRecord>,
    expectedRevision?: number,
  ): Promise<CompanySsoProviderRecord | null>;
  delete(organizationId: string, providerId: string, expectedRevision?: number): Promise<boolean>;
}

export interface CompanySsoAuthorizationContext {
  principalId: string;
  organizationId: string;
  role: string;
  /** Recovery is an authenticated platform-owner path, never a request flag. */
  mode: 'member' | 'recovery';
}

export type CompanySsoAuthorizationAction = 'read' | 'write' | 'delete';

export interface CompanySsoAuthorizer {
  authorize(input: {
    request: Request;
    organizationId: string;
    action: CompanySsoAuthorizationAction;
  }): Promise<CompanySsoAuthorizationContext | null>;
}

export interface CompanySsoValidationPolicy {
  /** Canonical origin of the app's auth server. */
  appOrigin: string;
  /** Allow loopback HTTP only in local disposable test environments. */
  allowLoopbackHttp?: boolean;
  /** Override fetch for deterministic discovery tests. */
  fetch?: typeof fetch;
  /** Bound network response size. */
  maxDiscoveryBytes?: number;
}

export interface CompanySsoModuleOptions extends CompanySsoValidationPolicy {
  repository: CompanySsoProviderRepository;
  authorizer: CompanySsoAuthorizer;
  routePrefix?: string;
  /** When true, the caller will run the returned schema SQL through its migration runner. */
  autoMigrate?: boolean;
  /** Explicitly disable domain discovery in the runtime adapter. Defaults to true. */
  allowDomainDiscovery?: false;
}

export interface CompanySsoRuntimeProvider {
  providerId: string;
  organizationId: string;
  issuer: string;
  /** Synthetic value required by Better Auth's provider schema; never used for lookup. */
  domain: string;
  oidcConfig?: CompanySsoOidcConfig;
  samlConfig?: CompanySsoSamlConfig;
}

export interface CompanySsoSignInSelection {
  providerId: string;
  organizationId: string;
  callbackURL: string;
}

export class CompanySsoError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'CompanySsoError';
    this.code = code;
    this.status = status;
  }
}

export class CompanySsoConfigurationError extends CompanySsoError {
  constructor(message: string) {
    super('COMPANY_SSO_CONFIGURATION', message, 500);
    this.name = 'CompanySsoConfigurationError';
  }
}

export class CompanySsoValidationError extends CompanySsoError {
  constructor(code: string, message: string, status = 422) {
    super(code, message, status);
    this.name = 'CompanySsoValidationError';
  }
}

export class CompanySsoRepositoryError extends CompanySsoError {
  constructor(message: string) {
    super('COMPANY_SSO_REPOSITORY', message, 500);
    this.name = 'CompanySsoRepositoryError';
  }
}

export class CompanySsoConflictError extends CompanySsoError {
  constructor(message: string) {
    super('COMPANY_SSO_CONFLICT', message, 409);
    this.name = 'CompanySsoConflictError';
  }
}
