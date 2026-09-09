import { useEffect, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { formatDate } from '../lib/format'
import type { AuditEvent } from '../lib/types'
import { Button, EmptyState, ErrorState, LoadingState, Panel } from '../components/Primitives'

export function AuditView() {
  const [events, setEvents] = useState<AuditEvent[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    setError(null)
    try {
      const response = await api.audit()
      setEvents(response.events ?? [])
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not load the audit log.')
    }
  }
  useEffect(() => { void load() }, [])

  return <div className="view-heading"><div><span className="eyebrow">Administrative history</span><h1>Audit log</h1><p className="muted">See who changed what and when. Sensitive credentials and private file contents are never shown here.</p></div><Panel title="Recent events" action={<Button kind="quiet" onClick={() => void load()}>Refresh</Button>}>{error ? <ErrorState message={error} onRetry={() => void load()} /> : events === null ? <LoadingState /> : events.length === 0 ? <EmptyState title="No audit events" description="Administrative actions will appear here as the registry changes." /> : <div className="table-wrap"><table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Resource</th><th>Details</th></tr></thead><tbody>{events.map((event) => <tr key={event.id}><td>{formatDate(event.createdAt)}</td><td>{event.subject}</td><td><strong>{event.action}</strong></td><td>{event.resourceId ?? '—'}</td><td>{event.details ? <code>{JSON.stringify(event.details)}</code> : '—'}</td></tr>)}</tbody></table></div>}</Panel></div>
}
