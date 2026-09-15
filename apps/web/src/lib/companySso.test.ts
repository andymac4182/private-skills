import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  companySsoLoginRoute,
  companySsoRoute,
  listCompanySsoLoginProviders,
  listCompanySsoProviders,
  setCompanySsoProviderStatus,
  startCompanySsoLogin,
} from './companySso'

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

afterEach(() => vi.unstubAllGlobals())

describe('company SSO API client', () => {
  it('keeps organization and provider identity in the encoded server route', () => {
    expect(companySsoRoute('org/acme')).toBe('/v1/companies/org%2Facme/sso/providers')
    expect(companySsoRoute('org/acme', 'entra/workforce')).toBe('/v1/companies/org%2Facme/sso/providers/entra%2Fworkforce')
    expect(companySsoLoginRoute('org/acme')).toBe('/v1/companies/org%2Facme/sso/login')
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

  it('keeps company login discovery and explicit provider selection on the same route', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ organizationId: 'acme', providers: [{ providerId: 'acme-oidc', displayName: 'Acme Identity', protocol: 'oidc' }] }))
      .mockResolvedValueOnce(response({ redirect: true, url: 'https://idp.example/authorize' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(listCompanySsoLoginProviders('acme')).resolves.toMatchObject({
      organizationId: 'acme', providers: [{ providerId: 'acme-oidc', protocol: 'oidc' }],
    })
    await startCompanySsoLogin('acme', 'acme-oidc', '/organization/accept-invitation?id=invite-1')

    const [listPath] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(listPath).toBe('/v1/companies/acme/sso/login')
    const [startPath, startInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(startPath).toBe('/v1/companies/acme/sso/login')
    expect(startInit.method).toBe('POST')
    expect(JSON.parse(String(startInit.body))).toEqual({ providerId: 'acme-oidc', callbackURL: '/organization/accept-invitation?id=invite-1' })
  })
})
