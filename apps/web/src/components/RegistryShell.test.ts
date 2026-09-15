// @vitest-environment jsdom

import { act, createElement, type PropsWithChildren } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import type { AuthSession } from '../lib/types'

const authState = vi.hoisted(() => ({
  error: null as string | null,
  principal: null as { subject: string; roles: string[]; organizationId?: string; display?: { userName?: string; userEmail?: string; organizationName?: string; organizationSlug?: string } } | null,
  session: null as AuthSession | null,
  signOut: vi.fn(async () => {}),
  status: 'signed-out' as 'signed-out' | 'signed-in' | 'loading',
}))

vi.mock('../lib/auth', async () => {
  const actual = await vi.importActual<typeof import('../lib/auth')>('../lib/auth')
  return { ...actual, useAuth: () => authState }
})

vi.mock('../lib/directoryFeed', () => ({
  DirectoryFeedProvider: ({ children }: PropsWithChildren) => children,
}))

vi.mock('./CommandPalette', () => ({
  CommandPalette: () => null,
  registrySections: [
    { id: 'catalog', label: 'Skills', hint: 'Browse releases', glyph: '⌕' },
    { id: 'company', label: 'Company', hint: 'Team and access', glyph: '◍' },
  ],
  registryNavGroups: [
    {
      id: 'skills',
      label: 'Skills',
      hint: 'Build and publish',
      glyph: '⌕',
      defaultSectionId: 'catalog',
      sections: [{ id: 'catalog', label: 'Skills', hint: 'Browse releases', glyph: '⌕' }],
    },
    {
      id: 'company-admin',
      label: 'Company admin',
      hint: 'Team and controls',
      glyph: '◍',
      defaultSectionId: 'company',
      admin: true,
      sections: [
        { id: 'company', label: 'Company', hint: 'Team and access', glyph: '◍' },
        { id: 'company-sso', label: 'SSO settings', hint: 'Company sign-in', glyph: '⌁' },
        { id: 'company-tokens', label: 'CLI tokens', hint: 'Scoped access', glyph: '⌘' },
        { id: 'billing', label: 'Billing & usage', hint: 'Plan and invoices', glyph: '$' },
        { id: 'policy', label: 'Settings', hint: 'Review rules', glyph: '⚙' },
        { id: 'upstreams', label: 'Sources', hint: 'Approved sources', glyph: '⌘' },
        { id: 'audit', label: 'Audit', hint: 'Change history', glyph: '◷' },
      ],
    },
  ],
}))

vi.mock('./HealthStatus', () => ({ HealthStatus: () => null }))
vi.mock('./Primitives', () => ({
  Button: ({ children }: PropsWithChildren) => createElement('button', null, children),
  LoadingState: ({ label }: { label: string }) => createElement('div', null, label),
}))

import { RegistryShell } from './RegistryShell'

describe('RegistryShell auth return route', () => {
  let root: Root | null = null

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    vi.stubGlobal('scrollTo', vi.fn())
  })

  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = null
    document.body.replaceChildren()
    authState.error = null
    authState.principal = null
    authState.session = null
    authState.status = 'signed-out'
    vi.unstubAllGlobals()
  })

  it('keeps the return query when a shell rerender follows the login navigation', async () => {
    const rootRoute = createRootRoute({ component: () => createElement(Outlet) })
    const appRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/app',
      component: RegistryShell,
    })
    const catalogRoute = createRoute({
      getParentRoute: () => appRoute,
      path: '/catalog',
      component: () => createElement('div', null, 'catalog'),
    })
    const loginRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/login',
      // A pending route can leave the shell mounted for one render after the
      // location changes. Keep that transition in the regression harness.
      component: RegistryShell,
    })

    const testRouter = createRouter({
      routeTree: rootRoute.addChildren([appRoute.addChildren([catalogRoute]), loginRoute]),
      history: createMemoryHistory({
        initialEntries: ['/app/catalog?draft=draft-42&skill=reviewer&version=0.4.0&digest=sha256:abc123'],
      }),
    })
    await testRouter.load()

    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(createElement(RouterProvider, { router: testRouter }))
      await new Promise((resolve) => setTimeout(resolve, 25))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25))
    })

    expect(testRouter.state.location.pathname).toBe('/login')
    const returnTo = new URL((testRouter.state.location.search as { returnTo: string }).returnTo, 'https://registry.test')
    expect(returnTo.pathname).toBe('/app/catalog')
    expect(Object.fromEntries(returnTo.searchParams)).toEqual({
      draft: 'draft-42',
      skill: 'reviewer',
      version: '0.4.0',
      digest: 'sha256:abc123',
    })
  })

  it('prefers the sanitized identity account name over an opaque legacy subject', async () => {
    authState.status = 'signed-in'
    authState.principal = { subject: 'user_opaque_7f2a', roles: ['owner'], organizationId: 'org-1' }
    authState.session = {
      user: { id: 'user-1', email: 'alice@example.test', name: 'Alice Example', emailVerified: true },
      sessionId: 'session-1',
      createdAt: '2026-09-14T00:00:00.000Z',
      expiresAt: '2026-09-15T00:00:00.000Z',
      organizations: [],
      activeOrganizationId: 'org-1',
      activeOrganization: { id: 'org-1', name: 'Acme Skills', slug: 'acme-skills' },
      activeMembership: null,
      needsOnboarding: false,
      authMethod: 'better-auth',
    }

    const rootRoute = createRootRoute({ component: () => createElement(Outlet) })
    const appRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/app',
      component: RegistryShell,
    })
    const catalogRoute = createRoute({
      getParentRoute: () => appRoute,
      path: '/catalog',
      component: () => createElement('div', null, 'catalog'),
    })
    const testRouter = createRouter({
      routeTree: rootRoute.addChildren([appRoute.addChildren([catalogRoute])]),
      history: createMemoryHistory({ initialEntries: ['/app/catalog'] }),
    })
    await testRouter.load()

    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(createElement(RouterProvider, { router: testRouter }))
      await new Promise((resolve) => setTimeout(resolve, 25))
    })

    expect(container.querySelector('.sidebar-account strong')?.textContent).toBe('Alice Example')
    expect(container.querySelector('.principal-chip')?.textContent).toContain('Alice Example')
    expect(container.textContent).not.toContain('user_opaque_7f2a')
  })

  it('uses server-derived labels for a persisted-token principal', async () => {
    authState.status = 'signed-in'
    authState.principal = {
      subject: 'user_opaque_7f2a',
      roles: ['reader'],
      organizationId: 'org-opaque-42',
      display: {
        userName: 'Alice Example',
        userEmail: 'alice@example.test',
        organizationName: 'Acme Skills',
        organizationSlug: 'acme-skills',
      },
    }
    authState.session = null

    const rootRoute = createRootRoute({ component: () => createElement(Outlet) })
    const appRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/app',
      component: RegistryShell,
    })
    const catalogRoute = createRoute({
      getParentRoute: () => appRoute,
      path: '/catalog',
      component: () => createElement('div', null, 'catalog'),
    })
    const testRouter = createRouter({
      routeTree: rootRoute.addChildren([appRoute.addChildren([catalogRoute])]),
      history: createMemoryHistory({ initialEntries: ['/app/catalog'] }),
    })
    await testRouter.load()

    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(createElement(RouterProvider, { router: testRouter }))
      await new Promise((resolve) => setTimeout(resolve, 25))
    })

    expect(container.querySelector('.sidebar-account strong')?.textContent).toBe('Alice Example')
    expect(container.querySelector('.principal-chip')?.textContent).toContain('Alice Example')
    expect(container.textContent).not.toContain('user_opaque_7f2a')
    expect(container.textContent).not.toContain('org-opaque-42')
  })

  it('labels company navigation as access for a read-only member', async () => {
    authState.status = 'signed-in'
    authState.session = {
      user: { id: 'user-reader', email: 'reader@example.test', name: 'Reader Example', emailVerified: true },
      sessionId: 'session-reader',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-02T00:00:00.000Z',
      organizations: [{ id: 'member-reader', organizationId: 'org-1', role: 'reader', organization: { id: 'org-1', name: 'Acme Skills', slug: 'acme-skills' } }],
      activeOrganizationId: 'org-1',
      activeOrganization: { id: 'org-1', name: 'Acme Skills', slug: 'acme-skills' },
      activeMembership: { id: 'member-reader', organizationId: 'org-1', role: 'reader', organization: { id: 'org-1', name: 'Acme Skills', slug: 'acme-skills' } },
      needsOnboarding: false,
      authMethod: 'better-auth',
    }

    const rootRoute = createRootRoute({ component: () => createElement(Outlet) })
    const appRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/app',
      component: RegistryShell,
    })
    const companyRoute = createRoute({
      getParentRoute: () => appRoute,
      path: '/company',
      component: () => createElement('div', null, 'company'),
    })
    const testRouter = createRouter({
      routeTree: rootRoute.addChildren([appRoute.addChildren([companyRoute])]),
      history: createMemoryHistory({ initialEntries: ['/app/company'] }),
    })
    await testRouter.load()

    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(createElement(RouterProvider, { router: testRouter }))
      await new Promise((resolve) => setTimeout(resolve, 25))
    })

    const companyGroup = [...container.querySelectorAll<HTMLElement>('.nav-group')].find((group) => group.textContent?.includes('Team and access'))
    expect(companyGroup?.querySelector('strong')?.textContent).toBe('Company')
    expect(companyGroup?.querySelector('small')?.textContent).toBe('Team and access')
    expect(companyGroup?.classList.contains('nav-group-admin')).toBe(false)
    expect(container.textContent).not.toContain('Company admin')
    expect(companyGroup?.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('Company sections')
    const companySections = [...companyGroup?.querySelectorAll<HTMLElement>('.nav-subitem strong') ?? []].map((item) => item.textContent)
    expect(companySections).toEqual(['Company', 'CLI tokens', 'Settings', 'Sources'])
    expect(container.textContent).not.toContain('SSO settings')
    expect(container.textContent).not.toContain('Billing & usage')
    expect(container.textContent).not.toContain('Audit')

    authState.session = null
    authState.principal = { subject: 'mixed-role', roles: ['reader', 'admin'], organizationId: 'org-1' }
    await act(async () => {
      root?.render(createElement(RouterProvider, { router: testRouter }))
      await new Promise((resolve) => setTimeout(resolve, 25))
    })
    expect(container.textContent).toContain('Company admin')
    expect(container.textContent).toContain('SSO settings')
    expect(container.textContent).toContain('Billing & usage')
    expect(container.textContent).toContain('Audit')
  })

  it('opens a focus-trapped mobile drawer and restores the menu trigger on close', async () => {
    authState.status = 'signed-in'
    authState.principal = { subject: 'reader', roles: ['reader'] }

    const rootRoute = createRootRoute({ component: () => createElement(Outlet) })
    const appRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/app',
      component: RegistryShell,
    })
    const catalogRoute = createRoute({
      getParentRoute: () => appRoute,
      path: '/catalog',
      component: () => createElement('div', null, 'catalog'),
    })
    const testRouter = createRouter({
      routeTree: rootRoute.addChildren([appRoute.addChildren([catalogRoute])]),
      history: createMemoryHistory({ initialEntries: ['/app/catalog'] }),
    })
    await testRouter.load()

    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(createElement(RouterProvider, { router: testRouter }))
      await new Promise((resolve) => setTimeout(resolve, 25))
    })

    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Open navigation"]')
    expect(trigger).not.toBeNull()
    await act(async () => {
      trigger?.click()
      await new Promise((resolve) => setTimeout(resolve, 25))
    })

    const drawer = container.querySelector<HTMLElement>('#registry-navigation')
    const close = container.querySelector<HTMLButtonElement>('[aria-label="Close navigation"]')
    expect(drawer?.classList.contains('sidebar-mobile-open')).toBe(true)
    expect(drawer?.getAttribute('role')).toBe('dialog')
    expect(drawer?.getAttribute('aria-modal')).toBe('true')
    expect(container.querySelector('.app-frame')?.getAttribute('aria-hidden')).toBe('true')
    expect(container.querySelector('.app-frame')?.hasAttribute('inert')).toBe(true)
    expect(close).not.toBeNull()
    expect(document.activeElement).toBe(close)

    const companyGroup = container.querySelector<HTMLElement>('[aria-label="Company sections"]')?.closest<HTMLElement>('.nav-group')
    const companyToggle = companyGroup?.querySelector<HTMLButtonElement>('.nav-group-toggle')
    const companySubnav = companyGroup?.querySelector<HTMLElement>('.nav-subnav')
    expect(companyToggle?.getAttribute('aria-controls')).toBe('registry-nav-company-admin-sections')
    expect(companyToggle?.getAttribute('aria-expanded')).toBe('false')
    expect(companySubnav?.hidden).toBe(true)
    await act(async () => {
      companyToggle?.click()
      await new Promise((resolve) => setTimeout(resolve, 25))
    })
    expect(companyToggle?.getAttribute('aria-expanded')).toBe('true')
    expect(companySubnav?.hidden).toBe(false)

    const focusable = Array.from(drawer?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])') ?? [])
    const last = focusable.at(-1)
    last?.focus()
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    })
    expect(document.activeElement).toBe(focusable[0])

    focusable[0]?.focus()
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }))
    })
    expect(document.activeElement).toBe(last)

    await act(async () => {
      window.dispatchEvent(new Event('resize'))
      await new Promise((resolve) => setTimeout(resolve, 25))
    })
    expect(drawer?.classList.contains('sidebar-mobile-open')).toBe(false)
    expect(document.activeElement).toBe(trigger)

    await act(async () => {
      trigger?.click()
      await new Promise((resolve) => setTimeout(resolve, 25))
    })

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 25))
    })
    expect(drawer?.classList.contains('sidebar-mobile-open')).toBe(false)
    expect(document.activeElement).toBe(trigger)
  })
})
