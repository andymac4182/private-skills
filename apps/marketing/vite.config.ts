import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { defineConfig, loadEnv } from 'vite'
import { nitro } from 'nitro/vite'
import viteReact from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { marketingIndexingForBuild, marketingOriginForBuild } from './src/lib/marketingConfig.ts'
import { parsePublicPlanMetadataJson } from './src/lib/marketingPlanMetadata.ts'

/**
 * The marketing app is intentionally a small static-facing TanStack/Nitro
 * deployment. APP_ORIGIN is the public URL of the authenticated app. An
 * optional PUBLIC_CONTACT_URL may point to a public, durable intake or
 * scheduling page; no contact destination is guessed when it is absent.
 */
function appOriginForBuild(value: string | undefined, mode: string): string {
  const raw = value?.trim() ?? ''
  if (raw) {
    let parsed: URL
    try {
      parsed = new URL(raw)
    } catch {
      throw new Error('APP_ORIGIN must be a valid http(s) origin, for example https://app.example.com')
    }
    if (!/^https?:$/u.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
      throw new Error('APP_ORIGIN must be an origin without credentials, a path, a query, or a fragment')
    }
    return parsed.origin
  }

  if (mode === 'development') return 'http://localhost:5173'
  throw new Error('APP_ORIGIN is required for a production marketing build')
}

function publicContactUrlForBuild(value: string | undefined, mode: string): string {
  const raw = value?.trim() ?? ''
  if (!raw) return ''
  if (raw.length > 2048 || /[\u0000-\u001f\u007f]/u.test(raw)) {
    throw new Error('PUBLIC_CONTACT_URL must be at most 2048 characters without control characters')
  }

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('PUBLIC_CONTACT_URL must be a valid public URL')
  }

  const localDevelopmentUrl = mode === 'development'
    && parsed.protocol === 'http:'
    && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]')
  if (parsed.protocol !== 'https:' && !localDevelopmentUrl) {
    throw new Error('PUBLIC_CONTACT_URL must use HTTPS (HTTP is allowed only for localhost development)')
  }
  if (parsed.username || parsed.password) {
    throw new Error('PUBLIC_CONTACT_URL cannot include credentials')
  }
  return parsed.href
}

export default defineConfig(({ mode }) => {
  const root = fileURLToPath(new URL('./', import.meta.url))
  const environment = loadEnv(mode, fileURLToPath(new URL('../../', import.meta.url)), '')
  const appOrigin = appOriginForBuild(process.env.APP_ORIGIN ?? environment.APP_ORIGIN, mode)
  const contactUrl = publicContactUrlForBuild(process.env.PUBLIC_CONTACT_URL ?? environment.PUBLIC_CONTACT_URL, mode)
  const marketingOrigin = marketingOriginForBuild(process.env.MARKETING_ORIGIN ?? environment.MARKETING_ORIGIN, mode)
  const marketingIndexing = marketingIndexingForBuild(process.env.MARKETING_INDEXING ?? environment.MARKETING_INDEXING, mode, marketingOrigin)
  const publicPlanMetadataJson = process.env.PUBLIC_PLAN_METADATA_JSON ?? environment.PUBLIC_PLAN_METADATA_JSON ?? ''
  if (new TextEncoder().encode(publicPlanMetadataJson).byteLength > 256 * 1024) {
    throw new Error('PUBLIC_PLAN_METADATA_JSON must be at most 256 KiB')
  }
  if (publicPlanMetadataJson.trim() !== '') parsePublicPlanMetadataJson(publicPlanMetadataJson)

  return {
    root,
    define: {
      __MARKETING_APP_ORIGIN__: JSON.stringify(appOrigin),
      __MARKETING_CONTACT_URL__: JSON.stringify(contactUrl),
      __MARKETING_ORIGIN__: JSON.stringify(marketingOrigin ?? ''),
      __MARKETING_INDEXING__: JSON.stringify(marketingIndexing),
      __MARKETING_PUBLIC_PLAN_METADATA_JSON__: JSON.stringify(publicPlanMetadataJson),
    },
    plugins: [
      tanstackStart(),
      nitro({ serverDir: './server' }),
      viteReact(),
    ],
  }
})
