import { beforeEach, expect, test, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { eventMembers, events, faceDetections, photoJobs, photos, users } from '@/db/schema'

// Mock the worker client so we don't make real HTTP calls
vi.mock('@/lib/worker/client', () => ({
  detectPhoto: vi.fn(),
}))

// Partial mock for complete module — markSucceeded and markFailed can be
// intercepted (D6 verifies markFailed is NOT called on the race-loss path).
vi.mock('@/lib/jobs/complete', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/jobs/complete')>()
  return {
    ...real,
    markSucceeded: vi.fn(real.markSucceeded),
    markFailed: vi.fn(real.markFailed),
  }
})

// Seed fixtures for u_dispatch@x.com
async function seedFixtures(opts?: {
  processingState?: 'pending' | 'processing' | 'ready' | 'failed'
  r2KeyPreview?: string | null
}) {
  const state = opts?.processingState ?? 'ready'
  const preview = opts?.r2KeyPreview !== undefined ? opts.r2KeyPreview : 'events/E/preview/P.jpg'

  const [u] = await db
    .insert(users)
    .values({ name: 'U', contact: 'u_dispatch@x.com', contactType: 'email' })
    .returning()

  const [e] = await db
    .insert(events)
    .values({ hostUserId: u.id, name: 'E', expiresAt: new Date(Date.now() + 86400_000) })
    .returning()

  await db.insert(eventMembers).values({ eventId: e.id, userId: u.id, role: 'host' })

  const [p] = await db
    .insert(photos)
    .values({
      eventId: e.id,
      uploaderUserId: u.id,
      declaredMimeType: 'image/jpeg',
      declaredSizeBytes: 1000,
      processingState: state,
      r2KeyPreview: preview,
    })
    .returning()

  return { u, e, p }
}

async function insertQueuedJob(photoId: string) {
  const [job] = await db
    .insert(photoJobs)
    .values({ photoId, kind: 'detect', state: 'queued' })
    .returning()
  return job
}

const CANNED_FACES = [
  {
    bbox_x1: 0.1,
    bbox_y1: 0.2,
    bbox_x2: 0.5,
    bbox_y2: 0.7,
    confidence: 0.95,
    landmarks: [
      [0.2, 0.3],
      [0.4, 0.3],
      [0.3, 0.5],
      [0.2, 0.6],
      [0.4, 0.6],
    ],
    embedding: Array.from({ length: 512 }, (_, i) => i / 512),
    yaw: 0.0,
  },
]

beforeEach(async () => {
  await db.delete(faceDetections)
  await db.delete(photoJobs)
  await db.delete(photos)
  await db.delete(eventMembers)
  await db.delete(events)
  await db.delete(users)

  // Reset client mock
  const { detectPhoto } = await import('@/lib/worker/client')
  vi.mocked(detectPhoto).mockReset()

  // Reset markSucceeded + markFailed back to call-through to real implementations
  const { markSucceeded, markFailed } = await import('@/lib/jobs/complete')
  const real = await vi.importActual<typeof import('@/lib/jobs/complete')>('@/lib/jobs/complete')
  vi.mocked(markSucceeded).mockImplementation(real.markSucceeded)
  vi.mocked(markFailed).mockImplementation(real.markFailed)
})

// D1: Happy path — canned faces, rows inserted, has_detected_faces=true, job succeeded
test('D1: processOneJob inserts face_detections, sets has_detected_faces=true, job=succeeded', async () => {
  const { p } = await seedFixtures()
  await insertQueuedJob(p.id)

  const { detectPhoto } = await import('@/lib/worker/client')
  vi.mocked(detectPhoto).mockResolvedValueOnce({
    photo_id: p.id,
    faces: CANNED_FACES,
    elapsed_ms: 50,
  })

  const { processOneJob } = await import('@/lib/worker/dispatcher')
  const result = await processOneJob('worker-1')

  expect(result).not.toBeNull()

  // face_detections rows
  const detections = await db
    .select()
    .from(faceDetections)
    .where(eq(faceDetections.photoId, p.id))

  expect(detections).toHaveLength(1)
  expect(detections[0].bboxX1).toBeCloseTo(0.1)
  expect(detections[0].bboxY1).toBeCloseTo(0.2)
  expect(detections[0].bboxX2).toBeCloseTo(0.5)
  expect(detections[0].bboxY2).toBeCloseTo(0.7)
  expect(detections[0].confidence).toBeCloseTo(0.95)
  expect(detections[0].embedding).toHaveLength(512)

  // photos.has_detected_faces = true
  const [photo] = await db.select().from(photos).where(eq(photos.id, p.id))
  expect(photo.hasDetectedFaces).toBe(true)

  // photo_jobs state = succeeded
  const [job] = await db.select().from(photoJobs).where(eq(photoJobs.photoId, p.id))
  expect(job.state).toBe('succeeded')
})

// D2: No faces detected — zero rows, has_detected_faces=false, job succeeded
test('D2: processOneJob with empty faces sets has_detected_faces=false, zero detections, job=succeeded', async () => {
  const { p } = await seedFixtures()
  await insertQueuedJob(p.id)

  const { detectPhoto } = await import('@/lib/worker/client')
  vi.mocked(detectPhoto).mockResolvedValueOnce({
    photo_id: p.id,
    faces: [],
    elapsed_ms: 20,
  })

  const { processOneJob } = await import('@/lib/worker/dispatcher')
  await processOneJob('worker-1')

  const detections = await db
    .select()
    .from(faceDetections)
    .where(eq(faceDetections.photoId, p.id))
  expect(detections).toHaveLength(0)

  const [photo] = await db.select().from(photos).where(eq(photos.id, p.id))
  expect(photo.hasDetectedFaces).toBe(false)

  const [job] = await db.select().from(photoJobs).where(eq(photoJobs.photoId, p.id))
  expect(job.state).toBe('succeeded')
})

// D3: Defensive check — photo state != 'ready' (e.g., 'processing')
test('D3: processOneJob marks job failed with photo_not_ready when photo state is not ready', async () => {
  const { p } = await seedFixtures({ processingState: 'processing' })
  const job = await insertQueuedJob(p.id)

  const { detectPhoto } = await import('@/lib/worker/client')

  const { processOneJob } = await import('@/lib/worker/dispatcher')
  await processOneJob('worker-1')

  // detectPhoto must NOT have been called
  expect(vi.mocked(detectPhoto)).not.toHaveBeenCalled()

  // No face_detections inserted
  const detections = await db
    .select()
    .from(faceDetections)
    .where(eq(faceDetections.photoId, p.id))
  expect(detections).toHaveLength(0)

  // Job should be marked failed (or retried) with error=photo_not_ready
  const [jobAfter] = await db.select().from(photoJobs).where(eq(photoJobs.id, job.id))
  expect(jobAfter.lastError).toBe('photo_not_ready')
})

// D4: Defensive check — r2_key_preview is null
test('D4: processOneJob marks job failed with photo_not_ready when r2_key_preview is null', async () => {
  const { p } = await seedFixtures({ r2KeyPreview: null })
  const job = await insertQueuedJob(p.id)

  const { detectPhoto } = await import('@/lib/worker/client')

  const { processOneJob } = await import('@/lib/worker/dispatcher')
  await processOneJob('worker-1')

  expect(vi.mocked(detectPhoto)).not.toHaveBeenCalled()

  const detections = await db
    .select()
    .from(faceDetections)
    .where(eq(faceDetections.photoId, p.id))
  expect(detections).toHaveLength(0)

  const [jobAfter] = await db.select().from(photoJobs).where(eq(photoJobs.id, job.id))
  expect(jobAfter.lastError).toBe('photo_not_ready')
})

// D5: Worker call throws — job retried up to max_attempts then dead-lettered
test('D5: processOneJob marks job for retry when detectPhoto throws, dead-letters at max_attempts', async () => {
  const { p } = await seedFixtures()
  const { detectPhoto } = await import('@/lib/worker/client')
  vi.mocked(detectPhoto).mockRejectedValue(new Error('network error'))

  const { processOneJob } = await import('@/lib/worker/dispatcher')

  // Seed a job with attempts < max_attempts (claim will bump attempts to 1)
  await insertQueuedJob(p.id)
  await processOneJob('worker-1')

  // After 1 attempt out of 5 → should be queued (retry)
  const [job1] = await db.select().from(photoJobs).where(eq(photoJobs.photoId, p.id))
  expect(job1.state).toBe('queued')
  expect(job1.lastError).toBe('network error')

  // Now bump attempts to max by re-running until dead-lettered
  // maxAttempts=5: need 4 more claims (already at 1 attempt)
  for (let i = 0; i < 4; i++) {
    await processOneJob('worker-1')
  }

  const [jobFinal] = await db.select().from(photoJobs).where(eq(photoJobs.photoId, p.id))
  expect(jobFinal.state).toBe('failed')
  expect(jobFinal.lastError).toBe('network error')
})

// D6: Race condition — markSucceeded returns null (another worker already succeeded).
// Expected behavior: transaction rolls back (no face_detections committed),
// dispatcher logs worker.dispatch.race_loss, does NOT call markFailed (job stays succeeded).
test('D6: processOneJob handles race loss (markSucceeded returns null) gracefully — no face_detections, race_loss logged', async () => {
  const { p } = await seedFixtures()
  await insertQueuedJob(p.id)

  const { detectPhoto } = await import('@/lib/worker/client')
  vi.mocked(detectPhoto).mockResolvedValueOnce({
    photo_id: p.id,
    faces: CANNED_FACES,
    elapsed_ms: 50,
  })

  // Override markSucceeded to return null (simulates another worker already succeeded)
  const { markSucceeded, markFailed } = await import('@/lib/jobs/complete')
  vi.mocked(markSucceeded).mockResolvedValueOnce(null)
  vi.mocked(markFailed).mockClear()

  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

  const { processOneJob } = await import('@/lib/worker/dispatcher')
  // Should not throw
  await expect(processOneJob('worker-1')).resolves.toBeNull()

  // No face_detections must have been committed (transaction rolled back)
  const detections = await db
    .select()
    .from(faceDetections)
    .where(eq(faceDetections.photoId, p.id))
  expect(detections).toHaveLength(0)

  // worker.dispatch.race_loss must be logged
  const raceLossCalls = warnSpy.mock.calls.filter(
    (args) =>
      args[0] &&
      typeof args[0] === 'object' &&
      (args[0] as { event?: string }).event === 'worker.dispatch.race_loss',
  )
  expect(raceLossCalls).toHaveLength(1)

  // Spec invariant: markFailed must NOT be called on the race-loss path
  expect(markFailed).not.toHaveBeenCalled()

  warnSpy.mockRestore()
})

// D7: Idle — no jobs in queue, processOneJob returns null without doing work
test('D7: processOneJob returns null when no jobs are available', async () => {
  // No jobs seeded
  const { processOneJob } = await import('@/lib/worker/dispatcher')
  const result = await processOneJob('worker-idle')

  expect(result).toBeNull()
})
