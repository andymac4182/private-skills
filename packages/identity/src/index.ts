import { APIError, betterAuth, type BetterAuthOptions, type Auth } from 'better-auth';
import { genericOAuth, organization } from 'better-auth/plugins';
import { memberAc } from 'better-auth/plugins/organization/access';
import type { GenericOAuthConfig } from 'better-auth/plugins/generic-oauth';
import { getMigrations } from 'better-auth/db/migration';
import { PostgresJSDialect } from 'kysely-postgres-js';
import postgres from 'postgres';

import { defaultScopesForRoles } from '../../auth/src/index';
import type { Principal, Role } from '../../contracts/src/index';

/** Version of the host-neutral identity boundary shared by the API and UI. */
export const IDENTITY_PROTOCOL_VERSION = 1 as const;
/** Stable BFF paths for the browser-safe identity views. */
export const IDENTITY_BFF_BASE_PATH = '/auth/identity' as const;

/** Roles that a Better Auth organization membership may grant to a user. */
export type IdentityRole = Exclude<Role, 'worker'>;

/** Built-in providers have provider-specific Better Auth support. */
export type IdentityProviderKind = 'github' | 'google' | 'microsoft' | 'oidc';

/** A provider id is stable and server-owned; the UI may only select one of these ids. */
export type IdentityProviderId = string & {};

/** Provider metadata safe to expose to browser code. It never contains credentials. */
export interface IdentityProviderPublicConfig {
  id: IdentityProviderId;
  label: string;
  kind: IdentityProviderKind;
  enabled: boolean;
  /** Relative callback path registered with the provider. */
  callbackPath: string;
}

/** Public organization and invitation guardrails used to render onboarding controls. */
export interface IdentityOrganizationPublicConfig {
  enabled: boolean;
  roles: readonly IdentityRole[];
  maxOrganizationsPerUser: number;
  maxMembersPerOrganization: number;
  maxInvitationsPerMember: number;
}

export interface IdentityInvitationPublicConfig {
  /** The first implementation returns a link that an inviter can copy. */
  mode: 'copy-link';
  /** There is no implicit email send when this is false. */
  emailDelivery: 'disabled' | 'configured';
  /** Acceptance always proves ownership of the invited email address. */
  requiresVerifiedEmail: true;
  /** The server rejects an invitation role outside this ceiling. */
  allowedRoles: readonly IdentityRole[];
}

export interface IdentityBootstrapPublicConfig {
  /** Whether an owner bootstrap credential is configured on this deployment. */
  enabled: boolean;
  /** Adoption of an existing tenant requires an explicit owner-authenticated action. */
  requiresExplicitOwnerClaim: true;
  /** Social first login never adopts or creates a default tenant implicitly. */
  implicitSocialTenantAdoption: false;
}

/** Browser-safe identity configuration. Secrets and provider access tokens are excluded by type. */
export interface IdentityPublicConfig {
  protocolVersion: typeof IDENTITY_PROTOCOL_VERSION;
  enabled: boolean;
  basePath: string;
  providers: readonly IdentityProviderPublicConfig[];
  organization: IdentityOrganizationPublicConfig;
  invitations: IdentityInvitationPublicConfig;
  bootstrap: IdentityBootstrapPublicConfig;
}

/** A Better Auth user snapshot safe to include in an authenticated API response. */
export interface IdentityUser {
  id: string;
  email: string;
  name: string;
  image?: string | null;
  emailVerified: boolean;
}

export interface IdentityOrganization {
  id: string;
  name: string;
  slug: string;
}

/** One authoritative Better Auth organization membership. */
export interface IdentityMembership {
  id: string;
  organizationId: string;
  role: IdentityRole;
  organization: IdentityOrganization;
}

/**
 * Sanitized browser session view. Better Auth's session token, provider access
 * token, and refresh token are intentionally absent from this contract.
 */
export interface IdentitySession {
  user: IdentityUser;
  sessionId: string;
  createdAt: string;
  expiresAt: string;
  organizations: readonly IdentityMembership[];
  activeOrganizationId: string | null;
  activeOrganization: IdentityOrganization | null;
  activeMembership: IdentityMembership | null;
  /** True when the user has a valid session but no organization membership. */
  needsOnboarding: boolean;
  authMethod: 'better-auth';
}

/** Principal returned to existing registry routes after live membership checks. */
export interface IdentityPrincipal extends Principal {
  /** Existing route code treats this as a user principal and excludes workers. */
  identity: 'user';
  authMethod: 'better-auth';
  userId: string;
  email: string;
  emailVerified: boolean;
  sessionId: string;
  membershipId: string;
  membershipRole: IdentityRole;
}

/** Server-owned credentials for one social or generic OIDC provider. */
export interface IdentityProviderSecretConfig {
  id: IdentityProviderId;
  kind: IdentityProviderKind;
  /** Optional operator-facing name for a generic provider. */
  displayName?: string;
  clientId: string;
  clientSecret?: string;
  /** Generic OIDC discovery URL. It is never accepted from browser input. */
  discoveryUrl?: string;
  /** Optional provider-specific callback URI; defaults to the Better Auth base URL. */
  redirectURI?: string;
  scopes?: readonly string[];
  /** Only Microsoft supports this built-in setting in the current adapter. */
  tenantId?: string;
  authority?: string;
}

export interface IdentityOrganizationConfig {
  allowUserToCreateOrganization: boolean;
  organizationLimit: number;
  membershipLimit: number;
  invitationLimit: number;
  creatorRole: 'owner';
}

export interface IdentityInvitationConfig {
  mode: 'copy-link';
  requireVerifiedEmail: true;
  emailDelivery: 'disabled' | 'configured';
  allowedRoles: readonly IdentityRole[];
}

export interface IdentityDatabaseConfig {
  /** PostgreSQL connection string, normally Neon in a deployed Node runtime. */
  connectionString: string;
  schemaName?: string;
  /** Run Better Auth's Kysely schema check on initialization. */
  validateSchema?: boolean;
}

/** Full server configuration. It must never be serialized through a public route. */
export interface IdentityRuntimeConfig {
  enabled: boolean;
  baseURL: string;
  basePath: string;
  secret: string;
  database: IdentityDatabaseConfig;
  providers: readonly IdentityProviderSecretConfig[];
  organization: IdentityOrganizationConfig;
  invitations: IdentityInvitationConfig;
  /** Existing bootstrap tokens remain a separate authentication path. */
  bootstrapConfigured: boolean;
  /** Migrations are explicit by default so deploys can review schema changes. */
  autoMigrate?: boolean;
}

export interface IdentityOnboardingContract {
  protocolVersion: typeof IDENTITY_PROTOCOL_VERSION;
  needsOrganization: boolean;
  canCreateOrganization: boolean;
  canAcceptInvitation: boolean;
  invitation: IdentityInvitationPublicConfig;
  bootstrap: IdentityBootstrapPublicConfig;
}

/** Host-neutral runtime boundary consumed by Nitro, tests, and the web client. */
export interface IdentityRuntime {
  /** Portable handler for Better Auth `/api/auth/*` and sanitized identity BFF requests. */
  handler(request: Request): Promise<Response>;
  /** Resolves a live, currently valid membership to the existing route principal. */
  authenticate(request: Request): Promise<IdentityPrincipal | null>;
  /** Returns sanitized session state, including onboarding without a membership. */
  getSession(request: Request): Promise<IdentitySession | null>;
  publicProviderConfig(): IdentityPublicConfig;
  onboarding(): IdentityOnboardingContract;
}

export type PublicProviderConfig = IdentityPublicConfig;

/**
 * Type guard for callers that need to distinguish an identity principal from
 * the existing token-authenticated principal at a composition boundary.
 */
export function isIdentityPrincipal(value: Principal | null | undefined): value is IdentityPrincipal {
  return Boolean(value && (value as Partial<IdentityPrincipal>).authMethod === 'better-auth');
}

const IDENTITY_ROLES: readonly IdentityRole[] = ['owner', 'admin', 'publisher', 'reader'];
const BUILTIN_PROVIDER_IDS = new Set<IdentityProviderId>(['github', 'google', 'microsoft']);
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SCHEMA_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
/** One database-wide lock key for Better Auth organization state changes. */
const ORGANIZATION_MUTATION_LOCK_KEY = 2_147_483_647;

/** Environment variables accepted by the server-side identity factory. */
export type IdentityEnvironment = Readonly<Record<string, string | undefined>>;

export class IdentityConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityConfigurationError';
  }
}

export class IdentityAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityAuthorizationError';
  }
}

/**
 * Better Auth's built-in `member` role is deliberately reduced to the
 * Private Skills `reader` role. Unknown roles fail closed and never become
 * owners through a fallback.
 */
export function normalizeIdentityRole(role: string): IdentityRole {
  const normalized = role.trim().toLowerCase();
  if (normalized === 'member') return 'reader';
  if ((IDENTITY_ROLES as readonly string[]).includes(normalized)) {
    return normalized as IdentityRole;
  }
  throw new IdentityAuthorizationError(`Unsupported organization role: ${role}`);
}

function normalizeRoleForBetterAuth(role: string): string {
  return normalizeIdentityRole(role);
}

function lowerEmail(email: string): string {
  return email.trim().toLowerCase();
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new IdentityConfigurationError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  throw new IdentityConfigurationError(`Invalid boolean identity setting: ${value}`);
}

function parseBoundedInteger(
  value: string | undefined,
  field: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value.trim() === '') return fallback;
  if (!/^\d+$/.test(value.trim())) {
    throw new IdentityConfigurationError(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new IdentityConfigurationError(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function firstEnvironmentValue(env: IdentityEnvironment, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return undefined;
}

function parseURL(value: string, field: string, options: { allowLoopbackHTTP?: boolean } = {}): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new IdentityConfigurationError(`${field} must be an absolute URL`);
  }
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  const allowLoopbackHTTP = options.allowLoopbackHTTP ?? true;
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && allowLoopbackHTTP && loopback)) {
    throw new IdentityConfigurationError(`${field} must use HTTPS (HTTP is allowed only for loopback development providers)`);
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new IdentityConfigurationError(`${field} must not include credentials or a fragment`);
  }
  return parsed;
}

function normalizeBaseURL(value: string): string {
  const parsed = parseURL(value, 'Better Auth base URL');
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/$/, '');
}

function normalizeBasePath(value: string | undefined): string {
  const path = value?.trim() || '/api/auth';
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('?') || path.includes('#')) {
    throw new IdentityConfigurationError('BETTER_AUTH_BASE_PATH must be an absolute path without query or fragment');
  }
  const normalized = `/${path.replace(/^\/+|\/+$/g, '')}`;
  return normalized === '/' ? '/api/auth' : normalized;
}

function parseSchemaName(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  if (!SCHEMA_NAME_PATTERN.test(value.trim())) {
    throw new IdentityConfigurationError('Better Auth schema name contains unsupported characters');
  }
  return value.trim();
}

function parseProviderCredentials(
  env: IdentityEnvironment,
  id: Extract<IdentityProviderKind, 'github' | 'google' | 'microsoft'>,
): IdentityProviderSecretConfig | undefined {
  const upper = id.toUpperCase();
  const clientId = firstEnvironmentValue(
    env,
    `PSKILLS_BETTER_AUTH_${upper}_CLIENT_ID`,
    `BETTER_AUTH_${upper}_CLIENT_ID`,
    `PSKILLS_${upper}_CLIENT_ID`,
    `${upper}_CLIENT_ID`,
  );
  const clientSecret = firstEnvironmentValue(
    env,
    `PSKILLS_BETTER_AUTH_${upper}_CLIENT_SECRET`,
    `BETTER_AUTH_${upper}_CLIENT_SECRET`,
    `PSKILLS_${upper}_CLIENT_SECRET`,
    `${upper}_CLIENT_SECRET`,
  );
  if (!clientId && !clientSecret) return undefined;
  if (!clientId || !clientSecret) {
    throw new IdentityConfigurationError(`${id} requires both client id and client secret`);
  }
  const provider: IdentityProviderSecretConfig = {
    id,
    kind: id,
    clientId,
    clientSecret,
  };
  if (id === 'microsoft') {
    provider.tenantId = firstEnvironmentValue(
      env,
      'PSKILLS_BETTER_AUTH_MICROSOFT_TENANT_ID',
      'BETTER_AUTH_MICROSOFT_TENANT_ID',
      'MICROSOFT_TENANT_ID',
    ) ?? 'common';
    provider.authority = firstEnvironmentValue(
      env,
      'PSKILLS_BETTER_AUTH_MICROSOFT_AUTHORITY',
      'BETTER_AUTH_MICROSOFT_AUTHORITY',
      'MICROSOFT_AUTHORITY',
    ) ?? 'https://login.microsoftonline.com';
    parseURL(provider.authority, 'Microsoft authority', { allowLoopbackHTTP: false });
  }
  return provider;
}

interface GenericProviderEnvironmentRecord {
  id?: unknown;
  providerId?: unknown;
  name?: unknown;
  clientId?: unknown;
  clientSecret?: unknown;
  discoveryUrl?: unknown;
  redirectURI?: unknown;
  scopes?: unknown;
}

function parseGenericProviders(env: IdentityEnvironment): IdentityProviderSecretConfig[] {
  const raw = firstEnvironmentValue(env, 'PSKILLS_OIDC_PROVIDERS_JSON', 'PSKILLS_BETTER_AUTH_OIDC_PROVIDERS_JSON', 'BETTER_AUTH_OIDC_PROVIDERS_JSON');
  if (!raw) return [];
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new IdentityConfigurationError('OIDC provider JSON is invalid');
  }
  if (!Array.isArray(decoded)) {
    throw new IdentityConfigurationError('OIDC provider JSON must be an array');
  }
  const providers: IdentityProviderSecretConfig[] = [];
  const ids = new Set<IdentityProviderId>(BUILTIN_PROVIDER_IDS);
  for (const [index, candidate] of decoded.entries()) {
    if (!candidate || typeof candidate !== 'object') {
      throw new IdentityConfigurationError(`OIDC provider ${index} must be an object`);
    }
    const record = candidate as GenericProviderEnvironmentRecord;
    const idValue = typeof record.id === 'string' ? record.id : record.providerId;
    const id = asNonEmptyString(idValue, `OIDC provider ${index} id`);
    if (!PROVIDER_ID_PATTERN.test(id) || ids.has(id)) {
      throw new IdentityConfigurationError(`OIDC provider id is invalid or already in use: ${id}`);
    }
    const clientId = asNonEmptyString(record.clientId, `OIDC provider ${id} clientId`);
    const discoveryUrl = asNonEmptyString(record.discoveryUrl, `OIDC provider ${id} discoveryUrl`);
    parseURL(discoveryUrl, `OIDC provider ${id} discoveryUrl`);
    const redirectURI = record.redirectURI === undefined ? undefined : asNonEmptyString(record.redirectURI, `OIDC provider ${id} redirectURI`);
    if (redirectURI) parseURL(redirectURI, `OIDC provider ${id} redirectURI`);
    const scopes = record.scopes === undefined ? ['openid', 'profile', 'email'] : record.scopes;
    if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== 'string' || scope.trim() === '')) {
      throw new IdentityConfigurationError(`OIDC provider ${id} scopes must be a non-empty string array`);
    }
    const provider: IdentityProviderSecretConfig = {
      id: id as IdentityProviderId,
      kind: 'oidc',
      clientId,
      clientSecret: record.clientSecret === undefined ? undefined : asNonEmptyString(record.clientSecret, `OIDC provider ${id} clientSecret`),
      discoveryUrl,
      redirectURI,
      scopes: scopes.map((scope) => scope.trim()),
    };
    const name = record.name === undefined ? undefined : asNonEmptyString(record.name, `OIDC provider ${id} name`);
    if (name) provider.displayName = name;
    ids.add(provider.id);
    providers.push(provider);
  }
  return providers;
}

/**
 * Reads only deployment-owned configuration. Provider credentials and OIDC
 * discovery URLs never come from a request or from browser-visible config.
 */
export function createIdentityRuntimeConfig(env: IdentityEnvironment = {}): IdentityRuntimeConfig {
  const enabled = parseBoolean(firstEnvironmentValue(env, 'PSKILLS_BETTER_AUTH_ENABLED', 'BETTER_AUTH_ENABLED'), false);
  const baseURL = normalizeBaseURL(firstEnvironmentValue(env, 'BETTER_AUTH_URL', 'PSKILLS_PUBLIC_ORIGIN', 'PSKILLS_API_URL') ?? 'http://localhost:5173');
  const basePath = normalizeBasePath(firstEnvironmentValue(env, 'BETTER_AUTH_BASE_PATH', 'PSKILLS_BETTER_AUTH_BASE_PATH'));
  const connectionString = firstEnvironmentValue(env, 'DATABASE_URL', 'PSKILLS_DATABASE_URL') ?? '';
  const secret = firstEnvironmentValue(env, 'BETTER_AUTH_SECRET', 'PSKILLS_BETTER_AUTH_SECRET', 'PSKILLS_SESSION_SECRET') ?? '';
  if (enabled) {
    if (!connectionString) throw new IdentityConfigurationError('DATABASE_URL is required when Better Auth is enabled');
    if (secret.length < 32) throw new IdentityConfigurationError('BETTER_AUTH_SECRET must contain at least 32 characters when enabled');
  }
  const genericProviders = parseGenericProviders(env);
  const providers = [
    parseProviderCredentials(env, 'github'),
    parseProviderCredentials(env, 'google'),
    parseProviderCredentials(env, 'microsoft'),
    ...genericProviders,
  ].filter((provider): provider is IdentityProviderSecretConfig => provider !== undefined);
  const emailDeliveryRaw = firstEnvironmentValue(env, 'PSKILLS_BETTER_AUTH_EMAIL_DELIVERY', 'BETTER_AUTH_EMAIL_DELIVERY') ?? 'disabled';
  if (emailDeliveryRaw !== 'disabled' && emailDeliveryRaw !== 'configured') {
    throw new IdentityConfigurationError('PSKILLS_BETTER_AUTH_EMAIL_DELIVERY must be disabled or configured');
  }
  const schemaName = parseSchemaName(firstEnvironmentValue(env, 'PSKILLS_BETTER_AUTH_SCHEMA', 'BETTER_AUTH_SCHEMA'));
  const organizationLimit = parseBoundedInteger(firstEnvironmentValue(env, 'PSKILLS_BETTER_AUTH_ORGANIZATION_LIMIT', 'BETTER_AUTH_ORGANIZATION_LIMIT'), 'organization limit', 10, 1, 100);
  const membershipLimit = parseBoundedInteger(firstEnvironmentValue(env, 'PSKILLS_BETTER_AUTH_MEMBERSHIP_LIMIT', 'BETTER_AUTH_MEMBERSHIP_LIMIT'), 'membership limit', 100, 1, 1000);
  const invitationLimit = parseBoundedInteger(firstEnvironmentValue(env, 'PSKILLS_BETTER_AUTH_INVITATION_LIMIT', 'BETTER_AUTH_INVITATION_LIMIT'), 'invitation limit', 100, 1, 1000);
  const allowedRoles = [...IDENTITY_ROLES] as readonly IdentityRole[];
  const bootstrapToken = firstEnvironmentValue(env, 'PSKILLS_BOOTSTRAP_TOKEN');
  return {
    enabled,
    baseURL,
    basePath,
    secret,
    database: {
      connectionString,
      ...(schemaName ? { schemaName } : {}),
      validateSchema: parseBoolean(firstEnvironmentValue(env, 'PSKILLS_BETTER_AUTH_VALIDATE_SCHEMA', 'BETTER_AUTH_VALIDATE_SCHEMA'), true),
    },
    providers,
    organization: {
      allowUserToCreateOrganization: parseBoolean(firstEnvironmentValue(env, 'PSKILLS_BETTER_AUTH_ALLOW_ORGANIZATION_CREATE', 'BETTER_AUTH_ALLOW_ORGANIZATION_CREATE'), true),
      organizationLimit,
      membershipLimit,
      invitationLimit,
      creatorRole: 'owner',
    },
    invitations: {
      mode: 'copy-link',
      requireVerifiedEmail: true,
      emailDelivery: emailDeliveryRaw,
      allowedRoles,
    },
    bootstrapConfigured: Boolean(bootstrapToken),
    autoMigrate: parseBoolean(firstEnvironmentValue(env, 'PSKILLS_BETTER_AUTH_AUTO_MIGRATE', 'BETTER_AUTH_AUTO_MIGRATE'), false),
  };
}

function providerLabel(provider: IdentityProviderSecretConfig): string {
  if (provider.id === 'github') return 'GitHub';
  if (provider.id === 'google') return 'Google';
  if (provider.id === 'microsoft') return 'Microsoft';
  return provider.displayName ?? provider.id;
}

export function createIdentityPublicConfig(config: IdentityRuntimeConfig): IdentityPublicConfig {
  return {
    protocolVersion: IDENTITY_PROTOCOL_VERSION,
    enabled: config.enabled,
    basePath: config.basePath,
    providers: config.providers.map((provider) => ({
      id: provider.id,
      label: providerLabel(provider),
      kind: provider.kind,
      enabled: true,
      callbackPath: `${config.basePath}/callback/${encodeURIComponent(provider.id)}`,
    })),
    organization: {
      enabled: config.enabled,
      roles: [...IDENTITY_ROLES],
      maxOrganizationsPerUser: config.organization.organizationLimit,
      maxMembersPerOrganization: config.organization.membershipLimit,
      maxInvitationsPerMember: config.organization.invitationLimit,
    },
    invitations: {
      mode: 'copy-link',
      emailDelivery: config.invitations.emailDelivery,
      requiresVerifiedEmail: true,
      allowedRoles: [...config.invitations.allowedRoles],
    },
    bootstrap: {
      enabled: config.bootstrapConfigured,
      requiresExplicitOwnerClaim: true,
      implicitSocialTenantAdoption: false,
    },
  };
}

export interface IdentityInvitationEmailData {
  id: string;
  role: string;
  email: string;
  organization: IdentityOrganization & Record<string, unknown>;
  invitation: Record<string, unknown>;
  inviter: Record<string, unknown> & { user: IdentityUser };
}

export interface IdentityRuntimeOptions {
  /** Optional existing transport. No email is sent when this is absent. */
  sendInvitationEmail?: (data: IdentityInvitationEmailData, request?: Request) => Promise<void>;
}

export interface IdentityRuntimeAdmin extends IdentityRuntime {
  readonly auth: Auth<BetterAuthOptions>;
  /** Resolves before requests when `autoMigrate` is enabled. */
  readonly ready: Promise<void>;
  runMigrations(): Promise<void>;
  close(): Promise<void>;
}

type SessionApiValue = {
  session: {
    id: string;
    token?: string;
    createdAt: Date | string;
    expiresAt: Date | string;
    activeOrganizationId?: string | null;
  };
  user: {
    id: string;
    email: string;
    name: string;
    image?: string | null;
    emailVerified: boolean;
  };
};

type OrganizationApiValue = {
  id: string;
  name: string;
  slug: string;
  [key: string]: unknown;
};

type MemberApiValue = {
  id?: string;
  userId?: string;
  organizationId?: string;
  role?: string;
  [key: string]: unknown;
};

interface IdentityAuthApi {
  getSession(input: { headers: Headers }): Promise<SessionApiValue | null>;
  listOrganizations(input: { headers: Headers }): Promise<OrganizationApiValue[]>;
  listMembers(input: {
    headers: Headers;
    query: {
      organizationId: string;
      limit: number;
      filterField: 'userId';
      filterOperator: 'eq';
      filterValue: string;
    };
  }): Promise<{ members?: MemberApiValue[]; total?: number }>;
}

function toISOString(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString();
}

function sanitizeOrganization(value: OrganizationApiValue): IdentityOrganization {
  return { id: value.id, name: value.name, slug: value.slug };
}

function sanitizeUser(value: SessionApiValue['user']): IdentityUser {
  return {
    id: value.id,
    email: value.email,
    name: value.name,
    ...(value.image === undefined ? {} : { image: value.image }),
    emailVerified: value.emailVerified === true,
  };
}

function identityApi(auth: Auth<BetterAuthOptions>): IdentityAuthApi {
  return auth.api as unknown as IdentityAuthApi;
}

function authError(code: string, message: string): APIError {
  return APIError.from('FORBIDDEN', { code, message });
}

function buildAuthOptions(
  config: IdentityRuntimeConfig,
  emailSender?: IdentityRuntimeOptions['sendInvitationEmail'],
  dialect?: PostgresJSDialect,
): BetterAuthOptions {
  if (!config.enabled) throw new IdentityConfigurationError('Better Auth identity runtime is disabled');
  if (config.invitations.emailDelivery === 'configured' && !emailSender) {
    throw new IdentityConfigurationError('Configured invitation email delivery requires an existing email transport');
  }
  const socialProviders: Record<string, unknown> = {};
  for (const provider of config.providers) {
    if (provider.kind === 'oidc') continue;
    const options: Record<string, unknown> = {
      clientId: provider.clientId,
      clientSecret: provider.clientSecret,
      ...(provider.redirectURI ? { redirectURI: provider.redirectURI } : {}),
      ...(provider.scopes ? { scope: [...provider.scopes] } : {}),
      ...(provider.id === 'microsoft'
        ? { tenantId: provider.tenantId ?? 'common', authority: provider.authority ?? 'https://login.microsoftonline.com' }
        : {}),
    };
    socialProviders[provider.id] = options;
  }
  const genericProviders: GenericOAuthConfig[] = config.providers
    .filter((provider): provider is IdentityProviderSecretConfig & { kind: 'oidc'; discoveryUrl: string } => provider.kind === 'oidc' && Boolean(provider.discoveryUrl))
    .map((provider) => ({
      providerId: provider.id,
      name: providerLabel(provider),
      clientId: provider.clientId,
      ...(provider.clientSecret ? { clientSecret: provider.clientSecret } : {}),
      discoveryUrl: provider.discoveryUrl,
      requireIdTokenVerification: true,
      pkce: true,
      scopes: [...(provider.scopes ?? ['openid', 'profile', 'email'])],
      ...(provider.redirectURI ? { redirectURI: provider.redirectURI } : {}),
      disableImplicitSignUp: false,
      disableSignUp: false,
    }));
  const plugins: NonNullable<BetterAuthOptions['plugins']> = [
    organization({
      allowUserToCreateOrganization: config.organization.allowUserToCreateOrganization,
      organizationLimit: config.organization.organizationLimit,
      membershipLimit: config.organization.membershipLimit,
      invitationLimit: config.organization.invitationLimit,
      creatorRole: config.organization.creatorRole,
      requireEmailVerificationOnInvitation: config.invitations.requireVerifiedEmail,
      cancelPendingInvitationsOnReInvite: true,
      roles: {
        reader: memberAc,
        publisher: memberAc,
      },
      organizationHooks: {
        beforeAddMember: async ({ member }) => ({
          data: { ...member, role: normalizeRoleForBetterAuth(member.role) },
        }),
        beforeUpdateMemberRole: async ({ newRole }) => ({
          data: { role: normalizeRoleForBetterAuth(newRole) },
        }),
        beforeCreateInvitation: async ({ invitation }) => ({
          data: { ...invitation, role: normalizeRoleForBetterAuth(invitation.role) },
        }),
        beforeAcceptInvitation: async ({ invitation, user }) => {
          if (user.emailVerified !== true || lowerEmail(invitation.email) !== lowerEmail(user.email)) {
            throw authError('INVITATION_EMAIL_UNVERIFIED', 'A verified session for the invited email is required');
          }
        },
      },
      ...(emailSender
        ? {
            sendInvitationEmail: async (data, request) => {
              await emailSender(data as IdentityInvitationEmailData, request);
            },
          }
        : {}),
    }),
  ];
  if (genericProviders.length > 0) plugins.push(genericOAuth({ config: genericProviders }));
  const trustedOrigins = [config.baseURL];
  for (const provider of config.providers) {
    if (!provider.redirectURI) continue;
    trustedOrigins.push(new URL(provider.redirectURI).origin);
  }
  const database = {
    dialect,
    type: 'postgres' as const,
    transaction: true,
    ...(config.database.schemaName ? { schemaName: config.database.schemaName } : {}),
  };
  return {
    appName: 'Private Skills',
    baseURL: config.baseURL,
    basePath: config.basePath,
    secret: config.secret,
    database: database as BetterAuthOptions['database'],
    socialProviders: socialProviders as BetterAuthOptions['socialProviders'],
    plugins,
    trustedOrigins,
    advanced: {
      database: { validateSchema: config.database.validateSchema ?? true },
      useSecureCookies: new URL(config.baseURL).protocol === 'https:',
      skipTrailingSlashes: true,
    },
    account: {
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        requireLocalEmailVerified: true,
      },
    },
    user: {
      validateUserInfo: ({ user, source }) => {
        if (source.method === 'oauth' && (typeof user.email !== 'string' || user.email.trim() === '')) {
          return { error: 'email_required', errorDescription: 'This provider did not return an email address' };
        }
      },
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 120,
      customRules: {
        '/organization/create': { window: 3600, max: 5 },
      },
    },
  };
}

function createSessionView(
  value: SessionApiValue,
  memberships: IdentityMembership[],
): IdentitySession {
  const activeOrganizationId = value.session.activeOrganizationId ?? null;
  const activeMembership = memberships.find((membership) => membership.organizationId === activeOrganizationId) ?? null;
  return {
    user: sanitizeUser(value.user),
    sessionId: value.session.id,
    createdAt: toISOString(value.session.createdAt),
    expiresAt: toISOString(value.session.expiresAt),
    organizations: memberships,
    activeOrganizationId: activeMembership?.organizationId ?? null,
    activeOrganization: activeMembership?.organization ?? null,
    activeMembership,
    needsOnboarding: memberships.length === 0,
    authMethod: 'better-auth',
  };
}

function createIdentityPrincipal(session: IdentitySession): IdentityPrincipal | null {
  const membership = session.activeMembership;
  if (!membership) return null;
  const role = normalizeIdentityRole(membership.role);
  const roles: Role[] = [role];
  return {
    identity: 'user',
    authMethod: 'better-auth',
    userId: session.user.id,
    email: session.user.email,
    emailVerified: session.user.emailVerified,
    sessionId: session.sessionId,
    membershipId: membership.id,
    membershipRole: role,
    organizationId: membership.organizationId,
    subject: session.user.id,
    roles,
    scopes: defaultScopesForRoles(roles),
  };
}

function isOrganizationMutation(request: Request, basePath: string): boolean {
  const pathname = new URL(request.url).pathname;
  return request.method !== 'GET'
    && request.method !== 'HEAD'
    && pathname.startsWith(`${basePath}/organization/`);
}

/** Build an invitation URL for the copy-link delivery mode. */
export function createInvitationLink(baseURL: string, invitationId: string): string {
  const origin = normalizeBaseURL(baseURL);
  const url = new URL('/organization/accept-invitation', `${origin}/`);
  url.searchParams.set('id', asNonEmptyString(invitationId, 'invitation id'));
  return url.toString();
}

/**
 * Construct the Better Auth runtime using PostgreSQL.js through the official
 * Kysely dialect. No connection is opened until Better Auth handles a request
 * or migrations are explicitly run.
 */
export function createIdentityRuntime(
  config: IdentityRuntimeConfig,
  options: IdentityRuntimeOptions = {},
): IdentityRuntimeAdmin {
  if (!config.enabled) throw new IdentityConfigurationError('Better Auth identity runtime is disabled');
  const sql = postgres(config.database.connectionString, {
    max: 10,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  // Keep lock waiters off the Kysely/Postgres.js pool used by Better Auth. If
  // the same pool held a lock connection while other mutation requests waited,
  // enough concurrent waiters could starve the handler's data connections.
  const lockSql = postgres(config.database.connectionString, {
    max: 1,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  const dialect = new PostgresJSDialect({ postgres: sql });
  const auth = betterAuth(buildAuthOptions(config, options.sendInvitationEmail, dialect));
  const api = identityApi(auth);
  const publicConfig = createIdentityPublicConfig(config);
  const onboarding: IdentityOnboardingContract = {
    protocolVersion: IDENTITY_PROTOCOL_VERSION,
    needsOrganization: false,
    canCreateOrganization: config.organization.allowUserToCreateOrganization,
    canAcceptInvitation: true,
    invitation: publicConfig.invitations,
    bootstrap: publicConfig.bootstrap,
  };
  const runMigrations = async (): Promise<void> => {
    const migration = await getMigrations(auth.options);
    await migration.runMigrations();
  };
  let ready: Promise<void> = Promise.resolve();
  const getSession = async (request: Request): Promise<IdentitySession | null> => {
    await ready;
    let session: SessionApiValue | null;
    try {
      session = await api.getSession({ headers: request.headers });
    } catch {
      return null;
    }
    if (!session) return null;
    let organizations: OrganizationApiValue[];
    try {
      organizations = await api.listOrganizations({ headers: request.headers });
    } catch {
      return null;
    }
    const memberships: IdentityMembership[] = [];
    for (const organizationSummary of organizations) {
      try {
        // Query the plugin's exact userId/orgId membership filter rather than
        // downloading the first N members from getFullOrganization. This
        // remains correct when a large tenant's membership list is ordered
        // ahead of the current user and rechecks the live membership row.
        const result = await api.listMembers({
          headers: request.headers,
          query: {
            organizationId: organizationSummary.id,
            limit: 1,
            filterField: 'userId',
            filterOperator: 'eq',
            filterValue: session.user.id,
          },
        });
        const member = result.members?.find((candidate) => candidate.userId === session.user.id);
        if (!member || typeof member.id !== 'string' || typeof member.role !== 'string' || member.organizationId !== organizationSummary.id) continue;
        let role: IdentityRole;
        try {
          role = normalizeIdentityRole(member.role);
        } catch {
          continue;
        }
        memberships.push({
          id: member.id,
          organizationId: organizationSummary.id,
          role,
          organization: sanitizeOrganization(organizationSummary),
        });
      } catch {
        // Membership checks fail closed when a row was revoked or the org was deleted.
      }
    }
    return createSessionView(session, memberships);
  };
  const runtime: IdentityRuntimeAdmin = {
    auth,
    get ready() {
      return ready;
    },
    handler: async (request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname === `${IDENTITY_BFF_BASE_PATH}/config`) {
        if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
        await ready;
        return Response.json(publicConfig, {
          headers: { 'cache-control': 'no-store' },
        });
      }
      if (pathname === `${IDENTITY_BFF_BASE_PATH}/session`) {
        if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
        const session = await getSession(request);
        return Response.json({ session }, {
          headers: { 'cache-control': 'no-store' },
        });
      }
      if (pathname === config.basePath || pathname.startsWith(`${config.basePath}/`)) {
        await ready;
        if (isOrganizationMutation(request, config.basePath)) {
          // Better Auth's last-owner check is correct for sequential calls but
          // its role-update route performs the count and write separately. A
          // transaction-scoped advisory lock closes that concurrent race while
          // leaving the plugin's membership and permission checks authoritative.
          return lockSql.begin(async (transaction) => {
            await transaction`select pg_advisory_xact_lock(${ORGANIZATION_MUTATION_LOCK_KEY})`;
            return auth.handler(request);
          });
        }
        return auth.handler(request);
      }
      return new Response('Not Found', { status: 404 });
    },
    authenticate: async (request) => {
      const session = await getSession(request);
      return session ? createIdentityPrincipal(session) : null;
    },
    getSession,
    publicProviderConfig: () => createIdentityPublicConfig(config),
    onboarding: () => ({
      ...onboarding,
      invitation: { ...onboarding.invitation, allowedRoles: [...onboarding.invitation.allowedRoles] },
      bootstrap: { ...onboarding.bootstrap },
    }),
    runMigrations,
    close: async () => {
      await Promise.all([sql.end({ timeout: 5 }), lockSql.end({ timeout: 5 })]);
    },
  };
  ready = config.autoMigrate ? runMigrations() : Promise.resolve();
  // The request path awaits this promise. Attaching a rejection handler also
  // prevents an unobserved auto-migration rejection during process startup.
  void ready.catch(() => undefined);
  return runtime;
}

/** Return null when the deployment intentionally leaves Better Auth disabled. */
export function createIdentityRuntimeFromEnv(
  env: IdentityEnvironment = {},
  options: IdentityRuntimeOptions = {},
): IdentityRuntimeAdmin | null {
  const config = createIdentityRuntimeConfig(env);
  if (!config.enabled) return null;
  return createIdentityRuntime(config, options);
}

/** Expose Better Auth's migration plan for review or a deployment runner. */
export async function getIdentityMigrations(runtime: IdentityRuntimeAdmin): Promise<Awaited<ReturnType<typeof getMigrations>>> {
  return getMigrations(runtime.auth.options);
}
