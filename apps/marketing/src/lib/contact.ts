/**
 * A public destination supplied by the deployment owner. It is intentionally
 * optional: the marketing site must not invent an inbox or render a broken
 * contact link when no durable intake has been configured.
 */
export function marketingContactUrl(): string {
  const raw = typeof __MARKETING_CONTACT_URL__ === 'string' ? __MARKETING_CONTACT_URL__.trim() : ''
  if (!raw) return ''

  try {
    const url = new URL(raw)
    const localDevelopmentUrl = url.protocol === 'http:'
      && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
    if ((url.protocol !== 'https:' && !localDevelopmentUrl) || url.username || url.password) return ''
    return url.href
  } catch {
    return ''
  }
}
