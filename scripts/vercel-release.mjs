import { lstatSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VERCEL_COMMAND = 'vercel'
const REQUIRED_DEPLOY_FLAGS = ['--prebuilt', '--prod', '--yes']
const SAFE_DEPLOY_FLAGS = new Set(REQUIRED_DEPLOY_FLAGS)
const SAFE_METADATA_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u
const SAFE_METADATA_VALUE = /^[A-Za-z0-9][A-Za-z0-9_./:@+-]{0,255}$/u
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/u

export class VercelReleaseGuardError extends Error {
  constructor(message) {
    super(message)
    this.name = 'VercelReleaseGuardError'
  }
}

function fail(message) {
  throw new VercelReleaseGuardError(message)
}

function assertIdentifier(value, label) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    fail(`Vercel release preflight requires a valid ${label}.`)
  }
}

function assertRegularPath(path, label) {
  let stats
  try {
    stats = lstatSync(path)
  } catch {
    fail(`Vercel release preflight requires ${label}.`)
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    fail(`Vercel release preflight requires ${label}.`)
  }
}

function readLinkedProject(root) {
  const vercelDirectory = join(root, '.vercel')
  let directoryStats
  try {
    directoryStats = lstatSync(vercelDirectory)
  } catch {
    fail('Vercel release preflight requires an existing .vercel/project.json link.')
  }
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    fail('Vercel release preflight requires a regular .vercel directory.')
  }

  const linkPath = join(vercelDirectory, 'project.json')
  assertRegularPath(linkPath, 'an existing .vercel/project.json link')

  let parsed
  try {
    parsed = JSON.parse(readFileSync(linkPath, 'utf8'))
  } catch {
    fail('The checked-in Vercel project link is not valid JSON.')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('The checked-in Vercel project link has an invalid shape.')
  }
  assertIdentifier(parsed.projectId, 'linked project ID')
  assertIdentifier(parsed.orgId, 'linked organization ID')
  return { projectId: parsed.projectId, orgId: parsed.orgId }
}

/**
 * Validate the explicit deployment context before the Vercel CLI is started.
 * The caller supplies the root for testability; the package command always
 * supplies the repository root derived from this file, so users cannot pick a
 * different checkout through CLI arguments.
 */
export function verifyVercelReleaseLink({ root, expectedProjectId, expectedOrgId }) {
  if (typeof root !== 'string' || root.length === 0) {
    fail('Vercel release preflight requires a repository root.')
  }
  assertIdentifier(expectedProjectId, 'expected project ID')
  assertIdentifier(expectedOrgId, 'expected organization ID')
  const linked = readLinkedProject(root)
  if (linked.projectId !== expectedProjectId || linked.orgId !== expectedOrgId) {
    fail('The existing Vercel project link does not match the explicit expected project and organization IDs.')
  }
  return Object.freeze({ root, projectId: expectedProjectId, orgId: expectedOrgId })
}

function assertSafeMetadata(value) {
  const separator = value.indexOf('=')
  if (separator <= 0 || separator === value.length - 1) {
    fail('Vercel release metadata must use a non-empty key=value pair.')
  }
  const key = value.slice(0, separator)
  const metadataValue = value.slice(separator + 1)
  if (!SAFE_METADATA_KEY.test(key) || /(?:token|secret|password|credential|private|authorization|api[-_]?key)/iu.test(key)) {
    fail('Vercel release metadata uses an unsupported or credential-like key.')
  }
  if (!SAFE_METADATA_VALUE.test(metadataValue)) {
    fail('Vercel release metadata contains unsupported characters or is too long.')
  }
}

/** Validate only the small deploy option surface this wrapper forwards. */
export function validateVercelDeployArgs(args) {
  if (!Array.isArray(args) || args.length === 0) {
    fail('Vercel release requires the fixed deploy options --prebuilt --prod --yes.')
  }
  const seen = new Set()
  const forwarded = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (typeof argument !== 'string' || argument.length === 0) {
      fail('Vercel release options must be non-empty strings.')
    }
    if (SAFE_DEPLOY_FLAGS.has(argument)) {
      if (seen.has(argument)) fail(`Vercel release option ${argument} was supplied more than once.`)
      seen.add(argument)
      forwarded.push(argument)
      continue
    }
    if (argument === '--meta') {
      const value = args[index + 1]
      if (typeof value !== 'string') fail('Vercel release --meta requires one sanitized key=value value.')
      assertSafeMetadata(value)
      forwarded.push(argument, value)
      index += 1
      continue
    }
    // A whitelist is intentional: it rejects Vercel context, path, project,
    // team, token, debug, environment, and positional-target overrides.
    fail(`Vercel release option is not permitted: ${argument}`)
  }
  for (const required of REQUIRED_DEPLOY_FLAGS) {
    if (!seen.has(required)) fail(`Vercel release requires ${required}.`)
  }
  return forwarded
}

function childEnvironment(baseEnvironment, projectId, orgId) {
  const environment = {
    ...(baseEnvironment ?? process.env),
    VERCEL_PROJECT_ID: projectId,
    VERCEL_ORG_ID: orgId,
  }
  // The CLI's --scope/--team flags are rejected above. Remove the ambient
  // team override too, so the explicit organization binding remains singular.
  delete environment.VERCEL_TEAM_ID
  return environment
}

/**
 * Run exactly `vercel deploy` after the link and option preflights succeed.
 * No shell is used and the child receives a fixed working directory and
 * explicit project/organization environment values.
 */
export function runVercelRelease({
  root,
  expectedProjectId,
  expectedOrgId,
  deployArgs,
  environment = process.env,
  spawn = spawnSync,
}) {
  const verified = verifyVercelReleaseLink({ root, expectedProjectId, expectedOrgId })
  const safeArgs = validateVercelDeployArgs(deployArgs)
  const child = spawn(VERCEL_COMMAND, ['deploy', ...safeArgs], {
    cwd: verified.root,
    env: childEnvironment(environment, verified.projectId, verified.orgId),
    shell: false,
    stdio: 'inherit',
  })
  if (child?.error) fail('The Vercel CLI could not be started.')
  if (typeof child?.status !== 'number') fail('The Vercel CLI ended without a status.')
  return child.status
}

function parseValue(argv, index, flag) {
  const value = argv[index + 1]
  if (typeof value !== 'string' || value === '' || value === '--' || value.startsWith('-')) {
    fail(`${flag} requires an explicit value.`)
  }
  return value
}

/** Parse the package command's explicit IDs and the post-`--` deploy flags. */
export function parseVercelReleaseArgs(argv) {
  if (!Array.isArray(argv)) fail('Vercel release arguments are invalid.')
  const separator = argv.indexOf('--')
  if (separator < 0 || separator !== argv.lastIndexOf('--')) {
    fail('Vercel release requires `--` before the fixed deploy options.')
  }
  let expectedProjectId
  let expectedOrgId
  for (let index = 0; index < separator; index += 1) {
    const argument = argv[index]
    if (argument === '--project-id') {
      if (expectedProjectId !== undefined) fail('--project-id was supplied more than once.')
      expectedProjectId = parseValue(argv, index, '--project-id')
      index += 1
      continue
    }
    if (argument === '--org-id') {
      if (expectedOrgId !== undefined) fail('--org-id was supplied more than once.')
      expectedOrgId = parseValue(argv, index, '--org-id')
      index += 1
      continue
    }
    if (typeof argument === 'string' && argument.startsWith('--project-id=')) {
      if (expectedProjectId !== undefined) fail('--project-id was supplied more than once.')
      expectedProjectId = argument.slice('--project-id='.length)
      continue
    }
    if (typeof argument === 'string' && argument.startsWith('--org-id=')) {
      if (expectedOrgId !== undefined) fail('--org-id was supplied more than once.')
      expectedOrgId = argument.slice('--org-id='.length)
      continue
    }
    fail(`Vercel release argument is not permitted before the deploy separator: ${String(argument)}`)
  }
  assertIdentifier(expectedProjectId, 'expected project ID')
  assertIdentifier(expectedOrgId, 'expected organization ID')
  const deployArgs = argv.slice(separator + 1)
  validateVercelDeployArgs(deployArgs)
  return Object.freeze({ expectedProjectId, expectedOrgId, deployArgs })
}

function isMainModule() {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}

if (isMainModule()) {
  try {
    const options = parseVercelReleaseArgs(process.argv.slice(2))
    const status = runVercelRelease({
      root: REPOSITORY_ROOT,
      expectedProjectId: options.expectedProjectId,
      expectedOrgId: options.expectedOrgId,
      deployArgs: options.deployArgs,
    })
    process.exitCode = status
  } catch (error) {
    if (error instanceof VercelReleaseGuardError) {
      console.error(error.message)
    } else {
      console.error('Vercel release preflight failed.')
    }
    process.exitCode = 1
  }
}
