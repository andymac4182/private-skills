import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertDemoEnvironment,
  buildIdentityProviderEnvironment,
  createPkcePair,
  createSourceSnapshot,
  decodeJwt,
  parseLaunchOptions,
  redactSecrets,
  startLocalOidcProvider,
  startLocalOidcProviders,
  verifyJwtSignature,
} from '../scripts/local-identity-demo.mjs'

const APP_ORIGIN = 'http://127.0.0.1:5297'
const providers: Array<{ close: () => Promise<void> }> = []
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.allSettled(providers.splice(0).map((provider) => provider.close()))
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function start(providerId: 'acme' | 'globex') {
  const provider = await startLocalOidcProvider({ providerId, appOrigin: APP_ORIGIN })
  providers.push(provider)
  return provider
}

async function authorize(provider: Awaited<ReturnType<typeof startLocalOidcProvider>>, selection: { user?: string; company?: string } = {}) {
  const pkce = createPkcePair()
  const state = `state-${provider.id}-fixed`
  const nonce = `nonce-${provider.id}-fixed`
  const url = new URL(provider.descriptor.authorizationEndpoint)
  const values: Record<string, string> = {
    client_id: provider.clientId,
    redirect_uri: provider.redirectUris[0]!,
    response_type: 'code',
    scope: 'openid profile email',
    state,
    code_challenge: pkce.challenge,
    code_challenge_method: pkce.method,
    nonce,
  }
  if (selection.user !== undefined) values.demo_user = selection.user
  if (selection.company !== undefined) values.demo_company = selection.company
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value)
  const response = await fetch(url, { redirect: 'manual' })
  return { pkce, state, nonce, response }
}

async function exchange(provider: Awaited<ReturnType<typeof startLocalOidcProvider>>, response: Response, verifier: string, basic = false) {
  const location = response.headers.get('location')
  if (!location) throw new Error('authorization response did not redirect')
  const callback = new URL(location)
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: callback.searchParams.get('code') ?? '',
    redirect_uri: provider.redirectUris[0]!,
    code_verifier: verifier,
  })
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' }
  if (basic) {
    headers.authorization = `Basic ${Buffer.from(`${provider.clientId}:${provider.clientSecret}`).toString('base64')}`
  } else {
    body.set('client_id', provider.clientId)
    body.set('client_secret', provider.clientSecret)
  }
  return fetch(provider.descriptor.tokenEndpoint, { method: 'POST', headers, body })
}

describe('local identity OIDC protocol fixture', () => {
  it('completes discovery, selectable authorization, state, S256 PKCE, token, userinfo, and JWKS verification', async () => {
    const provider = await start('acme')
    const discoveryResponse = await fetch(provider.descriptor.discoveryUrl)
    expect(discoveryResponse.status).toBe(200)
    const discovery = await discoveryResponse.json() as Record<string, unknown>
    expect(discovery.issuer).toBe(provider.issuer)
    expect(discovery.authorization_endpoint).toBe(provider.descriptor.authorizationEndpoint)
    expect(discovery.token_endpoint).toBe(provider.descriptor.tokenEndpoint)
    expect(discovery.userinfo_endpoint).toBe(provider.descriptor.userinfoEndpoint)
    expect(discovery.jwks_uri).toBe(provider.descriptor.jwksUri)
    expect(discovery.code_challenge_methods_supported).toEqual(['S256'])
    expect(discovery.token_endpoint_auth_methods_supported).toEqual(['client_secret_post', 'client_secret_basic'])

    const choice = await authorize(provider)
    expect(choice.response.status).toBe(200)
    const choicePage = await choice.response.text()
    expect(choicePage).toContain('name="demo_user"')
    expect(choicePage).toContain('name="demo_company"')
    expect(choicePage).toContain('Alice Acme')
    expect(choicePage).toContain('Acme Retail')
    expect(choicePage).not.toMatch(/type="password"/iu)
    expect(choicePage).not.toContain('client_secret')
    const formPolicy = choice.response.headers.get('content-security-policy')
    expect(formPolicy).toContain("form-action 'self'")
    expect(formPolicy).toContain(provider.issuer)
    expect(formPolicy).toContain(APP_ORIGIN)
    expect(formPolicy).not.toContain('*')

    // Mirror the browser's POST of the rendered form, including its hidden
    // OAuth parameters and the two selected fixture values.
    const browserForm = new URLSearchParams(new URL(choice.response.url).search)
    browserForm.set('demo_user', 'alice')
    browserForm.set('demo_company', 'acme-labs')
    const browserSubmit = await fetch(provider.descriptor.authorizationEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: browserForm,
      redirect: 'manual',
    })
    expect(browserSubmit.status).toBe(302)
    const browserCallback = new URL(browserSubmit.headers.get('location')!)
    expect(browserCallback.origin).toBe(APP_ORIGIN)
    expect(browserCallback.pathname).toBe('/api/auth/callback/acme')
    expect(browserCallback.searchParams.get('state')).toBe(browserForm.get('state'))
    expect(browserCallback.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]+$/u)

    const selected = await authorize(provider, { user: 'alice', company: 'acme-retail' })
    expect(selected.response.status).toBe(302)
    const location = new URL(selected.response.headers.get('location')!)
    expect(location.origin).toBe(APP_ORIGIN)
    expect(location.pathname).toBe('/api/auth/callback/acme')
    expect(location.searchParams.get('state')).toBe(selected.state)
    expect(location.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]+$/u)

    const wrongVerifier = await exchange(provider, selected.response, createPkcePair().verifier)
    expect(wrongVerifier.status).toBe(400)
    expect(await wrongVerifier.json()).toMatchObject({ error: 'invalid_grant' })

    const tokenResponse = await exchange(provider, selected.response, selected.pkce.verifier)
    expect(tokenResponse.status).toBe(200)
    const token = await tokenResponse.json() as { access_token: string; id_token: string; token_type: string; scope: string }
    expect(token.token_type).toBe('Bearer')
    expect(token.scope).toBe('openid profile email')
    expect(token.access_token).toMatch(/^[A-Za-z0-9_-]+$/u)
    const decoded = decodeJwt(token.id_token)
    expect(decoded?.header).toMatchObject({ alg: 'RS256', kid: 'local-acme-signing-v1' })
    expect(decoded?.payload).toMatchObject({
      iss: provider.issuer,
      aud: provider.clientId,
      sub: 'acme-user-alice',
      email: 'alice@acme.test',
      company_id: 'acme-retail',
      tenant_id: 'tenant-acme-retail',
      nonce: selected.nonce,
    })

    const jwks = await (await fetch(provider.descriptor.jwksUri)).json() as { keys: Array<Record<string, unknown>> }
    expect(jwks.keys).toHaveLength(1)
    expect(verifyJwtSignature(token.id_token, jwks.keys[0]!)).toBe(true)
    expect(verifyJwtSignature(token.id_token, { ...jwks.keys[0], n: 'invalid' })).toBe(false)

    const userinfoResponse = await fetch(provider.descriptor.userinfoEndpoint, { headers: { authorization: `Bearer ${token.access_token}` } })
    expect(userinfoResponse.status).toBe(200)
    expect(await userinfoResponse.json()).toMatchObject({
      iss: provider.issuer,
      sub: 'acme-user-alice',
      preferred_username: 'alice',
      company_id: 'acme-retail',
      tenant_id: 'tenant-acme-retail',
    })

    const replay = await exchange(provider, selected.response, selected.pkce.verifier)
    expect(replay.status).toBe(400)
    expect(await (await fetch(provider.descriptor.userinfoEndpoint, { headers: { authorization: 'Bearer unknown' } })).json()).toMatchObject({ error: 'invalid_token' })
  })

  it('accepts client_secret_basic and rejects invalid redirect, missing state, and arbitrary account selections', async () => {
    const provider = await start('globex')
    const missingState = await authorize(provider)
    // Remove the required state without changing the rest of the signed client request.
    const noStateUrl = new URL(provider.descriptor.authorizationEndpoint)
    for (const [key, value] of new URL(missingState.response.url || provider.descriptor.authorizationEndpoint).searchParams) noStateUrl.searchParams.set(key, value)
    noStateUrl.searchParams.delete('state')
    // The first call returned a selector page; use a complete direct request for the negative check.
    const pkce = createPkcePair()
    for (const [key, value] of Object.entries({
      client_id: provider.clientId,
      redirect_uri: provider.redirectUris[0]!,
      response_type: 'code',
      scope: 'openid',
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      demo_user: 'carol',
      demo_company: 'globex-research',
    })) noStateUrl.searchParams.set(key, value)
    const noStateResponse = await fetch(noStateUrl)
    expect(noStateResponse.status).toBe(400)
    expect(await noStateResponse.json()).toMatchObject({ error: 'invalid_request' })

    const invalidRedirect = await authorize(provider, { user: 'carol', company: 'globex-research' })
    expect(invalidRedirect.response.status).toBe(302)
    const invalidRequestUrl = new URL(provider.descriptor.authorizationEndpoint)
    invalidRequestUrl.search = new URL(invalidRedirect.response.headers.get('location')!).search
    invalidRequestUrl.searchParams.set('client_id', provider.clientId)
    invalidRequestUrl.searchParams.set('redirect_uri', 'http://127.0.0.1:5297/evil-callback')
    invalidRequestUrl.searchParams.set('response_type', 'code')
    invalidRequestUrl.searchParams.set('scope', 'openid')
    invalidRequestUrl.searchParams.set('state', 'state-invalid-redirect')
    invalidRequestUrl.searchParams.set('code_challenge', createPkcePair().challenge)
    invalidRequestUrl.searchParams.set('code_challenge_method', 'S256')
    invalidRequestUrl.searchParams.set('demo_user', 'carol')
    invalidRequestUrl.searchParams.set('demo_company', 'globex-research')
    expect((await fetch(invalidRequestUrl)).status).toBe(400)

    const arbitraryUser = await authorize(provider, { user: 'unknown-user', company: 'globex-research' })
    expect(arbitraryUser.response.status).toBe(400)
    const arbitraryCompany = await authorize(provider, { user: 'carol', company: 'unknown-company' })
    expect(arbitraryCompany.response.status).toBe(400)

    const selected = await authorize(provider, { user: 'dave', company: 'globex-retail' })
    expect(selected.response.status).toBe(302)
    const tokenResponse = await exchange(provider, selected.response, selected.pkce.verifier, true)
    expect(tokenResponse.status).toBe(200)
    const claims = decodeJwt((await tokenResponse.json()).id_token)?.payload
    expect(claims?.sub).toBe('globex-user-dave')
  })

  it('keeps two issuer identities and fixed tenant/company claims separate', async () => {
    const [acme, globex] = await startLocalOidcProviders({ appOrigin: APP_ORIGIN })
    providers.push(acme, globex)
    const acmeFlow = await authorize(acme, { user: 'alice', company: 'acme-labs' })
    const globexFlow = await authorize(globex, { user: 'carol', company: 'globex-research' })
    const acmeTokenResponse = await exchange(acme, acmeFlow.response, acmeFlow.pkce.verifier)
    const globexTokenResponse = await exchange(globex, globexFlow.response, globexFlow.pkce.verifier)
    const acmeToken = await acmeTokenResponse.json()
    const globexToken = await globexTokenResponse.json()
    const acmeClaims = decodeJwt(acmeToken.id_token)?.payload
    const globexClaims = decodeJwt(globexToken.id_token)?.payload
    expect(acme.issuer).not.toBe(globex.issuer)
    expect(acmeClaims).toMatchObject({ iss: acme.issuer, sub: 'acme-user-alice', company_id: 'acme-labs', tenant_id: 'tenant-acme-labs' })
    expect(globexClaims).toMatchObject({ iss: globex.issuer, sub: 'globex-user-carol', company_id: 'globex-research', tenant_id: 'tenant-globex-research' })
    expect(acmeClaims?.sub).not.toBe(globexClaims?.sub)
    expect(acmeClaims?.tenant_id).not.toBe(globexClaims?.tenant_id)
  })
})

describe('local identity demo launcher contract', () => {
  it('refuses production mode and parses only bounded loopback options', () => {
    expect(() => assertDemoEnvironment({ NODE_ENV: 'production' })).toThrow('refuses a production environment')
    expect(() => assertDemoEnvironment({ PSKILLS_ENVIRONMENT: 'production' })).toThrow('refuses a production environment')
    expect(() => assertDemoEnvironment({ PSKILLS_IDENTITY_DEMO: 'false' })).toThrow('requires PSKILLS_IDENTITY_DEMO=true')
    const options = parseLaunchOptions(['--source', '/private/tmp/working-tree', '--app-port', '5298', '--acme-port', '5300', '--globex-port', '5301', '--identity-adapter', 'postgres', '--database-url', 'postgres://postgres:postgres@127.0.0.1:5432/identity_demo', '--login-path', '/login'])
    expect(options).toMatchObject({ sourceRoot: '/private/tmp/working-tree', appPort: 5298, acmePort: 5300, globexPort: 5301, identityAdapter: 'postgres' })
    expect(() => parseLaunchOptions(['--database-url', 'postgres://postgres:postgres@db.example/identity'])).toThrow('local PostgreSQL')
    expect(() => parseLaunchOptions(['--app-port', '5297', '--acme-port', '5297'])).toThrow('ports must be distinct')
  })

  it('copies working-tree additions into a private snapshot and records exclusions in the manifest', () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'private-skills-identity-source-fixture-'))
    const destinationParent = mkdtempSync(join(tmpdir(), 'private-skills-identity-destination-fixture-'))
    temporaryRoots.push(sourceRoot, destinationParent)
    mkdirSync(join(sourceRoot, 'packages', 'identity', 'src'), { recursive: true })
    mkdirSync(join(sourceRoot, 'node_modules', 'secret-package'), { recursive: true })
    writeFileSync(join(sourceRoot, 'packages', 'identity', 'src', 'index.ts'), 'export const workingTreeIntegration = true\n')
    writeFileSync(join(sourceRoot, '.env'), 'SHOULD_NOT_BE_COPIED=1\n')
    writeFileSync(join(sourceRoot, '.env.local'), 'SHOULD_NOT_BE_COPIED=1\n')
    writeFileSync(join(sourceRoot, 'node_modules', 'secret-package', 'index.js'), 'credential-shaped dependency\n')
    const destinationRoot = join(destinationParent, 'source')
    const snapshot = createSourceSnapshot({ sourceRoot, destinationRoot })
    expect(snapshot.manifest.snapshotMode).toBe('working-tree-copy')
    expect(readFileSync(join(destinationRoot, 'packages', 'identity', 'src', 'index.ts'), 'utf8')).toContain('workingTreeIntegration')
    expect(statSync(join(destinationRoot, 'packages', 'identity', 'src', 'index.ts')).mode & 0o777).toBe(0o644)
    expect(snapshot.manifest.excluded).toEqual(expect.arrayContaining([
      { path: '.env', reason: 'private-or-generated' },
      { path: '.env.local', reason: 'private-or-generated' },
      { path: 'node_modules', reason: 'private-or-generated' },
    ]))
    expect(snapshot.manifest.files.map((file) => file.path)).toContain('packages/identity/src/index.ts')
    expect(snapshot.manifest.files.map((file) => file.path)).not.toContain('.env')
  })

  it('passes the frozen BetterAuth provider array plus a private fixture envelope', async () => {
    const [acme, globex] = await startLocalOidcProviders({ appOrigin: APP_ORIGIN })
    providers.push(acme, globex)
    const environment = buildIdentityProviderEnvironment([acme, globex], { adapter: 'postgres', databaseConfigured: true })
    const envelope = JSON.parse(environment.PSKILLS_IDENTITY_PROVIDERS_JSON) as { schemaVersion: number; loopbackOnly: boolean; persistence: { adapter: string }; providers: Array<Record<string, unknown>> }
    expect(envelope).toMatchObject({ schemaVersion: 1, loopbackOnly: true, persistence: { adapter: 'postgres' } })
    expect(envelope.providers).toHaveLength(2)
    expect(envelope.providers[0]).toHaveProperty('clientSecret')
    const oidcProviders = JSON.parse(environment.PSKILLS_OIDC_PROVIDERS_JSON) as Array<Record<string, unknown>>
    expect(oidcProviders).toHaveLength(2)
    expect(oidcProviders[0]).toEqual(expect.objectContaining({
      id: 'acme',
      name: 'Acme Identity',
      clientId: acme.clientId,
      clientSecret: acme.clientSecret,
      discoveryUrl: acme.descriptor.discoveryUrl,
      redirectURI: acme.redirectUris[0],
      scopes: ['openid', 'profile', 'email'],
    }))
    expect(Object.keys(oidcProviders[0]!).sort()).toEqual(['clientId', 'clientSecret', 'discoveryUrl', 'id', 'name', 'redirectURI', 'scopes'])
    expect(environment.BETTER_AUTH_OIDC_PROVIDERS_JSON).toBe(environment.PSKILLS_OIDC_PROVIDERS_JSON)
    expect(acme.descriptor).not.toHaveProperty('clientSecret')
    expect(environment.PSKILLS_AUTH_BACKEND).toBe('packages/identity')
    expect(environment.PSKILLS_IDENTITY_MODE).toBe('better-auth')
  })

  it('redacts generated secrets even when text is split across log chunks', () => {
    const secret = 'identity-demo-secret-value-1234567890'
    expect(redactSecrets(`prefix ${secret} suffix`, [secret])).toBe('prefix [redacted] suffix')
  })
})
