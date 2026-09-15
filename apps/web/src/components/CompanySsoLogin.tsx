import { useRef, useState } from 'react'
import { safeLoginReturnTo } from '../lib/auth'
import {
  companySsoErrorMessage,
  isCompanySsoUnavailableError,
  listCompanySsoLoginProviders,
  startCompanySsoLogin,
  type CompanySsoLoginProvider,
} from '../lib/companySso'
import { Button, Field, Notice } from './Primitives'

export interface CompanySsoLoginProps {
  /** A validated app or invitation path carried through the sign-in flow. */
  returnTo?: string
  /** Optional initial company id when a trusted caller already knows it. */
  initialOrganizationId?: string
  /** Injectable redirect for deterministic tests and embedded callers. */
  redirect?: (url: string) => void
}

const redirectToWindow = (url: string): void => {
  window.location.assign(url)
}

/**
 * Explicit company SSO discovery. The user supplies a company identifier,
 * then chooses a provider returned by that company's server-owned registry.
 * There is intentionally no email-domain inference in this component.
 */
export function CompanySsoLogin({ returnTo, initialOrganizationId = '', redirect = redirectToWindow }: CompanySsoLoginProps) {
  const [organizationId, setOrganizationId] = useState(initialOrganizationId)
  const [providers, setProviders] = useState<CompanySsoLoginProvider[] | null>(null)
  const [resolvedOrganizationId, setResolvedOrganizationId] = useState<string | null>(null)
  const [lookupBusy, setLookupBusy] = useState(false)
  const [providerBusy, setProviderBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const discoveryGeneration = useRef(0)

  const handleOrganizationChange = (value: string): void => {
    discoveryGeneration.current += 1
    setOrganizationId(value)
    setProviders(null)
    setResolvedOrganizationId(null)
    setLookupBusy(false)
    setProviderBusy(null)
    setError(null)
  }

  async function discover(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const normalized = organizationId.trim()
    const generation = ++discoveryGeneration.current
    if (!normalized) {
      setProviders(null)
      setResolvedOrganizationId(null)
      setError('Enter the company identifier provided by your administrator.')
      return
    }
    setLookupBusy(true)
    setError(null)
    try {
      const result = await listCompanySsoLoginProviders(normalized)
      if (generation !== discoveryGeneration.current) return
      const resolved = result.organizationId.trim()
      setOrganizationId(result.organizationId)
      setResolvedOrganizationId(resolved)
      setProviders([...result.providers])
    } catch (cause) {
      if (generation !== discoveryGeneration.current) return
      setProviders(null)
      setResolvedOrganizationId(null)
      setError(isCompanySsoUnavailableError(cause)
        ? 'Company sign-in is unavailable on this registry.'
        : companySsoErrorMessage(cause, 'Could not find company sign-in providers.'))
    } finally {
      if (generation === discoveryGeneration.current) setLookupBusy(false)
    }
  }

  async function choose(provider: CompanySsoLoginProvider) {
    if (providerBusy !== null) return
    const normalized = organizationId.trim()
    const resolved = resolvedOrganizationId?.trim()
    if (!resolved || resolved !== normalized) {
      setError('Enter the company identifier provided by your administrator.')
      return
    }
    const generation = discoveryGeneration.current
    setProviderBusy(provider.providerId)
    setError(null)
    try {
      const callbackURL = safeLoginReturnTo(returnTo) ?? '/app'
      const result = await startCompanySsoLogin(resolved, provider.providerId, callbackURL)
      if (generation !== discoveryGeneration.current) return
      if (!result.redirect || typeof result.url !== 'string' || result.url.length === 0) {
        throw new Error('The company identity provider did not return a sign-in URL.')
      }
      redirect(result.url)
    } catch (cause) {
      setError(companySsoErrorMessage(cause, `Could not continue with ${provider.displayName}.`))
    } finally {
      setProviderBusy(null)
    }
  }

  return <section aria-labelledby="company-sso-login-heading" className="company-sso-login">
    <div className="company-sso-login-heading">
      <span className="eyebrow">Company sign-in</span>
      <h2 id="company-sso-login-heading">Find your company provider</h2>
      <p className="muted">Enter the company identifier supplied by your administrator, then choose its configured identity provider.</p>
    </div>
    <form className="company-sso-discovery-form" onSubmit={(event) => void discover(event)}>
      <Field hint="Ask your administrator for your company identifier." label="Company identifier">
        <input autoComplete="organization" name="companySsoOrganizationId" onChange={(event) => handleOrganizationChange(event.target.value)} placeholder="acme" value={organizationId} />
      </Field>
      <Button busy={lookupBusy} kind="secondary" type="submit">Find providers</Button>
    </form>
    {error && <Notice kind="error">{error}</Notice>}
    {resolvedOrganizationId === organizationId.trim() && providers !== null && providers.length === 0 && <Notice kind="info">No active company identity providers are configured.</Notice>}
    {resolvedOrganizationId === organizationId.trim() && providers !== null && providers.length > 0 && <div aria-label="Company identity providers" className="company-sso-provider-list">
      {providers.map((provider) => <Button
        aria-label={`Continue with ${provider.displayName}`}
        busy={providerBusy === provider.providerId}
        className="company-sso-provider-option"
        disabled={providerBusy !== null && providerBusy !== provider.providerId}
        key={provider.providerId}
        onClick={() => void choose(provider)}
        type="button"
      >
        Continue with {provider.displayName} <small>{provider.protocol === 'oidc' ? 'OIDC' : 'SAML'}</small>
      </Button>)}
    </div>}
  </section>
}
