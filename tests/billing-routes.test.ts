import { describe, expect, it } from 'vitest'
import {
  BillingService,
  createMemoryBillingRepository,
  createLocalBillingAdapter,
  createPlanCatalog,
  createTestSubscriptionEvent,
  signWebhookPayload,
  type BillingProvider,
  type HostedBillingSession,
  type ProviderCustomer,
} from '../packages/billing/src/index.js'
import { BILLING_DEMO_ROUTE_PATHS, createBillingRoutes, type BillingInvoiceRecord } from '../apps/web/server/routes/billing.js'

const NOW = Date.parse('2026-09-15T00:00:00.000Z')
const NOW_SECONDS = Math.floor(NOW / 1_000)
const SECRET = 'whsec_console_route_test_secret'

function provider(calls: { customers: unknown[]; checkouts: unknown[]; portals: unknown[] }): BillingProvider {
  return {
    id: 'local',
    mode: 'test',
    async createCustomer(input): Promise<ProviderCustomer> {
      calls.customers.push(input)
      return { provider: 'local', customerId: `cus-${input.organizationId}` }
    },
    async createCheckoutSession(input): Promise<HostedBillingSession> {
      calls.checkouts.push(input)
      return { provider: 'local', mode: 'test', id: 'cs_console', url: 'http://localhost:5173/billing/test-checkout?session=cs_console' }
    },
    async createCustomerPortalSession(input): Promise<HostedBillingSession> {
      calls.portals.push(input)
      return { provider: 'local', mode: 'test', id: 'bps_console', url: 'http://localhost:5173/billing/test-portal?session=bps_console' }
    },
  }
}

function serviceWith(providerOverride?: BillingProvider, configured = true): BillingService {
  const calls = { customers: [], checkouts: [], portals: [] }
  return new BillingService({
    repository: createMemoryBillingRepository({ now: () => NOW }),
    catalog: configured ? createPlanCatalog({ priceIds: { team: 'price_team_console', business: 'price_business_console' } }) : createPlanCatalog(),
    provider: providerOverride ?? provider(calls),
    enabled: true,
    webhookSecret: SECRET,
    now: () => NOW,
    successUrl: 'https://private-skills.example/billing/success',
    cancelUrl: 'https://private-skills.example/billing/cancel',
    portalReturnUrl: 'https://private-skills.example/billing',
  })
}

function principal(organizationId = 'org-console', roles: Array<'owner' | 'admin' | 'reader'> = ['owner']) {
  return { organizationId, subject: `${roles[0]}@console.test`, roles }
}

function auth(value: ReturnType<typeof principal> | null) {
  return async () => value
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>
}

async function seedSubscription(service: BillingService, organizationId = 'org-console', customerId = 'cus-org-console') {
  const body = createTestSubscriptionEvent({
    eventId: `evt-${organizationId}`,
    created: NOW_SECONDS,
    organizationId,
    customerId,
    subscriptionId: `sub_${organizationId.replaceAll('-', '_')}`,
    priceId: 'price_team_console',
  })
  await service.handleWebhook(body, await signWebhookPayload(body, SECRET, NOW_SECONDS))
}

describe('company billing route factory', () => {
  it('serves a tenant-bound local checkout completion and portal return demo', async () => {
    const service = serviceWith(createLocalBillingAdapter({ baseUrl: 'https://private-skills.example' }))
    const routes = createBillingRoutes({ service, authenticate: auth(principal()) })

    const checkoutResponse = await routes(new Request('https://private-skills.example/v1/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planId: 'team' }),
    }))
    expect(checkoutResponse?.status).toBe(200)
    const checkout = await json(checkoutResponse!)
    const checkoutUrl = new URL((checkout.session as { url: string }).url)
    expect(checkoutUrl.pathname).toBe('/billing/test-checkout')
    const checkoutSessionId = checkoutUrl.searchParams.get('session')
    expect(checkoutSessionId).toBeTruthy()

    const checkoutPage = await routes(new Request(`https://private-skills.example${BILLING_DEMO_ROUTE_PATHS.checkout}?session=${encodeURIComponent(checkoutSessionId!)}`))
    expect(checkoutPage?.status).toBe(200)
    await expect(json(checkoutPage!)).resolves.toMatchObject({ session: { provider: 'local', mode: 'test', kind: 'checkout', planId: 'team', status: 'open' } })

    const completed = await routes(new Request(`https://private-skills.example${BILLING_DEMO_ROUTE_PATHS.checkoutComplete}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: checkoutSessionId }),
    }))
    expect(completed?.status).toBe(200)
    await expect(json(completed!)).resolves.toMatchObject({ completed: true, webhookStatus: 'applied', session: { status: 'completed', planId: 'team' } })
    await expect(service.entitlement('org-console')).resolves.toMatchObject({ planId: 'team', state: 'active', source: 'verified-webhook' })

    const retried = await routes(new Request(`https://private-skills.example${BILLING_DEMO_ROUTE_PATHS.checkoutComplete}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: checkoutSessionId }),
    }))
    await expect(json(retried!)).resolves.toMatchObject({ completed: true, webhookStatus: 'duplicate', session: { status: 'completed' } })

    const portalResponse = await routes(new Request('https://private-skills.example/v1/billing/portal', { method: 'POST', body: '{}' }))
    expect(portalResponse?.status).toBe(200)
    const portal = await json(portalResponse!)
    const portalUrl = new URL((portal.session as { url: string }).url)
    expect(portalUrl.pathname).toBe('/billing/test-portal')
    const portalSessionId = portalUrl.searchParams.get('session')
    expect(portalSessionId).toBeTruthy()
    const portalPage = await routes(new Request(`https://private-skills.example${BILLING_DEMO_ROUTE_PATHS.portal}?session=${encodeURIComponent(portalSessionId!)}`))
    expect(portalPage?.status).toBe(200)
    await expect(json(portalPage!)).resolves.toMatchObject({ session: { provider: 'local', mode: 'test', kind: 'portal', status: 'open' } })

    const readerRoutes = createBillingRoutes({ service, authenticate: auth(principal('org-console', ['reader'])) })
    const readerDemo = await readerRoutes(new Request(`https://private-skills.example${BILLING_DEMO_ROUTE_PATHS.checkout}?session=${encodeURIComponent(checkoutSessionId!)}`))
    expect(readerDemo?.status).toBe(403)
    const otherTenantRoutes = createBillingRoutes({ service, authenticate: auth(principal('org-other')) })
    const otherTenantDemo = await otherTenantRoutes(new Request(`https://private-skills.example${BILLING_DEMO_ROUTE_PATHS.checkout}?session=${encodeURIComponent(checkoutSessionId!)}`))
    expect(otherTenantDemo?.status).toBe(404)

    const stripeProvider = { ...provider({ customers: [], checkouts: [], portals: [] }), id: 'stripe' as const }
    const stripeService = serviceWith(stripeProvider)
    const stripeRoutes = createBillingRoutes({ service: stripeService, authenticate: auth(principal()) })
    const stripeDemo = await stripeRoutes(new Request(`https://private-skills.example${BILLING_DEMO_ROUTE_PATHS.checkout}?session=${encodeURIComponent(checkoutSessionId!)}`))
    expect(stripeDemo?.status).toBe(404)
  })

  it('keeps a local checkout open when its signed fixture event is stale', async () => {
    const adapter = createLocalBillingAdapter({ baseUrl: 'https://private-skills.example' })
    const service = serviceWith(adapter)
    const routes = createBillingRoutes({ service, authenticate: auth(principal()) })
    const checkoutResponse = await routes(new Request('https://private-skills.example/v1/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planId: 'team' }),
    }))
    const checkout = await json(checkoutResponse!)
    const checkoutSessionId = new URL((checkout.session as { url: string }).url).searchParams.get('session')!
    const customerId = adapter.getTestSession(checkoutSessionId)
    if (!customerId || customerId.kind !== 'checkout') throw new Error('local checkout fixture did not persist')
    const newerBody = createTestSubscriptionEvent({
      eventId: 'evt_newer_local_subscription',
      created: NOW_SECONDS + 1,
      organizationId: 'org-console',
      customerId: customerId.customerId,
      subscriptionId: 'sub_existing_local_subscription',
      priceId: 'price_business_console',
    })
    await expect(service.handleWebhook(newerBody, await signWebhookPayload(newerBody, SECRET, NOW_SECONDS + 1))).resolves.toMatchObject({ status: 'applied' })

    const completion = await routes(new Request(`https://private-skills.example${BILLING_DEMO_ROUTE_PATHS.checkoutComplete}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: checkoutSessionId }),
    }))
    expect(completion?.status).toBe(409)
    await expect(json(completion!)).resolves.toMatchObject({ code: 'BILLING_SESSION_NOT_COMPLETED' })
    const checkoutPage = await routes(new Request(`https://private-skills.example${BILLING_DEMO_ROUTE_PATHS.checkout}?session=${encodeURIComponent(checkoutSessionId)}`))
    await expect(json(checkoutPage!)).resolves.toMatchObject({ session: { status: 'open' } })
  })

  it('returns a tenant-bound console snapshot and verifies invoice customer mapping', async () => {
    const calls: { lookups: Array<{ organizationId: string; customerId: string }>; records: BillingInvoiceRecord[] } = {
      lookups: [],
      records: [{ provider: 'local', organizationId: 'org-console', customerId: 'cus-org-console', invoiceId: 'in_console_1', status: 'paid', amountPaidCents: 1_990, currency: 'USD', number: 'INV-1', createdAt: '2026-09-14T00:00:00.000Z', hostedInvoiceUrl: 'http://localhost:5173/invoices/in_console_1' }],
    }
    const service = serviceWith()
    await seedSubscription(service)
    const routes = createBillingRoutes({
      service,
      authenticate: auth(principal()),
      invoiceHistory: async (lookup) => {
        calls.lookups.push({ organizationId: lookup.organizationId, customerId: lookup.customerId })
        return calls.records
      },
    })

    const response = await routes(new Request('https://private-skills.example/v1/billing?organizationId=org-attacker'))
    expect(response?.status).toBe(200)
    const body = await json(response!)
    expect(body.organizationId).toBe('org-console')
    expect(body.readiness).toBe('test')
    expect(body.actions).toEqual({ checkout: true, portal: true })
    expect((body.invoices as { state: string }).state).toBe('available')
    expect(((body.invoices as { invoices: Array<Record<string, unknown>> }).invoices[0]).customerId).toBeUndefined()
    expect(calls.lookups).toEqual([{ organizationId: 'org-console', customerId: 'cus-org-console' }])
  })

  it('requires an owner or admin and ignores browser tenant/customer selectors', async () => {
    const calls = { customers: [] as unknown[], checkouts: [] as unknown[], portals: [] as unknown[] }
    const service = serviceWith(provider(calls))
    const readerRoutes = createBillingRoutes({ service, authenticate: auth(principal('org-console', ['reader'])) })
    const forbidden = await readerRoutes(new Request('https://private-skills.example/v1/billing'))
    expect(forbidden?.status).toBe(403)
    await expect(json(forbidden!)).resolves.toMatchObject({ code: 'BILLING_FORBIDDEN' })

    const routes = createBillingRoutes({ service, authenticate: auth(principal('org-console', ['admin'])) })
    const checkout = await routes(new Request('https://private-skills.example/v1/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId: 'org-attacker', customerId: 'cus-attacker', planId: 'team' }),
    }))
    expect(checkout?.status).toBe(200)
    expect(calls.customers[0]).toMatchObject({ organizationId: 'org-console' })
    expect(calls.checkouts[0]).toMatchObject({ organizationId: 'org-console', customerId: 'cus-org-console', planId: 'team' })
    expect(calls.checkouts[0]).not.toMatchObject({ customerId: 'cus-attacker' })

    const portal = await routes(new Request('https://private-skills.example/v1/billing/portal', { method: 'POST', body: '{}' }))
    expect(portal?.status).toBe(200)
    expect(calls.portals[0]).toMatchObject({ organizationId: 'org-console', customerId: 'cus-org-console' })
  })

  it('reports disabled and unconfigured states without opening payment actions', async () => {
    const disabled = new BillingService({ repository: createMemoryBillingRepository({ now: () => NOW }), enabled: false, now: () => NOW })
    const disabledRoutes = createBillingRoutes({ service: disabled, authenticate: auth(principal()) })
    const disabledResponse = await disabledRoutes(new Request('https://private-skills.example/v1/billing'))
    expect(await json(disabledResponse!)).toMatchObject({ readiness: 'disabled', actions: { checkout: false, portal: false }, invoices: { state: 'disabled' } })

    const unconfigured = serviceWith(undefined, false)
    const unconfiguredRoutes = createBillingRoutes({ service: unconfigured, authenticate: auth(principal('org-unconfigured')) })
    const unconfiguredResponse = await unconfiguredRoutes(new Request('https://private-skills.example/v1/billing'))
    expect(await json(unconfiguredResponse!)).toMatchObject({ readiness: 'unconfigured', actions: { checkout: false, portal: false }, invoices: { state: 'unconfigured' } })
    const action = await unconfiguredRoutes(new Request('https://private-skills.example/v1/billing/checkout', { method: 'POST', body: JSON.stringify({ planId: 'team' }) }))
    expect(action?.status).toBe(503)
    await expect(json(action!)).resolves.toMatchObject({ code: 'BILLING_UNAVAILABLE' })

    const missingCalls = { customers: [] as unknown[], checkouts: [] as unknown[], portals: [] as unknown[] }
    const missingWebhook = new BillingService({
      repository: createMemoryBillingRepository({ now: () => NOW }),
      catalog: createPlanCatalog({ priceIds: { team: 'price_team_console' } }),
      provider: provider(missingCalls),
      enabled: true,
      now: () => NOW,
      successUrl: 'https://private-skills.example/billing/success',
      cancelUrl: 'https://private-skills.example/billing/cancel',
      portalReturnUrl: 'https://private-skills.example/billing',
    })
    const missingWebhookRoutes = createBillingRoutes({ service: missingWebhook, authenticate: auth(principal('org-missing-webhook')) })
    await expect(json((await missingWebhookRoutes(new Request('https://private-skills.example/v1/billing')))!)).resolves.toMatchObject({ readiness: 'unconfigured', actions: { checkout: false, portal: false } })
    const missingWebhookAction = await missingWebhookRoutes(new Request('https://private-skills.example/v1/billing/checkout', { method: 'POST', body: JSON.stringify({ planId: 'team' }) }))
    await expect(json(missingWebhookAction!)).resolves.toMatchObject({ code: 'BILLING_UNAVAILABLE' })
    expect(missingCalls.customers).toHaveLength(0)
    expect(missingCalls.checkouts).toHaveLength(0)
  })

  it('serves providerless usage and limits while keeping hosted actions and invoices unavailable', async () => {
    const service = new BillingService({
      repository: createMemoryBillingRepository({ now: () => NOW }),
      enabled: true,
      usageEnabled: true,
      now: () => NOW,
    })
    const routes = createBillingRoutes({ service, authenticate: auth(principal('org-providerless')) })

    const response = await routes(new Request('https://private-skills.example/v1/billing'))
    expect(response?.status).toBe(200)
    const body = await json(response!)
    expect(body).toMatchObject({
      organizationId: 'org-providerless',
      readiness: 'unconfigured',
      status: { enabled: true, usageEnforcement: true, providerReady: false, provider: null, checkout: false, portal: false, webhookVerification: false },
      entitlement: { planId: 'free', state: 'inactive', reason: 'no-active-subscription' },
      usage: { limits: { seats: 3, scansPerMonth: 50 } },
      actions: { checkout: false, portal: false },
      invoices: { state: 'unconfigured' },
    })

    const checkout = await routes(new Request('https://private-skills.example/v1/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planId: 'team' }),
    }))
    expect(checkout?.status).toBe(503)
    await expect(json(checkout!)).resolves.toMatchObject({ code: 'BILLING_UNAVAILABLE' })
  })

  it('passes an actual signed webhook through the route and keeps it tenant-bound', async () => {
    const service = serviceWith()
    const routes = createBillingRoutes({ service, authenticate: auth(null) })
    const body = createTestSubscriptionEvent({ eventId: 'evt-webhook-route', created: NOW_SECONDS, organizationId: 'org-webhook-route', customerId: 'cus-webhook-route', subscriptionId: 'sub_webhook_route', priceId: 'price_business_console' })
    const response = await routes(new Request('https://private-skills.example/v1/billing/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': await signWebhookPayload(body, SECRET, NOW_SECONDS) },
      body,
    }))
    expect(response?.status).toBe(200)
    await expect(json(response!)).resolves.toMatchObject({ received: true, status: 'applied', organizationId: 'org-webhook-route' })
    await expect(service.entitlement('org-webhook-route')).resolves.toMatchObject({ planId: 'business', state: 'active' })
  })

  it('rejects provider invoice rows that cross the authenticated customer mapping', async () => {
    const service = serviceWith()
    await seedSubscription(service)
    const routes = createBillingRoutes({
      service,
      authenticate: auth(principal()),
      invoiceHistory: async () => [{ provider: 'local', organizationId: 'org-console', customerId: 'cus-other-company', invoiceId: 'in_wrong', status: 'paid', createdAt: '2026-09-14T00:00:00.000Z' }],
    })
    const response = await routes(new Request('https://private-skills.example/v1/billing'))
    expect(response?.status).toBe(409)
    await expect(json(response!)).resolves.toMatchObject({ code: 'INVOICE_MAPPING_CONFLICT' })
  })
})
