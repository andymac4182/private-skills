import { defineHandler } from 'nitro'
import { marketingRobotsTxt, marketingSeoConfig } from '../../src/lib/marketingSeo'

export default defineHandler(() => new Response(marketingRobotsTxt(marketingSeoConfig), {
  headers: {
    'cache-control': marketingSeoConfig.indexing === 'public' ? 'public, max-age=300' : 'no-store',
    'content-type': 'text/plain; charset=utf-8',
    ...(marketingSeoConfig.indexing === 'public' ? {} : { 'x-robots-tag': 'noindex, nofollow, noarchive' }),
  },
}))
