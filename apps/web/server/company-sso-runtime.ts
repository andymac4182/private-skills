export interface CompanySsoRuntimeHandler {
  handler(request: Request): Promise<Response | undefined>;
}

const COMPANY_SSO_ROUTE = /^\/v1\/companies\/[^/]+\/sso\/providers(?:\/[^/]+)?$/u;

/** Keep the company SSO capability explicit when the Node identity runtime is off. */
export async function handleCompanySsoRoute(
  request: Request,
  companySso: CompanySsoRuntimeHandler | undefined,
): Promise<Response | undefined> {
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname.replace(/\/+$/u, '') || '/';
  } catch {
    return undefined;
  }
  if (!COMPANY_SSO_ROUTE.test(pathname)) return undefined;
  if (!companySso) {
    return Response.json(
      { code: 'COMPANY_SSO_UNAVAILABLE', message: 'Company SSO is unavailable on this deployment.' },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
  return companySso.handler(request);
}
