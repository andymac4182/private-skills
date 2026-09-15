import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const GIT_SHA = /^[0-9a-f]{40}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CONFIG_NAME = /^[A-Z][A-Z0-9_]{0,127}$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

/**
 * This is a name-only inventory for the current web, worker, identity, and
 * build adapters used by the hosted deployment. One-off restore/integration
 * settings, historical ignored aliases, dynamic credentialEnv/price aliases,
 * and the optional loopback probe inputs are deliberately excluded. The CLI
 * never prints an environment value and never reads a Vercel environment
 * export.
 */
export const EXPECTED_CONFIG_NAMES = Object.freeze([
  "PSKILLS_ENVIRONMENT",
  "PSKILLS_PUBLIC_ORIGIN",
  "PSKILLS_API_URL",
  "PSKILLS_ORGANIZATION_ID",
  "PSKILLS_ORGANIZATION_NAME",
  "PSKILLS_ORGANIZATION_SLUG",
  "PSKILLS_BETTER_AUTH_ENABLED",
  "BETTER_AUTH_ENABLED",
  "DATABASE_URL",
  "PSKILLS_DATABASE_URL",
  "BETTER_AUTH_URL",
  "BETTER_AUTH_SECRET",
  "PSKILLS_BETTER_AUTH_SECRET",
  "PSKILLS_SESSION_SECRET",
  "BETTER_AUTH_BASE_PATH",
  "PSKILLS_BETTER_AUTH_BASE_PATH",
  "BETTER_AUTH_SCHEMA",
  "PSKILLS_BETTER_AUTH_SCHEMA",
  "BETTER_AUTH_VALIDATE_SCHEMA",
  "PSKILLS_BETTER_AUTH_VALIDATE_SCHEMA",
  "BETTER_AUTH_AUTO_MIGRATE",
  "PSKILLS_BETTER_AUTH_AUTO_MIGRATE",
  "BETTER_AUTH_EMAIL_DELIVERY",
  "PSKILLS_BETTER_AUTH_EMAIL_DELIVERY",
  "BETTER_AUTH_ALLOW_ORGANIZATION_CREATE",
  "PSKILLS_BETTER_AUTH_ALLOW_ORGANIZATION_CREATE",
  "BETTER_AUTH_ORGANIZATION_LIMIT",
  "BETTER_AUTH_MEMBERSHIP_LIMIT",
  "BETTER_AUTH_INVITATION_LIMIT",
  "PSKILLS_BETTER_AUTH_ORGANIZATION_LIMIT",
  "PSKILLS_BETTER_AUTH_MEMBERSHIP_LIMIT",
  "PSKILLS_BETTER_AUTH_INVITATION_LIMIT",
  "COMPANY_SSO_AUTO_MIGRATE",
  "PSKILLS_COMPANY_SSO_AUTO_MIGRATE",
  "COMPANY_SSO_TABLE_NAME",
  "PSKILLS_COMPANY_SSO_TABLE_NAME",
  "API_TOKEN_AUTO_MIGRATE",
  "PSKILLS_API_TOKEN_AUTO_MIGRATE",
  "PSKILLS_STATE_PROVIDER",
  "PSKILLS_STATE_ENDPOINT",
  "PSKILLS_STATE_TOKEN",
  "PSKILLS_STATE_PATH",
  "PSKILLS_SINGLE_PROCESS",
  "PSKILLS_SEARCH_PROVIDER",
  "PSKILLS_EMBEDDING_MODEL",
  "PSKILLS_EMBEDDING_DIMENSIONS",
  "PSKILLS_STORAGE_PROVIDER",
  "PSKILLS_RUNTIME_PROFILE",
  "PSKILLS_STORAGE_BUILD_PROFILE",
  "PSKILLS_STORAGE_ROOT",
  "PSKILLS_STORAGE_ENDPOINT",
  "PSKILLS_STORAGE_TOKEN",
  "PSKILLS_STORAGE_BUCKET",
  "PSKILLS_STORAGE_CONTAINER",
  "PSKILLS_STORAGE_REGION",
  "AWS_REGION",
  "PSKILLS_STORAGE_PATH_STYLE",
  "PSKILLS_STORAGE_PROJECT_ID",
  "PSKILLS_STORAGE_ACCESS_KEY_ID",
  "AWS_ACCESS_KEY_ID",
  "PSKILLS_STORAGE_SECRET_ACCESS_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "PSKILLS_STORAGE_ACCOUNT_ID",
  "PSKILLS_STORAGE_ACCOUNT_NAME",
  "PSKILLS_STORAGE_ACCOUNT_KEY",
  "PSKILLS_STORAGE_CONNECTION_STRING",
  "PSKILLS_STORAGE_SAS_TOKEN",
  "PSKILLS_STORAGE_CLIENT_EMAIL",
  "PSKILLS_STORAGE_PRIVATE_KEY",
  "BLOB_READ_WRITE_TOKEN",
  "PSKILLS_BOOTSTRAP_TOKEN",
  "PSKILLS_BOOTSTRAP_TOKEN_HASH",
  "PSKILLS_BOOTSTRAP_TOKENS",
  "PSKILLS_BOOTSTRAP_TOKEN_ID",
  "PSKILLS_BOOTSTRAP_SUBJECT",
  "PSKILLS_BOOTSTRAP_ROLES",
  "PSKILLS_BOOTSTRAP_NAMESPACES",
  "PSKILLS_BOOTSTRAP_SCOPES",
  "PSKILLS_SESSION_COOKIE",
  "PSKILLS_REQUIRED_SCANNER",
  "PSKILLS_ALLOW_UNSCANNED",
  "PSKILLS_HOSTED_SKILLSGUARD",
  "PSKILLS_IMAGE_CISCO",
  "PSKILLS_IMAGE_NVIDIA",
  "PSKILLS_IMAGE_SKILLSGUARD",
  "PSKILLS_HOSTED_WORKER",
  "PSKILLS_WORKER_ID",
  "PSKILLS_WORKER_SERVICE_IDENTITY",
  "PSKILLS_WORKER_TOKEN",
  "PSKILLS_WORKER_TOKENS",
  "PSKILLS_WORKER_TOKEN_HASH",
  "PSKILLS_WORKER_TOKEN_ID",
  "PSKILLS_WORKER_ORGANIZATION_ID",
  "PSKILLS_WORKER_SUBJECT",
  "PSKILLS_WORKER_NAMESPACES",
  "PSKILLS_WORKER_SCOPES",
  "PSKILLS_WORKER_DELEGATION_SECRET",
  "PSKILLS_LEASE_SECONDS",
  "PSKILLS_POLL_INTERVAL_MS",
  "CRON_SECRET",
  "PSKILLS_EVE_API_TOKEN",
  "PSKILLS_EVE_TENANT_DELEGATION_ISSUER",
  "PSKILLS_EVE_TENANT_DELEGATION_SECRET",
  "PSKILLS_EVE_TENANT_SERVICE_IDENTITY",
  "PSKILLS_REVIEWER_TOKEN",
  "PSKILLS_REVIEWER_URL",
  "PSKILLS_REVIEW_MODEL",
  "PSKILLS_REVIEW_CRON",
  "PSKILLS_AI_GATEWAY_BASE_URL",
  "PSKILLS_AI_GATEWAY_TEAM_ID",
  "AI_GATEWAY_API_KEY",
  "PSKILLS_UPLOAD_REVIEW_ENABLED",
  "PSKILLS_UPLOAD_REVIEW_EVE_API_TOKEN",
  "PSKILLS_UPLOAD_REVIEW_GATEWAY_API_KEY",
  "PSKILLS_UPLOAD_REVIEW_GATEWAY_BASE_URL",
  "PSKILLS_UPLOAD_REVIEW_GATEWAY_TEAM_ID",
  "PSKILLS_UPLOAD_REVIEW_MODEL",
  "PSKILLS_UPLOAD_REVIEW_REVIEWER_REVISION",
  "PSKILLS_UPLOAD_REVIEWER_URL",
  "PSKILLS_UPLOAD_REVIEW_REGISTRY_API_URL",
  "PSKILLS_UPLOAD_REVIEW_REGISTRY_TOKEN",
  "PSKILLS_REGISTRY_API_URL",
  "PSKILLS_BUILDER_APP_ORIGIN",
  "PSKILLS_BUILDER_SERVICE_TOKEN",
  "PSKILLS_BUILDER_EVE_API_TOKEN",
  "PSKILLS_AI_ENABLED",
  "PSKILLS_GATEWAY_TOKEN",
  "PSKILLS_MAX_BODY_BYTES",
  "PSKILLS_SANDBOX_DRIVER",
  "PSKILLS_SANDBOX_PROVIDER",
  "PSKILLS_DOCKER_CONTEXT",
  "PSKILLS_DOCKER_HOST",
  "PSKILLS_DOCKER_HOME",
  "PSKILLS_DOCKER_CONFIG",
  "PSKILLS_DIRECTORY_ENABLED",
  "PSKILLS_PACK_DIRECTORY_ENABLED",
  "PSKILLS_DIRECTORY_GATEWAYS_JSON",
  "PSKILLS_DIRECTORY_GATEWAY_URL",
  "PSKILLS_DIRECTORY_GATEWAY_TOKEN",
  "PSKILLS_SKILLS_SH_BASE_URL",
  "PSKILLS_SOURCES_ENABLED",
  "PSKILLS_SOURCES_JSON",
  "PSKILLS_GITHUB_CUSTOM_REPOSITORIES",
  "PSKILLS_TESSL_API_TOKEN",
  "PSKILLS_TESSL_TOKEN",
  "PSKILLS_OPENCLAW_FEED_ID",
  "PSKILLS_OPENCLAW_FEED_URL",
  "PSKILLS_OPENCLAW_NAMESPACE",
  "PSKILLS_OPENCLAW_SOURCE_LOCATOR_JSON",
  "PSKILLS_OPENCLAW_SOURCE_ORIGIN",
  "PSKILLS_OPENCLAW_TRUSTED_FEED_COMPATIBILITY",
  "PSKILLS_OPENCLAW_TRUSTED_FEED_ID",
  "PSKILLS_OPENCLAW_TRUSTED_FEED_URL",
  "PSKILLS_BILLING_ENABLED",
  "PSKILLS_BILLING_PROVIDER",
  "PSKILLS_BILLING_WEBHOOK_SECRET",
  "PSKILLS_BILLING_SUCCESS_URL",
  "PSKILLS_BILLING_CANCEL_URL",
  "PSKILLS_BILLING_PORTAL_RETURN_URL",
  "STRIPE_API_BASE_URL",
  "STRIPE_API_VERSION",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "PSKILLS_GITHUB_CLIENT_ID",
  "PSKILLS_GITHUB_CLIENT_SECRET",
  "BETTER_AUTH_GITHUB_CLIENT_ID",
  "BETTER_AUTH_GITHUB_CLIENT_SECRET",
  "PSKILLS_BETTER_AUTH_GITHUB_CLIENT_ID",
  "PSKILLS_BETTER_AUTH_GITHUB_CLIENT_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "PSKILLS_GOOGLE_CLIENT_ID",
  "PSKILLS_GOOGLE_CLIENT_SECRET",
  "BETTER_AUTH_GOOGLE_CLIENT_ID",
  "BETTER_AUTH_GOOGLE_CLIENT_SECRET",
  "PSKILLS_BETTER_AUTH_GOOGLE_CLIENT_ID",
  "PSKILLS_BETTER_AUTH_GOOGLE_CLIENT_SECRET",
  "MICROSOFT_CLIENT_ID",
  "MICROSOFT_CLIENT_SECRET",
  "PSKILLS_MICROSOFT_CLIENT_ID",
  "PSKILLS_MICROSOFT_CLIENT_SECRET",
  "BETTER_AUTH_MICROSOFT_CLIENT_ID",
  "BETTER_AUTH_MICROSOFT_CLIENT_SECRET",
  "PSKILLS_BETTER_AUTH_MICROSOFT_CLIENT_ID",
  "PSKILLS_BETTER_AUTH_MICROSOFT_CLIENT_SECRET",
  "MICROSOFT_TENANT_ID",
  "MICROSOFT_AUTHORITY",
  "BETTER_AUTH_MICROSOFT_TENANT_ID",
  "BETTER_AUTH_MICROSOFT_AUTHORITY",
  "PSKILLS_BETTER_AUTH_MICROSOFT_TENANT_ID",
  "PSKILLS_BETTER_AUTH_MICROSOFT_AUTHORITY",
  "PSKILLS_OIDC_PROVIDERS_JSON",
  "PSKILLS_BETTER_AUTH_OIDC_PROVIDERS_JSON",
  "BETTER_AUTH_OIDC_PROVIDERS_JSON",
]);

/** Nonsecret values which may be supplied in a sanitized operator file. */
export const SAFE_VALUE_NAMES = Object.freeze([
  "PSKILLS_ENVIRONMENT",
  "PSKILLS_ORGANIZATION_ID",
  "PSKILLS_BETTER_AUTH_ENABLED",
  "BETTER_AUTH_ENABLED",
  "BETTER_AUTH_BASE_PATH",
  "PSKILLS_BETTER_AUTH_BASE_PATH",
  "BETTER_AUTH_SCHEMA",
  "PSKILLS_BETTER_AUTH_SCHEMA",
  "BETTER_AUTH_VALIDATE_SCHEMA",
  "PSKILLS_BETTER_AUTH_VALIDATE_SCHEMA",
  "BETTER_AUTH_AUTO_MIGRATE",
  "PSKILLS_BETTER_AUTH_AUTO_MIGRATE",
  "BETTER_AUTH_EMAIL_DELIVERY",
  "PSKILLS_BETTER_AUTH_EMAIL_DELIVERY",
  "BETTER_AUTH_ALLOW_ORGANIZATION_CREATE",
  "PSKILLS_BETTER_AUTH_ALLOW_ORGANIZATION_CREATE",
  "COMPANY_SSO_AUTO_MIGRATE",
  "PSKILLS_COMPANY_SSO_AUTO_MIGRATE",
  "API_TOKEN_AUTO_MIGRATE",
  "PSKILLS_API_TOKEN_AUTO_MIGRATE",
  "PSKILLS_STATE_PROVIDER",
  "PSKILLS_STORAGE_PROVIDER",
  "PSKILLS_STORAGE_BUILD_PROFILE",
  "COMPANY_SSO_TABLE_NAME",
  "PSKILLS_COMPANY_SSO_TABLE_NAME",
]);

const SAFE_VALUE_NAME_SET = new Set(SAFE_VALUE_NAMES);
const EXPECTED_NAME_SET = new Set(EXPECTED_CONFIG_NAMES);
const BETTER_AUTH_ENABLED_NAMES = ["PSKILLS_BETTER_AUTH_ENABLED", "BETTER_AUTH_ENABLED"];
const DATABASE_NAMES = ["DATABASE_URL"];
const BETTER_AUTH_SECRET_NAMES = ["BETTER_AUTH_SECRET", "PSKILLS_BETTER_AUTH_SECRET"];
const BETTER_AUTH_AUTO_MIGRATE_NAMES = ["PSKILLS_BETTER_AUTH_AUTO_MIGRATE", "BETTER_AUTH_AUTO_MIGRATE"];
const BETTER_AUTH_VALIDATE_SCHEMA_NAMES = ["PSKILLS_BETTER_AUTH_VALIDATE_SCHEMA", "BETTER_AUTH_VALIDATE_SCHEMA"];
const COMPANY_SSO_AUTO_MIGRATE_NAMES = ["PSKILLS_COMPANY_SSO_AUTO_MIGRATE", "COMPANY_SSO_AUTO_MIGRATE"];
const API_TOKEN_AUTO_MIGRATE_NAMES = ["PSKILLS_API_TOKEN_AUTO_MIGRATE", "API_TOKEN_AUTO_MIGRATE"];
const LEGACY_TOKEN_NAMES = ["PSKILLS_BOOTSTRAP_TOKENS", "PSKILLS_BOOTSTRAP_TOKEN", "PSKILLS_BOOTSTRAP_TOKEN_HASH"];
const PRIVATE_OBJECT_LOCATION_NAMES = ["PSKILLS_STORAGE_PROVIDER", "PSKILLS_STORAGE_ENDPOINT", "PSKILLS_STORAGE_BUCKET", "PSKILLS_STORAGE_ROOT"];
const PRIVATE_OBJECT_CREDENTIAL_NAMES = [
  "PSKILLS_STORAGE_TOKEN",
  "BLOB_READ_WRITE_TOKEN",
  "PSKILLS_STORAGE_ACCESS_KEY_ID",
  "AWS_ACCESS_KEY_ID",
  "PSKILLS_STORAGE_SECRET_ACCESS_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "PSKILLS_STORAGE_CONNECTION_STRING",
  "PSKILLS_STORAGE_CLIENT_EMAIL",
  "PSKILLS_STORAGE_ACCOUNT_KEY",
  "PSKILLS_STORAGE_SAS_TOKEN",
  "PSKILLS_STORAGE_PRIVATE_KEY",
];

export const MIGRATION_ORDER = Object.freeze([
  "fence-and-backup",
  "review-better-auth-plan",
  "apply-better-auth-schema",
  "apply-company-sso-schema-and-mirror",
  "prove-service-token-schema-compatibility",
  "read-back-registry-and-private-objects",
  "perform-explicit-owner-adoption",
  "prove-company-provider-callbacks",
  "run-two-company-request-matrix",
  "switch-traffic",
]);

const REQUIRED_BACKUP_DOMAINS = Object.freeze([
  "better-auth",
  "company-sso",
  "service-tokens",
  "billing",
  "registry",
  "objects",
]);

const REQUIRED_BETTER_AUTH_TABLES = Object.freeze([
  "user",
  "account",
  "session",
  "verification",
  "organization",
  "member",
  "invitation",
  "rateLimit",
  "ssoProvider",
]);

const CROSS_TENANT_PROOFS = Object.freeze([
  "sessionMembership",
  "activeOrganizationSwitch",
  "serviceToken",
  "ssoBinding",
  "registryMetadata",
  "sealedObject",
  "search",
  "workerJob",
]);

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const LOOPBACK_IDENTITY_PATH = "/auth/identity/config";
const LOOPBACK_PROBE_MAX_BYTES = 256 * 1024;
const LOOPBACK_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_COMPANY_SSO_TABLE = "private_skills_company_sso_providers";
const DEFAULT_SERVICE_TOKEN_TABLE = "private_skills_service_tokens";
const DEFAULT_REGISTRY_TABLE = "private_skills_registry_state";
const LIVE_PROBE_BRAND = Symbol("hosted-identity-live-probe");

export class HostedIdentityPreflightError extends Error {
  constructor(message) {
    super(message);
    this.name = "HostedIdentityPreflightError";
  }
}

function fail(message) {
  throw new HostedIdentityPreflightError(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value, field, maximum = 4_096) {
  if (typeof value !== "string" || value.trim() === "" || value.length > maximum || CONTROL_CHARACTERS.test(value)) {
    fail(`${field} is invalid`);
  }
  return value.trim();
}

function identifier(value, field) {
  const normalized = nonEmptyString(value, field, 128);
  if (!IDENTIFIER.test(normalized)) fail(`${field} is invalid`);
  return normalized;
}

function sourceRevision(value, field) {
  const normalized = nonEmptyString(value, field, 40);
  if (!GIT_SHA.test(normalized)) fail(`${field} must be a 40-character git revision`);
  return normalized;
}

function configNameSet(value) {
  if (!Array.isArray(value)) fail("configNames must be an array");
  const names = new Set();
  for (const candidate of value) {
    if (typeof candidate !== "string") continue;
    const name = candidate.trim();
    if (!CONFIG_NAME.test(name)) continue;
    if (EXPECTED_NAME_SET.has(name)) names.add(name);
  }
  return names;
}

function extractKnownConfigNames(text) {
  const names = new Set();
  for (const name of EXPECTED_CONFIG_NAMES) {
    const expression = new RegExp(`(^|[^A-Z0-9_])${name}(?=$|[^A-Z0-9_])`, "u");
    if (expression.test(text)) names.add(name);
  }
  return names;
}

/** Parse a Vercel `env ls` name inventory without retaining any row values. */
export function parseConfigNamesInventory(text) {
  if (typeof text !== "string" || text.length > 2_000_000 || CONTROL_CHARACTERS.test(text.replace(/[\n\r\t]/gu, ""))) {
    fail("config names inventory is invalid");
  }
  return extractKnownConfigNames(text);
}

function valuesFromEnvironment(environment) {
  const values = {};
  for (const name of SAFE_VALUE_NAMES) {
    const value = environment?.[name];
    if (value !== undefined) values[name] = value;
  }
  return values;
}

function validateSafeValues(value) {
  if (!isRecord(value)) fail("safeValues must be an object");
  const values = {};
  for (const [name, candidate] of Object.entries(value)) {
    if (!SAFE_VALUE_NAME_SET.has(name)) fail("safeValues contains an unsupported key");
    if (typeof candidate !== "string" || candidate.length > 4_096 || CONTROL_CHARACTERS.test(candidate)) {
      fail("safeValues contains an invalid value");
    }
    values[name] = candidate;
  }
  return values;
}

function firstValue(values, names) {
  for (const name of names) {
    if (values[name] !== undefined) return { name, value: values[name] };
  }
  return undefined;
}

function hasAnyName(names, candidates) {
  return candidates.some((candidate) => names.has(candidate));
}

function check(name, status, detail, extra = {}) {
  return { name, status, detail, ...extra };
}

function statusForBoolean(values, configuredNames, aliases, expected, checkName, detail) {
  const configured = firstValue(values, aliases.filter((name) => configuredNames.has(name)));
  if (!configured) return check(checkName, "unknown", `${detail}; safe value was not supplied`);
  const normalized = configured.value.trim().toLowerCase();
  if (!["true", "false", "1", "0", "yes", "no"].includes(normalized)) {
    return check(checkName, "blocked", `${detail}; value is not a valid boolean`);
  }
  const actual = ["true", "1", "yes"].includes(normalized);
  return actual === expected
    ? check(checkName, "pass", detail)
    : check(checkName, "blocked", `${detail}; configured state is unsafe`);
}

function statusForExactValue(values, configuredNames, aliases, expected, checkName, detail) {
  const configured = firstValue(values, aliases.filter((name) => configuredNames.has(name)));
  if (!configured) return check(checkName, "unknown", `${detail}; safe value was not supplied`);
  return configured.value.trim() === expected
    ? check(checkName, "pass", detail)
    : check(checkName, "blocked", `${detail}; configured state is unsafe`);
}

function statusForPresentNames(names, candidates, checkName, detail) {
  return hasAnyName(names, candidates)
    ? check(checkName, "pass", detail)
    : check(checkName, "blocked", `${detail}; required configuration name is absent`);
}

function evaluateSafeValuesInventory(values, names) {
  const missing = Object.keys(values).filter((name) => !names.has(name));
  return missing.length === 0
    ? check("safe-values-inventory", "pass", "safe nonsecret values belong to the discovered configuration names")
    : check("safe-values-inventory", "blocked", "safe nonsecret values must be accompanied by the matching discovered configuration names");
}

function evaluatePrivateObjectConfiguration(names) {
  const location = hasAnyName(names, PRIVATE_OBJECT_LOCATION_NAMES);
  const credential = hasAnyName(names, PRIVATE_OBJECT_CREDENTIAL_NAMES);
  if (location && credential) return check("private-object-configuration", "pass", "private object location and credential configuration names are present");
  return check("private-object-configuration", "blocked", "private object storage requires both a location and a server-side credential configuration name");
}

function allTrue(record, fields) {
  return fields.every((field) => record?.[field] === true);
}

function allFalse(record, fields) {
  return fields.every((field) => record?.[field] === false);
}

function evaluateSchemaReadback(value) {
  if (!isRecord(value)) return check("schema-readback", "unknown", "schema and migration readback was not supplied");
  if (value.status !== "ready") return check("schema-readback", value.status === "blocked" ? "blocked" : "unknown", "schema readback is not ready");
  const plan = value.migrationPlan;
  const tables = new Set(Array.isArray(plan?.tableNames) ? plan.tableNames : []);
  const planReady = plan?.reviewed === true && plan?.applied === true && typeof plan.planDigest === "string" && SHA256.test(plan.planDigest);
  const tablesReady = value.tablesReadBack === true && REQUIRED_BETTER_AUTH_TABLES.every((table) => tables.has(table));
  const ssoReady = allTrue(value.companySso, ["privateTableReadBack", "mirrorReadBack", "bindingMatch"]);
  const tokenReady = allTrue(value.serviceTokens, ["tableReadBack", "hashesPreserved", "revocationFieldsReadBack"]);
  const registryReady = allTrue(value.registry, ["tableReadBack", "stateRevisionsReadBack"]);
  const objectsReady = allTrue(value.objects, ["inventoryReadBack", "digestsVerified"]);
  if (!planReady || !tablesReady || !ssoReady || !tokenReady || !registryReady || !objectsReady) {
    return check("schema-readback", "blocked", "Better Auth, SSO mirror, service-token, registry, and object readback is incomplete");
  }
  return check("schema-readback", "pass", "reviewed migration plan and dependent schema/object readback are complete");
}

function evaluateTokenSchemaCompatibility(value) {
  if (!isRecord(value) || !isRecord(value.serviceTokens)) {
    return check("b27-token-schema-compatibility", "unknown", "B27 requires an explicit token-schema compatibility readback");
  }
  const token = value.serviceTokens;
  const schema = value.betterAuthSchema ?? "";
  const tableSchema = token.tableSchema;
  const tableName = token.tableName;
  if (token.schemaCompatibility === "held") {
    return check("b27-token-schema-compatibility", "blocked", "B27 remains held; custom Better Auth schema may move existing token lookup");
  }
  if (token.schemaCompatibility !== "passed") {
    return check("b27-token-schema-compatibility", "unknown", "B27 requires reviewed data-preserving token lookup compatibility");
  }
  if (typeof tableSchema !== "string" || typeof tableName !== "string") {
    return check("b27-token-schema-compatibility", "blocked", "B27 readback must name the token table location without exporting credentials");
  }
  if (tableName !== "private_skills_service_tokens") {
    return check("b27-token-schema-compatibility", "blocked", "B27 requires the existing service-token table location to remain explicit");
  }
  if (schema !== "" && schema !== "public" && tableSchema === schema) {
    return check("b27-token-schema-compatibility", "blocked", "B27 does not permit moving existing service tokens into the Better Auth schema without a reviewed migration");
  }
  return check("b27-token-schema-compatibility", "pass", "service-token table location and lookup compatibility are explicitly reviewed");
}

function evaluateAdoption(value, organizationId) {
  if (!isRecord(value)) return check("explicit-default-organization-adoption", "unknown", "sanitized owner-adoption readback was not supplied");
  if (value.status !== "passed") return check("explicit-default-organization-adoption", value.status === "blocked" ? "blocked" : "unknown", "explicit owner adoption has not passed");
  if (value.organizationId !== organizationId) return check("explicit-default-organization-adoption", "blocked", "adoption evidence does not match the server-configured default organization");
  const required = ["authenticatedBetterAuthUser", "emailVerified", "ownerProofVerified", "membershipBound", "atomic", "markerRecorded", "replaySafe"];
  const prohibited = ["implicitSocialAdoption", "emailDomainInference", "browserHeaderSelection", "firstUserInference"];
  if (!allTrue(value, required) || !allFalse(value, prohibited) || value.selectionSource !== "server-configured") {
    return check("explicit-default-organization-adoption", "blocked", "adoption must use a verified Better Auth user, separate owner proof, live membership, and server-configured organization selection");
  }
  return check("explicit-default-organization-adoption", "pass", "default organization is bound only by the explicit owner-authenticated operation");
}

function evaluateBackup(value) {
  if (!isRecord(value)) return check("backup-readiness", "unknown", "sanitized backup readiness manifest was not supplied");
  const domains = new Set(Array.isArray(value.domains) ? value.domains : []);
  if (value.status !== "ready" || !REQUIRED_BACKUP_DOMAINS.every((domain) => domains.has(domain))) {
    return check("backup-readiness", value.status === "blocked" ? "blocked" : "unknown", "one consistent encrypted recovery point must cover identity, SSO, tokens, billing, registry, and objects");
  }
  if (!allTrue(value, ["consistentSnapshot", "fenceActive", "encrypted", "secretValuesExcluded", "objectDigestsVerified", "legacyAccessPreserved"])) {
    return check("backup-readiness", "blocked", "backup readiness lacks a consistency fence, secret exclusion, object digest, or legacy-access assertion");
  }
  return check("backup-readiness", "pass", "complete encrypted backup manifest covers every durable tenant boundary and preserves legacy access");
}

function evaluateRollback(value) {
  if (!isRecord(value)) return check("rollback-preserves-legacy-access", "unknown", "sanitized rollback evidence was not supplied");
  if (value.status !== "ready") return check("rollback-preserves-legacy-access", value.status === "blocked" ? "blocked" : "unknown", "rollback plan is not ready");
  const required = ["previousDeploymentAvailable", "legacyPathRetained", "legacySmokePassed", "legacyAccessPreserved", "additiveSchemaOnly", "noDownMigration", "forwardFixAllowed", "fenceReleaseBlockedUntilMatrix"];
  if (!allTrue(value, required)) return check("rollback-preserves-legacy-access", "blocked", "rollback must retain the previous deployment and legacy token path and use forward fixes for populated schemas");
  return check("rollback-preserves-legacy-access", "pass", "legacy bearer/session access remains available while rollback stays forward-compatible");
}

function evaluateTwoCompany(value) {
  if (!isRecord(value)) return check("two-company-hosted-identity-matrix", "unknown", "post-credential two-company evidence was not supplied");
  if (value.status !== "passed") return check("two-company-hosted-identity-matrix", value.status === "blocked" ? "blocked" : "unknown", "two-company hosted identity proof is pending");
  const companyCount = value.companyCount === 2;
  const companyChecks = Array.isArray(value.companies) && value.companies.length === 2
    && value.companies.every((company) => allTrue(company, ["sessionMembership", "activeOrganization", "serviceToken", "ssoBinding", "registryMetadata", "sealedObject", "search", "workerJob"]));
  const denialChecks = allTrue(value.crossTenantDenials, CROSS_TENANT_PROOFS);
  if (!companyCount || !companyChecks || !denialChecks || value.sameDisplayNameFixture !== true || value.providerCallbacks !== true || value.legacyFallback !== true || value.recordedWithoutSecrets !== true) {
    return check("two-company-hosted-identity-matrix", "blocked", "each company must pass session, membership, token, SSO, registry, object, search, and worker isolation with cross-tenant denials");
  }
  return check("two-company-hosted-identity-matrix", "pass", "two companies completed the hosted identity and cross-tenant isolation matrix");
}

function migrationOrderCheck() {
  return check("migration-order", "pass", "migration order is fixed: Better Auth, SSO mirror, B27 token compatibility, registry/objects, adoption, callbacks, two-company proof, traffic");
}

function evaluateSourceRevision(sourceSha, expectedSourceSha) {
  if (sourceSha === undefined) return check("source-revision", "unknown", "source revision could not be recorded");
  if (expectedSourceSha !== undefined && sourceSha !== expectedSourceSha) {
    return check("source-revision", "blocked", "source revision does not match the operator-selected reviewed revision");
  }
  return check("source-revision", "pass", expectedSourceSha === undefined ? "source revision recorded without an expected comparison" : "source revision matches the operator-selected reviewed revision");
}

function liveResult(name, status, detail, extra = {}) {
  return Object.freeze({ [LIVE_PROBE_BRAND]: true, name, status, detail, ...extra });
}

function evaluateVerifiedLiveResult(value, checkName, kind, missingDetail) {
  if (!isRecord(value)) return check(checkName, "unknown", missingDetail);
  if (value.status === "blocked") return check(checkName, "blocked", `${missingDetail}; live probe was blocked`);
  if (value[LIVE_PROBE_BRAND] !== true || value.status !== "pass" || value.verified !== true || value.kind !== kind) {
    return check(checkName, "blocked", `${missingDetail}; live verification did not complete with the expected probe`);
  }
  const observed = kind === "git-rev-parse"
    ? typeof value.actualSourceSha === "string" && GIT_SHA.test(value.actualSourceSha)
    : kind === "loopback-postgres-read-only"
      ? Number.isSafeInteger(value.expectedTableCount) && value.expectedTableCount > 0
        && value.observedTableCount === value.expectedTableCount
      : kind === "loopback-http-public-identity-config"
        ? Number.isSafeInteger(value.providerCount) && value.providerCount >= 0
        : false;
  if (!observed) return check(checkName, "blocked", `${missingDetail}; live probe did not include bounded observed results`);
  return check(checkName, "pass", "read-only live probe passed");
}

function evaluateVerifiedLiveChecks(value) {
  const checks = [
    evaluateVerifiedLiveResult(
      value?.sourceRevision,
      "local-git-source-revision",
      "git-rev-parse",
      "the local checkout revision was not verified with git rev-parse",
    ),
  ];
  if (value?.loopbackPostgres !== undefined) {
    checks.push(evaluateVerifiedLiveResult(
      value.loopbackPostgres,
      "loopback-postgres-schema-readback",
      "loopback-postgres-read-only",
      "the opt-in loopback PostgreSQL schema/readback probe did not complete",
    ));
  } else {
    checks.push(check("loopback-postgres-schema-readback", "skip", "no loopback PostgreSQL probe was requested; hosted database was not contacted"));
  }
  if (value?.publicIdentityConfig !== undefined) {
    checks.push(evaluateVerifiedLiveResult(
      value.publicIdentityConfig,
      "loopback-public-identity-config",
      "loopback-http-public-identity-config",
      "the opt-in loopback public identity-config probe did not complete",
    ));
  } else {
    checks.push(check("loopback-public-identity-config", "skip", "no loopback public identity-config probe was requested; hosted HTTP was not contacted"));
  }
  const blockers = checks.filter(({ status }) => status === "blocked" || status === "unknown");
  return {
    ready: blockers.length === 0,
    checks,
    blockers: blockers.map(({ name, status, detail }) => ({ name, status, detail })),
  };
}

/**
 * Evaluate a sanitized hosted identity input. This function performs no I/O,
 * network call, database operation, migration, provider callback, or mutation.
 */
export function evaluateHostedIdentityPreflight(input = {}) {
  if (!isRecord(input)) fail("preflight input must be an object");
  const environment = isRecord(input.environment) ? input.environment : {};
  const names = configNameSet(environment.configNames ?? []);
  const values = validateSafeValues(environment.safeValues ?? {});
  const expectedSourceSha = input.expectedSourceSha === undefined ? undefined : sourceRevision(input.expectedSourceSha, "expectedSourceSha");
  const sourceSha = input.sourceSha === undefined ? undefined : sourceRevision(input.sourceSha, "sourceSha");
  const liveSourceSha = input.liveSourceSha ?? input.liveChecks?.sourceRevision?.actualSourceSha;
  const organizationId = identifier(input.defaultOrganizationId ?? values.PSKILLS_ORGANIZATION_ID ?? "default", "defaultOrganizationId");
  const production = environment.name === "production";
  const evidenceChecks = [
    evaluateSourceRevision(sourceSha, expectedSourceSha),
    check("production-context", production ? "pass" : "blocked", "preflight is scoped to the hosted production environment"),
    evaluateSafeValuesInventory(values, names),
    statusForPresentNames(names, LEGACY_TOKEN_NAMES, "legacy-access-configuration", "legacy bootstrap token configuration is present"),
    statusForPresentNames(names, ["PSKILLS_SESSION_SECRET"], "legacy-session-configuration", "legacy session signing secret configuration is present"),
    statusForBoolean(values, names, BETTER_AUTH_ENABLED_NAMES, true, "better-auth-enabled", "Better Auth is explicitly enabled for the reviewed activation"),
    statusForPresentNames(names, ["BETTER_AUTH_URL", "PSKILLS_PUBLIC_ORIGIN"], "canonical-origin-configuration", "canonical hosted origin configuration is present for callbacks and cookie origin checks"),
    statusForPresentNames(names, DATABASE_NAMES, "better-auth-database-configuration", "Better Auth database configuration is present"),
    statusForPresentNames(names, BETTER_AUTH_SECRET_NAMES, "better-auth-secret-configuration", "dedicated Better Auth secret configuration is present"),
    statusForBoolean(values, names, BETTER_AUTH_AUTO_MIGRATE_NAMES, false, "better-auth-explicit-migration", "Better Auth startup auto-migration is explicitly disabled for multi-instance production"),
    statusForBoolean(values, names, BETTER_AUTH_VALIDATE_SCHEMA_NAMES, true, "better-auth-schema-validation", "Better Auth schema validation is explicitly enabled"),
    statusForBoolean(values, names, COMPANY_SSO_AUTO_MIGRATE_NAMES, false, "company-sso-explicit-migration", "company SSO startup auto-migration is explicitly disabled"),
    statusForBoolean(values, names, API_TOKEN_AUTO_MIGRATE_NAMES, false, "service-token-explicit-migration", "service-token startup auto-migration is explicitly disabled"),
    statusForExactValue(values, names, ["PSKILLS_STATE_PROVIDER"], "postgres", "node-state-boundary", "shared hosted identity and registry state must use the durable PostgreSQL Node boundary"),
    evaluatePrivateObjectConfiguration(names),
    evaluateSchemaReadback(input.schemaReadback),
    evaluateTokenSchemaCompatibility(input.schemaReadback),
    evaluateAdoption(input.adoption, organizationId),
    evaluateBackup(input.backup),
    evaluateRollback(input.rollback),
    evaluateTwoCompany(input.twoCompany),
    migrationOrderCheck(),
  ];
  const evidenceBlockers = evidenceChecks.filter(({ status }) => status === "blocked" || status === "unknown");
  const verifiedLiveChecks = evaluateVerifiedLiveChecks(input.liveChecks);
  const checks = [...evidenceChecks, ...verifiedLiveChecks.checks];
  const blockers = [...evidenceBlockers, ...verifiedLiveChecks.blockers];
  return Object.freeze({
    schemaVersion: "hosted-identity-preflight-v1",
    readOnly: true,
    sourceSha: sourceSha ?? null,
    expectedSourceSha: expectedSourceSha ?? null,
    liveSourceSha: typeof liveSourceSha === "string" && GIT_SHA.test(liveSourceSha) ? liveSourceSha : null,
    environment: environment.name ?? null,
    configuredNames: [...names].sort(),
    configuredNameValuesPrinted: false,
    migrationOrder: [...MIGRATION_ORDER],
    ready: evidenceBlockers.length === 0 && verifiedLiveChecks.ready,
    checks,
    blockers: blockers.map(({ name, status, detail }) => ({ name, status, detail })),
    validatedEvidence: {
      ready: evidenceBlockers.length === 0,
      checks: evidenceChecks,
      blockers: evidenceBlockers.map(({ name, status, detail }) => ({ name, status, detail })),
    },
    verifiedLiveChecks,
    externalInputs: [
      "production configuration name inventory and safe nonsecret flags",
      "reviewed Better Auth migration plan and schema readback",
      "explicit owner-adoption readback for the configured default organization",
      "complete encrypted backup manifest and active availability fence",
      "previous deployment and legacy-access rollback evidence",
      "two-company provider accounts and hosted Request matrix after credentials are configured",
      "local checkout revision verified by git rev-parse; optional loopback-only PostgreSQL and public identity-config probes",
    ],
    limitations: [
      "read-only local evaluation; no Vercel environment export, production database connection, DDL, provider callback, adoption mutation, or deployment",
      "configuration names prove presence only; safe flag values must be supplied separately and secret values are never accepted",
      "attested evidence is reported separately from verified live checks; evidence alone can never make ready true",
      "B27 remains a release blocker until the service-token table location and lookup compatibility are explicitly proven",
      "two-company proof is required after real provider credentials and isolated test accounts are configured",
      "PostgreSQL and public identity-config probes are optional and refuse non-loopback targets; omitted probes are marked skip",
    ],
  });
}

async function readJson(path, label) {
  let text;
  try {
    text = await readFile(resolve(path), "utf8");
  } catch {
    fail(`${label} could not be read`);
  }
  if (text.length > 2_000_000) fail(`${label} is too large`);
  try {
    return JSON.parse(text);
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

async function readConfigNames(path) {
  let text;
  try {
    text = await readFile(resolve(path), "utf8");
  } catch {
    fail("config names inventory could not be read");
  }
  return [...parseConfigNamesInventory(text)];
}

function currentSourceSha(root = REPOSITORY_ROOT) {
  try {
    const output = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return GIT_SHA.test(output) ? output : undefined;
  } catch {
    return undefined;
  }
}

function currentTrackedChanges(root = REPOSITORY_ROOT) {
  try {
    return execFileSync("git", ["-C", root, "status", "--porcelain=v1", "--untracked-files=no"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

function isLoopbackHostname(hostname) {
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

function safeSchemaName(value, fallback = "public") {
  const candidate = typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
  return /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(candidate) ? candidate : undefined;
}

function safeTableName(value, fallback) {
  const candidate = typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
  return /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(candidate) ? candidate : undefined;
}

function parseLoopbackDatabaseUrl(value) {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") return undefined;
    if (!isLoopbackHostname(parsed.hostname)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function parseLoopbackIdentityConfigUrl(value) {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    if (!isLoopbackHostname(parsed.hostname) || parsed.pathname !== LOOPBACK_IDENTITY_PATH || parsed.search !== "" || parsed.hash !== "") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Verify the checkout revision with the local Git executable. The returned
 * object is intentionally marked as a live probe; callers must not replace it
 * with a manually asserted `{ status: 'pass' }` object.
 */
export function verifyLocalGitSource({ root = REPOSITORY_ROOT, expectedSourceSha, selectedSourceSha } = {}) {
  const target = expectedSourceSha ?? selectedSourceSha;
  if (target !== undefined && (typeof target !== "string" || !GIT_SHA.test(target))) {
    return liveResult("local-git-source-revision", "blocked", "the selected source revision is not a valid git revision", {
      kind: "git-rev-parse",
      verified: false,
    });
  }
  const actualSourceSha = currentSourceSha(root);
  if (actualSourceSha === undefined) {
    return liveResult("local-git-source-revision", "unknown", "git rev-parse could not verify the local checkout revision", {
      kind: "git-rev-parse",
      verified: false,
    });
  }
  const trackedChanges = currentTrackedChanges(root);
  if (trackedChanges === undefined) {
    return liveResult("local-git-source-revision", "unknown", "git status could not verify that tracked source files are unchanged", {
      kind: "git-rev-parse",
      verified: false,
      actualSourceSha,
    });
  }
  if (trackedChanges.trim() !== "") {
    return liveResult("local-git-source-revision", "blocked", "the checkout has tracked source changes; use a clean reviewed revision for the change window", {
      kind: "git-rev-parse",
      verified: true,
      actualSourceSha,
    });
  }
  if (target !== undefined && actualSourceSha !== target) {
    return liveResult("local-git-source-revision", "blocked", "the local checkout revision does not match the selected deployment revision", {
      kind: "git-rev-parse",
      verified: true,
      actualSourceSha,
    });
  }
  return liveResult("local-git-source-revision", "pass", target === undefined
    ? "git rev-parse verified the local checkout revision"
    : "git rev-parse verified the local checkout matches the selected deployment revision", {
    kind: "git-rev-parse",
    verified: true,
    actualSourceSha,
  });
}

/**
 * Connect only to a loopback PostgreSQL URL and read information_schema. No
 * application rows, credentials, or query results are emitted. The postgres
 * client is loaded lazily so the normal hosted preflight remains portable and
 * does not eagerly pull a Node database dependency into Nitro/edge builds.
 */
export async function probeLoopbackPostgres(databaseUrl, { betterAuthSchema = "public", companySsoTableName = DEFAULT_COMPANY_SSO_TABLE } = {}) {
  const parsed = parseLoopbackDatabaseUrl(databaseUrl);
  const schema = safeSchemaName(betterAuthSchema);
  const ssoTable = safeTableName(companySsoTableName, DEFAULT_COMPANY_SSO_TABLE);
  if (!parsed || !schema || !ssoTable) {
    return liveResult("loopback-postgres-schema-readback", "blocked", "PostgreSQL probe requires a valid loopback URL and bounded schema/table names", {
      kind: "loopback-postgres-read-only",
      verified: false,
    });
  }

  let postgres;
  try {
    const module = await import("postgres");
    postgres = module.default;
  } catch {
    return liveResult("loopback-postgres-schema-readback", "blocked", "the optional loopback PostgreSQL probe could not load the Node postgres client", {
      kind: "loopback-postgres-read-only",
      verified: false,
    });
  }

  let sql;
  try {
    // Use the original URL only as an in-process client input. It is never
    // placed in a report, error, or child-process argument.
    sql = postgres(parsed.toString(), {
      max: 1,
      prepare: false,
      connect_timeout: Math.ceil(LOOPBACK_PROBE_TIMEOUT_MS / 1_000),
      idle_timeout: Math.ceil(LOOPBACK_PROBE_TIMEOUT_MS / 1_000),
    });
    const identityTables = [...REQUIRED_BETTER_AUTH_TABLES, ssoTable];
    const identityRows = await sql`
      SELECT table_name AS "tableName", table_type AS "tableType"
      FROM information_schema.tables
      WHERE table_schema = ${schema}
        AND table_name = ANY(${sql.array(identityTables)})
    `;
    const publicRows = await sql`
      SELECT table_name AS "tableName", table_type AS "tableType"
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY(${sql.array([DEFAULT_SERVICE_TOKEN_TABLE, DEFAULT_REGISTRY_TABLE])})
    `;
    const identityFound = new Set(identityRows.filter((row) => row.tableType === "BASE TABLE").map((row) => row.tableName));
    const publicFound = new Set(publicRows.filter((row) => row.tableType === "BASE TABLE").map((row) => row.tableName));
    const missingIdentity = identityTables.filter((tableName) => !identityFound.has(tableName));
    const missingPublic = [DEFAULT_SERVICE_TOKEN_TABLE, DEFAULT_REGISTRY_TABLE].filter((tableName) => !publicFound.has(tableName));
    if (missingIdentity.length > 0 || missingPublic.length > 0) {
      return liveResult("loopback-postgres-schema-readback", "blocked", "loopback PostgreSQL is reachable but the required identity, SSO, token, or registry tables are missing", {
        kind: "loopback-postgres-read-only",
        verified: true,
        expectedTableCount: identityTables.length + 2,
        observedTableCount: identityFound.size + publicFound.size,
      });
    }
    return liveResult("loopback-postgres-schema-readback", "pass", "loopback PostgreSQL connection and required schema table readback passed", {
      kind: "loopback-postgres-read-only",
      verified: true,
      expectedTableCount: identityTables.length + 2,
      observedTableCount: identityFound.size + publicFound.size,
    });
  } catch {
    return liveResult("loopback-postgres-schema-readback", "blocked", "loopback PostgreSQL schema/readback failed without exposing database details", {
      kind: "loopback-postgres-read-only",
      verified: false,
    });
  } finally {
    try {
      await sql?.end({ timeout: 1 });
    } catch {
      // Closing an already failed read-only client does not change the gate.
    }
  }
}

async function readBoundedResponseText(response) {
  if (!response.body) {
    const text = await response.text();
    return text.length > LOOPBACK_PROBE_MAX_BYTES ? undefined : text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > LOOPBACK_PROBE_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Read the browser-safe identity config from an explicitly loopback server. */
export async function probeLoopbackIdentityConfig(identityConfigUrl) {
  const parsed = parseLoopbackIdentityConfigUrl(identityConfigUrl);
  if (!parsed) {
    return liveResult("loopback-public-identity-config", "blocked", "public identity-config probe requires the exact loopback /auth/identity/config path", {
      kind: "loopback-http-public-identity-config",
      verified: false,
    });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOOPBACK_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(parsed, {
      method: "GET",
      redirect: "error",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      return liveResult("loopback-public-identity-config", "blocked", "loopback public identity-config returned a non-success status", {
        kind: "loopback-http-public-identity-config",
        verified: true,
      });
    }
    const text = await readBoundedResponseText(response);
    if (text === undefined) {
      return liveResult("loopback-public-identity-config", "blocked", "loopback public identity-config response exceeded the bounded probe size", {
        kind: "loopback-http-public-identity-config",
        verified: true,
      });
    }
    let config;
    try {
      config = JSON.parse(text);
    } catch {
      return liveResult("loopback-public-identity-config", "blocked", "loopback public identity-config was not JSON", {
        kind: "loopback-http-public-identity-config",
        verified: true,
      });
    }
    const valid = isRecord(config)
      && config.enabled === true
      && typeof config.basePath === "string"
      && Array.isArray(config.providers)
      && isRecord(config.organization)
      && config.organization.enabled === true
      && isRecord(config.bootstrap)
      && config.bootstrap.requiresExplicitOwnerClaim === true
      && config.bootstrap.implicitSocialTenantAdoption === false;
    if (!valid) {
      return liveResult("loopback-public-identity-config", "blocked", "loopback public identity-config did not advertise the required enabled and explicit-adoption contract", {
        kind: "loopback-http-public-identity-config",
        verified: true,
      });
    }
    return liveResult("loopback-public-identity-config", "pass", "loopback public identity-config returned the enabled explicit-adoption contract", {
      kind: "loopback-http-public-identity-config",
      verified: true,
      providerCount: config.providers.length,
    });
  } catch {
    return liveResult("loopback-public-identity-config", "blocked", "loopback public identity-config probe failed without exposing response details", {
      kind: "loopback-http-public-identity-config",
      verified: false,
    });
  } finally {
    clearTimeout(timeout);
  }
}

/** Run the actual local checks used by the CLI before evaluating attestations. */
export async function collectLiveChecks({ root = REPOSITORY_ROOT, expectedSourceSha, selectedSourceSha, environment = {}, safeValues = {} } = {}) {
  const checks = {
    sourceRevision: verifyLocalGitSource({ root, expectedSourceSha, selectedSourceSha }),
  };
  if (environment.PSKILLS_PREFLIGHT_LOOPBACK_DATABASE_URL !== undefined) {
    checks.loopbackPostgres = await probeLoopbackPostgres(environment.PSKILLS_PREFLIGHT_LOOPBACK_DATABASE_URL, {
      betterAuthSchema: safeValues.PSKILLS_BETTER_AUTH_SCHEMA ?? safeValues.BETTER_AUTH_SCHEMA ?? "public",
      companySsoTableName: safeValues.PSKILLS_COMPANY_SSO_TABLE_NAME ?? safeValues.COMPANY_SSO_TABLE_NAME ?? DEFAULT_COMPANY_SSO_TABLE,
    });
  }
  if (environment.PSKILLS_PREFLIGHT_LOOPBACK_IDENTITY_CONFIG_URL !== undefined) {
    checks.publicIdentityConfig = await probeLoopbackIdentityConfig(environment.PSKILLS_PREFLIGHT_LOOPBACK_IDENTITY_CONFIG_URL);
  }
  return checks;
}

function parseArgumentValue(argv, index, flag) {
  const value = argv[index + 1];
  if (typeof value !== "string" || value === "" || value.startsWith("--")) fail(`${flag} requires an explicit value`);
  return value;
}

function parseArguments(argv) {
  const options = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      options.json = true;
    } else if (argument === "--config-names-file") {
      options.configNamesFile = parseArgumentValue(argv, index, argument);
      index += 1;
    } else if (argument === "--safe-values-file") {
      options.safeValuesFile = parseArgumentValue(argv, index, argument);
      index += 1;
    } else if (argument === "--evidence-file") {
      options.evidenceFile = parseArgumentValue(argv, index, argument);
      index += 1;
    } else if (argument === "--source-sha") {
      options.sourceSha = parseArgumentValue(argv, index, argument);
      index += 1;
    } else if (argument === "--expected-source-sha") {
      options.expectedSourceSha = parseArgumentValue(argv, index, argument);
      index += 1;
    } else if (argument === "--organization-id") {
      options.organizationId = parseArgumentValue(argv, index, argument);
      index += 1;
    } else if (argument === "--environment") {
      options.environmentName = parseArgumentValue(argv, index, argument);
      index += 1;
    } else {
      fail("unsupported preflight option");
    }
  }
  return options;
}

function printHuman(report) {
  for (const result of report.checks) process.stdout.write(`${result.status.toUpperCase()} ${result.name}: ${result.detail}\n`);
  process.stdout.write(`hosted-identity-preflight: ${report.ready ? "READY" : "BLOCKED"}\n`);
  for (const limitation of report.limitations) process.stdout.write(`LIMITATION ${limitation}\n`);
}

async function main(argv = process.argv.slice(2), environment = process.env) {
  const options = parseArguments(argv);
  const configNames = options.configNamesFile
    ? await readConfigNames(options.configNamesFile)
    : Object.keys(environment);
  const unvalidatedSafeValues = options.safeValuesFile
    ? await readJson(options.safeValuesFile, "safe values")
    : valuesFromEnvironment(environment);
  const safeValues = validateSafeValues(unvalidatedSafeValues);
  const evidence = options.evidenceFile ? await readJson(options.evidenceFile, "evidence") : {};
  const sourceSha = options.sourceSha === undefined ? undefined : sourceRevision(options.sourceSha, "sourceSha");
  const expectedSourceSha = options.expectedSourceSha === undefined
    ? undefined
    : sourceRevision(options.expectedSourceSha, "expectedSourceSha");
  const liveChecks = await collectLiveChecks({
    root: REPOSITORY_ROOT,
    expectedSourceSha,
    selectedSourceSha: sourceSha,
    environment,
    safeValues,
  });
  const report = evaluateHostedIdentityPreflight({
    ...(sourceSha === undefined ? {} : { sourceSha }),
    ...(expectedSourceSha === undefined ? {} : { expectedSourceSha }),
    liveSourceSha: liveChecks.sourceRevision.actualSourceSha,
    liveChecks,
    defaultOrganizationId: options.organizationId ?? safeValues?.PSKILLS_ORGANIZATION_ID ?? "default",
    environment: {
      name: options.environmentName ?? safeValues?.PSKILLS_ENVIRONMENT ?? "production",
      configNames,
      safeValues,
    },
    ...(isRecord(evidence) ? evidence : {}),
  });
  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else printHuman(report);
  return report.ready ? 0 : 2;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = await main();
  } catch (error) {
    if (error instanceof HostedIdentityPreflightError) {
      process.stderr.write(`hosted-identity-preflight: ${error.message}\n`);
    } else {
      process.stderr.write("hosted-identity-preflight: input failed\n");
    }
    process.exitCode = 1;
  }
}
