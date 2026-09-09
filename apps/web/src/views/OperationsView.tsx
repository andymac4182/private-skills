import { useEffect, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { formatDate, titleCase } from '../lib/format'
import type { Job } from '../lib/types'
import { Badge, Button, EmptyState, ErrorState, LoadingState, Panel } from '../components/Primitives'

export function OperationsView() {
  const [operations, setOperations] = useState<Job[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    setError(null)
    try {
      const response = await api.operations()
      setOperations(response.operations ?? [])
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not load operations.')
    }
  }

  useEffect(() => { void load() }, [])
  useEffect(() => {
    if (!operations?.some((operation) => operation.state === 'queued' || operation.state === 'running')) return
    const timer = window.setInterval(() => void load(), 4000)
    return () => window.clearInterval(timer)
  }, [operations])

  return <div className="view-heading"><div><span className="eyebrow">Durable work</span><h1>Operations</h1><p className="muted">Import, scan, and publication jobs are independent of the browser session and report their current state here.</p></div><Panel title="Job queue" action={<Button kind="quiet" onClick={() => void load()}>Refresh</Button>}>{error ? <ErrorState message={error} onRetry={() => void load()} /> : operations === null ? <LoadingState /> : operations.length === 0 ? <EmptyState title="No operations yet" description="Publishing a bundle, importing an upstream, or requesting a rescan creates a durable operation." /> : <div className="table-wrap"><table><thead><tr><th>Operation</th><th>State</th><th>Resource</th><th>Attempts</th><th>Updated</th><th>Failure</th></tr></thead><tbody>{operations.map((operation) => <tr key={operation.id}><td><strong>{titleCase(operation.kind)}</strong><span className="cell-sub">{operation.id}</span></td><td><Badge value={operation.state} /></td><td>{operation.resourceId ?? '—'}</td><td>{operation.attempts}</td><td>{formatDate(operation.updatedAt)}</td><td>{operation.error ? <span className="cell-sub">{operation.error}</span> : '—'}</td></tr>)}</tbody></table></div>}</Panel></div>
}

