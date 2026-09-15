export const DEFAULT_HOSTED_WORKER_DURATION_MS: 240000
export const MAX_HOSTED_WORKER_DURATION_MS: 900000
export const DEFAULT_REVIEWER_DURATION_MS: 600000
export const MAX_REVIEWER_DURATION_MS: 840000
export const DEFAULT_VERCEL_HEADROOM_SECONDS: 15
export const MIN_VERCEL_HEADROOM_SECONDS: 5
export const MAX_VERCEL_HEADROOM_SECONDS: 120
export const DEFAULT_VERCEL_PLAN_MAX_DURATION_SECONDS: 800
export const MAX_VERCEL_PLAN_DURATION_SECONDS: 1800

export interface VercelFunctionBudget {
  workerDurationMs: number
  reviewerDurationMs: number
  runtimeDurationMs: number
  runtimeDurationSeconds: number
  headroomSeconds: number
  planMaxDurationSeconds: number
  maxDurationSeconds: number
}

export function resolveVercelFunctionBudget(environment?: Record<string, string | undefined>): VercelFunctionBudget
export function applyVercelFunctionBudget(outputDirectory: string, budget: VercelFunctionBudget): string[]
export function verifyVercelFunctionBudget(outputDirectory: string, budget: VercelFunctionBudget): string[]
