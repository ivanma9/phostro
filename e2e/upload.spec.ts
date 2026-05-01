import { join } from 'node:path'
import { expect, test } from '@playwright/test'

test('host signs in, creates event, uploads photos, sees thumbnails', async ({ page }) => {
  // Sign in via test-only route — page.request shares the browser context's cookie jar
  await page.goto('/auth/signin')
  const res = await page.request.post('/api/test-login', {
    data: { contact: 'host+e2e@example.com', name: 'E2E Host' },
  })
  if (!res.ok()) throw new Error(`test-login failed: ${res.status()} ${await res.text()}`)

  // Create event
  await page.goto('/events/new')
  await page.getByPlaceholder('Event name').fill('E2E Photos')
  await page.getByRole('button', { name: /create event/i }).click()

  await expect(page).toHaveURL(/\/events\/[0-9a-f-]+/)

  // Upload three fixture images
  const fixtureDir = join(process.cwd(), 'tests/fixtures/photos')
  const fileChooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: /add photos/i }).click()
  const chooser = await fileChooserPromise
  await chooser.setFiles([
    join(fixtureDir, 'plain.jpg'),
    join(fixtureDir, 'rotated-orientation-6.jpg'),
    join(fixtureDir, 'with-gps.jpg'),
  ])

  // After all uploads complete the component calls window.location.reload().
  // Wait for the navigation that reload triggers, then assert the gallery.
  await page.waitForNavigation({ timeout: 60_000 })
  await page.waitForLoadState('networkidle')
  await expect(page.getByText(/Your uploads \(3\)/i)).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('img[alt=""]')).toHaveCount(3)
})
