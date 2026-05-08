import { sql } from 'drizzle-orm'
import { beforeEach, expect, test, vi } from 'vitest'
import { GET } from '@/app/api/pockets/[id]/you/route'
import { db } from '@/db'
import {
  eventMembers,
  events,
  faceDetectionsV2,
  photos,
  userFaceEmbeddings,
  users,
} from '@/db/schema'
import { FACE_SCAN_ANGLES } from '@/lib/auth/face-enrollment'
import * as currentUser from '@/lib/auth/current-user'

// 512-d unit vectors for filter correctness tests
function unitVec(pos: number): number[] {
  const v = new Array(512).fill(0)
  v[pos] = 1.0
  return v
}

beforeEach(async () => {
  await db.delete(faceDetectionsV2)
  await db.delete(photos)
  await db.delete(eventMembers)
  await db.delete(events)
  await db.delete(userFaceEmbeddings)
  await db.delete(users)
  vi.restoreAllMocks()
})

// When `faceEmbedding` is provided we seed all 3 angles with that vector so the
// user passes the enrolled-3-of-3 gate. The matching SQL takes MIN(LEAST(d,d,d))
// across angles → identical seeds collapse to one effective embedding for tests.
async function seedUser(suffix: string, faceEmbedding?: number[]) {
  const [u] = await db
    .insert(users)
    .values({
      name: `U-${suffix}`,
      contact: `you_feed_${suffix}@x.com`,
      contactType: 'email',
    })
    .returning()
  if (faceEmbedding) {
    for (const angle of FACE_SCAN_ANGLES) {
      await db.insert(userFaceEmbeddings).values({
        userId: u.id,
        angle,
        embedding: faceEmbedding,
        qualityScore: 90,
        yaw: angle === 'left' ? -0.25 : angle === 'right' ? 0.25 : 0,
        previewR2Key: `enrollment/${u.id}/${angle}.jpg`,
      })
    }
  }
  return u
}

async function seedPocket(hostId: string, suffix: string) {
  const [e] = await db
    .insert(events)
    .values({
      hostUserId: hostId,
      name: `Pocket-${suffix}`,
      visibilityMode: 'personal',
      lifespanDays: 30,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    })
    .returning()
  await db.insert(eventMembers).values({ eventId: e.id, userId: hostId, role: 'host' })
  return e
}

async function seedPhoto(
  eventId: string,
  opts: {
    state?: 'pending' | 'processing' | 'ready' | 'failed'
    takenAt?: Date | null
    deletedAt?: Date | null
    uploaderUserId?: string
  } = {},
) {
  const state = opts.state ?? 'ready'
  // photos require exactly one of uploaderUserId or uploaderToken
  const uploaderToken = opts.uploaderUserId
    ? undefined
    : `tok_${Math.random().toString(36).slice(2)}`
  const [p] = await db
    .insert(photos)
    .values({
      eventId,
      uploaderUserId: opts.uploaderUserId ?? null,
      uploaderToken: uploaderToken ?? null,
      declaredMimeType: 'image/jpeg',
      declaredSizeBytes: 1000,
      processingState: state,
      r2KeyPreview: `preview/${Math.random().toString(36).slice(2)}.jpg`,
      r2KeyOriginal: `original/${Math.random().toString(36).slice(2)}.jpg`,
      takenAt: opts.takenAt !== undefined ? opts.takenAt : new Date('2024-01-01T10:00:00Z'),
      deletedAt: opts.deletedAt ?? null,
    })
    .returning()
  return p
}

async function seedDetection(photoId: string, embedding: number[]) {
  await db.execute(sql`
    INSERT INTO face_detections_v2 (photo_id, bbox_x1, bbox_y1, bbox_x2, bbox_y2, confidence, landmarks_json, embedding, yaw)
    VALUES (
      ${photoId},
      0.1, 0.1, 0.5, 0.5, 0.9,
      '[]'::jsonb,
      ${`[${embedding.join(',')}]`}::vector,
      0.0
    )
  `)
}

function makeReq(id: string) {
  return new Request(`http://t/api/pockets/${id}/you`)
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) }
}

// Case 1: 401 unauthenticated
test('returns 401 when not authenticated', async () => {
  vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(null)
  const res = await GET(
    makeReq('00000000-0000-0000-0000-000000000001'),
    makeParams('00000000-0000-0000-0000-000000000001'),
  )
  expect(res.status).toBe(401)
})

// Case 2: 404 nonexistent event
test('returns 404 for nonexistent event', async () => {
  const u = await seedUser('404')
  vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(u)
  const res = await GET(
    makeReq('00000000-0000-0000-0000-000000000099'),
    makeParams('00000000-0000-0000-0000-000000000099'),
  )
  expect(res.status).toBe(404)
})

// Case 3: 403 not the host
test('returns 403 when caller is not the host', async () => {
  const owner = await seedUser('owner-403')
  const other = await seedUser('other-403')
  const pocket = await seedPocket(owner.id, '403')
  vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(other)
  const res = await GET(makeReq(pocket.id), makeParams(pocket.id))
  expect(res.status).toBe(403)
})

// Case 4: 412 not enrolled
test('returns 412 with error=not_enrolled when owner has no face_embedding', async () => {
  const owner = await seedUser('owner-412') // no face_embedding
  const pocket = await seedPocket(owner.id, '412')
  vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(owner)
  const res = await GET(makeReq(pocket.id), makeParams(pocket.id))
  expect(res.status).toBe(412)
  const body = await res.json()
  expect(body.error).toBe('not_enrolled')
})

// Case 5: empty feed — owner enrolled, no photos
test('returns empty photos array when no photos exist', async () => {
  const emb = unitVec(0)
  const owner = await seedUser('owner-empty', emb)
  const pocket = await seedPocket(owner.id, 'empty')
  vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(owner)
  const res = await GET(makeReq(pocket.id), makeParams(pocket.id))
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.photos).toEqual([])
})

// Case 6: matching photo surfaces (identical embedding → distance ~0)
test('returns photo when face detection embedding matches owner', async () => {
  const emb = unitVec(0)
  const owner = await seedUser('owner-match', emb)
  const pocket = await seedPocket(owner.id, 'match')
  const photo = await seedPhoto(pocket.id, { state: 'ready' })
  await seedDetection(photo.id, emb) // identical → distance ~0
  vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(owner)
  const res = await GET(makeReq(pocket.id), makeParams(pocket.id))
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.photos).toHaveLength(1)
  expect(body.photos[0].photoId).toBe(photo.id)
  expect(body.photos[0].distance).toBeLessThan(0.01)
  expect(typeof body.photos[0].previewUrl).toBe('string')
})

// Case 7: non-matching photo excluded (orthogonal embedding → distance=1.0 > threshold)
test('excludes photo when face detection embedding is orthogonal to owner', async () => {
  const ownerEmb = unitVec(0)
  const otherEmb = unitVec(1)
  const owner = await seedUser('owner-nonmatch', ownerEmb)
  const pocket = await seedPocket(owner.id, 'nonmatch')
  const photo = await seedPhoto(pocket.id, { state: 'ready' })
  await seedDetection(photo.id, otherEmb) // orthogonal → distance=1.0 >> 0.528
  vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(owner)
  const res = await GET(makeReq(pocket.id), makeParams(pocket.id))
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.photos).toHaveLength(0)
})

// Case 8: photo with no detections excluded (JOIN filters it out)
test('excludes ready photo with zero face detections', async () => {
  const emb = unitVec(0)
  const owner = await seedUser('owner-nodet', emb)
  const pocket = await seedPocket(owner.id, 'nodet')
  await seedPhoto(pocket.id, { state: 'ready' }) // no detection seeded
  vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(owner)
  const res = await GET(makeReq(pocket.id), makeParams(pocket.id))
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.photos).toHaveLength(0)
})

// Case 9: pending photo excluded
test('excludes photo in pending processing_state even with matching detection', async () => {
  const emb = unitVec(0)
  const owner = await seedUser('owner-pending', emb)
  const pocket = await seedPocket(owner.id, 'pending')
  const photo = await seedPhoto(pocket.id, { state: 'pending' })
  await seedDetection(photo.id, emb) // matching but photo not ready
  vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(owner)
  const res = await GET(makeReq(pocket.id), makeParams(pocket.id))
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.photos).toHaveLength(0)
})

// Case 10: soft-deleted photo excluded
test('excludes soft-deleted photo even with matching detection', async () => {
  const emb = unitVec(0)
  const owner = await seedUser('owner-deleted', emb)
  const pocket = await seedPocket(owner.id, 'deleted')
  const photo = await seedPhoto(pocket.id, { state: 'ready', deletedAt: new Date() })
  await seedDetection(photo.id, emb)
  vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(owner)
  const res = await GET(makeReq(pocket.id), makeParams(pocket.id))
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.photos).toHaveLength(0)
})

// Case 11: multiple detections, MIN wins — returned exactly once with smallest distance
test('returns photo exactly once with MIN distance when multiple detections exist', async () => {
  const ownerEmb = unitVec(0) // match
  const nonMatchEmb = unitVec(1) // orthogonal, distance=1.0
  const owner = await seedUser('owner-multi', ownerEmb)
  const pocket = await seedPocket(owner.id, 'multi')
  const photo = await seedPhoto(pocket.id, { state: 'ready' })
  await seedDetection(photo.id, ownerEmb) // matches
  await seedDetection(photo.id, nonMatchEmb) // doesn't match
  vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(owner)
  const res = await GET(makeReq(pocket.id), makeParams(pocket.id))
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.photos).toHaveLength(1) // exactly once
  expect(body.photos[0].photoId).toBe(photo.id)
  expect(body.photos[0].distance).toBeLessThan(0.01) // the MIN (matching) distance
})

// Case 12: ordering by takenAt DESC NULLS LAST, then id ASC
test('orders photos by takenAt DESC NULLS LAST then id ASC', async () => {
  const emb = unitVec(0)
  const owner = await seedUser('owner-order', emb)
  const pocket = await seedPocket(owner.id, 'order')

  // Insert in non-chronological order to verify sort
  const photoA = await seedPhoto(pocket.id, { state: 'ready', takenAt: new Date('2024-01-01') })
  const photoB = await seedPhoto(pocket.id, { state: 'ready', takenAt: new Date('2024-01-03') })
  const photoC = await seedPhoto(pocket.id, { state: 'ready', takenAt: null }) // NULLS LAST

  await seedDetection(photoA.id, emb)
  await seedDetection(photoB.id, emb)
  await seedDetection(photoC.id, emb)

  vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(owner)
  const res = await GET(makeReq(pocket.id), makeParams(pocket.id))
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.photos).toHaveLength(3)
  // DESC: B(Jan 3), A(Jan 1), C(null last)
  expect(body.photos[0].photoId).toBe(photoB.id)
  expect(body.photos[1].photoId).toBe(photoA.id)
  expect(body.photos[2].photoId).toBe(photoC.id)
})
