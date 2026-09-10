import { useEffect, useMemo, useRef, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { formatBytes, shortDigest } from '../lib/format'
import type { DraftView, SkillBundle } from '../lib/types'
import { Badge, Button, ErrorState, LoadingState, Notice } from './Primitives'

interface DraftEditorProps {
  resourceId: string
  baseDigest: `sha256:${string}`
  baseVersion: string
  onClose: () => void
}

const TEXT_EXTENSIONS = new Set(['.cjs', '.css', '.csv', '.go', '.html', '.ini', '.java', '.js', '.json', '.jsx', '.md', '.mdx', '.mjs', '.py', '.rb', '.rs', '.sh', '.sql', '.svg', '.toml', '.ts', '.tsx', '.txt', '.vue', '.xml', '.yaml', '.yml'])

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

function editableText(file: SkillBundle['files'][number]): string | null {
  if (!TEXT_EXTENSIONS.has(extensionFor(file.path)) && !['.editorconfig', '.gitignore', 'dockerfile', 'license', 'makefile', 'readme'].includes(file.path.slice(file.path.lastIndexOf('/') + 1).toLowerCase())) return null
  return decodeBase64Text(file.content)
}

function firstEditableFile(draft: DraftView): SkillBundle['files'][number] | null {
  return draft.files.find((file) => editableText(file) !== null) ?? null
}

export function DraftEditor({ resourceId, baseDigest, baseVersion, onClose }: DraftEditorProps) {
  const [draft, setDraft] = useState<DraftView | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [dirty, setDirty] = useState(false)
  const [creating, setCreating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [version, setVersion] = useState(baseVersion)
  const [message, setMessage] = useState<{ kind: 'success' | 'error' | 'warning'; text: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const requestGeneration = useRef(0)

  const selectedFile = useMemo(() => draft?.files.find((file) => file.path === selectedPath) ?? null, [draft, selectedPath])
  const selectedIsEditable = selectedFile ? editableText(selectedFile) !== null : false

  useEffect(() => () => {
    requestGeneration.current += 1
  }, [])

  useEffect(() => {
    if (!draft || selectedPath) return
    const first = firstEditableFile(draft) ?? draft.files[0]
    if (first) setSelectedPath(first.path)
  }, [draft, selectedPath])

  useEffect(() => {
    if (!selectedFile || dirty) return
    setText(editableText(selectedFile) ?? '')
  }, [dirty, selectedFile])

  async function startDraft() {
    const generation = ++requestGeneration.current
    setCreating(true)
    setError(null)
    setMessage(null)
    try {
      const response = await api.createDraft(resourceId, baseDigest, idempotencyKey('draft-create'))
      if (generation !== requestGeneration.current) return
      setDraft(response.draft)
      setMessage({ kind: 'success', text: response.idempotent ? 'Reopened your existing draft.' : 'Draft created from this release.' })
    } catch (cause) {
      if (generation !== requestGeneration.current) return
      setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not start a draft.')
    } finally {
      if (generation === requestGeneration.current) setCreating(false)
    }
  }

  async function reloadDraft() {
    if (!draft) return
    const generation = ++requestGeneration.current
    setError(null)
    setMessage(null)
    try {
      const response = await api.draft(draft.id)
      if (generation !== requestGeneration.current) return
      setDraft(response.draft)
      setDirty(false)
      setMessage({ kind: 'success', text: `Draft reloaded at revision ${response.draft.revision}.` })
    } catch (cause) {
      if (generation !== requestGeneration.current) return
      setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not reload the draft.')
    }
  }

  function selectFile(path: string) {
    if (path === selectedPath) return
    if (dirty && !window.confirm('Discard unsaved changes to this file?')) return
    setDirty(false)
    setSelectedPath(path)
    setMessage(null)
    setError(null)
  }

  function updateText(value: string) {
    setText(value)
    setDirty(true)
    setMessage(null)
    setError(null)
  }

  async function saveDraft() {
    if (!draft || !selectedFile || !selectedIsEditable || !dirty) return
    const nextFiles = draft.files.map((file) => file.path === selectedFile.path ? { ...file, content: encodeBase64Text(text) } : file)
    const generation = ++requestGeneration.current
    setSaving(true)
    setError(null)
    setMessage(null)
    try {
      const response = await api.updateDraft(draft.id, { expectedRevision: draft.revision, files: nextFiles, idempotencyKey: idempotencyKey('draft-save') })
      if (generation !== requestGeneration.current) return
      setDraft(response.draft)
      setDirty(false)
      setMessage({ kind: 'success', text: `Saved revision ${response.draft.revision}.` })
    } catch (cause) {
      if (generation !== requestGeneration.current) return
      setMessage({ kind: cause instanceof ApiError && cause.status === 409 ? 'warning' : 'error', text: cause instanceof ApiError && cause.status === 409 ? 'This draft changed elsewhere. Reload it before saving again.' : cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not save the draft.' })
    } finally {
      if (generation === requestGeneration.current) setSaving(false)
    }
  }

  async function publishDraft() {
    if (!draft || dirty || publishing) return
    const nextVersion = version.trim()
    if (!/^(?:0|[1-9]\d*)\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(nextVersion)) {
      setMessage({ kind: 'error', text: 'Enter a semantic version such as 0.4.0 before queuing a release.' })
      return
    }
    const generation = ++requestGeneration.current
    setPublishing(true)
    setError(null)
    setMessage(null)
    try {
      const response = await api.publishDraft(draft.id, { expectedRevision: draft.revision, version: nextVersion, idempotencyKey: idempotencyKey('draft-publish') })
      if (generation !== requestGeneration.current) return
      setMessage({ kind: 'success', text: `Release ${response.operation.version} queued for security scanning. It is not approved yet.` })
    } catch (cause) {
      if (generation !== requestGeneration.current) return
      setMessage({ kind: cause instanceof ApiError && cause.status === 409 ? 'warning' : 'error', text: cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not queue the release.' })
    } finally {
      if (generation === requestGeneration.current) setPublishing(false)
    }
  }

  return <section className="draft-editor">
    <header className="draft-editor-header">
      <div><span className="eyebrow">Draft workspace</span><h3>{draft ? draft.name : 'Start a draft from this release'}</h3><p className="helper">Editing creates a separate revision; the selected release stays unchanged.</p></div>
      <div className="row-actions"><Button kind="quiet" type="button" onClick={onClose}>Close</Button>{draft && <Badge value={draft.status} />}</div>
    </header>
    {error && <ErrorState message={error} onRetry={draft ? () => void reloadDraft() : undefined} />}
    {message && <div className="draft-editor-message"><Notice kind={message.kind}>{message.text}</Notice></div>}
    {!draft && <div className="draft-start"><p className="helper">The draft starts with the exact bytes and digest from version <strong>{baseVersion}</strong>. Nothing is saved until you start it.</p><Button kind="secondary" busy={creating} type="button" onClick={() => void startDraft()}>Start draft</Button></div>}
    {draft && <>
      <div className="draft-editor-meta"><span>Revision <strong>{draft.revision}</strong></span><span>Files <strong>{draft.files.length}</strong></span><span>Size <strong>{formatBytes(draft.size)}</strong></span><span title={draft.digest}>Digest <code>{shortDigest(draft.digest)}</code></span></div>
      <div className="draft-editor-layout">
        <aside className="draft-file-tree" aria-label="Draft files"><div className="release-tree-heading"><strong>Files</strong><span>{draft.files.length}</span></div><div className="release-file-list">{draft.files.map((file) => <button className={`release-file-row ${file.path === selectedPath ? 'release-file-row-selected' : ''}`.trim()} key={file.path} type="button" onClick={() => selectFile(file.path)}><span aria-hidden="true">{editableText(file) === null ? '◇' : '▤'}</span><code title={file.path}>{file.path}</code><small>{editableText(file) === null ? 'Metadata only' : 'Editable text'}</small></button>)}</div></aside>
        <div className="draft-editor-main">
          <div className="draft-editor-toolbar"><div><strong>{selectedPath ?? 'No file selected'}</strong>{dirty && <span className="draft-dirty">Unsaved changes</span>}</div>{selectedFile && <span className="helper">{selectedIsEditable ? 'UTF-8 text' : 'Preview unavailable'}</span>}</div>
          {selectedFile && selectedIsEditable ? <textarea aria-label={`Edit ${selectedFile.path}`} className="draft-textarea" spellCheck={false} value={text} onChange={(event) => updateText(event.target.value)} /> : <div className="release-file-placeholder">Select a text file to edit. Binary and unsupported files stay metadata-only.</div>}
          <div className="draft-editor-actions"><Button kind="secondary" busy={saving} disabled={!dirty || !selectedIsEditable} type="button" onClick={() => void saveDraft()}>Save revision</Button><label className="draft-version-field"><span>Next version</span><input aria-label="Next release version" value={version} onChange={(event) => setVersion(event.target.value)} /></label><Button busy={publishing} disabled={dirty} type="button" onClick={() => void publishDraft()}>Queue release scan</Button></div>
        </div>
      </div>
      <footer className="draft-editor-footer"><span className="helper">Revision {draft.revision} is saved on the server. Reload before saving if someone else changed it.</span><Button kind="quiet" type="button" onClick={() => void reloadDraft()}>Reload draft</Button></footer>
    </>}
  </section>
}
