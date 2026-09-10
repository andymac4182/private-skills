import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import { buildDraftDeltaFiles, canonicalDraftFiles, draftPayloadFingerprint, inspectDraftFile, loadImmutableReleaseBaseline, MAX_TEXT_PREVIEW_BYTES, operationKey, releaseBaselineStatus } from './DraftEditor'
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

  it('sends unchanged large and renamed files as digest references while omitting deletions', async () => {
    const largeContent = btoa('x'.repeat(3_500_000))
    const unchangedNotes = btoa('unchanged notes\n')
    const savedFiles = [
      { path: 'assets/large.bin', content: largeContent },
      { path: 'notes.md', content: unchangedNotes },
      { path: 'removed.txt', content: btoa('remove me\n') },
    ]
    const workingFiles = [
      { path: 'assets/archive.bin', content: largeContent },
      { path: 'notes.md', content: unchangedNotes },
      { path: 'new.md', content: btoa('new file\n') },
    ]

    const delta = await buildDraftDeltaFiles(savedFiles, workingFiles, { 'assets/archive.bin': 'assets/large.bin' })
    const serializedDelta = new TextEncoder().encode(JSON.stringify({ expectedRevision: 1, expectedDigest: 'sha256:saved', files: delta }))
    const serializedFull = new TextEncoder().encode(JSON.stringify({ expectedRevision: 1, expectedDigest: 'sha256:saved', files: savedFiles }))

    expect(delta).toHaveLength(3)
    expect(delta.find((file) => file.path === 'assets/archive.bin')).toMatchObject({
      path: 'assets/archive.bin',
      sourcePath: 'assets/large.bin',
    })
    const largeReference = delta.find((file) => file.path === 'assets/archive.bin')
    expect(largeReference && 'digest' in largeReference ? largeReference.digest : '').toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(delta.find((file) => file.path === 'notes.md')).toMatchObject({ path: 'notes.md', digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) })
    expect(delta.find((file) => file.path === 'new.md')).toEqual({ path: 'new.md', content: btoa('new file\n') })
    expect(delta.some((file) => file.path === 'removed.txt')).toBe(false)
    expect(serializedDelta.byteLength).toBeLessThan(4_500_000)
    expect(serializedFull.byteLength).toBeGreaterThan(4_500_000)
    expect(await buildDraftDeltaFiles(savedFiles, workingFiles, { 'assets/archive.bin': 'assets/large.bin' })).toEqual(delta)
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
    expect(baseline.entries[0]).toMatchObject({ size: 128, contentDigest: 'sha256:skill' })
    expect(baseline.entries[1]).toMatchObject({ size: 16, contentDigest: 'sha256:binary' })
    expect(baseline.files).toEqual([{ path: 'README.md', content: 'cmVhZA==' }])
    expect(releaseFile).not.toHaveBeenCalled()
  })

  it('uses manifest metadata for binary paths until selected bytes are available', () => {
    const binary = { path: 'assets/logo.bin', content: 'AA==' }
    const textBase = { path: 'SKILL.md', content: 'b2xk' }
    const textCurrent = { path: 'SKILL.md', content: 'bmV3' }

    expect(releaseBaselineStatus({ path: 'assets/logo.bin', size: 1, contentDigest: 'sha256:binary', previewState: 'binary' }, undefined, binary, 'sha256:binary', 1)).toBe('unchanged')
    expect(releaseBaselineStatus({ path: 'SKILL.md', size: 3, contentDigest: 'sha256:original', previewState: 'text' }, undefined, textBase, undefined, undefined)).toBe('checking')
    expect(releaseBaselineStatus(undefined, undefined, { path: 'new.md', content: 'bmV3' })).toBe('added')
    expect(releaseBaselineStatus({ path: 'removed.md', size: 0, contentDigest: 'sha256:removed', previewState: 'unsupported' }, undefined, undefined)).toBe('removed')
    expect(releaseBaselineStatus({ path: 'SKILL.md', size: 3, contentDigest: 'sha256:original', previewState: 'text' }, undefined, textBase, 'sha256:original', 3)).toBe('unchanged')
    expect(releaseBaselineStatus({ path: 'SKILL.md', size: 3, contentDigest: 'sha256:original', previewState: 'text' }, undefined, textCurrent, 'sha256:new', 3)).toBe('changed')
  })

  it('marks a resumed replacement as changed without loading its release bytes', () => {
    const manifestEntry = { path: 'SKILL.md', size: 3, contentDigest: 'sha256:release' as const, previewState: 'text' as const }
    const resumedText = { path: 'SKILL.md', content: 'bmV3' }
    const originalBinary = { path: 'assets/logo.bin', content: 'AA==' }
    expect(releaseBaselineStatus(manifestEntry, undefined, resumedText, 'sha256:draft', 3)).toBe('changed')
    expect(releaseBaselineStatus({ path: 'assets/logo.bin', size: 1, contentDigest: 'sha256:binary', previewState: 'binary' }, undefined, originalBinary, 'sha256:binary', 1)).toBe('unchanged')
    expect(releaseBaselineStatus(manifestEntry, undefined, resumedText, 'sha256:release', 3)).toBe('unchanged')
  })

  it('keeps oversized text metadata-only while allowing bounded text editing', () => {
    const oversized = { path: 'oversize.txt', content: btoa('x'.repeat(3_500_000)) }
    const small = { path: 'notes.txt', content: btoa('small text') }
    const oversizedPreview = inspectDraftFile(oversized)
    const smallPreview = inspectDraftFile(small)

    expect(oversizedPreview).toMatchObject({ state: 'oversize', size: 3_500_000, text: null })
    expect(oversizedPreview?.size).toBeGreaterThan(MAX_TEXT_PREVIEW_BYTES)
    expect(smallPreview).toMatchObject({ state: 'text', size: 10, text: 'small text' })
  })
})
