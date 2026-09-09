import { describe, expect, it } from 'vitest'
import { normalizeSelectedPaths, UploadPathError } from './upload'

describe('normalizeSelectedPaths', () => {
  it('removes the selected folder while preserving nested paths', () => {
    expect(normalizeSelectedPaths(['hello/SKILL.md', 'hello/references/example.md'])).toEqual([
      'SKILL.md',
      'references/example.md',
    ])
  })

  it('keeps direct file selections unchanged', () => {
    expect(normalizeSelectedPaths(['SKILL.md', 'README.md'])).toEqual(['SKILL.md', 'README.md'])
  })

  it('rejects selections that mix folder roots', () => {
    expect(() => normalizeSelectedPaths(['hello/SKILL.md', 'other/README.md'])).toThrow(UploadPathError)
  })
})
