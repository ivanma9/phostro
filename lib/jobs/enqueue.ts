import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { photoJobs } from '@/db/schema'

type PhotoJob = typeof photoJobs.$inferSelect

export async function enqueuePhotoJob(
  photoId: string,
  opts?: { kind?: string },
): Promise<PhotoJob> {
  const kind = opts?.kind ?? 'detect'

  // Use onConflictDoUpdate with a no-op SET so RETURNING always yields one row —
  // either the freshly inserted row or the existing active row. This eliminates
  // the TOCTOU window present in a separate INSERT + SELECT approach (the
  // INSERT-then-SELECT pattern could produce TypeError if the active row
  // transitioned to 'failed' between the two statements).
  //
  // The no-op touches only `kind` with its own value; all other columns (state,
  // attempts, etc.) remain unchanged.
  //
  // MUST match db/schema.ts photoJobs partial unique index predicate:
  // WHERE state IN ('queued','claimed','succeeded')
  const [job] = await db
    .insert(photoJobs)
    .values({ photoId, kind })
    .onConflictDoUpdate({
      target: [photoJobs.photoId, photoJobs.kind],
      targetWhere: sql`state IN ('queued','claimed','succeeded')`,
      set: { kind: sql`excluded.kind` },
    })
    .returning()

  // Log a single neutral event; callers can infer idempotency by observing
  // repeated jobId values across calls.
  console.log({ event: 'photo_job.enqueue', photoId, jobId: job.id, state: job.state })

  return job
}
