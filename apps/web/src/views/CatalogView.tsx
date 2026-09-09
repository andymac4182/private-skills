import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { api, ApiError } from '../lib/api'
import { formatBytes, formatDate, shortDigest } from '../lib/format'
import type { ScanResult, SkillVersion } from '../lib/types'
import { useAuth } from '../lib/auth'
import { Badge, Button, EmptyState, ErrorState, LoadingState, Notice, Panel } from '../components/Primitives'

export function CatalogView() {
  const [query, setQuery] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState('')
  const [skills, setSkills] = useState<SkillVersion[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  async function load() {
    setError(null)
    try {
      const response = await api.skills(submittedQuery)
      setSkills(response.skills ?? [])
      setSelectedId((current) => response.skills?.some((skill) => skill.id === current) ? current : response.skills?.[0]?.id ?? null)
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Catalog request failed.')
    }
  }

  useEffect(() => { void load() }, [submittedQuery])

  return (
    <div className="view-heading">
      <div>
        <span className="eyebrow">Private catalog</span>
        <h1>Skills</h1>
        <p className="muted">Search approved releases and inspect the exact artifact and scan evidence behind each result.</p>
      </div>
      <Panel>
        <form className="catalog-search" onSubmit={(event) => { event.preventDefault(); setSubmittedQuery(query.trim()) }}>
          <input aria-label="Search skills" onChange={(event) => setQuery(event.target.value)} placeholder="Search @namespace/skill or description" value={query} />
          <Button type="submit">Search</Button>
          {submittedQuery && <Button kind="quiet" type="button" onClick={() => { setQuery(''); setSubmittedQuery('') }}>Clear</Button>}
        </form>
      </Panel>
      {error && <ErrorState message={error} onRetry={() => void load()} />}
      {skills === null && !error && <Panel><LoadingState /></Panel>}
      {skills !== null && !error && (
        <Panel title={`${skills.length} release${skills.length === 1 ? '' : 's'}`} description={submittedQuery ? `Matching “${submittedQuery}”` : 'Every row is scoped to the signed-in organization.'}>
          {skills.length === 0 ? <EmptyState title="No skills in the catalog yet" description="Publish a complete SKILL.md bundle or import one from an approved upstream to make it available here." action={<Link className="button button-primary" params={{ section: 'publish' }} to="/app/$section">Publish a skill</Link>} /> : <div className="table-wrap"><table><thead><tr><th>Skill</th><th>Version</th><th>State</th><th>Files</th><th>Created</th><th /></tr></thead><tbody>{skills.map((skill) => <SkillRow key={skill.id} skill={skill} selected={selectedId === skill.id} onSelect={() => setSelectedId(skill.id)} />)}</tbody></table></div>}
        </Panel>
      )}
      {selectedId && skills?.some((skill) => skill.id === selectedId) && <SkillDetail skillId={selectedId} fallback={skills.find((skill) => skill.id === selectedId)!} onChanged={() => void load()} />}
    </div>
  )
}

function SkillRow({ skill, selected, onSelect }: { skill: SkillVersion; selected: boolean; onSelect: () => void }) {
  return <tr className={selected ? 'row-selected' : ''}><td><button className="link-button" type="button" onClick={onSelect}><strong>{skill.name}</strong><span className="cell-sub">{skill.description || 'No description'}</span></button></td><td>{skill.version}</td><td><Badge value={skill.state} /></td><td>{skill.fileCount}<span className="cell-sub">{formatBytes(skill.artifact.size)}</span></td><td>{formatDate(skill.createdAt)}</td><td><button className="row-link" type="button" onClick={onSelect}>Inspect</button></td></tr>
}

function SkillDetail({ skillId, fallback, onChanged }: { skillId: string; fallback: SkillVersion; onChanged: () => void }) {
  const { principal } = useAuth()
  const [skill, setSkill] = useState<SkillVersion>(fallback)
  const [scans, setScans] = useState<ScanResult[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<'rescan' | 'revoke' | null>(null)
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)
  const canRescan = principal?.roles.some((role) => role === 'owner' || role === 'admin' || role === 'publisher') ?? false
  const canRevoke = principal?.roles.some((role) => role === 'owner' || role === 'admin') ?? false

  async function load() {
    setLoading(true)
    try {
      const [skillResponse, scansResponse] = await Promise.all([api.skill(skillId), api.scans(fallback.artifact.digest)])
      setSkill(skillResponse.skill)
      setScans(scansResponse.scans ?? [])
    } catch (cause) {
      setMessage({ kind: 'error', text: cause instanceof ApiError ? cause.message : 'Could not load release details.' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [skillId])

  async function action(kind: 'rescan' | 'revoke') {
    setBusy(kind)
    setMessage(null)
    try {
      if (kind === 'rescan') {
        const response = await api.rescan(skill.id)
        setMessage({ kind: 'success', text: response.operation ? `Rescan queued as ${response.operation.id}.` : 'Rescan requested.' })
      } else {
        const response = await api.revoke(skill.id)
        setSkill(response.skill ?? { ...skill, state: 'revoked' })
        setMessage({ kind: 'success', text: 'Release revoked. New resolutions and grants will be denied.' })
        onChanged()
      }
    } catch (cause) {
      setMessage({ kind: 'error', text: cause instanceof ApiError ? cause.message : `${kind} request failed.` })
    } finally {
      setBusy(null)
    }
  }

  const installCommand = `pskills install ${skill.name}@${skill.version} --agent codex`
  const provenance = skill.provenance.kind === 'native' ? 'Native publish' : `${skill.provenance.kind}${skill.provenance.repository ? ` · ${skill.provenance.repository}` : ''}`
  return <Panel title="Release details" description="Metadata, provenance, policy state, and scan evidence for this immutable version." action={(canRescan || canRevoke) && <div className="row-actions">{canRescan && <Button kind="secondary" busy={busy === 'rescan'} onClick={() => void action('rescan')}>Rescan</Button>}{canRevoke && <Button kind="danger" busy={busy === 'revoke'} onClick={() => { if (window.confirm(`Revoke ${skill.name}@${skill.version}?`)) void action('revoke') }}>Revoke</Button>}</div>}>
    {message && <div style={{ padding: '16px 22px 0' }}><Notice kind={message.kind}>{message.text}</Notice></div>}
    {loading ? <LoadingState label="Loading release details…" /> : <div className="detail-grid"><div><div className="detail-heading"><div><h2>{skill.name}<span className="muted">@{skill.version}</span></h2><p>{skill.description || 'No description supplied.'}</p></div><Badge value={skill.state} /></div><div className="detail-meta"><div className="meta-row"><span>Artifact</span><span title={skill.artifact.digest}>{shortDigest(skill.artifact.digest)} · {formatBytes(skill.artifact.size)}</span></div><div className="meta-row"><span>Provenance</span><span>{provenance}</span></div><div className="meta-row"><span>Policy revision</span><span>{skill.policyRevision}</span></div><div className="meta-row"><span>Created</span><span>{formatDate(skill.createdAt)}</span></div></div><h3 className="subheading">Install command</h3><pre className="code-block">{installCommand}</pre></div><div><h3 className="subheading">Scan reports</h3>{scans.length === 0 ? <p className="helper">No scan evidence is attached to this release yet.</p> : <div className="scan-list">{scans.map((scan) => <div className="scan-item" key={scan.id}><div className="scan-item-top"><strong>{scan.scannerId}</strong><Badge value={scan.status} /></div><small>{scan.findings.length} finding{scan.findings.length === 1 ? '' : 's'} · {scan.coverage.filesAnalyzed}/{scan.coverage.filesEnumerated} files analyzed</small></div>)}</div>}</div></div>}
  </Panel>
}
