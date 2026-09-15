export type MarketingIndexing = 'public' | 'noindex'

export const LOCAL_MARKETING_ORIGIN = 'http://localhost:5173'

function parseOrigin(value: string, label: string): URL {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${label} must be a valid http(s) origin, for example https://marketing.example.com`)
  }

  if (!/^https?:$/u.test(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`${label} must be an origin without credentials, a path, a query, or a fragment`)
  }

  return parsed
}

/**
 * Resolve the public origin used for canonical URLs and the sitemap. A
 * production build must receive this explicitly so a preview hostname or an
 * application origin cannot be guessed into public metadata.
 */
export function marketingOriginForBuild(value: string | undefined, mode: string): string {
  const raw = value?.trim() ?? ''
  if (!raw) {
    if (mode === 'development') return LOCAL_MARKETING_ORIGIN
    throw new Error('MARKETING_ORIGIN is required for a production marketing build')
  }

  return parseOrigin(raw, 'MARKETING_ORIGIN').origin
}

/**
 * Require an explicit indexing intent for production and preview builds.
 * Development is always noindex unless a caller opts into an explicit mode;
 * public indexing still requires an HTTPS marketing origin.
 */
export function marketingIndexingForBuild(value: string | undefined, mode: string, origin: string): MarketingIndexing {
  const raw = value?.trim().toLowerCase() ?? ''
  if (!raw && mode === 'development') return 'noindex'
  if (raw !== 'public' && raw !== 'noindex') {
    throw new Error('MARKETING_INDEXING must be explicitly set to public or noindex for a production marketing build')
  }

  if (raw === 'public' && parseOrigin(origin, 'MARKETING_ORIGIN').protocol !== 'https:') {
    throw new Error('MARKETING_INDEXING=public requires an HTTPS MARKETING_ORIGIN')
  }

  return raw
}
