import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

afterEach(() => vi.unstubAllGlobals())

describe('lazy draft file API', () => {
  it('requests one canonical path against the exact draft revision and digest', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      file: {
        path: 'docs/hello world.md',
        size: 5,
        digest: 'sha256:' + 'a'.repeat(64),
        previewState: 'text',
        content: 'aGVsbG8=',
      },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await api.draftFile('draft/1', 'docs/hello world.md', {
      revision: 7,
      digest: 'sha256:' + 'b'.repeat(64) as `sha256:${string}`,
    })

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const url = new URL(path, 'https://registry.test')
    expect(url.pathname).toBe('/v1/drafts/draft%2F1/files')
    expect(url.searchParams.get('path')).toBe('docs/hello world.md')
    expect(url.searchParams.get('revision')).toBe('7')
    expect(url.searchParams.get('digest')).toBe('sha256:' + 'b'.repeat(64))
    expect(init.credentials).toBe('include')
    expect(result.file.path).toBe('docs/hello world.md')
  })

  it('sends builder session creation binding in both query and body', async () => {
    const digest = 'sha256:' + 'b'.repeat(64) as `sha256:${string}`
    const fetchMock = vi.fn().mockResolvedValue(response({ session: {} }))
    vi.stubGlobal('fetch', fetchMock)

    await api.builderCreateSession('draft/1', { revision: 7, digest, requestId: 'session-1' })

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const url = new URL(path, 'https://registry.test')
    expect(url.pathname).toBe('/v1/drafts/draft%2F1/builder/session')
    expect(url.searchParams.get('revision')).toBe('7')
    expect(url.searchParams.get('digest')).toBe(digest)
    expect(JSON.parse(String(init.body))).toEqual({ revision: 7, digest, requestId: 'session-1' })
    expect(init.credentials).toBe('include')
  })
})

describe('multi-source discovery API', () => {
  it('keeps provider selection in the search query and posts only the external identity to resolve', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ protocolVersion: 1, query: 'review', data: [], sources: [] }))
      .mockResolvedValueOnce(response({ sourceId: 'tessl', externalId: 'workspace/review', reference: '@tessl/workspace/review', resolution: { members: [] } }))
    vi.stubGlobal('fetch', fetchMock)

    await api.sourceSearch('review', { source: 'tessl', limit: 50 })
    await api.sourceResolve('tessl', { externalId: 'workspace/review' })

    const [searchPath] = fetchMock.mock.calls[0] as [string, RequestInit]
    const searchUrl = new URL(searchPath, 'https://registry.test')
    expect(searchUrl.pathname).toBe('/v1/sources/search')
    expect(searchUrl.searchParams.get('q')).toBe('review')
    expect(searchUrl.searchParams.get('source')).toBe('tessl')
    expect(searchUrl.searchParams.get('limit')).toBe('50')

    const [resolvePath, resolveInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(resolvePath).toBe('/v1/sources/tessl/resolve')
    expect(JSON.parse(String(resolveInit.body))).toEqual({ externalId: 'workspace/review' })
    expect(resolveInit.credentials).toBe('include')
  })
})

describe('identity API', () => {
  it('posts Better Auth sign-out to the configured base path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({}))
    vi.stubGlobal('fetch', fetchMock)

    await api.authSignOut('/identity/auth/')

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/identity/auth/sign-out')
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('include')
    expect(new Headers(init.headers).get('content-type')).toBe('application/json')
    expect(JSON.parse(String(init.body))).toEqual({})
  })

  it('gets and accepts invitations through the Better Auth organization endpoints', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ id: 'invite/1', email: 'new@acme.test', role: 'reader', status: 'pending', organizationName: 'Acme Skills' }))
      .mockResolvedValueOnce(response({ invitation: { id: 'invite/1', status: 'accepted' }, member: { id: 'member-2', role: 'reader' } }))
    vi.stubGlobal('fetch', fetchMock)

    await api.getOrganizationInvitation('invite/1')
    await api.acceptOrganizationInvitation('invite/1')

    const [getPath, getInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    const getUrl = new URL(getPath, 'https://registry.test')
    expect(getUrl.pathname).toBe('/api/auth/organization/get-invitation')
    expect(getUrl.searchParams.get('id')).toBe('invite/1')
    expect(getInit.credentials).toBe('include')

    const [acceptPath, acceptInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(acceptPath).toBe('/api/auth/organization/accept-invitation')
    expect(acceptInit.method).toBe('POST')
    expect(JSON.parse(String(acceptInit.body))).toEqual({ invitationId: 'invite/1' })
  })

  it('uses the sanitized identity routes and normalizes Better Auth organization payloads', async () => {
    const organization = { id: 'org-1', name: 'Acme Skills', slug: 'acme-skills' }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ protocolVersion: 1, enabled: true, basePath: '/api/auth', providers: [], organization: { enabled: true, roles: ['owner', 'admin', 'publisher', 'reader'], maxOrganizationsPerUser: 3, maxMembersPerOrganization: 50, maxInvitationsPerMember: 5 }, invitations: { mode: 'copy-link', emailDelivery: 'disabled', requiresVerifiedEmail: true, allowedRoles: ['reader'] }, bootstrap: { enabled: true, requiresExplicitOwnerClaim: true, implicitSocialTenantAdoption: false } }))
      .mockResolvedValueOnce(response({ session: null }))
      .mockResolvedValueOnce(response([organization]))
      .mockResolvedValueOnce(response(organization))
      .mockResolvedValueOnce(response(organization))
      .mockResolvedValueOnce(response({ members: [] }))
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response({ id: 'invite-1', email: 'new@acme.test', role: 'reader', status: 'pending' }))
      .mockResolvedValueOnce(response({ id: 'member-1', role: 'admin' }))
    vi.stubGlobal('fetch', fetchMock)

    await api.authProviders()
    expect(await api.authSession()).toBeNull()
    expect(await api.listOrganizations()).toEqual({ organizations: [organization] })
    expect(await api.createOrganization({ name: organization.name, slug: organization.slug })).toEqual({ organization })
    expect(await api.switchOrganization(organization.id)).toEqual(organization)
    expect(await api.organizationMembers()).toEqual({ members: [] })
    expect(await api.organizationInvitations()).toEqual({ invitations: [] })
    expect(await api.inviteOrganizationMember({ email: 'new@acme.test', role: 'reader' })).toEqual({ id: 'invite-1', email: 'new@acme.test', role: 'reader', status: 'pending' })
    await api.updateOrganizationMemberRole('member-1', 'admin')

    const paths = fetchMock.mock.calls.map(([path]) => new URL(path as string, 'https://registry.test').pathname)
    expect(paths).toEqual([
      '/auth/identity/config',
      '/auth/identity/session',
      '/api/auth/organization/list',
      '/api/auth/organization/create',
      '/api/auth/organization/set-active',
      '/api/auth/organization/list-members',
      '/api/auth/organization/list-invitations',
      '/api/auth/organization/invite-member',
      '/api/auth/organization/update-member-role',
    ])
    const [, createInit] = fetchMock.mock.calls[3] as [string, RequestInit]
    expect(JSON.parse(String(createInit.body))).toEqual({ name: organization.name, slug: organization.slug })
    const [, roleInit] = fetchMock.mock.calls[8] as [string, RequestInit]
    expect(JSON.parse(String(roleInit.body))).toEqual({ memberId: 'member-1', role: 'admin' })
  })
})
