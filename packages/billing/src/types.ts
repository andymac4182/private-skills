/**
 * Provider-neutral billing contracts.  This package deliberately has no
 * dependency on an identity provider, web framework, or payment SDK.
 */

export const BILLING_PROTOCOL_VERSION = 1 as const;

/** The API version used by the direct Stripe REST adapter. Update deliberately. */
export const STRIPE_API_VERSION = '2025-06-30.basil' as const;

export type PlanId = string & {};
export type BillingProviderId = 'stripe' | 'local';
export type BillingMode = 'disabled' | 'test' | 'live';

export type BillingSubscriptionStatus =
  | 'incomplete'
  | 'incomplete_expired'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'paused'
  | 'unknown';

/** Metrics with a finite, enforceable unit. There is intentionally no "unlimited" value. */
export type BillingMetric = 'seats' | 'storageBytes' | 'scans' | 'eveCostCents';

export interface PlanLimits {
  /** Current active organization members. */
  seats: number;
  /** Bytes retained by the organization, including sealed artifacts. */
  storageBytes: number;
  /** Scanner jobs allowed in one UTC billing period. */
  scansPerMonth: number;
  /** Eve model budget in integer US cents in one UTC billing period. */
  eveCostCentsPerMonth: number;
}

export interface PlanDefinition {
  id: PlanId;
  label: string;
  description: string;
  limits: PlanLimits;
  /** A server-only mapping to a Stripe recurring Price. */
  priceId?: string;
  /** Public metadata may be omitted from marketing output without changing entitlements. */
  public: boolean;
}

export interface PublicPlanMetadata {
  protocolVersion: typeof BILLING_PROTOCOL_VERSION;
  id: PlanId;
  label: string;
  description: string;
  limits: PlanLimits;
  /** False until an operator has supplied the corresponding price id. */
  priceConfigured: boolean;
  /** A configured recurring price is required before hosted checkout is offered. */
  checkoutAvailable: boolean;
}

export interface PlanCatalog {
  get(id: PlanId): PlanDefinition | undefined;
  byPriceId(priceId: string): PlanDefinition | undefined;
  all(): readonly PlanDefinition[];
  publicMetadata(): readonly PublicPlanMetadata[];
}

export interface BillingCustomer {
  organizationId: string;
  provider: BillingProviderId;
  customerId: string;
  createdAt: string;
  updatedAt: string;
}

export interface BillingSubscription {
  organizationId: string;
  provider: BillingProviderId;
  subscriptionId: string;
  customerId: string;
  /** Price id from the verified provider event. Never from a URL/query parameter. */
  priceId: string;
  /** Server mapping of priceId to a known plan, or `unknown` when not configured. */
  planId: PlanId;
  status: BillingSubscriptionStatus;
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  cancelAtPeriodEnd: boolean;
  eventCreatedAt: number;
  lastEventId: string;
  source: 'verified-webhook';
  updatedAt: string;
}

export interface BillingUsage {
  organizationId: string;
  periodStart: string;
  periodEnd: string;
  seats: number;
  storageBytes: number;
  scans: number;
  eveCostCents: number;
  updatedAt: string;
}

export interface BillingWebhookEvent {
  provider: BillingProviderId;
  eventId: string;
  eventType: string;
  createdAt: number;
  receivedAt: string;
  payloadDigest: string;
  organizationId?: string;
  handled: boolean;
  ignoredReason?: 'unsupported' | 'stale' | 'unbound';
}

export interface BillingUsageOperation {
  organizationId: string;
  operationKey: string;
  delta: Partial<Record<BillingMetric, number>>;
  usage: BillingUsage;
  createdAt: string;
}

/**
 * A seat admission is kept separately from the aggregate usage operation log.
 * `active` means the Better Auth write is still in flight; `settled` means the
 * admission was committed or released and can be reused by a later lifecycle
 * for the same subject. Active holds stay fail-closed until an explicit
 * lifecycle transition resolves them.
 */
export interface BillingSeatReservation {
  operationKey: string;
  status: 'active' | 'settled';
  /**
   * A settled reservation is either a committed identity row or a released
   * admission. Older rows omit this field; readers treat those as committed
   * so recovery fails closed rather than undercounting seats.
   */
  committed?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BillingOrganizationState {
  organizationId: string;
  customer?: BillingCustomer;
  subscription?: BillingSubscription;
  usage: BillingUsage;
  webhookEvents: BillingWebhookEvent[];
  usageOperations: BillingUsageOperation[];
  /** Authoritative member + pending invitation count before active admissions. */
  seatBaseline?: number;
  /** Durable in-flight seat admissions, including their lifecycle state. */
  seatReservations?: BillingSeatReservation[];
}

export interface BillingRepository {
  read(organizationId: string): Promise<BillingOrganizationState>;
  /** The updater must be synchronous so every implementation can commit atomically. */
  transaction<T>(organizationId: string, updater: (state: BillingOrganizationState) => T): Promise<T>;
  findOrganizationByCustomerId(provider: BillingProviderId, customerId: string): Promise<string | undefined>;
  findOrganizationBySubscriptionId(provider: BillingProviderId, subscriptionId: string): Promise<string | undefined>;
  findWebhookEvent(provider: BillingProviderId, eventId: string): Promise<BillingWebhookEvent | undefined>;
}

export interface ProviderCustomer {
  provider: BillingProviderId;
  customerId: string;
}

export interface CreateCustomerInput {
  organizationId: string;
  email?: string;
  idempotencyKey: string;
}

export interface CreateCheckoutSessionInput {
  organizationId: string;
  customerId: string;
  priceId: string;
  planId: PlanId;
  successUrl: string;
  cancelUrl: string;
  idempotencyKey: string;
}

export interface CreateCustomerPortalSessionInput {
  organizationId: string;
  customerId: string;
  returnUrl: string;
  idempotencyKey: string;
}

export interface HostedBillingSession {
  provider: BillingProviderId;
  mode: BillingMode;
  id: string;
  url: string;
  expiresAt?: string;
}

export type BillingProviderInvoiceStatus = 'draft' | 'open' | 'paid' | 'uncollectible' | 'void' | 'unknown';

/** Provider invoice data returned through the server-only invoice adapter. */
export interface BillingProviderInvoice {
  provider: BillingProviderId;
  invoiceId: string;
  customerId: string;
  status: BillingProviderInvoiceStatus;
  amountDueCents?: number;
  amountPaidCents?: number;
  currency?: string;
  number?: string;
  createdAt: string;
  paidAt?: string;
  periodStart?: string;
  periodEnd?: string;
  hostedInvoiceUrl?: string;
  invoicePdfUrl?: string;
}

export interface BillingInvoiceLookup {
  organizationId: string;
  provider: BillingProviderId;
  mode: Exclude<BillingMode, 'disabled'>;
  customerId: string;
}

export interface ListInvoicesInput {
  customerId: string;
  /** Providers may return at most this many rows. */
  limit?: number;
}

export interface BillingProvider {
  readonly id: BillingProviderId;
  readonly mode: Exclude<BillingMode, 'disabled'>;
  createCustomer(input: CreateCustomerInput): Promise<ProviderCustomer>;
  createCheckoutSession(input: CreateCheckoutSessionInput): Promise<HostedBillingSession>;
  createCustomerPortalSession(input: CreateCustomerPortalSessionInput): Promise<HostedBillingSession>;
  /** Optional server-only invoice reader; absence leaves invoice history unavailable. */
  listInvoices?(input: ListInvoicesInput): Promise<readonly BillingProviderInvoice[]>;
}

export interface BillingEntitlement {
  protocolVersion: typeof BILLING_PROTOCOL_VERSION;
  organizationId: string;
  planId: PlanId;
  limits: PlanLimits;
  state: 'active' | 'inactive' | 'disabled' | 'unconfigured';
  source: 'verified-webhook' | 'no-subscription' | 'billing-disabled';
  provider?: BillingProviderId;
  customerId?: string;
  subscriptionId?: string;
  currentPeriodEnd?: string;
  /** Safe explanation for operators and enforcement hooks. */
  reason: 'active-subscription' | 'no-active-subscription' | 'billing-disabled' | 'price-not-configured' | 'unknown-price';
}

export interface UsageDelta {
  seats?: number;
  storageBytes?: number;
  scans?: number;
  eveCostCents?: number;
}

export interface UsageSnapshot {
  organizationId: string;
  limits: PlanLimits;
  usage: BillingUsage;
  entitlement: BillingEntitlement;
}

export interface UsageReservation {
  operationKey: string;
  idempotent: boolean;
  delta: UsageDelta;
  snapshot: UsageSnapshot;
}

export interface UsageLimitDetails {
  metric: BillingMetric;
  limit: number;
  used: number;
  requested: number;
}

export interface BillingStatus {
  enabled: boolean;
  provider: BillingProviderId | null;
  mode: BillingMode;
  webhookVerification: boolean;
  checkout: boolean;
  portal: boolean;
}

export interface BillingServiceOptions {
  repository: BillingRepository;
  catalog?: PlanCatalog;
  provider?: BillingProvider;
  enabled?: boolean;
  webhookSecret?: string;
  webhookToleranceSeconds?: number;
  maxWebhookBodyBytes?: number;
  now?: () => number;
  /** Trusted origin owned by deployment configuration. */
  successUrl?: string;
  cancelUrl?: string;
  portalReturnUrl?: string;
}

export interface CheckoutRequest {
  organizationId: string;
  subject: string;
  planId: PlanId;
  email?: string;
  idempotencyKey?: string;
}

export interface PortalRequest {
  organizationId: string;
  subject: string;
  idempotencyKey?: string;
}

export interface WebhookHandlingResult {
  status: 'applied' | 'duplicate' | 'ignored';
  eventId: string;
  eventType: string;
  organizationId?: string;
  reason?: 'unsupported' | 'stale' | 'unbound';
}
