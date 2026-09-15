import type {
  BlobStore,
  Digest,
  RecoverableBlobStore,
  StorageObjectInspection,
  StoredBlob,
} from "../../contracts/src/index.js";
import { digestBytes, isSha256Digest } from "./digest.js";
import { isRecoverableBlobStore } from "./recovery.js";

export const DEFAULT_GATEWAY_MAX_BODY_BYTES = 20 * 1024 * 1024;
export const DEFAULT_GATEWAY_TIMEOUT_MS = 30_000;

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};
const PRIVATE_HEADERS = {
  "cache-control": "no-store, private",
  "content-disposition": "attachment",
};

export type HttpHeaders = HeadersInit | (() => HeadersInit);

export interface HttpBlobStoreOptions {
  /** Origin of the private Node gateway, for example https://gateway.example. */
  baseOrigin?: string;
  /** Compatibility spelling used by the runtime infrastructure factory. */
  baseUrl?: string;
  /** Opaque gateway token headers. This is never included in an error. */
  headers?: HttpHeaders;
  /** Convenience for the dedicated gateway bearer token. */
  token?: string;
  /** Permit HTTP loopback only for explicitly enabled local development. */
  allowLoopback?: boolean;
  /** Injected fetch implementation for tests or a host runtime. */
  fetch?: typeof fetch;
  /** Prefix used when allocating stable sealed object identities. */
  prefix?: string;
  maxBytes?: number;
  timeoutMs?: number;
}

export interface BlobGatewayHandlerOptions {
  /** The real Files SDK-backed store. Do not replace this with a mock in prod. */
  blobStore?: BlobStore;
  /** Compatibility spelling used by the runtime infrastructure factory. */
  store?: BlobStore;
  /** Gateway-token or mTLS authorization check supplied by the root. */
  authorize: (request: Request) => boolean | Promise<boolean>;
  /** Fixed public origin used to reject proxy/origin confusion. */
  baseOrigin?: string;
  /** Compatibility spelling for an optional fixed gateway URL. */
  baseUrl?: string;
  /** Maximum raw request body accepted by POST /internal/blobs. */
  maxBodyBytes?: number;
  /** Timeout while consuming a request body. */
  timeoutMs?: number;
  /** Permit HTTP loopback only for explicitly enabled local development. */
  allowLoopbackDevelopment?: boolean;
  /** Compatibility spelling used by local runtime callers. */
  allowLoopback?: boolean;
}

export class HttpBlobError extends Error {
  readonly status: number;
  readonly code: "configuration" | "http" | "integrity" | "limit";

  constructor(
    message: string,
    status: number,
    code: HttpBlobError["code"] = "http"
  ) {
    super(message);
    this.name = "HttpBlobError";
    this.status = status;
    this.code = code;
  }
}

interface LocalBlobRecord {
  digest: Digest;
  size: number;
}

function positiveLimit(value: number | undefined, fallback: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new HttpBlobError("gateway byte limit must be a positive safe integer", 500, "configuration");
  }
  return limit;
}

function normalizeOrigin(
  value: string,
  allowLoopbackDevelopment: boolean
): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new HttpBlobError("gateway base origin is invalid", 500, "configuration");
  }
  const loopback =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]" ||
    parsed.hostname === "::1";
  if (parsed.protocol !== "https:" && !(allowLoopbackDevelopment && loopback && parsed.protocol === "http:")) {
    throw new HttpBlobError(
      "gateway base origin must use HTTPS outside explicit loopback development",
      500,
      "configuration"
    );
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new HttpBlobError(
      "gateway base origin must be an origin without credentials or a path",
      500,
      "configuration"
    );
  }
  return parsed.origin;
}

function normalizePrefix(prefix: string | undefined): string {
  if (prefix === undefined || prefix === "") return "";
  const value = prefix.replace(/^\/+|\/+$/gu, "");
  if (
    value.length === 0 ||
    value.includes("\\") ||
    value.includes(":") ||
    value.includes("//") ||
    value.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new HttpBlobError("storage prefix is invalid", 500, "configuration");
  }
  return value;
}

function randomKeyPart(): string {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) {
    throw new HttpBlobError("secure Web Crypto randomness is required for sealed storage keys", 500, "configuration");
  }
  const bytes = new Uint8Array(24);
  cryptoApi.getRandomValues(bytes);
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

function isKnownNotFound(error: unknown): boolean {
  if (error instanceof HttpBlobError) return error.status === 404;
  if (typeof error === "object" && error !== null) {
    const candidate = error as { code?: unknown; status?: unknown; statusCode?: unknown };
    const code = typeof candidate.code === "string" ? candidate.code.toLowerCase() : "";
    if (code === "notfound" || code === "not_found" || code === "enoent" || candidate.status === 404 || candidate.statusCode === 404) return true;
  }
  return error instanceof Error && /^(?:not[ -]?found|enoent)$/iu.test(error.message.trim());
}

function combineTimeout(timeoutMs: number, parent?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!parent) return timeoutSignal;
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([parent, timeoutSignal]);
  }
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason ?? timeoutSignal.reason);
  if (parent.aborted) abort();
  else parent.addEventListener("abort", abort, { once: true });
  timeoutSignal.addEventListener("abort", () => controller.abort(timeoutSignal.reason), {
    once: true,
  });
  return controller.signal;
}

function pathForKey(key: string): string {
  if (
    typeof key !== "string" ||
    !key ||
    key.length > 4_096 ||
    key.startsWith("/") ||
    key.endsWith("/") ||
    key.includes("\\") ||
    key.includes(":") ||
    key.includes("//") ||
    key.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new HttpBlobError("storage key is invalid", 400, "http");
  }
  return `/internal/blobs/${encodeURIComponent(key)}`;
}

function assertStableKey(key: string, prefix: string): void {
  pathForKey(key);
  const expectedPrefix = `${prefix ? `${prefix}/` : ""}sealed/`;
  if (!key.startsWith(expectedPrefix) || !/^[0-9a-f]{48}$/u.test(key.slice(expectedPrefix.length))) {
    throw new HttpBlobError("storage key is not a Private Skills sealed-object key", 400, "integrity");
  }
}

function requestHeaders(value: HttpHeaders | undefined): Headers {
  return new Headers(typeof value === "function" ? value() : value);
}

function validateStoredBlob(value: unknown): StoredBlob {
  if (typeof value !== "object" || value === null) {
    throw new HttpBlobError("gateway returned an invalid blob descriptor", 502, "integrity");
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.key !== "string" ||
    typeof candidate.size !== "number" ||
    !Number.isSafeInteger(candidate.size) ||
    candidate.size < 0 ||
    !isSha256Digest(candidate.digest)
  ) {
    throw new HttpBlobError("gateway returned an invalid blob descriptor", 502, "integrity");
  }
  try {
    pathForKey(candidate.key);
  } catch {
    throw new HttpBlobError(
      "gateway returned an invalid storage key",
      502,
      "integrity"
    );
  }
  return {
    digest: candidate.digest,
    key: candidate.key,
    size: candidate.size,
  };
}

async function readResponseBytes(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  let declaredSize: number | undefined;
  if (declared !== null) {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new HttpBlobError("gateway returned an invalid content length", 502, "integrity");
    }
    if (size > maxBytes) {
      throw new HttpBlobError("gateway response exceeds the configured byte limit", 502, "limit");
    }
    declaredSize = size;
  }
  if (!response.body) {
    if (signal?.aborted) {
      throw new HttpBlobError("gateway response timed out", 504, "http");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (signal?.aborted) {
      throw new HttpBlobError("gateway response timed out", 504, "http");
    }
    if (bytes.byteLength > maxBytes) {
      throw new HttpBlobError("gateway response exceeds the configured byte limit", 502, "limit");
    }
    if (declaredSize !== undefined && bytes.byteLength !== declaredSize) {
      throw new HttpBlobError("gateway response length does not match its header", 502, "integrity");
    }
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancelOnAbort = () => {
    void reader.cancel(signal?.reason);
  };
  signal?.addEventListener("abort", cancelOnAbort, { once: true });
  try {
    while (true) {
      const next = await reader.read();
      if (signal?.aborted) {
        throw new HttpBlobError("gateway response timed out", 504, "http");
      }
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new HttpBlobError("gateway response exceeds the configured byte limit", 502, "limit");
      }
      chunks.push(next.value);
    }
  } finally {
    signal?.removeEventListener("abort", cancelOnAbort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (declaredSize !== undefined && bytes.byteLength !== declaredSize) {
    throw new HttpBlobError("gateway response length does not match its header", 502, "integrity");
  }
  return bytes;
}

async function responseError(response: Response, operation: string): Promise<never> {
  // Deliberately do not read or include the response body: gateways can
  // contain provider diagnostics or credential-bearing proxy details.
  throw new HttpBlobError(
    `blob gateway ${operation} failed with HTTP ${response.status}`,
    response.status >= 400 && response.status < 500 ? response.status : 502
  );
}

function rejectRedirect(response: Response, operation: string): void {
  // Workerd does not implement `redirect: "error"`. Manual mode is portable,
  // but a manual response must still be rejected before any body is consumed
  // so a gateway cannot redirect a private request to another origin.
  if (response.status >= 300 && response.status < 400) {
    throw new HttpBlobError(
      `blob gateway ${operation} returned an unexpected redirect`,
      502
    );
  }
}

/** BlobStore client for the private gateway, with no provider credentials. */
export class HttpBlobStore implements RecoverableBlobStore {
  readonly #origin: string;
  readonly #headers: HttpHeaders | undefined;
  readonly #fetch: typeof fetch;
  readonly #prefix: string;
  readonly #maxBytes: number;
  readonly #timeoutMs: number;
  readonly #records = new Map<string, LocalBlobRecord>();

  constructor(options: HttpBlobStoreOptions) {
    const base = options.baseOrigin ?? options.baseUrl;
    if (!base) {
      throw new HttpBlobError("gateway baseUrl is required", 500, "configuration");
    }
    this.#origin = normalizeOrigin(base, options.allowLoopback === true);
    this.#headers = () => {
      const headers = requestHeaders(options.headers);
      if (options.token) headers.set("authorization", `Bearer ${options.token}`);
      return headers;
    };
    const fetchImplementation = options.fetch ?? globalThis.fetch;
    if (typeof fetchImplementation !== "function") {
      throw new HttpBlobError("a fetch implementation is required", 500, "configuration");
    }
    // Some edge runtimes expose fetch as a receiver-sensitive host method.
    // Store a bound function so calling it through a private class field does
    // not lose the required global receiver.
    this.#fetch = fetchImplementation.bind(globalThis);
    this.#prefix = normalizePrefix(options.prefix);
    this.#maxBytes = positiveLimit(options.maxBytes, DEFAULT_GATEWAY_MAX_BODY_BYTES);
    this.#timeoutMs = positiveLimit(options.timeoutMs, DEFAULT_GATEWAY_TIMEOUT_MS);
  }

  async put(bytes: Uint8Array): Promise<StoredBlob> {
    if (!(bytes instanceof Uint8Array)) {
      throw new HttpBlobError("put expects a Uint8Array", 400);
    }
    if (bytes.byteLength > this.#maxBytes) {
      throw new HttpBlobError("blob exceeds the configured byte limit", 413, "limit");
    }
    const payload = new Uint8Array(bytes);
    const digest = await digestBytes(payload);
    const headers = requestHeaders(this.#headers);
    headers.set("content-type", "application/octet-stream");
    headers.set("content-length", String(payload.byteLength));
    headers.set("cache-control", "no-store");
    const signal = combineTimeout(this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(`${this.#origin}/internal/blobs`, {
        method: "POST",
        headers,
        body: payload,
        redirect: "manual",
        signal,
      });
    } catch {
      throw new HttpBlobError("blob gateway request failed", 502);
    }
    rejectRedirect(response, "upload");
    if (!response.ok) await responseError(response, "upload");
    let descriptor: StoredBlob;
    try {
      const descriptorBytes = await readResponseBytes(response, 64 * 1024, signal);
      const descriptorText = new TextDecoder("utf-8", { fatal: true }).decode(
        descriptorBytes
      );
      descriptor = validateStoredBlob(JSON.parse(descriptorText) as unknown);
    } catch (error) {
      if (error instanceof HttpBlobError) throw error;
      throw new HttpBlobError("blob gateway returned invalid JSON", 502, "integrity");
    }
    if (descriptor.digest !== digest || descriptor.size !== payload.byteLength) {
      throw new HttpBlobError("blob gateway changed the uploaded descriptor", 502, "integrity");
    }
    this.#records.set(descriptor.key, { digest, size: payload.byteLength });
    return descriptor;
  }

  allocateObjectKey(): string {
    return `${this.#prefix ? `${this.#prefix}/` : ""}sealed/${randomKeyPart()}`;
  }

  async putAtKey(
    key: string,
    bytes: Uint8Array,
    metadata?: Record<string, string>,
  ): Promise<StoredBlob> {
    assertStableKey(key, this.#prefix);
    if (!(bytes instanceof Uint8Array)) {
      throw new HttpBlobError("put expects a Uint8Array", 400);
    }
    if (bytes.byteLength > this.#maxBytes) {
      throw new HttpBlobError("blob exceeds the configured byte limit", 413, "limit");
    }
    const payload = new Uint8Array(bytes);
    const digest = await digestBytes(payload);
    const existing = await this.inspectObject(key);
    if (existing.state === "present") {
      if (existing.digest !== digest || existing.size !== payload.byteLength) {
        throw new HttpBlobError("stable storage key contains different bytes", 409, "integrity");
      }
      this.#records.set(key, { digest, size: payload.byteLength });
      return { key, digest, size: payload.byteLength };
    }
    if (existing.state === "unknown") {
      throw new HttpBlobError("cannot establish whether stable storage key exists", 502, "integrity");
    }
    const headers = requestHeaders(this.#headers);
    headers.set("content-type", "application/octet-stream");
    headers.set("content-length", String(payload.byteLength));
    headers.set("cache-control", "no-store");
    // Gateway metadata is deliberately not forwarded: the private route
    // derives object identity and integrity from the request body.
    void metadata;
    let response: Response;
    try {
      response = await this.#fetch(`${this.#origin}${pathForKey(key)}`, {
        method: "PUT",
        headers,
        body: payload,
        redirect: "manual",
        signal: combineTimeout(this.#timeoutMs),
      });
    } catch {
      throw new HttpBlobError("blob gateway request failed", 502);
    }
    rejectRedirect(response, "stable upload");
    if (!response.ok) await responseError(response, "stable upload");
    let descriptor: StoredBlob;
    try {
      const descriptorBytes = await readResponseBytes(response, 64 * 1024);
      descriptor = validateStoredBlob(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(descriptorBytes)) as unknown);
    } catch (error) {
      if (error instanceof HttpBlobError) throw error;
      throw new HttpBlobError("blob gateway returned invalid JSON", 502, "integrity");
    }
    if (descriptor.key !== key || descriptor.digest !== digest || descriptor.size !== payload.byteLength) {
      throw new HttpBlobError("blob gateway changed the stable upload descriptor", 502, "integrity");
    }
    this.#records.set(key, { digest, size: payload.byteLength });
    return descriptor;
  }

  async inspectObject(key: string): Promise<StorageObjectInspection> {
    pathForKey(key);
    try {
      const bytes = await this.get(key);
      return { state: "present", key, digest: await digestBytes(bytes), size: bytes.byteLength };
    } catch (error) {
      if (isKnownNotFound(error)) return { state: "absent", key };
      if (error instanceof HttpBlobError && error.code === "limit") return { state: "unknown", key, reason: "limit" };
      if (error instanceof HttpBlobError && error.code === "integrity") return { state: "unknown", key, reason: "integrity" };
      return { state: "unknown", key, reason: "provider-error" };
    }
  }

  async getVerified(key: string, expectedDigest: Digest): Promise<Uint8Array> {
    if (!isSha256Digest(expectedDigest)) {
      throw new HttpBlobError("expected digest is not sha256", 400, "integrity");
    }
    const bytes = await this.get(key);
    const actual = await digestBytes(bytes);
    if (actual !== expectedDigest) {
      throw new HttpBlobError("blob gateway returned bytes with the wrong digest", 502, "integrity");
    }
    return bytes;
  }

  async get(key: string): Promise<Uint8Array> {
    const headers = requestHeaders(this.#headers);
    headers.set("accept", "application/octet-stream");
    headers.set("cache-control", "no-store");
    const signal = combineTimeout(this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(`${this.#origin}${pathForKey(key)}`, {
        method: "GET",
        headers,
        redirect: "manual",
        signal,
      });
    } catch {
      throw new HttpBlobError("blob gateway request failed", 502);
    }
    rejectRedirect(response, "download");
    if (!response.ok) await responseError(response, "download");
    let bytes: Uint8Array;
    try {
      bytes = await readResponseBytes(response, this.#maxBytes, signal);
    } catch (error) {
      if (error instanceof HttpBlobError) throw error;
      throw new HttpBlobError("blob gateway response failed", 502);
    }
    const digest = await digestBytes(bytes);
    const declaredDigest = response.headers.get("x-pskills-digest");
    if (declaredDigest !== null && (!isSha256Digest(declaredDigest) || declaredDigest !== digest)) {
      throw new HttpBlobError("blob gateway returned an invalid digest", 502, "integrity");
    }
    const record = this.#records.get(key);
    if (record && (record.digest !== digest || record.size !== bytes.byteLength)) {
      throw new HttpBlobError("blob gateway bytes no longer match their digest", 502, "integrity");
    }
    return bytes;
  }

  async remove(key: string): Promise<void> {
    const headers = requestHeaders(this.#headers);
    headers.set("cache-control", "no-store");
    let response: Response;
    try {
      response = await this.#fetch(`${this.#origin}${pathForKey(key)}`, {
        method: "DELETE",
        headers,
        redirect: "manual",
        signal: combineTimeout(this.#timeoutMs),
      });
    } catch {
      throw new HttpBlobError("blob gateway request failed", 502);
    }
    rejectRedirect(response, "delete");
    if (!response.ok) await responseError(response, "delete");
    this.#records.delete(key);
  }
}

async function requestBytes(
  request: Request,
  maxBytes: number,
  timeoutMs: number
): Promise<Uint8Array> {
  const length = request.headers.get("content-length");
  if (length !== null) {
    const declared = Number(length);
    if (!Number.isSafeInteger(declared) || declared < 0) {
      throw new HttpBlobError("request content length is invalid", 400);
    }
    if (declared > maxBytes) {
      throw new HttpBlobError("request body exceeds the configured byte limit", 413, "limit");
    }
  }
  if (!request.body) return new Uint8Array();
  const signal = combineTimeout(timeoutMs, request.signal);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancelOnAbort = () => {
    void reader.cancel(signal.reason);
  };
  signal.addEventListener("abort", cancelOnAbort, { once: true });
  try {
    while (true) {
      const next = await reader.read();
      if (signal.aborted) {
        throw new HttpBlobError("gateway request timed out", 504, "http");
      }
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new HttpBlobError("request body exceeds the configured byte limit", 413, "limit");
      }
      chunks.push(next.value);
    }
  } finally {
    signal.removeEventListener("abort", cancelOnAbort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function responseForError(error: unknown): Response {
  const candidate =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown })
      : undefined;
  const status =
    error instanceof HttpBlobError
      ? error.status
      : isKnownNotFound(error)
        ? 404
      : candidate?.code === "limit"
        ? 413
        : candidate?.code === "invalid_key"
          ? 400
          : 502;
  const body = JSON.stringify({ error: status === 413 ? "payload_too_large" : "blob_gateway_error" });
  return new Response(body, {
    status,
    headers: JSON_HEADERS,
  });
}

/**
 * Create the private gateway route used by edge hosts that cannot load native
 * provider SDKs. The handler is origin-pinned and deny-by-default through the
 * injected authorization function.
 */
export function createBlobGatewayHandler(
  options: BlobGatewayHandlerOptions
): (request: Request) => Promise<Response> {
  if (typeof options?.authorize !== "function") {
    throw new HttpBlobError(
      "blob gateway authorize callback is required",
      500,
      "configuration"
    );
  }
  const configuredOrigin = options.baseOrigin ?? options.baseUrl;
  const allowLoopback =
    options.allowLoopbackDevelopment === true || options.allowLoopback === true;
  const origin = configuredOrigin
    ? normalizeOrigin(configuredOrigin, allowLoopback)
    : undefined;
  const blobStore = options.blobStore ?? options.store;
  if (!blobStore) {
    throw new HttpBlobError("blob gateway store is required", 500, "configuration");
  }
  const maxBytes = positiveLimit(options.maxBodyBytes, DEFAULT_GATEWAY_MAX_BODY_BYTES);
  const timeoutMs = positiveLimit(options.timeoutMs, DEFAULT_GATEWAY_TIMEOUT_MS);

  return async (request: Request): Promise<Response> => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return responseForError(new HttpBlobError("request URL is invalid", 400));
    }
    if (url.username || url.password) {
      return responseForError(new HttpBlobError("gateway URL credentials are not accepted", 400));
    }
    if (origin && url.origin !== origin) {
      return responseForError(new HttpBlobError("gateway origin mismatch", 421));
    }
    if (!origin) {
      try {
        normalizeOrigin(url.origin, allowLoopback);
      } catch {
        return responseForError(new HttpBlobError("gateway origin is not allowed", 421));
      }
    }
    let authorized = false;
    try {
      authorized = await options.authorize(request);
    } catch {
      authorized = false;
    }
    if (!authorized) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: JSON_HEADERS,
      });
    }
    if (url.search || url.hash) {
      return responseForError(new HttpBlobError("query strings are not accepted", 400));
    }
    const collection = "/internal/blobs";
    if (url.pathname === collection && request.method === "POST") {
      if (
        request.headers.get("content-encoding") &&
        request.headers.get("content-encoding") !== "identity"
      ) {
        return responseForError(new HttpBlobError("encoded request bodies are not accepted", 415));
      }
      try {
        const bytes = await requestBytes(request, maxBytes, timeoutMs);
        const stored = await blobStore.put(bytes);
        return new Response(JSON.stringify(stored), {
          status: 201,
          headers: JSON_HEADERS,
        });
      } catch (error) {
        return responseForError(error);
      }
    }

    if (!url.pathname.startsWith(`${collection}/`)) {
      return responseForError(new HttpBlobError("blob route not found", 404));
    }
    let key: string;
    try {
      key = decodeURIComponent(url.pathname.slice(collection.length + 1));
    } catch {
      return responseForError(new HttpBlobError("storage key is invalid", 400));
    }
    try {
      pathForKey(key);
    } catch {
      return responseForError(new HttpBlobError("storage key is invalid", 400));
    }
    if (!key) return responseForError(new HttpBlobError("storage key is invalid", 400));

    try {
      if (request.method === "PUT") {
        if (!isRecoverableBlobStore(blobStore)) {
          return responseForError(new HttpBlobError("stable blob writes are unavailable on this gateway", 501));
        }
        if (
          request.headers.get("content-encoding") &&
          request.headers.get("content-encoding") !== "identity"
        ) {
          return responseForError(new HttpBlobError("encoded request bodies are not accepted", 415));
        }
        const bytes = await requestBytes(request, maxBytes, timeoutMs);
        const stored = await blobStore.putAtKey(key, bytes);
        if (stored.key !== key) {
          return responseForError(new HttpBlobError("stable blob store returned a different key", 502, "integrity"));
        }
        return new Response(JSON.stringify(stored), {
          status: 201,
          headers: JSON_HEADERS,
        });
      }
      if (request.method === "GET") {
        const bytes = await blobStore.get(key);
        if (bytes.byteLength > maxBytes) {
          throw new HttpBlobError(
            "blob exceeds the configured byte limit",
            413,
            "limit"
          );
        }
        const digest = await digestBytes(bytes);
        return new Response(bytes as unknown as BodyInit, {
          status: 200,
          headers: {
            ...PRIVATE_HEADERS,
            "content-length": String(bytes.byteLength),
            "content-type": "application/octet-stream",
            "x-pskills-digest": digest,
          },
        });
      }
      if (request.method === "DELETE") {
        await blobStore.remove(key);
        return new Response(null, { status: 204, headers: PRIVATE_HEADERS });
      }
      return responseForError(new HttpBlobError("blob method not allowed", 405));
    } catch (error) {
      return responseForError(error);
    }
  };
}
