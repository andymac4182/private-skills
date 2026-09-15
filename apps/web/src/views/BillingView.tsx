import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../lib/auth'
import { Badge, Button, EmptyState, ErrorState, LoadingState, Notice, Panel } from '../components/Primitives'

type BillingMode = 'disabled' | 'test' | 'live'
type BillingInvoiceStatus = 'draft' | 'open' | 'paid' | 'uncollectible' | 'void' | 'unknown'

interface BillingStatus {
  enabled: boolean
  providerReady: boolean
  usageEnforcement: boolean
  provider: 'stripe' | 'local' | null
  mode: BillingMode
  webhookVerification: boolean
  checkout: boolean
  portal: boolean
}
interface PlanLimits {
  seats: number
  storageBytes: number
  scansPerMonth: number
  eveCostCentsPerMonth: number
}

interface PlanMetadata {
  id: string
  label: string
  description: string
  limits: PlanLimits
  priceConfigured: boolean
  checkoutAvailable: boolean
}

interface BillingEntitlement {
  planId: string
  limits: PlanLimits
  state: 'active' | 'inactive' | 'disabled' | 'unconfigured'
  source: 'verified-webhook' | 'no-subscription' | 'billing-disabled'
  reason: string
  currentPeriodEnd?: string
}

interface BillingUsage {
  seats: number
  storageBytes: number
  scans: number
  eveCostCents: number
}

interface UsageSnapshot {
  limits: PlanLimits
  usage: BillingUsage
  entitlement: BillingEntitlement
}

interface BillingInvoiceView {
  invoiceId: string
  status: BillingInvoiceStatus
  amountDueCents?: number
  amountPaidCents?: number
  currency?: string
  number?: string
  createdAt: string
  paidAt?: string
  hostedInvoiceUrl?: string
  invoicePdfUrl?: string
}

interface BillingInvoiceHistory {
  state: 'available' | 'unavailable' | 'disabled' | 'unconfigured'
  invoices: readonly BillingInvoiceView[]
  message?: string
}

export interface BillingConsoleViewData {
  protocolVersion: 1
  organizationId: string
  status: BillingStatus
  readiness: 'disabled' | 'unconfigured' | 'test' | 'live'
  plans: readonly PlanMetadata[]
  entitlement: BillingEntitlement
  usage: UsageSnapshot
  invoices: BillingInvoiceHistory
  actions: { checkout: boolean; portal: boolean }
}

interface BillingSessionResponse {
  protocolVersion: 1
  session: { provider: 'stripe' | 'local'; mode: Exclude<BillingMode, 'disabled'>; id: string; url: string; expiresAt?: string }
}

export interface BillingViewProps {
  /** Injected in tests or a host shell; production uses the same-origin fetch. */
  fetcher?: typeof fetch
}

function title(value: string): string {
  return value.replaceAll('-', ' ').replace(/\b\w/gu, (character) => character.toUpperCase())
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`
  if (value < 1_024 ** 2) return `${(value / 1_024).toFixed(1)} KB`
  if (value < 1_024 ** 3) return `${(value / 1_024 ** 2).toFixed(1)} MB`
  return `${(value / 1_024 ** 3).toFixed(1)} GB`
}

function formatCents(value: number, currency = 'usd'): string {
  return `${currency.toUpperCase()} ${(value / 100).toFixed(2)}`
}

function formatDate(value: string): string {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' }).format(timestamp) : 'Date unavailable'
}

function sessionUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value)
    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password || (parsed.protocol === 'http:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1')) return undefined
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
    const message = body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string' ? (body as { message: string }).message : 'The billing request failed.'
    throw new Error(message)
  }
  return body as T
}

function readinessLabel(readiness: BillingConsoleViewData['readiness']): string {
  if (readiness === 'disabled') return 'billing disabled'
  if (readiness === 'unconfigured') return 'not configured'
  if (readiness === 'test') return 'test mode'
  return 'live billing'
}

function readinessTone(readiness: BillingConsoleViewData['readiness']): 'good' | 'warn' | 'bad' | 'muted' {
  if (readiness === 'live') return 'good'
  if (readiness === 'test' || readiness === 'unconfigured') return 'warn'
  return 'muted'
}

function usageRows(snapshot: UsageSnapshot): Array<{ label: string; used: number; limit: number; format: (value: number) => string }> {
  return [
    { label: 'Seats', used: snapshot.usage.seats, limit: snapshot.limits.seats, format: (value) => String(value) },
    { label: 'Stored bytes', used: snapshot.usage.storageBytes, limit: snapshot.limits.storageBytes, format: formatBytes },
    { label: 'Scans this month', used: snapshot.usage.scans, limit: snapshot.limits.scansPerMonth, format: (value) => String(value) },
    { label: 'Eve spend this month', used: snapshot.usage.eveCostCents, limit: snapshot.limits.eveCostCentsPerMonth, format: (value) => formatCents(value) },
  ]
}

export function BillingView({ fetcher = fetch }: BillingViewProps) {
  const { principal, session } = useAuth()
  const [data, setData] = useState<BillingConsoleViewData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [selectedPlan, setSelectedPlan] = useState<string>('')
  const [busyAction, setBusyAction] = useState<'checkout' | 'portal' | null>(null)
  const reload = useCallback(async () => {
    setError(null)
    try {
      const next = await fetchJson<BillingConsoleViewData>(fetcher, '/v1/billing')
      setData(next)
      setSelectedPlan((current) => current && next.plans.some((plan) => plan.id === current && plan.checkoutAvailable) ? current : next.plans.find((plan) => plan.checkoutAvailable)?.id ?? '')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load company billing.')
    }
  }, [fetcher])

  useEffect(() => { void reload() }, [reload])

  const activeMembershipRole = session?.activeMembership?.role
  const canManage = principal?.roles.includes('owner') || principal?.roles.includes('admin') || activeMembershipRole === 'owner' || activeMembershipRole === 'admin'
  const selectedPlanMetadata = useMemo(() => data?.plans.find((plan) => plan.id === selectedPlan && plan.checkoutAvailable), [data, selectedPlan])

  async function openSession(path: '/v1/billing/checkout' | '/v1/billing/portal', body: Record<string, string>) {
    setActionError(null)
    setBusyAction(path.endsWith('checkout') ? 'checkout' : 'portal')
    try {
      const result = await fetchJson<BillingSessionResponse>(fetcher, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const url = sessionUrl(result.session.url)
      if (!url) throw new Error('The billing provider returned an unsafe session URL.')
      if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer')
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'The billing action failed.')
    } finally {
      setBusyAction(null)
    }
  }

  if (error) return <div className="view-heading"><div className="page-intro"><div><span className="eyebrow">Company billing</span><h1>Billing &amp; usage</h1><p className="muted">The server could not load billing for this company.</p></div></div><ErrorState message={error} onRetry={() => void reload()} /></div>
  if (!data) return <div className="view-heading"><div className="page-intro"><div><span className="eyebrow">Company billing</span><h1>Billing &amp; usage</h1><p className="muted">Loading your plan, usage, and invoices.</p></div></div><Panel><LoadingState label="Loading company billing…" /></Panel></div>

  const currentPlan = data.plans.find((plan) => plan.id === data.entitlement.planId)
  const rows = usageRows(data.usage)
  const providerlessUsage = data.status.usageEnforcement && !data.status.providerReady
  return <div className="view-heading billing-view">
    <div className="page-intro">
      <div><span className="eyebrow">Company billing</span><h1>Billing &amp; usage</h1><p className="muted">Plan, enforced limits, provider state, and invoices for the active company.</p></div>
      <div className="billing-heading-status"><Badge tone={readinessTone(data.readiness)} value={readinessLabel(data.readiness)} /><span className="muted">{data.status.provider ? `${title(data.status.provider)} · ${title(data.status.mode)}` : 'No provider configured'}</span></div>
    </div>
    {data.readiness === 'disabled' && <Notice kind="warning">Billing is disabled for this deployment. No checkout, portal, or payment action is available.</Notice>}
    {data.readiness === 'unconfigured' && providerlessUsage && <Notice kind="info">Usage limits are enforced from the durable billing ledger. Hosted checkout, subscription management, and invoice history are unavailable until a billing provider is configured.</Notice>}
    {data.readiness === 'unconfigured' && !providerlessUsage && <Notice kind="warning">Billing is not configured for this company yet. Checkout and subscription management stay closed until server Price IDs and provider settings are present.</Notice>}
    {data.readiness === 'test' && <Notice kind="warning">Test mode is active. Provider sessions and webhooks are fixtures or test transactions; this view does not imply a live charge.</Notice>}
    {!canManage && <Notice kind="info">Billing changes require an owner or admin role. The server enforces this role for every billing request.</Notice>}
    {actionError && <Notice kind="error">{actionError}</Notice>}
    <div className="grid-4 billing-summary-stats">
      <Panel className="stat"><span className="stat-label">Current plan</span><span className="stat-value">{currentPlan?.label ?? title(data.entitlement.planId)}</span><span className="stat-note">{title(data.entitlement.state)} · {title(data.entitlement.reason)}</span></Panel>
      <Panel className="stat"><span className="stat-label">Seats</span><span className="stat-value">{data.usage.usage.seats} / {data.usage.limits.seats}</span><span className="stat-note">Enforced active-member allowance</span></Panel>
      <Panel className="stat"><span className="stat-label">Scans</span><span className="stat-value">{data.usage.usage.scans} / {data.usage.limits.scansPerMonth}</span><span className="stat-note">UTC billing period</span></Panel>
      <Panel className="stat"><span className="stat-label">Eve budget</span><span className="stat-value">{formatCents(data.usage.usage.eveCostCents)} / {formatCents(data.usage.limits.eveCostCentsPerMonth)}</span><span className="stat-note">Integer cents, enforced server-side</span></Panel>
    </div>
    <div className="billing-console-grid">
      <Panel title="Current plan" description="Entitlement comes from verified provider state and the server plan catalog.">
        <div className="billing-plan-summary"><div><strong>{currentPlan?.label ?? title(data.entitlement.planId)}</strong><span className="cell-sub">{title(data.entitlement.state)} · {title(data.entitlement.reason)}</span>{data.entitlement.currentPeriodEnd && <span className="cell-sub">Period ends {formatDate(data.entitlement.currentPeriodEnd)}</span>}</div><Badge value={data.entitlement.state} tone={data.entitlement.state === 'active' ? 'good' : data.entitlement.state === 'unconfigured' ? 'warn' : 'muted'} /></div>
        <div className="billing-actions"><label className="field"><span className="field-label">Choose a configured plan</span><select disabled={!canManage || !data.actions.checkout || busyAction !== null} onChange={(event) => setSelectedPlan(event.target.value)} value={selectedPlan}><option value="">No paid plan available</option>{data.plans.filter((plan) => plan.checkoutAvailable).map((plan) => <option key={plan.id} value={plan.id}>{plan.label}</option>)}</select></label><Button busy={busyAction === 'checkout'} disabled={!canManage || !data.actions.checkout || !selectedPlanMetadata} onClick={() => void openSession('/v1/billing/checkout', { planId: selectedPlanMetadata?.id ?? '' })}>Start checkout</Button><Button kind="secondary" busy={busyAction === 'portal'} disabled={!canManage || !data.actions.portal} onClick={() => void openSession('/v1/billing/portal', {})}>Manage subscription</Button></div>
      </Panel>
      <Panel title="Billing readiness" description="Deployment state is explicit so a local fixture cannot look like live payment." action={<Badge value={data.status.webhookVerification ? 'webhooks verified' : 'webhooks unavailable'} tone={data.status.webhookVerification ? 'good' : 'warn'} />}>
        <dl className="billing-readiness-list"><div><dt>Provider</dt><dd>{data.status.provider ? title(data.status.provider) : 'None'}</dd></div><div><dt>Mode</dt><dd>{title(data.status.mode)}</dd></div><div><dt>Checkout</dt><dd>{data.actions.checkout ? 'Available' : 'Unavailable'}</dd></div><div><dt>Subscription management</dt><dd>{data.actions.portal ? 'Available' : 'Unavailable'}</dd></div><div><dt>Organization</dt><dd><code>{data.organizationId}</code></dd></div></dl>
      </Panel>
    </div>
    <Panel title="Usage and limits" description="Measured usage is checked transactionally before storage, scans, and Eve work consume allowance.">
      <div className="table-wrap"><table><thead><tr><th>Resource</th><th>Used</th><th>Limit</th><th>Progress</th></tr></thead><tbody>{rows.map((row) => <tr key={row.label}><td><strong>{row.label}</strong></td><td>{row.format(row.used)}</td><td>{row.format(row.limit)}</td><td><progress aria-label={`${row.label} usage`} max={row.limit} value={Math.min(row.used, row.limit)} /> <span className="cell-sub">{row.limit > 0 ? Math.round((row.used / row.limit) * 100) : 100}%</span></td></tr>)}</tbody></table></div>
    </Panel>
    <Panel title="Invoice history" description="Showing up to the most recent 100 invoices for your company.">
      {data.invoices.state === 'available' ? data.invoices.invoices.length === 0 ? <EmptyState title="No invoices yet" description="Your company has no invoices yet." /> : <div className="table-wrap"><table><thead><tr><th>Invoice</th><th>Status</th><th>Amount</th><th>Created</th><th>Document</th></tr></thead><tbody>{data.invoices.invoices.map((invoice) => <tr key={invoice.invoiceId}><td><strong>{invoice.number ?? invoice.invoiceId}</strong></td><td><Badge value={invoice.status} tone={invoice.status === 'paid' ? 'good' : invoice.status === 'open' ? 'warn' : 'muted'} /></td><td>{invoice.amountPaidCents !== undefined ? formatCents(invoice.amountPaidCents, invoice.currency) : invoice.amountDueCents !== undefined ? formatCents(invoice.amountDueCents, invoice.currency) : 'Amount unavailable'}</td><td>{formatDate(invoice.createdAt)}</td><td>{invoice.hostedInvoiceUrl ? <a href={sessionUrl(invoice.hostedInvoiceUrl)} rel="noreferrer" target="_blank">Open invoice</a> : invoice.invoicePdfUrl ? <a href={sessionUrl(invoice.invoicePdfUrl)} rel="noreferrer" target="_blank">PDF</a> : <span className="muted">Unavailable</span>}</td></tr>)}</tbody></table></div> : <Notice kind="info">{data.invoices.message ?? 'Invoice history is unavailable for this billing deployment.'}</Notice>}
    </Panel>
  </div>
}
