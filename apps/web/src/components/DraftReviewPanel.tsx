import { useEffect, useMemo, useRef, useState } from 'react'
import { api, ApiError } from '../lib/api'
import type { DraftReviewFinding, DraftReviewJob, DraftReviewResult, DraftReviewsResponse, DraftView } from '../lib/types'
import { Badge, Button, EmptyState, ErrorState, LoadingState, Notice, Panel } from './Primitives'

interface DraftReviewPanelProps {
  draft: DraftView
  disabled?: boolean
}

type ReviewBusy = 'request' | 'retry' | string
interface MutationToken { binding: string; generation: number }
interface DismissTarget { resultId: string; findingId: string }

const REVIEW_POLL_ATTEMPTS = 5
const REVIEW_POLL_INTERVAL_MS = 500
const MAX_DISMISS_REASON_LENGTH = 1_000

function draftBindingKey(draft: DraftView): string {
  return JSON.stringify([draft.id, draft.revision, draft.digest])
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

function reviewJobId(review: DraftReviewJob | DraftReviewResult): string {
  return 'jobId' in review ? review.jobId : review.id
}

function isReviewPending(job: DraftReviewJob): boolean {
  return job.state === 'pending' || job.state === 'running'
}

function reviewLiveMessage(loading: boolean, error: string | null, job: DraftReviewJob | undefined, result: DraftReviewResult | undefined): string {
  if (loading) return 'Loading review status.'
  if (error) return 'Review status is unavailable.'
  if (job) return `Review job ${job.state === 'passed' ? 'complete' : job.state}.`
  if (result) return `Review result ${result.state}.`
  return 'No review for this draft revision.'
}

function reviewMutationMessage(review: DraftReviewJob | DraftReviewResult, operation: 'request' | 'retry'): string {
  if (review.state === 'pending') return operation === 'request' ? 'Review queued for this saved draft revision.' : 'A new review attempt was queued for this revision.'
  if (review.state === 'running') return 'Review is already running for this saved draft revision.'
  if (review.state === 'passed') return operation === 'request' ? 'A completed review already exists for this saved draft revision.' : 'Review is complete for this saved draft revision.'
  if (review.state === 'failed') return operation === 'request' ? 'An existing review attempt failed for this saved draft revision.' : 'The review retry is still marked failed.'
  return operation === 'request' ? 'An existing review attempt is stale for this saved draft revision.' : 'The review retry is still marked stale.'
}

function waitForReviewPoll(): Promise<void> {
  return new Promise((resolve) => { window.setTimeout(resolve, REVIEW_POLL_INTERVAL_MS) })
}

export function newestFirst<T>(items: readonly T[]): T | undefined {
  return items[0]
}

export function DraftReviewPanel({ draft, disabled = false }: DraftReviewPanelProps) {
  const [reviews, setReviews] = useState<DraftReviewsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<ReviewBusy | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [dismissTarget, setDismissTarget] = useState<DismissTarget | null>(null)
  const [dismissReason, setDismissReason] = useState('')
  const [focusFindingId, setFocusFindingId] = useState<string | null>(null)
  const requestGeneration = useRef(0)
  const mutationGeneration = useRef(0)
  const mountedRef = useRef(false)
  const activeBindingRef = useRef(draftBindingKey(draft))
  activeBindingRef.current = draftBindingKey(draft)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      requestGeneration.current += 1
      mutationGeneration.current += 1
    }
  }, [])

  async function load(nextDraft: DraftView): Promise<DraftReviewsResponse | null> {
    const binding = draftBindingKey(nextDraft)
    if (!mountedRef.current || activeBindingRef.current !== binding) return null
    const generation = ++requestGeneration.current
    setLoading(true)
    setError(null)
    try {
      const response = await api.draftReviews(nextDraft.id)
      if (!mountedRef.current || generation !== requestGeneration.current || activeBindingRef.current !== binding) return null
      setReviews(response)
      return response
    } catch (cause) {
      if (!mountedRef.current || generation !== requestGeneration.current || activeBindingRef.current !== binding) return null
      setReviews(null)
      setError(reviewMessage(cause))
      return null
    } finally {
      if (mountedRef.current && generation === requestGeneration.current && activeBindingRef.current === binding) setLoading(false)
    }
  }

  useEffect(() => {
    requestGeneration.current += 1
    mutationGeneration.current += 1
    setBusy(null)
    setReviews(null)
    setMessage(null)
    setDismissTarget(null)
    setDismissReason('')
    setFocusFindingId(null)
    void load(draft)
    return () => {
      requestGeneration.current += 1
      mutationGeneration.current += 1
    }
  }, [draft.digest, draft.id, draft.revision])

  const currentJobs = useMemo(() => reviews?.reviews.filter((review) => sameBinding(review, draft)) ?? [], [draft.digest, draft.id, draft.revision, reviews])
  const currentResults = useMemo(() => reviews?.results.filter((result) => sameBinding(result, draft)) ?? [], [draft.digest, draft.id, draft.revision, reviews])
  // The registry returns both collections newest-first. Keep the server's
  // ordering so decisions and retries stay pinned to the current snapshot.
  const latestJob = newestFirst(currentJobs)
  // A requeued job clears resultId while its previous result is retained for
  // audit history. Only the result explicitly attached to the current job is
  // actionable, so pending work cannot show superseded findings.
  const latestResult = latestJob === undefined || isReviewPending(latestJob) || latestJob.resultId === undefined
    ? undefined
    : currentResults.find((result) => result.id === latestJob.resultId && result.jobId === latestJob.id)
  const canRetry = latestJob !== undefined && (latestJob.state === 'failed' || latestJob.state === 'stale')
  const reviewInProgress = latestJob !== undefined && isReviewPending(latestJob)

  function mutationIsCurrent(token: MutationToken): boolean {
    return mountedRef.current && activeBindingRef.current === token.binding && mutationGeneration.current === token.generation
  }

  function beginMutation(kind: ReviewBusy, binding: string): MutationToken | null {
    if (!mountedRef.current || activeBindingRef.current !== binding || busy !== null) return null
    const generation = mutationGeneration.current + 1
    mutationGeneration.current = generation
    setBusy(kind)
    return { binding, generation }
  }

  async function refreshUntilSettled(nextDraft: DraftView, targetJobId: string, token: MutationToken): Promise<void> {
    for (let attempt = 0; attempt < REVIEW_POLL_ATTEMPTS; attempt += 1) {
      if (!mutationIsCurrent(token)) return
      const response = await load(nextDraft)
      if (!mutationIsCurrent(token)) return
      const targetJob = response?.reviews.find((job) => job.id === targetJobId && sameBinding(job, nextDraft))
      if (targetJob && !isReviewPending(targetJob)) return
      if (attempt + 1 < REVIEW_POLL_ATTEMPTS) await waitForReviewPoll()
    }
  }

  async function requestReview(): Promise<void> {
    if (disabled) return
    if (latestJob && !isReviewPending(latestJob)) {
      await retryReview()
      return
    }
    const binding = draftBindingKey(draft)
    const token = beginMutation('request', binding)
    if (token === null) return
    setError(null)
    setMessage(null)
    try {
      const response = await api.requestDraftReview(draft.id)
      if (!mutationIsCurrent(token)) return
      setMessage(reviewMutationMessage(response.review, 'request'))
      await refreshUntilSettled(draft, reviewJobId(response.review), token)
    } catch (cause) {
      if (mutationIsCurrent(token)) setError(reviewMessage(cause))
    } finally {
      if (mutationIsCurrent(token)) setBusy(null)
    }
  }

  async function retryReview(): Promise<void> {
    if (disabled || !latestJob || isReviewPending(latestJob)) return
    const binding = draftBindingKey(draft)
    const token = beginMutation('retry', binding)
    if (token === null) return
    setError(null)
    setMessage(null)
    try {
      const response = await api.retryDraftReview(draft.id, latestJob.id)
      if (!mutationIsCurrent(token)) return
      setMessage(reviewMutationMessage(response.review, 'retry'))
      await refreshUntilSettled(draft, reviewJobId(response.review), token)
    } catch (cause) {
      if (mutationIsCurrent(token)) setError(reviewMessage(cause))
    } finally {
      if (mutationIsCurrent(token)) setBusy(null)
    }
  }

  async function decide(finding: DraftReviewFinding, decision: 'acknowledged' | 'dismissed', reason?: string, resultId?: string): Promise<void> {
    if (disabled || !latestJob || latestJob.state !== 'passed' || !latestResult || latestResult.state !== 'passed' || (resultId !== undefined && latestResult.id !== resultId)) return
    const result = latestResult
    const cleanReason = reason?.trim()
    if (decision === 'dismissed' && !cleanReason) {
      setError('Enter a reason before dismissing this finding.')
      return
    }
    const binding = draftBindingKey(draft)
    const token = beginMutation(finding.id, binding)
    if (token === null) return
    setError(null)
    setMessage(null)
    try {
      await api.decideDraftReview(draft.id, result.id, {
        findingId: finding.id,
        decision,
        ...(cleanReason === undefined ? {} : { reason: cleanReason }),
      })
      if (!mutationIsCurrent(token)) return
      setMessage(`Finding ${decision}.`)
      if (decision === 'dismissed') {
        setDismissTarget(null)
        setDismissReason('')
        setFocusFindingId(finding.id)
      }
      await load(draft)
    } catch (cause) {
      if (mutationIsCurrent(token)) setError(reviewMessage(cause))
    } finally {
      if (mutationIsCurrent(token)) setBusy(null)
    }
  }

  function openDismissal(finding: DraftReviewFinding): void {
    if (disabled || busy !== null || !latestJob || latestJob.state !== 'passed' || !latestResult || latestResult.state !== 'passed') return
    setError(null)
    setMessage(null)
    setDismissTarget({ resultId: latestResult.id, findingId: finding.id })
    setDismissReason('')
  }

  function cancelDismissal(): void {
    if (busy !== null) return
    setDismissTarget(null)
    setDismissReason('')
  }

  function submitDismissal(finding: DraftReviewFinding): void {
    if (!dismissTarget || !latestResult || dismissTarget.resultId !== latestResult.id || dismissTarget.findingId !== finding.id) {
      cancelDismissal()
      return
    }
    void decide(finding, 'dismissed', dismissReason, dismissTarget.resultId)
  }

  function refreshStatus(): void {
    if (disabled || busy !== null || loading) return
    void load(draft)
  }

  useEffect(() => {
    if (loading || focusFindingId === null) return
    document.getElementById(`draft-review-finding-${focusFindingId}`)?.focus()
    setFocusFindingId(null)
  }, [focusFindingId, loading, reviews])

  return <Panel className="draft-review-panel" title="Review" description="Eve review is advisory. Required security scanners still decide whether a release can be installed." action={<div className="row-actions">{latestJob && isReviewPending(latestJob) && <Button kind="quiet" disabled={disabled || busy !== null || loading} type="button" onClick={refreshStatus}>Refresh status</Button>}<Button kind="secondary" busy={busy === 'request' || busy === 'retry'} disabled={disabled || busy !== null || loading || reviewInProgress} type="button" onClick={() => void requestReview()}>{latestJob ? latestJob.state === 'pending' ? 'Review pending' : latestJob.state === 'running' ? 'Review running' : 'Run review again' : 'Request Eve review'}</Button>{canRetry && <Button kind="quiet" busy={busy === 'retry'} disabled={disabled || busy !== null} type="button" onClick={() => void retryReview()}>Retry</Button>}</div>}>
    <div aria-atomic="true" aria-busy={loading || busy !== null} aria-live="polite" className="draft-review-live-region" role="status">{reviewLiveMessage(loading, error, latestJob, latestResult)}</div>
    {loading && <LoadingState label="Loading review status…" />}
    {!loading && error && <ErrorState message={error} onRetry={busy === null && !disabled ? () => void load(draft) : undefined} />}
    {!loading && !error && message && <div className="draft-review-message"><Notice kind="success">{message}</Notice></div>}
    {!loading && !error && !latestJob && !latestResult && <EmptyState title="No Eve review for this revision" description="Request an advisory review after saving the draft. The reviewer receives the bounded saved snapshot." action={<Button kind="secondary" disabled={disabled || busy !== null} type="button" onClick={() => void requestReview()}>Request Eve review</Button>} />}
    {!loading && !error && (latestJob || latestResult) && <div className="draft-review-body">
      {latestJob && <div className="draft-review-status"><div><span className="eyebrow">Review job</span><strong>{latestJob.state === 'passed' ? 'Review complete' : latestJob.state}</strong><span className="helper">Reviewer {latestJob.reviewerRevision} · model {latestJob.model}</span></div><Badge value={latestJob.state === 'passed' ? 'review complete' : latestJob.state} /></div>}
      {latestJob?.error && <Notice kind="warning">{latestJob.error}</Notice>}
      {latestJob?.staleReason && <Notice kind="warning">This result is stale: {latestJob.staleReason}</Notice>}
      {latestResult && <div className="draft-review-result"><div className="draft-review-result-heading"><div><strong>Findings</strong><span className="helper">{latestResult.findings.length} finding{latestResult.findings.length === 1 ? '' : 's'} · {latestResult.state === 'passed' ? 'Review complete' : latestResult.state}</span></div><Badge tone={latestResult.state === 'failed' ? 'warn' : undefined} value={latestResult.state === 'passed' ? 'review complete' : latestResult.state} /></div>{latestResult.error && <Notice kind="warning">{latestResult.error}</Notice>}{latestResult.findings.length === 0 ? <p className="helper">No findings were returned for this snapshot.</p> : <div className="draft-review-findings">{latestResult.findings.map((finding) => <FindingCard allowDecisions={latestResult.state === 'passed' && latestJob?.state === 'passed'} busy={busy === finding.id} disabled={disabled || busy !== null} dismissOpen={dismissTarget?.resultId === latestResult.id && dismissTarget.findingId === finding.id} dismissReason={dismissTarget?.resultId === latestResult.id && dismissTarget.findingId === finding.id ? dismissReason : ''} finding={finding} key={finding.id} onAcknowledge={() => void decide(finding, 'acknowledged', undefined, latestResult.id)} onDismiss={() => openDismissal(finding)} onDismissCancel={cancelDismissal} onDismissReasonChange={setDismissReason} onDismissSubmit={() => submitDismissal(finding)} />)}</div>}</div>}
    </div>}
  </Panel>
}

function FindingCard({ finding, busy, disabled, allowDecisions, dismissOpen, dismissReason, onAcknowledge, onDismiss, onDismissCancel, onDismissReasonChange, onDismissSubmit }: {
  finding: DraftReviewFinding
  busy: boolean
  disabled: boolean
  allowDecisions: boolean
  dismissOpen: boolean
  dismissReason: string
  onAcknowledge: () => void
  onDismiss: () => void
  onDismissCancel: () => void
  onDismissReasonChange: (reason: string) => void
  onDismissSubmit: () => void
}) {
  const reasonId = `dismiss-reason-${finding.id}`
  const reasonHintId = `${reasonId}-hint`
  const reasonRef = useRef<HTMLTextAreaElement>(null)
  const wasDismissOpen = useRef(false)

  useEffect(() => {
    if (dismissOpen) reasonRef.current?.focus()
    else if (wasDismissOpen.current) document.getElementById(`dismiss-trigger-${finding.id}`)?.focus()
    wasDismissOpen.current = dismissOpen
  }, [dismissOpen, finding.id])

  return <article className="draft-review-finding" id={`draft-review-finding-${finding.id}`} tabIndex={-1}><div className="draft-review-finding-top"><div><Badge tone={severityTone(finding.severity)} value={finding.severity} /><strong>{finding.title}</strong></div><Badge value={finding.decision} /></div><p>{finding.summary}</p>{(finding.path || finding.line !== undefined) && <code>{finding.path ?? 'Skill'}{finding.line === undefined ? '' : `:${finding.line}`}</code>}{finding.evidence && <details><summary>Evidence</summary><pre>{finding.evidence}</pre></details>}{finding.recommendation && <p className="helper">Suggested next step: {finding.recommendation}</p>}{finding.decisionReason && <p className="helper">Decision reason: {finding.decisionReason}</p>}{finding.decision === 'open' && allowDecisions && <div className="row-actions"><Button kind="quiet" busy={busy} disabled={disabled} type="button" onClick={onAcknowledge}>Acknowledge</Button><Button id={`dismiss-trigger-${finding.id}`} kind="quiet" disabled={disabled || dismissOpen} type="button" onClick={onDismiss}>Dismiss</Button></div>}{finding.decision === 'open' && !allowDecisions && <p className="helper">Actions are unavailable for this review result.</p>}{dismissOpen && finding.decision === 'open' && allowDecisions && <div className="draft-review-dismissal" aria-labelledby={`${reasonId}-label`} role="group"><strong id={`${reasonId}-label`}>Reason for dismissal</strong><label htmlFor={reasonId}>Reason (required)</label><textarea aria-describedby={reasonHintId} aria-required="true" disabled={disabled || busy} id={reasonId} maxLength={MAX_DISMISS_REASON_LENGTH} onChange={(event) => onDismissReasonChange(event.target.value)} ref={reasonRef} value={dismissReason} /><span className="field-hint" id={reasonHintId}>Explain why this finding should be dismissed. This reason is retained in the audit record.</span><div className="row-actions"><Button kind="quiet" disabled={disabled || busy} type="button" onClick={onDismissCancel}>Cancel</Button><Button kind="danger" busy={busy} disabled={disabled || busy || dismissReason.trim().length === 0} type="button" onClick={onDismissSubmit}>Submit dismissal</Button></div></div>}</article>
}
