/**
 * Small, dependency-free HTTP boundary shared by the disposable M6 stubs.
 *
 * The registry is a local process during this fixture, but it is still an
 * HTTP boundary. Keep requests finite and response materialization bounded so
 * a stalled or malformed registry cannot leave a browser run hanging or grow
 * the fixture process without limit.
 */
export const LOCAL_REGISTRY_REQUEST_TIMEOUT_MS = 8_000;
export const LOCAL_REGISTRY_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

class LocalRegistryHttpError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LocalRegistryHttpError';
  }
}

function boundedOption(value, fallback, label) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > fallback) {
    throw new LocalRegistryHttpError(`${label} is outside the bounded range`);
  }
  return value;
}

/**
 * Read a response without ever retaining more than the configured byte limit.
 * Error messages intentionally contain no URL, headers, or upstream body.
 */
export async function readBoundedResponseText(response, maxBytes = LOCAL_REGISTRY_MAX_RESPONSE_BYTES) {
  const limit = boundedOption(maxBytes, LOCAL_REGISTRY_MAX_RESPONSE_BYTES, 'response limit');
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
      throw new LocalRegistryHttpError('registry response has an invalid content length');
    }
    if (declaredLength > limit) {
      try { await response.body?.cancel(); } catch { /* the bounded error is authoritative */ }
      throw new LocalRegistryHttpError('registry response exceeded the bounded size');
    }
  }

  if (!response.body) {
    // A fetch-backed HTTP response normally has a stream. Treat a missing
    // body as empty so the JSON layer returns the same sanitized schema error.
    return '';
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limit) {
        try { await reader.cancel(); } catch { /* the bounded error is authoritative */ }
        throw new LocalRegistryHttpError('registry response exceeded the bounded size');
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof LocalRegistryHttpError) throw error;
    throw new LocalRegistryHttpError('registry response could not be read');
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
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new LocalRegistryHttpError('registry response was not valid UTF-8');
  }
}

/**
 * Fetch a JSON response with an eight-second default timeout and bounded body.
 * The response is returned alongside the parsed value because the reviewer
 * fixture uses status codes for its narrow, bounded retry policy.
 */
export async function requestBoundedJson(url, init = {}, options = {}) {
  const timeoutMs = boundedOption(options.timeoutMs, LOCAL_REGISTRY_REQUEST_TIMEOUT_MS, 'request timeout');
  const maxBytes = boundedOption(options.maxBytes, LOCAL_REGISTRY_MAX_RESPONSE_BYTES, 'response limit');
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const externalSignal = init.signal;
  const abort = () => controller.abort();
  if (externalSignal?.aborted) abort();
  else externalSignal?.addEventListener('abort', abort, { once: true });

  try {
    let response;
    try {
      response = await fetch(url, { ...init, signal: controller.signal });
    } catch {
      throw new LocalRegistryHttpError(timedOut ? 'registry request timed out' : 'registry request failed');
    }

    const text = await readBoundedResponseText(response, maxBytes);
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      throw new LocalRegistryHttpError('registry response was not valid JSON');
    }
    return { response, value };
  } catch (error) {
    if (timedOut) throw new LocalRegistryHttpError('registry request timed out');
    if (error instanceof LocalRegistryHttpError) throw error;
    throw new LocalRegistryHttpError('registry request failed');
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', abort);
  }
}
