import { useEffect, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { formatDate, shortDigest } from '../lib/format'
import type { ReviewRunView, ReviewSuggestionView } from '../lib/types'
import { Badge, Button, EmptyState, ErrorState, LoadingState, Notice, Panel } from '../components/Primitives'

export function ReviewsView() {
  const [runs, setRuns] = useState<ReviewRunView[] | null>(null)
  const [suggestions, setSuggestions] = useState<ReviewSuggestionView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)
  const [starting, setStarting] = useState(false)
  const [deciding, setDeciding] = useState<string | null>(null)

  async function load() {
    setError(null)
    try {
      const response = await api.reviews()
      setRuns(response.runs ?? [])
      setSuggestions(response.suggestions ?? [])
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not load Eve reviews.')
    }
  }

  useEffect(() => { void load() }, [])
  useEffect(() => {
    if (!runs?.some((run) => run.state === 'running')) return
    const timer = window.setInterval(() => void load(), 5000)
    return () => window.clearInterval(timer)
  }, [runs])

  async function startReview() {
    setStarting(true)
    setMessage(null)
    try {
      await api.startReview()
      setMessage({ kind: 'success', text: 'Eve’s daily review started. Suggestions will appear here when the session completes.' })
      await load()
    } catch (cause) {
      setMessage({ kind: 'error', text: cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not start the Eve review.' })
    } finally {
      setStarting(false)
    }
  }

  async function decide(suggestionId: string, decision: 'accepted' | 'dismissed') {
    setDeciding(suggestionId)
    setMessage(null)
    try {
      const response = await api.decideReview(suggestionId, decision)
      setSuggestions((current) => current?.map((item) => item.id === suggestionId ? response.suggestion : item) ?? current)
      setMessage({ kind: 'success', text: decision === 'accepted' ? 'Suggestion accepted for follow-up. No source or release was changed.' : 'Suggestion dismissed. No source or release was changed.' })
    } catch (cause) {
      setMessage({ kind: 'error', text: cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not record that review decision.' })
    } finally {
      setDeciding(null)
    }
  }

  const running = runs?.some((run) => run.state === 'running') ?? false
  if (error) return <div className="view-heading"><ReviewsIntro onStart={() => void startReview()} starting={starting} running={running} /><ErrorState message={error} onRetry={() => void load()} /></div>
  if (!runs || !suggestions) return <div className="view-heading"><ReviewsIntro onStart={() => void startReview()} starting={starting} running={running} /><Panel><LoadingState label="Loading Eve reviews…" /></Panel></div>

  const openSuggestions = suggestions.filter((suggestion) => suggestion.state === 'open')
  return <div className="view-heading"><ReviewsIntro onStart={() => void startReview()} starting={starting} running={running} /><div className="reviews-layout"><div className="reviews-main">{message && <Notice kind={message.kind}>{message.text}</Notice>}{openSuggestions.length === 0 ? <Panel className="eve-empty"><EmptyState title="No open suggestions" description={suggestions.length === 0 ? 'Eve has not recorded a daily review suggestion yet.' : 'All recorded suggestions have a decision.'} /></Panel> : openSuggestions.map((suggestion) => <SuggestionCard busy={deciding === suggestion.id} key={suggestion.id} onDecision={(decision) => void decide(suggestion.id, decision)} suggestion={suggestion} />)}</div><div className="reviews-side"><Panel title="Review history" description="Daily review runs recorded by the registry.">{runs.length === 0 ? <EmptyState title="No review runs yet" description="Start a daily review when you are ready to compare approved skills." /> : <div className="review-runs">{runs.map((run) => <div className="review-run" key={run.id}><div className="review-run-top"><strong>{formatDate(run.createdAt)}</strong><Badge value={run.state} /></div><span>{run.snapshot.length} candidate{run.snapshot.length === 1 ? '' : 's'} · {run.model}</span>{run.error && <small>{run.error}</small>}</div>)}</div>}</Panel><Panel className="eve-note" title="Eve’s boundary" description="Review suggestions support human decisions."><p className="helper">Accepting a suggestion records your decision for follow-up. It does not merge, publish, edit source, or authorize an install.</p></Panel></div></div><Panel title="Recorded suggestions" description="Past suggestions remain visible with their decision and review snapshot.">{suggestions.length === 0 ? <EmptyState title="Nothing recorded yet" description="Completed review sessions will appear here." /> : <div className="table-wrap"><table><thead><tr><th>Suggestion</th><th>Similarity</th><th>State</th><th>Created</th></tr></thead><tbody>{suggestions.map((suggestion) => <tr key={suggestion.id}><td><strong>{suggestion.title}</strong><span className="cell-sub">{suggestion.resourceIds.length} skills · {suggestion.id}</span></td><td>{formatSimilarity(suggestion.similarity)}</td><td><Badge value={suggestion.state} /></td><td>{formatDate(suggestion.createdAt)}</td></tr>)}</tbody></table></div>}</Panel></div>
}

function ReviewsIntro({ onStart, starting, running }: { onStart: () => void; starting: boolean; running: boolean }) {
  return <div className="page-intro"><div><span className="eyebrow eyebrow-eve">Eve daily review</span><h1>Review suggestions, together.</h1><p className="muted">Compare common approved skills and decide what deserves a closer human look. Eve proposes; your team decides.</p></div><Button kind="primary" busy={starting} disabled={running} onClick={onStart}>{running ? 'Review in progress' : 'Run today’s review'}</Button></div>
}

function SuggestionCard({ suggestion, busy, onDecision }: { suggestion: ReviewSuggestionView; busy: boolean; onDecision: (decision: 'accepted' | 'dismissed') => void }) {
  return <Panel className="eve-suggestion"><div className="eve-suggestion-header"><div><span className="eve-kicker">Eve’s suggestion</span><h2>{suggestion.title}</h2><p className="muted">{suggestion.rationale}</p></div><div className="eve-suggestion-score"><strong>{formatSimilarity(suggestion.similarity)}</strong><span>semantic overlap</span></div></div><div className="review-candidates">{suggestion.snapshot.map((candidate) => <div className="review-candidate" key={candidate.resourceId}><div className="skill-avatar" aria-hidden="true">{candidate.name.replace(/^@/, '').slice(0, 1).toUpperCase()}</div><div><strong>{candidate.name}</strong><span>{candidate.version} · {shortDigest(candidate.artifactDigest)}</span></div></div>)}</div><div className="review-analysis"><ReviewCopy label="Overlap" value={suggestion.overlap} /><ReviewCopy label="Key differences" value={suggestion.differences} /><ReviewCopy label="Merge plan" value={suggestion.mergePlan} /></div><div className="eve-suggestion-footer"><span className={`snapshot-state ${suggestion.snapshotValid ? 'snapshot-valid' : 'snapshot-stale'}`}><span aria-hidden="true">{suggestion.snapshotValid ? '✓' : '!'}</span>{suggestion.snapshotValid ? 'Snapshot still matches' : 'Snapshot needs review'}</span>{suggestion.state === 'open' && <div className="row-actions"><Button busy={busy} kind="quiet" onClick={() => onDecision('dismissed')}>Dismiss</Button><Button busy={busy} kind="primary" onClick={() => onDecision('accepted')}>Accept suggestion</Button></div>}</div></Panel>
}

function ReviewCopy({ label, value }: { label: string; value: string }) {
  return <div><strong>{label}</strong><p>{value}</p></div>
}

function formatSimilarity(value: number) {
  return `${Math.round(value * 100)}%`
}
