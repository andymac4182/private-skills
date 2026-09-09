import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { api, ApiError } from '../lib/api'
import { formatDate } from '../lib/format'
import type { Job, PackVersion, Policy, SkillVersion } from '../lib/types'
import { Badge, Button, EmptyState, ErrorState, LoadingState, Panel } from '../components/Primitives'

export function OverviewView() {
  const [skills, setSkills] = useState<SkillVersion[] | null>(null)
  const [packs, setPacks] = useState<PackVersion[] | null>(null)
  const [operations, setOperations] = useState<Job[] | null>(null)
  const [policy, setPolicy] = useState<Policy | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    setError(null)
    try {
      const [skillsResponse, packsResponse, operationsResponse, policyResponse] = await Promise.all([api.skills(), api.packs(), api.operations(), api.policy()])
      setSkills(skillsResponse.skills ?? [])
      setPacks(packsResponse.packs ?? [])
      setOperations(operationsResponse.operations ?? [])
      setPolicy(policyResponse.policy)
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not load the registry overview.')
    }
  }

  useEffect(() => { void load() }, [])

  if (error) return <div className="view-heading"><div><span className="eyebrow">Workspace overview</span><h1>Registry pulse</h1><p className="muted">This page shows the latest releases, collections, and review activity.</p></div><ErrorState message={error} onRetry={() => void load()} /></div>
  if (!skills || !packs || !operations || !policy) return <div className="view-heading"><div><span className="eyebrow">Workspace overview</span><h1>Registry pulse</h1><p className="muted">Loading your releases, collections, and review settings.</p></div><Panel><LoadingState /></Panel></div>

  const activeOperations = operations.filter((operation) => operation.state === 'queued' || operation.state === 'running')
  const blockedSkills = skills.filter((skill) => skill.state !== 'approved')
  const enabledScanners = policy.scanners.filter((scanner) => scanner.mode !== 'disabled')
  return <div className="view-heading"><div><span className="eyebrow">Workspace overview</span><h1>Registry pulse</h1><p className="muted">A live view of releases, collections, activity, and security checks.</p></div><div className="grid-3"><Panel className="stat"><span className="stat-label">Skill releases</span><span className="stat-value">{skills.length}</span><span className="stat-note">{blockedSkills.length ? `${blockedSkills.length} need attention` : 'All releases approved'}</span></Panel><Panel className="stat"><span className="stat-label">Packs</span><span className="stat-value">{packs.length}</span><span className="stat-note">Fixed member lists</span></Panel><Panel className="stat"><span className="stat-label">Active tasks</span><span className="stat-value">{activeOperations.length}</span><span className="stat-note">{enabledScanners.length} security check{enabledScanners.length === 1 ? '' : 's'} enabled</span></Panel></div><div className="grid-2"><Panel title="Recent releases" description="Newest versions in the signed-in organization." action={<Link className="button button-quiet" to="/app/$section" params={{ section: 'catalog' }}>View catalog</Link>}>{skills.length === 0 ? <EmptyState title="Catalog is empty" description="Publish or import the first skill to start building your private registry." action={<Link className="button button-primary" to="/app/$section" params={{ section: 'publish' }}>Publish a skill</Link>} /> : <div className="table-wrap"><table><thead><tr><th>Skill</th><th>State</th><th>Created</th></tr></thead><tbody>{skills.slice(0, 5).map((skill) => <tr key={skill.id}><td><strong>{skill.name}</strong><span className="cell-sub">{skill.version}</span></td><td><Badge value={skill.state} /></td><td>{formatDate(skill.createdAt)}</td></tr>)}</tbody></table></div>}</Panel><Panel title="Recent activity" description="Publishing, imports, and security checks reported by the registry." action={<Link className="button button-quiet" to="/app/$section" params={{ section: 'operations' }}>View activity</Link>}>{operations.length === 0 ? <EmptyState title="No activity" description="Work will appear here when you publish or import a skill." /> : <div className="table-wrap"><table><thead><tr><th>Activity</th><th>State</th><th>Updated</th></tr></thead><tbody>{operations.slice(0, 5).map((operation) => <tr key={operation.id}><td><strong>{operation.kind}</strong><span className="cell-sub">{operation.id}</span></td><td><Badge value={operation.state} /></td><td>{formatDate(operation.updatedAt)}</td></tr>)}</tbody></table></div>}</Panel></div><Panel title="Current review settings" description="These settings determine which releases can be installed." action={<Link className="button button-quiet" to="/app/$section" params={{ section: 'policy' }}>Review settings</Link>}><div className="scan-policy-strip">{policy.scanners.map((scanner) => <div className="scan-policy-chip" key={scanner.id}><span>{scanner.id}</span><Badge value={scanner.mode} /></div>)}</div></Panel></div>
}
