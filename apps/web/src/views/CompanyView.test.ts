// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthSession, IdentityMembership, OrganizationInvitation, OrganizationSummary, TeamMember } from '../lib/types'

const harness = vi.hoisted(() => ({
  navigate: vi.fn(async () => {}),
  auth: {
    principal: null,
    session: null as AuthSession | null,
    refresh: vi.fn(async () => null),
    switchOrganization: vi.fn(async () => null as unknown as AuthSession),
  },
  clearTenantScopedClientState: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => harness.navigate }))
vi.mock('../lib/auth', () => ({ useAuth: () => harness.auth }))
vi.mock('../lib/tenant', () => ({ clearTenantScopedClientState: harness.clearTenantScopedClientState }))

import { api } from '../lib/api'
import { CompanyView } from './CompanyView'

const user = {
  id: 'user-1',
  email: 'owner@acme.test',
  name: 'Acme Owner',
  emailVerified: true,
}
const organization: OrganizationSummary = { id: 'org-1', name: 'Acme Skills', slug: 'acme-skills' }
const membership: IdentityMembership = { id: 'member-1', organizationId: organization.id, role: 'owner', organization }

function makeSession(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    user,
    sessionId: 'session-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-02T00:00:00.000Z',
    organizations: [membership],
    activeOrganizationId: organization.id,
    activeOrganization: organization,
    activeMembership: membership,
    needsOnboarding: false,
    authMethod: 'better-auth',
    ...overrides,
  }
}

async function renderView(): Promise<{ root: Root; container: HTMLDivElement }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => { root.render(createElement(CompanyView)) })
  return { root, container }
}

async function flushEffects(): Promise<void> {
  await act(async () => {})
}

describe('CompanyView', () => {
  let root: Root | null = null

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    harness.navigate.mockClear()
    harness.auth.refresh.mockReset().mockResolvedValue(null)
    harness.auth.switchOrganization.mockReset().mockResolvedValue(makeSession())
    harness.auth.principal = null
    harness.auth.session = null
    harness.clearTenantScopedClientState.mockClear()
  })

  afterEach(async () => {
    await act(async () => { root?.unmount() })
    root = null
    document.body.replaceChildren()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('shows signed-in onboarding and creates a company with a server-normalized slug', async () => {
    harness.auth.session = makeSession({
      organizations: [],
      activeOrganizationId: null,
      activeOrganization: null,
      activeMembership: null,
      needsOnboarding: true,
    })
    const createOrganization = vi.spyOn(api, 'createOrganization').mockResolvedValue({ organization })
    root = (await renderView()).root
    await flushEffects()

    const input = document.querySelector<HTMLInputElement>('input[name="companyName"]')
    const slug = document.querySelector<HTMLInputElement>('input[name="companySlug"]')
    expect(document.body.textContent).toContain('Create your company')
    expect(input).not.toBeNull()

    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setValue?.call(input, 'Acme Skills')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      setValue?.call(slug, 'Acme Skills')
      slug?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const form = document.querySelector('form')
    await act(async () => { form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })

    expect(createOrganization).toHaveBeenCalledWith({ name: 'Acme Skills', slug: 'acme-skills' })
    expect(harness.clearTenantScopedClientState).toHaveBeenCalledOnce()
    expect(harness.auth.refresh).toHaveBeenCalledOnce()
    expect(harness.auth.switchOrganization).toHaveBeenCalledWith('org-1')
    expect(harness.navigate).toHaveBeenCalledWith({ to: '/app', search: {}, replace: true })
  })

  it('requires an active company selection when memberships exist without one', async () => {
    const secondOrganization: OrganizationSummary = { id: 'org-2', name: 'Beta Skills', slug: 'beta-skills' }
    const secondMembership: IdentityMembership = { id: 'member-2', organizationId: secondOrganization.id, role: 'reader', organization: secondOrganization }
    harness.auth.session = makeSession({
      organizations: [membership, secondMembership],
      activeOrganizationId: null,
      activeOrganization: null,
      activeMembership: null,
    })
    root = (await renderView()).root
    await flushEffects()

    expect(document.body.textContent).toContain('Choose a company')
    expect(document.body.textContent).toContain('Your account belongs to more than one company.')
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent?.includes('Open company'))
    expect(buttons).toHaveLength(2)
    await act(async () => { buttons[1]?.click() })

    expect(harness.clearTenantScopedClientState).toHaveBeenCalledOnce()
    expect(harness.auth.switchOrganization).toHaveBeenCalledWith('org-2')
    expect(harness.navigate).toHaveBeenCalledWith({ to: '/app', search: {}, replace: true })
  })

  it('uses singular copy when one company needs an active selection', async () => {
    harness.auth.session = makeSession({
      organizations: [membership],
      activeOrganizationId: null,
      activeOrganization: null,
      activeMembership: null,
    })
    root = (await renderView()).root
    await flushEffects()

    expect(document.body.textContent).toContain('Choose this company to open the registry.')
    expect(document.body.textContent).not.toContain('more than one company')
  })

  it('loads owner team controls and invitation links from server responses', async () => {
    harness.auth.session = makeSession()
    const member: TeamMember = { id: 'member-2', userId: 'user-2', name: 'Publisher', email: 'publisher@acme.test', role: 'publisher', status: 'active' }
    const invitation: OrganizationInvitation = { id: 'invite-1', email: 'new@acme.test', role: 'reader', status: 'pending' }
    vi.spyOn(api, 'organizationMembers').mockResolvedValue({ members: [member] })
    vi.spyOn(api, 'organizationInvitations').mockResolvedValue({ invitations: [invitation] })
    root = (await renderView()).root
    await flushEffects()

    expect(document.body.textContent).toContain('publisher@acme.test')
    expect(document.body.textContent).toContain('new@acme.test')
    expect(document.querySelector<HTMLInputElement>('input[name="inviteEmail"]')?.disabled).toBe(false)
    expect(document.querySelector('select[aria-label="Role for Publisher"]')).not.toBeNull()
  })

  it('derives a same-origin copy link from the Better Auth invitation id', async () => {
    harness.auth.session = makeSession()
    vi.spyOn(api, 'organizationMembers').mockResolvedValue({ members: [] })
    vi.spyOn(api, 'organizationInvitations').mockResolvedValue({ invitations: [] })
    const createInvitation = vi.spyOn(api, 'inviteOrganizationMember').mockResolvedValue({ id: 'invite/1', email: 'new@acme.test', role: 'reader', status: 'pending' })
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    root = (await renderView()).root
    await flushEffects()

    const input = document.querySelector<HTMLInputElement>('input[name="inviteEmail"]')
    const form = document.querySelector('form')
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setValue?.call(input, 'new@acme.test')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await vi.waitFor(() => expect(createInvitation).toHaveBeenCalledWith({ email: 'new@acme.test', role: 'reader' }))

    const expectedLink = new URL('/organization/accept-invitation?id=invite%2F1', window.location.origin).toString()
    const linkInput = document.querySelector<HTMLInputElement>('input[aria-label="Invitation link"]')
    await vi.waitFor(() => expect(linkInput?.value).toBe(expectedLink))
    const copyButton = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Copy invitation link')
    await act(async () => { copyButton?.click() })

    expect(writeText).toHaveBeenCalledWith(expectedLink)
    expect(document.body.textContent).toContain('Copied')
  })

  it('leaves a selectable link and explains clipboard failures', async () => {
    harness.auth.session = makeSession()
    vi.spyOn(api, 'organizationMembers').mockResolvedValue({ members: [] })
    vi.spyOn(api, 'organizationInvitations').mockResolvedValue({ invitations: [] })
    const createInvitation = vi.spyOn(api, 'inviteOrganizationMember').mockResolvedValue({ id: 'invite/1', email: 'new@acme.test', role: 'reader', status: 'pending' })
    const writeText = vi.fn(async () => { throw new Error('clipboard permission denied') })
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    root = (await renderView()).root
    await flushEffects()

    const input = document.querySelector<HTMLInputElement>('input[name="inviteEmail"]')
    const form = document.querySelector('form')
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setValue?.call(input, 'new@acme.test')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await vi.waitFor(() => expect(createInvitation).toHaveBeenCalledOnce())

    const expectedLink = new URL('/organization/accept-invitation?id=invite%2F1', window.location.origin).toString()
    const linkInput = document.querySelector<HTMLInputElement>('input[aria-label="Invitation link"]')
    await vi.waitFor(() => expect(linkInput?.value).toBe(expectedLink))
    const copyButton = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Copy invitation link')
    await act(async () => { copyButton?.click() })

    await vi.waitFor(() => expect(document.body.textContent).toContain('Copy is unavailable here. Select the invitation link below and copy it manually.'))
    expect(writeText).toHaveBeenCalledWith(expectedLink)
    expect(copyButton?.textContent).toBe('Copy invitation link')
  })

  it('keeps member access read-only and does not request restricted invitations for readers', async () => {
    const readerMembership: IdentityMembership = { ...membership, role: 'reader' }
    harness.auth.session = makeSession({ activeMembership: readerMembership })
    const member: TeamMember = { id: 'member-2', userId: 'user-2', name: 'Reader', email: 'reader@acme.test', role: 'reader', status: 'active' }
    const members = vi.spyOn(api, 'organizationMembers').mockResolvedValue({ members: [member] })
    const invitations = vi.spyOn(api, 'organizationInvitations').mockResolvedValue({ invitations: [] })
    root = (await renderView()).root
    await flushEffects()

    expect(members).toHaveBeenCalledOnce()
    expect(invitations).not.toHaveBeenCalled()
    expect(document.querySelector<HTMLInputElement>('input[name="inviteEmail"]')?.disabled).toBe(true)
    expect(document.body.textContent).toContain('Pending invitations are visible to owners and admins.')
    expect(document.querySelector('select[aria-label="Role for Reader"]')).toBeNull()
  })
})
