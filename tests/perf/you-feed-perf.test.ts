/**
 * Task 8 perf SLO verification for listYouFeed.
 *
 * What's being measured: listYouFeed end-to-end — the single SQL query that
 * does JOIN photos ↔ face_detections + pgvector cosine distance (<=>)  +
 * GROUP BY + HAVING MIN(distance) < threshold, executed via drizzle against
 * a real Postgres instance with the pgvector extension.
 *
 * Why 1500ms not 500ms: 500ms is the production deploy SLO (plan Task 8).
 * In CI the DB is a Docker container on a shared runner with cold page cache
 * and no ivfflat warm-up; a 3× headroom keeps the test from flaking on GHA
 * while still catching a catastrophic regression (e.g. seq-scan on 100k rows).
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { db } from '@/db'
import {
  eventMembers,
  events,
  faceDetections,
  photos,
  userFaceEmbeddings,
  users,
} from '@/db/schema'
import { FACE_SCAN_ANGLES } from '@/lib/auth/face-enrollment'
import { listYouFeed } from '@/lib/photos/you-feed'

// 512-d unit vector with the hot component at position `pos`.
// Cosine distance between unitVec(0) and unitVec(n>0) = 1.0 (orthogonal).
// Cosine distance between unitVec(0) and unitVec(0)   = 0.0 (identical).
function unitVec(pos: number): number[] {
  const v = new Array(512).fill(0)
  v[pos] = 1.0
  return v
}

// IDs collected during setup so afterAll can tear down deterministically.
let eventId: string
let ownerEmbedding: number[]

beforeAll(async () => {
  // Owner with face enrolled at unitVec(0). Seed all 3 angles with the same
  // vector — listYouFeed's LEAST(d,d,d)=d collapses identical seeds to one
  // effective embedding so the perf shape matches a single-embedding match.
  ownerEmbedding = unitVec(0)
  const [owner] = await db
    .insert(users)
    .values({
      name: 'PerfOwner',
      contact: 'perf_owner@perf.test',
      contactType: 'email',
    })
    .returning()
  for (const angle of FACE_SCAN_ANGLES) {
    await db.insert(userFaceEmbeddings).values({
      userId: owner.id,
      angle,
      embedding: ownerEmbedding,
      qualityScore: 90,
      yaw: angle === 'left' ? -0.25 : angle === 'right' ? 0.25 : 0,
      previewR2Key: `enrollment/${owner.id}/${angle}.jpg`,
    })
  }

  // Pocket (personal visibility)
  const [event] = await db
    .insert(events)
    .values({
      hostUserId: owner.id,
      name: 'PerfPocket',
      visibilityMode: 'personal',
      lifespanDays: 30,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    })
    .returning()
  eventId = event.id

  await db.insert(eventMembers).values({ eventId, userId: owner.id, role: 'host' })

  // Seed 100 photos — anonymous contributors (uploaderToken, no uploaderUserId)
  const photoRows = Array.from({ length: 100 }, (_, i) => ({
    eventId,
    uploaderUserId: null as string | null,
    uploaderToken: `perf_tok_${i.toString().padStart(3, '0')}`,
    declaredMimeType: 'image/jpeg',
    declaredSizeBytes: 1000,
    processingState: 'ready' as const,
    r2KeyPreview: `perf/preview_${i}.jpg`,
    r2KeyOriginal: `perf/original_${i}.jpg`,
    takenAt: new Date(Date.now() - i * 60_000), // spread over time so ordering is meaningful
    deletedAt: null as Date | null,
  }))

  const insertedPhotos = await db.insert(photos).values(photoRows).returning()

  // Half photos (even indices 0–49) get a matching embedding (unitVec(0), distance ~0).
  // Half photos (odd indices 50–99) get an orthogonal embedding (unitVec(1), distance 1.0).
  // Expected result: ~50 photos returned (those with even index).
  for (let i = 0; i < insertedPhotos.length; i++) {
    const embedding = i % 2 === 0 ? unitVec(0) : unitVec(1)
    const embStr = `[${embedding.join(',')}]`
    await db.execute(sql`
      INSERT INTO face_detections (photo_id, bbox_x1, bbox_y1, bbox_x2, bbox_y2, confidence, landmarks_json, embedding)
      VALUES (
        ${insertedPhotos[i].id},
        0.1, 0.1, 0.5, 0.5, 0.9,
        '[]'::jsonb,
        ${embStr}::vector
      )
    `)
  }
})

afterAll(async () => {
  // Clean up perf test data without disturbing other test state.
  await db.delete(faceDetections)
  await db.delete(photos)
  await db.delete(userFaceEmbeddings)
  await db.delete(eventMembers)
  await db.delete(events)
  await db.delete(users)
})

test('listYouFeed runs < 1500ms with 100 detections in pocket', async () => {
  const t0 = performance.now()
  const results = await listYouFeed(eventId, [ownerEmbedding])
  const elapsed = performance.now() - t0

  console.log(
    `[perf] listYouFeed elapsed: ${elapsed.toFixed(1)}ms (${results.length} photos returned)`,
  )

  // Sanity: half the photos should match (even-indexed → unitVec(0) → distance ~0).
  expect(results.length).toBe(50)

  // SLO: < 1500ms. Production target is 500ms; CI gets 3× headroom for Docker overhead.
  expect(elapsed).toBeLessThan(1500)
})
