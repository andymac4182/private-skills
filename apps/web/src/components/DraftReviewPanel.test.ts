// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import type { DraftReviewBinding, DraftReviewFinding, DraftReviewJob, DraftReviewResult, DraftReviewsResponse, DraftView } from '../lib/types'
import { DraftReviewPanel, newestFirst } from './DraftReviewPanel'

const digestA = `sha256:${'a'.repeat(64)}` as `sha256:${string}`
const digestB = `sha256:${'b'.repeat(64)}` as `sha256:${string}`

function draft(id: string, digest: `sha256:${string}` = digestA): DraftView {
  return {
    id,
    origin: 'upload',
    name: `@team/${id}`,
    skillName: `@team/${id}`,
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

function binding(forDraft: DraftView): DraftReviewBinding {
  return {
    draftId: forDraft.id,
    draftRevision: forDraft.revision,
    contentDigest: forDraft.digest,
    policyRevision: 'policy-1',
  }
}

function finding(id: string, title: string, decision: DraftReviewFinding['decision'] = 'open', decisionReason?: string): DraftReviewFinding {
  return {
    id,
    severity: 'medium',
    category: 'quality',
    title,
    summary: `${title} summary`,
    path: 'SKILL.md',
    line: 1,
    decision,
    ...(decisionReason === undefined ? {} : { decisionReason }),
  }
}

function job(forDraft: DraftView, id: string, state: DraftReviewJob['state'], resultId?: string): DraftReviewJob {
  return {
    id,
    binding: binding(forDraft),
    model: 'test/reviewer',
    reviewerRevision: 'review-contract-1',
    state,
    createdAt: '2026-09-13T00:00:00.000Z',
    updatedAt: '2026-09-13T00:00:00.000Z',
    ...(resultId === undefined ? {} : { resultId }),
  }
}

function result(forDraft: DraftView, id: string, state: DraftReviewResult['state'], findings: DraftReviewFinding[], jobId = 'job-1'): DraftReviewResult {
  return {
    id,
    jobId,
    binding: binding(forDraft),
    model: 'test/reviewer',
    reviewerRevision: 'review-contract-1',
    state,
    findings,
    createdAt: '2026-09-13T00:00:00.000Z',
    finishedAt: '2026-09-13T00:00:00.000Z',
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve })
  return { promise, resolve }
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find((candidate) => candidate.textContent === label)
  if (!(found instanceof HTMLButtonElement)) throw new Error(`button ${label} was not found`)
  return found
}

function inputValue(element: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

function mount(container: HTMLElement, forDraft: DraftView): Root {
  const root = createRoot(container)
  root.render(createElement(DraftReviewPanel, { draft: forDraft }))
  return root
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('draft review ordering', () => {
  it('uses the registry newest-first result at index zero', () => {
    const newest = { id: 'newest', createdAt: '2026-09-10T00:02:00.000Z' }
    const older = { id: 'older', createdAt: '2026-09-10T00:01:00.000Z' }
    expect(newestFirst([newest, older])).toBe(newest)
    expect(newestFirst([])).toBeUndefined()
  })
})

describe('rendered draft review actions', () => {
  it('requires and sends an explicit dismissal reason, then displays the persisted reason', async () => {
    const forDraft = draft('draft-reason')
    const openFinding = finding('finding-1', 'Unsafe shell example')
    const initialResult = result(forDraft, 'result-1', 'passed', [openFinding])
    const initialJob = job(forDraft, 'job-1', 'passed', initialResult.id)
    const persistedFinding = finding('finding-1', 'Unsafe shell example', 'dismissed', 'Reviewed and accepted as intentional for this fixture.')
    const persistedResult = result(forDraft, 'result-1', 'passed', [persistedFinding])
    const reviews: DraftReviewsResponse[] = [
      { reviews: [initialJob], results: [initialResult] },
      { reviews: [initialJob], results: [persistedResult] },
    ]
    const reviewsMock = vi.spyOn(api, 'draftReviews').mockImplementation(async () => reviews.shift() ?? { reviews: [], results: [] })
    const decideMock = vi.spyOn(api, 'decideDraftReview').mockResolvedValue({ review: persistedResult })
    const container = document.createElement('div')
    document.body.appendChild(container)
    let root: Root | undefined

    try {
      await act(async () => {
        root = mount(container, forDraft)
        await flushMicrotasks()
      })
      expect(container.textContent).toContain('Unsafe shell example')

      await act(async () => {
        button(container, 'Dismiss').click()
        await flushMicrotasks()
      })
      const reason = container.querySelector('textarea[aria-required="true"]')
      expect(reason).toBeInstanceOf(HTMLTextAreaElement)
      expect(document.activeElement).toBe(reason)

      await act(async () => {
        inputValue(reason as HTMLTextAreaElement, '   ')
        await flushMicrotasks()
      })
      expect(button(container, 'Submit dismissal').disabled).toBe(true)
      expect(decideMock).not.toHaveBeenCalled()

      await act(async () => {
        button(container, 'Cancel').click()
        await flushMicrotasks()
      })
      expect(document.activeElement).toBe(container.querySelector('#dismiss-trigger-finding-1'))

      await act(async () => {
        button(container, 'Dismiss').click()
        await flushMicrotasks()
        inputValue(container.querySelector('textarea[aria-required="true"]') as HTMLTextAreaElement, '  Reviewed and accepted as intentional for this fixture.  ')
        await flushMicrotasks()
      })
      expect(button(container, 'Submit dismissal').disabled).toBe(false)

      await act(async () => {
        button(container, 'Submit dismissal').click()
        await flushMicrotasks()
      })
      expect(decideMock).toHaveBeenCalledWith('draft-reason', 'result-1', {
        findingId: 'finding-1',
        decision: 'dismissed',
        reason: 'Reviewed and accepted as intentional for this fixture.',
      })
      expect(reviewsMock).toHaveBeenCalledTimes(2)
      expect(container.textContent).toContain('Decision reason: Reviewed and accepted as intentional for this fixture.')
      expect(document.activeElement).toBe(container.querySelector('#draft-review-finding-finding-1'))
    } finally {
      await act(async () => { root?.unmount(); await flushMicrotasks() })
    }
  })

  it('does not let an old request completion reload a newer draft binding', async () => {
    const draftA = draft('draft-a')
    const draftB = draft('draft-b', digestB)
    const requests: Array<{ draftId: string; deferred: ReturnType<typeof deferred<DraftReviewsResponse>> }> = []
    const reviewsMock = vi.spyOn(api, 'draftReviews').mockImplementation((draftId) => {
      const pending = deferred<DraftReviewsResponse>()
      requests.push({ draftId, deferred: pending })
      return pending.promise
    })
    const createDeferred = deferred<{ review: DraftReviewJob }>()
    const requestMock = vi.spyOn(api, 'requestDraftReview').mockReturnValue(createDeferred.promise)
    const container = document.createElement('div')
    document.body.appendChild(container)
    let root: Root | undefined

    try {
      await act(async () => {
        root = mount(container, draftA)
        await flushMicrotasks()
      })
      expect(requests.map(({ draftId }) => draftId)).toEqual(['draft-a'])
      await act(async () => {
        requests[0]!.deferred.resolve({ reviews: [], results: [] })
        await flushMicrotasks()
      })

      await act(async () => {
        button(container, 'Request Eve review').click()
        await flushMicrotasks()
      })
      expect(requestMock).toHaveBeenCalledWith('draft-a')

      await act(async () => {
        root!.render(createElement(DraftReviewPanel, { draft: draftB }))
        await flushMicrotasks()
      })
      expect(requests.map(({ draftId }) => draftId)).toEqual(['draft-a', 'draft-b'])
      requests[1]!.deferred.resolve({ reviews: [], results: [] })
      await act(async () => { await flushMicrotasks() })

      createDeferred.resolve({ review: job(draftA, 'job-old', 'pending') })
      await act(async () => { await flushMicrotasks() })
      expect(reviewsMock).toHaveBeenCalledTimes(2)
      expect(reviewsMock.mock.calls.map(([draftId]) => draftId)).toEqual(['draft-a', 'draft-b'])
      expect(container.textContent).toContain('No Eve review for this revision')
    } finally {
      await act(async () => { root?.unmount(); await flushMicrotasks() })
    }
  })

  it('refreshes a retry from pending to complete and hides the superseded result while pending', async () => {
    vi.useFakeTimers()
    const forDraft = draft('draft-refresh')
    const oldFinding = finding('old-finding', 'Superseded finding')
    const oldResult = result(forDraft, 'result-old', 'failed', [oldFinding])
    const failedJob = job(forDraft, 'job-1', 'failed', oldResult.id)
    const pendingJob = job(forDraft, 'job-1', 'pending')
    const newFinding = finding('new-finding', 'Current finding')
    const newResult = result(forDraft, 'result-new', 'passed', [newFinding])
    const completedJob = job(forDraft, 'job-1', 'passed', newResult.id)
    const responses: DraftReviewsResponse[] = [
      { reviews: [failedJob], results: [oldResult] },
      { reviews: [pendingJob], results: [oldResult] },
      { reviews: [completedJob], results: [oldResult, newResult] },
    ]
    const reviewsMock = vi.spyOn(api, 'draftReviews').mockImplementation(async () => responses.shift() ?? { reviews: [completedJob], results: [newResult] })
    const retryMock = vi.spyOn(api, 'retryDraftReview').mockResolvedValue({ review: pendingJob })
    const container = document.createElement('div')
    document.body.appendChild(container)
    let root: Root | undefined

    try {
      await act(async () => {
        root = mount(container, forDraft)
        await flushMicrotasks()
      })
      expect(container.textContent).toContain('Superseded finding')
      expect(button(container, 'Retry')).toBeDefined()

      await act(async () => {
        button(container, 'Retry').click()
        await flushMicrotasks()
      })
      expect(retryMock).toHaveBeenCalledWith('draft-refresh', 'job-1')
      expect(reviewsMock).toHaveBeenCalledTimes(2)
      expect(container.textContent).toContain('pending')
      expect(container.textContent).not.toContain('Superseded finding')
      expect(container.querySelector('#dismiss-trigger-old-finding')).toBeNull()
      expect(button(container, 'Refresh status')).toBeDefined()

      await act(async () => {
        vi.advanceTimersByTime(500)
        await flushMicrotasks()
      })
      expect(reviewsMock).toHaveBeenCalledTimes(3)
      expect(container.textContent).toContain('Review complete')
      expect(container.textContent).toContain('Current finding')
      expect(container.textContent).not.toContain('Superseded finding')
    } finally {
      await act(async () => { root?.unmount(); await flushMicrotasks() })
    }
  })

  it('offers an explicit refresh for a review that was already pending on mount', async () => {
    const forDraft = draft('draft-pending')
    const pendingJob = job(forDraft, 'job-pending', 'pending')
    const completedFinding = finding('finding-complete', 'Completed review finding')
    const completedResult = result(forDraft, 'result-complete', 'passed', [completedFinding], 'job-pending')
    const completedJob = job(forDraft, 'job-pending', 'passed', completedResult.id)
    const responses: DraftReviewsResponse[] = [
      { reviews: [pendingJob], results: [] },
      { reviews: [completedJob], results: [completedResult] },
    ]
    const reviewsMock = vi.spyOn(api, 'draftReviews').mockImplementation(async () => responses.shift() ?? { reviews: [completedJob], results: [completedResult] })
    const container = document.createElement('div')
    document.body.appendChild(container)
    let root: Root | undefined

    try {
      await act(async () => {
        root = mount(container, forDraft)
        await flushMicrotasks()
      })
      expect(container.textContent).toContain('pending')
      expect(button(container, 'Refresh status')).toBeDefined()

      await act(async () => {
        button(container, 'Refresh status').click()
        await flushMicrotasks()
      })
      expect(reviewsMock).toHaveBeenCalledTimes(2)
      expect(container.textContent).toContain('Review complete')
      expect(container.textContent).toContain('Completed review finding')
    } finally {
      await act(async () => { root?.unmount(); await flushMicrotasks() })
    }
  })
})
