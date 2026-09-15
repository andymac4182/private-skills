import { useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { appLoginHref } from '../lib/appHref'
import { brand } from '../lib/brand'
import '../styles/public-marketing.css'

interface PublicLayoutProps {
  children: ReactNode
  current?: 'home' | 'product' | 'demo' | 'pricing' | 'docs' | 'faq' | 'legal' | 'contact'
}

export function PublicLogo({ compact = false }: { compact?: boolean }) {
  return <span className="marketing-logo" aria-label={compact ? undefined : brand.name}>
    <span aria-hidden="true" className="marketing-logo-mark">{brand.shortName}</span>
    {!compact && <span className="marketing-logo-copy"><strong>{brand.name}</strong><small>{brand.descriptor}</small></span>}
  </span>
}

export function PublicLayout({ children, current }: PublicLayoutProps) {
  return <div className="marketing-shell">
    <a className="marketing-skip-link" href="#main-content">Skip to content</a>
    <header className="marketing-header">
      <a className="marketing-brand-link" href="/" aria-label={`${brand.name} home`}><PublicLogo /></a>
      <nav className="marketing-nav" aria-label="Public navigation">
        <a aria-current={current === 'product' ? 'page' : undefined} className={current === 'product' ? 'marketing-nav-active' : ''} href="/product">Product</a>
        <a href="/product#how-it-works">How it works</a>
        <a aria-current={current === 'demo' ? 'page' : undefined} className={current === 'demo' ? 'marketing-nav-active' : ''} href="/demo">Demo</a>
        <a aria-current={current === 'pricing' ? 'page' : undefined} className={current === 'pricing' ? 'marketing-nav-active' : ''} href="/pricing">Pricing</a>
        <a aria-current={current === 'docs' ? 'page' : undefined} className={current === 'docs' ? 'marketing-nav-active' : ''} href="/docs">Docs</a>
        <a aria-current={current === 'faq' ? 'page' : undefined} className={current === 'faq' ? 'marketing-nav-active' : ''} href="/faq">FAQ</a>
        <a aria-current={current === 'contact' ? 'page' : undefined} className={current === 'contact' ? 'marketing-nav-active' : ''} href="/contact">Contact</a>
      </nav>
      <div className="marketing-header-actions">
        <a className="marketing-button marketing-button-primary marketing-button-small" href={appLoginHref()}>Open app sign-in <span aria-hidden="true">↗</span></a>
      </div>
    </header>
    <main id="main-content" tabIndex={-1}>{children}</main>
    <MarketingFooter />
  </div>
}

function handleTabKeyDown(
  event: KeyboardEvent<HTMLButtonElement>,
  index: number,
  count: number,
  tabIdPrefix: string,
  select: (nextIndex: number) => void,
) {
  let nextIndex: number | undefined
  if (event.key === 'ArrowRight') nextIndex = (index + 1) % count
  if (event.key === 'ArrowLeft') nextIndex = (index - 1 + count) % count
  if (event.key === 'Home') nextIndex = 0
  if (event.key === 'End') nextIndex = count - 1
  if (nextIndex === undefined) return

  event.preventDefault()
  select(nextIndex)
  document.getElementById(`${tabIdPrefix}-${nextIndex}`)?.focus()
}

export function ProductFlowDemo() {
  const [activeStep, setActiveStep] = useState(0)
  const steps = [
    {
      number: '01',
      label: 'Source',
      title: 'Bring the source into view',
      description: 'Search a connected catalog and confirm the source record before any bytes enter your registry.',
      code: 'pskills sources search --source skills-sh "release notes"',
      status: 'Metadata only',
    },
    {
      number: '02',
      label: 'Scan',
      title: 'Check the candidate',
      description: 'The registry validates the bundle and records scanner evidence. Your policy can admit a release after required checks or route it through a separate review gate. A required failure keeps it unavailable.',
      code: 'pskills scan status sha256:<release-digest>',
      status: 'Policy gate',
    },
    {
      number: '03',
      label: 'Pack',
      title: 'Make the install repeatable',
      description: 'Group releases that pass your policy into a fixed pack so the team can review one deliberate install plan.',
      code: 'pskills pack show @team/frontend',
      status: 'Selected releases',
    },
    {
      number: '04',
      label: 'Install',
      title: 'Install an approved release',
      description: 'The CLI requests an authorization for the resolved plan, verifies the final digest, and writes to the selected agent scope.',
      code: 'pskills install @team/release@1.2.0 --agent codex',
      status: 'Authorized transfer',
    },
  ] as const
  const step = steps[activeStep]

  return <section className="marketing-demo" aria-labelledby="flow-demo-title">
    <div className="marketing-demo-heading">
      <div>
        <span className="marketing-eyebrow">Product walkthrough</span>
        <h3 id="flow-demo-title">From source to install, with a decision at every handoff.</h3>
      </div>
      <span className="marketing-demo-badge"><span aria-hidden="true" className="marketing-status-dot" />Example flow</span>
    </div>
    <div className="marketing-demo-tabs" role="tablist" aria-label="Release pathway steps">
      {steps.map((item, index) => <button
        aria-controls="marketing-demo-panel"
        aria-selected={activeStep === index}
        className={activeStep === index ? 'marketing-demo-tab marketing-demo-tab-active' : 'marketing-demo-tab'}
        id={`marketing-demo-tab-${index}`}
        key={item.number}
        onClick={() => setActiveStep(index)}
        onKeyDown={event => handleTabKeyDown(event, index, steps.length, 'marketing-demo-tab', nextIndex => setActiveStep(nextIndex))}
        role="tab"
        tabIndex={activeStep === index ? 0 : -1}
        type="button"
      >
        <span className="marketing-demo-tab-number">{item.number}</span>
        <span>{item.label}</span>
      </button>)}
    </div>
    <div aria-labelledby={`marketing-demo-tab-${activeStep}`} className="marketing-demo-panel" id="marketing-demo-panel" role="tabpanel" tabIndex={0}>
      <div className="marketing-demo-panel-copy">
        <span className="marketing-demo-step-label">{step.status}</span>
        <h4>{step.title}</h4>
        <p>{step.description}</p>
      </div>
      <div className="marketing-code-window">
        <div className="marketing-code-window-bar"><span /><span /><span /><small>terminal · example</small></div>
        <pre><code><span className="marketing-code-prompt">$</span> {step.code}</code></pre>
      </div>
    </div>
  </section>
}

export function InstallWalkthrough() {
  const [activeStep, setActiveStep] = useState(0)
  const [copied, setCopied] = useState(false)
  const steps = [
    { label: 'Discover', title: 'Start with a known source', code: 'pskills sources search --source skills-sh "frontend"', note: 'Compare metadata before requesting a pull-through.' },
    { label: 'Inspect', title: 'Choose a release', code: 'pskills show @team/web-guidelines', note: 'Keep the source identity and scan status in view.' },
    { label: 'Install', title: 'Install into an agent scope', code: 'pskills install @team/web-guidelines@1.2.0 --agent codex', note: 'The final authorization is checked immediately before activation.' },
  ] as const
  const step = steps[activeStep]

  async function copyCommand() {
    if (typeof navigator === 'undefined') return
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(step.code)
      } else {
        const textArea = document.createElement('textarea')
        textArea.value = step.code
        textArea.setAttribute('readonly', '')
        textArea.style.position = 'fixed'
        textArea.style.opacity = '0'
        document.body.append(textArea)
        textArea.select()
        const copiedWithFallback = document.execCommand('copy')
        textArea.remove()
        if (!copiedWithFallback) return
      }
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setCopied(false)
    }
  }

  return <section className="marketing-install" aria-labelledby="install-walkthrough-title">
    <div className="marketing-install-intro">
      <span className="marketing-eyebrow">A small, useful view</span>
      <h3 id="install-walkthrough-title">Your install command stays boring.</h3>
      <p>Discovery, policy, and provenance live around the command. The project gets a deliberate skill directory it can reproduce.</p>
      <a className="marketing-text-link" href="/docs/getting-started">Read the CLI path <span aria-hidden="true">↗</span></a>
    </div>
    <div className="marketing-install-card">
      <div className="marketing-install-tabs" role="tablist" aria-label="CLI walkthrough">
        {steps.map((item, index) => <button
          aria-controls="marketing-install-panel"
          aria-selected={activeStep === index}
          className={activeStep === index ? 'marketing-install-tab marketing-install-tab-active' : 'marketing-install-tab'}
          id={`marketing-install-tab-${index}`}
          key={item.label}
          onClick={() => { setActiveStep(index); setCopied(false) }}
          onKeyDown={event => handleTabKeyDown(event, index, steps.length, 'marketing-install-tab', nextIndex => { setActiveStep(nextIndex); setCopied(false) })}
          role="tab"
          tabIndex={activeStep === index ? 0 : -1}
          type="button"
        >{item.label}</button>)}
      </div>
      <div className="marketing-install-card-heading"><span className="marketing-terminal-mark" aria-hidden="true">›_</span><div><strong>{step.title}</strong><small>{step.note}</small></div></div>
      <div aria-labelledby={`marketing-install-tab-${activeStep}`} className="marketing-install-panel" id="marketing-install-panel" role="tabpanel" tabIndex={0}>
        <div className="marketing-install-command"><code>{step.code}</code><button aria-label={`Copy ${step.label.toLowerCase()} command`} className="marketing-copy-button" onClick={() => void copyCommand()} type="button">{copied ? 'Copied' : 'Copy'}</button></div>
      </div>
      <p className="marketing-install-caption">Example command · replace the source and release with your approved registry identity.</p>
    </div>
  </section>
}

function MarketingFooter() {
  return <footer className="marketing-footer">
    <div className="marketing-footer-cta">
      <div>
        <span className="marketing-eyebrow">Start with one real workflow</span>
        <h2>Start with one skill your team already needs.</h2>
        <p>Use the pilot guide to see the steps. If you already have an application workspace, open sign-in and continue there.</p>
      </div>
      <div className="marketing-footer-cta-actions">
        <a className="marketing-button marketing-button-primary" href="/docs/getting-started">Start with the pilot guide <span aria-hidden="true">↗</span></a>
        <a className="marketing-button marketing-button-secondary" href={appLoginHref()}>Open app sign-in</a>
      </div>
    </div>
    <div className="marketing-footer-grid">
      <div className="marketing-footer-brand"><a className="marketing-brand-link" href="/"><PublicLogo /></a><p>A clear release path for engineering teams rolling out AI-agent skills.</p></div>
      <div><span className="marketing-footer-label">Explore</span><a href="/product">Product</a><a href="/demo">Demo walkthrough</a><a href="/pricing">Pricing</a><a href="/docs">Docs</a><a href="/faq">FAQ</a><a href="/contact">Contact</a></div>
      <div><span className="marketing-footer-label">Get started</span><a href="/docs/getting-started">Pilot guide</a><a href={appLoginHref()}>Open app sign-in</a><a href="/docs/getting-started#rollout">Plan a rollout</a></div>
      <div><span className="marketing-footer-label">Plan the first run</span><span className="marketing-footer-note">Start with one source and one engineering team.</span><span className="marketing-footer-note">Required checks follow your policy; people control publishing.</span><a href="/legal#publication-status">Legal and privacy status</a></div>
    </div>
    <div className="marketing-footer-bottom"><span>© {new Date().getFullYear()} {brand.name}</span><span>Working name · launch preview</span></div>
  </footer>
}
