import { createHash, timingSafeEqual } from 'node:crypto';
import { eveChannel } from 'eve/channels/eve';
import {
  extractBearerToken,
  type AuthFn,
  withAuthChallenges,
} from 'eve/channels/auth';
import {
  authenticateEveTenantRequest,
  eveTenantDelegationIssuerOptionsFromEnv,
  looksLikeEveTenantDelegation,
  sessionAuthFromEveTenantPrincipal,
  EVE_TENANT_DELEGATION_SECRET_ENV,
  EVE_TENANT_ID_HEADER,
  EVE_TENANT_SERVICE_HEADER,
  type EveTenantDelegationVerifierOptions,
} from '../../../../packages/eve-tenant/src/index.js';

const SESSION_JOB_HEADER = 'x-pskills-upload-review-job';
const MAX_JOB_ID_LENGTH = 256;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const TENANT_SERVICE = 'upload-reviewer' as const;
const TENANT_ISSUER_ENV = 'PSKILLS_EVE_TENANT_DELEGATION_ISSUER';
const TENANT_SERVICE_IDENTITY_ENV = 'PSKILLS_EVE_TENANT_SERVICE_IDENTITY';

function constantTimeEqual(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left, 'utf8').digest();
  const rightHash = createHash('sha256').update(right, 'utf8').digest();
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

function validJobId(value: string): string | null {
  const jobId = value.trim();
  return !jobId || jobId.length > MAX_JOB_ID_LENGTH || CONTROL_CHARACTER.test(jobId) ? null : jobId;
}

/** Tenant bearer auth binds upload review to the signed job claim. */
export async function uploadReviewTenantAuth(request: Request): Promise<ReturnType<typeof sessionAuthFromEveTenantPrincipal> | null> {
  const supplied = extractBearerToken(request.headers.get('authorization'));
  const verifier = tenantVerifier();
  if (!supplied || verifier === undefined) return null;
  const principal = await authenticateEveTenantRequest(request, verifier, { service: TENANT_SERVICE });
  const jobId = principal?.claims.binding?.jobId;
  if (!principal || !jobId || !tenantMetadataMatches(request, principal.claims.tenantId)) return null;
  const suppliedJob = request.headers.get(SESSION_JOB_HEADER);
  if (suppliedJob !== null && validJobId(suppliedJob) !== jobId) return null;
  const auth = sessionAuthFromEveTenantPrincipal(principal);
  return {
    ...auth,
    attributes: {
      ...auth.attributes,
      // Preserve the existing tool attribute, but source it from signed claims.
      uploadReviewJobId: jobId,
    },
  };
}

function uploadReviewStaticAuth(request: Request) {
  const expected = process.env.PSKILLS_UPLOAD_REVIEW_EVE_API_TOKEN?.trim();
  const supplied = extractBearerToken(request.headers.get('authorization'));
  if (!expected || expected.length > 512 || /\s/u.test(expected) || !supplied || supplied.length > 512 || /\s/u.test(supplied) || !constantTimeEqual(expected, supplied)) return null;
  const attributes: Record<string, string> = {
    service: 'private-skills-upload-reviewer',
  };
  const rawJobId = request.headers.get(SESSION_JOB_HEADER);
  if (rawJobId !== null) {
    const jobId = validJobId(rawJobId);
    if (!jobId) return null;
    attributes.uploadReviewJobId = jobId;
  }
  return {
    attributes,
    authenticator: 'pskills-upload-review-static-bearer',
    principalId: 'private-skills-upload-reviewer-client',
    principalType: 'service' as const,
  };
}

export const uploadReviewAuth: AuthFn<Request> = withAuthChallenges(
  async (request) => {
    const tenant = await uploadReviewTenantAuth(request);
    if (tenant) return tenant;
    const supplied = extractBearerToken(request.headers.get('authorization'));
    if (tenantDelegationConfigured() && looksLikeEveTenantDelegation(supplied ?? undefined)) return null;
    return uploadReviewStaticAuth(request);
  },
  [{ scheme: 'Bearer' }],
);

export default eveChannel({ auth: uploadReviewAuth });
