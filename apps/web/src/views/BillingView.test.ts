// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BillingConsoleViewData } from './BillingView'

const harness = vi.hoisted(() => ({
  principal: { organizationId: 'org-console', subject: 'owner@console.test', roles: ['owner'] as Array<'owner' | 'admin' | 'publisher' | 'reader'> },
  session: null as unknown,
}))

vi.mock('../lib/auth', () => ({ useAuth: () => ({ principal: harness.principal, session: harness.session }) }))

import { BillingView } from './BillingView'

const limits = { seats: 10, storageBytes: 1_073_741_824, scansPerMonth: 100, eveCostCentsPerMonth: 5_000 }
const usage = { seats: 2, storageBytes: 12_288, scans: 3, eveCostCents: 75 }
const entitlement = { protocolVersion: 1 as const, organizationId: 'org-console', planId: 'team', limits, state: 'active' as const, source: 'verified-webhook' as const, reason: 'active-subscription', currentPeriodEnd: '2026-10-15T00:00:00.000Z' }

function fixture(overrides: Partial<BillingConsoleViewData> = {}): BillingConsoleViewData {
  return {
    protocolVersion: 1,
    organizationId: 'org-console',
    status: { enabled: true, providerReady: true, usageEnforcement: true, provider: 'local', mode: 'test', webhookVerification: true, checkout: true, portal: true },
    readiness: 'test',
    plans: [
      { id: 'free', label: 'Free', description: 'Free plan', limits, priceConfigured: false, checkoutAvailable: false },
      { id: 'team', label: 'Team', description: 'Team plan', limits, priceConfigured: true, checkoutAvailable: true },
    ],
    entitlement,
    usage: { limits, usage, entitlement },
    invoices: { state: 'available', invoices: [{ invoiceId: 'in_console_1', number: 'INV-1', status: 'paid', amountPaidCents: 1_990, currency: 'usd', createdAt: '2026-09-14T00:00:00.000Z', hostedInvoiceUrl: 'http://localhost:5173/invoices/in_console_1' }] },
    actions: { checkout: true, portal: true },
    ...overrides,
  }
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

async function flushEffects(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('BillingView', () => {
  let root: Root | null = null

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    harness.principal = { organizationId: 'org-console', subject: 'owner@console.test', roles: ['owner'] }
    harness.session = null
  })

  afterEach(async () => {
    await act(async () => { root?.unmount() })
    root = null
    document.body.replaceChildren()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('renders test-mode plan, enforced usage, invoice history, and tenant-safe checkout', async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, init })
      if (init?.method === 'POST' && String(input) === '/v1/billing/portal') return response({ protocolVersion: 1, session: { provider: 'local', mode: 'test', id: 'bps_console', url: 'http://localhost:5173/billing/test-portal?session=bps_console' } })
      if (init?.method === 'POST') return response({ protocolVersion: 1, session: { provider: 'local', mode: 'test', id: 'cs_console', url: 'http://localhost:5173/billing/test-checkout?session=cs_console' } })
      return response(fixture())
    })
    vi.stubGlobal('fetch', fetcher)
    const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null)
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => { root!.render(createElement(BillingView, { fetcher })); await flushEffects() })

    expect(container.textContent).toContain('Test mode is active')
    expect(container.textContent).toContain('Team')
    expect(container.textContent).toContain('2 / 10')
    expect(container.textContent).toContain('INV-1')
    expect(container.textContent).toContain('most recent 100 invoices')
    const checkout = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Start checkout'))
    expect(checkout?.disabled).toBe(false)

    await act(async () => { checkout?.click(); await flushEffects() })
    const checkoutRequest = requests.find((entry) => entry.init?.method === 'POST')
    expect(checkoutRequest?.input).toBe('/v1/billing/checkout')
    expect(JSON.parse(String(checkoutRequest?.init?.body))).toEqual({ planId: 'team' })
    expect(JSON.parse(String(checkoutRequest?.init?.body))).not.toHaveProperty('organizationId')
    expect(JSON.parse(String(checkoutRequest?.init?.body))).not.toHaveProperty('customerId')
    expect(windowOpen).toHaveBeenCalledWith('http://localhost:5173/billing/test-checkout?session=cs_console', '_blank', 'noopener,noreferrer')

    const portal = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Manage subscription'))
    await act(async () => { portal?.click(); await flushEffects() })
    const portalRequest = requests.find((entry) => String(entry.input) === '/v1/billing/portal')
    expect(JSON.parse(String(portalRequest?.init?.body))).toEqual({})
    expect(JSON.parse(String(portalRequest?.init?.body))).not.toHaveProperty('organizationId')
    expect(JSON.parse(String(portalRequest?.init?.body))).not.toHaveProperty('customerId')
    expect(windowOpen).toHaveBeenCalledWith('http://localhost:5173/billing/test-portal?session=bps_console', '_blank', 'noopener,noreferrer')
  })

  it('keeps actions disabled and states invoice unavailability truthfully when billing is disabled', async () => {
    const fetcher = vi.fn(async () => response(fixture({
      readiness: 'disabled',
      status: { enabled: false, providerReady: false, usageEnforcement: false, provider: null, mode: 'disabled', webhookVerification: false, checkout: false, portal: false },
      invoices: { state: 'disabled', invoices: [], message: 'Billing is disabled for this deployment.' },
      actions: { checkout: false, portal: false },
    })))
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => { root!.render(createElement(BillingView, { fetcher })); await flushEffects() })

    expect(container.textContent).toContain('Billing is disabled for this deployment')
    expect(container.textContent).toContain('Billing is disabled for this deployment.')
    expect([...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Start checkout'))?.disabled).toBe(true)
    expect([...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Manage subscription'))?.disabled).toBe(true)
  })

  it('keeps providerless usage and limits readable while payment actions stay unavailable', async () => {
    const fetcher = vi.fn(async () => response(fixture({
      readiness: 'unconfigured',
      status: { enabled: true, providerReady: false, usageEnforcement: true, provider: null, mode: 'test', webhookVerification: false, checkout: false, portal: false },
      entitlement: { ...entitlement, state: 'inactive', source: 'no-subscription', reason: 'no-active-subscription' },
      invoices: { state: 'unconfigured', invoices: [], message: 'Usage limits remain available; invoice history is unavailable until hosted billing is configured.' },
      actions: { checkout: false, portal: false },
    })))
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => { root!.render(createElement(BillingView, { fetcher })); await flushEffects() })

    expect(container.textContent).toContain('Usage limits are enforced from the durable billing ledger')
    expect(container.textContent).toContain('No provider configured')
    expect(container.textContent).toContain('2 / 10')
    expect(container.textContent).toContain('invoice history is unavailable until hosted billing is configured')
    expect([...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Start checkout'))?.disabled).toBe(true)
    expect([...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Manage subscription'))?.disabled).toBe(true)
  })
})
