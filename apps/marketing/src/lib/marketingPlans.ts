import { DEFAULT_PUBLIC_PLAN_METADATA } from '../../../../packages/billing/src/public-plans.js'
import type { PlanLimits, PublicPlanMetadata } from '../../../../packages/billing/src/types.js'
import { normalizePublicPlanMetadataList, parsePublicPlanMetadataJson } from './marketingPlanMetadata'

export interface MarketingPlan {
  id: string
  name: string
  kicker: string
  audience: string
  price: string
  cadence: string
  description: string
  features: string[]
  limits: PlanLimits
  priceConfigured: boolean
  checkoutAvailable: boolean
  cta: string
  href: string
  featured?: boolean
}

export type MarketingPlanSource = 'shared-default' | 'build-configured'

/**
 * Keep the launch page useful while the commercial packaging decision is open.
 * The public page intentionally shows shared plan metadata and finite limits
 * without publishing prices or opening a purchase flow.
 */
export const pricingStatus = 'Pricing preview'

const defaultPublicPlanMetadata = DEFAULT_PUBLIC_PLAN_METADATA
const configuredPublicPlanMetadata = typeof __MARKETING_PUBLIC_PLAN_METADATA_JSON__ === 'string'
  && __MARKETING_PUBLIC_PLAN_METADATA_JSON__.trim() !== ''
  ? parsePublicPlanMetadataJson(__MARKETING_PUBLIC_PLAN_METADATA_JSON__)
  : undefined

export const marketingPlanSource: MarketingPlanSource = configuredPublicPlanMetadata ? 'build-configured' : 'shared-default'
export const publicPlanMetadata = configuredPublicPlanMetadata ?? defaultPublicPlanMetadata

export function formatMarketingStorage(bytes: number): string {
  const gib = 1024 ** 3
  const mib = 1024 ** 2
  const kib = 1024
  if (bytes % gib === 0) return `${bytes / gib} GiB`
  if (bytes % mib === 0) return `${bytes / mib} MiB`
  if (bytes % kib === 0) return `${bytes / kib} KiB`
  return `${bytes} bytes`
}

function formatCapacity(limits: PlanLimits): string {
  return `Up to ${limits.seats} active member${limits.seats === 1 ? '' : 's'} · ${formatMarketingStorage(limits.storageBytes)} retained · ${limits.scansPerMonth} scans/month`
}

function formatEveAllowance(limits: PlanLimits): string {
  return `Eve review allowance: ${limits.eveCostCentsPerMonth} cents/month`
}

function planKicker(plan: PublicPlanMetadata): string {
  if (plan.id === 'free') return 'Evaluation'
  if (plan.id === 'team') return 'For teams'
  if (plan.id === 'business') return 'For organizations'
  return 'Configured plan'
}

function planAudience(plan: PublicPlanMetadata): string {
  if (plan.id === 'free') return 'A bounded evaluation workspace'
  if (plan.id === 'team') return 'Shared workflows for a small team'
  if (plan.id === 'business') return 'Higher bounded capacity for organization use'
  return 'A configured application workspace'
}

function planCta(plan: PublicPlanMetadata): { cta: string; href: string } {
  if (plan.id === 'free') return { cta: 'Read the setup guide', href: '/docs/getting-started' }
  if (plan.id === 'team') return { cta: 'Open app sign-in', href: '/app' }
  return { cta: 'Plan a rollout', href: '/docs/getting-started#rollout' }
}

function planCadence(plan: PublicPlanMetadata): string {
  if (!plan.priceConfigured) return 'no recurring price configured'
  if (!plan.checkoutAvailable) return 'recurring price configured · app checkout closed'
  return 'recurring price configured in app'
}

/**
 * Project browser-safe billing metadata into visitor-facing cards. This is a
 * pure projection: it accepts metadata from any validated catalog, keeps the
 * server plan ID and limits, and adds only non-entitlement marketing copy.
 */
export function marketingPlansFromPublicMetadata(metadata: readonly PublicPlanMetadata[]): readonly MarketingPlan[] {
  const normalized = normalizePublicPlanMetadataList(metadata)
  return normalized.map((plan) => {
    const destination = planCta(plan)
    return {
      id: plan.id,
      name: plan.label,
      kicker: planKicker(plan),
      audience: planAudience(plan),
      price: 'Preview',
      cadence: planCadence(plan),
      description: plan.description,
      features: [
        'Private release catalog',
        'Configured policy and scanner evidence',
        'Repeatable pskills install path',
        formatCapacity(plan.limits),
        formatEveAllowance(plan.limits),
      ],
      limits: { ...plan.limits },
      priceConfigured: plan.priceConfigured,
      checkoutAvailable: plan.checkoutAvailable,
      cta: destination.cta,
      href: destination.href,
      ...(plan.id === 'team' ? { featured: true } : {}),
    }
  })
}

export const marketingPlans = marketingPlansFromPublicMetadata(publicPlanMetadata)
