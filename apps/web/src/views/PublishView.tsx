import { useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { api, ApiError } from '../lib/api'
import { formatBytes } from '../lib/format'
import { normalizeSelectedPaths, UploadPathError } from '../lib/upload'
import type { DraftView } from '../lib/types'
import { DraftEditor } from '../components/DraftEditor'
import { Button, Field, Notice, Panel } from '../components/Primitives'

interface UploadFile {
  path: string
  file: File
}

function toBase64(bytes: Uint8Array) {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)))
  }
  return btoa(binary)
}

function idempotencyKey(prefix: string): string {
  const suffix = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `web-${prefix}-${suffix}`
}

async function toBundle(files: UploadFile[]) {
  const sorted = [...files].sort((left, right) => left.path.localeCompare(right.path))
  return {
    format: 'pskills-bundle-v1' as const,
    files: await Promise.all(sorted.map(async ({ path, file }) => ({
      path,
      content: toBase64(new Uint8Array(await file.arrayBuffer())),
    }))),
  }
}

export function PublishView() {
  const [name, setName] = useState('')
  const [version, setVersion] = useState('')
  const [description, setDescription] = useState('')
  const [files, setFiles] = useState<UploadFile[]>([])
  const [busy, setBusy] = useState(false)
  const [draftBusy, setDraftBusy] = useState(false)
  const [uploadDraft, setUploadDraft] = useState<DraftView | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileCountLabel = useMemo(() => `${files.length} file${files.length === 1 ? '' : 's'} · ${formatBytes(files.reduce((sum, item) => sum + item.file.size, 0))}`, [files])

  function chooseFiles(event: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.target.files ?? [])
    try {
      const paths = normalizeSelectedPaths(selected.map((file) => file.webkitRelativePath || file.name))
      const next = selected.map((file, index) => ({ path: paths[index]!, file }))
      setFiles(next.sort((left, right) => left.path.localeCompare(right.path)))
      setError(null)
    } catch (cause) {
      setFiles([])
      setError(cause instanceof UploadPathError ? cause.message : 'Could not read the selected files.')
    }
  }

  function validateNameAndFiles(action: 'publishing' | 'saving a draft'): boolean {
    if (!/^@[a-z0-9-]+\/[a-z0-9-]+$/.test(name.trim())) {
      setError('Use a namespaced skill name such as @team/review.')
      return false
    }
    if (files.length === 0) {
      setError(`Choose the complete skill directory before ${action}.`)
      return false
    }
    return true
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!validateNameAndFiles('publishing')) return
    if (!version.trim()) {
      setError('Enter an immutable semantic version.')
      return
    }
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const bundle = await toBundle(files)
      const response = await api.publish({ name: name.trim(), version: version.trim(), description: description.trim(), bundle })
      setResult(response.operation ? 'Release submitted for review. Follow its progress in Operations.' : `Published ${response.skill?.name ?? name.trim()}@${response.skill?.version ?? version.trim()}.`)
      setFiles([])
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Publish request failed.')
    } finally {
      setBusy(false)
    }
  }

  async function saveAsDraft() {
    if (!validateNameAndFiles('saving a draft')) return
    setDraftBusy(true)
    setError(null)
    setResult(null)
    try {
      const bundle = await toBundle(files)
      const response = await api.createUploadDraft({ name: name.trim(), files: bundle.files, idempotencyKey: idempotencyKey('draft-create') })
      setUploadDraft(response.draft)
      setResult(`Editable draft saved at revision ${response.draft.revision}. Review it below before publishing.`)
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not save the upload as a draft.')
    } finally {
      setDraftBusy(false)
    }
  }

  return <div className="view-heading">
    <div><span className="eyebrow">New release</span><h1>Publish a skill</h1><p className="muted">Add a complete skill folder. We check its files and security before anyone can install it.</p></div>
    <Panel title="Release details" description="Give this release a name, version, and short description.">
      <form className="form-grid" onSubmit={submit}>
        <Field label="Skill name" hint="Use a team namespace, such as @team/review."><input onChange={(event) => setName(event.target.value)} placeholder="@team/review" value={name} /></Field>
        <Field label="Version" hint="Choose an immutable semantic version such as 1.2.0."><input onChange={(event) => setVersion(event.target.value)} placeholder="1.2.0" value={version} /></Field>
        <Field label="Description" hint="Shown in the private catalog."><textarea className="short-textarea" onChange={(event) => setDescription(event.target.value)} placeholder="What does this skill help the team do?" value={description} /></Field>
        <div className="full file-drop"><strong>Skill files</strong><small>Choose the full folder, including SKILL.md. Nested folders stay in the release, and files are checked before publishing.</small><input {...({ webkitdirectory: '', directory: '' } as Record<string, string>)} multiple onChange={chooseFiles} type="file" /></div>
        {files.length > 0 && <div className="full file-list"><strong>{fileCountLabel}</strong><ul>{files.slice(0, 40).map((item) => <li key={item.path}>{item.path}</li>)}</ul>{files.length > 40 && <span className="helper">Showing the first 40 paths.</span>}</div>}
        {error && <div className="full"><Notice kind="error">{error}</Notice></div>}
        {result && <div className="full"><Notice kind="success">{result} <Link to="/app/$section" params={{ section: 'operations' }}>Open operations</Link></Notice></div>}
        <div className="form-actions"><Button busy={busy} type="submit">Publish release</Button><Button kind="secondary" busy={draftBusy} disabled={busy} type="button" onClick={() => void saveAsDraft()}>Save editable draft</Button><Link className="button button-quiet" to="/app/$section" params={{ section: 'catalog' }}>Back to catalog</Link></div>
      </form>
    </Panel>
    {uploadDraft && <Panel title="Editable upload draft" description="Work on the saved revision before you queue a release scan."><DraftEditor initialDraft={uploadDraft} resourceId={`upload:${uploadDraft.id}`} baseDigest={uploadDraft.digest} baseVersion="upload draft" onClose={() => setUploadDraft(null)} /></Panel>}
    <Panel title="What happens next" description="The release becomes available after its checks pass."><div className="helper" style={{ padding: '18px 22px' }}>Publishing starts a review. The release stays private while the registry checks its files and required security reviews complete.</div></Panel>
  </div>
}
