/**
 * Runner tests — TDD, 5 tests.
 *
 * Test user: u_runner@x.com
 *
 * Design choices:
 *   - No real SIGTERM. `shutdown()` exposed on the runner instance; tests call it directly.
 *   - Watchdog log design: only emit `worker.watchdog.reclaimed` when N > 0 (quiet idle).
 *   - Idle log design: emit `worker.runner.idle` only on first idle after a non-idle period.
 *     Tests check "at least once" rather than exact count to stay resilient to timing.
 *   - runDispatcher returns { shutdown, joined } — caller awaits joined after signalling shutdown.
 */

import { eq, sql } from 'drizzle-orm'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { db } from '@/db'
import { eventMembers, events, photoJobs, photos, users } from '@/db/schema'

// Mock the worker client so we don't make real HTTP calls
vi.mock('@/lib/worker/client', () => ({
  detectPhoto: vi.fn(),
}))

// ── Fixtures ──────────────────────────────────────────────────────────────────

async function seedUser() {
  const [u] = await db
    .insert(users)
    .values({ name: 'U', contact: 'u_runner@x.com', contactType: 'email' })
    .returning()
  return u
}

async function seedEvent(hostUserId: string) {
  const [e] = await db
    .insert(events)
    .values({ hostUserId, name: 'E', expiresAt: new Date(Date.now() + 86400_000) })
    .returning()
  await db.insert(eventMembers).values({ eventId: e.id, userId: hostUserId, role: 'host' })
  return e
}

async function seedPhoto(eventId: string, uploaderUserId: string) {
  const [p] = await db
    .insert(photos)
    .values({
      eventId,
      uploaderUserId,
      declaredMimeType: 'image/jpeg',
      declaredSizeBytes: 1000,
      processingState: 'ready',
      r2KeyPreview: 'events/E/preview/P.jpg',
    })
    .returning()
  return p
}

async function insertQueuedJob(photoId: string) {
  const [job] = await db
    .insert(photoJobs)
    .values({ photoId, kind: 'detect', state: 'queued' })
    .returning()
  return job
}

async function insertStuckClaimedJob(photoId: string, claimedSecondsAgo: number) {
  const [job] = await db
    .insert(photoJobs)
    .values({ photoId, kind: 'detect', state: 'queued' })
    .returning()

  // Directly set state='claimed' with old claimed_at
  await db.execute(sql`
    UPDATE photo_jobs
    SET state = 'claimed',
        claimed_at = now() - make_interval(secs => ${claimedSecondsAgo}),
        claimed_by = 'dead-worker',
        attempts = 1,
        updated_at = now()
    WHERE id = ${job.id}
  `)

  return job
}

// ── beforeEach / afterEach ─────────────────────────────────────────────────────

beforeEach(async () => {
  await db.delete(photoJobs)
  await db.delete(photos)
  await db.delete(eventMembers)
  await db.delete(events)
  await db.delete(users)

  const { detectPhoto } = await import('@/lib/worker/client')
  vi.mocked(detectPhoto).mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ── R1: Idle path ──────────────────────────────────────────────────────────────

test('R1: idle queue — runner polls, emits started+idle+shutting_down, exits cleanly', async () => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
  // Silence warn so any incidental warnings don't pollute test output
  vi.spyOn(console, 'warn').mockImplementation(() => {})

  const { runDispatcher } = await import('@/lib/worker/runner')

  const runner = runDispatcher({
    concurrency: 1,
    pollIntervalMs: 50, // fast poll for test
    watchdogIntervalMs: 60_000, // prevent watchdog from firing
    watchdogStaleSec: 120,
    workerId: 'test-worker-r1',
  })

  // Let it poll a couple of times
  await new Promise((resolve) => setTimeout(resolve, 200))

  await runner.shutdown()
  await runner.joined

  // worker.runner.started emitted once
  const startedCalls = logSpy.mock.calls.filter(
    (args) =>
      args[0] &&
      typeof args[0] === 'object' &&
      (args[0] as { event?: string }).event === 'worker.runner.started',
  )
  expect(startedCalls).toHaveLength(1)

  // worker.runner.shutting_down emitted once
  const shuttingDownCalls = logSpy.mock.calls.filter(
    (args) =>
      args[0] &&
      typeof args[0] === 'object' &&
      (args[0] as { event?: string }).event === 'worker.runner.shutting_down',
  )
  expect(shuttingDownCalls).toHaveLength(1)

  // worker.runner.idle emitted at least once (debug level)
  const idleCalls = debugSpy.mock.calls.filter(
    (args) =>
      args[0] &&
      typeof args[0] === 'object' &&
      (args[0] as { event?: string }).event === 'worker.runner.idle',
  )
  expect(idleCalls.length).toBeGreaterThanOrEqual(1)
})

// ── R2: Concurrency ────────────────────────────────────────────────────────────

test('R2: concurrency=2 processes 5 queued jobs and all reach succeeded within 5s', async () => {
  const { detectPhoto } = await import('@/lib/worker/client')
  vi.mocked(detectPhoto).mockImplementation(async () => {
    // Fast mock — minimal delay
    await new Promise((r) => setTimeout(r, 20))
    return { photo_id: 'x', faces: [], elapsed_ms: 20 }
  })

  // Seed 5 jobs
  const u = await seedUser()
  const e = await seedEvent(u.id)
  for (let i = 0; i < 5; i++) {
    const p = await seedPhoto(e.id, u.id)
    await insertQueuedJob(p.id)
  }

  const { runDispatcher } = await import('@/lib/worker/runner')

  const start = Date.now()
  const runner = runDispatcher({
    concurrency: 2,
    pollIntervalMs: 50,
    watchdogIntervalMs: 60_000,
    watchdogStaleSec: 120,
    workerId: 'test-worker-r2',
  })

  // Poll until all jobs succeed or timeout
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const remaining = await db
      .select()
      .from(photoJobs)
      .where(sql`state NOT IN ('succeeded', 'failed')`)
    if (remaining.length === 0) break
    await new Promise((r) => setTimeout(r, 50))
  }

  await runner.shutdown()
  await runner.joined

  const elapsed = Date.now() - start
  expect(elapsed).toBeLessThan(5000)

  const allJobs = await db.select().from(photoJobs)
  expect(allJobs).toHaveLength(5)
  for (const job of allJobs) {
    expect(job.state).toBe('succeeded')
  }
})

// ── R3: SIGTERM grace ─────────────────────────────────────────────────────────

test('R3: shutdown() during in-flight job allows it to finish before exiting', async () => {
  const { detectPhoto } = await import('@/lib/worker/client')

  // Single slow job: takes 500ms
  let detectResolve: (() => void) | null = null
  vi.mocked(detectPhoto).mockImplementationOnce(
    () =>
      new Promise<{ photo_id: string; faces: []; elapsed_ms: number }>((resolve) => {
        detectResolve = () => resolve({ photo_id: 'x', faces: [], elapsed_ms: 500 })
        // Auto-resolve after 500ms
        setTimeout(() => {
          if (detectResolve) detectResolve()
        }, 500)
      }),
  )

  const u = await seedUser()
  const e = await seedEvent(u.id)
  const p = await seedPhoto(e.id, u.id)
  await insertQueuedJob(p.id)

  const { runDispatcher } = await import('@/lib/worker/runner')

  const runner = runDispatcher({
    concurrency: 1,
    pollIntervalMs: 50,
    watchdogIntervalMs: 60_000,
    watchdogStaleSec: 120,
    workerId: 'test-worker-r3',
  })

  // Wait a bit for the job to be claimed and processing to start
  await new Promise((r) => setTimeout(r, 100))

  // Signal shutdown BEFORE the 500ms detect call completes
  const shutdownStart = Date.now()
  await runner.shutdown()
  await runner.joined
  const shutdownMs = Date.now() - shutdownStart

  // Should complete well within 30s (should be ~400ms after our 100ms wait)
  expect(shutdownMs).toBeLessThan(1000)

  // The in-flight job should have finished successfully
  const [job] = await db.select().from(photoJobs).where(eq(photoJobs.photoId, p.id))
  expect(job.state).toBe('succeeded')
})

// ── R4: Watchdog reclaims stuck jobs ──────────────────────────────────────────

test('R4: watchdog resets stuck claimed job back to queued and emits worker.watchdog.reclaimed N=1', async () => {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

  const u = await seedUser()
  const e = await seedEvent(u.id)
  const p = await seedPhoto(e.id, u.id)

  // Stuck job claimed 60s ago: exceeds watchdog's 30s stale threshold,
  // but is WITHIN claimNextJob's 120s timeout so the poll loop won't reclaim it.
  await insertStuckClaimedJob(p.id, 60)

  const { runDispatcher } = await import('@/lib/worker/runner')

  const runner = runDispatcher({
    concurrency: 1,
    pollIntervalMs: 50,
    // Short watchdog interval and stale threshold so test doesn't take forever
    watchdogIntervalMs: 100,
    watchdogStaleSec: 30,
    workerId: 'test-worker-r4',
  })

  // Wait for at least one watchdog tick (100ms) plus slack
  await new Promise((r) => setTimeout(r, 350))

  await runner.shutdown()
  await runner.joined

  // Stuck job should be reset to queued (or it may have been picked up and processed)
  const [job] = await db.select().from(photoJobs).where(eq(photoJobs.photoId, p.id))
  // After watchdog reset to queued, the runner loop may have picked it up.
  // The key invariant is it's NOT stuck in 'claimed' by dead-worker any more.
  expect(job.state).not.toBe('claimed')

  // worker.watchdog.reclaimed warn must have been emitted with N=1
  const reclaimedCalls = warnSpy.mock.calls.filter(
    (args) =>
      args[0] &&
      typeof args[0] === 'object' &&
      (args[0] as { event?: string }).event === 'worker.watchdog.reclaimed',
  )
  expect(reclaimedCalls.length).toBeGreaterThanOrEqual(1)
  // First reclaim call should report N >= 1
  const payload = reclaimedCalls[0][0] as {
    n: number
    jobs: Array<{ id: string; previousClaimedBy: string | null }>
  }
  expect(payload.n).toBeGreaterThanOrEqual(1)
  // Verify previousClaimedBy carries the pre-update worker id (CTE captures it
  // before the SET clears claimed_by; without the CTE this would always be null).
  expect(payload.jobs[0].previousClaimedBy).toBe('dead-worker')
})

// ── R5: Watchdog idle ─────────────────────────────────────────────────────────

test('R5: watchdog with no stuck jobs emits NO worker.watchdog.reclaimed log (quiet idle)', async () => {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

  // Seed a normal queued job (not stuck)
  const u = await seedUser()
  const e = await seedEvent(u.id)
  const p = await seedPhoto(e.id, u.id)
  await insertQueuedJob(p.id)

  const { detectPhoto } = await import('@/lib/worker/client')
  vi.mocked(detectPhoto).mockResolvedValue({ photo_id: p.id, faces: [], elapsed_ms: 5 })

  const { runDispatcher } = await import('@/lib/worker/runner')

  const runner = runDispatcher({
    concurrency: 1,
    pollIntervalMs: 50,
    watchdogIntervalMs: 100, // Short interval so we actually get a tick
    watchdogStaleSec: 30,
    workerId: 'test-worker-r5',
  })

  // Wait for one watchdog tick
  await new Promise((r) => setTimeout(r, 350))

  await runner.shutdown()
  await runner.joined

  // worker.watchdog.reclaimed must NOT have been emitted (N=0 means silent)
  const reclaimedCalls = warnSpy.mock.calls.filter(
    (args) =>
      args[0] &&
      typeof args[0] === 'object' &&
      (args[0] as { event?: string }).event === 'worker.watchdog.reclaimed',
  )
  expect(reclaimedCalls).toHaveLength(0)
})
