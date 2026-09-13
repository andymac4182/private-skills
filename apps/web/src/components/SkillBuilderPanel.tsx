import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { FileDiff } from '@pierre/diffs/react'
import { parseDiffFromFile, type FileContents, type FileDiffMetadata } from '@pierre/diffs'
import type { DraftView } from '../lib/types'
import styles from './SkillBuilderPanel.module.css'
import { onPierrePostRender, PIERRE_ACCESSIBLE_CSS } from './pierreAccessibility'

/**
 * The editor owns the selected draft and this panel only receives its binding.
 * File contents stay behind the same-origin builder adapter; the browser never
 * receives an Eve/service bearer token.
 */
export interface SkillBuilderDraftContext {
  readonly draftId: string
  readonly revision: number
  readonly digest: `sha256:${string}`
  readonly selectedPath?: string
}

export type SkillBuilderTurnRole = 'user' | 'assistant' | 'system'

export interface SkillBuilderConversationTurn {
  readonly id: string
  readonly role: SkillBuilderTurnRole
  readonly content: string
  readonly createdAt: string
}

export type SkillBuilderSessionState = 'ready' | 'running' | 'stopped' | 'failed' | 'completed'

export interface SkillBuilderProposalOperation {
  readonly op: 'add' | 'edit' | 'rename' | 'delete'
  readonly path: string
  readonly newPath?: string
  readonly contentBytes?: number
  /** Optional bounded previews selected by the server for human review. */
  readonly before?: string | null
  readonly after?: string | null
}

export type SkillBuilderProposalState = 'pending' | 'applied' | 'rejected' | 'stale'

export interface SkillBuilderProposal {
  readonly id: string
  readonly draftId: string
  readonly baseRevision: number
  readonly baseDigest: `sha256:${string}`
  readonly proposedDigest?: `sha256:${string}`
  readonly diffDigest?: `sha256:${string}`
  readonly operations: readonly SkillBuilderProposalOperation[]
  readonly state: SkillBuilderProposalState
  readonly sessionId: string
  readonly createdAt: string
}

export interface SkillBuilderSession {
  readonly id: string
  readonly binding: SkillBuilderDraftContext
  readonly state: SkillBuilderSessionState
  readonly turns: readonly SkillBuilderConversationTurn[]
  readonly proposal?: SkillBuilderProposal | null
}

export type SkillBuilderProgressPhase =
  | 'connecting'
  | 'reading-context'
  | 'thinking'
  | 'preparing-proposal'
  | 'saving'

export interface SkillBuilderProgress {
  readonly phase: SkillBuilderProgressPhase
  readonly message: string
}

export interface SkillBuilderAvailability {
  readonly enabled: boolean
  readonly reason?: string
  readonly model?: string
}

export interface SkillBuilderPromptInput {
  readonly binding: SkillBuilderDraftContext
  readonly sessionId: string
  readonly prompt: string
  /** Stable across retries so the BFF can deduplicate the request. */
  readonly requestId: string
  readonly signal: AbortSignal
  readonly onProgress?: (progress: SkillBuilderProgress) => void
  /** Called when the BFF has accepted a prompt before polling completes. */
  readonly onSession?: (session: SkillBuilderSession) => void
}

export interface SkillBuilderPromptResult {
  readonly session: SkillBuilderSession
  readonly proposal?: SkillBuilderProposal | null
}

export interface SkillBuilderProposalResult {
  readonly session?: SkillBuilderSession
  readonly proposal: SkillBuilderProposal
  /** The exact server revision returned after a successful apply, when the BFF provides it. */
  readonly draft?: DraftView
}

/**
 * Apply is only considered complete after the panel has rebound to a fresh
 * server draft.  Keeping this separate from the mutation response prevents a
 * caller from accidentally treating an old cached revision as authoritative.
 */
export type SkillBuilderAppliedResult = Omit<SkillBuilderProposalResult, 'draft'> & {
  readonly draft: DraftView
}

/**
 * Small same-origin adapter seam.  The central editor can map its BFF client
 * to this interface while the route/session contract settles independently.
 */
export interface SkillBuilderPanelAdapter {
  getAvailability?: (input: { draftId: string; signal?: AbortSignal }) => Promise<SkillBuilderAvailability>
  loadSession: (input: { binding: SkillBuilderDraftContext; signal: AbortSignal; onSession?: (session: SkillBuilderSession) => void }) => Promise<SkillBuilderSession>
  /** Refresh an already-loaded running session after a bounded poll window. */
  refreshSession?: (input: { binding: SkillBuilderDraftContext; sessionId: string; signal: AbortSignal; onSession?: (session: SkillBuilderSession) => void }) => Promise<SkillBuilderSession>
  sendPrompt: (input: SkillBuilderPromptInput) => Promise<SkillBuilderPromptResult>
  /** Reload the exact draft after apply; this is the authoritative CAS result. */
  reloadDraft: (input: { binding: SkillBuilderDraftContext; signal: AbortSignal }) => Promise<DraftView>
  stop: (input: { binding: SkillBuilderDraftContext; sessionId: string; requestId: string }) => Promise<void>
  applyProposal: (input: {
    binding: SkillBuilderDraftContext
    sessionId: string
    proposalId: string
    requestId: string
  }) => Promise<SkillBuilderProposalResult>
  rejectProposal: (input: {
    binding: SkillBuilderDraftContext
    sessionId: string
    proposalId: string
    requestId: string
  }) => Promise<SkillBuilderProposalResult | void>
}

export interface SkillBuilderPanelProps {
  readonly draft: SkillBuilderDraftContext | null
  readonly adapter: SkillBuilderPanelAdapter
  /** Set false when the registry has disabled the feature for this tenant. */
  readonly enabled?: boolean
  readonly disabledReason?: string
  /** Applying a proposal is disabled while the editor owns unsaved local bytes. */
  readonly canApply?: boolean
  readonly applyDisabledReason?: string
  /** Required so the central editor cannot keep using the pre-apply binding. */
  readonly onDraftRebound: (draft: DraftView) => void
  readonly onApplied?: (result: SkillBuilderAppliedResult) => void
  readonly onRejected?: (proposal: SkillBuilderProposal) => void
}

const MAX_PROMPT_LENGTH = 8_000
const MAX_DISPLAYED_TURNS = 200

function requestId(prefix: string): string {
  const suffix = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `builder-${prefix}-${suffix}`
}

function contextKey(binding: SkillBuilderDraftContext | null): string {
  return binding ? `${binding.draftId}:${binding.revision}:${binding.digest}` : 'none'
}

function shortDigest(value: string): string {
  return value.length > 18 ? `${value.slice(0, 15)}…` : value
}

function errorCode(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const code = (value as { code?: unknown }).code
  return typeof code === 'string' ? code.toUpperCase() : undefined
}

export function isStaleBuilderError(value: unknown): boolean {
  const code = errorCode(value)
  const status = value && typeof value === 'object' ? (value as { status?: unknown }).status : undefined
  return code === 'STALE_BINDING' || code === 'DRAFT_CONFLICT' || code === 'CONFLICT' || status === 409
}

function displayError(value: unknown, fallback: string): string {
  if (isStaleBuilderError(value)) return 'This draft changed while Eve was working. Reload the draft before applying a proposal.'
  if (errorCode(value) === 'DISABLED') return 'The skill builder is disabled for this registry.'
  if (value && typeof value === 'object' && typeof (value as { message?: unknown }).message === 'string') {
    const message = (value as { message: string }).message.trim()
    if (message.length > 0 && message.length <= 240) return message
  }
  return fallback
}

function bindingMatches(draft: SkillBuilderDraftContext, proposal: SkillBuilderProposal): boolean {
  return proposal.draftId === draft.draftId && proposal.baseRevision === draft.revision && proposal.baseDigest === draft.digest
}

type ProposalAction = 'apply' | 'reject'

function proposalActionKey(action: ProposalAction, binding: SkillBuilderDraftContext, sessionId: string, proposalId: string): string {
  return `${action}:${contextKey(binding)}:${sessionId}:${proposalId}`
}

function reboundDraft(current: SkillBuilderDraftContext, next: DraftView): DraftView {
  if (next.id !== current.draftId || next.revision <= current.revision) {
    throw new Error('The builder returned an invalid post-apply draft revision.')
  }
  return next
}

function contentForDiff(value: string | null | undefined, name: string): FileContents | null {
  return typeof value === 'string' ? { name, contents: value, cacheKey: `${name}:${value.length}:${value.slice(0, 16)}` } : null
}

export function proposalDiff(operation: SkillBuilderProposalOperation): FileDiffMetadata | null {
  const oldName = operation.path
  const newName = operation.newPath ?? operation.path
  const oldFile = operation.op === 'add' ? null : contentForDiff(operation.before, oldName)
  const newFile = operation.op === 'delete' ? null : contentForDiff(operation.after, newName)
  if (!oldFile && !newFile) return null
  try {
    return parseDiffFromFile(oldFile, newFile, { context: 3 })
  } catch {
    return null
  }
}

function proposalSummary(operation: SkillBuilderProposalOperation): string {
  if (operation.op === 'rename') return `${operation.path} → ${operation.newPath ?? 'new path'}`
  return operation.path
}

function builderLiveMessage(session: SkillBuilderSession | null, proposal: SkillBuilderProposal | null, stopped: boolean): string {
  if (stopped) return 'The builder request was cancelled.'
  if (proposal?.state === 'pending') return 'Eve has prepared a proposal for review.'
  if (proposal?.state === 'applied') return 'The proposal was applied and the draft was reloaded.'
  if (proposal?.state === 'rejected') return 'The Eve proposal was rejected.'
  if (proposal?.state === 'stale') return 'The Eve proposal is stale. Reload the draft before applying it.'
  if (!session) return 'Loading the builder conversation.'
  if (session.state === 'running') return 'Eve is working on the draft.'
  if (session.state === 'completed') return 'The Eve builder session is complete.'
  if (session.state === 'failed') return 'The Eve builder session failed.'
  if (session.state === 'stopped') return 'The Eve builder session stopped.'
  return 'The Eve builder is ready.'
}

function initialAvailability(enabled: boolean | undefined, disabledReason: string | undefined, hasAvailabilityResolver: boolean): SkillBuilderAvailability | null {
  if (enabled === false) return { enabled: false, reason: disabledReason ?? 'The skill builder is disabled for this registry.' }
  if (enabled === true) return { enabled: true }
  return hasAvailabilityResolver ? null : { enabled: false, reason: 'The skill builder availability is not configured.' }
}

export function SkillBuilderPanel({ draft, adapter, enabled, disabledReason, canApply = true, applyDisabledReason, onDraftRebound, onApplied, onRejected }: SkillBuilderPanelProps) {
  const [availability, setAvailability] = useState<SkillBuilderAvailability | null>(() => initialAvailability(enabled, disabledReason, Boolean(adapter.getAvailability)))
  const [session, setSession] = useState<SkillBuilderSession | null>(null)
  const [proposal, setProposal] = useState<SkillBuilderProposal | null>(null)
  const [prompt, setPrompt] = useState('')
  const [progress, setProgress] = useState<SkillBuilderProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [stopped, setStopped] = useState(false)
  const [loading, setLoading] = useState(false)
  const [sessionPolling, setSessionPolling] = useState(false)
  const [sending, setSending] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [proposalAction, setProposalAction] = useState<'apply' | 'reject' | null>(null)
  const [lastRequest, setLastRequest] = useState<{ prompt: string; requestId: string } | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [restarting, setRestarting] = useState(false)
  const generation = useRef(0)
  const activeRequest = useRef<{ requestId: string; controller: AbortController } | null>(null)
  const restartPending = useRef(false)
  const proposalRequestIds = useRef(new Map<string, string>())
  const stopRequestIds = useRef(new Map<string, string>())
  const draftRef = useRef<SkillBuilderDraftContext | null>(draft)
  draftRef.current = draft

  const bindingKey = contextKey(draft)
  const sessionActive = session?.state === 'running'
  const terminalSession = session?.state === 'failed' || session?.state === 'stopped' || session?.state === 'completed'
  const turns = useMemo(() => (session?.turns ?? []).slice(-MAX_DISPLAYED_TURNS), [session?.turns])
  const effectiveProposal = proposal ?? session?.proposal ?? null
  const canStartNewConversation = terminalSession && effectiveProposal?.state !== 'pending'
  const busy = loading || sessionPolling || sending || refreshing || stopping || restarting || proposalAction !== null || sessionActive

  useEffect(() => {
    if (enabled === false) {
      setAvailability({ enabled: false, reason: disabledReason ?? 'The skill builder is disabled for this registry.' })
      return
    }
    if (!draft || !adapter.getAvailability) {
      setAvailability(enabled === true
        ? { enabled: true }
        : { enabled: false, reason: 'The skill builder availability is not configured.' })
      return
    }
    const controller = new AbortController()
    let active = true
    setAvailability(null)
    void adapter.getAvailability({ draftId: draft.draftId, signal: controller.signal }).then((next) => {
      if (active) setAvailability(next)
    }).catch((cause: unknown) => {
      if (active && !controller.signal.aborted) setAvailability({ enabled: false, reason: displayError(cause, 'The skill builder is unavailable.') })
    })
    return () => { active = false; controller.abort() }
  }, [adapter, disabledReason, draft?.draftId, enabled])

  useEffect(() => {
    const currentGeneration = ++generation.current
    activeRequest.current?.controller.abort()
    activeRequest.current = null
    setSession(null)
    setProposal(null)
    setPrompt('')
    setProgress(null)
    setError(null)
    setStopped(false)
    setLastRequest(null)
    setSending(false)
    setSessionPolling(false)
    setRefreshing(false)
    setStopping(false)
    setProposalAction(null)
    proposalRequestIds.current.clear()
    stopRequestIds.current.clear()
    const currentDraft = draftRef.current
    if (!currentDraft || availability?.enabled !== true) {
      setLoading(false)
      return () => { generation.current += 1 }
    }
    const controller = new AbortController()
    const loadRequestId = requestId('load')
    activeRequest.current = { requestId: loadRequestId, controller }
    setSessionPolling(true)
    setLoading(true)
    void adapter.loadSession({
      binding: currentDraft,
      signal: controller.signal,
      onSession: (next) => {
        if (currentGeneration !== generation.current || controller.signal.aborted) return
        setSession(next)
        setProposal(next.proposal ?? null)
        setLoading(false)
        setProgress(next.state === 'running' && next.proposal == null ? { phase: 'thinking', message: 'Eve is finishing the builder request…' } : null)
      },
    }).then((next) => {
      if (currentGeneration !== generation.current || controller.signal.aborted) return
      setSession(next)
      setProposal(next.proposal ?? null)
      setLoading(false)
      setProgress(null)
    }).catch((cause: unknown) => {
      if (currentGeneration !== generation.current || controller.signal.aborted) return
      setError(displayError(cause, 'Could not load the builder conversation.'))
      setLoading(false)
    }).finally(() => {
      if (currentGeneration !== generation.current) return
      setSessionPolling(false)
      if (restartPending.current) {
        restartPending.current = false
        setRestarting(false)
      }
      if (activeRequest.current?.requestId === loadRequestId) activeRequest.current = null
    })
    return () => { controller.abort(); generation.current += 1 }
  }, [adapter, availability?.enabled, bindingKey, loadAttempt])

  function startNewConversation(): void {
    if (!draft || availability?.enabled !== true || !canStartNewConversation || busy || restartPending.current) return
    restartPending.current = true
    setRestarting(true)
    setLoadAttempt((attempt) => attempt + 1)
  }

  async function refreshStatus(): Promise<void> {
    const currentDraft = draft
    const currentSession = session
    if (!currentDraft || !currentSession || currentSession.state !== 'running' || !adapter.refreshSession || sessionPolling || refreshing || stopping || proposalAction) return
    const currentGeneration = generation.current
    const controller = new AbortController()
    const refreshRequestId = requestId('refresh')
    activeRequest.current = { requestId: refreshRequestId, controller }
    setRefreshing(true)
    setError(null)
    setProgress({ phase: 'thinking', message: 'Refreshing the builder session status…' })
    try {
      const next = await adapter.refreshSession({
        binding: currentDraft,
        sessionId: currentSession.id,
        signal: controller.signal,
        onSession: (updated) => {
          if (currentGeneration !== generation.current || controller.signal.aborted) return
          setSession(updated)
          setProposal(updated.proposal ?? null)
          setProgress(updated.state === 'running' && updated.proposal == null ? { phase: 'thinking', message: 'Eve is finishing the builder request…' } : null)
        },
      })
      if (currentGeneration !== generation.current || controller.signal.aborted) return
      setSession(next)
      setProposal(next.proposal ?? null)
      setProgress(null)
    } catch (cause: unknown) {
      if (currentGeneration !== generation.current || controller.signal.aborted) return
      setError(displayError(cause, 'Could not refresh the builder session.'))
      setProgress(null)
    } finally {
      if (activeRequest.current?.requestId === refreshRequestId) activeRequest.current = null
      if (currentGeneration === generation.current) setRefreshing(false)
    }
  }

  async function sendPrompt(value = prompt, retryRequestId?: string): Promise<void> {
    const text = value.trim()
    if (!draft || !session || !availability?.enabled || busy || terminalSession || !text || text.length > MAX_PROMPT_LENGTH) {
      if (terminalSession && !busy) setError('This conversation has ended. Start a new conversation to continue.')
      return
    }
    const currentGeneration = generation.current
    const request = { prompt: text, requestId: retryRequestId ?? requestId('prompt') }
    const controller = new AbortController()
    activeRequest.current = { requestId: request.requestId, controller }
    setSending(true)
    setStopped(false)
    setError(null)
    setProgress({ phase: 'connecting', message: 'Connecting to the builder…' })
    setLastRequest(request)
    try {
      const result = await adapter.sendPrompt({
        binding: draft,
        sessionId: session.id,
        prompt: text,
        requestId: request.requestId,
        signal: controller.signal,
        onProgress: setProgress,
        onSession: (next) => {
          if (currentGeneration !== generation.current || next.id !== session.id) return
          setSession(next)
          setProposal(next.proposal ?? null)
        },
      })
      if (currentGeneration !== generation.current || controller.signal.aborted) return
      setSession(result.session)
      setProposal(result.proposal ?? result.session.proposal ?? null)
      setPrompt('')
      setLastRequest(null)
      setProgress(null)
    } catch (cause: unknown) {
      if (currentGeneration !== generation.current) return
      if (controller.signal.aborted) {
        setProgress(null)
      } else {
        setError(displayError(cause, 'The builder could not complete that request.'))
        setProgress(null)
      }
    } finally {
      if (currentGeneration === generation.current) {
        setSending(false)
        if (activeRequest.current?.requestId === request.requestId) activeRequest.current = null
      }
    }
  }

  async function stopPrompt(): Promise<void> {
    const active = activeRequest.current
    const currentDraft = draft
    if (!currentDraft || !session || (!active && session.state !== 'running') || stopping) return
    const currentGeneration = generation.current
    const stopKey = `${contextKey(currentDraft)}:${session.id}`
    const activeRequestId = active?.requestId ?? stopRequestIds.current.get(stopKey) ?? requestId('stop')
    stopRequestIds.current.set(stopKey, activeRequestId)
    setStopping(true)
    active?.controller.abort()
    let confirmed = false
    try {
      await adapter.stop({ binding: currentDraft, sessionId: session.id, requestId: activeRequestId })
      confirmed = true
      if (currentGeneration === generation.current) {
        setSession((current) => current && current.id === session.id ? { ...current, state: 'stopped' } : current)
        setStopped(true)
      }
    } catch (cause: unknown) {
      if (currentGeneration === generation.current && !isAbortLike(cause)) setError(displayError(cause, 'The builder could not be stopped.'))
    } finally {
      if (activeRequest.current?.requestId === activeRequestId) activeRequest.current = null
      if (currentGeneration === generation.current) {
        setSending(false)
        setStopping(false)
        if (confirmed) setProgress(null)
      }
    }
  }

  async function applyProposal(): Promise<void> {
    if (!draft || !session || !effectiveProposal || proposalAction) return
    if (!canApply) {
      setError(applyDisabledReason ?? 'Save or discard local changes before applying an Eve proposal.')
      return
    }
    if (!bindingMatches(draft, effectiveProposal)) {
      setProposal({ ...effectiveProposal, state: 'stale' })
      setError('This proposal was created from an older draft revision. Reload the draft before applying it.')
      return
    }
    const currentProposal = effectiveProposal
    const currentGeneration = generation.current
    const actionKey = proposalActionKey('apply', draft, session.id, currentProposal.id)
    const applyRequestId = proposalRequestIds.current.get(actionKey) ?? requestId('apply')
    proposalRequestIds.current.set(actionKey, applyRequestId)
    setProposalAction('apply')
    setError(null)
    try {
      const result = await adapter.applyProposal({
        binding: draft,
        sessionId: session.id,
        proposalId: currentProposal.id,
        requestId: applyRequestId,
      })
      if (currentGeneration !== generation.current) return
      const reloadController = new AbortController()
      const reloaded = await adapter.reloadDraft({ binding: draft, signal: reloadController.signal })
      if (currentGeneration !== generation.current || reloadController.signal.aborted) return
      const rebound = reboundDraft(draft, reloaded)
      const reboundBinding: SkillBuilderDraftContext = {
        draftId: rebound.id,
        revision: rebound.revision,
        digest: rebound.digest,
        ...(draft.selectedPath === undefined ? {} : { selectedPath: draft.selectedPath }),
      }
      const appliedResult: SkillBuilderAppliedResult = {
        ...result,
        draft: rebound,
      }
      setSession({ ...(result.session ?? session), binding: reboundBinding })
      setProposal(result.proposal)
      onDraftRebound(rebound)
      onApplied?.(appliedResult)
      if (result.proposal.state !== 'pending' && result.proposal.state !== 'stale') proposalRequestIds.current.delete(actionKey)
    } catch (cause: unknown) {
      if (currentGeneration !== generation.current) return
      if (isStaleBuilderError(cause)) {
        proposalRequestIds.current.delete(actionKey)
        setProposal({ ...currentProposal, state: 'stale' })
      }
      setError(displayError(cause, 'The proposal could not be applied.'))
    } finally {
      if (currentGeneration === generation.current) setProposalAction(null)
    }
  }

  async function rejectProposal(): Promise<void> {
    if (!draft || !session || !effectiveProposal || proposalAction) return
    const currentProposal = effectiveProposal
    const currentGeneration = generation.current
    const actionKey = proposalActionKey('reject', draft, session.id, currentProposal.id)
    const rejectRequestId = proposalRequestIds.current.get(actionKey) ?? requestId('reject')
    proposalRequestIds.current.set(actionKey, rejectRequestId)
    setProposalAction('reject')
    setError(null)
    try {
      const result = await adapter.rejectProposal({
        binding: draft,
        sessionId: session.id,
        proposalId: currentProposal.id,
        requestId: rejectRequestId,
      })
      if (currentGeneration !== generation.current) return
      const nextProposal = result?.proposal ?? { ...currentProposal, state: 'rejected' as const }
      setProposal(nextProposal)
      if (result?.session) setSession(result.session)
      onRejected?.(nextProposal)
      if (nextProposal.state !== 'pending' && nextProposal.state !== 'stale') proposalRequestIds.current.delete(actionKey)
    } catch (cause: unknown) {
      if (currentGeneration !== generation.current) return
      if (isStaleBuilderError(cause)) proposalRequestIds.current.delete(actionKey)
      setError(displayError(cause, 'The proposal could not be rejected.'))
    } finally {
      if (currentGeneration === generation.current) setProposalAction(null)
    }
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    void sendPrompt()
  }

  if (!draft) return <section className={styles.panel} aria-label="Skill builder"><DisabledState title="Choose a draft to build with Eve" message="Open a saved draft to give the builder a revision and digest to work against." /></section>
  if (availability?.enabled === false) return <section className={styles.panel} aria-label="Skill builder"><DisabledState title="Skill builder unavailable" message={availability.reason ?? 'The skill builder is disabled for this registry.'} /></section>
  if (availability === null || (loading && !session)) return <section className={styles.panel} aria-label="Skill builder" aria-busy="true"><div aria-atomic="true" aria-live="polite" className={styles.liveRegion} role="status">Loading the builder conversation.</div><div className={styles.loading}><span className={styles.spinner} aria-hidden="true" />Loading the builder conversation…</div></section>
  if (!session) return <section className={styles.panel} aria-label="Skill builder"><div className={styles.errorBlock} role={error ? 'alert' : undefined}><strong>Conversation unavailable</strong><span>{error ?? 'The builder conversation could not be loaded.'}</span><button className={styles.secondaryButton} type="button" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>Retry</button></div></section>

  return <section className={styles.panel} aria-busy={busy} aria-label="Skill builder">
    <div aria-atomic="true" aria-live="polite" className={styles.liveRegion} role="status">{builderLiveMessage(session, effectiveProposal, stopped)}</div>
    <header className={styles.header}>
      <div>
        <span className={styles.eyebrow}>Eve builder</span>
        <h2>Shape this draft with a conversation.</h2>
        <p className={styles.subtle}>Eve can suggest bounded file changes. You review and apply every proposal.</p>
      </div>
      <span className={`${styles.status} ${sending || sessionActive ? styles.statusBusy : session.state === 'failed' ? styles.statusError : styles.statusReady}`}>{sending || sessionActive ? 'Working' : session.state}</span>
    </header>
    <div className={styles.contextBar}>
      <span><strong>Draft</strong> {draft.draftId}</span>
      <span><strong>Revision</strong> {draft.revision}</span>
      <code title={draft.digest}>{shortDigest(draft.digest)}</code>
      {draft.selectedPath && <span className={styles.selectedFile}>Selected file · <code>{draft.selectedPath}</code></span>}
    </div>
    <div className={styles.transcript} aria-live="polite">
      {turns.length === 0 && <div className={styles.emptyTranscript}><span aria-hidden="true">✦</span><p>Ask for a focused change, explanation, or review of this draft.</p></div>}
      {turns.map((turn) => <article className={`${styles.turn} ${turn.role === 'user' ? styles.turnUser : styles.turnAssistant}`} key={turn.id}><div className={styles.turnMeta}><span>{turn.role === 'assistant' ? 'Eve' : turn.role === 'user' ? 'You' : 'Registry'}</span><time dateTime={turn.createdAt}>{formatTime(turn.createdAt)}</time></div><p>{turn.content}</p></article>)}
      {progress && <div className={styles.progress} role="status"><span className={styles.progressDot} aria-hidden="true" /><span>{progress.message}</span></div>}
      {stopped && <div className={styles.stopped} role="status">This request was cancelled in the browser. The server may finish it without applying changes; you can retry when ready.</div>}
    </div>
    {effectiveProposal && <ProposalCard proposal={effectiveProposal} busy={proposalAction !== null} canApply={canApply} applyDisabledReason={applyDisabledReason} onApply={() => void applyProposal()} onReject={() => void rejectProposal()} />}
    {error && <div className={styles.errorNotice} role="alert"><span>{error}</span>{lastRequest && !sending && !sessionActive && !sessionPolling && !refreshing && <button className={styles.retryButton} type="button" onClick={() => void sendPrompt(lastRequest.prompt, lastRequest.requestId)}>Retry</button>}</div>}
    <form className={styles.composer} onSubmit={submit}>
      <label className={styles.promptLabel} htmlFor="skill-builder-prompt">Prompt Eve</label>
      <textarea id="skill-builder-prompt" maxLength={MAX_PROMPT_LENGTH} disabled={busy} onChange={(event) => setPrompt(event.target.value)} placeholder="Describe one change you want to review…" rows={3} value={prompt} />
      <div className={styles.composerFooter}><span>{prompt.length.toLocaleString()} / {MAX_PROMPT_LENGTH.toLocaleString()}</span><div className={styles.composerActions}>{canStartNewConversation && <button className={styles.secondaryButton} type="button" disabled={busy} onClick={startNewConversation}>{restarting ? 'Starting…' : 'Start new conversation'}</button>}{(sending || stopping || sessionActive) && <button className={styles.secondaryButton} type="button" disabled={stopping} onClick={() => void stopPrompt()}>{stopping ? 'Stopping…' : 'Stop'}</button>}{sessionActive && !session.proposal && !sessionPolling && !sending && adapter.refreshSession && <button className={styles.secondaryButton} type="button" disabled={refreshing || stopping || proposalAction !== null} onClick={() => void refreshStatus()}>{refreshing ? 'Refreshing…' : 'Refresh status'}</button>}<button className={styles.primaryButton} disabled={busy || terminalSession || prompt.trim().length === 0} title={terminalSession ? 'Start a new conversation before sending another prompt.' : undefined} type="submit">{sending || sessionActive ? 'Working…' : terminalSession ? 'Start a new conversation first' : 'Send prompt'}</button></div></div>
    </form>
  </section>
}

function ProposalCard({ proposal, busy, canApply, applyDisabledReason, onApply, onReject }: { proposal: SkillBuilderProposal; busy: boolean; canApply: boolean; applyDisabledReason?: string; onApply: () => void; onReject: () => void }) {
  const isPending = proposal.state === 'pending'
  const digest = proposal.proposedDigest ?? proposal.diffDigest
  return <section className={styles.proposal} aria-label="Eve proposal">
    <header className={styles.proposalHeader}><div><span className={styles.proposalEyebrow}>Proposed change</span><h3>{proposal.operations.length} file change{proposal.operations.length === 1 ? '' : 's'}</h3>{digest ? <p>Base revision {proposal.baseRevision} · {proposal.proposedDigest ? 'proposed digest' : 'diff digest'} <code title={digest}>{shortDigest(digest)}</code></p> : <p>Base revision {proposal.baseRevision}</p>}</div><span className={`${styles.proposalState} ${proposal.state === 'pending' ? styles.proposalPending : proposal.state === 'applied' ? styles.proposalApplied : proposal.state === 'stale' ? styles.proposalStale : styles.proposalRejected}`}>{proposal.state}</span></header>
    <div className={styles.operations}>{proposal.operations.map((operation, index) => <ProposalOperation key={`${operation.op}:${operation.path}:${index}`} operation={operation} />)}</div>
    {isPending ? <footer className={styles.proposalActions}><span className={styles.proposalHint}>{canApply ? 'Review each diff before applying this revision.' : applyDisabledReason ?? 'Save or discard local changes before applying this proposal.'}</span><div><button className={styles.secondaryButton} disabled={busy} type="button" onClick={onReject}>Reject</button><button className={styles.primaryButton} aria-describedby={!canApply ? 'skill-builder-apply-disabled' : undefined} disabled={busy || !canApply} type="button" onClick={onApply}>{busy ? 'Saving…' : 'Apply proposal'}</button></div>{!canApply && <span id="skill-builder-apply-disabled" className={styles.proposalHint}>{applyDisabledReason ?? 'The editor has unsaved local changes.'}</span>}</footer> : <footer className={styles.proposalFooter}>This proposal is {proposal.state}. The editor remains the source of truth for the draft.</footer>}
  </section>
}

function ProposalOperation({ operation }: { operation: SkillBuilderProposalOperation }) {
  const diff = useMemo(() => proposalDiff(operation), [operation])
  return <article className={styles.operation}><div className={styles.operationHeading}><span className={`${styles.operationKind} ${styles[`operation${operation.op[0].toUpperCase()}${operation.op.slice(1)}`]}`}>{operation.op}</span><code>{proposalSummary(operation)}</code>{operation.contentBytes !== undefined && <span className={styles.operationBytes}>{operation.contentBytes.toLocaleString()} bytes</span>}</div>{diff ? <div className={styles.diffSurface}><FileDiff fileDiff={diff} disableWorkerPool options={{ diffStyle: 'split', overflow: 'scroll', themeType: 'light', theme: 'github-light', stickyHeader: true, unsafeCSS: PIERRE_ACCESSIBLE_CSS, onPostRender: onPierrePostRender }} /></div> : <p className={styles.noPreview}>The server returned a bounded summary for this operation. Open the draft file to inspect the resulting bytes before applying.</p>}</article>
}

function DisabledState({ title, message }: { title: string; message: string }) {
  return <div className={styles.disabled}><span className={styles.disabledMark} aria-hidden="true">✦</span><div><strong>{title}</strong><p>{message}</p></div></div>
}

function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return ''
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function isAbortLike(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && (value as { name?: unknown }).name === 'AbortError')
}
