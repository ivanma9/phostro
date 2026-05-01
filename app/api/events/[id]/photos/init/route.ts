import { and, eq, sql } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { db } from '@/db'
import { eventMembers, events, photos } from '@/db/schema'
import { getCurrentUser } from '@/lib/auth/current-user'
import { countActivePhotos } from '@/lib/photos/cap'
import {
  ALLOWED_UPLOAD_MIMES,
  MAX_PHOTOS_PER_EVENT,
  MAX_UPLOAD_BYTES,
  PUT_URL_TTL_SECONDS,
  pendingKey,
} from '@/lib/photos/keys'
import { createPresignedPutUrl } from '@/lib/photos/r2'

export const runtime = 'nodejs'

const PENDING_TTL_MS = 24 * 60 * 60 * 1000

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: eventId } = await params

  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })

  const body = (await req.json()) as {
    filename?: unknown
    mimeType?: unknown
    sizeBytes?: unknown
  }

  const mimeType = typeof body.mimeType === 'string' ? body.mimeType : ''
  if (!ALLOWED_UPLOAD_MIMES.has(mimeType)) {
    return NextResponse.json({ error: 'invalid mime type' }, { status: 400 })
  }

  const sizeBytes =
    typeof body.sizeBytes === 'number' && Number.isInteger(body.sizeBytes) ? body.sizeBytes : -1
  if (sizeBytes <= 0) {
    return NextResponse.json({ error: 'invalid size' }, { status: 400 })
  }
  if (sizeBytes > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: 'size exceeds limit' }, { status: 413 })
  }

  const filename =
    typeof body.filename === 'string' && body.filename.length > 0
      ? body.filename.slice(0, 255)
      : null

  // Membership + event existence + expiry, then cap-count + INSERT in a single TX.
  const photoId = await db
    .transaction(async (tx) => {
      const [event] = await tx.select().from(events).where(eq(events.id, eventId))
      if (!event) throw Object.assign(new Error('not found'), { status: 404 })
      if (event.expiresAt.getTime() <= Date.now()) {
        throw Object.assign(new Error('event expired'), { status: 410 })
      }

      const [membership] = await tx
        .select()
        .from(eventMembers)
        .where(and(eq(eventMembers.eventId, eventId), eq(eventMembers.userId, user.id)))
      if (!membership) throw Object.assign(new Error('forbidden'), { status: 403 })

      // Lock the parent event row to serialize cap checks.
      await tx.execute(sql`SELECT 1 FROM events WHERE id = ${eventId} FOR UPDATE`)

      const count = await countActivePhotos(eventId, tx)
      if (count >= MAX_PHOTOS_PER_EVENT) {
        throw Object.assign(new Error('event cap reached'), { status: 429 })
      }

      const [row] = await tx
        .insert(photos)
        .values({
          eventId,
          uploaderUserId: user.id,
          processingState: 'pending',
          pendingExpiresAt: new Date(Date.now() + PENDING_TTL_MS),
          pendingKey: '',
          declaredMimeType: mimeType,
          declaredSizeBytes: sizeBytes,
          originalFilename: filename,
        })
        .returning({ id: photos.id })
      const id = row.id
      const key = pendingKey(eventId, id)
      await tx.update(photos).set({ pendingKey: key }).where(eq(photos.id, id))
      return id
    })
    .catch((e: unknown) => {
      if (typeof e === 'object' && e !== null && 'status' in e) {
        return e as { status: number; message: string }
      }
      throw e
    })

  if (typeof photoId !== 'string') {
    return NextResponse.json({ error: photoId.message }, { status: photoId.status })
  }

  const putUrl = await createPresignedPutUrl(
    pendingKey(eventId, photoId),
    'application/octet-stream',
    PUT_URL_TTL_SECONDS,
  )

  return NextResponse.json({ photoId, putUrl })
}
