import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { faceDetections, photos } from '@/db/schema'
import { claimNextJob } from '@/lib/jobs/claim'
import { markFailed, markSucceeded, type PhotoJob } from '@/lib/jobs/complete'
import { detectPhoto } from './client'

// TODO: add Sentry breadcrumbs (Task 16)

/**
 * Claims and processes one job from the queue.
 *
 * Returns the succeeded PhotoJob row, or null if no jobs were available (idle).
 *
 * Race-loss semantic: if `markSucceeded` returns null it means another worker
 * already succeeded this job (watchdog reclaim + fast parallel worker). The
 * transaction throws, rolling back any face_detections inserts. The catch
 * block detects the null-markSucceeded case, logs `worker.dispatch.race_loss`,
 * and returns without calling `markFailed` — because the job IS succeeded, just
 * not by us. markFailed would see `state != 'claimed'` and emit a late_marker
 * warn, which is misleading. Instead we treat it as a clean no-op.
 */
export async function processOneJob(workerId: string): Promise<PhotoJob | null> {
  // Step 1: claim a job
  const job = await claimNextJob(workerId, 120)
  if (!job) {
    // Idle — no jobs available
    return null
  }

  const jobId = job.id
  const photoId = job.photoId

  // Sentinel to distinguish race-loss from real errors inside the transaction
  const RACE_LOSS = Symbol('race_loss')

  try {
    // Step 2: fetch photo row; defensive check
    const [photo] = await db.select().from(photos).where(eq(photos.id, photoId))

    if (!photo || photo.processingState !== 'ready' || photo.r2KeyPreview == null) {
      await markFailed(jobId, 'photo_not_ready')
      console.warn({
        event: 'worker.dispatch.photo_not_ready',
        jobId,
        photoId,
        processingState: photo?.processingState,
        hasPreview: photo?.r2KeyPreview != null,
      })
      return null
    }

    // Step 3: call the Python worker
    const detectResult = await detectPhoto(photoId, photo.r2KeyPreview)

    // Step 4: transactional commit — face_detections + has_detected_faces + markSucceeded
    const succeededJob = await db.transaction(async (tx) => {
      // Insert face_detections rows (may be empty)
      if (detectResult.faces.length > 0) {
        await tx.insert(faceDetections).values(
          detectResult.faces.map((face) => ({
            photoId,
            bboxX1: face.bbox_x1,
            bboxY1: face.bbox_y1,
            bboxX2: face.bbox_x2,
            bboxY2: face.bbox_y2,
            confidence: face.confidence,
            landmarksJson: face.landmarks,
            embedding: face.embedding,
          })),
        )
      }

      // Update has_detected_faces — NEVER write processing_state (Phase 2 owns it)
      await tx
        .update(photos)
        .set({ hasDetectedFaces: detectResult.faces.length > 0 })
        .where(eq(photos.id, photoId))

      // Mark job succeeded inside the transaction
      const result = await markSucceeded(jobId, tx)

      if (result === null) {
        // Another worker already succeeded this job — throw to roll back the
        // transaction, preventing duplicate face_detections. The catch block
        // will handle RACE_LOSS specially.
        throw RACE_LOSS
      }

      return result
    })

    console.log({
      event: 'worker.dispatch.success',
      jobId,
      photoId,
      faceCount: detectResult.faces.length,
      elapsedMs: detectResult.elapsed_ms,
    })
    return succeededJob
  } catch (err: unknown) {
    if (err === RACE_LOSS) {
      // Another worker succeeded this job before us. Transaction rolled back.
      // Do NOT call markFailed (the job is already succeeded).
      console.warn({
        event: 'worker.dispatch.race_loss',
        jobId,
        photoId,
        workerId,
      })
      return null
    }

    // Real error — mark the job failed (handles retry vs dead-letter internally)
    const errorMessage = err instanceof Error ? err.message : String(err)
    const failResult = await markFailed(jobId, errorMessage)

    if (failResult?.state === 'queued') {
      console.log({
        event: 'worker.dispatch.retry',
        jobId,
        photoId,
        error: errorMessage,
        attempts: failResult.attempts,
      })
    } else if (failResult?.state === 'failed') {
      console.error({
        event: 'worker.dispatch.dead_letter',
        jobId,
        photoId,
        error: errorMessage,
        attempts: failResult.attempts,
      })
    }

    return null
  }
}
