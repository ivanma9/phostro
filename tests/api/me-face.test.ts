import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { POST } from '@/app/api/me/face/route'
import { db } from '@/db'
import { users } from '@/db/schema'
import * as currentUser from '@/lib/auth/current-user'
import type { DetectResponse } from '@/lib/worker/client'

const FIX = join(__dirname, '../fixtures/photos')

const store = new Map<string, Buffer>()

vi.mock('@/lib/photos/r2', () => ({
  createPresignedGetUrl: vi.fn(async (key: string) => `https://fake.r2/${key}?signature=x`),
  headObject: vi.fn(async (key: string) =>
    store.has(key) ? { contentLength: store.get(key)?.length } : null,
  ),
  getObjectBuffer: vi.fn(async (key: string) => {
    const b = store.get(key)
    if (!b) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' })
    return b
  }),
  putObject: vi.fn(async (key: string, body: Buffer) => {
    store.set(key, body)
  }),
  deleteObject: vi.fn(async (key: string) => {
    store.delete(key)
  }),
}))

vi.mock('@/lib/worker/client', () => ({
  detectPhoto: vi.fn(),
}))

// Import after mocks are set up
const workerClient = await import('@/lib/worker/client')
const detectPhotoMock = vi.mocked(workerClient.detectPhoto)

// Helper: build a 128-float embedding filled with a given value
function makeEmbedding(value: number): number[] {
  return Array.from({ length: 128 }, () => value)
}

// Helper: build a DetectResponse with given faces (confidence, embedding)
function makeDetectResponse(
  faces: Array<{ confidence: number; embedding?: number[] }>,
): DetectResponse {
  return {
    photo_id: 'test-uuid',
    faces: faces.map((f) => ({
      confidence: f.confidence,
      embedding: f.embedding ?? makeEmbedding(0.5),
      bbox_x1: 0.1,
      bbox_y1: 0.1,
      bbox_x2: 0.4,
      bbox_y2: 0.5,
      landmarks: [[0, 0]],
    })),
    elapsed_ms: 10,
  }
}

async function seed() {
  const [user] = await db
    .insert(users)
    .values({ name: 'Owner', contact: 'owner@x.com', contactType: 'email' })
    .returning()
  return user
}

function makeJpegRequest(jpegBuffer: Buffer): Request {
  const formData = new FormData()
  const blob = new Blob([jpegBuffer], { type: 'image/jpeg' })
  formData.append('file', blob, 'selfie.jpg')
  return new Request('http://t/api/me/face', { method: 'POST', body: formData })
}

beforeEach(async () => {
  store.clear()
  await db.delete(users)
  vi.restoreAllMocks()
  detectPhotoMock.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('POST /api/me/face', () => {
  test('401 when not signed in', async () => {
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(null)
    const jpegBuf = readFileSync(join(FIX, 'plain.jpg'))
    const res = await POST(makeJpegRequest(jpegBuf))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('unauthenticated')
  })

  test('single-face success: writes embedding, quality, enrolled_at; returns quality', async () => {
    const user = await seed()
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(user)

    const embedding = makeEmbedding(0.1)
    detectPhotoMock.mockResolvedValue(makeDetectResponse([{ confidence: 0.97, embedding }]))

    const jpegBuf = readFileSync(join(FIX, 'plain.jpg'))
    const res = await POST(makeJpegRequest(jpegBuf))
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.quality).toBe(97)

    const [row] = await db.select().from(users).where(eq(users.id, user.id))
    expect(row.faceEmbedding).not.toBeNull()
    expect(row.faceEmbedding).toHaveLength(128)
    expect(row.faceQualityScore).toBe(97)
    expect(row.faceEnrolledAt).not.toBeNull()
    // enrolled within last 5 seconds
    expect(Date.now() - row.faceEnrolledAt!.getTime()).toBeLessThan(5000)
  })

  test('multiple faces rejection: 400 multiple_faces, no embedding written', async () => {
    const user = await seed()
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(user)

    detectPhotoMock.mockResolvedValue(
      makeDetectResponse([
        { confidence: 0.95, embedding: makeEmbedding(0.9) },
        { confidence: 0.91, embedding: makeEmbedding(0.8) },
      ]),
    )

    const jpegBuf = readFileSync(join(FIX, 'plain.jpg'))
    const res = await POST(makeJpegRequest(jpegBuf))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('multiple_faces')

    const [row] = await db.select().from(users).where(eq(users.id, user.id))
    expect(row.faceEmbedding).toBeNull()
    expect(row.faceQualityScore).toBeNull()
    expect(row.faceEnrolledAt).toBeNull()
  })

  test('no face / empty faces array: 400 no_face, no embedding written', async () => {
    const user = await seed()
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(user)

    detectPhotoMock.mockResolvedValue(makeDetectResponse([]))

    const jpegBuf = readFileSync(join(FIX, 'plain.jpg'))
    const res = await POST(makeJpegRequest(jpegBuf))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('no_face')

    const [row] = await db.select().from(users).where(eq(users.id, user.id))
    expect(row.faceEmbedding).toBeNull()
  })

  test('single face below confidence threshold: 400 no_face', async () => {
    const user = await seed()
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(user)

    detectPhotoMock.mockResolvedValue(
      makeDetectResponse([{ confidence: 0.85, embedding: makeEmbedding(0.5) }]),
    )

    const jpegBuf = readFileSync(join(FIX, 'plain.jpg'))
    const res = await POST(makeJpegRequest(jpegBuf))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('no_face')

    const [row] = await db.select().from(users).where(eq(users.id, user.id))
    expect(row.faceEmbedding).toBeNull()
  })

  test('re-enrollment: second POST overwrites first embedding', async () => {
    const user = await seed()
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(user)

    const embedding1 = makeEmbedding(0.1)
    detectPhotoMock.mockResolvedValue(makeDetectResponse([{ confidence: 0.97, embedding: embedding1 }]))

    const jpegBuf = readFileSync(join(FIX, 'plain.jpg'))
    const res1 = await POST(makeJpegRequest(jpegBuf))
    expect(res1.status).toBe(200)

    const [row1] = await db.select().from(users).where(eq(users.id, user.id))
    const enrolledAt1 = row1.faceEnrolledAt

    // Small delay to ensure timestamps differ
    await new Promise((r) => setTimeout(r, 5))

    const embedding2 = makeEmbedding(0.2)
    detectPhotoMock.mockResolvedValue(makeDetectResponse([{ confidence: 0.92, embedding: embedding2 }]))

    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(user)
    const res2 = await POST(makeJpegRequest(jpegBuf))
    expect(res2.status).toBe(200)
    const body2 = await res2.json()
    expect(body2.quality).toBe(92)

    const [row2] = await db.select().from(users).where(eq(users.id, user.id))
    expect(row2.faceEmbedding).not.toBeNull()
    // Embedding values should be the second one (all 0.2)
    expect(row2.faceEmbedding![0]).toBeCloseTo(0.2, 5)
    expect(row2.faceQualityScore).toBe(92)
    // enrolled_at should have been updated
    expect(row2.faceEnrolledAt!.getTime()).toBeGreaterThanOrEqual(enrolledAt1!.getTime())
  })

  // Decision: one-high + one-low confidence → REJECT with multiple_faces.
  // Rationale: faces.length > 1 means multiple people are detectable in the
  // frame, regardless of confidence levels. The plan explicitly says "do not
  // pick highest-confidence from a group selfie." A low-confidence face is still
  // evidence of another person in the frame. We reject any frame with >1 face
  // detected at any confidence.
  test('one high + one low confidence face: 400 multiple_faces (any multi-face frame rejected)', async () => {
    const user = await seed()
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(user)

    detectPhotoMock.mockResolvedValue(
      makeDetectResponse([
        { confidence: 0.95, embedding: makeEmbedding(0.9) },
        { confidence: 0.5, embedding: makeEmbedding(0.3) },
      ]),
    )

    const jpegBuf = readFileSync(join(FIX, 'plain.jpg'))
    const res = await POST(makeJpegRequest(jpegBuf))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('multiple_faces')

    const [row] = await db.select().from(users).where(eq(users.id, user.id))
    expect(row.faceEmbedding).toBeNull()
  })

  test('invalid file: no file in form-data returns 400', async () => {
    const user = await seed()
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(user)

    const formData = new FormData()
    // No file appended
    const req = new Request('http://t/api/me/face', { method: 'POST', body: formData })
    const res = await POST(req)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('invalid_file')
  })

  test('wrong mime type returns 400 invalid_file', async () => {
    const user = await seed()
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(user)

    const formData = new FormData()
    const blob = new Blob([Buffer.from('fake pdf data')], { type: 'application/pdf' })
    formData.append('file', blob, 'selfie.pdf')
    const req = new Request('http://t/api/me/face', { method: 'POST', body: formData })
    const res = await POST(req)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('invalid_file')
  })

  test('file too large returns 400 too_large', async () => {
    const user = await seed()
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(user)

    // 11 MB, over the 10 MB limit
    const bigBuffer = Buffer.alloc(11 * 1024 * 1024, 0xff)
    const formData = new FormData()
    const blob = new Blob([bigBuffer], { type: 'image/jpeg' })
    formData.append('file', blob, 'big.jpg')
    const req = new Request('http://t/api/me/face', { method: 'POST', body: formData })
    const res = await POST(req)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('too_large')
  })

  // Fix #2: ImageProcessError → invalid_file mapping.
  // Passes mime + size checks but fails Sharp decode — same collapse as other input-shape failures.
  test('corrupt jpeg (valid mime, garbage bytes): 400 invalid_file', async () => {
    const user = await seed()
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(user)

    const garbageBuf = Buffer.from('not-a-jpeg-just-text')
    const res = await POST(makeJpegRequest(garbageBuf))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('invalid_file')
  })

  // Fix #3: detectPhoto throws → 503 worker_unavailable.
  test('detectPhoto throws: 503 worker_unavailable', async () => {
    const user = await seed()
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(user)

    detectPhotoMock.mockRejectedValue(new Error('connection refused'))

    const jpegBuf = readFileSync(join(FIX, 'plain.jpg'))
    const res = await POST(makeJpegRequest(jpegBuf))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error).toBe('worker_unavailable')
  })
})
