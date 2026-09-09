import { createGateway, type LanguageModel } from "ai";

const DEFAULT_REVIEW_MODEL = "openai/gpt-5.6-luna";
const DEFAULT_REVIEW_CRON = "0 22 * * *";

const MODEL_ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const REVIEW_ENDPOINTS = new Set([
  "/internal/reviewer/prepare",
  "/internal/reviewer/complete",
]);

export function reviewModel(): string {
  const value = process.env.PSKILLS_REVIEW_MODEL?.trim() || DEFAULT_REVIEW_MODEL;
  if (!MODEL_ID.test(value)) {
    throw new Error("PSKILLS_REVIEW_MODEL must be a provider/model identifier");
  }
  return value;
}

/**
 * Return a model handle for Eve's `step.started` dynamic-model event.
 *
 * Eve requires session/turn dynamic selections to be serializable model IDs,
 * but it explicitly permits a live AI SDK LanguageModel at step scope. That
 * is the scope used here so a deployment can point the Gateway at a controlled
 * base URL while still using the standard AI_GATEWAY_API_KEY or Vercel OIDC
 * credential resolution in @ai-sdk/gateway.
 */
export function reviewLanguageModel(): LanguageModel {
  const configuredBase = process.env.PSKILLS_AI_GATEWAY_BASE_URL?.trim();
  const baseURL = configuredBase ? gatewayBaseUrl(configuredBase) : undefined;
  const apiKey = process.env.AI_GATEWAY_API_KEY?.trim() || undefined;
  const teamIdOrSlug = process.env.PSKILLS_AI_GATEWAY_TEAM_ID?.trim() || undefined;

  const gateway = createGateway({
    ...(baseURL ? { baseURL } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(teamIdOrSlug ? { teamIdOrSlug } : {}),
  });
  return gateway.languageModel(reviewModel());
}

function gatewayBaseUrl(value: string): string {
  const base = new URL(value);
  if (base.username || base.password || base.search || base.hash) {
    throw new Error("PSKILLS_AI_GATEWAY_BASE_URL must not contain credentials or query data");
  }
  const isDevelopment = process.env.NODE_ENV !== "production" && process.env.VERCEL_ENV !== "production";
  if (base.protocol !== "https:" && !(base.protocol === "http:" && isDevelopment && LOOPBACK_HOSTS.has(base.hostname))) {
    throw new Error("PSKILLS_AI_GATEWAY_BASE_URL must use HTTPS outside loopback development");
  }
  return base.toString().replace(/\/+$/u, "");
}

export function reviewCron(): string {
  const value = process.env.PSKILLS_REVIEW_CRON?.trim() || DEFAULT_REVIEW_CRON;
  const fields = value.split(/\s+/u);
  if (fields.length !== 5 || fields.some((field) => field.length === 0 || /[\r\n]/u.test(field))) {
    throw new Error("PSKILLS_REVIEW_CRON must be a five-field UTC cron expression");
  }
  return value;
}

export function dailyReviewIdempotencyKey(now = new Date()): string {
  return `common-skill-review:${now.toISOString().slice(0, 10)}`;
}

export function registryEndpoint(path: string): URL {
  if (!REVIEW_ENDPOINTS.has(path)) throw new Error("Unsupported reviewer endpoint");
  const configured = process.env.PSKILLS_REGISTRY_API_URL?.trim();
  if (!configured) throw new Error("PSKILLS_REGISTRY_API_URL is not configured");

  const base = new URL(configured);
  if (base.username || base.password || base.search || base.hash) {
    throw new Error("PSKILLS_REGISTRY_API_URL must not contain credentials or query data");
  }
  const isDevelopment = process.env.NODE_ENV !== "production" && process.env.VERCEL_ENV !== "production";
  if (base.protocol !== "https:" && !(base.protocol === "http:" && isDevelopment && LOOPBACK_HOSTS.has(base.hostname))) {
    throw new Error("PSKILLS_REGISTRY_API_URL must use HTTPS outside loopback development");
  }

  const prefix = base.pathname.replace(/\/+$/u, "");
  base.pathname = `${prefix}${path}`;
  return base;
}

export function reviewerToken(): string {
  const token = process.env.PSKILLS_REVIEWER_TOKEN?.trim();
  if (!token) throw new Error("PSKILLS_REVIEWER_TOKEN is not configured");
  if (token.length > 512 || /\s/u.test(token)) {
    throw new Error("PSKILLS_REVIEWER_TOKEN must be a bounded bearer token");
  }
  return token;
}
