import { createHash, timingSafeEqual } from "node:crypto";
import { eveChannel } from "eve/channels/eve";
import {
  extractBearerToken,
  type AuthFn,
  withAuthChallenges,
} from "eve/channels/auth";
import { builderEveToken } from "../lib/config.js";
import {
  authenticateEveTenantRequest,
  eveTenantDelegationIssuerOptionsFromEnv,
  looksLikeEveTenantDelegation,
  sessionAuthFromEveTenantPrincipal,
  EVE_TENANT_ID_HEADER,
  EVE_TENANT_SERVICE_HEADER,
  EVE_TENANT_DELEGATION_SECRET_ENV,
  type EveTenantDelegationVerifierOptions,
} from "../../../../packages/eve-tenant/src/index.js";

const TENANT_SERVICE = "skill-builder" as const;
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

/** Tenant bearer auth for the routed deployment; invalid values fail closed. */
export async function builderTenantAuth(request: Request): Promise<ReturnType<typeof sessionAuthFromEveTenantPrincipal> | null> {
  const supplied = extractBearerToken(request.headers.get("authorization"));
  const verifier = tenantVerifier();
  if (!supplied || verifier === undefined) return null;
  const principal = await authenticateEveTenantRequest(request, verifier, { service: TENANT_SERVICE });
  if (!principal || !tenantMetadataMatches(request, principal.claims.tenantId)) return null;
  return sessionAuthFromEveTenantPrincipal(principal);
}

function builderStaticAuth(request: Request) {
  let expected: string;
  try {
    expected = builderEveToken();
  } catch {
    return null;
  }
  const supplied = extractBearerToken(request.headers.get("authorization"));
  if (!supplied || supplied.length > 512 || /\s/u.test(supplied) || !constantTimeEqual(expected, supplied)) return null;
  return {
    attributes: { service: "private-skills-skill-builder" },
    authenticator: "pskills-static-bearer",
    principalId: "private-skills-skill-builder-bff",
    principalType: "service" as const,
  };
}

export const builderAuth: AuthFn<Request> = withAuthChallenges(
  async (request) => {
    const tenant = await builderTenantAuth(request);
    if (tenant) return tenant;
    const supplied = extractBearerToken(request.headers.get("authorization"));
    // Once tenant mode is provisioned, an invalid/expired/mis-audienced
    // delegation must not be reinterpreted as the legacy default credential.
    if (tenantDelegationConfigured() && looksLikeEveTenantDelegation(supplied ?? undefined)) return null;
    return builderStaticAuth(request);
  },
  [{ scheme: "Bearer" }],
);

export default eveChannel({ auth: builderAuth });
