import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { ApiError } from '../lib/api'
import { useAuth } from '../lib/auth'
import { clearTenantScopedClientState } from '../lib/tenant'
import { Notice } from './Primitives'

export function CompanySwitcher() {
  const navigate = useNavigate()
  const { session, switchOrganization } = useAuth()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const memberships = session?.organizations ?? []
  if (!session || memberships.length === 0) return null
  const activeId = session.activeOrganizationId ?? ''
  const choose = async (organizationId: string) => {
    if (!organizationId || organizationId === activeId || busy) return
    setBusy(true); setError(null)
    try {
      clearTenantScopedClientState()
      await switchOrganization(organizationId)
      // Drop any draft/skill/version query owned by the previous company.
      await navigate({ to: '/app', search: {}, replace: true })
    } catch (cause) { setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not switch companies.') }
    finally { setBusy(false) }
  }
  return <div className="company-switcher"><label htmlFor="company-switcher-select"><span className="company-switcher-label">Company</span><select aria-busy={busy} aria-label="Company" disabled={busy} id="company-switcher-select" value={activeId} onChange={(event) => void choose(event.target.value)}><option disabled value="">Choose a company</option>{memberships.map((membership) => <option key={membership.organization.id} value={membership.organization.id}>{membership.organization.name}</option>)}</select></label>{error && <Notice kind="error">{error}</Notice>}</div>
}
