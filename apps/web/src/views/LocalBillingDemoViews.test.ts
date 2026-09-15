// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  auth: { status: 'signed-in' as 'loading' | 'signed-in' | 'signed-out' },
}))

vi.mock('../lib/auth', () => ({ useAuth: () => harness.auth }))

import { LocalBillingCheckoutView, LocalBillingPortalView } from './LocalBillingDemoViews'

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const checkoutSession = {
  provider: 'local' as const,
  mode: 'test' as const,
  kind: 'checkout' as const,
  id: 'cs_demo',
  status: 'open' as const,
  planId: 'team',
  planLabel: 'Team',
  returnUrl: 'http://127.0.0.1:5305/app/billing?billing=success',
  cancelUrl: 'http://127.0.0.1:5305/app/billing?billing=cancelled',
}

const portalSession = {
  provider: 'local' as const,
  mode: 'test' as const,
  kind: 'portal' as const,
  id: 'bps_demo',
  status: 'open' as const,
  returnUrl: 'http://127.0.0.1:5305/app/billing',
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve()
  })
}

describe('local billing demo views', () => {
  let root: Root | null = null

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    harness.auth.status = 'signed-in'
  })

  afterEach(async () => {
    await act(async () => { root?.unmount() })
    root = null
    document.body.replaceChildren()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('completes only through the signed local fixture response and offers the billing return', async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, init })
      if (init?.method === 'POST') return response({ protocolVersion: 1, completed: true, webhookStatus: 'applied', session: { ...checkoutSession, status: 'completed' } })
      return response({ protocolVersion: 1, session: checkoutSession })
    }) as unknown as typeof fetch
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => { root?.render(createElement(LocalBillingCheckoutView, { sessionId: 'cs_demo', fetcher })) })
    await flushEffects()

    expect(container.textContent).toContain('Local test billing')
    expect(container.textContent).toContain('Test checkout')
    expect(container.textContent).toContain('does not contact Stripe')
    const complete = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Complete test checkout'))
    expect(complete?.disabled).toBe(false)

    await act(async () => { complete?.click(); await flushEffects() })

    expect(requests.some((request) => request.input === '/v1/billing/test-checkout/complete' && request.init?.method === 'POST')).toBe(true)
    const completion = requests.find((request) => request.init?.method === 'POST')
    expect(JSON.parse(String(completion?.init?.body))).toEqual({ session: 'cs_demo' })
    expect(container.textContent).toContain('signed fixture webhook was accepted')
    expect(container.querySelector<HTMLAnchorElement>('a[href="http://127.0.0.1:5305/app/billing?billing=success"]')).not.toBeNull()
  })

  it('renders the local portal handoff and keeps provider management unavailable in test mode', async () => {
    const fetcher = vi.fn(async () => response({ protocolVersion: 1, session: portalSession })) as unknown as typeof fetch
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => { root?.render(createElement(LocalBillingPortalView, { sessionId: 'bps_demo', fetcher })) })
    await flushEffects()

    expect(container.textContent).toContain('Test subscription portal')
    expect(container.textContent).toContain('No provider customer portal is opened in this test mode')
    expect(container.querySelector<HTMLAnchorElement>('a[href="http://127.0.0.1:5305/app/billing"]')).not.toBeNull()
  })
})
