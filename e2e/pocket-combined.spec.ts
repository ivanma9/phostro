/**
 * pocket-combined.spec.ts — End-to-end: contributor upload → dispatcher → You feed populated.
 *
 * CI requirements:
 *   - Postgres + pgvector at TEST_DATABASE_URL
 *   - Worker (uvicorn) at WORKER_URL (default http://localhost:8000):
 *       • for selfie enrollment (/api/me/face)
 *       • for face detection via /api/internal/process-one-job (which calls detectPhoto)
 *   - Real R2 credentials (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET)
 *     for presigned PUT URLs during the contributor upload step.
 *
 * The spec drives the Node-side dispatcher synchronously via POST /api/internal/process-one-job
 * (a non-production debug endpoint, NODE_ENV gated). This keeps the spec self-contained —
 * no external worker daemon lifecycle needed. CI still runs uvicorn for the /detect HTTP call.
 *
 * Polling strategy: deterministic poll of GET /api/events/[id]/you on a 500ms interval
 * with a 30s hard cap. Never uses waitForTimeout. See e2e/helpers/wait-for-you-feed.ts.
 */

import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { hasR2Config, isWorkerHealthy } from './helpers/preconditions'
import { waitForYouFeedPhotos } from './helpers/wait-for-you-feed'

const fixtureDir = join(process.cwd(), 'tests/fixtures/photos')

test(
  'combined: contributor upload → process-one-job → You feed populated',
  async ({ page, browser }) => {
    const workerOk = await isWorkerHealthy()
    test.skip(!workerOk, 'Worker not reachable — skipping pocket-combined spec')
    test.skip(!hasR2Config(), 'R2 not configured — skipping pocket-combined spec')

    // ── 1. Sign in as host ────────────────────────────────────────────────────
    const loginRes = await page.request.post('/api/test-login', {
      data: { contact: 'pocket-combined-host+e2e@example.com', name: 'E2E Combined Host' },
    })
    expect(loginRes.ok(), `test-login failed: ${loginRes.status()}`).toBeTruthy()

    // ── 2. Enroll selfie (worker required) ────────────────────────────────────
    await page.goto('/pockets/new')
    await expect(page.getByRole('heading', { name: /new pocket/i })).toBeVisible()

    await page.getByPlaceholder('Pocket name').fill('E2E Combined Pocket')
    await page.getByRole('button', { name: /next/i }).click()

    await expect(page.getByText(/take a quick selfie/i)).toBeVisible()
    await page.locator('input[type="file"]').setInputFiles(join(fixtureDir, 'plain.jpg'))
    await expect(page.getByText(/looks great/i)).toBeVisible({ timeout: 30_000 })

    // ── 3. Create pocket via API (skip the UI click — we already have the session) ──
    //    The selfie enrollment (step 2) writes the face_embedding to the users row.
    //    We use the API directly for the pocket creation to get pocketId reliably.
    await page.getByRole('button', { name: /create pocket/i }).click()

    const shareInput = page.locator('input[readonly]')
    await expect(shareInput).toBeVisible({ timeout: 15_000 })
    const shareUrl = await shareInput.inputValue()
    expect(shareUrl).toMatch(/\/p\/[A-Za-z0-9_-]+$/)

    // Extract pocketId from URL after clicking "Open pocket"
    await page.getByRole('button', { name: /open pocket/i }).click()
    await expect(page).toHaveURL(/\/pockets\/[0-9a-f-]+$/, { timeout: 10_000 })
    const pocketId = page.url().split('/pockets/')[1]
    expect(pocketId).toBeTruthy()

    // ── 4. Contributor uploads 1 photo in a fresh context ─────────────────────
    const contributorContext = await browser.newContext()
    const contributorPage = await contributorContext.newPage()

    try {
      await contributorPage.goto(shareUrl)
      await expect(contributorPage.getByText(/asked for/i)).toBeVisible({ timeout: 10_000 })

      const fileChooserPromise = contributorPage.waitForEvent('filechooser')
      await contributorPage.getByRole('button', { name: /add photos/i }).click()
      const chooser = await fileChooserPromise
      await chooser.setFiles(join(fixtureDir, 'with-gps.jpg'))

      await expect(contributorPage.getByText(/added 1 photo/i)).toBeVisible({ timeout: 60_000 })
    } finally {
      await contributorContext.close()
    }

    // ── 5. Drive the dispatcher via the debug endpoint ─────────────────────────
    // POST once to process the photo job (face detection via Python worker).
    // The upload finalize route inserts the photo_job row in the same DB transaction
    // that returns the 200, so the job is already committed before "Added 1 photo"
    // appears in the UI above. Retry up to 5 times immediately (no sleep) in case
    // of a DB read replica lag or rare clock skew.
    let processed = false
    for (let attempt = 0; attempt < 5; attempt++) {
      const processRes = await page.request.post('/api/internal/process-one-job')
      expect(processRes.ok(), `process-one-job HTTP error: ${processRes.status()}`).toBeTruthy()
      const body = (await processRes.json()) as { processed: boolean }
      if (body.processed) {
        processed = true
        break
      }
      // Job not visible yet — retry immediately; finalize commit should already be durable
    }
    expect(processed, 'process-one-job: no job was available after 5 attempts').toBeTruthy()

    // ── 6. Poll You feed deterministically (no waitForTimeout) ────────────────
    // page.request carries the host's session cookie.
    await waitForYouFeedPhotos(page.request, pocketId, 1)

    // ── 7. Assert the feed has photos via API ─────────────────────────────────
    const feedRes = await page.request.get(`/api/events/${pocketId}/you`)
    expect(feedRes.ok()).toBeTruthy()
    const { photos } = (await feedRes.json()) as {
      photos: Array<{ photoId: string; previewUrl: string; distance: number }>
    }
    expect(photos.length).toBeGreaterThanOrEqual(1)

    // Distance should be a finite number — NaN/Infinity indicates a broken embedding
    const [topPhoto] = photos
    expect(topPhoto.photoId).toBeTruthy()
    expect(Number.isFinite(topPhoto.distance)).toBeTruthy()
  },
)
