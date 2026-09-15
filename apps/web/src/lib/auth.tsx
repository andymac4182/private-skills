import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { PropsWithChildren } from 'react'
import { api, ApiError } from './api'
import { invitationReturnTo, isInvitationReturnTo } from './invitations'
import type { AuthSession, Principal } from './types'

type AuthStatus = 'loading' | 'signed-in' | 'signed-out'
export interface AuthContextValue {
  principal: Principal | null
  session: AuthSession | null
  status: AuthStatus
  error: string | null
  signIn: (token: string) => Promise<Principal>
  signOut: () => Promise<void>
  refresh: () => Promise<Principal | null>
  switchOrganization: (organizationId: string) => Promise<AuthSession>
}
const AuthContext = createContext<AuthContextValue | null>(null)
function getErrorMessage(error: unknown) { return error instanceof ApiError || error instanceof Error ? error.message : 'The registry could not be reached.' }

const RETURN_TO_MAX_LENGTH = 2048
const RETURN_TO_BASE_ORIGIN = 'https://private-skills.invalid'

/**
 * Keep authentication return destinations inside the app. The login route is
 * public, so this value is deliberately a small, same-origin app path rather
 * than an arbitrary URL that could become an open redirect.
 */
export function safeAppReturnTo(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > RETURN_TO_MAX_LENGTH || !value.startsWith('/') || value.startsWith('//')) return undefined
  if (/[\u0000-\u001f\u007f]/u.test(value) || value.includes('\\')) return undefined

  const baseOrigin = typeof window === 'undefined' ? RETURN_TO_BASE_ORIGIN : window.location.origin
  let target: URL
  try {
    target = new URL(value, baseOrigin)
  } catch {
    return undefined
  }

  if (target.origin !== baseOrigin || target.username || target.password || !/^\/app(?:\/|$)/u.test(target.pathname)) return undefined
  return `${target.pathname}${target.search}${target.hash}`
}

/**
 * Login may return to an app route or to one validated invitation route. The
 * invitation route is kept separate from safeAppReturnTo so existing app
 * navigation remains constrained to authenticated registry pages.
 */
export function safeLoginReturnTo(value: unknown): string | undefined {
  const appReturnTo = safeAppReturnTo(value)
  if (appReturnTo) return appReturnTo
  if (!isInvitationReturnTo(value)) return undefined
  const id = new URL(value, 'https://private-skills.invalid').searchParams.get('id')
  return invitationReturnTo(id)
}

function principalFromSession(session: AuthSession): Principal | null {
  const organization = session.activeOrganization
  if (!organization) return null

  // This is a display fallback for a brief identity/API handoff. Every
  // registry mutation is still authorized by the server's session principal.
  const role = session.activeMembership?.role && ['owner', 'admin', 'publisher', 'reader'].includes(session.activeMembership.role)
    ? session.activeMembership.role as Principal['roles'][number]
    : 'reader'
  return {
    organizationId: organization.id,
    subject: session.user.email || session.user.name || session.user.id,
    roles: [role],
  }
}

/** A valid identity session still needs a company choice before registry access. */
export function needsCompanySetup(session: AuthSession | null | undefined): boolean {
  return Boolean(session && (session.needsOnboarding || (!session.activeOrganizationId && session.organizations.length > 0)))
}

export function providerSignInHref(providerId: string, returnTo?: string, basePath = '/api/auth'): string | undefined {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/iu.test(providerId)) return undefined
  if (!/^\/[a-z0-9/_-]*$/iu.test(basePath)) return undefined
  const safeReturnTo = safeLoginReturnTo(returnTo)
  const params = new URLSearchParams({ provider: providerId })
  if (safeReturnTo) params.set('callbackURL', safeReturnTo)
  return `${basePath.replace(/\/$/u, '')}/sign-in/social?${params.toString()}`
}

export function AuthProvider({ children }: PropsWithChildren) {
  const [principal, setPrincipal] = useState<Principal | null>(null)
  const [session, setSession] = useState<AuthSession | null>(null)
  const [status, setStatus] = useState<AuthStatus>('loading')
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(async (knownIdentitySession?: AuthSession | null) => {
    let identitySession: AuthSession | null = null
    if (knownIdentitySession !== undefined) {
      identitySession = knownIdentitySession
    } else {
      try {
        identitySession = await api.authSession()
      } catch (cause) {
        // Older deployments expose only the token session and /v1/me. Keep
        // those deployments usable while the identity handler rolls out.
        if (cause instanceof ApiError && cause.status === 401) {
          setPrincipal(null); setSession(null); setStatus('signed-out'); setError(null); return null
        }
        if (!(cause instanceof ApiError && [404, 405, 501].includes(cause.status))) {
          setStatus('signed-out'); setError(getErrorMessage(cause)); return null
        }
      }
    }

    try {
      const current = await api.me()
      // An identity session is authoritative for the browser flow. Do not let
      // a stale legacy token principal bypass company onboarding or selection.
      if (identitySession && needsCompanySetup(identitySession)) {
        setSession(identitySession)
        setPrincipal(null)
        setStatus('signed-in')
        setError(null)
        return null
      }
      setPrincipal(current)
      setSession(identitySession)
      setStatus('signed-in')
      setError(null)
      return current
    } catch (cause) {
      // A signed-in identity without an active organization is expected to be
      // rejected by /v1/me until onboarding creates the first company.
      if (identitySession && needsCompanySetup(identitySession)) {
        setSession(identitySession)
        const fallbackPrincipal = principalFromSession(identitySession)
        setPrincipal(fallbackPrincipal)
        setStatus('signed-in')
        setError(null)
        return fallbackPrincipal
      }
      if (cause instanceof ApiError && cause.status === 401) {
        setPrincipal(null); setSession(null); setStatus('signed-out'); setError(null); return null
      }
      setStatus('signed-out'); setError(getErrorMessage(cause)); return null
    }
  }, [])
  useEffect(() => { void refresh() }, [refresh])
  const signIn = useCallback(async (token: string) => { setError(null); await api.signIn(token); const current = await refresh(); if (!current) throw new Error('The token was accepted but no principal was returned.'); return current }, [refresh])
  const signOut = useCallback(async () => {
    try {
      if (session) {
        let config: Awaited<ReturnType<typeof api.authProviders>> | null = null
        let configError: unknown = null
        try {
          config = await api.authProviders()
        } catch (cause) {
          configError = cause
        }
        const results = await Promise.allSettled([
          config
            ? Promise.resolve().then(() => api.authSignOut(config.basePath))
            : Promise.reject(configError),
          Promise.resolve().then(() => api.signOut()),
        ])
        const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
        if (failure) throw failure.reason
      } else {
        await api.signOut()
      }
    } catch (cause) {
      setError(getErrorMessage(cause))
      throw cause
    }
    setPrincipal(null); setSession(null); setStatus('signed-out'); setError(null)
  }, [session])
  const switchOrganization = useCallback(async (organizationId: string) => {
    if (!organizationId.trim()) throw new Error('Choose a company to continue.')
    await api.switchOrganization(organizationId)
    const next = await api.authSession()
    if (!next) throw new Error('The company session could not be refreshed.')
    setSession(next)
    await refresh(next)
    return next
  }, [refresh])
  const value = useMemo<AuthContextValue>(() => ({ principal, session, status, error, signIn, signOut, refresh, switchOrganization }), [principal, session, status, error, signIn, signOut, refresh, switchOrganization])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
export function useAuth() { const context = useContext(AuthContext); if (!context) throw new Error('useAuth must be used inside AuthProvider'); return context }
