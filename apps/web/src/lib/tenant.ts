/**
 * Clear browser-only view selections when the authenticated company changes.
 * Server data and credentials are never stored in this namespace.
 */
export function clearTenantScopedClientState() {
  if (typeof window === 'undefined') return
  for (const key of Object.keys(window.sessionStorage)) {
    if (key.startsWith('pskills.directory.')) window.sessionStorage.removeItem(key)
  }
}
