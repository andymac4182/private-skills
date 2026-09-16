import { useEffect, useState, type ReactNode } from 'react'
import { useAuth } from '../lib/auth'
import { Button, Notice, Panel } from '../components/Primitives'

type LocalDemoKind = 'checkout' | 'portal'
type LocalDemoStatus = 'open' | 'completed'

interface LocalDemoSession {
  provider: 'local'
  mode: 'test'
  kind: LocalDemoKind
  id: string
  status: LocalDemoStatus
  planId?: string
  planLabel?: string
  returnUrl: string
  cancelUrl?: string
}

interface LocalDemoSessionResponse {
  protocolVersion: 1
  session: LocalDemoSession
}

interface LocalDemoCompletionResponse {
  protocolVersion: 1
  completed: true
  webhookStatus: 'applied' | 'duplicate' | 'ignored'
  session: LocalDemoSession
}

export interface LocalBillingDemoViewProps {
  sessionId?: string
  /** Injected in tests; production uses the same-origin fetch. */
  fetcher?: typeof fetch
}

function safeLocalReturnUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const parsed = new URL(value)
    if (parsed.username || parsed.password || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')))) return undefined
    return parsed.toString()
  } catch {
    return undefined
  }
}

async function fetchJson<T>(fetcher: typeof fetch, path: string, init?: RequestInit): Promise<T> {
  const response = await fetcher(path, { ...init, credentials: 'include', headers: { accept: 'application/json', ...(init?.headers ?? {}) } })
  const text = await response.text()
  let body: unknown
  try { body = text ? JSON.parse(text) : undefined } catch { body = undefined }
  if (!response.ok) {
    const message = body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string'
      ? (body as { message: string }).message
      : 'The local billing demo request failed.'
    throw new Error(message)
  }
  return body as T
}

function DemoFrame({ children, label }: { children: ReactNode; label: string }) {
  return <main className="public-shell"><div className="public-nav"><a className="brand" href="/"><span className="brand-mark">PS</span><strong>Private Skills</strong></a><span className="public-nav-label">{label}</span></div><div className="public-center">{children}</div></main>
}

function SessionError({ message }: { message: string }) {
  return <DemoFrame label="Local test billing"><div className="invitation-card-content"><span className="eyebrow">Local test billing</span><h1>Demo session unavailable</h1><Notice kind="error">{message}</Notice><div className="form-actions"><a className="button button-secondary" href="/app/billing">Return to billing</a></div></div></DemoFrame>
}

function useLocalDemoSession(kind: LocalDemoKind, sessionId: string | undefined, fetcher: typeof fetch) {
  const { status } = useAuth()
  const [session, setSession] = useState<LocalDemoSession | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (status === 'loading') return
    let active = true
    if (status === 'signed-out') {
      setLoading(false)
      setError('Sign in with a company owner or admin account to use the local billing demo.')
      return () => { active = false }
    }
    if (!sessionId) {
      setLoading(false)
      setError('This local billing demo link is missing its session id.')
      return () => { active = false }
    }
    setLoading(true)
    setError(null)
    setSession(null)
    void fetchJson<LocalDemoSessionResponse>(fetcher, `/v1/billing/test-${kind}?session=${encodeURIComponent(sessionId)}`)
      .then((body) => { if (active) setSession(body.session) })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : 'The local billing demo request failed.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [fetcher, kind, sessionId, status])

  return { session, loading, error }
}

export function LocalBillingCheckoutView({ fetcher = fetch, sessionId }: LocalBillingDemoViewProps) {
  const { session, loading, error } = useLocalDemoSession('checkout', sessionId, fetcher)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [completedSession, setCompletedSession] = useState<LocalDemoSession | null>(null)

  async function completeCheckout() {
    if (!session || busy) return
    setBusy(true)
    setActionError(null)
    try {
      const body = await fetchJson<LocalDemoCompletionResponse>(fetcher, '/v1/billing/test-checkout/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session: session.id }),
      })
      setCompletedSession(body.session)
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'The local checkout could not be completed.')
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <DemoFrame label="Local test billing"><div className="invitation-card-content"><span className="eyebrow">Local test billing</span><h1>Loading test checkout</h1><p className="lede">Checking this fixture session with the server…</p></div></DemoFrame>
  if (error || !session) return <SessionError message={error ?? 'The local checkout session is unavailable.'} />
  const finished = completedSession ?? session
  const returnUrl = safeLocalReturnUrl(finished.returnUrl)
  const cancelUrl = safeLocalReturnUrl(finished.cancelUrl)
  return <DemoFrame label="Local test billing">
    <div className="invitation-card-content">
      <span className="eyebrow">Local test billing</span>
      <h1>Test checkout</h1>
      <p className="lede">This deterministic local fixture does not contact Stripe, create a charge, or collect a payment method.</p>
      <Panel className="invitation-card" title={finished.planLabel ?? finished.planId ?? 'Configured plan'} description="A server-owned signed fixture webhook applies the plan only after you complete this demo.">
        <div className="detail-meta">
          <div className="meta-row"><span>Provider</span><span>Local</span></div>
          <div className="meta-row"><span>Mode</span><span>Test</span></div>
          <div className="meta-row"><span>Session</span><span>{finished.status === 'completed' ? 'Completed' : 'Ready'}</span></div>
        </div>
        {actionError && <Notice kind="error">{actionError}</Notice>}
        {finished.status === 'completed' ? <Notice kind="success">Local checkout completed. The signed fixture webhook was accepted; return to billing to read the verified entitlement.</Notice> : <div className="form-actions"><Button busy={busy} onClick={() => void completeCheckout()}>Complete test checkout</Button></div>}
        <div className="form-actions"><a className="button button-secondary" href={returnUrl ?? '/app/billing'}>Return to billing</a>{finished.status !== 'completed' && <a className="button button-quiet" href={cancelUrl ?? '/app/billing?billing=cancelled'}>Cancel checkout</a>}</div>
      </Panel>
    </div>
  </DemoFrame>
}

export function LocalBillingPortalView({ fetcher = fetch, sessionId }: LocalBillingDemoViewProps) {
  const { session, loading, error } = useLocalDemoSession('portal', sessionId, fetcher)
  if (loading) return <DemoFrame label="Local test billing"><div className="invitation-card-content"><span className="eyebrow">Local test billing</span><h1>Loading test portal</h1><p className="lede">Checking this fixture session with the server…</p></div></DemoFrame>
  if (error || !session) return <SessionError message={error ?? 'The local portal session is unavailable.'} />
  const returnUrl = safeLocalReturnUrl(session.returnUrl)
  return <DemoFrame label="Local test billing">
    <div className="invitation-card-content">
      <span className="eyebrow">Local test billing</span>
      <h1>Test subscription portal</h1>
      <p className="lede">This deterministic local fixture demonstrates the subscription-management handoff. It does not contact Stripe or change a payment method.</p>
      <Panel className="invitation-card" title="Subscription management" description="The server verified the owner/admin session and the tenant-bound local portal session.">
        <div className="detail-meta">
          <div className="meta-row"><span>Provider</span><span>Local</span></div>
          <div className="meta-row"><span>Mode</span><span>Test</span></div>
          <div className="meta-row"><span>Session</span><span>Ready</span></div>
        </div>
        <Notice kind="info">No provider customer portal is opened in this test mode. Use the return button to verify the billing console handoff.</Notice>
        <div className="form-actions"><a className="button button-primary" href={returnUrl ?? '/app/billing'}>Return to billing</a></div>
      </Panel>
    </div>
  </DemoFrame>
}
