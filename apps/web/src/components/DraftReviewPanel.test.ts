import { describe, expect, it } from 'vitest'
import { newestFirst } from './DraftReviewPanel'

describe('draft review ordering', () => {
  it('uses the registry newest-first result at index zero', () => {
    const newest = { id: 'newest', createdAt: '2026-09-10T00:02:00.000Z' }
    const older = { id: 'older', createdAt: '2026-09-10T00:01:00.000Z' }
    expect(newestFirst([newest, older])).toBe(newest)
    expect(newestFirst([])).toBeUndefined()
  })
})
