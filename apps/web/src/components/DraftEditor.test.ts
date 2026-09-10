import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import { canonicalDraftFiles, draftPayloadFingerprint, loadImmutableReleaseBaseline, operationKey, releaseBaselineStatus } from './DraftEditor'
import type { DraftView, ReleaseFilesResponse } from '../lib/types'

const draft: DraftView = {
  id: 'draft-1',
  origin: 'release',
  name: 'demo-skill',
  skillName: 'demo-skill',
  baseResourceId: 'resource-1',
  baseDigest: 'sha256:release',
  revision: 3,
  digest: 'sha256:draft',
  size: 4,
  files: [{ path: 'SKILL.md', content: 'I2F2ZQ==' }],
  status: 'open',
  actor: 'owner',
  createdAt: '2026-09-10T00:00:00.000Z',
  updatedAt: '2026-09-10T00:00:00.000Z',
}

const firstFiles = [
  { path: 'z.txt', content: 'eg==' },
  { path: 'a.txt', content: 'YQ==' },
]

describe('draft editor persistence identities', () => {
  it('canonicalizes the same file payload independent of file order', () => {
    expect(canonicalDraftFiles(firstFiles)).toBe(canonicalDraftFiles([...firstFiles].reverse()))
  })

  it('keeps exact save retries idempotent while changing the key for changed bytes', async () => {
    const ref = { current: null } as Parameters<typeof operationKey>[0]
    const firstFingerprint = await draftPayloadFingerprint(firstFiles)
    const sameFingerprint = await draftPayloadFingerprint([...firstFiles].reverse())
    const changedFingerprint = await draftPayloadFingerprint([{ ...firstFiles[0], content: 'Yg==' }, firstFiles[1]])
    const firstKey = operationKey(ref, 'draft-save', draft, firstFingerprint)
    expect(operationKey(ref, 'draft-save', draft, sameFingerprint)).toBe(firstKey)
    expect(operationKey(ref, 'draft-save', draft, changedFingerprint)).not.toBe(firstKey)
  })
})

describe('immutable release baseline loading', () => {
  afterEach(() => vi.restoreAllMocks())

  it('keeps all manifest paths while loading inline text only', async () => {
    const releaseFiles: ReleaseFilesResponse = {
      release: { id: 'resource-1', name: 'demo-skill', skillName: 'demo-skill', version: '1.0.0', digest: 'sha256:release', fileCount: 4 },
      files: [
        { path: 'SKILL.md', size: 128, contentDigest: 'sha256:skill', previewState: 'text' },
        { path: 'assets/logo.bin', size: 16, contentDigest: 'sha256:binary', previewState: 'binary' },
        { path: 'LICENSE', size: 32, contentDigest: 'sha256:license', previewState: 'unsupported', contents: 'license text' },
        { path: 'README.md', size: 4, contentDigest: 'sha256:readme', previewState: 'text', contents: 'read' },
      ],
    }
    vi.spyOn(api, 'releaseFiles').mockResolvedValue(releaseFiles)
    const releaseFile = vi.spyOn(api, 'releaseFile')

    const baseline = await loadImmutableReleaseBaseline('resource-1', 'sha256:release', new AbortController().signal)

    expect(baseline.entries.map((entry) => entry.path)).toEqual(['SKILL.md', 'assets/logo.bin', 'LICENSE', 'README.md'])
    expect(baseline.files).toEqual([{ path: 'README.md', content: 'cmVhZA==' }])
    expect(releaseFile).not.toHaveBeenCalled()
  })

  it('uses manifest metadata for binary paths until selected bytes are available', () => {
    const binary = { path: 'assets/logo.bin', content: 'AA==' }
    const textBase = { path: 'SKILL.md', content: 'b2xk' }
    const textCurrent = { path: 'SKILL.md', content: 'bmV3' }

    expect(releaseBaselineStatus({ path: 'assets/logo.bin', previewState: 'binary' }, undefined, binary)).toBe('unchanged')
    expect(releaseBaselineStatus({ path: 'SKILL.md', previewState: 'text' }, undefined, textBase)).toBe('unchanged')
    expect(releaseBaselineStatus(undefined, undefined, { path: 'new.md', content: 'bmV3' })).toBe('added')
    expect(releaseBaselineStatus({ path: 'removed.md', previewState: 'unsupported' }, undefined, undefined)).toBe('removed')
    expect(releaseBaselineStatus({ path: 'SKILL.md', previewState: 'text' }, textBase, textCurrent)).toBe('changed')
  })
})
