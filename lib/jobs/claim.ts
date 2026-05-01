import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { photoJobs } from '@/db/schema'

export type PhotoJob = typeof photoJobs.$inferSelect

// Raw DB row shape returned by postgres-js (snake_case column names).
// Timestamps may be Date objects or ISO strings depending on the postgres-js
// type parser configuration — accept both.
type RawJobRow = {
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
  // CTE extras
  prev_claimed_by: string | null
  prev_state: string | null
  prev_attempts: number | null
}

function toDate(v: Date | string | null | undefined): Date | null {
  if (v == null) return null
  return v instanceof Date ? v : new Date(v)
}

function toDateNN(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v)
}

function mapRow(raw: RawJobRow): PhotoJob {
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
  }
}

/**
 * Claims the next available job from photo_jobs using SELECT … FOR UPDATE SKIP LOCKED.
 *
 * Uses a CTE pattern so we can capture the pre-update state (prev_claimed_by, prev_state)
 * in the same statement, enabling reclaim detection without a separate SELECT.
 *
 * Returns null when no jobs are claimable.
 */
export async function claimNextJob(
  workerId: string,
  claimTimeoutSec: number = 120,
): Promise<PhotoJob | null> {
  // db.execute with postgres-js driver returns the raw postgres result (array-like, snake_case)
  const result = (await db.execute(sql`
    WITH candidate AS (
      SELECT id, claimed_by AS prev_claimed_by, state AS prev_state, attempts AS prev_attempts
      FROM photo_jobs
      WHERE (state = 'queued')
         OR (state = 'claimed' AND claimed_at < now() - make_interval(secs => ${claimTimeoutSec}))
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE photo_jobs
    SET
      state = 'claimed',
      attempts = attempts + 1,
      claimed_at = now(),
      claimed_by = ${workerId},
      updated_at = now()
    FROM candidate
    WHERE photo_jobs.id = candidate.id
    RETURNING
      photo_jobs.*,
      candidate.prev_claimed_by,
      candidate.prev_state,
      candidate.prev_attempts
  `)) as unknown as RawJobRow[]

  const rows = Array.from(result)

  if (rows.length === 0) {
    return null
  }

  const raw = rows[0]

  // Emit reclaim warn when a stuck claimed job is re-owned by a new worker.
  if (raw.prev_state === 'claimed') {
    console.warn({
      event: 'worker.job.reclaimed',
      jobId: raw.id,
      previousClaimedBy: raw.prev_claimed_by,
      previousAttempts: raw.prev_attempts,
      claimTimeoutSec,
    })
  }

  return mapRow(raw)
}
