import { and, desc, eq, isNull } from 'drizzle-orm'
import { db } from '@/db'
import { photos } from '@/db/schema'
import { createPresignedGetUrl } from './r2'

const PREVIEW_URL_TTL_SECONDS = 5 * 60

export type GalleryPhoto = {
  id: string
  previewUrl: string
  width: number | null
  height: number | null
  takenAt: Date | null
  createdAt: Date
}

export async function listMyPhotos(eventId: string, userId: string): Promise<GalleryPhoto[]> {
  const rows = await db
    .select()
    .from(photos)
    .where(
      and(
        eq(photos.eventId, eventId),
        eq(photos.uploaderUserId, userId),
        eq(photos.processingState, 'ready'),
        isNull(photos.deletedAt),
      ),
    )
    .orderBy(desc(photos.takenAt), desc(photos.createdAt))

  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      previewUrl: await createPresignedGetUrl(row.r2KeyPreview!, PREVIEW_URL_TTL_SECONDS),
      width: row.width,
      height: row.height,
      takenAt: row.takenAt,
      createdAt: row.createdAt,
    })),
  )
}
