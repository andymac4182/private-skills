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
  registrySections: [{ id: 'catalog', label: 'Skills', hint: 'Browse releases', glyph: '⌕' }],
  registryNavGroups: [{
    id: 'skills',
    label: 'Skills',
    hint: 'Build and publish',
    glyph: '⌕',
    defaultSectionId: 'catalog',
    sections: [{ id: 'catalog', label: 'Skills', hint: 'Browse releases', glyph: '⌕' }],
  }],
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
