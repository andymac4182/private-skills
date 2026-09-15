import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { marketingIndexingForBuild, marketingOriginForBuild } from '../apps/marketing/src/lib/marketingConfig'
import {
  MARKETING_PUBLIC_ROUTES,
  marketingCanonicalUrl,
  marketingHead,
  marketingRobotsTxt,
  marketingSitemapXml,
} from '../apps/marketing/src/lib/marketingSeo'
import type { MarketingSeoConfig } from '../apps/marketing/src/lib/marketingSeo'

type RenderableMeta = {
  charSet?: unknown
  name?: unknown
  property?: unknown
  content?: unknown
}

function metaAttributes(item: RenderableMeta): Record<string, string> | undefined {
  if (typeof item.charSet === 'string') return { charSet: item.charSet }
  if (typeof item.name === 'string' && typeof item.content === 'string') return { name: item.name, content: item.content }
  if (typeof item.property === 'string' && typeof item.content === 'string') return { property: item.property, content: item.content }
  return undefined
}

function renderHead(metadata: Parameters<typeof marketingHead>[0], config: MarketingSeoConfig): string {
  const head = marketingHead(metadata, config)
  const metaTags = head.meta.map((item, index) => {
    if ('title' in item) return createElement('title', { key: `title-${index}` }, item.title)
    const attributes = metaAttributes(item)
    return attributes ? createElement('meta', { ...attributes, key: `meta-${index}` }) : null
  })
  const linkTags = head.links.map((link, index) => createElement('link', { ...link, key: `link-${index}` }))
  return renderToStaticMarkup(createElement('head', null, ...metaTags, ...linkTags))
}

describe('marketing SEO metadata', () => {
  const publicConfig: MarketingSeoConfig = {
    origin: 'https://marketing.example.test',
    indexing: 'public',
  }

  it('renders page metadata and escapes values in the generated HTML', () => {
    const html = renderHead({
      path: '/product',
      title: 'Private Skills & <preview>',
      description: 'A "clear" <path> & repeatable install.',
    }, publicConfig)

    expect(html).toContain('<title>Private Skills &amp; &lt;preview&gt;</title>')
    expect(html).toContain('name="description" content="A &quot;clear&quot; &lt;path&gt; &amp; repeatable install."')
    expect(html).toContain('property="og:url" content="https://marketing.example.test/product"')
    expect(html).toContain('name="robots" content="index, follow"')
    expect(html).toContain('rel="canonical" href="https://marketing.example.test/product"')
    expect(html).not.toContain('<script')
  })

  it('rejects query, fragment, and protocol-relative canonical paths', () => {
    expect(() => marketingCanonicalUrl('/product?next=https://example.test', publicConfig)).toThrow()
    expect(() => marketingCanonicalUrl('/product#details', publicConfig)).toThrow()
    expect(() => marketingCanonicalUrl('//example.test/product', publicConfig)).toThrow()
  })

  it('generates a sitemap containing only the intended public routes', () => {
    const xml = marketingSitemapXml(publicConfig)
    const locations = [...xml.matchAll(/<loc>([^<]+)<\/loc>/gu)].map(match => match[1])

    expect(locations).toEqual(MARKETING_PUBLIC_ROUTES.map(path => marketingCanonicalUrl(path, publicConfig)))
    expect(xml).not.toMatch(/\/(?:login|app|api|health)(?:[./]|$)/u)
    expect(marketingRobotsTxt(publicConfig)).toContain('Sitemap: https://marketing.example.test/sitemap.xml')
  })

  it('keeps preview and local deployments out of discovery', () => {
    const previewConfig: MarketingSeoConfig = { ...publicConfig, indexing: 'noindex' }
    expect(marketingSitemapXml(previewConfig)).not.toContain('<loc>')
    expect(marketingRobotsTxt(previewConfig)).toBe('User-agent: *\nDisallow: /\n')
    expect(renderHead({ path: '/', title: 'Preview', description: 'Preview site' }, previewConfig)).toContain('noindex, nofollow, noarchive')
  })

  it('omits origin-derived URLs when no marketing origin is configured', () => {
    const noOriginConfig: MarketingSeoConfig = { indexing: 'noindex' }
    const html = renderHead({ path: '/', title: 'Preview', description: 'Preview site' }, noOriginConfig)

    expect(html).not.toContain('rel="canonical"')
    expect(html).not.toContain('og:url')
    expect(html).not.toContain('twitter:url')
    expect(marketingSitemapXml(noOriginConfig)).not.toContain('<loc>')
    expect(marketingRobotsTxt(noOriginConfig)).toBe('User-agent: *\nDisallow: /\n')
  })
})

describe('marketing build configuration', () => {
  it('defaults production, preview, and development to safe noindex without an origin', () => {
    for (const mode of ['production', 'preview', 'development']) {
      expect(marketingOriginForBuild(undefined, mode)).toBeUndefined()
      expect(marketingIndexingForBuild(undefined, mode)).toBe('noindex')
    }
  })

  it('validates origins and requires HTTPS for public indexing', () => {
    expect(marketingOriginForBuild('https://marketing.example.test/', 'production')).toBe('https://marketing.example.test')
    expect(() => marketingOriginForBuild('https://marketing.example.test/base', 'production')).toThrow()
    expect(() => marketingOriginForBuild('https://user:pass@marketing.example.test', 'production')).toThrow()
    expect(marketingIndexingForBuild('public', 'production', 'https://marketing.example.test')).toBe('public')
    expect(() => marketingIndexingForBuild('public', 'production')).toThrow('MARKETING_ORIGIN is required')
    expect(() => marketingIndexingForBuild('public', 'production', 'http://localhost:5173')).toThrow('HTTPS')
    expect(() => marketingIndexingForBuild('maybe', 'preview')).toThrow('public or noindex')
  })
})
