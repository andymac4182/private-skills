const APP_PATH = '/login'
const FALLBACK_RETURN_TO = '/app'

/**
 * Keep marketing links pointed at the authenticated app while allowing the
 * two deployments to live on different origins. The return path is limited
 * to the app area so a marketing link cannot become an open redirect.
 */
export function safeAppReturnTo(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048 || !value.startsWith('/') || value.startsWith('//')) return FALLBACK_RETURN_TO
  if (/[\u0000-\u001f\u007f]/u.test(value) || value.includes('\\')) return FALLBACK_RETURN_TO

  let target: URL
  try {
    target = new URL(value, 'https://private-skills.invalid')
  } catch {
    return FALLBACK_RETURN_TO
  }

  if (target.origin !== 'https://private-skills.invalid' || target.username || target.password || !/^\/app(?:\/|$)/u.test(target.pathname)) return FALLBACK_RETURN_TO
  return `${target.pathname}${target.search}${target.hash}`
}

function configuredAppOrigin(): string {
  const raw = typeof __MARKETING_APP_ORIGIN__ === 'string' ? __MARKETING_APP_ORIGIN__.trim() : ''
  if (!raw) return ''
  try {
    const origin = new URL(raw)
    if (!/^https?:$/u.test(origin.protocol) || origin.username || origin.password || origin.search || origin.hash) return ''
    return origin.origin
  } catch {
    return ''
  }
}

export function appLoginHref(returnTo: unknown = FALLBACK_RETURN_TO): string {
  const query = new URLSearchParams({ returnTo: safeAppReturnTo(returnTo) })
  return `${configuredAppOrigin()}${APP_PATH}?${query.toString()}`
}
