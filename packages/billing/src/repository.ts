import type {
  BillingCustomer,
  BillingOrganizationState,
  BillingProviderId,
  BillingRepository,
  BillingSubscription,
  BillingSeatReservation,
  BillingUsage,
  BillingUsageOperation,
  BillingWebhookEvent,
} from './types.js';

export class BillingRepositoryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'BillingRepositoryError';
    this.code = code;
  }
}

export interface BillingRepositoryFactoryOptions {
  stateFactory?: (organizationId: string) => BillingOrganizationState;
  now?: () => number;
}

export interface MemoryBillingRepositoryOptions extends BillingRepositoryFactoryOptions {
  initial?: Readonly<Record<string, BillingOrganizationState>>;
}

const MAX_ORGANIZATION_ID_BYTES = 256;
const MAX_EVENT_ID_BYTES = 256;
const MAX_OPERATION_KEY_BYTES = 256;
const MAX_PROVIDER_ID_BYTES = 64;
const MAX_RETAINED_EVENTS = 2_000;
const MAX_RETAINED_OPERATIONS = 20_000;
const MAX_TABLE_PREFIX_LENGTH = 40;
const GLOBAL_TRANSACTION_KEY = '__billing_global__';
const BILLING_PROVIDERS = new Set<BillingProviderId>(['stripe', 'local']);
const BILLING_SUBSCRIPTION_STATUSES = new Set<BillingSubscription['status']>(['incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused', 'unknown']);

export function validateBillingOrganizationId(value: unknown): string {
  if (typeof value !== 'string') {
    throw new BillingRepositoryError('INVALID_ORGANIZATION', 'organizationId must be a string');
  }
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_ORGANIZATION_ID_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new BillingRepositoryError('INVALID_ORGANIZATION', 'organizationId is invalid');
  }
  if (new TextEncoder().encode(normalized).byteLength > MAX_ORGANIZATION_ID_BYTES) {
    throw new BillingRepositoryError('INVALID_ORGANIZATION', 'organizationId is invalid');
  }
  return normalized;
}

export function validateBillingIdentifier(value: unknown, field: string, maxBytes = MAX_EVENT_ID_BYTES): string {
  if (typeof value !== 'string') {
    throw new BillingRepositoryError('INVALID_IDENTIFIER', `${field} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxBytes || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new BillingRepositoryError('INVALID_IDENTIFIER', `${field} is invalid`);
  }
  if (new TextEncoder().encode(normalized).byteLength > maxBytes) {
    throw new BillingRepositoryError('INVALID_IDENTIFIER', `${field} is invalid`);
  }
  return normalized;
}

export function validateBillingProviderId(value: unknown): BillingProviderId {
  const provider = validateBillingIdentifier(value, 'provider', MAX_PROVIDER_ID_BYTES);
  if (!BILLING_PROVIDERS.has(provider as BillingProviderId)) {
    throw new BillingRepositoryError('INVALID_PROVIDER', 'billing provider is unsupported');
  }
  return provider as BillingProviderId;
}

export function periodBounds(nowMs = Date.now()): { start: string; end: string } {
  if (!Number.isFinite(nowMs)) throw new BillingRepositoryError('INVALID_TIME', 'billing clock is invalid');
  const now = new Date(nowMs);
  if (!Number.isFinite(now.getTime())) throw new BillingRepositoryError('INVALID_TIME', 'billing clock is invalid');
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

export function defaultBillingUsage(organizationId: string, nowMs = Date.now()): BillingUsage {
  const normalized = validateBillingOrganizationId(organizationId);
  const period = periodBounds(nowMs);
  return {
    organizationId: normalized,
    periodStart: period.start,
    periodEnd: period.end,
    seats: 0,
    storageBytes: 0,
    scans: 0,
    eveCostCents: 0,
    updatedAt: new Date(nowMs).toISOString(),
  };
}

export function defaultBillingState(organizationId: string, nowMs = Date.now()): BillingOrganizationState {
  const normalized = validateBillingOrganizationId(organizationId);
  return {
    organizationId: normalized,
    usage: defaultBillingUsage(normalized, nowMs),
    webhookEvents: [],
    usageOperations: [],
    seatBaseline: 0,
    seatReservations: [],
  };
}

export function cloneBillingState(state: BillingOrganizationState): BillingOrganizationState {
  try {
    return JSON.parse(JSON.stringify(state)) as BillingOrganizationState;
  } catch {
    throw new BillingRepositoryError('INVALID_STATE', 'billing state is not JSON serializable');
  }
}

function nonnegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new BillingRepositoryError('INVALID_STATE', `${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function validateUsage(usage: BillingUsage, organizationId: string): void {
  if (!usage || usage.organizationId !== organizationId) {
    throw new BillingRepositoryError('INVALID_STATE', 'billing usage organization does not match state');
  }
  if (!Number.isFinite(Date.parse(usage.periodStart)) || !Number.isFinite(Date.parse(usage.periodEnd))) {
    throw new BillingRepositoryError('INVALID_STATE', 'billing usage period is invalid');
  }
  if (Date.parse(usage.periodEnd) <= Date.parse(usage.periodStart)) {
    throw new BillingRepositoryError('INVALID_STATE', 'billing usage period is empty');
  }
  nonnegativeInteger(usage.seats, 'usage.seats');
  nonnegativeInteger(usage.storageBytes, 'usage.storageBytes');
  nonnegativeInteger(usage.scans, 'usage.scans');
  nonnegativeInteger(usage.eveCostCents, 'usage.eveCostCents');
  if (typeof usage.updatedAt !== 'string' || !Number.isFinite(Date.parse(usage.updatedAt))) {
    throw new BillingRepositoryError('INVALID_STATE', 'billing usage updatedAt is invalid');
  }
}

export function assertBillingState(state: BillingOrganizationState): void {
  const organizationId = validateBillingOrganizationId(state?.organizationId);
  validateUsage(state.usage, organizationId);
  if (!Array.isArray(state.webhookEvents) || !Array.isArray(state.usageOperations)) {
    throw new BillingRepositoryError('INVALID_STATE', 'billing collections are invalid');
  }
  if (state.seatBaseline !== undefined) nonnegativeInteger(state.seatBaseline, 'seatBaseline');
  if (state.seatReservations !== undefined) {
    if (!Array.isArray(state.seatReservations)) throw new BillingRepositoryError('INVALID_STATE', 'seat reservations are invalid');
    const reservationKeys = new Set<string>();
    for (const reservation of state.seatReservations) {
      if (!reservation || typeof reservation !== 'object') throw new BillingRepositoryError('INVALID_STATE', 'seat reservation is invalid');
      validateBillingIdentifier(reservation.operationKey, 'seatReservation.operationKey');
      if (reservationKeys.has(reservation.operationKey)) throw new BillingRepositoryError('INVALID_STATE', 'seat reservation is duplicated');
      reservationKeys.add(reservation.operationKey);
      if (reservation.status !== 'active' && reservation.status !== 'settled') throw new BillingRepositoryError('INVALID_STATE', 'seat reservation status is invalid');
      if (!Number.isFinite(Date.parse(reservation.createdAt)) || !Number.isFinite(Date.parse(reservation.updatedAt))) throw new BillingRepositoryError('INVALID_STATE', 'seat reservation timestamp is invalid');
    }
  }
  if (state.customer !== undefined) {
    if (state.customer.organizationId !== organizationId) throw new BillingRepositoryError('INVALID_STATE', 'billing customer organization does not match state');
    validateBillingProviderId(state.customer.provider);
    validateBillingIdentifier(state.customer.customerId, 'customer.customerId');
    if (!Number.isFinite(Date.parse(state.customer.createdAt)) || !Number.isFinite(Date.parse(state.customer.updatedAt))) throw new BillingRepositoryError('INVALID_STATE', 'billing customer timestamps are invalid');
  }
  if (state.subscription !== undefined) {
    if (state.subscription.organizationId !== organizationId) throw new BillingRepositoryError('INVALID_STATE', 'billing subscription organization does not match state');
    validateBillingProviderId(state.subscription.provider);
    validateBillingIdentifier(state.subscription.subscriptionId, 'subscription.subscriptionId');
    validateBillingIdentifier(state.subscription.customerId, 'subscription.customerId');
    validateBillingIdentifier(state.subscription.priceId, 'subscription.priceId');
    validateBillingIdentifier(state.subscription.planId, 'subscription.planId');
    validateBillingIdentifier(state.subscription.lastEventId, 'subscription.lastEventId');
    if (!BILLING_SUBSCRIPTION_STATUSES.has(state.subscription.status)) throw new BillingRepositoryError('INVALID_STATE', 'subscription status is invalid');
    if (state.subscription.source !== 'verified-webhook') throw new BillingRepositoryError('INVALID_STATE', 'subscription source is invalid');
    if (typeof state.subscription.cancelAtPeriodEnd !== 'boolean') throw new BillingRepositoryError('INVALID_STATE', 'subscription cancelAtPeriodEnd is invalid');
    if (!Number.isSafeInteger(state.subscription.eventCreatedAt) || state.subscription.eventCreatedAt < 0) {
      throw new BillingRepositoryError('INVALID_STATE', 'subscription eventCreatedAt is invalid');
    }
    if (state.subscription.currentPeriodStart !== undefined && !Number.isFinite(Date.parse(state.subscription.currentPeriodStart))) throw new BillingRepositoryError('INVALID_STATE', 'subscription currentPeriodStart is invalid');
    if (state.subscription.currentPeriodEnd !== undefined && !Number.isFinite(Date.parse(state.subscription.currentPeriodEnd))) throw new BillingRepositoryError('INVALID_STATE', 'subscription currentPeriodEnd is invalid');
    if (state.subscription.currentPeriodStart !== undefined && state.subscription.currentPeriodEnd !== undefined && Date.parse(state.subscription.currentPeriodEnd) <= Date.parse(state.subscription.currentPeriodStart)) throw new BillingRepositoryError('INVALID_STATE', 'subscription billing period is empty');
  }
  const eventKeys = new Set<string>();
  for (const event of state.webhookEvents) {
    validateBillingProviderId(event.provider);
    validateBillingIdentifier(event.eventId, 'webhook.eventId');
    validateBillingIdentifier(event.eventType, 'webhook.eventType');
    if (event.organizationId !== undefined && event.organizationId !== organizationId) throw new BillingRepositoryError('INVALID_STATE', 'webhook event organization does not match state');
    const key = `${event.provider}\u0000${event.eventId}`;
    if (eventKeys.has(key)) throw new BillingRepositoryError('INVALID_STATE', 'webhook event is duplicated in state');
    eventKeys.add(key);
    if (!Number.isSafeInteger(event.createdAt) || event.createdAt < 0) throw new BillingRepositoryError('INVALID_STATE', 'webhook createdAt is invalid');
    if (!Number.isFinite(Date.parse(event.receivedAt)) || typeof event.payloadDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(event.payloadDigest) || typeof event.handled !== 'boolean') throw new BillingRepositoryError('INVALID_STATE', 'webhook event metadata is invalid');
    if (event.ignoredReason !== undefined && event.ignoredReason !== 'unsupported' && event.ignoredReason !== 'stale' && event.ignoredReason !== 'unbound') throw new BillingRepositoryError('INVALID_STATE', 'webhook ignored reason is invalid');
  }
  const operationKeys = new Set<string>();
  for (const operation of state.usageOperations) {
    if (operation.organizationId !== organizationId) throw new BillingRepositoryError('INVALID_STATE', 'usage operation organization does not match state');
    validateBillingIdentifier(operation.operationKey, 'usage.operationKey', MAX_OPERATION_KEY_BYTES);
    if (operationKeys.has(operation.operationKey)) throw new BillingRepositoryError('INVALID_STATE', 'usage operation is duplicated');
    operationKeys.add(operation.operationKey);
    if (!Number.isFinite(Date.parse(operation.createdAt))) throw new BillingRepositoryError('INVALID_STATE', 'usage operation createdAt is invalid');
    validateUsage(operation.usage, organizationId);
    if (!operation.delta || typeof operation.delta !== 'object' || Array.isArray(operation.delta)) throw new BillingRepositoryError('INVALID_STATE', 'usage operation delta is invalid');
    for (const [metric, value] of Object.entries(operation.delta)) {
      if (!['seats', 'storageBytes', 'scans', 'eveCostCents'].includes(metric)) throw new BillingRepositoryError('INVALID_STATE', 'usage operation metric is invalid');
      if (!Number.isSafeInteger(value) || (value as number) === 0) throw new BillingRepositoryError('INVALID_STATE', 'usage operation delta is invalid');
    }
  }
}

function assertCrossOrganizationUniqueness(
  states: ReadonlyMap<string, BillingOrganizationState>,
  organizationId: string,
  state: BillingOrganizationState,
): void {
  for (const [otherOrganizationId, other] of states) {
    if (otherOrganizationId === organizationId) continue;
    if (
      state.customer &&
      other.customer &&
      state.customer.provider === other.customer.provider &&
      state.customer.customerId === other.customer.customerId
    ) {
      throw new BillingRepositoryError('MAPPING_CONFLICT', 'billing customer is already mapped to another organization');
    }
    if (
      state.subscription &&
      other.subscription &&
      state.subscription.provider === other.subscription.provider &&
      state.subscription.subscriptionId === other.subscription.subscriptionId
    ) {
      throw new BillingRepositoryError('MAPPING_CONFLICT', 'billing subscription is already mapped to another organization');
    }
    for (const event of state.webhookEvents) {
      if (other.webhookEvents.some((candidate) => candidate.provider === event.provider && candidate.eventId === event.eventId)) {
        throw new BillingRepositoryError('DUPLICATE_WEBHOOK', 'billing webhook event was already recorded');
      }
    }
  }
}

class OrganizationMutex {
  private readonly queues = new Map<string, Promise<void>>();

  async run<T>(organizationId: string, operation: () => Promise<T> | T): Promise<T> {
    const previous = this.queues.get(organizationId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.queues.set(organizationId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.queues.get(organizationId) === current) this.queues.delete(organizationId);
    }
  }
}

function syncResult(value: unknown): void {
  if (value !== null && (typeof value === 'object' || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function') {
    throw new BillingRepositoryError('ASYNC_UPDATER', 'billing transaction updates must be synchronous');
  }
}

export class MemoryBillingRepository implements BillingRepository {
  private readonly states = new Map<string, BillingOrganizationState>();
  private readonly mutex = new OrganizationMutex();
  /**
   * Mapping and event uniqueness span organizations.  A process-local
   * repository therefore needs one short critical section around commits in
   * addition to the per-organization read/write mutex.
   */
  private readonly commitMutex = new OrganizationMutex();
  private readonly stateFactory: (organizationId: string) => BillingOrganizationState;

  constructor(options: MemoryBillingRepositoryOptions = {}) {
    const now = options.now ?? Date.now;
    this.stateFactory = options.stateFactory ?? ((organizationId) => defaultBillingState(organizationId, now()));
    for (const [organizationId, state] of Object.entries(options.initial ?? {})) {
      const normalized = validateBillingOrganizationId(organizationId);
      const copy = cloneBillingState(state);
      if (copy.organizationId !== normalized) throw new BillingRepositoryError('INVALID_STATE', 'initial billing state organization mismatch');
      assertBillingState(copy);
      this.states.set(normalized, copy);
    }
    for (const [organizationId, state] of this.states) {
      assertCrossOrganizationUniqueness(this.states, organizationId, state);
    }
  }

  async read(organizationId: string): Promise<BillingOrganizationState> {
    const normalized = validateBillingOrganizationId(organizationId);
    return this.mutex.run(normalized, () => {
      const current = this.states.get(normalized);
      if (!current) {
        const created = cloneBillingState(this.stateFactory(normalized));
        if (created.organizationId !== normalized) throw new BillingRepositoryError('INVALID_STATE', 'billing state factory returned another organization');
        assertBillingState(created);
        this.states.set(normalized, created);
        return cloneBillingState(created);
      }
      return cloneBillingState(current);
    });
  }

  async transaction<T>(organizationId: string, updater: (state: BillingOrganizationState) => T): Promise<T> {
    const normalized = validateBillingOrganizationId(organizationId);
    return this.commitMutex.run(GLOBAL_TRANSACTION_KEY, () => this.mutex.run(normalized, () => {
      const current = this.states.get(normalized);
      const working = cloneBillingState(current ?? this.stateFactory(normalized));
      if (working.organizationId !== normalized) throw new BillingRepositoryError('INVALID_STATE', 'billing state factory returned another organization');
      assertBillingState(working);
      const result = updater(working);
      syncResult(result);
      assertBillingState(working);

      // PostgreSQL enforces these invariants with unique constraints.  Keep
      // the local adapter equally strict so tests and single-process mode do
      // not permit a provider identifier to be claimed by two organizations.
      assertCrossOrganizationUniqueness(this.states, normalized, working);
      this.states.set(normalized, cloneBillingState(working));
      return result;
    }));
  }

  async findOrganizationByCustomerId(provider: BillingProviderId, customerId: string): Promise<string | undefined> {
    const normalizedProvider = validateBillingProviderId(provider);
    const normalizedCustomer = validateBillingIdentifier(customerId, 'customerId');
    for (const [organizationId, state] of this.states) {
      if (state.customer?.provider === normalizedProvider && state.customer.customerId === normalizedCustomer) return organizationId;
    }
    return undefined;
  }

  async findOrganizationBySubscriptionId(provider: BillingProviderId, subscriptionId: string): Promise<string | undefined> {
    const normalizedProvider = validateBillingProviderId(provider);
    const normalizedSubscription = validateBillingIdentifier(subscriptionId, 'subscriptionId');
    for (const [organizationId, state] of this.states) {
      if (state.subscription?.provider === normalizedProvider && state.subscription.subscriptionId === normalizedSubscription) return organizationId;
    }
    return undefined;
  }

  async findWebhookEvent(provider: BillingProviderId, eventId: string): Promise<BillingWebhookEvent | undefined> {
    const normalizedProvider = validateBillingProviderId(provider);
    const normalizedEvent = validateBillingIdentifier(eventId, 'eventId');
    for (const state of this.states.values()) {
      const event = state.webhookEvents.find((candidate) => candidate.provider === normalizedProvider && candidate.eventId === normalizedEvent);
      if (event) return cloneBillingState({ ...defaultBillingState(state.organizationId), webhookEvents: [event] }).webhookEvents[0];
    }
    return undefined;
  }
}

export interface BillingPgQueryResult<Row = Record<string, unknown>> {
  rows: Row[];
  rowCount?: number;
}

export interface BillingPgClientLike {
  query<Row = Record<string, unknown>>(text: string, parameters?: readonly unknown[]): Promise<BillingPgQueryResult<Row>>;
  release?: () => void | Promise<void>;
}

export interface BillingPgPoolLike {
  query<Row = Record<string, unknown>>(text: string, parameters?: readonly unknown[]): Promise<BillingPgQueryResult<Row>>;
  connect(): Promise<BillingPgClientLike>;
}

function quoteIdentifier(identifier: string): string {
  if (identifier.length > 63 || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier)) throw new BillingRepositoryError('INVALID_TABLE', 'billing table name is invalid');
  return `"${identifier}"`;
}

interface BillingTables {
  customers: string;
  subscriptions: string;
  usage: string;
  events: string;
  operations: string;
}

function tableNames(prefix = 'private_skills_billing'): BillingTables {
  if (typeof prefix !== 'string') throw new BillingRepositoryError('INVALID_TABLE', 'billing table prefix is invalid');
  const normalized = prefix.trim();
  if (normalized.length > MAX_TABLE_PREFIX_LENGTH || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(normalized)) throw new BillingRepositoryError('INVALID_TABLE', 'billing table prefix is invalid');
  return {
    customers: quoteIdentifier(`${normalized}_customers`),
    subscriptions: quoteIdentifier(`${normalized}_subscriptions`),
    usage: quoteIdentifier(`${normalized}_usage`),
    events: quoteIdentifier(`${normalized}_webhook_events`),
    operations: quoteIdentifier(`${normalized}_usage_operations`),
  };
}

/** Separate migration owned by billing; it never alters the registry/auth tables. */
export function billingPostgresSchemaSql(tablePrefix = 'private_skills_billing'): string {
  if (typeof tablePrefix !== 'string') throw new BillingRepositoryError('INVALID_TABLE', 'billing table prefix is invalid');
  const normalizedPrefix = tablePrefix.trim();
  const tables = tableNames(normalizedPrefix);
  return `
CREATE TABLE IF NOT EXISTS ${tables.customers} (
  organization_id text PRIMARY KEY,
  provider text NOT NULL,
  customer_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, customer_id)
);

CREATE TABLE IF NOT EXISTS ${tables.subscriptions} (
  organization_id text PRIMARY KEY,
  provider text NOT NULL,
  subscription_id text NOT NULL,
  customer_id text NOT NULL,
  price_id text NOT NULL,
  plan_id text NOT NULL,
  status text NOT NULL,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  event_created_at bigint NOT NULL,
  last_event_id text NOT NULL,
  source text NOT NULL DEFAULT 'verified-webhook',
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, subscription_id),
  CHECK (event_created_at >= 0),
  CHECK (source = 'verified-webhook')
);

CREATE TABLE IF NOT EXISTS ${tables.usage} (
  organization_id text PRIMARY KEY,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  seats bigint NOT NULL DEFAULT 0,
  storage_bytes bigint NOT NULL DEFAULT 0,
  scans bigint NOT NULL DEFAULT 0,
  eve_cost_cents bigint NOT NULL DEFAULT 0,
  seat_baseline bigint NOT NULL DEFAULT 0,
  seat_reservations jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end > period_start),
  CHECK (seats >= 0),
  CHECK (storage_bytes >= 0),
  CHECK (scans >= 0),
  CHECK (eve_cost_cents >= 0),
  CHECK (seat_baseline >= 0),
  CHECK (jsonb_typeof(seat_reservations) = 'array')
);

ALTER TABLE ${tables.usage}
  ADD COLUMN IF NOT EXISTS seat_baseline bigint NOT NULL DEFAULT 0;
ALTER TABLE ${tables.usage}
  ADD COLUMN IF NOT EXISTS seat_reservations jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS ${tables.events} (
  provider text NOT NULL,
  event_id text NOT NULL,
  event_type text NOT NULL,
  organization_id text,
  created_at bigint NOT NULL,
  received_at timestamptz NOT NULL,
  payload_digest text NOT NULL,
  handled boolean NOT NULL DEFAULT false,
  ignored_reason text,
  PRIMARY KEY (provider, event_id),
  CHECK (created_at >= 0)
);

CREATE TABLE IF NOT EXISTS ${tables.operations} (
  organization_id text NOT NULL,
  operation_key text NOT NULL,
  seats_delta bigint,
  storage_bytes_delta bigint,
  scans_delta bigint,
  eve_cost_cents_delta bigint,
  usage_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, operation_key)
);

CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${normalizedPrefix}_events_org_idx`)}
  ON ${tables.events} (organization_id, received_at DESC);
CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${normalizedPrefix}_operations_org_idx`)}
  ON ${tables.operations} (organization_id, created_at DESC);
`;
}

export const BILLING_POSTGRES_SCHEMA_SQL = billingPostgresSchemaSql();

export interface PostgresBillingRepositoryOptions extends BillingRepositoryFactoryOptions {
  tablePrefix?: string;
  autoMigrate?: boolean;
  maxWebhookEvents?: number;
  maxUsageOperations?: number;
}

function asText(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new BillingRepositoryError('CORRUPT_STATE', `${field} is invalid`);
  return value;
}

function asNumber(value: unknown, field: string, allowNegative = false): number {
  const parsed = typeof value === 'bigint' ? Number(value) : typeof value === 'string' ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || (!allowNegative && (parsed as number) < 0)) throw new BillingRepositoryError('CORRUPT_STATE', `${field} is invalid`);
  return parsed as number;
}

function asOptionalIso(value: unknown, field: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = typeof value === 'string' ? value : value instanceof Date ? value.toISOString() : undefined;
  if (!text || !Number.isFinite(Date.parse(text))) throw new BillingRepositoryError('CORRUPT_STATE', `${field} is invalid`);
  return new Date(text).toISOString();
}

function asIso(value: unknown, field: string): string {
  const parsed = asOptionalIso(value, field);
  if (!parsed) throw new BillingRepositoryError('CORRUPT_STATE', `${field} is missing`);
  return parsed;
}

function rowEvent(row: Record<string, unknown>): BillingWebhookEvent {
  const ignored = row.ignored_reason;
  return {
    provider: validateBillingProviderId(asText(row.provider, 'webhook.provider')),
    eventId: asText(row.event_id, 'webhook.event_id'),
    eventType: asText(row.event_type, 'webhook.event_type'),
    organizationId: row.organization_id === null || row.organization_id === undefined ? undefined : asText(row.organization_id, 'webhook.organization_id'),
    createdAt: asNumber(row.created_at, 'webhook.created_at'),
    receivedAt: asIso(row.received_at, 'webhook.received_at'),
    payloadDigest: asText(row.payload_digest, 'webhook.payload_digest'),
    handled: row.handled === true,
    ...(ignored === 'unsupported' || ignored === 'stale' || ignored === 'unbound' ? { ignoredReason: ignored } : {}),
  };
}

function rowUsage(row: Record<string, unknown>, organizationId: string): BillingUsage {
  return {
    organizationId,
    periodStart: asIso(row.period_start, 'usage.period_start'),
    periodEnd: asIso(row.period_end, 'usage.period_end'),
    seats: asNumber(row.seats, 'usage.seats'),
    storageBytes: asNumber(row.storage_bytes, 'usage.storage_bytes'),
    scans: asNumber(row.scans, 'usage.scans'),
    eveCostCents: asNumber(row.eve_cost_cents, 'usage.eve_cost_cents'),
    updatedAt: asIso(row.updated_at, 'usage.updated_at'),
  };
}

function rowSeatReservations(row: Record<string, unknown>): BillingSeatReservation[] {
  if (row.seat_reservations === undefined || row.seat_reservations === null) return [];
  let value: unknown;
  try {
    value = typeof row.seat_reservations === 'string' ? JSON.parse(row.seat_reservations) : row.seat_reservations;
  } catch {
    throw new BillingRepositoryError('CORRUPT_STATE', 'seat reservations are invalid JSON');
  }
  if (!Array.isArray(value)) throw new BillingRepositoryError('CORRUPT_STATE', 'seat reservations are invalid');
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== 'object') throw new BillingRepositoryError('CORRUPT_STATE', 'seat reservation is invalid');
    const reservation = candidate as Partial<BillingSeatReservation>;
    if (typeof reservation.operationKey !== 'string' || (reservation.status !== 'active' && reservation.status !== 'settled') || typeof reservation.createdAt !== 'string' || typeof reservation.updatedAt !== 'string') {
      throw new BillingRepositoryError('CORRUPT_STATE', 'seat reservation is invalid');
    }
    return {
      operationKey: reservation.operationKey,
      status: reservation.status,
      createdAt: reservation.createdAt,
      updatedAt: reservation.updatedAt,
    };
  });
}

function rowCustomer(row: Record<string, unknown>, organizationId: string): BillingCustomer {
  return {
    organizationId,
    provider: validateBillingProviderId(asText(row.provider, 'customer.provider')),
    customerId: asText(row.customer_id, 'customer.customer_id'),
    createdAt: asIso(row.created_at, 'customer.created_at'),
    updatedAt: asIso(row.updated_at, 'customer.updated_at'),
  };
}

function rowSubscription(row: Record<string, unknown>, organizationId: string): BillingSubscription {
  return {
    organizationId,
    provider: validateBillingProviderId(asText(row.provider, 'subscription.provider')),
    subscriptionId: asText(row.subscription_id, 'subscription.subscription_id'),
    customerId: asText(row.customer_id, 'subscription.customer_id'),
    priceId: asText(row.price_id, 'subscription.price_id'),
    planId: asText(row.plan_id, 'subscription.plan_id'),
    status: asText(row.status, 'subscription.status') as BillingSubscription['status'],
    currentPeriodStart: asOptionalIso(row.current_period_start, 'subscription.current_period_start'),
    currentPeriodEnd: asOptionalIso(row.current_period_end, 'subscription.current_period_end'),
    cancelAtPeriodEnd: row.cancel_at_period_end === true,
    eventCreatedAt: asNumber(row.event_created_at, 'subscription.event_created_at'),
    lastEventId: asText(row.last_event_id, 'subscription.last_event_id'),
    source: 'verified-webhook',
    updatedAt: asIso(row.updated_at, 'subscription.updated_at'),
  };
}

function rowOperation(row: Record<string, unknown>, organizationId: string): BillingUsageOperation {
  let snapshot: BillingUsage;
  try {
    snapshot = typeof row.usage_snapshot === 'string' ? JSON.parse(row.usage_snapshot) as BillingUsage : row.usage_snapshot as BillingUsage;
  } catch {
    throw new BillingRepositoryError('CORRUPT_STATE', 'usage operation snapshot is invalid JSON');
  }
  const delta: BillingUsageOperation['delta'] = {};
  for (const [column, metric] of [
    ['seats_delta', 'seats'],
    ['storage_bytes_delta', 'storageBytes'],
    ['scans_delta', 'scans'],
    ['eve_cost_cents_delta', 'eveCostCents'],
  ] as const) {
    if (row[column] !== null && row[column] !== undefined) delta[metric] = asNumber(row[column], `operation.${column}`, true);
  }
  return {
    organizationId,
    operationKey: asText(row.operation_key, 'operation.operation_key'),
    delta,
    usage: snapshot,
    createdAt: asIso(row.created_at, 'operation.created_at'),
  };
}

function usageRowParameters(usage: BillingUsage, state: BillingOrganizationState): unknown[] {
  return [
    usage.organizationId,
    usage.periodStart,
    usage.periodEnd,
    usage.seats,
    usage.storageBytes,
    usage.scans,
    usage.eveCostCents,
    usage.updatedAt,
    state.seatBaseline ?? usage.seats,
    JSON.stringify(state.seatReservations ?? []),
  ];
}

function eventKey(event: Pick<BillingWebhookEvent, 'provider' | 'eventId'>): string {
  return `${event.provider}\u0000${event.eventId}`;
}

function insertSucceeded(result: BillingPgQueryResult): boolean {
  // `pg` exposes rowCount for command results.  The rows fallback keeps the
  // adapter usable with drivers that only expose RETURNING rows.
  return typeof result.rowCount === 'number' ? result.rowCount > 0 : result.rows.length > 0;
}

export class PostgresBillingRepository implements BillingRepository {
  private readonly pool: BillingPgPoolLike;
  private readonly tables: BillingTables;
  private readonly stateFactory: (organizationId: string) => BillingOrganizationState;
  private readonly autoMigrate: boolean;
  private readonly maxWebhookEvents: number;
  private readonly maxUsageOperations: number;
  private migrationPromise?: Promise<void>;

  constructor(pool: BillingPgPoolLike, options?: PostgresBillingRepositoryOptions);
  constructor(options: PostgresBillingRepositoryOptions & { pool: BillingPgPoolLike });
  constructor(
    poolOrOptions: BillingPgPoolLike | (PostgresBillingRepositoryOptions & { pool: BillingPgPoolLike }),
    options: PostgresBillingRepositoryOptions = {},
  ) {
    const supplied = 'pool' in poolOrOptions ? poolOrOptions : options;
    this.pool = 'pool' in poolOrOptions ? poolOrOptions.pool : poolOrOptions;
    const now = supplied.now ?? Date.now;
    this.stateFactory = supplied.stateFactory ?? ((organizationId) => defaultBillingState(organizationId, now()));
    this.tables = tableNames(supplied.tablePrefix);
    this.autoMigrate = supplied.autoMigrate ?? false;
    this.maxWebhookEvents = supplied.maxWebhookEvents ?? MAX_RETAINED_EVENTS;
    this.maxUsageOperations = supplied.maxUsageOperations ?? MAX_RETAINED_OPERATIONS;
    if (!Number.isSafeInteger(this.maxWebhookEvents) || this.maxWebhookEvents < 1 || this.maxWebhookEvents > 100_000) throw new BillingRepositoryError('INVALID_OPTIONS', 'maxWebhookEvents is invalid');
    if (!Number.isSafeInteger(this.maxUsageOperations) || this.maxUsageOperations < 1 || this.maxUsageOperations > 1_000_000) throw new BillingRepositoryError('INVALID_OPTIONS', 'maxUsageOperations is invalid');
  }

  private async ensureSchema(): Promise<void> {
    if (!this.autoMigrate) return;
    const prefix = this.tables.customers.slice(1, -1).replace(/_customers$/u, '');
    this.migrationPromise ??= this.pool.query(billingPostgresSchemaSql(prefix)).then(() => undefined);
    await this.migrationPromise;
  }

  private async load(executor: Pick<BillingPgPoolLike, 'query'>, organizationId: string, lock = false): Promise<BillingOrganizationState> {
    const normalized = validateBillingOrganizationId(organizationId);
    const suffix = lock ? ' FOR UPDATE' : '';
    // Query sequentially. pg clients support one in-flight query at a time;
    // this remains a single transaction while avoiding driver-specific
    // protocol races on transaction-scoped clients.
    const customerResult = await executor.query<Record<string, unknown>>(`SELECT organization_id, provider, customer_id, created_at, updated_at FROM ${this.tables.customers} WHERE organization_id = $1${suffix}`, [normalized]);
    const subscriptionResult = await executor.query<Record<string, unknown>>(`SELECT organization_id, provider, subscription_id, customer_id, price_id, plan_id, status, current_period_start, current_period_end, cancel_at_period_end, event_created_at, last_event_id, source, updated_at FROM ${this.tables.subscriptions} WHERE organization_id = $1${suffix}`, [normalized]);
    const usageResult = await executor.query<Record<string, unknown>>(`SELECT organization_id, period_start, period_end, seats, storage_bytes, scans, eve_cost_cents, seat_baseline, seat_reservations, updated_at FROM ${this.tables.usage} WHERE organization_id = $1${suffix}`, [normalized]);
    const eventsResult = await executor.query<Record<string, unknown>>(`SELECT provider, event_id, event_type, organization_id, created_at, received_at, payload_digest, handled, ignored_reason FROM ${this.tables.events} WHERE organization_id = $1 ORDER BY received_at DESC LIMIT ${this.maxWebhookEvents}${suffix}`, [normalized]);
    const operationsResult = await executor.query<Record<string, unknown>>(`SELECT organization_id, operation_key, seats_delta, storage_bytes_delta, scans_delta, eve_cost_cents_delta, usage_snapshot, created_at FROM ${this.tables.operations} WHERE organization_id = $1 ORDER BY created_at DESC LIMIT ${this.maxUsageOperations}${suffix}`, [normalized]);
    const base = cloneBillingState(this.stateFactory(normalized));
    if (base.organizationId !== normalized) throw new BillingRepositoryError('INVALID_STATE', 'billing state factory returned another organization');
    const usageRow = usageResult.rows[0];
    const usage = usageRow ? rowUsage(usageRow, normalized) : base.usage;
    const state: BillingOrganizationState = {
      ...base,
      customer: customerResult.rows[0] ? rowCustomer(customerResult.rows[0], normalized) : undefined,
      subscription: subscriptionResult.rows[0] ? rowSubscription(subscriptionResult.rows[0], normalized) : undefined,
      usage,
      webhookEvents: eventsResult.rows.map(rowEvent),
      usageOperations: operationsResult.rows.map((row) => rowOperation(row, normalized)),
      seatBaseline: usageRow?.seat_baseline === undefined || usageRow.seat_baseline === null
        ? usage.seats
        : asNumber(usageRow.seat_baseline, 'usage.seat_baseline'),
      seatReservations: usageRow ? rowSeatReservations(usageRow) : [],
    };
    assertBillingState(state);
    return state;
  }

  async read(organizationId: string): Promise<BillingOrganizationState> {
    const normalized = validateBillingOrganizationId(organizationId);
    await this.ensureSchema();
    return this.load(this.pool, normalized);
  }

  private async ensureUsageRow(executor: Pick<BillingPgPoolLike, 'query'>, organizationId: string): Promise<void> {
    const state = cloneBillingState(this.stateFactory(organizationId));
    if (state.organizationId !== organizationId) throw new BillingRepositoryError('INVALID_STATE', 'billing state factory returned another organization');
    assertBillingState(state);
    await executor.query(
      `INSERT INTO ${this.tables.usage} (organization_id, period_start, period_end, seats, storage_bytes, scans, eve_cost_cents, updated_at)
       VALUES ($1, $2::timestamptz, $3::timestamptz, 0, 0, 0, 0, $4::timestamptz)
       ON CONFLICT (organization_id) DO NOTHING`,
      [organizationId, state.usage.periodStart, state.usage.periodEnd, state.usage.updatedAt],
    );
  }

  private async write(
    executor: Pick<BillingPgClientLike, 'query'>,
    state: BillingOrganizationState,
    initialEventKeys: ReadonlySet<string>,
  ): Promise<void> {
    if (state.customer) {
      await executor.query(
        `INSERT INTO ${this.tables.customers} (organization_id, provider, customer_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz)
         ON CONFLICT (organization_id) DO UPDATE SET provider = EXCLUDED.provider, customer_id = EXCLUDED.customer_id, updated_at = EXCLUDED.updated_at`,
        [state.customer.organizationId, state.customer.provider, state.customer.customerId, state.customer.createdAt, state.customer.updatedAt],
      );
    } else {
      await executor.query(`DELETE FROM ${this.tables.customers} WHERE organization_id = $1`, [state.organizationId]);
    }
    if (state.subscription) {
      await executor.query(
        `INSERT INTO ${this.tables.subscriptions} (organization_id, provider, subscription_id, customer_id, price_id, plan_id, status, current_period_start, current_period_end, cancel_at_period_end, event_created_at, last_event_id, source, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10, $11, $12, $13, $14::timestamptz)
         ON CONFLICT (organization_id) DO UPDATE SET provider = EXCLUDED.provider, subscription_id = EXCLUDED.subscription_id, customer_id = EXCLUDED.customer_id, price_id = EXCLUDED.price_id, plan_id = EXCLUDED.plan_id, status = EXCLUDED.status, current_period_start = EXCLUDED.current_period_start, current_period_end = EXCLUDED.current_period_end, cancel_at_period_end = EXCLUDED.cancel_at_period_end, event_created_at = EXCLUDED.event_created_at, last_event_id = EXCLUDED.last_event_id, source = EXCLUDED.source, updated_at = EXCLUDED.updated_at`,
        [state.subscription.organizationId, state.subscription.provider, state.subscription.subscriptionId, state.subscription.customerId, state.subscription.priceId, state.subscription.planId, state.subscription.status, state.subscription.currentPeriodStart ?? null, state.subscription.currentPeriodEnd ?? null, state.subscription.cancelAtPeriodEnd, state.subscription.eventCreatedAt, state.subscription.lastEventId, state.subscription.source, state.subscription.updatedAt],
      );
    } else {
      await executor.query(`DELETE FROM ${this.tables.subscriptions} WHERE organization_id = $1`, [state.organizationId]);
    }
    await executor.query(
      `INSERT INTO ${this.tables.usage} (organization_id, period_start, period_end, seats, storage_bytes, scans, eve_cost_cents, updated_at, seat_baseline, seat_reservations)
       VALUES ($1, $2::timestamptz, $3::timestamptz, $4, $5, $6, $7, $8::timestamptz, $9, $10::jsonb)
       ON CONFLICT (organization_id) DO UPDATE SET period_start = EXCLUDED.period_start, period_end = EXCLUDED.period_end, seats = EXCLUDED.seats, storage_bytes = EXCLUDED.storage_bytes, scans = EXCLUDED.scans, eve_cost_cents = EXCLUDED.eve_cost_cents, updated_at = EXCLUDED.updated_at, seat_baseline = EXCLUDED.seat_baseline, seat_reservations = EXCLUDED.seat_reservations`,
      usageRowParameters(state.usage, state),
    );
    for (const event of state.webhookEvents) {
      // Existing rows are immutable.  Only rows appended by this
      // transaction are written, which lets us distinguish a genuine
      // duplicate event claim from the normal reload of retained history.
      if (initialEventKeys.has(eventKey(event))) continue;
      const inserted = await executor.query(
        `INSERT INTO ${this.tables.events} (provider, event_id, event_type, organization_id, created_at, received_at, payload_digest, handled, ignored_reason)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9)
         ON CONFLICT (provider, event_id) DO NOTHING
         RETURNING provider, event_id`,
        [event.provider, event.eventId, event.eventType, event.organizationId ?? null, event.createdAt, event.receivedAt, event.payloadDigest, event.handled, event.ignoredReason ?? null],
      );
      if (!insertSucceeded(inserted)) throw new BillingRepositoryError('DUPLICATE_WEBHOOK', 'billing webhook event was already recorded');
    }
    for (const operation of state.usageOperations) {
      await executor.query(
        `INSERT INTO ${this.tables.operations} (organization_id, operation_key, seats_delta, storage_bytes_delta, scans_delta, eve_cost_cents_delta, usage_snapshot, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::timestamptz)
         ON CONFLICT (organization_id, operation_key) DO NOTHING`,
        [operation.organizationId, operation.operationKey, operation.delta.seats ?? null, operation.delta.storageBytes ?? null, operation.delta.scans ?? null, operation.delta.eveCostCents ?? null, JSON.stringify(operation.usage), operation.createdAt],
      );
    }
  }

  async transaction<T>(organizationId: string, updater: (state: BillingOrganizationState) => T): Promise<T> {
    const normalized = validateBillingOrganizationId(organizationId);
    await this.ensureSchema();
    const client = await this.pool.connect();
    let began = false;
    try {
      await client.query('BEGIN');
      began = true;
      await this.ensureUsageRow(client, normalized);
      const state = await this.load(client, normalized, true);
      const initialEventKeys = new Set(state.webhookEvents.map(eventKey));
      const result = updater(state);
      syncResult(result);
      assertBillingState(state);
      await this.write(client, state, initialEventKeys);
      await client.query('COMMIT');
      began = false;
      return result;
    } catch (error) {
      if (began) {
        try { await client.query('ROLLBACK'); } catch { /* preserve the original error */ }
      }
      throw error;
    } finally {
      await client.release?.();
    }
  }

  async findOrganizationByCustomerId(provider: BillingProviderId, customerId: string): Promise<string | undefined> {
    const normalizedProvider = validateBillingProviderId(provider);
    const normalizedCustomer = validateBillingIdentifier(customerId, 'customerId');
    await this.ensureSchema();
    const result = await this.pool.query<{ organization_id?: unknown }>(
      `SELECT organization_id FROM ${this.tables.customers} WHERE provider = $1 AND customer_id = $2`,
      [normalizedProvider, normalizedCustomer],
    );
    const value = result.rows[0]?.organization_id;
    return value === undefined ? undefined : validateBillingOrganizationId(value);
  }

  async findOrganizationBySubscriptionId(provider: BillingProviderId, subscriptionId: string): Promise<string | undefined> {
    const normalizedProvider = validateBillingProviderId(provider);
    const normalizedSubscription = validateBillingIdentifier(subscriptionId, 'subscriptionId');
    await this.ensureSchema();
    const result = await this.pool.query<{ organization_id?: unknown }>(
      `SELECT organization_id FROM ${this.tables.subscriptions} WHERE provider = $1 AND subscription_id = $2`,
      [normalizedProvider, normalizedSubscription],
    );
    const value = result.rows[0]?.organization_id;
    return value === undefined ? undefined : validateBillingOrganizationId(value);
  }

  async findWebhookEvent(provider: BillingProviderId, eventId: string): Promise<BillingWebhookEvent | undefined> {
    const normalizedProvider = validateBillingProviderId(provider);
    const normalizedEvent = validateBillingIdentifier(eventId, 'eventId');
    await this.ensureSchema();
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT provider, event_id, event_type, organization_id, created_at, received_at, payload_digest, handled, ignored_reason FROM ${this.tables.events} WHERE provider = $1 AND event_id = $2`,
      [normalizedProvider, normalizedEvent],
    );
    return result.rows[0] ? rowEvent(result.rows[0]) : undefined;
  }
}

export const createMemoryBillingRepository = (options: MemoryBillingRepositoryOptions = {}): MemoryBillingRepository => new MemoryBillingRepository(options);
export function createPostgresBillingRepository(pool: BillingPgPoolLike, options?: PostgresBillingRepositoryOptions): PostgresBillingRepository;
export function createPostgresBillingRepository(options: PostgresBillingRepositoryOptions & { pool: BillingPgPoolLike }): PostgresBillingRepository;
export function createPostgresBillingRepository(
  poolOrOptions: BillingPgPoolLike | (PostgresBillingRepositoryOptions & { pool: BillingPgPoolLike }),
  options: PostgresBillingRepositoryOptions = {},
): PostgresBillingRepository {
  return new PostgresBillingRepository(poolOrOptions as BillingPgPoolLike, options);
}
