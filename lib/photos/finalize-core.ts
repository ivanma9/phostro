import { and, eq, inArray, lt, or } from 'drizzle-orm'
import { db } from '@/db'
import { photos } from '@/db/schema'
import { enqueuePhotoJob } from '@/lib/jobs/enqueue'
import { MAX_UPLOAD_BYTES, originalKey, previewKey } from '@/lib/photos/keys'
import { ImageProcessError, processImage } from '@/lib/photos/process'
import { deleteObject, getObjectBuffer, headObject, putObject } from '@/lib/photos/r2'
import { ShareLinkError, incrementShareLinkUsage } from '@/lib/share-links/storage'

export type Actor =
  | { kind: 'user'; userId: string }
  | { kind: 'token'; token: string; linkId: string }

export type FinalizeOutcome =
  | { ok: true; photo: typeof photos.$inferSelect }
  | { ok: false; status: number; body: Record<string, unknown> }

const STALE_CLAIM_AGE_MS = 5 * 60 * 1000

async function markFailed(photoId: string, alsoDeleteKey?: string | null): Promise<void> {
  await db
    .update(photos)
    .set({
      processingState: 'failed',
      processingClaimedAt: null,
    })
    .where(and(eq(photos.id, photoId), inArray(photos.processingState, ['pending', 'processing'])))
  if (alsoDeleteKey) {
    try {
      await deleteObject(alsoDeleteKey)
    } catch {
      // best effort
    }
  }
}

export async function finalizePhotoCore(
  eventId: string,
  photoId: string,
  actor: Actor,
): Promise<FinalizeOutcome> {
  const [row] = await db.select().from(photos).where(eq(photos.id, photoId))

  if (!row || row.eventId !== eventId) {
    return { ok: false, status: 404, body: { error: 'not found' } }
  }

  // Authorization check — depends on actor kind
  if (actor.kind === 'user') {
    if (row.uploaderUserId !== actor.userId) {
      return { ok: false, status: 403, body: { error: 'forbidden' } }
    }
  } else {
    if (row.uploaderToken !== actor.token) {
      return { ok: false, status: 403, body: { error: 'forbidden' } }
    }
  }

  if (
    row.pendingExpiresAt &&
    row.pendingExpiresAt.getTime() < Date.now() &&
    (row.processingState === 'pending' || row.processingState === 'processing')
  ) {
    await markFailed(row.id, row.pendingKey)
    return { ok: false, status: 410, body: { status: 'expired' } }
  }

  const staleCutoff = new Date(Date.now() - STALE_CLAIM_AGE_MS)
  const claimed = await db
    .update(photos)
    .set({ processingState: 'processing', processingClaimedAt: new Date() })
    .where(
      and(
        eq(photos.id, row.id),
        or(
          eq(photos.processingState, 'pending'),
          and(
            eq(photos.processingState, 'processing'),
            lt(photos.processingClaimedAt, staleCutoff),
          ),
        ),
      ),
    )
    .returning()

  if (claimed.length === 0) {
    const [now] = await db.select().from(photos).where(eq(photos.id, row.id))
    if (now.processingState === 'ready') {
      return { ok: true, photo: now }
    }
    if (now.processingState === 'failed') {
      return { ok: false, status: 422, body: { status: 'failed' } }
    }
    if (now.processingState === 'processing') {
      return {
        ok: false,
        status: 409,
        body: { status: 'processing', retryAfterSeconds: 30 },
      }
    }
    return { ok: false, status: 500, body: { status: 'unexpected' } }
  }

  const claimedRow = claimed[0]
  const pending = claimedRow.pendingKey
  if (!pending) {
    await markFailed(claimedRow.id)
    return { ok: false, status: 500, body: { status: 'corrupt' } }
  }

  const head = await headObject(pending)
  if (!head) {
    await markFailed(claimedRow.id)
    return { ok: false, status: 410, body: { status: 'expired' } }
  }
  if (head.contentLength > MAX_UPLOAD_BYTES) {
    await markFailed(claimedRow.id, pending)
    return { ok: false, status: 413, body: { status: 'too-large' } }
  }

  let buf: Buffer
  try {
    buf = await getObjectBuffer(pending)
  } catch {
    await markFailed(claimedRow.id, pending)
    return { ok: false, status: 410, body: { status: 'expired' } }
  }

  let result: Awaited<ReturnType<typeof processImage>>
  try {
    result = await processImage(buf)
  } catch (e) {
    await markFailed(claimedRow.id, pending)
    if (e instanceof ImageProcessError) {
      return { ok: false, status: 422, body: { status: 'unprocessable' } }
    }
    throw e
  }

  const okey = originalKey(eventId, claimedRow.id)
  const pkey = previewKey(eventId, claimedRow.id)
  await putObject(okey, result.originalJpeg, 'image/jpeg')
  await putObject(pkey, result.previewJpeg, 'image/jpeg')
  try {
    await deleteObject(pending)
  } catch {
    // best effort
  }

  // Final state transition to ready — wrap in a transaction so share-link increment
  // is atomic with the state change.
  let finalRow: typeof photos.$inferSelect
  try {
    finalRow = await db.transaction(async (tx) => {
      const updated = await tx
        .update(photos)
        .set({
          processingState: 'ready',
          r2KeyOriginal: okey,
          r2KeyPreview: pkey,
          width: result.width,
          height: result.height,
          sizeBytesOriginal: result.originalJpeg.length,
          takenAt: result.takenAt,
          uploadedAt: new Date(),
          pendingKey: null,
          pendingExpiresAt: null,
          processingClaimedAt: null,
        })
        // WHERE predicate ensures this is a no-op if a concurrent finalize already finished.
        .where(and(eq(photos.id, claimedRow.id), eq(photos.processingState, 'processing')))
        .returning()

      if (updated.length > 0) {
        // State actually transitioned — increment share link usage if token actor.
        if (actor.kind === 'token') {
          await incrementShareLinkUsage(tx, actor.linkId)
        }
        return updated[0]
      }

      // Concurrent finalize beat us; read the current row (should be ready).
      const [current] = await tx.select().from(photos).where(eq(photos.id, claimedRow.id))
      return current
    })
  } catch (e) {
    if (e instanceof ShareLinkError) {
      // incrementShareLinkUsage threw — transaction rolled back automatically.
      // R2 objects written above are orphaned (v1 cleanup concern).
      const status = e.code === 'exhausted' ? 429 : 410
      return { ok: false, status, body: { status: e.code } }
    }
    throw e
  }

  try {
    await enqueuePhotoJob(claimedRow.id)
  } catch (err) {
    console.error({ event: 'worker.enqueue.failed', photoId: claimedRow.id, error: String(err) })
    return { ok: false, status: 500, body: { error: 'enqueue failed' } }
  }

  return { ok: true, photo: finalRow }
}
