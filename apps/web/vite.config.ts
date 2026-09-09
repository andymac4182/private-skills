import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { defineConfig, loadEnv } from 'vite'
import { nitro } from 'nitro/vite'
import viteReact from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

type RuntimeProfile = 'node' | 'edge'
const filesProviders = new Set(['fs', 's3', 'r2', 'gcs', 'azure', 'vercel-blob'])

const providerForBuild = (profile: RuntimeProfile): string | undefined => {
  if (profile === 'edge') return undefined
  const configured = process.env.PSKILLS_STORAGE_BUILD_PROFILE ?? process.env.PSKILLS_STORAGE_PROVIDER
  if (configured === 'filesystem') return 'fs'
  if (configured === 'http') return undefined
  const provider = configured ?? 's3'
  if (!filesProviders.has(provider)) {
    throw new Error(`Unsupported PSKILLS_STORAGE_PROVIDER for a Node build: ${provider}`)
  }
  return provider
}

export default defineConfig(({ mode }) => {
  const root = fileURLToPath(new URL('./', import.meta.url))
  const environment = loadEnv(mode, fileURLToPath(new URL('../../', import.meta.url)), 'PSKILLS_')
  for (const [name, value] of Object.entries(environment)) process.env[name] ??= value
  const preset = process.env.NITRO_PRESET ?? ''
  const profile: RuntimeProfile =
    process.env.PSKILLS_RUNTIME_PROFILE === 'edge' || preset.startsWith('cloudflare')
      ? 'edge'
      : 'node'
  const edge = profile === 'edge'
  const infrastructure = fileURLToPath(new URL(edge ? './server/runtime-edge.ts' : './server/runtime-node.ts', import.meta.url))
  const provider = providerForBuild(profile)
  const traceDeps = edge
    ? ['!files-sdk']
    : [
      '@vercel/sandbox',
      '@vercel/oidc',
      '@computesdk/vercel',
      '@computesdk/provider',
      'computesdk',
      ...(provider ? ['files-sdk', `files-sdk/${provider}`] : []),
    ]
  return {
    root,
    resolve: { alias: { '#pskills-infrastructure': infrastructure } },
    plugins: [
      tanstackStart(),
      nitro({
        serverDir: './server',
        alias: { '#pskills-infrastructure': infrastructure },
        noExternals: provider ? ['files-sdk', `files-sdk/${provider}`] : false,
        traceDeps,
      }),
      viteReact(),
    ],
  }
})
