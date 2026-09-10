import { Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { useAuth } from '../lib/auth'
import { DirectoryFeedProvider } from '../lib/directoryFeed'
import { HealthStatus } from './HealthStatus'
import { Button, LoadingState } from './Primitives'

const sections = [
  { id: 'overview', label: 'Discover', hint: 'Registry pulse', glyph: '⌂' },
  { id: 'catalog', label: 'Skills', hint: 'Browse releases', glyph: '⌕' },
  { id: 'packs', label: 'Skill packs', hint: 'Curated installs', glyph: '▦' },
  { id: 'directory', label: 'Cloud directory', hint: 'All / trending / hot', glyph: '◌' },
  { id: 'official', label: 'Official makers', hint: 'Maker-curated', glyph: '✦' },
  { id: 'topics', label: 'Topics', hint: 'Source taxonomy', glyph: '⌘' },
  { id: 'cloud-audits', label: 'External audits', hint: 'Partner evidence', glyph: '◉' },
  { id: 'analytics', label: 'Analytics', hint: 'Confirmed installs', glyph: '▥' },
  { id: 'reviews', label: 'Eve reviews', hint: 'Daily suggestions', glyph: '✦' },
  { id: 'publish', label: 'Publish', hint: 'Add a skill', glyph: '+' },
  { id: 'operations', label: 'Activity', hint: 'Imports and reviews', glyph: '↗' },
  { id: 'policy', label: 'Settings', hint: 'Review rules', glyph: '⚙' },
  { id: 'upstreams', label: 'Sources', hint: 'Approved sources', glyph: '⌘' },
  { id: 'audit', label: 'Audit', hint: 'Change history', glyph: '◷' },
]

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
  const activeLabel = sections.find((section) => section.id === activeSection)?.label ?? 'Registry'
  const accountInitial = principal.subject.trim().slice(0, 1).toUpperCase() || 'P'
  return <DirectoryFeedProvider><div className="app-shell"><aside className="sidebar"><Link className="brand" to="/app"><span className="brand-mark">PS</span><span><strong>Private Skills</strong><small>Private registry</small></span></Link><nav className="primary-nav" aria-label="Registry sections">{sections.map((section) => <Link activeProps={{ className: 'nav-item nav-item-active' }} className="nav-item" key={section.id} params={{ section: section.id }} to="/app/$section"><span aria-hidden="true" className="nav-glyph">{section.glyph}</span><span>{section.label}</span><small>{section.hint}</small></Link>)}</nav><div className="sidebar-note"><span className="eyebrow">Private by default</span><p>Releases stay private until checks pass and you have access.</p></div><div className="sidebar-account"><span aria-hidden="true" className="account-avatar">{accountInitial}</span><span><strong>{principal.subject}</strong><small>{principal.roles.join(' · ')}</small></span></div></aside><div className="app-frame"><header className="topbar"><div className="mobile-brand"><span className="brand-mark">PS</span><strong>Private Skills</strong></div><span className="topbar-context">{activeLabel}</span><div className="topbar-status"><HealthStatus /><span className="divider" aria-hidden="true" /><span className="principal-chip">{principal.subject}<span>{principal.roles.join(' · ')}</span></span><Button kind="quiet" onClick={() => void signOut().then(() => navigate({ to: '/login' }))}>Sign out</Button></div></header><main className="main-content"><div className="route-kicker">{activeLabel}</div><Outlet /></main></div></div></DirectoryFeedProvider>
}
