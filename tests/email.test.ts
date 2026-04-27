import { expect, test, vi } from 'vitest'
import { sendMagicLinkEmail } from '@/lib/email'

vi.mock('resend', () => {
  class Resend {
    emails = {
      send: vi.fn().mockResolvedValue({ data: { id: 'abc' }, error: null }),
    }
  }
  return { Resend }
})

test('sendMagicLinkEmail returns the Resend id', async () => {
  const result = await sendMagicLinkEmail({
    to: 'a@b.com',
    link: 'https://app.test/auth?token=xyz',
  })
  expect(result.id).toBe('abc')
})
