import { createFileRoute } from '@tanstack/react-router'
import { PublicLayout } from '../components/PublicLayout'
import { appLoginHref } from '../lib/appHref'

export const Route = createFileRoute('/legal')({
  head: () => ({
    meta: [
      { title: 'Legal and product notes · Private Skills' },
      { name: 'description', content: 'Legal and product notes for the Private Skills marketing site, including launch status and service boundaries.' },
    ],
  }),
  component: LegalPage,
})

function LegalPage() {
  return <PublicLayout current="legal">
    <section className="marketing-page-hero" aria-labelledby="legal-page-title">
      <div className="marketing-page-hero-grid">
        <div><span className="marketing-eyebrow">Legal and product notes</span><h1 id="legal-page-title">The details behind this <em>launch preview.</em></h1><p>These notes explain what this public site covers, where the application begins, and what still needs to be published before an external rollout.</p></div>
        <div className="marketing-page-hero-note"><strong>Launch preview</strong>Public terms, a privacy notice, and a support route are still being prepared. Use this page for current product boundaries; application data use belongs to the application.</div>
      </div>
    </section>
    <section className="marketing-legal-layout" aria-label="Legal and product notes">
      <article className="marketing-legal-card"><span className="marketing-feature-index">01 / SITE SCOPE</span><h2>What this site handles</h2><p>This deployment serves public product, documentation, FAQ, pricing preview, and launch information. It does not contain registry records, account sessions, company data, payment collection, or private app credentials.</p></article>
      <article className="marketing-legal-card"><span className="marketing-feature-index">02 / APP ACCESS</span><h2>Where application access begins</h2><p>Use <a href={appLoginHref()}>Open app sign-in</a> to continue to an application workspace. That application shows the available identity and workspace steps for its environment; this public site does not create accounts.</p></article>
      <article className="marketing-legal-card"><span className="marketing-feature-index">03 / PRODUCT STATUS</span><h2>What the preview means</h2><p>Examples, screenshots, plan shapes, and feature descriptions on this site are provided for evaluation. Hosted source import, approved transfer and install, scanner availability, and deployment evidence depend on the environment and its current acceptance evidence.</p></article>
      <article className="marketing-legal-card"><span className="marketing-feature-index">04 / CONTENT HANDLING</span><h2>How the product treats skills</h2><p>The registry handles uploaded and imported skill content as data during ingestion and scanning. The public site does not accept skill uploads or run candidate content.</p></article>
      <article className="marketing-legal-card"><span className="marketing-feature-index">05 / COMMERCIAL STATUS</span><h2>No purchase is active</h2><p>The pricing page is a planning preview while packaging and billing are reviewed. It is not a checkout, offer, or payment authorization.</p></article>
      <article className="marketing-legal-card"><span className="marketing-feature-index">06 / NEXT STEP</span><h2>Read the current guide</h2><p>For the product workflow and operational boundaries, read <a href="/docs/getting-started">getting started</a>. For launch contact options, see <a href="/contact">launch contact</a>. For the public answers, see the <a href="/faq">FAQ</a>.</p></article>
      <article className="marketing-legal-card" id="privacy-status"><span className="marketing-feature-index">07 / PRIVACY STATUS</span><h2>Privacy notice is not published yet</h2><p>This marketing site has no account creation or skill upload. A public privacy notice for application use still needs an owner, data categories, retention details, subprocessors, and a real contact route before an external rollout.</p></article>
      <article className="marketing-legal-card" id="terms-status"><span className="marketing-feature-index">08 / TERMS STATUS</span><h2>Service terms are not published yet</h2><p>Application terms, service limits, support expectations, and the operating entity are not published on this preview. The pricing page remains a planning aid and is not an offer.</p></article>
      <article className="marketing-legal-card" id="publication-status"><span className="marketing-feature-index">09 / ROLLOUT INPUTS</span><h2>What launch still needs</h2><p>Before inviting an external team, publish the privacy notice and service terms, name the service owner and jurisdiction, provide a durable support intake, and document the application’s data handling and retention choices.</p></article>
    </section>
  </PublicLayout>
}
