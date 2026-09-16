import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Keep the deployment budget in one place. The runtime dispatchers have
 * their own bounds, but a Vercel function must leave time for the dispatcher
 * to persist its lease/cursor before the platform terminates the request.
 */
export const DEFAULT_HOSTED_WORKER_DURATION_MS = 240_000
export const MAX_HOSTED_WORKER_DURATION_MS = 900_000
export const DEFAULT_REVIEWER_DURATION_MS = 600_000
export const MAX_REVIEWER_DURATION_MS = 840_000
export const DEFAULT_VERCEL_HEADROOM_SECONDS = 15
export const MIN_VERCEL_HEADROOM_SECONDS = 5
export const MAX_VERCEL_HEADROOM_SECONDS = 120
export const DEFAULT_VERCEL_PLAN_MAX_DURATION_SECONDS = 800
export const MAX_VERCEL_PLAN_DURATION_SECONDS = 1_800

const WORKER_DURATION_ENV = 'PSKILLS_HOSTED_WORKER_DISPATCH_MAX_DURATION_MS'
const REVIEWER_DURATION_ENV = 'PSKILLS_REVIEW_DISPATCH_MAX_DURATION_MS'
const HEADROOM_ENV = 'PSKILLS_VERCEL_FUNCTION_HEADROOM_SECONDS'
const PLAN_LIMIT_ENV = 'PSKILLS_VERCEL_PLAN_MAX_DURATION_SECONDS'

/**
 * Resolve the maximum invocation time that the generated Vercel function
 * should advertise. Explicit runtime overrides are honored so a smaller plan
 * can use smaller bounded dispatches; the runtime guard fails closed if those
 * overrides are absent when the deployed bundle still has larger source
 * defaults.
 */
export function resolveVercelFunctionBudget(environment = process.env) {
  const configuredWorkerMs = parseOptionalInteger(environment[WORKER_DURATION_ENV], WORKER_DURATION_ENV)
  const configuredReviewerMs = parseOptionalInteger(environment[REVIEWER_DURATION_ENV], REVIEWER_DURATION_ENV)
  const workerDurationMs = configuredWorkerMs ?? DEFAULT_HOSTED_WORKER_DURATION_MS
  const reviewerDurationMs = configuredReviewerMs ?? DEFAULT_REVIEWER_DURATION_MS
  if (workerDurationMs < 1_000 || workerDurationMs > MAX_HOSTED_WORKER_DURATION_MS) {
    throw new Error(`${WORKER_DURATION_ENV} must be between 1000 and ${MAX_HOSTED_WORKER_DURATION_MS} milliseconds`)
  }
  if (reviewerDurationMs < 1 || reviewerDurationMs > MAX_REVIEWER_DURATION_MS) {
    throw new Error(`${REVIEWER_DURATION_ENV} must be between 1 and ${MAX_REVIEWER_DURATION_MS} milliseconds`)
  }

  const headroomSeconds = parseBoundedInteger(
    environment[HEADROOM_ENV],
    DEFAULT_VERCEL_HEADROOM_SECONDS,
    MIN_VERCEL_HEADROOM_SECONDS,
    MAX_VERCEL_HEADROOM_SECONDS,
    HEADROOM_ENV,
  )
  const planMaxDurationSeconds = parseBoundedInteger(
    environment[PLAN_LIMIT_ENV],
    DEFAULT_VERCEL_PLAN_MAX_DURATION_SECONDS,
    1,
    MAX_VERCEL_PLAN_DURATION_SECONDS,
    PLAN_LIMIT_ENV,
  )

  const runtimeDurationMs = Math.max(
    workerDurationMs,
    reviewerDurationMs,
  )
  const runtimeDurationSeconds = Math.ceil(runtimeDurationMs / 1_000)
  const maxDurationSeconds = runtimeDurationSeconds + headroomSeconds
  if (maxDurationSeconds > planMaxDurationSeconds) {
    throw new Error(
      `Vercel function duration ${maxDurationSeconds}s exceeds the declared plan limit ${planMaxDurationSeconds}s; `
      + `lower ${WORKER_DURATION_ENV}/${REVIEWER_DURATION_ENV} or increase ${PLAN_LIMIT_ENV} for the actual eligible plan`,
    )
  }

  return {
    workerDurationMs,
    reviewerDurationMs,
    runtimeDurationMs,
    runtimeDurationSeconds,
    headroomSeconds,
    planMaxDurationSeconds,
    maxDurationSeconds,
  }
}

/**
 * Apply the resolved duration to every serverless function config emitted by
 * Nitro. Function directories may be symlinked aliases, so only regular
 * `.vc-config.json` files are changed.
 */
export function applyVercelFunctionBudget(outputDirectory, budget) {
  const functionsDirectory = resolve(outputDirectory, 'functions')
  if (!existsSync(functionsDirectory)) throw new Error(`Vercel function output is missing: ${functionsDirectory}`)
  const configPaths = collectFunctionConfigPaths(functionsDirectory)
  if (configPaths.length === 0) throw new Error(`Vercel function output has no .vc-config.json files: ${functionsDirectory}`)
  for (const configPath of configPaths) {
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error(`Vercel function config is invalid: ${configPath}`)
    }
    config.maxDuration = budget.maxDurationSeconds
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
  }
  return configPaths
}

/** Verify the value in generated output rather than trusting the resolver. */
export function verifyVercelFunctionBudget(outputDirectory, budget) {
  const functionsDirectory = resolve(outputDirectory, 'functions')
  const configPaths = collectFunctionConfigPaths(functionsDirectory)
  if (configPaths.length === 0) throw new Error(`Vercel function output has no .vc-config.json files: ${functionsDirectory}`)
  for (const configPath of configPaths) {
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    if (config?.maxDuration !== budget.maxDurationSeconds) {
      throw new Error(
        `Vercel function config ${configPath} has maxDuration=${String(config?.maxDuration)}; expected ${budget.maxDurationSeconds}`,
      )
    }
  }
  return configPaths
}

function collectFunctionConfigPaths(directory) {
  const paths = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) paths.push(...collectFunctionConfigPaths(path))
    else if (entry.isFile() && entry.name === '.vc-config.json') paths.push(path)
  }
  return paths.sort()
}

function parseOptionalInteger(value, name) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} must be a positive integer`)
  if (!/^\d+$/u.test(value.trim())) throw new Error(`${name} must be a positive integer`)
  const parsed = Number(value.trim())
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`)
  return parsed
}

function parseBoundedInteger(value, fallback, minimum, maximum, name) {
  const parsed = parseOptionalInteger(value, name) ?? fallback
  if (parsed < minimum || parsed > maximum) throw new Error(`${name} must be between ${minimum} and ${maximum}`)
  return parsed
}
