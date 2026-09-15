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

import { SsoSettingsView } from './SsoSettingsView'

const organization = { id: 'org/acme', name: 'Acme Skills', slug: 'acme-skills' }
const membership = { id: 'membership-1', organizationId: organization.id, role: 'owner' as const, organization }
const user = { id: 'user-1', email: 'owner@acme.test', name: 'Acme Owner', emailVerified: true }

function makeSession(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    user,
    sessionId: 'session-1',
    createdAt: '2026-09-14T00:00:00.000Z',
    expiresAt: '2026-09-15T00:00:00.000Z',
    organizations: [membership],
    activeOrganizationId: organization.id,
    activeOrganization: organization,
    activeMembership: membership,
    needsOnboarding: false,
    authMethod: 'better-auth',
    ...overrides,
  }
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const provider = {
  id: 'sso-1',
  organizationId: organization.id,
  providerId: 'okta',
  displayName: 'Acme Okta',
  protocol: 'oidc' as const,
  issuer: 'https://idp.example.com',
  callbackUrl: 'https://registry.example.com/api/auth/sso/callback/okta',
  status: 'active' as const,
  hasClientSecret: true,
  hasSigningCertificate: false,
  revision: 4,
  createdAt: '2026-09-14T00:00:00.000Z',
  updatedAt: '2026-09-14T00:00:00.000Z',
}

async function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
    setter?.call(element, value)
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve()
  })
}

describe('SsoSettingsView', () => {
  let root: Root | null = null

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    harness.auth.principal = null
    harness.auth.session = makeSession()
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
    await act(async () => { root?.render(createElement(SsoSettingsView)) })
    await flushEffects()
    return container
  }

  it('shows a truthful disabled state when the company SSO route is unavailable', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ code: 'NOT_FOUND', message: 'Route not found' }, 404))
    vi.stubGlobal('fetch', fetchMock)

    const container = await renderView()

    expect(container.textContent).toContain('Company SSO settings are not available on this deployment yet.')
    expect(container.textContent).toContain('Provider configuration is disabled')
    expect(container.querySelector('fieldset')?.hasAttribute('disabled')).toBe(true)
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('renders server-owned provider metadata without exposing configuration material', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ providers: [provider] }))
    vi.stubGlobal('fetch', fetchMock)

    const container = await renderView()

    expect(container.textContent).toContain('Acme Okta')
    expect(container.textContent).toContain('Client secret stored')
    expect(container.textContent).toContain('No signing certificate stored')
    expect(container.textContent).toContain(provider.callbackUrl)
    expect(container.textContent).not.toContain('top-secret-client-value')
    expect(container.textContent).not.toContain('<EntityDescriptor')
    const [path] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/v1/companies/org%2Facme/sso/providers')
  })

  it('posts an OIDC provider without client-controlled callback or company selectors', async () => {
    const created = { ...provider, id: 'sso-2', providerId: 'entra', displayName: 'Microsoft Entra', revision: 1 }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ providers: [] }))
      .mockResolvedValueOnce(response({ provider: created }, 201))
      .mockResolvedValueOnce(response({ providers: [created] }))
    vi.stubGlobal('fetch', fetchMock)
    const container = await renderView()

    await setNativeValue(container.querySelector<HTMLInputElement>('input[name="providerId"]')!, 'entra')
    await setNativeValue(container.querySelector<HTMLInputElement>('input[name="displayName"]')!, 'Microsoft Entra')
    await setNativeValue(container.querySelector<HTMLInputElement>('input[name="issuer"]')!, 'https://login.example.com')
    await setNativeValue(container.querySelector<HTMLInputElement>('input[name="discoveryUrl"]')!, 'https://login.example.com/.well-known/openid-configuration')
    await setNativeValue(container.querySelector<HTMLInputElement>('input[name="clientId"]')!, 'client-id')
    await setNativeValue(container.querySelector<HTMLInputElement>('input[name="clientSecret"]')!, 'top-secret-client-value')
    await act(async () => { container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    await flushEffects()

    const [path, init] = fetchMock.mock.calls[1] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(path).toBe('/v1/companies/org%2Facme/sso/providers')
    expect(init.method).toBe('POST')
    expect(body).toMatchObject({ providerId: 'entra', displayName: 'Microsoft Entra', protocol: 'oidc', issuer: 'https://login.example.com', status: 'active' })
    expect(body).not.toHaveProperty('callbackUrl')
    expect(body).not.toHaveProperty('organizationId')
    expect(body).not.toHaveProperty('domain')
    expect(body.oidc).toEqual({ clientId: 'client-id', clientSecret: 'top-secret-client-value', discoveryUrl: 'https://login.example.com/.well-known/openid-configuration' })
    expect(container.querySelector<HTMLInputElement>('input[name="clientSecret"]')?.value).toBe('')
    expect(container.textContent).not.toContain('top-secret-client-value')
    expect(container.textContent).toContain('Microsoft Entra')
  })

  it('posts SAML metadata as server-bound configuration and requires signed assertions', async () => {
    const created = { ...provider, id: 'sso-3', providerId: 'workforce-saml', displayName: 'Workforce SAML', protocol: 'saml' as const, hasClientSecret: false, hasSigningCertificate: true, revision: 1 }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ providers: [] }))
      .mockResolvedValueOnce(response({ provider: created }, 201))
      .mockResolvedValueOnce(response({ providers: [created] }))
    vi.stubGlobal('fetch', fetchMock)
    const container = await renderView()

    await setNativeValue(container.querySelector<HTMLSelectElement>('select[name="protocol"]')!, 'saml')
    await setNativeValue(container.querySelector<HTMLInputElement>('input[name="providerId"]')!, 'workforce-saml')
    await setNativeValue(container.querySelector<HTMLInputElement>('input[name="displayName"]')!, 'Workforce SAML')
    await setNativeValue(container.querySelector<HTMLInputElement>('input[name="issuer"]')!, 'https://idp.example.com/entity')
    await setNativeValue(container.querySelector<HTMLInputElement>('input[name="entryPoint"]')!, 'https://idp.example.com/sso')
    await setNativeValue(container.querySelector<HTMLTextAreaElement>('textarea[name="samlMetadata"]')!, '<EntityDescriptor><X509Certificate>certificate</X509Certificate></EntityDescriptor>')
    await act(async () => { container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    await flushEffects()

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as Record<string, any>
    expect(body.protocol).toBe('saml')
    expect(body.saml).toEqual({
      entryPoint: 'https://idp.example.com/sso',
      idpMetadata: { metadata: '<EntityDescriptor><X509Certificate>certificate</X509Certificate></EntityDescriptor>' },
      wantAssertionsSigned: true,
    })
    expect(body).not.toHaveProperty('callbackUrl')
    expect(container.textContent).toContain('Workforce SAML')
  })

  it('does not call the company API for a reader or for an unselected identity company', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ providers: [] }))
    vi.stubGlobal('fetch', fetchMock)
    harness.auth.session = makeSession({ activeOrganizationId: null, activeOrganization: null, activeMembership: null })

    const container = await renderView()

    expect(container.textContent).toContain('Choose an active company before managing company sign-in.')
    expect(fetchMock).not.toHaveBeenCalled()

    harness.auth.session = makeSession({ activeMembership: { ...membership, role: 'reader' } })
    await act(async () => { root?.render(createElement(SsoSettingsView)) })
    await flushEffects()
    expect(container.textContent).toContain('Owner or admin access is required')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
