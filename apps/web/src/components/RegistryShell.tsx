import { Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { needsCompanySetup, safeAppReturnTo, useAuth } from '../lib/auth'
import { DirectoryFeedProvider } from '../lib/directoryFeed'
import { CommandPalette, registryNavGroups, registrySections } from './CommandPalette'
import { CompanySwitcher } from './CompanySwitcher'
import { HealthStatus } from './HealthStatus'
import { Button, LoadingState } from './Primitives'

// These destinations are guarded by the company-admin boundary. A reader can
// still open a bookmarked URL and receive the server's denial, but the normal
// navigation should not advertise controls they cannot use.
const READER_HIDDEN_COMPANY_SECTIONS = new Set(['company-sso', 'billing', 'audit'])

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled])'))
    .filter((element) => {
      if (element.tabIndex < 0 || element.hidden || element.getAttribute('aria-hidden') === 'true') return false
      if (element.closest('[hidden], [aria-hidden="true"]')) return false
      const style = window.getComputedStyle(element)
      return style.display !== 'none' && style.visibility !== 'hidden'
    })
}

export function RegistryShell() {
  const { principal, session, status, error, signOut } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [routeIsEntering, setRouteIsEntering] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [mobileExpandedGroupId, setMobileExpandedGroupId] = useState<string | null>(null)
  const mobileNavRef = useRef<HTMLElement>(null)
  const mobileNavTriggerRef = useRef<HTMLButtonElement>(null)

  const returnTo = safeAppReturnTo(`${location.pathname}${location.searchStr}${location.hash ? (location.hash.startsWith('#') ? location.hash : `#${location.hash}`) : ''}`)
  const isCompanyRoute = location.pathname === '/app/company'
  const needsCompany = needsCompanySetup(session)
  const routeSection = location.pathname.split('/')[2] || 'overview'
  const activeSection = routeSection === 'topic' ? 'topics' : routeSection
  const activeLabel = registrySections.find((section) => section.id === activeSection)?.label ?? 'Registry'
  const sessionCompanyRole = session?.activeMembership?.role
  const principalHasCompanyRole = principal?.roles.some((role) => ['owner', 'admin', 'publisher', 'reader'].includes(role)) ?? false
  const canManageCompany = sessionCompanyRole !== undefined
    ? sessionCompanyRole === 'owner' || sessionCompanyRole === 'admin'
    : principal?.roles.some((role) => role === 'owner' || role === 'admin') ?? false
  const readonlyCompanyNavigation = (sessionCompanyRole !== undefined || principalHasCompanyRole) && !canManageCompany
  const navigationGroups = readonlyCompanyNavigation
    ? registryNavGroups
      .map((group) => group.id === 'company-admin'
        ? { ...group, sections: group.sections.filter((section) => !READER_HIDDEN_COMPANY_SECTIONS.has(section.id)) }
        : group)
      .filter((group) => group.sections.length > 0)
    : registryNavGroups
  const navigationSections = readonlyCompanyNavigation
    ? registrySections.filter((section) => !READER_HIDDEN_COMPANY_SECTIONS.has(section.id))
    : registrySections
  const activeGroup = navigationGroups.find((group) => group.sections.some((section) => section.id === activeSection)) ?? navigationGroups[0] ?? registryNavGroups[0]
  const activeNavItemRef = useRef<HTMLAnchorElement>(null)
  // Identity sessions carry the human-facing account label. The legacy
  // principal subject is often an opaque id, so only use it after the
  // sanitized identity name/email fields and retain it for token sessions.
  const accountName = session?.user.name?.trim()
    || session?.user.email?.trim()
    || principal?.display?.userName?.trim()
    || principal?.display?.userEmail?.trim()
    || principal?.subject?.trim()
    || session?.user.id?.trim()
    || 'Private Skills'
  const accountInitial = accountName.trim().slice(0, 1).toUpperCase() || 'P'
  const accountRoles = principal?.roles.join(' · ') ?? (session?.activeMembership?.role ?? 'company setup')
  const tenantKey = session?.activeOrganizationId ?? principal?.organizationId ?? 'identity'
  const closeMobileNav = useCallback(() => setMobileNavOpen(false), [])

  useEffect(() => {
    setMobileExpandedGroupId(activeGroup.id)
  }, [activeGroup.id])

  useEffect(() => {
    if (!returnTo || status === 'loading') return
    if (status === 'signed-in' && (principal || (session && isCompanyRoute))) return
    if (status === 'signed-in' && needsCompany) {
      void navigate({ to: '/app/$section', params: { section: 'company' }, replace: true })
      return
    }
    void navigate({ to: '/login', search: { returnTo }, replace: true })
  }, [isCompanyRoute, navigate, needsCompany, principal, returnTo, session, status])

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

  useEffect(() => {
    // Navigation and company changes both close the drawer. The search string
    // is included because CompanySwitcher clears draft context while landing
    // on the same shell route.
    setMobileNavOpen(false)
  }, [location.pathname, location.searchStr, tenantKey])

  useEffect(() => {
    // Keep the selected destination visible when the navigation has more items
    // than the viewport. This does not move focus, so keyboard users retain
    // the normal drawer and link focus behavior.
    const frame = window.requestAnimationFrame(() => {
      activeNavItemRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'auto' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [activeSection, mobileNavOpen, tenantKey])

  useEffect(() => {
    if (!mobileNavOpen) return
    const navigation = mobileNavRef.current
    if (!navigation) return

    const previousOverflow = document.body.style.overflow
    const focusFrame = window.requestAnimationFrame(() => getFocusableElements(navigation)[0]?.focus())

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeMobileNav()
        return
      }
      if (event.key !== 'Tab') return

      const focusable = getFocusableElements(navigation)
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (event.shiftKey && (active === first || !navigation.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || !navigation.contains(active))) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    const desktopBreakpoint = window.matchMedia('(min-width: 781px)')
    const onResize = () => {
      if (window.innerWidth > 780 || desktopBreakpoint.matches) closeMobileNav()
    }
    window.addEventListener('resize', onResize)
    desktopBreakpoint.addEventListener?.('change', onResize)
    document.body.style.overflow = 'hidden'
    return () => {
      window.cancelAnimationFrame(focusFrame)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onResize)
      desktopBreakpoint.removeEventListener?.('change', onResize)
      document.body.style.overflow = previousOverflow
      if (mobileNavTriggerRef.current?.isConnected) mobileNavTriggerRef.current.focus()
    }
  }, [closeMobileNav, mobileNavOpen])

  if (status === 'loading') return <LoadingState label="Opening your private registry…" />
  if (status !== 'signed-in' || (!principal && !(session && isCompanyRoute))) return <LoadingState label={error ?? 'Redirecting to sign in…'} />

  return (
    <DirectoryFeedProvider key={tenantKey}>
      <div className="app-shell">
        <aside
          aria-label="Registry navigation"
          aria-modal={mobileNavOpen ? true : undefined}
          className={`sidebar${mobileNavOpen ? ' sidebar-mobile-open' : ''}`}
          id="registry-navigation"
          role={mobileNavOpen ? 'dialog' : undefined}
          ref={mobileNavRef}
        >
          <button aria-label="Close navigation" className="mobile-nav-close" type="button" onClick={closeMobileNav}>
            <span aria-hidden="true">×</span>
          </button>
          <Link className="brand" to="/app">
            <span className="brand-mark">PS</span>
            <span>
              <strong>Private Skills</strong>
              <small>Private registry</small>
            </span>
          </Link>

          <nav className="primary-nav" aria-label="Registry sections">
            {navigationGroups.map((group) => {
              const defaultSection = group.sections.find((section) => section.id === group.defaultSectionId)
              if (!defaultSection) return null
              const isActiveGroup = group.id === activeGroup.id
              const isReadonlyCompanyGroup = group.id === 'company-admin' && readonlyCompanyNavigation
              const groupLabel = isReadonlyCompanyGroup ? 'Company' : group.label
              const groupHint = isReadonlyCompanyGroup ? 'Team and access' : group.hint
              const groupSubnavId = `registry-nav-${group.id}-sections`
              const mobileGroupExpanded = mobileNavOpen && mobileExpandedGroupId === group.id
              const showSubnav = group.sections.length > 1 && (mobileNavOpen ? mobileGroupExpanded : isActiveGroup)
              return (
                <div className={`nav-group${isActiveGroup ? ' nav-group-active' : ''}${group.admin && !isReadonlyCompanyGroup ? ' nav-group-admin' : ''}`} key={group.id}>
                  <div className="nav-group-heading">
                    <Link
                      className={`nav-group-link${isActiveGroup ? ' nav-group-link-active' : ''}`}
                      params={{ section: defaultSection.id }}
                      to="/app/$section"
                      ref={isActiveGroup && group.sections.length === 1 ? activeNavItemRef : undefined}
                      onClick={closeMobileNav}
                    >
                      <span aria-hidden="true" className="nav-glyph">{group.glyph}</span>
                      <span className="nav-group-copy">
                        <strong>{groupLabel}</strong>
                        <small>{groupHint}</small>
                      </span>
                      {group.sections.length > 1 && <span aria-hidden="true" className="nav-group-chevron">{isActiveGroup ? '⌄' : '›'}</span>}
                    </Link>
                    {group.sections.length > 1 && <button
                      aria-controls={groupSubnavId}
                      aria-expanded={mobileGroupExpanded}
                      aria-label={`${mobileGroupExpanded ? 'Collapse' : 'Expand'} ${groupLabel} sections`}
                      className="nav-group-toggle"
                      type="button"
                      onClick={() => setMobileExpandedGroupId((current) => current === group.id ? null : group.id)}
                    >
                      <span aria-hidden="true">{mobileGroupExpanded ? '⌄' : '›'}</span>
                    </button>}
                  </div>

                  {group.sections.length > 1 && (
                    <div aria-label={`${groupLabel} sections`} className="nav-subnav" hidden={!showSubnav} id={groupSubnavId} role="group">
                      {group.sections.map((section) => (
                        <Link
                          activeProps={{ className: 'nav-subitem nav-subitem-active' }}
                          className="nav-subitem"
                          key={section.id}
                          params={{ section: section.id }}
                          to="/app/$section"
                          ref={section.id === activeSection ? activeNavItemRef : undefined}
                          onClick={closeMobileNav}
                        >
                          <span aria-hidden="true" className="nav-subitem-glyph">{section.glyph}</span>
                          <span className="nav-subitem-copy">
                            <strong>{section.label}</strong>
                            <small>{section.hint}</small>
                          </span>
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </nav>

          <div className="sidebar-note">
            <span className="eyebrow">Private by default</span>
            <p>Only authorized members can access this company’s skills.</p>
          </div>

          <div className="sidebar-account">
            <span aria-hidden="true" className="account-avatar">{accountInitial}</span>
            <span>
              <strong>{accountName}</strong>
              <small>{accountRoles}</small>
            </span>
          </div>
        </aside>

        {mobileNavOpen && <button aria-label="Close navigation" className="mobile-nav-scrim" tabIndex={-1} type="button" onClick={closeMobileNav} />}

        <div aria-hidden={mobileNavOpen ? true : undefined} className="app-frame" inert={mobileNavOpen ? true : undefined}>
          <header className="topbar">
            <div className="topbar-leading">
              <button
                ref={mobileNavTriggerRef}
                aria-controls="registry-navigation"
                aria-expanded={mobileNavOpen}
                aria-label={mobileNavOpen ? 'Close navigation' : 'Open navigation'}
                className="mobile-nav-trigger"
                type="button"
                onClick={() => {
                  setMobileExpandedGroupId(activeGroup.id)
                  setMobileNavOpen(true)
                }}
              >
                <span aria-hidden="true" className="mobile-nav-trigger-icon">☰</span>
                <span className="mobile-nav-trigger-label">Menu</span>
              </button>
              <div className="mobile-brand">
                <span className="brand-mark">PS</span>
                <strong>Private Skills</strong>
              </div>
              <span className="topbar-context">{activeLabel}</span>
            </div>

            <div className="topbar-status">
              <CommandPalette sections={navigationSections} />
              <CompanySwitcher />
              <HealthStatus />
              <span className="divider" aria-hidden="true" />
              <span className="principal-chip">
                {accountName}
                <span>{accountRoles}</span>
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
