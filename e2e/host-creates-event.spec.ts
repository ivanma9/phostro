import { expect, type Page, test } from '@playwright/test'

async function login(page: Page, contact: string, name: string) {
  const res = await page.request.post('/api/test-login', {
    data: { contact, name },
  })
  expect(res.ok()).toBeTruthy()
}

test('sign-in form submits and shows confirmation', async ({ page }) => {
  await page.goto('/auth/signin')
  await page.getByPlaceholder('Your name').fill('Test Host')
  await page.getByPlaceholder('email@example.com').fill('test+e2e@example.com')
  await page.getByRole('button', { name: /send magic link/i }).click()
  await expect(page.getByText(/test\+e2e@example\.com/i)).toBeVisible()
})

test('host creates an event and lands on the share page', async ({ page }) => {
  await login(page, 'host+e2e@example.com', 'Test Host')

  await page.goto('/events/new')
  await page.getByPlaceholder('Event name').fill("Sarah's Birthday")
  await page.getByRole('button', { name: /create event/i }).click()

  await expect(page).toHaveURL(/\/events\/[0-9a-f-]+$/)
  await expect(page.getByRole('heading', { name: "Sarah's Birthday" })).toBeVisible()
  await expect(page.locator('input[readonly]')).toHaveValue(/\/events\/[0-9a-f-]+\/join$/)
})

test('attendee follows the join link and becomes a member', async ({ page }) => {
  await login(page, 'host+join@example.com', 'Host')

  const createRes = await page.request.post('/api/events', {
    data: { name: 'Join Test Event' },
  })
  expect(createRes.ok()).toBeTruthy()
  const { event } = (await createRes.json()) as { event: { id: string } }

  await login(page, 'attendee@example.com', 'Attendee')
  await page.goto(`/events/${event.id}/join`)

  await expect(page).toHaveURL(new RegExp(`/events/${event.id}$`))
  await expect(page.getByRole('heading', { name: 'Join Test Event' })).toBeVisible()

  const eventRes = await page.request.get(`/api/events/${event.id}`)
  expect(eventRes.ok()).toBeTruthy()
  const body = await eventRes.json()
  expect(body.role).toBe('attendee')
})

test('unauthenticated request to /events/new redirects to sign-in', async ({ page }) => {
  await page.goto('/events/new')
  await expect(page).toHaveURL(/\/auth\/signin/)
})
