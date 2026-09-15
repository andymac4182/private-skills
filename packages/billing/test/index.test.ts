import { describe, expect, it } from 'vitest';
import {
  BILLING_POSTGRES_SCHEMA_SQL,
  BillingError,
  BillingService,
  DEFAULT_PLAN_DEFINITIONS,
  STRIPE_API_VERSION,
  billingPostgresSchemaSql,
  createBillingWebhookHandler,
  createBillingServiceFromEnv,
  createLocalBillingAdapter,
  createMemoryBillingRepository,
  createPlanCatalog,
  createStripeBillingAdapter,
  createTestSubscriptionEvent,
  PostgresBillingRepository,
  signWebhookPayload,
  verifyWebhookSignature,
  type BillingProvider,
  type BillingProviderInvoice,
  type BillingPgPoolLike,
  type BillingPgClientLike,
  type CreateCheckoutSessionInput,
  type CreateCustomerInput,
  type CreateCustomerPortalSessionInput,
  type HostedBillingSession,
  type PlanId,
  type ProviderCustomer,
} from '../src/index.js';

const NOW = Date.parse('2026-09-15T00:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW / 1_000);
const WEBHOOK_SECRET = 'whsec_private_skills_test_secret';

function configuredCatalog() {
  return createPlanCatalog({
    priceIds: {
      team: 'price_team_test',
      business: 'price_business_test',
    },
  });
}

interface ProviderCalls {
  customers: CreateCustomerInput[];
  checkouts: CreateCheckoutSessionInput[];
  portals: CreateCustomerPortalSessionInput[];
}

function mockProvider(): { provider: BillingProvider; calls: ProviderCalls } {
  const calls: ProviderCalls = { customers: [], checkouts: [], portals: [] };
  const provider: BillingProvider = {
    id: 'local',
    mode: 'test',
    async createCustomer(input): Promise<ProviderCustomer> {
      calls.customers.push(input);
      return { provider: 'local', customerId: `cus_${input.organizationId}` };
    },
    async createCheckoutSession(input): Promise<HostedBillingSession> {
      calls.checkouts.push(input);
      return { provider: 'local', mode: 'test', id: 'cs_test', url: 'http://localhost:5173/billing/test-checkout?session=cs_test' };
    },
    async createCustomerPortalSession(input): Promise<HostedBillingSession> {
      calls.portals.push(input);
      return { provider: 'local', mode: 'test', id: 'bps_test', url: 'http://localhost:5173/billing/test-portal?session=bps_test' };
    },
  };
  return { provider, calls };
}

function serviceWith(options: { enabled?: boolean; provider?: BillingProvider; catalog?: ReturnType<typeof configuredCatalog>; now?: () => number } = {}) {
  return new BillingService({
    repository: createMemoryBillingRepository({ now: options.now ?? (() => NOW) }),
    catalog: options.catalog ?? configuredCatalog(),
    enabled: options.enabled ?? true,
    ...(options.provider ? { provider: options.provider } : {}),
    webhookSecret: WEBHOOK_SECRET,
    now: options.now ?? (() => NOW),
    successUrl: 'https://private-skills.example/billing/success',
    cancelUrl: 'https://private-skills.example/billing/cancel',
    portalReturnUrl: 'https://private-skills.example/billing',
  });
}

describe('bounded plan catalog', () => {
  it('keeps every provisional allowance finite and exposes price readiness separately', () => {
    for (const plan of DEFAULT_PLAN_DEFINITIONS) {
      for (const limit of Object.values(plan.limits)) {
        expect(Number.isSafeInteger(limit)).toBe(true);
        expect(limit).toBeGreaterThan(0);
        expect(Number.isFinite(limit)).toBe(true);
      }
    }

    const catalog = createPlanCatalog({ env: { PSKILLS_BILLING_PRICE_TEAM: 'price_team_env' } });
    expect(catalog.byPriceId('price_team_env')?.id).toBe('team');
    expect(catalog.publicMetadata()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'team', priceConfigured: true, checkoutAvailable: true }),
      expect.objectContaining({ id: 'business', priceConfigured: false, checkoutAvailable: false }),
    ]));
  });

  it('rejects duplicate price mappings so verified prices have one entitlement', () => {
    const plans = DEFAULT_PLAN_DEFINITIONS.map((plan) => ({
      ...plan,
      limits: { ...plan.limits },
      ...(plan.id === 'team' || plan.id === 'business' ? { priceId: 'price_same' } : {}),
    }));
    expect(() => createPlanCatalog({ plans })).toThrow(/price_same.*duplicated/u);
  });

  it('rejects conflicting plan and deployment price mappings', () => {
    const plans = DEFAULT_PLAN_DEFINITIONS.map((plan) => ({ ...plan, limits: { ...plan.limits }, ...(plan.id === 'team' ? { priceId: 'price_from_plan' } : {}) }));
    expect(() => createPlanCatalog({ plans, priceIds: { team: 'price_from_env' } })).toThrow(/conflicting price mappings/u);
  });
});

describe('webhook verification and authoritative entitlements', () => {
  it('accepts an independently generated HMAC vector and rejects mutation or replay', async () => {
    // Generated independently with Python's hmac/hashlib implementation:
    // HMAC-SHA256("1700000000.{body}", "whsec_vector_secret_123").
    const body = '{"id":"evt_vector","object":"event"}';
    const signature = 't=1700000000,v1=479ced6de2949cbb3d94c4ddb99320041a878706385bf05c40e9af29544b1d0b';
    await expect(verifyWebhookSignature(body, signature, 'whsec_vector_secret_123', { now: () => 1_700_000_000_000 })).resolves.toMatchObject({
      timestamp: 1_700_000_000,
      apiVersion: STRIPE_API_VERSION,
    });
    await expect(verifyWebhookSignature(`${body} `, signature, 'whsec_vector_secret_123', { now: () => 1_700_000_000_000 })).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
    await expect(verifyWebhookSignature(body, signature, 'whsec_vector_secret_123', { now: () => 1_700_000_601_000 })).rejects.toMatchObject({ code: 'REPLAY_REJECTED' });
  });

  it('activates only from a signed mapped subscription event and deduplicates delivery', async () => {
    const { provider } = mockProvider();
    const service = serviceWith({ provider });
    const rawBody = createTestSubscriptionEvent({
      eventId: 'evt_business_1',
      created: NOW_SECONDS,
      organizationId: 'org-a',
      customerId: 'cus-a',
      subscriptionId: 'sub_test_a',
      priceId: 'price_business_test',
      currentPeriodStart: NOW_SECONDS,
      currentPeriodEnd: NOW_SECONDS + 30 * 86_400,
    });
    const signature = await signWebhookPayload(rawBody, WEBHOOK_SECRET, NOW_SECONDS);

    await expect(service.processWebhook(rawBody, signature)).resolves.toMatchObject({ status: 'applied', organizationId: 'org-a' });
    await expect(service.handleStripeWebhook(rawBody, signature)).resolves.toMatchObject({ status: 'duplicate', eventId: 'evt_business_1' });
    await expect(service.entitlement('org-a')).resolves.toMatchObject({
      planId: 'business',
      state: 'active',
      source: 'verified-webhook',
      customerId: 'cus-a',
      subscriptionId: 'sub_test_a',
    });

    const state = await service['repository'].read('org-a');
    expect(state.webhookEvents).toHaveLength(1);
    expect(state.subscription?.source).toBe('verified-webhook');

    const refundBody = JSON.stringify({ id: 'evt_refund_1', type: 'refund.created', created: NOW_SECONDS + 1, data: { object: { id: 're_test', object: 'refund', customer: 'cus-a' } } });
    await expect(service.handleWebhook(refundBody, await signWebhookPayload(refundBody, WEBHOOK_SECRET, NOW_SECONDS))).resolves.toMatchObject({ status: 'applied', eventId: 'evt_refund_1', organizationId: 'org-a' });
    await expect(service.entitlement('org-a')).resolves.toMatchObject({ planId: 'business', state: 'active' });
  });

  it('keeps unknown prices bounded and rejects a cross-tenant provider mapping', async () => {
    const { provider } = mockProvider();
    const service = serviceWith({ provider });
    const unknownBody = createTestSubscriptionEvent({
      eventId: 'evt_unknown_price',
      created: NOW_SECONDS,
      organizationId: 'org-unknown',
      customerId: 'cus-unknown',
      subscriptionId: 'sub_test_unknown',
      priceId: 'price_not_configured',
    });
    await expect(service.handleWebhook(unknownBody, await signWebhookPayload(unknownBody, WEBHOOK_SECRET, NOW_SECONDS))).resolves.toMatchObject({ status: 'applied' });
    await expect(service.entitlement('org-unknown')).resolves.toMatchObject({ planId: 'free', state: 'unconfigured', source: 'verified-webhook' });

    const conflictBody = createTestSubscriptionEvent({
      eventId: 'evt_cross_tenant',
      created: NOW_SECONDS + 1,
      organizationId: 'org-attacker',
      customerId: 'cus-unknown',
      subscriptionId: 'sub_test_attacker',
      priceId: 'price_business_test',
    });
    await expect(service.handleWebhook(conflictBody, await signWebhookPayload(conflictBody, WEBHOOK_SECRET, NOW_SECONDS))).rejects.toMatchObject({ code: 'TENANT_MAPPING_CONFLICT' });
    await expect(service.entitlement('org-attacker')).resolves.toMatchObject({ planId: 'free', state: 'inactive' });
  });

  it('does not treat a checkout URL or environment price label as entitlement state', async () => {
    const { provider } = mockProvider();
    const service = serviceWith({ provider });
    await expect(service.entitlement('org-query')).resolves.toMatchObject({ planId: 'free', state: 'inactive', source: 'no-subscription' });
    const local = createLocalBillingAdapter({ baseUrl: 'http://localhost:5173' });
    const hosted = await local.createCheckoutSession({
      organizationId: 'org-query',
      customerId: 'local_cus_query',
      priceId: 'price_business_test',
      planId: 'business' as PlanId,
      successUrl: 'http://localhost:5173/success',
      cancelUrl: 'http://localhost:5173/cancel',
      idempotencyKey: 'local-checkout',
    });
    const url = new URL(hosted.url);
    expect(url.searchParams.get('plan')).toBeNull();
    expect(url.searchParams.get('organization')).toBeNull();
  });
});

describe('billing provider readiness', () => {
  it('fails closed when disabled or when a plan has no configured price', async () => {
    const disabled = serviceWith({ enabled: false });
    expect(disabled.status()).toMatchObject({ enabled: false, mode: 'disabled', checkout: false, portal: false, webhookVerification: false });
    expect(disabled.publicPlans().find((plan) => plan.id === 'business')?.checkoutAvailable).toBe(false);
    await expect(disabled.entitlement('org-disabled')).resolves.toMatchObject({ planId: 'free', state: 'disabled', source: 'billing-disabled' });
    await expect(disabled.checkout({ organizationId: 'org-disabled', subject: 'owner', planId: 'business' })).rejects.toMatchObject({ code: 'BILLING_DISABLED' });

    const { provider } = mockProvider();
    const unconfigured = serviceWith({ provider, catalog: createPlanCatalog() });
    expect(unconfigured.status().checkout).toBe(false);
    await expect(unconfigured.checkout({ organizationId: 'org-unconfigured', subject: 'owner', planId: 'team' })).rejects.toMatchObject({ code: 'PLAN_NOT_CONFIGURED' });
  });

  it('keeps usage enforcement available when hosted provider setup is deferred', async () => {
    const repository = createMemoryBillingRepository({ now: () => NOW });
    const service = new BillingService({
      repository,
      catalog: configuredCatalog(),
      enabled: true,
      now: () => NOW,
      successUrl: 'https://private-skills.example/billing/success',
      cancelUrl: 'https://private-skills.example/billing/cancel',
      portalReturnUrl: 'https://private-skills.example/billing',
    });
    const timestamp = new Date(NOW).toISOString();
    await repository.transaction('org-provider-deferred', (state) => {
      state.customer = { organizationId: state.organizationId, provider: 'stripe', customerId: 'cus_deferred', createdAt: timestamp, updatedAt: timestamp };
      state.subscription = {
        organizationId: state.organizationId,
        provider: 'stripe',
        subscriptionId: 'sub_deferred',
        customerId: 'cus_deferred',
        priceId: 'price_team_test',
        planId: 'team',
        status: 'active',
        cancelAtPeriodEnd: false,
        eventCreatedAt: NOW_SECONDS,
        lastEventId: 'evt_deferred',
        source: 'verified-webhook',
        updatedAt: timestamp,
      };
    });
    expect(service.status()).toMatchObject({ enabled: true, usageEnforcement: true, providerReady: false, provider: null, checkout: false, portal: false, webhookVerification: false });
    await expect(service.entitlement('org-provider-deferred')).resolves.toMatchObject({ planId: 'team', state: 'active' });
    await expect(service.reserveUsage('org-provider-deferred', { scans: 1 }, 'deferred-eve-scan')).resolves.toMatchObject({ idempotent: false });
  });

  it('keeps explicit environment admission enabled without inferring a provider', () => {
    const service = createBillingServiceFromEnv({
      repository: createMemoryBillingRepository({ now: () => NOW }),
      env: { PSKILLS_BILLING_ENABLED: 'true' },
    });
    expect(service.status()).toMatchObject({ enabled: true, usageEnforcement: true, providerReady: false, provider: null, checkout: false, portal: false });
  });

  it('uses one server-owned customer mapping for hosted checkout and portal', async () => {
    const { provider, calls } = mockProvider();
    const service = serviceWith({ provider });
    await expect(service.checkout({ organizationId: 'org-checkout', subject: 'owner', planId: 'team', email: 'owner@example.test', idempotencyKey: 'checkout-1' })).resolves.toMatchObject({ id: 'cs_test' });
    await expect(service.checkout({ organizationId: 'org-checkout', subject: 'owner', planId: 'team', idempotencyKey: 'checkout-2' })).resolves.toMatchObject({ id: 'cs_test' });
    await expect(service.portal({ organizationId: 'org-checkout', subject: 'owner', idempotencyKey: 'portal-1' })).resolves.toMatchObject({ id: 'bps_test' });
    expect(calls.customers).toHaveLength(1);
    expect(calls.customers[0]).toMatchObject({ organizationId: 'org-checkout', email: 'owner@example.test', idempotencyKey: 'private-skills:customer:org-checkout' });
    expect(calls.checkouts).toHaveLength(2);
    expect(calls.checkouts[0]).toMatchObject({ organizationId: 'org-checkout', customerId: 'cus_org-checkout', priceId: 'price_team_test', planId: 'team' });
    expect(calls.portals[0]).toMatchObject({ organizationId: 'org-checkout', customerId: 'cus_org-checkout' });
  });

  it('deduplicates concurrent customer creation per organization', async () => {
    const calls = { customers: 0 };
    const provider: BillingProvider = {
      id: 'local',
      mode: 'test',
      async createCustomer() {
        calls.customers += 1;
        await new Promise((resolve) => setTimeout(resolve, 2));
        return { provider: 'local', customerId: 'cus-concurrent' };
      },
      async createCheckoutSession(input) { return { provider: 'local', mode: 'test', id: input.idempotencyKey, url: 'http://localhost:5173/billing/test-checkout' }; },
      async createCustomerPortalSession(input) { return { provider: 'local', mode: 'test', id: input.idempotencyKey, url: 'http://localhost:5173/billing/test-portal' }; },
    };
    const service = serviceWith({ provider });
    await Promise.all([
      service.checkout({ organizationId: 'org-concurrent-checkout', subject: 'owner', planId: 'team', idempotencyKey: 'c-a' }),
      service.checkout({ organizationId: 'org-concurrent-checkout', subject: 'owner', planId: 'team', idempotencyKey: 'c-b' }),
    ]);
    expect(calls.customers).toBe(1);
  });

  it('keeps the portal closed when no paid provider price is allowlisted', async () => {
    const { provider } = mockProvider();
    const service = serviceWith({ provider, catalog: createPlanCatalog() });
    expect(service.status()).toMatchObject({ checkout: false, portal: false });
    await expect(service.portal({ organizationId: 'org-unconfigured-portal', subject: 'owner' })).rejects.toMatchObject({ code: 'PLAN_NOT_CONFIGURED' });
  });

  it('handles the webhook endpoint as a bounded raw-body, signed POST route', async () => {
    const { provider } = mockProvider();
    const service = serviceWith({ provider });
    const handler = createBillingWebhookHandler(service, { path: '/api/billing/webhook' });
    const body = createTestSubscriptionEvent({ eventId: 'evt_handler', created: NOW_SECONDS, organizationId: 'org-handler', customerId: 'cus-handler', subscriptionId: 'sub_test_handler', priceId: 'price_team_test' });
    const signature = await signWebhookPayload(body, WEBHOOK_SECRET, NOW_SECONDS);
    const response = await handler(new Request('https://private-skills.example/api/billing/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': signature },
      body,
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ received: true, status: 'applied' });

    const invalid = await handler(new Request('https://private-skills.example/api/billing/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 't=1700000000,v1=bad' },
      body,
    }));
    expect(invalid.status).toBe(400);

    const declaredTooLarge = await handler(new Request('https://private-skills.example/api/billing/webhook', {
      method: 'POST',
      headers: { 'content-length': String(10 * 1024 * 1024 + 1) },
    }));
    expect(declaredTooLarge.status).toBe(413);

    const malformedUtf8 = await handler(new Request('https://private-skills.example/api/billing/webhook', {
      method: 'POST',
      body: new Uint8Array([0xff]),
    }));
    expect(malformedUtf8.status).toBe(400);
  });
});

describe('provider invoice read model', () => {
  it('reads and validates Stripe invoices through the server-only adapter', async () => {
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    const adapter = createStripeBillingAdapter({
      secretKey: 'sk_test_fixture',
      apiBaseUrl: 'https://stripe.example.test',
      fetch: async (input, init) => {
        requestUrl = String(input);
        requestInit = init;
        return Response.json({
          object: 'list',
          data: [{
            id: 'in_test_1',
            customer: 'cus_company',
            status: 'paid',
            amount_due: 9900,
            amount_paid: 9900,
            currency: 'AUD',
            number: 'INV-1',
            created: NOW_SECONDS,
            status_transitions: { paid_at: NOW_SECONDS + 60 },
            period_start: NOW_SECONDS - 30 * 86_400,
            period_end: NOW_SECONDS,
            hosted_invoice_url: 'https://pay.stripe.example.test/invoices/in_test_1',
            invoice_pdf: 'https://files.stripe.example.test/invoices/in_test_1.pdf',
          }],
          has_more: false,
        });
      },
    });

    await expect(adapter.listInvoices({ customerId: 'cus_company', limit: 10 })).resolves.toEqual([expect.objectContaining({
      provider: 'stripe',
      invoiceId: 'in_test_1',
      customerId: 'cus_company',
      status: 'paid',
      amountDueCents: 9900,
      amountPaidCents: 9900,
      currency: 'aud',
      number: 'INV-1',
      createdAt: new Date(NOW * 1).toISOString(),
    })]);
    expect(requestUrl).toBe('https://stripe.example.test/v1/invoices?customer=cus_company&limit=10');
    expect(requestInit?.method).toBe('GET');
    expect(requestInit?.redirect).toBe('error');
    expect(new Headers(requestInit?.headers).get('authorization')).toBe('Bearer sk_test_fixture');
    expect(new Headers(requestInit?.headers).get('stripe-version')).toBe(STRIPE_API_VERSION);
  });

  it('rejects a provider invoice that crosses the requested customer mapping', async () => {
    const adapter = createStripeBillingAdapter({
      secretKey: 'sk_test_fixture',
      apiBaseUrl: 'https://stripe.example.test',
      fetch: async () => Response.json({ data: [{ id: 'in_wrong', customer: 'cus_other', status: 'open', created: NOW_SECONDS }] }),
    });
    await expect(adapter.listInvoices({ customerId: 'cus_company' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('checks the durable customer mapping before invoking a provider invoice reader', async () => {
    const { provider } = mockProvider();
    let readCount = 0;
    const invoice: BillingProviderInvoice = {
      provider: 'local',
      invoiceId: 'in_local_1',
      customerId: 'cus_org-invoices',
      status: 'paid',
      createdAt: new Date(NOW).toISOString(),
    };
    const invoiceProvider: BillingProvider = {
      ...provider,
      async listInvoices(input) {
        readCount += 1;
        expect(input).toEqual({ customerId: 'cus_org-invoices', limit: 100 });
        return [invoice];
      },
    };
    const service = serviceWith({ provider: invoiceProvider });
    await service.checkout({ organizationId: 'org-invoices', subject: 'owner', planId: 'team' });
    await expect(service.listInvoices({ organizationId: 'org-invoices', provider: 'local', mode: 'test', customerId: 'cus_org-invoices' })).resolves.toEqual([invoice]);
    await expect(service.listInvoices({ organizationId: 'org-invoices', provider: 'local', mode: 'test', customerId: 'cus-other' })).rejects.toMatchObject({ code: 'CUSTOMER_MAPPING_CONFLICT' });
    expect(readCount).toBe(1);
  });
});

describe('transactional usage enforcement', () => {
  it('keeps global memory operation lookup available after the recent window ages out', async () => {
    const repository = createMemoryBillingRepository({ now: () => NOW });
    await repository.transaction('org-memory-aged', (state) => {
      state.usageOperations = Array.from({ length: 20_001 }, (_, index) => ({
        organizationId: 'org-memory-aged',
        operationKey: index === 0 ? 'memory-aged-operation' : `memory-operation-${index}`,
        delta: { scans: 1 },
        usage: { ...state.usage },
        createdAt: new Date(NOW + index).toISOString(),
        status: 'released' as const,
      }));
    });

    const recent = await repository.read('org-memory-aged');
    expect(recent.usageOperations).toHaveLength(20_000);
    expect(recent.usageOperations.some((operation) => operation.operationKey === 'memory-aged-operation')).toBe(false);
    await expect(repository.findUsageOperation('memory-aged-operation')).resolves.toMatchObject({
      organizationId: 'org-memory-aged',
      operationKey: 'memory-aged-operation',
      status: 'released',
    });
  });

  it('enforces all finite limits atomically and makes retries idempotent', async () => {
    const service = serviceWith({ enabled: false });
    const limit = (await service.entitlement('org-limits')).limits;
    const initial = await service.reserveUsage('org-limits', {
      seats: limit.seats,
      storageBytes: limit.storageBytes,
      scans: limit.scansPerMonth,
      eveCostCents: limit.eveCostCentsPerMonth,
    }, 'operation-at-limit');
    expect(initial.idempotent).toBe(false);
    await expect(service.reserveUsage('org-limits', { scans: 1 }, 'operation-over')).rejects.toMatchObject({ code: 'USAGE_LIMIT_EXCEEDED', status: 429 });
    await expect(service.reserveUsage('org-limits', {
      seats: limit.seats,
      storageBytes: limit.storageBytes,
      scans: limit.scansPerMonth,
      eveCostCents: limit.eveCostCentsPerMonth,
    }, 'operation-at-limit')).resolves.toMatchObject({ idempotent: true });
    await expect(service.reserveUsage('org-limits', { seats: 1 }, 'operation-at-limit')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(service.usageSnapshot('org-limits')).resolves.toMatchObject({ usage: { seats: limit.seats, storageBytes: limit.storageBytes, scans: limit.scansPerMonth, eveCostCents: limit.eveCostCentsPerMonth } });
  });

  it('serializes authoritative seat counts and supports estimate reconciliation', async () => {
    const service = serviceWith({ enabled: false });
    const results = await Promise.allSettled([
      service.setSeatCount('org-seats', 3, 'seat-membership-a'),
      service.setSeatCount('org-seats', 4, 'seat-membership-b'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: expect.objectContaining({ code: 'USAGE_LIMIT_EXCEEDED' }) });
    await expect(service.usageSnapshot('org-seats')).resolves.toMatchObject({ usage: { seats: 3 } });

    await service.reserveUsage('org-seats', { eveCostCents: 40 }, 'eve-estimate');
    await expect(service.reconcileUsage('org-seats', 'eve-estimate', { eveCostCents: 25 }, 'eve-actual')).resolves.toMatchObject({ idempotent: false, snapshot: { usage: { eveCostCents: 25 } } });
    await expect(service.reconcileReservedUsage('org-seats', 'eve-estimate', { eveCostCents: 25 }, 'eve-actual')).resolves.toMatchObject({ idempotent: true });
  });

  it('keeps concurrent seat holds across reconciliation and reuses lifecycle keys after release', async () => {
    const service = serviceWith({ enabled: false });
    await service.syncSeatCount('org-seat-lifecycle', 2, 'seed');
    const results = await Promise.allSettled([
      service.reserveSeat('org-seat-lifecycle', 'invite-a'),
      service.reserveSeat('org-seat-lifecycle', 'invite-b'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const winner = results.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof service.reserveSeat>>> => result.status === 'fulfilled')!.value.operationKey;
    await expect(service.usageSnapshot('org-seat-lifecycle')).resolves.toMatchObject({ usage: { seats: 3 } });

    // Cancellation releases the active hold. Re-inviting the same email/key
    // is a new lifecycle and must reserve again rather than returning the old
    // idempotent result.
    await expect(service.releaseSeat('org-seat-lifecycle', winner)).resolves.toMatchObject({ idempotent: false });
    await expect(service.reserveSeat('org-seat-lifecycle', winner)).resolves.toMatchObject({ idempotent: false });
    await expect(service.commitSeat('org-seat-lifecycle', winner)).resolves.toMatchObject({ idempotent: false });
    await expect(service.syncSeatCount('org-seat-lifecycle', 3, 'commit')).resolves.toMatchObject({ snapshot: { usage: { seats: 3 } } });

    // A stale lower count must not lower the committed baseline. The explicit
    // lifecycle release then frees the seat, and a later re-add of the same
    // subject key admits a fresh seat.
    await service.syncSeatCount('org-seat-lifecycle', 2, 'stale-remove-observation');
    await expect(service.usageSnapshot('org-seat-lifecycle')).resolves.toMatchObject({ usage: { seats: 3 } });
    await expect(service.releaseSeat('org-seat-lifecycle', winner)).resolves.toMatchObject({ idempotent: false });
    await expect(service.reserveSeat('org-seat-lifecycle', winner)).resolves.toMatchObject({ idempotent: false });
    await expect(service.usageSnapshot('org-seat-lifecycle')).resolves.toMatchObject({ usage: { seats: 3 } });
  });

  it('exposes active failed-write holds and requires matching operator proof to release them', async () => {
    const service = serviceWith();
    await service.reserveSeat('org-seat-recovery', 'failed-member-hold', { subjectKey: true });
    await expect(service.activeSeatReservations('org-seat-recovery')).resolves.toMatchObject([
      { operationKey: 'failed-member-hold', status: 'active', subjectKey: true, committed: false },
    ]);

    const proof = { kind: 'known-failure' as const, reference: 'better-auth-create-member-err-1' };
    await expect(service.releaseSeatAfterFailure('org-seat-recovery', 'failed-member-hold', proof)).resolves.toMatchObject({
      idempotent: false,
      reservation: { operationKey: 'failed-member-hold', status: 'settled', committed: false, recoveryProof: proof },
      snapshot: { usage: { seats: 0 } },
    });
    await expect(service.activeSeatReservations('org-seat-recovery')).resolves.toEqual([]);
    await expect(service.releaseSeatAfterFailure('org-seat-recovery', 'failed-member-hold', proof)).resolves.toMatchObject({ idempotent: true });
    await expect(service.releaseSeatAfterFailure('org-seat-recovery', 'failed-member-hold', { kind: 'known-failure', reference: 'different-proof' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await service.reserveSeat('org-seat-recovery', 'failed-member-hold', { subjectKey: true });
    const reactivated = await service.activeSeatReservations('org-seat-recovery');
    expect(reactivated).toMatchObject([{ operationKey: 'failed-member-hold', status: 'active' }]);
    expect(reactivated[0]).not.toHaveProperty('recoveryProof');
    await service.releaseSeatAfterFailure('org-seat-recovery', 'failed-member-hold', { kind: 'writer-terminated', reference: 'better-auth-create-member-err-2' });

    await service.reserveSeat('org-seat-recovery', 'committed-member-hold', { subjectKey: true });
    await service.commitSeat('org-seat-recovery', 'committed-member-hold');
    await expect(service.releaseSeatAfterFailure('org-seat-recovery', 'committed-member-hold', { kind: 'writer-terminated', reference: 'writer-terminated-1' })).rejects.toMatchObject({ code: 'SEAT_RESERVATION_SETTLED' });
    await expect(service.releaseSeatAfterFailure('org-seat-recovery', 'missing-member-hold', proof)).rejects.toMatchObject({ code: 'SEAT_RESERVATION_NOT_FOUND' });
  });

  it('resets monthly counters while retaining seats and storage', async () => {
    let now = Date.parse('2026-01-31T23:00:00.000Z');
    const service = serviceWith({ enabled: false, now: () => now });
    await service.reserveUsage('org-rollover', { seats: 2, storageBytes: 1_000, scans: 25, eveCostCents: 25 }, 'before-rollover');
    now = Date.parse('2026-02-01T00:00:00.000Z');
    await expect(service.usageSnapshot('org-rollover')).resolves.toMatchObject({ usage: { seats: 2, storageBytes: 1_000, scans: 0, eveCostCents: 0 } });
    await service.reserveUsage('org-rollover', { scans: 1 }, 'after-rollover');
    await expect(service.usageSnapshot('org-rollover')).resolves.toMatchObject({ usage: { seats: 2, storageBytes: 1_000, scans: 1, eveCostCents: 0 } });
  });

  it('serializes concurrent deliveries and keeps the newest provider event authoritative', async () => {
    const { provider } = mockProvider();
    const service = serviceWith({ provider });
    const newer = createTestSubscriptionEvent({ eventId: 'evt_newer', created: NOW_SECONDS, organizationId: 'org-order', customerId: 'cus-order', subscriptionId: 'sub_order', priceId: 'price_business_test' });
    const older = createTestSubscriptionEvent({ eventId: 'evt_older', created: NOW_SECONDS - 1, organizationId: 'org-order', customerId: 'cus-order', subscriptionId: 'sub_order', priceId: 'price_team_test' });
    const [newerResult, olderResult] = await Promise.all([
      service.handleWebhook(newer, await signWebhookPayload(newer, WEBHOOK_SECRET, NOW_SECONDS)),
      service.handleWebhook(older, await signWebhookPayload(older, WEBHOOK_SECRET, NOW_SECONDS)),
    ]);
    expect([newerResult.status, olderResult.status].sort()).toEqual(['applied', 'ignored']);
    expect(olderResult.reason).toBe('stale');
    await expect(service.entitlement('org-order')).resolves.toMatchObject({ planId: 'business', state: 'active' });

    const sameSecondActive = createTestSubscriptionEvent({ eventId: 'evt_same_b', created: NOW_SECONDS + 2, organizationId: 'org-tie', customerId: 'cus-tie', subscriptionId: 'sub_tie', priceId: 'price_business_test' });
    const sameSecondCanceled = createTestSubscriptionEvent({ eventId: 'evt_same_a', created: NOW_SECONDS + 2, organizationId: 'org-tie', customerId: 'cus-tie', subscriptionId: 'sub_tie', priceId: 'price_business_test', status: 'canceled' });
    await expect(service.handleWebhook(sameSecondActive, await signWebhookPayload(sameSecondActive, WEBHOOK_SECRET, NOW_SECONDS))).resolves.toMatchObject({ status: 'applied' });
    await expect(service.handleWebhook(sameSecondCanceled, await signWebhookPayload(sameSecondCanceled, WEBHOOK_SECRET, NOW_SECONDS))).resolves.toMatchObject({ status: 'ignored', reason: 'stale' });
    await expect(service.entitlement('org-tie')).resolves.toMatchObject({ planId: 'business', state: 'active' });
  });

  it('does not release omitted metered resources during partial reconciliation', async () => {
    const service = serviceWith({ enabled: false });
    await service.reserveUsage('org-partial-reconcile', { scans: 2, eveCostCents: 40 }, 'estimate');
    await service.reconcileUsage('org-partial-reconcile', 'estimate', { eveCostCents: 25 }, 'actual');
    await expect(service.usageSnapshot('org-partial-reconcile')).resolves.toMatchObject({ usage: { scans: 2, eveCostCents: 25 } });
  });

  it('keeps explicit zero reconciliation and reopens the same released key', async () => {
    const service = serviceWith({ enabled: false });
    await service.reserveUsage('org-reopen', { storageBytes: 40 }, 'stable-import');
    await expect(service.reconcileUsage('org-reopen', 'stable-import', { storageBytes: 0 }, 'stable-import-release')).resolves.toMatchObject({ idempotent: false });
    await expect(service.usageSnapshot('org-reopen')).resolves.toMatchObject({ usage: { storageBytes: 0 } });
    await expect(service.reserveUsage('org-reopen', { storageBytes: 40 }, 'stable-import')).resolves.toMatchObject({ idempotent: false, snapshot: { usage: { storageBytes: 40 } } });
    await expect(service.usageSnapshot('org-reopen')).resolves.toMatchObject({ usage: { storageBytes: 40 } });
    await expect(service.reconcileUsage('org-reopen', 'stable-import', { storageBytes: 0 }, 'stable-import-release')).resolves.toMatchObject({ idempotent: false });
    await expect(service.usageSnapshot('org-reopen')).resolves.toMatchObject({ usage: { storageBytes: 0 } });
    await expect(service.reconcileUsage('org-reopen', 'stable-import', { storageBytes: 0 }, 'stable-import-release')).resolves.toMatchObject({ idempotent: true });
  });

  it('releases a reserved metric when reconciliation explicitly reports zero', async () => {
    const service = serviceWith({ enabled: false });
    await service.reserveUsage('org-zero-reconcile', { eveCostCents: 40 }, 'estimate');
    await service.reconcileUsage('org-zero-reconcile', 'estimate', { eveCostCents: 0 }, 'release');
    await expect(service.usageSnapshot('org-zero-reconcile')).resolves.toMatchObject({ usage: { eveCostCents: 0 } });
  });
});

describe('PostgreSQL repository contract', () => {
  class FakePgPool implements BillingPgPoolLike {
    readonly customers = new Map<string, Record<string, unknown>>();
    readonly subscriptions = new Map<string, Record<string, unknown>>();
    readonly usage = new Map<string, Record<string, unknown>>();
    readonly events = new Map<string, Record<string, unknown>>();
    readonly operations = new Map<string, Record<string, unknown>>();

    async query<Row = Record<string, unknown>>(text: string, parameters: readonly unknown[] = []) {
      return this.run<Row>(text, parameters);
    }

    async connect(): Promise<BillingPgClientLike> {
      return { query: <Row = Record<string, unknown>>(text: string, parameters: readonly unknown[] = []) => this.run<Row>(text, parameters) };
    }

    private async run<Row>(text: string, parameters: readonly unknown[]) {
      if (/^(BEGIN|COMMIT|ROLLBACK)$/u.test(text.trim())) return { rows: [] as Row[], rowCount: 0 };
      if (text.includes('INSERT INTO "billing_contract_usage"') && text.includes('ON CONFLICT')) {
        const current = this.usage.get(String(parameters[0]));
        if (text.includes('VALUES ($1, $2::timestamptz, $3::timestamptz, 0, 0, 0, 0')) {
          const [organizationId, periodStart, periodEnd, updatedAt] = parameters;
          if (!current) this.usage.set(String(organizationId), { organization_id: organizationId, period_start: periodStart, period_end: periodEnd, seats: 0, storage_bytes: 0, scans: 0, eve_cost_cents: 0, seat_baseline: 0, seat_reservations: '[]', seat_revision: 0, updated_at: updatedAt });
          return { rows: [] as Row[], rowCount: current ? 0 : 1 };
        }
        const [organizationId, periodStart, periodEnd, seats, storageBytes, scans, eveCostCents, updatedAt, seatBaseline, seatReservations, seatRevision] = parameters;
        this.usage.set(String(organizationId), { organization_id: organizationId, period_start: periodStart, period_end: periodEnd, seats, storage_bytes: storageBytes, scans, eve_cost_cents: eveCostCents, seat_baseline: seatBaseline ?? seats, seat_reservations: seatReservations ?? '[]', seat_revision: seatRevision ?? 0, updated_at: updatedAt });
        return { rows: [] as Row[], rowCount: 1 };
      }
      if (text.includes('SELECT organization_id, provider, customer_id') && text.includes('FROM "billing_contract_customers"')) {
        const row = this.customers.get(String(parameters[0]));
        return { rows: (row ? [row] : []) as Row[], rowCount: row ? 1 : 0 };
      }
      if (text.includes('SELECT organization_id, provider, subscription_id') && text.includes('FROM "billing_contract_subscriptions"')) {
        const row = this.subscriptions.get(String(parameters[0]));
        return { rows: (row ? [row] : []) as Row[], rowCount: row ? 1 : 0 };
      }
      if (text.includes('SELECT organization_id, period_start') && text.includes('FROM "billing_contract_usage"')) {
        const row = this.usage.get(String(parameters[0]));
        return { rows: (row ? [row] : []) as Row[], rowCount: row ? 1 : 0 };
      }
      if (text.includes('SELECT provider, event_id, event_type') && text.includes('FROM "billing_contract_webhook_events" WHERE organization_id')) {
        const rows = [...this.events.values()].filter((row) => row.organization_id === parameters[0]);
        return { rows: rows as Row[], rowCount: rows.length };
      }
      if (text.includes('SELECT organization_id, operation_key') && text.includes('FROM "billing_contract_usage_operations"')) {
        const rows = [...this.operations.values()].filter((row) => row.organization_id === parameters[0]);
        return { rows: rows as Row[], rowCount: rows.length };
      }
      if (text.includes('INSERT INTO "billing_contract_customers"')) {
        const [organizationId, provider, customerId, createdAt, updatedAt] = parameters;
        const duplicate = [...this.customers.values()].find((row) => row.provider === provider && row.customer_id === customerId && row.organization_id !== organizationId);
        if (duplicate) throw Object.assign(new Error('duplicate customer'), { code: '23505' });
        this.customers.set(String(organizationId), { organization_id: organizationId, provider, customer_id: customerId, created_at: createdAt, updated_at: updatedAt });
        return { rows: [] as Row[], rowCount: 1 };
      }
      if (text.includes('DELETE FROM "billing_contract_customers"')) {
        this.customers.delete(String(parameters[0]));
        return { rows: [] as Row[], rowCount: 1 };
      }
      if (text.includes('INSERT INTO "billing_contract_subscriptions"')) {
        const [organizationId, provider, subscriptionId, customerId, priceId, planId, status, periodStart, periodEnd, cancelAtPeriodEnd, eventCreatedAt, lastEventId, source, updatedAt] = parameters;
        const duplicate = [...this.subscriptions.values()].find((row) => row.provider === provider && row.subscription_id === subscriptionId && row.organization_id !== organizationId);
        if (duplicate) throw Object.assign(new Error('duplicate subscription'), { code: '23505' });
        this.subscriptions.set(String(organizationId), { organization_id: organizationId, provider, subscription_id: subscriptionId, customer_id: customerId, price_id: priceId, plan_id: planId, status, current_period_start: periodStart, current_period_end: periodEnd, cancel_at_period_end: cancelAtPeriodEnd, event_created_at: eventCreatedAt, last_event_id: lastEventId, source, updated_at: updatedAt });
        return { rows: [] as Row[], rowCount: 1 };
      }
      if (text.includes('DELETE FROM "billing_contract_subscriptions"')) {
        this.subscriptions.delete(String(parameters[0]));
        return { rows: [] as Row[], rowCount: 1 };
      }
      if (text.includes('INSERT INTO "billing_contract_webhook_events"')) {
        const [provider, eventId, eventType, organizationId, createdAt, receivedAt, payloadDigest, handled, ignoredReason] = parameters;
        const key = `${provider}:${eventId}`;
        if (this.events.has(key)) return { rows: [] as Row[], rowCount: 0 };
        const row = { provider, event_id: eventId, event_type: eventType, organization_id: organizationId, created_at: createdAt, received_at: receivedAt, payload_digest: payloadDigest, handled, ignored_reason: ignoredReason };
        this.events.set(key, row);
        return { rows: [row] as Row[], rowCount: 1 };
      }
      if (text.includes('INSERT INTO "billing_contract_usage_operations"')) {
        const [organizationId, operationKey, seats, storageBytes, scans, eveCostCents, usageSnapshot, createdAt, status, reconciled] = parameters;
        const key = `${organizationId}:${operationKey}`;
        this.operations.set(key, { organization_id: organizationId, operation_key: operationKey, seats_delta: seats, storage_bytes_delta: storageBytes, scans_delta: scans, eve_cost_cents_delta: eveCostCents, usage_snapshot: usageSnapshot, created_at: createdAt, status: status ?? 'reserved', reconciled: reconciled ?? null });
        return { rows: [] as Row[], rowCount: 1 };
      }
      if (text.includes('SELECT organization_id FROM "billing_contract_customers"')) {
        const row = [...this.customers.values()].find((candidate) => candidate.provider === parameters[0] && candidate.customer_id === parameters[1]);
        return { rows: (row ? [{ organization_id: row.organization_id }] : []) as Row[], rowCount: row ? 1 : 0 };
      }
      if (text.includes('SELECT organization_id FROM "billing_contract_subscriptions"')) {
        const row = [...this.subscriptions.values()].find((candidate) => candidate.provider === parameters[0] && candidate.subscription_id === parameters[1]);
        return { rows: (row ? [{ organization_id: row.organization_id }] : []) as Row[], rowCount: row ? 1 : 0 };
      }
      if (text.includes('SELECT provider, event_id, event_type') && text.includes('WHERE provider = $1 AND event_id = $2')) {
        const row = this.events.get(`${parameters[0]}:${parameters[1]}`);
        return { rows: (row ? [row] : []) as Row[], rowCount: row ? 1 : 0 };
      }
      throw new Error(`Unhandled fake SQL: ${text}`);
    }
  }

  it('persists company customer and subscription mappings transactionally', async () => {
    const pool = new FakePgPool();
    const repository = new PostgresBillingRepository(pool, { tablePrefix: 'billing_contract' });
    await repository.transaction('org-postgres', (state) => {
      const timestamp = '2026-09-15T00:00:00.000Z';
      state.customer = { organizationId: 'org-postgres', provider: 'stripe', customerId: 'cus_postgres', createdAt: timestamp, updatedAt: timestamp };
      state.subscription = { organizationId: 'org-postgres', provider: 'stripe', subscriptionId: 'sub_postgres', customerId: 'cus_postgres', priceId: 'price_team', planId: 'team', status: 'active', cancelAtPeriodEnd: false, eventCreatedAt: NOW_SECONDS, lastEventId: 'evt_postgres', source: 'verified-webhook', updatedAt: timestamp };
    });
    await expect(repository.findOrganizationByCustomerId('stripe', 'cus_postgres')).resolves.toBe('org-postgres');
    await expect(repository.findOrganizationBySubscriptionId('stripe', 'sub_postgres')).resolves.toBe('org-postgres');
    await expect(repository.read('org-postgres')).resolves.toMatchObject({ customer: { customerId: 'cus_postgres' }, subscription: { subscriptionId: 'sub_postgres', priceId: 'price_team' } });
  });

  it('claims a webhook event once across organization transactions', async () => {
    const pool = new FakePgPool();
    const repository = new PostgresBillingRepository(pool, { tablePrefix: 'billing_contract' });
    const event = { provider: 'stripe' as const, eventId: 'evt_once', eventType: 'customer.subscription.created', createdAt: NOW_SECONDS, receivedAt: '2026-09-15T00:00:00.000Z', payloadDigest: `sha256:${'a'.repeat(64)}`, organizationId: 'org-one', handled: true };
    await repository.transaction('org-one', (state) => { state.webhookEvents.push(event); });
    await expect(repository.transaction('org-two', (state) => { state.webhookEvents.push({ ...event, organizationId: 'org-two' }); })).rejects.toMatchObject({ code: 'DUPLICATE_WEBHOOK' });
  });
});

describe('separate PostgreSQL billing migration', () => {
  it('owns normalized billing tables without changing auth or registry tables', () => {
    const sql = billingPostgresSchemaSql('pskills_billing_test');
    expect(sql).toContain('"pskills_billing_test_customers"');
    expect(sql).toContain('"pskills_billing_test_subscriptions"');
    expect(sql).toContain('"pskills_billing_test_usage"');
    expect(sql).toContain('"pskills_billing_test_webhook_events"');
    expect(sql).toContain('"pskills_billing_test_usage_operations"');
    expect(sql).toContain("CHECK (source = 'verified-webhook')");
    expect(sql).toContain('PRIMARY KEY (provider, event_id)');
    expect(sql).toContain('PRIMARY KEY (organization_id, operation_key)');
    expect(sql).not.toMatch(/better.?auth|organization_metadata|registry_state/iu);
    expect(BILLING_POSTGRES_SCHEMA_SQL).toContain('private_skills_billing_customers');
  });
});
