import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/db'
import { photoJobs } from '@/db/schema'

type PhotoJob = typeof photoJobs.$inferSelect

export async function enqueuePhotoJob(
  photoId: string,
  opts?: { kind?: string },
): Promise<PhotoJob> {
  const kind = opts?.kind ?? 'detect'

  // The partial unique index is on (photo_id, kind) WHERE state IN ('queued','claimed','succeeded').
  // PostgreSQL requires the conflict clause WHERE to match the index predicate exactly.
  const inserted = await db
    .insert(photoJobs)
    .values({ photoId, kind })
    .onConflictDoNothing({
      target: [photoJobs.photoId, photoJobs.kind],
      where: sql`state IN ('queued','claimed','succeeded')`,
    })
    .returning()

  if (inserted.length > 0) {
    const job = inserted[0]
    console.log({ event: 'photo_job.enqueued', photoId, jobId: job.id })
    return job
  }

  // Conflict: an active row (queued/claimed/succeeded) already exists — fetch it.
  const [existing] = await db
    .select()
    .from(photoJobs)
    .where(
      and(
        eq(photoJobs.photoId, photoId),
        eq(photoJobs.kind, kind),
        inArray(photoJobs.state, ['queued', 'claimed', 'succeeded']),
      ),
    )

  console.log({ event: 'photo_job.enqueue.skipped', photoId, jobId: existing.id })
  return existing
}
