import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from '@tanstack/react-router'
import { api, ApiError, isApiErrorCode } from '../lib/api'
import { formatDate } from '../lib/format'
import { DirectoryFeedSelector } from '../components/DirectoryFeedSelector'
import { resolveSelectedDirectoryFeed, useDirectoryFeedSelection } from '../lib/directoryFeed'
import type { DirectoryFeed, SkillAuditResponse } from '../lib/types'
import { Badge, Button, DisconnectedState, EmptyState, ErrorState, Field, LoadingState, Notice, Panel } from '../components/Primitives'

function initialAuditId() {
  if (typeof window === 'undefined') return ''
  return window.sessionStorage.getItem('pskills.directory.audit.id') ?? ''
}

export function DirectoryAuditsView() {
  const { selectedFeedName, setSelectedFeedName } = useDirectoryFeedSelection()
  const [id, setId] = useState(initialAuditId)
  const [submittedId, setSubmittedId] = useState(initialAuditId)
  const [audits, setAudits] = useState<SkillAuditResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [disconnected, setDisconnected] = useState(false)
  const [feeds, setFeeds] = useState<DirectoryFeed[] | null>(null)
  const [feedsLoading, setFeedsLoading] = useState(true)
  const [feedsError, setFeedsError] = useState<string | null>(null)
  const loadGeneration = useRef(0)
  const feedGeneration = useRef(0)

  async function loadFeeds() {
    const generation = ++feedGeneration.current
    setFeedsLoading(true)
    setFeedsError(null)
    try {
      const response = await api.feeds()
      if (generation !== feedGeneration.current) return
      setFeeds(response.feeds)
    } catch (cause) {
      if (generation !== feedGeneration.current) return
      setFeeds(null)
      setFeedsError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not load configured source feeds.')
    } finally {
      if (generation === feedGeneration.current) setFeedsLoading(false)
    }
  }

  async function loadAudit(targetId: string) {
    const generation = ++loadGeneration.current
    setLoading(true)
    setError(null)
    setDisconnected(false)
    setAudits(null)
    const selectedFeed = resolveSelectedDirectoryFeed(selectedFeedName, feeds)
    if (selectedFeedName && selectedFeed === undefined) {
      setLoading(false)
      setError('The selected discovery feed is no longer available. Choose Global/default or reload the feed list.')
      return
    }
    try {
      const response = await api.directoryAudits(targetId, { feed: selectedFeed?.name })
      if (generation !== loadGeneration.current) return
      setAudits(response)
    } catch (cause) {
      if (generation !== loadGeneration.current) return
      if (cause instanceof ApiError && cause.status === 404) {
        const parts = targetId.split('/').filter(Boolean)
        setAudits({ id: targetId, source: parts.slice(0, -1).join('/') || targetId, slug: parts.at(-1) ?? targetId, audits: [] })
      } else if (isApiErrorCode(cause, 'DIRECTORY_NOT_CONFIGURED')) {
        setDisconnected(true)
        setError(null)
        setAudits(null)
      } else {
        setDisconnected(false)
        setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not load external audit evidence.')
        setAudits(null)
      }
    } finally {
      if (generation === loadGeneration.current) setLoading(false)
    }
  }

  useEffect(() => { void loadFeeds() }, [])
  useEffect(() => {
    if (submittedId && !feedsLoading) void loadAudit(submittedId)
  }, [feeds, feedsLoading, selectedFeedName, submittedId])

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const target = id.trim()
    if (target.split('/').length < 2) {
      ++loadGeneration.current
      setLoading(false)
      setSubmittedId('')
      setAudits(null)
      setDisconnected(false)
      setError('Enter the complete skills.sh external ID, such as owner/repository/skill.')
      return
    }
    setError(null)
    setDisconnected(false)
    setAudits(null)
    if (target === submittedId && !feedsLoading) {
      void loadAudit(target)
    } else {
      setLoading(true)
      setSubmittedId(target)
    }
    if (typeof window !== 'undefined') window.sessionStorage.setItem('pskills.directory.audit.id', target)
  }

  const evidenceFeed = audits?.feedName ?? (selectedFeedName || 'Global/default')
  return <div className="view-heading external-audits-view"><div className="page-intro"><div><span className="eyebrow eyebrow-cloud">Cloud directory</span><h1>External security audits</h1><p className="muted">Read partner evidence attached to a skills.sh listing. A remote pass is evidence only and never changes this registry’s scanner or approval state.</p></div><Link className="button button-primary" params={{ section: 'directory' }} to="/app/$section">Browse cloud skills</Link></div><Notice kind="info">This evidence is separate from the administrative audit log and from Private Skills scanner reports. A missing partner audit means unknown evidence, not a private scan failure.</Notice><Panel title="Check a cloud skill" description="Use the complete external source/slug identity from the cloud directory."><DirectoryFeedSelector error={feedsError} feeds={feeds} loading={feedsLoading} onChange={setSelectedFeedName} selectedFeedName={selectedFeedName} /><form className="directory-audit-form" onSubmit={submit}><Field label="External ID" hint="Copied from a cloud skill detail panel."><input onChange={(event) => setId(event.target.value)} placeholder="owner/repository/skill" value={id} /></Field><Button type="submit">Load external audits</Button></form></Panel>{disconnected ? <DisconnectedState title="External audits are disconnected" message="Partner evidence is unavailable because the public skills.sh connection is not configured. Your private scanner and administrative audit log remain available." action={<a className="button button-secondary" href="https://skills.sh" rel="noreferrer" target="_blank">Open skills.sh ↗</a>} /> : error && <ErrorState message={error} onRetry={() => submittedId ? void loadAudit(submittedId) : undefined} />}{submittedId && <Panel title="Partner evidence" description={`${submittedId} · ${evidenceFeed} · external source evidence`}>
    {loading ? <LoadingState label="Loading partner evidence…" /> : disconnected ? <Notice kind="info">Partner evidence is paused until the public source connection is configured.</Notice> : error ? <Notice kind="warning">No partner evidence is shown while the source is unavailable.</Notice> : audits && audits.audits.length === 0 ? <EmptyState title="No external audit yet" description="skills.sh returned no partner audit for this listing. Continue to rely on the Private Skills scanner and policy before admission." /> : audits && <div className="external-audit-list">{audits.audits.map((audit) => <article className="external-audit-card" key={`${audit.provider}:${audit.slug}:${audit.auditedAt}`}><div className="external-audit-heading"><div><span className="eyebrow eyebrow-cloud">Partner evidence</span><h2>{audit.provider}</h2><p>{audit.slug}</p></div><Badge tone={audit.status === 'pass' ? 'good' : audit.status === 'warn' ? 'warn' : 'bad'} value={audit.status} /></div><p className="external-audit-summary">{audit.summary}</p><div className="external-audit-meta"><span>Audited {formatDate(audit.auditedAt)}</span>{audit.riskLevel && <span>Risk {audit.riskLevel}</span>}{audit.categories && audit.categories.length > 0 && <span>{audit.categories.join(' · ')}</span>}</div></article>)}</div>}
  </Panel>}</div>
}
