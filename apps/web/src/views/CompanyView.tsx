import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { api, ApiError } from '../lib/api'
import { useAuth } from '../lib/auth'
import { createInvitationLink } from '../lib/invitations'
import { clearTenantScopedClientState } from '../lib/tenant'
import type { IdentityMembership, OrganizationInvitation, OrganizationRole, TeamMember } from '../lib/types'
import { Badge, Button, EmptyState, ErrorState, Field, LoadingState, Notice, Panel } from '../components/Primitives'

const INVITABLE_ROLES: OrganizationRole[] = ['reader', 'publisher', 'admin']
const ROLE_OPTIONS: OrganizationRole[] = ['reader', 'publisher', 'admin', 'owner']

function displayRole(role: string | null | undefined): string {
  if (!role) return 'No role'
  return role.slice(0, 1).toUpperCase() + role.slice(1)
}

function invitationStatus(invitation: OrganizationInvitation): string {
  const status = invitation.status?.trim().toLowerCase()
  return status || 'pending'
}

function effectiveInvitationStatus(invitation: OrganizationInvitation, now: number): string {
  const status = invitationStatus(invitation)
  if (status !== 'pending' || !invitation.expiresAt) return status
  const expiresAt = Date.parse(invitation.expiresAt)
  return Number.isFinite(expiresAt) && expiresAt <= now ? 'expired' : status
}

function displayInvitationStatus(invitation: OrganizationInvitation, now: number): string {
  return displayRole(effectiveInvitationStatus(invitation, now))
}

function isPendingInvitation(invitation: OrganizationInvitation, now: number): boolean {
  return effectiveInvitationStatus(invitation, now) === 'pending'
}

function groupInvitations(invitations: readonly OrganizationInvitation[], now: number): {
  pending: OrganizationInvitation[]
  history: OrganizationInvitation[]
} {
  const pending: OrganizationInvitation[] = []
  const history: OrganizationInvitation[] = []
  for (const invitation of invitations) {
    if (isPendingInvitation(invitation, now)) pending.push(invitation)
    else history.push(invitation)
  }
  return { pending, history }
}

function memberName(member: TeamMember): string {
  return member.name || member.user?.name || member.email || member.user?.email || member.userId || 'Team member'
}

function memberEmail(member: TeamMember): string | undefined {
  return member.email || member.user?.email || undefined
}

function safeSlug(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 64)
}

async function copyToClipboard(value: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value)
      return true
    } catch {
      // Fall through to the selection-based copy for browsers that expose the
      // Clipboard API but deny the write in the current context.
    }
  }
  if (typeof document === 'undefined') return false
  const fallback = document.createElement('textarea')
  fallback.value = value
  fallback.setAttribute('readonly', '')
  fallback.style.position = 'fixed'
  fallback.style.opacity = '0'
  document.body.append(fallback)
  fallback.select()
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    fallback.remove()
  }
}

export function CompanyView() {
  const navigate = useNavigate()
  const { principal, session, refresh, switchOrganization } = useAuth()
  const memberships = session?.organizations ?? []
  const activeOrganization = session?.activeOrganization ?? null
  const activeMembership = session?.activeMembership ?? null
  const needsOrganization = session?.needsOnboarding === true
  const needsSelection = !needsOrganization && memberships.length > 0 && !activeOrganization

  if (!session && principal) return <LegacyCompanyState organizationId={principal.organizationId} organizationName={principal.display?.organizationName} />
  if (!session) return <LoadingState label="Loading company access…" />
  if (needsOrganization) return <OnboardingPanel onCreated={async (organizationId) => {
    clearTenantScopedClientState()
    await refresh()
    if (organizationId) await switchOrganization(organizationId)
    await navigate({ to: '/app', search: {}, replace: true })
  }} />
  if (needsSelection) return <CompanySelection memberships={memberships} onSelect={async (organizationId) => {
    clearTenantScopedClientState()
    await switchOrganization(organizationId)
    await navigate({ to: '/app', search: {}, replace: true })
  }} />
  if (!activeOrganization || !activeMembership) return <ErrorState message="Your company session is missing an active membership." onRetry={() => void refresh()} />
  return <CompanyManagement activeMembership={activeMembership} organization={activeOrganization} />
}

function LegacyCompanyState({ organizationId, organizationName }: { organizationId: string; organizationName?: string }) {
  return <div className="view-heading"><div><span className="eyebrow">Company</span><h1>{organizationName ?? organizationId}</h1><p className="muted">This registry is using the existing token sign-in. Company switching and team controls appear after company identity is configured.</p></div><Notice kind="info">Your access is checked before each change. Ask an owner to configure company identity access before inviting teammates.</Notice></div>
}

function OnboardingPanel({ onCreated }: { onCreated: (organizationId?: string) => Promise<void> }) {
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmedName = name.trim()
    if (!trimmedName) { setError('Enter a company name to continue.'); return }
    const normalizedSlug = safeSlug(slug || trimmedName)
    if (!normalizedSlug) { setError('Enter a company slug using letters, numbers, or hyphens.'); return }
    setBusy(true); setError(null)
    try {
      const result = await api.createOrganization({ name: trimmedName, slug: normalizedSlug })
      await onCreated(result.organization.id)
    } catch (cause) { setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not create your company.') } finally { setBusy(false) }
  }
  return <div className="company-onboarding"><div className="company-onboarding-copy"><span className="eyebrow">First step</span><h1>Create your company</h1><p className="muted">Your identity is signed in. Create a company to keep releases, policy, and team access in one private workspace.</p><div className="company-onboarding-steps"><span><strong>01</strong> Name the company</span><span><strong>02</strong> Invite teammates when ready</span><span><strong>03</strong> Access is checked for each request</span></div></div><Panel title="Set up a company" description="You become the owner. Existing token registry data stays unchanged."><form className="form-grid" onSubmit={submit}><Field label="Company name" hint="Use the name your team will recognize."><input autoFocus maxLength={120} name="companyName" onChange={(event) => setName(event.target.value)} placeholder="Acme Skills" value={name} /></Field><Field label="Company slug" hint="Optional. Letters, numbers, and hyphens are accepted."><input maxLength={64} name="companySlug" onChange={(event) => setSlug(event.target.value)} placeholder="acme-skills" value={slug} /></Field>{error && <div className="form-grid-message"><Notice kind="error">{error}</Notice></div>}<div className="form-actions"><Button busy={busy} type="submit">Create company</Button></div></form></Panel></div>
}

function CompanySelection({ memberships, onSelect }: { memberships: readonly IdentityMembership[]; onSelect: (organizationId: string) => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null)
  const choose = async (organizationId: string) => { setBusy(organizationId); try { await onSelect(organizationId) } finally { setBusy(null) } }
  const selectionDescription = memberships.length === 1
    ? 'Choose this company to open the registry.'
    : 'Your account belongs to more than one company. Choose where this registry session should work.'
  return <div className="company-selection"><div className="view-heading"><div><span className="eyebrow">Company access</span><h1>Choose a company</h1><p className="muted">{selectionDescription}</p></div></div><div className="company-card-grid">{memberships.map((membership) => <article className="company-card" key={membership.organization.id}><div className="company-card-mark" aria-hidden="true">{membership.organization.name.slice(0, 1).toUpperCase()}</div><div className="company-card-copy"><h2>{membership.organization.name}</h2><p>{membership.organization.slug}</p><span className="badge badge-muted">{displayRole(membership.role)}</span></div><Button busy={busy === membership.organization.id} kind="secondary" onClick={() => void choose(membership.organization.id)}>Open company</Button></article>)}</div></div>
}

function CompanyManagement({ activeMembership, organization }: { activeMembership: IdentityMembership; organization: IdentityMembership['organization'] }) {
  const canManage = activeMembership.role === 'owner' || activeMembership.role === 'admin'
  const [members, setMembers] = useState<TeamMember[] | null>(null)
  const [invitations, setInvitations] = useState<OrganizationInvitation[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const requestGeneration = useRef(0)
  const reload = useCallback(async () => {
    const generation = ++requestGeneration.current
    setError(null)
    const membersPromise = api.organizationMembers()
    const invitationsPromise = canManage ? api.organizationInvitations() : null
    const membersResult = await membersPromise.then((value) => ({ status: 'fulfilled' as const, value }), (reason: unknown) => ({ status: 'rejected' as const, reason }))
    const invitationResult = invitationsPromise ? await invitationsPromise.then((value) => ({ status: 'fulfilled' as const, value }), (reason: unknown) => ({ status: 'rejected' as const, reason })) : null
    if (generation !== requestGeneration.current) return
    if (membersResult.status === 'rejected') { const cause = membersResult.reason; setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not load team access.'); return }
    if (invitationResult?.status === 'rejected') { const cause = invitationResult.reason; setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not load team access.'); return }
    setMembers(membersResult.value.members)
    setInvitations(invitationResult?.status === 'fulfilled' ? invitationResult.value.invitations : [])
  }, [canManage, organization.id])
  useEffect(() => {
    requestGeneration.current += 1
    setMembers(null)
    setInvitations(null)
    void reload()
    return () => { requestGeneration.current += 1 }
  }, [reload, reloadKey])
  return <div className="company-management"><div className="page-intro"><div><span className="eyebrow">Company</span><h1>{organization.name}</h1><p className="muted">Manage who can use this company. Role changes and invitations are checked before they take effect.</p></div><div className="company-heading-meta"><span className="badge badge-good">Active</span><code>{organization.slug}</code></div></div>{error && <Notice kind="error">{error}</Notice>}<div className="company-management-grid">{canManage && <InvitePanel disabled={false} onInvited={() => setReloadKey((current) => current + 1)} />}<TeamPanel canManage={canManage} invitations={invitations} members={members} onChanged={() => setReloadKey((current) => current + 1)} /></div></div>
}

function InvitePanel({ disabled, onInvited }: { disabled: boolean; onInvited: () => void }) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<OrganizationRole>('reader')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)
  const [inviteLink, setInviteLink] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (disabled) return
    const trimmedEmail = email.trim()
    if (!trimmedEmail || !/^\S+@\S+\.\S+$/u.test(trimmedEmail)) { setMessage({ kind: 'error', text: 'Enter a valid teammate email.' }); return }
    setBusy(true); setMessage(null); setInviteLink(null); setCopied(false)
    try {
      const invitation = await api.inviteOrganizationMember({ email: trimmedEmail, role })
      const link = createInvitationLink(invitation.id)
      setEmail('')
      setInviteLink(link ?? null)
      setMessage(link
        ? { kind: 'success', text: 'Invitation created. Copy the link to share it securely.' }
        : { kind: 'error', text: 'The invitation was created, but its link could not be generated.' })
      onInvited()
    }
    catch (cause) { setMessage({ kind: 'error', text: cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not create the invitation.' }) }
    finally { setBusy(false) }
  }
  async function copyInviteLink() {
    if (!inviteLink) return
    const copiedToClipboard = await copyToClipboard(inviteLink)
    setCopied(copiedToClipboard)
    setMessage(copiedToClipboard
      ? { kind: 'success', text: 'Invitation link copied to clipboard.' }
      : { kind: 'error', text: 'Copy is unavailable here. Select the invitation link below and copy it manually.' })
  }
  return <Panel className="company-invite-panel" title="Invite a teammate" description={disabled ? 'Only an owner or admin can invite teammates.' : 'Create a link for a teammate. Share it with them; no email is sent automatically.'}><form className="stack-form company-invite-form" onSubmit={submit}><Field label="Email address"><input disabled={disabled} name="inviteEmail" onChange={(event) => setEmail(event.target.value)} placeholder="teammate@company.com" type="email" value={email} /></Field><Field label="Role"><select disabled={disabled} name="inviteRole" onChange={(event) => setRole(event.target.value as OrganizationRole)} value={role}>{INVITABLE_ROLES.map((candidate) => <option key={candidate} value={candidate}>{displayRole(candidate)}</option>)}</select></Field>{message && <Notice kind={message.kind}>{message.text}</Notice>}{inviteLink && <div className="invite-link-block"><Field label="Invitation link"><input aria-label="Invitation link" onClick={(event) => event.currentTarget.select()} onFocus={(event) => event.currentTarget.select()} readOnly value={inviteLink} /></Field><Button kind="secondary" type="button" onClick={() => void copyInviteLink()}>{copied ? 'Copied' : 'Copy invitation link'}</Button><span className="helper">If clipboard access is blocked, select the link above and copy it manually.</span></div>}<Button busy={busy} disabled={disabled} type="submit">Create invitation</Button></form></Panel>
}

function TeamPanel({ canManage, invitations, members, onChanged }: { canManage: boolean; invitations: OrganizationInvitation[] | null; members: TeamMember[] | null; onChanged: () => void }) {
  const now = Date.now()
  const groups = invitations === null ? null : groupInvitations(invitations, now)
  return <Panel className="company-team-panel" title="Team access" description={canManage ? 'Choose a new role and save it. The change takes effect after it is checked.' : 'You can view team access. Ask an owner or admin to change roles.'}>{!canManage && <div className="company-readonly-guidance" role="note"><strong>Team access is view-only.</strong><span>Owners and admins manage invitations and role changes.</span></div>}{members === null ? <LoadingState label="Loading team access…" /> : members.length === 0 ? <EmptyState title="No team members yet" description="The active company has no memberships in the current response." /> : <div className="table-wrap"><table><thead><tr><th>Member</th><th>Role</th><th>Status</th><th>Access</th></tr></thead><tbody>{members.map((member) => <MemberRow canManage={canManage} key={member.id} member={member} onChanged={onChanged} />)}</tbody></table></div>}{canManage ? <div className="company-invitations"><section aria-labelledby="pending-invitations-heading" data-testid="pending-invitations"><div className="company-subheading"><div><h3 id="pending-invitations-heading">Pending invitations</h3><p className="muted">Links waiting to be accepted stay here. Accepted or closed links appear in history.</p></div><span className="badge badge-muted" data-testid="pending-invitations-count">{groups?.pending.length ?? '…'}</span></div>{invitations === null ? <LoadingState label="Loading invitations…" /> : groups!.pending.length === 0 ? <p className="company-empty-note">No pending invitations.</p> : <InvitationList invitations={groups!.pending} now={now} />}</section>{groups !== null && groups.history.length > 0 && <section aria-labelledby="invitation-history-heading" className="company-invitation-history" data-testid="invitation-history"><div className="company-subheading"><div><h3 id="invitation-history-heading">Invitation history</h3><p className="muted">Accepted or closed invitations stay here for reference.</p></div><span className="badge badge-muted" data-testid="invitation-history-count">{groups.history.length}</span></div><InvitationList invitations={groups.history} now={now} /></section>}</div> : <p className="company-empty-note">Invitation management is available to owners and admins.</p>}</Panel>
}

function InvitationList({ invitations, now }: { invitations: readonly OrganizationInvitation[]; now: number }) {
  return <div className="invitation-list">{invitations.map((invitation) => <div className="invitation-row" key={invitation.id}><div><strong>{invitation.email}</strong><span>{displayRole(invitation.role)} · {displayInvitationStatus(invitation, now)}</span></div><Badge tone="muted" value={effectiveInvitationStatus(invitation, now)} /></div>)}</div>
}

function MemberRow({ canManage, member, onChanged }: { canManage: boolean; member: TeamMember; onChanged: () => void }) {
  const [role, setRole] = useState(member.role)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const changed = role !== member.role
  const save = async () => {
    if (!changed || !canManage) return
    setBusy(true); setError(null)
    try { await api.updateOrganizationMemberRole(member.id, role); onChanged() }
    catch (cause) { setRole(member.role); setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'The server rejected this role change.') }
    finally { setBusy(false) }
  }
  return <tr><td><strong>{memberName(member)}</strong>{memberEmail(member) && <span className="cell-sub">{memberEmail(member)}</span>}{error && <span className="cell-sub company-error-text">{error}</span>}</td><td>{canManage ? <select aria-label={`Role for ${memberName(member)}`} disabled={busy} onChange={(event) => setRole(event.target.value as OrganizationRole)} value={role}>{ROLE_OPTIONS.map((candidate) => <option key={candidate} value={candidate}>{displayRole(candidate)}</option>)}</select> : <Badge tone="muted" value={displayRole(member.role)} />}</td><td><Badge tone="muted" value={member.status ?? 'active'} /></td><td>{canManage && changed ? <Button busy={busy} kind="secondary" onClick={() => void save()}>Save role</Button> : <span className="muted company-server-note">Current</span>}</td></tr>
}
