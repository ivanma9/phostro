import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { getMatchMaxDistance } from '@/lib/worker/thresholds'

export type YouFeedItem = {
  photoId: string
  r2KeyPreview: string
  takenAt: Date | null
  distance: number
}

type YouFeedRow = {
  photo_id: string
  r2_key_preview: string
  taken_at: Date | string | null
  distance: number | string
}

export async function listYouFeed(
  eventId: string,
  ownerEmbedding: number[],
): Promise<YouFeedItem[]> {
  const embeddingLiteral = `[${ownerEmbedding.join(',')}]`

  const rows = Array.from(
    (await db.execute(sql`
      SELECT p.id AS photo_id,
             p.r2_key_preview,
             p.taken_at,
             MIN(fd.embedding <=> ${embeddingLiteral}::vector) AS distance
      FROM photos p
      JOIN face_detections fd ON fd.photo_id = p.id
      WHERE p.event_id = ${eventId}
        AND p.processing_state = 'ready'
        AND p.deleted_at IS NULL
      GROUP BY p.id, p.r2_key_preview, p.taken_at
      HAVING MIN(fd.embedding <=> ${embeddingLiteral}::vector) < ${getMatchMaxDistance()}
      ORDER BY p.taken_at DESC NULLS LAST, p.id ASC
    `)) as unknown as YouFeedRow[],
  )

  return rows.map((row) => ({
    photoId: row.photo_id,
    r2KeyPreview: row.r2_key_preview,
    takenAt:
      row.taken_at instanceof Date ? row.taken_at : row.taken_at ? new Date(row.taken_at) : null,
    distance: typeof row.distance === 'string' ? parseFloat(row.distance) : row.distance,
  }))
}
