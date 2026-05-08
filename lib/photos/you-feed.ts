// Pocket v0 Task 8 decision: filter runs as SQL in Next.js, NOT as a worker call.
// Rationale: pgvector cosine distance with the existing ivfflat index is fast enough
// at v0 scale. A worker round-trip per page load (HTTP + JSON encode/decode + presigned
// URL minting) adds ~300ms+ for no compute benefit.
//
// v1 multi-angle update: ownerEmbeddings is an array (one per enrolled angle).
// We compute distance as MIN(LEAST(<=> emb_1, <=> emb_2, <=> emb_3)) per photo.
// pgvector does NOT register a working vector[] array type, so unnest(::vector[])
// is not viable; LEAST over N parameterized literals is the correct shape. The
// IVFFlat index is bypassed by the LEAST aggregation — acceptable at v0/v1 scale
// (perf budget < 1500ms with 100 detections; the WHERE clause bounds row count
// to a single event's photos).

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

function toLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`
}

export async function listYouFeed(
  eventId: string,
  ownerEmbeddings: number[][],
): Promise<YouFeedItem[]> {
  if (ownerEmbeddings.length === 0) return []

  // Pad/truncate to exactly 3 entries — the SQL is shaped for 3 angles.
  // LEAST(d, d, d) = d, so duplicating the first embedding when fewer than 3
  // are enrolled is idempotent and lets a partial enrollment still match.
  const filled =
    ownerEmbeddings.length >= 3
      ? ownerEmbeddings.slice(0, 3)
      : [
          ownerEmbeddings[0],
          ownerEmbeddings[1] ?? ownerEmbeddings[0],
          ownerEmbeddings[2] ?? ownerEmbeddings[1] ?? ownerEmbeddings[0],
        ]
  const [l1, l2, l3] = filled.map(toLiteral)

  const threshold = getMatchMaxDistance()

  const rows = Array.from(
    (await db.execute(sql`
      SELECT p.id AS photo_id,
             p.r2_key_preview,
             p.taken_at,
             MIN(LEAST(
               fd.embedding <=> ${l1}::vector,
               fd.embedding <=> ${l2}::vector,
               fd.embedding <=> ${l3}::vector
             )) AS distance
      FROM photos p
      JOIN face_detections fd ON fd.photo_id = p.id
      WHERE p.event_id = ${eventId}
        AND p.processing_state = 'ready'
        AND p.deleted_at IS NULL
      GROUP BY p.id, p.r2_key_preview, p.taken_at
      HAVING MIN(LEAST(
               fd.embedding <=> ${l1}::vector,
               fd.embedding <=> ${l2}::vector,
               fd.embedding <=> ${l3}::vector
             )) < ${threshold}
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
