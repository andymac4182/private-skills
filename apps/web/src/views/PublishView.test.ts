import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { api } from '../lib/api'
import type { DraftView } from '../lib/types'
import { SectionView } from './SectionView'

// The reload boundary tests do not need the editor's browser-only surfaces.
// Keep those dependencies out of this focused route-hydration test.
// The Node test environment has no DOM, so queue the publish view's effects
// and run them after the static render to model a committed route.
vi.mock('../components/DraftEditor', () => ({ DraftEditor: () => null }))
vi.mock('@tanstack/react-router', () => ({ Link: () => null, useNavigate: () => vi.fn() }))
const queuedEffects: Array<() => void | (() => void)> = []
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  return { ...actual, useEffect: (effect: () => void | (() => void)) => { queuedEffects.push(effect) } }
})

import { loadUploadDraft, uploadDraftCreateFingerprint, uploadDraftCreateKey, validateUploadDraft } from './PublishView'

const digest = `sha256:${'a'.repeat(64)}` as `sha256:${string}`
const uploadDraft: DraftView = {
  id: 'draft-upload-1',
  origin: 'upload',
  name: '@team/review',
  skillName: '@team/review',
  revision: 1,
  digest,
  size: 7,
  files: [{ path: 'SKILL.md', size: 7, digest }],
  status: 'open',
  actor: 'owner',
  createdAt: '2026-09-13T00:00:00.000Z',
  updatedAt: '2026-09-13T00:00:00.000Z',
}

afterEach(() => {
  queuedEffects.splice(0)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('upload draft reload recovery', () => {
  it('hydrates from the publish route and does not POST while reopening the URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ draft: uploadDraft }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const createDraft = vi.spyOn(api, 'createUploadDraft')

    const routeElement = SectionView({ section: 'publish', draftSearch: { draft: uploadDraft.id } })
    renderToStaticMarkup(routeElement)
    const cleanups = queuedEffects.splice(0).map((effect) => effect()).filter((cleanup): cleanup is () => void => typeof cleanup === 'function')
    await Promise.resolve()

    expect(fetchMock).toHaveBeenCalledOnce()
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[0]).toBe(`/v1/drafts/${encodeURIComponent(uploadDraft.id)}`)
    expect(createDraft).not.toHaveBeenCalled()
    cleanups.forEach((cleanup) => cleanup())
  })

  it('hydrates one authenticated GET and never creates a draft during reload', async () => {
    const signal = new AbortController().signal
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ draft: uploadDraft }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const createDraft = vi.spyOn(api, 'createUploadDraft')

    await expect(loadUploadDraft(uploadDraft.id, signal)).resolves.toEqual({ status: 'ready', draft: uploadDraft })
    expect(fetchMock).toHaveBeenCalledOnce()
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(path).toBe(`/v1/drafts/${encodeURIComponent(uploadDraft.id)}`)
    expect(init.credentials).toBe('include')
    expect(init.signal).toBe(signal)
    expect(createDraft).not.toHaveBeenCalled()
  })

  it('rejects malformed URL IDs before making a registry request', async () => {
    const getDraft = vi.spyOn(api, 'draft')

    await expect(loadUploadDraft('draft/other', new AbortController().signal)).resolves.toEqual({
      status: 'stale',
      message: 'This draft link is malformed. Start a new upload draft.',
    })
    expect(getDraft).not.toHaveBeenCalled()
  })

  it('keeps release-origin and closed drafts out of the upload editor', () => {
    expect(validateUploadDraft({ ...uploadDraft, origin: 'release', baseResourceId: 'release-1' }, uploadDraft.id)).toEqual({
      ok: false,
      reason: 'This link does not identify an upload draft. Start a new upload draft.',
    })
    expect(validateUploadDraft({ ...uploadDraft, status: 'published' }, uploadDraft.id)).toEqual({
      ok: false,
      reason: 'This upload draft is published and can no longer be edited.',
    })
  })

  it('reuses the same create intent fingerprint for an explicit retry', () => {
    const bundle = {
      format: 'pskills-bundle-v1',
      files: [{ path: 'SKILL.md', content: 'c2tpbGw=' }],
    } as const
    const first = uploadDraftCreateFingerprint('@team/review', bundle)
    const same = uploadDraftCreateFingerprint('@team/review', {
      format: 'pskills-bundle-v1',
      files: [{ path: 'SKILL.md', content: 'c2tpbGw=' }],
    })
    const changed = uploadDraftCreateFingerprint('@team/review', {
      format: 'pskills-bundle-v1',
      files: [{ path: 'SKILL.md', content: 'Y2hhbmdlZA==' }],
    })

    expect(same).toBe(first)
    expect(changed).not.toBe(first)

    const intent = { current: null as { fingerprint: string; key: string } | null }
    const firstKey = uploadDraftCreateKey(intent, '@team/review', bundle)
    expect(uploadDraftCreateKey(intent, '@team/review', bundle)).toBe(firstKey)
    expect(uploadDraftCreateKey(intent, '@team/other', bundle)).not.toBe(firstKey)
  })
})
