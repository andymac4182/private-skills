// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthSession, Principal } from '../lib/types'

const harness = vi.hoisted(() => ({
  auth: {
    principal: null as Principal | null,
    session: null as AuthSession | null,
  },
}))

vi.mock('../lib/auth', () => ({ useAuth: () => harness.auth }))

import { ApiTokensView } from './ApiTokensView'

const organization = { id: 'org/acme', name: 'Acme Skills', slug: 'acme-skills' }
const otherOrganization = { id: 'org/other', name: 'Other Skills', slug: 'other-skills' }
const user = { id: 'user-1', email: 'owner@acme.test', name: 'Acme Owner', emailVerified: true }

function makeSession(role: 'owner' | 'admin' | 'publisher' | 'reader' = 'owner', active = organization): AuthSession {
  const membership = { id: `membership-${active.id}`, organizationId: active.id, role, organization: active }
  return {
    user,
    sessionId: 'session-1',
    createdAt: '2026-09-14T00:00:00.000Z',
    expiresAt: '2099-09-15T00:00:00.000Z',
    organizations: [membership],
    activeOrganizationId: active.id,
    activeOrganization: active,
    activeMembership: membership,
    needsOnboarding: false,
    authMethod: 'better-auth',
  }
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const baseMetadata = {
  organizationId: organization.id,
  userId: 'user-1',
  name: 'Release bot',
  roleCeiling: 'reader' as const,
  scopes: ['skills:read'],
  expiresAt: '2099-01-01T00:00:00.000Z',
  createdAt: '2026-09-15T00:00:00.000Z',
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 7; index += 1) await Promise.resolve()
  })
}

async function setNativeValue(element: HTMLInputElement | HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
    setter?.call(element, value)
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}

describe('ApiTokensView', () => {
  let root: Root | null = null

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    harness.auth.principal = null
    harness.auth.session = makeSession()
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: undefined })
  })

  afterEach(async () => {
    await act(async () => { root?.unmount() })
    root = null
    document.body.replaceChildren()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  async function renderView(): Promise<HTMLDivElement> {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => { root?.render(createElement(ApiTokensView)) })
    await flushEffects()
    return container
  }

  it('creates a scoped expiring token and exposes its secret only in the one-time panel', async () => {
    const created = { id: 'st_new', ...baseMetadata, token: 'psk_one-time-secret-value' }
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST' ? response(created, 201) : response({ tokens: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText } })

    const container = await renderView()
    await setNativeValue(container.querySelector<HTMLInputElement>('input[name="tokenName"]')!, 'Release bot')
    await act(async () => { container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    await flushEffects()

    const postCall = fetchMock.mock.calls.find((call) => call[1]?.method === 'POST')
    expect(postCall).toBeDefined()
    expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({
      name: 'Release bot',
      roleCeiling: 'owner',
      scopes: expect.arrayContaining(['skills:read']),
      expiresInSeconds: 7_776_000,
    })
    expect(JSON.parse(String(postCall?.[1]?.body))).not.toHaveProperty('organizationId')
    expect(container.querySelector<HTMLInputElement>('input[aria-label="New CLI token secret"]')?.value).toBe(created.token)
    expect(container.textContent).toContain('it cannot be shown again')

    const copy = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Copy token')
    await act(async () => { copy?.click(); await flushEffects() })
    expect(writeText).toHaveBeenCalledWith(created.token)
    expect(container.textContent).toContain('Copied to clipboard')

    const hide = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Hide secret')
    await act(async () => { hide?.click() })
    expect(container.querySelector('input[aria-label="New CLI token secret"]')).toBeNull()
    expect(container.textContent).not.toContain(created.token)
  })

  it('offers a manual copy fallback and lists metadata without token material', async () => {
    const metadata = { id: 'st_existing', ...baseMetadata }
    const created = { id: 'st_new', ...baseMetadata, name: 'Manual copy', token: 'psk_manual-secret-value' }
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST' ? response(created, 201) : response({ tokens: [metadata] }))
    vi.stubGlobal('fetch', fetchMock)
    const container = await renderView()

    expect(container.textContent).toContain('Release bot')
    expect(container.textContent).toContain('skills:read')
    expect(container.textContent).not.toContain('tokenHash')
    expect(container.textContent).not.toContain('psk_')

    await setNativeValue(container.querySelector<HTMLInputElement>('input[name="tokenName"]')!, 'Manual copy')
    await act(async () => { container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    await flushEffects()
    const copy = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Copy token')
    await act(async () => { copy?.click(); await flushEffects() })
    expect(container.textContent).toContain('Select the token field above and copy it manually.')
  })

  it('lets administrators revoke listed member tokens and keeps member revoke access scoped', async () => {
    const other = { id: 'st_other', ...baseMetadata, userId: 'user-2', name: 'Other member' }
    const own = { id: 'st_own', ...baseMetadata, name: 'Own token' }
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === 'DELETE' ? response({ revoked: true, token: { ...other, revokedAt: '2026-09-15T01:00:00.000Z' } }) : response({ tokens: [other, own] }))
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const container = await renderView()

    expect([...container.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent === 'Revoke')).toHaveLength(2)
    const otherButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Revoke')
    await act(async () => { otherButton?.click(); await flushEffects() })
    expect(fetchMock.mock.calls.find((call) => call[1]?.method === 'DELETE')?.[0]).toBe('/v1/tokens/st_other')

    harness.auth.session = makeSession('reader')
    await act(async () => { root?.render(createElement(ApiTokensView)) })
    await flushEffects()
    const revokeButtons = [...container.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent === 'Revoke')
    expect(revokeButtons).toHaveLength(1)
    expect(container.textContent).toContain('Admin only')
  })

  it('shows an honest unavailable state and clears the one-time secret on company switch', async () => {
    const created = { id: 'st_new', ...baseMetadata, token: 'psk_switch-secret-value' }
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST' ? response(created, 201) : response({ tokens: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const container = await renderView()
    await setNativeValue(container.querySelector<HTMLInputElement>('input[name="tokenName"]')!, 'Switch test')
    await act(async () => { container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    await flushEffects()
    expect(container.querySelector('input[aria-label="New CLI token secret"]')).not.toBeNull()

    harness.auth.session = makeSession('owner', otherOrganization)
    await act(async () => { root?.render(createElement(ApiTokensView)) })
    await flushEffects()
    expect(container.querySelector('input[aria-label="New CLI token secret"]')).toBeNull()
    expect(container.textContent).toContain('Other Skills')
    expect(container.textContent).not.toContain(created.token)

    const unavailableFetch = vi.fn().mockResolvedValue(response({ code: 'NOT_FOUND', message: 'Route not found' }, 503))
    vi.stubGlobal('fetch', unavailableFetch)
    const refresh = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Refresh')
    await act(async () => { refresh?.click(); await flushEffects() })
    await flushEffects()
    expect(container.textContent).toContain('CLI token management is not available on this deployment yet.')
    expect(container.querySelector('fieldset')?.hasAttribute('disabled')).toBe(true)
  })
})
