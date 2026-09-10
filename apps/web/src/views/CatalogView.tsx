import { useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { api, ApiError } from '../lib/api'
import { formatBytes, formatDate, shortDigest } from '../lib/format'
import { quotePosix, quotePowerShell } from '../lib/shell'
import type { Policy, ScanResult, SearchStatusResponse, SemanticSearchResult, SkillVersion } from '../lib/types'
import { useAuth } from '../lib/auth'
import { Badge, Button, DisconnectedState, EmptyState, ErrorState, LoadingState, Notice, Panel } from '../components/Primitives'
import { ReleaseViewer } from '../components/ReleaseViewer'

export function CatalogView() {
  const [query, setQuery] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState('')
  const [skills, setSkills] = useState<SkillVersion[] | null>(null)
  const [semanticResults, setSemanticResults] = useState<SemanticSearchResult[] | null>(null)
  const [mode, setMode] = useState<'catalog' | 'semantic'>('catalog')
  const [policy, setPolicy] = useState<Policy | null>(null)
  const [searchStatus, setSearchStatus] = useState<SearchStatusResponse | null>(null)
  const [searchStatusError, setSearchStatusError] = useState<string | null>(null)
  const [reindexing, setReindexing] = useState(false)
  const [searchMessage, setSearchMessage] = useState<string | null>(null)
  const [reindexCursor, setReindexCursor] = useState<string | null>(null)
  const [reindexIndexed, setReindexIndexed] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const searchInput = useRef<HTMLInputElement>(null)

  async function load() {
    setError(null)
    try {
      const semanticActive = mode === 'semantic' && submittedQuery.length > 0
      if (semanticActive) {
        const [response, policyResponse] = await Promise.all([api.search(submittedQuery), api.policy()])
        setSemanticResults(response.results ?? [])
        setSkills(null)
        setPolicy(policyResponse.policy)
      } else {
        const [response, policyResponse] = await Promise.all([api.skills(submittedQuery), api.policy()])
        setSkills(response.skills ?? [])
        setSemanticResults(null)
        setPolicy(policyResponse.policy)
        setSelectedId((current) => response.skills?.some((skill) => skill.id === current) ? current : response.skills?.[0]?.id ?? null)
      }
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Catalog request failed.')
    }
  }

  useEffect(() => { void load() }, [submittedQuery, mode])
  useEffect(() => {
    void api.searchStatus().then((status) => { setSearchStatus(status); setSearchStatusError(null) }).catch((cause) => { setSearchStatus(null); setSearchStatusError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Search status is unavailable.') })
  }, [])
  useEffect(() => {
    function focusSearch(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        searchInput.current?.focus()
      }
    }
    window.addEventListener('keydown', focusSearch)
    return () => window.removeEventListener('keydown', focusSearch)
  }, [])

  async function reindexSearch(cursor?: string) {
    setReindexing(true)
    setSearchMessage(null)
    try {
      const isContinuation = Boolean(cursor)
      if (!isContinuation) setReindexIndexed(0)
      const response = await api.reindexSearch(cursor)
      const indexedTotal = (isContinuation ? reindexIndexed : 0) + response.indexed
      const nextCursor = response.truncated ? response.nextCursor ?? null : null
      setReindexIndexed(indexedTotal)
      setReindexCursor(nextCursor)
      setSearchMessage(nextCursor
        ? `Indexed ${indexedTotal} release${indexedTotal === 1 ? '' : 's'} this run. Continue indexing to process the next bounded batch.`
        : `Search index updated with ${indexedTotal} release${indexedTotal === 1 ? '' : 's'} this run.`)
      const status = await api.searchStatus()
      setSearchStatus(status)
      setSearchStatusError(null)
    } catch (cause) {
      setSearchMessage(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not refresh the search index.')
    } finally {
      setReindexing(false)
    }
  }

  const semanticActive = mode === 'semantic' && submittedQuery.length > 0
  const semanticDisconnected = searchStatus?.provider === 'disabled'

  return (
    <div className="view-heading">
      <div className="page-intro">
        <div>
        <span className="eyebrow">Private catalog</span>
        <h1>Skills</h1>
        <p className="muted">Search approved releases and review the details and security checks behind each result.</p>
        </div>
        <Link className="button button-primary" params={{ section: 'publish' }} to="/app/$section">Publish a skill</Link>
      </div>
      <Panel>
        <div className="search-mode-switch" role="group" aria-label="Search mode"><button className={mode === 'catalog' ? 'search-mode-active' : ''} type="button" onClick={() => setMode('catalog')}>Catalog</button><button aria-describedby={semanticDisconnected ? 'semantic-disconnected' : undefined} className={mode === 'semantic' ? 'search-mode-active' : ''} disabled={semanticDisconnected} title={semanticDisconnected ? 'Semantic search is unavailable' : undefined} type="button" onClick={() => setMode('semantic')}>Semantic</button></div>
        <form className="catalog-search" onSubmit={(event) => { event.preventDefault(); setSubmittedQuery(query.trim()) }}>
          <input ref={searchInput} aria-label={`${mode === 'semantic' ? 'Semantic ' : ''}search skills`} onChange={(event) => setQuery(event.target.value)} placeholder={mode === 'semantic' ? 'Describe what you need…' : 'Search @namespace/skill or description'} value={query} />
          <span className="search-shortcut" aria-hidden="true"><kbd>⌘</kbd><kbd>K</kbd></span>
          <Button type="submit">Search</Button>
          {submittedQuery && <Button kind="quiet" type="button" onClick={() => { setQuery(''); setSubmittedQuery('') }}>Clear</Button>}
        </form>
        <div className="search-meta"><span className={`search-status ${searchStatus?.status === 'ok' ? 'search-status-good' : searchStatus?.provider === 'disabled' ? 'search-status-disconnected' : searchStatus?.status === 'degraded' ? 'search-status-warn' : ''}`}><span className={`health-dot ${searchStatus?.status === 'ok' ? 'health-online' : 'health-checking'}`} aria-hidden="true" />{searchStatus?.provider === 'disabled' ? 'Semantic search disconnected' : searchStatus ? `Semantic index ${searchStatus.status}` : searchStatusError ?? 'Checking semantic index…'}</span>{mode === 'semantic' && !semanticDisconnected && <Button kind="quiet" busy={reindexing} type="button" onClick={() => void reindexSearch(reindexCursor ?? undefined)}>{reindexCursor ? 'Continue indexing' : 'Refresh index'}</Button>}{mode === 'semantic' && semanticDisconnected && <Button kind="quiet" type="button" onClick={() => setMode('catalog')}>Use catalog search</Button>}</div>
        {semanticDisconnected && <div id="semantic-disconnected"><DisconnectedState title="Semantic search is disconnected" message="The private semantic index is not connected. Standard catalog search remains available while the search service is configured." action={<Button kind="secondary" type="button" onClick={() => setMode('catalog')}>Use catalog search</Button>} /></div>}
      </Panel>
      {searchMessage && <Notice kind="info">{searchMessage}</Notice>}
      {error && <ErrorState message={error} onRetry={() => void load()} />}
      {skills === null && semanticResults === null && !error && <Panel><LoadingState label={semanticActive ? 'Searching the private index…' : 'Loading catalog…'} /></Panel>}
      {semanticActive && semanticResults !== null && !error && (
        <Panel title={`${semanticResults.length} semantic match${semanticResults.length === 1 ? '' : 'es'}`} description={`Results for “${submittedQuery}” ranked by similarity.`}>
          {semanticResults.length === 0 ? <EmptyState title="No semantic matches" description="Try describing the outcome you need or switch back to the catalog search." /> : <div className="catalog-grid">{semanticResults.map((result) => <SemanticCard key={`${result.resourceId}:${result.version}`} result={result} onOpen={() => { setMode('catalog'); setQuery(result.name); setSubmittedQuery(result.name) }} />)}</div>}
        </Panel>
      )}
      {!semanticActive && skills !== null && policy !== null && !error && (
        <Panel title={`${skills.length} release${skills.length === 1 ? '' : 's'}`} description={submittedQuery ? `Matching “${submittedQuery}”` : 'Every row is scoped to the signed-in organization.'}>
          {skills.length === 0 ? <EmptyState title="No skills in the catalog yet" description="Publish a complete skill folder or import one from an approved source to make it available here." action={<Link className="button button-primary" params={{ section: 'publish' }} to="/app/$section">Publish a skill</Link>} /> : <div className="catalog-grid">{skills.map((skill) => <SkillCard key={skill.id} skill={skill} needsRescan={needsRescan(skill, policy)} selected={selectedId === skill.id} onSelect={() => setSelectedId(skill.id)} />)}</div>}
        </Panel>
      )}
      {selectedId && skills?.some((skill) => skill.id === selectedId) && <SkillDetail currentPolicyRevision={policy?.revision ?? null} skillId={selectedId} fallback={skills.find((skill) => skill.id === selectedId)!} onChanged={() => void load()} />}
    </div>
  )
}

function needsRescan(skill: SkillVersion, policy: Policy): boolean {
  return skill.state === 'approved' && skill.policyRevision !== policy.revision
}

function sourceReferenceForSkill(skill: SkillVersion): string | undefined {
  const value = (skill.provenance as SkillVersion['provenance'] & { sourceReference?: unknown }).sourceReference
  if (typeof value !== 'string' || value.length < 4 || value.length > 2_048 || !value.startsWith('@') || /[\u0000-\u001f\u007f\\?#%\s]/u.test(value)) return undefined
  const parts = value.slice(1).split('/')
  if (parts.length < 2 || !['github', 'web', 'snapshot'].includes(parts[0] ?? '') || parts.some((part) => !part || part === '.' || part === '..' || !/^[A-Za-z0-9._~-]+$/u.test(part))) return undefined
  return value
}

function displaySkillIdentity(skill: SkillVersion): string {
  return sourceReferenceForSkill(skill) ?? skill.name
}

function installTarget(skill: SkillVersion): string {
  return quotePosix(`${skill.name}@${skill.version}`)
}

function SkillCard({ skill, needsRescan: releaseNeedsRescan, selected, onSelect }: { skill: SkillVersion; needsRescan: boolean; selected: boolean; onSelect: () => void }) {
  const identity = displaySkillIdentity(skill)
  const initial = identity.replace(/^@/, '').split(/[\/_-]/)[0]?.slice(0, 1).toUpperCase() || 'S'
  const fileLabel = `${skill.fileCount} file${skill.fileCount === 1 ? '' : 's'}`
  return <article className={`skill-card ${selected ? 'skill-card-selected' : ''}`.trim()}><button aria-label={`Inspect ${identity} ${skill.version}`} aria-pressed={selected} className="skill-card-trigger" type="button" onClick={onSelect}><div className="skill-card-top"><span aria-hidden="true" className="skill-avatar">{initial}</span><span className="skill-card-identity"><strong>{identity}</strong><span>{skill.version}</span></span><span aria-hidden="true" className="skill-card-dots">···</span></div><p className="skill-card-description">{skill.description || 'No description supplied.'}</p><div className="skill-card-tags"><span className="skill-tag">Skill</span><span className="skill-tag">{skill.provenance.kind}</span></div><div className="skill-card-footer"><Badge tone={releaseNeedsRescan ? 'warn' : undefined} value={releaseNeedsRescan ? 'needs rescan' : skill.state} /><span>{fileLabel}</span></div></button></article>
}

function SemanticCard({ result, onOpen }: { result: SemanticSearchResult; onOpen: () => void }) {
  const initial = result.name.replace(/^@/, '').slice(0, 1).toUpperCase() || 'S'
  return <article className="skill-card semantic-card"><button aria-label={`Open ${result.name} ${result.version} in the catalog`} className="skill-card-trigger" type="button" onClick={onOpen}><div className="skill-card-top"><span aria-hidden="true" className="skill-avatar">{initial}</span><span className="skill-card-identity"><strong>{result.name}</strong><span>{result.version}</span></span><span className="skill-card-dots">{Math.round(result.score * 100)}%</span></div><p className="skill-card-description">{result.description || result.text}</p><div className="skill-card-tags"><span className="skill-tag">Semantic match</span><span className="skill-tag">Open release</span></div><div className="skill-card-footer"><span className="badge badge-good">{Math.round(result.score * 100)}% match</span><span>Inspect catalog</span></div></button></article>
}

function SkillDetail({ currentPolicyRevision, skillId, fallback, onChanged }: { currentPolicyRevision: string | null; skillId: string; fallback: SkillVersion; onChanged: () => void }) {
  const { principal } = useAuth()
  const [skill, setSkill] = useState<SkillVersion>(fallback)
  const [scans, setScans] = useState<ScanResult[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<'rescan' | 'revoke' | null>(null)
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const canRescan = principal?.roles.some((role) => role === 'owner' || role === 'admin' || role === 'publisher') ?? false
  const canRevoke = principal?.roles.some((role) => role === 'owner' || role === 'admin') ?? false
  const sourceReference = sourceReferenceForSkill(skill)
  const identity = sourceReference ?? skill.name
  const installCommand = `pskills install ${installTarget(skill)} --agent codex`
  const installPowerShellCommand = `pskills install ${quotePowerShell(`${skill.name}@${skill.version}`)} --agent codex`

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

  async function copyInstallCommand() {
    try {
      await navigator.clipboard.writeText(installCommand)
      setMessage(null)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setMessage({ kind: 'error', text: 'Copy is unavailable here. Select the command and copy it manually.' })
    }
  }

  const provenance = skill.provenance.kind === 'native' ? 'Native publish' : `${skill.provenance.kind}${skill.provenance.repository ? ` · ${skill.provenance.repository}` : ''}`
  const releaseNeedsRescan = skill.state === 'approved' && currentPolicyRevision !== null && skill.policyRevision !== currentPolicyRevision
  return <Panel title="Release details" description="Release information and security checks for this version." action={(canRescan || canRevoke) && <div className="row-actions">{canRescan && <Button kind="secondary" busy={busy === 'rescan'} onClick={() => void action('rescan')}>Rescan</Button>}{canRevoke && <Button kind="danger" busy={busy === 'revoke'} onClick={() => { if (window.confirm(`Revoke ${skill.name}@${skill.version}?`)) void action('revoke') }}>Revoke</Button>}</div>}>
    {message && <div style={{ padding: '16px 22px 0' }}><Notice kind={message.kind}>{message.text}</Notice></div>}
    {loading ? <LoadingState label="Loading release details…" /> : <><div className="detail-grid"><div><div className="detail-heading"><div><h2>{identity}<span className="muted">@{skill.version}</span></h2><p>{skill.description || 'No description supplied.'}</p></div><Badge tone={releaseNeedsRescan ? 'warn' : undefined} value={releaseNeedsRescan ? 'needs rescan' : skill.state} /></div>{releaseNeedsRescan && <Notice kind="warning">Current review rules changed after this release was approved. It remains stored as approved, but it needs a new security scan before installation.</Notice>}<div className="detail-meta"><div className="meta-row"><span>Stored state</span><span><Badge value={skill.state} /></span></div><div className="meta-row"><span>Package</span><span title={skill.artifact.digest}>{shortDigest(skill.artifact.digest)} · {formatBytes(skill.artifact.size)}</span></div><div className="meta-row"><span>Source</span><span>{provenance}</span></div>{sourceReference && <div className="meta-row"><span>Canonical source</span><code>{sourceReference}</code></div>}<div className="meta-row"><span>Review rules</span><span>{skill.policyRevision}</span></div><div className="meta-row"><span>Created</span><span>{formatDate(skill.createdAt)}</span></div></div><div className="install-block"><div className="install-header"><h3 className="subheading">Install command</h3><Button kind="quiet" type="button" onClick={() => void copyInstallCommand()}>{copied ? 'Copied' : 'Copy command'}</Button></div><span className="helper">POSIX (bash/zsh)</span><pre className="code-block">{installCommand}</pre><span className="helper">PowerShell</span><pre className="code-block">{installPowerShellCommand}</pre></div></div><div><h3 className="subheading">Security checks</h3>{scans.length === 0 ? <p className="helper">No security checks are attached to this release yet.</p> : <div className="scan-list">{scans.map((scan) => <div className="scan-item" key={scan.id}><div className="scan-item-top"><strong>{scan.scannerId}</strong><Badge value={scan.status} /></div><small>{scan.findings.length} finding{scan.findings.length === 1 ? '' : 's'} · {scan.coverage.filesAnalyzed}/{scan.coverage.filesEnumerated} files analyzed</small></div>)}</div>}</div></div><ReleaseViewer key={skill.id} resourceId={skill.id} /></>}
  </Panel>
}
