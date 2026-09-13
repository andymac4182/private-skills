import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { api, ApiError } from '../lib/api'
import { formatBytes } from '../lib/format'
import { normalizeSelectedPaths, UploadPathError } from '../lib/upload'
import type { DraftView, SkillBundle } from '../lib/types'
import type { AppSectionSearch } from '../routes/app.$section'
import { DraftEditor } from '../components/DraftEditor'
import { Button, Field, LoadingState, Notice, Panel } from '../components/Primitives'

interface UploadFile {
  path: string
  file: File
}

export type UploadDraftValidation = { ok: true } | { ok: false; reason: string }
export type UploadDraftLoadFailure = 'missing' | 'unauthorized' | 'stale' | 'error'

export type UploadDraftLoadResult =
  | { status: 'ready'; draft: DraftView }
  | { status: 'stale'; message: string }

type UploadDraftHydration =
  | { status: 'idle' }
  | { status: 'loading'; draftId: string }
  | { status: 'ready'; draftId: string }
  | { status: 'missing'; draftId: string }
  | { status: 'unauthorized'; draftId: string }
  | { status: 'stale'; draftId: string; message: string }
  | { status: 'error'; draftId: string }

function safeDraftId(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f/\\]/u.test(value)
}

/**
 * Upload drafts are deliberately checked at the publish boundary. The API
 * authorizes the GET, while the UI also refuses to mount a release-origin or
 * otherwise closed draft in the upload editor.
 */
export function validateUploadDraft(draft: DraftView, requestedId: string): UploadDraftValidation {
  if (!safeDraftId(requestedId) || draft.id !== requestedId) {
    return { ok: false, reason: 'This draft link is stale. Start a new upload draft.' }
  }
  if (draft.origin !== 'upload' || draft.baseResourceId !== undefined || draft.baseDigest !== undefined) {
    return { ok: false, reason: 'This link does not identify an upload draft. Start a new upload draft.' }
  }
  if (draft.status !== 'open') {
    return { ok: false, reason: `This upload draft is ${draft.status} and can no longer be edited.` }
  }
  return { ok: true }
}

/**
 * Reload hydration has one read boundary. Keeping it separate from the
 * create handler makes it difficult for a URL load to accidentally POST a
 * second draft.
 */
export async function loadUploadDraft(draftId: string, signal: AbortSignal): Promise<UploadDraftLoadResult> {
  if (!safeDraftId(draftId)) {
    return { status: 'stale', message: 'This draft link is malformed. Start a new upload draft.' }
  }
  const response = await api.draft(draftId, signal)
  const validation = validateUploadDraft(response.draft, draftId)
  return validation.ok
    ? { status: 'ready', draft: response.draft }
    : { status: 'stale', message: validation.reason }
}

type UploadDraftBundle = { format?: SkillBundle['format']; files: ReadonlyArray<SkillBundle['files'][number]> }

export function uploadDraftCreateFingerprint(name: string, bundle: UploadDraftBundle): string {
  return JSON.stringify({ format: bundle.format ?? 'pskills-bundle-v1', name, files: bundle.files })
}

export function classifyUploadDraftError(cause: unknown): UploadDraftLoadFailure {
  if (cause instanceof ApiError) {
    if (cause.status === 401 || cause.status === 403) return 'unauthorized'
    if (cause.status === 404) return 'missing'
    if (cause.status === 409 || cause.code === 'DRAFT_CONFLICT') return 'stale'
  }
  return 'error'
}

function isAbortError(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && (value as { name?: unknown }).name === 'AbortError')
}

function uploadDraftFailureMessage(failure: UploadDraftLoadFailure): string {
  switch (failure) {
    case 'missing': return 'This upload draft is unavailable. It may have been removed or you may not have access to it.'
    case 'unauthorized': return 'Your session is not authorized to resume this upload draft. Sign in again or ask an owner for publisher access.'
    case 'stale': return 'This upload draft is stale and cannot be resumed safely. Start a new upload draft.'
    case 'error': return 'The upload draft could not be loaded. Retry when the registry is available.'
  }
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

export interface UploadDraftCreateIntent {
  fingerprint: string
  key: string
}

/** Keep a deliberate retry bound to the same server-side create record. */
export function uploadDraftCreateKey(
  intent: { current: UploadDraftCreateIntent | null },
  name: string,
  bundle: UploadDraftBundle,
): string {
  const fingerprint = uploadDraftCreateFingerprint(name, bundle)
  if (intent.current?.fingerprint === fingerprint) return intent.current.key
  const key = idempotencyKey('draft-create')
  intent.current = { fingerprint, key }
  return key
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

export function PublishView({ draftSearch }: { draftSearch?: AppSectionSearch }) {
  const [name, setName] = useState('')
  const [version, setVersion] = useState('')
  const [description, setDescription] = useState('')
  const [files, setFiles] = useState<UploadFile[]>([])
  const [busy, setBusy] = useState(false)
  const [draftBusy, setDraftBusy] = useState(false)
  const [uploadDraft, setUploadDraft] = useState<DraftView | null>(null)
  const [draftHydration, setDraftHydration] = useState<UploadDraftHydration>({ status: 'idle' })
  const [draftRetry, setDraftRetry] = useState(0)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()
  const draftLoadGeneration = useRef(0)
  const draftCreateInFlight = useRef(false)
  const draftCreatedInSession = useRef<string | null>(null)
  const draftCreateIntent = useRef<UploadDraftCreateIntent | null>(null)
  const mountedRef = useRef(true)
  const fileCountLabel = useMemo(() => `${files.length} file${files.length === 1 ? '' : 's'} · ${formatBytes(files.reduce((sum, item) => sum + item.file.size, 0))}`, [files])
  const requestedDraftId = draftSearch?.draft
  const requestedDraftIdRef = useRef(requestedDraftId)
  requestedDraftIdRef.current = requestedDraftId

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      draftLoadGeneration.current += 1
    }
  }, [])

  useEffect(() => {
    const generation = ++draftLoadGeneration.current
    if (!requestedDraftId) {
      setUploadDraft(null)
      setDraftHydration({ status: 'idle' })
      return
    }
    // Creation already installed the authoritative response locally. The URL
    // write below makes it durable without immediately re-fetching the same
    // draft; a full reload still enters this effect with an empty ref.
    if (draftCreatedInSession.current === requestedDraftId) {
      draftCreatedInSession.current = null
      return
    }
    draftCreatedInSession.current = null
    if (!safeDraftId(requestedDraftId)) {
      setUploadDraft(null)
      setDraftHydration({ status: 'stale', draftId: requestedDraftId, message: 'This draft link is malformed. Start a new upload draft.' })
      return
    }

    const controller = new AbortController()
    setUploadDraft(null)
    setDraftHydration({ status: 'loading', draftId: requestedDraftId })
    void loadUploadDraft(requestedDraftId, controller.signal).then((loaded) => {
      if (generation !== draftLoadGeneration.current || controller.signal.aborted || requestedDraftIdRef.current !== requestedDraftId) return
      if (loaded.status === 'stale') {
        setUploadDraft(null)
        setDraftHydration({ status: 'stale', draftId: requestedDraftId, message: loaded.message })
        return
      }
      setUploadDraft(loaded.draft)
      setDraftHydration({ status: 'ready', draftId: requestedDraftId })
    }).catch((cause: unknown) => {
      if (generation !== draftLoadGeneration.current || controller.signal.aborted || requestedDraftIdRef.current !== requestedDraftId || isAbortError(cause)) return
      const failure = classifyUploadDraftError(cause)
      setUploadDraft(null)
      setDraftHydration(failure === 'stale'
        ? { status: 'stale', draftId: requestedDraftId, message: uploadDraftFailureMessage(failure) }
        : { status: failure, draftId: requestedDraftId })
    })
    return () => {
      controller.abort()
      if (generation === draftLoadGeneration.current) draftLoadGeneration.current += 1
    }
  }, [draftRetry, requestedDraftId])

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
    if (draftCreateInFlight.current || uploadDraft || draftHydration.status === 'loading') return
    if (!validateNameAndFiles('saving a draft')) return
    draftCreateInFlight.current = true
    const routeAtStart = requestedDraftIdRef.current
    const isCurrentCreate = () => mountedRef.current && requestedDraftIdRef.current === routeAtStart
    setDraftBusy(true)
    setError(null)
    setResult(null)
    try {
      const bundle = await toBundle(files)
      if (!isCurrentCreate()) return
      const trimmedName = name.trim()
      const key = uploadDraftCreateKey(draftCreateIntent, trimmedName, bundle)
      const response = await api.createUploadDraft({ name: trimmedName, files: bundle.files, idempotencyKey: key })
      if (!isCurrentCreate()) return
      const validation = validateUploadDraft(response.draft, response.draft.id)
      if (!validation.ok) throw new Error(validation.reason)
      draftCreatedInSession.current = response.draft.id
      setUploadDraft(response.draft)
      setDraftHydration({ status: 'ready', draftId: response.draft.id })
      setResult(`Editable draft saved at revision ${response.draft.revision}. Review it below before publishing.`)
      void navigate({
        to: '/app/$section',
        params: { section: 'publish' },
        replace: true,
        search: () => ({ draft: response.draft.id }),
      })
    } catch (cause) {
      if (isCurrentCreate()) {
        setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not save the upload as a draft.')
      }
    } finally {
      draftCreateInFlight.current = false
      if (mountedRef.current) setDraftBusy(false)
    }
  }

  function clearDraftLink(): void {
    draftCreatedInSession.current = null
    draftCreateIntent.current = null
    setUploadDraft(null)
    setDraftHydration({ status: 'idle' })
    void navigate({
      to: '/app/$section',
      params: { section: 'publish' },
      replace: true,
      search: () => ({}),
    })
  }

  function retryDraftHydration(): void {
    setDraftRetry((current) => current + 1)
  }

  const hydrationFailure = draftHydration.status === 'missing' || draftHydration.status === 'unauthorized' || draftHydration.status === 'stale' || draftHydration.status === 'error'
    ? draftHydration
    : null

  return <div className="view-heading">
    <div><span className="eyebrow">New release</span><h1>Publish a skill</h1><p className="muted">Add a complete skill folder. We check its files and security before anyone can install it.</p></div>
    {draftHydration.status === 'loading' && <Panel title="Resume upload draft" description="Checking the saved draft with the registry before opening the editor."><LoadingState label="Loading upload draft…" /></Panel>}
    {hydrationFailure && <Panel title="Upload draft unavailable" description="The saved link was not opened in the editor."><div style={{ padding: '0 22px 18px' }}><Notice kind={hydrationFailure.status === 'unauthorized' || hydrationFailure.status === 'error' ? 'error' : 'warning'}>{hydrationFailure.status === 'stale' ? hydrationFailure.message : uploadDraftFailureMessage(hydrationFailure.status)}</Notice><div className="form-actions"><Button kind="secondary" type="button" onClick={retryDraftHydration}>Retry</Button><Button kind="quiet" type="button" onClick={clearDraftLink}>Start a new upload draft</Button></div></div></Panel>}
    <Panel title="Release details" description="Give this release a name, version, and short description.">
      <form className="form-grid" onSubmit={submit}>
        <Field label="Skill name" hint="Use a team namespace, such as @team/review."><input onChange={(event) => setName(event.target.value)} placeholder="@team/review" value={name} /></Field>
        <Field label="Version" hint="Choose an immutable semantic version such as 1.2.0."><input onChange={(event) => setVersion(event.target.value)} placeholder="1.2.0" value={version} /></Field>
        <Field label="Description" hint="Shown in the private catalog."><textarea className="short-textarea" onChange={(event) => setDescription(event.target.value)} placeholder="What does this skill help the team do?" value={description} /></Field>
        <div className="full file-drop"><strong>Skill files</strong><small>Choose the full folder, including SKILL.md. Nested folders stay in the release, and files are checked before publishing.</small><input {...({ webkitdirectory: '', directory: '' } as Record<string, string>)} multiple onChange={chooseFiles} type="file" /></div>
        {files.length > 0 && <div className="full file-list"><strong>{fileCountLabel}</strong><ul>{files.slice(0, 40).map((item) => <li key={item.path}>{item.path}</li>)}</ul>{files.length > 40 && <span className="helper">Showing the first 40 paths.</span>}</div>}
        {error && <div className="full"><Notice kind="error">{error}</Notice></div>}
        {result && <div className="full"><Notice kind="success">{result} <Link to="/app/$section" params={{ section: 'operations' }}>Open operations</Link></Notice></div>}
        <div className="form-actions"><Button busy={busy} type="submit">Publish release</Button><Button kind="secondary" busy={draftBusy} disabled={busy || Boolean(uploadDraft) || draftHydration.status === 'loading'} type="button" onClick={() => void saveAsDraft()}>Save editable draft</Button><Link className="button button-quiet" to="/app/$section" params={{ section: 'catalog' }}>Back to catalog</Link></div>
      </form>
    </Panel>
    {uploadDraft && <Panel title="Editable upload draft" description="Work on the saved revision before you queue a release scan."><DraftEditor key={uploadDraft.id} initialDraft={uploadDraft} resourceId={`upload:${uploadDraft.id}`} baseDigest={uploadDraft.digest} baseVersion="upload draft" onClose={clearDraftLink} /></Panel>}
    <Panel title="What happens next" description="The release becomes available after its checks pass."><div className="helper" style={{ padding: '18px 22px' }}>Publishing starts a review. The release stays private while the registry checks its files and required security reviews complete.</div></Panel>
  </div>
}
