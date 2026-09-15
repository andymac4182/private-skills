export type MarketingIndexing = 'public' | 'noindex'

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
 * Resolve the optional origin used for canonical URLs and the sitemap. A
 * missing origin is safe: the build remains noindex and emits no
 * origin-derived URLs. A public build is checked separately below so a
 * preview hostname or an application origin cannot be guessed into public
 * metadata.
 */
export function marketingOriginForBuild(value: string | undefined, _mode: string): string | undefined {
  const raw = value?.trim() ?? ''
  if (!raw) return undefined

  return parseOrigin(raw, 'MARKETING_ORIGIN').origin
}

/**
 * Resolve indexing intent. Omitted intent is noindex in every mode, which
 * keeps existing local and preview builds safe while the public deployment
 * must opt in explicitly. Public indexing also requires an explicit HTTPS
 * marketing origin.
 */
export function marketingIndexingForBuild(value: string | undefined, _mode: string, origin?: string): MarketingIndexing {
  const raw = value?.trim().toLowerCase() ?? ''
  if (raw !== 'public' && raw !== 'noindex') {
    if (!raw) return 'noindex'
    throw new Error('MARKETING_INDEXING must be public or noindex')
  }

  if (raw === 'public') {
    if (!origin) {
      throw new Error('MARKETING_ORIGIN is required when MARKETING_INDEXING=public')
    }
    if (parseOrigin(origin, 'MARKETING_ORIGIN').protocol !== 'https:') {
      throw new Error('MARKETING_INDEXING=public requires an HTTPS MARKETING_ORIGIN')
    }
  }

  return raw
}
