import {
  CompanySsoError,
  type CompanySsoProtocol,
} from '../../../packages/identity/src/company-sso-types.js';
import {
  normalizeCompanyOrganizationId,
  normalizeCompanyProviderId,
} from '../../../packages/identity/src/company-sso-validation.js';

export interface CompanySsoRuntimeHandler {
  handler(request: Request): Promise<Response | undefined>;
  listPublicProviders?(organizationId: string): Promise<readonly CompanySsoProviderPublicView[]>;
  getProviderForOrganization?(organizationId: string, providerId: string): Promise<CompanySsoProviderRecordView | null>;
  selectProvider?(organizationId: string, providerId: string, appOrigin: string, allowLoopbackHttp?: boolean): Promise<CompanySsoSelection | null>;
}

/** The public projection returned by the unauthenticated company login picker. */
export interface CompanySsoProviderPublicView {
  providerId: string;
  displayName: string;
  protocol: CompanySsoProtocol;
  status: 'active' | 'disabled';
}

/** Only the fields needed to bind the Better Auth sign-in request are retained. */
export interface CompanySsoProviderRecordView {
  providerId: string;
  organizationId: string;
  protocol: CompanySsoProtocol;
  status: 'active' | 'disabled';
}

export interface CompanySsoSelection {
  organizationId: string;
  providerId: string;
  /** The generated callback registered with the provider. */
  callbackURL: string;
}

export interface CompanySsoLoginRuntime {
  /** Better Auth's server handler, mounted at the configured base path. */
  identityHandler: (request: Request) => Promise<Response>;
  basePath: string;
  appOrigin: string;
  allowLoopbackHttp?: boolean;
}

const COMPANY_SSO_ADMIN_ROUTE = /^\/v1\/companies\/([^/]+)\/sso\/providers(?:\/[^/]+)?$/u;
const COMPANY_SSO_LOGIN_ROUTE = /^\/v1\/companies\/([^/]+)\/sso\/login$/u;
const MAX_LOGIN_BODY_BYTES = 64 * 1024;
const CALLBACK_PATH = /^\/app(?:\/|$)/u;
const INVITATION_PATH = '/organization/accept-invitation';

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function unavailableResponse(): Response {
  return jsonResponse(
    { code: 'COMPANY_SSO_UNAVAILABLE', message: 'Company SSO is unavailable on this deployment.' },
    503,
  );
}

function errorResponse(error: unknown, unavailable = false): Response {
  if (error instanceof CompanySsoError) return jsonResponse({ code: error.code, message: error.message }, error.status);
  if (unavailable) return unavailableResponse();
  return jsonResponse({ code: 'COMPANY_SSO_ERROR', message: 'Company SSO operation failed' }, 500);
}

function methodNotAllowed(): Response {
  return jsonResponse({ code: 'METHOD_NOT_ALLOWED', message: 'Method is not allowed' }, 405, { allow: 'GET, POST' });
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new CompanySsoError('INVALID_REQUEST', 'Company SSO route contains an invalid path segment', 400);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

async function readLoginBody(request: Request): Promise<Record<string, unknown>> {
  const declared = request.headers.get('content-length');
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > MAX_LOGIN_BODY_BYTES) {
    throw new CompanySsoError('REQUEST_TOO_LARGE', 'Request body exceeds the configured size limit', 413);
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_LOGIN_BODY_BYTES) {
    throw new CompanySsoError('REQUEST_TOO_LARGE', 'Request body exceeds the configured size limit', 413);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CompanySsoError('INVALID_REQUEST', 'Request body must contain valid JSON', 400);
  }
  if (!isRecord(value)) throw new CompanySsoError('INVALID_REQUEST', 'Request body must be an object', 400);
  return value;
}

function safeCallbackURL(value: unknown, appOrigin: string): string {
  const raw = value === undefined ? '/app' : value;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2_048 || /[\u0000-\u001f\u007f\\]/u.test(raw) || raw.startsWith('//')) {
    throw new CompanySsoError('INVALID_CALLBACK', 'callbackURL must be a same-origin application path', 400);
  }
  let target: URL;
  try {
    target = new URL(raw, appOrigin);
  } catch {
    throw new CompanySsoError('INVALID_CALLBACK', 'callbackURL must be a same-origin application path', 400);
  }
  if (target.origin !== appOrigin || target.username || target.password) {
    throw new CompanySsoError('INVALID_CALLBACK', 'callbackURL must be a same-origin application path', 400);
  }
  if (CALLBACK_PATH.test(target.pathname)) return `${target.pathname}${target.search}${target.hash}`;
  if (target.pathname !== INVITATION_PATH || target.hash) {
    throw new CompanySsoError('INVALID_CALLBACK', 'callbackURL must point to the registry or an invitation', 400);
  }
  const keys = [...target.searchParams.keys()];
  const invitationId = target.searchParams.get('id');
  if (keys.length !== 1 || keys[0] !== 'id' || !invitationId || invitationId.length > 256 || /[\u0000-\u001f\u007f]/u.test(invitationId)) {
    throw new CompanySsoError('INVALID_CALLBACK', 'callbackURL must point to the registry or an invitation', 400);
  }
  return `${target.pathname}?${target.searchParams.toString()}`;
}

function authSignInPath(basePath: string): string {
  if (!/^\/[A-Za-z0-9/_-]*$/u.test(basePath)) throw new CompanySsoError('COMPANY_SSO_UNAVAILABLE', 'Identity authentication is unavailable on this deployment.', 503);
  const normalized = basePath.replace(/\/+$/u, '') || '/api/auth';
  return `${normalized}/sign-in/sso`;
}

function requestOriginMatches(request: Request, appOrigin: string): void {
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== appOrigin) throw new CompanySsoError('ORIGIN_MISMATCH', 'Company SSO requests must come from the registry origin', 403);
}

async function handleCompanySsoLogin(
  request: Request,
  organizationId: string,
  companySso: CompanySsoRuntimeHandler,
  login: CompanySsoLoginRuntime | undefined,
): Promise<Response> {
  if (!login || !companySso.listPublicProviders || !companySso.getProviderForOrganization || !companySso.selectProvider) return unavailableResponse();
  if (request.method === 'GET') {
    try {
      const providers = (await companySso.listPublicProviders(organizationId))
        .filter((provider) => provider.status === 'active')
        .map(({ providerId, displayName, protocol }) => ({ providerId, displayName, protocol }));
      return jsonResponse({ organizationId, providers });
    } catch (error) {
      return errorResponse(error, true);
    }
  }
  if (request.method !== 'POST') return methodNotAllowed();
  try {
    requestOriginMatches(request, login.appOrigin);
    const body = await readLoginBody(request);
    const providerId = normalizeCompanyProviderId(body.providerId);
    if (body.organizationId !== undefined && normalizeCompanyOrganizationId(body.organizationId) !== organizationId) {
      throw new CompanySsoError('ORGANIZATION_MISMATCH', 'The request organization does not match the company login', 403);
    }
    const record = await companySso.getProviderForOrganization(organizationId, providerId);
    if (!record) throw new CompanySsoError('NOT_FOUND', 'Company SSO provider was not found', 404);
    if (body.providerType !== undefined && body.providerType !== record.protocol) {
      throw new CompanySsoError('PROTOCOL_MISMATCH', 'The request protocol does not match the company provider', 403);
    }
    const selection = await companySso.selectProvider(
      organizationId,
      providerId,
      login.appOrigin,
      login.allowLoopbackHttp,
    );
    if (!selection) throw new CompanySsoError('NOT_FOUND', 'Company SSO provider was not found', 404);
    const callbackURL = safeCallbackURL(body.callbackURL, login.appOrigin);
    const headers = new Headers({ accept: 'application/json', 'content-type': 'application/json', origin: login.appOrigin });
    for (const name of ['cookie', 'user-agent']) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    const identityRequest = new Request(new URL(authSignInPath(login.basePath), login.appOrigin), {
      method: 'POST',
      headers,
      body: JSON.stringify({ providerId: selection.providerId, providerType: record.protocol, callbackURL }),
    });
    return await login.identityHandler(identityRequest);
  } catch (error) {
    return errorResponse(error, true);
  }
}

/** Keep the company SSO capability explicit when the Node identity runtime is off. */
export async function handleCompanySsoRoute(
  request: Request,
  companySso: CompanySsoRuntimeHandler | undefined,
  login?: CompanySsoLoginRuntime,
): Promise<Response | undefined> {
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname.replace(/\/+$/u, '') || '/';
  } catch {
    return undefined;
  }
  const loginMatch = COMPANY_SSO_LOGIN_ROUTE.exec(pathname);
  const adminMatch = COMPANY_SSO_ADMIN_ROUTE.exec(pathname);
  if (!loginMatch && !adminMatch) return undefined;
  if (!companySso) return unavailableResponse();
  if (loginMatch) {
    try {
      const organizationId = normalizeCompanyOrganizationId(decodeSegment(loginMatch[1]));
      return handleCompanySsoLogin(request, organizationId, companySso, login);
    } catch (error) {
      return errorResponse(error);
    }
  }
  return companySso.handler(request);
}
