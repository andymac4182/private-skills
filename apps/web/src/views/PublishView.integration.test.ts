// @vitest-environment jsdom

import { act, createElement, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DraftView } from '../lib/types'
import { SectionView } from './SectionView'

vi.mock('../components/DraftEditor', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    DraftEditor: ({ initialDraft }: { initialDraft: DraftView }) => React.createElement('output', { 'data-draft-id': initialDraft.id }, `${initialDraft.id}:${initialDraft.name}`),
  }
})

vi.mock('@tanstack/react-router', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    Link: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => React.createElement('a', props, children),
    useNavigate: () => vi.fn(),
  }
})

interface PendingDraftRequest {
  path: string
  method: string
  signal?: AbortSignal
  resolve: (draft: DraftView) => void
}

function controlledFetch(): { fetch: ReturnType<typeof vi.fn>; requests: PendingDraftRequest[] } {
  const requests: PendingDraftRequest[] = []
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve) => {
    requests.push({
      path: String(input),
      method: init?.method ?? 'GET',
      signal: init?.signal ?? undefined,
      resolve: (draft) => resolve(new Response(JSON.stringify({ draft }), { status: 200, headers: { 'content-type': 'application/json' } })),
    })
  }))
  return { fetch: fetchMock, requests }
}

const digestA = `sha256:${'a'.repeat(64)}` as `sha256:${string}`
const digestB = `sha256:${'b'.repeat(64)}` as `sha256:${string}`

function draft(id: string, name: string, digest: `sha256:${string}`): DraftView {
  return {
    id,
    origin: 'upload',
    name,
    skillName: name,
    revision: 1,
    digest,
    size: 8,
    files: [{ path: 'SKILL.md', size: 8, digest }],
    status: 'open',
    actor: 'owner',
    createdAt: '2026-09-13T00:00:00.000Z',
    updatedAt: '2026-09-13T00:00:00.000Z',
  }
}

const draftA = draft('draft-a', '@team/a', digestA)
const draftB = draft('draft-b', '@team/b', digestB)

async function flushEffects(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

let navigateTo: (draftId: string) => void = () => { throw new Error('Navigation harness has not mounted.') }

function NavigationHarness({ initialDraftId }: { initialDraftId: string }): ReactNode {
  const [draftId, setDraftId] = useState(initialDraftId)
  navigateTo = setDraftId
  return createElement(SectionView, { section: 'publish', draftSearch: { draft: draftId } })
}

function UrlHarness(): ReactNode {
  const draftId = new URLSearchParams(window.location.search).get('draft') ?? undefined
  return createElement(SectionView, { section: 'publish', draftSearch: draftId ? { draft: draftId } : undefined })
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
})

afterEach(() => {
  navigateTo = () => { throw new Error('Navigation harness has not mounted.') }
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('upload draft route hydration in a real React mount', () => {
  it('keeps the newer route visible when the older draft request resolves later', async () => {
    const { fetch: fetchMock, requests } = controlledFetch()
    vi.stubGlobal('fetch', fetchMock)
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(createElement(NavigationHarness, { initialDraftId: draftA.id }))
        await flushEffects()
      })
      expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual(['GET /v1/drafts/draft-a'])

      await act(async () => {
        navigateTo(draftB.id)
        await flushEffects()
      })
      expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
        'GET /v1/drafts/draft-a',
        'GET /v1/drafts/draft-b',
      ])
      expect(requests[0]?.signal?.aborted).toBe(true)

      await act(async () => {
        requests[1]!.resolve(draftB)
        await flushEffects()
      })
      expect(container.textContent).toContain('draft-b:@team/b')
      expect(container.textContent).not.toContain('draft-a:@team/a')

      await act(async () => {
        requests[0]!.resolve(draftA)
        await flushEffects()
      })
      expect(container.textContent).toContain('draft-b:@team/b')
      expect(container.textContent).not.toContain('draft-a:@team/a')
      expect(requests.some(({ method, path }) => method === 'POST' && path === '/v1/drafts')).toBe(false)
    } finally {
      await act(async () => { root.unmount(); await flushEffects() })
      container.parentNode?.removeChild(container)
    }
  })

  it('reopens the exact draft URL with GET-only hydration and no create request', async () => {
    const { fetch: fetchMock, requests } = controlledFetch()
    vi.stubGlobal('fetch', fetchMock)
    window.history.replaceState({}, '', `/app/publish?draft=${encodeURIComponent(draftA.id)}`)

    const firstContainer = document.createElement('div')
    document.body.appendChild(firstContainer)
    const firstRoot = createRoot(firstContainer)
    try {
      await act(async () => {
        firstRoot.render(createElement(UrlHarness))
        await flushEffects()
      })
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({ method: 'GET', path: '/v1/drafts/draft-a' })
      await act(async () => {
        requests[0]!.resolve(draftA)
        await flushEffects()
      })
      expect(firstContainer.textContent).toContain('draft-a:@team/a')
      await act(async () => { firstRoot.unmount(); await flushEffects() })

      const resumedContainer = document.createElement('div')
      document.body.appendChild(resumedContainer)
      const resumedRoot = createRoot(resumedContainer)
      try {
        await act(async () => {
          resumedRoot.render(createElement(UrlHarness))
          await flushEffects()
        })
        expect(requests).toHaveLength(2)
        expect(requests[1]).toMatchObject({ method: 'GET', path: '/v1/drafts/draft-a' })
        await act(async () => {
          requests[1]!.resolve(draftA)
          await flushEffects()
        })
        expect(resumedContainer.textContent).toContain('draft-a:@team/a')
        expect(requests.some(({ method, path }) => method === 'POST' && path === '/v1/drafts')).toBe(false)
      } finally {
        await act(async () => { resumedRoot.unmount(); await flushEffects() })
        resumedContainer.parentNode?.removeChild(resumedContainer)
      }
    } finally {
      firstContainer.parentNode?.removeChild(firstContainer)
    }
  })
})
