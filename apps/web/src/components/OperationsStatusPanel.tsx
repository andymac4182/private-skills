import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { useAuth } from '../lib/auth'
import { formatDate } from '../lib/format'
import type { OperationsStatusResponse } from '../lib/types'
import { Badge, Button, ErrorState, LoadingState, Notice, Panel } from './Primitives'

type BadgeTone = 'good' | 'warn' | 'bad' | 'muted'

function canViewOperationsStatus(
  principal: ReturnType<typeof useAuth>['principal'],
  session: ReturnType<typeof useAuth>['session'],
): boolean {
  const role = session?.activeMembership?.role
  return role === 'owner' || role === 'admin' || principal?.roles.some((candidate) => candidate === 'owner' || candidate === 'admin') === true
}

function tone(value: string): BadgeTone {
  if (['clear', 'current', 'available'].includes(value)) return 'good'
  if (['active', 'unconfigured', 'disabled', 'empty', 'unavailable'].includes(value)) return 'warn'
  return 'bad'
}

function activeAge(seconds: number | undefined): string {
  if (seconds === undefined) return 'No active queue age'
  if (seconds < 60) return `${seconds}s oldest active`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m oldest active`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h oldest active`
  return `${Math.floor(hours / 24)}d oldest active`
}

function billingLabel(status: OperationsStatusResponse['billing']): string {
  if (status.state === 'available') return status.mode === 'live' ? 'Live' : 'Test'
  if (status.state === 'disabled') return 'Disabled'
  if (status.state === 'unconfigured') return 'Unconfigured'
  return 'Unavailable'
}

function StatusCard({ label, value, state, note }: { label: string; value: string; state: string; note: string }) {
  return <Panel className="stat operations-status-card">
    <span className="stat-label">{label}</span>
    <strong className="stat-value">{value}</strong>
    <span className="stat-note">{note}</span>
    <Badge value={state} tone={tone(state)} />
  </Panel>
}

export function OperationsStatusPanel() {
  const { principal, session } = useAuth()
  const canView = canViewOperationsStatus(principal, session)
  const [status, setStatus] = useState<OperationsStatusResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!canView) return
    setError(null)
    try {
      setStatus(await api.operationsStatus())
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not load company operations status.')
    }
  }, [canView])

  useEffect(() => { void reload() }, [reload])
  useEffect(() => {
    if (!canView) return
    const timer = window.setInterval(() => void reload(), 15_000)
    return () => window.clearInterval(timer)
  }, [canView, reload])

  if (!canView) return <Panel title="Company operations status"><Notice kind="info">Owner or admin access is required to view company operations status.</Notice></Panel>
  if (error) return <Panel title="Company operations status" action={<Button kind="quiet" onClick={() => void reload()}>Refresh</Button>}><ErrorState message={error} onRetry={() => void reload()} /></Panel>
  if (!status) return <Panel title="Company operations status"><LoadingState label="Loading queue, scan, billing, and review status…" /></Panel>

  const queue = status.queue
  const scans = status.scans
  const eve = status.eve
  const billing = status.billing
  const active = queue.queued + queue.running
  const scanAttention = scans.skills.stale + scans.skills.failed + scans.skills.blocked + scans.skills.unavailable
  const eveAttention = eve.consolidationRuns.failed + eve.uploadReviews.failed + eve.uploadReviews.stale
  const eveTotal = eve.consolidationRuns.total + eve.uploadReviews.total
  const billingNote = billing.usageState === 'available' && billing.usage
    ? `${billing.usage.seats} seats · ${billing.usage.scans} scans this period`
    : billing.reason

  return <Panel title="Company operations status" description="Bounded operational signals for the active company. Failure history stays unavailable when the backing service does not persist it." action={<Button kind="quiet" onClick={() => void reload()}>Refresh</Button>}>
    <div className="grid-4 operations-status-grid" aria-label="Company operations status">
      <StatusCard label="Queue" value={`${active} active`} state={queue.state} note={`${queue.queued} queued · ${queue.running} running · ${queue.failed} failed · ${activeAge(queue.oldestActiveAgeSeconds)}`} />
      <StatusCard label="Scan freshness" value={scans.state === 'empty' ? 'No releases' : `${scans.skills.current}/${scans.skills.total} current`} state={scans.state} note={`${scanAttention} needing attention · ${scans.enabledScannerCount} enabled scanner${scans.enabledScannerCount === 1 ? '' : 's'}`} />
      <StatusCard label="Eve reviews" value={eve.state === 'unavailable' ? 'Unavailable' : eve.state === 'empty' ? 'No runs' : `${eveAttention} attention`} state={eve.state} note={`${eveTotal} retained run${eveTotal === 1 ? '' : 's'} · ${eve.uploadReviews.pending + eve.uploadReviews.running} upload reviews active`} />
      <StatusCard label="Billing" value={billingLabel(billing)} state={billing.state} note={billingNote} />
      <StatusCard label="Auth/callback history" value="Unavailable" state={status.auth.state} note="No durable sign-in or callback failure metric is connected" />
    </div>
    {queue.oldestActiveAt && <p className="muted operations-status-footnote">Oldest active work started {formatDate(queue.oldestActiveAt)}. Latest completed scan: {formatDate(scans.latestCompletedAt)}.</p>}
  </Panel>
}
