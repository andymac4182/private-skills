import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { api, ApiError } from '../lib/api'
import { formatDate, shortDigest } from '../lib/format'
import { useAuth } from '../lib/auth'
import type {
  SkillDetailResponse,
  SkillSearchResponse,
  SkillView,
  V1Skill,
  DirectorySkillListResponse,
} from '../lib/types'
import { Badge, Button, EmptyState, ErrorState, Field, LoadingState, Notice, Panel } from '../components/Primitives'

const browseViews: Array<{ id: SkillView; label: string; description: string }> = [
  { id: 'all-time', label: 'All', description: 'The complete on-demand leaderboard page.' },
  { id: 'trending', label: 'Trending', description: 'Skills with current momentum on skills.sh.' },
  { id: 'hot', label: 'Hot', description: 'Skills with recent install activity.' },
]

const pageSize = 24

export function DirectoryView() {
  const [topicReady, setTopicReady] = useState(false)
  const [view, setView] = useState<SkillView>('all-time')
  const [page, setPage] = useState(0)
  const [query, setQuery] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState('')
  const [list, setList] = useState<DirectorySkillListResponse | null>(null)
  const [search, setSearch] = useState<SkillSearchResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<V1Skill | null>(null)
  const [detail, setDetail] = useState<SkillDetailResponse | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const loadGeneration = useRef(0)
  const detailGeneration = useRef(0)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const topicSearch = window.sessionStorage.getItem('pskills.directory.topic.query') ?? ''
    window.sessionStorage.removeItem('pskills.directory.topic.query')
    if (topicSearch) {
      setQuery(topicSearch)
      setSubmittedQuery(topicSearch)
    }
    setTopicReady(true)
  }, [])

  async function load() {
    const generation = ++loadGeneration.current
    setLoading(true)
    setError(null)
    setList(null)
    setSearch(null)
    try {
      if (submittedQuery) {
        const response = await api.directorySearch(submittedQuery, { limit: 200 })
        if (generation !== loadGeneration.current) return
        setSearch(response)
        setList(null)
      } else {
        const response = await api.directorySkills({ view, page, perPage: pageSize })
        if (generation !== loadGeneration.current) return
        setList(response)
        setSearch(null)
      }
    } catch (cause) {
      if (generation !== loadGeneration.current) return
      setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not load the cloud directory.')
    } finally {
      if (generation === loadGeneration.current) setLoading(false)
    }
  }

  useEffect(() => { if (topicReady) void load() }, [page, submittedQuery, topicReady, view])

  async function inspect(skill: V1Skill) {
    const generation = ++detailGeneration.current
    setSelected(skill)
    setDetail(null)
    setDetailError(null)
    setDetailLoading(true)
    try {
      const response = await api.directoryDetail(skill.id)
      if (generation !== detailGeneration.current) return
      setDetail(response)
    } catch (cause) {
      if (generation !== detailGeneration.current) return
      setDetailError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not load the cloud skill detail.')
    } finally {
      if (generation === detailGeneration.current) setDetailLoading(false)
    }
  }

  function chooseView(next: SkillView) {
    const changed = next !== view || submittedQuery !== '' || page !== 0
    setView(next)
    setPage(0)
    setQuery('')
    setSubmittedQuery('')
    ++detailGeneration.current
    setSelected(null)
    setDetail(null)
    if (changed) {
      setLoading(true)
      setList(null)
      setSearch(null)
    } else {
      void load()
    }
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const normalized = query.trim()
    if (normalized && [...normalized].length < 2) {
      ++loadGeneration.current
      setLoading(false)
      setList(null)
      setSearch(null)
      setSubmittedQuery('')
      ++detailGeneration.current
      setSelected(null)
      setDetail(null)
      setError('Cloud search needs at least two characters.')
      return
    }
    setError(null)
    setPage(0)
    ++detailGeneration.current
    setSelected(null)
    setDetail(null)
    if (normalized === submittedQuery && page === 0) {
      void load()
      return
    }
    setLoading(true)
    setList(null)
    setSearch(null)
    setSubmittedQuery(normalized)
  }

  const skills = submittedQuery ? search?.data ?? [] : list?.data ?? []
  const resultDescription = submittedQuery
    ? search ? `${search.count} result${search.count === 1 ? '' : 's'} · ${search.searchType} search · directory matches, not topic membership` : loading ? 'Searching the cloud directory…' : 'Search results are unavailable until the directory responds.'
    : list ? `${formatNumber(list.pagination.total)} listed skills · ${browseViews.find((item) => item.id === view)?.description}` : loading ? 'Loading the cloud directory…' : 'Directory data is unavailable until the source responds.'

  return <div className="view-heading directory-view">
    <div className="page-intro">
      <div>
        <h1>Discover skills beyond your registry.</h1>
        <p className="muted">Browse skills.sh metadata on demand. Public listings, source identity, and external evidence stay separate from private approval.</p>
      </div>
      <a className="button button-secondary" href="https://skills.sh" rel="noreferrer" target="_blank">Open skills.sh ↗</a>
    </div>
    <Panel className="directory-toolbar">
      <div className="directory-view-tabs" aria-label="Cloud directory views" role="tablist">
        {browseViews.map((item) => <button aria-selected={!submittedQuery && view === item.id} className={!submittedQuery && view === item.id ? 'directory-tab-active' : ''} key={item.id} role="tab" type="button" onClick={() => chooseView(item.id)}>{item.label}</button>)}
      </div>
      <form className="directory-search" onSubmit={submitSearch}>
        <label className="directory-search-label" htmlFor="directory-search">Search the cloud directory</label>
        <div className="directory-search-row"><input id="directory-search" onChange={(event) => setQuery(event.target.value)} placeholder="Search by skill, source, or description" value={query} /><Button type="submit">Search</Button>{submittedQuery && <Button kind="quiet" type="button" onClick={() => { setQuery(''); setSubmittedQuery(''); setPage(0) }}>Clear</Button>}</div>
        <small>Search results are a bounded upstream result set, not a complete catalog enumeration.</small>
      </form>
    </Panel>
    {error && <ErrorState message={error} onRetry={() => void load()} />}
    <Panel title={submittedQuery ? `Search results for “${submittedQuery}”` : `${browseViews.find((item) => item.id === view)?.label} skills`} description={resultDescription}>
      {loading ? <LoadingState label="Loading cloud metadata…" /> : error ? <Notice kind="warning">No directory results are shown while the source is unavailable.</Notice> : skills.length === 0 ? <EmptyState title={submittedQuery ? 'No cloud matches' : 'No skills on this page'} description={submittedQuery ? 'Try a broader source or skill description.' : 'The directory returned no rows for this page.'} /> : <div className="directory-grid">{skills.map((skill) => <DirectorySkillCard key={skill.id} skill={skill} selected={selected?.id === skill.id} onInspect={() => void inspect(skill)} />)}</div>}
      {!submittedQuery && list && <DirectoryPagination pagination={list.pagination} page={page} onPageChange={(nextPage) => { setPage(nextPage); setSelected(null); setDetail(null) }} />}
    </Panel>
    {selected && <DirectoryDetailPanel detail={detail} detailError={detailError} loading={detailLoading} selected={selected} onRetry={() => void inspect(selected)} />}
  </div>
}

function DirectorySkillCard({ skill, selected, onInspect }: { skill: V1Skill; selected: boolean; onInspect: () => void }) {
  const sourceLabel = skill.sourceType === 'github' ? 'GitHub source' : 'Well-known source'
  const initial = skill.name.replace(/^@/, '').slice(0, 1).toUpperCase() || 'S'
  return <article className={`directory-card ${selected ? 'directory-card-selected' : ''}`.trim()}>
    <button aria-pressed={selected} className="directory-card-trigger" type="button" onClick={onInspect}>
      <div className="directory-card-top"><span aria-hidden="true" className="skill-avatar">{initial}</span><span className="directory-card-heading"><strong>{skill.name}</strong><span>{skill.source}</span></span><span className="directory-card-arrow" aria-hidden="true">↗</span></div>
      <p className="directory-card-slug">{skill.slug}</p>
      <div className="directory-card-tags"><span className="skill-tag">{sourceLabel}</span>{skill.isDuplicate && <span className="skill-tag directory-tag-warn">Duplicate listing</span>}</div>
      <div className="directory-card-stats"><strong>{formatNumber(skill.installs)}</strong><span>skills.sh installs</span></div>
    </button>
    <div className="directory-card-footer"><span>External metadata</span><a href={skill.url} rel="noreferrer" target="_blank">View source page ↗</a></div>
  </article>
}

function DirectoryPagination({ pagination, page, onPageChange }: { pagination: DirectorySkillListResponse['pagination']; page: number; onPageChange: (page: number) => void }) {
  const totalPages = Math.max(1, Math.ceil(pagination.total / pagination.perPage))
  return <div className="directory-pagination"><span>Page {pagination.page + 1} of {totalPages} · {formatNumber(pagination.total)} total rows</span><div className="row-actions"><Button disabled={page <= 0} kind="quiet" type="button" onClick={() => onPageChange(Math.max(0, page - 1))}>Previous</Button><Button disabled={!pagination.hasMore} kind="secondary" type="button" onClick={() => onPageChange(page + 1)}>Next</Button></div></div>
}

function DirectoryDetailPanel({ detail, detailError, loading, selected, onRetry }: { detail: SkillDetailResponse | null; detailError: string | null; loading: boolean; selected: V1Skill; onRetry: () => void }) {
  const navigate = useNavigate()
  const { principal } = useAuth()
  const [name, setName] = useState('')
  const [version, setVersion] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)
  const canImport = principal?.roles.some((role) => role === 'owner' || role === 'admin' || role === 'publisher') ?? false

  async function requestImport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!/^@[a-z0-9-]+\/[a-z0-9-]+$/u.test(name.trim()) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version.trim())) {
      setMessage({ kind: 'error', text: 'Choose a private @namespace/name and an explicit semantic version for admission.' })
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      const response = await api.directoryImport({ id: selected.id, name: name.trim(), version: version.trim() })
      setMessage({ kind: 'success', text: `Private import queued as ${response.operation.id}. The existing scanner and policy flow must complete before installation.` })
    } catch (cause) {
      setMessage({ kind: 'error', text: cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not queue the private import.' })
    } finally {
      setBusy(false)
    }
  }

  function openAudits() {
    if (typeof window !== 'undefined') window.sessionStorage.setItem('pskills.directory.audit.id', selected.id)
    void navigate({ to: '/app/$section', params: { section: 'cloud-audits' } })
  }

  return <Panel className="directory-detail" title="Cloud skill detail" description="External source identity and snapshot evidence. A listing or external audit never approves a private release." action={<div className="row-actions"><Button kind="quiet" type="button" onClick={openAudits}>External audits</Button>{selected.url && <a className="button button-secondary" href={selected.url} rel="noreferrer" target="_blank">Open source page ↗</a>}</div>}>
    {loading ? <LoadingState label="Loading source detail…" /> : detailError ? <ErrorState message={detailError} onRetry={onRetry} /> : detail && <div className="directory-detail-grid"><div>
      <div className="detail-heading"><div><span className="eyebrow eyebrow-cloud">skills.sh listing</span><h2>{selected.name}</h2><p>{selected.source}/{selected.slug}</p></div><Badge value={detail.files === null ? 'metadata-only' : 'snapshot-available'} /></div>
      <div className="detail-meta"><div className="meta-row"><span>External ID</span><span>{detail.id}</span></div><div className="meta-row"><span>Source type</span><span>{selected.sourceType === 'github' ? 'GitHub' : 'Well-known provider'}</span></div><div className="meta-row"><span>skills.sh installs</span><span>{formatNumber(detail.installs)}</span></div><div className="meta-row"><span>External snapshot hash</span><span>{detail.hash ? shortDigest(detail.hash) : 'Unavailable'}</span></div></div>
      {detail.files === null ? <Notice kind="warning">The directory has no file snapshot for this row. Source resolution is required before a private import can be admitted.</Notice> : <div className="directory-files"><div className="install-header"><h3 className="subheading">Snapshot files</h3><span className="helper">{detail.files.length} file{detail.files.length === 1 ? '' : 's'} · text is retained as source data</span></div><ul>{detail.files.slice(0, 24).map((file) => <li key={file.path}><code>{file.path}</code></li>)}</ul>{detail.files.length > 24 && <span className="helper">Showing the first 24 paths.</span>}</div>}
    </div><div className="directory-import"><h3 className="subheading">Request private import</h3><p className="helper">Choose the private namespace and version yourself. The external row has no upstream SemVer, and approval still depends on our scanner policy.</p><form className="stack-form" onSubmit={requestImport}><Field label="Private name"><input disabled={!canImport} onChange={(event) => setName(event.target.value)} placeholder="@team/skill" value={name} /></Field><Field label="Private version"><input disabled={!canImport} onChange={(event) => setVersion(event.target.value)} placeholder="1.0.0" value={version} /></Field>{message && <Notice kind={message.kind}>{message.text}{message.kind === 'success' && <>{' '}<Link to="/app/$section" params={{ section: 'operations' }}>View activity</Link></>}</Notice>}{!canImport && <Notice kind="warning">Your role cannot request a private import.</Notice>}<Button busy={busy} disabled={!canImport || detail.files === null} type="submit">Queue private import</Button></form></div></div>}
  </Panel>
}

function formatNumber(value: number) {
  return new Intl.NumberFormat().format(value)
}
