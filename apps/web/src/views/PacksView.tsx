import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { api, ApiError } from '../lib/api'
import { formatDate, shortDigest } from '../lib/format'
import type { PackVersion } from '../lib/types'
import { Button, EmptyState, ErrorState, Field, LoadingState, Notice, Panel } from '../components/Primitives'

export function PacksView() {
  const [packs, setPacks] = useState<PackVersion[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [version, setVersion] = useState('')
  const [description, setDescription] = useState('')
  const [members, setMembers] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  async function load() {
    setError(null)
    try {
      const response = await api.packs()
      setPacks(response.packs ?? [])
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not load packs.')
    }
  }
  useEffect(() => { void load() }, [])

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const memberLines = members.split('\n').map((line) => line.trim()).filter(Boolean)
    const skills = memberLines.map((line) => {
      const match = line.match(/^(.+)@([^@]+)$/)
      return match ? { ref: match[1], version: match[2] } : null
    })
    if (!/^@[a-z0-9-]+\/[a-z0-9-]+$/.test(name.trim()) || !version.trim() || skills.length === 0 || skills.some((skill) => !skill)) {
      setMessage({ kind: 'error', text: 'Enter a namespaced pack, version, and members in @namespace/skill@version form.' })
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      const response = await api.createPack({ name: name.trim(), version: version.trim(), description: description.trim(), skills: skills as Array<{ ref: string; version: string }> })
      setMessage({ kind: 'success', text: `Created ${response.pack.name}@${response.pack.version} with ${response.pack.members.length} pinned member${response.pack.members.length === 1 ? '' : 's'}.` })
      setName(''); setVersion(''); setDescription(''); setMembers('')
      await load()
    } catch (cause) {
      setMessage({ kind: 'error', text: cause instanceof ApiError ? cause.message : 'Pack creation failed.' })
    } finally {
      setBusy(false)
    }
  }

  return <div className="view-heading"><div><span className="eyebrow">Curated releases</span><h1>Packs</h1><p className="muted">Publish exact, approved member sets for repeatable installs across projects and machines.</p></div><div className="grid-2"><Panel title="Create a pack" description="Members are resolved and pinned by the registry at creation time."><form className="form-grid" onSubmit={create}><Field label="Pack name"><input onChange={(event) => setName(event.target.value)} placeholder="@team/web" value={name} /></Field><Field label="Version"><input onChange={(event) => setVersion(event.target.value)} placeholder="1.0.0" value={version} /></Field><Field label="Description"><textarea onChange={(event) => setDescription(event.target.value)} placeholder="Approved web engineering skills" value={description} /></Field><Field label="Members" hint="One ref@version per line. Exact versions keep the pack reproducible."><textarea onChange={(event) => setMembers(event.target.value)} placeholder="@team/review@1.2.0\n@team/accessibility@2.0.1" value={members} /></Field>{message && <div className="full"><Notice kind={message.kind}>{message.text}</Notice></div>}<div className="form-actions"><Button busy={busy} type="submit">Create pack</Button></div></form></Panel><Panel title="Published packs" description="Immutable manifests and member digests returned by the API.">{error ? <ErrorState message={error} onRetry={() => void load()} /> : packs === null ? <LoadingState /> : packs.length === 0 ? <EmptyState title="No packs yet" description="Create the first curated collection once its member skills are approved." action={<Link className="button button-secondary" to="/app/$section" params={{ section: 'catalog' }}>Review catalog</Link>} /> : <div className="table-wrap"><table><thead><tr><th>Pack</th><th>Members</th><th>State</th><th>Published</th></tr></thead><tbody>{packs.map((pack) => <tr key={pack.id}><td><strong>{pack.name}</strong><span className="cell-sub">{pack.version} · {shortDigest(pack.manifestDigest)}</span></td><td>{pack.members.length}</td><td><span className="badge badge-good">{pack.state}</span></td><td>{formatDate(pack.createdAt)}</td></tr>)}</tbody></table></div>}</Panel></div></div>
}
