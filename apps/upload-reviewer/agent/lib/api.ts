import { registryEndpoint, uploadReviewToken } from './config.js';
import {
  createEveTenantServiceFromEnv,
  requireEveTenantCaller,
  type EveSessionAuthShape,
  type EveTenantDelegationBinding,
} from '../../../../packages/eve-tenant/src/index.js';

const REQUEST_TIMEOUT_MS = 45_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES = 1_500_000;

type JsonParser<T> = (value: unknown) => T;

export interface UploadReviewerCallbackOptions {
  readonly session?: {
    readonly id: string;
    readonly auth: EveSessionAuthShape;
  };
  readonly binding?: EveTenantDelegationBinding;
}

/** The status is retained for bounded, route-specific retry decisions. */
export class UploadReviewApiError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`upload reviewer API returned HTTP ${status}`);
    this.name = 'UploadReviewApiError';
    this.status = status;
  }
}

async function readBoundedText(response: Response): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new Error('upload reviewer response exceeded the bounded size');
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('upload reviewer response exceeded the bounded size');
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
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export async function postUploadReviewerJson<T>(
  path: string,
  body: Record<string, unknown>,
  parse: JsonParser<T>,
  signal: AbortSignal,
  options: UploadReviewerCallbackOptions = {},
): Promise<T> {
  const encoded = JSON.stringify(body);
  if (new TextEncoder().encode(encoded).byteLength > MAX_REQUEST_BYTES) throw new Error('upload reviewer request exceeded the bounded size');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  try {
    const headers = await callbackHeaders(options);
    const response = await fetch(registryEndpoint(path), {
      method: 'POST',
      headers,
      body: encoded,
      redirect: 'error',
      signal: controller.signal,
    });
    const text = await readBoundedText(response);
    if (!response.ok) throw new UploadReviewApiError(response.status);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error('upload reviewer API returned invalid JSON');
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('upload reviewer API returned an invalid object');
    return parse(value);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

async function callbackHeaders(
  options: UploadReviewerCallbackOptions,
): Promise<Headers> {
  const base = {
    accept: 'application/json',
    'content-type': 'application/json',
  };
  const active = options.session?.auth.current;
  const tenantId = active?.attributes?.tenantId;
  if (typeof tenantId !== 'string') {
    if (active?.authenticator === 'pskills-eve-tenant-delegation') {
      throw new Error('active tenant Eve caller has no tenant id');
    }
    return new Headers({ ...base, authorization: `Bearer ${uploadReviewToken()}` });
  }
  const caller = requireEveTenantCaller({ session: options.session! }, 'upload-reviewer');
  const issuer = tenantIssuer();
  const service = createEveTenantServiceFromEnv(process.env, {
    issuer,
    tenantId: caller.tenantId,
    service: 'upload-reviewer',
  });
  if (!service) throw new Error('tenant Eve delegation is not configured');
  const binding = {
    ...caller.binding,
    ...options.binding,
  };
  if (!binding.jobId) throw new Error('upload review callback is missing its job binding');
  return service.headers(base, binding);
}

function tenantIssuer(): string {
  const configured = process.env.PSKILLS_EVE_TENANT_DELEGATION_ISSUER?.trim();
  if (configured) return configured;
  const registry = process.env.PSKILLS_UPLOAD_REVIEW_REGISTRY_API_URL?.trim();
  if (!registry) throw new Error('tenant Eve delegation issuer is not configured');
  return new URL(registry).origin;
}
