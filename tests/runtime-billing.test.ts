import { describe, expect, it, vi } from 'vitest';
import { createBillingRoutes } from '../apps/web/server/routes/billing.js';
import { createBillingRuntime } from '../apps/web/server/runtime-node.js';
import {
  createTestSubscriptionEvent,
  signWebhookPayload,
  type BillingPgPoolLike,
} from '../packages/billing/src/index.js';
import type { Principal } from '../packages/contracts/src/index.js';

const SECRET = 'runtime_billing_test_secret';
const principal: Principal = { organizationId: 'org-runtime', subject: 'owner-runtime', roles: ['owner'] };

function json(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

describe('Node billing runtime composition', () => {
  it('mounts the local test checkout, portal, invoice, and signed webhook journey', async () => {
    const runtime = createBillingRuntime({
      PSKILLS_ENVIRONMENT: 'test',
      PSKILLS_BILLING_ENABLED: 'true',
      PSKILLS_BILLING_PROVIDER: 'local',
      PSKILLS_BILLING_LOCAL_TEST: 'true',
      PSKILLS_BILLING_PRICE_TEAM: 'price_team_runtime',
      PSKILLS_BILLING_WEBHOOK_SECRET: SECRET,
      PSKILLS_BILLING_LOCAL_BASE_URL: 'http://localhost:5173',
    }, undefined, 'http://localhost:5173');
    const routes = createBillingRoutes({
      service: runtime.service,
      authenticate: async () => principal,
      invoiceHistory: async (lookup) => (await runtime.invoiceHistory(lookup)).map((invoice) => ({
        ...invoice,
        organizationId: lookup.organizationId,
      })),
    });

    const initial = await routes(new Request('http://localhost:5173/v1/billing?organizationId=attacker'));
    expect(initial?.status).toBe(200);
    expect(await json(initial!)).toMatchObject({
      organizationId: 'org-runtime',
      readiness: 'test',
      status: { provider: 'local', mode: 'test', checkout: true, portal: true, webhookVerification: true },
      actions: { checkout: true, portal: true },
    });

    const checkout = await routes(new Request('http://localhost:5173/v1/billing/checkout', {
      method: 'POST',
      body: JSON.stringify({ planId: 'team', organizationId: 'attacker', customerId: 'cus_attacker' }),
    }));
    expect(checkout?.status).toBe(200);
    expect(await json(checkout!)).toMatchObject({ session: { provider: 'local', mode: 'test' } });

    const state = await runtime.service['repository'].read('org-runtime');
    expect(state.customer?.provider).toBe('local');
    expect(state.customer?.customerId).toMatch(/^local_cus_/u);

    const portal = await routes(new Request('http://localhost:5173/v1/billing/portal', { method: 'POST', body: '{}' }));
    expect(portal?.status).toBe(200);
    expect(await json(portal!)).toMatchObject({ session: { provider: 'local', mode: 'test' } });

    const event = createTestSubscriptionEvent({
      eventId: 'evt_runtime_subscription',
      organizationId: principal.organizationId,
      customerId: state.customer!.customerId,
      subscriptionId: 'sub_runtime_subscription',
      priceId: 'price_team_runtime',
    });
    const signature = await signWebhookPayload(event, SECRET);
    const webhook = await routes(new Request('http://localhost:5173/v1/billing/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': signature },
      body: event,
    }));
    expect(webhook?.status).toBe(200);
    expect(await json(webhook!)).toMatchObject({ received: true, status: 'applied', organizationId: principal.organizationId });

    const final = await routes(new Request('http://localhost:5173/v1/billing'));
    expect(await json(final!)).toMatchObject({
      organizationId: principal.organizationId,
      readiness: 'test',
      entitlement: { planId: 'team', state: 'active', customerId: state.customer!.customerId },
      invoices: { state: 'available', invoices: [] },
    });
  });

  it('keeps a requested live provider disabled when no durable PostgreSQL boundary exists', () => {
    const runtime = createBillingRuntime({
      PSKILLS_ENVIRONMENT: 'production',
      PSKILLS_BILLING_ENABLED: 'true',
      PSKILLS_BILLING_PROVIDER: 'stripe',
      STRIPE_SECRET_KEY: 'sk_live_fixture',
      PSKILLS_BILLING_PRICE_TEAM: 'price_team_runtime',
    }, undefined, 'https://private-skills.example');
    expect(runtime.service.status()).toMatchObject({
      enabled: false,
      provider: null,
      mode: 'disabled',
      checkout: false,
      portal: false,
      webhookVerification: false,
    });
  });

  it('supports an explicit providerless metered evaluation profile without opening payment routes', () => {
    const runtime = createBillingRuntime({
      PSKILLS_ENVIRONMENT: 'test',
      PSKILLS_BILLING_ENABLED: 'true',
      PSKILLS_BILLING_METERED_EVALUATION: 'true',
    }, {} as BillingPgPoolLike, 'http://localhost:5173');
    expect(runtime.service.status()).toMatchObject({
      enabled: true,
      provider: null,
      mode: 'test',
      checkout: false,
      portal: false,
      webhookVerification: false,
    });
  });

  it('keeps providerless finite usage enabled in hosted production with PostgreSQL', () => {
    const runtime = createBillingRuntime({
      PSKILLS_ENVIRONMENT: 'production',
      PSKILLS_BILLING_ENABLED: 'true',
      PSKILLS_BILLING_METERED_EVALUATION: 'true',
    }, {} as BillingPgPoolLike, 'https://private-skills.example');
    expect(runtime.service.status()).toMatchObject({
      enabled: true,
      usageEnforcement: true,
      providerReady: false,
      provider: null,
      mode: 'test',
      checkout: false,
      portal: false,
      webhookVerification: false,
    });
  });

  it('keeps providerless evaluation disabled without a durable PostgreSQL boundary', () => {
    const runtime = createBillingRuntime({
      PSKILLS_ENVIRONMENT: 'test',
      PSKILLS_BILLING_ENABLED: 'true',
      PSKILLS_BILLING_METERED_EVALUATION: 'true',
    }, undefined, 'http://localhost:5173');
    expect(runtime.service.status()).toMatchObject({ enabled: false, provider: null, mode: 'disabled' });
  });

  it('keeps local billing test-only and surfaces sanitized configuration failures', () => {
    const operatorError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const productionLocal = createBillingRuntime({
        PSKILLS_ENVIRONMENT: 'production',
        PSKILLS_BILLING_ENABLED: 'true',
        PSKILLS_BILLING_PROVIDER: 'local',
        PSKILLS_BILLING_LOCAL_TEST: 'true',
        PSKILLS_BILLING_PRICE_TEAM: 'price_team_runtime',
      }, {} as BillingPgPoolLike, 'https://private-skills.example');
      expect(productionLocal.service.status()).toMatchObject({ enabled: false, provider: null, mode: 'disabled' });

      const invalidProvider = createBillingRuntime({
        PSKILLS_ENVIRONMENT: 'production',
        PSKILLS_BILLING_ENABLED: 'true',
        PSKILLS_BILLING_PROVIDER: 'stripe',
        STRIPE_SECRET_KEY: 'not-a-stripe-secret',
        PSKILLS_BILLING_PRICE_TEAM: 'price_team_runtime',
      }, {} as BillingPgPoolLike, 'https://private-skills.example');
      expect(invalidProvider.service.status()).toMatchObject({ enabled: false, provider: null, mode: 'disabled' });
      const messages = operatorError.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
      expect(messages).toContain('Billing configuration disabled');
      expect(messages).toContain('local billing provider is test-only');
      expect(messages).toContain('provider configuration is unavailable or invalid');
      expect(messages).not.toContain('not-a-stripe-secret');
    } finally {
      operatorError.mockRestore();
    }
  });
});
