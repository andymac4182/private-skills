import { describe, expect, it } from 'vitest'
import { createInvitationLink, invitationReturnTo, isInvitationReturnTo, normalizeInvitationId } from './invitations'

describe('invitation link helpers', () => {
  it('builds a same-origin link from Better Auth’s opaque invitation id', () => {
    expect(createInvitationLink('invite/123', 'https://registry.test')).toBe(
      'https://registry.test/organization/accept-invitation?id=invite%2F123',
    )
  })

  it('keeps the login return path bounded to one invitation id', () => {
    const returnTo = invitationReturnTo('invite/123')
    expect(returnTo).toBe('/organization/accept-invitation?id=invite%2F123')
    expect(isInvitationReturnTo(returnTo)).toBe(true)
    expect(isInvitationReturnTo('/organization/accept-invitation?id=invite-1&returnTo=/app')).toBe(false)
    expect(isInvitationReturnTo('https://attacker.example/organization/accept-invitation?id=invite-1')).toBe(false)
  })

  it('rejects missing, control-bearing, and oversized ids', () => {
    expect(normalizeInvitationId('')).toBeUndefined()
    expect(normalizeInvitationId('invite\u0000')).toBeUndefined()
    expect(normalizeInvitationId('x'.repeat(257))).toBeUndefined()
    expect(createInvitationLink('invite-1', 'not a URL')).toBeUndefined()
  })
})
