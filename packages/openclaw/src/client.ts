import {
  decodeUtf8,
  parseOpenClawFeed,
  sha256,
  utf8Bytes,
  OpenClawValidationError,
} from "./feed.ts";
import {
  OPENCLAW_DEFAULT_MAX_BODY_BYTES,
  OPENCLAW_DEFAULT_MAX_STALE_MS,
  OPENCLAW_DEFAULT_TIMEOUT_MS,
  OPENCLAW_CLAWHUB_SKILLS_API_URL,
  OPENCLAW_CLAWHUB_SKILLS_COMPATIBILITY_PROFILE,
  OPENCLAW_CLAWHUB_SKILLS_FEED_ID,
  OPENCLAW_CLAWHUB_SKILLS_MAX_TTL_MS,
  OPENCLAW_MAX_BODY_BYTES,
  OPENCLAW_MAX_STALE_MS,
  OPENCLAW_MAX_TIMEOUT_MS,
  type OpenClawCacheSnapshot,
  type OpenClawFeed,
  type OpenClawFeedCacheOptions,
  type OpenClawFeedCompatibilityProfile,
  type OpenClawFeedErrorCode,
  type OpenClawFeedRefreshRequest,
  type OpenClawFetch,
  type OpenClawRefreshResult,
} from "./types.ts";

const MAX_HEADER_BYTES = 8 * 1024;

export class OpenClawRequestError extends Error {
  readonly code: OpenClawFeedErrorCode;

  constructor(code: OpenClawFeedErrorCode) {
    super(code);
    this.name = "OpenClawRequestError";
    this.code = code;
  }
}

/**
 * A single-feed, single-tenant last-known-good cache.  The host should create
 * one instance per authenticated tenant and feed URL; this class refuses to
 * reuse a snapshot for a different URL or feed identity.
 */
export class OpenClawFeedCache {
  private readonly maxBodyBytes: number;
  private readonly maxStaleMs: number;
  private readonly now: () => number;
  private snapshotValue: OpenClawCacheSnapshot | undefined;
  private cacheKey: string | undefined;
  private refreshTail: Promise<void> = Promise.resolve();

  constructor(options: OpenClawFeedCacheOptions = {}) {
    this.maxBodyBytes = boundedBodyLimit(options.maxBodyBytes);
    this.maxStaleMs = boundedStaleLimit(options.maxStaleMs);
    this.now = options.now ?? Date.now;
  }

  getSnapshot(): OpenClawCacheSnapshot | undefined {
    return this.snapshotValue === undefined ? undefined : cloneSnapshot(this.snapshotValue);
  }

  clear(): void {
    this.snapshotValue = undefined;
    this.cacheKey = undefined;
  }

  refresh(request: OpenClawFeedRefreshRequest): Promise<OpenClawRefreshResult> {
    const run = this.refreshTail.then(() => this.refreshInternal(request));
    this.refreshTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async refreshInternal(
    request: OpenClawFeedRefreshRequest,
  ): Promise<OpenClawRefreshResult> {
    const now = this.now();
    const maxBodyBytes = boundedBodyLimit(
      Math.min(request.maxBodyBytes ?? this.maxBodyBytes, this.maxBodyBytes),
    );
    const timeoutMs = boundedTimeout(request.timeoutMs);
    let url: URL;
    try {
      url = validateFeedUrl(request.url, request.allowedOrigins);
    } catch {
      return this.rejectWithoutSnapshot("invalid-url");
    }
    if (!request.expectedFeedId || request.expectedFeedId.trim() === "") {
      return this.rejectWithoutSnapshot("invalid-url");
    }
    if (!isSupportedCompatibilityRequest(url, request.expectedFeedId, request.compatibilityProfile)) {
      return this.rejectWithoutSnapshot("invalid-url");
    }
    const key = `${request.expectedFeedId}\u0000${url.href}`;
    if (this.cacheKey !== undefined && this.cacheKey !== key) {
      return this.rejectWithoutSnapshot("invalid-url");
    }
    this.cacheKey ??= key;

    const fetcher = request.fetcher ?? globalThis.fetch;
    if (typeof fetcher !== "function") {
      return this.rejected("fetch-failed", now);
    }

    const headers: Record<string, string> = { accept: "application/json" };
    if (this.snapshotValue?.transportEtag ?? this.snapshotValue?.etag) {
      headers["if-none-match"] = this.snapshotValue.transportEtag ?? this.snapshotValue.etag;
    }
    if (this.snapshotValue?.lastModified) {
      headers["if-modified-since"] = this.snapshotValue.lastModified;
    }

    const controller = new AbortController();
    const cleanupAbort = forwardAbort(request.signal, controller);
    // The injected cache clock controls freshness metadata.  Transport
    // deadlines use the host wall clock so a test or durable-clock adapter
    // cannot accidentally schedule a multi-year timer.
    const deadline = Date.now() + timeoutMs;
    try {
      const response = await raceRequest(
        fetcher,
        url,
        { method: "GET", headers, redirect: "error", signal: controller.signal },
        request.signal,
        controller,
        deadline,
      );
      if (
        response.redirected ||
        (response.status >= 300 && response.status < 400 && response.status !== 304)
      ) {
        return this.fallback("redirected", now, response.status);
      }
      if (response.status === 304) {
        const cached = this.usableSnapshot(now);
        if (!cached) {
          return this.rejected("no-cache", now, 304);
        }
        const responseEtag = readBoundedHeader(response.headers.get("etag"));
        if (responseEtag === "invalid") {
          return this.fallback("invalid-etag", now, 304);
        }
        if (
          responseEtag !== undefined &&
          !matchesResponseEtag(
            responseEtag,
            cached.sha256,
            url,
            request.compatibilityProfile,
          )
        ) {
          return this.fallback("invalid-etag", now, 304);
        }
        const responseLastModified = readBoundedHeader(response.headers.get("last-modified"));
        if (
          responseLastModified === "invalid" ||
          (responseLastModified !== undefined &&
            cached.lastModified !== undefined &&
            responseLastModified !== cached.lastModified)
        ) {
          return this.fallback("invalid-feed", now, 304);
        }
        if (
          request.expectedSha256 !== undefined &&
          !matchesExpectedSha256(cached.sha256, request.expectedSha256)
        ) {
          return this.rejectWithoutSnapshot("digest-mismatch", 304);
        }
        return { kind: "not-modified", status: 304, snapshot: cached };
      }
      if (response.status !== 200) {
        return this.fallback("unexpected-status", now, response.status);
      }
      const rawBody = await readResponseBody(
        response,
        maxBodyBytes,
        request.signal,
        controller,
        deadline,
      );
      const body = rawBody.text;
      let feed: OpenClawFeed;
      try {
        feed = parseOpenClawFeed(rawBody.bytes, {
          expectedFeedId: request.expectedFeedId,
          now,
          checkExpiry: true,
          maxBytes: maxBodyBytes,
        });
      } catch (error) {
        const code = classifyFeedError(error);
        return this.fallback(code, now, 200);
      }
      if (!isCompatibleFeedWithinBounds(feed, url, request.compatibilityProfile, now)) {
        return this.fallback("invalid-feed", now, 200);
      }
      let digest: Awaited<ReturnType<typeof sha256>>;
      try {
        digest = await sha256(rawBody.bytes);
      } catch {
        return this.fallback("webcrypto-unavailable", now, 200);
      }
      if (request.expectedSha256 !== undefined && !matchesExpectedSha256(digest, request.expectedSha256)) {
        return this.rejectWithoutSnapshot("digest-mismatch", 200);
      }
      const suppliedEtag = readBoundedHeader(response.headers.get("etag"));
      if (suppliedEtag === "invalid") {
        return this.fallback("invalid-etag", now, 200);
      }
      const suppliedContentDigest = readBoundedHeader(response.headers.get("x-content-sha256"));
      if (suppliedContentDigest === "invalid") {
        return this.fallback("invalid-feed", now, 200);
      }
      if (
        suppliedContentDigest !== undefined &&
        !matchesExpectedSha256(digest, suppliedContentDigest)
      ) {
        return this.rejectWithoutSnapshot("digest-mismatch", 200);
      }
      // The pinned ClawHub hosted-feed contract defines ETag as the quoted
      // payload SHA-256. The opt-in live profile additionally accepts only
      // the digest-derived suffix emitted by the observed Vercel gzip
      // representation. Opaque validators remain invalid.
      if (
        suppliedEtag !== undefined &&
        !matchesResponseEtag(suppliedEtag, digest, url, request.compatibilityProfile)
      ) {
        return this.fallback("invalid-etag", now, 200);
      }
      const previous = this.snapshotValue;
      if (previous !== undefined) {
        if (feed.sequence < previous.feed.sequence) {
          return this.fallback("replay", now, 200);
        }
        if (feed.sequence === previous.feed.sequence && digest !== previous.sha256) {
          return this.fallback("equivocation", now, 200);
        }
      }
      const lastModified = readBoundedHeader(response.headers.get("last-modified"));
      if (lastModified === "invalid") {
        return this.fallback("invalid-feed", now, 200);
      }
      const snapshot: OpenClawCacheSnapshot = {
        feed,
        body,
        bytes: rawBody.bytes.slice(),
        sha256: digest,
        etag: `"${digest}"`,
        ...(suppliedEtag === undefined ? {} : { transportEtag: suppliedEtag }),
        ...(lastModified === undefined ? {} : { lastModified }),
        acceptedAt: now,
        sourceUrl: url.href,
      };
      this.snapshotValue = snapshot;
      return { kind: "accepted", status: 200, snapshot: cloneSnapshot(snapshot) };
    } catch (error) {
      const code = classifyRequestError(error, request.signal, controller.signal, deadline, Date.now());
      return this.fallback(code, now);
    } finally {
      controller.abort();
      cleanupAbort();
    }
  }

  private usableSnapshot(now: number): OpenClawCacheSnapshot | undefined {
    const snapshot = this.snapshotValue;
    if (!snapshot) {
      return undefined;
    }
    if (now - snapshot.acceptedAt > this.maxStaleMs) {
      return undefined;
    }
    const expiresAt = effectiveOpenClawFeedExpiry(snapshot.feed, snapshot.sourceUrl);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      return undefined;
    }
    return cloneSnapshot(snapshot);
  }

  private fallback(
    error: OpenClawFeedErrorCode,
    now: number,
    status?: number,
  ): OpenClawRefreshResult {
    const snapshot = this.usableSnapshot(now);
    if (snapshot) {
      return {
        kind: "stale",
        ...(status === undefined ? {} : { status }),
        snapshot,
        error,
      };
    }
    return this.rejected(error, now, status);
  }

  private rejected(
    error: OpenClawFeedErrorCode,
    now: number,
    status?: number,
  ): OpenClawRefreshResult {
    const snapshot = this.usableSnapshot(now);
    return {
      kind: "rejected",
      ...(status === undefined ? {} : { status }),
      ...(snapshot === undefined ? {} : { snapshot }),
      error,
    };
  }

  private rejectWithoutSnapshot(
    error: OpenClawFeedErrorCode,
    status?: number,
  ): OpenClawRefreshResult {
    return {
      kind: "rejected",
      ...(status === undefined ? {} : { status }),
      error,
    };
  }
}

export function validateOpenClawFeedUrl(
  value: string | URL,
  allowedOrigins: readonly string[],
): URL {
  return validateFeedUrl(value, allowedOrigins);
}

/**
 * Identify the one upstream producer/profile for which this package carries
 * an explicit compatibility rule. The URL and feed id are checked together;
 * neither value is accepted as a portable alias for the pinned contract.
 */
export function isOpenClawClawHubSkillsCompatibilityIdentity(
  feedId: string,
  sourceUrl: string | URL,
): boolean {
  try {
    const url = sourceUrl instanceof URL ? new URL(sourceUrl.href) : new URL(sourceUrl);
    return feedId === OPENCLAW_CLAWHUB_SKILLS_FEED_ID && url.href === OPENCLAW_CLAWHUB_SKILLS_API_URL;
  } catch {
    return false;
  }
}

/**
 * Compute the effective local expiry used by cache/admission callers. The
 * current producer advertises a seven-day wire expiry, but this consumer
 * intentionally never treats that as more than one day of local validity.
 */
export function effectiveOpenClawFeedExpiry(
  feed: Pick<OpenClawFeed, "generatedAt" | "expiresAt" | "id">,
  sourceUrl: string | URL,
): number {
  const expiresAt = Date.parse(feed.expiresAt);
  if (!Number.isFinite(expiresAt)) return Number.NaN;
  if (!isOpenClawClawHubSkillsCompatibilityIdentity(feed.id, sourceUrl)) {
    return expiresAt;
  }
  const generatedAt = Date.parse(feed.generatedAt);
  if (!Number.isFinite(generatedAt)) return Number.NaN;
  return Math.min(expiresAt, generatedAt + 24 * 60 * 60 * 1_000);
}

/** Validate a persisted/source transport ETag against the canonical body. */
export function isValidOpenClawTransportEtag(
  value: string,
  digest: string,
  sourceUrl: string | URL,
  feedId: string,
): boolean {
  if (value === `"${digest}"`) return true;
  return isOpenClawClawHubSkillsCompatibilityIdentity(
    feedId,
    sourceUrl,
  ) && (value === `"${digest}-gzip"` || value === `W/"${digest}-gzip"`);
}

function validateFeedUrl(value: string | URL, allowedOrigins: readonly string[]): URL {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value.href) : new URL(value);
  } catch {
    throw new OpenClawRequestError("invalid-url");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new OpenClawRequestError("invalid-url");
  }
  if (allowedOrigins.length === 0) {
    throw new OpenClawRequestError("invalid-url");
  }
  const origins = new Set<string>();
  for (const origin of allowedOrigins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new OpenClawRequestError("invalid-url");
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new OpenClawRequestError("invalid-url");
    }
    if (parsed.pathname !== "/") {
      throw new OpenClawRequestError("invalid-url");
    }
    origins.add(parsed.origin);
  }
  if (!origins.has(url.origin)) {
    throw new OpenClawRequestError("invalid-url");
  }
  return url;
}

async function raceRequest(
  fetcher: OpenClawFetch,
  url: URL,
  init: RequestInit,
  signal: AbortSignal | undefined,
  controller: AbortController,
  deadline: number,
): Promise<Response> {
  const timeout = waitUntil(deadline, "timeout");
  const aborted = signal === undefined ? undefined : waitForAbort(signal);
  try {
    return await Promise.race([
      fetcher(url.href, init),
      timeout,
      ...(aborted === undefined ? [] : [aborted]),
    ]);
  } catch (error) {
    controller.abort();
    throw error;
  } finally {
    timeout.cancel();
    aborted?.cancel();
  }
}

async function readResponseBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal | undefined,
  controller: AbortController,
  deadline: number,
): Promise<{ text: string; bytes: Uint8Array }> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/u.test(contentLength)) {
      throw new OpenClawRequestError("body-too-large");
    }
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length > maxBytes) {
      throw new OpenClawRequestError("body-too-large");
    }
  }
  const body = response.body;
  if (!body || typeof body.getReader !== "function") {
    throw new OpenClawRequestError("invalid-feed");
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const timeout = waitUntil(deadline, "timeout");
      const aborted = signal === undefined ? undefined : waitForAbort(signal);
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await Promise.race([
          reader.read(),
          timeout,
          ...(aborted === undefined ? [] : [aborted]),
        ]);
      } finally {
        timeout.cancel();
        aborted?.cancel();
      }
      if (result.done) {
        break;
      }
      const chunk = result.value;
      total += chunk.byteLength;
      if (total > maxBytes) {
        controller.abort();
        void reader.cancel().catch(() => undefined);
        throw new OpenClawRequestError("body-too-large");
      }
      chunks.push(chunk.slice());
    }
  } catch (error) {
    controller.abort();
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { text: decodeUtf8(bytes), bytes };
  } catch {
    throw new OpenClawRequestError("invalid-utf8");
  }
}

function cloneSnapshot(snapshot: OpenClawCacheSnapshot): OpenClawCacheSnapshot {
  return {
    feed: parseOpenClawFeed(snapshot.body, { checkExpiry: false }),
    body: snapshot.body,
    bytes: snapshot.bytes.slice(),
    sha256: snapshot.sha256,
    etag: snapshot.etag,
    ...(snapshot.transportEtag === undefined ? {} : { transportEtag: snapshot.transportEtag }),
    ...(snapshot.lastModified === undefined ? {} : { lastModified: snapshot.lastModified }),
    acceptedAt: snapshot.acceptedAt,
    sourceUrl: snapshot.sourceUrl,
  };
}

function classifyFeedError(error: unknown): OpenClawFeedErrorCode {
  if (error instanceof OpenClawValidationError) {
    if (error.message.includes("sequence")) {
      return "replay";
    }
    if (error.message.includes("UTF-8")) {
      return "invalid-utf8";
    }
  }
  return "invalid-feed";
}

function classifyRequestError(
  error: unknown,
  signal: AbortSignal | undefined,
  controllerSignal: AbortSignal,
  deadline: number,
  now: number,
): OpenClawFeedErrorCode {
  if (error instanceof OpenClawRequestError) {
    return error.code;
  }
  if (signal?.aborted) {
    return "aborted";
  }
  if (now >= deadline || controllerSignal.aborted) {
    return "timeout";
  }
  return "fetch-failed";
}

function readBoundedHeader(value: string | null): string | undefined | "invalid" {
  if (value === null || value === "") {
    return undefined;
  }
  if (utf8Bytes(value).byteLength > MAX_HEADER_BYTES || /[\r\n]/u.test(value)) {
    return "invalid";
  }
  return value;
}

function matchesExpectedSha256(actual: string, expected: string): boolean {
  const normalized = expected.startsWith("sha256:") ? expected : `sha256:${expected}`;
  return /^sha256:[0-9a-f]{64}$/u.test(normalized) && normalized === actual;
}

function isSupportedCompatibilityRequest(
  url: URL,
  expectedFeedId: string,
  profile: OpenClawFeedCompatibilityProfile | undefined,
): boolean {
  // The producer's alternate id is reserved for the explicit profile. This
  // prevents a caller from accidentally reusing it with another origin or
  // from treating it as an alias for the pinned `clawhub-official` id.
  if (profile === undefined) return expectedFeedId !== OPENCLAW_CLAWHUB_SKILLS_FEED_ID;
  return profile === OPENCLAW_CLAWHUB_SKILLS_COMPATIBILITY_PROFILE &&
    isOpenClawClawHubSkillsCompatibilityIdentity(expectedFeedId, url);
}

function isCompatibleFeedWithinBounds(
  feed: OpenClawFeed,
  url: URL,
  profile: OpenClawFeedCompatibilityProfile | undefined,
  now: number,
): boolean {
  if (profile === undefined) return true;
  if (!isSupportedCompatibilityRequest(url, feed.id, profile)) return false;
  const generatedAt = Date.parse(feed.generatedAt);
  const expiresAt = Date.parse(feed.expiresAt);
  const effectiveExpiry = effectiveOpenClawFeedExpiry(feed, url);
  return Number.isFinite(generatedAt) &&
    generatedAt <= now &&
    Number.isFinite(expiresAt) &&
    expiresAt > generatedAt &&
    expiresAt - generatedAt <= OPENCLAW_CLAWHUB_SKILLS_MAX_TTL_MS &&
    Number.isFinite(effectiveExpiry) &&
    effectiveExpiry > now;
}

function matchesResponseEtag(
  value: string,
  digest: string,
  url: URL,
  profile: OpenClawFeedCompatibilityProfile | undefined,
): boolean {
  if (value === `"${digest}"`) return true;
  if (
    profile === OPENCLAW_CLAWHUB_SKILLS_COMPATIBILITY_PROFILE &&
    isOpenClawClawHubSkillsCompatibilityIdentity(OPENCLAW_CLAWHUB_SKILLS_FEED_ID, url)
  ) {
    return value === `"${digest}-gzip"` || value === `W/"${digest}-gzip"`;
  }
  return false;
}

function forwardAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) {
    return () => undefined;
  }
  if (signal.aborted) {
    controller.abort();
    return () => undefined;
  }
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

function waitUntil(deadline: number, kind: "timeout"): CancellablePromise<never> {
  const delay = Math.max(0, deadline - Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel = () => undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new OpenClawRequestError(kind)), delay);
    cancel = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }) as CancellablePromise<never>;
  promise.cancel = cancel;
  return promise;
}

function waitForAbort(signal: AbortSignal): CancellablePromise<never> {
  let cancel: () => void = () => undefined;
  const promise = new Promise<never>((_, reject) => {
    const onAbort = () => reject(new OpenClawRequestError("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    cancel = () => signal.removeEventListener("abort", onAbort);
  }) as CancellablePromise<never>;
  promise.cancel = cancel;
  return promise;
}

type CancellablePromise<T> = Promise<T> & { cancel: () => void };

function boundedBodyLimit(value: number | undefined): number {
  const max = value ?? OPENCLAW_DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(max) || max <= 0 || max > OPENCLAW_MAX_BODY_BYTES) {
    throw new OpenClawValidationError("feed body limit is outside the supported bounds");
  }
  return max;
}

function boundedTimeout(value: number | undefined): number {
  const timeout = value ?? OPENCLAW_DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > OPENCLAW_MAX_TIMEOUT_MS) {
    throw new OpenClawValidationError("feed timeout is outside the supported bounds");
  }
  return timeout;
}

function boundedStaleLimit(value: number | undefined): number {
  const max = value ?? OPENCLAW_DEFAULT_MAX_STALE_MS;
  if (!Number.isSafeInteger(max) || max < 0 || max > OPENCLAW_MAX_STALE_MS) {
    throw new OpenClawValidationError("feed stale retention is outside the supported bounds");
  }
  return max;
}
