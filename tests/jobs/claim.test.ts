import { beforeEach, expect, test, vi } from 'vitest'
import { db } from '@/db'
import { eventMembers, events, photoJobs, photos, users } from '@/db/schema'
import { claimNextJob } from '@/lib/jobs/claim'

async function seedFixtures() {
  const [u] = await db
    .insert(users)
    .values({ name: 'U', contact: 'u_claim@x.com', contactType: 'email' })
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

async function insertQueuedJob(photoId: string) {
  const [job] = await db
    .insert(photoJobs)
    .values({ photoId, kind: 'detect', state: 'queued' })
    .returning()
  return job
}

beforeEach(async () => {
  await db.delete(photoJobs)
  await db.delete(photos)
  await db.delete(eventMembers)
  await db.delete(events)
  await db.delete(users)
})

// Test 1: basic claim
test('claimNextJob: claims a queued job, sets state=claimed, claimed_at, claimed_by', async () => {
  const { p } = await seedFixtures()
  await insertQueuedJob(p.id)

  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const job = await claimNextJob('worker-1', 120)

  expect(job).not.toBeNull()
  expect(job!.state).toBe('claimed')
  expect(job!.claimedBy).toBe('worker-1')
  expect(job!.claimedAt).not.toBeNull()
  expect(job!.attempts).toBe(1)

  // Negative case: a fresh queued claim must NOT emit worker.job.reclaimed.
  const reclaimedCalls = warnSpy.mock.calls.filter(
    (args) =>
      args[0] && typeof args[0] === 'object' && (args[0] as { event?: string }).event === 'worker.job.reclaimed',
  )
  expect(reclaimedCalls).toHaveLength(0)
  warnSpy.mockRestore()
})

// Test 2: concurrent claimers receive distinct jobs
test('claimNextJob: two concurrent claimers receive distinct jobs', async () => {
  const { p: p1 } = await seedFixtures()
  // Insert second photo under the same user/event — need a fresh photo row
  const [p2] = await db
    .insert(photos)
    .values({
      eventId: (await db.select().from(events).limit(1))[0].id,
      uploaderUserId: (await db.select().from(users).limit(1))[0].id,
      declaredMimeType: 'image/jpeg',
      declaredSizeBytes: 1000,
    })
    .returning()

  await insertQueuedJob(p1.id)
  await insertQueuedJob(p2.id)

  const [job1, job2] = await Promise.all([
    claimNextJob('worker-a', 120),
    claimNextJob('worker-b', 120),
  ])

  expect(job1).not.toBeNull()
  expect(job2).not.toBeNull()
  expect(job1!.id).not.toBe(job2!.id)
})

// Test 3: reclaim a stuck (timed-out) job
test('claimNextJob: reclaims a stuck claimed job past claim_timeout and emits warn log', async () => {
  const { p } = await seedFixtures()
  // Insert a "stuck" job: state=claimed, claimed_at 10 minutes ago
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000)
  await db.insert(photoJobs).values({
    photoId: p.id,
    kind: 'detect',
    state: 'claimed',
    claimedAt: tenMinutesAgo,
    claimedBy: 'dead-worker',
    attempts: 1,
  })

  const warnSpy = vi.spyOn(console, 'warn')

  const job = await claimNextJob('worker-rescue', 60)

  expect(job).not.toBeNull()
  expect(job!.state).toBe('claimed')
  expect(job!.claimedBy).toBe('worker-rescue')
  expect(job!.claimedAt).not.toBeNull()
  expect(job!.claimedAt!.getTime()).toBeGreaterThan(tenMinutesAgo.getTime())
  expect(job!.attempts).toBe(2)

  // Reclaim warn log must have been emitted
  const warnCalls = warnSpy.mock.calls
  const reclaimLog = warnCalls.find(
    (args) =>
      args[0] &&
      typeof args[0] === 'object' &&
      args[0].event === 'worker.job.reclaimed',
  )
  expect(reclaimLog).toBeDefined()
  expect(reclaimLog![0].jobId).toBe(job!.id)
  expect(reclaimLog![0].photoId).toBe(p.id)
  expect(reclaimLog![0].previousClaimedBy).toBe('dead-worker')

  warnSpy.mockRestore()
})
