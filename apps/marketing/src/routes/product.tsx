import { createFileRoute } from '@tanstack/react-router'
import { ProductFlowDemo, PublicLayout } from '../components/PublicLayout'
import { marketingHead } from '../lib/marketingSeo'

export const Route = createFileRoute('/product')({
  head: () => marketingHead({
    path: '/product',
    title: 'Product · Private Skills',
    description: 'See how Private Skills connects source discovery, release checks, packs, and installation for engineering teams.',
  }),
  component: ProductPage,
})

function ProductPage() {
  return <PublicLayout current="product">
    <section className="marketing-page-hero" aria-labelledby="product-page-title">
      <div className="marketing-page-hero-grid">
        <div><span className="marketing-eyebrow">For platform and developer-experience teams</span><h1 id="product-page-title">Make every private AI-agent skill release <em>easy to inspect.</em></h1><p>Private Skills connects source identity, required checks, release decisions, and install plans in a private registry your engineering team can use across projects.</p></div>
        <div className="marketing-page-hero-note"><strong>One workflow, shared context</strong>Start with one source and one release. Add packs, review suggestions, and more teams after the first workflow is clear.</div>
      </div>
    </section>

    <section className="marketing-section" aria-labelledby="product-features-title">
      <div className="marketing-section-heading"><span className="marketing-eyebrow">What teams get</span><h2 id="product-features-title">Keep every install easy to explain.</h2><p>Keep source choices, release evidence, and installation decisions in one workspace that your team can inspect.</p></div>
      <div className="marketing-feature-grid">
        <article className="marketing-feature-card"><span className="marketing-feature-index">01 / CATALOG</span><h3>One private catalog</h3><p>Publish immutable releases into a workspace your team can search, inspect, and authorize by role.</p><span className="marketing-feature-tag">private by default</span></article>
        <article className="marketing-feature-card"><span className="marketing-feature-index">02 / PULL-THROUGH</span><h3>Keep the source trail</h3><p>Pull from a connected catalog, keep its source identity with the candidate, and apply the checks required by your policy before caching.</p><span className="marketing-feature-tag">source attached</span></article>
        <article className="marketing-feature-card"><span className="marketing-feature-index">03 / PACKS</span><h3>Repeatable packs</h3><p>Group approved releases into a versioned pack so a project can reproduce the same skill set.</p><span className="marketing-feature-tag">selected releases</span></article>
        <article className="marketing-feature-card"><span className="marketing-feature-index">04 / EVE</span><h3>Review suggestions from Eve</h3><p>Eve can prepare a review proposal or draft-change suggestion. A person chooses what to apply; publishing and merging remain team actions.</p><span className="marketing-feature-tag">human decision</span></article>
      </div>
    </section>

    <section className="marketing-section marketing-section-split" id="how-it-works" aria-labelledby="product-flow-title">
      <div className="marketing-section-heading"><span className="marketing-eyebrow">How it works</span><h2 id="product-flow-title">A decision at every handoff.</h2><p>See the path from source discovery to an authorized install, with a clear reason for each step.</p></div>
      <ProductFlowDemo />
    </section>

    <section className="marketing-section" aria-labelledby="product-principles-title">
      <div className="marketing-section-heading"><span className="marketing-eyebrow">Designed for the team around the code</span><h2 id="product-principles-title">Shared context makes the workflow repeatable.</h2></div>
      <div className="marketing-principles">
        <article className="marketing-principle"><small>01 / VISIBILITY</small><h3>Teams can see what changed.</h3><p>Release versions, source revisions, policy revisions, and audit activity stay alongside the artifact decision.</p></article>
        <article className="marketing-principle"><small>02 / REPEATABILITY</small><h3>Projects can install the same plan.</h3><p>Pack members and lock metadata preserve the selected releases and digests for another installation.</p></article>
        <article className="marketing-principle"><small>03 / BOUNDARIES</small><h3>Automation has a job description.</h3><p>Scanning and pull-through handle a defined job. Eve can suggest a review action or draft change; people still decide what to publish, merge, or install.</p></article>
      </div>
    </section>
  </PublicLayout>
}
