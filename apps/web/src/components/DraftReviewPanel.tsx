import { useEffect, useMemo, useRef, useState } from 'react'
import { api, ApiError } from '../lib/api'
import type { DraftReviewFinding, DraftReviewJob, DraftReviewResult, DraftReviewsResponse, DraftView } from '../lib/types'
import { Badge, Button, EmptyState, ErrorState, LoadingState, Notice, Panel } from './Primitives'

interface DraftReviewPanelProps {
  draft: DraftView
  disabled?: boolean
}

function sameBinding(value: DraftReviewJob | DraftReviewResult, draft: DraftView): boolean {
  return value.binding.draftId === draft.id && value.binding.draftRevision === draft.revision && value.binding.contentDigest === draft.digest
}

function reviewMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.code === 'REVIEW_UNAVAILABLE') return 'The review service is not connected. Required security scanners remain the release authority.'
    return cause.message
  }
  return cause instanceof Error ? cause.message : 'The review request failed.'
}

function severityTone(severity: DraftReviewFinding['severity']): 'good' | 'warn' | 'bad' | 'muted' {
  if (severity === 'critical' || severity === 'high') return 'bad'
  if (severity === 'medium') return 'warn'
  if (severity === 'low') return 'muted'
  return 'good'
}

export function newestFirst<T>(items: readonly T[]): T | undefined {
  return items[0]
}

export function DraftReviewPanel({ draft, disabled = false }: DraftReviewPanelProps) {
  const [reviews, setReviews] = useState<DraftReviewsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<'request' | 'retry' | string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const requestGeneration = useRef(0)

  async function load(): Promise<void> {
    const generation = ++requestGeneration.current
    setLoading(true)
    setError(null)
    try {
      const response = await api.draftReviews(draft.id)
      if (generation !== requestGeneration.current) return
      setReviews(response)
    } catch (cause) {
      if (generation !== requestGeneration.current) return
      setReviews(null)
      setError(reviewMessage(cause))
    } finally {
      if (generation === requestGeneration.current) setLoading(false)
    }
  }

  useEffect(() => {
    requestGeneration.current += 1
    setReviews(null)
    setMessage(null)
    void load()
    return () => { requestGeneration.current += 1 }
  }, [draft.digest, draft.id, draft.revision])

  const currentJobs = useMemo(() => reviews?.reviews.filter((review) => sameBinding(review, draft)) ?? [], [draft, reviews])
  const currentResults = useMemo(() => reviews?.results.filter((result) => sameBinding(result, draft)) ?? [], [draft, reviews])
  // The registry returns both collections newest-first. Keep the server's
  // ordering so decisions and retries stay pinned to the current snapshot.
  const latestJob = newestFirst(currentJobs)
  const latestResult = newestFirst(currentResults)
  const canRetry = latestJob !== undefined && (latestJob.state === 'failed' || latestJob.state === 'stale')

  async function requestReview(): Promise<void> {
    if (disabled || busy) return
    setBusy('request')
    setError(null)
    setMessage(null)
    try {
      await api.requestDraftReview(draft.id)
      setMessage('Review queued for this saved draft revision.')
      await load()
    } catch (cause) {
      setError(reviewMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  async function retryReview(): Promise<void> {
    if (disabled || busy || !latestJob) return
    setBusy('retry')
    setError(null)
    setMessage(null)
    try {
      await api.retryDraftReview(draft.id, latestJob.id)
      setMessage('A new review attempt was queued for this revision.')
      await load()
    } catch (cause) {
      setError(reviewMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  async function decide(finding: DraftReviewFinding, decision: 'acknowledged' | 'dismissed'): Promise<void> {
    if (disabled || busy || !latestResult) return
    setBusy(finding.id)
    setError(null)
    setMessage(null)
    try {
      await api.decideDraftReview(draft.id, latestResult.id, { findingId: finding.id, decision })
      setMessage(`Finding ${decision}.`)
      await load()
    } catch (cause) {
      setError(reviewMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  return <Panel className="draft-review-panel" title="Review" description="Eve review is advisory. Required security scanners still decide whether a release can be installed." action={<div className="row-actions"><Button kind="secondary" busy={busy === 'request'} disabled={disabled || busy !== null || loading} type="button" onClick={() => void requestReview()}>{latestJob ? 'Run review again' : 'Request Eve review'}</Button>{canRetry && <Button kind="quiet" busy={busy === 'retry'} disabled={disabled || busy !== null} type="button" onClick={() => void retryReview()}>Retry</Button>}</div>}>
    {loading && <LoadingState label="Loading review status…" />}
    {!loading && error && <ErrorState message={error} onRetry={() => void load()} />}
    {!loading && !error && message && <div className="draft-review-message"><Notice kind="success">{message}</Notice></div>}
    {!loading && !error && !latestJob && !latestResult && <EmptyState title="No Eve review for this revision" description="Request an advisory review after saving the draft. The reviewer receives the bounded saved snapshot." action={<Button kind="secondary" disabled={disabled || busy !== null} type="button" onClick={() => void requestReview()}>Request Eve review</Button>} />}
    {!loading && !error && (latestJob || latestResult) && <div className="draft-review-body">
      {latestJob && <div className="draft-review-status"><div><span className="eyebrow">Review job</span><strong>{latestJob.state === 'passed' ? 'Review complete' : latestJob.state}</strong><span className="helper">Reviewer {latestJob.reviewerRevision} · model {latestJob.model}</span></div><Badge value={latestJob.state === 'passed' ? 'review complete' : latestJob.state} /></div>}
      {latestJob?.error && <Notice kind="warning">{latestJob.error}</Notice>}
      {latestJob?.staleReason && <Notice kind="warning">This result is stale: {latestJob.staleReason}</Notice>}
      {latestResult && <div className="draft-review-result"><div className="draft-review-result-heading"><div><strong>Findings</strong><span className="helper">{latestResult.findings.length} finding{latestResult.findings.length === 1 ? '' : 's'} · {latestResult.state === 'passed' ? 'Review complete' : latestResult.state}</span></div><Badge tone={latestResult.state === 'failed' ? 'warn' : undefined} value={latestResult.state === 'passed' ? 'review complete' : latestResult.state} /></div>{latestResult.error && <Notice kind="warning">{latestResult.error}</Notice>}{latestResult.findings.length === 0 ? <p className="helper">No findings were returned for this snapshot.</p> : <div className="draft-review-findings">{latestResult.findings.map((finding) => <FindingCard busy={busy === finding.id} disabled={disabled || busy !== null} finding={finding} key={finding.id} onDecision={(decision) => void decide(finding, decision)} />)}</div>}</div>}
    </div>}
  </Panel>
}

function FindingCard({ finding, busy, disabled, onDecision }: { finding: DraftReviewFinding; busy: boolean; disabled: boolean; onDecision: (decision: 'acknowledged' | 'dismissed') => void }) {
  return <article className="draft-review-finding"><div className="draft-review-finding-top"><div><Badge tone={severityTone(finding.severity)} value={finding.severity} /><strong>{finding.title}</strong></div><Badge value={finding.decision} /></div><p>{finding.summary}</p>{(finding.path || finding.line !== undefined) && <code>{finding.path ?? 'Skill'}{finding.line === undefined ? '' : `:${finding.line}`}</code>}{finding.evidence && <details><summary>Evidence</summary><pre>{finding.evidence}</pre></details>}{finding.recommendation && <p className="helper">Suggested next step: {finding.recommendation}</p>}{finding.decision === 'open' && <div className="row-actions"><Button kind="quiet" busy={busy} disabled={disabled} type="button" onClick={() => onDecision('acknowledged')}>Acknowledge</Button><Button kind="quiet" busy={busy} disabled={disabled} type="button" onClick={() => onDecision('dismissed')}>Dismiss</Button></div>}</article>
}
