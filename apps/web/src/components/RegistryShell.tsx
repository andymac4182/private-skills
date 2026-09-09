import { Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { useAuth } from '../lib/auth'
import { HealthStatus } from './HealthStatus'
import { Button, LoadingState } from './Primitives'
const sections = [{ id: 'overview', label: 'Overview', hint: 'Registry pulse' }, { id: 'catalog', label: 'Catalog', hint: 'Skills and checks' }, { id: 'packs', label: 'Packs', hint: 'Pinned collections' }, { id: 'publish', label: 'Publish', hint: 'Add a skill' }, { id: 'operations', label: 'Activity', hint: 'Imports and reviews' }, { id: 'policy', label: 'Review rules', hint: 'Security checks' }, { id: 'upstreams', label: 'Sources', hint: 'Approved sources' }, { id: 'audit', label: 'Audit', hint: 'Change history' }]
export function RegistryShell() {
  const { principal, status, error, signOut } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  useEffect(() => {
    if (status !== 'loading' && (status !== 'signed-in' || !principal)) void navigate({ to: '/login', replace: true })
  }, [navigate, principal, status])
  if (status === 'loading') return <LoadingState label="Opening your private registry…" />
  if (status !== 'signed-in' || !principal) return <LoadingState label={error ?? 'Redirecting to sign in…'} />
  const activeSection = location.pathname.split('/')[2] || 'overview'
  return <div className="app-shell"><aside className="sidebar"><Link className="brand" to="/app"><span className="brand-mark">PS</span><span><strong>Private Skills</strong><small>Registry workspace</small></span></Link><nav className="primary-nav" aria-label="Registry sections">{sections.map((section) => <Link activeProps={{ className: 'nav-item nav-item-active' }} className="nav-item" key={section.id} params={{ section: section.id }} to="/app/$section"><span>{section.label}</span><small>{section.hint}</small></Link>)}</nav><div className="sidebar-note"><span className="eyebrow">Privacy</span><p>Skills stay private until checks pass and you have access.</p></div></aside><div className="app-frame"><header className="topbar"><div className="mobile-brand"><span className="brand-mark">PS</span><strong>Private Skills</strong></div><div className="topbar-status"><HealthStatus /><span className="divider" aria-hidden="true" /><span className="principal-chip">{principal.subject}<span>{principal.roles.join(' · ')}</span></span><Button kind="quiet" onClick={() => void signOut().then(() => navigate({ to: '/login' }))}>Sign out</Button></div></header><main className="main-content"><div className="route-kicker">{sections.find((section) => section.id === activeSection)?.label ?? 'Registry'}</div><Outlet /></main></div></div>
}
