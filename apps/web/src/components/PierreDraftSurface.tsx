import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import { EditProvider, File as PierreFile, FileDiff } from '@pierre/diffs/react'
import { Editor, type EditorFactory } from '@pierre/diffs/edit'
import { parseDiffFromFile, type FileContents } from '@pierre/diffs'
import { FileTree, useFileTree } from '@pierre/trees/react'
import type { SkillBundle } from '../lib/types'
import { Badge, LoadingState } from './Primitives'

type DraftFile = SkillBundle['files'][number]

export interface DraftSurfaceEntry {
  path: string
  status: 'added' | 'changed' | 'removed' | 'unchanged'
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
  currentFile: DraftFile | null
  mode: 'edit' | 'diff'
  editable: boolean
  busy: boolean
  baseLoading: boolean
  baseError: string | null
  onSelect: (path: string) => void
  onEditChange: (contents: string) => void
  onContentChange: (contents: string) => void
}

function decodeText(value: string): string | null {
  try {
    const binary = atob(value)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    if (bytes.includes(0)) return null
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

function toFile(file: DraftFile | null): FileContents | null {
  if (!file) return null
  const contents = decodeText(file.content)
  return contents === null ? null : { name: file.path, contents, cacheKey: file.content }
}

const createEditor: EditorFactory<undefined, undefined> = (editorType, options, editStateKey) => new Editor(editorType, options, editStateKey)

export function pierreEditStateKey(draftId: string, revision: number, digest: `sha256:${string}`, path: string): string {
  return `draft:${draftId}:${revision}:${digest}:${path}`
}

export const PierreDraftSurface = forwardRef<DraftSurfaceHandle, PierreDraftSurfaceProps>(function PierreDraftSurface({ draftId, draftRevision, draftDigest, entries, selectedPath, baseFile, currentFile, mode, editable, busy, baseLoading, baseError, onSelect, onEditChange, onContentChange }, ref) {
  const paths = entries.map((entry) => entry.path)
  const { model } = useFileTree({
    paths,
    initialExpansion: 'open',
    initialSelectedPaths: selectedPath ? [selectedPath] : [],
    onSelectionChange: (selected: readonly string[]) => {
      const candidate = selected[selected.length - 1]
      if (candidate && paths.includes(candidate)) onSelect(candidate)
    },
  })
  const current = useMemo(() => toFile(currentFile), [currentFile?.path, currentFile?.content])
  const base = useMemo(() => toFile(baseFile), [baseFile?.path, baseFile?.content])
  const latestContents = useRef<string | null>(current?.contents ?? null)

  useEffect(() => {
    latestContents.current = current?.contents ?? null
  }, [current?.name, current?.cacheKey])

  useEffect(() => {
    if (!selectedPath) return
    model.getItem(selectedPath)?.select()
  }, [model, selectedPath])

  useImperativeHandle(ref, () => ({
    readCurrent: () => latestContents.current,
  }), [])

  const diff = useMemo(() => {
    if (!base && !current) return null
    return parseDiffFromFile(base, current, { context: 3 })
  }, [base, current])

  return <div className="draft-surface">
    <div className="draft-surface-tree" aria-label="Draft files">
      <FileTree header={<strong>Files</strong>} model={model} style={{ height: '100%', minHeight: 220 }} />
      {entries.length > 0 && <div className="draft-surface-tree-status"><span>{entries.filter((entry) => entry.status !== 'unchanged').length} changed</span><span>{busy ? 'Saving is in progress' : 'Select a file to continue'}</span></div>}
    </div>
    <div className="draft-surface-code">
      {baseLoading ? <LoadingState label="Loading the release baseline…" /> : baseError ? <div className="release-file-placeholder"><Badge tone="muted" value="Baseline unavailable" /><p>{baseError}</p></div> : mode === 'edit' && editable && current ? <EditProvider createEditor={createEditor}><PierreFile
        key={`edit:${draftId}:${draftRevision}:${draftDigest}:${current.name}:${current.cacheKey ?? ''}`}
        className="draft-pierre-file"
        file={current}
        edit
        editStateKey={pierreEditStateKey(draftId, draftRevision, draftDigest, current.name)}
        options={{ overflow: 'scroll', themeType: 'light', theme: 'github-light', stickyHeader: true }}
        disableWorkerPool
        onEditChange={(event) => { latestContents.current = event.file.contents; onEditChange(event.file.contents) }}
        onEditComplete={(event) => { onContentChange(event.file.contents); return 'accept' }}
      /></EditProvider> : diff ? <FileDiff
        key={`diff:${diff.name}:${diff.cacheKey ?? ''}:${diff.type}`}
        className="draft-pierre-file"
        fileDiff={diff}
        options={{ diffStyle: 'split', overflow: 'scroll', themeType: 'light', theme: 'github-light', stickyHeader: true }}
        disableWorkerPool
      /> : <div className="release-file-placeholder"><Badge tone="muted" value="Metadata only" /><p>This file cannot be edited or previewed as UTF-8 text.</p></div>}
      {mode === 'edit' && busy && <div className="draft-surface-busy"><LoadingState label="Saving revision…" /></div>}
    </div>
  </div>
})

PierreDraftSurface.displayName = 'PierreDraftSurface'
