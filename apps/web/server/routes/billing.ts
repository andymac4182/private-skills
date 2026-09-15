import type { Authenticator, Principal } from '../../../../packages/contracts/src/index.js'
import {
  BillingError,
  BillingService,
  createBillingWebhookHandler,
} from '../../../../packages/billing/src/index.js'
import type {
  BillingEntitlement,
  BillingMode,
  BillingProviderId,
  BillingStatus,
  HostedBillingSession,
  PlanId,
  PlanLimits,
  PublicPlanMetadata,
  UsageSnapshot,
} from '../../../../packages/billing/src/index.js'

/** The host-neutral paths owned by this factory. The parent runtime can mount the factory before registry routing. */
export const BILLING_ROUTE_PATHS = Object.freeze({
  root: '/v1/billing',
  invoices: '/v1/billing/invoices',
  checkout: '/v1/billing/checkout',
  portal: '/v1/billing/portal',
  webhook: '/v1/billing/webhook',
})

const BILLING_PROTOCOL_VERSION = 1 as const
const BILLING_ROLES = new Set(['owner', 'admin'])
const MAX_BILLING_BODY_BYTES = 16 * 1024
const MAX_INVOICES = 100
const INVOICE_STATUSES = new Set<BillingInvoiceStatus>(['draft', 'open', 'paid', 'uncollectible', 'void', 'unknown'])

export type BillingInvoiceAvailability = 'available' | 'unavailable' | 'disabled' | 'unconfigured'
export type BillingInvoiceStatus = 'draft' | 'open' | 'paid' | 'uncollectible' | 'void' | 'unknown'

/** Provider data is accepted only from a server-side, tenant-bound adapter. */
export interface BillingInvoiceRecord {
  provider: BillingProviderId
  invoiceId: string
  customerId: string
  organizationId?: string
  status: BillingInvoiceStatus
  amountDueCents?: number
  amountPaidCents?: number
  currency?: string
  number?: string
  createdAt: string
  paidAt?: string
  periodStart?: string
  periodEnd?: string
  hostedInvoiceUrl?: string
  invoicePdfUrl?: string
}

/** Browser-safe invoice projection; provider/customer identifiers stay server-side. */
export interface BillingInvoiceView {
  invoiceId: string
  status: BillingInvoiceStatus
  amountDueCents?: number
  amountPaidCents?: number
  currency?: string
  number?: string
  createdAt: string
  paidAt?: string
  periodStart?: string
  periodEnd?: string
  hostedInvoiceUrl?: string
  invoicePdfUrl?: string
}

export interface BillingInvoiceHistory {
  state: BillingInvoiceAvailability
  invoices: readonly BillingInvoiceView[]
  message?: string
}

export interface BillingConsoleResponse {
  protocolVersion: typeof BILLING_PROTOCOL_VERSION
  organizationId: string
  status: BillingStatus
  readiness: 'disabled' | 'unconfigured' | 'test' | 'live'
  plans: readonly PublicPlanMetadata[]
  entitlement: BillingEntitlement
  usage: UsageSnapshot
  invoices: BillingInvoiceHistory
  actions: {
    checkout: boolean
    portal: boolean
  }
}

export interface BillingSessionResponse {
  protocolVersion: typeof BILLING_PROTOCOL_VERSION
  session: HostedBillingSession
}

export interface BillingInvoiceLookup {
  organizationId: string
  provider: BillingProviderId
  mode: Exclude<BillingMode, 'disabled'>
  customerId: string
}

export interface BillingRoutesOptions {
  service: BillingService
  /** The runtime's request-local authenticator; it must verify membership and roles. */
  authenticate: Authenticator['authenticate']
  /**
   * Optional provider invoice read model. The callback receives only the
   * organization and customer mapping read from the service's state; browser
   * request fields are never forwarded. Results are checked again here.
   */
  invoiceHistory?: (input: BillingInvoiceLookup) => Promise<readonly BillingInvoiceRecord[]>
  maxBodyBytes?: number
}

export interface BillingRoutes {
  (request: Request): Promise<Response | undefined>
}

export class BillingRouteError extends Error {
  readonly code: string
  readonly status: number
  readonly retryable: boolean

  constructor(code: string, message: string, status = 400, retryable = false) {
    super(message)
    this.name = 'BillingRouteError'
    this.code = code
    this.status = status
    this.retryable = retryable
  }
}

function routeErrorResponse(error: unknown): Response {
  if (error instanceof BillingRouteError) {
    return Response.json({ code: error.code, message: error.message, retryable: error.retryable }, {
      status: error.status,
      headers: { 'cache-control': 'no-store' },
    })
  }
  if (error instanceof BillingError) {
    return Response.json({ code: error.code, message: error.message, retryable: error.retryable }, {
      status: error.status,
      headers: { 'cache-control': 'no-store' },
    })
  }
  return Response.json({ code: 'BILLING_UNAVAILABLE', message: 'Billing is temporarily unavailable.', retryable: true }, {
    status: 503,
    headers: { 'cache-control': 'no-store' },
  })
}

function safePath(request: Request): string {
  try {
    return new URL(request.url).pathname.replace(/\/+$/u, '') || '/'
  } catch {
    return ''
  }
}

function method(request: Request): string {
  return request.method.toUpperCase()
}

async function billingPrincipal(options: BillingRoutesOptions, request: Request): Promise<Principal> {
  let principal: Principal | null
  try {
    principal = await options.authenticate(request)
  } catch {
    throw new BillingRouteError('BILLING_AUTH_UNAVAILABLE', 'Billing authorization is temporarily unavailable.', 503, true)
  }
  if (!principal) throw new BillingRouteError('UNAUTHENTICATED', 'Authentication is required.', 401)
  if (typeof principal.organizationId !== 'string' || principal.organizationId.trim() === '' || typeof principal.subject !== 'string' || principal.subject.trim() === '') {
    throw new BillingRouteError('TENANT_FORBIDDEN', 'The authenticated company is not available.', 403)
  }
  if (!Array.isArray(principal.roles) || !principal.roles.some((role) => BILLING_ROLES.has(role))) {
    throw new BillingRouteError('BILLING_FORBIDDEN', 'Owner or admin access is required for company billing.', 403)
  }
  return principal
}

function readiness(status: BillingStatus): BillingConsoleResponse['readiness'] {
  if (!status.enabled) return 'disabled'
  // Hosted actions without a verified webhook would accept money without a
  // signed entitlement update. Keep the console visibly unconfigured until
  // both sides of the provider boundary are ready.
  if (!status.webhookVerification || (!status.checkout && !status.portal)) return 'unconfigured'
  return status.mode === 'test' ? 'test' : 'live'
}

function validBodyLimit(value: number | undefined): number {
  if (value === undefined) return MAX_BILLING_BODY_BYTES
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_BILLING_BODY_BYTES) throw new BillingRouteError('INVALID_CONFIGURATION', 'Billing request body limit is invalid.', 500)
  return value
}

async function readJsonBody(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  let bytes: ArrayBuffer
  try {
    bytes = await request.arrayBuffer()
  } catch {
    throw new BillingRouteError('INVALID_REQUEST', 'Billing request could not be read.', 400)
  }
  if (bytes.byteLength > maxBytes) throw new BillingRouteError('PAYLOAD_TOO_LARGE', 'Billing request is too large.', 413)
  let decoded: string
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new BillingRouteError('INVALID_REQUEST', 'Billing request is not valid UTF-8.', 400)
  }
  if (decoded.trim() === '') return {}
  let value: unknown
  try {
    value = JSON.parse(decoded)
  } catch {
    throw new BillingRouteError('INVALID_REQUEST', 'Billing request JSON is invalid.', 400)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BillingRouteError('INVALID_REQUEST', 'Billing request must be a JSON object.', 400)
  return value as Record<string, unknown>
}

function optionalString(value: unknown, field: string, max = 256): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '' || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new BillingRouteError('INVALID_REQUEST', `${field} is invalid.`, 400)
  return value.trim()
}

function invoiceText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new BillingRouteError('INVOICE_PROVIDER_ERROR', `Invoice ${field} is invalid.`, 502, true)
  return value.trim()
}

function invoiceDate(value: unknown, field: string): string {
  const text = invoiceText(value, field, 128)
  const time = Date.parse(text)
  if (!Number.isFinite(time)) throw new BillingRouteError('INVOICE_PROVIDER_ERROR', `Invoice ${field} is invalid.`, 502, true)
  return new Date(time).toISOString()
}

function invoiceAmount(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new BillingRouteError('INVOICE_PROVIDER_ERROR', `Invoice ${field} is invalid.`, 502, true)
  return value as number
}

function invoiceUrl(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  const text = invoiceText(value, field, 4_096)
  let parsed: URL
  try { parsed = new URL(text) } catch { throw new BillingRouteError('INVOICE_PROVIDER_ERROR', `Invoice ${field} is invalid.`, 502, true) }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password || (parsed.protocol === 'http:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1')) throw new BillingRouteError('INVOICE_PROVIDER_ERROR', `Invoice ${field} is invalid.`, 502, true)
  return parsed.toString()
}

function projectInvoices(records: readonly BillingInvoiceRecord[], lookup: BillingInvoiceLookup): readonly BillingInvoiceView[] {
  if (!Array.isArray(records) || records.length > MAX_INVOICES) throw new BillingRouteError('INVOICE_PROVIDER_ERROR', 'Invoice history is invalid.', 502, true)
  const ids = new Set<string>()
  return records.map((record) => {
    if (!record || typeof record !== 'object' || record.provider !== lookup.provider || record.customerId !== lookup.customerId || (record.organizationId !== undefined && record.organizationId !== lookup.organizationId)) {
      throw new BillingRouteError('INVOICE_MAPPING_CONFLICT', 'Invoice history does not match the authenticated company customer.', 409)
    }
    const invoiceId = invoiceText(record.invoiceId, 'id', 256)
    if (ids.has(invoiceId)) throw new BillingRouteError('INVOICE_PROVIDER_ERROR', 'Invoice history contains a duplicate invoice.', 502, true)
    ids.add(invoiceId)
    if (!INVOICE_STATUSES.has(record.status)) throw new BillingRouteError('INVOICE_PROVIDER_ERROR', 'Invoice status is invalid.', 502, true)
    const currency = record.currency === undefined ? undefined : invoiceText(record.currency, 'currency', 3).toLowerCase()
    if (currency !== undefined && !/^[a-z]{3}$/u.test(currency)) throw new BillingRouteError('INVOICE_PROVIDER_ERROR', 'Invoice currency is invalid.', 502, true)
    const number = record.number === undefined ? undefined : invoiceText(record.number, 'number', 128)
    const amountDueCents = invoiceAmount(record.amountDueCents, 'amountDueCents')
    const amountPaidCents = invoiceAmount(record.amountPaidCents, 'amountPaidCents')
    const paidAt = record.paidAt === undefined ? undefined : invoiceDate(record.paidAt, 'paidAt')
    const periodStart = record.periodStart === undefined ? undefined : invoiceDate(record.periodStart, 'periodStart')
    const periodEnd = record.periodEnd === undefined ? undefined : invoiceDate(record.periodEnd, 'periodEnd')
    if (periodStart !== undefined && periodEnd !== undefined && Date.parse(periodEnd) <= Date.parse(periodStart)) throw new BillingRouteError('INVOICE_PROVIDER_ERROR', 'Invoice period is invalid.', 502, true)
    const hostedInvoiceUrl = invoiceUrl(record.hostedInvoiceUrl, 'hostedInvoiceUrl')
    const invoicePdfUrl = invoiceUrl(record.invoicePdfUrl, 'invoicePdfUrl')
    return {
      invoiceId,
      status: record.status,
      ...(amountDueCents === undefined ? {} : { amountDueCents }),
      ...(amountPaidCents === undefined ? {} : { amountPaidCents }),
      ...(currency === undefined ? {} : { currency }),
      ...(number === undefined ? {} : { number }),
      createdAt: invoiceDate(record.createdAt, 'createdAt'),
      ...(paidAt === undefined ? {} : { paidAt }),
      ...(periodStart === undefined ? {} : { periodStart }),
      ...(periodEnd === undefined ? {} : { periodEnd }),
      ...(hostedInvoiceUrl === undefined ? {} : { hostedInvoiceUrl }),
      ...(invoicePdfUrl === undefined ? {} : { invoicePdfUrl }),
    }
  }).sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
}

async function invoicesFor(
  options: BillingRoutesOptions,
  organizationId: string,
  status: BillingStatus,
  entitlement: BillingEntitlement,
): Promise<BillingInvoiceHistory> {
  if (!status.enabled || status.mode === 'disabled') return { state: 'disabled', invoices: [], message: 'Billing is disabled for this deployment.' }
  if (!status.checkout && !status.portal) return { state: 'unconfigured', invoices: [], message: 'Invoice history is unavailable until hosted billing is configured.' }
  const customerId = entitlement.customerId
  const provider = entitlement.provider ?? status.provider
  if (!customerId || !provider || (status.mode !== 'test' && status.mode !== 'live')) return { state: 'unavailable', invoices: [], message: 'No provider customer is mapped to this company yet.' }
  if (!options.invoiceHistory) return { state: 'unavailable', invoices: [], message: 'Invoice history is not connected for this billing deployment.' }
  const lookup: BillingInvoiceLookup = { organizationId, provider, mode: status.mode, customerId }
  try {
    const records = await options.invoiceHistory(lookup)
    return { state: 'available', invoices: projectInvoices(records, lookup) }
  } catch (error) {
    if (error instanceof BillingRouteError) throw error
    return { state: 'unavailable', invoices: [], message: 'Invoice history is temporarily unavailable.' }
  }
}

async function consoleResponse(options: BillingRoutesOptions, principal: Principal): Promise<BillingConsoleResponse> {
  const organizationId = principal.organizationId.trim()
  const status = options.service.status()
  const [entitlement, usage] = await Promise.all([
    options.service.entitlement(organizationId),
    options.service.usageSnapshot(organizationId),
  ])
  const invoices = await invoicesFor(options, organizationId, status, entitlement)
  return {
    protocolVersion: BILLING_PROTOCOL_VERSION,
    organizationId,
    status,
    readiness: readiness(status),
    plans: options.service.publicPlans(),
    entitlement,
    usage,
    invoices,
    actions: { checkout: status.checkout && status.webhookVerification, portal: status.portal && status.webhookVerification },
  }
}

/**
 * Build the company billing API without modifying the shared registry router.
 * Return `undefined` for unrelated paths so the runtime can delegate them.
 */
export function createBillingRoutes(options: BillingRoutesOptions): BillingRoutes {
  if (!options.service || typeof options.service.status !== 'function') throw new Error('billing service is required')
  if (typeof options.authenticate !== 'function') throw new Error('billing authenticator is required')
  const maxBodyBytes = validBodyLimit(options.maxBodyBytes)
  const webhook = createBillingWebhookHandler(options.service, { path: BILLING_ROUTE_PATHS.webhook })

  return async (request: Request): Promise<Response | undefined> => {
    const path = safePath(request)
    if (path === BILLING_ROUTE_PATHS.webhook || path.startsWith(`${BILLING_ROUTE_PATHS.webhook}/`)) return webhook(request)
    if (path !== BILLING_ROUTE_PATHS.root && path !== BILLING_ROUTE_PATHS.invoices && path !== BILLING_ROUTE_PATHS.checkout && path !== BILLING_ROUTE_PATHS.portal) return undefined
    try {
      const principal = await billingPrincipal(options, request)
      const organizationId = principal.organizationId.trim()
      if (path === BILLING_ROUTE_PATHS.root) {
        if (method(request) !== 'GET') throw new BillingRouteError('METHOD_NOT_ALLOWED', 'Billing summary only accepts GET.', 405)
        return Response.json(await consoleResponse(options, principal), { headers: { 'cache-control': 'no-store' } })
      }
      if (path === BILLING_ROUTE_PATHS.invoices) {
        if (method(request) !== 'GET') throw new BillingRouteError('METHOD_NOT_ALLOWED', 'Invoice history only accepts GET.', 405)
        const status = options.service.status()
        const entitlement = await options.service.entitlement(organizationId)
        return Response.json({ protocolVersion: BILLING_PROTOCOL_VERSION, invoices: await invoicesFor(options, organizationId, status, entitlement) }, { headers: { 'cache-control': 'no-store' } })
      }
      if (method(request) !== 'POST') throw new BillingRouteError('METHOD_NOT_ALLOWED', 'Billing actions only accept POST.', 405)
      const body = await readJsonBody(request, maxBodyBytes)
      const idempotencyKey = optionalString(body.idempotencyKey, 'idempotencyKey', 256)
      const status = options.service.status()
      if (path === BILLING_ROUTE_PATHS.checkout) {
        if (!status.checkout || !status.webhookVerification) throw new BillingRouteError('BILLING_UNAVAILABLE', 'Hosted checkout is not configured for this deployment.', 503, true)
        const planId = optionalString(body.planId, 'planId', 64) as PlanId | undefined
        if (!planId) throw new BillingRouteError('INVALID_REQUEST', 'planId is required.', 400)
        const session = await options.service.checkout({ organizationId, subject: principal.subject, planId, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) })
        return Response.json({ protocolVersion: BILLING_PROTOCOL_VERSION, session } satisfies BillingSessionResponse, { headers: { 'cache-control': 'no-store' } })
      }
      if (!status.portal || !status.webhookVerification) throw new BillingRouteError('BILLING_UNAVAILABLE', 'Hosted subscription management is not configured for this deployment.', 503, true)
      const session = await options.service.portal({ organizationId, subject: principal.subject, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) })
      return Response.json({ protocolVersion: BILLING_PROTOCOL_VERSION, session } satisfies BillingSessionResponse, { headers: { 'cache-control': 'no-store' } })
    } catch (error) {
      return routeErrorResponse(error)
    }
  }
}
