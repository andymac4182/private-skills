import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSkillBuilderAdapter } from './builder'

const binding = {
  draftId: 'draft-1',
  revision: 4,
  digest: 'sha256:base' as const,
  selectedPath: 'SKILL.md',
}

function response(body: unknown, status = 200): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    session: {
      id: 'session-1',
      binding: { draftId: binding.draftId, revision: binding.revision, digest: binding.digest },
      state: 'ready',
      turns: [],
      proposal: null,
      ...overrides,
    },
  }
}

function proposal(state: 'pending' | 'applied' | 'rejected' = 'pending') {
  return {
    id: 'proposal-1',
    draftId: binding.draftId,
    baseRevision: binding.revision,
    baseDigest: binding.digest,
    proposedDigest: 'sha256:next',
    state,
    sessionId: 'session-1',
    createdAt: '2026-09-10T00:01:00.000Z',
    operations: [{ op: 'edit', path: 'SKILL.md', contentBytes: 12 }],
  }
}

function proposalWithPreview(state: 'pending' | 'applied' | 'rejected' = 'pending') {
  return {
    ...proposal(state),
    operations: [{ op: 'edit', path: 'SKILL.md', contentBytes: 12, before: '# Before\n', after: '# After\n' }],
  }
}

function draft() {
  return {
    id: binding.draftId,
    name: 'demo-skill',
    skillName: 'demo-skill',
    baseResourceId: 'resource-1',
    baseDigest: binding.digest,
    revision: 5,
    digest: 'sha256:next' as const,
    size: 12,
    files: [{ path: 'SKILL.md', size: 11, digest: 'sha256:' + 'n'.repeat(64) }],
    status: 'open' as const,
    actor: 'owner',
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:02:00.000Z',
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('same-origin skill builder BFF adapter', () => {
  it('checks draft-scoped availability and hydrates the ID-addressed session history', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ enabled: true, model: 'openai/gpt-5' }))
      .mockResolvedValueOnce(response(session()))
      .mockResolvedValueOnce(response(session({
        turns: [{ id: 'turn-1', role: 'assistant', content: 'Ready.', createdAt: '2026-09-10T00:00:00.000Z' }],
      })))
      .mockResolvedValueOnce(response({ proposals: [] }))
    vi.stubGlobal('fetch', fetchMock)

    const adapter = createSkillBuilderAdapter()
    const availability = await adapter.getAvailability?.({ draftId: binding.draftId, signal: new AbortController().signal })
    const loaded = await adapter.loadSession({ binding, signal: new AbortController().signal })

    expect(availability).toEqual({ enabled: true, model: 'openai/gpt-5' })
    expect(loaded.id).toBe('session-1')
    expect(loaded.turns).toHaveLength(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/v1/drafts/draft-1/builder/availability')
    const createUrl = new URL(String(fetchMock.mock.calls[1]?.[0]), 'https://registry.test')
    expect(createUrl.pathname).toBe('/v1/drafts/draft-1/builder/session')
    expect(createUrl.searchParams.get('revision')).toBe('4')
    expect(createUrl.searchParams.get('digest')).toBe('sha256:base')
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))).toMatchObject({ revision: 4, digest: 'sha256:base' })
    const createBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))
    expect(createBody.requestId).toMatch(/^web-builder-session-/u)
    const sessionUrl = new URL(String(fetchMock.mock.calls[2]?.[0]), 'https://registry.test')
    expect(sessionUrl.pathname).toBe('/v1/drafts/draft-1/builder/session/session-1')
    expect(sessionUrl.searchParams.get('revision')).toBe('4')
    expect(sessionUrl.searchParams.get('digest')).toBe('sha256:base')
  })

  it('uses a new session request identity when the draft binding advances', async () => {
    const nextBinding = { draftId: binding.draftId, revision: 5, digest: 'sha256:next' as const, selectedPath: 'SKILL.md' }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(session()))
      .mockResolvedValueOnce(response(session()))
      .mockResolvedValueOnce(response({ proposals: [] }))
      .mockResolvedValueOnce(response(session({ id: 'session-2', binding: { draftId: nextBinding.draftId, revision: nextBinding.revision, digest: nextBinding.digest } })))
      .mockResolvedValueOnce(response(session({ id: 'session-2', binding: { draftId: nextBinding.draftId, revision: nextBinding.revision, digest: nextBinding.digest } })))
      .mockResolvedValueOnce(response({ proposals: [] }))
    vi.stubGlobal('fetch', fetchMock)

    const adapter = createSkillBuilderAdapter()
    const first = await adapter.loadSession({ binding, signal: new AbortController().signal })
    const second = await adapter.loadSession({ binding: nextBinding, signal: new AbortController().signal })

    expect(first.id).toBe('session-1')
    expect(second.id).toBe('session-2')
    const firstCreateUrl = new URL(String(fetchMock.mock.calls[0]?.[0]), 'https://registry.test')
    const secondCreateUrl = new URL(String(fetchMock.mock.calls[3]?.[0]), 'https://registry.test')
    expect(firstCreateUrl.searchParams.get('revision')).toBe('4')
    expect(firstCreateUrl.searchParams.get('digest')).toBe('sha256:base')
    expect(secondCreateUrl.searchParams.get('revision')).toBe('5')
    expect(secondCreateUrl.searchParams.get('digest')).toBe('sha256:next')
    const firstRequestId = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)).requestId
    const secondRequestId = JSON.parse(String((fetchMock.mock.calls[3]?.[1] as RequestInit).body)).requestId
    expect(secondRequestId).not.toBe(firstRequestId)
  })

  it('sends a bound prompt and reaches the real stop route without a service bearer', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(session()))
      .mockResolvedValueOnce(response(session()))
      .mockResolvedValueOnce(response({ proposals: [] }))
      .mockResolvedValueOnce(response(session({
        state: 'running',
        turns: [{ id: 'turn-2', role: 'user', content: 'Improve the introduction.', createdAt: '2026-09-10T00:01:00.000Z' }],
        proposal: proposal(),
      }), 202))
      .mockResolvedValueOnce(response({ proposals: [proposalWithPreview()] }))
      .mockResolvedValueOnce(response(undefined, 204))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createSkillBuilderAdapter()
    const loaded = await adapter.loadSession({ binding, signal: new AbortController().signal })
    const progress: string[] = []
    const result = await adapter.sendPrompt({
      binding,
      sessionId: loaded.id,
      prompt: 'Improve the introduction.',
      requestId: 'prompt-1',
      signal: new AbortController().signal,
      onProgress: (value) => progress.push(value.phase),
    })
    await adapter.stop({ binding, sessionId: loaded.id, requestId: 'stop-1' })

    expect(result.session.state).toBe('running')
    expect(result.proposal?.id).toBe('proposal-1')
    expect(progress).toEqual(['reading-context', 'thinking', 'preparing-proposal'])
    const [promptPath, promptInit] = fetchMock.mock.calls[3] as [string, RequestInit]
    const promptUrl = new URL(promptPath, 'https://registry.test')
    expect(promptUrl.pathname).toBe('/v1/drafts/draft-1/builder/session/session-1/prompt')
    expect(promptUrl.searchParams.get('revision')).toBe('4')
    expect(promptUrl.searchParams.get('digest')).toBe('sha256:base')
    expect(JSON.parse(String(promptInit.body))).toEqual({ prompt: 'Improve the introduction.', requestId: 'prompt-1', selectedPath: 'SKILL.md' })
    expect(new Headers(promptInit.headers).get('authorization')).toBeNull()
    const [previewPath, previewInit] = fetchMock.mock.calls[4] as [string, RequestInit]
    const previewUrl = new URL(previewPath, 'https://registry.test')
    expect(previewUrl.pathname).toBe('/v1/drafts/draft-1/proposals')
    expect(previewUrl.searchParams.get('revision')).toBe('4')
    expect(previewUrl.searchParams.get('digest')).toBe('sha256:base')
    expect(previewInit.credentials).toBe('include')
    expect(new Headers(previewInit.headers).get('authorization')).toBeNull()
    const hydratedProposal = result.proposal
    expect(hydratedProposal?.operations[0]?.before).toBe('# Before\n')
    expect(hydratedProposal?.operations[0]?.after).toBe('# After\n')
    const [stopPath, stopInit] = fetchMock.mock.calls[5] as [string, RequestInit]
    const stopUrl = new URL(stopPath, 'https://registry.test')
    expect(stopUrl.pathname).toBe('/v1/drafts/draft-1/builder/session/session-1/stop')
    expect(stopUrl.searchParams.get('revision')).toBe('4')
    expect(JSON.parse(String(stopInit.body))).toEqual({ requestId: 'stop-1' })
  })

  it('pins proposal apply and reject to the session binding and preserves the returned draft', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ proposal: proposal('applied'), draft: draft() }))
      .mockResolvedValueOnce(response({ proposal: proposal('rejected') }))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createSkillBuilderAdapter()

    const applied = await adapter.applyProposal({ binding, sessionId: 'session-1', proposalId: 'proposal-1', requestId: 'apply-1' })
    const rejected = await adapter.rejectProposal({ binding, sessionId: 'session-1', proposalId: 'proposal-1', requestId: 'reject-1' })

    expect(applied.proposal.state).toBe('applied')
    expect(applied.draft?.revision).toBe(5)
    expect(rejected?.proposal.state).toBe('rejected')
    const [applyPath, applyInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(applyPath).toBe('/v1/drafts/draft-1/proposals/proposal-1/apply')
    expect(JSON.parse(String(applyInit.body))).toEqual({ revision: 4, digest: 'sha256:base', sessionId: 'session-1' })
    expect(new Headers(applyInit.headers).get('idempotency-key')).toBe('apply-1')
    const [rejectPath, rejectInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(rejectPath).toBe('/v1/drafts/draft-1/proposals/proposal-1/reject')
    expect(JSON.parse(String(rejectInit.body))).toEqual({ revision: 4, digest: 'sha256:base', sessionId: 'session-1' })
    expect(new Headers(rejectInit.headers).get('idempotency-key')).toBe('reject-1')
  })

  it('fails closed when the BFF returns a session bound to another revision', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response(session({ binding: { ...binding, revision: 5 } })))
      .mockResolvedValueOnce(response({ proposals: [] })))
    const adapter = createSkillBuilderAdapter()
    await expect(adapter.loadSession({ binding, signal: new AbortController().signal })).rejects.toMatchObject({ code: 'STALE_BINDING', status: 409 })
  })

  it('polls a 202 running prompt until the ID-addressed session exposes a proposal', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(session()))
      .mockResolvedValueOnce(response(session()))
      .mockResolvedValueOnce(response({ proposals: [] }))
      .mockResolvedValueOnce(response(session({ state: 'running', turns: [{ id: 'turn-3', role: 'user', content: 'Add a usage example.', createdAt: '2026-09-10T00:03:00.000Z' }] }), 202))
      .mockResolvedValueOnce(response({ proposals: [] }))
      .mockResolvedValueOnce(response(session({ state: 'completed', proposal: proposal() })))
      .mockResolvedValueOnce(response({ proposals: [proposalWithPreview()] }))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createSkillBuilderAdapter()
    const loaded = await adapter.loadSession({ binding, signal: new AbortController().signal })
    const observedStates: string[] = []
    const result = await adapter.sendPrompt({
      binding,
      sessionId: loaded.id,
      prompt: 'Add a usage example.',
      requestId: 'prompt-poll-1',
      signal: new AbortController().signal,
      onSession: (next) => observedStates.push(`${next.state}:${next.proposal ? 'proposal' : 'pending'}`),
    })

    expect(result.session.state).toBe('completed')
    expect(result.proposal?.operations[0]?.before).toBe('# Before\n')
    expect(observedStates[0]).toBe('running:pending')
    expect(observedStates.at(-1)).toBe('completed:proposal')
    expect(fetchMock).toHaveBeenCalledTimes(7)
    const pollUrl = new URL(String(fetchMock.mock.calls[5]?.[0]), 'https://registry.test')
    expect(pollUrl.pathname).toBe('/v1/drafts/draft-1/builder/session/session-1')
    expect(pollUrl.searchParams.get('revision')).toBe('4')
  })

  it('resumes polling for a running session returned by the reload path', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(session()))
      .mockResolvedValueOnce(response(session({ state: 'running' })))
      .mockResolvedValueOnce(response({ proposals: [] }))
      .mockResolvedValueOnce(response(session({ state: 'completed', proposal: proposal() })))
      .mockResolvedValueOnce(response({ proposals: [proposalWithPreview()] }))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createSkillBuilderAdapter()
    const observedStates: string[] = []
    const loaded = await adapter.loadSession({ binding, signal: new AbortController().signal, onSession: (next) => observedStates.push(next.state) })

    expect(loaded.state).toBe('completed')
    expect(loaded.proposal?.operations[0]?.after).toBe('# After\n')
    expect(observedStates[0]).toBe('running')
    expect(observedStates.at(-1)).toBe('completed')
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  it('leaves a bounded running session recoverable through refreshSession', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(session()))
      .mockResolvedValueOnce(response(session({ state: 'running' })))
      .mockResolvedValueOnce(response({ proposals: [] }))
      .mockResolvedValueOnce(response(session({ state: 'running' })))
      .mockResolvedValueOnce(response({ proposals: [] }))
      .mockResolvedValueOnce(response(session({ state: 'completed', proposal: proposal() })))
      .mockResolvedValueOnce(response({ proposals: [proposalWithPreview()] }))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createSkillBuilderAdapter({ pollIntervalMs: 0, maxPollAttempts: 1 })
    const loaded = await adapter.loadSession({ binding, signal: new AbortController().signal })

    expect(loaded.state).toBe('running')
    const refreshSession = adapter.refreshSession
    expect(refreshSession).toBeDefined()
    const resumed = await refreshSession!({ binding, sessionId: loaded.id, signal: new AbortController().signal })

    expect(resumed.state).toBe('completed')
    expect(resumed.proposal?.operations[0]?.after).toBe('# After\n')
    expect(fetchMock).toHaveBeenCalledTimes(7)
  })

  it('keeps an applied proposal as history when the session has rebound to its new draft', async () => {
    const reboundBinding = { draftId: binding.draftId, revision: 5, digest: 'sha256:next' as const }
    const historical = { ...proposal('applied'), baseRevision: binding.revision, baseDigest: binding.digest }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ session: { id: 'session-1', binding: reboundBinding, state: 'completed', turns: [], proposal: historical } }))
      .mockResolvedValueOnce(response({ session: { id: 'session-1', binding: reboundBinding, state: 'completed', turns: [], proposal: historical } }))
      .mockResolvedValueOnce(response({ proposals: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createSkillBuilderAdapter()
    const loaded = await adapter.loadSession({ binding: reboundBinding, signal: new AbortController().signal })

    expect(loaded.binding.revision).toBe(5)
    expect(loaded.proposal?.state).toBe('applied')
    expect(loaded.proposal?.baseRevision).toBe(4)
    expect(loaded.proposal?.baseDigest).toBe('sha256:base')
  })
})
