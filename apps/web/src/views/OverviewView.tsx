import { useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { api, ApiError } from '../lib/api'
import { formatDate } from '../lib/format'
import type { Job, PackVersion, Policy, SkillVersion } from '../lib/types'
import { Badge, EmptyState, ErrorState, LoadingState, Panel } from '../components/Primitives'
import '../styles/experience-pages.css'

type ReleaseView = 'all' | 'attention'
type ActivityView = 'all' | 'active'

export function OverviewView() {
  const [skills, setSkills] = useState<SkillVersion[] | null>(null)
  const [packs, setPacks] = useState<PackVersion[] | null>(null)
  const [operations, setOperations] = useState<Job[] | null>(null)
  const [policy, setPolicy] = useState<Policy | null>(null)
  const [releaseView, setReleaseView] = useState<ReleaseView>('all')
  const [activityView, setActivityView] = useState<ActivityView>('all')
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  const loadGeneration = useRef(0)

  async function load() {
    const generation = ++loadGeneration.current
    setError(null)
    try {
      const [skillsResponse, packsResponse, operationsResponse, policyResponse] = await Promise.all([api.skills(), api.packs(), api.operations(), api.policy()])
      if (!mounted.current || generation !== loadGeneration.current) return
      setSkills(skillsResponse.skills ?? [])
      setPacks(packsResponse.packs ?? [])
      setOperations(operationsResponse.operations ?? [])
      setPolicy(policyResponse.policy)
    } catch (cause) {
      if (!mounted.current || generation !== loadGeneration.current) return
      setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not load the registry overview.')
    }
  }

  useEffect(() => {
    mounted.current = true
    void load()
    return () => {
      mounted.current = false
      ++loadGeneration.current
    }
  }, [])

  if (error) return <div className="view-heading overview-view overview-state-view">
    <OverviewIntro />
    <ErrorState message={error} onRetry={() => void load()} />
  </div>

  if (!skills || !packs || !operations || !policy) return <div className="view-heading overview-view overview-state-view">
    <OverviewIntro />
    <Panel className="overview-loading-panel"><LoadingState label="Loading your releases, collections, and review settings." /></Panel>
  </div>

  const activeOperations = operations.filter((operation) => operation.state === 'queued' || operation.state === 'running')
  const needsAttention = skills.filter((skill) => skill.state !== 'approved' || (skill.state === 'approved' && skill.policyRevision !== policy.revision))
  const approvedReleases = skills.filter((skill) => skill.state === 'approved')
  const enabledScanners = policy.scanners.filter((scanner) => scanner.mode !== 'disabled')
  const visibleReleases = releaseView === 'attention' ? needsAttention : skills
  const visibleOperations = activityView === 'active' ? activeOperations : operations

  return <div className="view-heading overview-view">
    <section className="overview-hero" aria-labelledby="overview-title">
      <div className="overview-hero-copy">
        <div className="overview-hero-kicker"><span className="eyebrow">Workspace overview</span><span className="overview-snapshot"><span aria-hidden="true" className="health-dot health-online" /> Live registry snapshot</span></div>
        <h1 id="overview-title">Your team’s skills, <em>connected.</em></h1>
        <p className="overview-hero-lede">A calm place to publish releases, trace review activity, and keep installation rules visible to everyone on the team.</p>
      </div>
      <div className="overview-hero-aside" aria-label="Registry snapshot">
        <span className="overview-aside-label">Registry snapshot</span>
        <strong>{skills.length} release{skills.length === 1 ? '' : 's'}</strong>
        <span>{approvedReleases.length} approved · {needsAttention.length} needing attention</span>
      </div>
    </section>

    <nav className="overview-action-rail" aria-label="Workspace actions">
      <Link className="overview-action-card overview-action-card-primary" params={{ section: 'catalog' }} to="/app/$section">
        <span className="overview-action-index">01</span>
        <span className="overview-action-copy"><strong>Browse the catalog</strong><small>Inspect private releases and scan evidence.</small></span>
        <span aria-hidden="true" className="overview-action-arrow">↗</span>
      </Link>
      <Link className="overview-action-card" params={{ section: 'publish' }} to="/app/$section">
        <span className="overview-action-index">02</span>
        <span className="overview-action-copy"><strong>Publish a release</strong><small>Send a complete skill folder through review.</small></span>
        <span aria-hidden="true" className="overview-action-arrow">↗</span>
      </Link>
      <Link className="overview-action-card" params={{ section: 'source-discovery' }} to="/app/$section">
        <span className="overview-action-index">03</span>
        <span className="overview-action-copy"><strong>Find across sources</strong><small>Compare configured providers before importing.</small></span>
        <span aria-hidden="true" className="overview-action-arrow">↗</span>
      </Link>
    </nav>

    <section className="overview-stats" aria-label="Registry metrics">
      <Panel className="overview-stat-card">
        <div className="overview-stat-heading"><span>Skill releases</span><span aria-hidden="true">01</span></div>
        <strong className="overview-stat-value">{skills.length}</strong>
        <span className="overview-stat-note">{approvedReleases.length} approved</span>
      </Panel>
      <Panel className={`overview-stat-card ${needsAttention.length ? 'overview-stat-card-attention' : ''}`.trim()}>
        <div className="overview-stat-heading"><span>Needs attention</span><span aria-hidden="true">02</span></div>
        <strong className="overview-stat-value">{needsAttention.length}</strong>
        <span className="overview-stat-note">{needsAttention.length ? 'Releases outside current rules' : 'Everything is current'}</span>
      </Panel>
      <Panel className="overview-stat-card">
        <div className="overview-stat-heading"><span>Skill packs</span><span aria-hidden="true">03</span></div>
        <strong className="overview-stat-value">{packs.length}</strong>
        <span className="overview-stat-note">Fixed member lists</span>
      </Panel>
      <Panel className="overview-stat-card">
        <div className="overview-stat-heading"><span>Active tasks</span><span aria-hidden="true">04</span></div>
        <strong className="overview-stat-value">{activeOperations.length}</strong>
        <span className="overview-stat-note">{enabledScanners.length} security check{enabledScanners.length === 1 ? '' : 's'} enabled</span>
      </Panel>
    </section>

    <div className="overview-content-grid">
      <Panel className="overview-table-panel" title="Recent releases" description="Newest versions in the signed-in organization." action={<div className="overview-panel-actions"><div className="overview-filter" role="group" aria-label="Release table view"><button aria-pressed={releaseView === 'all'} className={releaseView === 'all' ? 'overview-filter-active' : ''} type="button" onClick={() => setReleaseView('all')}>All <span>{skills.length}</span></button><button aria-pressed={releaseView === 'attention'} className={releaseView === 'attention' ? 'overview-filter-active' : ''} type="button" onClick={() => setReleaseView('attention')}>Attention <span>{needsAttention.length}</span></button></div><Link className="button button-quiet" params={{ section: 'catalog' }} to="/app/$section">View catalog ↗</Link></div>}>
        {visibleReleases.length === 0 ? releaseView === 'attention' ? <EmptyState title="Nothing needs attention" description="Every release matches the current scanner policy." /> : <EmptyState title="Catalog is empty" description="Publish or import the first skill to start building your private registry." action={<Link className="button button-primary" params={{ section: 'publish' }} to="/app/$section">Publish a skill</Link>} /> : <div className="table-wrap"><table><thead><tr><th>Skill</th><th>State</th><th>Files</th><th>Created</th></tr></thead><tbody>{visibleReleases.slice(0, 5).map((skill) => {
          const stale = skill.state === 'approved' && skill.policyRevision !== policy.revision
          return <tr key={skill.id}>
            <td><Link className="overview-table-link" params={{ section: 'catalog' }} search={{ skill: skill.id }} to="/app/$section"><strong>{skill.name}</strong><span className="cell-sub">{skill.version}</span></Link></td>
            <td><Badge tone={stale ? 'warn' : undefined} value={stale ? 'needs rescan' : skill.state} /></td>
            <td>{skill.fileCount}</td>
            <td>{formatDate(skill.createdAt)}</td>
          </tr>
        })}</tbody></table>{visibleReleases.length > 5 && <div className="overview-table-footnote">Showing 5 of {visibleReleases.length} releases. Open the catalog to see the rest.</div>}</div>}
      </Panel>

      <Panel className="overview-table-panel" title="Recent activity" description="Publishing, imports, and security checks reported by the registry." action={<div className="overview-panel-actions"><div className="overview-filter" role="group" aria-label="Activity table view"><button aria-pressed={activityView === 'all'} className={activityView === 'all' ? 'overview-filter-active' : ''} type="button" onClick={() => setActivityView('all')}>All <span>{operations.length}</span></button><button aria-pressed={activityView === 'active'} className={activityView === 'active' ? 'overview-filter-active' : ''} type="button" onClick={() => setActivityView('active')}>Active <span>{activeOperations.length}</span></button></div><Link className="button button-quiet" params={{ section: 'operations' }} to="/app/$section">View activity ↗</Link></div>}>
        {visibleOperations.length === 0 ? <EmptyState title={activityView === 'active' ? 'No active tasks' : 'No activity yet'} description={activityView === 'active' ? 'The registry has no queued or running work right now.' : 'Work will appear here when you publish or import a skill.'} /> : <div className="table-wrap"><table><thead><tr><th>Activity</th><th>State</th><th>Updated</th></tr></thead><tbody>{visibleOperations.slice(0, 5).map((operation) => <tr key={operation.id}><td><strong>{operation.kind}</strong><span className="cell-sub"><code>{operation.id}</code></span></td><td><Badge value={operation.state} /></td><td>{formatDate(operation.updatedAt)}</td></tr>)}</tbody></table>{visibleOperations.length > 5 && <div className="overview-table-footnote">Showing 5 of {visibleOperations.length} activities. Open activity for the full queue.</div>}</div>}
      </Panel>
    </div>

    <Panel className="overview-policy-panel" title="Current review settings" description="These settings determine which releases can be installed." action={<Link className="button button-quiet" params={{ section: 'policy' }} to="/app/$section">Review settings ↗</Link>}>
      <div className="overview-policy-summary"><span><strong>{enabledScanners.length}</strong> enabled check{enabledScanners.length === 1 ? '' : 's'}</span><span><strong>{policy.allowUnscanned ? 'Allowed' : 'Blocked'}</strong> unreviewed releases</span><span>Policy <code>{policy.revision}</code></span></div>
      <div className="scan-policy-strip">{policy.scanners.map((scanner) => <div className="scan-policy-chip" key={scanner.id}><span>{scanner.id}</span><Badge value={scanner.mode} /></div>)}</div>
    </Panel>
  </div>
}

function OverviewIntro() {
  return <section className="overview-hero overview-hero-state" aria-labelledby="overview-title">
    <div className="overview-hero-copy">
      <div className="overview-hero-kicker"><span className="eyebrow">Workspace overview</span><span className="overview-snapshot"><span aria-hidden="true" className="health-dot health-checking" /> Registry snapshot</span></div>
      <h1 id="overview-title">Your team’s skills, <em>connected.</em></h1>
      <p className="overview-hero-lede">A calm place to publish releases, trace review activity, and keep installation rules visible to everyone on the team.</p>
    </div>
  </section>
}
