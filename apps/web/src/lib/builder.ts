import { api, ApiError } from './api'
import type {
  BuilderConversation,
  BuilderConversationResponse,
  BuilderMessage,
  BuilderMessageResponse,
  BuilderOperation,
  BuilderProposal,
  BuilderProposalResponse,
  DraftResponse,
  DraftView,
} from './types'
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
 * Browser-side adapter for the builder BFF.  It deliberately uses the
 * registry client's same-origin cookie session; the Eve service token stays
 * in the server-side builder application.
 */

type BuilderEnvelope = BuilderConversation | BuilderConversationResponse | BuilderMessageResponse | BuilderProposalResponse

const conversationKeys = new Map<string, string>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
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

function conversationKey(binding: SkillBuilderDraftContext): string {
  const value = `${binding.draftId}:${binding.revision}:${binding.digest}`
  const existing = conversationKeys.get(value)
  if (existing) return existing
  // This key contains only the opaque draft id/revision/digest and is stable
  // for uncertain retries. It does not contain prompt or file contents.
  const key = `web-builder-${value}`
  conversationKeys.set(value, key)
  return key
}

function mapSessionState(value: unknown): SkillBuilderSession['state'] {
  switch (value) {
    case 'running': return 'running'
    case 'stopped': return 'stopped'
    case 'failed':
    case 'stale': return 'failed'
    case 'completed':
    case 'closed': return 'completed'
    case 'ready':
    case 'active':
    default: return 'ready'
  }
}

function mapProposalState(value: unknown): SkillBuilderProposal['state'] {
  switch (value) {
    case 'applied': return 'applied'
    case 'rejected': return 'rejected'
    case 'stale': return 'stale'
    case 'pending':
    case 'proposed':
    default: return 'pending'
  }
}

function unwrapConversation(value: BuilderEnvelope): BuilderConversation | null {
  if (isRecord(value) && isRecord(value.conversation)) return value.conversation as unknown as BuilderConversation
  if (isRecord(value) && typeof value.id === 'string' && typeof value.draftId === 'string') return value as unknown as BuilderConversation
  return null
}

function unwrapArray<T>(value: BuilderEnvelope, key: 'messages' | 'proposals'): T[] {
  if (!isRecord(value) || !Array.isArray(value[key])) return []
  return value[key] as T[]
}

function mapTurn(value: unknown): SkillBuilderConversationTurn {
  if (!isRecord(value)) throw schemaError('builder message is not an object.')
  const role = value.role
  if (role !== 'user' && role !== 'assistant' && role !== 'system') throw schemaError('builder message role is invalid.')
  return {
    id: requiredString(value.id, 'message.id'),
    role,
    content: requiredString(value.content, 'message.content'),
    createdAt: optionalString(value.createdAt) ?? '',
  }
}

function mapOperation(value: unknown): SkillBuilderProposalOperation {
  if (!isRecord(value)) throw schemaError('builder proposal operation is not an object.')
  const op = value.op ?? value.kind
  if (op !== 'add' && op !== 'edit' && op !== 'rename' && op !== 'delete') throw schemaError('builder proposal operation is invalid.')
  const before = typeof value.before === 'string' ? value.before : value.before === null ? null : undefined
  const after = typeof value.after === 'string' ? value.after : value.after === null ? null : undefined
  const content = typeof value.content === 'string' ? value.content : undefined
  const contentBytes = typeof value.contentBytes === 'number' && Number.isSafeInteger(value.contentBytes) ? value.contentBytes : content === undefined ? undefined : new TextEncoder().encode(content).byteLength
  return {
    op,
    path: requiredString(value.path, 'operation.path'),
    ...(typeof value.newPath === 'string' || typeof value.toPath === 'string' ? { newPath: (value.newPath ?? value.toPath) as string } : {}),
    ...(contentBytes === undefined ? {} : { contentBytes }),
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after: after ?? content ?? null }),
  }
}

function mapProposal(value: unknown, binding: SkillBuilderDraftContext, sessionId: string): SkillBuilderProposal {
  if (!isRecord(value)) throw schemaError('builder proposal is not an object.')
  const draftId = requiredString(value.draftId, 'proposal.draftId')
  if (draftId !== binding.draftId) throw staleError()
  const baseRevision = requiredNumber(value.baseRevision, 'proposal.baseRevision')
  const baseDigest = digest(value.baseDigest, 'proposal.baseDigest')
  if (baseRevision !== binding.revision || baseDigest !== binding.digest) throw staleError()
  if (!Array.isArray(value.operations)) throw schemaError('proposal.operations is missing from the builder response.')
  const rawSessionId = optionalString(value.sessionId) ?? optionalString(value.conversationId) ?? sessionId
  return {
    id: requiredString(value.id, 'proposal.id'),
    draftId,
    baseRevision,
    baseDigest,
    ...(digest(value.proposedDigest, 'proposal.proposedDigest', false) ? { proposedDigest: digest(value.proposedDigest, 'proposal.proposedDigest', false) } : {}),
    ...(digest(value.diffDigest, 'proposal.diffDigest', false) ? { diffDigest: digest(value.diffDigest, 'proposal.diffDigest', false) } : {}),
    operations: value.operations.map(mapOperation),
    state: mapProposalState(value.state),
    sessionId: rawSessionId,
    createdAt: optionalString(value.createdAt) ?? '',
  }
}

function mapSession(value: BuilderEnvelope, binding: SkillBuilderDraftContext, fallback?: SkillBuilderSession): SkillBuilderSession {
  const conversation = unwrapConversation(value)
  if (!conversation) {
    if (!fallback) throw schemaError('builder conversation is missing from the response.')
    const rawMessage = isRecord(value) && value.message ? value.message : null
    const rawProposal = isRecord(value) && value.proposal ? value.proposal : null
    const turns = rawMessage ? [...fallback.turns, mapTurn(rawMessage)] : fallback.turns
    const proposal = rawProposal ? mapProposal(rawProposal, binding, fallback.id) : fallback.proposal
    return { ...fallback, turns, ...(proposal ? { proposal } : {}) }
  }
  const draftId = requiredString(conversation.draftId, 'conversation.draftId')
  const draftRevision = requiredNumber(conversation.draftRevision, 'conversation.draftRevision')
  const draftDigest = digest(conversation.draftDigest, 'conversation.draftDigest')
  if (draftId !== binding.draftId || draftRevision !== binding.revision || draftDigest !== binding.digest) throw staleError()
  const messages = Array.isArray(conversation.messages) ? conversation.messages : unwrapArray<BuilderMessage>(value, 'messages')
  const proposalValues = Array.isArray(conversation.proposals) ? conversation.proposals : unwrapArray<BuilderProposal>(value, 'proposals')
  const rawProposal = isRecord(value) && value.proposal ? value.proposal : proposalValues[proposalValues.length - 1]
  const proposal = rawProposal ? mapProposal(rawProposal, binding, requiredString(conversation.id, 'conversation.id')) : null
  return {
    id: requiredString(conversation.id, 'conversation.id'),
    binding,
    state: mapSessionState(conversation.state),
    turns: messages.map(mapTurn),
    ...(proposal ? { proposal } : {}),
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
    async loadSession({ binding, signal }) {
      const response = await api.builderCreateConversation(binding.draftId, { draftRevision: binding.revision, draftDigest: binding.digest }, conversationKey(binding), signal)
      const session = mapSession(response, binding)
      sessions.set(session.id, session)
      return session
    },

    async sendPrompt(input: SkillBuilderPromptInput): Promise<SkillBuilderPromptResult> {
      input.onProgress?.({ phase: 'reading-context', message: 'Reading the selected draft revision…' })
      input.onProgress?.({ phase: 'thinking', message: 'Waiting for Eve to prepare a bounded response…' })
      const response = await api.builderMessage(input.binding.draftId, input.sessionId, {
        draftRevision: input.binding.revision,
        draftDigest: input.binding.digest,
        content: input.prompt,
        ...(input.binding.selectedPath ? { selectedPath: input.binding.selectedPath } : {}),
      }, input.requestId, input.signal)
      input.onProgress?.({ phase: 'preparing-proposal', message: 'Preparing a reviewable proposal…' })
      const previous = sessions.get(input.sessionId)
      const session = mapSession(response, input.binding, previous)
      sessions.set(session.id, session)
      return { session, proposal: session.proposal ?? null }
    },

    async reloadDraft({ binding, signal }) {
      const response = await api.draft(binding.draftId, signal)
      return validateReboundDraft(response, binding)
    },

    async stop() {
      // The browser aborts the same-origin request before invoking this hook.
      // There is no portable stop route in the documented BFF seam; keeping
      // this method local avoids pretending a cancelled fetch stopped Eve.
    },

    async applyProposal({ binding, sessionId, proposalId, requestId }): Promise<SkillBuilderProposalResult> {
      const response = await api.applyBuilderProposal(binding.draftId, proposalId, { expectedRevision: binding.revision, idempotencyKey: requestId })
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
      const response = await api.rejectBuilderProposal(binding.draftId, proposalId, requestId)
      if (!response.proposal) return undefined
      const proposal = mapProposal(response.proposal, binding, sessionId)
      const previous = sessions.get(sessionId)
      const session = previous ? { ...previous, proposal } : undefined
      if (session) sessions.set(session.id, session)
      return { ...(session ? { session } : {}), proposal }
    },
  }
}
