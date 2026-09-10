import { createGateway, type LanguageModel } from 'ai';

const DEFAULT_UPLOAD_REVIEW_MODEL = 'openai/gpt-5.6-luna';
const MODEL_ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/iu;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const UPLOAD_REVIEW_ENDPOINTS = new Set([
  '/internal/upload-review/prepare',
  '/internal/upload-review/complete',
  '/internal/upload-review/fail',
]);

export function uploadReviewModel(): string {
  const value = process.env.PSKILLS_UPLOAD_REVIEW_MODEL?.trim() || DEFAULT_UPLOAD_REVIEW_MODEL;
  if (!MODEL_ID.test(value)) throw new Error('PSKILLS_UPLOAD_REVIEW_MODEL must be a provider/model identifier');
  return value;
}

export function uploadReviewLanguageModel(): LanguageModel {
  const configuredBase = process.env.PSKILLS_UPLOAD_REVIEW_GATEWAY_BASE_URL?.trim();
  const baseURL = configuredBase ? gatewayBaseUrl(configuredBase) : undefined;
  const apiKey = process.env.PSKILLS_UPLOAD_REVIEW_GATEWAY_API_KEY?.trim() || undefined;
  const teamIdOrSlug = process.env.PSKILLS_UPLOAD_REVIEW_GATEWAY_TEAM_ID?.trim() || undefined;
  const gateway = createGateway({
    ...(baseURL ? { baseURL } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(teamIdOrSlug ? { teamIdOrSlug } : {}),
  });
  return gateway.languageModel(uploadReviewModel());
}

function gatewayBaseUrl(value: string): string {
  const base = new URL(value);
  if (base.username || base.password || base.search || base.hash) throw new Error('PSKILLS_UPLOAD_REVIEW_GATEWAY_BASE_URL must not contain credentials or query data');
  const local = process.env.NODE_ENV !== 'production' && process.env.VERCEL_ENV !== 'production';
  if (base.protocol !== 'https:' && !(local && base.protocol === 'http:' && LOOPBACK_HOSTS.has(base.hostname))) {
    throw new Error('PSKILLS_UPLOAD_REVIEW_GATEWAY_BASE_URL must use HTTPS outside loopback development');
  }
  return base.toString().replace(/\/+$/u, '');
}

export function registryEndpoint(path: string): URL {
  if (!UPLOAD_REVIEW_ENDPOINTS.has(path)) throw new Error('Unsupported upload-review endpoint');
  const configured = process.env.PSKILLS_UPLOAD_REVIEW_REGISTRY_API_URL?.trim();
  if (!configured) throw new Error('PSKILLS_UPLOAD_REVIEW_REGISTRY_API_URL is not configured');
  const base = new URL(configured);
  if (base.username || base.password || base.search || base.hash) throw new Error('PSKILLS_UPLOAD_REVIEW_REGISTRY_API_URL must not contain credentials or query data');
  const local = process.env.NODE_ENV !== 'production' && process.env.VERCEL_ENV !== 'production';
  if (base.protocol !== 'https:' && !(local && base.protocol === 'http:' && LOOPBACK_HOSTS.has(base.hostname))) {
    throw new Error('PSKILLS_UPLOAD_REVIEW_REGISTRY_API_URL must use HTTPS outside loopback development');
  }
  const prefix = base.pathname.replace(/\/+$/u, '');
  base.pathname = `${prefix}${path}`;
  return base;
}

export function uploadReviewToken(): string {
  const value = process.env.PSKILLS_UPLOAD_REVIEW_REGISTRY_TOKEN?.trim();
  if (!value || value.length > 512 || /\s/u.test(value)) throw new Error('PSKILLS_UPLOAD_REVIEW_REGISTRY_TOKEN is invalid');
  return value;
}
