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
        <div><span className="marketing-eyebrow">Legal and product notes</span><h1 id="legal-page-title">The details behind this <em>launch preview.</em></h1><p>These notes explain what this public site covers, where the application begins, and the current product status.</p></div>
        <div className="marketing-page-hero-note"><strong>Launch preview</strong>This preview does not yet publish service terms, a privacy notice, or a support contact for application use.</div>
      </div>
    </section>
    <section className="marketing-legal-layout" aria-label="Legal and product notes">
      <article className="marketing-legal-card"><span className="marketing-feature-index">01 / SITE SCOPE</span><h2>What this site handles</h2><p>This site provides public product, documentation, FAQ, pricing preview, and launch information. It does not contain registry records, account sessions, company data, payment collection, or private app credentials.</p></article>
      <article className="marketing-legal-card"><span className="marketing-feature-index">02 / APP ACCESS</span><h2>Where application access begins</h2><p>Use <a href={appLoginHref()}>Open app sign-in</a> to continue to an application workspace. The application shows the sign-in and workspace steps for your team; this public site does not create accounts.</p></article>
      <article className="marketing-legal-card"><span className="marketing-feature-index">03 / PRODUCT STATUS</span><h2>What the preview means</h2><p>Examples, screenshots, plan limits, and feature descriptions on this site are provided for evaluation. The product includes private registry, source pull-through, packs, scanner checks, and Eve review paths; available connections and options depend on your application workspace.</p></article>
      <article className="marketing-legal-card"><span className="marketing-feature-index">04 / CONTENT HANDLING</span><h2>How the product treats skills</h2><p>The registry handles uploaded and imported skill content as data during ingestion and scanning. The public site does not accept skill uploads or run candidate content.</p></article>
      <article className="marketing-legal-card"><span className="marketing-feature-index">05 / COMMERCIAL STATUS</span><h2>No purchase is active</h2><p>The pricing page is a planning preview while packaging and billing are reviewed. It is not a checkout, offer, or payment authorization.</p></article>
      <article className="marketing-legal-card"><span className="marketing-feature-index">06 / NEXT STEP</span><h2>Read the current guide</h2><p>For the product workflow and operational boundaries, read <a href="/docs/getting-started">getting started</a>. For launch contact options, see <a href="/contact">launch contact</a>. For the public answers, see the <a href="/faq">FAQ</a>.</p></article>
      <article className="marketing-legal-card" id="publication-status"><span className="marketing-feature-index">07 / PUBLICATION STATUS</span><h2>Public terms are still being prepared</h2><p>This launch preview does not yet publish a privacy notice, service terms, or a support contact for application use. Those details will be added before an external rollout.</p></article>
    </section>
  </PublicLayout>
}
