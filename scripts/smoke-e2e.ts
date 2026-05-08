#!/usr/bin/env -S pnpm tsx
/**
 * Phase 3 Task 18 — End-to-end smoke against a local stack.
 *
 * Exercises the full recognition pipeline:
 *   1. Local HTTP fixture server (serves bench/fixtures/wedding-face-crops/)
 *   2. R2 override env points the dispatcher's presigned-URL minting at the
 *      local server (no real R2 needed).
 *   3. Insert user/event/photo rows directly + enqueue a detect job.
 *   4. Call processOneJob() — exercises real ONNX inference in the worker,
 *      writes face_detections, flips photos.has_detected_faces, marks job
 *      succeeded.
 *   5. Call runClusterJob() — assigns cluster_id to the new detection,
 *      writes a face_clusters row.
 *   6. Verify the entire chain via SQL.
 *   7. Negative test: insert a photo whose URL is unreachable, run repeatedly,
 *      verify markFailed retries and eventually dead-letters to state='failed'.
 *
 * Prerequisites:
 *   - Postgres reachable (default: test DB on port 54329).
 *   - Worker reachable at WORKER_URL (default localhost:8000) with matching
 *     WORKER_SECRET. Easiest: run uvicorn directly:
 *       WORKER_SECRET=ci-test-secret \
 *         WORKER_MODELS_DIR=$(pwd)/bench/models \
 *         worker/.venv/bin/uvicorn worker.main:app --host 127.0.0.1 --port 8000
 *
 * Usage:
 *   pnpm tsx scripts/smoke-e2e.ts
 */

import { spawn, type ChildProcess } from 'node:child_process'
import * as path from 'node:path'

// ─── Config (set BEFORE module imports so project modules read them) ──────

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:54329/postgres'
const WORKER_URL = process.env.WORKER_URL ?? 'http://localhost:8000'
const WORKER_SECRET = process.env.WORKER_SECRET ?? 'ci-test-secret'
const FIXTURE_PORT = Number(process.env.FIXTURE_PORT ?? 8801)
const FIXTURE_HOST_FOR_WORKER = process.env.FIXTURE_HOST_FOR_WORKER ?? '127.0.0.1'

process.env.DATABASE_URL = DATABASE_URL
process.env.WORKER_URL = WORKER_URL
process.env.WORKER_SECRET = WORKER_SECRET
process.env.R2_LOCAL_OVERRIDE_BASE_URL = `http://${FIXTURE_HOST_FOR_WORKER}:${FIXTURE_PORT}`

// ─── Counters + helpers ────────────────────────────────────────────────────

let pass = 0
let fail = 0

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ✓ ${name}`)
    pass++
  } else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
    fail++
  }
}

function header(s: string): void {
  console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 70 - s.length - 4))}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function workerHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${WORKER_URL}/health`, { signal: AbortSignal.timeout(3000) })
    return res.ok
  } catch {
    return false
  }
}

function startFixtureServer(): ChildProcess {
  const fixtureDir = path.resolve('bench/fixtures/wedding-face-crops')
  return spawn(
    'python3',
    ['-m', 'http.server', String(FIXTURE_PORT), '--bind', '0.0.0.0'],
    { cwd: fixtureDir, stdio: ['ignore', 'ignore', 'ignore'] },
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('Phase 3 Task 18 — End-to-end smoke')
  console.log(`  DATABASE_URL          = ${DATABASE_URL}`)
  console.log(`  WORKER_URL            = ${WORKER_URL}`)
  console.log(`  fixture server (host) = http://0.0.0.0:${FIXTURE_PORT}`)
  console.log(`  worker fetches at     = http://${FIXTURE_HOST_FOR_WORKER}:${FIXTURE_PORT}`)

  if (!(await workerHealth())) {
    console.error(`\n✗ Worker not reachable at ${WORKER_URL}/health`)
    console.error(
      '   Start the worker first. Either `make up` (compose) or run uvicorn directly:',
    )
    console.error(
      '   WORKER_SECRET=ci-test-secret WORKER_MODELS_DIR=$(pwd)/bench/models worker/.venv/bin/uvicorn worker.main:app --host 127.0.0.1 --port 8000',
    )
    process.exit(1)
  }
  console.log('  worker /health        = ok')

  // Now safe to import project modules — env vars are set
  const { eq, sql } = await import('drizzle-orm')
  const { db } = await import('@/db')
  const {
    users, events, eventMembers, photos, photoJobs, faceDetections, faceClusters,
  } = await import('@/db/schema')
  const { processOneJob } = await import('@/lib/worker/dispatcher')
  const { runClusterJob } = await import('@/lib/worker/cluster')

  async function cleanFixtures(): Promise<void> {
    await db.delete(faceDetections)
    await db.delete(faceClusters)
    await db.delete(photoJobs)
    await db.delete(photos)
    await db.delete(eventMembers)
    await db.delete(events)
    await db.delete(users)
  }

  async function seed(opts: { previewKey: string }) {
    const [u] = await db
      .insert(users)
      .values({ name: 'Smoke', contact: 'smoke-e2e@x.com', contactType: 'email' })
      .returning()
    const [e] = await db
      .insert(events)
      .values({
        hostUserId: u.id,
        name: 'smoke-event',
        expiresAt: new Date(Date.now() + 86400 * 1000),
      })
      .returning()
    await db.insert(eventMembers).values({ eventId: e.id, userId: u.id, role: 'host' })
    const [p] = await db
      .insert(photos)
      .values({
        eventId: e.id,
        uploaderUserId: u.id,
        processingState: 'ready',
        r2KeyPreview: opts.previewKey,
        declaredMimeType: 'image/jpeg',
        declaredSizeBytes: 50_000,
      })
      .returning()
    const [j] = await db
      .insert(photoJobs)
      .values({ photoId: p.id, kind: 'detect', state: 'queued' })
      .returning()
    return { user: u, event: e, photo: p, job: j }
  }

  // Start fixture server
  const server = startFixtureServer()
  await sleep(500)
  console.log(`  fixture server pid    = ${server.pid}`)

  try {
    // ── Happy path ────────────────────────────────────────────────────────
    header('Happy path: real photo → worker → face_detections → face_clusters')

    await cleanFixtures()
    const { event, photo, job } = await seed({
      previewKey: 'lfw_george_w_bush/George_W_Bush_0001.jpg',
    })

    console.log(`  photo_id=${photo.id}`)
    console.log(`  job_id=${job.id}`)

    const result = await processOneJob('smoke-worker-1')
    check('processOneJob returned non-null', result !== null)

    const [updatedJob] = await db.select().from(photoJobs).where(eq(photoJobs.id, job.id))
    check(
      'photo_jobs row state=succeeded',
      updatedJob?.state === 'succeeded',
      `actual=${updatedJob?.state} last_error=${updatedJob?.lastError}`,
    )

    const detections = await db
      .select()
      .from(faceDetections)
      .where(eq(faceDetections.photoId, photo.id))
    check(
      'face_detections has ≥1 row',
      detections.length >= 1,
      `count=${detections.length}`,
    )
    if (detections.length >= 1) {
      const d = detections[0]
      check(
        'embedding has 512 dimensions',
        Array.isArray(d.embedding) && d.embedding.length === 512,
        `length=${Array.isArray(d.embedding) ? d.embedding.length : 'not array'}`,
      )
      check('confidence > 0', d.confidence > 0, `confidence=${d.confidence}`)
    }

    const [updatedPhoto] = await db.select().from(photos).where(eq(photos.id, photo.id))
    check(
      'photos.has_detected_faces=true',
      updatedPhoto?.hasDetectedFaces === true,
      `actual=${updatedPhoto?.hasDetectedFaces}`,
    )

    const clusterResult = await runClusterJob({ matchMaxDistance: 0.528 })
    check(
      'cluster job processed ≥1 event',
      clusterResult.eventsProcessed >= 1,
      `events=${clusterResult.eventsProcessed}`,
    )
    check(
      'cluster job clustered ≥1 detection',
      clusterResult.detectionsClustered >= 1,
      `detections=${clusterResult.detectionsClustered}`,
    )

    const clusters = await db
      .select()
      .from(faceClusters)
      .where(eq(faceClusters.eventId, event.id))
    check(
      'face_clusters has ≥1 row for the event',
      clusters.length >= 1,
      `count=${clusters.length}`,
    )

    const detectionsAfter = await db
      .select()
      .from(faceDetections)
      .where(eq(faceDetections.photoId, photo.id))
    check(
      'detection.cluster_id assigned after cluster run',
      detectionsAfter[0]?.clusterId != null,
      `cluster_id=${detectionsAfter[0]?.clusterId}`,
    )

    const failedRows = (await db.execute(
      sql`SELECT id FROM failed_photo_jobs_recent WHERE photo_id = ${photo.id}`,
    )) as unknown as { id: string }[]
    check(
      'failed_photo_jobs_recent empty for this photo',
      Array.from(failedRows).length === 0,
    )

    // ── Failure path ──────────────────────────────────────────────────────
    header(
      'Failure path: unreachable URL → worker.detect.r2_fetch_failed → markFailed',
    )

    await cleanFixtures()
    const { photo: badPhoto, job: badJob } = await seed({
      previewKey: 'this-file-does-not-exist.jpg',
    })

    console.log(`  photo_id=${badPhoto.id}`)
    console.log(`  job_id=${badJob.id}`)

    await processOneJob('smoke-worker-2')
    let [retryJob] = await db.select().from(photoJobs).where(eq(photoJobs.id, badJob.id))
    check(
      'first failure → state=queued (retry path)',
      retryJob?.state === 'queued',
      `state=${retryJob?.state} attempts=${retryJob?.attempts}`,
    )
    check('attempts incremented to 1', retryJob?.attempts === 1)
    check('last_error populated', !!retryJob?.lastError)

    // Drain remaining attempts
    for (let i = 0; i < 5; i++) {
      await processOneJob('smoke-worker-2')
      ;[retryJob] = await db.select().from(photoJobs).where(eq(photoJobs.id, badJob.id))
      if (retryJob?.state === 'failed') break
    }
    check(
      'after exhausting retries → state=failed',
      retryJob?.state === 'failed',
      `state=${retryJob?.state} attempts=${retryJob?.attempts}`,
    )

    const failedAfterRetries = (await db.execute(
      sql`SELECT id FROM failed_photo_jobs_recent WHERE photo_id = ${badPhoto.id}`,
    )) as unknown as { id: string }[]
    check(
      'failed_photo_jobs_recent shows the dead-lettered job',
      Array.from(failedAfterRetries).length === 1,
    )

    // Cleanup before exit so a re-run starts clean
    await cleanFixtures()
  } finally {
    server.kill()
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('Smoke harness crashed:', err)
  process.exit(2)
})
