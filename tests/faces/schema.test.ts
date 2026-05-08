import { sql } from 'drizzle-orm'
import { beforeEach, expect, test } from 'vitest'
import { db } from '@/db'
import { eventMembers, events, faceClusters, faceDetections, photos, users } from '@/db/schema'

async function seedFixtures() {
  const [u] = await db
    .insert(users)
    .values({ name: 'U', contact: 'u_faces@x.com', contactType: 'email' })
    .returning()
  const [e] = await db
    .insert(events)
    .values({
      hostUserId: u.id,
      name: 'E',
      expiresAt: new Date(Date.now() + 86400 * 1000),
    })
    .returning()
  await db.insert(eventMembers).values({ eventId: e.id, userId: u.id, role: 'host' })
  const [p] = await db
    .insert(photos)
    .values({
      eventId: e.id,
      uploaderUserId: u.id,
      declaredMimeType: 'image/jpeg',
      declaredSizeBytes: 1000,
    })
    .returning()
  return { u, e, p }
}

beforeEach(async () => {
  await db.delete(faceDetections)
  await db.delete(faceClusters)
  await db.delete(photos)
  await db.delete(eventMembers)
  await db.delete(events)
  await db.delete(users)
})

const DIM = 512
const makeEmbedding = (len: number) => Array.from({ length: len }, (_, i) => i / len)

test('round-trip: insert face_clusters + face_detections with 512-d embedding and linked cluster_id', async () => {
  const { e, p } = await seedFixtures()
  const embedding = makeEmbedding(DIM)

  const [cluster] = await db
    .insert(faceClusters)
    .values({
      eventId: e.id,
      representativeEmbedding: embedding,
    })
    .returning()

  const [det] = await db
    .insert(faceDetections)
    .values({
      photoId: p.id,
      bboxX1: 0.1,
      bboxY1: 0.1,
      bboxX2: 0.3,
      bboxY2: 0.3,
      confidence: 0.95,
      landmarksJson: [
        [1, 2],
        [3, 4],
        [5, 6],
        [7, 8],
        [9, 10],
      ],
      embedding,
      clusterId: cluster.id,
    })
    .returning()

  expect(det.embedding).toHaveLength(DIM)
  expect(det.clusterId).toBe(cluster.id)

  // Fetch back and verify embedding round-trips correctly
  const rows = await db.select().from(faceDetections).where(sql`id = ${det.id}`)
  expect(rows).toHaveLength(1)
  expect(rows[0].embedding).toHaveLength(DIM)
  for (let i = 0; i < DIM; i++) {
    expect(rows[0].embedding[i]).toBeCloseTo(i / DIM, 6)
  }
})

test('pgvector rejects embedding with wrong dimension (511 floats)', async () => {
  const { p } = await seedFixtures()
  const badEmbedding = makeEmbedding(511)

  await expect(
    db.insert(faceDetections).values({
      photoId: p.id,
      bboxX1: 0.1,
      bboxY1: 0.1,
      bboxX2: 0.3,
      bboxY2: 0.3,
      confidence: 0.95,
      landmarksJson: [
        [1, 2],
        [3, 4],
        [5, 6],
        [7, 8],
        [9, 10],
      ],
      embedding: badEmbedding,
    }),
  ).rejects.toThrow()
})
