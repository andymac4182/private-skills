import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { PropsWithChildren } from 'react'
import { api, ApiError } from './api'
import type { Principal } from './types'

type AuthStatus = 'loading' | 'signed-in' | 'signed-out'
interface AuthContextValue { principal: Principal | null; status: AuthStatus; error: string | null; signIn: (token: string) => Promise<Principal>; signOut: () => Promise<void>; refresh: () => Promise<Principal | null> }
const AuthContext = createContext<AuthContextValue | null>(null)
function getErrorMessage(error: unknown) { return error instanceof ApiError || error instanceof Error ? error.message : 'The registry could not be reached.' }

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
