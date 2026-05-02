import { sql } from 'drizzle-orm'
import { db } from '@/db'
import type { photoJobs } from '@/db/schema'

type TxParam = Parameters<Parameters<typeof db.transaction>[0]>[0]
type DbOrTx = typeof db | TxParam

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
 * Mark a claimed job as succeeded.
 *
 * - Sets state='succeeded', succeeded_at=now(), clears claim fields.
 *
 * @returns The updated row, or null if the job is no longer in 'claimed' state
 *   (e.g., a watchdog reclaim already happened and another worker now owns it).
 *
 * IMPORTANT — Transaction safety: callers running inside a transaction (notably
 * Task 9's dispatcher inserting face_detections in the same tx) MUST throw on a
 * null return so the surrounding transaction rolls back. Committing your work
 * after a null markSucceeded creates duplicate face_detections rows when the
 * other worker also commits.
 *
 * @param dbOrTx Optional Drizzle db or transaction handle. Defaults to the
 *   global `db`. Pass the transaction handle when calling inside `db.transaction()`
 *   so the UPDATE participates in the same transaction and rolls back atomically.
 */
export async function markSucceeded(jobId: string, dbOrTx: DbOrTx = db): Promise<PhotoJob | null> {
  const result = (await dbOrTx.execute(sql`
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
 * Marks a claimed job as failed after a worker error.
 *
 * Uses a single atomic CASE UPDATE (no TOCTOU window):
 * - If attempts < max_attempts: sets state='queued', clears claim fields so
 *   the next worker can pick up the job.
 * - If attempts >= max_attempts: dead-letters to state='failed'. Claim fields
 *   are preserved on dead-letter so operators can identify which worker failed last.
 *
 * Does NOT increment attempts — that is the claim helper's responsibility.
 *
 * @returns The updated row, or null if the job is not in 'claimed' state or does
 *   not exist. A null return on a non-existent job fires a `worker.job.notfound`
 *   warn. A null return because the job is no longer 'claimed' (e.g., a watchdog
 *   already reclaimed it and another worker succeeded) fires a
 *   `worker.job.late_marker` warn — the stale late-marker becomes a no-op and the
 *   succeeded row is left untouched.
 *
 * The `AND state = 'claimed'` guard prevents the stale-worker race condition where:
 *   1. Watchdog reclaims job J for Worker B.
 *   2. Worker B succeeds: state → 'succeeded'.
 *   3. Worker A's hanging call resolves and calls markFailed.
 *   Without the guard, the CASE expression would transition the succeeded row back
 *   to 'queued', causing duplicate processing.
 *
 * NOTE — Transaction safety for callers: this function is intentionally
 *   tx-unaware (no dbOrTx parameter). It must always be called OUTSIDE any
 *   open transaction, because it needs to observe the committed DB state to
 *   correctly distinguish retry vs dead-letter paths. The `AND state = 'claimed'`
 *   guard also relies on the committed row state — calling inside a transaction
 *   that has already mutated the row would produce incorrect results.
 *   The Task 9 dispatcher calls markFailed only in the catch block, after any
 *   transaction has already rolled back.
 *
 * Emits:
 *   worker.job.retry      (console.log / INFO)   on retry path
 *   worker.job.failed     (console.error / ERROR) on dead-letter path
 *   worker.job.notfound   (console.warn / WARN)   when jobId does not exist
 *   worker.job.late_marker (console.warn / WARN)  when job is no longer 'claimed'
 */
export async function markFailed(jobId: string, error: string): Promise<PhotoJob | null> {
  const result = (await db.execute(sql`
    UPDATE photo_jobs
    SET
      -- All CASE expressions below evaluate against the pre-update row.
      -- Per Postgres UPDATE semantics: SET-list expressions read the original
      -- values, so the retry-vs-dead-letter decision (attempts < max_attempts)
      -- is consistent across all four columns even if a future change adds
      -- "attempts = attempts + 1" to the same UPDATE.
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
      AND state = 'claimed'
    RETURNING
      photo_jobs.*,
      (SELECT photos.event_id FROM photos WHERE photos.id = photo_jobs.photo_id) AS event_id_for_log
  `)) as unknown as RawCompleteRow[]

  const rows = Array.from(result)

  if (rows.length === 0) {
    // Distinguish: does the row exist at all, or is it just not in 'claimed' state?
    const existing = (await db.execute(sql`
      SELECT id FROM photo_jobs WHERE id = ${jobId}
    `)) as unknown as { id: string }[]
    const exists = Array.from(existing).length > 0

    if (!exists) {
      console.warn({ event: 'worker.job.notfound', jobId, error })
    } else {
      // Row exists but not in 'claimed' state — stale late-marker (e.g., watchdog
      // reclaimed and another worker already succeeded this job).
      console.warn({ event: 'worker.job.late_marker', jobId, error })
    }
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
