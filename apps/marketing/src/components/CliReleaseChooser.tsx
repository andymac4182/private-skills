import { useState } from 'react'
import {
  CLI_RELEASE_TARGETS,
  PINNED_CLI_RELEASE_MANIFEST,
  type CliReleaseTarget,
} from '../../../../packages/cli-release/src/index.js'
import { appCliReleaseChooserHref, appLoginHref } from '../lib/appHref'

const release = PINNED_CLI_RELEASE_MANIFEST

function verificationCopy(target: CliReleaseTarget): string {
  return release.verification.nativeProofTargets.includes(target)
    ? 'Apple Silicon macOS check recorded'
    : 'Archive integrity verified · native Linux/Windows validation pending'
}

/** Public documentation chooser for authenticated private CLI downloads. */
export function CliReleaseChooser() {
  const [selectedTarget, setSelectedTarget] = useState<CliReleaseTarget>('aarch64-apple-darwin')
  const selected = release.assets.find((asset) => asset.target === selectedTarget)

  return (
    <section className="marketing-cli-chooser" id="cli-downloads" aria-labelledby="cli-downloads-title">
      <div className="marketing-cli-heading">
        <div>
          <span className="marketing-eyebrow">Private binary distribution</span>
          <h2 id="cli-downloads-title">Get <code>pskills</code> without cloning the repository.</h2>
        </div>
        <p>Choose your machine, then open the company workspace to check access and start a private download.</p>
      </div>

      <div className="marketing-cli-tabs" aria-label="CLI platform" role="group">
        {CLI_RELEASE_TARGETS.map((target) => {
          const selectedTab = target.target === selectedTarget
          return (
            <button
              aria-pressed={selectedTab}
              className={selectedTab ? 'marketing-cli-tab marketing-cli-tab-active' : 'marketing-cli-tab'}
              key={target.target}
              onClick={() => setSelectedTarget(target.target)}
              type="button"
            >
              <span>{target.shortLabel}</span>
            </button>
          )
        })}
      </div>

      <div
        className="marketing-cli-panel"
        id="cli-release-panel"
      >
        {selected ? (
          <>
            <div className="marketing-cli-panel-copy">
              <span className="marketing-feature-index">Private release v{release.version}</span>
              <h3>{CLI_RELEASE_TARGETS.find((target) => target.target === selected.target)?.label}</h3>
              <p>{verificationCopy(selected.target)}. Intel Mac is not included in this release.</p>
            </div>
            <div className="marketing-cli-panel-actions">
              <a className="marketing-button marketing-button-primary" href={appCliReleaseChooserHref(selected.target)}>
                Open company download chooser <span aria-hidden="true">↗</span>
              </a>
              <a className="marketing-button marketing-button-secondary" href={appLoginHref(`/app/cli?target=${encodeURIComponent(selected.target)}`)}>
                Open company sign-in <span aria-hidden="true">↗</span>
              </a>
            </div>
            <details className="marketing-cli-details">
              <summary>Technical release details</summary>
              <dl className="marketing-cli-meta">
                <div><dt>Archive</dt><dd>{selected.filename}</dd></div>
                <div><dt>Size</dt><dd>{selected.size.toLocaleString()} bytes</dd></div>
                <div><dt>SHA-256</dt><dd>{selected.digest}</dd></div>
              </dl>
            </details>
          </>
        ) : (
          <p>This platform is not packaged in the current release.</p>
        )}
      </div>

      <p className="marketing-cli-note">
        <strong>Verification boundary.</strong> v{release.version} archive checksums and member shapes were verified from the private release. Apple Silicon macOS has a native smoke check; Linux and Windows native validation is pending for this delivery. The company workspace reports whether each private archive is provisioned.
      </p>
    </section>
  )
}
