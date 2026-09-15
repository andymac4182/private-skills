// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from './api'
import { AuthProvider, useAuth } from './auth'
import type { AuthSession, Principal, PublicProviderConfig } from './types'

const organization = { id: 'org-1', name: 'Acme Skills', slug: 'acme-skills' }
const membership = { id: 'member-1', organizationId: organization.id, role: 'owner' as const, organization }
const identitySession: AuthSession = {
  user: { id: 'user-1', email: 'owner@acme.test', name: 'Owner', emailVerified: true },
  sessionId: 'identity-session-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-02T00:00:00.000Z',
  organizations: [membership],
  activeOrganizationId: organization.id,
  activeOrganization: organization,
  activeMembership: membership,
  needsOnboarding: false,
  authMethod: 'better-auth',
}
const legacyPrincipal: Principal = { organizationId: organization.id, subject: 'legacy-owner', roles: ['owner'] }
const providerConfig: PublicProviderConfig = {
  protocolVersion: 1,
  enabled: true,
  basePath: '/identity/api/auth',
  providers: [],
  organization: { enabled: true, roles: ['owner', 'admin', 'publisher', 'reader'], maxOrganizationsPerUser: 3, maxMembersPerOrganization: 50, maxInvitationsPerMember: 5 },
  invitations: { mode: 'copy-link', emailDelivery: 'disabled', requiresVerifiedEmail: true, allowedRoles: ['reader'] },
  bootstrap: { enabled: true, requiresExplicitOwnerClaim: true, implicitSocialTenantAdoption: false },
}

function AuthProbe() {
  const { error, session, signOut, status } = useAuth()
  return createElement('div', null,
    createElement('span', { 'data-testid': 'status' }, status),
    createElement('span', { 'data-testid': 'session' }, session?.sessionId ?? ''),
    createElement('span', { 'data-testid': 'error' }, error ?? ''),
    createElement('button', { type: 'button', onClick: () => { void signOut().catch(() => undefined) } }, 'Sign out'),
  )
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
}

describe('AuthProvider sign-out', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  })

  afterEach(async () => {
    await act(async () => { root?.unmount() })
    root = null
    container = null
    document.body.replaceChildren()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  async function renderAuth(): Promise<HTMLDivElement> {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(createElement(AuthProvider, null, createElement(AuthProbe)))
    })
    await act(async () => { await flushMicrotasks() })
    return container
  }

  function setup(initialSession: AuthSession | null) {
    const authSession = vi.spyOn(api, 'authSession').mockResolvedValue(initialSession)
    const me = vi.spyOn(api, 'me').mockResolvedValue(legacyPrincipal)
    const authProviders = vi.spyOn(api, 'authProviders').mockResolvedValue(providerConfig)
    const authSignOut = vi.spyOn(api, 'authSignOut').mockResolvedValue(undefined)
    const signOut = vi.spyOn(api, 'signOut').mockResolvedValue(undefined)
    return { authSession, me, authProviders, authSignOut, signOut }
  }

  it('logs out Better Auth through the configured base path and clears local state after success', async () => {
    const spies = setup(identitySession)
    const view = await renderAuth()

    expect(view.querySelector('[data-testid="status"]')?.textContent).toBe('signed-in')
    await act(async () => {
      view.querySelector<HTMLButtonElement>('button')?.click()
      await flushMicrotasks()
    })

    expect(spies.authSession).toHaveBeenCalledOnce()
    expect(spies.authProviders).toHaveBeenCalledOnce()
    expect(spies.authSignOut).toHaveBeenCalledWith(providerConfig.basePath)
    expect(spies.signOut).toHaveBeenCalledOnce()
    expect(view.querySelector('[data-testid="status"]')?.textContent).toBe('signed-out')
    expect(view.querySelector('[data-testid="session"]')?.textContent).toBe('')
    expect(view.querySelector('[data-testid="error"]')?.textContent).toBe('')
  })

  it('keeps the identity session when the server logout fails and exposes the error', async () => {
    const spies = setup(identitySession)
    spies.authSignOut.mockRejectedValue(new ApiError(503, { message: 'Identity logout unavailable' }))
    const view = await renderAuth()

    await act(async () => {
      view.querySelector<HTMLButtonElement>('button')?.click()
      await flushMicrotasks()
    })

    expect(spies.authSignOut).toHaveBeenCalledWith(providerConfig.basePath)
    expect(spies.signOut).toHaveBeenCalledOnce()
    expect(view.querySelector('[data-testid="status"]')?.textContent).toBe('signed-in')
    expect(view.querySelector('[data-testid="session"]')?.textContent).toBe(identitySession.sessionId)
    expect(view.querySelector('[data-testid="error"]')?.textContent).toBe('Identity logout unavailable')
  })

  it('keeps the legacy logout route for token sessions', async () => {
    const spies = setup(null)
    const view = await renderAuth()

    await act(async () => {
      view.querySelector<HTMLButtonElement>('button')?.click()
      await flushMicrotasks()
    })

    expect(spies.signOut).toHaveBeenCalledOnce()
    expect(spies.authProviders).not.toHaveBeenCalled()
    expect(spies.authSignOut).not.toHaveBeenCalled()
    expect(view.querySelector('[data-testid="status"]')?.textContent).toBe('signed-out')
  })
})
