import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSkillBuilderAdapter } from './builder'

const binding = {
  draftId: 'draft-1',
  revision: 4,
  digest: 'sha256:base' as const,
  selectedPath: 'SKILL.md',
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function conversation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    draftId: binding.draftId,
    draftRevision: binding.revision,
    draftDigest: binding.digest,
    state: 'active',
    messages: [{ id: 'turn-1', role: 'assistant', content: 'Ready.', createdAt: '2026-09-10T00:00:00.000Z' }],
    ...overrides,
  }
}

function proposal(state: 'proposed' | 'applied' | 'rejected' = 'proposed') {
  return {
    id: 'proposal-1',
    conversationId: 'session-1',
    draftId: binding.draftId,
    baseRevision: binding.revision,
    baseDigest: binding.digest,
    diffDigest: 'sha256:diff',
    state,
    createdAt: '2026-09-10T00:01:00.000Z',
    operations: [{ kind: 'edit', path: 'SKILL.md', content: '# Updated\n' }],
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

describe('same-origin skill builder adapter', () => {
  it('loads a bound conversation and sends a prompt without a service bearer', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ conversation: conversation() }))
      .mockResolvedValueOnce(response({ conversation: conversation({
        messages: [
          { id: 'turn-1', role: 'assistant', content: 'Ready.', createdAt: '2026-09-10T00:00:00.000Z' },
          { id: 'turn-2', role: 'user', content: 'Improve the introduction.', createdAt: '2026-09-10T00:01:00.000Z' },
          { id: 'turn-3', role: 'assistant', content: 'I prepared a proposal.', createdAt: '2026-09-10T00:01:01.000Z' },
        ],
        proposals: [proposal()],
      }) }))
    vi.stubGlobal('fetch', fetchMock)

    const adapter = createSkillBuilderAdapter()
    const loaded = await adapter.loadSession({ binding, signal: new AbortController().signal })
    const progress: string[] = []
    const result = await adapter.sendPrompt({
      binding,
      sessionId: loaded.id,
      prompt: 'Improve the introduction.',
      requestId: 'request-1',
      signal: new AbortController().signal,
      onProgress: (value) => progress.push(value.phase),
    })

    expect(result.session.id).toBe('session-1')
    expect(result.session.turns).toHaveLength(3)
    expect(result.proposal?.id).toBe('proposal-1')
    expect(progress).toEqual(['reading-context', 'thinking', 'preparing-proposal'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(init.headers).toBeInstanceOf(Headers)
    expect((init.headers as Headers).get('authorization')).toBeNull()
    expect(JSON.parse(String(init.body))).toEqual({
      draftRevision: 4,
      draftDigest: 'sha256:base',
      content: 'Improve the introduction.',
      selectedPath: 'SKILL.md',
    })
  })

  it('pins apply to the requested proposal and returns the exact new draft', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response({ proposal: proposal('applied'), draft: draft() }))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createSkillBuilderAdapter()

    const result = await adapter.applyProposal({
      binding,
      sessionId: 'session-1',
      proposalId: 'proposal-1',
      requestId: 'apply-1',
    })

    expect(result.proposal.state).toBe('applied')
    expect(result.draft?.id).toBe(binding.draftId)
    expect(result.draft?.revision).toBe(5)
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/v1/drafts/draft-1/builder/proposals/proposal-1/apply')
    expect(JSON.parse(String(init.body))).toEqual({ expectedRevision: 4, proposalId: 'proposal-1' })
  })

  it('reloads a newer draft revision for the authoritative apply rebind', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response({ draft: draft() }))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createSkillBuilderAdapter()

    const result = await adapter.reloadDraft({ binding, signal: new AbortController().signal })

    expect(result.id).toBe(binding.draftId)
    expect(result.revision).toBeGreaterThan(binding.revision)
    expect(fetchMock).toHaveBeenCalledWith('/v1/drafts/draft-1', expect.objectContaining({ credentials: 'include' }))
  })
})
