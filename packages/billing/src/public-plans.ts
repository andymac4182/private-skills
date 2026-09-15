import {
  BILLING_PROTOCOL_VERSION,
  type PlanDefinition,
  type PlanId,
  type PublicPlanMetadata,
} from './types.js'

const GIB = 1024 ** 3

/**
 * Provisional finite defaults used by the local/test contract. Product and
 * marketing may replace these through explicit configuration before launch.
 * This module stays free of provider, server, and Price-ID logic so public
 * product surfaces can reuse the browser-safe defaults.
 */
export const DEFAULT_PLAN_DEFINITIONS: readonly PlanDefinition[] = Object.freeze([
  {
    id: 'free' as PlanId,
    label: 'Free',
    description: 'A bounded evaluation workspace for trying the registry.',
    limits: { seats: 3, storageBytes: GIB, scansPerMonth: 50, eveCostCentsPerMonth: 50 },
    public: true,
  },
  {
    id: 'team' as PlanId,
    label: 'Team',
    description: 'Shared private skill management for a small team (provisional).',
    limits: { seats: 10, storageBytes: 10 * GIB, scansPerMonth: 750, eveCostCentsPerMonth: 500 },
    public: true,
  },
  {
    id: 'business' as PlanId,
    label: 'Business',
    description: 'Higher bounded capacity for governed organization use (provisional Team Plus anchor).',
    limits: { seats: 25, storageBytes: 50 * GIB, scansPerMonth: 4_000, eveCostCentsPerMonth: 2_500 },
    public: true,
  },
].map((plan) => Object.freeze({ ...plan, limits: Object.freeze({ ...plan.limits }) })))

/**
 * The default browser-safe projection. Price readiness is deliberately false
 * until a deployment supplies its own public metadata readback.
 */
export const DEFAULT_PUBLIC_PLAN_METADATA: readonly PublicPlanMetadata[] = Object.freeze(
  DEFAULT_PLAN_DEFINITIONS.filter((plan) => plan.public).map((plan) => Object.freeze({
    protocolVersion: BILLING_PROTOCOL_VERSION,
    id: plan.id,
    label: plan.label,
    description: plan.description,
    limits: Object.freeze({ ...plan.limits }),
    priceConfigured: false,
    checkoutAvailable: false,
  })),
)
