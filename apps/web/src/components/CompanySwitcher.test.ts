// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthSession } from '../lib/types'

const harness = vi.hoisted(() => ({
  navigate: vi.fn(async () => {}),
  switchOrganization: vi.fn(async () => {}),
  session: null as AuthSession | null,
}))

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => harness.navigate }))
vi.mock('../lib/auth', () => ({ useAuth: () => ({ session: harness.session, switchOrganization: harness.switchOrganization }) }))

import { CompanySwitcher } from './CompanySwitcher'

const firstOrganization = { id: 'org-1', name: 'Acme Skills', slug: 'acme-skills' }
const secondOrganization = { id: 'org-2', name: 'Beta Skills', slug: 'beta-skills' }
const session: AuthSession = {
  user: { id: 'user-1', email: 'owner@acme.test', name: 'Owner', emailVerified: true },
  sessionId: 'session-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-02T00:00:00.000Z',
  organizations: [
    { id: 'member-1', organizationId: firstOrganization.id, role: 'owner', organization: firstOrganization },
    { id: 'member-2', organizationId: secondOrganization.id, role: 'reader', organization: secondOrganization },
  ],
  activeOrganizationId: firstOrganization.id,
  activeOrganization: firstOrganization,
  activeMembership: { id: 'member-1', organizationId: firstOrganization.id, role: 'owner', organization: firstOrganization },
  needsOnboarding: false,
  authMethod: 'better-auth',
}

describe('CompanySwitcher', () => {
  let root: Root | null = null

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    harness.session = session
    harness.navigate.mockClear()
    harness.switchOrganization.mockReset().mockResolvedValue(undefined)
    sessionStorage.setItem('pskills.directory.topic', 'old-topic')
    sessionStorage.setItem('unrelated', 'keep-me')
  })

  afterEach(async () => {
    await act(async () => { root?.unmount() })
    root = null
    document.body.replaceChildren()
    sessionStorage.clear()
    vi.unstubAllGlobals()
  })

  it('uses the server-selected membership and clears tenant UI state before switching', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => { root?.render(createElement(CompanySwitcher)) })

    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Company"]')
    expect(select?.value).toBe('org-1')
    await act(async () => {
      if (!select) throw new Error('company switcher select was not rendered')
      select.value = 'org-2'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(sessionStorage.getItem('pskills.directory.topic')).toBeNull()
    expect(sessionStorage.getItem('unrelated')).toBe('keep-me')
    expect(harness.switchOrganization).toHaveBeenCalledWith('org-2')
    expect(harness.navigate).toHaveBeenCalledWith({ to: '/app', search: {}, replace: true })
  })
})
