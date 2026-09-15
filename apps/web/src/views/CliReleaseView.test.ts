// @vitest-environment jsdom

import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliReleaseTarget, PublicCliReleaseManifest } from '../../../../packages/cli-release/src/index.js'
import type { AuthSession, BrowserPrincipal } from '../lib/types'

const harness = vi.hoisted(() => ({
  auth: {
    principal: null as BrowserPrincipal | null,
    session: null as AuthSession | null,
  },
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: { children?: ReactNode; to?: string; [key: string]: unknown }) => createElement('a', { ...props, href: typeof to === 'string' ? to : '#' }, children),
}))
vi.mock('../lib/auth', () => ({ useAuth: () => harness.auth }))

import { api } from '../lib/api'
import { CliReleaseView } from './CliReleaseView'

const organization = { id: 'org-acme', name: 'Acme Skills', slug: 'acme-skills' }
const membership = { id: 'member-1', organizationId: organization.id, role: 'reader' as const, organization }
const session: AuthSession = {
  user: { id: 'user-1', email: 'reader@acme.test', name: 'Acme Reader', emailVerified: true },
  sessionId: 'session-1',
  createdAt: '2026-09-15T00:00:00.000Z',
  expiresAt: '2099-09-15T00:00:00.000Z',
  organizations: [membership],
  activeOrganizationId: organization.id,
  activeOrganization: organization,
  activeMembership: membership,
  needsOnboarding: false,
  authMethod: 'better-auth',
}
const principal: BrowserPrincipal = { organizationId: organization.id, subject: 'reader@acme.test', roles: ['reader'] }

function manifest(availability: 'ready' | 'unprovisioned'): PublicCliReleaseManifest {
  return {
    protocolVersion: 1,
    version: '0.4.0',
    releaseTag: 'v0.4.0',
    checksums: { filename: 'SHA256SUMS', size: 1, digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' },
    assets: [{
      target: 'aarch64-apple-darwin', platform: 'macos', architecture: 'arm64',
      filename: 'pskills-aarch64-apple-darwin.tar.gz', archive: 'tar.gz', member: 'pskills',
      size: 4, digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      verification: 'native-smoke-verified', availability,
    }],
    verification: { nativeProofTargets: ['aarch64-apple-darwin'], nativeTestWaivedTargets: [] },
  }
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve()
  })
}

describe('CliReleaseView', () => {
  let root: Root | null = null

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    harness.auth.principal = principal
    harness.auth.session = session
  })

  afterEach(async () => {
    await act(async () => { root?.unmount() })
    root = null
    document.body.replaceChildren()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  async function renderView(initialTarget?: CliReleaseTarget): Promise<HTMLDivElement> {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => { root?.render(createElement(CliReleaseView, { initialTarget })) })
    await flushEffects()
    return container
  }

  it('preserves the selected target and keeps an unprovisioned archive unavailable', async () => {
    vi.spyOn(api, 'cliReleaseManifest').mockResolvedValue(manifest('unprovisioned'))
    const download = vi.spyOn(api, 'cliReleaseDownload')
    const container = await renderView('aarch64-apple-darwin')

    expect(container.textContent).toContain('Acme Skills')
    expect(container.textContent).toContain('Not provisioned')
    expect(container.textContent).toContain('Downloads stay disabled until platform provisioning is complete.')
    const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent?.includes('Download'))
    expect(button?.disabled).toBe(true)
    expect(download).not.toHaveBeenCalled()
  })

  it('downloads exact response bytes only after the server reports the asset ready', async () => {
    vi.spyOn(api, 'cliReleaseManifest').mockResolvedValue(manifest('ready'))
    const bytes = new Uint8Array([0, 1, 2, 254])
    vi.spyOn(api, 'cliReleaseDownload').mockResolvedValue(new Response(bytes, { status: 200, headers: { 'content-type': 'application/gzip' } }))
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:cli-release') })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const container = await renderView()

    const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent?.includes('Download'))
    expect(button?.disabled).toBe(false)
    await act(async () => { button?.click(); await flushEffects() })
    await flushEffects()

    expect(api.cliReleaseDownload).toHaveBeenCalledWith('0.4.0', 'aarch64-apple-darwin')
    expect(click).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('Download started for pskills-aarch64-apple-darwin.tar.gz.')
  })
})
