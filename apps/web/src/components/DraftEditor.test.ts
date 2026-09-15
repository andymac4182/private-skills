// @vitest-environment jsdom

import { webcrypto } from 'node:crypto'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import { buildDraftDeltaFiles, canonicalDraftFiles, DraftEditor, draftPayloadFingerprint, filterNativeDraftEntries, findingAnnotationLabel, inspectDraftFile, loadImmutableReleaseBaseline, MAX_TEXT_PREVIEW_BYTES, nativeUnifiedDiff, operationKey, releaseBaselineStatus, renameOriginForPath, textLineCount } from './DraftEditor'
import type { DraftSurfaceEntry } from './PierreDraftSurface'
import type { DraftReviewBinding, DraftReviewFinding, DraftReviewJob, DraftReviewResult, DraftReviewsResponse, DraftView, ReleaseFilesResponse } from '../lib/types'

const pierreHarness = vi.hoisted(() => ({ shouldThrow: true, contentsByPath: {} as Record<string, string> }))

vi.mock('@tanstack/react-router', () => ({ useBlocker: () => undefined }))
vi.mock('./PierreDraftSurface', async () => {
  const React = await import('react')
  type PierreHandle = { readCurrent: () => string | null; focus?: () => void }
  type PierreCallback = (contents: string) => void
  const PierreDraftSurface = React.forwardRef<PierreHandle, Record<string, unknown>>((props, ref) => {
    const currentFile = props.currentFile as { path?: unknown } | null | undefined
    const path = typeof currentFile?.path === 'string' ? currentFile.path : null
    const mode = props.mode
    const codeRegionRef = React.useRef<HTMLDivElement>(null)
    React.useImperativeHandle(ref, () => ({ readCurrent: () => path ? pierreHarness.contentsByPath[path] ?? null : null, focus: () => codeRegionRef.current?.focus() }), [path])
    React.useEffect(() => {
      if (pierreHarness.shouldThrow || mode !== 'edit' || !path) return
      const contents = pierreHarness.contentsByPath[path]
      if (contents !== undefined && typeof props.onContentChange === 'function') (props.onContentChange as PierreCallback)(contents)
    }, [mode, path])
    if (pierreHarness.shouldThrow) throw new Error('simulated beta editor failure')
    const onEditChange = typeof props.onEditChange === 'function' ? props.onEditChange as PierreCallback : undefined
    const onContentChange = typeof props.onContentChange === 'function' ? props.onContentChange as PierreCallback : undefined
    const entries = Array.isArray(props.entries) ? props.entries as Array<{ path?: unknown }> : []
    const onSelect = typeof props.onSelect === 'function' ? props.onSelect as (nextPath: string) => void : undefined
    const annotation = props.findingAnnotation as { lineNumber?: unknown; label?: unknown } | null | undefined
    const onClearFindingAnnotation = typeof props.onClearFindingAnnotation === 'function' ? props.onClearFindingAnnotation as () => void : undefined
    function changeContents(): void {
      if (!path) return
      const next = 'edited body\n'
      pierreHarness.contentsByPath[path] = next
      onEditChange?.(next)
      onContentChange?.(next)
    }
    const keyboardHelpId = typeof props.keyboardHelpId === 'string' ? props.keyboardHelpId : undefined
    return React.createElement('div', { 'data-testid': 'mock-pierre' }, React.createElement('div', { ref: codeRegionRef, className: 'draft-surface-code', tabIndex: -1, 'aria-describedby': mode === 'edit' && keyboardHelpId ? keyboardHelpId : undefined }, annotation && typeof annotation.lineNumber === 'number' && typeof annotation.label === 'string' && React.createElement('div', { 'data-testid': 'mock-finding-location', role: 'status' }, `Review location at line ${annotation.lineNumber}. Read-only inspection.`, onClearFindingAnnotation && React.createElement('button', { type: 'button', onClick: onClearFindingAnnotation }, 'Return to diff')), mode === 'edit' && keyboardHelpId && React.createElement('span', { id: keyboardHelpId, className: 'helper' }, 'Press Escape to leave the editor.'), annotation && typeof annotation.lineNumber === 'number' && typeof annotation.label === 'string' && React.createElement('span', { 'data-testid': 'mock-finding-annotation', 'data-line': annotation.lineNumber }, annotation.label), mode === 'edit' && React.createElement('input', { 'data-testid': 'mock-pierre-search', type: 'search', placeholder: 'Search' }), mode === 'edit' && React.createElement('div', { 'data-testid': 'mock-pierre-content', contentEditable: true, suppressContentEditableWarning: true, tabIndex: 0 }, React.createElement('span', null, 'editor')), mode === 'edit' && React.createElement('button', { type: 'button', 'data-testid': 'mock-pierre-change', onClick: changeContents }, 'Change contents'), ...entries.flatMap((entry) => typeof entry.path === 'string' ? [React.createElement('button', { key: entry.path, type: 'button', 'data-testid': `mock-pierre-select-${entry.path}`, onClick: () => onSelect?.(entry.path as string) }, entry.path)] : [])))
  })
  return { PierreDraftSurface }
})

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
  files: [{ path: 'SKILL.md', size: 4, digest: 'sha256:' + 'd'.repeat(64) as `sha256:${string}` }],
  status: 'open',
  actor: 'owner',
  createdAt: '2026-09-10T00:00:00.000Z',
  updatedAt: '2026-09-10T00:00:00.000Z',
}

const firstFiles = [
  { path: 'z.txt', content: 'eg==' },
  { path: 'a.txt', content: 'YQ==' },
]

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
}

describe('draft editor persistence identities', () => {
  it('renders a bounded unified fallback while preserving additions and removals', () => {
    expect(nativeUnifiedDiff('same\nold', 'same\nnew')).toBe('  same\n- old\n+ new')
    expect(nativeUnifiedDiff(null, 'new')).toBe('+ new')
    expect(nativeUnifiedDiff('old', null)).toBe('- old')
  })

  it('matches Pierre line boundaries for empty and newline-terminated text', () => {
    expect(textLineCount('')).toBe(0)
    expect(textLineCount('one')).toBe(1)
    expect(textLineCount('one\n')).toBe(1)
    expect(textLineCount('one\ntwo\n')).toBe(2)
    expect(textLineCount('one\r\ntwo')).toBe(2)
    expect(textLineCount('one\rtwo')).toBe(1)
  })

  it('bounds review annotation labels while retaining literal finding text', () => {
    const finding: DraftReviewFinding = {
      id: 'finding-label',
      severity: 'medium',
      category: 'quality',
      title: '<title>',
      summary: '<summary>' + 'x'.repeat(500),
      decision: 'open',
    }
    const label = findingAnnotationLabel(finding)
    expect(label).toContain('<title>: <summary>')
    expect(label.length).toBe(280)
    expect(label.endsWith('…')).toBe(true)
  })

  it('filters native fallback paths case-insensitively without changing path identity', () => {
    const entries: DraftSurfaceEntry[] = [
      { path: 'packs/000/nested/skill/SKILL.md', status: 'unchanged' },
      { path: 'packs/100/nested/skill/deeper/SKILL.md', status: 'added' },
    ]

    expect(filterNativeDraftEntries(entries, 'DEEPER/SKILL')).toEqual([entries[1]])
    expect(filterNativeDraftEntries(entries, '   ')).toEqual(entries)
  })

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

  it('binds sparse save identity to references and their saved revision', async () => {
    const digest = 'sha256:' + 'a'.repeat(64) as `sha256:${string}`
    const sparse = [{ path: 'assets/final.bin', sourcePath: 'assets/original.bin', digest }]
    const same = await draftPayloadFingerprint(sparse, { expectedRevision: 2, expectedDigest: 'sha256:revision-2' })
    const differentSource = await draftPayloadFingerprint([{ ...sparse[0], sourcePath: 'assets/other.bin' }], { expectedRevision: 2, expectedDigest: 'sha256:revision-2' })
    const differentRevision = await draftPayloadFingerprint(sparse, { expectedRevision: 3, expectedDigest: 'sha256:revision-3' })

    expect(canonicalDraftFiles(sparse)).toContain(`"sourcePath":"assets/original.bin"`)
    expect(canonicalDraftFiles(sparse)).toContain(`"digest":"${digest}"`)
    expect(same).not.toBe(differentSource)
    expect(same).not.toBe(differentRevision)
  })

  it('preserves the original saved source across a multi-step rename chain', () => {
    expect(renameOriginForPath(
      'assets/final.bin',
      { 'assets/final.bin': 'assets/original.bin' },
      [{ path: 'assets/original.bin', size: 8, digest: 'sha256:' + 'a'.repeat(64) as `sha256:${string}` }, { path: 'assets/final.bin', size: 3, digest: 'sha256:' + 'b'.repeat(64) as `sha256:${string}` }],
      [{ path: 'assets/original.bin' }, { path: 'assets/final.bin' }],
    )).toBe('assets/original.bin')
  })

  it('sends unchanged large and renamed files as digest references while omitting deletions', async () => {
    const largeContent = btoa('x'.repeat(3_500_000))
    const largeDigest = 'sha256:' + 'a'.repeat(64) as `sha256:${string}`
    const notesDigest = 'sha256:' + 'b'.repeat(64) as `sha256:${string}`
    const savedFiles = [
      { path: 'assets/large.bin', size: 3_500_000, digest: largeDigest },
      { path: 'notes.md', size: 16, digest: notesDigest },
      { path: 'removed.txt', size: 9, digest: 'sha256:' + 'c'.repeat(64) as `sha256:${string}` },
    ]
    const workingFiles = [
      { path: 'assets/archive.bin', size: 3_500_000, digest: largeDigest, previewState: 'binary' as const, dirty: false },
      { path: 'notes.md', size: 16, digest: notesDigest, previewState: 'text' as const, dirty: false },
      { path: 'new.md', size: 9, digest: 'sha256:' + '0'.repeat(64) as `sha256:${string}`, content: btoa('new file\n'), previewState: 'text' as const, dirty: true },
    ]
    const fullSavedFiles = [
      { path: 'assets/large.bin', content: largeContent },
      { path: 'notes.md', content: btoa('unchanged notes\n') },
      { path: 'removed.txt', content: btoa('remove me\n') },
    ]

    const delta = await buildDraftDeltaFiles(savedFiles, workingFiles, { 'assets/archive.bin': 'assets/large.bin' })
    const serializedDelta = new TextEncoder().encode(JSON.stringify({ expectedRevision: 1, expectedDigest: 'sha256:saved', files: delta }))
    const serializedFull = new TextEncoder().encode(JSON.stringify({ expectedRevision: 1, expectedDigest: 'sha256:saved', files: fullSavedFiles }))

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

describe('draft editor renderer fallback', () => {
  it('keeps the error fallback read-only while preserving searchable selection', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('crypto', webcrypto)
    const firstPath = 'packs/000/nested/first/SKILL.md'
    const secondPath = 'packs/100/nested/second/SKILL.md'
    const firstText = 'first body\n'
    const secondText = 'second body\n'
    const fallbackDraft: DraftView = {
      ...draft,
      origin: 'upload',
      files: [
        { path: firstPath, size: new TextEncoder().encode(firstText).byteLength, digest: 'sha256:51e5f80e60c2bb85ed6b8e48aa61e0d8f5cd126dc3907af60319a810b476bb1c' },
        { path: secondPath, size: new TextEncoder().encode(secondText).byteLength, digest: 'sha256:a202941a54600108f5b251c071b96b6a1563d219688ce6a773db459a974487a8' },
      ],
    }
    const draftFile = vi.spyOn(api, 'draftFile').mockImplementation(async (_draftId, path) => {
      const text = path === firstPath ? firstText : secondText
      const fileDigest = path === firstPath ? 'sha256:51e5f80e60c2bb85ed6b8e48aa61e0d8f5cd126dc3907af60319a810b476bb1c' : 'sha256:a202941a54600108f5b251c071b96b6a1563d219688ce6a773db459a974487a8'
      return { file: { path, size: new TextEncoder().encode(text).byteLength, digest: fileDigest as `sha256:${string}`, previewState: 'text', content: btoa(text) } }
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    await act(async () => {
      root.render(createElement(DraftEditor, { resourceId: 'upload:test', baseDigest: draft.baseDigest!, baseVersion: '1.0.0', initialDraft: fallbackDraft, onClose: vi.fn() }))
    })

    try {
      expect(draftFile).toHaveBeenCalledWith(fallbackDraft.id, firstPath, { revision: fallbackDraft.revision, digest: fallbackDraft.digest }, expect.any(AbortSignal))
      const draftFileRequest = draftFile.mock.results[0]
      expect(draftFileRequest?.type).toBe('return')
      await act(async () => { await (draftFileRequest as { type: 'return'; value: Promise<unknown> }).value })

      const editButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Edit')
      expect(editButton).toBeDefined()
      expect(editButton?.disabled).toBe(false)
      await act(async () => { editButton?.click() })
      expect(container.querySelector('.release-code-fallback')?.textContent).toBe(firstText)
      expect(container.querySelector('textarea')).toBeNull()

      const search = container.querySelector('input[type="search"]') as HTMLInputElement | null
      expect(search).not.toBeNull()
      const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      expect(inputSetter).toBeDefined()
      await act(async () => {
        inputSetter?.call(search, 'second')
        search?.dispatchEvent(new Event('input', { bubbles: true }))
      })
      expect(Array.from(container.querySelectorAll('.release-file-row code')).map((node) => node.textContent)).toEqual([secondPath])

      await act(async () => {
        search?.focus()
        inputSetter?.call(search, '')
        search?.dispatchEvent(new Event('input', { bubbles: true }))
      })
      const secondButton = Array.from(container.querySelectorAll<HTMLButtonElement>('.release-file-row')).find((button) => button.textContent?.includes(secondPath))
      expect(secondButton).toBeDefined()
      await act(async () => { secondButton?.click() })
      expect(container.querySelector('[aria-current="true"] code')?.textContent).toBe(secondPath)
      expect(container.querySelector('textarea')).toBeNull()
    } finally {
      await act(async () => { root.unmount() })
      document.body.replaceChildren()
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
    }
  })

  it('keeps a loaded editor clean across mode and selection changes until bytes change', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('crypto', webcrypto)
    pierreHarness.shouldThrow = false
    const firstPath = 'packs/000/nested/first/SKILL.md'
    const secondPath = 'packs/100/nested/second/SKILL.md'
    const firstText = 'first body\n'
    const secondText = 'second body\n'
    pierreHarness.contentsByPath = { [firstPath]: firstText, [secondPath]: secondText }
    const cleanDraft: DraftView = {
      ...draft,
      origin: 'upload',
      files: [
        { path: firstPath, size: firstText.length, digest: 'sha256:51e5f80e60c2bb85ed6b8e48aa61e0d8f5cd126dc3907af60319a810b476bb1c' },
        { path: secondPath, size: secondText.length, digest: 'sha256:a202941a54600108f5b251c071b96b6a1563d219688ce6a773db459a974487a8' },
      ],
    }
    const draftFile = vi.spyOn(api, 'draftFile').mockImplementation(async (_draftId, path) => {
      const text = pierreHarness.contentsByPath[path] ?? ''
      const fileDigest = path === firstPath ? cleanDraft.files[0]!.digest : cleanDraft.files[1]!.digest
      return { file: { path, size: text.length, digest: fileDigest, previewState: 'text', content: btoa(text) } }
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    await act(async () => {
      root.render(createElement(DraftEditor, { resourceId: 'upload:test', baseDigest: draft.baseDigest!, baseVersion: '1.0.0', initialDraft: cleanDraft, onClose: vi.fn() }))
    })

    async function settle(): Promise<void> {
      await act(async () => { await flushMicrotasks() })
    }

    try {
      await settle()
      expect(container.querySelector('.draft-dirty')).toBeNull()

      const editButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Edit')
      expect(editButton?.disabled).toBe(false)
      await act(async () => { editButton?.click() })
      await settle()
      expect(container.querySelector('.draft-dirty')).toBeNull()
      const editorHelp = container.querySelector('.draft-editor-main [id$="-keyboard-help"]')
      expect(editorHelp?.textContent).toBe('Press Escape to leave the editor.')
      expect(container.querySelector('.draft-surface-code')?.getAttribute('aria-describedby')).toBe(editorHelp?.id)

      const editable = container.querySelector<HTMLElement>('[data-testid="mock-pierre-content"]')
      expect(editable).not.toBeNull()
      editable?.focus()
      const composingEscape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, composed: true })
      Object.defineProperty(composingEscape, 'isComposing', { value: true })
      await act(async () => { editable?.dispatchEvent(composingEscape) })
      expect(composingEscape.defaultPrevented).toBe(false)
      expect(container.querySelector('.draft-dirty')).toBeNull()

      const modifiedEscape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, composed: true, shiftKey: true })
      await act(async () => { editable?.dispatchEvent(modifiedEscape) })
      expect(modifiedEscape.defaultPrevented).toBe(false)
      expect(container.querySelector('.draft-dirty')).toBeNull()

      const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true, composed: true })
      await act(async () => { editable?.dispatchEvent(tab) })
      expect(tab.defaultPrevented).toBe(false)

      const search = container.querySelector<HTMLInputElement>('[data-testid="mock-pierre-search"]')
      expect(search).not.toBeNull()
      search?.focus()
      const searchEscape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, composed: true })
      await act(async () => { search?.dispatchEvent(searchEscape) })
      expect(searchEscape.defaultPrevented).toBe(false)
      expect(document.activeElement).toBe(search)
      expect(container.querySelector('.draft-dirty')).toBeNull()

      editable?.focus()
      const editorText = editable?.querySelector('span')
      const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, composed: true })
      await act(async () => { editorText?.dispatchEvent(escape) })
      expect(escape.defaultPrevented).toBe(true)
      expect(container.querySelector('.draft-dirty')).toBeNull()
      expect(container.querySelector('.draft-editor-main [id$="-keyboard-help"]')).toBeNull()
      const diffButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Diff')
      expect(diffButton?.getAttribute('aria-pressed')).toBe('true')
      expect(document.activeElement?.textContent).toBe('Edit')

      const selectSecond = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid^="mock-pierre-select-"]')).find((button) => button.textContent === secondPath)
      expect(selectSecond).toBeDefined()
      await act(async () => { selectSecond?.click() })
      await settle()
      expect(container.querySelector('.draft-dirty')).toBeNull()

      const selectFirst = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid^="mock-pierre-select-"]')).find((button) => button.textContent === firstPath)
      expect(selectFirst).toBeDefined()
      await act(async () => { selectFirst?.click() })
      await settle()
      expect(container.querySelector('.draft-dirty')).toBeNull()

      const editAgain = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Edit')
      await act(async () => { editAgain?.click() })
      await settle()
      expect(container.querySelector('.draft-dirty')).toBeNull()
      await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="mock-pierre-change"]')?.click() })
      expect(container.querySelector('.draft-dirty')).not.toBeNull()
    } finally {
      await act(async () => { root.unmount() })
      document.body.replaceChildren()
      draftFile.mockRestore()
      pierreHarness.shouldThrow = true
      pierreHarness.contentsByPath = {}
      vi.unstubAllGlobals()
    }
  })
})

describe('draft editor review finding navigation', () => {
  it('opens a current finding in read-only location mode without saving and clears it before edits', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('crypto', webcrypto)
    pierreHarness.shouldThrow = false
    const firstPath = 'packs/000/nested/first/SKILL.md'
    const secondPath = 'packs/100/nested/second/SKILL.md'
    const firstText = 'first body\n'
    const secondText = 'second body\n'
    const firstDigest = 'sha256:51e5f80e60c2bb85ed6b8e48aa61e0d8f5cd126dc3907af60319a810b476bb1c' as `sha256:${string}`
    const secondDigest = 'sha256:a202941a54600108f5b251c071b96b6a1563d219688ce6a773db459a974487a8' as `sha256:${string}`
    const cleanDraft: DraftView = {
      ...draft,
      origin: 'upload',
      files: [
        { path: firstPath, size: firstText.length, digest: firstDigest },
        { path: secondPath, size: secondText.length, digest: secondDigest },
      ],
    }
    pierreHarness.contentsByPath = { [firstPath]: firstText, [secondPath]: secondText }
    const draftFile = vi.spyOn(api, 'draftFile').mockImplementation(async (_draftId, path) => {
      const text = pierreHarness.contentsByPath[path] ?? ''
      const digest = path === firstPath ? firstDigest : secondDigest
      return { file: { path, size: text.length, digest, previewState: 'text', content: btoa(text) } }
    })
    const reviewFinding: DraftReviewFinding = {
      id: 'finding-location-editor',
      severity: 'high',
      category: 'security',
      title: '<img src=x>',
      summary: '<script>literal finding</script>',
      path: secondPath,
      line: 1,
      decision: 'open',
    }
    const binding: DraftReviewBinding = {
      draftId: cleanDraft.id,
      draftRevision: cleanDraft.revision,
      contentDigest: cleanDraft.digest,
      policyRevision: 'policy-1',
    }
    const reviewResult: DraftReviewResult = {
      id: 'result-location-editor',
      jobId: 'job-location-editor',
      binding,
      model: 'test/reviewer',
      reviewerRevision: 'review-contract-1',
      state: 'passed',
      findings: [reviewFinding],
      createdAt: '2026-09-13T00:00:00.000Z',
      finishedAt: '2026-09-13T00:00:00.000Z',
    }
    const reviewJob: DraftReviewJob = {
      id: reviewResult.jobId,
      binding,
      model: reviewResult.model,
      reviewerRevision: reviewResult.reviewerRevision,
      state: 'passed',
      resultId: reviewResult.id,
      createdAt: reviewResult.createdAt,
      updatedAt: reviewResult.finishedAt,
    }
    const reviews: DraftReviewsResponse = { reviews: [reviewJob], results: [reviewResult] }
    vi.spyOn(api, 'draftReviews').mockResolvedValue(reviews)
    const updateDraft = vi.spyOn(api, 'updateDraft').mockRejectedValue(new Error('unexpected save during navigation'))
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    await act(async () => {
      root.render(createElement(DraftEditor, { resourceId: 'upload:test', baseDigest: draft.baseDigest!, baseVersion: '1.0.0', initialDraft: cleanDraft, onClose: vi.fn() }))
    })

    async function settle(): Promise<void> {
      await act(async () => { await flushMicrotasks() })
    }

    try {
      await settle()
      const reviewTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((button) => button.textContent === 'Review')
      expect(reviewTab).toBeDefined()
      await act(async () => { reviewTab?.click(); await flushMicrotasks() })
      expect(container.textContent).toContain('<img src=x>')
      const location = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Open in editor')
      expect(location).toBeDefined()
      expect(location?.disabled).toBe(false)

      await act(async () => { location?.click(); await flushMicrotasks() })
      await settle()
      expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Files')
      expect(container.querySelector('.draft-editor-toolbar strong')?.textContent).toBe(secondPath)
      const annotation = container.querySelector('[data-testid="mock-finding-annotation"]')
      expect(annotation?.getAttribute('data-line')).toBe('1')
      expect(annotation?.textContent).toBe('<img src=x>: <script>literal finding</script>')
      expect(annotation?.querySelector('img, script')).toBeNull()
      expect(container.querySelector('.draft-dirty')).toBeNull()
      expect(updateDraft).not.toHaveBeenCalled()

      const returnToDiff = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Return to diff')
      expect(returnToDiff).toBeDefined()
      await act(async () => { returnToDiff?.click() })
      expect(container.querySelector('[data-testid="mock-finding-annotation"]')).toBeNull()

      const editButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Edit')
      expect(editButton?.disabled).toBe(false)
      await act(async () => { editButton?.click() })
      await settle()
      await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="mock-pierre-change"]')?.click() })
      expect(container.querySelector('.draft-dirty')).not.toBeNull()
      expect(updateDraft).not.toHaveBeenCalled()
    } finally {
      await act(async () => { root.unmount() })
      document.body.replaceChildren()
      draftFile.mockRestore()
      pierreHarness.shouldThrow = true
      pierreHarness.contentsByPath = {}
      vi.unstubAllGlobals()
    }
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
    expect(baseline.files).toEqual([])
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

  it('keeps an unloaded text path metadata-only and refuses to submit it as changed bytes', async () => {
    const digest = 'sha256:' + 'a'.repeat(64) as `sha256:${string}`
    const metadata = { path: 'docs/notes.md', size: 12, digest, previewState: 'text' as const }
    expect(inspectDraftFile(metadata)).toEqual({ state: 'text', size: 12, text: null })
    await expect(buildDraftDeltaFiles(
      [{ path: metadata.path, size: 8, digest: 'sha256:' + 'b'.repeat(64) as `sha256:${string}` }],
      [{ ...metadata, dirty: true }],
    )).rejects.toThrow('Load docs/notes.md before saving its changes.')
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
