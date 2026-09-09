import { spawn } from 'node:child_process'

type Platform = 'node' | 'vercel' | 'cloudflare'

const platform = process.argv[2] as Platform | undefined
const supported: readonly Platform[] = ['node', 'vercel', 'cloudflare']

if (!platform || !supported.includes(platform)) {
  console.error(`Usage: pnpm exec tsx scripts/platform-build.ts <${supported.join('|')}>`)
  process.exitCode = 2
} else {
  const environment = { ...process.env }
  delete environment.NITRO_PRESET

  if (platform === 'cloudflare') {
    environment.NITRO_PRESET = 'cloudflare_module'
    environment.PSKILLS_RUNTIME_PROFILE = 'edge'
    environment.PSKILLS_ENVIRONMENT = 'production'
    environment.PSKILLS_STATE_PROVIDER = 'http'
    environment.PSKILLS_STORAGE_PROVIDER = 'http'
  } else {
    if (platform === 'vercel') environment.NITRO_PRESET = 'vercel'
    environment.PSKILLS_RUNTIME_PROFILE = 'node'
    environment.PSKILLS_ENVIRONMENT = 'production'
    // The production runtime defaults to S3. Keeping that choice at build
    // time lets Nitro trace only the selected Files SDK dependency set.
    environment.PSKILLS_STORAGE_PROVIDER ??= 's3'
    environment.PSKILLS_STORAGE_BUILD_PROFILE ??= environment.PSKILLS_STORAGE_PROVIDER
  }

  const child = spawn('pnpm', ['--filter', '@private-skills/web', 'build'], {
    cwd: process.cwd(),
    env: environment,
    stdio: 'inherit',
  })

  child.once('error', (error) => {
    console.error(`Unable to start platform build: ${error.message}`)
    process.exitCode = 1
  })
  child.once('exit', (code, signal) => {
    if (signal) {
      console.error(`Platform build terminated by ${signal}`)
      process.exitCode = 1
    } else {
      process.exitCode = code ?? 1
    }
  })
}
