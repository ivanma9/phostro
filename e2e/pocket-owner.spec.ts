/**
 * pocket-owner.spec.ts — Pocket creation flow from the host's perspective.
 *
 * CI requirements:
 *   - Postgres + pgvector at TEST_DATABASE_URL
 *   - Worker (uvicorn) at WORKER_URL (default http://localhost:8000)
 *     for selfie enrollment via /api/me/face
 *   - R2 credentials are NOT required for this spec (enrollment uses putObject
 *     server-side; the spec never generates a presigned GET/PUT URL for the browser)
 *
 * The spec is skipped when the worker is unreachable because the selfie enrollment
 * step calls the Python face-detection worker.
 */

import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { isWorkerHealthy } from './helpers/preconditions'

const fixtureDir = join(process.cwd(), 'tests/fixtures/photos')

test('host creates a pocket: name → selfie → share link → open pocket', async ({
  page,
  context,
}) => {
  const workerOk = await isWorkerHealthy()
  test.skip(!workerOk, 'Worker not reachable — skipping pocket-owner spec')

  // Grant clipboard-write so navigator.clipboard.writeText succeeds in headless Chromium
  await context.grantPermissions(['clipboard-write'])

  // 1. Sign in
  const loginRes = await page.request.post('/api/test-login', {
    data: { contact: 'pocket-owner+e2e@example.com', name: 'E2E Pocket Owner' },
  })
  expect(loginRes.ok(), `test-login failed: ${loginRes.status()}`).toBeTruthy()

  // 2. Navigate to /pockets/new
  await page.goto('/pockets/new')
  await expect(page.getByRole('heading', { name: /new pocket/i })).toBeVisible()

  // 3. Fill pocket name and click Next
  await page.getByPlaceholder('Pocket name').fill('E2E Graduation Party')
  await page.getByRole('button', { name: /next/i }).click()

  // 4. Upload selfie via file picker (triggered by the hidden file input)
  // The selfie phase renders an <input type="file"> — no button labeled "Choose selfie"
  // but the input is rendered with the instructional text visible. Set files directly.
  await expect(page.getByText(/take a quick selfie/i)).toBeVisible()
  const fileInput = page.locator('input[type="file"]')
  await fileInput.setInputFiles(join(fixtureDir, 'plain.jpg'))

  // 5. Wait for enrollment success — "Looks great!" quality confirmation appears
  await expect(page.getByText(/looks great/i)).toBeVisible({ timeout: 30_000 })

  // 6. Confirm enrollment → create pocket
  await page.getByRole('button', { name: /create pocket/i }).click()

  // 7. Wait for the share URL to appear
  const shareInput = page.locator('input[readonly]')
  await expect(shareInput).toBeVisible({ timeout: 15_000 })
  const shareUrl = await shareInput.inputValue()
  expect(shareUrl).toMatch(/\/p\/[A-Za-z0-9_-]+$/)

  // 8. Copy share link — verify clipboard feedback
  await page.getByRole('button', { name: /copy share link/i }).click()
  await expect(page.getByRole('button', { name: /copied!/i })).toBeVisible({ timeout: 3_000 })

  // 9. Open pocket — navigate to /pockets/[id]
  await page.getByRole('button', { name: /open pocket/i }).click()
  await expect(page).toHaveURL(/\/pockets\/[0-9a-f-]+$/, { timeout: 10_000 })

  // 10. Pocket page shows name and empty state
  await expect(page.getByRole('heading', { name: /E2E Graduation Party/i })).toBeVisible()
  await expect(page.getByText(/no photos yet|share your link/i)).toBeVisible()
})
