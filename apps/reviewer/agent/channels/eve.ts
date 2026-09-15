import { createHash, timingSafeEqual } from "node:crypto";
import { eveChannel } from "eve/channels/eve";
import {
  extractBearerToken,
  type AuthFn,
  withAuthChallenges,
} from "eve/channels/auth";
import {
  authenticateEveTenantRequest,
  eveTenantDelegationIssuerOptionsFromEnv,
  looksLikeEveTenantDelegation,
  sessionAuthFromEveTenantPrincipal,
  EVE_TENANT_DELEGATION_SECRET_ENV,
  EVE_TENANT_ID_HEADER,
  EVE_TENANT_SERVICE_HEADER,
  type EveTenantDelegationVerifierOptions,
} from "../../../../packages/eve-tenant/src/index.js";

const TENANT_SERVICE = "consolidation-reviewer" as const;
const TENANT_ISSUER_ENV = "PSKILLS_EVE_TENANT_DELEGATION_ISSUER";
const TENANT_SERVICE_IDENTITY_ENV = "PSKILLS_EVE_TENANT_SERVICE_IDENTITY";

function constantTimeEqual(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left, "utf8").digest();
  const rightHash = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftHash, rightHash);
}

function tenantVerifier(): EveTenantDelegationVerifierOptions | undefined {
  const issuer = process.env[TENANT_ISSUER_ENV]?.trim();
  const serviceIdentity = process.env[TENANT_SERVICE_IDENTITY_ENV]?.trim();
  if (!process.env[EVE_TENANT_DELEGATION_SECRET_ENV] || !issuer || !serviceIdentity) return undefined;
  try {
    const issuerOptions = eveTenantDelegationIssuerOptionsFromEnv(process.env, {
      issuer,
      serviceIdentity,
    });
    return issuerOptions === undefined ? undefined : {
      ...issuerOptions,
      expectedServiceIdentity: serviceIdentity,
    };
  } catch {
    return undefined;
  }
}

function tenantDelegationConfigured(): boolean {
  return Boolean(process.env[EVE_TENANT_DELEGATION_SECRET_ENV]);
}

function tenantMetadataMatches(request: Request, tenantId: string): boolean {
  const suppliedTenant = request.headers.get(EVE_TENANT_ID_HEADER);
  const suppliedService = request.headers.get(EVE_TENANT_SERVICE_HEADER);
  return (suppliedTenant === null || suppliedTenant === tenantId) &&
    (suppliedService === null || suppliedService === TENANT_SERVICE);
}

/** Tenant bearer auth exposes only the verified tenant principal to Eve. */
export async function reviewerTenantAuth(request: Request): Promise<ReturnType<typeof sessionAuthFromEveTenantPrincipal> | null> {
  const supplied = extractBearerToken(request.headers.get("authorization"));
  const verifier = tenantVerifier();
  if (!supplied || verifier === undefined) return null;
  const principal = await authenticateEveTenantRequest(request, verifier, { service: TENANT_SERVICE });
  if (!principal || !tenantMetadataMatches(request, principal.claims.tenantId)) return null;
  return sessionAuthFromEveTenantPrincipal(principal);
}

function reviewerStaticAuth(request: Request) {
  const expected = process.env.PSKILLS_EVE_API_TOKEN?.trim();
  const supplied = extractBearerToken(request.headers.get("authorization"));
  if (!expected || expected.length > 512 || /\s/u.test(expected) || !supplied || supplied.length > 512 || /\s/u.test(supplied) || !constantTimeEqual(expected, supplied)) return null;
  return {
    attributes: { service: "private-skills-reviewer" },
    authenticator: "pskills-static-bearer",
    principalId: "private-skills-reviewer-client",
    principalType: "service" as const,
  };
}

export const reviewerAuth: AuthFn<Request> = withAuthChallenges(
  async (request) => {
    const tenant = await reviewerTenantAuth(request);
    if (tenant) return tenant;
    const supplied = extractBearerToken(request.headers.get("authorization"));
    if (tenantDelegationConfigured() && looksLikeEveTenantDelegation(supplied ?? undefined)) return null;
    return reviewerStaticAuth(request);
  },
  [{ scheme: "Bearer" }],
);

export default eveChannel({ auth: reviewerAuth });
