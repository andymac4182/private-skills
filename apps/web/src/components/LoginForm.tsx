import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { providerSignInHref, safeLoginReturnTo, useAuth } from '../lib/auth'
import { api, ApiError } from '../lib/api'
import type { IdentityProviderPublicConfig, PublicProviderConfig } from '../lib/types'
import { Button, Field, Notice } from './Primitives'

interface LoginFormProps {
  returnTo?: string
}

export function LoginForm({ returnTo }: LoginFormProps) {
  const navigate = useNavigate(); const { signIn } = useAuth()
  const [token, setToken] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [health, setHealth] = useState<'checking' | 'online' | 'offline'>('checking')
  const [providerConfig, setProviderConfig] = useState<PublicProviderConfig | null>(null)
  const [providerError, setProviderError] = useState<string | null>(null)
  const [providerBusy, setProviderBusy] = useState<string | null>(null)
  const checkHealth = useCallback(async () => { setHealth('checking'); try { await api.health(); setHealth('online') } catch { setHealth('offline') } }, [])
  const loadProviders = useCallback(async () => {
    setProviderError(null)
    try { setProviderConfig(await api.authProviders()) }
    catch (cause) { setProviderConfig(null); setProviderError(cause instanceof ApiError ? cause.message : 'Identity providers are unavailable.') }
  }, [])
  useEffect(() => { void checkHealth(); void loadProviders() }, [checkHealth, loadProviders])
  async function submit(event: React.FormEvent<HTMLFormElement>) { event.preventDefault(); if (!token.trim()) { setError('Enter a registry token to continue.'); return }; setBusy(true); setError(null); try { await signIn(token.trim()); setToken(''); await navigate({ href: safeLoginReturnTo(returnTo) ?? '/app' }) } catch (cause) { setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Sign-in failed.') } finally { setBusy(false) } }
  async function signInWithProvider(provider: IdentityProviderPublicConfig) {
    if (!provider.enabled || providerBusy) return
    const basePath = providerConfig?.basePath && /^\/[a-z0-9/_-]*$/iu.test(providerConfig.basePath) ? providerConfig.basePath : '/api/auth'
    const callbackPath = safeLoginReturnTo(returnTo) ?? '/app'
    const callbackURL = typeof window === 'undefined' ? callbackPath : new URL(callbackPath, window.location.origin).toString()
    setProviderBusy(provider.id); setError(null)
    try {
      const response = await api.authSignIn(provider.id, callbackURL, basePath)
      if (response.redirect && response.url) {
        window.location.assign(response.url)
        return
      }
      await navigate({ href: callbackPath })
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : `Could not continue with ${provider.label}.`)
    } finally { setProviderBusy(null) }
  }
  const providers = providerConfig?.providers ?? []
  return <div className="login-layout"><section className="login-context"><span className="eyebrow">Private skills registry</span><h1>Skills your team can trust.</h1><p className="lede">Keep releases, sources, packs, and review decisions together in one calm workspace.</p><div className="login-points"><span>Browse releases your organization can use</span><span>See review status before installation</span><span>Keep source and policy decisions visible</span></div></section><div className="login-card"><div className="eyebrow">Welcome back</div><h1>Sign in to your registry</h1><p className="lede">Use your company identity or an existing registry token.</p><div className="health-line"><span className={`health-dot health-${health}`} aria-hidden="true" />{health === 'checking' && 'Checking registry…'}{health === 'online' && 'Registry is online'}{health === 'offline' && <><span>Registry is unavailable.</span><button className="inline-button" type="button" onClick={() => void checkHealth()}>Retry</button></>}</div><section aria-labelledby="provider-login-heading" className="provider-login"><div className="provider-login-heading"><div><span className="eyebrow">Company sign-in</span><h2 id="provider-login-heading">Continue with your provider</h2></div><span className="provider-lock" aria-hidden="true">⌁</span></div>{providerError ? <Notice kind="info">{providerError} Use the registry token below, or retry when identity configuration is available.</Notice> : !providerConfig ? <div className="provider-loading" role="status"><span className="spinner" />Loading configured providers…</div> : providerConfig.enabled && providers.length > 0 ? <div className="provider-list">{providers.map((provider) => <ProviderButton basePath={providerConfig.basePath} busy={providerBusy === provider.id} key={provider.id} provider={provider} returnTo={returnTo} onClick={() => void signInWithProvider(provider)} />)}</div> : <Notice kind="info">Company sign-in is not configured on this registry. Use the registry token below.</Notice>}</section><div className="login-divider"><span>or use a registry token</span></div><form onSubmit={submit} className="stack-form"><Field label="Registry token" hint="Your token signs you in and is not saved in this browser."><input autoComplete="off" autoFocus name="token" onChange={(event) => setToken(event.target.value)} placeholder="psk_…" type="password" value={token} /></Field>{error && <Notice kind="error">{error}</Notice>}<Button busy={busy} type="submit">Sign in with token</Button></form><p className="login-footnote">Need a token? Ask an owner or administrator of this private registry.</p></div></div>
}

function ProviderButton({ provider, basePath, returnTo, busy, onClick }: { provider: IdentityProviderPublicConfig; basePath: string; returnTo?: string; busy: boolean; onClick: () => void }) {
  const href = provider.enabled ? providerSignInHref(provider.id, returnTo, basePath) : undefined
  const providerInitial = provider.label.trim().slice(0, 1).toUpperCase() || '•'
  if (!provider.enabled) return <div aria-disabled="true" className="provider-option provider-option-disabled"><span aria-hidden="true" className="provider-icon">{providerInitial}</span><span className="provider-copy"><strong>{provider.label}</strong><small>Unavailable until configured by an administrator.</small></span><span className="badge badge-muted">Unavailable</span></div>
  return <button aria-label={`Continue with ${provider.label}`} className="provider-option" disabled={busy} type="button" onClick={onClick} data-provider-href={href}><span aria-hidden="true" className="provider-icon">{providerInitial}</span><span className="provider-copy"><strong>Continue with {provider.label}</strong><small>{provider.kind === 'oidc' ? 'Managed company identity' : 'Secure company identity'}</small></span><span aria-hidden="true" className="provider-arrow">→</span></button>
}
