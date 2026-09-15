import { describe, expect, it } from 'vitest';

import { readSessionExchangeToken } from '../server/session-exchange.js';

function streamRequest(chunks: readonly string[]): Request {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Request('https://registry.example.test/auth/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
}

describe('session exchange body reader', () => {
  it('reads a chunked token from a clone and leaves the original body available', async () => {
    const request = streamRequest(['{"token":"issued-', 'api-token-with-enough-length"}']);
    expect(await readSessionExchangeToken(request)).toBe('issued-api-token-with-enough-length');
    await expect(request.json()).resolves.toEqual({ token: 'issued-api-token-with-enough-length' });
  });

  it('rejects an oversized chunked body before retaining it', async () => {
    const request = streamRequest(['{"token":"issued-api-token-with-enough-length", "padding":"', 'x'.repeat(9_000), '"}']);
    expect(await readSessionExchangeToken(request)).toBeUndefined();
    await expect(request.json()).resolves.toMatchObject({ token: 'issued-api-token-with-enough-length' });
  });
});
