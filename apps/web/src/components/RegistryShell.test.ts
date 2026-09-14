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

const authState = vi.hoisted(() => ({
  error: null as string | null,
  principal: null,
  signOut: vi.fn(async () => {}),
  status: 'signed-out' as const,
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
})
