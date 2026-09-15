import type { PlanLimits, PublicPlanMetadata } from '../../../../packages/billing/src/types.js'

const BILLING_PROTOCOL_VERSION = 1
const PLAN_ID = /^[a-z][a-z0-9_-]{0,63}$/u
const MAX_METADATA_BYTES = 256 * 1024
const MAX_PLANS = 32
const LIMIT_FIELDS = ['seats', 'storageBytes', 'scansPerMonth', 'eveCostCentsPerMonth'] as const
const METADATA_FIELDS = ['protocolVersion', 'id', 'label', 'description', 'limits', 'priceConfigured', 'checkoutAvailable'] as const

type MetadataRecord = Record<string, unknown>

function isRecord(value: unknown): value is MetadataRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${field} is invalid`)
  }
  return value.trim()
}

function boundedLimit(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} must be a finite positive integer`)
  return value
}

function exactKeys(value: MetadataRecord, allowed: readonly string[], field: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${field}.${key} is unsupported`)
  }
}

function parseLimits(value: unknown): PlanLimits {
  if (!isRecord(value)) throw new Error('plan limits are required')
  exactKeys(value, LIMIT_FIELDS, 'plan limits')
  const limits = {
    seats: boundedLimit(value.seats, 'plan limit seats'),
    storageBytes: boundedLimit(value.storageBytes, 'plan limit storageBytes'),
    scansPerMonth: boundedLimit(value.scansPerMonth, 'plan limit scansPerMonth'),
    eveCostCentsPerMonth: boundedLimit(value.eveCostCentsPerMonth, 'plan limit eveCostCentsPerMonth'),
  }
  return limits
}

/**
 * Validate the browser-safe shape returned by PlanCatalog.publicMetadata().
 * Price IDs and other server-only fields are intentionally rejected here.
 */
export function normalizePublicPlanMetadata(value: unknown): PublicPlanMetadata {
  if (!isRecord(value)) throw new Error('public plan metadata must be an object')
  exactKeys(value, METADATA_FIELDS, 'public plan metadata')
  if (value.protocolVersion !== BILLING_PROTOCOL_VERSION) throw new Error('public plan metadata protocol version is unsupported')

  const id = boundedText(value.id, 'plan id', 64)
  if (!PLAN_ID.test(id)) throw new Error('plan id must use lowercase letters, digits, underscores, or hyphens')
  const label = boundedText(value.label, 'plan label', 128)
  const description = boundedText(value.description, 'plan description', 4_000)
  if (typeof value.priceConfigured !== 'boolean') throw new Error('plan priceConfigured flag is invalid')
  if (typeof value.checkoutAvailable !== 'boolean') throw new Error('plan checkoutAvailable flag is invalid')
  if (value.checkoutAvailable && (!value.priceConfigured || id === 'free')) throw new Error('plan checkoutAvailable flag contradicts price readiness')

  return {
    protocolVersion: BILLING_PROTOCOL_VERSION,
    id: id as PublicPlanMetadata['id'],
    label,
    description,
    limits: parseLimits(value.limits),
    priceConfigured: value.priceConfigured,
    checkoutAvailable: value.checkoutAvailable,
  }
}

/** Validate a list of public plan metadata and preserve the catalog order. */
export function normalizePublicPlanMetadataList(value: unknown): readonly PublicPlanMetadata[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PLANS) {
    throw new Error(`public plan metadata must contain between 1 and ${MAX_PLANS} plans`)
  }

  const ids = new Set<string>()
  const plans = value.map((candidate) => {
    const plan = normalizePublicPlanMetadata(candidate)
    if (ids.has(plan.id)) throw new Error(`public plan ${plan.id} is duplicated`)
    ids.add(plan.id)
    return plan
  })
  return plans
}

/**
 * Parse a public metadata array or a small `{ protocolVersion, plans }`
 * envelope. The input is intentionally public-only and bounded so a custom
 * app catalog can be projected without bringing server configuration into
 * the marketing bundle.
 */
export function parsePublicPlanMetadataJson(raw: string): readonly PublicPlanMetadata[] {
  const bytes = typeof raw === 'string' ? new TextEncoder().encode(raw).byteLength : 0
  if (typeof raw !== 'string' || raw.trim() === '' || bytes > MAX_METADATA_BYTES) {
    throw new Error(`PUBLIC_PLAN_METADATA_JSON must be a bounded JSON document (at most ${MAX_METADATA_BYTES} bytes)`)
  }

  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    throw new Error('PUBLIC_PLAN_METADATA_JSON must contain valid JSON')
  }

  if (isRecord(decoded) && 'plans' in decoded) {
    exactKeys(decoded, ['protocolVersion', 'plans'], 'public plan metadata envelope')
    if (decoded.protocolVersion !== BILLING_PROTOCOL_VERSION) throw new Error('public plan metadata protocol version is unsupported')
    return normalizePublicPlanMetadataList(decoded.plans)
  }

  return normalizePublicPlanMetadataList(decoded)
}
