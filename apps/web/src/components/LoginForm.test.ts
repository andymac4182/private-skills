// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicProviderConfig } from '../lib/types'

const harness = vi.hoisted(() => ({
  navigate: vi.fn(async () => {}),
  signIn: vi.fn(async () => ({ organizationId: 'org-1', subject: 'user-1', roles: ['reader'] as const })),
}))

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => harness.navigate }))
vi.mock('../lib/auth', async () => {
  const actual = await vi.importActual<typeof import('../lib/auth')>('../lib/auth')
  return { ...actual, useAuth: () => ({ signIn: harness.signIn }) }
})

import { api } from '../lib/api'
import { LoginForm } from './LoginForm'

const providerConfig: PublicProviderConfig = {
  protocolVersion: 1,
  enabled: true,
  basePath: '/api/auth',
  providers: [
    { id: 'github', label: 'GitHub', kind: 'github', enabled: true, callbackPath: '/api/auth/callback/github' },
    { id: 'google', label: 'Google', kind: 'google', enabled: false, callbackPath: '/api/auth/callback/google' },
  ],
  organization: { enabled: true, roles: ['owner', 'admin', 'publisher', 'reader'], maxOrganizationsPerUser: 10, maxMembersPerOrganization: 100, maxInvitationsPerMember: 100 },
  invitations: { mode: 'copy-link', emailDelivery: 'disabled', requiresVerifiedEmail: true, allowedRoles: ['reader'] },
  bootstrap: { enabled: true, requiresExplicitOwnerClaim: true, implicitSocialTenantAdoption: false },
}

describe('LoginForm providers', () => {
  let root: Root | null = null

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.spyOn(api, 'health').mockResolvedValue({ ok: true, service: 'registry', version: 'test' })
    vi.spyOn(api, 'authProviders').mockResolvedValue(providerConfig)
    vi.spyOn(api, 'authSignIn').mockResolvedValue({ redirect: false })
    harness.navigate.mockClear()
    harness.signIn.mockClear()
  })

  afterEach(async () => {
    await act(async () => { root?.unmount() })
    root = null
    document.body.replaceChildren()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('renders configured providers and honest unavailable states while preserving token fallback', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => { root?.render(createElement(LoginForm, { returnTo: '/app/catalog?draft=draft-42' })) })
    await act(async () => {})

    expect(container.querySelector('button[aria-label="Continue with GitHub"]')).not.toBeNull()
    expect(container.textContent).toContain('Google')
    expect(container.textContent).toContain('Unavailable until configured by an administrator.')
    expect(container.querySelector('input[name="token"]')).not.toBeNull()

    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Continue with GitHub"]')?.click() })
    expect(api.authSignIn).toHaveBeenCalledWith('github', 'http://localhost:3000/app/catalog?draft=draft-42', '/api/auth')
    expect(harness.navigate).toHaveBeenCalledWith({ href: '/app/catalog?draft=draft-42' })
  })
})
