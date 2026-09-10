import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { SkillBuilderPanel, isStaleBuilderError, proposalDiff, type SkillBuilderPanelAdapter, type SkillBuilderProposal, type SkillBuilderSession } from './SkillBuilderPanel'
import type { DraftView } from '../lib/types'

const draft = {
  draftId: 'draft-1',
  revision: 4,
  digest: 'sha256:base' as const,
  selectedPath: 'SKILL.md',
}

const session: SkillBuilderSession = {
  id: 'session-1',
  binding: draft,
  state: 'ready',
  turns: [],
}

const proposal: SkillBuilderProposal = {
  id: 'proposal-1',
  draftId: draft.draftId,
  baseRevision: draft.revision,
  baseDigest: draft.digest,
  proposedDigest: 'sha256:next',
  operations: [{ op: 'edit', path: 'SKILL.md', before: '# Before\n', after: '# After\n' }],
  state: 'pending',
  sessionId: session.id,
  createdAt: '2026-09-10T00:00:00.000Z',
}

const reboundDraft: DraftView = {
  id: draft.draftId,
  origin: 'release',
  name: 'demo-skill',
  skillName: 'demo-skill',
  baseResourceId: 'resource-1',
  baseDigest: draft.digest,
  revision: draft.revision + 1,
  digest: 'sha256:next',
  size: 12,
  files: [{ path: 'SKILL.md', size: 9, digest: 'sha256:' + 'n'.repeat(64) as `sha256:${string}` }],
  status: 'open',
  actor: 'owner',
  createdAt: '2026-09-10T00:00:00.000Z',
  updatedAt: '2026-09-10T00:01:00.000Z',
}

function adapter(): SkillBuilderPanelAdapter {
  return {
    loadSession: async () => session,
    sendPrompt: async () => ({ session: { ...session, turns: [] }, proposal }),
    reloadDraft: async () => reboundDraft,
    stop: async () => undefined,
    applyProposal: async () => ({ session, proposal: { ...proposal, state: 'applied' } }),
    rejectProposal: async () => ({ proposal: { ...proposal, state: 'rejected' } }),
  }
}

describe('SkillBuilderPanel helpers', () => {
  it('recognizes stale binding responses from the BFF', () => {
    expect(isStaleBuilderError({ code: 'STALE_BINDING' })).toBe(true)
    expect(isStaleBuilderError({ code: 'DRAFT_CONFLICT' })).toBe(true)
    expect(isStaleBuilderError({ status: 409 })).toBe(true)
    expect(isStaleBuilderError({ code: 'UNAVAILABLE' })).toBe(false)
  })

  it('creates a genuine Pierre diff only when bounded previews are available', () => {
    const diff = proposalDiff(proposal.operations[0])
    expect(diff).not.toBeNull()
    expect(diff?.name).toBe('SKILL.md')
    expect(diff?.hunks.length).toBeGreaterThan(0)
    expect(proposalDiff({ op: 'delete', path: 'private.bin' })).toBeNull()
  })
})

describe('SkillBuilderPanel rendering boundary', () => {
  it('renders the disabled state without touching the adapter', () => {
    const markup = renderToStaticMarkup(createElement(SkillBuilderPanel, { draft, adapter: adapter(), onDraftRebound: () => undefined, enabled: false, disabledReason: 'Builder access is disabled by policy.' }))
    expect(markup).toContain('Skill builder unavailable')
    expect(markup).toContain('Builder access is disabled by policy.')
    expect(markup).not.toContain('Send prompt')
  })

  it('renders no-draft state as an explicit empty context', () => {
    const markup = renderToStaticMarkup(createElement(SkillBuilderPanel, { draft: null, adapter: adapter(), onDraftRebound: () => undefined }))
    expect(markup).toContain('Choose a draft to build with Eve')
    expect(markup).toContain('Open a saved draft')
    expect(markup).not.toContain('Prompt Eve')
  })

  it('fails closed when availability is neither enabled nor configured', () => {
    const markup = renderToStaticMarkup(createElement(SkillBuilderPanel, { draft, adapter: adapter(), onDraftRebound: () => undefined }))
    expect(markup).toContain('Skill builder unavailable')
    expect(markup).toContain('availability is not configured')
    expect(markup).not.toContain('Send prompt')
  })
})
