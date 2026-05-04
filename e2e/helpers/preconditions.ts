/**
 * Runtime precondition helpers for Pocket e2e specs.
 *
 * CI requirements per spec:
 *   pocket-owner:      Postgres at TEST_DATABASE_URL, Worker at WORKER_URL (for selfie enrollment)
 *   pocket-contributor: Postgres + real R2 credentials (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
 *                        R2_SECRET_ACCESS_KEY, R2_BUCKET) for presigned PUT URLs
 *   pocket-combined:   All of the above; also requires /api/internal/process-one-job endpoint
 *                      (available in non-production) to drive the dispatcher inside the spec.
 */

const WORKER_URL = process.env.WORKER_URL ?? 'http://localhost:8000'

/**
 * Returns true iff the Python face-detection worker responds to its /health endpoint
 * within 3 seconds. Returns false on any error or timeout.
 */
export async function isWorkerHealthy(): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3_000)
  try {
    const res = await fetch(`${WORKER_URL}/health`, { signal: controller.signal })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Returns true iff all four R2 environment variables are present and non-empty.
 * Presigned PUT URLs require real R2 credentials — there is no local override seam
 * for the PUT side.
 */
export function hasR2Config(): boolean {
  return Boolean(
    process.env.R2_ACCOUNT_ID &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY &&
      process.env.R2_BUCKET,
  )
}
