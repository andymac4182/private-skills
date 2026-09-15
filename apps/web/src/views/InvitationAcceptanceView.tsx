import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { api, ApiError } from '../lib/api'
import { safeLoginReturnTo, useAuth } from '../lib/auth'
import { invitationReturnTo, normalizeInvitationId } from '../lib/invitations'
import type { OrganizationInvitation } from '../lib/types'
import { Button, Notice, Panel } from '../components/Primitives'

export interface InvitationAcceptanceViewProps {
  invitationId?: string
}

/** Keep Better Auth's invitation failures understandable without weakening its checks. */
export function invitationErrorMessage(cause: unknown): string {
  const detail = cause instanceof ApiError
    ? `${cause.code ?? ''} ${cause.message}`.toLowerCase()
    : cause instanceof Error
      ? cause.message.toLowerCase()
      : ''

  if (detail.includes('email_verification') || detail.includes('email verification') || detail.includes('verify your email') || detail.includes('invitation_email_unverified') || detail.includes('verified session for the invited email')) {
    return 'Verify the invited email address before accepting this invitation.'
  }
  if (detail.includes('not_the_recipient') || detail.includes('not the recipient') || detail.includes('recipient of the invitation')) {
    return 'This invitation was sent to a different email address. Sign in with the invited email address.'
  }
  if (detail.includes('invitation_not_found') || detail.includes('invitation not found') || detail.includes('invitation has expired') || detail.includes('expired')) {
    return 'This invitation has expired or is no longer available. Ask the company owner for a new link.'
  }
  if (cause instanceof ApiError && cause.status === 401) {
    return 'Your company session has expired. Sign in again to continue.'
  }
  if (cause instanceof ApiError || cause instanceof Error) return cause.message
  return 'The invitation could not be loaded. Try again or ask the company owner for a new link.'
}

export function InvitationAcceptanceView({ invitationId }: InvitationAcceptanceViewProps) {
  const navigate = useNavigate()
  const { session, status, refresh } = useAuth()
  const id = normalizeInvitationId(invitationId)
  const loginReturnTo = safeLoginReturnTo(invitationReturnTo(id))
  const [invitation, setInvitation] = useState<OrganizationInvitation | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!loginReturnTo || status !== 'signed-out' || session) return
    void navigate({ to: '/login', search: { returnTo: loginReturnTo }, replace: true })
  }, [loginReturnTo, navigate, session, status])

  useEffect(() => {
    if (!id || status !== 'signed-in' || !session) return
    let active = true
    setLoading(true)
    setError(null)
    setInvitation(null)
    void api.getOrganizationInvitation(id)
      .then((value) => {
        if (active) setInvitation(value)
      })
      .catch((cause: unknown) => {
        if (active) setError(invitationErrorMessage(cause))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [attempt, id, session?.sessionId, status])

  async function acceptInvitation() {
    if (!id || !invitation || busy) return
    setBusy(true)
    setError(null)
    try {
      await api.acceptOrganizationInvitation(id)
      await refresh()
      await navigate({ to: '/app', search: {}, replace: true })
    } catch (cause) {
      setError(invitationErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  if (!id) {
    return <InvitationPageFrame><InvitationMessage title="Invalid invitation link">This invitation link is missing a valid invitation id. Ask the company owner to send a new link.</InvitationMessage></InvitationPageFrame>
  }
  if (status === 'loading') {
    return <InvitationPageFrame><InvitationMessage title="Checking your session">Loading the secure invitation flow…</InvitationMessage></InvitationPageFrame>
  }
  if (status === 'signed-out' && !session) {
    return <InvitationPageFrame><InvitationMessage title="Sign in to accept this invitation">Taking you to secure company sign-in…</InvitationMessage></InvitationPageFrame>
  }
  if (status === 'signed-in' && !session) {
    return <InvitationPageFrame><InvitationMessage title="Company sign-in required"><Notice kind="error">Use company identity sign-in with the invited email address to accept this invitation.</Notice><div className="form-actions"><Button onClick={() => void navigate({ to: '/login', search: { returnTo: loginReturnTo ?? `/organization/accept-invitation?id=${encodeURIComponent(id)}` } })}>Sign in with company identity</Button></div></InvitationMessage></InvitationPageFrame>
  }
  if (loading) {
    return <InvitationPageFrame><InvitationMessage title="Loading invitation">Checking the invitation with the identity service…</InvitationMessage></InvitationPageFrame>
  }
  if (error || !invitation) {
    return <InvitationPageFrame><InvitationMessage title="Invitation unavailable"><Notice kind="error">{error ?? 'The invitation could not be loaded.'}</Notice><div className="form-actions"><Button kind="secondary" onClick={() => setAttempt((value) => value + 1)}>Try again</Button></div></InvitationMessage></InvitationPageFrame>
  }

  return <InvitationPageFrame>
    <div className="invitation-card-content">
      <span className="eyebrow">Company invitation</span>
      <h1>Join {invitation.organizationName ?? 'this company'}</h1>
      <p className="lede">You are signed in as <strong>{session?.user.email}</strong>. Review the invitation before adding this company to your account.</p>
      <Panel className="invitation-card" title="Invitation details" description="The identity service checks the invited email, expiry, and membership limits when you accept.">
        <div className="detail-meta">
          <div className="meta-row"><span>Company</span><span>{invitation.organizationName ?? invitation.organizationSlug ?? 'Private company'}</span></div>
          <div className="meta-row"><span>Invited email</span><span>{invitation.email}</span></div>
          <div className="meta-row"><span>Role</span><span>{displayRole(invitation.role)}</span></div>
          {invitation.expiresAt && <div className="meta-row"><span>Expires</span><span>{formatExpiry(invitation.expiresAt)}</span></div>}
        </div>
        <div className="form-actions invitation-actions"><Button busy={busy} onClick={() => void acceptInvitation()}>Accept invitation</Button></div>
      </Panel>
    </div>
  </InvitationPageFrame>
}

function InvitationPageFrame({ children }: { children: ReactNode }) {
  return <main className="public-shell"><div className="public-nav"><a className="brand" href="/"><span className="brand-mark">PS</span><strong>Private Skills</strong></a><span className="public-nav-label">Secure invitation</span></div><div className="public-center">{children}</div></main>
}

function InvitationMessage({ title, children }: { title: string; children: ReactNode }) {
  return <div className="invitation-card-content"><span className="eyebrow">Company invitation</span><h1>{title}</h1><div className="invitation-message-body">{typeof children === 'string' ? <p className="lede">{children}</p> : children}</div></div>
}

function displayRole(role: string | undefined): string {
  if (!role) return 'Member'
  return role.slice(0, 1).toUpperCase() + role.slice(1)
}

function formatExpiry(value: string): string {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString()
}
