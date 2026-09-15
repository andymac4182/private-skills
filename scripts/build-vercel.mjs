import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  applyVercelFunctionBudget,
  resolveVercelFunctionBudget,
  verifyVercelFunctionBudget,
} from './vercel-function-budget.mjs'

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

// Match Vite's production-mode PSKILLS environment loading so the budget
// checked here is the same one used to compile the runtime and Nitro config.
const { loadEnv } = await import('vite')
const loadedEnvironment = loadEnv('production', root, 'PSKILLS_')

rmSync(webOutput, { recursive: true, force: true })
rmSync(rootOutput, { recursive: true, force: true })

const environment = {
  ...loadedEnvironment,
  ...process.env,
  NITRO_PRESET: 'vercel',
  PSKILLS_RUNTIME_PROFILE: 'node',
  PSKILLS_ENVIRONMENT: process.env.PSKILLS_ENVIRONMENT ?? 'production',
  PSKILLS_STORAGE_BUILD_PROFILE:
    process.env.PSKILLS_STORAGE_BUILD_PROFILE ?? process.env.PSKILLS_STORAGE_PROVIDER ?? 's3',
}
const functionBudget = resolveVercelFunctionBudget(environment)
console.log(
  `Vercel function budget: maxDuration=${functionBudget.maxDurationSeconds}s `
  + `(runtime=${functionBudget.runtimeDurationSeconds}s, headroom=${functionBudget.headroomSeconds}s, `
  + `declared plan max=${functionBudget.planMaxDurationSeconds}s)`,
)
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

const generatedFunctionConfigs = applyVercelFunctionBudget(webOutput, functionBudget)
verifyVercelFunctionBudget(webOutput, functionBudget)
console.log(`Applied maxDuration=${functionBudget.maxDurationSeconds}s to ${generatedFunctionConfigs.length} generated Vercel function config(s)`)

cpSync(webOutput, rootOutput, {
  recursive: true,
  force: true,
  // Nitro emits relative function links (for example auth/[...path].func ->
  // ./../__server.func). Keep those link targets relative when the output is
  // relocated to the repository root; resolving them would point back into
  // the checkout's apps/web output and fail on Vercel.
  verbatimSymlinks: true,
})

function collectSymlinks(directory, prefix = '') {
  const links = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
    const absolutePath = resolve(directory, entry.name)
    if (entry.isSymbolicLink()) {
      links.push(relativePath)
    } else if (entry.isDirectory()) {
      links.push(...collectSymlinks(absolutePath, relativePath))
    }
  }
  return links
}

function isRelativeLinkTarget(target) {
  return !isAbsolute(target) && !target.startsWith('\\') && !/^[A-Za-z]:[\\/]/.test(target)
}

function verifyRelocatedSymlinks(sourceDirectory, destinationDirectory) {
  const symlinks = collectSymlinks(sourceDirectory)
  for (const relativePath of symlinks) {
    const sourcePath = resolve(sourceDirectory, relativePath)
    const destinationPath = resolve(destinationDirectory, relativePath)
    const sourceTarget = readlinkSync(sourcePath)
    if (!isRelativeLinkTarget(sourceTarget)) {
      throw new Error(`Vercel output contains an absolute symlink target: ${relativePath}`)
    }
    if (!lstatSync(destinationPath).isSymbolicLink()) {
      throw new Error(`Vercel output symlink was not preserved: ${relativePath}`)
    }
    const destinationTarget = readlinkSync(destinationPath)
    if (destinationTarget !== sourceTarget) {
      throw new Error(`Vercel output symlink target changed during relocation: ${relativePath}`)
    }
    const resolvedTarget = resolve(dirname(destinationPath), destinationTarget)
    const relativeTarget = relative(destinationDirectory, resolvedTarget)
    if (relativeTarget.startsWith('..') || isAbsolute(relativeTarget) || !existsSync(resolvedTarget)) {
      throw new Error(`Vercel output symlink target is broken after relocation: ${relativePath}`)
    }
  }
  console.log(`Verified ${symlinks.length} relocated Vercel output symlinks`)
}

function verifyNodeDependencies(functionDirectory) {
  const dependencies = [
    {
      name: '@vercel/sandbox',
      assertion: "!module.Sandbox || typeof module.Sandbox.create !== 'function'",
      label: 'Sandbox.create',
    },
    {
      name: '@vercel/oidc',
      assertion: "typeof module.getVercelOidcToken !== 'function'",
      label: 'getVercelOidcToken',
    },
    {
      name: '@computesdk/vercel',
      assertion: "typeof module.vercel !== 'function'",
      label: 'vercel provider factory',
    },
    {
      name: '@computesdk/provider',
      assertion: "typeof module.defineProvider !== 'function'",
      label: 'provider factory',
    },
    {
      name: 'computesdk',
      assertion: "typeof module.compute !== 'function'",
      label: 'compute API',
    },
  ]

  const isolationRoot = mkdtempSync(resolve(tmpdir(), 'private-skills-vercel-sandbox-'))
  const isolatedFunctionDirectory = resolve(isolationRoot, '__server.func')
  try {
    cpSync(functionDirectory, isolatedFunctionDirectory, {
      recursive: true,
      force: true,
      verbatimSymlinks: true,
    })
    for (const dependency of dependencies) {
      const isolatedPackageJsonPath = resolve(isolatedFunctionDirectory, `node_modules/${dependency.name}/package.json`)
      if (!existsSync(isolatedPackageJsonPath)) {
        throw new Error(`Vercel function output does not include ${dependency.name}: ${isolatedPackageJsonPath}`)
      }
      const packageJson = JSON.parse(readFileSync(isolatedPackageJsonPath, 'utf8'))
      const probe = [
        "const load = new Function('specifier', 'return import(specifier)')",
        `const module = await load(${JSON.stringify(dependency.name)})`,
        `if (${dependency.assertion}) throw new Error(${JSON.stringify(`${dependency.name} ${dependency.label} is unavailable`)})`,
      ].join(';')
      const result = spawnSync(process.execPath, ['--input-type=module', '--eval', probe], {
        cwd: isolatedFunctionDirectory,
        env: { PATH: process.env.PATH ?? '' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      if (result.error) throw result.error
      if (result.status !== 0) {
        throw new Error(
          `Vercel function output could not load ${dependency.name} ${packageJson.version ?? 'unknown'} from its isolated node_modules`,
        )
      }
      console.log(`Verified isolated ${dependency.name} ${packageJson.version ?? 'unknown'} ${dependency.label}`)
    }
  } finally {
    rmSync(isolationRoot, { recursive: true, force: true })
  }
}

verifyRelocatedSymlinks(webOutput, rootOutput)
verifyVercelFunctionBudget(rootOutput, functionBudget)
verifyNodeDependencies(resolve(rootOutput, 'functions/__server.func'))
console.log(`Copied Vercel Build Output API output to ${rootOutput}`)
