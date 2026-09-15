import {
  assertBillingState,
  cloneBillingState,
  defaultBillingState,
  defaultBillingUsage,
  periodBounds,
  validateBillingIdentifier,
  validateBillingOrganizationId,
  validateBillingProviderId,
  BillingRepositoryError,
  type MemoryBillingRepositoryOptions,
  MemoryBillingRepository,
  PostgresBillingRepository,
  type BillingPgPoolLike,
  type PostgresBillingRepositoryOptions,
  billingPostgresSchemaSql,
  BILLING_POSTGRES_SCHEMA_SQL,
  createMemoryBillingRepository,
  createPostgresBillingRepository,
} from './repository.js';
import { createPlanCatalog, DEFAULT_PLAN_DEFINITIONS, planForPriceId, priceIdsFromEnv, validatePlanDefinition, validatePlanLimits } from './plans.js';
import { createLocalBillingAdapter, createStripeBillingAdapter, LocalBillingAdapter, StripeBillingAdapter, StripeBillingError, type LocalBillingAdapterOptions, type StripeBillingAdapterOptions } from './stripe.js';
import { BillingWebhookError, verifyWebhookSignature, signWebhookPayload, type VerifyWebhookOptions } from './webhooks.js';
import {
  BILLING_PROTOCOL_VERSION,
  type BillingCustomer,
  type BillingEntitlement,
  type BillingInvoiceLookup,
  type BillingMetric,
  type BillingMode,
  type BillingOrganizationState,
  type BillingProviderInvoice,
  type BillingProvider,
  type BillingProviderId,
  type BillingRepository,
  type BillingServiceOptions,
  type BillingStatus,
  type BillingSubscription,
  type BillingSubscriptionStatus,
  type BillingUsage,
  type BillingUsageOperation,
  type BillingWebhookEvent,
  type CheckoutRequest,
  type CreateCheckoutSessionInput,
  type HostedBillingSession,
  type PlanCatalog,
  type PlanDefinition,
  type PlanId,
  type PlanLimits,
  type PortalRequest,
  type PublicPlanMetadata,
  type UsageDelta,
  type UsageLimitDetails,
  type UsageReservation,
  type UsageSnapshot,
  type WebhookHandlingResult,
} from './types.js';

export * from './types.js';
export * from './repository.js';
export * from './plans.js';
export * from './stripe.js';
export * from './webhooks.js';

export class BillingError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, status = 400, options: { retryable?: boolean; details?: Record<string, unknown> } = {}) {
    super(message);
    this.name = 'BillingError';
    this.code = code;
    this.status = status;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

const ACTIVE_SUBSCRIPTION_STATUSES = new Set<BillingSubscriptionStatus>(['active', 'trialing']);
const SUBSCRIPTION_EVENTS = new Set(['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted']);
const REFUND_EVENTS = new Set(['charge.refunded', 'refund.created', 'refund.updated']);
const MAX_OPERATION_KEY_BYTES = 256;
export const MAX_WEBHOOK_BODY_BYTES = 10 * 1024 * 1024;
const MAX_WEBHOOK_EVENTS = 2_000;

type JsonObject = Record<string, unknown>;

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}

function objectId(value: unknown): string | undefined {
  return typeof value === 'string' ? value : object(value) ? text(object(value)!.id) : undefined;
}

function eventIdentifier(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new BillingError('INVALID_EVENT', `provider ${field} is invalid`, 400);
  try {
    const normalized = validateBillingIdentifier(value, field, 256);
    // Do not silently canonicalize provider IDs.  The exact signed event
    // identity must be the identity used for durable deduplication.
    if (normalized !== value) throw new Error('provider identifier is not normalized');
    return normalized;
  } catch {
    throw new BillingError('INVALID_EVENT', `provider ${field} is invalid`, 400);
  }
}

function oneEventIdentifier(values: readonly unknown[], field: string): string | undefined {
  const present = values.filter((value): value is string => value !== undefined && value !== null);
  if (present.length === 0) return undefined;
  const identifiers = present.map((value) => eventIdentifier(value, field)!);
  const unique = [...new Set(identifiers)];
  if (unique.length > 1) throw new BillingError('INVALID_EVENT', `provider ${field} is ambiguous`, 400);
  return unique[0];
}

function metadata(value: JsonObject | undefined): JsonObject {
  return object(value?.metadata) ?? {};
}

function metadataOrganizationId(value: JsonObject | undefined): string | undefined {
  const details = metadata(value);
  const underscored = text(details.organization_id);
  const camel = text(details.organizationId);
  if (underscored !== undefined && camel !== undefined && underscored !== camel) throw new BillingError('INVALID_EVENT', 'provider organization metadata is ambiguous', 400);
  const candidate = underscored ?? camel;
  if (candidate === undefined) return undefined;
  try {
    const normalized = validateBillingOrganizationId(candidate);
    if (normalized !== candidate) throw new Error('provider organization identifier is not normalized');
    return normalized;
  } catch { throw new BillingError('INVALID_EVENT', 'provider organization metadata is invalid', 400); }
}

function eventDataObject(event: JsonObject): JsonObject {
  const data = object(event.data);
  const payload = object(data?.object);
  if (!payload) throw new BillingError('INVALID_EVENT', 'provider event data is invalid', 400);
  return payload;
}

function parseEvent(rawBody: string): { id: string; type: string; created: number; object: JsonObject } {
  let value: unknown;
  try { value = JSON.parse(rawBody); } catch { throw new BillingError('INVALID_EVENT', 'provider event JSON is invalid', 400); }
  const event = object(value);
  const id = eventIdentifier(event?.id, 'event id');
  const type = eventIdentifier(event?.type, 'event type');
  const createdValue = event?.created;
  const created = typeof createdValue === 'number' ? createdValue : typeof createdValue === 'string' && /^\d+$/u.test(createdValue) ? Number(createdValue) : NaN;
  if (!id || !type || !Number.isSafeInteger(created) || created <= 0) throw new BillingError('INVALID_EVENT', 'provider event identity is invalid', 400);
  return { id, type, created, object: eventDataObject(event!) };
}

function idempotencyKey(value: string | undefined, field = 'idempotencyKey'): string {
  if (value === undefined || value.trim() === '') return crypto.randomUUID();
  return validateBillingIdentifier(value, field, MAX_OPERATION_KEY_BYTES);
}

function trustedSubject(value: unknown): string {
  return validateBillingIdentifier(value, 'subject', 256);
}

function isoFromSeconds(value: unknown): string | undefined {
  const seconds = typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : undefined;
  return seconds !== undefined && Number.isSafeInteger(seconds) ? new Date(seconds * 1_000).toISOString() : undefined;
}

function bool(value: unknown): boolean {
  return value === true || value === 'true';
}

function subscriptionPriceId(payload: JsonObject, fallback?: string): string | undefined {
  const directField = text(payload.price_id);
  const directObject = objectId(payload.price);
  if (directField !== undefined && directObject !== undefined && directField !== directObject) throw new BillingError('INVALID_EVENT', 'provider price metadata is ambiguous', 400);
  const direct = directField ?? directObject;
  const items = object(payload.items);
  const data = Array.isArray(items?.data) ? items.data : [];
  const itemPrices = data.map((item) => {
    const itemObject = object(item);
    return itemObject ? text(itemObject.price_id) ?? objectId(itemObject.price) : undefined;
  }).filter((value): value is string => value !== undefined);
  const uniqueItemPrices = [...new Set(itemPrices)];
  if (uniqueItemPrices.length > 1) throw new BillingError('INVALID_EVENT', 'provider subscription has ambiguous prices', 400);
  const fromItems = uniqueItemPrices[0];
  if (direct !== undefined && fromItems !== undefined && direct !== fromItems) throw new BillingError('INVALID_EVENT', 'provider subscription price is ambiguous', 400);
  return direct ?? fromItems ?? fallback;
}

function subscriptionStatus(value: unknown): BillingSubscriptionStatus {
  if (value === 'incomplete' || value === 'incomplete_expired' || value === 'trialing' || value === 'active' || value === 'past_due' || value === 'canceled' || value === 'unpaid' || value === 'paused') return value;
  return 'unknown';
}

function eventIsNewer(created: number, eventId: string, current: BillingSubscription): boolean {
  // Provider timestamps have second precision.  Use the provider event id as
  // a deterministic tie-breaker so same-second deliveries do not make state
  // depend on network arrival order.
  return created > current.eventCreatedAt || (created === current.eventCreatedAt && eventId > current.lastEventId);
}

function periodUsage(usage: BillingUsage, nowMs: number): BillingUsage {
  const current = periodBounds(nowMs);
  if (usage.periodStart === current.start && usage.periodEnd === current.end) return { ...usage };
  return {
    ...usage,
    periodStart: current.start,
    periodEnd: current.end,
    // Seats and retained storage are current-state values. Scans and Eve
    // spend are period counters and restart at the UTC month boundary.
    scans: 0,
    eveCostCents: 0,
    updatedAt: new Date(nowMs).toISOString(),
  };
}

function usageValue(usage: BillingUsage, metric: BillingMetric): number {
  return usage[metric === 'scans' ? 'scans' : metric];
}

function limitValue(limits: PlanLimits, metric: BillingMetric): number {
  if (metric === 'seats') return limits.seats;
  if (metric === 'storageBytes') return limits.storageBytes;
  if (metric === 'scans') return limits.scansPerMonth;
  return limits.eveCostCentsPerMonth;
}

function normalizedDelta(input: UsageDelta): UsageDelta {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BillingError('INVALID_USAGE', 'usage delta is required', 400);
  const supportedMetrics = new Set(['seats', 'storageBytes', 'scans', 'eveCostCents']);
  for (const key of Object.keys(input)) {
    if (!supportedMetrics.has(key)) throw new BillingError('INVALID_USAGE', `usage metric ${key} is unsupported`, 400);
  }
  const result: UsageDelta = {};
  for (const metric of ['seats', 'storageBytes', 'scans', 'eveCostCents'] as const) {
    const value = input[metric];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) throw new BillingError('INVALID_USAGE', `${metric} must be a safe integer`, 400);
    if (value !== 0) result[metric] = value;
  }
  if (Object.keys(result).length === 0) return {};
  return result;
}

function sameDelta(left: UsageDelta, right: UsageDelta): boolean {
  return (left.seats ?? 0) === (right.seats ?? 0) && (left.storageBytes ?? 0) === (right.storageBytes ?? 0) && (left.scans ?? 0) === (right.scans ?? 0) && (left.eveCostCents ?? 0) === (right.eveCostCents ?? 0);
}

function applyDelta(usage: BillingUsage, delta: UsageDelta, nowMs: number): BillingUsage {
  const result = { ...usage, updatedAt: new Date(nowMs).toISOString() };
  for (const metric of ['seats', 'storageBytes', 'scans', 'eveCostCents'] as const) {
    const value = (result[metric] ?? 0) + (delta[metric] ?? 0);
    if (!Number.isSafeInteger(value) || value < 0) throw new BillingError('INVALID_USAGE', `${metric} cannot become negative`, 400);
    result[metric] = value;
  }
  return result;
}

function digestBytes(bytes: Uint8Array): Promise<string> {
  // TS 7 models Uint8Array<ArrayBufferLike> separately from the Web Crypto
  // BufferSource accepted by digest(). Copy to a concrete ArrayBuffer so the
  // runtime and type checker agree without weakening the input contract.
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  return crypto.subtle.digest('SHA-256', input.buffer).then((value) => `sha256:${[...new Uint8Array(value)].map((item) => item.toString(16).padStart(2, '0')).join('')}`);
}

function freeDefinition(catalog: PlanCatalog): PlanDefinition {
  const plan = catalog.get('free');
  if (!plan) throw new BillingError('INVALID_CONFIGURATION', 'a free plan is required', 500);
  return plan;
}

function providerFailure(error: unknown): BillingError {
  if (error instanceof BillingError) return error;
  if (error instanceof StripeBillingError) {
    const status = error.code === 'INVALID_INPUT' ? 400 : error.code === 'INVALID_CONFIGURATION' ? 500 : 502;
    return new BillingError(error.code, error.code === 'INVALID_INPUT' ? error.message : 'Billing provider request failed', status, { retryable: error.retryable });
  }
  return new BillingError('BILLING_PROVIDER_ERROR', 'Billing provider request failed', 502, { retryable: true });
}

function mappingConflict(error: unknown): boolean {
  return error instanceof BillingRepositoryError && error.code === 'MAPPING_CONFLICT';
}

function duplicateWebhook(error: unknown): boolean {
  return error instanceof BillingRepositoryError && error.code === 'DUPLICATE_WEBHOOK';
}

function postgresUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === '23505');
}

function providerCustomer(value: unknown, provider: BillingProvider): { provider: BillingProviderId; customerId: string } {
  if (!value || typeof value !== 'object' || (value as { provider?: unknown }).provider !== provider.id) throw new BillingError('PROVIDER_ERROR', 'Billing provider returned an invalid customer', 502, { retryable: true });
  try {
    const customerId = validateBillingIdentifier((value as { customerId?: unknown }).customerId, 'customerId', 256);
    return { provider: provider.id, customerId };
  } catch {
    throw new BillingError('PROVIDER_ERROR', 'Billing provider returned an invalid customer', 502, { retryable: true });
  }
}

function providerSession(value: unknown, provider: BillingProvider): HostedBillingSession {
  if (!value || typeof value !== 'object' || (value as { provider?: unknown }).provider !== provider.id || (value as { mode?: unknown }).mode !== provider.mode) {
    throw new BillingError('PROVIDER_ERROR', 'Billing provider returned an invalid session', 502, { retryable: true });
  }
  let id: string;
  let url: string;
  try {
    id = validateBillingIdentifier((value as { id?: unknown }).id, 'session id', 256);
    url = validateBillingIdentifier((value as { url?: unknown }).url, 'session url', 4_096);
    const parsed = new URL(url);
    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password || (parsed.protocol === 'http:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1')) throw new Error('session URL is not trusted');
  } catch {
    throw new BillingError('PROVIDER_ERROR', 'Billing provider returned an invalid session', 502, { retryable: true });
  }
  const expiresAt = (value as { expiresAt?: unknown }).expiresAt;
  if (expiresAt !== undefined && (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt)))) throw new BillingError('PROVIDER_ERROR', 'Billing provider returned an invalid session', 502, { retryable: true });
  return { provider: provider.id, mode: provider.mode, id, url, ...(expiresAt === undefined ? {} : { expiresAt: new Date(expiresAt as string).toISOString() }) };
}

class ServiceKeyedMutex {
  private readonly queues = new Map<string, Promise<void>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.queues.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.queues.get(key) === current) this.queues.delete(key);
    }
  }
}

function entitlementFromState(
  catalog: PlanCatalog,
  state: BillingOrganizationState,
  enabled: boolean,
): BillingEntitlement {
  const free = freeDefinition(catalog);
  if (!enabled) {
    return {
      protocolVersion: BILLING_PROTOCOL_VERSION,
      organizationId: state.organizationId,
      planId: free.id,
      limits: { ...free.limits },
      state: 'disabled',
      source: 'billing-disabled',
      reason: 'billing-disabled',
    };
  }
  const subscription = state.subscription;
  if (!subscription || !ACTIVE_SUBSCRIPTION_STATUSES.has(subscription.status)) {
    return {
      protocolVersion: BILLING_PROTOCOL_VERSION,
      organizationId: state.organizationId,
      planId: free.id,
      limits: { ...free.limits },
      state: 'inactive',
      source: 'no-subscription',
      ...(subscription?.provider ? { provider: subscription.provider } : {}),
      ...(state.customer?.customerId ? { customerId: state.customer.customerId } : {}),
      ...(subscription?.subscriptionId ? { subscriptionId: subscription.subscriptionId } : {}),
      ...(subscription?.currentPeriodEnd ? { currentPeriodEnd: subscription.currentPeriodEnd } : {}),
      reason: 'no-active-subscription',
    };
  }
  // The price id must map through the server-owned catalog. A plan label in
  // provider metadata is never sufficient to activate paid limits.
  const plan = planForPriceId(catalog, subscription.priceId);
  if (!plan || plan.id === free.id) {
    return {
      protocolVersion: BILLING_PROTOCOL_VERSION,
      organizationId: state.organizationId,
      planId: free.id,
      limits: { ...free.limits },
      state: 'unconfigured',
      source: 'verified-webhook',
      provider: subscription.provider,
      customerId: subscription.customerId,
      subscriptionId: subscription.subscriptionId,
      ...(subscription.currentPeriodEnd ? { currentPeriodEnd: subscription.currentPeriodEnd } : {}),
      reason: 'unknown-price',
    };
  }
  return {
    protocolVersion: BILLING_PROTOCOL_VERSION,
    organizationId: state.organizationId,
    planId: plan.id,
    limits: { ...plan.limits },
    state: 'active',
    source: 'verified-webhook',
    provider: subscription.provider,
    customerId: subscription.customerId,
    subscriptionId: subscription.subscriptionId,
    ...(subscription.currentPeriodEnd ? { currentPeriodEnd: subscription.currentPeriodEnd } : {}),
    reason: 'active-subscription',
  };
}

function eventCustomerId(payload: JsonObject): string | undefined {
  const charge = object(payload.charge);
  return oneEventIdentifier([
    objectId(payload.customer),
    text(payload.customer_id),
    charge ? objectId(charge.customer) : undefined,
    charge ? text(charge.customer_id) : undefined,
  ], 'customer id');
}

function eventSubscriptionId(payload: JsonObject): string | undefined {
  const charge = object(payload.charge);
  return oneEventIdentifier([
    objectId(payload.subscription),
    text(payload.subscription_id),
    charge ? objectId(charge.subscription) : undefined,
    charge ? text(charge.subscription_id) : undefined,
    text(payload.id)?.startsWith('sub_') ? text(payload.id) : undefined,
  ], 'subscription id');
}

function eventOrganizationId(payload: JsonObject): string | undefined {
  const top = metadataOrganizationId(payload);
  const nested = metadataOrganizationId(object(payload.charge));
  if (top !== undefined && nested !== undefined && top !== nested) throw new BillingError('INVALID_EVENT', 'provider organization metadata is ambiguous', 400);
  return top ?? nested;
}

function eventPriceId(payload: JsonObject): string | undefined {
  const nestedPlan = object(payload.plan);
  return eventIdentifier(subscriptionPriceId(payload) ?? text(nestedPlan?.id), 'price id');
}

function eventDetails(payload: JsonObject, type: string, current?: BillingSubscription): {
  customerId?: string;
  subscriptionId?: string;
  organizationId?: string;
  priceId?: string;
  status?: BillingSubscriptionStatus;
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  cancelAtPeriodEnd: boolean;
} {
  const customerId = eventCustomerId(payload);
  const subscriptionId = eventSubscriptionId(payload) ?? current?.subscriptionId;
  const priceId = eventPriceId(payload) ?? current?.priceId;
  const sameSubscription = current !== undefined && subscriptionId === current.subscriptionId;
  const parsedStatus = SUBSCRIPTION_EVENTS.has(type) ? subscriptionStatus(payload.status) : undefined;
  const status = parsedStatus !== undefined && parsedStatus !== 'unknown' ? parsedStatus : sameSubscription ? current?.status : undefined;
  const periodStart = isoFromSeconds(payload.current_period_start) ?? isoFromSeconds(payload.period_start) ?? (sameSubscription ? current?.currentPeriodStart : undefined);
  const periodEnd = isoFromSeconds(payload.current_period_end) ?? isoFromSeconds(payload.period_end) ?? (sameSubscription ? current?.currentPeriodEnd : undefined);
  const cancelAtPeriodEnd = Object.prototype.hasOwnProperty.call(payload, 'cancel_at_period_end')
    ? bool(payload.cancel_at_period_end)
    : sameSubscription
      ? current?.cancelAtPeriodEnd ?? false
      : false;
  return {
    ...(customerId ? { customerId } : {}),
    ...(subscriptionId ? { subscriptionId } : {}),
    ...(eventOrganizationId(payload) ? { organizationId: eventOrganizationId(payload) } : {}),
    ...(priceId ? { priceId } : {}),
    ...(status ? { status } : {}),
    ...(periodStart ? { currentPeriodStart: periodStart } : {}),
    ...(periodEnd ? { currentPeriodEnd: periodEnd } : {}),
    cancelAtPeriodEnd,
  };
}

export interface BillingWebhookHandlerOptions {
  /** If supplied, only this pathname is accepted by the adapter handler. */
  path?: string;
  /** Optional lower bound for deployments with a stricter request limit. */
  maxBodyBytes?: number;
}

async function readBoundedRequestBody(request: Request, maxBytes = MAX_WEBHOOK_BODY_BYTES): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_WEBHOOK_BODY_BYTES) {
    throw new BillingError('INVALID_CONFIGURATION', 'Billing webhook body limit is invalid', 500);
  }
  const declared = request.headers.get('content-length');
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > maxBytes) {
    throw new BillingError('PAYLOAD_TOO_LARGE', 'Billing webhook body exceeds the configured limit', 413);
  }
  if (!request.body) return request.text();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      const chunk = part.value;
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new BillingError('PAYLOAD_TOO_LARGE', 'Billing webhook body exceeds the configured limit', 413);
      }
      chunks.push(chunk);
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
  try {
    // Stripe signs the original UTF-8 bytes. Replacement decoding would
    // produce a different signed message, so malformed input is rejected.
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new BillingError('INVALID_BODY', 'Billing webhook body is not valid UTF-8', 400);
  }
}

/** Construct a host-neutral POST handler. It consumes the request body once and bounds it before parsing. */
export function createBillingWebhookHandler(service: BillingService, options: BillingWebhookHandlerOptions = {}): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const method = request.method.toUpperCase();
    if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
    if (options.path !== undefined && new URL(request.url).pathname !== options.path) return Response.json({ code: 'NOT_FOUND', message: 'Not found' }, { status: 404 });
    let rawBody: string;
    try {
      const serviceLimit = service.webhookBodyLimit();
      const requestedLimit = options.maxBodyBytes ?? serviceLimit;
      rawBody = await readBoundedRequestBody(request, Math.min(requestedLimit, serviceLimit));
    } catch (error) {
      const failure = error instanceof BillingError ? error : new BillingError('INVALID_BODY', 'Billing webhook body could not be read', 400);
      return Response.json({ code: failure.code, message: failure.message, retryable: failure.retryable }, { status: failure.status });
    }
    const signature = request.headers.get('stripe-signature');
    if (!signature) return Response.json({ code: 'INVALID_SIGNATURE', message: 'Webhook signature is required' }, { status: 400 });
    try {
      const result = await service.handleWebhook(rawBody, signature);
      return Response.json({ received: true, ...result });
    } catch (error) {
      const failure = error instanceof BillingError
        ? error
        : error instanceof BillingWebhookError
          ? new BillingError(error.code, error.message, error.code === 'INVALID_CONFIGURATION' ? 503 : 400)
          : new BillingError('BILLING_UNAVAILABLE', 'Billing webhook could not be processed', 503, { retryable: true });
      return Response.json({ code: failure.code, message: failure.message, retryable: failure.retryable }, { status: failure.status });
    }
  };
}

export class BillingService {
  private readonly repository: BillingRepository;
  private readonly catalog: PlanCatalog;
  private readonly provider?: BillingProvider;
  private readonly enabled: boolean;
  private readonly webhookSecret?: string;
  private readonly webhookToleranceSeconds: number;
  private readonly maxWebhookBodyBytes: number;
  private readonly now: () => number;
  private readonly customerMutex = new ServiceKeyedMutex();
  private readonly successUrl?: string;
  private readonly cancelUrl?: string;
  private readonly portalReturnUrl?: string;

  constructor(options: BillingServiceOptions) {
    if (!options.repository || typeof options.repository.read !== 'function' || typeof options.repository.transaction !== 'function') throw new BillingError('INVALID_CONFIGURATION', 'billing repository is required', 500);
    this.repository = options.repository;
    this.catalog = options.catalog ?? createPlanCatalog();
    freeDefinition(this.catalog);
    this.provider = options.provider;
    if (this.provider) {
      try {
        if (validateBillingProviderId(this.provider.id) !== this.provider.id) throw new Error('provider id is not normalized');
      } catch {
        throw new BillingError('INVALID_CONFIGURATION', 'billing provider is unsupported', 500);
      }
      if (this.provider.mode !== 'test' && this.provider.mode !== 'live') throw new BillingError('INVALID_CONFIGURATION', 'billing provider mode is invalid', 500);
    }
    this.enabled = options.enabled ?? options.provider !== undefined;
    this.webhookSecret = options.webhookSecret;
    this.webhookToleranceSeconds = options.webhookToleranceSeconds ?? 300;
    this.maxWebhookBodyBytes = options.maxWebhookBodyBytes ?? MAX_WEBHOOK_BODY_BYTES;
    this.now = options.now ?? Date.now;
    this.successUrl = options.successUrl;
    this.cancelUrl = options.cancelUrl;
    this.portalReturnUrl = options.portalReturnUrl;
    if (!Number.isSafeInteger(this.webhookToleranceSeconds) || this.webhookToleranceSeconds <= 0 || this.webhookToleranceSeconds > 86_400) throw new BillingError('INVALID_CONFIGURATION', 'webhook tolerance is invalid', 500);
    if (!Number.isSafeInteger(this.maxWebhookBodyBytes) || this.maxWebhookBodyBytes <= 0 || this.maxWebhookBodyBytes > MAX_WEBHOOK_BODY_BYTES) throw new BillingError('INVALID_CONFIGURATION', 'webhook body limit is invalid', 500);
    if (this.webhookSecret !== undefined && (typeof this.webhookSecret !== 'string' || this.webhookSecret.length < 16 || this.webhookSecret.length > 512 || /[\u0000-\u001f\u007f]/u.test(this.webhookSecret))) throw new BillingError('INVALID_CONFIGURATION', 'webhook signing secret is invalid', 500);
  }

  status(): BillingStatus {
    const mode: BillingMode = !this.enabled || !this.provider ? 'disabled' : this.provider.mode;
    const providerReady = this.enabled && this.provider !== undefined;
    return {
      enabled: providerReady,
      provider: this.provider?.id ?? null,
      mode,
      webhookVerification: providerReady && this.webhookSecret !== undefined,
      checkout: providerReady && Boolean(this.successUrl && this.cancelUrl) && this.hasConfiguredPaidPlan(),
      // Keep both hosted entry points closed until at least one server-owned
      // recurring price mapping is configured for the deployment.
      portal: providerReady && Boolean(this.portalReturnUrl) && this.hasConfiguredPaidPlan(),
    };
  }

  planCatalog(): PlanCatalog {
    return this.catalog;
  }

  /** Request-body ceiling used by host adapters before signature parsing. */
  webhookBodyLimit(): number {
    return this.maxWebhookBodyBytes;
  }

  private hasConfiguredPaidPlan(): boolean {
    return this.catalog.all().some((plan) => plan.id !== 'free' && plan.priceId !== undefined);
  }

  publicPlans(): readonly PublicPlanMetadata[] {
    const checkoutEnabled = this.status().checkout;
    return this.catalog.publicMetadata().map((plan) => ({
      ...plan,
      checkoutAvailable: checkoutEnabled && plan.checkoutAvailable,
    }));
  }

  async entitlement(organizationId: string): Promise<BillingEntitlement> {
    const normalized = validateBillingOrganizationId(organizationId);
    const state = await this.repository.read(normalized);
    return entitlementFromState(this.catalog, state, this.enabled && this.provider !== undefined);
  }

  /** Alias used by runtime enforcement hooks. */
  getEntitlement(organizationId: string): Promise<BillingEntitlement> {
    return this.entitlement(organizationId);
  }

  private requireProvider(): BillingProvider {
    if (!this.enabled || !this.provider) throw new BillingError('BILLING_DISABLED', 'Billing is disabled on this deployment', 503);
    return this.provider;
  }

  private async customerFor(organizationId: string, email?: string): Promise<BillingCustomer> {
    return this.customerMutex.run(organizationId, async () => {
      const provider = this.requireProvider();
      const state = await this.repository.read(organizationId);
      if (state.customer) {
        if (state.customer.provider !== provider.id) throw new BillingError('CUSTOMER_MAPPING_CONFLICT', 'Organization billing provider does not match the configured provider', 409);
        return state.customer;
      }
      let created: Awaited<ReturnType<BillingProvider['createCustomer']>>;
      try {
        created = await provider.createCustomer({ organizationId, ...(email ? { email } : {}), idempotencyKey: `private-skills:customer:${organizationId}` });
      } catch (error) {
        throw providerFailure(error);
      }
      created = providerCustomer(created, provider);
      const timestamp = new Date(this.now()).toISOString();
      try {
        return await this.repository.transaction(organizationId, (mutable) => {
          if (mutable.customer) {
            if (mutable.customer.provider !== created.provider || mutable.customer.customerId !== created.customerId) throw new BillingError('CUSTOMER_MAPPING_CONFLICT', 'Organization already has another billing customer', 409);
            return mutable.customer;
          }
          const customer: BillingCustomer = { organizationId, provider: created.provider, customerId: created.customerId, createdAt: timestamp, updatedAt: timestamp };
          mutable.customer = customer;
          return customer;
        });
      } catch (error) {
        if (mappingConflict(error) || postgresUniqueViolation(error)) throw new BillingError('CUSTOMER_MAPPING_CONFLICT', 'Billing customer is already mapped to another organization', 409);
        throw error;
      }
    });
  }

  async createCheckoutSession(request: CheckoutRequest): Promise<HostedBillingSession> {
    if (!request || typeof request !== 'object') throw new BillingError('INVALID_REQUEST', 'Checkout request is required', 400);
    const organizationId = validateBillingOrganizationId(request.organizationId);
    trustedSubject(request.subject);
    const email = request.email === undefined ? undefined : validateBillingIdentifier(request.email, 'email', 320);
    const planId = validateBillingIdentifier(request.planId, 'planId', 64) as PlanId;
    const plan = this.catalog.get(planId);
    if (!plan) throw new BillingError('PLAN_NOT_FOUND', 'Requested billing plan is unavailable', 404);
    const provider = this.requireProvider();
    if (plan.id === 'free' || !plan.priceId) throw new BillingError('PLAN_NOT_CONFIGURED', 'Hosted checkout is unavailable until this plan has a configured provider price', 503);
    if (!this.successUrl || !this.cancelUrl) throw new BillingError('BILLING_UNAVAILABLE', 'Hosted checkout URLs are not configured', 503);
    const customer = await this.customerFor(organizationId, email);
    const input: CreateCheckoutSessionInput = {
      organizationId,
      customerId: customer.customerId,
      priceId: plan.priceId,
      planId: plan.id,
      successUrl: this.successUrl,
      cancelUrl: this.cancelUrl,
      idempotencyKey: idempotencyKey(request.idempotencyKey, 'checkout idempotencyKey'),
    };
    try {
      return providerSession(await provider.createCheckoutSession(input), provider);
    } catch (error) {
      throw providerFailure(error);
    }
  }

  /** Alias used by callers that prefer the shorter name. */
  checkout(request: CheckoutRequest): Promise<HostedBillingSession> {
    return this.createCheckoutSession(request);
  }

  async createCustomerPortalSession(request: PortalRequest): Promise<HostedBillingSession> {
    if (!request || typeof request !== 'object') throw new BillingError('INVALID_REQUEST', 'Portal request is required', 400);
    const organizationId = validateBillingOrganizationId(request.organizationId);
    trustedSubject(request.subject);
    const provider = this.requireProvider();
    if (!this.hasConfiguredPaidPlan()) throw new BillingError('PLAN_NOT_CONFIGURED', 'Hosted billing is unavailable until a provider price is configured', 503);
    if (!this.portalReturnUrl) throw new BillingError('BILLING_UNAVAILABLE', 'Customer portal return URL is not configured', 503);
    const state = await this.repository.read(organizationId);
    if (!state.customer || state.customer.provider !== provider.id) throw new BillingError('CUSTOMER_NOT_FOUND', 'The organization has no billing customer yet', 404);
    try {
      return providerSession(await provider.createCustomerPortalSession({
        organizationId,
        customerId: state.customer.customerId,
        returnUrl: this.portalReturnUrl,
        idempotencyKey: idempotencyKey(request.idempotencyKey, 'portal idempotencyKey'),
      }), provider);
    } catch (error) {
      throw providerFailure(error);
    }
  }

  portal(request: PortalRequest): Promise<HostedBillingSession> {
    return this.createCustomerPortalSession(request);
  }

  /**
   * Read the most recent bounded provider invoices through the server-owned
   * customer mapping. The browser never supplies the customer identifier; the
   * lookup is checked against the durable organization mapping before the
   * provider is called.
   */
  async listInvoices(input: BillingInvoiceLookup): Promise<readonly BillingProviderInvoice[]> {
    if (!input || typeof input !== 'object') throw new BillingError('INVALID_REQUEST', 'Invoice lookup is required', 400);
    const organizationId = validateBillingOrganizationId(input.organizationId);
    const providerId = validateBillingProviderId(input.provider);
    const customerId = validateBillingIdentifier(input.customerId, 'customerId', 256);
    const provider = this.requireProvider();
    if (providerId !== provider.id || input.mode !== provider.mode) {
      throw new BillingError('CUSTOMER_MAPPING_CONFLICT', 'Organization billing provider does not match the configured provider', 409);
    }
    const state = await this.repository.read(organizationId);
    if (!state.customer || state.customer.provider !== provider.id || state.customer.customerId !== customerId) {
      throw new BillingError('CUSTOMER_MAPPING_CONFLICT', 'The requested provider customer is not mapped to this organization', 409);
    }
    const reader = provider.listInvoices;
    if (!reader) throw new BillingError('INVOICE_HISTORY_UNAVAILABLE', 'Invoice history is not available for this billing provider', 503, { retryable: true });
    let invoices: readonly BillingProviderInvoice[];
    try {
      invoices = await reader.call(provider, { customerId: state.customer.customerId, limit: 100 });
    } catch (error) {
      throw providerFailure(error);
    }
    if (!Array.isArray(invoices) || invoices.length > 100) {
      throw new BillingError('INVOICE_PROVIDER_ERROR', 'Billing provider returned invalid invoice history', 502, { retryable: true });
    }
    for (const invoice of invoices) {
      if (!invoice || typeof invoice !== 'object' || invoice.provider !== provider.id || invoice.customerId !== state.customer.customerId) {
        throw new BillingError('INVOICE_MAPPING_CONFLICT', 'Billing provider returned an invoice for another customer', 409);
      }
    }
    return invoices;
  }

  async usageSnapshot(organizationId: string): Promise<UsageSnapshot> {
    const normalized = validateBillingOrganizationId(organizationId);
    const state = await this.repository.read(normalized);
    const entitlement = entitlementFromState(this.catalog, state, this.enabled && this.provider !== undefined);
    return { organizationId: normalized, limits: { ...entitlement.limits }, usage: periodUsage(state.usage, this.now()), entitlement };
  }

  async checkUsage(organizationId: string, delta: UsageDelta = {}): Promise<{ allowed: boolean; snapshot: UsageSnapshot; projected: BillingUsage; exceeded?: UsageLimitDetails }> {
    const normalized = validateBillingOrganizationId(organizationId);
    const normalizedDelta = normalizedDeltaInput(delta);
    const snapshot = await this.usageSnapshot(normalized);
    const projected = applyDelta(snapshot.usage, normalizedDelta, this.now());
    const exceeded = firstExceeded(snapshot.entitlement.limits, projected, normalizedDelta);
    return exceeded ? { allowed: false, snapshot, projected, exceeded } : { allowed: true, snapshot, projected };
  }

  async reserveUsage(organizationId: string, delta: UsageDelta, operationKey: string): Promise<UsageReservation> {
    const normalized = validateBillingOrganizationId(organizationId);
    const normalizedDelta = normalizedDeltaInput(delta);
    const normalizedKey = validateBillingIdentifier(operationKey, 'operationKey', MAX_OPERATION_KEY_BYTES);
    const nowMs = this.now();
    return this.repository.transaction(normalized, (state) => this.reserveUsageInState(state, normalized, normalizedDelta, normalizedKey, nowMs));
  }

  /**
   * Reconcile a pre-reserved estimate with measured usage in one transaction.
   * The reservation remains the fail-closed guard before work starts; this
   * correction records the difference after the worker reports actual cost.
   */
  async reconcileUsage(
    organizationId: string,
    reservationKey: string,
    actual: UsageDelta,
    operationKey: string,
  ): Promise<UsageReservation> {
    const normalized = validateBillingOrganizationId(organizationId);
    const normalizedReservationKey = validateBillingIdentifier(reservationKey, 'reservationKey', MAX_OPERATION_KEY_BYTES);
    const normalizedActual = nonnegativeDeltaInput(actual);
    const normalizedKey = validateBillingIdentifier(operationKey, 'operationKey', MAX_OPERATION_KEY_BYTES);
    const nowMs = this.now();
    return this.repository.transaction(normalized, (state) => {
      const reservation = state.usageOperations.find((candidate) => candidate.operationKey === normalizedReservationKey);
      if (!reservation) throw new BillingError('USAGE_RESERVATION_NOT_FOUND', 'The usage reservation does not exist', 404);
      const correction: UsageDelta = {};
      for (const metric of ['seats', 'storageBytes', 'scans', 'eveCostCents'] as const) {
        // A measured usage report may cover only one metered resource.  An
        // omitted metric keeps its reservation; an explicit zero releases it.
        if (normalizedActual[metric] === undefined) continue;
        const difference = (normalizedActual[metric] ?? 0) - (reservation.delta[metric] ?? 0);
        if (difference !== 0) correction[metric] = difference;
      }
      return this.reserveUsageInState(state, normalized, correction, normalizedKey, nowMs);
    });
  }

  reconcileReservedUsage(
    organizationId: string,
    reservationKey: string,
    actual: UsageDelta,
    operationKey: string,
  ): Promise<UsageReservation> {
    return this.reconcileUsage(organizationId, reservationKey, actual, operationKey);
  }

  /**
   * Apply a usage reservation inside the repository transaction that owns the
   * organization row. Runtime callers should use reserveUsage(); the helper
   * also lets the identity membership hook update seats atomically.
   */
  private reserveUsageInState(
    state: BillingOrganizationState,
    organizationId: string,
    delta: UsageDelta,
    operationKey: string,
    nowMs: number,
  ): UsageReservation {
    state.usage = periodUsage(state.usage, nowMs);
    const entitlement = entitlementFromState(this.catalog, state, this.enabled && this.provider !== undefined);
    const existing = state.usageOperations.find((candidate) => candidate.operationKey === operationKey);
    if (existing) {
      if (!sameDelta(existing.delta, delta)) throw new BillingError('IDEMPOTENCY_CONFLICT', 'Usage operation key was already used with another delta', 409);
      return {
        operationKey,
        idempotent: true,
        delta: { ...existing.delta },
        snapshot: { organizationId, limits: { ...entitlement.limits }, usage: { ...existing.usage }, entitlement },
      };
    }
    const next = applyDelta(state.usage, delta, nowMs);
    const exceeded = firstExceeded(entitlement.limits, next, delta);
    if (exceeded) throw new BillingError('USAGE_LIMIT_EXCEEDED', `The ${exceeded.metric} limit has been reached`, 429, { retryable: false, details: { ...exceeded } });
    state.usage = next;
    const operation: BillingUsageOperation = {
      organizationId,
      operationKey,
      delta: { ...delta },
      usage: { ...next },
      createdAt: new Date(nowMs).toISOString(),
    };
    state.usageOperations.push(operation);
    if (state.usageOperations.length > 20_000) state.usageOperations.splice(0, state.usageOperations.length - 20_000);
    return {
      operationKey,
      idempotent: false,
      delta: { ...delta },
      snapshot: { organizationId, limits: { ...entitlement.limits }, usage: { ...next }, entitlement },
    };
  }

  /** Alias used by storage/scanner/Eve runtime seams. */
  enforceUsage(organizationId: string, delta: UsageDelta, operationKey: string): Promise<UsageReservation> {
    return this.reserveUsage(organizationId, delta, operationKey);
  }

  recordUsage(organizationId: string, delta: UsageDelta, operationKey: string): Promise<UsageReservation> {
    return this.reserveUsage(organizationId, delta, operationKey);
  }

  /** Identity backend calls this with its authoritative active membership count. */
  async setSeatCount(organizationId: string, seats: number, operationKey: string): Promise<UsageReservation> {
    if (!Number.isSafeInteger(seats) || seats < 0) throw new BillingError('INVALID_USAGE', 'seat count must be a non-negative safe integer', 400);
    const normalized = validateBillingOrganizationId(organizationId);
    const normalizedKey = validateBillingIdentifier(operationKey, 'operationKey', MAX_OPERATION_KEY_BYTES);
    const nowMs = this.now();
    return this.repository.transaction(normalized, (state) => {
      const current = periodUsage(state.usage, nowMs);
      state.usage = current;
      return this.reserveUsageInState(state, normalized, { seats: seats - current.seats }, normalizedKey, nowMs);
    });
  }

  async handleWebhook(rawBody: string, signatureHeader: string): Promise<WebhookHandlingResult> {
    const provider = this.requireProvider();
    if (!this.webhookSecret) throw new BillingError('BILLING_WEBHOOK_UNAVAILABLE', 'Billing webhook verification is not configured', 503);
    if (typeof rawBody !== 'string' || typeof signatureHeader !== 'string') throw new BillingError('INVALID_BODY', 'Billing webhook body and signature are required', 400);
    if (new TextEncoder().encode(rawBody).byteLength > this.maxWebhookBodyBytes) throw new BillingError('PAYLOAD_TOO_LARGE', 'Billing webhook body exceeds the configured limit', 413);
    await verifyWebhookSignature(rawBody, signatureHeader, this.webhookSecret, { now: this.now, toleranceSeconds: this.webhookToleranceSeconds });
    const payloadDigest = await digestBytes(new TextEncoder().encode(rawBody));
    const parsed = parseEvent(rawBody);
    const known = await this.repository.findWebhookEvent(provider.id, parsed.id);
    if (known) return { status: 'duplicate', eventId: parsed.id, eventType: parsed.type, ...(known.organizationId ? { organizationId: known.organizationId } : {}) };
    const details = eventDetails(parsed.object, parsed.type);
    const mappedCustomerOrg = details.customerId ? await this.repository.findOrganizationByCustomerId(provider.id, details.customerId) : undefined;
    const mappedSubscriptionOrg = details.subscriptionId ? await this.repository.findOrganizationBySubscriptionId(provider.id, details.subscriptionId) : undefined;
    if (mappedCustomerOrg && mappedSubscriptionOrg && mappedCustomerOrg !== mappedSubscriptionOrg) throw new BillingError('TENANT_MAPPING_CONFLICT', 'Provider identifiers map to different organizations', 409);
    if (details.organizationId && mappedCustomerOrg && details.organizationId !== mappedCustomerOrg) throw new BillingError('TENANT_MAPPING_CONFLICT', 'Provider organization metadata does not match the server mapping', 409);
    if (details.organizationId && mappedSubscriptionOrg && details.organizationId !== mappedSubscriptionOrg) throw new BillingError('TENANT_MAPPING_CONFLICT', 'Provider subscription metadata does not match the server mapping', 409);
    const organizationId = mappedCustomerOrg ?? mappedSubscriptionOrg ?? details.organizationId;
    // Signed but unbound events do not grant anything. They are reported as
    // ignored because there is no safe tenant transaction in which to record
    // them. An operator can inspect provider delivery logs without exposing
    // customer data in the registry.
    if (!organizationId) return { status: 'ignored', eventId: parsed.id, eventType: parsed.type, reason: 'unbound' };
    try {
      return await this.repository.transaction(organizationId, (state) => {
        const duplicate = state.webhookEvents.find((candidate) => candidate.provider === provider.id && candidate.eventId === parsed.id);
        if (duplicate) return { status: 'duplicate' as const, eventId: parsed.id, eventType: parsed.type, organizationId };
        const effectiveDetails = eventDetails(parsed.object, parsed.type, state.subscription);
        const receivedAt = new Date(this.now()).toISOString();
        let handled = false;
        let ignoredReason: BillingWebhookEvent['ignoredReason'];
        if (effectiveDetails.customerId) {
          if (state.customer && (state.customer.provider !== provider.id || state.customer.customerId !== effectiveDetails.customerId)) throw new BillingError('CUSTOMER_MAPPING_CONFLICT', 'Provider customer is bound to another customer', 409);
          if (!state.customer) {
            state.customer = { organizationId, provider: provider.id, customerId: effectiveDetails.customerId, createdAt: receivedAt, updatedAt: receivedAt };
          }
        }
        if (SUBSCRIPTION_EVENTS.has(parsed.type)) {
          const customerId = effectiveDetails.customerId ?? state.customer?.customerId;
          const subscriptionId = effectiveDetails.subscriptionId;
          const priceId = effectiveDetails.priceId ?? state.subscription?.priceId;
          const replacesDifferentSubscription = state.subscription !== undefined && subscriptionId !== state.subscription.subscriptionId;
          if (!customerId || !subscriptionId || !priceId) {
            ignoredReason = 'unsupported';
          } else if (replacesDifferentSubscription && (parsed.type !== 'customer.subscription.created' || state.subscription?.status !== 'canceled')) {
            // One organization has one authoritative subscription mapping.
            // A late event for a superseded subscription cannot replace the
            // current mapping; a new subscription may take over only after
            // the previous one was cancelled.
            ignoredReason = 'stale';
          } else if (state.subscription && !eventIsNewer(parsed.created, parsed.id, state.subscription)) {
            ignoredReason = 'stale';
          } else {
            const plan = planForPriceId(this.catalog, priceId);
            const subscription: BillingSubscription = {
              organizationId,
              provider: provider.id,
              subscriptionId,
              customerId,
              priceId,
              planId: plan?.id ?? ('unknown' as PlanId),
              status: parsed.type === 'customer.subscription.deleted' ? 'canceled' : effectiveDetails.status ?? 'unknown',
              ...(effectiveDetails.currentPeriodStart ? { currentPeriodStart: effectiveDetails.currentPeriodStart } : {}),
              ...(effectiveDetails.currentPeriodEnd ? { currentPeriodEnd: effectiveDetails.currentPeriodEnd } : {}),
              cancelAtPeriodEnd: effectiveDetails.cancelAtPeriodEnd,
              eventCreatedAt: parsed.created,
              lastEventId: parsed.id,
              source: 'verified-webhook',
              updatedAt: receivedAt,
            };
            state.subscription = subscription;
            handled = true;
          }
        } else if (parsed.type === 'invoice.paid' || parsed.type === 'invoice.payment_failed') {
          const subscriptionId = effectiveDetails.subscriptionId;
          if (state.subscription && state.subscription.status !== 'canceled' && subscriptionId === state.subscription.subscriptionId && parsed.created >= state.subscription.eventCreatedAt) {
            state.subscription = { ...state.subscription, status: parsed.type === 'invoice.paid' ? 'active' : 'past_due', eventCreatedAt: parsed.created, lastEventId: parsed.id, updatedAt: receivedAt };
            handled = true;
          } else {
            ignoredReason = 'unsupported';
          }
        } else if (REFUND_EVENTS.has(parsed.type)) {
          // Refund delivery is recorded for reconciliation, but a charge
          // refund alone cannot prove that a subscription was cancelled or
          // that all of an invoice was refunded. Access changes still come
          // from the provider's subscription lifecycle event.
          handled = (effectiveDetails.customerId === undefined || state.customer?.customerId === effectiveDetails.customerId)
            && (effectiveDetails.subscriptionId === undefined || state.subscription?.subscriptionId === effectiveDetails.subscriptionId);
          if (!handled) ignoredReason = 'unsupported';
        } else if (parsed.type === 'checkout.session.completed') {
          // Checkout completion establishes/reconciles the customer mapping;
          // subscription status still comes only from a subscription event.
          handled = effectiveDetails.customerId !== undefined && state.customer?.customerId === effectiveDetails.customerId;
          if (!handled) ignoredReason = 'unsupported';
        } else {
          ignoredReason = 'unsupported';
        }
        const event: BillingWebhookEvent = {
          provider: provider.id,
          eventId: parsed.id,
          eventType: parsed.type,
          createdAt: parsed.created,
          receivedAt,
          payloadDigest,
          organizationId,
          handled,
          ...(ignoredReason ? { ignoredReason } : {}),
        };
        state.webhookEvents.push(event);
        if (state.webhookEvents.length > MAX_WEBHOOK_EVENTS) state.webhookEvents.splice(0, state.webhookEvents.length - MAX_WEBHOOK_EVENTS);
        return { status: handled ? 'applied' as const : 'ignored' as const, eventId: parsed.id, eventType: parsed.type, organizationId, ...(ignoredReason ? { reason: ignoredReason } : {}) };
      });
    } catch (error) {
      if (mappingConflict(error)) throw new BillingError('TENANT_MAPPING_CONFLICT', 'Provider identifiers map to different organizations', 409);
      if (duplicateWebhook(error) || postgresUniqueViolation(error)) {
        // A concurrent delivery may have won the provider/event unique claim
        // in another transaction. Re-read the durable event before returning
        // success to avoid granting a second state transition.
        const recorded = await this.repository.findWebhookEvent(provider.id, parsed.id);
        if (recorded) return { status: 'duplicate', eventId: parsed.id, eventType: parsed.type, ...(recorded.organizationId ? { organizationId: recorded.organizationId } : {}) };
        if (postgresUniqueViolation(error)) {
          const [customerOrganizationId, subscriptionOrganizationId] = await Promise.all([
            details.customerId === undefined ? undefined : this.repository.findOrganizationByCustomerId(provider.id, details.customerId),
            details.subscriptionId === undefined ? undefined : this.repository.findOrganizationBySubscriptionId(provider.id, details.subscriptionId),
          ]);
          if ((customerOrganizationId && customerOrganizationId !== organizationId) || (subscriptionOrganizationId && subscriptionOrganizationId !== organizationId)) {
            throw new BillingError('TENANT_MAPPING_CONFLICT', 'Provider identifiers map to different organizations', 409);
          }
        }
      }
      throw error;
    }
  }

  /** Explicit aliases for framework adapters that name their webhook route. */
  processWebhook(rawBody: string, signatureHeader: string): Promise<WebhookHandlingResult> {
    return this.handleWebhook(rawBody, signatureHeader);
  }

  handleStripeWebhook(rawBody: string, signatureHeader: string): Promise<WebhookHandlingResult> {
    return this.handleWebhook(rawBody, signatureHeader);
  }
}

function normalizedDeltaInput(delta: UsageDelta): UsageDelta {
  try { return normalizedDelta(delta); } catch (error) {
    if (error instanceof BillingError) throw error;
    throw new BillingError('INVALID_USAGE', 'usage delta is invalid', 400);
  }
}

function nonnegativeDeltaInput(delta: UsageDelta): UsageDelta {
  const normalized = normalizedDeltaInput(delta);
  for (const [metric, value] of Object.entries(normalized)) {
    if ((value as number) < 0) throw new BillingError('INVALID_USAGE', `${metric} actual usage must be non-negative`, 400);
  }
  return normalized;
}

function firstExceeded(limits: PlanLimits, usage: BillingUsage, delta: UsageDelta): UsageLimitDetails | undefined {
  for (const metric of ['seats', 'storageBytes', 'scans', 'eveCostCents'] as const) {
    const requested = delta[metric] ?? 0;
    const used = usageValue(usage, metric);
    const limit = limitValue(limits, metric);
    if (used > limit) return { metric, limit, used: used - requested, requested };
  }
  return undefined;
}

export interface BillingEnvironmentOptions {
  repository: BillingRepository;
  env?: Readonly<Record<string, string | undefined>>;
  catalog?: PlanCatalog;
  successUrl?: string;
  cancelUrl?: string;
  portalReturnUrl?: string;
}

function envBool(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return value === '1' || value.toLowerCase() === 'true';
}

/**
 * Compose an optional service from deployment configuration. Missing provider
 * credentials produce an explicitly disabled service; they do not activate a
 * local paid mode or infer entitlements from an environment label.
 */
export function createBillingServiceFromEnv(options: BillingEnvironmentOptions): BillingService {
  const env = options.env ?? {};
  const catalog = options.catalog ?? createPlanCatalog({ env });
  const requested = envBool(env.PSKILLS_BILLING_ENABLED, false);
  const providerName = env.PSKILLS_BILLING_PROVIDER ?? 'stripe';
  let provider: BillingProvider | undefined;
  if (requested && providerName === 'stripe' && env.STRIPE_SECRET_KEY) {
    try {
      provider = createStripeBillingAdapter({
        secretKey: env.STRIPE_SECRET_KEY,
        ...(env.STRIPE_API_BASE_URL ? { apiBaseUrl: env.STRIPE_API_BASE_URL } : {}),
        ...(env.STRIPE_API_VERSION ? { apiVersion: env.STRIPE_API_VERSION } : {}),
      });
    } catch {
      provider = undefined;
    }
  } else if (requested && providerName === 'local' && env.PSKILLS_BILLING_LOCAL_TEST === 'true') {
    provider = createLocalBillingAdapter({ baseUrl: env.PSKILLS_BILLING_LOCAL_BASE_URL });
  }
  return new BillingService({
    repository: options.repository,
    catalog,
    provider,
    enabled: requested && provider !== undefined,
    ...(env.STRIPE_WEBHOOK_SECRET ? { webhookSecret: env.STRIPE_WEBHOOK_SECRET } : env.PSKILLS_BILLING_WEBHOOK_SECRET ? { webhookSecret: env.PSKILLS_BILLING_WEBHOOK_SECRET } : {}),
    ...(options.successUrl ? { successUrl: options.successUrl } : env.PSKILLS_BILLING_SUCCESS_URL ? { successUrl: env.PSKILLS_BILLING_SUCCESS_URL } : {}),
    ...(options.cancelUrl ? { cancelUrl: options.cancelUrl } : env.PSKILLS_BILLING_CANCEL_URL ? { cancelUrl: env.PSKILLS_BILLING_CANCEL_URL } : {}),
    ...(options.portalReturnUrl ? { portalReturnUrl: options.portalReturnUrl } : env.PSKILLS_BILLING_PORTAL_RETURN_URL ? { portalReturnUrl: env.PSKILLS_BILLING_PORTAL_RETURN_URL } : {}),
  });
}

export interface TestSubscriptionEventInput {
  eventId?: string;
  eventType?: 'customer.subscription.created' | 'customer.subscription.updated' | 'customer.subscription.deleted';
  created?: number;
  organizationId: string;
  customerId: string;
  subscriptionId: string;
  priceId: string;
  status?: BillingSubscriptionStatus;
  currentPeriodStart?: number;
  currentPeriodEnd?: number;
  cancelAtPeriodEnd?: boolean;
}

/** Build raw, deterministic local fixtures for webhook tests and demos. */
export function createTestSubscriptionEvent(input: TestSubscriptionEventInput): string {
  const now = Math.floor(Date.now() / 1_000);
  const eventType = input.eventType ?? 'customer.subscription.created';
  const event = {
    id: input.eventId ?? `evt_test_${crypto.randomUUID().replaceAll('-', '')}`,
    type: eventType,
    created: input.created ?? now,
    data: {
      object: {
        id: input.subscriptionId,
        object: 'subscription',
        customer: input.customerId,
        status: input.status ?? 'active',
        metadata: { organization_id: input.organizationId },
        items: { data: [{ price: { id: input.priceId } }] },
        ...(input.currentPeriodStart === undefined ? {} : { current_period_start: input.currentPeriodStart }),
        ...(input.currentPeriodEnd === undefined ? {} : { current_period_end: input.currentPeriodEnd }),
        cancel_at_period_end: input.cancelAtPeriodEnd ?? false,
      },
    },
  };
  return JSON.stringify(event);
}

export { BILLING_POSTGRES_SCHEMA_SQL, billingPostgresSchemaSql, createMemoryBillingRepository, createPostgresBillingRepository, MemoryBillingRepository, PostgresBillingRepository, defaultBillingState, defaultBillingUsage, periodBounds, assertBillingState, cloneBillingState, createPlanCatalog, DEFAULT_PLAN_DEFINITIONS, priceIdsFromEnv, validatePlanDefinition, validatePlanLimits, createLocalBillingAdapter, createStripeBillingAdapter, LocalBillingAdapter, StripeBillingAdapter, verifyWebhookSignature, signWebhookPayload };
