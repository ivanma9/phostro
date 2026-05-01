import { beforeEach, expect, test, vi } from 'vitest'
import { db } from '@/db'
import { eventMembers, events, photoJobs, photos, users } from '@/db/schema'
import { markFailed, markSucceeded } from '@/lib/jobs/complete'

async function seedFixtures() {
  const [u] = await db
    .insert(users)
    .values({ name: 'U', contact: 'u_complete@x.com', contactType: 'email' })
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

async function insertClaimedJob(
  photoId: string,
  overrides: {
    attempts?: number
    maxAttempts?: number
    state?: 'queued' | 'claimed' | 'succeeded' | 'failed'
  } = {},
) {
  const [job] = await db
    .insert(photoJobs)
    .values({
      photoId,
      kind: 'detect',
      state: overrides.state ?? 'claimed',
      attempts: overrides.attempts ?? 1,
      maxAttempts: overrides.maxAttempts ?? 5,
      claimedAt: new Date(),
      claimedBy: 'worker-test',
    })
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

// Test 1: markSucceeded happy path
test('markSucceeded: sets state=succeeded, succeeded_at non-null, clears claim fields', async () => {
  const { p } = await seedFixtures()
  const job = await insertClaimedJob(p.id, { attempts: 1 })

  const result = await markSucceeded(job.id)

  expect(result).not.toBeNull()
  expect(result!.state).toBe('succeeded')
  expect(result!.succeededAt).not.toBeNull()
  expect(result!.claimedAt).toBeNull()
  expect(result!.claimedBy).toBeNull()
  // updatedAt must be >= job creation
  expect(result!.updatedAt.getTime()).toBeGreaterThanOrEqual(job.updatedAt.getTime())
})

// Test 2: markFailed retry path
test('markFailed: attempts<max_attempts → state=queued, clears claim, bumps last_error', async () => {
  const { p, e } = await seedFixtures()
  const job = await insertClaimedJob(p.id, { attempts: 2, maxAttempts: 5 })

  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

  const result = await markFailed(job.id, 'boom')

  expect(result).not.toBeNull()
  expect(result!.state).toBe('queued')
  expect(result!.lastError).toBe('boom')
  expect(result!.lastErrorAt).not.toBeNull()
  // attempts must NOT be bumped by markFailed
  expect(result!.attempts).toBe(2)
  // claim fields cleared so watchdog/next worker can pick it up
  expect(result!.claimedAt).toBeNull()
  expect(result!.claimedBy).toBeNull()

  // worker.job.retry log must be emitted (info = console.log)
  const retryCalls = logSpy.mock.calls.filter(
    (args) =>
      args[0] &&
      typeof args[0] === 'object' &&
      (args[0] as { event?: string }).event === 'worker.job.retry',
  )
  expect(retryCalls).toHaveLength(1)
  const retryLog = retryCalls[0][0] as Record<string, unknown>
  expect(retryLog.photoId).toBe(p.id)
  expect(retryLog.eventId).toBe(e.id)
  expect(retryLog.attempts).toBe(2)
  expect(retryLog.last_error).toBe('boom')

  logSpy.mockRestore()
})

// Test 3: markFailed dead-letter path
test('markFailed: attempts>=max_attempts → state=failed, failed_at set, last_error set', async () => {
  const { p, e } = await seedFixtures()
  const job = await insertClaimedJob(p.id, { attempts: 5, maxAttempts: 5 })

  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

  const result = await markFailed(job.id, 'final blow')

  expect(result).not.toBeNull()
  expect(result!.state).toBe('failed')
  expect(result!.failedAt).not.toBeNull()
  expect(result!.lastError).toBe('final blow')
  expect(result!.lastErrorAt).not.toBeNull()
  // attempts must NOT be bumped
  expect(result!.attempts).toBe(5)
  // On dead-letter, claimed_by is preserved so operators can see who failed last.
  // claimed_at is also preserved (matches the spec decision: don't clear on dead-letter).
  expect(result!.claimedBy).toBe('worker-test')

  // worker.job.failed log must be emitted (error = console.error)
  const failedCalls = errorSpy.mock.calls.filter(
    (args) =>
      args[0] &&
      typeof args[0] === 'object' &&
      (args[0] as { event?: string }).event === 'worker.job.failed',
  )
  expect(failedCalls).toHaveLength(1)
  const failedLog = failedCalls[0][0] as Record<string, unknown>
  expect(failedLog.photoId).toBe(p.id)
  expect(failedLog.eventId).toBe(e.id)
  expect(failedLog.attempts).toBe(5)
  expect(failedLog.last_error).toBe('final blow')

  errorSpy.mockRestore()
})

// Test 4 (negative): markSucceeded on an already-succeeded job is a no-op (return null, don't crash)
test('markSucceeded: no-op on already-succeeded job, returns null', async () => {
  const { p } = await seedFixtures()
  // Insert a job already in succeeded state
  const job = await insertClaimedJob(p.id, { state: 'succeeded', attempts: 1 })

  const result = await markSucceeded(job.id)
  // Should return null rather than crash or corrupt the row
  expect(result).toBeNull()

  // The row should still be succeeded (not touched)
  const [row] = await db
    .select()
    .from(photoJobs)
    .where((await import('drizzle-orm')).eq(photoJobs.id, job.id))
  expect(row.state).toBe('succeeded')
})

// Test 5 (negative): markFailed on a nonexistent job returns null without crashing
test('markFailed: nonexistent jobId returns null, does not throw', async () => {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

  const result = await markFailed('00000000-0000-0000-0000-000000000000', 'stale')
  expect(result).toBeNull()

  // A warn should be emitted for operator visibility
  const warnCalls = warnSpy.mock.calls.filter(
    (args) =>
      args[0] &&
      typeof args[0] === 'object' &&
      (args[0] as { event?: string }).event === 'worker.job.notfound',
  )
  expect(warnCalls).toHaveLength(1)

  warnSpy.mockRestore()
})
