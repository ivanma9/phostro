#!/usr/bin/env -S pnpm tsx
/**
 * Task 9 — Filter correctness on bench fixtures with real ONNX.
 *
 * Owner identity: lfw_tony_blair (5 photos; clearly same person; good LFW quality).
 *   - Tony_Blair_0001.jpg → enrollment selfie (derives owner face_embedding)
 *   - Tony_Blair_0037/0073/0108/0144.jpg → contributed photos (4 labeled tony_blair photos)
 *
 * All 8 identities × 5 photos = 40 contributed photos total.
 *
 * GATE  (hard fail):   zero false positives — every returned photo must have r2KeyPreview
 *                       prefix lfw_tony_blair/.
 * ADVISORY (log only): recall = returned_owner / 4. Warn if < 0.6. DO NOT fail on recall.
 *
 * Prerequisites:
 *   - Postgres reachable (default: test DB on port 54329).
 *   - Worker reachable at WORKER_URL (default localhost:8000).
 *     Run with:
 *       WORKER_SECRET=ci-test-secret \
 *         WORKER_MODELS_DIR=$(pwd)/bench/models \
 *         worker/.venv/bin/uvicorn worker.main:app --host 127.0.0.1 --port 8000
 *
 * Usage:
 *   pnpm smoke:filter
 *   # or with custom DB:
 *   DATABASE_URL=... pnpm smoke:filter
 */

import { spawn, type ChildProcess } from 'node:child_process'
import * as path from 'node:path'

// ─── Config — set BEFORE module imports so project modules see them ────────

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:54329/postgres'
const WORKER_URL = process.env.WORKER_URL ?? 'http://localhost:8000'
const WORKER_SECRET = process.env.WORKER_SECRET ?? 'ci-test-secret'
const FIXTURE_PORT = Number(process.env.FIXTURE_PORT ?? 8802)
const FIXTURE_HOST_FOR_WORKER = process.env.FIXTURE_HOST_FOR_WORKER ?? '127.0.0.1'

process.env.DATABASE_URL = DATABASE_URL
process.env.WORKER_URL = WORKER_URL
process.env.WORKER_SECRET = WORKER_SECRET
process.env.R2_LOCAL_OVERRIDE_BASE_URL = `http://${FIXTURE_HOST_FOR_WORKER}:${FIXTURE_PORT}`

// ─── Fixture manifest ──────────────────────────────────────────────────────

const OWNER_IDENTITY = 'lfw_tony_blair'
const ENROLLMENT_KEY = 'lfw_tony_blair/Tony_Blair_0001.jpg'

// All 40 contributed photos: 8 identities × 5 photos each.
// The enrollment photo (Tony_Blair_0001.jpg) is NOT included — it becomes the
// owner's face_embedding reference and is deleted from the photo set.
const ALL_IDENTITIES: Record<string, string[]> = {
  lfw_colin_powell: [
    'lfw_colin_powell/Colin_Powell_0001.jpg',
    'lfw_colin_powell/Colin_Powell_0060.jpg',
    'lfw_colin_powell/Colin_Powell_0119.jpg',
    'lfw_colin_powell/Colin_Powell_0177.jpg',
    'lfw_colin_powell/Colin_Powell_0236.jpg',
  ],
  lfw_donald_rumsfeld: [
    'lfw_donald_rumsfeld/Donald_Rumsfeld_0001.jpg',
    'lfw_donald_rumsfeld/Donald_Rumsfeld_0030.jpg',
    'lfw_donald_rumsfeld/Donald_Rumsfeld_0060.jpg',
    'lfw_donald_rumsfeld/Donald_Rumsfeld_0090.jpg',
    'lfw_donald_rumsfeld/Donald_Rumsfeld_0121.jpg',
  ],
  lfw_george_w_bush: [
    'lfw_george_w_bush/George_W_Bush_0001.jpg',
    'lfw_george_w_bush/George_W_Bush_0133.jpg',
    'lfw_george_w_bush/George_W_Bush_0265.jpg',
    'lfw_george_w_bush/George_W_Bush_0398.jpg',
    'lfw_george_w_bush/George_W_Bush_0530.jpg',
  ],
  lfw_gerhard_schroeder: [
    'lfw_gerhard_schroeder/Gerhard_Schroeder_0001.jpg',
    'lfw_gerhard_schroeder/Gerhard_Schroeder_0028.jpg',
    'lfw_gerhard_schroeder/Gerhard_Schroeder_0055.jpg',
    'lfw_gerhard_schroeder/Gerhard_Schroeder_0082.jpg',
    'lfw_gerhard_schroeder/Gerhard_Schroeder_0109.jpg',
  ],
  lfw_hugo_chavez: [
    'lfw_hugo_chavez/Hugo_Chavez_0001.jpg',
    'lfw_hugo_chavez/Hugo_Chavez_0017.jpg',
    'lfw_hugo_chavez/Hugo_Chavez_0035.jpg',
    'lfw_hugo_chavez/Hugo_Chavez_0053.jpg',
    'lfw_hugo_chavez/Hugo_Chavez_0071.jpg',
  ],
  lfw_jacques_chirac: [
    'lfw_jacques_chirac/Jacques_Chirac_0001.jpg',
    'lfw_jacques_chirac/Jacques_Chirac_0013.jpg',
    'lfw_jacques_chirac/Jacques_Chirac_0026.jpg',
    'lfw_jacques_chirac/Jacques_Chirac_0039.jpg',
    'lfw_jacques_chirac/Jacques_Chirac_0052.jpg',
  ],
  lfw_junichiro_koizumi: [
    'lfw_junichiro_koizumi/Junichiro_Koizumi_0001.jpg',
    'lfw_junichiro_koizumi/Junichiro_Koizumi_0016.jpg',
    'lfw_junichiro_koizumi/Junichiro_Koizumi_0031.jpg',
    'lfw_junichiro_koizumi/Junichiro_Koizumi_0045.jpg',
    'lfw_junichiro_koizumi/Junichiro_Koizumi_0060.jpg',
  ],
  lfw_tony_blair: [
    // 0001 is the enrollment selfie — omitted from contributions
    'lfw_tony_blair/Tony_Blair_0037.jpg',
    'lfw_tony_blair/Tony_Blair_0073.jpg',
    'lfw_tony_blair/Tony_Blair_0108.jpg',
    'lfw_tony_blair/Tony_Blair_0144.jpg',
  ],
}

// 4 owner contributions (0001 is the enrollment selfie, excluded from contributions)
const TOTAL_OWNER_IN_SET = ALL_IDENTITIES[OWNER_IDENTITY].length
// 7 other identities × 5 + 4 owner contributions = 39 contributed photos total
// (enrollment selfie Tony_Blair_0001.jpg is processed separately and deleted)
const ALL_CONTRIBUTED_KEYS = Object.values(ALL_IDENTITIES).flat()

// ─── Helpers ──────────────────────────────────────────────────────────────

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
  return spawn('python3', ['-m', 'http.server', String(FIXTURE_PORT), '--bind', '0.0.0.0'], {
    cwd: fixtureDir,
    stdio: ['ignore', 'ignore', 'ignore'],
  })
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('Task 9 — Filter correctness (bench fixtures, real ONNX)')
  console.log(`  DATABASE_URL          = ${DATABASE_URL}`)
  console.log(`  WORKER_URL            = ${WORKER_URL}`)
  console.log(`  fixture server port   = ${FIXTURE_PORT}`)
  console.log(`  worker fetches at     = http://${FIXTURE_HOST_FOR_WORKER}:${FIXTURE_PORT}`)
  console.log(`  owner identity        = ${OWNER_IDENTITY}`)
  console.log(`  enrollment selfie     = ${ENROLLMENT_KEY}`)
  console.log(`  contributed photos    = ${ALL_CONTRIBUTED_KEYS.length}`)

  // ── Preflight: worker health ──────────────────────────────────────────────
  if (!(await workerHealth())) {
    console.error(`\nFAIL Worker not reachable at ${WORKER_URL}/health`)
    console.error('  Start the worker first:')
    console.error(
      '  WORKER_SECRET=ci-test-secret WORKER_MODELS_DIR=$(pwd)/bench/models worker/.venv/bin/uvicorn worker.main:app --host 127.0.0.1 --port 8000',
    )
    process.exit(1)
  }
  console.log('  worker /health        = ok')

  // Safe to import project modules now — env is set
  const { eq, sql } = await import('drizzle-orm')
  const { db } = await import('@/db')
  const { users, events, eventMembers, photos, photoJobs, faceDetections, faceClusters, shareLinks } =
    await import('@/db/schema')
  const { processOneJob } = await import('@/lib/worker/dispatcher')
  const { listYouFeed } = await import('@/lib/photos/you-feed')

  async function cleanFixtures(): Promise<void> {
    await db.delete(shareLinks)
    await db.delete(faceDetections)
    await db.delete(faceClusters)
    await db.delete(photoJobs)
    await db.delete(photos)
    await db.delete(eventMembers)
    await db.delete(events)
    await db.delete(users)
  }

  // ── Start fixture HTTP server ──────────────────────────────────────────────
  const server = startFixtureServer()
  await sleep(500)
  console.log(`  fixture server pid    = ${server.pid}`)

  let precisionPassed = false

  try {
    // ── Step 1: Clean ────────────────────────────────────────────────────────
    header('Step 1: Clean fixtures')
    await cleanFixtures()
    console.log('  truncated all fixture tables')

    // ── Step 2: Seed owner user + event ──────────────────────────────────────
    header('Step 2: Seed owner + event')

    const [owner] = await db
      .insert(users)
      .values({
        name: 'Tony Blair (smoke)',
        contact: 'smoke-task9-owner@x.com',
        contactType: 'email',
      })
      .returning()
    console.log(`  owner user_id = ${owner.id}`)

    const [event] = await db
      .insert(events)
      .values({
        hostUserId: owner.id,
        name: 'smoke-pocket',
        visibilityMode: 'personal',
        expiresAt: new Date(Date.now() + 86400 * 1000),
      })
      .returning()
    console.log(`  event_id      = ${event.id}`)

    await db.insert(eventMembers).values({ eventId: event.id, userId: owner.id, role: 'host' })
    console.log('  event_members (host) inserted')

    // ── Step 3: Process enrollment selfie → extract embedding ─────────────────
    header('Step 3: Enroll owner (Tony_Blair_0001.jpg → face_embedding)')

    const [enrollPhoto] = await db
      .insert(photos)
      .values({
        eventId: event.id,
        uploaderUserId: owner.id,
        processingState: 'ready',
        r2KeyPreview: ENROLLMENT_KEY,
        declaredMimeType: 'image/jpeg',
        declaredSizeBytes: 50_000,
      })
      .returning()

    const [enrollJob] = await db
      .insert(photoJobs)
      .values({ photoId: enrollPhoto.id, kind: 'detect', state: 'queued' })
      .returning()

    console.log(`  enroll photo_id = ${enrollPhoto.id}`)
    console.log(`  enroll job_id   = ${enrollJob.id}`)

    const enrollResult = await processOneJob('smoke-task9-enroll')
    if (!enrollResult) {
      throw new Error('Enrollment job failed or returned null — cannot derive owner embedding')
    }

    const enrollDetections = await db
      .select()
      .from(faceDetections)
      .where(eq(faceDetections.photoId, enrollPhoto.id))

    if (enrollDetections.length === 0) {
      throw new Error('No face detected in enrollment selfie — cannot derive owner embedding')
    }

    const ownerEmbedding = enrollDetections[0].embedding as number[]
    console.log(`  embedding dimensions = ${ownerEmbedding.length}`)

    // Store embedding on the user row
    await db
      .update(users)
      .set({
        faceEmbedding: ownerEmbedding,
        faceEnrolledAt: new Date(),
      })
      .where(eq(users.id, owner.id))
    console.log('  users.face_embedding updated')

    // Delete the temp enrollment photo + its detections (not part of contribution set)
    await db.delete(faceDetections).where(eq(faceDetections.photoId, enrollPhoto.id))
    await db.delete(photoJobs).where(eq(photoJobs.id, enrollJob.id))
    await db.delete(photos).where(eq(photos.id, enrollPhoto.id))
    console.log('  enrollment photo/job/detections cleaned up')

    // ── Step 4: Insert all 39 contributed photos + jobs ───────────────────────
    header(`Step 4: Insert ${ALL_CONTRIBUTED_KEYS.length} contributed photos`)

    const DUMMY_UPLOADER_TOKEN = 'smoke-task9-anon-token'

    const insertedPhotoIds: string[] = []
    for (const key of ALL_CONTRIBUTED_KEYS) {
      const [p] = await db
        .insert(photos)
        .values({
          eventId: event.id,
          uploaderToken: DUMMY_UPLOADER_TOKEN,
          processingState: 'ready',
          r2KeyPreview: key,
          declaredMimeType: 'image/jpeg',
          declaredSizeBytes: 50_000,
        })
        .returning()
      await db.insert(photoJobs).values({ photoId: p.id, kind: 'detect', state: 'queued' })
      insertedPhotoIds.push(p.id)
    }
    console.log(`  inserted ${insertedPhotoIds.length} photos + jobs`)

    // ── Step 5: Drain the job queue ───────────────────────────────────────────
    header('Step 5: Drain job queue (real ONNX)')

    const MAX_DRAIN_ITERATIONS = 200 // 39 photos × max ~5 retries each = well-bounded
    let drainCount = 0
    let idleCount = 0

    while (drainCount < MAX_DRAIN_ITERATIONS) {
      const result = await processOneJob(`smoke-task9-drain-${drainCount}`)
      if (result === null) {
        // Check if there are genuinely no more queued jobs
        const [queuedRow] = (await db.execute(
          sql`SELECT COUNT(*)::int AS cnt FROM photo_jobs WHERE state = 'queued'`,
        )) as unknown as [{ cnt: number }]
        if ((queuedRow?.cnt ?? 0) === 0) {
          console.log(`  queue drained after ${drainCount} iterations (idle signal)`)
          break
        }
        // Transient idle (claimed but not yet freed) — keep looping
        idleCount++
        if (idleCount > 10) {
          console.warn('  too many consecutive idle signals with jobs still queued — stopping')
          break
        }
      } else {
        idleCount = 0
      }
      drainCount++
    }

    if (drainCount >= MAX_DRAIN_ITERATIONS) {
      console.warn(`  reached drain cap of ${MAX_DRAIN_ITERATIONS} iterations`)
    }

    // Verify all jobs succeeded (no stuck/failed)
    const jobStates = (await db.execute(
      sql`SELECT state, COUNT(*)::int AS cnt FROM photo_jobs GROUP BY state`,
    )) as unknown as { state: string; cnt: number }[]
    for (const row of Array.from(jobStates)) {
      console.log(`  job state ${row.state}: ${row.cnt}`)
    }

    const failedJobs = Array.from(jobStates).filter(
      (r) => r.state === 'failed' || r.state === 'queued' || r.state === 'claimed',
    )
    if (failedJobs.length > 0) {
      console.warn('  WARNING: some jobs did not succeed — results may be incomplete')
    }

    // ── Step 6: Run the filter ────────────────────────────────────────────────
    header('Step 6: listYouFeed (SQL vector filter)')

    const feedItems = await listYouFeed(event.id, ownerEmbedding)
    console.log(`  filter returned ${feedItems.length} photos`)

    // ── Step 7: Assert precision (HARD GATE) ──────────────────────────────────
    header('Step 7: Precision gate (zero false positives)')

    const falsePositives = feedItems.filter((item) => !item.r2KeyPreview.startsWith(`${OWNER_IDENTITY}/`))

    if (falsePositives.length > 0) {
      console.error(`  PRECISION FAIL: ${falsePositives.length} false positive(s) detected:`)
      for (const fp of falsePositives) {
        console.error(`    photo_id=${fp.photoId}  r2Key=${fp.r2KeyPreview}  distance=${fp.distance.toFixed(4)}`)
      }
      precisionPassed = false
    } else {
      console.log(`  PRECISION PASS: all ${feedItems.length} returned photos are tony_blair`)
      precisionPassed = true
    }

    // ── Step 8: Log recall (ADVISORY — never fails the script) ───────────────
    header('Step 8: Recall (advisory)')

    const returnedOwnerCount = feedItems.filter((item) =>
      item.r2KeyPreview.startsWith(`${OWNER_IDENTITY}/`),
    ).length

    const recall = TOTAL_OWNER_IN_SET > 0 ? returnedOwnerCount / TOTAL_OWNER_IN_SET : 0

    console.log(`  total_owner_in_set = ${TOTAL_OWNER_IN_SET}`)
    console.log(`  returned_owner     = ${returnedOwnerCount}`)
    console.log(`  recall             = ${(recall * 100).toFixed(1)}%  (${returnedOwnerCount}/${TOTAL_OWNER_IN_SET})`)

    if (recall < 0.6) {
      console.warn(
        `  RECALL WARNING: recall=${(recall * 100).toFixed(1)}% is below the 60% advisory threshold.`,
      )
      console.warn('  This is logged for human inspection. The script does NOT fail on recall.')
    } else {
      console.log('  Recall is at or above the 60% advisory threshold.')
    }

    // ── Step 9: Cleanup ───────────────────────────────────────────────────────
    header('Step 9: Cleanup')
    await cleanFixtures()
    console.log('  fixtures truncated')
  } finally {
    server.kill()
    console.log('\n  fixture server stopped')
  }

  // ── Final summary ─────────────────────────────────────────────────────────
  header('Result')
  if (precisionPassed) {
    console.log('  PASS — precision gate passed (zero false positives)')
    process.exit(0)
  } else {
    console.error('  FAIL — precision gate failed (false positives detected)')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('Smoke harness crashed:', err)
  process.exit(2)
})
