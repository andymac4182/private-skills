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
import '../styles/experience-pages.css'

const allSources = 'all'
const sourceSearchLimit = 50
const suggestedQueries = ['code review', 'browser testing', 'documentation', 'security']

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
  const sourceGeneration = useRef(0)
  const mounted = useRef(true)

  async function loadSources() {
    const generation = ++sourceGeneration.current
    setSourceError(null)
    try {
      const response = await api.sources()
      if (!mounted.current || generation !== sourceGeneration.current) return
      setSources([...(response.sources ?? [])])
    } catch (cause) {
      if (!mounted.current || generation !== sourceGeneration.current) return
      setSources(null)
      setSourceError(sourceFailureMessage(cause, 'Could not load source providers.'))
    }
  }

  useEffect(() => {
    mounted.current = true
    void loadSources()
    return () => {
      mounted.current = false
      ++sourceGeneration.current
      ++searchGeneration.current
    }
  }, [])

  const orderedSources = useMemo(() => sortSources(sources ?? []), [sources])
  const selectedDescriptor = selectedSource === allSources ? undefined : sources?.find((source) => source.id === selectedSource)
  const canSearch = selectedSource === allSources
    ? orderedSources.some((source) => sourceCanSearch(source))
    : sourceCanSearch(selectedDescriptor)
  const searchableSourceCount = orderedSources.filter((source) => sourceCanSearch(source)).length
  const resolvableSourceCount = orderedSources.filter((source) => sourceCanResolve(source)).length
  const unavailableSourceCount = orderedSources.filter((source) => source.availability.state !== 'available').length
  const selectedSourceLabel = selectedSource === allSources ? 'All providers' : selectedDescriptor?.label ?? sourceLabel(selectedSource)

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

  async function searchFor(rawQuery: string) {
    const normalized = normalizeSourceQuery(rawQuery)
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

  async function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await searchFor(query)
  }

  function runSuggestedSearch(nextQuery: string) {
    setQuery(nextQuery)
    void searchFor(nextQuery)
  }

  const results = searchResponse?.data ?? []
  const resultCount = results.length
  const respondingSourceCount = searchResponse?.sources.length ?? 0
  const matchingSourceCount = searchResponse?.sources.filter((status) => status.resultCount > 0).length ?? 0
  return <div className="view-heading source-discovery-view">
    <section className="source-discovery-hero" aria-labelledby="source-discovery-title">
      <div className="source-discovery-hero-copy">
        <div className="source-discovery-kicker"><span className="eyebrow eyebrow-cloud">Source discovery</span><span className="source-discovery-privacy"><span aria-hidden="true" className="health-dot health-online" /> Server-side search</span></div>
        <h1 id="source-discovery-title">Find a skill across your sources.</h1>
        <p>Search configured providers, compare exact identities, then request a private scan.</p>
      </div>
      <div className="source-discovery-hero-actions"><Link className="button button-secondary" params={{ section: 'directory' }} to="/app/$section">Browse skills.sh</Link><Link className="button button-quiet" params={{ section: 'upstreams' }} to="/app/$section">Advanced sources ↗</Link></div>
    </section>

    <Panel className="source-discovery-toolbar">
      <div className="source-search-heading"><div><span className="eyebrow">Search the source catalog</span><h2>What are you looking for?</h2><p className="muted">Search by skill name, capability, or description across the providers your registry can reach.</p></div>{searching && <span aria-hidden="true" className="source-search-orb source-search-orb-active" />}</div>
      <form className="source-search-form" onSubmit={(event) => void submitSearch(event)}>
        <label className="directory-search-label" htmlFor="source-discovery-search">Search configured sources</label>
        <div className="directory-search-row"><span aria-hidden="true" className="source-search-icon">⌕</span><input id="source-discovery-search" onChange={(event) => setQuery(event.target.value)} placeholder="Try “code review” or “browser testing”" value={query} /><Button busy={searching} disabled={sources === null || Boolean(sourceError) || orderedSources.length === 0 || !canSearch} type="submit">Search sources</Button>{submittedQuery && <Button kind="quiet" type="button" onClick={clearSearch}>Clear</Button>}</div>
        <small>Results are bounded provider metadata. Source bytes are fetched only after you request a registry resolution.</small>
      </form>
      <div className="source-suggested-queries" aria-label="Suggested searches"><span>Try a suggested search</span>{suggestedQueries.map((suggestion) => <button key={suggestion} type="button" onClick={() => runSuggestedSearch(suggestion)}>{suggestion}<span aria-hidden="true">↗</span></button>)}</div>
      {sources === null && !sourceError ? <div className="source-provider-loading"><LoadingState label="Loading configured source providers…" /></div> : sourceError ? <ErrorState message={sourceError} onRetry={() => void loadSources()} /> : orderedSources.length === 0 ? <EmptyState title="No source providers configured" description="An administrator must configure a source adapter before this registry can search or import from it." /> : <details className="source-provider-details"><summary><span className="source-provider-summary-selection"><span className="eyebrow">Provider access</span><strong>{selectedSourceLabel}</strong></span><span className="source-provider-summary-counts"><span><strong>{searchableSourceCount}</strong> searchable</span><span><strong>{resolvableSourceCount}</strong> resolvable</span>{unavailableSourceCount > 0 && <span className="source-provider-summary-attention"><strong>{unavailableSourceCount}</strong> need access</span>}</span><span aria-hidden="true" className="source-details-chevron">⌄</span></summary><div className="source-provider-details-body"><div className="source-provider-heading"><div><span className="eyebrow">Provider access</span><h2>Choose where to search</h2></div>{selectedSource !== allSources && <button className="source-provider-reset" type="button" onClick={() => chooseSource(allSources)}>Use all providers</button>}</div><div className="source-provider-picker" aria-label="Source providers" role="list">
        <button aria-pressed={selectedSource === allSources} className={`source-provider-option ${selectedSource === allSources ? 'source-provider-option-active' : ''}`.trim()} type="button" onClick={() => chooseSource(allSources)}>
          <span aria-hidden="true" className="source-provider-mark source-provider-mark-all">ALL</span>
          <span className="source-provider-copy"><strong>All providers</strong><small>Search every source that is ready.</small></span>
          <span className="source-provider-capabilities"><span>{searchableSourceCount} search</span><span>{resolvableSourceCount} resolve</span></span>
        </button>
        {orderedSources.map((source) => <SourceProviderOption key={source.id} source={source} selected={selectedSource === source.id} onSelect={() => chooseSource(source.id)} />)}
      </div></div></details>}
      {selectedDescriptor && <SourceSelectionNote source={selectedDescriptor} />}
    </Panel>

    {searchError && <div className="source-discovery-search-error"><ErrorState message={searchError} onRetry={submittedQuery ? () => { const form = document.getElementById('source-discovery-search')?.closest('form'); if (form) form.requestSubmit() } : undefined} /></div>}
    {searching && <div className="source-search-progress" aria-live="polite"><Panel><LoadingState label={`Searching ${selectedSource === allSources ? 'configured providers' : sourceLabel(selectedSource)}…`} /></Panel></div>}
    {!searching && searchResponse && <div className={`source-discovery-workspace ${selectedResult ? 'source-discovery-workspace-selected' : ''}`.trim()}>
      <Panel className="source-results-panel" title={`Results${submittedQuery ? ` for “${submittedQuery}”` : ''}`} description={`${resultCount} result${resultCount === 1 ? '' : 's'} returned. Select a result to inspect its source identity.`}>
        <div className="source-results-summary" aria-live="polite"><span><strong>{resultCount}</strong> match{resultCount === 1 ? '' : 'es'}</span><span><strong>{matchingSourceCount}</strong> provider{matchingSourceCount === 1 ? '' : 's'} with matches</span><span>{respondingSourceCount} provider response{respondingSourceCount === 1 ? '' : 's'}</span></div>
        <SourceSearchStatuses statuses={[...searchResponse.sources]} />
        {results.length === 0 ? <EmptyState title="No source matches" description="Try a broader query or choose another available provider." /> : <div className="source-result-grid">{results.map((result) => <SourceResultCard key={`${result.sourceId}:${result.externalId}`} result={result} selected={selectedResult?.sourceId === result.sourceId && selectedResult.externalId === result.externalId} onSelect={() => setSelectedResult(result)} />)}</div>}
      </Panel>
      {selectedResult && <div className="source-resolve-anchor" id="source-resolve-panel"><SourceResolvePanel key={`${selectedResult.sourceId}:${selectedResult.externalId}`} principal={principal} result={selectedResult} source={sources?.find((candidate) => candidate.id === selectedResult.sourceId)} /></div>}
    </div>}
    {!searching && !searchResponse && !searchError && <Panel className="source-discovery-empty" title="Search to compare source options" description="A result keeps the provider identity and external ID needed for a safe, reviewable import request."><div className="source-discovery-empty-content"><span aria-hidden="true" className="source-discovery-empty-mark">⌕</span><p>Search across the providers above. The registry will show which provider responded and whether each result has only metadata or can be resolved through private scanning.</p></div></Panel>}
  </div>
}

function SourceProviderOption({ source, selected, onSelect }: { source: SourceDescriptor; selected: boolean; onSelect: () => void }) {
  const statusReason = sourceStatusReason(source.availability)
  const status = source.availability.state === 'available' && !sourceCanSearch(source) ? 'Resolve only' : sourceStatusLabel(source.availability)
  return <button aria-pressed={selected} className={`source-provider-option ${selected ? 'source-provider-option-active' : ''}`.trim()} title={statusReason} type="button" onClick={onSelect}>
    <span aria-hidden="true" className="source-provider-mark">{source.label.replace(/[^A-Za-z0-9]/gu, '').slice(0, 2).toUpperCase() || 'S'}</span>
    <span className="source-provider-copy"><strong>{source.label}</strong><small>{sourceDescription(source)}</small><span className="source-provider-id"><code>{source.id}</code></span></span>
    <span className="source-provider-option-meta"><span className="source-provider-capabilities"><span className={sourceCanSearch(source) ? 'source-capability-ready' : ''}>Search {sourceCanSearch(source) ? 'ready' : 'off'}</span><span className={sourceCanResolve(source) ? 'source-capability-ready' : ''}>Resolve {sourceCanResolve(source) ? 'ready' : 'off'}</span></span><Badge tone={status === 'Resolve only' ? 'muted' : sourceStatusTone(source.availability)} value={status} /></span>
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
  const failedStatuses = statuses.filter((status) => Boolean(status.error))
  const failureSummary = failedStatuses.map((status) => `${status.label}: ${conciseReason(status.error?.message || sourceStatusReason(status.availability) || 'Search failed')}`).join(' · ')
  return <details className="source-status-details"><summary><span className="source-status-summary-label"><span className="eyebrow">Provider responses</span><strong>{statuses.length} checked</strong></span><span className={`source-status-summary-result ${failedStatuses.length ? 'source-status-summary-result-failed' : ''}`.trim()}>{failedStatuses.length ? `${failedStatuses.length} failed` : 'No response errors'}{failureSummary && <small title={failureSummary}>{failureSummary}</small>}</span><span aria-hidden="true" className="source-details-chevron">⌄</span></summary><div className="source-search-statuses" aria-label="Provider response status">{statuses.map((status) => {
    const reason = status.error?.message || sourceStatusReason(status.availability)
    const failed = Boolean(status.error)
    return <div className="source-search-status" key={status.id}><span><strong>{status.label}</strong><code>{status.id}</code><small>{status.resultCount} result{status.resultCount === 1 ? '' : 's'}</small></span><span><Badge tone={failed ? 'warn' : sourceStatusTone(status.availability)} value={failed ? 'Search failed' : sourceStatusLabel(status.availability)} />{reason && <small title={reason}>{reason}</small>}</span></div>
  })}</div></details>
}

function conciseReason(value: string): string {
  const normalized = value.trim().replace(/\s+/gu, ' ')
  return normalized.length > 88 ? `${normalized.slice(0, 85)}…` : normalized
}

function SourceResultCard({ result, selected, onSelect }: { result: SourceSearchResult; selected: boolean; onSelect: () => void }) {
  const pageUrl = providerPageUrl(result.sourceUrl)
  const title = sourceResultLabel(result)
  const sourceMeta = result.sourceType ? `${sourceLabel(result.sourceId)} · ${result.sourceType}` : sourceLabel(result.sourceId)
  return <article className={`source-result-card ${selected ? 'source-result-card-selected' : ''}`.trim()}>
    <button aria-controls={selected ? 'source-resolve-panel' : undefined} aria-pressed={selected} className="source-result-trigger" type="button" onClick={onSelect}>
      <div className="source-result-top"><span aria-hidden="true" className="skill-avatar">{title.replace(/^@/, '').slice(0, 1).toUpperCase() || 'S'}</span><span className="source-result-heading"><strong>{title}</strong><span>{sourceMeta}</span></span><span className="source-result-arrow" aria-hidden="true">↗</span></div>
      <div className="source-result-identity"><span>Source ID</span><code>{result.sourceId}</code><span>External ID</span><code>{result.externalId}</code></div>
      <p className="source-result-description">{result.description || 'No description supplied by this provider.'}</p>
      <div className="source-result-tags"><Badge tone={result.installable ? 'good' : 'muted'} value={result.installable ? 'resolve available' : 'metadata only'} />{result.version && <span className="skill-tag">v{result.version}</span>}{result.snapshotDigest && <span className="skill-tag">snapshot recorded</span>}</div>
    </button>
    <div className="source-result-footer"><span>Provider metadata</span>{pageUrl ? <a href={pageUrl} rel="noreferrer" target="_blank">Open provider page ↗</a> : <span>Provider page unavailable</span>}</div>
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

function SourceOperationProgress({ operation, ready }: { operation: Job; ready: boolean }) {
  const failed = operation.state === 'failed'
  const active = operation.state === 'queued' ? 0 : operation.state === 'running' ? 1 : operation.state === 'completed' && !ready ? 2 : -1
  const steps = [
    { label: 'Request accepted', detail: 'The source identity is held by this registry operation.' },
    { label: 'Fetch and scan', detail: 'Source bytes stay server-side while required checks run.' },
    { label: 'Approved locator', detail: 'A registry locator appears only after approval.' },
  ]
  const stateLabel = failed ? 'Operation failed' : ready ? 'Ready to install' : operation.state === 'completed' ? 'Checking approval' : operation.state === 'running' ? 'Fetching and scanning' : 'Queued for processing'
  return <div className="source-operation-progress" aria-live="polite">
    <div className="source-operation-progress-heading"><div><span className="eyebrow">Registry progress</span><strong>{stateLabel}</strong></div><Badge tone={failed ? 'bad' : ready ? 'good' : undefined} value={ready ? 'approved' : operation.state} /></div>
    <ol>{steps.map((step, index) => {
      const state = failed ? (index === 1 ? 'failed' : index === 0 ? 'complete' : 'pending') : ready || (operation.state === 'completed' && index < 2) || (operation.state === 'running' && index === 0) ? 'complete' : active === index ? 'active' : 'pending'
      return <li className={`source-operation-step source-operation-step-${state}`.trim()} key={step.label}><span aria-hidden="true" className="source-operation-step-marker">{state === 'complete' ? '✓' : state === 'failed' ? '!' : index + 1}</span><span><strong>{step.label}</strong><small>{step.detail}</small></span></li>
    })}</ol>
    {operation.error && <small className="source-operation-error">{operation.error}</small>}
  </div>
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
      <div className="source-resolve-heading"><div className="source-resolve-kicker"><span className="eyebrow eyebrow-cloud">{sourceLabel(result.sourceId)}</span><Badge tone={result.installable ? 'good' : 'muted'} value={result.installable ? 'resolve available' : 'metadata only'} /></div><h2>{sourceResultLabel(result)}</h2><p>{result.description || 'No description supplied by this provider.'}</p></div>
      <div className="source-identity-card"><span className="source-identity-label">Exact source identity</span><div className="source-identity-row"><span>Source ID</span><code>{result.sourceId}</code></div><div className="source-identity-row"><span>External ID</span><code>{result.externalId}</code></div></div>
      <div className="detail-meta"><div className="meta-row"><span>Provider</span><span>{sourceLabel(result.sourceId)}</span></div>{result.sourceType && <div className="meta-row"><span>Source type</span><span>{result.sourceType}</span></div>}{result.version && <div className="meta-row"><span>Provider version</span><span>{result.version}</span></div>}{result.repository && <div className="meta-row"><span>Repository</span><code>{result.repository}</code></div>}{result.path && <div className="meta-row"><span>Path</span><code>{result.path}</code></div>}{result.ref && <div className="meta-row"><span>Reference</span><code>{result.ref}</code></div>}</div>
    </div><div className="source-resolve-actions">
      {message && <Notice kind={message.kind}>{message.text}</Notice>}
      {operation && <><SourceOperationProgress operation={operation} ready={ready} /><div className="proxy-operation"><div className="meta-row"><span>Operation ID</span><code>{operation.id}</code></div></div></>}
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
