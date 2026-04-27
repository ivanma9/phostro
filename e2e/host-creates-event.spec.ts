import { expect, test } from '@playwright/test'

test('sign-in form submits and shows confirmation', async ({ page }) => {
  await page.goto('/auth/signin')
  await page.getByPlaceholder('Your name').fill('Test Host')
  await page.getByPlaceholder('email@example.com').fill('test+e2e@example.com')
  await page.getByRole('button', { name: /send magic link/i }).click()
  await expect(page.getByText(/test\+e2e@example\.com/i)).toBeVisible()
})

test('unauthenticated request to /events/new redirects to sign-in', async ({ page }) => {
  await page.goto('/events/new')
  await expect(page).toHaveURL(/\/auth\/signin/)
})
