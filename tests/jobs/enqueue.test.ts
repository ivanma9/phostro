import { eq } from 'drizzle-orm'
import { beforeEach, expect, test } from 'vitest'
import { db } from '@/db'
import { eventMembers, events, photoJobs, photos, users } from '@/db/schema'
import { enqueuePhotoJob } from '@/lib/jobs/enqueue'

async function seedFixtures() {
  const [u] = await db
    .insert(users)
    .values({ name: 'U', contact: 'u_enqueue@x.com', contactType: 'email' })
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
  await db.delete(photoJobs)
  await db.delete(photos)
  await db.delete(eventMembers)
  await db.delete(events)
  await db.delete(users)
})

test('enqueuePhotoJob: inserts a photo_jobs row with state=queued, kind=detect, attempts=0', async () => {
  const { p } = await seedFixtures()
  const job = await enqueuePhotoJob(p.id)
  expect(job.photoId).toBe(p.id)
  expect(job.kind).toBe('detect')
  expect(job.state).toBe('queued')
  expect(job.attempts).toBe(0)

  const [dbRow] = await db.select().from(photoJobs).where(eq(photoJobs.photoId, p.id))
  expect(dbRow).toBeDefined()
  expect(dbRow.state).toBe('queued')
  expect(dbRow.kind).toBe('detect')
  expect(dbRow.attempts).toBe(0)
})

test('enqueuePhotoJob: idempotent — calling twice returns existing row, no unique violation', async () => {
  const { p } = await seedFixtures()
  const job1 = await enqueuePhotoJob(p.id)
  const job2 = await enqueuePhotoJob(p.id)

  // Same row returned both times
  expect(job2.id).toBe(job1.id)
  expect(job2.state).toBe('queued')

  // Only one row in DB
  const rows = await db.select().from(photoJobs).where(eq(photoJobs.photoId, p.id))
  expect(rows).toHaveLength(1)
})

test('enqueuePhotoJob: concurrent calls both resolve to same id with exactly one row', async () => {
  const { p } = await seedFixtures()
  const [job1, job2] = await Promise.all([enqueuePhotoJob(p.id), enqueuePhotoJob(p.id)])

  // Both calls must resolve
  expect(job1).toBeDefined()
  expect(job2).toBeDefined()
  // Both return the same logical row
  expect(job1.id).toBe(job2.id)

  // Exactly one row in DB
  const rows = await db.select().from(photoJobs).where(eq(photoJobs.photoId, p.id))
  expect(rows).toHaveLength(1)
})

test('enqueuePhotoJob: failed state allows new queued row (partial index does not block)', async () => {
  const { p } = await seedFixtures()

  // Insert a failed job manually — partial index covers only queued/claimed/succeeded
  const [failedJob] = await db
    .insert(photoJobs)
    .values({ photoId: p.id, kind: 'detect', state: 'failed' })
    .returning()
  expect(failedJob.state).toBe('failed')

  // enqueuePhotoJob should create a NEW queued row, not conflict
  const newJob = await enqueuePhotoJob(p.id)
  expect(newJob.state).toBe('queued')
  expect(newJob.id).not.toBe(failedJob.id)

  // Both rows exist
  const rows = await db.select().from(photoJobs).where(eq(photoJobs.photoId, p.id))
  expect(rows).toHaveLength(2)
  expect(rows.some((r) => r.state === 'failed')).toBe(true)
  expect(rows.some((r) => r.state === 'queued')).toBe(true)
})
