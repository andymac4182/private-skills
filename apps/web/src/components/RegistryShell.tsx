import { Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { safeAppReturnTo, useAuth } from '../lib/auth'
import { DirectoryFeedProvider } from '../lib/directoryFeed'
import { CommandPalette, registrySections } from './CommandPalette'
import { HealthStatus } from './HealthStatus'
import { Button, LoadingState } from './Primitives'

export function RegistryShell() {
  const { principal, status, error, signOut } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [routeIsEntering, setRouteIsEntering] = useState(false)

  const returnTo = safeAppReturnTo(`${location.pathname}${location.searchStr}${location.hash ? (location.hash.startsWith('#') ? location.hash : `#${location.hash}`) : ''}`)

  useEffect(() => {
    if (!returnTo || status === 'loading' || (status === 'signed-in' && principal)) return
    void navigate({ to: '/login', search: { returnTo }, replace: true })
  }, [navigate, principal, returnTo, status])

  useEffect(() => {
    if (typeof window === 'undefined') return

    // The class is progressive enhancement: the route remains usable if this
    // effect is unavailable, and reduced motion skips the entrance entirely.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setRouteIsEntering(false)
      return
    }

    setRouteIsEntering(false)
    const frame = window.requestAnimationFrame(() => setRouteIsEntering(true))
    const timeout = window.setTimeout(() => setRouteIsEntering(false), 360)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(timeout)
    }
  }, [location.pathname])

  if (status === 'loading') return <LoadingState label="Opening your private registry…" />
  if (status !== 'signed-in' || !principal) return <LoadingState label={error ?? 'Redirecting to sign in…'} />

  const activeSection = location.pathname.split('/')[2] || 'overview'
  const activeLabel = registrySections.find((section) => section.id === activeSection)?.label ?? 'Registry'
  const accountInitial = principal.subject.trim().slice(0, 1).toUpperCase() || 'P'

  return (
    <DirectoryFeedProvider>
      <div className="app-shell">
        <aside className="sidebar">
          <Link className="brand" to="/app">
            <span className="brand-mark">PS</span>
            <span>
              <strong>Private Skills</strong>
              <small>Private registry</small>
            </span>
          </Link>

          <nav className="primary-nav" aria-label="Registry sections">
            {registrySections.map((section) => (
              <Link
                activeProps={{ className: 'nav-item nav-item-active' }}
                className="nav-item"
                key={section.id}
                params={{ section: section.id }}
                to="/app/$section"
              >
                <span aria-hidden="true" className="nav-glyph">{section.glyph}</span>
                <span className="nav-label">{section.label}</span>
                <small>{section.hint}</small>
              </Link>
            ))}
          </nav>

          <div className="sidebar-note">
            <span className="eyebrow">Private by default</span>
            <p>Releases stay private until checks pass and you have access.</p>
          </div>

          <div className="sidebar-account">
            <span aria-hidden="true" className="account-avatar">{accountInitial}</span>
            <span>
              <strong>{principal.subject}</strong>
              <small>{principal.roles.join(' · ')}</small>
            </span>
          </div>
        </aside>

        <div className="app-frame">
          <header className="topbar">
            <div className="topbar-leading">
              <div className="mobile-brand">
                <span className="brand-mark">PS</span>
                <strong>Private Skills</strong>
              </div>
              <span className="topbar-context">{activeLabel}</span>
            </div>

            <div className="topbar-status">
              <CommandPalette sections={registrySections} />
              <HealthStatus />
              <span className="divider" aria-hidden="true" />
              <span className="principal-chip">
                {principal.subject}
                <span>{principal.roles.join(' · ')}</span>
              </span>
              <Button kind="quiet" onClick={() => void signOut().then(() => navigate({ to: '/login' }))}>
                Sign out
              </Button>
            </div>
          </header>

          <main className="main-content">
            <div className="route-kicker">
              <span aria-hidden="true" className="route-kicker-dot" />
              {activeLabel}
            </div>
            <div className={`route-content${routeIsEntering ? ' route-content-entering' : ''}`}>
              <Outlet />
            </div>
          </main>
        </div>
      </div>
    </DirectoryFeedProvider>
  )
}
