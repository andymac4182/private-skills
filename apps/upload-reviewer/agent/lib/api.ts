import { registryEndpoint, uploadReviewToken } from './config.js';

const REQUEST_TIMEOUT_MS = 45_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES = 1_500_000;

type JsonParser<T> = (value: unknown) => T;

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
): Promise<T> {
  const encoded = JSON.stringify(body);
  if (new TextEncoder().encode(encoded).byteLength > MAX_REQUEST_BYTES) throw new Error('upload reviewer request exceeded the bounded size');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(registryEndpoint(path), {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${uploadReviewToken()}`,
        'content-type': 'application/json',
      },
      body: encoded,
      redirect: 'error',
      signal: controller.signal,
    });
    const text = await readBoundedText(response);
    if (!response.ok) throw new Error(`upload reviewer API returned HTTP ${response.status}`);
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
