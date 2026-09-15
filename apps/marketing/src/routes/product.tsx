import { createFileRoute } from '@tanstack/react-router'
import { ProductFlowDemo, PublicLayout } from '../components/PublicLayout'

export const Route = createFileRoute('/product')({
  head: () => ({
    meta: [
      { title: 'Product · Private Skills' },
      { name: 'description', content: 'See how Private Skills connects source discovery, release checks, packs, and installation for engineering teams.' },
    ],
  }),
  component: ProductPage,
})

function ProductPage() {
  return <PublicLayout current="product">
    <section className="marketing-page-hero" aria-labelledby="product-page-title">
      <div className="marketing-page-hero-grid">
        <div><span className="marketing-eyebrow">A registry around your agent stack</span><h1 id="product-page-title">Keep every skill decision <em>close to the code.</em></h1><p>Private Skills connects your AI agent skills, source checks, review, and install plan so teams can move quickly with a record they can read.</p></div>
        <div className="marketing-page-hero-note"><strong>One workflow, shared context</strong>Start with one source and one approved release. Add packs, review proposals, and more teams as the workflow earns its place.</div>
      </div>
    </section>

    <section className="marketing-section" aria-labelledby="product-features-title">
      <div className="marketing-section-heading"><span className="marketing-eyebrow">What teams get</span><h2 id="product-features-title">The controls belong around the install.</h2><p>Keep source choices, release evidence, and installation decisions in one workspace that your team can inspect.</p></div>
      <div className="marketing-feature-grid">
        <article className="marketing-feature-card"><span className="marketing-feature-index">01 / CATALOG</span><h3>One private catalog</h3><p>Publish immutable releases into a workspace your team can search, inspect, and authorize by role.</p><span className="marketing-feature-tag">private by default</span></article>
        <article className="marketing-feature-card"><span className="marketing-feature-index">02 / PULL-THROUGH</span><h3>Source pull-through</h3><p>Search configured catalogs, preserve the original identity, and bring a candidate through checks before it reaches the cache.</p><span className="marketing-feature-tag">provenance attached</span></article>
        <article className="marketing-feature-card"><span className="marketing-feature-index">03 / PACKS</span><h3>Repeatable packs</h3><p>Group approved releases into a versioned pack so a project can reproduce the same skill set.</p><span className="marketing-feature-tag">selected releases</span></article>
        <article className="marketing-feature-card"><span className="marketing-feature-index">04 / EVE</span><h3>Review and author with Eve</h3><p>Eve can suggest a review decision or a draft change. A person chooses what to apply, while publishing and merging stay with the team.</p><span className="marketing-feature-tag">human decision</span></article>
      </div>
    </section>

    <section className="marketing-section marketing-section-split" id="how-it-works" aria-labelledby="product-flow-title">
      <div className="marketing-section-heading"><span className="marketing-eyebrow">How it works</span><h2 id="product-flow-title">A decision at every handoff.</h2><p>See the path from source discovery to an authorized install, with a clear reason for each step.</p></div>
      <ProductFlowDemo />
    </section>

    <section className="marketing-section" aria-labelledby="product-principles-title">
      <div className="marketing-section-heading"><span className="marketing-eyebrow">Designed for the team around the code</span><h2 id="product-principles-title">Shared context makes the workflow repeatable.</h2></div>
      <div className="marketing-principles">
        <article className="marketing-principle"><small>01 / OWNERSHIP</small><h3>Owners can see what changed.</h3><p>Release versions, source revisions, policy revisions, and audit activity stay alongside the artifact decision.</p></article>
        <article className="marketing-principle"><small>02 / REPEATABILITY</small><h3>Projects can install the same plan.</h3><p>Pack members and lock metadata preserve the selected releases and digests for another installation.</p></article>
        <article className="marketing-principle"><small>03 / BOUNDARIES</small><h3>Automation has a job description.</h3><p>Scanning and pull-through handle a defined job. Eve can suggest a review action or draft change; people still decide what to publish, merge, or install.</p></article>
      </div>
    </section>
  </PublicLayout>
}
