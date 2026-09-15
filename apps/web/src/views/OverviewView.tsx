import { useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { api, ApiError } from '../lib/api'
import { useAuth } from '../lib/auth'
import { formatDate } from '../lib/format'
import type { AuthSession, Job, PackVersion, Policy, Principal, SkillVersion } from '../lib/types'
import { Badge, EmptyState, ErrorState, LoadingState, Panel } from '../components/Primitives'
import '../styles/experience-pages.css'

type ReleaseView = 'all' | 'attention'
type ActivityView = 'all' | 'active'

export function OverviewView() {
  const { principal, session } = useAuth()
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
    <OverviewIntro canPublish={canPublishFromSession(principal, session)} principal={principal} session={session} showActions={false} />
    <ErrorState message={error} onRetry={() => void load()} />
  </div>

  if (!skills || !packs || !operations || !policy) return <div className="view-heading overview-view overview-state-view">
    <OverviewIntro canPublish={canPublishFromSession(principal, session)} principal={principal} session={session} showActions={false} />
    <Panel className="overview-loading-panel"><LoadingState label="Loading your releases, collections, and review settings." /></Panel>
  </div>

  const activeOperations = operations.filter((operation) => operation.state === 'queued' || operation.state === 'running')
  const needsAttention = skills.filter((skill) => skill.state !== 'approved' || (skill.state === 'approved' && skill.policyRevision !== policy.revision))
  const approvedReleases = skills.filter((skill) => skill.state === 'approved')
  const enabledScanners = policy.scanners.filter((scanner) => scanner.mode !== 'disabled')
  const visibleReleases = releaseView === 'attention' ? needsAttention : skills
  const visibleOperations = activityView === 'active' ? activeOperations : operations
  const isFirstRun = skills.length === 0 && packs.length === 0 && operations.length === 0
  const companyName = session?.activeOrganization?.name ?? 'this company'
  const canPublish = canPublishFromSession(principal, session)

  return <div className="view-heading overview-view">
    <OverviewIntro canPublish={canPublish} firstRun={isFirstRun} principal={principal} session={session} />

    <section className="overview-stats" aria-label="Registry metrics">
      <Panel className="overview-stat-card">
        <div className="overview-stat-heading"><span>Skill releases</span></div>
        <strong className="overview-stat-value">{skills.length}</strong>
        <span className="overview-stat-note">{approvedReleases.length} approved</span>
      </Panel>
      <Panel className={`overview-stat-card ${needsAttention.length ? 'overview-stat-card-attention' : ''}`.trim()}>
        <div className="overview-stat-heading"><span>Needs attention</span></div>
        <strong className="overview-stat-value">{needsAttention.length}</strong>
        <span className="overview-stat-note">{needsAttention.length ? 'Releases outside current rules' : 'Everything is current'}</span>
      </Panel>
      <Panel className="overview-stat-card">
        <div className="overview-stat-heading"><span>Skill packs</span></div>
        <strong className="overview-stat-value">{packs.length}</strong>
        <span className="overview-stat-note">Fixed member lists</span>
      </Panel>
      <Panel className="overview-stat-card">
        <div className="overview-stat-heading"><span>Active tasks</span></div>
        <strong className="overview-stat-value">{activeOperations.length}</strong>
        <span className="overview-stat-note">{enabledScanners.length} security check{enabledScanners.length === 1 ? '' : 's'} enabled</span>
      </Panel>
    </section>

    <div className="overview-content-grid">
      <Panel className="overview-table-panel" title="Recent releases" description={`Newest versions in ${companyName}.`} action={<div className="overview-panel-actions"><div className="overview-filter" role="group" aria-label="Release table view"><button aria-pressed={releaseView === 'all'} className={releaseView === 'all' ? 'overview-filter-active' : ''} type="button" onClick={() => setReleaseView('all')}>All <span>{skills.length}</span></button><button aria-pressed={releaseView === 'attention'} className={releaseView === 'attention' ? 'overview-filter-active' : ''} type="button" onClick={() => setReleaseView('attention')}>Attention <span>{needsAttention.length}</span></button></div><Link className="button button-quiet" params={{ section: 'catalog' }} to="/app/$section">View catalog ↗</Link></div>}>
        {visibleReleases.length === 0 ? releaseView === 'attention' ? <EmptyState title="Nothing needs attention" description="Every release matches the current scanner policy." /> : <EmptyState title={isFirstRun ? canPublish ? 'Add your first skill' : 'Find a skill for this company' : 'Catalog is empty'} description={isFirstRun ? canPublish ? `Start ${companyName} with a private release or find one from a configured source.` : `Browse the private catalog or find a skill from a configured source for ${companyName}.` : canPublish ? 'Publish or import a skill to start building your private registry.' : 'Browse the catalog or find a skill from a configured source.'} action={isFirstRun ? <div className="overview-empty-actions">{canPublish ? <Link className="button button-primary" params={{ section: 'publish' }} to="/app/$section">Add skill</Link> : <Link className="button button-primary" params={{ section: 'catalog' }} to="/app/$section">Browse catalog</Link>}<Link className="button button-secondary" params={{ section: 'source-discovery' }} to="/app/$section">Find skills</Link></div> : canPublish ? <Link className="button button-primary" params={{ section: 'publish' }} to="/app/$section">Add skill</Link> : <Link className="button button-primary" params={{ section: 'catalog' }} to="/app/$section">Browse catalog</Link>} /> : <div className="table-wrap"><table><thead><tr><th>Skill</th><th>State</th><th>Files</th><th>Created</th></tr></thead><tbody>{visibleReleases.slice(0, 5).map((skill) => {
          const stale = skill.state === 'approved' && skill.policyRevision !== policy.revision
          return <tr key={skill.id}>
            <td><Link className="overview-table-link" params={{ section: 'catalog' }} search={{ skill: skill.id }} to="/app/$section"><strong>{skill.name}</strong><span className="cell-sub">{skill.version}</span></Link></td>
            <td><Badge tone={stale ? 'warn' : undefined} value={stale ? 'needs rescan' : skill.state} /></td>
            <td>{skill.fileCount}</td>
            <td>{formatDate(skill.createdAt)}</td>
          </tr>
        })}</tbody></table>{visibleReleases.length > 5 && <div className="overview-table-footnote">Showing 5 of {visibleReleases.length} releases. Open the catalog to see the rest.</div>}</div>}
      </Panel>

      <Panel className="overview-table-panel" title="Recent activity" description={`Publishing, imports, and checks for ${companyName}.`} action={<div className="overview-panel-actions"><div className="overview-filter" role="group" aria-label="Activity table view"><button aria-pressed={activityView === 'all'} className={activityView === 'all' ? 'overview-filter-active' : ''} type="button" onClick={() => setActivityView('all')}>All <span>{operations.length}</span></button><button aria-pressed={activityView === 'active'} className={activityView === 'active' ? 'overview-filter-active' : ''} type="button" onClick={() => setActivityView('active')}>Active <span>{activeOperations.length}</span></button></div><Link className="button button-quiet" params={{ section: 'operations' }} to="/app/$section">View activity ↗</Link></div>}>
        {visibleOperations.length === 0 ? <EmptyState title={activityView === 'active' ? 'No active tasks' : isFirstRun ? 'Activity starts here' : 'No activity yet'} description={activityView === 'active' ? 'The registry has no queued or running work right now.' : 'Activity appears as your team publishes or imports skills.'} /> : <div className="table-wrap"><table><thead><tr><th>Activity</th><th>State</th><th>Updated</th></tr></thead><tbody>{visibleOperations.slice(0, 5).map((operation) => <tr key={operation.id}><td><strong>{operation.kind}</strong><span className="cell-sub"><code>{operation.id}</code></span></td><td><Badge value={operation.state} /></td><td>{formatDate(operation.updatedAt)}</td></tr>)}</tbody></table>{visibleOperations.length > 5 && <div className="overview-table-footnote">Showing 5 of {visibleOperations.length} activities. Open activity for the full queue.</div>}</div>}
      </Panel>
    </div>

    <Panel className="overview-policy-panel" title="Current review settings" description="These settings determine which releases can be installed." action={<Link className="button button-quiet" params={{ section: 'policy' }} to="/app/$section">Review settings ↗</Link>}>
      <div className="overview-policy-summary"><span><strong>{enabledScanners.length}</strong> enabled check{enabledScanners.length === 1 ? '' : 's'}</span><span><strong>{policy.allowUnscanned ? 'Allowed' : 'Blocked'}</strong> unreviewed releases</span><span>Policy <code>{policy.revision}</code></span></div>
      <div className="scan-policy-strip">{policy.scanners.map((scanner) => <div className="scan-policy-chip" key={scanner.id}><span>{scanner.id}</span><Badge value={scanner.mode} /></div>)}</div>
    </Panel>
  </div>
}

function canPublishFromSession(principal: Principal | null, session: AuthSession | null): boolean {
  const activeRole = session?.activeMembership?.role
  if (activeRole) return activeRole === 'owner' || activeRole === 'admin' || activeRole === 'publisher'
  return principal?.roles.some((candidate) => candidate === 'owner' || candidate === 'admin' || candidate === 'publisher') ?? false
}

function OverviewIntro({ canPublish, firstRun = false, principal, session, showActions = true }: { canPublish: boolean; firstRun?: boolean; principal: Principal | null; session: AuthSession | null; showActions?: boolean }) {
  const organization = session?.activeOrganization
  const companyName = organization?.name ?? 'Private registry'
  const companyIdentifier = organization?.slug ?? principal?.organizationId
  const role = session?.activeMembership?.role ?? principal?.roles.find((candidate) => candidate !== 'worker')
  const description = firstRun
    ? 'This company is ready for its first private skill.'
    : 'Private releases, team activity, and review state for this company.'

  return <header className={`overview-header${showActions ? '' : ' overview-header-state'}`} aria-labelledby="overview-title">
    <div className="overview-header-copy">
      <div className="overview-header-kicker"><span className="eyebrow">Company workspace</span><span className="overview-company-status">Private registry</span></div>
      <h1 id="overview-title">{companyName}</h1>
      <div className="overview-company-meta">
        {companyIdentifier && <code>{companyIdentifier}</code>}
        {role && <span>{role}</span>}
      </div>
      <p className="overview-header-lede">{description}</p>
    </div>
    {showActions && <div className="overview-header-actions" aria-label="Workspace actions">
      {canPublish ? <Link className="button button-primary" params={{ section: 'publish' }} to="/app/$section">Add skill</Link> : <Link className="button button-primary" params={{ section: 'catalog' }} to="/app/$section">Browse catalog</Link>}
      <Link className="button button-secondary" params={{ section: 'source-discovery' }} to="/app/$section">Find skills</Link>
    </div>}
  </header>
}
