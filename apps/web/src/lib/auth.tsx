import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { PropsWithChildren } from 'react'
import { api, ApiError } from './api'
import type { Principal } from './types'

type AuthStatus = 'loading' | 'signed-in' | 'signed-out'
interface AuthContextValue { principal: Principal | null; status: AuthStatus; error: string | null; signIn: (token: string) => Promise<Principal>; signOut: () => Promise<void>; refresh: () => Promise<Principal | null> }
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

export function AuthProvider({ children }: PropsWithChildren) {
  const [principal, setPrincipal] = useState<Principal | null>(null)
  const [status, setStatus] = useState<AuthStatus>('loading')
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    try { const current = await api.me(); setPrincipal(current); setStatus('signed-in'); setError(null); return current }
    catch (cause) { if (cause instanceof ApiError && cause.status === 401) { setPrincipal(null); setStatus('signed-out'); setError(null); return null }; setStatus('signed-out'); setError(getErrorMessage(cause)); return null }
  }, [])
  useEffect(() => { void refresh() }, [refresh])
  const signIn = useCallback(async (token: string) => { setError(null); await api.signIn(token); const current = await refresh(); if (!current) throw new Error('The token was accepted but no principal was returned.'); return current }, [refresh])
  const signOut = useCallback(async () => { try { await api.signOut() } finally { setPrincipal(null); setStatus('signed-out') } }, [])
  const value = useMemo<AuthContextValue>(() => ({ principal, status, error, signIn, signOut, refresh }), [principal, status, error, signIn, signOut, refresh])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
export function useAuth() { const context = useContext(AuthContext); if (!context) throw new Error('useAuth must be used inside AuthProvider'); return context }
