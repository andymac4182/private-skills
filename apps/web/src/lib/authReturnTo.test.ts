import { describe, expect, it } from 'vitest'
import { providerSignInHref, safeAppReturnTo } from './auth'

describe('safeAppReturnTo', () => {
  it('keeps an app destination and its draft query intact', () => {
    const target = '/app/catalog?draft=draft-42&skill=reviewer&version=0.4.0&digest=sha256:abc123'

    expect(safeAppReturnTo(target)).toBe(target)
  })

  it('rejects external, public, and oversized destinations', () => {
    expect(safeAppReturnTo('https://attacker.example/app/catalog')).toBeUndefined()
    expect(safeAppReturnTo('//attacker.example/app/catalog')).toBeUndefined()
    expect(safeAppReturnTo('//localhost/app/catalog')).toBeUndefined()
    expect(safeAppReturnTo('app/catalog')).toBeUndefined()
    expect(safeAppReturnTo('/login?returnTo=/app/catalog')).toBeUndefined()
    expect(safeAppReturnTo('/app/catalog?draft=' + 'x'.repeat(2049))).toBeUndefined()
  })

  it('builds a provider endpoint with only a safe app callback', () => {
    expect(providerSignInHref('github', '/app/catalog?draft=draft-42', '/api/auth')).toBe('/api/auth/sign-in/social?provider=github&callbackURL=%2Fapp%2Fcatalog%3Fdraft%3Ddraft-42')
    expect(providerSignInHref('github', 'https://attacker.example/app', '/api/auth')).toBe('/api/auth/sign-in/social?provider=github')
    expect(providerSignInHref('bad provider', '/app', '/api/auth')).toBeUndefined()
  })
})
