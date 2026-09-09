import { useEffect, useState, type FormEvent } from 'react'
import { Link } from '@tanstack/react-router'
import { api, ApiError } from '../lib/api'
import { formatDate, shortDigest } from '../lib/format'
import type { PackVersion, SkillsPackManifest, SkillsPackMember } from '../lib/types'
import { Badge, Button, EmptyState, ErrorState, Field, LoadingState, Notice, Panel } from '../components/Primitives'

export function PacksView() {
  const [packs, setPacks] = useState<PackVersion[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [version, setVersion] = useState('')
  const [description, setDescription] = useState('')
  const [members, setMembers] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)
  const [externalPackUrl, setExternalPackUrl] = useState('')
  const [externalPack, setExternalPack] = useState<SkillsPackManifest | null>(null)
  const [externalPackBusy, setExternalPackBusy] = useState(false)
  const [externalPackMessage, setExternalPackMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

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

  async function create(event: FormEvent<HTMLFormElement>) {
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

  async function previewExternalPack(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const candidate = externalPackUrl.trim()
    if (!parseSkillsPackUrl(candidate)) {
      setExternalPack(null)
      setExternalPackMessage({ kind: 'error', text: 'Use a link in the form https://skills.sh/p/<pack-id>.' })
      return
    }
    setExternalPackBusy(true)
    setExternalPack(null)
    setExternalPackMessage(null)
    try {
      const response = await api.directoryPackPreview({ url: candidate })
      setExternalPack(response)
      setExternalPackMessage({ kind: 'success', text: `Preview loaded with ${response.members.length} upstream member${response.members.length === 1 ? '' : 's'}.` })
    } catch (cause) {
      setExternalPackMessage({ kind: 'error', text: cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not preview this external pack.' })
    } finally {
      setExternalPackBusy(false)
    }
  }

  return <div className="view-heading packs-view">
    <div><span className="eyebrow">Curated releases</span><h1>Packs</h1><p className="muted">Create approved collections that install consistently across projects and machines.</p></div>
    <div className="grid-2">
      <Panel title="Create a private pack" description="Members are selected and fixed when you create the pack. External previews do not populate this private list.">
        <form className="form-grid" onSubmit={create}>
          <Field label="Pack name"><input onChange={(event) => setName(event.target.value)} placeholder="@team/web" value={name} /></Field>
          <Field label="Version"><input onChange={(event) => setVersion(event.target.value)} placeholder="1.0.0" value={version} /></Field>
          <Field label="Description"><textarea onChange={(event) => setDescription(event.target.value)} placeholder="Approved web engineering skills" value={description} /></Field>
          <Field label="Members" hint="One private release per line. Fixed versions keep the collection consistent."><textarea onChange={(event) => setMembers(event.target.value)} placeholder="@team/review@1.2.0\n@team/accessibility@2.0.1" value={members} /></Field>
          {message && <div className="full"><Notice kind={message.kind}>{message.text}</Notice></div>}
          <div className="form-actions"><Button busy={busy} type="submit">Create pack</Button></div>
        </form>
      </Panel>
      <Panel title="Published packs" description="Published collections and the skills they include.">
        {error ? <ErrorState message={error} onRetry={() => void load()} /> : packs === null ? <LoadingState /> : packs.length === 0 ? <EmptyState title="No packs yet" description="Create the first curated collection once its member skills are approved." action={<Link className="button button-secondary" to="/app/$section" params={{ section: 'catalog' }}>Review catalog</Link>} /> : <div className="table-wrap"><table><thead><tr><th>Pack</th><th>Members</th><th>State</th><th>Published</th></tr></thead><tbody>{packs.map((pack) => <tr key={pack.id}><td><strong>{pack.name}</strong><span className="cell-sub">{pack.version} · {shortDigest(pack.manifestDigest)}</span></td><td>{pack.members.length}</td><td><span className="badge badge-good">{pack.state}</span></td><td>{formatDate(pack.createdAt)}</td></tr>)}</tbody></table></div>}
      </Panel>
    </div>
    <Panel className="external-pack-panel" title="Preview an unlisted skills.sh pack" description="Private packs stay managed here. Preview an upstream pack by its link before deciding which releases to admit privately.">
      <form className="directory-pack-form" onSubmit={previewExternalPack}>
        <Field label="skills.sh pack link" hint="Anyone with the link can view or install the upstream pack. Previewing it does not create a private pack or bypass the private scanner."><input onChange={(event) => { setExternalPackUrl(event.target.value); setExternalPack(null); setExternalPackMessage(null) }} placeholder="https://skills.sh/p/…" value={externalPackUrl} /></Field>
        <div className="form-actions"><Button busy={externalPackBusy} kind="secondary" type="submit">Preview pack</Button>{externalPack && <a className="button button-primary" href={externalPackUrl.trim()} rel="noreferrer" target="_blank">Open original pack ↗</a>}</div>
        {externalPackMessage && <Notice kind={externalPackMessage.kind}>{externalPackMessage.text}</Notice>}
      </form>
      {externalPack && <ExternalPackPreview pack={externalPack} />}
    </Panel>
  </div>
}

function ExternalPackPreview({ pack }: { pack: SkillsPackManifest }) {
  return <div className="external-pack-preview">
    <div className="external-pack-preview-header"><div><span className="eyebrow eyebrow-cloud">External manifest preview</span><h2>{pack.packUrl}</h2><p className="muted">Source manifest resolved on demand. The contents remain upstream data until a private admission flow is completed.</p></div><Badge tone="muted" value={`schema ${pack.schema}`} /></div>
    <div className="external-pack-meta"><span><strong>{pack.members.length}</strong> upstream member{pack.members.length === 1 ? '' : 's'}</span><span>Manifest <code>{shortDigest(pack.manifestDigest)}</code></span><span>Format <code>{pack.schema}</code></span><span>Source <code title={pack.manifestUrl}>{compactUrl(pack.manifestUrl)}</code></span></div>
    <Notice kind="warning">Preview only. No member bytes were imported and no private pack was created. Each selected member must enter the existing private release, scanner, and policy flow before it can be added to a private pack.</Notice>
    <div className="external-pack-members">{pack.members.map((member) => <ExternalPackMember key={member.name} member={member} />)}</div>
  </div>
}

function ExternalPackMember({ member }: { member: SkillsPackMember }) {
  const format = member.type === 'files' ? 'legacy files' : member.type
  return <article className="external-pack-member"><div className="external-pack-member-heading"><div><strong>{member.name}</strong><span>{member.description}</span></div><Badge tone="muted" value={format} /></div><div className="external-pack-member-meta"><span>Format <strong>{format}</strong></span>{member.files && <span>{member.files.length} declared file{member.files.length === 1 ? '' : 's'}</span>}{member.artifactUrl && <span>Source <code title={member.artifactUrl}>{compactUrl(member.artifactUrl)}</code></span>}{member.externalDigest && <span>Source digest <code>{shortDigest(member.externalDigest)}</code></span>}</div></article>
}

function parseSkillsPackUrl(value: string): URL | null {
  try {
    const parsed = new URL(value)
    const hostname = parsed.hostname.toLowerCase()
    if (parsed.protocol !== 'https:' || (hostname !== 'skills.sh' && hostname !== 'www.skills.sh') || parsed.port || parsed.search || parsed.hash) return null
    if (!/^\/p\/[A-Za-z0-9][A-Za-z0-9._~-]{0,127}\/?$/u.test(parsed.pathname)) return null
    return parsed
  } catch {
    return null
  }
}

function compactUrl(value: string) {
  try {
    const parsed = new URL(value)
    return `${parsed.host}${parsed.pathname}`
  } catch {
    return value
  }
}
