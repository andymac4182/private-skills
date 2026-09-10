import { describe, expect, it } from 'vitest'
import type { DirectoryFeed } from './types'
import { resolveSelectedDirectoryFeed, selectedDirectoryFeedQuery } from './directoryFeed'
import { formatDirectoryStatus, formatRelativeAge } from './format'

const feeds: DirectoryFeed[] = [
  { id: 'feed-community', name: 'community', kind: 'skills-sh', enabled: true, configRevision: 'revision-1', baseUrl: 'https://skills.sh', namespace: '@community' },
  { id: 'feed-legacy', name: 'legacy', kind: 'skills-sh', enabled: false, configRevision: 'revision-2', baseUrl: 'https://skills.sh', namespace: '@legacy' },
]

describe('directory feed selection', () => {
  it('keeps the global view explicit and unscoped', () => {
    expect(resolveSelectedDirectoryFeed('', feeds)).toBeNull()
    expect(selectedDirectoryFeedQuery('', feeds)).toBeUndefined()
  })

  it('returns only names validated by the server feed list', () => {
    expect(resolveSelectedDirectoryFeed('community', feeds)).toMatchObject({ name: 'community', namespace: '@community' })
    expect(selectedDirectoryFeedQuery('community', feeds)).toBe('community')
    expect(resolveSelectedDirectoryFeed('unknown', feeds)).toBeUndefined()
    expect(selectedDirectoryFeedQuery('unknown', feeds)).toBeUndefined()
  })

  it('preserves disabled feed identity so the server/UI can show its state', () => {
    expect(resolveSelectedDirectoryFeed('legacy', feeds)).toMatchObject({ name: 'legacy', enabled: false })
    expect(selectedDirectoryFeedQuery('legacy', feeds)).toBe('legacy')
  })

  it('keeps missing or malformed freshness metadata honest', () => {
    expect(formatRelativeAge()).toBe('Freshness unknown')
    expect(formatRelativeAge('not-a-date', 1_000)).toBe('Freshness unknown')
    expect(formatDirectoryStatus()).toBe('Status unknown')
    expect(formatDirectoryStatus('metadata-only')).toBe('Metadata Only')
  })

  it('formats adapter timestamps without mutating or restamping them', () => {
    expect(formatRelativeAge('2026-09-10T00:00:00.000Z', Date.parse('2026-09-10T01:05:00.000Z'))).toBe('Fetched 1h ago')
  })
})
