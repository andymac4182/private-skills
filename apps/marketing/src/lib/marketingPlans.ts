export interface MarketingPlan {
  id: string
  name: string
  audience: string
  price: string
  cadence: string
  description: string
  features: string[]
  cta: string
  href: string
  featured?: boolean
}

/**
 * Keep the launch page useful while the commercial packaging decision is open.
 * The public page intentionally shows plan shapes without publishing prices
 * or opening a purchase flow.
 */
export const pricingStatus = 'Pricing preview'

export const marketingPlans: MarketingPlan[] = [
  {
    id: 'pilot',
    name: 'Pilot',
    audience: 'One engineering team',
    price: 'Preview',
    cadence: 'packaging under review',
    description: 'A focused starting point for proving one private skill workflow end to end.',
    features: ['Private release catalog', 'One configured source', 'Shared review policy', 'pskills install path'],
    cta: 'Read the setup guide',
    href: '/docs/getting-started',
  },
  {
    id: 'team',
    name: 'Team',
    audience: 'Several workflows, one owner group',
    price: 'Preview',
    cadence: 'packaging under review',
    description: 'A broader workspace for teams that publish, import, review, and repeat.',
    features: ['Multiple source connections', 'Fixed skill packs', 'Scanner evidence in review', 'Eve review proposals'],
    cta: 'Sign in to registry',
    href: '/app',
    featured: true,
  },
  {
    id: 'organization',
    name: 'Organization',
    audience: 'Multiple teams and policy owners',
    price: 'Preview',
    cadence: 'rollout planning',
    description: 'A planning conversation for teams with shared infrastructure and distinct owners.',
    features: ['Tenant-aware operating model', 'Policy and source planning', 'Deployment profile review', 'Adoption guidance'],
    cta: 'Plan a rollout',
    href: '/docs/getting-started#rollout',
  },
]
