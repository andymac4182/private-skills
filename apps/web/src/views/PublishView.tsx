import { useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { api, ApiError } from '../lib/api'
import { formatBytes } from '../lib/format'
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
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileCountLabel = useMemo(() => `${files.length} file${files.length === 1 ? '' : 's'} · ${formatBytes(files.reduce((sum, item) => sum + item.file.size, 0))}`, [files])

  function chooseFiles(event: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.target.files ?? [])
    const next = selected.map((file) => ({ path: file.webkitRelativePath || file.name, file }))
    const unique = new Map(next.map((item) => [item.path, item]))
    setFiles([...unique.values()].sort((left, right) => left.path.localeCompare(right.path)))
    setError(null)
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!/^@[a-z0-9-]+\/[a-z0-9-]+$/.test(name.trim())) {
      setError('Use a namespaced skill name such as @team/review.')
      return
    }
    if (!version.trim()) {
      setError('Enter an immutable semantic version.')
      return
    }
    if (files.length === 0) {
      setError('Choose the complete skill directory before publishing.')
      return
    }
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const bundle = await toBundle(files)
      const response = await api.publish({ name: name.trim(), version: version.trim(), description: description.trim(), bundle })
      setResult(response.operation ? `Ingestion queued as ${response.operation.id}. Review its scan and policy state in Operations.` : `Published ${response.skill?.name ?? name.trim()}@${response.skill?.version ?? version.trim()}.`)
      setFiles([])
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Publish request failed.')
    } finally {
      setBusy(false)
    }
  }

  return <div className="view-heading"><div><span className="eyebrow">Native release</span><h1>Publish a skill</h1><p className="muted">Upload the complete directory as a deterministic JSON bundle. The registry validates and scans those exact bytes before distribution.</p></div><Panel title="Release metadata" description="Names and versions are immutable after publication."><form className="form-grid" onSubmit={submit}><Field label="Skill name" hint="Namespaced form, for example @team/review."><input onChange={(event) => setName(event.target.value)} placeholder="@team/review" value={name} /></Field><Field label="Version" hint="Use a semantic version such as 1.2.0."><input onChange={(event) => setVersion(event.target.value)} placeholder="1.2.0" value={version} /></Field><Field label="Description" hint="Shown in the private catalog."><textarea className="short-textarea" onChange={(event) => setDescription(event.target.value)} placeholder="What does this skill help the team do?" value={description} /></Field><div className="full file-drop"><strong>Skill directory</strong><small>Choose a directory or multiple files. The browser sends base64 file bytes in the pskills-bundle-v1 format; scripts are never executed.</small><input {...({ webkitdirectory: '', directory: '' } as Record<string, string>)} multiple onChange={chooseFiles} type="file" /></div>{files.length > 0 && <div className="full file-list"><strong>{fileCountLabel}</strong><ul>{files.slice(0, 40).map((item) => <li key={item.path}>{item.path}</li>)}</ul>{files.length > 40 && <span className="helper">Showing the first 40 paths.</span>}</div>}{error && <div className="full"><Notice kind="error">{error}</Notice></div>}{result && <div className="full"><Notice kind="success">{result} <Link to="/app/$section" params={{ section: 'operations' }}>Open operations</Link></Notice></div>}<div className="form-actions"><Button busy={busy} type="submit">Validate and publish</Button><Link className="button button-quiet" to="/app/$section" params={{ section: 'catalog' }}>Back to catalog</Link></div></form></Panel><Panel title="Before publishing" description="The server is the source of truth for size, path, digest, validation, and scan policy."><div className="helper" style={{ padding: '18px 22px' }}>The upload does not grant access by itself. A release remains pending or quarantined until its current policy permits distribution. Required scanner failures stay blocked.</div></Panel></div>
}
