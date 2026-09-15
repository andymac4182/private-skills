import { STRIPE_API_VERSION } from './types.js';

export class BillingWebhookError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'BillingWebhookError';
    this.code = code;
  }
}

export interface VerifyWebhookOptions {
  now?: () => number;
  toleranceSeconds?: number;
}

export interface VerifiedWebhookSignature {
  timestamp: number;
  /** This is a diagnostic value only; callers must still process the raw body. */
  apiVersion: typeof STRIPE_API_VERSION;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function fromHex(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/iu.test(value)) throw new BillingWebhookError('INVALID_SIGNATURE', 'webhook signature is invalid');
  const result = new Uint8Array(32);
  for (let index = 0; index < result.length; index += 1) result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return result;
}

function parseSignatureHeader(value: string): { timestamp: number; signatures: string[] } {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16_384) throw new BillingWebhookError('INVALID_SIGNATURE', 'webhook signature is missing');
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const segment of value.split(',')) {
    const separator = segment.indexOf('=');
    if (separator <= 0) throw new BillingWebhookError('INVALID_SIGNATURE', 'webhook signature is malformed');
    const key = segment.slice(0, separator).trim();
    const raw = segment.slice(separator + 1).trim();
    if (key === 't') {
      if (timestamp !== undefined || !/^\d+$/u.test(raw)) throw new BillingWebhookError('INVALID_SIGNATURE', 'webhook timestamp is malformed');
      const parsed = Number(raw);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new BillingWebhookError('INVALID_SIGNATURE', 'webhook timestamp is malformed');
      timestamp = parsed;
    } else if (key === 'v1') {
      if (raw.length !== 64 || !/^[0-9a-f]+$/iu.test(raw)) throw new BillingWebhookError('INVALID_SIGNATURE', 'webhook signature is malformed');
      signatures.push(raw.toLowerCase());
    }
  }
  if (timestamp === undefined || signatures.length === 0) throw new BillingWebhookError('INVALID_SIGNATURE', 'webhook signature is missing');
  return { timestamp, signatures };
}

function ensureSecret(secret: string): string {
  if (typeof secret !== 'string' || secret.length < 16 || secret.length > 512 || /[\u0000-\u001f\u007f]/u.test(secret)) {
    throw new BillingWebhookError('INVALID_CONFIGURATION', 'webhook signing secret is invalid');
  }
  return secret;
}

async function sign(timestamp: number, rawBody: string, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signed = `${timestamp}.${rawBody}`;
  const result = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signed));
  return new Uint8Array(result);
}

async function verify(timestamp: number, rawBody: string, secret: string, candidate: Uint8Array): Promise<boolean> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const signed = `${timestamp}.${rawBody}`;
  // Delegate the comparison to the platform Web Crypto primitive.  Keeping
  // the candidate at the provider's fixed HMAC length also prevents a
  // malformed header from reaching a provider-specific coercion path.
  const signature = new Uint8Array(candidate.byteLength);
  signature.set(candidate);
  return crypto.subtle.verify('HMAC', key, signature.buffer, new TextEncoder().encode(signed));
}

/** Create a Stripe-compatible signature for local/test fixtures. */
export async function signWebhookPayload(rawBody: string, secret: string, timestamp = Math.floor(Date.now() / 1_000)): Promise<string> {
  if (typeof rawBody !== 'string') throw new BillingWebhookError('INVALID_BODY', 'webhook body must be a raw string');
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new BillingWebhookError('INVALID_TIMESTAMP', 'webhook timestamp is invalid');
  const signature = await sign(timestamp, rawBody, ensureSecret(secret));
  return `t=${timestamp},v1=${hex(signature)}`;
}

/**
 * Verify the Stripe-Signature header against the exact raw UTF-8 request body.
 * Timestamp tolerance is checked before event parsing to reject replays.
 */
export async function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
  options: VerifyWebhookOptions = {},
): Promise<VerifiedWebhookSignature> {
  if (typeof rawBody !== 'string' || rawBody.length === 0 || new TextEncoder().encode(rawBody).byteLength > 10 * 1024 * 1024) throw new BillingWebhookError('INVALID_BODY', 'webhook body is invalid');
  const parsed = parseSignatureHeader(signatureHeader);
  const tolerance = options.toleranceSeconds ?? 300;
  if (!Number.isSafeInteger(tolerance) || tolerance <= 0 || tolerance > 86_400) throw new BillingWebhookError('INVALID_CONFIGURATION', 'webhook tolerance is invalid');
  const nowSeconds = Math.floor((options.now ?? Date.now)() / 1_000);
  if (!Number.isSafeInteger(nowSeconds) || Math.abs(nowSeconds - parsed.timestamp) > tolerance) throw new BillingWebhookError('REPLAY_REJECTED', 'webhook timestamp is outside the replay window');
  const normalizedSecret = ensureSecret(secret);
  const matches = await Promise.all(parsed.signatures.map(async (candidate) => {
    try {
      return await verify(parsed.timestamp, rawBody, normalizedSecret, fromHex(candidate));
    } catch {
      return false;
    }
  })).then((results) => results.some(Boolean));
  if (!matches) throw new BillingWebhookError('INVALID_SIGNATURE', 'webhook signature does not match');
  return { timestamp: parsed.timestamp, apiVersion: STRIPE_API_VERSION };
}
