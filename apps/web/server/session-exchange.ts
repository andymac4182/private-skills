const MAX_SESSION_EXCHANGE_BODY_BYTES = 8 * 1024;

/**
 * Read the token from a session-exchange body without consuming the request
 * that the core handler will parse. The bounded tee also prevents a caller
 * from making tenant selection allocate an arbitrary request body first.
 */
export async function readSessionExchangeToken(request: Request): Promise<string | undefined> {
  const declaredLength = request.headers.get('content-length');
  if (
    declaredLength !== null &&
    Number.isFinite(Number(declaredLength)) &&
    Number(declaredLength) > MAX_SESSION_EXCHANGE_BODY_BYTES
  ) return undefined;
  try {
    const clone = request.clone();
    let bytes: Uint8Array;
    if (!clone.body) {
      bytes = new Uint8Array(await clone.arrayBuffer());
    } else {
      const reader = clone.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          total += next.value.byteLength;
          if (total > MAX_SESSION_EXCHANGE_BODY_BYTES) {
            // The original request branch is intentionally still available
            // for core. A tee cancellation may wait for that branch, so start
            // it without making tenant selection wait on an untrusted stream.
            void reader.cancel().catch(() => undefined);
            return undefined;
          }
          chunks.push(next.value);
        }
      } finally {
        reader.releaseLock();
      }
      bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
    const value = (body as { token?: unknown }).token;
    if (typeof value !== 'string') return undefined;
    const token = value.trim();
    return token.length >= 20 && token.length <= 512 ? token : undefined;
  } catch {
    return undefined;
  }
}
