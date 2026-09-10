import { Component, lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import { api, ApiError } from '../lib/api'
import { formatBytes, shortDigest } from '../lib/format'
import type { ReleaseFileView, ReleaseFilesResponse } from '../lib/types'
import { Badge, Button, ErrorState, LoadingState, Notice } from './Primitives'
import { DraftEditor } from './DraftEditor'

const PierreReleaseRenderer = lazy(() => import('./PierreReleaseRenderer').then((module) => ({ default: module.PierreReleaseRenderer })))

interface ReleaseViewerProps {
  resourceId: string
  baseDigest: `sha256:${string}`
  baseVersion: string
  canEdit: boolean
  resumeDraftId?: string
  onDraftChange?: (draft: import('../lib/types').DraftView) => void
  onDraftDirty?: (dirty: boolean) => void
  onDraftClose?: () => void
}

interface ErrorBoundaryProps {
  fallback: ReactNode
  children: ReactNode
}

interface ErrorBoundaryState {
  failed: boolean
}

class OptionalRendererBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true }
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

function fileForPath(files: ReleaseFileView[], path: string | null): ReleaseFileView | null {
  return path ? files.find((file) => file.path === path) ?? null : null
}

function firstInspectable(files: ReleaseFileView[]): ReleaseFileView | null {
  return files.find((file) => file.previewState === 'text') ?? files[0] ?? null
}

function displayPreviewState(file: ReleaseFileView): string {
  if (file.previewState === 'text') return 'Text'
  if (file.previewState === 'binary') return 'Binary'
  if (file.previewState === 'oversize') return 'Too large to preview'
  return 'Unsupported preview'
}

export function ReleaseViewer({ resourceId, baseDigest, baseVersion, canEdit, resumeDraftId, onDraftChange, onDraftDirty, onDraftClose }: ReleaseViewerProps) {
  const [open, setOpen] = useState(false)
  const [draftOpen, setDraftOpen] = useState(Boolean(resumeDraftId))
  const [draftCloseRequest, setDraftCloseRequest] = useState(0)
  const [manifest, setManifest] = useState<ReleaseFilesResponse | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [selectedFile, setSelectedFile] = useState<ReleaseFileView | null>(null)
  const [manifestLoading, setManifestLoading] = useState(false)
  const [fileLoading, setFileLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestGeneration = useRef(0)

  useEffect(() => {
    if (resumeDraftId) setDraftOpen(true)
  }, [resumeDraftId])

  async function loadManifest() {
    const generation = ++requestGeneration.current
    setManifestLoading(true)
    setFileLoading(false)
    setError(null)
    setSelectedPath(null)
    setSelectedFile(null)
    try {
      const response = await api.releaseFiles(resourceId)
      if (generation !== requestGeneration.current) return
      setManifest(response)
      const first = firstInspectable(response.files ?? [])
      setSelectedPath(first?.path ?? null)
      setSelectedFile(first?.previewState === 'text' ? null : first)
    } catch (cause) {
      if (generation !== requestGeneration.current) return
      setManifest(null)
      setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not load release files.')
    } finally {
      if (generation === requestGeneration.current) setManifestLoading(false)
    }
  }

  useEffect(() => {
    requestGeneration.current += 1
    setOpen(false)
    setDraftOpen(false)
    setDraftCloseRequest(0)
    setManifest(null)
    setSelectedPath(null)
    setSelectedFile(null)
    setManifestLoading(false)
    setFileLoading(false)
    setError(null)
  }, [resourceId])

  useEffect(() => {
    if (!open || !manifest || !selectedPath) return
    const entry = fileForPath(manifest.files, selectedPath)
    if (!entry) return
    const generation = ++requestGeneration.current
    setSelectedFile(entry.previewState === 'text' ? null : entry)
    setError(null)
    if (entry.previewState !== 'text') {
      setFileLoading(false)
      return
    }

    setFileLoading(true)
    void api.releaseFile(resourceId, selectedPath).then((response) => {
      if (generation !== requestGeneration.current) return
      const content = fileForPath(response.files ?? [], selectedPath)
      if (!content || content.previewState !== 'text' || typeof content.contents !== 'string') {
        setSelectedFile(null)
        setError('This file is available in the release manifest but cannot be previewed.')
        return
      }
      setSelectedFile(content)
    }).catch((cause: unknown) => {
      if (generation !== requestGeneration.current) return
      setSelectedFile(null)
      setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not load this file.')
    }).finally(() => {
      if (generation === requestGeneration.current) setFileLoading(false)
    })
  }, [manifest, open, resourceId, selectedPath])

  function openViewer() {
    if (open) {
      requestGeneration.current += 1
      setOpen(false)
      setManifestLoading(false)
      setFileLoading(false)
      return
    }
    setOpen(true)
    if (!manifest && !manifestLoading) void loadManifest()
  }

  const nativeSurface = manifest && <NativeReleaseSurface
    files={manifest.files}
    selectedPath={selectedPath}
    selectedFile={selectedFile}
    fileLoading={fileLoading}
    onSelect={setSelectedPath}
  />

  return <section className="release-viewer">
    <div className="release-viewer-header">
      <div>
        <span className="eyebrow">Release files</span>
        <h3>Explore files in this version</h3>
        <p className="helper">Read-only view of the selected version.</p>
      </div>
      <div className="row-actions"><Button kind="secondary" type="button" onClick={openViewer}>{open ? 'Hide files' : 'Browse files'}</Button>{canEdit && <Button kind="quiet" type="button" onClick={() => { if (draftOpen) setDraftCloseRequest((current) => current + 1); else { setDraftCloseRequest(0); setDraftOpen(true) } }}>{draftOpen ? 'Hide editor' : 'Open draft editor'}</Button>}</div>
    </div>
    {open && <div className="release-viewer-body">
      {manifestLoading && <LoadingState label="Loading the release manifest…" />}
      {!manifestLoading && error && !manifest && <ErrorState message={error} onRetry={() => void loadManifest()} />}
      {!manifestLoading && manifest && <>
        <div className="release-viewer-meta">
          <span><strong>{manifest.release.fileCount}</strong> file{manifest.release.fileCount === 1 ? '' : 's'}</span>
          <span>Version <strong>{manifest.release.version}</strong></span>
          <span title={manifest.release.digest}>Artifact <code>{shortDigest(manifest.release.digest)}</code></span>
        </div>
        {error && <Notice kind="error">{error}</Notice>}
        <OptionalRendererBoundary fallback={nativeSurface}>
          <Suspense fallback={nativeSurface}>
            {manifest.files.length === 0 ? <div className="release-file-placeholder">This version has no readable files.</div> : <PierreReleaseRenderer
              files={manifest.files}
              selectedPath={selectedPath}
              selectedFile={selectedFile}
              fileLoading={fileLoading}
              onSelect={setSelectedPath}
            />}
          </Suspense>
        </OptionalRendererBoundary>
      </>}
    </div>}
    {draftOpen && <DraftEditor closeRequest={draftCloseRequest} resumeDraftId={resumeDraftId} resourceId={resourceId} baseDigest={baseDigest} baseVersion={baseVersion} onDraftChange={onDraftChange} onDirtyChange={onDraftDirty} onClose={() => { setDraftCloseRequest(0); setDraftOpen(false); onDraftClose?.() }} />}
  </section>
}

function NativeReleaseSurface({ files, selectedPath, selectedFile, fileLoading, onSelect }: { files: ReleaseFileView[]; selectedPath: string | null; selectedFile: ReleaseFileView | null; fileLoading: boolean; onSelect: (path: string) => void }) {
  return <div className="release-viewer-enhanced release-viewer-native">
    <div className="release-viewer-tree" aria-label="Release files">
      <div className="release-tree-heading"><strong>Files</strong><span>{files.length}</span></div>
      <div className="release-file-list">{files.map((file) => <button className={`release-file-row ${selectedPath === file.path ? 'release-file-row-selected' : ''}`.trim()} key={file.path} type="button" onClick={() => onSelect(file.path)}><span aria-hidden="true">{file.previewState === 'text' ? '▤' : '◇'}</span><code title={file.path}>{file.path}</code><small>{displayPreviewState(file)}</small></button>)}</div>
    </div>
    <div className="release-viewer-code">
      {fileLoading && <LoadingState label="Loading file…" />}
      {!fileLoading && selectedFile?.previewState === 'text' && typeof selectedFile.contents === 'string' && <pre className="release-code-fallback"><code>{selectedFile.contents}</code></pre>}
      {!fileLoading && selectedFile && selectedFile.previewState !== 'text' && <div className="release-file-placeholder"><Badge tone="muted" value={displayPreviewState(selectedFile)} /><p>This file remains in the release, but the registry does not expose it as text.</p><span className="helper">{formatBytes(selectedFile.size)} · {shortDigest(selectedFile.contentDigest)}</span></div>}
      {!fileLoading && !selectedFile && <div className="release-file-placeholder">Select a text file to inspect its content.</div>}
    </div>
  </div>
}
