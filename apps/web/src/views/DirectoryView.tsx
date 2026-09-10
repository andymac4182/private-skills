import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { api, ApiError, isApiErrorCode } from '../lib/api'
import { shortDigest } from '../lib/format'
import { quotePosix, quotePowerShell } from '../lib/shell'
import { useAuth } from '../lib/auth'
import type {
  Job,
  DirectoryFeed,
  Principal,
  SkillDetailResponse,
  SkillSearchResponse,
  SkillView,
  V1Skill,
  DirectorySkillListResponse,
} from '../lib/types'
import { Badge, Button, DisconnectedState, EmptyState, ErrorState, LoadingState, Notice, Panel } from '../components/Primitives'

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
  const [disconnected, setDisconnected] = useState(false)
  const [selected, setSelected] = useState<V1Skill | null>(null)
  const [detail, setDetail] = useState<SkillDetailResponse | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [detailDisconnected, setDetailDisconnected] = useState(false)
  const [feeds, setFeeds] = useState<DirectoryFeed[] | null>(null)
  const [feedsLoading, setFeedsLoading] = useState(true)
  const [feedsError, setFeedsError] = useState<string | null>(null)
  const [selectedFeedName, setSelectedFeedName] = useState('')
  const loadGeneration = useRef(0)
  const detailGeneration = useRef(0)
  const feedGeneration = useRef(0)

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

  async function loadFeeds() {
    const generation = ++feedGeneration.current
    setFeedsLoading(true)
    setFeedsError(null)
    try {
      const response = await api.feeds()
      if (generation !== feedGeneration.current) return
      setFeeds(response.feeds)
      setSelectedFeedName((current) => response.feeds.some((feed) => feed.name === current)
        ? current
        : response.feeds.find((feed) => feed.enabled)?.name ?? response.feeds[0]?.name ?? '')
    } catch (cause) {
      if (generation !== feedGeneration.current) return
      setFeeds(null)
      setFeedsError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not load configured source feeds.')
    } finally {
      if (generation === feedGeneration.current) setFeedsLoading(false)
    }
  }

  async function load() {
    const generation = ++loadGeneration.current
    setLoading(true)
    setError(null)
    setDisconnected(false)
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
      if (isApiErrorCode(cause, 'DIRECTORY_NOT_CONFIGURED')) {
        setDisconnected(true)
        setError(null)
      } else {
        setDisconnected(false)
        setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not load the cloud directory.')
      }
    } finally {
      if (generation === loadGeneration.current) setLoading(false)
    }
  }

  useEffect(() => { if (topicReady) void loadFeeds() }, [topicReady])
  useEffect(() => { if (topicReady) void load() }, [page, submittedQuery, topicReady, view])

  async function inspect(skill: V1Skill) {
    const generation = ++detailGeneration.current
    setSelected(skill)
    setDetail(null)
    setDetailError(null)
    setDetailDisconnected(false)
    setDetailLoading(true)
    try {
      const response = await api.directoryDetail(skill.id)
      if (generation !== detailGeneration.current) return
      setDetail(response)
    } catch (cause) {
      if (generation !== detailGeneration.current) return
      if (isApiErrorCode(cause, 'DIRECTORY_NOT_CONFIGURED')) {
        setDetailDisconnected(true)
        setDetailError(null)
      } else {
        setDetailDisconnected(false)
        setDetailError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not load the cloud skill detail.')
      }
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
    setDetailDisconnected(false)
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
      setDetailDisconnected(false)
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
      <div className="directory-feed-control">
        <label className="directory-search-label" htmlFor="directory-feed">Source discovery feed</label>
        {feedsLoading ? <small>Loading discovery feed configuration…</small> : feedsError ? <Notice kind="warning">Discovery feed configuration is unavailable. Source requests stay disabled until the registry responds.</Notice> : feeds && feeds.length > 0 ? <><select id="directory-feed" onChange={(event) => setSelectedFeedName(event.target.value)} value={selectedFeedName}>{feeds.map((feed) => <option key={feed.id} value={feed.name}>{feed.name} · {feed.kind}{feed.enabled ? '' : ' · disabled'}</option>)}</select><small>{feeds.find((feed) => feed.name === selectedFeedName)?.enabled ? 'Choose which configured feed discovers this source. The server returns its canonical source reference after resolution.' : 'This discovery feed is disabled for new source requests.'}</small></> : <Notice kind="warning">No source discovery feed is configured. Browse remains available; source requests stay disabled.</Notice>}
      </div>
    </Panel>
    {disconnected ? <DisconnectedState title="Cloud directory is disconnected" message="The public skills.sh connection is not configured for this registry. Your private catalog, packs, and policy remain available." action={<a className="button button-secondary" href="https://skills.sh" rel="noreferrer" target="_blank">Open skills.sh ↗</a>} /> : error && <ErrorState message={error} onRetry={() => void load()} />}
    <Panel title={submittedQuery ? `Search results for “${submittedQuery}”` : `${browseViews.find((item) => item.id === view)?.label} skills`} description={resultDescription}>
      {loading ? <LoadingState label="Loading cloud metadata…" /> : disconnected ? <Notice kind="info">Directory results are paused until the public source connection is configured.</Notice> : error ? <Notice kind="warning">No directory results are shown while the source is unavailable.</Notice> : skills.length === 0 ? <EmptyState title={submittedQuery ? 'No cloud matches' : 'No skills on this page'} description={submittedQuery ? 'Try a broader source or skill description.' : 'The directory returned no rows for this page.'} /> : <div className="directory-grid">{skills.map((skill) => <DirectorySkillCard key={skill.id} skill={skill} selected={selected?.id === skill.id} onInspect={() => void inspect(skill)} />)}</div>}
      {!submittedQuery && list && <DirectoryPagination pagination={list.pagination} page={page} onPageChange={(nextPage) => { setPage(nextPage); setSelected(null); setDetail(null) }} />}
    </Panel>
    {selected && <DirectoryDetailPanel key={`${selected.id}:${selectedFeedName || 'unknown'}`} detail={detail} detailDisconnected={detailDisconnected} detailError={detailError} feedsError={feedsError} feedsLoading={feedsLoading} feed={feeds?.find((candidate) => candidate.name === selectedFeedName) ?? null} loading={detailLoading} selected={selected} onRetry={() => void inspect(selected)} />}
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

interface ProxyImportFields {
  externalId?: unknown
  feedId?: unknown
  feedName?: unknown
  name?: unknown
  version?: unknown
  sourceReference?: unknown
}

interface ProxyMemberProvenance {
  externalId?: unknown
  feedId?: unknown
  feedName?: unknown
  sourceReference?: unknown
}

interface ProxyOperationPin {
  rootOperationId: string
  activeOperationId: string
  resourceId: string | null
  externalId: string
  feedId: string
  feedName: string
  name: string
  version: string
  sourceReference: string | null
}

function proxyImportFields(job: Job): ProxyImportFields {
  return (job.import ?? {}) as ProxyImportFields
}

function pinProxyOperation(job: Job, feed: DirectoryFeed, externalId: string, responseReference?: string): ProxyOperationPin | null {
  if (job.kind !== 'import') return null
  const request = proxyImportFields(job)
  if (request.externalId !== externalId || typeof request.name !== 'string' || request.name.length === 0 || typeof request.version !== 'string' || request.version.length === 0) return null
  if (request.feedId !== feed.id && request.feedName !== feed.name) return null
  return {
    rootOperationId: job.id,
    activeOperationId: job.id,
    resourceId: job.resourceId ?? null,
    externalId,
    feedId: feed.id,
    feedName: feed.name,
    name: request.name,
    version: request.version,
    sourceReference: verifiedSourceReference(responseReference) ?? verifiedSourceReference(request.sourceReference),
  }
}

function hasProxyResolveScope(principal: Principal | null | undefined): boolean {
  if (!principal) return false
  if (principal.roles.some((role) => role === 'owner' || role === 'admin')) return true
  const scopes = (principal as Principal & { scopes?: unknown }).scopes
  if (!Array.isArray(scopes)) return false
  return scopes.some((scope) => scope === 'proxy:resolve' || scope === 'proxy:*' || scope === 'registry:*' || scope === '*')
}

function DirectoryDetailPanel({ detail, detailDisconnected, detailError, feed, feedsError, feedsLoading, loading, selected, onRetry }: { detail: SkillDetailResponse | null; detailDisconnected: boolean; detailError: string | null; feed: DirectoryFeed | null; feedsError: string | null; feedsLoading: boolean; loading: boolean; selected: V1Skill; onRetry: () => void }) {
  const navigate = useNavigate()
  const { principal } = useAuth()
  const [busy, setBusy] = useState(false)
  const [operation, setOperation] = useState<Job | null>(null)
  const [ready, setReady] = useState(false)
  const [reference, setReference] = useState<string | null>(null)
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)
  const requestGeneration = useRef(0)
  const operationPin = useRef<ProxyOperationPin | null>(null)
  const canResolveProxy = hasProxyResolveScope(principal)
  const canImport = canResolveProxy && !feedsLoading && !feedsError && feed?.enabled === true

  async function requestProxy(refresh = false) {
    if (!feed) {
      setMessage({ kind: 'error', text: 'Choose a configured import feed before requesting this source.' })
      return
    }
    const generation = ++requestGeneration.current
    operationPin.current = null
    setBusy(true)
    setMessage(null)
    setOperation(null)
    setReady(false)
    setReference(null)
    try {
      const response = await api.proxyResolve({ feed: feed.name, externalId: selected.id, ...(refresh ? { refresh: true } : {}) })
      if (generation !== requestGeneration.current) return
      const canonicalReference = verifiedSourceReference(response.reference)
      if (response.feed !== feed.name || response.externalId !== selected.id || (response.reference !== undefined && !canonicalReference)) {
        setMessage({ kind: 'error', text: 'The registry returned a different feed or external identity, so this request was not accepted.' })
      } else if (response.operation) {
        const pin = pinProxyOperation(response.operation, feed, selected.id, canonicalReference ?? undefined)
        if (!pin) {
          setMessage({ kind: 'error', text: 'The registry operation was not pinned to this source and discovery feed.' })
          return
        }
        operationPin.current = pin
        setReference(pin.sourceReference)
        setOperation(response.operation)
        if (response.operation.state === 'failed') {
          setMessage({ kind: 'error', text: response.operation.error ?? 'The registry operation failed before this source became ready.' })
        } else if (response.operation.state === 'completed') {
          setMessage({ kind: 'success', text: 'The registry operation completed. Check the source again to confirm its current approval state.' })
        } else {
          setMessage({ kind: 'success', text: `The registry is fetching, scanning, and caching ${response.externalId}.` })
        }
      } else if (response.resolution && canonicalReference) {
        setReference(canonicalReference)
        setReady(true)
        setMessage({ kind: 'success', text: 'This source is ready through the private registry. Use the original catalog ID and selected feed to install it.' })
      } else if (response.resolution) {
        setMessage({ kind: 'error', text: 'The registry returned a resolution without a verified canonical source reference.' })
      } else {
        setMessage({ kind: 'error', text: 'The registry returned no operation or approved resolution for this source.' })
      }
    } catch (cause) {
      if (generation !== requestGeneration.current) return
      setReady(false)
      setMessage({ kind: 'error', text: cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not request this source through the private registry.' })
    } finally {
      if (generation === requestGeneration.current) setBusy(false)
    }
  }

  useEffect(() => () => {
    requestGeneration.current += 1
    operationPin.current = null
  }, [])

  useEffect(() => {
    const initialPin = operationPin.current
    if (!operation || !initialPin || operation.state === 'failed') return
    const generation = requestGeneration.current
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const fail = (text: string) => {
      operationPin.current = null
      setReady(false)
      setMessage({ kind: 'error', text })
    }
    const poll = async () => {
      try {
        const activePin = operationPin.current
        if (!activePin || activePin.rootOperationId !== initialPin.rootOperationId) return
        const response = await api.operation(activePin.activeOperationId)
        if (stopped || generation !== requestGeneration.current) return
        const completed = response.operation
        if (completed.state === 'failed') {
          setOperation(completed)
          fail(completed.error ?? 'The registry operation failed before this source became ready.')
        } else if (completed.resourceId && activePin.resourceId && completed.resourceId !== activePin.resourceId) {
          setOperation(completed)
          fail('The registry operation resolved a different resource, so readiness was not claimed.')
        } else if (completed.state === 'completed') {
          if (!completed.resourceId) {
            setOperation(completed)
            fail('The registry completed the operation without pinning a resource.')
            return
          }
          const completedPin = { ...activePin, resourceId: completed.resourceId }
          operationPin.current = completedPin
          try {
            const resolved = await api.resolve({ kind: 'skill', ref: completedPin.name, version: completedPin.version })
            if (stopped || generation !== requestGeneration.current) return
            if (resolved.operation) {
              if (resolved.operation.resourceId !== completedPin.resourceId) {
                fail('The registry returned a pending operation for a different resource, so readiness was not claimed.')
                return
              }
              operationPin.current = { ...completedPin, activeOperationId: resolved.operation.id }
              setOperation(resolved.operation)
              setMessage({ kind: 'success', text: 'The source was fetched. The registry is finishing its scanner and policy checks.' })
              timer = setTimeout(() => void poll(), 1200)
              return
            }
            const resolution = resolved.resolution
            const member = resolution?.members.find((candidate) => candidate.id === completedPin.resourceId)
            const memberProvenance = member?.provenance as ProxyMemberProvenance | undefined
            const memberExternalId = memberProvenance && typeof memberProvenance.externalId === 'string' ? memberProvenance.externalId : undefined
            const memberFeedId = memberProvenance && typeof memberProvenance.feedId === 'string' ? memberProvenance.feedId : undefined
            const memberFeedName = memberProvenance && typeof memberProvenance.feedName === 'string' ? memberProvenance.feedName : undefined
            const canonicalReference = verifiedSourceReference(completedPin.sourceReference) ?? verifiedSourceReference(memberProvenance?.sourceReference)
            if (!resolution || resolution.kind !== 'skill' || resolution.resourceId !== completedPin.resourceId || resolution.name !== completedPin.name || resolution.version !== completedPin.version || !member || (memberExternalId !== undefined && memberExternalId !== completedPin.externalId) || (memberFeedId !== undefined && memberFeedId !== completedPin.feedId) || (memberFeedName !== undefined && memberFeedName !== completedPin.feedName)) {
              fail('The registry returned a different resource, source, or feed, so readiness was not claimed.')
            } else if (!canonicalReference) {
              fail('The source completed without a verified canonical source reference.')
            } else {
              operationPin.current = { ...completedPin, sourceReference: canonicalReference }
              setReference(canonicalReference)
              setOperation(completed)
              setReady(true)
              setMessage({ kind: 'success', text: 'The source passed the registry flow and is ready to install with the original catalog ID.' })
            }
          } catch (cause) {
            if (!stopped && generation === requestGeneration.current) fail(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'The source completed without an approved resolution.')
          }
        } else if (!stopped) {
          setOperation(completed)
          timer = setTimeout(() => void poll(), 1600)
        }
      } catch (cause) {
        if (!stopped && generation === requestGeneration.current) setMessage({ kind: 'error', text: cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not refresh registry operation status.' })
      }
    }
    timer = setTimeout(() => void poll(), operation.state === 'completed' ? 0 : 1200)
    return () => { stopped = true; if (timer) clearTimeout(timer) }
  }, [operation?.id, selected.id, feed?.id])

  function openAudits() {
    if (typeof window !== 'undefined') window.sessionStorage.setItem('pskills.directory.audit.id', selected.id)
    void navigate({ to: '/app/$section', params: { section: 'cloud-audits' } })
  }

  return <Panel className="directory-detail" title="Cloud skill detail" description="External source identity and snapshot evidence. A listing or external audit never approves a private release." action={<div className="row-actions"><Button kind="quiet" type="button" onClick={openAudits}>External audits</Button>{selected.url && <a className="button button-secondary" href={selected.url} rel="noreferrer" target="_blank">Open source page ↗</a>}</div>}>
    {loading ? <LoadingState label="Loading source detail…" /> : detailDisconnected ? <DisconnectedState title="Cloud source is disconnected" message="This listing cannot be inspected until the public skills.sh connection is configured." action={selected.url ? <a className="button button-secondary" href={selected.url} rel="noreferrer" target="_blank">Open source page ↗</a> : undefined} /> : detailError ? <ErrorState message={detailError} onRetry={onRetry} /> : detail && <div className="directory-detail-grid"><div>
      <div className="detail-heading"><div><span className="eyebrow eyebrow-cloud">skills.sh listing</span><h2>{selected.name}</h2><p>{selected.source}/{selected.slug}</p></div><Badge value={detail.files === null ? 'metadata-only' : 'snapshot-available'} /></div>
      <div className="detail-meta"><div className="meta-row"><span>External ID</span><span>{detail.id}</span></div><div className="meta-row"><span>Source type</span><span>{selected.sourceType === 'github' ? 'GitHub' : 'Well-known provider'}</span></div><div className="meta-row"><span>skills.sh installs</span><span>{formatNumber(detail.installs)}</span></div><div className="meta-row"><span>External snapshot hash</span><span>{detail.hash ? shortDigest(detail.hash) : 'Unavailable'}</span></div></div>
      {detail.files === null ? <Notice kind="info">This row has metadata only. The first request below asks the registry to resolve the source, retain the external identity, scan the bytes, and cache the result.</Notice> : <div className="directory-files"><div className="install-header"><h3 className="subheading">Snapshot files</h3><span className="helper">{detail.files.length} file{detail.files.length === 1 ? '' : 's'} · text is retained as source data</span></div><ul>{detail.files.slice(0, 24).map((file) => <li key={file.path}><code>{file.path}</code></li>)}</ul>{detail.files.length > 24 && <span className="helper">Showing the first 24 paths.</span>}</div>}
    </div><div className="directory-import"><h3 className="subheading">Use this skill privately</h3><p className="helper">The catalog ID below is the source identity while the registry resolves it. No rename, version, or mapping form is required; the registry fetches, scans, and caches it on the first request.</p><div className="proxy-identity"><span>Catalog source ID</span><code>{selected.id}</code></div>{reference && <div className="proxy-reference"><span>Verified source reference</span><code>{reference}</code></div>}{message && <Notice kind={message.kind}>{message.text}</Notice>}{operation && <div className="proxy-operation"><div className="meta-row"><span>Registry operation</span><Badge value={operation.state} /></div><div className="meta-row"><span>Operation ID</span><code>{operation.id}</code></div>{operation.error && <Notice kind="error">{operation.error}</Notice>}</div>}{ready && <Notice kind="success">Approved resolution available through this registry.</Notice>}{feedsLoading && <Notice kind="info">Loading configured discovery feeds…</Notice>}{!feedsLoading && feedsError && <Notice kind="warning">Discovery feed configuration is unavailable; source requests stay disabled.</Notice>}{!feedsLoading && !feedsError && !feed && <Notice kind="warning">No matching discovery feed is available for this source.</Notice>}{!feedsLoading && !feedsError && feed && !feed.enabled && <Notice kind="warning">This discovery feed is disabled for new source requests.</Notice>}{!feedsLoading && !feedsError && feed?.enabled && !canResolveProxy && <Notice kind="warning">Your session does not have the proxy:resolve permission.</Notice>}<div className="proxy-actions"><Button busy={busy} disabled={!canImport} type="button" onClick={() => void requestProxy()}>{ready ? 'Check source again' : 'Fetch and check source'}</Button>{ready && <Button busy={busy} disabled={!canImport} kind="quiet" type="button" onClick={() => void requestProxy(true)}>Refresh source</Button>}</div><div className="proxy-command"><span className="helper">{ready && reference ? 'CLI command using the configured private registry' : 'Canonical source reference pending'}</span>{ready && reference ? <div className="proxy-command-variants"><span className="helper">POSIX (bash/zsh)</span><code>{proxyInstallCommand('posix', selected.id, feed?.name ?? '', registryOrigin())}</code><span className="helper">PowerShell</span><code>{proxyInstallCommand('powershell', selected.id, feed?.name ?? '', registryOrigin())}</code></div> : <div className="proxy-command-pending"><code>{selected.id}</code><span className="helper">Request the source to receive its canonical registry reference before installing.</span></div>}<span className="helper">{ready && reference ? 'Install uses this catalog ID with the selected discovery feed; the verified source reference above records what the registry resolved.' : 'The catalog ID remains visible while the registry fetches, scans, and caches the source.'}</span></div>{operation && <Link to="/app/$section" params={{ section: 'operations' }}>View activity</Link>}</div></div>}
  </Panel>
}

function verifiedSourceReference(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 4 || value.length > 2_048 || !value.startsWith('@') || /[\u0000-\u001f\u007f\\?#%\s]/u.test(value)) return null
  const parts = value.slice(1).split('/')
  if (parts.length < 2 || !['github', 'web', 'snapshot'].includes(parts[0] ?? '') || parts.some((part) => !part || part === '.' || part === '..' || !/^[A-Za-z0-9._~-]+$/u.test(part))) return null
  return value
}

function proxyInstallCommand(shell: 'posix' | 'powershell', externalId: string, feedName: string, origin: string): string {
  const quote = shell === 'posix' ? quotePosix : quotePowerShell
  return `pskills install ${quote(externalId)} --feed ${quote(feedName)} --registry ${quote(origin)} --agent codex`
}

function registryOrigin() {
  return typeof window === 'undefined' ? '<private-registry-url>' : window.location.origin
}

function formatNumber(value: number) {
  return new Intl.NumberFormat().format(value)
}
