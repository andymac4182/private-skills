import { createFileRoute } from '@tanstack/react-router'
import { PublicLayout } from '../components/PublicLayout'
import { appLoginHref } from '../lib/appHref'
import { marketingContactUrl } from '../lib/contact'
import { marketingHead } from '../lib/marketingSeo'

export const Route = createFileRoute('/contact')({
  head: () => marketingHead({
    path: '/contact',
    title: 'Launch contact · Private Skills',
    description: 'Choose a real next step for evaluating Private Skills with your engineering team.',
  }),
  component: ContactPage,
})

function ContactPage() {
  const contactUrl = marketingContactUrl()

  return <PublicLayout current="contact">
    <section className="marketing-page-hero" aria-labelledby="contact-page-title">
      <div className="marketing-page-hero-grid">
        <div>
          <span className="marketing-eyebrow">Launch contact</span>
          <h1 id="contact-page-title">Start with a <em>useful next step.</em></h1>
          <p>Use the pilot guide to evaluate one real workflow. When a public launch contact is configured, this page also gives you a direct place to ask for a walkthrough or rollout help.</p>
        </div>
        <div className="marketing-page-hero-note"><strong>Launch preview</strong>This page never guesses an email address or presents a contact channel that has not been configured for this deployment.</div>
      </div>
    </section>

    <section className="marketing-contact-layout" aria-label="Launch contact options">
      <article className="marketing-contact-card">
        <span className="marketing-feature-index">01 / EVALUATE</span>
        <h2>Try the workflow</h2>
          <p>Read the pilot guide, then use the configured registry sign-in when your team is ready to evaluate the workflow.</p>
        <div className="marketing-contact-actions">
          <a className="marketing-button marketing-button-primary" href="/docs/getting-started">Read the pilot guide <span aria-hidden="true">↗</span></a>
          <a className="marketing-button marketing-button-secondary" href={appLoginHref()}>Sign in to registry <span aria-hidden="true">↗</span></a>
        </div>
      </article>

      <article className="marketing-contact-card">
        <span className="marketing-feature-index">02 / WALKTHROUGH</span>
        <h2>Request a walkthrough</h2>
        {contactUrl ? <>
          <p>A public launch contact is available for questions about a pilot, setup, or rollout.</p>
          <div className="marketing-contact-actions">
            <a className="marketing-button marketing-button-primary" href={contactUrl} rel="noreferrer" target="_blank">Open launch contact <span aria-hidden="true">↗</span></a>
          </div>
        </> : <>
          <p>This preview does not publish a support address or scheduling link yet. Use the pilot guide or sign in when your configured registry is ready.</p>
          <div className="marketing-contact-status" role="status"><strong>Contact link pending</strong><span>A durable public intake or scheduling destination will appear here once configured.</span></div>
        </>}
      </article>
    </section>

    <section className="marketing-section marketing-contact-details" aria-labelledby="contact-details-title">
      <div className="marketing-section-heading">
        <span className="marketing-eyebrow">Make the first conversation useful</span>
        <h2 id="contact-details-title">Bring one workflow to the table.</h2>
        <p>For a walkthrough, start with the source you want to govern, the agent scope you need, and the team that should review the first release. The setup guide explains the product boundaries before any launch decision.</p>
        <a className="marketing-text-link" href="/docs/getting-started#rollout">Plan a rollout <span aria-hidden="true">↗</span></a>
      </div>
    </section>
  </PublicLayout>
}
