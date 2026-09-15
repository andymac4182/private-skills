import { describe, expect, it } from 'vitest'
import { createPlanCatalog } from '../../../../packages/billing/src/plans.js'
import { DEFAULT_PUBLIC_PLAN_METADATA } from '../../../../packages/billing/src/public-plans.js'
import type { PublicPlanMetadata } from '../../../../packages/billing/src/types.js'
import {
  marketingPlans,
  marketingPlansFromPublicMetadata,
} from './marketingPlans'
import { parsePublicPlanMetadataJson } from './marketingPlanMetadata'

const defaultMetadata = createPlanCatalog().publicMetadata()

function customMetadata(overrides: Partial<PublicPlanMetadata> = {}): PublicPlanMetadata {
  return {
    protocolVersion: 1,
    id: 'team-plus',
    label: 'Team Plus',
    description: 'A configured catalog plan for projection tests.',
    limits: { seats: 7, storageBytes: 2 * 1024 ** 3, scansPerMonth: 125, eveCostCentsPerMonth: 900 },
    priceConfigured: true,
    checkoutAvailable: false,
    ...overrides,
  }
}

describe('marketing plan projection', () => {
  it('uses the server catalog IDs, labels, and finite limits for the default preview', () => {
    expect(DEFAULT_PUBLIC_PLAN_METADATA).toEqual(defaultMetadata)
    expect(marketingPlans.map((plan) => plan.id)).toEqual(['free', 'team', 'business'])
    expect(marketingPlans.map((plan) => plan.name)).toEqual(['Free', 'Team', 'Business'])
    expect(marketingPlans.map((plan) => plan.limits)).toEqual(defaultMetadata.map((plan) => plan.limits))
    expect(marketingPlans.every((plan) => plan.price === 'Preview')).toBe(true)
    expect(marketingPlans.every((plan) => plan.cta.match(/checkout|buy|subscribe|purchase/iu) === null)).toBe(true)
  })

  it('keeps capability copy independent from unsupported source-count entitlements', () => {
    const featureText = marketingPlans.flatMap((plan) => plan.features).join(' ')
    expect(featureText).not.toMatch(/one source connection|multiple source connections/iu)
    expect(featureText).toContain('Configured policy and scanner evidence')
    expect(featureText).toContain('Repeatable pskills install path')
  })

  it('reflects a custom public catalog without falling back to default names or limits', () => {
    const plan = customMetadata()
    const [projected] = marketingPlansFromPublicMetadata([plan])
    expect(projected).toMatchObject({
      id: 'team-plus',
      name: 'Team Plus',
      limits: plan.limits,
      priceConfigured: true,
      checkoutAvailable: false,
      price: 'Preview',
      cadence: 'recurring price configured · app checkout closed',
    })
    expect(projected?.features.join(' ')).toContain('7 active members')
    expect(projected?.features.join(' ')).toContain('2 GiB retained')
  })
})

describe('public plan metadata input', () => {
  it('accepts the server response envelope and preserves its public-only fields', () => {
    const plan = customMetadata()
    expect(parsePublicPlanMetadataJson(JSON.stringify({ protocolVersion: 1, plans: [plan] }))).toEqual([plan])
    expect(parsePublicPlanMetadataJson(JSON.stringify([plan]))).toEqual([plan])
    expect(parsePublicPlanMetadataJson(`{\n\t"protocolVersion": 1,\n\t"plans": [${JSON.stringify(plan)}]\n}`)).toEqual([plan])
  })

  it('fails closed for secrets, duplicate plans, malformed limits, and unsupported versions', () => {
    const plan = customMetadata()
    expect(() => parsePublicPlanMetadataJson(JSON.stringify([{ ...plan, priceId: 'price_secret_or_server_only' }]))).toThrow(/unsupported/u)
    expect(() => parsePublicPlanMetadataJson(JSON.stringify([plan, plan]))).toThrow(/duplicated/u)
    expect(() => parsePublicPlanMetadataJson(JSON.stringify([{ ...plan, limits: { ...plan.limits, seats: 0 } }]))).toThrow(/finite positive integer/u)
    expect(() => parsePublicPlanMetadataJson(JSON.stringify({ protocolVersion: 2, plans: [plan] }))).toThrow(/protocol version/u)
    expect(() => parsePublicPlanMetadataJson(JSON.stringify([{ ...plan, priceConfigured: false, checkoutAvailable: true }]))).toThrow(/contradicts/u)
  })
})
