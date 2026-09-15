import { createFileRoute } from '@tanstack/react-router'
import { PublicLayout } from '../components/PublicLayout'
import { appLoginHref } from '../lib/appHref'
import { marketingPlans, pricingStatus } from '../lib/marketingPlans'

export const Route = createFileRoute('/pricing')({
  head: () => ({
    meta: [
      { title: 'Pricing · Private Skills' },
      { name: 'description', content: 'Pricing preview for Private Skills, a private registry and pull-through workflow for engineering teams.' },
    ],
  }),
  component: PricingPage,
})

function PricingPage() {
  return <PublicLayout current="pricing">
    <section className="marketing-page-hero" aria-labelledby="pricing-title">
      <div className="marketing-page-hero-grid">
        <div><span className="marketing-eyebrow">Simple packaging, deliberate rollout</span><h1 id="pricing-title">Choose the shape of your <em>first workflow.</em></h1><p>Start with the controls your team needs today, then expand as more sources, packs, and companies come into the registry.</p></div>
        <div className="marketing-page-hero-note"><strong>{pricingStatus}</strong>Plan shapes and inclusions are being evaluated for launch. This page helps teams compare the workflow; no purchase or payment path is active.</div>
      </div>
    </section>

    <section className="marketing-pricing-wrap" aria-labelledby="plans-title">
      <div className="marketing-pricing-notice"><b>No purchase yet</b><span>These are planning views, not offers. Use the setup guide to evaluate the workflow, then sign in through your provider and create or choose a company when prompted.</span></div>
      <h2 id="plans-title" className="marketing-visually-hidden">Pricing preview</h2>
      <div className="marketing-pricing-grid">
        {marketingPlans.map((plan) => <article className={plan.featured ? 'marketing-plan-card marketing-plan-card-featured' : 'marketing-plan-card'} key={plan.id}>
          <span className="marketing-plan-kicker">{plan.featured ? 'Most complete starting point' : plan.name === 'Organization' ? 'For a broader rollout' : 'For a focused pilot'}</span>
          <h2>{plan.name}</h2>
          <p className="marketing-plan-audience">{plan.audience}</p>
          <div className="marketing-plan-price marketing-plan-price-preview"><strong>{plan.price}</strong><span>{plan.cadence}</span></div>
          <p className="marketing-plan-description">{plan.description}</p>
          <ul className="marketing-plan-features">{plan.features.map((feature) => <li key={feature}>{feature}</li>)}</ul>
          <a className={plan.featured ? 'marketing-button marketing-button-primary' : 'marketing-button marketing-button-secondary'} href={plan.href === '/app' ? appLoginHref() : plan.href}>{plan.cta} <span aria-hidden="true">↗</span></a>
        </article>)}
      </div>

      <div className="marketing-comparison" aria-labelledby="comparison-title">
        <h2 id="comparison-title">What the preview covers</h2>
        <table><caption className="marketing-visually-hidden">Capability comparison for the pricing preview</caption><thead><tr><th>Capability</th><th>Pilot</th><th>Team</th><th>Organization</th></tr></thead><tbody>
          <tr><td>Private release catalog</td><td><strong>✓</strong></td><td><strong>✓</strong></td><td><strong>✓</strong></td></tr>
          <tr><td>Configured source pull-through</td><td>One source</td><td>Multiple sources</td><td>Rollout planning</td></tr>
          <tr><td>Repeatable packs</td><td>First pack</td><td>Shared packs</td><td>Across company teams</td></tr>
          <tr><td>Review workflow</td><td>Policy visible</td><td>Policy + Eve proposals</td><td>Policy planning</td></tr>
        </tbody></table>
      </div>
    </section>
  </PublicLayout>
}
