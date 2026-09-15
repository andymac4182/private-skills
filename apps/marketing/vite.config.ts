import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { defineConfig, loadEnv } from 'vite'
import { nitro } from 'nitro/vite'
import viteReact from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

/**
 * The marketing app is intentionally a small static-facing TanStack/Nitro
 * deployment. APP_ORIGIN is the public URL of the authenticated app and is
 * the only app configuration exposed to browser code.
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

export default defineConfig(({ mode }) => {
  const root = fileURLToPath(new URL('./', import.meta.url))
  const environment = loadEnv(mode, fileURLToPath(new URL('../../', import.meta.url)), '')
  const appOrigin = appOriginForBuild(process.env.APP_ORIGIN ?? environment.APP_ORIGIN, mode)

  return {
    root,
    define: { __MARKETING_APP_ORIGIN__: JSON.stringify(appOrigin) },
    plugins: [
      tanstackStart(),
      nitro({ serverDir: './server' }),
      viteReact(),
    ],
  }
})
