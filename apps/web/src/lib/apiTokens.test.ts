import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './api'
import { apiTokenRoute, createApiToken, listApiTokens, revokeApiToken } from './apiTokens'

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('api token browser client', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('uses the company token collection route and sends cookie credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ tokens: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await listApiTokens()

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/v1/tokens?includeRevoked=true')
    expect(init.credentials).toBe('include')
    expect(init.method).toBeUndefined()
    expect(new Headers(init.headers).get('accept')).toBe('application/json')
  })

  it('posts scoped expiry input without a client-selected organization', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ id: 'st_1', token: 'psk_one-time-secret', organizationId: 'org-1', userId: 'user-1', name: 'Release bot', roleCeiling: 'reader', scopes: ['skills:read'], expiresAt: '2099-01-01T00:00:00.000Z', createdAt: '2026-09-15T00:00:00.000Z' }, 201))
    vi.stubGlobal('fetch', fetchMock)

    await createApiToken({ name: 'Release bot', roleCeiling: 'reader', scopes: ['skills:read'], expiresInSeconds: 86_400 })

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/v1/tokens')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ name: 'Release bot', roleCeiling: 'reader', scopes: ['skills:read'], expiresInSeconds: 86_400 })
    expect(JSON.parse(String(init.body))).not.toHaveProperty('organizationId')
    expect(new Headers(init.headers).get('content-type')).toBe('application/json')
  })

  it('encodes token ids for revoke and preserves the server error contract', async () => {
    expect(apiTokenRoute('st_token:one')).toBe('/v1/tokens/st_token%3Aone')
    expect(() => apiTokenRoute('  ')).toThrow('A CLI token is required.')

    const fetchMock = vi.fn().mockImplementation(() => response({ code: 'FORBIDDEN', message: 'Only administrators can revoke this token' }, 403))
    vi.stubGlobal('fetch', fetchMock)

    await expect(revokeApiToken('st_token:one')).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/v1/tokens/st_token%3Aone')
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'DELETE', credentials: 'include' })
    await expect(revokeApiToken('st_token:one')).rejects.toBeInstanceOf(ApiError)
  })
})
