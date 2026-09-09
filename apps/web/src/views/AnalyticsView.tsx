import { useEffect, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { formatDate } from '../lib/format'
import type { InstallAnalytics } from '../lib/types'
import { EmptyState, ErrorState, LoadingState, Panel } from '../components/Primitives'

const ranges = [7, 30, 90] as const

export function AnalyticsView() {
  const [days, setDays] = useState<number>(30)
  const [analytics, setAnalytics] = useState<InstallAnalytics | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    setError(null)
    try {
      setAnalytics(await api.analytics(days))
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not load install analytics.')
    }
  }

  useEffect(() => { void load() }, [days])

  if (error) return <div className="view-heading"><div className="page-intro"><div><span className="eyebrow">Client-confirmed usage</span><h1>Analytics</h1><p className="muted">Understand confirmed install activity for your private registry.</p></div><RangeSelect days={days} onChange={setDays} /></div><ErrorState message={error} onRetry={() => void load()} /></div>
  if (!analytics) return <div className="view-heading"><div className="page-intro"><div><span className="eyebrow">Client-confirmed usage</span><h1>Analytics</h1><p className="muted">Loading confirmed install activity.</p></div><RangeSelect days={days} onChange={setDays} /></div><Panel><LoadingState label="Loading install analytics…" /></Panel></div>

  const maxDailyInstalls = Math.max(1, ...analytics.daily.map((day) => day.installOperations))
  const hasInstallActivity = analytics.totals.installOperations > 0
  return <div className="view-heading"><div className="page-intro"><div><span className="eyebrow">Client-confirmed usage</span><h1>Analytics</h1><p className="muted">Confirmed install activity from {formatDate(analytics.from)} to {formatDate(analytics.to)}. These are client receipts, not download counts.</p></div><RangeSelect days={days} onChange={setDays} /></div><div className="grid-4 analytics-stats"><Panel className="stat"><span className="stat-label">Install operations</span><span className="stat-value">{analytics.totals.installOperations}</span><span className="stat-note">Client-confirmed attempts</span></Panel><Panel className="stat"><span className="stat-label">Skill installs</span><span className="stat-value">{analytics.totals.skillInstalls}</span><span className="stat-note">Changed skill resolutions</span></Panel><Panel className="stat"><span className="stat-label">Pack installs</span><span className="stat-value">{analytics.totals.packInstalls}</span><span className="stat-note">Changed pack resolutions</span></Panel><Panel className="stat"><span className="stat-label">Already current</span><span className="stat-value">{analytics.totals.upToDateChecks}</span><span className="stat-note">No file transfer needed</span></Panel></div><Panel title="Install activity" description={`Daily confirmed operations across the last ${analytics.days} days.`}>{hasInstallActivity ? <div className="analytics-chart" aria-label="Daily confirmed install operations">{analytics.daily.map((day, index) => <div className="analytics-bar-column" key={day.date} title={`${day.date}: ${day.installOperations} install operation${day.installOperations === 1 ? '' : 's'}`}><div className="analytics-bar-track"><span className="analytics-bar" style={{ height: `${Math.max(day.installOperations > 0 ? 8 : 2, (day.installOperations / maxDailyInstalls) * 100)}%` }} /></div><span className="analytics-bar-label">{chartLabel(day.date, index, analytics.daily.length)}</span></div>)}</div> : <EmptyState title="No confirmed installs in this period" description="Install receipts will appear here after a client confirms a registry install." />}</Panel><Panel title="Most installed skills" description="Skill members reported by confirmed install receipts.">{analytics.topSkills.length === 0 ? <EmptyState title="No skill install detail yet" description="This period has no changed skill resolutions to rank." /> : <div className="table-wrap"><table><thead><tr><th>Skill</th><th>Version</th><th>Confirmed installs</th></tr></thead><tbody>{analytics.topSkills.map((skill) => <tr key={`${skill.resourceId}:${skill.version}`}><td><strong>{skill.name}</strong><span className="cell-sub">{skill.resourceId}</span></td><td>{skill.version}</td><td>{skill.installs}</td></tr>)}</tbody></table></div>}</Panel></div>
}

function RangeSelect({ days, onChange }: { days: number; onChange: (value: number) => void }) {
  return <label className="analytics-range"><span>Period</span><select aria-label="Analytics period" onChange={(event) => onChange(Number(event.target.value))} value={days}>{ranges.map((range) => <option key={range} value={range}>{range} days</option>)}</select></label>
}

function chartLabel(date: string, index: number, total: number) {
  if (total > 14 && index % 7 !== 0 && index !== total - 1) return ''
  const parsed = new Date(`${date}T00:00:00Z`)
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(parsed)
}
