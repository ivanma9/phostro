import { expect, test, vi } from 'vitest'
import { POST } from '@/app/api/auth/logout/route'

const destroy = vi.fn()

vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(async () => ({ destroy })),
}))

test('destroys the session and returns ok', async () => {
  destroy.mockClear()

  const res = await POST()

  expect(destroy).toHaveBeenCalledTimes(1)
  expect(res.status).toBe(200)
  await expect(res.json()).resolves.toEqual({ ok: true })
})
