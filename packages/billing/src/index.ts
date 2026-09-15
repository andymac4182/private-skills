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
import { createLocalBillingAdapter, createStripeBillingAdapter, LocalBillingAdapter, StripeBillingAdapter, StripeBillingError, type LocalBillingAdapterOptions, type LocalBillingTestSession, type StripeBillingAdapterOptions } from './stripe.js';
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
  type BillingSeatRecoveryProof,
  type BillingSeatRecoveryResult,
  type BillingSeatReservation,
  type BillingStorageRecoveryAction,
  type BillingServiceOptions,
  type BillingStatus,
  type BillingSubscription,
  type BillingSubscriptionStatus,
  type BillingUsage,
  type BillingUsageOperation,
  type BillingUsageRestoration,
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
  type UsageRecoveryResolution,
  type UsageReservation,
  type UsageRestoration,
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

/** Browser-safe projection of a session created by the local test adapter. */
export interface BillingLocalDemoSession {
  provider: 'local';
  mode: 'test';
  kind: 'checkout' | 'portal';
  id: string;
  status: 'open' | 'completed';
  planId?: PlanId;
  planLabel?: string;
  returnUrl: string;
  cancelUrl?: string;
}

export interface BillingLocalDemoCompletion {
  session: BillingLocalDemoSession;
  webhookStatus: WebhookHandlingResult['status'];
}

const ACTIVE_SUBSCRIPTION_STATUSES = new Set<BillingSubscriptionStatus>(['active', 'trialing']);
const SUBSCRIPTION_EVENTS = new Set(['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted']);
const REFUND_EVENTS = new Set(['charge.refunded', 'refund.created', 'refund.updated']);
const MAX_OPERATION_KEY_BYTES = 256;
const INITIAL_RESERVATION_GENERATION = 1;
const MAX_RESERVATION_GENERATION = Number.MAX_SAFE_INTEGER;
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

function storageRestorationDelta(input: UsageDelta): UsageDelta & { storageBytes: number } {
  const normalized = normalizedDeltaInput(input);
  if (
    Object.keys(normalized).length !== 1 ||
    normalized.storageBytes === undefined ||
    !Number.isSafeInteger(normalized.storageBytes) ||
    normalized.storageBytes <= 0
  ) {
    throw new BillingError('INVALID_USAGE', 'storage restoration must contain a positive storageBytes delta only', 400);
  }
  return { storageBytes: normalized.storageBytes };
}

function normalizeReservationGeneration(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < INITIAL_RESERVATION_GENERATION || (value as number) > MAX_RESERVATION_GENERATION) {
    throw new BillingError('INVALID_USAGE', 'reservation generation is invalid', 400);
  }
  return value as number;
}

function operationReservationGeneration(operation: BillingUsageOperation): number {
  // Rows written before generation fencing are the first lifecycle. Keep that
  // interpretation stable so an upgrade does not reject a valid legacy retry.
  return operation.reservationGeneration === undefined
    ? INITIAL_RESERVATION_GENERATION
    : normalizeReservationGeneration(operation.reservationGeneration);
}

function nextReservationGeneration(operation: BillingUsageOperation): number {
  const current = operationReservationGeneration(operation);
  if (current >= MAX_RESERVATION_GENERATION) throw new BillingError('BILLING_LEDGER_CORRUPT', 'reservation generation exhausted', 500, { retryable: false });
  return current + 1;
}

function staleReservationGeneration(current: number, expected: number | undefined): BillingError {
  return new BillingError(
    'STALE_RESERVATION_GENERATION',
    expected === undefined
      ? 'A reservation generation is required after the lifecycle was reopened'
      : 'The usage reservation lifecycle is no longer current',
    409,
    {
      retryable: false,
      details: {
        currentGeneration: current,
        ...(expected === undefined ? {} : { expectedGeneration: expected }),
      },
    },
  );
}

function appendDurableUsageOperation(
  state: BillingOrganizationState,
  operation: BillingUsageOperation | undefined,
  organizationId: string,
  operationKey: string,
): void {
  if (!operation || state.usageOperations.some((candidate) => candidate.operationKey === operationKey)) return;
  if (operation.organizationId !== organizationId || operation.operationKey !== operationKey) {
    throw new BillingError('BILLING_LEDGER_CORRUPT', 'The usage operation belongs to another organization or key', 500, { retryable: true });
  }
  // Repository adapters return detached rows, but clone nested values here as
  // well so a transaction cannot mutate an adapter's exact-key cache through
  // the working organization state.
  state.usageOperations.push({
    ...operation,
    delta: { ...operation.delta },
    usage: { ...operation.usage },
    ...(operation.reconciled === undefined ? {} : { reconciled: { ...operation.reconciled } }),
  });
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

function seatState(state: BillingOrganizationState): { baseline: number; reservations: BillingSeatReservation[] } {
  const baseline = state.seatBaseline ?? state.usage.seats;
  if (!Number.isSafeInteger(baseline) || baseline < 0) throw new BillingError('INVALID_USAGE', 'stored seat baseline is invalid', 500);
  const reservations = state.seatReservations ?? [];
  if (!Array.isArray(reservations)) throw new BillingError('INVALID_USAGE', 'stored seat reservations are invalid', 500);
  state.seatBaseline = baseline;
  state.seatReservations = reservations;
  return { baseline, reservations };
}

function seatRevision(state: BillingOrganizationState): number {
  const revision = state.seatRevision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0) throw new BillingError('INVALID_USAGE', 'stored seat revision is invalid', 500);
  state.seatRevision = revision;
  return revision;
}

function seatReservationSnapshot(
  organizationId: string,
  operationKey: string,
  delta: UsageDelta,
  usage: BillingUsage,
  entitlement: BillingEntitlement,
  idempotent: boolean,
): UsageReservation {
  return {
    operationKey,
    idempotent,
    delta: { ...delta },
    snapshot: {
      organizationId,
      limits: { ...entitlement.limits },
      usage: { ...usage },
      entitlement,
    },
  };
}

function normalizeSeatRecoveryProof(value: BillingSeatRecoveryProof): BillingSeatRecoveryProof {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BillingError('INVALID_SEAT_RECOVERY_PROOF', 'A seat recovery proof is required', 400);
  }
  if (value.kind !== 'known-failure' && value.kind !== 'writer-terminated') {
    throw new BillingError('INVALID_SEAT_RECOVERY_PROOF', 'Seat recovery proof kind is invalid', 400);
  }
  let reference: string;
  try {
    reference = validateBillingIdentifier(value.reference, 'proof.reference', 256);
  } catch {
    throw new BillingError('INVALID_SEAT_RECOVERY_PROOF', 'Seat recovery proof reference is invalid', 400);
  }
  return { kind: value.kind, reference };
}

function cloneSeatReservation(reservation: BillingSeatReservation): BillingSeatReservation {
  return {
    operationKey: reservation.operationKey,
    status: reservation.status,
    ...(reservation.committed === undefined ? {} : { committed: reservation.committed }),
    ...(reservation.subjectKey === undefined ? {} : { subjectKey: reservation.subjectKey }),
    ...(reservation.revision === undefined ? {} : { revision: reservation.revision }),
    ...(reservation.recoveryProof === undefined ? {} : { recoveryProof: { ...reservation.recoveryProof } }),
    createdAt: reservation.createdAt,
    updatedAt: reservation.updatedAt,
  };
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
  private readonly usageEnabled: boolean;
  private readonly webhookSecret?: string;
  private readonly webhookToleranceSeconds: number;
  private readonly maxWebhookBodyBytes: number;
  private readonly now: () => number;
  private readonly customerMutex = new ServiceKeyedMutex();
  private readonly successUrl?: string;
  private readonly cancelUrl?: string;
  private readonly portalReturnUrl?: string;

  constructor(options: BillingServiceOptions) {
    if (!options.repository || typeof options.repository.read !== 'function' || typeof options.repository.transaction !== 'function' || typeof options.repository.findUsageOperation !== 'function') throw new BillingError('INVALID_CONFIGURATION', 'billing repository is required', 500);
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
    if (options.usageEnabled !== undefined && typeof options.usageEnabled !== 'boolean') throw new BillingError('INVALID_CONFIGURATION', 'billing usage mode is invalid', 500);
    // Explicit billing enablement is also the admission switch. A provider
    // is only required for hosted payment calls; the durable usage ledger can
    // enforce the free or verified plan limits while provider setup is being
    // completed. Hosts may explicitly disable usage with `usageEnabled:false`.
    this.usageEnabled = options.usageEnabled ?? this.enabled;
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
    const providerReady = this.enabled && this.provider !== undefined;
    const mode: BillingMode = this.provider?.mode ?? (this.usageEnabled ? 'test' : 'disabled');
    return {
      enabled: this.usageEnabled,
      providerReady,
      usageEnforcement: this.usageEnabled,
      provider: this.provider?.id ?? null,
      mode,
      webhookVerification: this.enabled && providerReady && this.webhookSecret !== undefined,
      checkout: this.enabled && providerReady && Boolean(this.successUrl && this.cancelUrl) && this.hasConfiguredPaidPlan(),
      // Keep both hosted entry points closed until at least one server-owned
      // recurring price mapping is configured for the deployment.
      portal: this.enabled && providerReady && Boolean(this.portalReturnUrl) && this.hasConfiguredPaidPlan(),
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
    return entitlementFromState(this.catalog, state, this.usageEnabled);
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
   * Return a safe, tenant-bound projection for a local test session. These
   * sessions are process-local fixtures; live Stripe sessions never enter
   * this surface.
   */
  getLocalDemoSession(
    organizationId: string,
    kind: LocalBillingTestSession['kind'],
    sessionId: string,
  ): BillingLocalDemoSession | null {
    const normalizedOrganizationId = validateBillingOrganizationId(organizationId);
    const normalizedSessionId = validateBillingIdentifier(sessionId, 'sessionId', 256);
    const provider = this.localDemoProvider();
    const session = provider.getTestSession(normalizedSessionId);
    if (!session || session.kind !== kind || session.organizationId !== normalizedOrganizationId) return null;
    if (session.kind === 'checkout') {
      const plan = this.catalog.get(session.planId as PlanId);
      if (!plan || plan.id === 'free') return null;
      return {
        provider: 'local',
        mode: 'test',
        kind: 'checkout',
        id: session.id,
        status: session.status,
        planId: plan.id,
        planLabel: plan.label,
        returnUrl: session.successUrl,
        cancelUrl: session.cancelUrl,
      };
    }
    return {
      provider: 'local',
      mode: 'test',
      kind: 'portal',
      id: session.id,
      status: session.status,
      returnUrl: session.returnUrl,
    };
  }

  /**
   * Complete a local checkout through the same signed webhook path used by
   * provider deliveries. The browser cannot supply a plan, customer, or
   * signing secret, and retries remain safe because the event id is stable.
   */
  async completeLocalDemoCheckout(organizationId: string, sessionId: string): Promise<BillingLocalDemoCompletion> {
    const normalizedOrganizationId = validateBillingOrganizationId(organizationId);
    const normalizedSessionId = validateBillingIdentifier(sessionId, 'sessionId', 256);
    const provider = this.localDemoProvider();
    const source = provider.getTestSession(normalizedSessionId);
    if (!source || source.kind !== 'checkout' || source.organizationId !== normalizedOrganizationId) {
      throw new BillingError('BILLING_SESSION_NOT_FOUND', 'The local checkout session is unavailable.', 404);
    }
    const existing = this.getLocalDemoSession(normalizedOrganizationId, 'checkout', normalizedSessionId);
    if (!existing) throw new BillingError('BILLING_SESSION_NOT_FOUND', 'The local checkout session is unavailable.', 404);
    if (existing.status === 'completed') return { session: existing, webhookStatus: 'duplicate' };
    if (!this.webhookSecret) throw new BillingError('BILLING_WEBHOOK_UNAVAILABLE', 'Local billing webhook verification is not configured.', 503, { retryable: true });
    const created = Math.floor(this.now() / 1_000);
    const rawBody = createTestSubscriptionEvent({
      eventId: `evt_local_checkout_${source.id}`,
      created,
      organizationId: normalizedOrganizationId,
      customerId: source.customerId,
      // Keep the fixture identifier in the same `sub_` namespace accepted by
      // the provider payload parser. It remains deterministic and scoped to
      // this local session while exercising the real webhook path.
      subscriptionId: `sub_local_${source.id}`,
      priceId: source.priceId,
      currentPeriodStart: created,
      currentPeriodEnd: created + 30 * 86_400,
    });
    const signature = await signWebhookPayload(rawBody, this.webhookSecret, created);
    const webhook = await this.handleWebhook(rawBody, signature);
    const entitlement = await this.entitlement(normalizedOrganizationId);
    const expectedSubscriptionId = `sub_local_${source.id}`;
    if ((webhook.status !== 'applied' && webhook.status !== 'duplicate')
      || entitlement.subscriptionId !== expectedSubscriptionId
      || entitlement.planId !== source.planId
      || entitlement.state !== 'active') {
      throw new BillingError('BILLING_SESSION_NOT_COMPLETED', 'The signed local checkout event did not establish the requested entitlement.', 409, {
        details: { webhookStatus: webhook.status },
      });
    }
    provider.markTestCheckoutCompleted(source.id);
    const completed = this.getLocalDemoSession(normalizedOrganizationId, 'checkout', normalizedSessionId);
    if (!completed) throw new BillingError('BILLING_SESSION_NOT_FOUND', 'The local checkout session is unavailable.', 404);
    return { session: completed, webhookStatus: webhook.status };
  }

  private localDemoProvider(): LocalBillingAdapter {
    const status = this.status();
    if (!status.enabled || status.provider !== 'local' || status.mode !== 'test' || !status.webhookVerification || !(this.provider instanceof LocalBillingAdapter)) {
      throw new BillingError('BILLING_UNAVAILABLE', 'The local billing demo is available only in local test mode.', 404);
    }
    return this.provider;
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
    const entitlement = entitlementFromState(this.catalog, state, this.usageEnabled);
    return { organizationId: normalized, limits: { ...entitlement.limits }, usage: periodUsage(state.usage, this.now()), entitlement };
  }

  private transactionWithUsageOperations<T>(
    organizationId: string,
    operationKeys: readonly string[],
    updater: (state: BillingOrganizationState) => T,
  ): Promise<T> {
    const transactionWithOperations = this.repository.transactionWithUsageOperations;
    if (transactionWithOperations) return transactionWithOperations.call(this.repository, organizationId, operationKeys, updater) as Promise<T>;
    const transactionWithOperation = this.repository.transactionWithUsageOperation;
    if (transactionWithOperation && operationKeys.length === 1) return transactionWithOperation.call(this.repository, organizationId, operationKeys[0]!, updater) as Promise<T>;
    // Compatibility fallback for small custom repositories. Production
    // repositories implement the exact-row transaction above; a repository
    // without it cannot provide the same aged-operation guarantee.
    return this.repository.transaction(organizationId, updater);
  }

  /**
   * Recover a retained usage reservation after a host restart. The operation
   * record is the billing system's durable source of tenant identity and
   * reserved Eve amount; callers must not reconstruct it from request data.
   */
  async findUsageOperation(organizationId: string, operationKey: string): Promise<BillingUsageOperation | undefined>;
  async findUsageOperation(operationKey: string): Promise<BillingUsageOperation | undefined>;
  async findUsageOperation(first: string, second?: string): Promise<BillingUsageOperation | undefined> {
    if (second === undefined) {
      const normalized = validateBillingIdentifier(first, 'operationKey', MAX_OPERATION_KEY_BYTES);
      return this.repository.findUsageOperation(normalized);
    }
    const normalizedOrganization = validateBillingOrganizationId(first);
    const normalized = validateBillingIdentifier(second, 'operationKey', MAX_OPERATION_KEY_BYTES);
    return this.repository.findUsageOperation(normalizedOrganization, normalized);
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
    // The repository reloads this exact key inside the organization lock, so
    // an aged idempotency row cannot be missed or raced by a pre-lock lookup.
    return this.transactionWithUsageOperations(normalized, [normalizedKey], (state) => this.reserveUsageInState(state, normalized, normalizedDelta, normalizedKey, nowMs));
  }

  /**
   * Restore the exact retained storage bytes from a released reservation.
   *
   * This is deliberately separate from reserveUsage: a recovery inverse must
   * repair accounting even when a concurrent admission has filled the plan
   * cap. The successful inverse advances the reservation lifecycle, so an
   * old zero reconciliation cannot erase the restored bytes. The compensation
   * operation records its source and generation fence for durable, no-write
   * retries after a lost response, restart, or operation-window eviction.
   */
  async restoreUsage(
    organizationId: string,
    reservationKey: string,
    delta: UsageDelta,
    operationKey: string,
    reservationGeneration: number,
  ): Promise<UsageRestoration> {
    const normalized = validateBillingOrganizationId(organizationId);
    const normalizedReservationKey = validateBillingIdentifier(reservationKey, 'reservationKey', MAX_OPERATION_KEY_BYTES);
    const normalizedDelta = storageRestorationDelta(delta);
    const normalizedKey = validateBillingIdentifier(operationKey, 'operationKey', MAX_OPERATION_KEY_BYTES);
    const expectedGeneration = normalizeReservationGeneration(reservationGeneration);
    const nowMs = this.now();

    return this.transactionWithUsageOperations(normalized, [normalizedReservationKey, normalizedKey], (state) => {
      const reservation = state.usageOperations.find((candidate) => candidate.operationKey === normalizedReservationKey);
      if (!reservation) throw new BillingError('USAGE_RESERVATION_NOT_FOUND', 'The usage reservation does not exist', 404);
      const currentGeneration = operationReservationGeneration(reservation);
      const existing = state.usageOperations.find((candidate) => candidate.operationKey === normalizedKey);

      if (existing) {
        const restoration = existing.restoration;
        if (!restoration || (restoration.action ?? 'restored') !== 'restored' || restoration.reservationKey !== normalizedReservationKey || !sameDelta(existing.delta, normalizedDelta) || !sameDelta(restoration.delta, normalizedDelta)) {
          throw new BillingError('IDEMPOTENCY_CONFLICT', 'The restoration operation key was already used for another inverse', 409);
        }
        const storedFromGeneration = normalizeReservationGeneration(restoration.fromGeneration);
        const storedToGeneration = normalizeReservationGeneration(restoration.toGeneration);
        if (storedToGeneration !== storedFromGeneration + 1 || existing.status !== 'committed' || operationReservationGeneration(existing) !== storedToGeneration) {
          throw new BillingError('BILLING_LEDGER_CORRUPT', 'The usage restoration lifecycle is invalid', 500, { retryable: false });
        }
        // A retry may carry the pre-inverse generation when the first response
        // was lost. It is safe only because the durable operation and source
        // reservation prove the exact inverse already committed. A later
        // lifecycle cannot be mutated by this replay.
        if (expectedGeneration !== storedFromGeneration) {
          throw staleReservationGeneration(currentGeneration, expectedGeneration);
        }
        const originalStorage = reservation.delta.storageBytes;
        if (
          typeof originalStorage !== 'number' ||
          !Number.isSafeInteger(originalStorage) ||
          originalStorage !== normalizedDelta.storageBytes ||
          Object.keys(reservation.delta).length !== 1 ||
          reservation.delta.storageBytes === undefined ||
          currentGeneration < storedToGeneration
        ) {
          throw new BillingError('BILLING_LEDGER_CORRUPT', 'The usage restoration source lifecycle no longer matches its inverse', 500, { retryable: false });
        }
        const entitlement = entitlementFromState(this.catalog, state, this.enabled);
        const restorationMetadata: BillingUsageRestoration = {
          reservationKey: normalizedReservationKey,
          fromGeneration: storedFromGeneration,
          toGeneration: storedToGeneration,
          delta: { ...normalizedDelta },
          action: 'restored',
        };
        return {
          operationKey: normalizedKey,
          idempotent: true,
          delta: { ...normalizedDelta },
          restoredFromGeneration: storedFromGeneration,
          reservationGeneration: storedToGeneration,
          restoration: restorationMetadata,
          snapshot: { organizationId: normalized, limits: { ...entitlement.limits }, usage: { ...existing.usage }, entitlement },
        };
      }

      if (expectedGeneration !== currentGeneration) throw staleReservationGeneration(currentGeneration, expectedGeneration);
      if ((reservation.status ?? 'reserved') !== 'released') {
        throw new BillingError('USAGE_RESTORATION_INVALID', 'Only a released usage reservation can be restored', 409);
      }
      const originalStorage = reservation.delta.storageBytes;
      if (
        typeof originalStorage !== 'number' ||
        !Number.isSafeInteger(originalStorage) ||
        originalStorage <= 0 ||
        originalStorage !== normalizedDelta.storageBytes ||
        Object.keys(reservation.delta).length !== 1 ||
        reservation.delta.storageBytes === undefined
      ) {
        throw new BillingError('USAGE_RESTORATION_INVALID', 'Storage restoration must exactly match the released reservation', 409);
      }
      if ((reservation.reconciled?.storageBytes ?? 0) !== 0) {
        throw new BillingError('USAGE_RESTORATION_INVALID', 'The released reservation does not have a zero storage reconciliation', 409);
      }

      state.usage = periodUsage(state.usage, nowMs);
      const nextGeneration = nextReservationGeneration(reservation);
      // Do not call reserveUsageInState here: this inverse intentionally
      // bypasses the quota check, but still uses the same nonnegative ledger
      // arithmetic and the same organization transaction lock.
      state.usage = applyDelta(state.usage, normalizedDelta, nowMs);
      // The inverse starts a fresh measurement lifecycle at the next
      // generation. Keep any other metric measurements, but remove the old
      // zero for storage so a later cleanup can report storageBytes: 0 using
      // the returned generation without tripping reconciliation idempotency.
      const nextReconciled = { ...(reservation.reconciled ?? {}) };
      delete nextReconciled.storageBytes;
      reservation.reconciled = Object.keys(nextReconciled).length === 0 ? undefined : nextReconciled;
      reservation.status = 'committed';
      reservation.reservationGeneration = nextGeneration;
      reservation.usage = { ...state.usage };
      const restorationMetadata: BillingUsageRestoration = {
        reservationKey: normalizedReservationKey,
        fromGeneration: expectedGeneration,
        toGeneration: nextGeneration,
        delta: { ...normalizedDelta },
        action: 'restored',
      };
      state.usageOperations.push({
        organizationId: normalized,
        operationKey: normalizedKey,
        delta: { ...normalizedDelta },
        usage: { ...state.usage },
        createdAt: new Date(nowMs).toISOString(),
        status: 'committed',
        reservationGeneration: nextGeneration,
        restoration: restorationMetadata,
      });
      if (state.usageOperations.length > 20_000) state.usageOperations.splice(0, state.usageOperations.length - 20_000);
      const entitlement = entitlementFromState(this.catalog, state, this.enabled);
      return {
        operationKey: normalizedKey,
        idempotent: false,
        delta: { ...normalizedDelta },
        restoredFromGeneration: expectedGeneration,
        reservationGeneration: nextGeneration,
        restoration: restorationMetadata,
        snapshot: { organizationId: normalized, limits: { ...entitlement.limits }, usage: { ...state.usage }, entitlement },
      };
    });
  }

  /**
   * Resolve an uncertain storage release after a metadata reference appears.
   *
   * A storage recovery can crash after the zero reconciliation commits but
   * before the storage attempt reaches its terminal state.  This transaction
   * observes the exact reservation lifecycle under the same organization row
   * lock as reconcileUsage: a released G1 is restored and advanced to G2,
   * while a still-reserved/committed G1 is advanced to G2 without changing
   * usage.  The latter is the fence that makes a late G1 zero fail closed.
   */
  async resolveStorageRecovery(
    organizationId: string,
    reservationKey: string,
    delta: UsageDelta,
    operationKey: string,
    reservationGeneration: number,
  ): Promise<UsageRecoveryResolution> {
    const normalized = validateBillingOrganizationId(organizationId);
    const normalizedReservationKey = validateBillingIdentifier(reservationKey, 'reservationKey', MAX_OPERATION_KEY_BYTES);
    const normalizedDelta = storageRestorationDelta(delta);
    const normalizedKey = validateBillingIdentifier(operationKey, 'operationKey', MAX_OPERATION_KEY_BYTES);
    const expectedGeneration = normalizeReservationGeneration(reservationGeneration);
    const nowMs = this.now();

    return this.transactionWithUsageOperations(normalized, [normalizedReservationKey, normalizedKey], (state) => {
      const reservation = state.usageOperations.find((candidate) => candidate.operationKey === normalizedReservationKey);
      if (!reservation) throw new BillingError('USAGE_RESERVATION_NOT_FOUND', 'The usage reservation does not exist', 404);
      const currentGeneration = operationReservationGeneration(reservation);
      const existing = state.usageOperations.find((candidate) => candidate.operationKey === normalizedKey);

      if (existing) {
        const restoration = existing.restoration;
        const action = restoration?.action ?? 'restored';
        const existingDeltaIsValid = action === 'restored'
          ? sameDelta(existing.delta, normalizedDelta)
          : action === 'fenced' && Object.keys(existing.delta).length === 0;
        if (
          !restoration ||
          (action !== 'restored' && action !== 'fenced') ||
          restoration.reservationKey !== normalizedReservationKey ||
          !sameDelta(restoration.delta, normalizedDelta) ||
          !existingDeltaIsValid
        ) {
          throw new BillingError('IDEMPOTENCY_CONFLICT', 'The storage recovery operation key was already used for another resolution', 409);
        }
        const storedFromGeneration = normalizeReservationGeneration(restoration.fromGeneration);
        const storedToGeneration = normalizeReservationGeneration(restoration.toGeneration);
        if (
          storedToGeneration !== storedFromGeneration + 1 ||
          existing.status !== 'committed' ||
          operationReservationGeneration(existing) !== storedToGeneration
        ) {
          throw new BillingError('BILLING_LEDGER_CORRUPT', 'The storage recovery lifecycle is invalid', 500, { retryable: false });
        }
        // A lost response is replayed with the original source generation.
        // Never accept the returned generation as a new request: that would
        // make a later lifecycle look like the old recovery operation.
        if (expectedGeneration !== storedFromGeneration) throw staleReservationGeneration(currentGeneration, expectedGeneration);

        const originalStorage = reservation.delta.storageBytes;
        if (
          typeof originalStorage !== 'number' ||
          !Number.isSafeInteger(originalStorage) ||
          originalStorage <= 0 ||
          originalStorage !== normalizedDelta.storageBytes ||
          Object.keys(reservation.delta).length !== 1 ||
          currentGeneration < storedToGeneration
        ) {
          throw new BillingError('BILLING_LEDGER_CORRUPT', 'The storage recovery source lifecycle no longer matches its resolution', 500, { retryable: false });
        }
        const entitlement = entitlementFromState(this.catalog, state, this.enabled);
        const stableMetadata: BillingUsageRestoration = {
          reservationKey: normalizedReservationKey,
          fromGeneration: storedFromGeneration,
          toGeneration: storedToGeneration,
          delta: { ...normalizedDelta },
          action,
        };
        return {
          operationKey: normalizedKey,
          action,
          idempotent: true,
          restoredFromGeneration: storedFromGeneration,
          reservationGeneration: storedToGeneration,
          restoration: stableMetadata,
          snapshot: { organizationId: normalized, limits: { ...entitlement.limits }, usage: { ...existing.usage }, entitlement },
        };
      }

      if (expectedGeneration !== currentGeneration) throw staleReservationGeneration(currentGeneration, expectedGeneration);

      const originalStorage = reservation.delta.storageBytes;
      if (
        typeof originalStorage !== 'number' ||
        !Number.isSafeInteger(originalStorage) ||
        originalStorage <= 0 ||
        originalStorage !== normalizedDelta.storageBytes ||
        Object.keys(reservation.delta).length !== 1 ||
        reservation.delta.storageBytes === undefined
      ) {
        throw new BillingError('USAGE_RESTORATION_INVALID', 'Storage recovery must exactly match the original storage reservation', 409);
      }

      const reservationStatus = reservation.status ?? 'reserved';
      let action: BillingStorageRecoveryAction;
      if (reservationStatus === 'released') {
        // A released storage-only reservation must prove that zero was the
        // committed measurement. Missing or non-zero state is corruption, not
        // permission to invent a second inverse.
        if (reservation.reconciled?.storageBytes !== 0) {
          throw new BillingError('BILLING_LEDGER_CORRUPT', 'A released storage reservation has no exact zero reconciliation', 500, { retryable: false });
        }
        action = 'restored';
        state.usage = periodUsage(state.usage, nowMs);
        // This inverse deliberately bypasses quota admission. Future normal
        // reservations still use the finite-plan limit against the restored
        // aggregate usage.
        state.usage = applyDelta(state.usage, normalizedDelta, nowMs);
        const nextReconciled = { ...(reservation.reconciled ?? {}) };
        delete nextReconciled.storageBytes;
        reservation.reconciled = Object.keys(nextReconciled).length === 0 ? undefined : nextReconciled;
        reservation.status = 'committed';
      } else if (reservationStatus === 'reserved' || reservationStatus === 'committed') {
        // The charge is still present. Do not apply a positive adjustment; the
        // generation advance alone fences a delayed zero carrying G1.
        action = 'fenced';
      } else {
        throw new BillingError('BILLING_LEDGER_CORRUPT', 'The storage recovery source lifecycle has an invalid status', 500, { retryable: false });
      }

      const nextGeneration = nextReservationGeneration(reservation);
      reservation.reservationGeneration = nextGeneration;
      reservation.usage = { ...state.usage };
      const restorationMetadata: BillingUsageRestoration = {
        reservationKey: normalizedReservationKey,
        fromGeneration: expectedGeneration,
        toGeneration: nextGeneration,
        delta: { ...normalizedDelta },
        action,
      };
      state.usageOperations.push({
        organizationId: normalized,
        operationKey: normalizedKey,
        // A fence is a durable no-op. Keep the operation delta empty so
        // reports cannot mistake it for an additional usage charge; the
        // metadata carries the exact original bytes being protected.
        delta: action === 'restored' ? { ...normalizedDelta } : {},
        usage: { ...state.usage },
        createdAt: new Date(nowMs).toISOString(),
        status: 'committed',
        reservationGeneration: nextGeneration,
        restoration: restorationMetadata,
      });
      if (state.usageOperations.length > 20_000) state.usageOperations.splice(0, state.usageOperations.length - 20_000);
      const entitlement = entitlementFromState(this.catalog, state, this.enabled);
      return {
        operationKey: normalizedKey,
        action,
        idempotent: false,
        restoredFromGeneration: expectedGeneration,
        reservationGeneration: nextGeneration,
        restoration: restorationMetadata,
        snapshot: { organizationId: normalized, limits: { ...entitlement.limits }, usage: { ...state.usage }, entitlement },
      };
    });
  }

  /**
   * Reconcile a pre-reserved estimate with measured usage in one transaction.
   * The reservation remains the fail-closed guard before work starts; this
   * correction records the difference after the worker reports actual cost.
   * New callers should pass the generation returned by reserveUsage so a
   * delayed callback cannot release a later admission with the same key.
   */
  async reconcileUsage(
    organizationId: string,
    reservationKey: string,
    actual: UsageDelta,
    operationKey: string,
    reservationGeneration?: number,
  ): Promise<UsageReservation> {
    const normalized = validateBillingOrganizationId(organizationId);
    const normalizedReservationKey = validateBillingIdentifier(reservationKey, 'reservationKey', MAX_OPERATION_KEY_BYTES);
    const normalizedActual = nonnegativeDeltaInput(actual);
    const normalizedKey = validateBillingIdentifier(operationKey, 'operationKey', MAX_OPERATION_KEY_BYTES);
    const expectedGeneration = reservationGeneration === undefined
      ? undefined
      : normalizeReservationGeneration(reservationGeneration);
    const nowMs = this.now();
    // Reload both the reservation and correction rows inside the organization
    // lock so a bounded snapshot cannot miss an aged operation or race a
    // concurrent reconciliation.
    return this.transactionWithUsageOperations(normalized, [normalizedReservationKey, normalizedKey], (state) => {
      const reservation = state.usageOperations.find((candidate) => candidate.operationKey === normalizedReservationKey);
      if (!reservation) throw new BillingError('USAGE_RESERVATION_NOT_FOUND', 'The usage reservation does not exist', 404);
      const currentGeneration = operationReservationGeneration(reservation);
      // A four-argument reconciliation remains valid for the first lifecycle
      // (including legacy rows). Once the reservation is reopened, omission is
      // ambiguous and is rejected exactly like an explicitly stale token.
      if (expectedGeneration === undefined && currentGeneration > INITIAL_RESERVATION_GENERATION) {
        throw staleReservationGeneration(currentGeneration, expectedGeneration);
      }
      if (expectedGeneration !== undefined && expectedGeneration !== currentGeneration) {
        throw staleReservationGeneration(currentGeneration, expectedGeneration);
      }
      const reservationStatus = reservation.status ?? 'reserved';
      if (reservationStatus === 'released' && Object.values(normalizedActual).some((value) => value !== 0)) {
        throw new BillingError('USAGE_RESERVATION_CLOSED', 'A released usage reservation cannot be charged again', 409);
      }
      const priorActual = reservation.reconciled ?? {};
      const correction: UsageDelta = {};
      let newMeasurement = false;
      for (const metric of ['seats', 'storageBytes', 'scans', 'eveCostCents'] as const) {
        // A measured usage report may cover only one metered resource.  An
        // omitted metric keeps its reservation; an explicit zero releases it.
        if (normalizedActual[metric] === undefined) continue;
        const actualValue = normalizedActual[metric] ?? 0;
        if (priorActual[metric] !== undefined) {
          if (priorActual[metric] !== actualValue) throw new BillingError('IDEMPOTENCY_CONFLICT', 'A usage reservation was reconciled with a different measured value', 409);
          continue;
        }
        newMeasurement = true;
        const difference = actualValue - (reservation.delta[metric] ?? 0);
        if (difference !== 0) correction[metric] = difference;
      }
      const entitlement = entitlementFromState(this.catalog, state, this.enabled);
      const result = Object.keys(correction).length === 0
        ? {
          operationKey: normalizedKey,
          idempotent: !newMeasurement,
          delta: {},
          reservationGeneration: currentGeneration,
          snapshot: { organizationId: normalized, limits: { ...entitlement.limits }, usage: { ...state.usage }, entitlement },
        }
        : this.reserveUsageInState(state, normalized, correction, normalizedKey, nowMs, currentGeneration);
      if (newMeasurement) {
        const nextActual = { ...priorActual };
        for (const metric of ['seats', 'storageBytes', 'scans', 'eveCostCents'] as const) {
          if (normalizedActual[metric] !== undefined) nextActual[metric] = normalizedActual[metric];
        }
        reservation.reconciled = nextActual;
        const covered = Object.keys(reservation.delta).every((metric) => nextActual[metric as BillingMetric] !== undefined);
        reservation.status = covered
          ? Object.values(nextActual).every((value) => value === 0) ? 'released' : 'committed'
          : 'reserved';
        // Keep the operation's replay snapshot aligned with the resulting
        // committed usage. This is the value returned for a later idempotent
        // retry of the reservation key.
        reservation.usage = { ...state.usage };
      }
      // A release correction is itself a durable lifecycle operation. Marking
      // it released lets a later re-admission with the same reservation key
      // reopen and apply the same correction exactly once, while retries in
      // the current lifecycle remain idempotent.
      const correctionOperation = state.usageOperations.find((candidate) => candidate.operationKey === normalizedKey);
      if (correctionOperation && correctionOperation !== reservation) {
        correctionOperation.reservationGeneration = currentGeneration;
        correctionOperation.status = reservation.status === 'released'
          ? 'released'
          : reservation.status === 'committed'
            ? 'committed'
            : 'reserved';
      }
      return result;
    });
  }

  reconcileReservedUsage(
    organizationId: string,
    reservationKey: string,
    actual: UsageDelta,
    operationKey: string,
    reservationGeneration?: number,
  ): Promise<UsageReservation> {
    return this.reconcileUsage(organizationId, reservationKey, actual, operationKey, reservationGeneration);
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
    reservationGeneration?: number,
  ): UsageReservation {
    state.usage = periodUsage(state.usage, nowMs);
    const entitlement = entitlementFromState(this.catalog, state, this.usageEnabled);
    const existing = state.usageOperations.find((candidate) => candidate.operationKey === operationKey);
    if (existing) {
      if (!sameDelta(existing.delta, delta)) throw new BillingError('IDEMPOTENCY_CONFLICT', 'Usage operation key was already used with another delta', 409);
      // A definite no-write reconciliation closes a reservation without
      // consuming its operation key forever. Reopening the same key is a new
      // admission and must perform the limit check again before work starts.
      if (existing.status === 'released') {
        const next = applyDelta(state.usage, delta, nowMs);
        const exceeded = firstExceeded(entitlement.limits, next, delta);
        if (exceeded) throw new BillingError('USAGE_LIMIT_EXCEEDED', `The ${exceeded.metric} limit has been reached`, 429, { retryable: false, details: { ...exceeded } });
        state.usage = next;
        existing.status = 'reserved';
        delete existing.reconciled;
        existing.usage = { ...next };
        existing.reservationGeneration = reservationGeneration ?? nextReservationGeneration(existing);
        return {
          operationKey,
          idempotent: false,
          delta: { ...delta },
          reservationGeneration: operationReservationGeneration(existing),
          snapshot: { organizationId, limits: { ...entitlement.limits }, usage: { ...next }, entitlement },
        };
      }
      const generation = operationReservationGeneration(existing);
      return {
        operationKey,
        idempotent: true,
        delta: { ...existing.delta },
        reservationGeneration: generation,
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
      status: 'reserved',
      reservationGeneration: reservationGeneration ?? INITIAL_RESERVATION_GENERATION,
    };
    state.usageOperations.push(operation);
    if (state.usageOperations.length > 20_000) state.usageOperations.splice(0, state.usageOperations.length - 20_000);
    return {
      operationKey,
      idempotent: false,
      delta: { ...delta },
      reservationGeneration: operation.reservationGeneration,
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

  /** Return the durable revision used to fence an identity count snapshot. */
  async seatRevision(organizationId: string): Promise<number> {
    const normalized = validateBillingOrganizationId(organizationId);
    const state = await this.repository.read(normalized);
    return seatRevision(state);
  }

  /** Compatibility alias for callers that provide an authoritative seat count. */
  async setSeatCount(organizationId: string, seats: number, operationKey: string): Promise<UsageReservation> {
    return this.syncSeatCount(organizationId, seats, operationKey);
  }

  /**
   * Reserve one organization seat before Better Auth creates a member or
   * invitation. The reservation and its lifecycle are stored with the locked
   * organization usage row, so another process cannot reset an in-flight
   * admission while it is reading the authoritative identity rows.
   */
  async reserveSeat(organizationId: string, operationKey: string, options: { subjectKey?: boolean } = {}): Promise<UsageReservation> {
    const normalized = validateBillingOrganizationId(organizationId);
    const normalizedKey = validateBillingIdentifier(operationKey, 'operationKey', MAX_OPERATION_KEY_BYTES);
    const nowMs = this.now();
    return this.repository.transaction(normalized, (state) => {
      state.usage = periodUsage(state.usage, nowMs);
      const { reservations } = seatState(state);
      const revision = seatRevision(state);
      const subjectKey = options.subjectKey === true;
      const entitlement = entitlementFromState(this.catalog, state, this.enabled);
      const existing = reservations.find((candidate) => candidate.operationKey === normalizedKey);
      if (existing?.status === 'active') {
        if (subjectKey && existing.subjectKey !== true) {
          existing.subjectKey = true;
          existing.revision = revision;
        }
        const exceeded = firstExceeded(entitlement.limits, state.usage, {});
        if (exceeded) throw new BillingError('USAGE_LIMIT_EXCEEDED', `The ${exceeded.metric} limit has been reached`, 429, { retryable: false, details: { ...exceeded } });
        return seatReservationSnapshot(normalized, normalizedKey, { seats: 1 }, state.usage, entitlement, true);
      }
      const next = applyDelta(state.usage, { seats: 1 }, nowMs);
      const exceeded = firstExceeded(entitlement.limits, next, { seats: 1 });
      if (exceeded) throw new BillingError('USAGE_LIMIT_EXCEEDED', `The ${exceeded.metric} limit has been reached`, 429, { retryable: false, details: { ...exceeded } });
      const timestamp = new Date(nowMs).toISOString();
      if (existing) {
        existing.status = 'active';
        existing.committed = false;
        existing.subjectKey = subjectKey || existing.subjectKey === true;
        existing.revision = revision;
        delete existing.recoveryProof;
        existing.updatedAt = timestamp;
      } else {
        reservations.push({ operationKey: normalizedKey, status: 'active', committed: false, subjectKey, revision, createdAt: timestamp, updatedAt: timestamp });
      }
      state.usage = next;
      return seatReservationSnapshot(normalized, normalizedKey, { seats: 1 }, next, entitlement, false);
    });
  }

  /**
   * List active Better Auth holds for an authenticated company operator. An
   * active hold is intentionally not inferred to be expired from its age;
   * the writer may still be committing the identity row.
   */
  async activeSeatReservations(organizationId: string): Promise<readonly BillingSeatReservation[]> {
    const normalized = validateBillingOrganizationId(organizationId);
    const state = await this.repository.read(normalized);
    return (state.seatReservations ?? [])
      .filter((reservation) => reservation.status === 'active' && reservation.subjectKey === true)
      .map(cloneSeatReservation);
  }

  /**
   * Explicitly release a Better Auth hold after the host proves that the
   * identity writer failed or was terminated. The proof is recorded beside
   * the durable hold. A settled committed hold, or a settled hold released
   * through another lifecycle hook, can never be released through this path.
   */
  async releaseSeatAfterFailure(
    organizationId: string,
    operationKey: string,
    proof: BillingSeatRecoveryProof,
  ): Promise<BillingSeatRecoveryResult> {
    const normalized = validateBillingOrganizationId(organizationId);
    const normalizedKey = validateBillingIdentifier(operationKey, 'operationKey', MAX_OPERATION_KEY_BYTES);
    const normalizedProof = normalizeSeatRecoveryProof(proof);
    const nowMs = this.now();
    return this.repository.transaction(normalized, (state) => {
      state.usage = periodUsage(state.usage, nowMs);
      const { reservations } = seatState(state);
      const revision = seatRevision(state);
      const existing = reservations.find((candidate) => candidate.operationKey === normalizedKey);
      if (!existing || existing.subjectKey !== true) {
        throw new BillingError('SEAT_RESERVATION_NOT_FOUND', 'The Better Auth seat hold does not exist', 404);
      }
      const entitlement = entitlementFromState(this.catalog, state, this.enabled);
      if (existing.status === 'settled') {
        if (existing.committed === true || existing.recoveryProof === undefined) {
          throw new BillingError('SEAT_RESERVATION_SETTLED', 'The Better Auth seat hold is already settled', 409);
        }
        if (existing.recoveryProof.kind !== normalizedProof.kind || existing.recoveryProof.reference !== normalizedProof.reference) {
          throw new BillingError('IDEMPOTENCY_CONFLICT', 'The seat hold was recovered with different proof', 409);
        }
        return {
          operationKey: normalizedKey,
          idempotent: true,
          reservation: cloneSeatReservation(existing),
          snapshot: {
            organizationId: normalized,
            limits: { ...entitlement.limits },
            usage: { ...state.usage },
            entitlement,
          },
        };
      }
      if (existing.committed === true) {
        throw new BillingError('SEAT_RESERVATION_SETTLED', 'The Better Auth seat hold is already committed', 409);
      }
      state.usage = applyDelta(state.usage, { seats: -1 }, nowMs);
      existing.status = 'settled';
      existing.committed = false;
      existing.subjectKey = true;
      existing.revision = revision;
      existing.recoveryProof = { ...normalizedProof };
      existing.updatedAt = new Date(nowMs).toISOString();
      return {
        operationKey: normalizedKey,
        idempotent: false,
        reservation: cloneSeatReservation(existing),
        snapshot: {
          organizationId: normalized,
          limits: { ...entitlement.limits },
          usage: { ...state.usage },
          entitlement,
        },
      };
    });
  }

  /**
   * Release an admission that never became an authoritative member or
   * invitation, or release a committed member/invitation after its identity
   * row is removed. Settled reservations remain as lifecycle tombstones so a
   * remove-and-readd or cancel-and-reinvite can safely reactivate the same
   * subject key instead of being mistaken for an old idempotent request.
   */
  async releaseSeat(organizationId: string, operationKey: string): Promise<UsageReservation> {
    const normalized = validateBillingOrganizationId(organizationId);
    const normalizedKey = validateBillingIdentifier(operationKey, 'operationKey', MAX_OPERATION_KEY_BYTES);
    const nowMs = this.now();
    return this.repository.transaction(normalized, (state) => {
      state.usage = periodUsage(state.usage, nowMs);
      const { baseline, reservations } = seatState(state);
      const revision = seatRevision(state);
      const entitlement = entitlementFromState(this.catalog, state, this.enabled);
      const existing = reservations.find((candidate) => candidate.operationKey === normalizedKey);
      if (!existing || (existing.status === 'settled' && existing.committed === false)) {
        return seatReservationSnapshot(normalized, normalizedKey, { seats: -1 }, state.usage, entitlement, true);
      }
      const wasCommitted = existing.status === 'settled' && existing.committed !== false;
      state.usage = applyDelta(state.usage, { seats: -1 }, nowMs);
      existing.status = 'settled';
      existing.committed = false;
      existing.revision = revision;
      existing.updatedAt = new Date(nowMs).toISOString();
      if (wasCommitted) state.seatBaseline = Math.max(0, baseline - 1);
      return seatReservationSnapshot(normalized, normalizedKey, { seats: -1 }, state.usage, entitlement, false);
    });
  }

  /**
   * Convert a successful Better Auth write from an in-flight hold into the
   * authoritative seat baseline. The aggregate usage is unchanged; only the
   * durable lifecycle marker moves, which keeps a later remove/readd safe.
   */
  async commitSeat(organizationId: string, operationKey: string): Promise<UsageReservation> {
    const normalized = validateBillingOrganizationId(organizationId);
    const normalizedKey = validateBillingIdentifier(operationKey, 'operationKey', MAX_OPERATION_KEY_BYTES);
    const nowMs = this.now();
    return this.repository.transaction(normalized, (state) => {
      state.usage = periodUsage(state.usage, nowMs);
      const { baseline, reservations } = seatState(state);
      const revision = seatRevision(state);
      const entitlement = entitlementFromState(this.catalog, state, this.enabled);
      const existing = reservations.find((candidate) => candidate.operationKey === normalizedKey);
      if (!existing || existing.status === 'settled') {
        const exceeded = firstExceeded(entitlement.limits, state.usage, {});
        if (exceeded) throw new BillingError('USAGE_LIMIT_EXCEEDED', `The ${exceeded.metric} limit has been reached`, 429, { retryable: false, details: { ...exceeded } });
        return seatReservationSnapshot(normalized, normalizedKey, {}, state.usage, entitlement, true);
      }
      existing.status = 'settled';
      existing.committed = true;
      existing.revision = revision;
      existing.updatedAt = new Date(nowMs).toISOString();
      state.seatBaseline = baseline + 1;
      const exceeded = firstExceeded(entitlement.limits, state.usage, {});
      if (exceeded) throw new BillingError('USAGE_LIMIT_EXCEEDED', `The ${exceeded.metric} limit has been reached`, 429, { retryable: false, details: { ...exceeded } });
      return seatReservationSnapshot(normalized, normalizedKey, {}, state.usage, entitlement, false);
    });
  }

  /**
   * Reconcile Better Auth's member plus pending-invitation count without
   * erasing active reservations. Counts are read outside this transaction and
   * carry no version, so this method only advances the committed baseline.
   * Lifecycle releaseSeat calls perform decrements for rows that this process
   * removed; retaining a lower-bound observation is fail-closed when a stale
   * count races another identity write.
   */
  async syncSeatCount(organizationId: string, seats: number, operationKey: string): Promise<UsageReservation> {
    if (!Number.isSafeInteger(seats) || seats < 0) throw new BillingError('INVALID_USAGE', 'seat count must be a non-negative safe integer', 400);
    const normalized = validateBillingOrganizationId(organizationId);
    const normalizedKey = validateBillingIdentifier(operationKey, 'operationKey', MAX_OPERATION_KEY_BYTES);
    const nowMs = this.now();
    return this.repository.transaction(normalized, (state) => {
      state.usage = periodUsage(state.usage, nowMs);
      const seat = seatState(state);
      seatRevision(state);
      const activeCount = seat.reservations.filter((reservation) => reservation.status === 'active').length;
      // Identity counts are read outside this billing transaction. A lower
      // observation can therefore be stale (for example, it may have been
      // read before another member's after-hook committed). Never lower the
      // baseline from an unversioned snapshot: explicit releaseSeat calls
      // perform lifecycle decrements, while this reconciliation only raises
      // a known lower bound. If a hold is active, defer increases as well so
      // a count that already includes the in-flight write cannot double count
      // it; commitSeat will advance the baseline for that exact key.
      const nextBaseline = activeCount === 0 ? Math.max(seat.baseline, seats) : seat.baseline;
      const desiredSeats = nextBaseline + activeCount;
      const delta = desiredSeats - state.usage.seats;
      const entitlement = entitlementFromState(this.catalog, state, this.enabled);
      const normalizedDeltaValue = delta === 0 ? {} : { seats: delta };
      const next = applyDelta(state.usage, normalizedDeltaValue, nowMs);
      const exceeded = firstExceeded(entitlement.limits, next, normalizedDeltaValue);
      if (exceeded) throw new BillingError('USAGE_LIMIT_EXCEEDED', `The ${exceeded.metric} limit has been reached`, 429, { retryable: false, details: { ...exceeded } });
      state.seatBaseline = nextBaseline;
      state.usage = next;
      return seatReservationSnapshot(normalized, normalizedKey, normalizedDeltaValue, next, entitlement, delta === 0);
    });
  }

  /**
   * Reconcile the server-owned Better Auth member and pending-invitation
   * lifecycle keys against one identity snapshot. The caller captures the
   * billing revision before reading identity rows; entries changed after that
   * revision are preserved so a stale snapshot cannot undo a concurrent
   * commit or release. Missing committed subject entries are released,
   * present active entries are settled (recovering a missed after-hook), and
   * previously untracked members receive durable ledger rows.
   */
  async syncSeatSubjects(
    organizationId: string,
    subjectOperationKeys: readonly string[],
    operationKey: string,
    observedRevision: number,
  ): Promise<UsageReservation> {
    const normalized = validateBillingOrganizationId(organizationId);
    const normalizedKey = validateBillingIdentifier(operationKey, 'operationKey', MAX_OPERATION_KEY_BYTES);
    if (!Array.isArray(subjectOperationKeys) || subjectOperationKeys.length > 20_000) throw new BillingError('INVALID_USAGE', 'identity seat snapshot is invalid', 400);
    const subjects = new Set(subjectOperationKeys.map((value) => validateBillingIdentifier(value, 'subjectOperationKey', MAX_OPERATION_KEY_BYTES)));
    if (!Number.isSafeInteger(observedRevision) || observedRevision < 0) throw new BillingError('INVALID_USAGE', 'identity seat snapshot revision is invalid', 400);
    const nowMs = this.now();
    return this.repository.transaction(normalized, (state) => {
      state.usage = periodUsage(state.usage, nowMs);
      const seat = seatState(state);
      const revision = seatRevision(state);
      let baseline = seat.baseline;
      let seatDelta = 0;
      const timestamp = new Date(nowMs).toISOString();

      for (const reservation of seat.reservations) {
        if (reservation.subjectKey !== true || (reservation.revision ?? 0) > observedRevision) continue;
        if (reservation.status === 'active') {
          // A present row proves that the Better Auth write committed even if
          // its after-hook did not. Missing active rows remain held because a
          // count cannot prove that a slow write has stopped.
          if (!subjects.has(reservation.operationKey)) continue;
          reservation.status = 'settled';
          reservation.committed = true;
          reservation.revision = revision;
          reservation.updatedAt = timestamp;
          baseline += 1;
          continue;
        }
        if (reservation.committed === false || subjects.has(reservation.operationKey)) continue;
        baseline = Math.max(0, baseline - 1);
        seatDelta -= 1;
        reservation.committed = false;
        reservation.revision = revision;
        reservation.updatedAt = timestamp;
      }

      // A legacy organization may have a baseline count but no subject
      // ledger. Consume those already-counted slots before increasing usage
      // for newly discovered identity rows.
      const committedLedgerCount = seat.reservations.filter((reservation) => reservation.status === 'settled' && reservation.committed !== false).length;
      let legacySlots = Math.max(0, baseline - committedLedgerCount);
      for (const subject of subjects) {
        const existing = seat.reservations.find((reservation) => reservation.operationKey === subject);
        if (existing) {
          if ((existing.revision ?? 0) > observedRevision) continue;
          if (existing.status === 'active') continue;
          if (existing.committed !== false) continue;
          existing.committed = true;
          existing.subjectKey = true;
          existing.revision = revision;
          existing.updatedAt = timestamp;
          baseline += 1;
          seatDelta += 1;
          continue;
        }
        const countedByLegacyBaseline = legacySlots > 0;
        if (countedByLegacyBaseline) legacySlots -= 1;
        else {
          baseline += 1;
          seatDelta += 1;
        }
        seat.reservations.push({ operationKey: subject, status: 'settled', committed: true, subjectKey: true, revision, createdAt: timestamp, updatedAt: timestamp });
      }

      state.seatBaseline = baseline;
      state.usage = applyDelta(state.usage, seatDelta === 0 ? {} : { seats: seatDelta }, nowMs);
      const entitlement = entitlementFromState(this.catalog, state, this.enabled);
      // Reconciliation records the identity truth even when it reveals that
      // the current organization is already over its plan. The next admission
      // then fails before doing any new work.
      return seatReservationSnapshot(normalized, normalizedKey, seatDelta === 0 ? {} : { seats: seatDelta }, state.usage, entitlement, seatDelta === 0);
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
  // Reserve input may drop zero-valued fields, but reconciliation must retain
  // an explicit zero so callers can release a reservation they definitely did
  // not write or execute. Reconciliation therefore distinguishes an omitted
  // metric (keep its reservation) from an explicit zero (release that metric),
  // while the reserve path may continue to canonicalize zeros away because
  // zero and omission are equivalent there.
  for (const metric of ['seats', 'storageBytes', 'scans', 'eveCostCents'] as const) {
    if (delta[metric] === 0) normalized[metric] = 0;
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
 * credentials keep hosted checkout/portal/webhooks unavailable, while an
 * explicitly enabled deployment can still enforce verified plan limits from
 * its durable subscription state.
 */
export function createBillingServiceFromEnv(options: BillingEnvironmentOptions): BillingService {
  const env = options.env ?? {};
  const catalog = options.catalog ?? createPlanCatalog({ env });
  const requested = envBool(env.PSKILLS_BILLING_ENABLED, false);
  // The Node host only enables this providerless mode when it has a durable
  // PostgreSQL repository. Keeping the factory independent of environment
  // labels also lets a reviewed deployment runner construct the same service
  // for a hosted production database.
  const meteredEvaluation = requested && envBool(env.PSKILLS_BILLING_METERED_EVALUATION, false);
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
  const providerSetupRequested = providerName === 'stripe'
    ? env.STRIPE_SECRET_KEY?.trim() !== undefined
    : providerName === 'local'
      ? env.PSKILLS_BILLING_LOCAL_TEST?.trim().toLowerCase() === 'true'
      : true;
  const usageEnabled = requested && (!providerSetupRequested || provider !== undefined);
  return new BillingService({
    repository: options.repository,
    catalog,
    provider,
    enabled: requested,
    // A missing provider is a supported providerless posture. If an operator
    // supplied provider settings but adapter construction rejected them, keep
    // usage admission disabled rather than treating the invalid setup as a
    // valid hosted deployment. The runtime separately requires PostgreSQL
    // before allowing providerless admission.
    usageEnabled: usageEnabled || (meteredEvaluation && !providerSetupRequested),
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
