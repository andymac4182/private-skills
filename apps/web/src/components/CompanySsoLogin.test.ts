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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve })
  return { promise, resolve }
}

function inputValue(element: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

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
    expect(container.textContent).toContain('Ask your administrator for your company identifier.')
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

  it('clears providers on edit and ignores an out-of-order lookup for the prior company', async () => {
    const acme = deferred<{ organizationId: string; providers: Array<{ providerId: string; displayName: string; protocol: 'oidc' | 'saml' }> }>()
    const globex = deferred<{ organizationId: string; providers: Array<{ providerId: string; displayName: string; protocol: 'oidc' | 'saml' }> }>()
    sso.listCompanySsoLoginProviders.mockImplementation((organizationId: string) => organizationId === 'acme' ? acme.promise : globex.promise)
    sso.startCompanySsoLogin.mockResolvedValue({ redirect: true, url: 'https://idp.example/authorize' })
    const redirect = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => { root?.render(createElement(CompanySsoLogin, { initialOrganizationId: 'acme', redirect })) })

    const input = container.querySelector<HTMLInputElement>('input[name="companySsoOrganizationId"]')
    const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]')
    expect(input).not.toBeNull()
    expect(submit).not.toBeNull()
    await act(async () => { submit?.click() })
    expect(sso.listCompanySsoLoginProviders).toHaveBeenCalledWith('acme')

    await act(async () => { inputValue(input!, 'globex') })
    expect(container.querySelector('[aria-label="Company identity providers"]')).toBeNull()

    await act(async () => { submit?.click() })
    expect(sso.listCompanySsoLoginProviders).toHaveBeenCalledWith('globex')
    await act(async () => {
      globex.resolve({ organizationId: 'globex', providers: [{ providerId: 'globex-oidc', displayName: 'Globex Identity', protocol: 'oidc' }] })
      await globex.promise
    })
    expect(container.querySelector('button[aria-label="Continue with Globex Identity"]')).not.toBeNull()

    await act(async () => {
      acme.resolve({ organizationId: 'acme', providers: [{ providerId: 'acme-oidc', displayName: 'Acme Identity', protocol: 'oidc' }] })
      await acme.promise
    })
    expect(container.querySelector('button[aria-label="Continue with Acme Identity"]')).toBeNull()
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Continue with Globex Identity"]')?.click() })
    expect(sso.startCompanySsoLogin).toHaveBeenCalledWith('globex', 'globex-oidc', '/app')
    expect(redirect).toHaveBeenCalledWith('https://idp.example/authorize')
  })
})
