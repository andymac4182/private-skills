// @vitest-environment jsdom

import { act, createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import type { Principal, SourceDescriptor, SourceSearchResponse, SourceSearchResult } from '../lib/types'
import { SourceDiscoveryView } from './SourceDiscoveryView'

vi.mock('@tanstack/react-router', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return { Link: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => React.createElement('a', props, children) }
})

const principal: Principal = { organizationId: 'org-1', subject: 'owner@example.test', roles: ['owner'], scopes: ['proxy:resolve'] }
vi.mock('../lib/auth', () => ({ useAuth: () => ({ principal }) }))

const skillsmp: SourceDescriptor = {
  id: 'skillsmp',
  label: 'SkillsMP',
  capabilities: ['search', 'resolve'],
  availability: { state: 'available' },
  configRevision: 'revision-1',
}
const tessl: SourceDescriptor = {
  id: 'tessl',
  label: 'Tessl',
  capabilities: ['search', 'resolve'],
  availability: { state: 'unavailable', code: 'CREDENTIALS_REQUIRED', reason: 'Configure the Tessl credential.' },
  configRevision: 'revision-1',
}
const result: SourceSearchResult = {
  sourceId: 'skillsmp',
  externalId: 'acme/review',
  title: 'Review skill',
  description: 'Review pull requests safely.',
  sourceUrl: 'https://skillsmp.example/download/acme/review.zip',
  installable: false,
  unavailableReason: 'This result has no approved immutable source target.',
}
const skillsmpStatus = { ...skillsmp, resultCount: 1 }
const tesslStatus = { ...tessl, resultCount: 0 }

async function flushEffects(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
})

describe('SourceDiscoveryView', () => {
  it('shows provider credential state and keeps metadata-only results out of resolve', async () => {
    vi.spyOn(api, 'sources').mockResolvedValue({ protocolVersion: 1, sources: [skillsmp, tessl] })
    vi.spyOn(api, 'sourceSearch').mockResolvedValue({ protocolVersion: 1, query: 'review', data: [result], sources: [skillsmpStatus, tesslStatus] })
    const resolve = vi.spyOn(api, 'sourceResolve')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(createElement(SourceDiscoveryView))
        await flushEffects()
      })
      expect(container.textContent).toContain('Credentials Required')
      expect(container.textContent).toContain('Search configured sources')

      const input = container.querySelector<HTMLInputElement>('#source-discovery-search')!
      await act(async () => {
        // Use the native setter so React's value tracker sees the controlled
        // input update in jsdom, matching a real user edit.
        const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        setInputValue?.call(input, 'review')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
        await flushEffects()
      })
      await act(async () => {
        input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
        await flushEffects()
      })
      expect(api.sourceSearch).toHaveBeenCalledWith('review', { source: undefined, limit: 50 })
      expect(container.textContent).toContain('Review skill')
      expect(container.querySelector('.source-result-footer a')).toBeNull()

      await act(async () => {
        container.querySelector<HTMLButtonElement>('.source-result-trigger')!.click()
        await flushEffects()
      })
      expect(container.textContent).toContain('Metadata Only')
      expect(container.textContent).toContain('This result has no approved immutable source target.')
      expect(resolve).not.toHaveBeenCalled()
      expect(container.querySelector<HTMLButtonElement>('.source-resolve-actions .button')?.disabled).toBe(true)
    } finally {
      await act(async () => { root.unmount(); await flushEffects() })
      container.remove()
    }
  })

  it('ignores a search response that belongs to a provider selection left while it was pending', async () => {
    let releaseSearch: (response: SourceSearchResponse) => void = () => {}
    const pendingSearch = new Promise<SourceSearchResponse>((resolve) => { releaseSearch = resolve })
    vi.spyOn(api, 'sources').mockResolvedValue({ protocolVersion: 1, sources: [skillsmp, tessl] })
    vi.spyOn(api, 'sourceSearch').mockReturnValue(pendingSearch)
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(createElement(SourceDiscoveryView))
        await flushEffects()
      })
      const input = container.querySelector<HTMLInputElement>('#source-discovery-search')!
      await act(async () => {
        const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        setInputValue?.call(input, 'review')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
        input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
        await flushEffects()
      })
      expect(api.sourceSearch).toHaveBeenCalledWith('review', { source: undefined, limit: 50 })

      const tesslOption = [...container.querySelectorAll<HTMLButtonElement>('.source-provider-option')].find((button) => button.textContent?.includes('Tessl'))
      expect(tesslOption).toBeDefined()
      await act(async () => {
        tesslOption!.click()
        await flushEffects()
      })
      releaseSearch({ protocolVersion: 1, query: 'review', data: [result], sources: [skillsmpStatus, tesslStatus] })
      await act(async () => { await flushEffects() })

      expect(container.textContent).not.toContain('Review skill')
      expect(container.textContent).toContain('Tessl is credentials required.')
    } finally {
      await act(async () => { root.unmount(); await flushEffects() })
      container.remove()
    }
  })

  it('ignores a pending response after the search is cleared', async () => {
    let releaseSearch: (response: SourceSearchResponse) => void = () => {}
    const pendingSearch = new Promise<SourceSearchResponse>((resolve) => { releaseSearch = resolve })
    vi.spyOn(api, 'sources').mockResolvedValue({ protocolVersion: 1, sources: [skillsmp, tessl] })
    vi.spyOn(api, 'sourceSearch').mockReturnValue(pendingSearch)
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(createElement(SourceDiscoveryView))
        await flushEffects()
      })
      const input = container.querySelector<HTMLInputElement>('#source-discovery-search')!
      await act(async () => {
        const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        setInputValue?.call(input, 'review')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
        input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
        await flushEffects()
      })
      expect(api.sourceSearch).toHaveBeenCalledWith('review', { source: undefined, limit: 50 })
      expect(container.textContent).toContain('Searching configured providers')

      await act(async () => {
        container.querySelector<HTMLButtonElement>('.source-search-form button[type="button"]')!.click()
        await flushEffects()
      })
      releaseSearch({ protocolVersion: 1, query: 'review', data: [result], sources: [skillsmpStatus, tesslStatus] })
      await act(async () => { await flushEffects() })

      expect(container.textContent).not.toContain('Review skill')
      expect(container.textContent).toContain('Search to compare source options')
      expect(container.textContent).not.toContain('Searching configured providers')
    } finally {
      await act(async () => { root.unmount(); await flushEffects() })
      container.remove()
    }
  })
})
