import { createFileRoute } from '@tanstack/react-router'
import { appLoginHref } from '../lib/appHref'

export const Route = createFileRoute('/docs/getting-started')({
  head: () => ({
    meta: [
      { title: 'Getting started · Private Skills' },
      { name: 'description', content: 'Set up a first Private Skills registry workflow, configure policy, and install an approved release.' },
    ],
  }),
  component: GettingStartedPage,
})

function GettingStartedPage() {
  return <div className="marketing-start-layout">
      <nav className="marketing-breadcrumbs" aria-label="Breadcrumb"><a href="/docs">Docs</a><span aria-hidden="true">/</span><span>Getting started</span></nav>
      <section className="marketing-start-hero" aria-labelledby="getting-started-title">
        <div><span className="marketing-eyebrow">The shortest useful path</span><h1 id="getting-started-title">Bring one real skill through a <em>deliberate release</em> path.</h1><p>Use this guide to evaluate the workflow with an engineering teammate: configure the registry, choose a source, inspect scan evidence, create a pack if needed, and install the approved release.</p></div>
        <aside className="marketing-start-aside"><strong>Before you begin</strong><p>You will need a deployment profile, a provider sign-in, a company to work in, a configured source if you plan to pull through, and a selected agent scope such as Codex or Claude. First-time sign-in continues to company setup when needed.</p></aside>
      </section>

      <div className="marketing-start-content">
        <div className="marketing-start-steps">
          <section className="marketing-start-step" id="setup"><span className="marketing-start-step-number">01</span><div className="marketing-start-step-copy"><h2>Choose the registry shape</h2><p>Start with the environment your team can operate and verify. Node/container and edge Nitro profiles are supported in the architecture; storage, scanner, and source credentials remain deployment inputs.</p><div className="marketing-start-code"><pre><code><span className="comment"># local disposable demo</span>{'\n'}pnpm setup:dev --allow-unscanned{ '\n' }pnpm dev</code></pre></div></div></section>
          <section className="marketing-start-step" id="policy"><span className="marketing-start-step-number">02</span><div className="marketing-start-step-copy"><h2>Set a policy before content arrives</h2><p>Keep required scanner decisions explicit. A production policy denies distribution when required evidence is missing, stale, truncated, or blocked. The disposable demo flag is for local evaluation only.</p><div className="marketing-start-code"><pre><code><span className="comment"># inspect the registry health endpoint</span>{'\n'}curl --fail http://localhost:5173/health</code></pre></div></div></section>
          <section className="marketing-start-step" id="source"><span className="marketing-start-step-number">03</span><div className="marketing-start-step-copy"><h2>Resolve one source identity</h2><p>Search a configured catalog, inspect the source record, and request a pull-through. The registry validates the complete bundle and keeps source provenance attached to the candidate.</p><div className="marketing-start-code"><pre><code>pskills search --source skills-sh &quot;frontend&quot;{ '\n' }pskills show @team/web-guidelines</code></pre></div></div></section>
          <section className="marketing-start-step" id="review"><span className="marketing-start-step-number">04</span><div className="marketing-start-step-copy"><h2>Review the release decision</h2><p>Look for the release identity, source revision, artifact digest, policy revision, and scanner evidence. A release is available only when the configured policy admits it.</p><div className="marketing-start-code"><pre><code>pskills scan report @team/web-guidelines{ '\n' }pskills pack show @team/frontend</code></pre></div></div></section>
          <section className="marketing-start-step" id="cli"><span className="marketing-start-step-number">05</span><div className="marketing-start-step-copy"><h2>Install the approved plan</h2><p>Authenticate the CLI with the scoped credential from your workspace, select an agent scope, and install the approved release or pack. Frozen installs use the lock metadata rather than resolving a new version.</p><div className="marketing-start-code"><pre><code>pskills login --registry &lt;registry-url&gt; --token-stdin{ '\n' }pskills install @team/web-guidelines@1.2.0 --agent codex{ '\n' }pskills install --frozen-lockfile</code></pre></div></div></section>
          <div className="marketing-start-success"><strong>What a good first run leaves behind</strong><span>A named release, source provenance, current scan evidence, a visible policy decision, and an install plan that another engineer can reproduce.</span></div>
          <section className="marketing-start-step" id="boundaries"><span className="marketing-start-step-number">06</span><div className="marketing-start-step-copy"><h2>Keep the boundaries in the review</h2><p>Skill content stays data during ingestion and scanning. The registry does not execute uploaded scripts or install hooks. Eve's review tool records a proposal for a human decision; the builder can apply a chosen change to a draft after you ask it to. That authoring action is separate from publishing, merging, and installation authorization.</p></div></section>
          <section className="marketing-start-step" id="rollout"><span className="marketing-start-step-number">07</span><div className="marketing-start-step-copy"><h2>Plan the next company team</h2><p>When the first workflow is clear, decide which teams need source access, which scanner modes are required, and whether fixed packs should become the shared interface. Sign in through your provider to create or choose a company, then continue from the registry onboarding view.</p><a className="marketing-button marketing-button-primary" href={appLoginHref()}>Sign in and set up a company <span aria-hidden="true">↗</span></a></div></section>
        </div>
        <aside className="marketing-start-checklist" aria-label="Getting started sections"><h2>Guide sections</h2><a href="#setup">Registry setup</a><a href="#policy">Policy first</a><a href="#source">Source identity</a><a href="#review">Review decision</a><a href="#cli">Approved install</a><a href="#boundaries">Boundaries</a><a href="#rollout">Next company team</a><div className="marketing-start-callout"><strong>Need the pricing preview?</strong><span><a href="/pricing">Compare the preview and rollout shapes ↗</a></span></div></aside>
      </div>
  </div>
}
