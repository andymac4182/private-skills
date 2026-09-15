import { registryEndpoint, reviewerToken } from "./config.js";
import {
  createEveTenantServiceFromEnv,
  requireEveTenantCaller,
  type EveSessionAuthShape,
  type EveTenantDelegationBinding,
} from "../../../../packages/eve-tenant/src/index.js";

const REQUEST_TIMEOUT_MS = 45_000;
const MAX_RESPONSE_BYTES = 1_500_000;
const MAX_REQUEST_BYTES = 256_000;

type JsonParser<T> = (value: unknown) => T;

export interface ReviewerCallbackOptions {
  readonly session?: {
    readonly id: string;
    readonly auth: EveSessionAuthShape;
  };
  readonly binding?: EveTenantDelegationBinding;
}

function joinBytes(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function readBoundedText(response: Response): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
      throw new Error("reviewer API response exceeded the bounded size");
    }
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
        throw new Error("reviewer API response exceeded the bounded size");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(joinBytes(chunks, total));
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("reviewer API returned an invalid JSON object");
  }
  return value as Record<string, unknown>;
}

export async function postReviewerJson<T>(
  path: string,
  body: Record<string, unknown>,
  parse: JsonParser<T>,
  signal: AbortSignal,
  options: ReviewerCallbackOptions = {},
): Promise<T> {
  const encoded = JSON.stringify(body);
  if (new TextEncoder().encode(encoded).byteLength > MAX_REQUEST_BYTES) {
    throw new Error("reviewer request exceeded the bounded size");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });

  try {
    const headers = await callbackHeaders(options);
    const response = await fetch(registryEndpoint(path), {
      method: "POST",
      headers,
      body: encoded,
      redirect: "error",
      signal: controller.signal,
    });
    const text = await readBoundedText(response);
    if (!response.ok) {
      throw new Error(`reviewer API returned HTTP ${response.status}`);
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error("reviewer API returned invalid JSON");
    }
    return parse(parseObject(value));
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

async function callbackHeaders(options: ReviewerCallbackOptions): Promise<Headers> {
  const base = { accept: "application/json", "content-type": "application/json" };
  const active = options.session?.auth.current;
  const tenantId = active?.attributes?.tenantId;
  if (typeof tenantId !== "string") {
    if (active?.authenticator === "pskills-eve-tenant-delegation") {
      throw new Error("active tenant Eve caller has no tenant id");
    }
    return new Headers({ ...base, authorization: `Bearer ${reviewerToken()}` });
  }
  const caller = requireEveTenantCaller({ session: options.session! }, "consolidation-reviewer");
  const configured = process.env.PSKILLS_EVE_TENANT_DELEGATION_ISSUER?.trim();
  const registry = process.env.PSKILLS_REGISTRY_API_URL?.trim();
  const issuer = configured || (registry ? new URL(registry).origin : "");
  if (!issuer) throw new Error("tenant Eve delegation issuer is not configured");
  const service = createEveTenantServiceFromEnv(process.env, {
    issuer,
    tenantId: caller.tenantId,
    service: "consolidation-reviewer",
  });
  if (!service) throw new Error("tenant Eve delegation is not configured");
  const binding = { ...caller.binding, ...options.binding };
  if (!binding.sessionId) throw new Error("reviewer callback is missing its session binding");
  return service.headers(base, binding);
}
