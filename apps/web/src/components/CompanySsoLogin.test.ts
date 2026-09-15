// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sso = vi.hoisted(() => ({
  listCompanySsoLoginProviders: vi.fn(),
  startCompanySsoLogin: vi.fn(),
}))

vi.mock('../lib/companySso', () => ({
  ...sso,
  companySsoErrorMessage: (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback,
  isCompanySsoUnavailableError: () => false,
}))

import { CompanySsoLogin } from './CompanySsoLogin'

describe('CompanySsoLogin', () => {
  let root: Root | null = null

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    sso.listCompanySsoLoginProviders.mockReset()
    sso.startCompanySsoLogin.mockReset()
  })

  afterEach(async () => {
    await act(async () => { root?.unmount() })
    root = null
    document.body.replaceChildren()
    vi.unstubAllGlobals()
  })

  it('requires an explicit company identifier and lists only the providers returned for it', async () => {
    sso.listCompanySsoLoginProviders.mockResolvedValue({
      organizationId: 'acme',
      providers: [{ providerId: 'acme-oidc', displayName: 'Acme Identity', protocol: 'oidc' }],
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => { root?.render(createElement(CompanySsoLogin, { initialOrganizationId: 'acme' })) })

    expect(container.querySelector('input[name="companySsoOrganizationId"]')).not.toBeNull()
    expect(container.textContent).toContain('does not infer access from an email domain')
    await act(async () => { container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click() })

    expect(sso.listCompanySsoLoginProviders).toHaveBeenCalledWith('acme')
    expect(container.querySelector('button[aria-label="Continue with Acme Identity"]')).not.toBeNull()
    expect(container.textContent).toContain('OIDC')
  })

  it('starts the selected provider with the validated return path', async () => {
    sso.listCompanySsoLoginProviders.mockResolvedValue({
      organizationId: 'acme',
      providers: [{ providerId: 'acme-saml', displayName: 'Acme SAML', protocol: 'saml' }],
    })
    sso.startCompanySsoLogin.mockResolvedValue({ redirect: true, url: 'https://idp.example/authorize' })
    const redirect = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => { root?.render(createElement(CompanySsoLogin, {
      initialOrganizationId: 'acme', returnTo: '/organization/accept-invitation?id=invite-1', redirect,
    })) })
    await act(async () => { container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click() })
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Continue with Acme SAML"]')?.click() })

    expect(sso.startCompanySsoLogin).toHaveBeenCalledWith('acme', 'acme-saml', '/organization/accept-invitation?id=invite-1')
    expect(redirect).toHaveBeenCalledWith('https://idp.example/authorize')
  })

  it('reports a missing company id without making a discovery request', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => { root?.render(createElement(CompanySsoLogin)) })
    await act(async () => { container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click() })

    expect(sso.listCompanySsoLoginProviders).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Enter the company identifier provided by your administrator.')
  })
})
