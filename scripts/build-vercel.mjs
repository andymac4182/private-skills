import { cpSync, existsSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const webRoot = resolve(root, 'apps/web')
const viteEntry = resolve(root, 'node_modules/vite/bin/vite.js')
const webOutput = resolve(root, 'apps/web/.vercel/output')
const rootOutput = resolve(root, '.vercel/output')

const nodeMajor = Number(process.versions.node.split('.')[0])
if (nodeMajor !== 24) {
  throw new Error(`Vercel builds require Node 24; found ${process.versions.node}`)
}

if (process.env.NITRO_PRESET && process.env.NITRO_PRESET !== 'vercel') {
  throw new Error(`scripts/build-vercel.mjs requires NITRO_PRESET=vercel; found ${process.env.NITRO_PRESET}`)
}
if (process.env.PSKILLS_RUNTIME_PROFILE && process.env.PSKILLS_RUNTIME_PROFILE !== 'node') {
  throw new Error(`scripts/build-vercel.mjs requires PSKILLS_RUNTIME_PROFILE=node; found ${process.env.PSKILLS_RUNTIME_PROFILE}`)
}
if (!existsSync(viteEntry)) {
  throw new Error(`Vite is unavailable at ${viteEntry}; run the pinned pnpm install first`)
}

rmSync(webOutput, { recursive: true, force: true })
rmSync(rootOutput, { recursive: true, force: true })

const environment = {
  ...process.env,
  NITRO_PRESET: 'vercel',
  PSKILLS_RUNTIME_PROFILE: 'node',
  PSKILLS_ENVIRONMENT: process.env.PSKILLS_ENVIRONMENT ?? 'production',
  PSKILLS_STORAGE_BUILD_PROFILE:
    process.env.PSKILLS_STORAGE_BUILD_PROFILE ?? process.env.PSKILLS_STORAGE_PROVIDER ?? 's3',
}
const build = spawnSync(process.execPath, [viteEntry, 'build'], {
  cwd: webRoot,
  env: environment,
  stdio: 'inherit',
})

if (build.error) throw build.error
if (build.status !== 0) process.exit(build.status ?? 1)

const outputConfig = resolve(webOutput, 'config.json')
if (!existsSync(outputConfig)) {
  throw new Error(`Nitro did not emit a Vercel Build Output API config: ${outputConfig}`)
}

cpSync(webOutput, rootOutput, { recursive: true, force: true })
console.log(`Copied Vercel Build Output API output to ${rootOutput}`)
