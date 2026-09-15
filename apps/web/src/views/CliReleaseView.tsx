import { useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import type {
  CliReleaseAvailability,
  CliReleaseTarget,
  PublicCliReleaseAsset,
  PublicCliReleaseManifest,
} from '../../../../packages/cli-release/src/index.js'
import { CLI_RELEASE_TARGETS } from '../../../../packages/cli-release/src/index.js'
import { api, ApiError } from '../lib/api'
import { useAuth } from '../lib/auth'
import { Badge, Button, ErrorState, LoadingState, Notice, Panel } from '../components/Primitives'

type DownloadState = 'idle' | 'downloading' | 'started'

const DEFAULT_TARGET: CliReleaseTarget = 'aarch64-apple-darwin'

function targetLabel(target: CliReleaseTarget): string {
  return CLI_RELEASE_TARGETS.find((definition) => definition.target === target)?.label ?? target
}

function availabilityLabel(availability: CliReleaseAvailability): string {
  if (availability === 'ready') return 'Ready for download'
  if (availability === 'unprovisioned') return 'Not provisioned'
  return 'Availability not confirmed'
}

function availabilityTone(availability: CliReleaseAvailability): 'good' | 'warn' | 'muted' {
  return availability === 'ready' ? 'good' : availability === 'unprovisioned' ? 'warn' : 'muted'
}

async function downloadFailureMessage(response: Response): Promise<string> {
  let payload: unknown = undefined
  try { payload = await response.json() } catch { /* The gateway may return an empty error body. */ }
  const code = typeof payload === 'object' && payload !== null && 'code' in payload && typeof payload.code === 'string'
    ? payload.code
    : undefined
  if (response.status === 401) return 'Your company session has expired. Sign in again to download this release.'
  if (response.status === 403) return 'Your company role or credential does not include CLI download access. Ask an owner or administrator.'
  if (response.status === 503 || code === 'CLI_RELEASE_UNAVAILABLE') return 'This release is pinned, but its private archive is not available yet. Contact your platform administrator through your configured support path.'
  if (response.status === 502 || code === 'CLI_RELEASE_INTEGRITY') return 'The registry rejected this archive because its bytes did not match the pinned release digest. Contact your platform administrator through your configured support path.'
  return 'The registry could not start this download. Try again or ask an owner to check the release storage.'
}

async function startBrowserDownload(response: Response, filename: string): Promise<void> {
  const blob = await response.blob()
  const href = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = href
  link.download = filename
  link.rel = 'nofollow'
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(href), 0)
}

/** Authenticated company chooser for private CLI release archives. */
export function CliReleaseView({ initialTarget }: { initialTarget?: CliReleaseTarget }) {
  const { principal, session } = useAuth()
  const [manifest, setManifest] = useState<PublicCliReleaseManifest | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedTarget, setSelectedTarget] = useState<CliReleaseTarget>(initialTarget ?? DEFAULT_TARGET)
  const [downloadState, setDownloadState] = useState<DownloadState>('idle')
  const [downloadMessage, setDownloadMessage] = useState<string | null>(null)
  const loadGeneration = useRef(0)
  const companyName = session?.activeOrganization?.name ?? principal?.display?.organizationName ?? 'your company'

  useEffect(() => {
    if (initialTarget) setSelectedTarget(initialTarget)
  }, [initialTarget])

  async function load() {
    const generation = ++loadGeneration.current
    setError(null)
    try {
      const next = await api.cliReleaseManifest()
      if (generation !== loadGeneration.current) return
      setManifest(next)
      setSelectedTarget((current) => next.assets.some((asset) => asset.target === current) ? current : next.assets[0]?.target ?? DEFAULT_TARGET)
    } catch (cause) {
      if (generation !== loadGeneration.current) return
      setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not load the company CLI release catalog.')
    }
  }

  useEffect(() => {
    void load()
    return () => { ++loadGeneration.current }
  }, [])

  async function download(asset: PublicCliReleaseAsset | undefined) {
    if (!asset || asset.availability !== 'ready' || downloadState === 'downloading') return
    let started = false
    setDownloadState('downloading')
    setDownloadMessage(null)
    try {
      const response = await api.cliReleaseDownload(manifest!.version, asset.target)
      if (!response.ok) {
        setDownloadMessage(await downloadFailureMessage(response))
        return
      }
      await startBrowserDownload(response, asset.filename)
      started = true
      setDownloadState('started')
      setDownloadMessage(`Download started for ${asset.filename}.`)
    } catch (cause) {
      setDownloadMessage(cause instanceof Error ? cause.message : 'The download could not be started.')
    } finally {
      if (!started) setDownloadState('idle')
    }
  }

  if (error) return <div className="view-heading cli-release-view"><header className="page-intro"><div><span className="eyebrow">Company tools</span><h1>Download the CLI</h1><p className="muted">Private release archives for {companyName}.</p></div><Link className="button button-secondary" to="/app">Back to overview</Link></header><ErrorState message={error} onRetry={() => void load()} /></div>
  if (!manifest) return <div className="view-heading cli-release-view"><header className="page-intro"><div><span className="eyebrow">Company tools</span><h1>Download the CLI</h1><p className="muted">Checking the private release catalog for {companyName}.</p></div></header><Panel><LoadingState label="Loading company release options…" /></Panel></div>

  const selected = manifest.assets.find((asset) => asset.target === selectedTarget)
  const selectedDefinition = CLI_RELEASE_TARGETS.find((definition) => definition.target === selectedTarget)
  const selectedAvailability = selected?.availability ?? 'unprovisioned'
  const canDownload = selectedAvailability === 'ready'

  return <div className="view-heading cli-release-view">
    <header className="page-intro">
      <div>
        <span className="eyebrow">Company tools</span>
        <h1>Download the CLI</h1>
        <p className="muted">Choose a package for {companyName}. The registry checks your company session before it serves the private archive.</p>
      </div>
      <Link className="button button-secondary" to="/app">Back to overview</Link>
    </header>

    <Panel className="cli-release-panel" title={`Private Skills CLI v${manifest.version}`} description="The app serves only verified bytes registered in this company’s private storage.">
      <div className="cli-release-targets" aria-label="CLI platform" role="group">
        {CLI_RELEASE_TARGETS.map((definition) => {
          const asset = manifest.assets.find((candidate) => candidate.target === definition.target)
          const isSelected = definition.target === selectedTarget
          const availability = asset?.availability ?? 'unprovisioned'
          return <button aria-pressed={isSelected} className={`cli-release-target${isSelected ? ' cli-release-target-active' : ''}`} key={definition.target} type="button" onClick={() => { setSelectedTarget(definition.target); setDownloadMessage(null); setDownloadState('idle') }}>
            <span className="cli-release-target-name">{definition.shortLabel}</span>
            <span className="cli-release-target-status"><span className={`cli-release-status-dot cli-release-status-${availability}`} aria-hidden="true" />{availability === 'ready' ? 'Ready' : availability === 'unprovisioned' ? 'Not provisioned' : 'Check on download'}</span>
          </button>
        })}
      </div>

      <div className="cli-release-detail">
        <div className="cli-release-detail-heading">
          <div><span className="eyebrow">Selected package</span><h2>{selectedDefinition?.label ?? targetLabel(selectedTarget)}</h2><p className="muted">{selected?.verification === 'native-smoke-verified' ? 'Apple Silicon macOS smoke evidence is recorded for this archive.' : 'The archive digest and member shape are verified; native Linux/Windows testing is pending for this delivery.'}</p></div>
          <Badge tone={availabilityTone(selectedAvailability)} value={availabilityLabel(selectedAvailability)} />
        </div>

        {selected ? <dl className="cli-release-meta"><div><dt>Version</dt><dd>v{manifest.version}</dd></div><div><dt>Archive</dt><dd><code>{selected.filename}</code></dd></div><div><dt>Size</dt><dd>{selected.size.toLocaleString()} bytes</dd></div><div><dt>SHA-256</dt><dd><code>{selected.digest}</code></dd></div></dl> : <Notice kind="info">This platform is not included in the current company release catalog.</Notice>}

        {selectedAvailability === 'unprovisioned' && <Notice kind="info">This package is pinned in the release catalog, but its private archive is not available yet. Downloads stay disabled until platform provisioning is complete. Contact your platform administrator through your configured support path.</Notice>}
        {selectedAvailability === 'unknown' && <Notice kind="info">The registry has not confirmed storage availability for this package. Downloads stay disabled until the server reports it ready.</Notice>}
        {downloadMessage && <Notice kind={downloadState === 'started' ? 'success' : 'error'}>{downloadMessage}</Notice>}
        <div className="cli-release-actions"><Button disabled={!canDownload} busy={downloadState === 'downloading'} onClick={() => void download(selected)}>Download {selected?.filename ?? 'archive'}</Button><span className="helper">Your browser receives the archive only after the company session and release digest checks pass.</span></div>
      </div>
    </Panel>

    <Panel className="cli-release-boundary" title="Release qualification" description="The release inventory and verification notes are pinned by the registry operator.">
      <div className="cli-release-boundary-grid"><div><strong>Apple Silicon macOS</strong><span>Native smoke verified for v{manifest.version}.</span></div><div><strong>Linux x86_64 and Windows x86_64</strong><span>Archive checksums are verified; native testing is pending for this delivery.</span></div><div><strong>Private source</strong><span>Source repository and storage keys remain server-side.</span></div></div>
    </Panel>
  </div>
}
