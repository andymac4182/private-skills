import { useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { safeAppReturnTo, useAuth } from '../lib/auth'
import { api, ApiError } from '../lib/api'
import { Button, Field, Notice } from './Primitives'

interface LoginFormProps {
  returnTo?: string
}

export function LoginForm({ returnTo }: LoginFormProps) {
  const navigate = useNavigate(); const { signIn } = useAuth()
  const [token, setToken] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [health, setHealth] = useState<'checking' | 'online' | 'offline'>('checking')
  async function checkHealth() { setHealth('checking'); try { await api.health(); setHealth('online') } catch { setHealth('offline') } }
  useEffect(() => { void checkHealth() }, [])
  async function submit(event: React.FormEvent<HTMLFormElement>) { event.preventDefault(); if (!token.trim()) { setError('Enter a registry token to continue.'); return }; setBusy(true); setError(null); try { await signIn(token.trim()); setToken(''); await navigate({ href: safeAppReturnTo(returnTo) ?? '/app' }) } catch (cause) { setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Sign-in failed.') } finally { setBusy(false) } }
  return <div className="login-layout"><section className="login-context"><span className="eyebrow">Private skills registry</span><h1>Skills your team can trust.</h1><p className="lede">Keep releases, sources, packs, and review decisions together in one calm workspace.</p><div className="login-points"><span>Browse releases your organization can use</span><span>See review status before installation</span><span>Keep source and policy decisions visible</span></div></section><div className="login-card"><div className="eyebrow">Welcome back</div><h1>Sign in to your registry</h1><p className="lede">Use your registry token to open the private workspace.</p><div className="health-line"><span className={`health-dot health-${health}`} aria-hidden="true" />{health === 'checking' && 'Checking registry…'}{health === 'online' && 'Registry is online'}{health === 'offline' && <><span>Registry is unavailable.</span><button className="inline-button" type="button" onClick={() => void checkHealth()}>Retry</button></>}</div><form onSubmit={submit} className="stack-form"><Field label="Registry token" hint="Your token signs you in and is not saved in this browser."><input autoComplete="off" autoFocus name="token" onChange={(event) => setToken(event.target.value)} placeholder="psk_…" type="password" value={token} /></Field>{error && <Notice kind="error">{error}</Notice>}<Button busy={busy} type="submit">Sign in</Button></form><p className="login-footnote">Need a token? Ask an owner or administrator of this private registry.</p></div></div>
}
