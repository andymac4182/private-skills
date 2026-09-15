// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OperationsStatusResponse } from '../lib/types'

const harness = vi.hoisted(() => ({
  principal: { organizationId: 'org-a', subject: 'owner-a', roles: ['owner'] as Array<'owner' | 'admin' | 'publisher' | 'reader' | 'worker'> },
  session: null as unknown,
  operationsStatus: vi.fn(),
}))

vi.mock('../lib/auth', () => ({ useAuth: () => ({ principal: harness.principal, session: harness.session }) }))
vi.mock('../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: { operationsStatus: harness.operationsStatus },
}))

import { OperationsStatusPanel } from './OperationsStatusPanel'

const status: OperationsStatusResponse = {
  protocolVersion: 1,
  organizationId: 'org-a',
  generatedAt: '2026-09-16T00:00:00.000Z',
  queue: { state: 'attention', queued: 1, running: 0, failed: 1, oldestActiveAt: '2026-09-15T23:58:00.000Z', oldestActiveAgeSeconds: 120 },
  scans: {
    state: 'attention',
    skills: { total: 2, current: 1, stale: 1, failed: 0, blocked: 0, unavailable: 0 },
    enabledScannerCount: 3,
    requiredScannerCount: 1,
    evidenceMaxAgeSeconds: 3_600,
    latestCompletedAt: '2026-09-15T23:55:00.000Z',
  },
  auth: {
    state: 'unavailable',
    authenticationFailures: null,
    callbackFailures: null,
    reason: 'No auth history',
  },
  billing: {
    state: 'available',
    provider: 'local',
    mode: 'test',
    webhookVerification: true,
    checkout: true,
    portal: true,
    usageState: 'available',
    usage: {
      periodStart: '2026-09-01T00:00:00.000Z',
      periodEnd: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-09-16T00:00:00.000Z',
      seats: 2,
      storageBytes: 10,
      scans: 3,
      eveCostCents: 12,
      limits: { seats: 10, storageBytes: 100, scansPerMonth: 100, eveCostCentsPerMonth: 1_000 },
    },
    failureCount: null,
    failureState: 'unavailable',
    reason: 'No billing failure history',
  },
  eve: {
    state: 'attention',
    consolidationRuns: { total: 1, running: 0, completed: 0, failed: 1 },
    uploadReviews: { total: 2, pending: 0, running: 0, passed: 1, failed: 0, stale: 1 },
    latestFailureAt: '2026-09-15T23:59:00.000Z',
  },
}

async function flushEffects(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('OperationsStatusPanel', () => {
  let root: Root | null = null

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    harness.principal = { organizationId: 'org-a', subject: 'owner-a', roles: ['owner'] }
    harness.session = null
    harness.operationsStatus.mockReset()
    harness.operationsStatus.mockResolvedValue(status)
  })

  afterEach(async () => {
    await act(async () => { root?.unmount() })
    root = null
    document.body.replaceChildren()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('shows bounded company-admin signals and unavailable history explicitly', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => { root!.render(createElement(OperationsStatusPanel)); await flushEffects() })

    expect(harness.operationsStatus).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('Company operations status')
    expect(container.textContent).toContain('1 active')
    expect(container.textContent).toContain('1/2 current')
    expect(container.textContent).toContain('Sign-in and callback history')
    expect(container.textContent).toContain('Not available')
    expect(container.textContent).not.toContain('No auth history')
  })

  it('does not request the admin endpoint for a reader', async () => {
    harness.principal = { organizationId: 'org-a', subject: 'reader-a', roles: ['reader'] }
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => { root!.render(createElement(OperationsStatusPanel)); await flushEffects() })

    expect(harness.operationsStatus).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Owner or admin access is required')
  })
})
