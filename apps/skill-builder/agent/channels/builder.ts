import { createHash, timingSafeEqual } from "node:crypto";
import { defineChannel, GET, POST } from "eve/channels";
import { extractBearerToken } from "eve/channels/auth";
import {
  validateBuilderOpaqueId,
  validateBuilderSessionStartRequest,
  type BuilderDigest,
  type BuilderSessionAcceptance,
  type BuilderSessionStartRequest,
  validateDraftBinding,
} from "../../../../packages/skill-builder/src/index.js";
import { builderServiceToken, builderStatus } from "../lib/config.js";
import {
  authenticateEveTenantRequest,
  eveTenantDelegationIssuerOptionsFromEnv,
  looksLikeEveTenantDelegation,
  sessionAuthFromEveTenantPrincipal,
  EVE_TENANT_DELEGATION_SECRET_ENV,
  EVE_TENANT_ID_HEADER,
  EVE_TENANT_SERVICE_HEADER,
  type EveTenantDelegationVerifierOptions,
  type EveTenantPrincipal,
} from "../../../../packages/eve-tenant/src/index.js";

const MAX_REQUEST_BYTES = 96 * 1024;
const TENANT_SERVICE = "skill-builder" as const;
const TENANT_ISSUER_ENV = "PSKILLS_EVE_TENANT_DELEGATION_ISSUER";
const TENANT_SERVICE_IDENTITY_ENV = "PSKILLS_EVE_TENANT_SERVICE_IDENTITY";

export interface BuilderChannelState {
  readonly sessionKey: string | null;
  readonly registrySessionId: string | null;
  readonly draftId: string | null;
  readonly revision: number | null;
  readonly digest: BuilderDigest | null;
}

const initialState: BuilderChannelState = {
  sessionKey: null,
  registrySessionId: null,
  draftId: null,
  revision: null,
  digest: null,
};

const servicePrincipal = {
  attributes: { service: "private-skills-registry-bff" },
  authenticator: "pskills-builder-service-token",
  principalId: "private-skills-registry-bff",
  principalType: "service",
} as const;

function constantTimeEqual(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left, "utf8").digest();
  const rightHash = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftHash, rightHash);
}

function unauthorized(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "cache-control": "no-store",
      "www-authenticate": 'Bearer realm="private-skills-skill-builder"',
    },
  });
}

function staticAuthorization(request: Request): boolean {
  const supplied = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/iu)?.[1];
  if (!supplied || supplied.length > 512 || /\s/u.test(supplied)) return false;
  let expected: string;
  try {
    expected = builderServiceToken();
  } catch {
    return false;
  }
  return constantTimeEqual(expected, supplied);
}

export interface TenantAuthorization {
  readonly kind: "tenant";
  readonly principal: EveTenantPrincipal;
  readonly auth: ReturnType<typeof sessionAuthFromEveTenantPrincipal>;
}

export type BuilderAuthorization =
  | { readonly kind: "tenant"; readonly tenant: TenantAuthorization }
  | { readonly kind: "legacy" };

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

async function tenantAuthorization(request: Request): Promise<TenantAuthorization | null> {
  const supplied = extractBearerToken(request.headers.get("authorization"));
  const verifier = tenantVerifier();
  if (!supplied || verifier === undefined) return null;
  const principal = await authenticateEveTenantRequest(request, verifier, { service: TENANT_SERVICE });
  if (!principal || !tenantMetadataMatches(request, principal.claims.tenantId)) return null;
  return {
    kind: "tenant",
    principal,
    auth: sessionAuthFromEveTenantPrincipal(principal),
  };
}

export async function authorizeBuilderRequest(request: Request): Promise<BuilderAuthorization | null> {
  const tenant = await tenantAuthorization(request);
  if (tenant) return { kind: "tenant", tenant };
  const supplied = extractBearerToken(request.headers.get("authorization"));
  if (tenantDelegationConfigured() && looksLikeEveTenantDelegation(supplied ?? undefined)) return null;
  return staticAuthorization(request) ? { kind: "legacy" } : null;
}

export function builderBindingMatches(input: BuilderSessionRequest, principal: EveTenantPrincipal): boolean {
  const binding = principal.claims.binding;
  return binding?.registrySessionId === input.registrySessionId &&
    binding.draftId === input.draftId &&
    binding.draftRevision === input.revision &&
    binding.draftDigest === input.digest;
}

function invalid(message: string, status = 400): Response {
  return Response.json({ error: message }, { status, headers: { "cache-control": "no-store" } });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number.isSafeInteger(Number(declared)) && Number(declared) > MAX_REQUEST_BYTES) {
    throw new Error("request is too large");
  }
  if (!request.body) throw new Error("request body is required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new Error("request is too large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error("request body must be valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("request body must be an object");
  return value as Record<string, unknown>;
}

export type BuilderSessionRequest = BuilderSessionStartRequest;

export function parseSessionRequest(value: Record<string, unknown>): BuilderSessionRequest {
  return validateBuilderSessionStartRequest(value);
}

export function channelMetadata(state: BuilderChannelState): Record<string, unknown> {
  if (!state.registrySessionId || !state.draftId || state.revision === null || !state.digest) {
    return { audience: "private", bound: false };
  }
  let registrySessionId: string;
  try {
    registrySessionId = validateBuilderOpaqueId(state.registrySessionId, "registrySessionId");
    validateDraftBinding({
      draftId: state.draftId,
      revision: state.revision,
      digest: state.digest,
    });
  } catch {
    return { audience: "private", bound: false };
  }
  return {
    audience: "private",
    bound: true,
    registrySessionId,
    draftId: state.draftId,
    revision: state.revision,
    digest: state.digest,
  };
}

export default defineChannel<BuilderChannelState>({
  state: initialState,
  kindHint: "skill-builder",
  turnPolicy: "steer",
  metadata: channelMetadata,
  routes: [
    GET("/internal/builder/status", async (request) => {
      if (!await authorizeBuilderRequest(request)) return unauthorized();
      return Response.json(builderStatus(), {
        headers: { "cache-control": "no-store" },
      });
    }),
    POST("/internal/builder/sessions", async (request, { from }) => {
      const authorization = await authorizeBuilderRequest(request);
      if (!authorization) return unauthorized();
      let body: Record<string, unknown>;
      try {
        body = await readJson(request);
      } catch (error) {
        return invalid(error instanceof Error ? error.message : "invalid request");
      }
      let input: ReturnType<typeof parseSessionRequest>;
      try {
        input = parseSessionRequest(body);
      } catch (error) {
        return invalid(error instanceof Error ? error.message : "invalid request");
      }
      if (authorization.kind === "tenant" && !builderBindingMatches(input, authorization.tenant.principal)) {
        return invalid("builder request does not match its tenant draft delegation", 403);
      }
      const status = builderStatus();
      if (!status.enabled) return invalid("skill builder is disabled", 503);
      try {
        const session = await from(input.sessionKey).send(input.message, {
          auth: authorization.kind === "tenant" ? authorization.tenant.auth : servicePrincipal,
          state: {
            sessionKey: input.sessionKey,
            registrySessionId: input.registrySessionId,
            draftId: input.draftId,
            revision: input.revision,
            digest: input.digest,
          },
        });
        const acceptance: BuilderSessionAcceptance = {
          status: "accepted",
          sessionId: session.id,
          sessionKey: input.sessionKey,
          registrySessionId: input.registrySessionId,
          draftId: input.draftId,
          revision: input.revision,
          digest: input.digest,
          requestId: input.requestId,
          requestDigest: input.requestDigest,
          ...(input.selectedPath === undefined ? {} : { selectedPath: input.selectedPath }),
        };
        return Response.json(acceptance, {
          status: 202,
          headers: { "cache-control": "no-store" },
        });
      } catch {
        return invalid("skill builder session could not be started", 502);
      }
    }),
  ],
});
