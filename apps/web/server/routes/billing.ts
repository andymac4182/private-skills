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
  BillingSeatRecoveryResult,
  BillingSeatReservation,
  BillingSeatRecoveryProof,
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
  seatReservations: '/v1/billing/seat-reservations',
  seatRecovery: '/v1/billing/seat-recovery',
  checkout: '/v1/billing/checkout',
  portal: '/v1/billing/portal',
  webhook: '/v1/billing/webhook',
})

/** Capability carried only by the separately provisioned recovery operator credential. */
export const BILLING_SEAT_RECOVERY_SCOPE = 'billing:seat-recovery' as const

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

/**
 * A platform-only capability for repairing a Better Auth write that failed
 * after its before hook. This is intentionally separate from
 * `BillingRoutesOptions`: owner/admin company principals must never receive a
 * recovery callback or be able to self-attest a failed identity write.
 */
export interface BillingSeatRecoveryRoutesOptions {
  /** Authenticator for a server-owned worker/operator credential. */
  authorizeOperator: Authenticator['authenticate']
  listReservations: (organizationId: string) => Promise<readonly BillingSeatReservation[]>
  recoverSeat: (input: {
    organizationId: string
    operationKey: string
    subjectKind: 'member' | 'invitation'
    subjectId: string
    proof: BillingSeatRecoveryProof
  }) => Promise<BillingSeatRecoveryResult>
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
  if (!status.providerReady) return { state: 'unconfigured', invoices: [], message: 'Usage limits remain available; invoice history is unavailable until hosted billing is configured.' }
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
    // Seat hold inspection/recovery is deliberately not part of the
    // owner/admin company surface. A tenant must not be able to release a
    // hold by posting a self-attested failure proof.
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

/**
 * Build the platform/operator recovery endpoint separately from the company
 * billing console. The operator authenticator returns the target organization
 * from a server-owned credential; the request body cannot select a tenant.
 * The callback must perform the authoritative identity-row check while the
 * Better Auth organization mutation fence is held.
 */
export function createBillingSeatRecoveryRoutes(options: BillingSeatRecoveryRoutesOptions): BillingRoutes {
  if (typeof options.authorizeOperator !== 'function') throw new Error('billing recovery operator authenticator is required')
  if (typeof options.listReservations !== 'function') throw new Error('billing recovery listing callback is required')
  if (typeof options.recoverSeat !== 'function') throw new Error('billing recovery callback is required')
  const maxBodyBytes = validBodyLimit(options.maxBodyBytes)

  return async (request: Request): Promise<Response | undefined> => {
    const path = safePath(request)
    if (path !== BILLING_ROUTE_PATHS.seatReservations && path !== BILLING_ROUTE_PATHS.seatRecovery) return undefined
    try {
      let operator: Principal | null
      try {
        operator = await options.authorizeOperator(request)
      } catch {
        throw new BillingRouteError('BILLING_AUTH_UNAVAILABLE', 'Billing recovery authorization is temporarily unavailable.', 503, true)
      }
      const operatorRecord = operator as (Principal & { identity?: unknown; scopes?: unknown }) | null
      if (!operatorRecord || !Array.isArray(operatorRecord.roles) || !operatorRecord.roles.includes('worker') || operatorRecord.identity !== 'worker' || !Array.isArray(operatorRecord.scopes) || !operatorRecord.scopes.includes(BILLING_SEAT_RECOVERY_SCOPE) || typeof operatorRecord.organizationId !== 'string' || operatorRecord.organizationId.trim() === '') {
        throw new BillingRouteError('BILLING_FORBIDDEN', 'Platform operator access is required for seat recovery.', 403)
      }
      const organizationId = operatorRecord.organizationId.trim()
      if (path === BILLING_ROUTE_PATHS.seatReservations) {
        if (method(request) !== 'GET') throw new BillingRouteError('METHOD_NOT_ALLOWED', 'Seat reservations only accept GET.', 405)
        return Response.json({
          protocolVersion: BILLING_PROTOCOL_VERSION,
          reservations: await options.listReservations(organizationId),
        }, { headers: { 'cache-control': 'no-store' } })
      }
      if (method(request) !== 'POST') throw new BillingRouteError('METHOD_NOT_ALLOWED', 'Seat recovery only accepts POST.', 405)
      const body = await readJsonBody(request, maxBodyBytes)
      const operationKey = optionalString(body.operationKey, 'operationKey', 256)
      const subjectId = optionalString(body.subjectId, 'subjectId', 256)
      const subjectKind = optionalString(body.subjectKind, 'subjectKind', 32)
      if (!operationKey || !subjectId || (subjectKind !== 'member' && subjectKind !== 'invitation')) {
        throw new BillingRouteError('INVALID_REQUEST', 'operationKey, subjectKind, and subjectId are required.', 400)
      }
      const rawProof = body.proof
      if (!rawProof || typeof rawProof !== 'object' || Array.isArray(rawProof)) throw new BillingRouteError('INVALID_REQUEST', 'proof is required.', 400)
      const proof = rawProof as Partial<BillingSeatRecoveryProof>
      // A failed Better Auth writer can only be recovered by the platform
      // writer-fencing path. There is no tenant-visible known-failure mode.
      if (proof.kind !== 'writer-terminated') throw new BillingRouteError('INVALID_REQUEST', 'proof.kind must be writer-terminated.', 400)
      const reference = optionalString(proof.reference, 'proof.reference', 256)
      if (!reference) throw new BillingRouteError('INVALID_REQUEST', 'proof.reference is required.', 400)
      const recovery = await options.recoverSeat({
        organizationId,
        operationKey,
        subjectKind,
        subjectId,
        proof: { kind: 'writer-terminated', reference },
      })
      return Response.json({ protocolVersion: BILLING_PROTOCOL_VERSION, recovery }, { headers: { 'cache-control': 'no-store' } })
    } catch (error) {
      return routeErrorResponse(error)
    }
  }
}
