import { createFileRoute } from '@tanstack/react-router'
import { InstallWalkthrough, ProductFlowDemo, PublicLayout } from '../components/PublicLayout'
import { appLoginHref } from '../lib/appHref'

export const Route = createFileRoute('/')({
  head: () => ({
    meta: [
      { title: 'Private Skills · A private registry for engineering teams' },
      { name: 'description', content: 'Trace AI-agent skills from source to policy decision to repeatable install with a private registry for engineering teams.' },
    ],
  }),
  component: HomePage,
})

function HomePage() {
  return <PublicLayout current="home">
    <section className="marketing-hero" aria-labelledby="marketing-hero-title">
      <div className="marketing-hero-copy">
        <span className="marketing-eyebrow">Private AI-agent skills for engineering teams</span>
        <h1 id="marketing-hero-title">Give your team control of <em>private AI-agent skills.</em></h1>
        <p className="marketing-hero-lede">Private Skills brings source discovery, required checks, release decisions, and repeatable installs into one place, so every project can see what it is choosing and use the same skill version.</p>
        <div className="marketing-hero-actions">
          <a className="marketing-button marketing-button-primary" href="/docs/getting-started">Start with the pilot guide <span aria-hidden="true">↗</span></a>
          <a className="marketing-hero-link" href={appLoginHref()}>Already have access? Sign in <span aria-hidden="true">→</span></a>
        </div>
        <p className="marketing-hero-note"><span aria-hidden="true" className="marketing-status-dot" />Private registry <span aria-hidden="true">·</span> source and policy visible <span aria-hidden="true">·</span> required checks before installation</p>
      </div>
      <div className="marketing-hero-art" role="img" aria-label="Illustrated example release moving through source, scan, pack, and install stages">
        <div className="marketing-product-window">
          <div className="marketing-product-window-bar"><i /><i /><i /><small>registry / release review</small></div>
          <div className="marketing-product-window-body">
            <div aria-label="Example registry sections" className="marketing-product-window-rail" role="group" tabIndex={0}><strong>Private Skills</strong><span>Overview</span><span>Catalog</span><span>Sources</span><span>Packs</span><span>Policy</span></div>
            <div className="marketing-product-window-main">
              <div className="marketing-window-kicker"><span>Release pathway</span><b className="marketing-window-example-label"><span aria-hidden="true" className="marketing-status-dot" />Example release</b></div>
              <h2 className="marketing-window-title">A decision trail your team can read.</h2>
              <div className="marketing-window-release"><div className="marketing-window-release-main"><strong>@acme/frontend-guidelines</strong><small>release preview · source: skills-sh · revision 41bbe19d</small></div><span className="marketing-window-release-badge">Example release</span></div>
              <div className="marketing-window-progress" aria-hidden="true"><span /><span /><span /><span /></div>
              <div className="marketing-window-progress-label"><span>source resolved</span><span>policy recorded</span></div>
              <div className="marketing-window-evidence"><div className="marketing-window-evidence-row"><span>Provenance</span><strong>source identity recorded</strong></div><div className="marketing-window-evidence-row"><span>Scanner evidence</span><strong>current for release</strong></div><div className="marketing-window-evidence-row"><span>Install plan</span><strong>selected releases</strong></div></div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section className="marketing-proof-strip" aria-label="Product boundaries">
      <span>Useful controls around a simple install.</span>
      <div className="marketing-proof-items">
        <div className="marketing-proof-item"><b aria-hidden="true">01</b><span>Ingest treats skill content as data</span></div>
        <div className="marketing-proof-item"><b aria-hidden="true">02</b><span>Required scan failures deny release</span></div>
        <div className="marketing-proof-item"><b aria-hidden="true">03</b><span>Packs keep selected releases together</span></div>
        <div className="marketing-proof-item"><b aria-hidden="true">04</b><span>Eve proposes, humans decide</span></div>
      </div>
    </section>

    <section className="marketing-section" id="product" aria-labelledby="product-title">
      <div className="marketing-section-heading">
        <span className="marketing-eyebrow">Product at a glance</span>
        <h2 id="product-title">One private place for the agent skills your team uses.</h2>
        <p>Keep source choices, release evidence, and install decisions together, so a platform team can explain what a project is about to install.</p>
      </div>
      <div className="marketing-feature-grid">
        <article className="marketing-feature-card"><span className="marketing-feature-index">01 / CATALOG</span><h3>One private catalog</h3><p>Publish immutable releases into a workspace your team can search, inspect, and authorize by role.</p><span className="marketing-feature-tag">private by default</span></article>
        <article className="marketing-feature-card"><span className="marketing-feature-index">02 / PULL-THROUGH</span><h3>Keep the source trail</h3><p>Pull from a connected catalog, keep its source identity with the candidate, and apply the checks required by your policy before caching.</p><span className="marketing-feature-tag">source attached</span></article>
        <article className="marketing-feature-card"><span className="marketing-feature-index">03 / PACKS</span><h3>Repeatable packs</h3><p>Group approved releases into a versioned pack so a project can reproduce the same skill set.</p><span className="marketing-feature-tag">selected releases</span></article>
        <article className="marketing-feature-card"><span className="marketing-feature-index">04 / EVE</span><h3>Review suggestions from Eve</h3><p>Eve can prepare a review proposal or draft-change suggestion. A person chooses what to apply; publishing and merging remain team actions.</p><span className="marketing-feature-tag">human decision</span></article>
      </div>
    </section>

    <section className="marketing-section marketing-section-split" id="how-it-works" aria-labelledby="how-title">
      <div className="marketing-section-heading">
        <span className="marketing-eyebrow">How it works</span>
        <h2 id="how-title">Make the approved path easy to explain.</h2>
        <p>Each handoff has a visible boundary. Teams can move quickly while keeping the source, the checks, and the next decision easy to see.</p>
        <a className="marketing-text-link" href="/docs/getting-started#rollout">Plan your first workflow <span aria-hidden="true">↗</span></a>
      </div>
      <ProductFlowDemo />
    </section>

    <section className="marketing-section" aria-label="CLI installation walkthrough">
      <InstallWalkthrough />
    </section>

    <section className="marketing-section" aria-labelledby="principles-title">
      <div className="marketing-section-heading"><span className="marketing-eyebrow">Built for the team around the code</span><h2 id="principles-title">The useful part is the shared context.</h2></div>
      <div className="marketing-principles">
        <article className="marketing-principle"><small>01 / VISIBILITY</small><h3>Teams can see what changed.</h3><p>Release versions, source revisions, policy revisions, and audit activity stay alongside the artifact decision.</p></article>
        <article className="marketing-principle"><small>02 / REPEATABILITY</small><h3>Projects can install the same plan.</h3><p>Pack members and lock metadata preserve the selected releases and digests for another installation.</p></article>
        <article className="marketing-principle"><small>03 / BOUNDARIES</small><h3>Automation has a job description.</h3><p>Scanning and pull-through handle a defined job. Eve can suggest a review action or draft change; people still decide what to publish, merge, or install.</p></article>
      </div>
    </section>

    <section className="marketing-section" aria-labelledby="faq-title">
      <div className="marketing-section-heading"><span className="marketing-eyebrow">Questions teams ask first</span><h2 id="faq-title">A few useful boundaries.</h2></div>
      <div className="marketing-faq">
        <details><summary>Does Private Skills execute a skill while it is being imported?</summary><p>No. Uploaded and imported skill content is handled as data during ingestion, scanning, and installation. The registry does not run skill scripts or package lifecycle hooks.</p></details>
        <details><summary>What happens when a required scanner fails?</summary><p>The candidate stays unavailable or quarantined. A client-side flag cannot turn a failed required check into an approved release.</p></details>
        <details><summary>Can Eve publish or merge a change for us?</summary><p>No. Eve's review tool records a proposal for a person to decide. In the builder, a person can ask Eve to apply a chosen change to a draft; that authoring step is separate from publishing or merging.</p></details>
        <details><summary>Does every release need a human approval?</summary><p>Required checks can make the release available automatically. A human approval is part of the path only when your policy adds a review gate; Eve's proposals are advisory until then.</p></details>
        <details><summary>Is this a public marketplace?</summary><p>The product is designed around private, authorized registries. Connected external catalogs can be searched and resolved through source adapters, but discoverability does not make a release approved.</p></details>
      </div>
    </section>
  </PublicLayout>
}
