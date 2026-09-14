import { describe, expect, it } from 'vitest'
import type { SourceDescriptor } from './types'
import {
  matchesSourceIdentity,
  normalizeSourceQuery,
  sourceCanResolve,
  sourceCanSearch,
  sourceLabel,
  sourceStatusLabel,
  sourceStatusTone,
  verifiedSourceLocator,
} from './sourceDiscovery'

function descriptor(partial: Partial<SourceDescriptor> = {}): SourceDescriptor {
  return {
    id: 'skillsmp',
    label: 'SkillsMP',
    capabilities: ['search', 'resolve'],
    availability: { state: 'available' },
    configRevision: 'revision-1',
    ...partial,
  }
}

describe('source discovery helpers', () => {
  it('keeps provider labels descriptive while accepting future source ids', () => {
    expect(sourceLabel('skillsmp')).toBe('SkillsMP')
    expect(sourceLabel('org-private-source')).toBe('org-private-source')
    expect(sourceLabel(descriptor({ id: 'tessl', label: 'Tessl API' }))).toBe('Tessl')
  })

  it('normalizes bounded search input without changing the query meaning', () => {
    expect(normalizeSourceQuery('  deploy   a   worker  ')).toBe('deploy a worker')
    expect([...normalizeSourceQuery('  数据   skill  ')]).toHaveLength(8)
  })

  it('only enables calls for an available provider capability', () => {
    expect(sourceCanSearch(descriptor())).toBe(true)
    expect(sourceCanResolve(descriptor())).toBe(true)
    expect(sourceCanResolve(descriptor({ capabilities: ['search'] }))).toBe(false)
    expect(sourceCanSearch(descriptor({ availability: { state: 'disabled', reason: 'paused by administrator' } }))).toBe(false)
    expect(sourceStatusLabel({ state: 'unavailable', code: 'CREDENTIALS_REQUIRED', reason: 'Configure the provider token.' })).toBe('Credentials required')
    expect(sourceStatusTone({ state: 'disabled', reason: 'paused by administrator' })).toBe('muted')
  })

  it('accepts only server locators and never treats a direct URL as an install target', () => {
    expect(verifiedSourceLocator('@skillsmp/acme/review')).toBe('@skillsmp/acme/review')
    expect(verifiedSourceLocator('https://skillsmp.example/download/review.zip')).toBeNull()
    expect(verifiedSourceLocator('@skillsmp/acme/../review')).toBeNull()
    expect(verifiedSourceLocator('@skillsmp/acme/review\u0000')).toBeNull()
  })

  it('requires the resolve envelope to echo the exact provider identity', () => {
    expect(matchesSourceIdentity({ sourceId: 'skillsmp', externalId: 'acme/review' }, 'skillsmp', 'acme/review')).toBe(true)
    expect(matchesSourceIdentity({ sourceId: 'tessl', externalId: 'acme/review' }, 'skillsmp', 'acme/review')).toBe(false)
    expect(matchesSourceIdentity({ sourceId: 'skillsmp', externalId: 'other/review' }, 'skillsmp', 'acme/review')).toBe(false)
  })
})
