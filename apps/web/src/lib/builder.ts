import { api, ApiError } from './api'
import type { DraftResponse, DraftView } from './types'
import type {
  SkillBuilderConversationTurn,
  SkillBuilderDraftContext,
  SkillBuilderPanelAdapter,
  SkillBuilderProposal,
  SkillBuilderProposalOperation,
  SkillBuilderProposalResult,
  SkillBuilderPromptInput,
  SkillBuilderPromptResult,
  SkillBuilderSession,
} from '../components/SkillBuilderPanel'

/**
 * Browser-side adapter for the same-origin builder BFF. Eve credentials and
 * provider session identifiers remain server-side; the browser only receives
 * the registry-owned session DTO.
 */

const sessionRequestKeys = new Map<string, string>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw schemaError(`${field} is missing from the builder response.`)
  return value
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw schemaError(`${field} is invalid in the builder response.`)
  return value
}

function digest(value: unknown, field: string, required = true): `sha256:${string}` | undefined {
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string' || !value.startsWith('sha256:') || value.length <= 7) throw schemaError(`${field} is invalid in the builder response.`)
  return value as `sha256:${string}`
}

function schemaError(message: string): ApiError {
  return new ApiError(502, { code: 'BUILDER_SCHEMA', message })
}

function staleError(message = 'The builder response belongs to a different draft revision.'): ApiError {
  return new ApiError(409, { code: 'STALE_BINDING', message })
}

function sessionRequestKey(binding: SkillBuilderDraftContext): string {
  const key = `${binding.draftId}:${binding.revision}:${binding.digest}`
  const existing = sessionRequestKeys.get(key)
  if (existing) return existing
  // Keep the retry key bounded and free of control characters. The server
  // deduplicates session creation by the immutable draft binding as well.
  const safeDraftId = binding.draftId.replace(/[^a-z0-9_-]/giu, '_').slice(0, 120)
  const requestId = `web-builder-session-${safeDraftId}-${binding.revision}-${binding.digest.slice(-16)}`
  sessionRequestKeys.set(key, requestId)
  return requestId
}

function mapSessionState(value: unknown): SkillBuilderSession['state'] {
  if (value === 'ready' || value === 'running' || value === 'stopped' || value === 'failed' || value === 'completed') return value
  throw schemaError('session.state is invalid in the builder response.')
}

function mapProposalState(value: unknown): SkillBuilderProposal['state'] {
  if (value === 'pending' || value === 'applied' || value === 'rejected' || value === 'stale') return value
  throw schemaError('proposal.state is invalid in the builder response.')
}

function mapTurn(value: unknown): SkillBuilderConversationTurn {
  if (!isRecord(value)) throw schemaError('session.turns contains an invalid turn.')
  const role = value.role
  if (role !== 'user' && role !== 'assistant' && role !== 'system') throw schemaError('turn.role is invalid in the builder response.')
  return {
    id: requiredString(value.id, 'turn.id'),
    role,
    content: requiredString(value.content, 'turn.content'),
    createdAt: optionalString(value.createdAt) ?? '',
  }
}

function mapOperation(value: unknown): SkillBuilderProposalOperation {
  if (!isRecord(value)) throw schemaError('proposal.operations contains an invalid operation.')
  const op = value.op
  if (op !== 'add' && op !== 'edit' && op !== 'rename' && op !== 'delete') throw schemaError('operation.op is invalid in the builder response.')
  const contentBytes = value.contentBytes
  if (contentBytes !== undefined && (typeof contentBytes !== 'number' || !Number.isSafeInteger(contentBytes) || contentBytes < 0)) {
    throw schemaError('operation.contentBytes is invalid in the builder response.')
  }
  const newPath = value.newPath
  if (newPath !== undefined && typeof newPath !== 'string') throw schemaError('operation.newPath is invalid in the builder response.')
  const before = value.before
  if (before !== undefined && before !== null && typeof before !== 'string') throw schemaError('operation.before is invalid in the builder response.')
  const after = value.after
  if (after !== undefined && after !== null && typeof after !== 'string') throw schemaError('operation.after is invalid in the builder response.')
  return {
    op,
    path: requiredString(value.path, 'operation.path'),
    ...(newPath === undefined ? {} : { newPath }),
    ...(contentBytes === undefined ? {} : { contentBytes }),
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
  }
}

function mapProposal(value: unknown, binding: SkillBuilderDraftContext, sessionId: string): SkillBuilderProposal {
  if (!isRecord(value)) throw schemaError('builder proposal is missing from the response.')
  const draftId = requiredString(value.draftId, 'proposal.draftId')
  const baseRevision = requiredNumber(value.baseRevision, 'proposal.baseRevision')
  const baseDigest = digest(value.baseDigest, 'proposal.baseDigest')
  if (draftId !== binding.draftId || baseRevision !== binding.revision || baseDigest !== binding.digest) throw staleError()
  if (!Array.isArray(value.operations)) throw schemaError('proposal.operations is missing from the builder response.')
  const rawSessionId = optionalString(value.sessionId) ?? sessionId
  if (rawSessionId !== sessionId) throw staleError('The builder proposal belongs to a different session.')
  const proposedDigest = digest(value.proposedDigest, 'proposal.proposedDigest', false)
  const diffDigest = digest(value.diffDigest, 'proposal.diffDigest', false)
  return {
    id: requiredString(value.id, 'proposal.id'),
    draftId,
    baseRevision,
    baseDigest,
    ...(proposedDigest ? { proposedDigest } : {}),
    ...(diffDigest ? { diffDigest } : {}),
    operations: value.operations.map(mapOperation),
    state: mapProposalState(value.state),
    sessionId: rawSessionId,
    createdAt: optionalString(value.createdAt) ?? '',
  }
}

function mapSession(value: unknown, binding: SkillBuilderDraftContext, expectedSessionId?: string): SkillBuilderSession {
  if (!isRecord(value) || !isRecord(value.session)) throw schemaError('builder session is missing from the response.')
  const raw = value.session
  const id = requiredString(raw.id, 'session.id')
  if (expectedSessionId !== undefined && id !== expectedSessionId) throw staleError('The builder response returned a different session.')
  if (!isRecord(raw.binding)) throw schemaError('session.binding is missing from the builder response.')
  const draftId = requiredString(raw.binding.draftId, 'session.binding.draftId')
  const revision = requiredNumber(raw.binding.revision, 'session.binding.revision')
  const rawDigest = digest(raw.binding.digest, 'session.binding.digest')
  if (draftId !== binding.draftId || revision !== binding.revision || rawDigest !== binding.digest) throw staleError()
  if (!Array.isArray(raw.turns)) throw schemaError('session.turns is missing from the builder response.')
  const proposal = raw.proposal === undefined || raw.proposal === null ? null : mapProposal(raw.proposal, binding, id)
  return {
    id,
    binding,
    state: mapSessionState(raw.state),
    turns: raw.turns.map(mapTurn),
    ...(proposal ? { proposal } : {}),
  }
}

function mapAvailability(value: unknown): { enabled: boolean; reason?: string; model?: string } {
  if (!isRecord(value) || typeof value.enabled !== 'boolean') throw schemaError('builder availability is invalid.')
  if (value.reason !== undefined && typeof value.reason !== 'string') throw schemaError('availability.reason is invalid.')
  if (value.model !== undefined && typeof value.model !== 'string') throw schemaError('availability.model is invalid.')
  return {
    enabled: value.enabled,
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    ...(typeof value.model === 'string' ? { model: value.model } : {}),
  }
}

function validateDraft(response: DraftResponse, binding: SkillBuilderDraftContext): DraftResponse['draft'] {
  const draft = response.draft
  if (!draft || draft.id !== binding.draftId) throw staleError('The builder apply response returned a different draft.')
  if (draft.revision < binding.revision) throw staleError('The builder apply response returned an older draft revision.')
  return draft
}

function validateReboundDraft(response: DraftResponse, binding: SkillBuilderDraftContext): DraftView {
  const draft = validateDraft(response, binding)
  if (draft.revision <= binding.revision) throw staleError('The builder apply did not return a newer draft revision.')
  return draft
}

export function createSkillBuilderAdapter(): SkillBuilderPanelAdapter {
  const sessions = new Map<string, SkillBuilderSession>()

  return {
    async getAvailability({ draftId, signal }) {
      return mapAvailability(await api.builderAvailability(draftId, signal))
    },

    async loadSession({ binding, signal }) {
      const created = await api.builderCreateSession(binding.draftId, {
        revision: binding.revision,
        digest: binding.digest,
        requestId: sessionRequestKey(binding),
      }, signal)
      const createdSession = mapSession(created, binding)
      // POST /session resumes an existing registry session. Hydrate the
      // server-owned history through the ID-addressed GET before rendering so
      // a browser refresh never silently erases the conversation transcript.
      const hydrated = await api.builderSession(binding.draftId, createdSession.id, {
        revision: binding.revision,
        digest: binding.digest,
      }, signal)
      const session = mapSession(hydrated, binding, createdSession.id)
      sessions.set(session.id, session)
      return session
    },

    async sendPrompt(input: SkillBuilderPromptInput): Promise<SkillBuilderPromptResult> {
      input.onProgress?.({ phase: 'reading-context', message: 'Reading the selected draft revision…' })
      input.onProgress?.({ phase: 'thinking', message: 'Waiting for Eve to prepare a bounded response…' })
      const response = await api.builderPrompt(input.binding.draftId, input.sessionId, {
        revision: input.binding.revision,
        digest: input.binding.digest,
        prompt: input.prompt,
        requestId: input.requestId,
        ...(input.binding.selectedPath ? { selectedPath: input.binding.selectedPath } : {}),
      }, input.signal)
      input.onProgress?.({ phase: 'preparing-proposal', message: 'Preparing a reviewable proposal…' })
      const session = mapSession(response, input.binding, input.sessionId)
      sessions.set(session.id, session)
      return { session, proposal: session.proposal ?? null }
    },

    async reloadDraft({ binding, signal }) {
      const response = await api.draft(binding.draftId, signal)
      return validateReboundDraft(response, binding)
    },

    async stop({ binding, sessionId, requestId }) {
      await api.builderStop(binding.draftId, sessionId, {
        revision: binding.revision,
        digest: binding.digest,
        requestId,
      })
      const previous = sessions.get(sessionId)
      if (previous) sessions.set(sessionId, { ...previous, state: 'stopped' })
    },

    async applyProposal({ binding, sessionId, proposalId, requestId }): Promise<SkillBuilderProposalResult> {
      const response = await api.applyBuilderProposal(binding.draftId, proposalId, {
        revision: binding.revision,
        digest: binding.digest,
        sessionId,
        idempotencyKey: requestId,
      })
      const rawProposal = response.proposal
      if (!rawProposal) throw schemaError('The builder apply response did not include the proposal.')
      const proposal = mapProposal(rawProposal, binding, sessionId)
      const draft = response.draft ? validateDraft({ draft: response.draft }, binding) : undefined
      const previous = sessions.get(sessionId)
      const session = previous ? { ...previous, proposal } : undefined
      if (session) sessions.set(session.id, session)
      return { ...(session ? { session } : {}), proposal, ...(draft ? { draft } : {}) }
    },

    async rejectProposal({ binding, sessionId, proposalId, requestId }) {
      const response = await api.rejectBuilderProposal(binding.draftId, proposalId, {
        revision: binding.revision,
        digest: binding.digest,
        sessionId,
        idempotencyKey: requestId,
      })
      if (!response.proposal) throw schemaError('The builder reject response did not include the proposal.')
      const proposal = mapProposal(response.proposal, binding, sessionId)
      const previous = sessions.get(sessionId)
      const session = previous ? { ...previous, proposal } : undefined
      if (session) sessions.set(session.id, session)
      return { ...(session ? { session } : {}), proposal }
    },
  }
}
