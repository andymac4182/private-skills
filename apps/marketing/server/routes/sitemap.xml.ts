import { defineHandler } from 'nitro'
import { marketingSeoConfig, marketingSitemapXml } from '../../src/lib/marketingSeo'

export default defineHandler(() => new Response(marketingSitemapXml(marketingSeoConfig), {
  headers: {
    'cache-control': marketingSeoConfig.indexing === 'public' ? 'public, max-age=300' : 'no-store',
    'content-type': 'application/xml; charset=utf-8',
    ...(marketingSeoConfig.indexing === 'public' ? {} : { 'x-robots-tag': 'noindex, nofollow, noarchive' }),
  },
}))
