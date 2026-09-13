import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import { EditProvider, File as PierreFile, FileDiff } from '@pierre/diffs/react'
import { Editor, type EditorFactory } from '@pierre/diffs/edit'
import { parseDiffFromFile, type FileContents } from '@pierre/diffs'
import { FileTree, useFileTree } from '@pierre/trees/react'
import type { ReleaseFilePreviewState, SkillBundle } from '../lib/types'
import { formatBytes } from '../lib/format'
import { Badge, LoadingState } from './Primitives'
import type { DraftWorkingFile } from './DraftEditor'
import { onPierrePostRender, PIERRE_ACCESSIBLE_CSS } from './pierreAccessibility'

type DraftFile = SkillBundle['files'][number]

export interface DraftSurfaceEntry {
  path: string
  status: 'added' | 'changed' | 'removed' | 'unchanged' | 'checking' | 'unknown'
}

export interface DraftSurfaceHandle {
  readCurrent(): string | null
}

interface PierreDraftSurfaceProps {
  draftId: string
  draftRevision: number
  draftDigest: `sha256:${string}`
  entries: DraftSurfaceEntry[]
  selectedPath: string | null
  baseFile: DraftFile | null
  currentFile: DraftWorkingFile | null
  currentPreviewState: ReleaseFilePreviewState | null
  currentPreviewSize: number | null
  basePreviewState: ReleaseFilePreviewState | null
  basePreviewSize: number | null
  maxPreviewBytes: number
  mode: 'edit' | 'diff'
  editable: boolean
  busy: boolean
  baseLoading: boolean
  baseError: string | null
  onSelect: (path: string) => void
  onEditChange: (contents: string) => void
  onContentChange: (contents: string) => void
}

function decodeText(value: string, maxPreviewBytes: number): string | null {
  try {
    const binary = atob(value)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    if (bytes.includes(0)) return null
    if (bytes.byteLength > maxPreviewBytes) return null
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

const TEXT_EXTENSIONS = new Set(['c', 'cc', 'cfg', 'conf', 'cpp', 'css', 'csv', 'go', 'h', 'hpp', 'html', 'ini', 'java', 'js', 'json', 'jsx', 'md', 'mjs', 'mts', 'py', 'rs', 'sh', 'sql', 'toml', 'ts', 'tsx', 'txt', 'xml', 'yaml', 'yml'])
const BINARY_EXTENSIONS = new Set(['7z', 'avi', 'bin', 'bmp', 'class', 'dll', 'doc', 'docx', 'gif', 'gz', 'ico', 'jar', 'jpeg', 'jpg', 'mp3', 'mp4', 'pdf', 'png', 'so', 'tar', 'wasm', 'webp', 'woff', 'woff2', 'zip'])
const TEXT_FILENAMES = new Set(['.editorconfig', '.gitignore', '.npmignore', 'dockerfile', 'license', 'makefile', 'readme'])

function extensionFor(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  const index = name.lastIndexOf('.')
  return index > 0 ? name.slice(index + 1) : ''
}

function isSupportedTextPath(path: string): boolean {
  const basename = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  return TEXT_FILENAMES.has(basename) || TEXT_EXTENSIONS.has(extensionFor(path))
}

function toFile(file: DraftFile | DraftWorkingFile | null, maxPreviewBytes: number): FileContents | null {
  if (!file || typeof file.content !== 'string' || !isSupportedTextPath(file.path) || BINARY_EXTENSIONS.has(extensionFor(file.path))) return null
  const contents = decodeText(file.content, maxPreviewBytes)
  if (contents === null) return null
  return { name: file.path, contents, cacheKey: file.content }
}

function previewLabel(state: ReleaseFilePreviewState | null): string {
  if (state === 'oversize') return 'Too large to preview'
  if (state === 'binary') return 'Binary file'
  if (state === 'unsupported') return 'Unsupported preview'
  if (state === 'text') return 'Metadata only'
  return 'No preview'
}

function previewReason(state: ReleaseFilePreviewState | null, maxPreviewBytes: number): string {
  if (state === 'oversize') return `Text previews are limited to ${formatBytes(maxPreviewBytes)}.`
  if (state === 'binary') return 'Binary files remain available in the release but are not opened as text.'
  if (state === 'unsupported') return 'This path is not an allowed text preview type.'
  if (state === 'text') return 'The file is available as text after its release baseline is loaded.'
  return 'This file is available in the release manifest, but no text preview is available.'
}

const createEditor: EditorFactory<undefined, undefined> = (editorType, options, editStateKey) => new Editor(editorType, options, editStateKey)

export function pierreEditStateKey(draftId: string, revision: number, digest: `sha256:${string}`, path: string): string {
  return `draft:${draftId}:${revision}:${digest}:${path}`
}

export const PierreDraftSurface = forwardRef<DraftSurfaceHandle, PierreDraftSurfaceProps>(function PierreDraftSurface({ draftId, draftRevision, draftDigest, entries, selectedPath, baseFile, currentFile, currentPreviewState, currentPreviewSize, basePreviewState, basePreviewSize, maxPreviewBytes, mode, editable, busy, baseLoading, baseError, onSelect, onEditChange, onContentChange }, ref) {
  const paths = useMemo(() => entries.map((entry) => entry.path), [entries])
  const pathsRef = useRef(paths)
  const onSelectRef = useRef(onSelect)
  const syncingSelection = useRef(false)
  pathsRef.current = paths
  onSelectRef.current = onSelect
  const { model } = useFileTree({
    paths,
    initialExpansion: 'open',
    initialSelectedPaths: selectedPath ? [selectedPath] : [],
    onSelectionChange: (selected: readonly string[]) => {
      if (syncingSelection.current) return
      const candidate = selected[selected.length - 1]
      if (candidate && pathsRef.current.includes(candidate)) onSelectRef.current(candidate)
    },
  })
  const previousPaths = useRef<readonly string[] | null>(null)
  const current = useMemo(() => toFile(currentFile, maxPreviewBytes), [currentFile?.path, currentFile?.content, maxPreviewBytes])
  const base = useMemo(() => toFile(baseFile, maxPreviewBytes), [baseFile?.path, baseFile?.content, maxPreviewBytes])
  const latestContents = useRef<string | null>(current?.contents ?? null)

  useEffect(() => {
    const previous = previousPaths.current
    if (previous === null) {
      previousPaths.current = paths
      return
    }
    const unchanged = previous.length === paths.length && previous.every((path, index) => path === paths[index])
    if (unchanged) return
    model.resetPaths(paths)
    previousPaths.current = paths
  }, [model, paths])

  useEffect(() => {
    latestContents.current = current?.contents ?? null
  }, [current?.name, current?.cacheKey])

  useEffect(() => {
    const selected = model.getSelectedPaths()
    const stale = selected.filter((path) => path !== selectedPath)
    if (stale.length === 0 && (!selectedPath || selected.includes(selectedPath))) return
    syncingSelection.current = true
    try {
      for (const path of stale) model.getItem(path)?.deselect()
      if (selectedPath) model.getItem(selectedPath)?.select()
    } finally {
      syncingSelection.current = false
    }
  }, [model, selectedPath])

  useImperativeHandle(ref, () => ({
    readCurrent: () => latestContents.current,
  }), [])

  const diff = useMemo(() => {
    if (!base && !current) return null
    return parseDiffFromFile(base, current, { context: 3 })
  }, [base, current])
  const canShowDiff = (currentFile === null || currentPreviewState === 'text') && (baseFile ? basePreviewState === 'text' : basePreviewState === null)
  const baseUnavailable = baseFile === null && basePreviewState !== null && basePreviewState !== 'text'
  const placeholderState = baseUnavailable ? basePreviewState : currentPreviewState ?? basePreviewState
  const placeholderSize = currentPreviewSize ?? basePreviewSize

  return <div className="draft-surface">
    <div className="draft-surface-tree" aria-label="Draft files">
      <FileTree header={<strong>Files</strong>} model={model} style={{ height: '100%', minHeight: 220 }} />
      {entries.length > 0 && <div className="draft-surface-tree-status"><span>{entries.filter((entry) => entry.status === 'checking').length > 0 ? `${entries.filter((entry) => entry.status === 'checking').length} checking` : `${entries.filter((entry) => entry.status === 'changed' || entry.status === 'added' || entry.status === 'removed').length} changed`}</span><span>{busy ? 'Saving is in progress' : 'Select a file to continue'}</span></div>}
    </div>
    <div className="draft-surface-code">
      {baseLoading ? <LoadingState label="Loading the release baseline…" /> : baseError ? <div className="release-file-placeholder"><Badge tone="muted" value="Baseline unavailable" /><p>{baseError}</p></div> : mode === 'edit' && editable && current ? <EditProvider createEditor={createEditor}><PierreFile
        key={`edit:${draftId}:${draftRevision}:${draftDigest}:${current.name}:${current.cacheKey ?? ''}`}
        className="draft-pierre-file"
        file={current}
        edit
        editStateKey={pierreEditStateKey(draftId, draftRevision, draftDigest, current.name)}
        options={{ overflow: 'scroll', themeType: 'light', theme: 'github-light', stickyHeader: true, unsafeCSS: PIERRE_ACCESSIBLE_CSS, onPostRender: onPierrePostRender }}
        disableWorkerPool
        onEditChange={(event) => { latestContents.current = event.file.contents; onEditChange(event.file.contents) }}
        onEditComplete={(event) => { onContentChange(event.file.contents); return 'accept' }}
      /></EditProvider> : canShowDiff && diff ? <FileDiff
        key={`diff:${diff.name}:${diff.cacheKey ?? ''}:${diff.type}`}
        className="draft-pierre-file"
        fileDiff={diff}
        options={{ diffStyle: 'split', overflow: 'scroll', themeType: 'light', theme: 'github-light', stickyHeader: true, unsafeCSS: PIERRE_ACCESSIBLE_CSS, onPostRender: onPierrePostRender }}
        disableWorkerPool
      /> : <div className="release-file-placeholder"><Badge tone="muted" value={previewLabel(placeholderState)} /><p>{previewReason(placeholderState, maxPreviewBytes)}</p>{placeholderSize !== null && <span className="helper">{formatBytes(placeholderSize)}</span>}</div>}
      {mode === 'edit' && busy && <div className="draft-surface-busy"><LoadingState label="Saving revision…" /></div>}
    </div>
  </div>
})

PierreDraftSurface.displayName = 'PierreDraftSurface'
