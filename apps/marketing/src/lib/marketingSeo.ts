import type { LinkHTMLAttributes, MetaHTMLAttributes } from 'react'
import { brand } from './brand'
import type { MarketingIndexing } from './marketingConfig'

export interface MarketingSeoConfig {
  origin?: string
  indexing: MarketingIndexing
}

export interface MarketingPageMetadata {
  path: string
  title: string
  description: string
}

/** Keep this list limited to pages intended for public discovery. */
export const MARKETING_PUBLIC_ROUTES = [
  '/',
  '/product',
  '/demo',
  '/pricing',
  '/docs',
  '/docs/getting-started',
  '/faq',
  '/contact',
  '/legal',
] as const

const configuredOrigin = typeof __MARKETING_ORIGIN__ === 'string' && __MARKETING_ORIGIN__.length > 0
  ? __MARKETING_ORIGIN__
  : undefined
const configuredIndexing: MarketingIndexing = typeof __MARKETING_INDEXING__ === 'string' && __MARKETING_INDEXING__ === 'public'
  ? 'public'
  : 'noindex'

export const marketingSeoConfig: MarketingSeoConfig = {
  origin: configuredOrigin,
  indexing: configuredIndexing,
}

function publicPath(path: string): string {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[?#]/u.test(path) || /[\u0000-\u001f\u007f]/u.test(path)) {
    throw new Error('Marketing canonical paths must be absolute, query-free public paths')
  }

  if (path === '/') return path
  return path.replace(/\/+$/u, '') || '/'
}

export function marketingCanonicalUrl(path: string, config: MarketingSeoConfig = marketingSeoConfig): string {
  if (!config.origin) {
    throw new Error('Marketing canonical URLs require an explicit MARKETING_ORIGIN')
  }

  return new URL(publicPath(path), config.origin).href
}

export function marketingRobotsContent(config: MarketingSeoConfig = marketingSeoConfig): string {
  return config.indexing === 'public' ? 'index, follow' : 'noindex, nofollow, noarchive'
}

export function marketingHead(metadata: MarketingPageMetadata, config: MarketingSeoConfig = marketingSeoConfig) {
  const canonical = config.origin ? marketingCanonicalUrl(metadata.path, config) : undefined
  const robots = marketingRobotsContent(config)
  const meta: MetaHTMLAttributes<HTMLMetaElement>[] = [
    { title: metadata.title },
    { name: 'description', content: metadata.description },
    { name: 'robots', content: robots },
    { property: 'og:site_name', content: brand.name },
    { property: 'og:type', content: 'website' },
    { property: 'og:title', content: metadata.title },
    { property: 'og:description', content: metadata.description },
    { name: 'twitter:card', content: 'summary' },
    { name: 'twitter:title', content: metadata.title },
    { name: 'twitter:description', content: metadata.description },
    ...(canonical ? [
      { property: 'og:url', content: canonical },
      { name: 'twitter:url', content: canonical },
    ] : []),
  ]

  const links: LinkHTMLAttributes<HTMLLinkElement>[] = canonical
    ? [{ rel: 'canonical', href: canonical }]
    : []

  return {
    meta,
    // There is no approved public image asset in this app. The social tags
    // reuse the existing brand config and intentionally omit og:image rather
    // than pointing at a design fixture or inventing a preview graphic.
    links,
  }
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/gu, character => {
    switch (character) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case "'": return '&apos;'
      case '"': return '&quot;'
      default: return character
    }
  })
}

export function marketingSitemapXml(config: MarketingSeoConfig = marketingSeoConfig): string {
  const urls = config.indexing === 'public'
    ? MARKETING_PUBLIC_ROUTES.map(path => `    <url><loc>${escapeXml(marketingCanonicalUrl(path, config))}</loc></url>`).join('\n')
    : ''

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls ? `\n${urls}\n` : ''}</urlset>\n`
}

export function marketingRobotsTxt(config: MarketingSeoConfig = marketingSeoConfig): string {
  if (config.indexing !== 'public') return 'User-agent: *\nDisallow: /\n'
  return `User-agent: *\nAllow: /\nSitemap: ${marketingCanonicalUrl('/sitemap.xml', config)}\n`
}
