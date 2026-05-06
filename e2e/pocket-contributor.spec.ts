/**
 * pocket-contributor.spec.ts — Anonymous contributor upload via share link.
 *
 * CI requirements:
 *   - Postgres + pgvector at TEST_DATABASE_URL
 *   - Real R2 credentials (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET)
 *     The contributor upload flow generates a presigned PUT URL; there is no local override
 *     seam for the PUT side.
 *
 * Worker is NOT required for this spec — contributor uploads land in 'ready' state and
 * enqueue a job, but processing (face detection) is not exercised here.
 *
 * The spec is skipped when R2 is not configured.
 */

import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { hasR2Config } from './helpers/preconditions'

const fixtureDir = join(process.cwd(), 'tests/fixtures/photos')

test('contributor visits share link and uploads 3 photos', async ({ page, browser }) => {
  test.skip(!hasR2Config(), 'R2 not configured — skipping pocket-contributor spec')

  // ── Setup: create a pocket as host ──────────────────────────────────────────
  // Sign in as host using the host's page context (so cookies are set there)
  const loginRes = await page.request.post('/api/test-login', {
    data: {
      contact: 'pocket-contributor-host+e2e@example.com',
      name: 'E2E Contributor Host',
      enrollFakeFace: true,
    },
  })
  expect(loginRes.ok(), `test-login failed: ${loginRes.status()}`).toBeTruthy()

  const createRes = await page.request.post('/api/pockets', {
    data: { name: 'E2E Contributor Test' },
  })
  expect(createRes.ok(), `pocket create failed: ${createRes.status()}`).toBeTruthy()
  const { shareUrl } = (await createRes.json()) as { pocketId: string; shareUrl: string }
  expect(shareUrl).toMatch(/\/p\/[A-Za-z0-9_-]+$/)

  // Extract token from share URL for later verification
  const token = shareUrl.split('/p/')[1]
  expect(token).toBeTruthy()

  // ── Contributor flow in a fresh incognito context ────────────────────────────
  const contributorContext = await browser.newContext()
  const contributorPage = await contributorContext.newPage()

  try {
    await contributorPage.goto(shareUrl)

    // Verify page shows the host's name and prompt
    await expect(contributorPage.getByText(/asked for/i)).toBeVisible({ timeout: 10_000 })
    await expect(contributorPage.getByText(/E2E Contributor Test/i)).toBeVisible()

    // Click "Add Photos" to trigger the hidden file input
    const fileChooserPromise = contributorPage.waitForEvent('filechooser')
    await contributorPage.getByRole('button', { name: /add photos/i }).click()
    const chooser = await fileChooserPromise
    await chooser.setFiles([
      join(fixtureDir, 'plain.jpg'),
      join(fixtureDir, 'rotated-orientation-6.jpg'),
      join(fixtureDir, 'with-gps.jpg'),
    ])

    // Wait for the "done" terminal state: "Added 3 photos"
    await expect(contributorPage.getByText(/added 3 photos/i)).toBeVisible({ timeout: 60_000 })

    // Verify via DB (debug endpoint): 3 photos exist with uploaderToken set and uploaderUserId null
    // Use the host page's request context — the endpoint is auth-free but NODE_ENV gated.
    const photosRes = await page.request.get(`/api/internal/photos-by-token/${token}`)
    expect(photosRes.ok(), `photos-by-token failed: ${photosRes.status()}`).toBeTruthy()
    const { photos: dbPhotos } = (await photosRes.json()) as {
      photos: Array<{ id: string; uploaderToken: string; uploaderUserId: string | null }>
    }
    expect(dbPhotos).toHaveLength(3)
    for (const p of dbPhotos) {
      expect(p.uploaderToken).toBe(token)
      expect(p.uploaderUserId).toBeNull()
    }
  } finally {
    await contributorContext.close()
  }
})
