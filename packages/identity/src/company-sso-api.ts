import {
  CompanySsoConflictError,
  CompanySsoError,
  CompanySsoRepositoryError,
  type CompanySsoModuleOptions,
  type CompanySsoProviderCreateInput,
  type CompanySsoProviderPublic,
  type CompanySsoProviderRecord,
  type CompanySsoProviderUpdateInput,
} from './company-sso-types.js';
import {
  normalizeCompanySsoDisplayName,
  normalizeCompanySsoStatus,
  normalizeCompanyOrganizationId,
  normalizeCompanyProviderId,
  validateCompanySsoRegistration,
} from './company-sso-validation.js';

const DEFAULT_ROUTE_PREFIX = '/v1/companies';
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export interface CompanySsoApiOptions extends CompanySsoModuleOptions {
  routePrefix?: string;
  maxBodyBytes?: number;
  idGenerator?: () => string;
  now?: () => Date;
}

export type CompanySsoHandler = (request: Request) => Promise<Response | undefined>;

export interface CompanySsoApi {
  handler: CompanySsoHandler;
  /** List active providers for a company portal without exposing configuration secrets. */
  listPublicProviders(organizationId: string): Promise<CompanySsoProviderPublic[]>;
  /** Resolve one provider for the runtime's explicit providerId flow. */
  getProviderForOrganization(organizationId: string, providerId: string): Promise<CompanySsoProviderRecord | null>;
}

function routePrefix(value: string | undefined): string {
  const prefix = (value ?? DEFAULT_ROUTE_PREFIX).replace(/\/+$/u, '') || DEFAULT_ROUTE_PREFIX;
  if (!prefix.startsWith('/') || prefix.includes('..') || !/^\/[A-Za-z0-9/_-]+$/u.test(prefix)) {
    throw new CompanySsoError('COMPANY_SSO_CONFIGURATION', 'Company SSO route prefix is invalid', 500);
  }
  return prefix;
}

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function errorResponse(error: unknown): Response {
  if (error instanceof CompanySsoError) return jsonResponse({ code: error.code, message: error.message }, error.status);
  return jsonResponse({ code: 'COMPANY_SSO_ERROR', message: 'Company SSO operation failed' }, 500);
}

function methodNotAllowed(allow: readonly string[]): Response {
  return jsonResponse({ code: 'METHOD_NOT_ALLOWED', message: 'Method is not allowed' }, 405, { allow: allow.join(', ') });
}

function decodePathSegment(value: string): string {
  try { return decodeURIComponent(value); } catch { throw new CompanySsoError('INVALID_REQUEST', 'Company SSO route contains an invalid path segment', 400); }
}

function publicProvider(record: CompanySsoProviderRecord): CompanySsoProviderPublic {
  return {
    id: record.id,
    organizationId: record.organizationId,
    providerId: record.providerId,
    displayName: record.displayName,
    protocol: record.protocol,
    issuer: record.issuer,
    callbackUrl: record.callbackUrl,
    status: record.status,
    hasClientSecret: Boolean(record.oidc?.clientSecret),
    hasSigningCertificate: Boolean(record.saml?.idpMetadata.cert || record.saml?.idpMetadata.metadata?.match(/(?:^|[<:])X509Certificate[\s>]/u)),
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export { publicProvider as companySsoProviderPublic };

function bodyRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CompanySsoError('INVALID_REQUEST', 'Request body must be an object', 400);
  return value as Record<string, unknown>;
}

async function readBody(request: Request, maxBodyBytes: number): Promise<Record<string, unknown>> {
  const declared = request.headers.get('content-length');
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > maxBodyBytes) {
    throw new CompanySsoError('REQUEST_TOO_LARGE', 'Request body exceeds the configured size limit', 413);
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBodyBytes) throw new CompanySsoError('REQUEST_TOO_LARGE', 'Request body exceeds the configured size limit', 413);
  try { return bodyRecord(JSON.parse(text)); } catch { throw new CompanySsoError('INVALID_REQUEST', 'Request body must contain valid JSON', 400); }
}

function parseProviderPath(request: Request, prefix: string): { organizationId: string; providerId?: string } | undefined {
  let pathname: string;
  try { pathname = new URL(request.url).pathname.replace(/\/+$/u, ''); } catch { throw new CompanySsoError('INVALID_REQUEST', 'Request URL is invalid', 400); }
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return undefined;
  const suffix = pathname.slice(prefix.length).replace(/^\/+|\/+$/gu, '');
  const segments = suffix ? suffix.split('/') : [];
  // Prefix is `/v1/companies`; the supported paths are:
  //   /:organizationId/sso/providers
  //   /:organizationId/sso/providers/:providerId
  if (segments.length !== 3 && segments.length !== 4) throw new CompanySsoError('NOT_FOUND', 'Company SSO route was not found', 404);
  if (segments[1] !== 'sso' || segments[2] !== 'providers') throw new CompanySsoError('NOT_FOUND', 'Company SSO route was not found', 404);
  const organizationId = normalizeCompanyOrganizationId(decodePathSegment(segments[0]));
  return { organizationId, ...(segments.length === 4 ? { providerId: normalizeCompanyProviderId(decodePathSegment(segments[3])) } : {}) };
}

function parseExpectedRevision(request: Request, fallback: number): number {
  const header = request.headers.get('if-match');
  if (header === null) return fallback;
  const value = header.trim().replace(/^W\//u, '').replace(/^"|"$/gu, '');
  if (!/^\d+$/u.test(value)) throw new CompanySsoError('INVALID_REVISION', 'If-Match must contain a provider revision', 400);
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new CompanySsoError('INVALID_REVISION', 'If-Match must contain a provider revision', 400);
  return revision;
}

function assertBodyOrganization(body: Record<string, unknown>, organizationId: string): void {
  if (!('organizationId' in body) || body.organizationId === undefined) return;
  if (normalizeCompanyOrganizationId(body.organizationId) !== organizationId) {
    throw new CompanySsoError('ORGANIZATION_MISMATCH', 'The request organization does not match the company portal', 403);
  }
}

function assertBodyProvider(body: Record<string, unknown>, providerId: string): void {
  if (!('providerId' in body) || body.providerId === undefined) return;
  if (normalizeCompanyProviderId(body.providerId) !== providerId) throw new CompanySsoError('PROVIDER_MISMATCH', 'The request provider does not match the selected company provider', 403);
}

function valueChanged(body: Record<string, unknown>, ...keys: string[]): boolean {
  return keys.some((key) => key in body && body[key] !== undefined);
}

function mergeUpdateInput(record: CompanySsoProviderRecord, body: CompanySsoProviderUpdateInput): CompanySsoProviderCreateInput {
  const merged: Record<string, unknown> = {
    providerId: record.providerId,
    organizationId: record.organizationId,
    displayName: body.displayName ?? record.displayName,
    protocol: record.protocol,
    issuer: body.issuer ?? record.issuer,
    callbackUrl: body.callbackUrl ?? record.callbackUrl,
    status: body.status ?? record.status,
  };
  if (record.protocol === 'oidc' && record.oidc) {
    const updateOidc = body.oidc && typeof body.oidc === 'object' && !Array.isArray(body.oidc) ? body.oidc as Record<string, unknown> : {};
    merged.oidc = { ...record.oidc, ...updateOidc };
  }
  if (record.protocol === 'saml' && record.saml) {
    const updateSaml = body.saml && typeof body.saml === 'object' && !Array.isArray(body.saml) ? body.saml as Record<string, unknown> : {};
    merged.saml = { ...record.saml, ...updateSaml };
  }
  return merged;
}

function createId(idGenerator?: () => string): string {
  const generated = idGenerator?.() ?? globalThis.crypto?.randomUUID?.();
  if (!generated || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(generated)) {
    throw new CompanySsoRepositoryError('Company SSO id generation failed');
  }
  return generated;
}

export function createCompanySsoApi(options: CompanySsoApiOptions): CompanySsoApi {
  const prefix = routePrefix(options.routePrefix);
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1_024 || maxBodyBytes > 8 * 1024 * 1024) throw new CompanySsoError('COMPANY_SSO_CONFIGURATION', 'Company SSO body limit is invalid', 500);
  const now = options.now ?? (() => new Date());

  const listPublicProviders = async (organizationIdValue: string): Promise<CompanySsoProviderPublic[]> => {
    const organizationId = normalizeCompanyOrganizationId(organizationIdValue);
    return (await options.repository.list(organizationId)).map(publicProvider);
  };
  const getProviderForOrganization = async (organizationIdValue: string, providerIdValue: string): Promise<CompanySsoProviderRecord | null> => {
    const organizationId = normalizeCompanyOrganizationId(organizationIdValue);
    const providerId = normalizeCompanyProviderId(providerIdValue);
    return options.repository.get(organizationId, providerId);
  };

  const handler: CompanySsoHandler = async (request) => {
    let route: ReturnType<typeof parseProviderPath>;
    try { route = parseProviderPath(request, prefix); } catch (error) { return errorResponse(error); }
    if (!route) return undefined;
    try {
      const authorization = await options.authorizer.authorize({ request, organizationId: route.organizationId, action: request.method === 'GET' ? 'read' : request.method === 'DELETE' ? 'delete' : 'write' });
      if (!authorization || authorization.organizationId !== route.organizationId || (authorization.mode !== 'recovery' && authorization.role !== 'owner' && authorization.role !== 'admin')) {
        throw new CompanySsoError('FORBIDDEN', 'Company SSO administrator access is required', 403);
      }
      if (request.method === 'GET') {
        if (route.providerId) {
          const record = await options.repository.get(route.organizationId, route.providerId);
          if (!record) throw new CompanySsoError('NOT_FOUND', 'Company SSO provider was not found', 404);
          return jsonResponse({ provider: publicProvider(record) });
        }
        return jsonResponse({ providers: await listPublicProviders(route.organizationId) });
      }
      if (request.method === 'POST' && !route.providerId) {
        const body = await readBody(request, maxBodyBytes);
        assertBodyOrganization(body, route.organizationId);
        const validated = await validateCompanySsoRegistration(route.organizationId, body, options);
        if (await options.repository.getByProviderId(validated.providerId)) throw new CompanySsoConflictError('Company SSO provider id is already in use');
        const timestamp = now().toISOString();
        const record: CompanySsoProviderRecord = {
          id: createId(options.idGenerator),
          ...validated,
          createdBy: authorization.principalId,
          updatedBy: authorization.principalId,
          revision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        const created = await options.repository.create(record);
        return jsonResponse({ provider: publicProvider(created) }, 201);
      }
      if (!route.providerId) return methodNotAllowed(['GET', 'POST']);
      const existing = await options.repository.get(route.organizationId, route.providerId);
      if (!existing) throw new CompanySsoError('NOT_FOUND', 'Company SSO provider was not found', 404);
      if (request.method === 'DELETE') {
        const deleted = await options.repository.delete(route.organizationId, route.providerId, parseExpectedRevision(request, existing.revision));
        if (!deleted) throw new CompanySsoError('REVISION_CONFLICT', 'Company SSO provider changed; reload before deleting', 409);
        return jsonResponse({ deleted: true, providerId: route.providerId });
      }
      if (request.method !== 'PATCH' && request.method !== 'PUT') return methodNotAllowed(['GET', 'PATCH', 'PUT', 'DELETE']);
      const body = await readBody(request, maxBodyBytes);
      assertBodyOrganization(body, route.organizationId);
      assertBodyProvider(body, route.providerId);
      if ('protocol' in body && body.protocol !== undefined && body.protocol !== existing.protocol) throw new CompanySsoError('PROTOCOL_IMMUTABLE', 'Provider protocol cannot be changed', 409);
      if ('domain' in body || 'organizationSlug' in body) throw new CompanySsoError('DOMAIN_DISCOVERY_DISABLED', 'Company SSO does not support domain-based provider discovery', 422);
      const sensitiveChange = valueChanged(body, 'issuer', 'callbackUrl', 'oidc', 'saml');
      let patch: Partial<CompanySsoProviderRecord>;
      if (sensitiveChange) {
        const validated = await validateCompanySsoRegistration(route.organizationId, mergeUpdateInput(existing, body), options);
        patch = { ...validated, updatedBy: authorization.principalId, updatedAt: now().toISOString() };
      } else {
        if (body.displayName === undefined && body.status === undefined) throw new CompanySsoError('INVALID_REQUEST', 'No provider fields were supplied for update', 400);
        const bodyForValidation = { ...body };
        if ('domain' in bodyForValidation || 'organizationSlug' in bodyForValidation) throw new CompanySsoError('DOMAIN_DISCOVERY_DISABLED', 'Company SSO does not support domain-based provider discovery', 422);
        patch = {
          ...(body.displayName === undefined ? {} : { displayName: normalizeCompanySsoDisplayName(body.displayName) }),
          ...(body.status === undefined ? {} : { status: normalizeCompanySsoStatus(body.status) }),
          updatedBy: authorization.principalId,
          updatedAt: now().toISOString(),
        };
      }
      const updated = await options.repository.update(route.organizationId, route.providerId, patch, parseExpectedRevision(request, existing.revision));
      if (!updated) throw new CompanySsoError('REVISION_CONFLICT', 'Company SSO provider changed; reload before updating', 409);
      return jsonResponse({ provider: publicProvider(updated) });
    } catch (error) {
      return errorResponse(error);
    }
  };
  return { handler, listPublicProviders, getProviderForOrganization };
}

export const createCompanySsoHandler = (options: CompanySsoApiOptions): CompanySsoHandler => createCompanySsoApi(options).handler;
