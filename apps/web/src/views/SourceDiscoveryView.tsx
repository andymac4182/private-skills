import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link } from '@tanstack/react-router'
import { api, ApiError } from '../lib/api'
import { quotePosix, quotePowerShell } from '../lib/shell'
import {
  SOURCE_PROVIDER_ORDER,
  matchesSourceIdentity,
  normalizeSourceQuery,
  sourceCanResolve,
  sourceCanSearch,
  sourceDescription,
  sourceLabel,
  sourceResultLabel,
  sourceStatusLabel,
  sourceStatusReason,
  sourceStatusTone,
  verifiedSourceLocator,
} from '../lib/sourceDiscovery'
import { useAuth } from '../lib/auth'
import type { Job, Principal, Resolution, SourceDescriptor, SourceSearchResult, SourceSearchResponse, SourceSearchStatus } from '../lib/types'
import { Badge, Button, EmptyState, ErrorState, LoadingState, Notice, Panel } from '../components/Primitives'

const allSources = 'all'
const sourceSearchLimit = 50

function hasProxyResolveScope(principal: Principal | null | undefined): boolean {
  if (!principal) return false
  if (principal.roles.some((role) => role === 'owner' || role === 'admin')) return true
  return principal.scopes?.some((scope) => scope === '*' || scope === 'proxy:*' || scope === 'proxy:resolve') ?? false
}

function sourceOrder(source: SourceDescriptor): number {
  const index = SOURCE_PROVIDER_ORDER.indexOf(source.id as (typeof SOURCE_PROVIDER_ORDER)[number])
  return index === -1 ? SOURCE_PROVIDER_ORDER.length : index
}

function sortSources(sources: SourceDescriptor[]): SourceDescriptor[] {
  return [...sources].sort((left, right) => sourceOrder(left) - sourceOrder(right) || left.label.localeCompare(right.label))
}

function sourceFailureMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : error instanceof Error ? error.message : fallback
}

function providerPageUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return undefined
    if (/\/(?:download|archive|raw)(?:\/|$)/iu.test(url.pathname)) return undefined
    return url.href
  } catch {
    return undefined
  }
}

export function SourceDiscoveryView() {
  const { principal } = useAuth()
  const [sources, setSources] = useState<SourceDescriptor[] | null>(null)
  const [sourceError, setSourceError] = useState<string | null>(null)
  const [selectedSource, setSelectedSource] = useState(allSources)
  const [query, setQuery] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState('')
  const [searchResponse, setSearchResponse] = useState<SourceSearchResponse | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  const [selectedResult, setSelectedResult] = useState<SourceSearchResult | null>(null)
  const searchGeneration = useRef(0)

  async function loadSources() {
    setSourceError(null)
    try {
      const response = await api.sources()
      setSources([...(response.sources ?? [])])
    } catch (cause) {
      setSources(null)
      setSourceError(sourceFailureMessage(cause, 'Could not load source providers.'))
    }
  }

  useEffect(() => { void loadSources() }, [])

  const orderedSources = useMemo(() => sortSources(sources ?? []), [sources])
  const selectedDescriptor = selectedSource === allSources ? undefined : sources?.find((source) => source.id === selectedSource)
  const canSearch = selectedSource === allSources
    ? orderedSources.some((source) => sourceCanSearch(source))
    : sourceCanSearch(selectedDescriptor)

  function chooseSource(source: string) {
    ++searchGeneration.current
    setSelectedSource(source)
    setSearchResponse(null)
    setSearchError(null)
    setSelectedResult(null)
    setSearching(false)
  }

  function clearSearch() {
    ++searchGeneration.current
    setQuery('')
    setSubmittedQuery('')
    setSearchResponse(null)
    setSearchError(null)
    setSelectedResult(null)
    setSearching(false)
  }

  async function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const normalized = normalizeSourceQuery(query)
    if ([...normalized].length < 2) {
      setSearchResponse(null)
      setSelectedResult(null)
      setSubmittedQuery('')
      setSearchError('Enter at least two characters to search source providers.')
      return
    }
    if (!canSearch) {
      setSearchResponse(null)
      setSelectedResult(null)
      setSubmittedQuery(normalized)
      setSearchError(selectedDescriptor
        ? `${selectedDescriptor.label} is ${sourceStatusLabel(selectedDescriptor.availability).toLowerCase()} and cannot be searched right now.`
        : 'No configured source provider can search right now.')
      return
    }
    setSubmittedQuery(normalized)
    setSearchError(null)
    setSearchResponse(null)
    setSelectedResult(null)
    setSearching(true)
    const generation = ++searchGeneration.current
    try {
      const response = await api.sourceSearch(normalized, { source: selectedSource === allSources ? undefined : selectedSource, limit: sourceSearchLimit })
      if (generation !== searchGeneration.current) return
      setSearchResponse(response)
    } catch (cause) {
      if (generation !== searchGeneration.current) return
      setSearchError(sourceFailureMessage(cause, 'Could not search source providers.'))
    } finally {
      if (generation === searchGeneration.current) setSearching(false)
    }
  }

  const results = searchResponse?.data ?? []
  const resultCount = results.length
  return <div className="view-heading source-discovery-view">
    <div className="page-intro">
      <div>
        <span className="eyebrow eyebrow-cloud">Source discovery</span>
        <h1>Find skills across configured sources.</h1>
        <p className="muted">Search configured providers, inspect source metadata, and request a private registry resolution. Every import still passes through the existing scan and approval flow.</p>
      </div>
      <div className="page-actions">
        <Link className="button button-secondary" params={{ section: 'directory' }} to="/app/$section">Browse skills.sh</Link>
        <Link className="button button-quiet" params={{ section: 'upstreams' }} to="/app/$section">Advanced upstreams</Link>
      </div>
    </div>

    <Panel className="source-discovery-toolbar" title="Choose where to search" description="Provider availability and credentials are reported by the registry. A disabled provider stays visible so its state is clear.">
      {sources === null && !sourceError ? <LoadingState label="Loading configured source providers…" /> : sourceError ? <ErrorState message={sourceError} onRetry={() => void loadSources()} /> : orderedSources.length === 0 ? <EmptyState title="No source providers configured" description="An administrator must configure a source adapter before this registry can search or import from it." /> : <div className="source-provider-picker" aria-label="Source providers" role="list">
        <button aria-pressed={selectedSource === allSources} className={`source-provider-option ${selectedSource === allSources ? 'source-provider-option-active' : ''}`.trim()} type="button" onClick={() => chooseSource(allSources)}>
          <span aria-hidden="true" className="source-provider-mark">ALL</span>
          <span className="source-provider-copy"><strong>All providers</strong><small>Search every available adapter</small></span>
          <span className="source-provider-state">{orderedSources.filter((source) => sourceCanSearch(source)).length} ready</span>
        </button>
        {orderedSources.map((source) => <SourceProviderOption key={source.id} source={source} selected={selectedSource === source.id} onSelect={() => chooseSource(source.id)} />)}
      </div>}
      <form className="source-search-form" onSubmit={(event) => void submitSearch(event)}>
        <label className="directory-search-label" htmlFor="source-discovery-search">Search configured sources</label>
        <div className="directory-search-row"><input id="source-discovery-search" onChange={(event) => setQuery(event.target.value)} placeholder="Search by skill name, capability, or description" value={query} /><Button busy={searching} disabled={sources === null || Boolean(sourceError) || orderedSources.length === 0 || !canSearch} type="submit">Search</Button>{submittedQuery && <Button kind="quiet" type="button" onClick={clearSearch}>Clear</Button>}</div>
        <small>Results are bounded provider metadata. Source bytes are fetched only after you request a registry resolution.</small>
      </form>
      {selectedDescriptor && <SourceSelectionNote source={selectedDescriptor} />}
    </Panel>

    {searchError && <ErrorState message={searchError} onRetry={submittedQuery ? () => { const form = document.getElementById('source-discovery-search')?.closest('form'); if (form) form.requestSubmit() } : undefined} />}
    {searching && <Panel><LoadingState label={`Searching ${selectedSource === allSources ? 'configured providers' : sourceLabel(selectedSource)}…`} /></Panel>}
    {!searching && searchResponse && <Panel title={`Results${submittedQuery ? ` for “${submittedQuery}”` : ''}`} description={`${resultCount} result${resultCount === 1 ? '' : 's'} returned. Select a result to inspect its source identity.`}>
      <SourceSearchStatuses statuses={[...searchResponse.sources]} />
      {results.length === 0 ? <EmptyState title="No source matches" description="Try a broader query or choose another available provider." /> : <div className="source-result-grid">{results.map((result) => <SourceResultCard key={`${result.sourceId}:${result.externalId}`} result={result} selected={selectedResult?.sourceId === result.sourceId && selectedResult.externalId === result.externalId} onSelect={() => setSelectedResult(result)} />)}</div>}
    </Panel>}
    {!searching && !searchResponse && !searchError && <Panel className="source-discovery-empty" title="Search to compare source options" description="A result keeps the provider identity and external ID needed for a safe, reviewable import request."><div className="source-discovery-empty-content"><span aria-hidden="true" className="source-discovery-empty-mark">⌕</span><p>Search across the providers above. The registry will show which provider responded and whether each result has only metadata or can be resolved through private scanning.</p></div></Panel>}
    {selectedResult && <SourceResolvePanel key={`${selectedResult.sourceId}:${selectedResult.externalId}`} principal={principal} result={selectedResult} source={sources?.find((candidate) => candidate.id === selectedResult.sourceId)} />}
  </div>
}

function SourceProviderOption({ source, selected, onSelect }: { source: SourceDescriptor; selected: boolean; onSelect: () => void }) {
  const statusReason = sourceStatusReason(source.availability)
  const status = source.availability.state === 'available' && !sourceCanSearch(source) ? 'Resolve only' : sourceStatusLabel(source.availability)
  return <button aria-pressed={selected} className={`source-provider-option ${selected ? 'source-provider-option-active' : ''}`.trim()} title={statusReason} type="button" onClick={onSelect}>
    <span aria-hidden="true" className="source-provider-mark">{source.label.replace(/[^A-Za-z0-9]/gu, '').slice(0, 2).toUpperCase() || 'S'}</span>
    <span className="source-provider-copy"><strong>{source.label}</strong><small>{sourceDescription(source)}</small></span>
    <Badge tone={status === 'Resolve only' ? 'muted' : sourceStatusTone(source.availability)} value={status} />
  </button>
}

function SourceSelectionNote({ source }: { source: SourceDescriptor }) {
  const reason = sourceStatusReason(source.availability)
  if (source.availability.state === 'available' && sourceCanSearch(source)) return <div className="source-selection-note"><span className="health-dot health-online" aria-hidden="true" /><span><strong>{source.label} selected.</strong> Search and resolve actions use this provider's server-owned adapter.</span></div>
  if (source.availability.state === 'available') return <Notice kind="info"><strong>{source.label} is available for resolution only.</strong> This provider does not expose search capability.</Notice>
  return <Notice kind={source.availability.state === 'disabled' ? 'warning' : 'info'}><strong>{source.label} is {sourceStatusLabel(source.availability).toLowerCase()}.</strong>{reason ? ` ${reason}` : ' Search and import stay disabled until the registry reports it available.'}</Notice>
}

function SourceSearchStatuses({ statuses }: { statuses: SourceSearchStatus[] }) {
  if (statuses.length === 0) return null
  return <div className="source-search-statuses" aria-label="Provider response status">{statuses.map((status) => {
    const reason = status.error?.message || sourceStatusReason(status.availability)
    const failed = Boolean(status.error)
    return <div className="source-search-status" key={status.id}><span><strong>{status.label}</strong><small>{status.resultCount} result{status.resultCount === 1 ? '' : 's'}</small></span><span><Badge tone={failed ? 'warn' : sourceStatusTone(status.availability)} value={failed ? 'Search failed' : sourceStatusLabel(status.availability)} />{reason && <small title={reason}>{reason}</small>}</span></div>
  })}</div>
}

function SourceResultCard({ result, selected, onSelect }: { result: SourceSearchResult; selected: boolean; onSelect: () => void }) {
  const pageUrl = providerPageUrl(result.sourceUrl)
  const title = sourceResultLabel(result)
  const sourceMeta = result.sourceType ? `${sourceLabel(result.sourceId)} · ${result.sourceType}` : sourceLabel(result.sourceId)
  return <article className={`source-result-card ${selected ? 'source-result-card-selected' : ''}`.trim()}>
    <button aria-pressed={selected} className="source-result-trigger" type="button" onClick={onSelect}>
      <div className="source-result-top"><span aria-hidden="true" className="skill-avatar">{title.replace(/^@/, '').slice(0, 1).toUpperCase() || 'S'}</span><span className="source-result-heading"><strong>{title}</strong><span>{sourceMeta}</span></span><span className="source-result-arrow" aria-hidden="true">↗</span></div>
      <p className="source-result-id"><code>{result.externalId}</code></p>
      <p className="source-result-description">{result.description || 'No description supplied by this provider.'}</p>
      <div className="source-result-tags"><Badge tone={result.installable ? 'good' : 'muted'} value={result.installable ? 'resolve available' : 'metadata only'} />{result.version && <span className="skill-tag">v{result.version}</span>}{result.snapshotDigest && <span className="skill-tag">snapshot recorded</span>}</div>
    </button>
    <div className="source-result-footer"><span>External metadata</span>{pageUrl ? <a href={pageUrl} rel="noreferrer" target="_blank">Open provider page ↗</a> : <span>Provider page unavailable</span>}</div>
  </article>
}

function sourceResolveMessage(source: SourceDescriptor | undefined, principal: Principal | null | undefined): string | undefined {
  if (!hasProxyResolveScope(principal)) return 'Your session does not have the proxy:resolve permission.'
  if (!source) return 'This result has no matching server provider descriptor, so it cannot be resolved.'
  if (!sourceCanResolve(source)) {
    const reason = sourceStatusReason(source.availability)
    if (source.availability.state === 'disabled') return reason || `${source.label} is disabled for source resolution.`
    if (source.availability.state === 'unavailable') return reason || `${source.label} is unavailable for source resolution.`
    return `${source.label} does not expose source resolution.`
  }
  return undefined
}

function SourceResolvePanel({ principal, result, source }: { principal: Principal | null; result: SourceSearchResult; source: SourceDescriptor | undefined }) {
  const [busy, setBusy] = useState(false)
  const [operation, setOperation] = useState<Job | null>(null)
  const [reference, setReference] = useState<string | null>(null)
  const [resolution, setResolution] = useState<Resolution | null>(null)
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)
  const [ready, setReady] = useState(false)
  const [copied, setCopied] = useState(false)
  const mounted = useRef(true)
  const resolveGeneration = useRef(0)
  const unavailableReason = result.installable ? sourceResolveMessage(source, principal) : result.unavailableReason || 'This provider returned metadata without a resolvable source target.'

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const installCommand = ready ? sourceInstallCommand('posix', result.sourceId, result.externalId, registryOrigin()) : null
  const installPowerShellCommand = ready ? sourceInstallCommand('powershell', result.sourceId, result.externalId, registryOrigin()) : null

  async function copyInstallCommand() {
    if (!installCommand) return
    try {
      await navigator.clipboard.writeText(installCommand)
      if (mounted.current) {
        setCopied(true)
        window.setTimeout(() => { if (mounted.current) setCopied(false) }, 1_800)
      }
    } catch {
      if (mounted.current) setMessage({ kind: 'error', text: 'Copy is unavailable here. Select the command and copy it manually.' })
    }
  }

  async function loadResolution(refresh: boolean, generation: number) {
    const response = await api.sourceResolve(result.sourceId, { externalId: result.externalId, ...(refresh ? { refresh: true } : {}) })
    if (!mounted.current || generation !== resolveGeneration.current) return null
    if (!matchesSourceIdentity(response, result.sourceId, result.externalId)) throw new Error('The registry returned a different provider or external identity, so this request was not accepted.')
    const locator = verifiedSourceLocator(response.reference)
    if (response.operation) setOperation(response.operation)
    if (response.resolution && !locator) throw new Error('The registry returned an approved resolution without a verified registry locator.')
    if (response.resolution && locator) {
      setReference(locator)
      setResolution(response.resolution)
      setReady(true)
      setMessage({ kind: 'success', text: 'This source passed the private registry flow and is ready to install.' })
      return response
    }
    if (response.operation) {
      setReference(locator)
      setReady(false)
      setMessage({ kind: 'success', text: `The registry is fetching, scanning, and caching ${result.externalId}.` })
      if (response.operation.state === 'failed') setMessage({ kind: 'error', text: response.operation.error ?? 'The source operation failed before approval.' })
      return response
    }
    throw new Error('The registry returned no operation or approved resolution for this source.')
  }

  async function resolve(refresh = false) {
    if (unavailableReason) {
      setMessage({ kind: 'error', text: unavailableReason })
      return
    }
    const generation = ++resolveGeneration.current
    setBusy(true)
    setMessage(null)
    setOperation(null)
    setReference(null)
    setResolution(null)
    setReady(false)
    try {
      await loadResolution(refresh, generation)
    } catch (cause) {
      if (mounted.current && generation === resolveGeneration.current) setMessage({ kind: 'error', text: sourceFailureMessage(cause, 'Could not resolve this source through the private registry.') })
    } finally {
      if (mounted.current && generation === resolveGeneration.current) setBusy(false)
    }
  }

  useEffect(() => {
    if (!operation || operation.state === 'failed' || operation.state === 'completed') return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const response = await api.operation(operation.id)
        if (cancelled) return
        const current = response.operation
        if (current.state === 'failed') {
          setOperation(current)
          setReady(false)
          setMessage({ kind: 'error', text: current.error ?? 'The source operation failed before approval.' })
        } else if (current.state === 'completed') {
          setOperation(current)
          try {
            await loadResolution(false, resolveGeneration.current)
          } catch (cause) {
            if (!cancelled) setMessage({ kind: 'error', text: sourceFailureMessage(cause, 'The source operation completed without an approved resolution.') })
          }
        } else {
          setOperation(current)
          timer = setTimeout(() => void poll(), 1_600)
        }
      } catch (cause) {
        if (!cancelled) {
          setMessage({ kind: 'error', text: sourceFailureMessage(cause, 'Could not refresh source operation status.') })
          timer = setTimeout(() => void poll(), 2_500)
        }
      }
    }
    timer = setTimeout(() => void poll(), 1_200)
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [operation?.id, operation?.state, result.externalId, result.sourceId])

  return <Panel className="source-resolve-panel" title="Resolve this source privately" description="The registry keeps the provider identity, fetches source bytes server-side, runs required scanners, and exposes a locator only after approval." action={<Badge tone={ready ? 'good' : 'muted'} value={ready ? 'ready to install' : 'metadata only'} />}>
    <div className="source-resolve-grid"><div>
      <div className="source-resolve-heading"><span className="eyebrow eyebrow-cloud">{sourceLabel(result.sourceId)}</span><h2>{sourceResultLabel(result)}</h2><p>{result.description || 'No description supplied by this provider.'}</p></div>
      <div className="detail-meta"><div className="meta-row"><span>Provider</span><span>{sourceLabel(result.sourceId)}</span></div><div className="meta-row"><span>External ID</span><code>{result.externalId}</code></div>{result.version && <div className="meta-row"><span>Provider version</span><span>{result.version}</span></div>}<div className="meta-row"><span>Source state</span><Badge tone={result.installable ? 'good' : 'muted'} value={result.installable ? 'resolve available' : 'metadata only'} /></div></div>
    </div><div className="source-resolve-actions">
      {message && <Notice kind={message.kind}>{message.text}</Notice>}
      {operation && <div className="proxy-operation"><div className="meta-row"><span>Registry operation</span><Badge value={operation.state} /></div><div className="meta-row"><span>Operation ID</span><code>{operation.id}</code></div>{operation.error && <Notice kind="error">{operation.error}</Notice>}</div>}
      {reference && <div className="proxy-reference"><span>Verified registry locator</span><code>{reference}</code><small>This locator records the approved registry source identity. Use the source install command below; no upstream download URL is exposed.</small></div>}
      {resolution && <div className="proxy-reference"><span>Approved release</span><strong>{resolution.name}@{resolution.version}</strong><small>{resolution.members.length} scanned release member{resolution.members.length === 1 ? '' : 's'}</small></div>}
      {ready && installCommand && installPowerShellCommand && <div className="proxy-command source-install-command"><div className="install-header"><h3 className="subheading">Install from this source</h3><Button kind="quiet" type="button" onClick={() => void copyInstallCommand()}>{copied ? 'Copied' : 'Copy command'}</Button></div><span className="helper">POSIX (bash/zsh)</span><pre className="code-block">{installCommand}</pre><span className="helper">PowerShell</span><pre className="code-block">{installPowerShellCommand}</pre><small className="helper">This command uses the exact source ID and external ID returned by search, and asks the registry to resolve the source again before installation.</small></div>}
      {!ready && !unavailableReason && <small className="helper">After approval, this panel will provide the exact source install command for your agent.</small>}
      {unavailableReason && <Notice kind="warning">{unavailableReason}</Notice>}
      <div className="proxy-actions"><Button busy={busy} disabled={Boolean(unavailableReason)} type="button" onClick={() => void resolve()}>{ready ? 'Check source again' : 'Fetch, scan, and resolve'}</Button>{ready && <Button busy={busy} disabled={Boolean(unavailableReason)} kind="quiet" type="button" onClick={() => void resolve(true)}>Refresh source</Button>}</div>
    </div></div>
  </Panel>
}

function sourceInstallCommand(shell: 'posix' | 'powershell', sourceId: string, externalId: string, origin: string): string {
  const quote = shell === 'posix' ? quotePosix : quotePowerShell
  return `pskills install --source ${quote(sourceId)} ${quote(externalId)} --registry ${quote(origin)} --agent codex`
}

function registryOrigin(): string {
  return typeof window === 'undefined' ? '<private-registry-url>' : window.location.origin
}
