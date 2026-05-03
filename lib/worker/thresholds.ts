import { readFileSync } from 'node:fs'
import { join } from 'node:path'

interface ThresholdsJson {
  match_max_distance: number
  maybe_max_distance: number
}

function loadThresholds(): ThresholdsJson {
  const filePath = join(process.cwd(), 'worker', 'config', 'thresholds.json')
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch (err) {
    throw new Error(`thresholds.json not found at ${filePath}: ${err}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`thresholds.json is not valid JSON: ${err}`)
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).match_max_distance !== 'number' ||
    typeof (parsed as Record<string, unknown>).maybe_max_distance !== 'number'
  ) {
    throw new Error(
      'thresholds.json missing required fields: match_max_distance, maybe_max_distance',
    )
  }

  return parsed as ThresholdsJson
}

let cached: { match_max_distance: number; maybe_max_distance: number } | null = null

function load(): { match_max_distance: number; maybe_max_distance: number } {
  if (cached) return cached
  cached = loadThresholds()
  return cached
}

/** Binary match threshold for cosine distance. Used by the You feed filter. */
export function getMatchMaxDistance(): number {
  return load().match_max_distance
}

/**
 * Reserved for v1's "Maybe you" tier; intentionally unused in Pocket v0.
 * Plan anti-scope explicitly forbids surfacing this tier in v0 — do NOT
 * consume this constant from any code path without a corresponding plan
 * update.
 */
export function getMaybeMaxDistance(): number {
  return load().maybe_max_distance
}

/** Test-only: reset the cache. Used by tests to override thresholds. */
export function __resetThresholdsForTest(): void {
  cached = null
}
