/**
 * These values are replaced by Vite for a Vercel build. A non-Vercel build
 * receives null and keeps the normal Nitro runtime limits, preserving the
 * portable Node and edge profiles.
 */
declare const __PSKILLS_BUILT_VERCEL_FUNCTION_MAX_DURATION_SECONDS__: number | null
declare const __PSKILLS_BUILT_VERCEL_FUNCTION_HEADROOM_SECONDS__: number | null

const builtMaxDuration = typeof __PSKILLS_BUILT_VERCEL_FUNCTION_MAX_DURATION_SECONDS__ === 'number'
  ? __PSKILLS_BUILT_VERCEL_FUNCTION_MAX_DURATION_SECONDS__
  : undefined
const builtHeadroom = typeof __PSKILLS_BUILT_VERCEL_FUNCTION_HEADROOM_SECONDS__ === 'number'
  ? __PSKILLS_BUILT_VERCEL_FUNCTION_HEADROOM_SECONDS__
  : undefined

export const BUILT_VERCEL_FUNCTION_MAX_DURATION_SECONDS = builtMaxDuration
export const BUILT_VERCEL_FUNCTION_HEADROOM_SECONDS = builtHeadroom

/**
 * Keep a deployed runtime below the immutable duration in its generated
 * Vercel function config. The caller's runtime value is returned unchanged;
 * an absent override keeps the dispatcher's source default. A Vercel build
 * fails closed when a later runtime environment attempts to raise the cap.
 */
export function assertVercelRuntimeDuration(
  configuredDurationMs: number | undefined,
  sourceDefaultDurationMs: number,
  label: string,
  builtDurationSeconds = BUILT_VERCEL_FUNCTION_MAX_DURATION_SECONDS,
  headroomSeconds = BUILT_VERCEL_FUNCTION_HEADROOM_SECONDS,
): number | undefined {
  const effectiveDurationMs = configuredDurationMs ?? sourceDefaultDurationMs
  if (!Number.isSafeInteger(effectiveDurationMs) || effectiveDurationMs <= 0) {
    throw new Error(`${label} is invalid`)
  }
  if (builtDurationSeconds === undefined) return configuredDurationMs
  if (
    !Number.isSafeInteger(builtDurationSeconds)
    || builtDurationSeconds <= 0
    || headroomSeconds === undefined
    || !Number.isSafeInteger(headroomSeconds)
    || headroomSeconds < 0
    || headroomSeconds >= builtDurationSeconds
  ) {
    throw new Error('Generated Vercel function duration contract is invalid')
  }
  const runtimeCeilingMs = (builtDurationSeconds - headroomSeconds) * 1_000
  if (effectiveDurationMs > runtimeCeilingMs) {
    throw new Error(`${label} exceeds the generated Vercel function duration after headroom`)
  }
  return configuredDurationMs
}
