import { createGateway, type LanguageModel } from "ai";
import { getVercelOidcTokenSync } from "@vercel/oidc";
import {
  SkillBuilderConfigurationError,
  SkillBuilderRegistryClient,
} from "../../../../packages/skill-builder/src/index.js";
import type {
  BoundEveTenantService,
  EveTenantDelegationBinding,
} from "../../../../packages/eve-tenant/src/index.js";
import {
  bindEveTenantService,
  createEveTenantCredentialProvider,
} from "../../../../packages/eve-tenant/src/index.js";

const DEFAULT_BUILDER_MODEL = "openai/gpt-5.5";
const MODEL_ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/iu;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const MAX_OIDC_TOKEN_LENGTH = 16 * 1024;

export type BuilderStatusReason =
  | "AI_DISABLED"
  | "MODEL_INVALID"
  | "GATEWAY_CREDENTIAL_MISSING"
  | "GATEWAY_BASE_INVALID"
  | "REGISTRY_URL_MISSING"
  | "REGISTRY_URL_INVALID"
  | "REGISTRY_TOKEN_MISSING"
  | "SERVICE_TOKEN_MISSING"
  | "EVE_TOKEN_MISSING";

export interface BuilderStatus {
  readonly enabled: boolean;
  readonly model?: string;
  readonly gatewayConfigured: boolean;
  readonly registryConfigured: boolean;
  readonly serviceConfigured: boolean;
  readonly eveConfigured: boolean;
  readonly reasonCodes: readonly BuilderStatusReason[];
}

function nonEmptyEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length <= 1024 ? value : undefined;
}

function isDevelopment(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.VERCEL_ENV !== "production";
}

function validBoundedSecret(name: string): boolean {
  const value = nonEmptyEnv(name);
  return Boolean(value && value.length <= 512 && !/\s/u.test(value));
}

/**
 * Vercel injects OIDC into the request context in hosted functions. Keep the
 * synchronous lookup here because configuration is also checked by Eve's
 * synchronous dynamic-model hooks; the SDK's async lookup remains responsible
 * for refresh behavior when a model request is made.
 */
function oidcCredential(): string | undefined {
  try {
    return getVercelOidcTokenSync();
  } catch {
    return undefined;
  }
}

/** Vercel OIDC JWTs are request credentials and may exceed short API-key bounds. */
function validOidcCredential(): boolean {
  const value = oidcCredential()?.trim();
  if (!value || value.length > MAX_OIDC_TOKEN_LENGTH) return false;
  return Boolean(value && !/\s/u.test(value));
}

function validateGatewayBase(value: string): boolean {
  try {
    const base = new URL(value);
    if (base.username || base.password || base.search || base.hash) return false;
    return base.protocol === "https:" || (base.protocol === "http:" && isDevelopment() && LOOPBACK_HOSTS.has(base.hostname));
  } catch {
    return false;
  }
}

function validateRegistryBase(value: string): boolean {
  try {
    const base = new URL(value);
    if (base.username || base.password || base.search || base.hash) return false;
    return base.protocol === "https:" || (base.protocol === "http:" && isDevelopment() && LOOPBACK_HOSTS.has(base.hostname));
  } catch {
    return false;
  }
}

export function builderModel(): string {
  const model = nonEmptyEnv("PSKILLS_BUILDER_MODEL") || DEFAULT_BUILDER_MODEL;
  if (!MODEL_ID.test(model)) {
    throw new SkillBuilderConfigurationError("PSKILLS_BUILDER_MODEL must be a provider/model identifier");
  }
  return model;
}

export function builderStatus(): BuilderStatus {
  const reasons: BuilderStatusReason[] = [];
  const explicitlyDisabled = process.env.PSKILLS_BUILDER_AI_ENABLED?.trim().toLowerCase() === "false";
  if (explicitlyDisabled) reasons.push("AI_DISABLED");

  let model: string | undefined;
  try {
    model = builderModel();
  } catch {
    reasons.push("MODEL_INVALID");
  }

  const gatewayBase = nonEmptyEnv("PSKILLS_AI_GATEWAY_BASE_URL");
  if (gatewayBase && !validateGatewayBase(gatewayBase)) reasons.push("GATEWAY_BASE_INVALID");
  const gatewayConfigured = !reasons.includes("GATEWAY_BASE_INVALID") && validBoundedSecret("AI_GATEWAY_API_KEY")
    || !reasons.includes("GATEWAY_BASE_INVALID") && validOidcCredential();
  if (!gatewayConfigured) reasons.push("GATEWAY_CREDENTIAL_MISSING");

  const registryUrl = nonEmptyEnv("PSKILLS_BUILDER_REGISTRY_API_URL");
  const registryUrlConfigured = Boolean(registryUrl && validateRegistryBase(registryUrl));
  if (!registryUrl) reasons.push("REGISTRY_URL_MISSING");
  else if (!registryUrlConfigured) reasons.push("REGISTRY_URL_INVALID");
  const registryTokenConfigured = validBoundedSecret("PSKILLS_BUILDER_REGISTRY_TOKEN");
  const tenantDelegationConfigured = validTenantDelegationConfiguration();
  if (!registryTokenConfigured && !tenantDelegationConfigured) reasons.push("REGISTRY_TOKEN_MISSING");

  const serviceConfigured = validBoundedSecret("PSKILLS_BUILDER_SERVICE_TOKEN");
  if (!serviceConfigured && !tenantDelegationConfigured) reasons.push("SERVICE_TOKEN_MISSING");
  const eveConfigured = validBoundedSecret("PSKILLS_BUILDER_EVE_API_TOKEN");
  if (!eveConfigured && !tenantDelegationConfigured) reasons.push("EVE_TOKEN_MISSING");

  const enabled = !explicitlyDisabled && reasons.length === 0;
  return {
    enabled,
    ...(enabled && model ? { model } : {}),
    gatewayConfigured,
    registryConfigured: registryUrlConfigured && (registryTokenConfigured || tenantDelegationConfigured),
    serviceConfigured: serviceConfigured || tenantDelegationConfigured,
    eveConfigured: eveConfigured || tenantDelegationConfigured,
    reasonCodes: [...new Set(reasons)],
  };
}

export function assertBuilderEnabled(): BuilderStatus {
  const status = builderStatus();
  if (!status.enabled) {
    throw new SkillBuilderConfigurationError(`skill builder is disabled (${status.reasonCodes.join(",") || "unconfigured"})`);
  }
  return status;
}

export function builderLanguageModel(): LanguageModel {
  const status = assertBuilderEnabled();
  const configuredBase = nonEmptyEnv("PSKILLS_AI_GATEWAY_BASE_URL");
  const gateway = createGateway({
    ...(configuredBase ? { baseURL: configuredBase.replace(/\/+$/u, "") } : {}),
    ...(nonEmptyEnv("AI_GATEWAY_API_KEY") ? { apiKey: nonEmptyEnv("AI_GATEWAY_API_KEY") } : {}),
    ...(nonEmptyEnv("PSKILLS_AI_GATEWAY_TEAM_ID") ? { teamIdOrSlug: nonEmptyEnv("PSKILLS_AI_GATEWAY_TEAM_ID") } : {}),
  });
  return gateway.languageModel(status.model ?? builderModel());
}

export function registryClient(options: {
  tenantService?: BoundEveTenantService;
  tenantBinding?: EveTenantDelegationBinding;
} = {}): SkillBuilderRegistryClient {
  assertBuilderEnabled();
  const baseUrl = nonEmptyEnv("PSKILLS_BUILDER_REGISTRY_API_URL");
  const serviceToken = nonEmptyEnv("PSKILLS_BUILDER_REGISTRY_TOKEN");
  if (!baseUrl) throw new SkillBuilderConfigurationError("builder registry URL is not configured");
  if (options.tenantService) {
    return new SkillBuilderRegistryClient({
      baseUrl,
      tenantService: options.tenantService,
      tenantBinding: options.tenantBinding,
    });
  }
  if (!serviceToken) throw new SkillBuilderConfigurationError("builder registry credentials are not configured");
  return new SkillBuilderRegistryClient({ baseUrl, serviceToken });
}

export function validTenantDelegationConfiguration(): boolean {
  const secret = nonEmptyEnv("PSKILLS_EVE_TENANT_DELEGATION_SECRET");
  const issuer = nonEmptyEnv("PSKILLS_EVE_TENANT_DELEGATION_ISSUER");
  const serviceIdentity = nonEmptyEnv("PSKILLS_EVE_TENANT_SERVICE_IDENTITY");
  if (!secret || secret.length < 32 || /\s/u.test(secret) || !issuer || !serviceIdentity || /\s/u.test(serviceIdentity)) return false;
  try {
    const parsed = new URL(issuer);
    return parsed.username === "" && parsed.password === "" && parsed.pathname === "/" && parsed.search === "" && parsed.hash === "" &&
      (parsed.protocol === "https:" || (parsed.protocol === "http:" && isDevelopment() && LOOPBACK_HOSTS.has(parsed.hostname)));
  } catch {
    return false;
  }
}

export function tenantBuilderService(tenantId: string): BoundEveTenantService {
  if (!validTenantDelegationConfiguration()) {
    throw new SkillBuilderConfigurationError("tenant Eve delegation is not configured");
  }
  const issuer = nonEmptyEnv("PSKILLS_EVE_TENANT_DELEGATION_ISSUER")!;
  const secret = nonEmptyEnv("PSKILLS_EVE_TENANT_DELEGATION_SECRET")!;
  const serviceIdentity = nonEmptyEnv("PSKILLS_EVE_TENANT_SERVICE_IDENTITY")!;
  return bindEveTenantService(
    createEveTenantCredentialProvider({
      issuer,
      secret,
      serviceIdentity,
      tenantId,
      service: "skill-builder",
    }),
    { tenantId, service: "skill-builder" },
  );
}

export function builderServiceToken(): string {
  const value = nonEmptyEnv("PSKILLS_BUILDER_SERVICE_TOKEN");
  if (!value || value.length > 512 || /\s/u.test(value)) {
    throw new SkillBuilderConfigurationError("PSKILLS_BUILDER_SERVICE_TOKEN is not configured");
  }
  return value;
}

export function builderEveToken(): string {
  const value = nonEmptyEnv("PSKILLS_BUILDER_EVE_API_TOKEN");
  if (!value || value.length > 512 || /\s/u.test(value)) {
    throw new SkillBuilderConfigurationError("PSKILLS_BUILDER_EVE_API_TOKEN is not configured");
  }
  return value;
}
