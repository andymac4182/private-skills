import { Component, lazy, Suspense, useEffect, useMemo, useRef, useState, type FormEvent, type MutableRefObject, type ReactNode } from 'react'
import { api, ApiError } from '../lib/api'
import { formatBytes, shortDigest } from '../lib/format'
import type { DraftView, SkillBundle } from '../lib/types'
import { Badge, Button, ErrorState, LoadingState, Notice } from './Primitives'
import type { DraftSurfaceEntry, DraftSurfaceHandle } from './PierreDraftSurface'

const PierreDraftSurface = lazy(() => import('./PierreDraftSurface').then((module) => ({ default: module.PierreDraftSurface })))

interface DraftEditorProps {
  resourceId: string
  baseDigest: `sha256:${string}`
  baseVersion: string
  closeRequest?: number
  onClose: () => void
}

type DraftFile = SkillBundle['files'][number]
type DraftOperation = { draftId: string; revision: number; version?: string; key: string }
interface DraftPersistence { draftId?: string; createKey: string }

const TEXT_EXTENSIONS = new Set(['.cjs', '.css', '.csv', '.go', '.html', '.ini', '.java', '.js', '.json', '.jsx', '.md', '.mdx', '.mjs', '.py', '.rb', '.rs', '.sh', '.sql', '.svg', '.toml', '.ts', '.tsx', '.txt', '.vue', '.xml', '.yaml', '.yml'])
const DRAFT_STORAGE_PREFIX = 'private-skills:draft:'

function idempotencyKey(prefix: string): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `web-${prefix}-${random}`
}

function decodeBase64Text(value: string): string | null {
  try {
    const binary = atob(value)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    if (bytes.includes(0)) return null
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

function encodeBase64Text(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function extensionFor(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  const index = name.lastIndexOf('.')
  return index === -1 ? '' : name.slice(index)
}

function editableText(file: DraftFile | null): string | null {
  if (!file) return null
  const name = file.path.slice(file.path.lastIndexOf('/') + 1).toLowerCase()
  if (!TEXT_EXTENSIONS.has(extensionFor(file.path)) && !['.editorconfig', '.gitignore', 'dockerfile', 'license', 'makefile', 'readme'].includes(name)) return null
  return decodeBase64Text(file.content)
}

function cloneFiles(files: DraftFile[]): DraftFile[] {
  return files.map((file) => ({ ...file }))
}

function filesEqual(left: DraftFile[], right: DraftFile[]): boolean {
  if (left.length !== right.length) return false
  const rightByPath = new Map(right.map((file) => [file.path, file]))
  return left.every((file) => {
    const other = rightByPath.get(file.path)
    return other?.content === file.content && other.executable === file.executable
  })
}

function firstPath(files: DraftFile[]): string | null {
  return files.find((file) => editableText(file) !== null)?.path ?? files[0]?.path ?? null
}

function draftStorageKey(resourceId: string, baseDigest: string): string {
  return `${DRAFT_STORAGE_PREFIX}${encodeURIComponent(resourceId)}:${encodeURIComponent(baseDigest)}`
}

function readPersistence(key: string): DraftPersistence | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const value = JSON.parse(raw) as { draftId?: unknown; createKey?: unknown }
    if (typeof value.createKey !== 'string' || value.createKey.length < 8 || value.createKey.length > 256) return null
    return { createKey: value.createKey, ...(typeof value.draftId === 'string' && value.draftId.length > 0 ? { draftId: value.draftId } : {}) }
  } catch {
    return null
  }
}

function writePersistence(key: string, value: DraftPersistence): void {
  if (typeof window === 'undefined') return
  try { window.localStorage.setItem(key, JSON.stringify(value)) } catch { /* Private browsing may deny storage; memory state remains usable. */ }
}

function clearPersistence(key: string): void {
  if (typeof window === 'undefined') return
  try { window.localStorage.removeItem(key) } catch { /* Ignore storage cleanup failures. */ }
}

function validDraftPath(path: string): string | null {
  const normalized = path.normalize('NFC')
  if (!normalized || normalized !== path || normalized.length > 4_096 || normalized.startsWith('/') || normalized.endsWith('/') || normalized.includes('\\') || normalized.includes(':') || normalized.includes('//') || /[<>:"|?*\u0000-\u001f\u007f]/u.test(normalized)) return 'Use a safe relative file path.'
  for (const segment of normalized.split('/')) {
    if (!segment || segment === '.' || segment === '..' || segment.endsWith('.') || segment.endsWith(' ')) return 'Use a safe relative file path.'
  }
  return null
}

function operationKey(ref: MutableRefObject<DraftOperation | null>, prefix: string, draft: DraftView, version?: string): string {
  const sameOperation = ref.current?.draftId === draft.id && ref.current.revision === draft.revision && ref.current.version === version
  if (!sameOperation || !ref.current) ref.current = { draftId: draft.id, revision: draft.revision, ...(version === undefined ? {} : { version }), key: idempotencyKey(prefix) }
  return ref.current.key
}

interface ErrorBoundaryProps { fallback: ReactNode; children: ReactNode }
interface ErrorBoundaryState { failed: boolean }

class DraftRendererBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false }
  static getDerivedStateFromError(): ErrorBoundaryState { return { failed: true } }
  render() { return this.state.failed ? this.props.fallback : this.props.children }
}

export function DraftEditor({ resourceId, baseDigest, baseVersion, closeRequest = 0, onClose }: DraftEditorProps) {
  const [draft, setDraft] = useState<DraftView | null>(null)
  const [baseFiles, setBaseFiles] = useState<DraftFile[]>([])
  const [workingFiles, setWorkingFiles] = useState<DraftFile[]>([])
  const [renameOrigins, setRenameOrigins] = useState<Record<string, string>>({})
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [mode, setMode] = useState<'edit' | 'diff'>('diff')
  const [creating, setCreating] = useState(false)
  const [resuming, setResuming] = useState(true)
  const [reloading, setReloading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [version, setVersion] = useState(baseVersion)
  const [newPath, setNewPath] = useState('')
  const [addingFile, setAddingFile] = useState(false)
  const [surfaceRevision, setSurfaceRevision] = useState(0)
  const [message, setMessage] = useState<{ kind: 'success' | 'error' | 'warning'; text: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const requestGeneration = useRef(0)
  const persistence = useRef<DraftPersistence | null>(null)
  const saveOperation = useRef<DraftOperation | null>(null)
  const publishOperation = useRef<DraftOperation | null>(null)
  const surfaceRef = useRef<DraftSurfaceHandle | null>(null)

  const selectedFile = useMemo(() => workingFiles.find((file) => file.path === selectedPath) ?? null, [selectedPath, workingFiles])
  const selectedBaseFile = useMemo(() => {
    const basePath = selectedPath ? renameOrigins[selectedPath] ?? selectedPath : null
    return basePath ? baseFiles.find((file) => file.path === basePath) ?? null : null
  }, [baseFiles, renameOrigins, selectedPath])
  const selectedText = editableText(selectedFile)
  const selectedIsEditable = selectedText !== null
  const entries = useMemo<DraftSurfaceEntry[]>(() => {
    const paths = new Set([...baseFiles.map((file) => file.path), ...workingFiles.map((file) => file.path)])
    return [...paths].sort().map((path) => {
      const base = baseFiles.find((file) => file.path === path)
      const current = workingFiles.find((file) => file.path === path)
      return { path, status: !current ? 'removed' : !base ? 'added' : base.content !== current.content || base.executable !== current.executable ? 'changed' : 'unchanged' }
    })
  }, [baseFiles, workingFiles])
  const hasFileChanges = draft !== null && !filesEqual(baseFiles, workingFiles)
  const liveText = useMemo(() => surfaceRef.current?.readCurrent(), [selectedPath, selectedText, surfaceRevision])
  const hasLiveEdit = mode === 'edit' && selectedIsEditable && liveText !== null && liveText !== selectedText
  const hasChanges = hasFileChanges || hasLiveEdit
  const busy = creating || resuming || reloading || saving || publishing
  const storageKey = draftStorageKey(resourceId, baseDigest)

  function installServerDraft(next: DraftView): void {
    const files = cloneFiles(next.files)
    setDraft(next)
    setBaseFiles(files)
    setWorkingFiles(cloneFiles(files))
    setRenameOrigins({})
    setSelectedPath((current) => current && files.some((file) => file.path === current) ? current : firstPath(files))
    setMode('diff')
    setVersion((current) => current || baseVersion)
    saveOperation.current = null
    publishOperation.current = null
    setSurfaceRevision((current) => current + 1)
  }

  function syncSurfaceFiles(): DraftFile[] {
    if (!selectedFile || !selectedIsEditable) return workingFiles
    const currentText = surfaceRef.current?.readCurrent()
    if (currentText === undefined || currentText === null || currentText === selectedText) return workingFiles
    return workingFiles.map((file) => file.path === selectedFile.path ? { ...file, content: encodeBase64Text(currentText) } : file)
  }

  function getPersistence(): DraftPersistence {
    if (persistence.current) return persistence.current
    const stored = readPersistence(storageKey)
    const next = stored ?? { createKey: idempotencyKey('draft-create') }
    persistence.current = next
    return next
  }

  function requestClose(): void {
    if (creating || resuming || reloading || saving || publishing) {
      setMessage({ kind: 'warning', text: 'Wait for the current registry request to finish before closing.' })
      return
    }
    if (hasChanges && !window.confirm('Keep this draft saved and close the editor? Unsaved changes will stay only in this browser until you save them.')) return
    onClose()
  }

  useEffect(() => {
    const generation = ++requestGeneration.current
    setDraft(null)
    setBaseFiles([])
    setWorkingFiles([])
    setRenameOrigins({})
    setSelectedPath(null)
    setMode('diff')
    setVersion(baseVersion)
    setMessage(null)
    setError(null)
    setResuming(true)
    persistence.current = readPersistence(storageKey)
    saveOperation.current = null
    publishOperation.current = null
    const savedDraftId = persistence.current?.draftId
    if (!savedDraftId) {
      setResuming(false)
      return () => { requestGeneration.current += 1 }
    }
    void api.draft(savedDraftId).then((response) => {
      if (generation !== requestGeneration.current) return
      if (response.draft.baseResourceId !== resourceId || response.draft.baseDigest !== baseDigest) {
        clearPersistence(storageKey)
        persistence.current = null
        setMessage({ kind: 'warning', text: 'The saved draft belongs to another release. Start a new draft here.' })
      } else {
        installServerDraft(response.draft)
        setMessage({ kind: 'success', text: `Resumed draft at revision ${response.draft.revision}.` })
      }
      setResuming(false)
    }).catch((cause: unknown) => {
      if (generation !== requestGeneration.current) return
      if (cause instanceof ApiError && cause.status === 404) {
        clearPersistence(storageKey)
        persistence.current = null
        setMessage({ kind: 'warning', text: 'The saved draft is no longer available. Start a new draft here.' })
      } else {
        setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not resume the saved draft.')
      }
      setResuming(false)
    })
    return () => { requestGeneration.current += 1 }
  }, [baseDigest, baseVersion, resourceId, storageKey])

  useEffect(() => {
    if (closeRequest > 0) requestClose()
  }, [closeRequest])

  async function startDraft(): Promise<void> {
    const generation = ++requestGeneration.current
    const stored = getPersistence()
    writePersistence(storageKey, stored)
    setCreating(true)
    setError(null)
    setMessage(null)
    try {
      const response = await api.createDraft(resourceId, baseDigest, stored.createKey)
      if (generation !== requestGeneration.current) return
      const nextPersistence = { ...stored, draftId: response.draft.id }
      persistence.current = nextPersistence
      writePersistence(storageKey, nextPersistence)
      if (response.draft.baseResourceId !== resourceId || response.draft.baseDigest !== baseDigest) throw new Error('The registry returned a draft for a different release.')
      installServerDraft(response.draft)
      setMessage({ kind: 'success', text: response.idempotent ? 'Reopened your existing draft.' : 'Draft created from this release.' })
    } catch (cause) {
      if (generation !== requestGeneration.current) return
      setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not start a draft.')
    } finally {
      if (generation === requestGeneration.current) setCreating(false)
    }
  }

  async function reloadDraft(): Promise<void> {
    if (!draft || reloading || saving || publishing) return
    if (hasChanges && !window.confirm('Reload the saved revision and discard local changes?')) return
    const generation = ++requestGeneration.current
    setMode('diff')
    setReloading(true)
    setError(null)
    setMessage(null)
    try {
      const response = await api.draft(draft.id)
      if (generation !== requestGeneration.current) return
      if (response.draft.baseResourceId !== resourceId || response.draft.baseDigest !== baseDigest) throw new Error('The registry returned a draft for a different release.')
      installServerDraft(response.draft)
      setMessage({ kind: 'success', text: `Draft reloaded at revision ${response.draft.revision}.` })
    } catch (cause) {
      if (generation !== requestGeneration.current) return
      setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not reload the draft.')
    } finally {
      if (generation === requestGeneration.current) setReloading(false)
    }
  }

  function selectFile(path: string): void {
    if (busy || path === selectedPath) return
    const nextFiles = syncSurfaceFiles()
    setWorkingFiles(nextFiles)
    setMode('diff')
    setSelectedPath(path)
    setMessage(null)
    setError(null)
  }

  function switchMode(next: 'edit' | 'diff'): void {
    if (busy || next === mode) return
    if (next === 'edit' && !selectedIsEditable) {
      setMessage({ kind: 'warning', text: 'Only UTF-8 text files can be edited.' })
      return
    }
    if (next === 'diff') setWorkingFiles(syncSurfaceFiles())
    setMode(next)
  }

  function onPierreContentChange(contents: string): void {
    if (!selectedPath) return
    setWorkingFiles((current) => current.map((file) => file.path === selectedPath ? { ...file, content: encodeBase64Text(contents) } : file))
    setSurfaceRevision((current) => current + 1)
  }

  function addFile(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (busy) return
    const path = newPath.normalize('NFC')
    const pathError = validDraftPath(path)
    if (pathError) { setMessage({ kind: 'error', text: pathError }); return }
    if (entries.some((entry) => entry.path === path)) { setMessage({ kind: 'error', text: 'A file with that path already exists in this draft.' }); return }
    setWorkingFiles((current) => [...current, { path, content: encodeBase64Text('') }])
    setSelectedPath(path)
    setMode('edit')
    setNewPath('')
    setAddingFile(false)
    setMessage({ kind: 'success', text: `${path} added to the draft. Save the revision to persist it.` })
  }

  function renameFile(): void {
    if (busy || !selectedFile || !selectedPath) return
    const path = window.prompt('New relative path', selectedPath)?.normalize('NFC')
    if (!path || path === selectedPath) return
    const pathError = validDraftPath(path)
    if (pathError) { setMessage({ kind: 'error', text: pathError }); return }
    if (entries.some((entry) => entry.path === path)) { setMessage({ kind: 'error', text: 'A file with that path already exists in this draft.' }); return }
    const origin = renameOrigins[selectedPath] ?? (baseFiles.some((file) => file.path === selectedPath) ? selectedPath : undefined)
    const nextFiles = syncSurfaceFiles().map((file) => file.path === selectedPath ? { ...file, path } : file)
    setWorkingFiles(nextFiles)
    setRenameOrigins((current) => {
      const next = { ...current }
      delete next[selectedPath]
      if (origin && origin !== path) next[path] = origin
      return next
    })
    setSelectedPath(path)
    setMode('diff')
    setMessage({ kind: 'success', text: `${selectedPath} renamed locally. Save the revision to persist it.` })
  }

  function removeFile(): void {
    if (busy || !selectedFile || !selectedPath) return
    if (!window.confirm(`Remove ${selectedPath} from this draft?`)) return
    const nextFiles = syncSurfaceFiles().filter((file) => file.path !== selectedPath)
    setWorkingFiles(nextFiles)
    setRenameOrigins((current) => { const next = { ...current }; delete next[selectedPath]; return next })
    setSelectedPath(firstPath(nextFiles) ?? baseFiles.find((file) => file.path !== selectedPath)?.path ?? null)
    setMode('diff')
    setMessage({ kind: 'success', text: `${selectedPath} removed locally. Save the revision to persist it.` })
  }

  function restoreFile(): void {
    if (busy || selectedFile || !selectedBaseFile || !selectedPath) return
    setWorkingFiles((current) => [...current, { ...selectedBaseFile, path: selectedPath }])
    setMessage({ kind: 'success', text: `${selectedPath} restored locally. Save the revision to persist it.` })
  }

  async function saveDraft(): Promise<void> {
    if (!draft || !hasChanges || saving || reloading || publishing) return
    const snapshot = syncSurfaceFiles()
    if (snapshot.length === 0) { setMessage({ kind: 'error', text: 'A draft must contain at least one file.' }); return }
    const generation = ++requestGeneration.current
    const key = operationKey(saveOperation, 'draft-save', draft)
    setMode('diff')
    setWorkingFiles(snapshot)
    setSaving(true)
    setError(null)
    setMessage(null)
    try {
      const response = await api.updateDraft(draft.id, { expectedRevision: draft.revision, files: snapshot, idempotencyKey: key })
      if (generation !== requestGeneration.current) return
      installServerDraft(response.draft)
      saveOperation.current = null
      setMessage({ kind: 'success', text: `Saved revision ${response.draft.revision}.` })
    } catch (cause) {
      if (generation !== requestGeneration.current) return
      setMessage({ kind: cause instanceof ApiError && cause.status === 409 ? 'warning' : 'error', text: cause instanceof ApiError && cause.status === 409 ? 'This draft changed elsewhere. Reload it before saving again.' : cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not save the draft.' })
    } finally {
      if (generation === requestGeneration.current) setSaving(false)
    }
  }

  async function publishDraft(): Promise<void> {
    if (!draft || hasChanges || publishing || saving || reloading) return
    const nextVersion = version.trim()
    if (!nextVersion) { setMessage({ kind: 'error', text: 'Enter a release version before queuing a scan.' }); return }
    const generation = ++requestGeneration.current
    const key = operationKey(publishOperation, 'draft-publish', draft, nextVersion)
    setPublishing(true)
    setError(null)
    setMessage(null)
    try {
      const response = await api.publishDraft(draft.id, { expectedRevision: draft.revision, version: nextVersion, idempotencyKey: key })
      if (generation !== requestGeneration.current) return
      publishOperation.current = null
      setMessage({ kind: 'success', text: `Release ${response.operation.version} queued for security scanning. It is not approved yet.` })
    } catch (cause) {
      if (generation !== requestGeneration.current) return
      setMessage({ kind: cause instanceof ApiError && cause.status === 409 ? 'warning' : 'error', text: cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not queue the release.' })
    } finally {
      if (generation === requestGeneration.current) setPublishing(false)
    }
  }

  const nativeFallback = <NativeDraftSurface entries={entries} selectedPath={selectedPath} baseFile={selectedBaseFile} currentFile={selectedFile} mode={mode} editable={selectedIsEditable} busy={busy} onSelect={selectFile} onContentChange={onPierreContentChange} />

  return <section className="draft-editor">
    <header className="draft-editor-header">
      <div><span className="eyebrow">Draft workspace</span><h3>{draft ? draft.name : 'Start a draft from this release'}</h3><p className="helper">Editing creates a separate revision; the selected release stays unchanged.</p></div>
      <div className="row-actions"><Button kind="quiet" type="button" onClick={requestClose}>Close</Button>{draft && <Badge value={draft.status} />}</div>
    </header>
    {error && <ErrorState message={error} onRetry={draft ? () => void reloadDraft() : undefined} />}
    {message && <div className="draft-editor-message"><Notice kind={message.kind}>{message.text}</Notice></div>}
    {resuming && <LoadingState label="Looking for an open draft…" />}
    {!resuming && !draft && <div className="draft-start"><p className="helper">The draft starts with the exact bytes and digest from version <strong>{baseVersion}</strong>. Nothing is saved until you start it.</p><Button kind="secondary" busy={creating} type="button" onClick={() => void startDraft()}>Start draft</Button></div>}
    {!resuming && draft && <>
      <div className="draft-editor-meta"><span>Revision <strong>{draft.revision}</strong></span><span>Files <strong>{workingFiles.length}</strong></span><span>Size <strong>{formatBytes(draft.size)}</strong></span><span title={draft.digest}>Digest <code>{shortDigest(draft.digest)}</code></span>{hasChanges && <span className="draft-dirty">Local changes</span>}</div>
      <div className="draft-file-actions"><Button kind="quiet" type="button" disabled={busy} onClick={() => setAddingFile((current) => !current)}>{addingFile ? 'Cancel add' : 'Add file'}</Button><Button kind="quiet" type="button" disabled={busy || !selectedFile} onClick={renameFile}>Rename</Button><Button kind="quiet" type="button" disabled={busy || !selectedFile} onClick={removeFile}>Remove</Button>{!selectedFile && selectedBaseFile && <Button kind="quiet" type="button" disabled={busy} onClick={restoreFile}>Restore selected file</Button>}</div>
      {addingFile && <form className="draft-add-file" onSubmit={addFile}><label><span>New relative path</span><input autoFocus value={newPath} onChange={(event) => setNewPath(event.target.value)} placeholder="docs/notes.md" /></label><Button kind="secondary" disabled={busy}>Add file</Button></form>}
      <div className="draft-editor-layout">
        <div className="draft-editor-main draft-editor-surface-main">
          <div className="draft-editor-toolbar"><div><strong>{selectedPath ?? 'No file selected'}</strong>{hasChanges && <span className="draft-dirty">Unsaved changes</span>}</div><div className="draft-view-switch" role="group" aria-label="Draft file view"><button type="button" className={mode === 'diff' ? 'draft-view-active' : ''} disabled={busy} onClick={() => switchMode('diff')}>Diff</button><button type="button" className={mode === 'edit' ? 'draft-view-active' : ''} disabled={busy || !selectedIsEditable} onClick={() => switchMode('edit')}>Edit</button></div></div>
          <DraftRendererBoundary key={`${selectedPath ?? 'none'}:${mode}`} fallback={nativeFallback}><Suspense fallback={<LoadingState label="Loading the file workspace…" />}><PierreDraftSurface ref={surfaceRef} entries={entries} selectedPath={selectedPath} baseFile={selectedBaseFile} currentFile={selectedFile} mode={mode} editable={selectedIsEditable} busy={busy} onSelect={selectFile} onEditChange={() => setSurfaceRevision((current) => current + 1)} onContentChange={onPierreContentChange} /></Suspense></DraftRendererBoundary>
          <div className="draft-editor-actions"><Button kind="secondary" busy={saving} disabled={!hasChanges || busy && !saving} type="button" onClick={() => void saveDraft()}>Save revision</Button><label className="draft-version-field"><span>Next version</span><input aria-label="Next release version" disabled={busy} value={version} onChange={(event) => { publishOperation.current = null; setVersion(event.target.value) }} /></label><Button busy={publishing} disabled={hasChanges || busy && !publishing} type="button" onClick={() => void publishDraft()}>Queue release scan</Button></div>
        </div>
      </div>
      <footer className="draft-editor-footer"><span className="helper">Revision {draft.revision} is saved on the server. Reload before saving if someone else changed it.</span><Button kind="quiet" disabled={busy} type="button" onClick={() => void reloadDraft()}>Reload draft</Button></footer>
    </>}
  </section>
}

function NativeDraftSurface({ entries, selectedPath, baseFile, currentFile, mode, editable, busy, onSelect, onContentChange }: { entries: DraftSurfaceEntry[]; selectedPath: string | null; baseFile: DraftFile | null; currentFile: DraftFile | null; mode: 'edit' | 'diff'; editable: boolean; busy: boolean; onSelect: (path: string) => void; onContentChange: (contents: string) => void }) {
  const text = editableText(currentFile)
  const baseText = editableText(baseFile)
  return <div className="draft-surface draft-surface-native">
    <aside className="draft-surface-tree" aria-label="Draft files"><div className="release-tree-heading"><strong>Files</strong><span>{entries.length}</span></div><div className="release-file-list">{entries.map((entry) => <button className={`release-file-row ${entry.path === selectedPath ? 'release-file-row-selected' : ''}`.trim()} key={entry.path} type="button" disabled={busy} onClick={() => onSelect(entry.path)}><span aria-hidden="true">{entry.status === 'removed' ? '−' : entry.status === 'added' ? '+' : '▤'}</span><code title={entry.path}>{entry.path}</code><small>{entry.status}</small></button>)}</div></aside>
    <div className="draft-surface-code">{mode === 'edit' && editable && text !== null ? <textarea aria-label={`Edit ${selectedPath ?? 'file'}`} className="draft-textarea" disabled={busy} spellCheck={false} value={text} onChange={(event) => onContentChange(event.target.value)} /> : mode === 'diff' && (baseText !== null || text !== null) ? <div className="draft-native-diff"><div><span>Before</span><pre>{baseText ?? '(new file)'}</pre></div><div><span>After</span><pre>{text ?? '(removed file)'}</pre></div></div> : <div className="release-file-placeholder"><Badge tone="muted" value="Metadata only" /><p>This file cannot be edited or previewed as UTF-8 text.</p></div>}</div>
  </div>
}
