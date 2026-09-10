import { describe, expect, it } from 'vitest'
import { pierreEditStateKey } from './PierreDraftSurface'

describe('Pierre draft editor identity', () => {
  it('isolates edit state across drafts, revisions, and content digests', () => {
    const first = pierreEditStateKey('draft-1', 1, 'sha256:first', 'SKILL.md')
    expect(pierreEditStateKey('draft-2', 1, 'sha256:first', 'SKILL.md')).not.toBe(first)
    expect(pierreEditStateKey('draft-1', 2, 'sha256:first', 'SKILL.md')).not.toBe(first)
    expect(pierreEditStateKey('draft-1', 1, 'sha256:second', 'SKILL.md')).not.toBe(first)
    expect(pierreEditStateKey('draft-1', 1, 'sha256:first', 'README.md')).not.toBe(first)
  })
})
