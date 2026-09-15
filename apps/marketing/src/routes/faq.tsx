import { createFileRoute } from '@tanstack/react-router'
import { PublicLayout } from '../components/PublicLayout'

export const Route = createFileRoute('/faq')({
  head: () => ({
    meta: [
      { title: 'FAQ · Private Skills' },
      { name: 'description', content: 'Answers about Private Skills, its review workflow, source connections, installation, and launch status.' },
    ],
  }),
  component: FaqPage,
})

function FaqPage() {
  return <PublicLayout current="faq">
    <section className="marketing-page-hero" aria-labelledby="faq-page-title">
      <div className="marketing-page-hero-grid">
        <div><span className="marketing-eyebrow">Questions teams ask first</span><h1 id="faq-page-title">Clear answers for a <em>careful rollout.</em></h1><p>Private Skills keeps the path from a discovered skill to an approved install visible. These answers describe the current product and its launch boundaries.</p></div>
        <div className="marketing-page-hero-note"><strong>Start with one workflow</strong>Read the <a href="/docs/getting-started">getting started guide</a>, then sign in through your provider when you are ready to open the app.</div>
      </div>
    </section>
    <section className="marketing-faq marketing-faq-page" aria-label="Frequently asked questions">
      <details open><summary>What is Private Skills?</summary><p>It is a private registry for engineering teams. It brings source discovery, release checks, packs, and installation into one place so a team can see what it is choosing.</p></details>
      <details><summary>Does it execute a skill while it is being imported?</summary><p>No. Uploaded and imported skill content is handled as data during ingestion, scanning, and installation. The registry does not run skill scripts or package lifecycle hooks.</p></details>
      <details><summary>What happens when a required scanner fails?</summary><p>The candidate stays unavailable or quarantined. A client-side setting cannot turn a failed required check into an approved release.</p></details>
      <details><summary>Can I search an external catalog?</summary><p>Configured catalogs can be searched through source adapters. The source identity stays with the candidate, and discovery alone does not approve a release.</p></details>
      <details><summary>Can Eve publish or merge a change for us?</summary><p>No. Eve's review tool records a proposal for a person to decide. In the builder, a person can ask Eve to apply a chosen change to a draft; that authoring step is separate from publishing or merging.</p></details>
      <details><summary>What does first-time sign-in do?</summary><p>Choose Open registry, sign in through your provider, and create or choose a company if the app asks you to. A new user starts with provider sign-in and company setup.</p></details>
      <details><summary>Is pricing available?</summary><p>The pricing page is a preview of plan shapes while commercial packaging is being decided. No purchase or payment path is active.</p></details>
    </section>
  </PublicLayout>
}
