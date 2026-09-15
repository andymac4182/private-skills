import { afterEach, describe, expect, it, vi } from 'vitest'
import { companySsoRoute, listCompanySsoProviders, setCompanySsoProviderStatus } from './companySso'

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

afterEach(() => vi.unstubAllGlobals())

describe('company SSO API client', () => {
  it('keeps organization and provider identity in the encoded server route', () => {
    expect(companySsoRoute('org/acme')).toBe('/v1/companies/org%2Facme/sso/providers')
    expect(companySsoRoute('org/acme', 'entra/workforce')).toBe('/v1/companies/org%2Facme/sso/providers/entra%2Fworkforce')
  })

  it('sends authenticated requests and revision fencing for provider status changes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ providers: [] }))
      .mockResolvedValueOnce(response({ provider: { providerId: 'okta' } }))
    vi.stubGlobal('fetch', fetchMock)

    await listCompanySsoProviders('org-1')
    await setCompanySsoProviderStatus('org-1', { providerId: 'okta', revision: 7 }, 'disabled')

    const [listPath, listInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(listPath).toBe('/v1/companies/org-1/sso/providers')
    expect(listInit.credentials).toBe('include')
    expect(new Headers(listInit.headers).get('accept')).toBe('application/json')

    const [updatePath, updateInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(updatePath).toBe('/v1/companies/org-1/sso/providers/okta')
    expect(updateInit.method).toBe('PATCH')
    expect(updateInit.credentials).toBe('include')
    expect(new Headers(updateInit.headers).get('if-match')).toBe('7')
    expect(JSON.parse(String(updateInit.body))).toEqual({ status: 'disabled' })
  })
})
