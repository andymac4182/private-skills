import {
  STRIPE_API_VERSION,
  type CreateCheckoutSessionInput,
  type CreateCustomerInput,
  type CreateCustomerPortalSessionInput,
  type HostedBillingSession,
  type BillingProviderInvoice,
  type ListInvoicesInput,
  type ProviderCustomer,
} from './types.js';

export class StripeBillingError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(code: string, message: string, options: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = 'StripeBillingError';
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

export interface StripeBillingAdapterOptions {
  secretKey: string;
  apiBaseUrl?: string;
  apiVersion?: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}

export interface BillingProviderAdapter {
  readonly id: 'stripe' | 'local';
  readonly mode: 'test' | 'live';
  createCustomer(input: CreateCustomerInput): Promise<ProviderCustomer>;
  createCheckoutSession(input: CreateCheckoutSessionInput): Promise<HostedBillingSession>;
  createCustomerPortalSession(input: CreateCustomerPortalSessionInput): Promise<HostedBillingSession>;
  listInvoices?(input: ListInvoicesInput): Promise<readonly BillingProviderInvoice[]>;
}

function bounded(value: unknown, field: string, max = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new StripeBillingError('INVALID_INPUT', `${field} is invalid`);
  return value;
}

function trustedUrl(value: unknown, field: string): string {
  const text = bounded(value, field, 2_048);
  let parsed: URL;
  try { parsed = new URL(text); } catch { throw new StripeBillingError('INVALID_INPUT', `${field} is invalid`); }
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') throw new StripeBillingError('INVALID_INPUT', `${field} must use HTTPS`);
  if (parsed.username || parsed.password) throw new StripeBillingError('INVALID_INPUT', `${field} must not contain credentials`);
  return parsed.toString();
}

function formValue(value: string): string {
  return value;
}

function responseObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StripeBillingError('INVALID_RESPONSE', 'Stripe returned an invalid response');
  return value as Record<string, unknown>;
}

function responseId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) throw new StripeBillingError('INVALID_RESPONSE', `Stripe response ${field} is invalid`);
  return value;
}

function responseUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096) throw new StripeBillingError('INVALID_RESPONSE', 'Stripe session URL is invalid');
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new StripeBillingError('INVALID_RESPONSE', 'Stripe session URL is invalid'); }
  if (parsed.protocol !== 'https:') throw new StripeBillingError('INVALID_RESPONSE', 'Stripe session URL is invalid');
  return parsed.toString();
}

function keyMode(secretKey: string): 'test' | 'live' {
  if (secretKey.startsWith('sk_test_')) return 'test';
  if (secretKey.startsWith('sk_live_')) return 'live';
  throw new StripeBillingError('INVALID_CONFIGURATION', 'Stripe secret key must be a test or live key');
}

function responseOptionalId(value: unknown, field: string, max = 256): string | undefined {
  if (value === undefined || value === null) return undefined;
  return responseIdBounded(value, field, max);
}

function responseIdBounded(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new StripeBillingError('INVALID_RESPONSE', `Stripe response ${field} is invalid`);
  return value;
}

function responseEpoch(value: unknown, field: string, required = false): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new StripeBillingError('INVALID_RESPONSE', `Stripe response ${field} is invalid`);
    return undefined;
  }
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new StripeBillingError('INVALID_RESPONSE', `Stripe response ${field} is invalid`);
  const date = new Date((value as number) * 1_000);
  if (!Number.isFinite(date.getTime())) throw new StripeBillingError('INVALID_RESPONSE', `Stripe response ${field} is invalid`);
  return date.toISOString();
}

function responseAmount(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new StripeBillingError('INVALID_RESPONSE', `Stripe response ${field} is invalid`);
  return value as number;
}

function responseInvoiceStatus(value: unknown): BillingProviderInvoice['status'] {
  if (value === 'draft' || value === 'open' || value === 'paid' || value === 'uncollectible' || value === 'void') return value;
  return 'unknown';
}

function responseInvoiceUrl(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096) throw new StripeBillingError('INVALID_RESPONSE', `Stripe response ${field} is invalid`);
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new StripeBillingError('INVALID_RESPONSE', `Stripe response ${field} is invalid`); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new StripeBillingError('INVALID_RESPONSE', `Stripe response ${field} is invalid`);
  return parsed.toString();
}

function parseStripeInvoice(value: unknown, expectedCustomerId: string): BillingProviderInvoice {
  const invoice = responseObject(value);
  const invoiceId = responseIdBounded(invoice.id, 'invoice id', 256);
  const customer = invoice.customer;
  const customerId = responseIdBounded(
    typeof customer === 'string' ? customer : responseObject(customer).id,
    'invoice customer id',
    256,
  );
  if (customerId !== expectedCustomerId) throw new StripeBillingError('INVALID_RESPONSE', 'Stripe invoice customer does not match the requested customer');
  const statusTransitions = invoice.status_transitions === undefined || invoice.status_transitions === null
    ? undefined
    : responseObject(invoice.status_transitions);
  const currency = invoice.currency === undefined || invoice.currency === null ? undefined : invoice.currency;
  if (currency !== undefined && (typeof currency !== 'string' || !/^[A-Za-z]{3}$/u.test(currency))) throw new StripeBillingError('INVALID_RESPONSE', 'Stripe response invoice currency is invalid');
  const number = responseOptionalId(invoice.number, 'invoice number', 128);
  const createdAt = responseEpoch(invoice.created, 'invoice created', true)!;
  const periodStart = responseEpoch(invoice.period_start, 'invoice period start');
  const periodEnd = responseEpoch(invoice.period_end, 'invoice period end');
  const amountDueCents = responseAmount(invoice.amount_due, 'invoice amount due');
  const amountPaidCents = responseAmount(invoice.amount_paid, 'invoice amount paid');
  const paidAt = responseEpoch(statusTransitions?.paid_at, 'invoice paid at');
  const hostedInvoiceUrl = responseInvoiceUrl(invoice.hosted_invoice_url, 'hosted invoice URL');
  const invoicePdfUrl = responseInvoiceUrl(invoice.invoice_pdf, 'invoice PDF URL');
  if (periodStart !== undefined && periodEnd !== undefined && Date.parse(periodEnd) <= Date.parse(periodStart)) throw new StripeBillingError('INVALID_RESPONSE', 'Stripe response invoice period is invalid');
  return {
    provider: 'stripe',
    invoiceId,
    customerId,
    status: responseInvoiceStatus(invoice.status),
    ...(amountDueCents === undefined ? {} : { amountDueCents }),
    ...(amountPaidCents === undefined ? {} : { amountPaidCents }),
    ...(currency === undefined ? {} : { currency: currency.toLowerCase() }),
    ...(number === undefined ? {} : { number }),
    createdAt,
    ...(paidAt === undefined ? {} : { paidAt }),
    ...(periodStart === undefined ? {} : { periodStart }),
    ...(periodEnd === undefined ? {} : { periodEnd }),
    ...(hostedInvoiceUrl === undefined ? {} : { hostedInvoiceUrl }),
    ...(invoicePdfUrl === undefined ? {} : { invoicePdfUrl }),
  };
}

/**
 * Minimal Stripe REST adapter. It keeps provider credentials behind this
 * boundary and avoids making the Stripe SDK a dependency of portable code.
 */
export class StripeBillingAdapter implements BillingProviderAdapter {
  readonly id = 'stripe' as const;
  readonly mode: 'test' | 'live';
  private readonly secretKey: string;
  private readonly apiBaseUrl: string;
  private readonly apiVersion: string;
  private readonly fetcher: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(options: StripeBillingAdapterOptions) {
    this.secretKey = bounded(options.secretKey, 'Stripe secret key', 512);
    this.mode = keyMode(this.secretKey);
    const base = options.apiBaseUrl ?? 'https://api.stripe.com';
    let parsed: URL;
    try { parsed = new URL(base); } catch { throw new StripeBillingError('INVALID_CONFIGURATION', 'Stripe API base URL is invalid'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) throw new StripeBillingError('INVALID_CONFIGURATION', 'Stripe API base URL must be HTTPS without credentials');
    this.apiBaseUrl = parsed.toString().replace(/\/$/u, '');
    this.apiVersion = bounded(options.apiVersion ?? STRIPE_API_VERSION, 'Stripe API version', 128);
    this.fetcher = options.fetch ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs <= 0 || this.requestTimeoutMs > 120_000) throw new StripeBillingError('INVALID_CONFIGURATION', 'Stripe request timeout is invalid');
  }

  private async post(path: string, form: URLSearchParams, idempotencyKey: string): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetcher(`${this.apiBaseUrl}${path}`, {
          method: 'POST',
          redirect: 'error',
          headers: {
            authorization: `Bearer ${this.secretKey}`,
            'content-type': 'application/x-www-form-urlencoded',
            'stripe-version': this.apiVersion,
            'idempotency-key': bounded(idempotencyKey, 'idempotency key', 255),
          },
          body: form.toString(),
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) throw new StripeBillingError('PROVIDER_TIMEOUT', 'Stripe request timed out', { retryable: true });
        throw new StripeBillingError('PROVIDER_UNAVAILABLE', 'Stripe request could not be completed', { retryable: true });
      }
      let payload: unknown = undefined;
      try { payload = await response.json(); } catch { /* handled by generic response error */ }
      if (!response.ok) {
        const errorObject = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>).error : undefined;
        const type = errorObject && typeof errorObject === 'object' ? (errorObject as Record<string, unknown>).type : undefined;
        throw new StripeBillingError(type === 'idempotency_error' ? 'PROVIDER_IDEMPOTENCY' : 'PROVIDER_ERROR', 'Stripe rejected the billing request', { status: response.status, retryable: response.status === 409 || response.status === 429 || response.status >= 500 });
      }
      return responseObject(payload);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async get(path: string): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetcher(`${this.apiBaseUrl}${path}`, {
          method: 'GET',
          redirect: 'error',
          headers: {
            authorization: `Bearer ${this.secretKey}`,
            'stripe-version': this.apiVersion,
          },
          signal: controller.signal,
        });
      } catch {
        if (controller.signal.aborted) throw new StripeBillingError('PROVIDER_TIMEOUT', 'Stripe request timed out', { retryable: true });
        throw new StripeBillingError('PROVIDER_UNAVAILABLE', 'Stripe request could not be completed', { retryable: true });
      }
      let payload: unknown = undefined;
      try { payload = await response.json(); } catch { /* handled by generic response error */ }
      if (!response.ok) {
        const errorObject = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>).error : undefined;
        const type = errorObject && typeof errorObject === 'object' ? (errorObject as Record<string, unknown>).type : undefined;
        throw new StripeBillingError(type === 'idempotency_error' ? 'PROVIDER_IDEMPOTENCY' : 'PROVIDER_ERROR', 'Stripe rejected the billing request', { status: response.status, retryable: response.status === 409 || response.status === 429 || response.status >= 500 });
      }
      return responseObject(payload);
    } finally {
      clearTimeout(timeout);
    }
  }

  async createCustomer(input: CreateCustomerInput): Promise<ProviderCustomer> {
    const organizationId = bounded(input.organizationId, 'organizationId', 256);
    const form = new URLSearchParams();
    form.set('metadata[organization_id]', formValue(organizationId));
    if (input.email !== undefined) form.set('email', bounded(input.email, 'email', 320));
    const payload = await this.post('/v1/customers', form, input.idempotencyKey);
    return { provider: 'stripe', customerId: responseId(payload.id, 'customer id') };
  }

  async createCheckoutSession(input: CreateCheckoutSessionInput): Promise<HostedBillingSession> {
    const form = new URLSearchParams();
    form.set('mode', 'subscription');
    form.set('line_items[0][price]', bounded(input.priceId, 'priceId', 256));
    form.set('line_items[0][quantity]', '1');
    form.set('customer', bounded(input.customerId, 'customerId', 256));
    form.set('client_reference_id', `private-skills:${bounded(input.organizationId, 'organizationId', 256)}`);
    form.set('metadata[organization_id]', bounded(input.organizationId, 'organizationId', 256));
    form.set('metadata[plan_id]', bounded(input.planId, 'planId', 64));
    form.set('subscription_data[metadata][organization_id]', bounded(input.organizationId, 'organizationId', 256));
    form.set('subscription_data[metadata][plan_id]', bounded(input.planId, 'planId', 64));
    form.set('success_url', trustedUrl(input.successUrl, 'successUrl'));
    form.set('cancel_url', trustedUrl(input.cancelUrl, 'cancelUrl'));
    const payload = await this.post('/v1/checkout/sessions', form, input.idempotencyKey);
    return {
      provider: 'stripe',
      mode: this.mode,
      id: responseId(payload.id, 'checkout session id'),
      url: responseUrl(payload.url),
      ...(typeof payload.expires_at === 'number' && Number.isFinite(payload.expires_at) ? { expiresAt: new Date(payload.expires_at * 1_000).toISOString() } : {}),
    };
  }

  async createCustomerPortalSession(input: CreateCustomerPortalSessionInput): Promise<HostedBillingSession> {
    const form = new URLSearchParams();
    form.set('customer', bounded(input.customerId, 'customerId', 256));
    form.set('return_url', trustedUrl(input.returnUrl, 'returnUrl'));
    const payload = await this.post('/v1/billing_portal/sessions', form, input.idempotencyKey);
    return {
      provider: 'stripe',
      mode: this.mode,
      id: responseId(payload.id, 'portal session id'),
      url: responseUrl(payload.url),
    };
  }

  async listInvoices(input: ListInvoicesInput): Promise<readonly BillingProviderInvoice[]> {
    if (!input || typeof input !== 'object') throw new StripeBillingError('INVALID_INPUT', 'invoice lookup is invalid');
    const customerId = bounded(input.customerId, 'customerId', 256);
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new StripeBillingError('INVALID_INPUT', 'invoice limit is invalid');
    const query = new URLSearchParams({ customer: customerId, limit: String(limit) });
    const payload = await this.get(`/v1/invoices?${query.toString()}`);
    if (!Array.isArray(payload.data) || payload.data.length > limit) throw new StripeBillingError('INVALID_RESPONSE', 'Stripe invoice history is invalid');
    return payload.data.map((invoice) => parseStripeInvoice(invoice, customerId));
  }
}

export interface LocalBillingAdapterOptions {
  baseUrl?: string;
}

export type LocalBillingTestSessionStatus = 'open' | 'completed';

export interface LocalBillingTestCheckoutSession {
  kind: 'checkout';
  id: string;
  organizationId: string;
  customerId: string;
  planId: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  status: LocalBillingTestSessionStatus;
}

export interface LocalBillingTestPortalSession {
  kind: 'portal';
  id: string;
  organizationId: string;
  customerId: string;
  returnUrl: string;
  status: LocalBillingTestSessionStatus;
}

export type LocalBillingTestSession = LocalBillingTestCheckoutSession | LocalBillingTestPortalSession;

/**
 * Explicitly test-only provider. It creates no remote customer, product, or
 * charge. A caller must still feed a signed fixture through the webhook path
 * before any paid entitlement becomes active.
 */
export class LocalBillingAdapter implements BillingProviderAdapter {
  readonly id = 'local' as const;
  readonly mode = 'test' as const;
  private readonly baseUrl: string;
  private readonly customers = new Map<string, string>();
  private readonly sessions = new Map<string, LocalBillingTestSession>();

  constructor(options: LocalBillingAdapterOptions = {}) {
    const base = options.baseUrl ?? 'http://localhost:5173';
    let parsed: URL;
    try { parsed = new URL(base); } catch { throw new StripeBillingError('INVALID_CONFIGURATION', 'local billing base URL is invalid'); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new StripeBillingError('INVALID_CONFIGURATION', 'local billing base URL is invalid');
    this.baseUrl = parsed.toString().replace(/\/$/u, '');
  }

  async createCustomer(input: CreateCustomerInput): Promise<ProviderCustomer> {
    const organizationId = bounded(input.organizationId, 'organizationId', 256);
    bounded(input.idempotencyKey, 'idempotency key', 255);
    if (input.email !== undefined) bounded(input.email, 'email', 320);
    const existing = this.customers.get(organizationId);
    const customerId = existing ?? `local_cus_${crypto.randomUUID().replaceAll('-', '')}`;
    this.customers.set(organizationId, customerId);
    return { provider: 'local', customerId };
  }

  async createCheckoutSession(input: CreateCheckoutSessionInput): Promise<HostedBillingSession> {
    const organizationId = bounded(input.organizationId, 'organizationId', 256);
    const customerId = bounded(input.customerId, 'customerId', 256);
    const priceId = bounded(input.priceId, 'priceId', 256);
    const planId = bounded(input.planId, 'planId', 64);
    const successUrl = trustedUrl(input.successUrl, 'successUrl');
    const cancelUrl = trustedUrl(input.cancelUrl, 'cancelUrl');
    bounded(input.idempotencyKey, 'idempotency key', 255);
    const id = `local_cs_${crypto.randomUUID().replaceAll('-', '')}`;
    const url = new URL(`${this.baseUrl}/billing/test-checkout`);
    url.searchParams.set('session', id);
    this.rememberSession({ kind: 'checkout', id, organizationId, customerId, planId, priceId, successUrl, cancelUrl, status: 'open' });
    return { provider: 'local', mode: 'test', id, url: url.toString() };
  }

  async createCustomerPortalSession(input: CreateCustomerPortalSessionInput): Promise<HostedBillingSession> {
    const organizationId = bounded(input.organizationId, 'organizationId', 256);
    const customerId = bounded(input.customerId, 'customerId', 256);
    const returnUrl = trustedUrl(input.returnUrl, 'returnUrl');
    bounded(input.idempotencyKey, 'idempotency key', 255);
    const id = `local_bps_${crypto.randomUUID().replaceAll('-', '')}`;
    const url = new URL(`${this.baseUrl}/billing/test-portal`);
    url.searchParams.set('session', id);
    this.rememberSession({ kind: 'portal', id, organizationId, customerId, returnUrl, status: 'open' });
    return { provider: 'local', mode: 'test', id, url: url.toString() };
  }

  /** Server-only lookup used by the local billing demo routes. */
  getTestSession(id: string): LocalBillingTestSession | undefined {
    const session = this.sessions.get(bounded(id, 'session id', 256));
    return session === undefined ? undefined : { ...session };
  }

  /** Mark a completed local checkout after its signed fixture webhook applied. */
  markTestCheckoutCompleted(id: string): LocalBillingTestCheckoutSession {
    const session = this.sessions.get(bounded(id, 'session id', 256));
    if (!session || session.kind !== 'checkout') throw new StripeBillingError('SESSION_NOT_FOUND', 'local checkout session is not available');
    const completed: LocalBillingTestCheckoutSession = { ...session, status: 'completed' };
    this.sessions.set(completed.id, completed);
    return { ...completed };
  }

  async listInvoices(input: ListInvoicesInput): Promise<readonly BillingProviderInvoice[]> {
    bounded(input.customerId, 'customerId', 256);
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new StripeBillingError('INVALID_INPUT', 'invoice limit is invalid');
    // Local mode never creates a remote invoice. Returning an empty, typed
    // history lets the console prove the read-model path without implying a
    // charge or fabricating provider records.
    return [];
  }

  private rememberSession(session: LocalBillingTestSession): void {
    // The local adapter is a fixture, but its session map still has a bound
    // so a long-running development process cannot grow without limit.
    const oldest = this.sessions.keys().next().value;
    if (this.sessions.size >= 1_000 && typeof oldest === 'string') this.sessions.delete(oldest);
    this.sessions.set(session.id, session);
  }
}

export const createStripeBillingAdapter = (options: StripeBillingAdapterOptions): StripeBillingAdapter => new StripeBillingAdapter(options);
export const createLocalBillingAdapter = (options: LocalBillingAdapterOptions = {}): LocalBillingAdapter => new LocalBillingAdapter(options);
