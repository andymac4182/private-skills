import { createFileRoute } from '@tanstack/react-router'
import { PublicLayout } from '../components/PublicLayout'
import { appLoginHref } from '../lib/appHref'
import { marketingContactUrl } from '../lib/contact'

export const Route = createFileRoute('/contact')({
  head: () => ({
    meta: [
      { title: 'Launch contact · Private Skills' },
      { name: 'description', content: 'Choose a real next step for evaluating Private Skills with your engineering team.' },
    ],
  }),
  component: ContactPage,
})

function ContactPage() {
  const contactUrl = marketingContactUrl()

  return <PublicLayout current="contact">
    <section className="marketing-page-hero" aria-labelledby="contact-page-title">
      <div className="marketing-page-hero-grid">
        <div>
          <span className="marketing-eyebrow">Talk through the workflow</span>
          <h1 id="contact-page-title">Plan a practical <em>first run.</em></h1>
          <p>Start with one source and one engineering team. Use the guide or demo to see the workflow, then follow the walkthrough link when it is available.</p>
        </div>
        <div className="marketing-page-hero-note"><strong>{contactUrl ? 'Walkthrough available' : 'Launch preview'}</strong>{contactUrl ? 'Use the published request page to continue the conversation.' : 'A walkthrough request page is coming soon.'}</div>
      </div>
    </section>

    <section className="marketing-contact-layout" aria-label="Ways to start">
      <article className="marketing-contact-card">
        <span className="marketing-feature-index">01 / EVALUATE</span>
        <h2>Start the evaluation</h2>
        <p>If your team already has an application workspace, open sign-in and follow the hosted path. Otherwise, the guide explains what an operator needs for a local evaluation.</p>
        <div className="marketing-contact-actions">
          <a className="marketing-button marketing-button-primary" href="/docs/getting-started">Open the pilot guide <span aria-hidden="true">↗</span></a>
          <a className="marketing-button marketing-button-secondary" href={appLoginHref()}>Open app sign-in <span aria-hidden="true">↗</span></a>
        </div>
      </article>

      <article className="marketing-contact-card">
        <span className="marketing-feature-index">02 / WALKTHROUGH</span>
        <h2>Talk through a rollout</h2>
        {contactUrl ? <>
          <p>Use the published request page to ask about a pilot, setup, or rollout.</p>
          <div className="marketing-contact-actions">
            <a className="marketing-button marketing-button-primary" href={contactUrl} rel="noreferrer" target="_blank">Open request page <span aria-hidden="true">↗</span></a>
          </div>
        </> : <>
          <p>A walkthrough request page is coming soon. Until then, see the demo.</p>
          <div className="marketing-contact-actions">
            <a className="marketing-button marketing-button-primary" href="/demo">View the demo <span aria-hidden="true">↗</span></a>
          </div>
        </>}
      </article>
    </section>

    <section className="marketing-section marketing-contact-details" aria-labelledby="contact-details-title">
      <div className="marketing-section-heading">
        <span className="marketing-eyebrow">Make the first conversation useful</span>
        <h2 id="contact-details-title">Bring one workflow to the conversation.</h2>
        <p>For a useful rollout conversation, bring the source you want to manage, the agent scope you need, and the team for the first release. Start with the guide while the request page is being prepared.</p>
        <a className="marketing-text-link" href="/docs/getting-started#rollout">Plan the next team <span aria-hidden="true">↗</span></a>
      </div>
    </section>
  </PublicLayout>
}
