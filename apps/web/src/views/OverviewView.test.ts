// @vitest-environment jsdom

import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import type { AuthSession, Job, PackVersion, Policy, Principal, SkillVersion } from '../lib/types'

const harness = vi.hoisted(() => ({
  auth: {
    principal: null as Principal | null,
    session: null as AuthSession | null,
  },
}))

vi.mock('@tanstack/react-router', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    Link: ({ children, params: _params, search: _search, to, ...props }: { children?: ReactNode; params?: unknown; search?: unknown; to?: string; [key: string]: unknown }) => React.createElement('a', { ...props, href: to }, children),
  }
})
vi.mock('../lib/auth', () => ({ useAuth: () => harness.auth }))

import { OverviewView } from './OverviewView'

const organization = { id: 'org-1', name: 'Acme Skills', slug: 'acme-skills' }
const membership = { id: 'membership-1', organizationId: organization.id, role: 'owner' as const, organization }
const user = { id: 'user-1', email: 'owner@acme.test', name: 'Acme Owner', emailVerified: true }

const policy: Policy = {
  revision: 'policy-1',
  scanners: [{ id: 'skillsguard', mode: 'required', blockSeverities: ['high'], timeoutSeconds: 30 }],
  allowUnscanned: false,
  evidenceMaxAgeSeconds: 3600,
}

const skill: SkillVersion = {
  id: 'skill-1',
  organizationId: organization.id,
  name: '@acme/review',
  skillName: 'review',
  version: '1.2.0',
  description: 'Review pull requests safely.',
  artifact: { key: 'blob-1', digest: `sha256:${'a'.repeat(64)}`, size: 12 },
  state: 'approved',
  policyRevision: policy.revision,
  createdAt: '2026-09-14T00:00:00.000Z',
  approvedAt: '2026-09-14T00:01:00.000Z',
  provenance: { kind: 'native' },
  fileCount: 2,
  scanIds: [],
}

const pack: PackVersion = {
  id: 'pack-1',
  organizationId: organization.id,
  name: 'Core review pack',
  version: '1.0.0',
  description: 'Core skills for the review team.',
  members: [],
  manifestDigest: `sha256:${'b'.repeat(64)}`,
  state: 'approved',
  createdAt: '2026-09-14T00:00:00.000Z',
  policyRevision: policy.revision,
}

const operation: Job = {
  id: 'job-1',
  organizationId: organization.id,
  kind: 'scan',
  state: 'running',
  resourceId: skill.id,
  policyRevision: policy.revision,
  policy,
  createdAt: '2026-09-14T00:00:00.000Z',
  updatedAt: '2026-09-14T00:02:00.000Z',
  attempts: 1,
}

function makeSession(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    user,
    sessionId: 'session-1',
    createdAt: '2026-09-14T00:00:00.000Z',
    expiresAt: '2026-09-15T00:00:00.000Z',
    organizations: [membership],
    activeOrganizationId: organization.id,
    activeOrganization: organization,
    activeMembership: membership,
    needsOnboarding: false,
    authMethod: 'better-auth',
    ...overrides,
  }
}

async function flushEffects(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('OverviewView', () => {
  let root: Root | null = null

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    harness.auth.principal = null
    harness.auth.session = makeSession()
  })

  afterEach(async () => {
    await act(async () => { root?.unmount(); await flushEffects() })
    root = null
    document.body.replaceChildren()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  async function renderView(): Promise<HTMLDivElement> {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(createElement(OverviewView))
      await flushEffects()
    })
    return container
  }

  it('shows company identity and tailored next steps for a first-run registry', async () => {
    vi.spyOn(api, 'skills').mockResolvedValue({ skills: [] })
    vi.spyOn(api, 'packs').mockResolvedValue({ packs: [] })
    vi.spyOn(api, 'operations').mockResolvedValue({ operations: [] })
    vi.spyOn(api, 'policy').mockResolvedValue({ policy })

    const container = await renderView()

    expect(container.querySelector('h1')?.textContent).toBe('Acme Skills')
    expect(container.textContent).toContain('acme-skills')
    expect(container.textContent).toContain('Add your first skill')
    expect(container.textContent).toContain('Activity starts here')
    expect(container.textContent).toContain('Start Acme Skills with a private release or find one from a configured source.')
    expect(container.querySelector('a[href="/app/$section"]')?.textContent).toContain('Add skill')
    expect(container.textContent).not.toContain('Your team’s skills, connected.')
    expect(container.querySelectorAll('.overview-action-card')).toHaveLength(0)
  })

  it('renders current release, pack, task, and scanner counts from API data', async () => {
    vi.spyOn(api, 'skills').mockResolvedValue({ skills: [skill] })
    vi.spyOn(api, 'packs').mockResolvedValue({ packs: [pack] })
    vi.spyOn(api, 'operations').mockResolvedValue({ operations: [operation] })
    vi.spyOn(api, 'policy').mockResolvedValue({ policy })

    const container = await renderView()
    const statValues = [...container.querySelectorAll<HTMLElement>('.overview-stat-value')].map((value) => value.textContent)

    expect(statValues).toEqual(['1', '0', '1', '1'])
    expect(container.textContent).toContain('@acme/review')
    expect(container.textContent).toContain('Recent releases')
    expect(container.textContent).toContain('Recent activity')
    expect(container.textContent).toContain('1 security check enabled')
    expect(container.textContent).not.toContain('Add your first skill')
  })

  it('gives readers browse and discovery actions instead of publish prompts', async () => {
    harness.auth.session = makeSession({ activeMembership: { ...membership, role: 'reader' } })
    vi.spyOn(api, 'skills').mockResolvedValue({ skills: [] })
    vi.spyOn(api, 'packs').mockResolvedValue({ packs: [] })
    vi.spyOn(api, 'operations').mockResolvedValue({ operations: [] })
    vi.spyOn(api, 'policy').mockResolvedValue({ policy })

    const container = await renderView()

    expect(container.textContent).toContain('Browse catalog')
    expect(container.textContent).toContain('Find skills')
    expect(container.textContent).toContain('Find a skill for this company')
    expect(container.textContent).not.toContain('Add skill')
    expect(container.textContent).not.toContain('Publish or import a skill')
  })
})
