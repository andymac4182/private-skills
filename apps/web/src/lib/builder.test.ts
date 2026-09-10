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
    files: [{ path: 'SKILL.md', content: 'I1VwZGF0ZWQK' }],
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
    vi.stubGlobal('fetch', fetchMock)

    const adapter = createSkillBuilderAdapter()
    const availability = await adapter.getAvailability?.({ draftId: binding.draftId, signal: new AbortController().signal })
    const loaded = await adapter.loadSession({ binding, signal: new AbortController().signal })

    expect(availability).toEqual({ enabled: true, model: 'openai/gpt-5' })
    expect(loaded.id).toBe('session-1')
    expect(loaded.turns).toHaveLength(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/v1/drafts/draft-1/builder/availability')
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/v1/drafts/draft-1/builder/session')
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))).toMatchObject({ revision: 4, digest: 'sha256:base' })
    const createBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))
    expect(createBody.requestId).toMatch(/^web-builder-session-/u)
    const sessionUrl = new URL(String(fetchMock.mock.calls[2]?.[0]), 'https://registry.test')
    expect(sessionUrl.pathname).toBe('/v1/drafts/draft-1/builder/session/session-1')
    expect(sessionUrl.searchParams.get('revision')).toBe('4')
    expect(sessionUrl.searchParams.get('digest')).toBe('sha256:base')
  })

  it('sends a bound prompt and reaches the real stop route without a service bearer', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(session()))
      .mockResolvedValueOnce(response(session()))
      .mockResolvedValueOnce(response(session({
        state: 'running',
        turns: [{ id: 'turn-2', role: 'user', content: 'Improve the introduction.', createdAt: '2026-09-10T00:01:00.000Z' }],
        proposal: proposal(),
      }), 202))
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
    const [promptPath, promptInit] = fetchMock.mock.calls[2] as [string, RequestInit]
    const promptUrl = new URL(promptPath, 'https://registry.test')
    expect(promptUrl.pathname).toBe('/v1/drafts/draft-1/builder/session/session-1/prompt')
    expect(promptUrl.searchParams.get('revision')).toBe('4')
    expect(promptUrl.searchParams.get('digest')).toBe('sha256:base')
    expect(JSON.parse(String(promptInit.body))).toEqual({ prompt: 'Improve the introduction.', requestId: 'prompt-1', selectedPath: 'SKILL.md' })
    expect(new Headers(promptInit.headers).get('authorization')).toBeNull()
    const [stopPath, stopInit] = fetchMock.mock.calls[3] as [string, RequestInit]
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(session({ binding: { ...binding, revision: 5 } }))))
    const adapter = createSkillBuilderAdapter()
    await expect(adapter.loadSession({ binding, signal: new AbortController().signal })).rejects.toMatchObject({ code: 'STALE_BINDING', status: 409 })
  })
})
