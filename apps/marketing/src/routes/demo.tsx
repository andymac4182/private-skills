import { createFileRoute } from '@tanstack/react-router'
import { InstallWalkthrough, ProductFlowDemo, PublicLayout } from '../components/PublicLayout'
import { appLoginHref } from '../lib/appHref'
import { marketingHead } from '../lib/marketingSeo'

export const Route = createFileRoute('/demo')({
  head: () => marketingHead({
    path: '/demo',
    title: 'Demo walkthrough · Private Skills',
    description: 'Walk through a source-to-install Private Skills workflow with example records and the current CLI path.',
  }),
  component: DemoPage,
})

function DemoPage() {
  return <PublicLayout current="demo">
    <section className="marketing-page-hero marketing-demo-page-hero" aria-labelledby="demo-page-title">
      <div className="marketing-page-hero-grid">
        <div>
          <span className="marketing-eyebrow">Demo walkthrough · about 8 minutes</span>
          <h1 id="demo-page-title">See one skill move from <em>source to install.</em></h1>
          <p>Use this short story with an engineering teammate. It uses example records and placeholder identifiers, so it can be presented before a live registry is connected.</p>
          <div className="marketing-hero-actions">
            <a className="marketing-button marketing-button-primary" href="#demo-flow">Start the walkthrough <span aria-hidden="true">↓</span></a>
            <a className="marketing-hero-link" href="/docs/getting-started">Open setup guide <span aria-hidden="true">→</span></a>
          </div>
        </div>
        <div className="marketing-page-hero-note"><strong>Example records only</strong>Replace the source, release, digest, and pack identifiers with values from your application workspace before using the CLI commands.</div>
      </div>
    </section>

    <section className="marketing-section marketing-section-split" id="demo-flow" aria-labelledby="demo-flow-title">
      <div className="marketing-section-heading">
        <span className="marketing-eyebrow">The story to tell</span>
        <h2 id="demo-flow-title">A release trail your team can read.</h2>
        <p>Keep the walkthrough focused on one concrete workflow: where the skill came from, what your policy decided, and what the developer installed.</p>
        <ol className="marketing-demo-script-list">
          <li><span>01</span><div><strong>Name the starting problem</strong><p>Different people find skills in different places, and the install decision loses its context.</p></div></li>
          <li><span>02</span><div><strong>Follow the four handoffs</strong><p>Show source, scan, pack, and install. Pause at each handoff so the next decision is visible.</p></div></li>
          <li><span>03</span><div><strong>Close with the boundary</strong><p>Required checks and any review gate control release availability; Eve suggests, while people choose what to apply or publish.</p></div></li>
        </ol>
      </div>
      <ProductFlowDemo />
    </section>

    <section className="marketing-section" aria-labelledby="demo-cli-title">
      <div className="marketing-section-heading">
        <span className="marketing-eyebrow">Use your own workspace</span>
        <h2 id="demo-cli-title">The same story, with the current CLI.</h2>
        <p>These snippets mirror the supported Rust CLI commands. Replace angle-bracket values and example references with identities your registry returns.</p>
      </div>
      <div className="marketing-demo-script-grid">
        <article className="marketing-demo-script-card">
          <span className="marketing-feature-index">01 / CONNECT</span>
          <h3>Connect the CLI</h3>
          <p>Use a scoped token supplied by an owner or administrator of your application workspace. The current hosted preview has no public account sign-up. Keep the token out of recordings, shell history, and public docs.</p>
          <pre><code>pskills login --registry &lt;registry-url&gt; --token-stdin</code></pre>
        </article>
        <article className="marketing-demo-script-card">
          <span className="marketing-feature-index">02 / INSPECT</span>
          <h3>Inspect the decision</h3>
          <p>Discover a connected source, inspect the release, and read the scanner status before choosing an install.</p>
          <pre><code>pskills sources list{ '\n' }pskills sources search --source skills-sh &quot;frontend&quot;{ '\n' }pskills scan status sha256:&lt;release-digest&gt;</code></pre>
        </article>
        <article className="marketing-demo-script-card">
          <span className="marketing-feature-index">03 / INSTALL</span>
          <h3>Install and verify</h3>
          <p>Use an approved release reference, select the agent scope, and verify the resulting local state.</p>
          <pre><code>pskills install @team/web-guidelines@1.2.0 --agent codex{ '\n' }pskills verify</code></pre>
        </article>
      </div>
    </section>

    <section className="marketing-section" aria-label="CLI installation walkthrough">
      <InstallWalkthrough />
    </section>

    <section className="marketing-section marketing-demo-final" aria-labelledby="demo-next-title">
      <div className="marketing-section-heading">
        <span className="marketing-eyebrow">Ready for a real run?</span>
        <h2 id="demo-next-title">Bring one source and one teammate.</h2>
        <p>Follow the setup guide for your workspace, then open app sign-in when you are ready for a real run. The marketing site never asks for a credential.</p>
        <div className="marketing-hero-actions">
          <a className="marketing-button marketing-button-primary" href="/docs/getting-started">Read the setup guide <span aria-hidden="true">↗</span></a>
          <a className="marketing-hero-link" href={appLoginHref()}>Open app sign-in <span aria-hidden="true">→</span></a>
        </div>
      </div>
    </section>
  </PublicLayout>
}
