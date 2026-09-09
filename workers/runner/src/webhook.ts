import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export type WebhookMode = 'disabled' | 'advisory' | 'required';

export interface WebhookGateConfig {
  id: string;
  url: string;
  secret: string;
  mode: WebhookMode;
  timeoutSeconds: number;
  /** Permit HTTP only for explicit loopback development tests. */
  allowInsecureLoopback?: boolean;
  maxResponseBytes?: number;
}

export interface WebhookPayload {
  eventId: string;
  organizationId: string;
  jobId: string;
  attempt: number;
  artifactDigest: string;
  policyRevision: string;
  deadline: string;
  nonce: string;
  event: 'artifact.evaluate' | 'ingest.validate' | 'pack.evaluate';
  metadata?: Record<string, unknown>;
}

export interface WebhookResponse {
  accepted: boolean;
  jobId: string;
  artifactDigest: string;
  policyRevision: string;
  eventId?: string;
  reason?: string;
}

export interface WebhookResult {
  configId: string;
  mode: WebhookMode;
  status: 'disabled' | 'accepted' | 'rejected' | 'timeout' | 'error';
  response?: WebhookResponse;
  error?: string;
  eventId: string;
}

export async function invokeWebhookGate(
  config: WebhookGateConfig,
  payload: Omit<WebhookPayload, 'eventId' | 'nonce' | 'deadline'> & Partial<Pick<WebhookPayload, 'eventId' | 'nonce' | 'deadline'>>,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<WebhookResult> {
  const eventId = payload.eventId ?? randomUUID();
  if (config.mode === 'disabled') return { configId: config.id, mode: config.mode, status: 'disabled', eventId };
  let url: string;
  try {
    url = validateWebhookUrl(config.url, config.allowInsecureLoopback === true);
  } catch (error) {
    return { configId: config.id, mode: config.mode, status: 'error', error: sanitize(error), eventId };
  }
  if (!config.secret || config.secret.length < 16) {
    return { configId: config.id, mode: config.mode, status: 'error', error: 'webhook secret is too short', eventId };
  }
  const timeoutMs = Math.max(1, config.timeoutSeconds) * 1000;
  const deadline = payload.deadline ?? new Date(Date.now() + timeoutMs).toISOString();
  const nonce = payload.nonce ?? randomUUID();
  const body: WebhookPayload = { ...payload, eventId, nonce, deadline };
  const bodyText = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac('sha256', config.secret).update(`${timestamp}.${bodyText}`).digest('hex');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await (options.fetch ?? fetch)(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Private-Skills-Event-Id': eventId,
        'X-Private-Skills-Timestamp': timestamp,
        'X-Private-Skills-Nonce': nonce,
        'X-Private-Skills-Signature': `sha256=${signature}`,
      },
      body: bodyText,
      redirect: 'error',
      signal: controller.signal,
    });
    const text = await readBoundedText(response, config.maxResponseBytes ?? 64 * 1024);
    if (!response.ok) return { configId: config.id, mode: config.mode, status: 'rejected', error: `webhook returned HTTP ${response.status}`, eventId };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return { configId: config.id, mode: config.mode, status: 'error', error: 'webhook response was not JSON', eventId };
    }
    const result = validateWebhookResponse(parsed, body);
    if (!result.ok) return { configId: config.id, mode: config.mode, status: 'rejected', error: result.error, eventId };
    return { configId: config.id, mode: config.mode, status: result.value.accepted ? 'accepted' : 'rejected', response: result.value, eventId, ...(result.value.reason ? { error: result.value.reason } : {}) };
  } catch (error) {
    if (controller.signal.aborted) return { configId: config.id, mode: config.mode, status: 'timeout', error: 'webhook timed out', eventId };
    return { configId: config.id, mode: config.mode, status: 'error', error: sanitize(error), eventId };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}

export async function invokeWebhookGates(
  configs: WebhookGateConfig[],
  payload: Omit<WebhookPayload, 'eventId' | 'nonce' | 'deadline'> & Partial<Pick<WebhookPayload, 'eventId' | 'nonce' | 'deadline'>>,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<{ allow: boolean; results: WebhookResult[] }> {
  const results: WebhookResult[] = [];
  for (const config of configs) {
    results.push(await invokeWebhookGate(config, payload, options));
  }
  return {
    allow: results.every((result) => result.mode !== 'required' || result.status === 'accepted'),
    results,
  };
}

export function validateWebhookUrl(raw: string, allowInsecureLoopback = false): string {
  const url = new URL(raw);
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(allowInsecureLoopback && loopback && url.protocol === 'http:')) {
    throw new Error('webhook URL must use HTTPS');
  }
  if (url.username || url.password) throw new Error('webhook URL cannot contain credentials');
  if (url.hash) throw new Error('webhook URL cannot contain a fragment');
  return url.toString();
}

export function verifyWebhookSignature(secret: string, timestamp: string, body: string, supplied: string): boolean {
  const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  const actual = supplied.replace(/^sha256=/, '');
  if (!/^[0-9a-f]{64}$/i.test(actual)) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
}

function validateWebhookResponse(value: unknown, request: WebhookPayload): { ok: true; value: WebhookResponse } | { ok: false; error: string } {
  if (!isObject(value) || typeof value.accepted !== 'boolean' || value.jobId !== request.jobId || value.artifactDigest !== request.artifactDigest || value.policyRevision !== request.policyRevision) {
    return { ok: false, error: 'webhook response binding mismatch or missing accepted field' };
  }
  return { ok: true, value: { accepted: value.accepted, jobId: value.jobId, artifactDigest: value.artifactDigest, policyRevision: value.policyRevision, eventId: typeof value.eventId === 'string' ? value.eventId : undefined, reason: typeof value.reason === 'string' ? value.reason.slice(0, 2048) : undefined } };
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared && Number.isFinite(Number(declared)) && Number(declared) > maxBytes) {
    throw new Error('webhook response exceeds limit');
  }
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('webhook response exceeds limit');
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
      if (total > maxBytes) throw new Error('webhook response exceeds limit');
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
  return new TextDecoder().decode(bytes);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitize(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 2048);
}
