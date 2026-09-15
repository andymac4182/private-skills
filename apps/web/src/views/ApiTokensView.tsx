import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { useAuth } from '../lib/auth'
import {
  apiTokenErrorMessage,
  createApiToken,
  isApiTokenUnavailableError,
  listApiTokens,
  revokeApiToken,
} from '../lib/apiTokens'
import type { ApiTokenMetadata, CreateApiTokenResult } from '../../../../packages/api-tokens/src/index'
import { Badge, Button, ConfirmAction, EmptyState, ErrorState, Field, LoadingState, Notice, Panel } from '../components/Primitives'
import { formatDate } from '../lib/format'
import '../styles/company-tokens.css'

type TokenRole = Exclude<ApiTokenMetadata['roleCeiling'], 'worker'>
type LoadState = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'
type CopyState = 'idle' | 'copied' | 'manual'

const ROLE_ORDER: readonly TokenRole[] = ['reader', 'publisher', 'admin', 'owner']
const DEFAULT_EXPIRY_SECONDS = 90 * 24 * 60 * 60

const EXPIRY_OPTIONS = [
  { value: String(7 * 24 * 60 * 60), label: '7 days' },
  { value: String(30 * 24 * 60 * 60), label: '30 days' },
  { value: String(DEFAULT_EXPIRY_SECONDS), label: '90 days' },
  { value: String(180 * 24 * 60 * 60), label: '180 days' },
  { value: String(365 * 24 * 60 * 60), label: '1 year' },
] as const

/** The server's role grants are rendered as bounded, selectable capabilities. */
const TOKEN_SCOPES = [
  'registry:read',
  'skills:read',
  'skills:publish',
  'resolve:read',
  'operations:read',
  'install:authorize',
  'install:receipt',
  'artifacts:download',
  'packs:read',
  'packs:publish',
  'scans:read',
  'upstreams:read',
  'imports:create',
] as const

const ROLE_SCOPES: Readonly<Record<TokenRole, readonly string[]>> = {
  owner: TOKEN_SCOPES,
  admin: TOKEN_SCOPES,
  publisher: [
    'registry:read', 'skills:read', 'skills:publish', 'resolve:read', 'operations:read',
    'install:authorize', 'install:receipt', 'artifacts:download', 'packs:read', 'packs:publish',
    'scans:read', 'upstreams:read', 'imports:create',
  ],
  reader: [
    'registry:read', 'skills:read', 'resolve:read', 'operations:read', 'install:authorize',
    'install:receipt', 'artifacts:download', 'packs:read', 'scans:read', 'upstreams:read',
  ],
}

const SCOPE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'registry:read': 'Read registry metadata',
  'skills:read': 'Read private skill releases',
  'skills:publish': 'Publish and update skills',
  'resolve:read': 'Resolve install references',
  'operations:read': 'View registry operations',
  'install:authorize': 'Authorize an install transfer',
  'install:receipt': 'Submit install receipts',
  'artifacts:download': 'Download approved artifacts',
  'packs:read': 'Read private skill packs',
  'packs:publish': 'Publish skill packs',
  'scans:read': 'Read scan evidence',
  'upstreams:read': 'Read approved upstreams',
  'imports:create': 'Queue upstream imports',
}

interface FormValues {
  name: string
  roleCeiling: TokenRole
  scopes: string[]
  expiresInSeconds: string
}

function roleRank(role: TokenRole): number {
  return ROLE_ORDER.indexOf(role)
}

function highestRole(roles: readonly string[] | undefined): TokenRole | undefined {
  if (!roles) return undefined
  return [...ROLE_ORDER].reverse().find((candidate) => roles.some((role) => role === candidate))
}

function allowedRoles(role: TokenRole): readonly TokenRole[] {
  const maximum = roleRank(role)
  return [...ROLE_ORDER].reverse().filter((candidate) => roleRank(candidate) <= maximum)
}

function scopesForRole(role: TokenRole): string[] {
  return [...ROLE_SCOPES[role]]
}

function createInitialForm(role: TokenRole = 'reader'): FormValues {
  return {
    name: '',
    roleCeiling: role,
    scopes: scopesForRole(role),
    expiresInSeconds: String(DEFAULT_EXPIRY_SECONDS),
  }
}

function displayRole(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1)
}

function tokenStatus(token: ApiTokenMetadata): 'active' | 'expired' | 'revoked' {
  if (token.revokedAt) return 'revoked'
  const expiry = Date.parse(token.expiresAt)
  return Number.isFinite(expiry) && expiry <= Date.now() ? 'expired' : 'active'
}

function tokenStatusTone(status: ReturnType<typeof tokenStatus>): 'good' | 'warn' | 'bad' {
  if (status === 'active') return 'good'
  if (status === 'expired') return 'warn'
  return 'bad'
}

function formatScopes(scopes: readonly string[]): string {
  if (scopes.includes('*')) return 'All permitted scopes'
  return scopes.length > 0 ? scopes.join(' · ') : 'No scopes'
}

function unavailableCopy(): string {
  return 'CLI token management is not available on this deployment yet. The server route is not wired here, so token creation and revocation remain disabled.'
}

function copyFailureMessage(): string {
  return 'Clipboard access is unavailable. Select the token field above and copy it manually.'
}

export function ApiTokensView() {
  const { principal, session } = useAuth()
  const activeOrganization = session?.activeOrganization ?? null
  // The session's active id is the tenant switch boundary. The server still
  // derives the organization from the cookie; this id is only a reset key and
  // display guard for the browser view.
  const organizationId = session ? session.activeOrganizationId : principal?.organizationId ?? null
  const organizationName = activeOrganization?.name ?? organizationId ?? 'your active company'
  const activeRole = session
    ? session.activeMembership?.role
    : highestRole(principal?.roles)
  const identityReady = Boolean(session && activeOrganization && session.activeMembership && activeRole)
  const canManageAll = activeRole === 'owner' || activeRole === 'admin'
  const currentUserId = session?.user.id ?? null

  const [tokens, setTokens] = useState<ApiTokenMetadata[]>([])
  const [loadState, setLoadState] = useState<LoadState>('idle')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ kind: 'success' | 'info'; text: string } | null>(null)
  const [form, setForm] = useState<FormValues>(createInitialForm(activeRole ?? 'reader'))
  const [submitting, setSubmitting] = useState(false)
  const [busyTokenId, setBusyTokenId] = useState<string | null>(null)
  const [revealedToken, setRevealedToken] = useState<string | null>(null)
  const [revealedMetadata, setRevealedMetadata] = useState<CreateApiTokenResult | null>(null)
  const [copyState, setCopyState] = useState<CopyState>('idle')
  const [reloadKey, setReloadKey] = useState(0)
  const requestGeneration = useRef(0)

  useEffect(() => {
    setForm(createInitialForm(activeRole ?? 'reader'))
    setFormError(null)
    setMutationError(null)
    setNotice(null)
    setRevealedToken(null)
    setRevealedMetadata(null)
    setCopyState('idle')
  }, [activeRole, organizationId])

  useEffect(() => {
    const generation = ++requestGeneration.current
    const controller = new AbortController()

    if (!organizationId || !identityReady) {
      setTokens([])
      setLoadState('idle')
      setLoadError(null)
      return () => {
        controller.abort()
        ++requestGeneration.current
      }
    }

    setTokens([])
    setLoadState('loading')
    setLoadError(null)
    void listApiTokens(true, controller.signal)
      .then((response) => {
        if (controller.signal.aborted || generation !== requestGeneration.current) return
        setTokens([...(response.tokens ?? [])])
        setLoadState('ready')
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || generation !== requestGeneration.current) return
        if (isApiTokenUnavailableError(cause)) {
          setTokens([])
          setLoadState('unavailable')
          setLoadError(null)
          return
        }
        setLoadState('error')
        setLoadError(apiTokenErrorMessage(cause, 'Could not load company CLI tokens.'))
      })

    return () => {
      controller.abort()
      ++requestGeneration.current
    }
  }, [identityReady, organizationId, reloadKey])

  const availableScopes = form.roleCeiling ? scopesForRole(form.roleCeiling) : []
  const controlsDisabled = !identityReady || loadState !== 'ready' || submitting || busyTokenId !== null
  const createDisabled = controlsDisabled || availableScopes.length === 0

  function retry() {
    setReloadKey((value) => value + 1)
  }

  function changeRole(event: ChangeEvent<HTMLSelectElement>) {
    const role = event.target.value as TokenRole
    setForm((current) => ({ ...current, roleCeiling: role, scopes: scopesForRole(role) }))
    setFormError(null)
  }

  function toggleScope(scope: string) {
    setForm((current) => ({
      ...current,
      scopes: current.scopes.includes(scope)
        ? current.scopes.filter((candidate) => candidate !== scope)
        : [...current.scopes, scope],
    }))
    setFormError(null)
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (createDisabled || !activeRole) return

    const name = form.name.trim()
    if (!name) {
      setFormError('Enter a name so your team can identify this CLI token.')
      return
    }
    if (form.scopes.length === 0) {
      setFormError('Choose at least one scope for this token.')
      return
    }
    const expiresInSeconds = Number(form.expiresInSeconds)
    if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds <= 0) {
      setFormError('Choose a valid expiration period.')
      return
    }

    const generation = requestGeneration.current
    setSubmitting(true)
    setFormError(null)
    setMutationError(null)
    setNotice(null)
    try {
      const created = await createApiToken({
        name,
        roleCeiling: form.roleCeiling,
        scopes: [...form.scopes],
        expiresInSeconds,
      })
      if (generation !== requestGeneration.current) return
      if (!created || typeof created.token !== 'string' || created.token.length === 0) {
        setFormError('The server did not return a one-time token secret.')
        return
      }
      setRevealedToken(created.token)
      setRevealedMetadata(created)
      setCopyState('idle')
      setForm(createInitialForm(activeRole))
      setNotice({ kind: 'success', text: 'CLI token created. Copy the secret now; it cannot be shown again.' })
      retry()
    } catch (cause) {
      if (generation !== requestGeneration.current) return
      if (isApiTokenUnavailableError(cause)) {
        setLoadState('unavailable')
        setLoadError(null)
      } else {
        setMutationError(apiTokenErrorMessage(cause, 'The CLI token could not be created.'))
      }
    } finally {
      if (generation === requestGeneration.current) setSubmitting(false)
    }
  }

  async function copyRevealedToken() {
    if (!revealedToken) return
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
    if (!clipboard?.writeText) {
      setCopyState('manual')
      return
    }
    try {
      await clipboard.writeText(revealedToken)
      setCopyState('copied')
    } catch {
      setCopyState('manual')
    }
  }

  async function revoke(token: ApiTokenMetadata) {
    const canRevoke = canManageAll || token.userId === currentUserId
    if (!canRevoke || busyTokenId !== null) return

    const generation = requestGeneration.current
    setBusyTokenId(token.id)
    setMutationError(null)
    setNotice(null)
    try {
      await revokeApiToken(token.id)
      if (generation !== requestGeneration.current) return
      setNotice({ kind: 'success', text: `CLI token “${token.name}” was revoked.` })
      retry()
    } catch (cause) {
      if (generation !== requestGeneration.current) return
      if (isApiTokenUnavailableError(cause)) {
        setLoadState('unavailable')
        setLoadError(null)
      } else {
        setMutationError(apiTokenErrorMessage(cause, 'The CLI token could not be revoked.'))
      }
    } finally {
      if (generation === requestGeneration.current) setBusyTokenId(null)
    }
  }

  return (
    <div className="company-tokens-view">
      <div className="page-intro company-tokens-header">
        <div>
          <span className="eyebrow">Company admin</span>
          <h1>CLI tokens</h1>
          <p className="muted">Create short-lived, scoped credentials for the Private Skills CLI and automation.</p>
        </div>
        {activeOrganization && <div className="company-tokens-company"><span>Active company</span><strong>{activeOrganization.name}</strong><code>{activeOrganization.slug}</code></div>}
      </div>

      {!organizationId && <Notice kind="info">Choose an active company before managing CLI tokens.</Notice>}
      {organizationId && !identityReady && session && <Notice kind="info">Choose an active company with an active membership before managing CLI tokens.</Notice>}
      {organizationId && !session && <Notice kind="info">CLI token management requires a company identity session. Your existing token sign-in remains available for registry access.</Notice>}
      {loadState === 'unavailable' && <Notice kind="warning">{unavailableCopy()}</Notice>}
      {notice && <Notice kind={notice.kind}>{notice.text}</Notice>}
      {mutationError && <Notice kind="error">{mutationError}</Notice>}

      {revealedToken && (
        <Panel className="company-token-secret-panel" title="Copy your new token" description="This is the only time the raw secret is displayed. Store it in your CLI secret manager before closing this panel.">
          <div className="company-token-secret">
            <Field label="CLI token secret" hint="Select the field to copy manually if clipboard access is blocked.">
              <input
                aria-label="New CLI token secret"
                autoComplete="off"
                onClick={(event) => event.currentTarget.select()}
                onFocus={(event) => event.currentTarget.select()}
                readOnly
                spellCheck={false}
                value={revealedToken}
              />
            </Field>
            <div className="company-token-secret-actions">
              <Button kind="secondary" type="button" onClick={() => void copyRevealedToken()}>{copyState === 'copied' ? 'Copied' : 'Copy token'}</Button>
              <Button kind="quiet" type="button" onClick={() => { setRevealedToken(null); setCopyState('idle') }}>Hide secret</Button>
            </div>
            <p aria-live="polite" className="helper">{copyState === 'manual' ? copyFailureMessage() : copyState === 'copied' ? 'Copied to clipboard. This secret will not appear in the token list.' : 'Keep this secret private. It will not be shown again after you hide it.'}</p>
            {revealedMetadata && <p className="company-token-secret-meta">{revealedMetadata.name} · {displayRole(revealedMetadata.roleCeiling)} ceiling · expires {formatDate(revealedMetadata.expiresAt)}</p>}
          </div>
        </Panel>
      )}

      <div className="company-tokens-grid">
        <Panel className="company-token-form-panel" title="Create a scoped token" description={identityReady ? 'The server checks your current company membership and role before issuing a token.' : 'An active company identity session is required before a token can be issued.'}>
          <form className="company-token-form" onSubmit={(event) => void submit(event)}>
            <fieldset disabled={createDisabled}>
              <Field label="Token name" hint="Use a purpose and owner, such as “Release bot”.">
                <input maxLength={128} name="tokenName" onChange={(event) => { setForm((current) => ({ ...current, name: event.target.value })); setFormError(null) }} placeholder="Release bot" value={form.name} />
              </Field>
              <Field label="Role ceiling" hint="The server will cap this at your current company role.">
                <select name="tokenRole" onChange={changeRole} value={form.roleCeiling}>
                  {activeRole ? allowedRoles(activeRole).map((role) => <option key={role} value={role}>{displayRole(role)}</option>) : <option value="reader">Reader</option>}
                </select>
              </Field>
              <Field label="Expiration" hint="Short-lived credentials are easier to rotate safely.">
                <select name="tokenExpiry" onChange={(event) => setForm((current) => ({ ...current, expiresInSeconds: event.target.value }))} value={form.expiresInSeconds}>
                  {EXPIRY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </Field>
              <fieldset className="company-token-scope-fieldset">
                <legend>Scopes</legend>
                <p className="helper">Select only the capabilities this client needs. The server enforces these grants for every request.</p>
                <div className="company-token-scope-list">
                  {availableScopes.map((scope) => (
                    <label className="company-token-scope" key={scope}>
                      <input checked={form.scopes.includes(scope)} onChange={() => toggleScope(scope)} type="checkbox" />
                      <span><strong>{scope}</strong><small>{SCOPE_DESCRIPTIONS[scope] ?? 'Scoped registry access'}</small></span>
                    </label>
                  ))}
                </div>
              </fieldset>
              {formError && <div className="form-grid-message"><Notice kind="error">{formError}</Notice></div>}
              <div className="form-actions"><Button busy={submitting} type="submit">Create token</Button></div>
            </fieldset>
          </form>
        </Panel>

        <Panel
          className="company-token-list-panel"
          title="Issued tokens"
          description={canManageAll ? 'You can view and revoke tokens issued by every member of this company.' : 'You can view and revoke tokens issued by your account. Company administrators can manage other members’ tokens.'}
          action={<Button busy={loadState === 'loading'} disabled={!identityReady} kind="quiet" type="button" onClick={retry}>Refresh</Button>}
        >
          {loadState === 'loading' ? <LoadingState label="Loading company tokens…" /> : loadState === 'error' ? <ErrorState message={loadError ?? 'Could not load company CLI tokens.'} onRetry={retry} /> : !identityReady ? <div className="company-token-list-note"><Notice kind="info">Token metadata will appear after you choose an active company.</Notice></div> : tokens.length === 0 ? <EmptyState title="No CLI tokens yet" description="Create a scoped token for a trusted CLI or automation client. The secret is shown once." /> : <TokenTable canManageAll={canManageAll} currentUserId={currentUserId} busyTokenId={busyTokenId} onRevoke={(token) => void revoke(token)} tokens={tokens} />}
        </Panel>
      </div>
    </div>
  )
}

function TokenTable({
  tokens,
  canManageAll,
  currentUserId,
  busyTokenId,
  onRevoke,
}: {
  tokens: readonly ApiTokenMetadata[]
  canManageAll: boolean
  currentUserId: string | null
  busyTokenId: string | null
  onRevoke: (token: ApiTokenMetadata) => void
}) {
  return (
    <div className="table-wrap company-token-table-wrap">
      <table className="company-token-table">
        <thead><tr><th>Token</th><th>Role and scopes</th><th>Lifecycle</th><th>Access</th></tr></thead>
        <tbody>
          {tokens.map((token) => {
            const status = tokenStatus(token)
            const canRevoke = canManageAll || token.userId === currentUserId
            return (
              <tr className={`company-token-row company-token-row-${status}`} key={token.id}>
                <td>
                  <strong>{token.name}</strong>
                  <span className="cell-sub">Created by <code>{token.userId}</code></span>
                  <span className="cell-sub"><code>{token.id}</code></span>
                </td>
                <td>
                  <Badge tone="muted" value={token.roleCeiling} />
                  <span className="cell-sub company-token-scopes">{formatScopes(token.scopes)}</span>
                </td>
                <td>
                  <Badge tone={tokenStatusTone(status)} value={status} />
                  <span className="cell-sub">Created {formatDate(token.createdAt)}</span>
                  <span className="cell-sub">Expires {formatDate(token.expiresAt)}</span>
                  {token.revokedAt && <span className="cell-sub">Revoked {formatDate(token.revokedAt)}</span>}
                </td>
                <td>
                  {status === 'active' && canRevoke ? <ConfirmAction busy={busyTokenId === token.id} label="Revoke" confirmLabel={`Revoke the CLI token “${token.name}”? Existing clients will stop authenticating with it.`} onConfirm={() => onRevoke(token)} /> : status !== 'active' ? <span className="muted company-server-note">No longer active</span> : <span className="muted company-server-note">Admin only</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
