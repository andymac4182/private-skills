import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useAuth } from '../lib/auth'
import {
  companySsoErrorMessage,
  createCompanySsoProvider,
  isCompanySsoUnavailableError,
  listCompanySsoProviders,
  setCompanySsoProviderStatus,
} from '../lib/companySso'
import type {
  CompanySsoProviderCreateInput,
  CompanySsoProviderPublic,
  CompanySsoProviderStatus,
  CompanySsoProtocol,
} from '../../../../packages/identity/src/company-sso-types'
import { Badge, Button, EmptyState, ErrorState, Field, LoadingState, Notice, Panel } from '../components/Primitives'
import '../styles/company-sso.css'

type LoadState = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'

interface FormValues {
  protocol: CompanySsoProtocol
  providerId: string
  displayName: string
  issuer: string
  discoveryUrl: string
  clientId: string
  clientSecret: string
  entryPoint: string
  samlMetadata: string
}

const initialForm: FormValues = {
  protocol: 'oidc',
  providerId: '',
  displayName: '',
  issuer: '',
  discoveryUrl: '',
  clientId: '',
  clientSecret: '',
  entryPoint: '',
  samlMetadata: '',
}

function hasCompanyAdminRole(role: string | undefined): boolean {
  return role === 'owner' || role === 'admin'
}

function unavailableCopy(): string {
  return 'Company SSO settings are not available on this deployment yet. Provider configuration is disabled until the company SSO runtime route is wired.'
}

function providerStatusTone(status: CompanySsoProviderStatus): 'good' | 'muted' {
  return status === 'active' ? 'good' : 'muted'
}

export function SsoSettingsView() {
  const { principal, session } = useAuth()
  const activeOrganization = session?.activeOrganization ?? null
  // An identity session without an active company must choose one before any
  // company-scoped request is made. Legacy token sessions retain their
  // server-derived principal organization as a compatibility fallback.
  const organizationId = activeOrganization?.id ?? (session ? null : principal?.organizationId ?? null)
  const organizationName = activeOrganization?.name ?? organizationId ?? 'your company'
  const role = session?.activeMembership?.role ?? (session ? undefined : principal?.roles.find((candidate) => candidate !== 'worker'))
  const canManage = Boolean(organizationId && hasCompanyAdminRole(role))

  const [providers, setProviders] = useState<CompanySsoProviderPublic[]>([])
  const [loadState, setLoadState] = useState<LoadState>('idle')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ kind: 'success' | 'info'; text: string } | null>(null)
  const [form, setForm] = useState<FormValues>(initialForm)
  const [submitting, setSubmitting] = useState(false)
  const [busyProviderId, setBusyProviderId] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const requestGeneration = useRef(0)

  useEffect(() => {
    setForm(initialForm)
    setFormError(null)
    setNotice(null)
  }, [organizationId])

  useEffect(() => {
    const generation = ++requestGeneration.current
    const controller = new AbortController()

    if (!organizationId || !canManage) {
      setProviders([])
      setLoadState('idle')
      setLoadError(null)
      return () => {
        controller.abort()
        ++requestGeneration.current
      }
    }

    setLoadState('loading')
    setLoadError(null)
    void listCompanySsoProviders(organizationId, controller.signal)
      .then((response) => {
        if (controller.signal.aborted || generation !== requestGeneration.current) return
        setProviders([...(response.providers ?? [])])
        setLoadState('ready')
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || generation !== requestGeneration.current) return
        if (isCompanySsoUnavailableError(cause)) {
          setProviders([])
          setLoadState('unavailable')
          setLoadError(null)
          return
        }
        setLoadState('error')
        setLoadError(companySsoErrorMessage(cause, 'Could not load company SSO providers.'))
      })

    return () => {
      controller.abort()
      ++requestGeneration.current
    }
  }, [canManage, organizationId, reloadToken])

  const retry = () => setReloadToken((value) => value + 1)
  const controlsDisabled = !canManage || loadState !== 'ready' || submitting || busyProviderId !== null

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!organizationId || !canManage || controlsDisabled) return

    const providerId = form.providerId.trim()
    const displayName = form.displayName.trim() || providerId
    const issuer = form.issuer.trim()
    if (!providerId) {
      setFormError('Enter a provider ID to identify this company connection.')
      return
    }
    if (!issuer) {
      setFormError('Enter the identity provider issuer or entity ID.')
      return
    }

    let input: CompanySsoProviderCreateInput
    if (form.protocol === 'oidc') {
      if (!form.discoveryUrl.trim() || !form.clientId.trim() || !form.clientSecret) {
        setFormError('OIDC needs a discovery URL, client ID, and client secret.')
        return
      }
      input = {
        providerId,
        displayName,
        protocol: 'oidc',
        issuer,
        status: 'active',
        oidc: {
          clientId: form.clientId.trim(),
          clientSecret: form.clientSecret,
          discoveryUrl: form.discoveryUrl.trim(),
        },
      }
    } else {
      if (!form.entryPoint.trim() || !form.samlMetadata.trim()) {
        setFormError('SAML needs an entry point and IdP metadata XML.')
        return
      }
      input = {
        providerId,
        displayName,
        protocol: 'saml',
        issuer,
        status: 'active',
        saml: {
          entryPoint: form.entryPoint.trim(),
          idpMetadata: { metadata: form.samlMetadata.trim() },
          wantAssertionsSigned: true,
        },
      }
    }

    const generation = requestGeneration.current
    setSubmitting(true)
    setFormError(null)
    setNotice(null)
    try {
      await createCompanySsoProvider(organizationId, input)
      if (generation !== requestGeneration.current) return
      setForm(initialForm)
      setNotice({ kind: 'success', text: 'Company sign-in provider added. Provider credentials remain server-side.' })
      retry()
    } catch (cause) {
      if (generation !== requestGeneration.current) return
      if (isCompanySsoUnavailableError(cause)) {
        setLoadState('unavailable')
        setLoadError(null)
      } else {
        setFormError(companySsoErrorMessage(cause, 'The company SSO provider could not be saved.'))
      }
    } finally {
      if (generation === requestGeneration.current) setSubmitting(false)
    }
  }

  async function toggleProvider(provider: CompanySsoProviderPublic) {
    if (!organizationId || !canManage || controlsDisabled) return
    const generation = requestGeneration.current
    const nextStatus: CompanySsoProviderStatus = provider.status === 'active' ? 'disabled' : 'active'
    setBusyProviderId(provider.providerId)
    setNotice(null)
    setFormError(null)
    try {
      await setCompanySsoProviderStatus(organizationId, provider, nextStatus)
      if (generation !== requestGeneration.current) return
      setNotice({ kind: 'success', text: `${provider.displayName} is now ${nextStatus}.` })
      retry()
    } catch (cause) {
      if (generation !== requestGeneration.current) return
      if (isCompanySsoUnavailableError(cause)) {
        setLoadState('unavailable')
        setLoadError(null)
      } else {
        setFormError(companySsoErrorMessage(cause, 'The company SSO provider could not be updated.'))
      }
    } finally {
      if (generation === requestGeneration.current) setBusyProviderId(null)
    }
  }

  return (
    <div className="company-sso-view">
      <div className="page-intro company-sso-header">
        <div>
          <span className="eyebrow">Company admin</span>
          <h1>Company sign-in</h1>
          <p className="muted">Configure the identity providers that members can use for {organizationName}.</p>
        </div>
        {activeOrganization && <div className="company-sso-company"><span>Active company</span><strong>{activeOrganization.name}</strong><code>{activeOrganization.slug}</code></div>}
      </div>

      {!organizationId ? (
        <Notice kind="info">Choose an active company before managing company sign-in. No company SSO request was made.</Notice>
      ) : !canManage ? (
        <Notice kind="warning">Owner or admin access is required to manage company sign-in. The server remains the authority for this permission.</Notice>
      ) : (
        <>
          {notice && <Notice kind={notice.kind}>{notice.text}</Notice>}
          {formError && <Notice kind="error">{formError}</Notice>}
          {loadState === 'unavailable' && <Notice kind="warning">{unavailableCopy()}</Notice>}
          {loadState === 'error' && <ErrorState message={loadError ?? 'Could not load company SSO providers.'} onRetry={retry} />}
          {loadState === 'loading' && <LoadingState label="Loading company sign-in providers…" />}

          {loadState === 'ready' && (
            <Panel className="company-sso-provider-panel" title="Configured providers" description="The server binds every provider to this company and returns metadata only.">
              {providers.length === 0 ? (
                <EmptyState title="No company providers configured yet" description="Add an OIDC or SAML connection below. The callback URL is generated by the server for the selected provider." />
              ) : (
                <div className="company-sso-provider-list">
                  {providers.map((provider) => <ProviderCard busy={busyProviderId === provider.providerId} disabled={controlsDisabled} key={provider.id} provider={provider} onToggle={() => void toggleProvider(provider)} />)}
                </div>
              )}
            </Panel>
          )}

          <Panel className="company-sso-form-panel" title="Add a provider" description="Credentials and SAML metadata are sent over the authenticated company admin API and are never displayed after save.">
            <form className="company-sso-form" onSubmit={(event) => void submit(event)}>
              <fieldset disabled={controlsDisabled}>
                <legend className="company-sso-legend">Provider details</legend>
                <div className="form-grid">
                  <Field hint="Use a stable ID such as okta or entra." label="Provider ID"><input autoComplete="off" maxLength={64} name="providerId" placeholder="okta" value={form.providerId} onChange={(event) => setForm((current) => ({ ...current, providerId: event.target.value }))} /></Field>
                  <Field hint="Shown to members on the company sign-in screen." label="Display name"><input maxLength={160} name="displayName" placeholder="Okta" value={form.displayName} onChange={(event) => setForm((current) => ({ ...current, displayName: event.target.value }))} /></Field>
                  <Field hint="The server validates the issuer and binds it to this company." label="Issuer / entity ID"><input autoComplete="url" name="issuer" placeholder="https://idp.example.com" value={form.issuer} onChange={(event) => setForm((current) => ({ ...current, issuer: event.target.value }))} /></Field>
                  <Field hint="The server requires HTTPS and an exact provider-specific endpoint." label="Protocol"><select name="protocol" value={form.protocol} onChange={(event) => setForm((current) => ({ ...initialForm, providerId: current.providerId, displayName: current.displayName, issuer: current.issuer, protocol: event.target.value as CompanySsoProtocol }))}><option value="oidc">OIDC</option><option value="saml">SAML</option></select></Field>
                </div>

                {form.protocol === 'oidc' ? (
                  <div className="form-grid company-sso-protocol-fields">
                    <Field hint="Usually https://issuer.example.com/.well-known/openid-configuration." label="Discovery URL"><input autoComplete="url" name="discoveryUrl" placeholder="https://idp.example.com/.well-known/openid-configuration" value={form.discoveryUrl} onChange={(event) => setForm((current) => ({ ...current, discoveryUrl: event.target.value }))} /></Field>
                    <Field hint="Stored by the identity service; never returned to the browser." label="Client ID"><input autoComplete="off" name="clientId" value={form.clientId} onChange={(event) => setForm((current) => ({ ...current, clientId: event.target.value }))} /></Field>
                    <Field hint="Sent once during setup and redacted after save." label="Client secret"><input autoComplete="new-password" name="clientSecret" type="password" value={form.clientSecret} onChange={(event) => setForm((current) => ({ ...current, clientSecret: event.target.value }))} /></Field>
                    <p className="company-sso-help">PKCE and the default openid, profile, and email scopes are enforced by the server.</p>
                  </div>
                ) : (
                  <div className="form-grid company-sso-protocol-fields">
                    <Field hint="HTTPS SSO endpoint from the identity provider metadata." label="SAML entry point"><input autoComplete="url" name="entryPoint" placeholder="https://idp.example.com/sso" value={form.entryPoint} onChange={(event) => setForm((current) => ({ ...current, entryPoint: event.target.value }))} /></Field>
                    <Field hint="Must include a signing X509Certificate. It stays server-side after save." label="IdP metadata XML"><textarea autoComplete="off" name="samlMetadata" placeholder="Paste the IdP metadata XML" rows={6} value={form.samlMetadata} onChange={(event) => setForm((current) => ({ ...current, samlMetadata: event.target.value }))} /></Field>
                    <p className="company-sso-help">Signed assertions are required. The generated callback URL appears in the saved provider details after validation.</p>
                  </div>
                )}

                <div className="form-actions"><Button busy={submitting} disabled={controlsDisabled} type="submit">Add provider</Button></div>
              </fieldset>
            </form>
          </Panel>
        </>
      )}
    </div>
  )
}

function ProviderCard({ provider, busy, disabled, onToggle }: { provider: CompanySsoProviderPublic; busy: boolean; disabled: boolean; onToggle: () => void }) {
  const nextAction = provider.status === 'active' ? 'Disable provider' : 'Enable provider'
  return (
    <article className="company-sso-provider">
      <div className="company-sso-provider-heading">
        <div>
          <span className="eyebrow">Company connection</span>
          <h3>{provider.displayName}</h3>
          <p><code>{provider.providerId}</code><Badge value={provider.protocol} tone="muted" /><Badge value={provider.status} tone={providerStatusTone(provider.status)} /></p>
        </div>
        <Button disabled={disabled} busy={busy} kind="secondary" onClick={onToggle}>{nextAction}</Button>
      </div>
      <dl className="company-sso-provider-meta">
        <div><dt>Issuer</dt><dd><code>{provider.issuer}</code></dd></div>
        <div><dt>Generated callback</dt><dd className="company-sso-callback"><code>{provider.callbackUrl}</code></dd></div>
      </dl>
      <ul className="company-sso-secret-state">
        <li><span aria-hidden="true">{provider.hasClientSecret ? '✓' : '○'}</span>{provider.hasClientSecret ? 'Client secret stored' : 'No client secret stored'}</li>
        <li><span aria-hidden="true">{provider.hasSigningCertificate ? '✓' : '○'}</span>{provider.hasSigningCertificate ? 'Signing certificate stored' : 'No signing certificate stored'}</li>
      </ul>
    </article>
  )
}
