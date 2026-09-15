const INVITATION_PATH = '/organization/accept-invitation'
const INVITATION_ID_MAX_LENGTH = 256

/**
 * Better Auth invitation ids are opaque. Keep them bounded and free of
 * controls before putting them into a link or sending them to the API.
 */
export function normalizeInvitationId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  if (!normalized || normalized.length > INVITATION_ID_MAX_LENGTH || /[\u0000-\u001f\u007f]/u.test(normalized)) return undefined
  return normalized
}

/** Build the same-origin path carried through the login flow. */
export function invitationReturnTo(invitationId: unknown): string | undefined {
  const id = normalizeInvitationId(invitationId)
  if (!id) return undefined
  const params = new URLSearchParams({ id })
  return `${INVITATION_PATH}?${params.toString()}`
}

/**
 * Build a copy-link invitation URL from the server-returned opaque id. The
 * browser origin is the only default base, so a Better Auth response cannot
 * redirect an invitee to an arbitrary host.
 */
export function createInvitationLink(invitationId: unknown, origin?: string): string | undefined {
  const returnTo = invitationReturnTo(invitationId)
  if (!returnTo) return undefined
  const baseOrigin = origin ?? (typeof window === 'undefined' ? undefined : window.location.origin)
  if (!baseOrigin) return undefined
  let base: URL
  try {
    base = new URL(baseOrigin)
  } catch {
    return undefined
  }
  if (base.username || base.password || base.pathname !== '/' || base.search || base.hash) return undefined
  return new URL(returnTo, base.origin).toString()
}

/** Return true only for the invitation route shape accepted by login. */
export function isInvitationReturnTo(value: unknown): value is string {
  // A UTF-8 code point can occupy four bytes and each byte may be percent
  // encoded. Better Auth ids are normally ASCII, but keep the validator
  // correct for any bounded opaque id.
  const maxEncodedIdLength = INVITATION_ID_MAX_LENGTH * 12
  if (typeof value !== 'string' || value.length === 0 || value.length > INVITATION_PATH.length + maxEncodedIdLength + 4) return false
  if (!value.startsWith(`${INVITATION_PATH}?`) || /[\u0000-\u001f\u007f\\]/u.test(value)) return false
  try {
    const target = new URL(value, 'https://private-skills.invalid')
    if (target.origin !== 'https://private-skills.invalid' || target.pathname !== INVITATION_PATH || target.hash) return false
    const keys = [...target.searchParams.keys()]
    if (keys.length !== 1 || keys[0] !== 'id') return false
    return invitationReturnTo(target.searchParams.get('id')) === `${INVITATION_PATH}?${target.searchParams.toString()}`
  } catch {
    return false
  }
}
