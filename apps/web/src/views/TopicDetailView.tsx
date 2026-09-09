import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { Badge, Button, DisconnectedState, EmptyState, ErrorState, LoadingState, Notice, Panel } from '../components/Primitives'
import { api, ApiError, isApiErrorCode } from '../lib/api'
import { formatDate } from '../lib/format'
import type { SkillsTopicLink, SkillsTopicResponse, SkillsTopicSkill } from '../lib/types'

export function TopicDetailView({ slug }: { slug: string }) {
  const navigate = useNavigate()
  const [topic, setTopic] = useState<SkillsTopicResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [disconnected, setDisconnected] = useState(false)
  const [retry, setRetry] = useState(0)
  const loadGeneration = useRef(0)

  useEffect(() => {
    const generation = ++loadGeneration.current
    setLoading(true)
    setError(null)
    setDisconnected(false)
    setTopic(null)
    void api.directoryTopic(slug).then((response) => {
      if (generation !== loadGeneration.current) return
      setTopic(response)
    }).catch((cause: unknown) => {
      if (generation !== loadGeneration.current) return
      if (isApiErrorCode(cause, 'DIRECTORY_NOT_CONFIGURED')) {
        setDisconnected(true)
        setError(null)
      } else {
        setDisconnected(false)
        setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not load this cloud topic.')
      }
    }).finally(() => {
      if (generation === loadGeneration.current) setLoading(false)
    })
    return () => { ++loadGeneration.current }
  }, [retry, slug])

  function findMatches() {
    if (typeof window !== 'undefined') window.sessionStorage.setItem('pskills.directory.topic.query', topic?.title ?? slug)
    void navigate({ to: '/app/$section', params: { section: 'directory' } })
  }

  const heading = topic?.title ?? topicTitle(slug)
  const sourceUrl = topic?.sourceUrl ?? `https://www.skills.sh/topic/${encodeURIComponent(slug)}`

  return <div className="view-heading topic-detail-view">
    <div className="page-intro"><div><span className="eyebrow eyebrow-cloud">Cloud directory · Topic</span><h1>{heading}</h1><p className="muted">A bounded metadata snapshot from the official skills.sh topic page. Its links describe the upstream category and do not grant private approval.</p></div><div className="page-actions"><Link className="button button-secondary" to="/app/$section" params={{ section: 'topics' }}>All topics</Link><a className="button button-primary" href={sourceUrl} rel="noreferrer" target="_blank">Open upstream ↗</a></div></div>
    {loading ? <Panel><LoadingState label="Reading the official topic page…" /></Panel> : disconnected ? <DisconnectedState title="Topic pages are disconnected" message="The public skills.sh connection is not configured for this registry. Your private catalog, packs, and policy remain available." action={<a className="button button-secondary" href="https://www.skills.sh/topic" rel="noreferrer" target="_blank">Open skills.sh topics ↗</a>} /> : error ? <ErrorState message={error} onRetry={() => setRetry((value) => value + 1)} /> : topic && topic.status !== 'fresh' ? <TopicUnavailable topic={topic} onRetry={() => setRetry((value) => value + 1)} /> : topic ? <TopicDocument topic={topic} onFindMatches={findMatches} /> : <ErrorState message="The topic response was empty." onRetry={() => setRetry((value) => value + 1)} />}
  </div>
}

function TopicUnavailable({ topic, onRetry }: { topic: SkillsTopicResponse; onRetry: () => void }) {
  const stale = topic.status === 'stale'
  return <Panel className="topic-state-panel"><div className="topic-state-icon" aria-hidden="true">{stale ? '!' : '—'}</div><div><Badge tone={stale ? 'warn' : 'muted'} value={stale ? 'stale' : 'unavailable'} /><h2>{stale ? 'Topic page needs a parser update' : 'Topic page unavailable'}</h2><p className="muted">{topic.reason ?? (stale ? 'The upstream page shape changed before its metadata could be recognized.' : 'skills.sh did not return this topic page.')}</p><div className="row-actions"><Button kind="secondary" type="button" onClick={onRetry}>Try again</Button><a className="button button-quiet" href={topic.sourceUrl} rel="noreferrer" target="_blank">Open upstream ↗</a></div></div><TopicProvenance topic={topic} /></Panel>
}

function TopicDocument({ topic, onFindMatches }: { topic: SkillsTopicResponse; onFindMatches: () => void }) {
  return <>
    <Panel className="topic-document" title="Topic snapshot" description="The page structure was recognized and normalized into source-backed text and links.">
      <div className="topic-document-grid"><div className="topic-document-main">
        <div className="topic-document-heading"><div><Badge tone="good" value="fresh" /><h2>{topic.title}</h2><p className="muted">{topic.description}</p></div><Button kind="secondary" type="button" onClick={onFindMatches}>Find matching skills</Button></div>
        <section className="topic-section" aria-labelledby="topic-capabilities-heading"><div className="topic-section-heading"><h3 id="topic-capabilities-heading">What your agent can do</h3><span className="helper">{topic.capabilities.length} item{topic.capabilities.length === 1 ? '' : 's'} from the page</span></div>{topic.capabilities.length === 0 ? <EmptyState title="No capability list returned" description="The page was recognized, but it did not publish capability bullets for this snapshot." /> : <ul className="topic-capabilities">{topic.capabilities.map((capability) => <li key={capability}>{capability}</li>)}</ul>}</section>
        <section className="topic-section" aria-labelledby="topic-skills-heading"><div className="topic-section-heading"><h3 id="topic-skills-heading">Skills linked from this topic</h3><span className="helper">{topic.skills.length} link{topic.skills.length === 1 ? '' : 's'} captured</span></div>{topic.skills.length === 0 ? <EmptyState title="No skill links returned" description="The recognized page did not expose any skill links in this snapshot." /> : <div className="topic-skill-list">{topic.skills.map((skill) => <TopicSkillRow key={skill.id} skill={skill} />)}</div>}</section>
        <section className="topic-section" aria-labelledby="topic-agents-heading"><h3 id="topic-agents-heading">Works with your agent</h3><Notice kind="info">{topic.compatibleAgents ?? 'The source did not provide compatible-agent copy for this snapshot.'}</Notice></section>
        {topic.faqs.length > 0 && <section className="topic-section" aria-labelledby="topic-faq-heading"><h3 id="topic-faq-heading">Frequently asked questions</h3><div className="topic-faq-list">{topic.faqs.map((faq) => <details key={faq.question}><summary>{faq.question}</summary><p className="muted">{faq.answer}</p></details>)}</div></section>}
      </div><aside className="topic-document-side"><TopicProvenance topic={topic} /><RelatedTopics topics={topic.relatedTopics} /></aside></div>
    </Panel>
  </>
}

function TopicSkillRow({ skill }: { skill: SkillsTopicSkill }) {
  return <a className="topic-skill-row" href={skill.url} rel="noreferrer" target="_blank"><span className="topic-skill-main"><strong>{skill.name}</strong><span>{skill.source}/{skill.slug}</span></span><span className="topic-skill-description">{skill.description}</span><span className="topic-skill-arrow" aria-hidden="true">↗</span></a>
}

function RelatedTopics({ topics }: { topics: SkillsTopicLink[] }) {
  return <section className="topic-related" aria-labelledby="topic-related-heading"><div className="topic-section-heading"><h3 id="topic-related-heading">Related topics</h3><span className="helper">{topics.length} link{topics.length === 1 ? '' : 's'}</span></div>{topics.length === 0 ? <p className="helper">No related topic links were returned.</p> : <div className="topic-related-list">{topics.map((related) => <Link key={related.slug} className="topic-related-link" params={{ slug: related.slug }} to="/app/topic/$slug">{related.name}<span aria-hidden="true">↗</span></Link>)}</div>}</section>
}

function TopicProvenance({ topic }: { topic: SkillsTopicResponse }) {
  return <div className="topic-provenance"><div className="topic-provenance-heading"><h3>Source provenance</h3><Badge tone="muted" value={topic.provider} /></div><dl><div><dt>Source URL</dt><dd><a href={topic.sourceUrl} rel="noreferrer" target="_blank">{topic.sourceUrl}</a></dd></div><div><dt>Fetched</dt><dd>{formatDate(topic.fetchedAt)}</dd></div><div><dt>Parser revision</dt><dd><code>{topic.parserRevision}</code></dd></div></dl></div>
}

function topicTitle(slug: string): string {
  return slug.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')
}
