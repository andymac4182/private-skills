import { createFileRoute } from '@tanstack/react-router'
import { PublicLayout } from '../components/PublicLayout'
import { appLoginHref } from '../lib/appHref'
import { marketingHead } from '../lib/marketingSeo'

export const Route = createFileRoute('/legal')({
  head: () => marketingHead({
    path: '/legal',
    title: 'Legal and product notes · Private Skills',
    description: 'Legal and product notes for the Private Skills marketing site, including launch status and service boundaries.',
  }),
  component: LegalPage,
})

function LegalPage() {
  return <PublicLayout current="legal">
    <section className="marketing-page-hero" aria-labelledby="legal-page-title">
      <div className="marketing-page-hero-grid">
        <div><span className="marketing-eyebrow">Legal and product notes</span><h1 id="legal-page-title">The details behind this <em>launch preview.</em></h1><p>These notes explain what this public site does, where the authenticated app begins, and which product statements remain subject to launch decisions.</p></div>
        <div className="marketing-page-hero-note"><strong>Last reviewed: launch preview</strong>This page is part of the marketing deployment. App access, registry data, and any future billing terms belong to the authenticated app and its published terms.</div>
      </div>
    </section>
    <section className="marketing-legal-layout" aria-label="Legal and product notes">
      <article className="marketing-legal-card"><span className="marketing-feature-index">01 / SITE SCOPE</span><h2>What this site handles</h2><p>This deployment serves public product, documentation, FAQ, pricing preview, and launch information. It does not contain registry records, account sessions, company data, payment collection, or private app credentials.</p></article>
      <article className="marketing-legal-card"><span className="marketing-feature-index">02 / APP ACCESS</span><h2>Where sign-in happens</h2><p>Use <a href={appLoginHref()}>Sign in to registry</a> to continue to the authenticated app. The sign-in and workspace setup path are configured by that deployment.</p></article>
      <article className="marketing-legal-card"><span className="marketing-feature-index">03 / PRODUCT STATUS</span><h2>What the preview means</h2><p>Examples, screenshots, plan shapes, and feature descriptions on this site are provided for evaluation. Source availability, scanner configuration, and deployment evidence depend on the selected environment.</p></article>
      <article className="marketing-legal-card"><span className="marketing-feature-index">04 / CONTENT HANDLING</span><h2>How the product treats skills</h2><p>The registry handles uploaded and imported skill content as data during ingestion and scanning. The public site does not accept skill uploads or run candidate content.</p></article>
      <article className="marketing-legal-card"><span className="marketing-feature-index">05 / COMMERCIAL STATUS</span><h2>No purchase is active</h2><p>The pricing page is a planning preview while packaging and billing are reviewed. It is not a checkout, offer, or payment authorization.</p></article>
      <article className="marketing-legal-card"><span className="marketing-feature-index">06 / NEXT STEP</span><h2>Read the current guide</h2><p>For the product workflow and operational boundaries, read <a href="/docs/getting-started">getting started</a>. For launch contact options, see <a href="/contact">launch contact</a>. For the public answers, see the <a href="/faq">FAQ</a>.</p></article>
    </section>
  </PublicLayout>
}
