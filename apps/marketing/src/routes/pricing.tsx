import { createFileRoute } from '@tanstack/react-router'
import { PublicLayout } from '../components/PublicLayout'
import { appLoginHref } from '../lib/appHref'
import { formatMarketingStorage, marketingPlans, pricingStatus } from '../lib/marketingPlans'
import { marketingHead } from '../lib/marketingSeo'

export const Route = createFileRoute('/pricing')({
  head: () => marketingHead({
    path: '/pricing',
    title: 'Pricing · Private Skills',
    description: 'Pricing preview for Private Skills, a private registry and pull-through workflow for engineering teams.',
  }),
  component: PricingPage,
})

function PricingPage() {
  return <PublicLayout current="pricing">
    <section className="marketing-page-hero" aria-labelledby="pricing-title">
      <div className="marketing-page-hero-grid">
        <div><span className="marketing-eyebrow">Simple packaging, deliberate rollout</span><h1 id="pricing-title">Choose the shape of your <em>first workflow.</em></h1><p>Compare a focused team run, several workflows, or a broader rollout. Commercial terms will be published after the workflow and value metric are settled.</p></div>
        <div className="marketing-page-hero-note"><strong>{pricingStatus}</strong>Plan shapes and finite allowances are shown for evaluation. Confirm current plan limits and checkout readiness in your application billing console.</div>
      </div>
    </section>

    <section className="marketing-pricing-wrap" aria-labelledby="plans-title">
      <div className="marketing-pricing-notice"><b>No purchase yet</b><span>These are planning views, not offers. The application billing console is the source of truth for live plan limits and checkout state; this separate public site never starts checkout. <a href="/contact">Need a walkthrough?</a></span></div>
      <h2 id="plans-title" className="marketing-visually-hidden">Pricing preview</h2>
      <div className="marketing-pricing-grid">
        {marketingPlans.map((plan) => <article className={plan.featured ? 'marketing-plan-card marketing-plan-card-featured' : 'marketing-plan-card'} data-plan-id={plan.id} key={plan.id}>
          <span className="marketing-plan-kicker">{plan.kicker}</span>
          <h2>{plan.name}</h2>
          <p className="marketing-plan-audience">{plan.audience}</p>
          <div className="marketing-plan-price marketing-plan-price-preview"><strong>{plan.price}</strong><span>{plan.cadence}</span></div>
          <p className="marketing-plan-description">{plan.description}</p>
          <ul className="marketing-plan-features">{plan.features.map((feature) => <li key={feature}>{feature}</li>)}</ul>
          <a className={plan.featured ? 'marketing-button marketing-button-primary' : 'marketing-button marketing-button-secondary'} href={plan.href === '/app' ? appLoginHref() : plan.href}>{plan.cta} <span aria-hidden="true">↗</span></a>
        </article>)}
      </div>

      <div aria-labelledby="comparison-title" className="marketing-comparison" role="region" tabIndex={0}>
        <h2 id="comparison-title">What the preview covers</h2>
        <table><caption className="marketing-visually-hidden">Plan metadata and bounded limits for the pricing preview</caption><thead><tr><th>Plan metadata</th>{marketingPlans.map((plan) => <th key={plan.id}>{plan.name}</th>)}</tr></thead><tbody>
          <tr><td>Server plan ID</td>{marketingPlans.map((plan) => <td key={plan.id}><code>{plan.id}</code></td>)}</tr>
          <tr><td>Active members</td>{marketingPlans.map((plan) => <td key={plan.id}>{plan.limits.seats}</td>)}</tr>
          <tr><td>Retained storage</td>{marketingPlans.map((plan) => <td key={plan.id}>{formatMarketingStorage(plan.limits.storageBytes)}</td>)}</tr>
          <tr><td>Scans per month</td>{marketingPlans.map((plan) => <td key={plan.id}>{plan.limits.scansPerMonth}</td>)}</tr>
          <tr><td>Eve allowance</td>{marketingPlans.map((plan) => <td key={plan.id}>{plan.limits.eveCostCentsPerMonth} cents/month</td>)}</tr>
          <tr><td>Recurring price</td>{marketingPlans.map((plan) => <td key={plan.id}>{plan.priceConfigured ? 'Configured in app' : 'Not configured'}</td>)}</tr>
          <tr><td>Marketing checkout</td>{marketingPlans.map((plan) => <td key={plan.id}>Unavailable</td>)}</tr>
        </tbody></table>
      </div>
    </section>
  </PublicLayout>
}
