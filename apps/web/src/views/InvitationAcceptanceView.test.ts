// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthSession, IdentityMembership, OrganizationInvitation, OrganizationSummary } from '../lib/types'

const harness = vi.hoisted(() => ({
  navigate: vi.fn(async () => {}),
  auth: {
    session: null as AuthSession | null,
    status: 'signed-in' as 'loading' | 'signed-in' | 'signed-out',
    refresh: vi.fn(async () => null),
  },
}))

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => harness.navigate }))
vi.mock('../lib/auth', async () => {
  const actual = await vi.importActual<typeof import('../lib/auth')>('../lib/auth')
  return { ...actual, useAuth: () => harness.auth }
})

import { api, ApiError } from '../lib/api'
import { InvitationAcceptanceView } from './InvitationAcceptanceView'

const organization: OrganizationSummary = { id: 'org-1', name: 'Acme Skills', slug: 'acme-skills' }
const membership: IdentityMembership = { id: 'member-1', organizationId: organization.id, role: 'owner', organization }
const session: AuthSession = {
  user: { id: 'user-1', email: 'new@acme.test', name: 'New teammate', emailVerified: true },
  sessionId: 'session-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-02T00:00:00.000Z',
  organizations: [membership],
  activeOrganizationId: organization.id,
  activeOrganization: organization,
  activeMembership: membership,
  needsOnboarding: false,
  authMethod: 'better-auth',
}

async function renderView(invitationId?: string): Promise<{ root: Root; container: HTMLDivElement }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => { root.render(createElement(InvitationAcceptanceView, { invitationId })) })
  return { root, container }
}

async function flushEffects(): Promise<void> {
  await act(async () => {})
}

describe('InvitationAcceptanceView', () => {
  let root: Root | null = null

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    harness.navigate.mockClear()
    harness.auth.session = session
    harness.auth.status = 'signed-in'
    harness.auth.refresh.mockReset().mockResolvedValue(null)
  })

  afterEach(async () => {
    await act(async () => { root?.unmount() })
    root = null
    document.body.replaceChildren()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('sends signed-out invitees to login with a safe invitation return path', async () => {
    harness.auth.session = null
    harness.auth.status = 'signed-out'
    root = (await renderView('invite/1')).root
    await flushEffects()

    expect(harness.navigate).toHaveBeenCalledWith({
      to: '/login',
      search: { returnTo: '/organization/accept-invitation?id=invite%2F1' },
      replace: true,
    })
    expect(document.body.textContent).toContain('Taking you to secure company sign-in')
  })

  it('loads the server-bound invitation and refreshes the session after acceptance', async () => {
    const invitation: OrganizationInvitation = {
      id: 'invite-1',
      email: 'new@acme.test',
      role: 'reader',
      organizationId: organization.id,
      organizationName: organization.name,
      organizationSlug: organization.slug,
      status: 'pending',
      expiresAt: '2030-01-02T00:00:00.000Z',
    }
    const getInvitation = vi.spyOn(api, 'getOrganizationInvitation').mockResolvedValue(invitation)
    const acceptInvitation = vi.spyOn(api, 'acceptOrganizationInvitation').mockResolvedValue({
      invitation,
      member: { id: 'member-2', userId: session.user.id, role: 'reader', status: 'active' },
    })
    root = (await renderView('invite-1')).root
    await vi.waitFor(() => expect(document.body.textContent).toContain('Join Acme Skills'))
    expect(getInvitation).toHaveBeenCalledWith('invite-1')
    expect(document.body.textContent).toContain('new@acme.test')

    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent === 'Accept invitation')
    await act(async () => { button?.click() })
    await vi.waitFor(() => expect(acceptInvitation).toHaveBeenCalledWith('invite-1'))

    expect(harness.auth.refresh).toHaveBeenCalledOnce()
    expect(harness.navigate).toHaveBeenCalledWith({ to: '/app', search: {}, replace: true })
  })

  it.each([
    [new ApiError(403, { code: 'YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION', message: 'You are not the recipient of the invitation' }), 'different email address'],
    [new ApiError(400, { message: 'Invitation not found!' }), 'expired or is no longer available'],
    [new ApiError(403, { code: 'INVITATION_EMAIL_UNVERIFIED', message: 'A verified session for the invited email is required' }), 'Verify the invited email address'],
  ])('explains a Better Auth invitation failure (%s)', async (cause, expected) => {
    vi.spyOn(api, 'getOrganizationInvitation').mockRejectedValue(cause)
    root = (await renderView('invite-1')).root

    await vi.waitFor(() => expect(document.body.textContent).toContain(expected))
    expect(document.querySelector('[role="alert"]')).not.toBeNull()
  })

  it('does not call the identity API for an invalid invitation link', async () => {
    const getInvitation = vi.spyOn(api, 'getOrganizationInvitation')
    root = (await renderView('\u0000')).root
    await flushEffects()

    expect(document.body.textContent).toContain('Invalid invitation link')
    expect(getInvitation).not.toHaveBeenCalled()
    expect(harness.navigate).not.toHaveBeenCalled()
  })
})
