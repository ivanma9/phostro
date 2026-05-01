import { sql } from 'drizzle-orm'
import { db } from '@/db'
import type { photoJobs } from '@/db/schema'

export type PhotoJob = typeof photoJobs.$inferSelect

type RawCompleteRow = {
  id: string
  photo_id: string
  kind: string
  state: string
  attempts: number
  max_attempts: number
  claimed_at: Date | string | null
  claimed_by: string | null
  last_error: string | null
  last_error_at: Date | string | null
  succeeded_at: Date | string | null
  failed_at: Date | string | null
  created_at: Date | string
  updated_at: Date | string
  // From JOIN
  event_id_for_log: string | null
}

function toDate(v: Date | string | null | undefined): Date | null {
  if (v == null) return null
  return v instanceof Date ? v : new Date(v)
}

function toDateNN(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v)
}

function mapRow(raw: RawCompleteRow): PhotoJob & { _eventId: string | null } {
  return {
    id: raw.id,
    photoId: raw.photo_id,
    kind: raw.kind,
    state: raw.state as PhotoJob['state'],
    attempts: raw.attempts,
    maxAttempts: raw.max_attempts,
    claimedAt: toDate(raw.claimed_at),
    claimedBy: raw.claimed_by,
    lastError: raw.last_error,
    lastErrorAt: toDate(raw.last_error_at),
    succeededAt: toDate(raw.succeeded_at),
    failedAt: toDate(raw.failed_at),
    createdAt: toDateNN(raw.created_at),
    updatedAt: toDateNN(raw.updated_at),
    _eventId: raw.event_id_for_log,
  }
}

/**
 * Marks a job as succeeded.
 *
 * - Sets state='succeeded', succeeded_at=now(), clears claim fields.
 * - If the job is not in 'claimed' state, returns null without modifying the row.
 *   This is intentional: a race where two workers try to succeed the same job
 *   should be a silent no-op for the loser, not a crash or a data corruption.
 */
export async function markSucceeded(jobId: string): Promise<PhotoJob | null> {
  const result = (await db.execute(sql`
    UPDATE photo_jobs
    SET
      state       = 'succeeded',
      succeeded_at = now(),
      claimed_at  = NULL,
      claimed_by  = NULL,
      updated_at  = now()
    WHERE id = ${jobId}
      AND state = 'claimed'
    RETURNING
      photo_jobs.*,
      (SELECT photos.event_id FROM photos WHERE photos.id = photo_jobs.photo_id) AS event_id_for_log
  `)) as unknown as RawCompleteRow[]

  const rows = Array.from(result)

  if (rows.length === 0) {
    // Either jobId does not exist or job is not in 'claimed' state (no-op).
    return null
  }

  const mapped = mapRow(rows[0])
  const { _eventId, ...job } = mapped
  return job
}

/**
 * Marks a job as failed after a worker error.
 *
 * Uses a single atomic CASE UPDATE (no TOCTOU window):
 * - If attempts < max_attempts: sets state='queued', clears claim fields so
 *   the next worker can pick up the job.
 * - If attempts >= max_attempts: dead-letters to state='failed'. Claim fields
 *   are preserved on dead-letter so operators can identify which worker failed last.
 *
 * Does NOT increment attempts — that is the claim helper's responsibility.
 *
 * Emits:
 *   worker.job.retry  (console.log / INFO)  on retry path
 *   worker.job.failed (console.error / ERROR) on dead-letter path
 *
 * Returns null if the job does not exist (logs a warn for operator visibility).
 */
export async function markFailed(jobId: string, error: string): Promise<PhotoJob | null> {
  const result = (await db.execute(sql`
    UPDATE photo_jobs
    SET
      state        = CASE WHEN attempts < max_attempts THEN 'queued' ELSE 'failed' END,
      last_error   = ${error},
      last_error_at = now(),
      failed_at    = CASE WHEN attempts < max_attempts THEN failed_at ELSE now() END,
      -- Retry path: clear claim so watchdog/next worker can pick up.
      -- Dead-letter path: preserve claim fields so operators can see who failed last.
      claimed_at   = CASE WHEN attempts < max_attempts THEN NULL ELSE claimed_at END,
      claimed_by   = CASE WHEN attempts < max_attempts THEN NULL ELSE claimed_by END,
      updated_at   = now()
    WHERE id = ${jobId}
    RETURNING
      photo_jobs.*,
      (SELECT photos.event_id FROM photos WHERE photos.id = photo_jobs.photo_id) AS event_id_for_log
  `)) as unknown as RawCompleteRow[]

  const rows = Array.from(result)

  if (rows.length === 0) {
    console.warn({ event: 'worker.job.notfound', jobId, last_error: error })
    return null
  }

  const mapped = mapRow(rows[0])
  const { _eventId, ...job } = mapped
  const eventId = _eventId

  if (job.state === 'queued') {
    // Retry path
    console.log({
      event: 'worker.job.retry',
      jobId: job.id,
      photoId: job.photoId,
      eventId,
      attempts: job.attempts,
      last_error: error,
    })
  } else {
    // Dead-letter path
    console.error({
      event: 'worker.job.failed',
      jobId: job.id,
      photoId: job.photoId,
      eventId,
      attempts: job.attempts,
      last_error: error,
    })
  }

  return job
}
