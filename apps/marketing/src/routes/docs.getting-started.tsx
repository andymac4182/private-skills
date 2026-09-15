import { createFileRoute } from '@tanstack/react-router'
import { CliReleaseChooser } from '../components/CliReleaseChooser'
import { appLoginHref } from '../lib/appHref'
import { marketingHead } from '../lib/marketingSeo'

export const Route = createFileRoute('/docs/getting-started')({
  head: () => marketingHead({
    path: '/docs/getting-started',
    title: 'Getting started · Private Skills',
    description: 'Set up a first Private Skills registry workflow, configure policy, and install an approved release.',
  }),
  component: GettingStartedPage,
})

function GettingStartedPage() {
  return <div className="marketing-start-layout">
      <nav className="marketing-breadcrumbs" aria-label="Breadcrumb"><a href="/docs">Docs</a><span aria-hidden="true">/</span><span>Getting started</span></nav>
      <section className="marketing-start-hero" aria-labelledby="getting-started-title">
        <div><span className="marketing-eyebrow">The shortest useful path</span><h1 id="getting-started-title">Bring one real skill through a <em>deliberate release</em> path.</h1><p>Use this guide to evaluate the workflow with an engineering teammate: open a workspace, choose a source, inspect scan evidence, create a pack if needed, and install the approved release.</p><div className="marketing-hero-actions"><a className="marketing-button marketing-button-primary" href="/demo">Open the demo <span aria-hidden="true">↗</span></a><a className="marketing-hero-link" href={appLoginHref()}>Open app sign-in <span aria-hidden="true">→</span></a></div></div>
        <aside className="marketing-start-aside"><strong>Before you begin</strong><p>You will need access to an application workspace (or a local checkout for operator setup), a source if you plan to pull through, and a selected agent scope such as Codex, Claude, or Universal. The CLI currently uses a scoped token on stdin.</p></aside>
      </section>

      <section className="marketing-start-paths" aria-labelledby="getting-started-path-title">
        <div className="marketing-start-path-heading"><span className="marketing-eyebrow">Choose your starting point</span><h2 id="getting-started-path-title">Application workspace or local operator setup?</h2><p>If your team already has an application workspace, start there. An operator setting up a disposable local demo has a separate path below.</p></div>
        <div className="marketing-start-path-grid">
          <article className="marketing-start-path-card marketing-start-path-card-primary"><span className="marketing-feature-index">01 / APPLICATION WORKSPACE</span><h3>Open the application workspace</h3><p>If your team already has access, open application sign-in and complete the workspace steps shown there. Then obtain a scoped CLI token from the workspace. This marketing site does not create accounts or collect credentials.</p><div className="marketing-start-path-actions"><a className="marketing-button marketing-button-primary" href={appLoginHref()}>Open app sign-in <span aria-hidden="true">↗</span></a><a className="marketing-text-link" href="#cli">Jump to CLI setup <span aria-hidden="true">↓</span></a></div></article>
          <article className="marketing-start-path-card"><span className="marketing-feature-index">02 / SELF-HOST OPERATOR</span><h3>Run a local disposable demo</h3><p>Use this only when you operate the repository locally. The flag permits an unscanned local setup for evaluation; it is not a production release policy.</p><div className="marketing-start-code"><pre><code>pnpm setup:dev --allow-unscanned{ '\n' }pnpm dev</code></pre></div><p className="marketing-start-path-note">For a policy-enforced local setup, configure the scanner worker and run setup without the disposable flag before publishing.</p></article>
        </div>
      </section>

      <CliReleaseChooser />

      <div className="marketing-start-content">
        <div className="marketing-start-steps">
          <section className="marketing-start-step" id="setup"><span className="marketing-start-step-number">01</span><div className="marketing-start-step-copy"><h2>Open the application workspace</h2><p>For an application workspace, start with the app sign-in above and complete the steps shown there. For local operator work, use the separate disposable setup card; the two paths have different responsibilities and credentials.</p></div></section>
          <section className="marketing-start-step" id="policy"><span className="marketing-start-step-number">02</span><div className="marketing-start-step-copy"><h2>Set a policy before content arrives</h2><p>Keep required scanner decisions explicit. A production policy denies distribution when required evidence is missing, stale, truncated, or blocked. The disposable demo flag is for local evaluation only.</p><div className="marketing-start-code"><pre><code><span className="comment"># inspect the registry health endpoint</span>{'\n'}curl --fail http://localhost:5173/health</code></pre></div></div></section>
          <section className="marketing-start-step" id="source"><span className="marketing-start-step-number">03</span><div className="marketing-start-step-copy"><h2>Resolve one source identity</h2><p>Search a connected catalog, inspect the source record, and request a pull-through. The registry validates the complete bundle and keeps source provenance attached to the candidate.</p><div className="marketing-start-code"><pre><code>pskills sources search --source skills-sh &quot;frontend&quot;{ '\n' }pskills show @team/web-guidelines</code></pre></div></div></section>
          <section className="marketing-start-step" id="review"><span className="marketing-start-step-number">04</span><div className="marketing-start-step-copy"><h2>Review the release decision</h2><p>Look for the release identity, source revision, artifact digest, policy revision, and scanner evidence. Your policy can admit a release after required evidence passes; a separate review gate can require a human decision. A required failure keeps the release unavailable.</p><div className="marketing-start-code"><pre><code>pskills scan status sha256:&lt;release-digest&gt;{ '\n' }pskills pack show @team/frontend</code></pre></div></div></section>
          <section className="marketing-start-step" id="cli"><span className="marketing-start-step-number">05</span><div className="marketing-start-step-copy"><h2>Install the approved plan</h2><p>Download the reviewed <code>pskills</code> archive above from your company session, then authenticate it with the scoped credential from your workspace. Select an agent scope and install the approved release or pack. Frozen installs use the lock metadata rather than resolving a new version.</p><div className="marketing-start-code"><pre><code>pskills login --registry &lt;registry-url&gt; --token-stdin{ '\n' }pskills install @team/web-guidelines@1.2.0 --agent codex{ '\n' }pskills --frozen-lockfile install @team/web-guidelines@1.2.0 --agent codex</code></pre></div></div></section>
          <div className="marketing-start-success"><strong>What a good first run leaves behind</strong><span>A named release, source provenance, current scan evidence, a visible policy decision, and an install plan that another engineer can reproduce.</span></div>
          <section className="marketing-start-step" id="boundaries"><span className="marketing-start-step-number">06</span><div className="marketing-start-step-copy"><h2>Keep the boundaries in the review</h2><p>Skill content stays data during ingestion and scanning. The registry does not execute uploaded scripts or install hooks. Eve's review tool records a proposal for a human decision; it is advisory unless your policy adds a review gate. In the builder, a person can ask Eve to apply a chosen change to a draft. That authoring action is separate from publishing, merging, and installation authorization.</p></div></section>
          <section className="marketing-start-step" id="rollout"><span className="marketing-start-step-number">07</span><div className="marketing-start-step-copy"><h2>Plan the next team</h2><p>When the first workflow is clear, decide which teams need access and whether a fixed pack should become the shared install plan. Open app sign-in to continue when the workspace is ready.</p><a className="marketing-button marketing-button-primary" href={appLoginHref()}>Open app sign-in <span aria-hidden="true">↗</span></a></div></section>
        </div>
        <aside className="marketing-start-checklist" aria-label="Getting started sections"><h2>Guide sections</h2><a href="/demo">Demo walkthrough</a><a href="#setup">Application workspace</a><a href="#policy">Policy first</a><a href="#source">Source identity</a><a href="#review">Review decision</a><a href="#cli-downloads">Download the CLI</a><a href="#cli">Approved install</a><a href="#boundaries">Boundaries</a><a href="#rollout">Next team</a><div className="marketing-start-callout"><strong>Need the pricing preview?</strong><span><a href="/pricing">Compare the preview and rollout shapes ↗</a></span></div></aside>
      </div>
  </div>
}
