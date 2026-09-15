import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/docs/')({
  head: () => ({
    meta: [
      { title: 'Docs · Private Skills' },
      { name: 'description', content: 'Start and evaluate a Private Skills registry workflow with the rollout and CLI guide.' },
    ],
  }),
  component: DocsPage,
})

function DocsPage() {
  return <div className="marketing-docs-layout">
    <article className="marketing-docs-main">
      <span className="marketing-eyebrow">Private Skills documentation</span>
      <h1>Make the first <em>approved install</em> easy to explain.</h1>
      <p>These pages cover the smallest useful path from registry setup to a repeatable skill install. They also explain the product boundaries, so an engineering team can evaluate the workflow before it depends on a larger rollout.</p>
      <div className="marketing-docs-cards">
        <a className="marketing-doc-card" href="/docs/getting-started"><span className="marketing-doc-card-index">01 / START HERE</span><h2>Getting started</h2><p>Choose a deployment profile, set a policy, bring in one source, and install one approved release with the CLI.</p><span>Open the guide ↗</span></a>
        <a className="marketing-doc-card" href="/docs/getting-started#boundaries"><span className="marketing-doc-card-index">02 / TRUST MODEL</span><h2>Product boundaries</h2><p>Understand source identity, scanner decisions, sealed artifacts, no-execution handling, and the human review line.</p><span>Read the boundaries ↗</span></a>
        <a className="marketing-doc-card" href="/docs/getting-started#cli"><span className="marketing-doc-card-index">03 / CLI</span><h2>Install workflow</h2><p>See the commands for login, discovery, release selection, pack operations, and frozen reproduction.</p><span>See the CLI path ↗</span></a>
        <a className="marketing-doc-card" href="/pricing"><span className="marketing-doc-card-index">04 / EVALUATE</span><h2>Plans and rollout</h2><p>Compare the pricing preview and decide which team should run the first real workflow.</p><span>View pricing preview ↗</span></a>
      </div>
      <div className="marketing-docs-note"><strong>Current product status</strong><span>The public pages describe the implemented registry, pull-through, packs, and Eve features. Source availability, scanner configuration, and deployment evidence still depend on the environment you choose.</span></div>
    </article>
    <aside className="marketing-docs-sidebar" aria-label="Documentation navigation"><strong>On this page</strong><a aria-current="page" href="/docs">Docs overview</a><a href="/docs/getting-started">Getting started</a><a href="/docs/getting-started#cli">CLI workflow</a><a href="/docs/getting-started#boundaries">Boundaries</a><a href="/pricing">Pricing preview</a></aside>
  </div>
}
