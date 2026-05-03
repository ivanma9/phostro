import { and, eq, inArray, lt, or } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { db } from '@/db'
import { photos } from '@/db/schema'
import { getCurrentUser } from '@/lib/auth/current-user'
import { enqueuePhotoJob } from '@/lib/jobs/enqueue'
import { MAX_UPLOAD_BYTES, originalKey, previewKey } from '@/lib/photos/keys'
import { ImageProcessError, processImage } from '@/lib/photos/process'
import { deleteObject, getObjectBuffer, headObject, putObject } from '@/lib/photos/r2'

export const runtime = 'nodejs'
// Sharp + R2 round-trips can take 10s+ on large HEICs. Bump above the Vercel default.
export const maxDuration = 60

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

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; photoId: string }> },
) {
  const { id: eventId, photoId } = await params

  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })

  const [row] = await db.select().from(photos).where(eq(photos.id, photoId))
  if (!row || row.eventId !== eventId) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  if (row.uploaderUserId !== user.id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  if (
    row.pendingExpiresAt &&
    row.pendingExpiresAt.getTime() < Date.now() &&
    (row.processingState === 'pending' || row.processingState === 'processing')
  ) {
    await markFailed(row.id, row.pendingKey)
    return NextResponse.json({ status: 'expired' }, { status: 410 })
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
      return NextResponse.json({ photo: now })
    }
    if (now.processingState === 'failed') {
      return NextResponse.json({ status: 'failed' }, { status: 422 })
    }
    if (now.processingState === 'processing') {
      return NextResponse.json({ status: 'processing', retryAfterSeconds: 30 }, { status: 409 })
    }
    return NextResponse.json({ status: 'unexpected' }, { status: 500 })
  }

  const claimedRow = claimed[0]
  const pending = claimedRow.pendingKey
  if (!pending) {
    await markFailed(claimedRow.id)
    return NextResponse.json({ status: 'corrupt' }, { status: 500 })
  }

  const head = await headObject(pending)
  if (!head) {
    await markFailed(claimedRow.id)
    return NextResponse.json({ status: 'expired' }, { status: 410 })
  }
  if (head.contentLength > MAX_UPLOAD_BYTES) {
    await markFailed(claimedRow.id, pending)
    return NextResponse.json({ status: 'too-large' }, { status: 413 })
  }

  let buf: Buffer
  try {
    buf = await getObjectBuffer(pending)
  } catch {
    await markFailed(claimedRow.id, pending)
    return NextResponse.json({ status: 'expired' }, { status: 410 })
  }

  let result: Awaited<ReturnType<typeof processImage>>
  try {
    result = await processImage(buf)
  } catch (e) {
    await markFailed(claimedRow.id, pending)
    if (e instanceof ImageProcessError) {
      return NextResponse.json({ status: 'unprocessable' }, { status: 422 })
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

  const [final] = await db
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
    .where(eq(photos.id, claimedRow.id))
    .returning()

  try {
    await enqueuePhotoJob(claimedRow.id)
  } catch (err) {
    console.error({ event: 'worker.enqueue.failed', photoId: claimedRow.id, error: String(err) })
    return NextResponse.json({ error: 'enqueue failed' }, { status: 500 })
  }

  return NextResponse.json({ photo: final })
}
