import { eq } from 'drizzle-orm'
import { beforeEach, expect, test } from 'vitest'
import { POST } from '@/app/api/auth/request/route'
import { db } from '@/db'
import { magicLinkTokens } from '@/db/schema'

beforeEach(async () => {
  await db.delete(magicLinkTokens)
})

test('creates a magic link token row', async () => {
  const req = new Request('http://test/api/auth/request', {
    method: 'POST',
    body: JSON.stringify({ contact: 'a@b.com', name: 'Alice' }),
    headers: { 'content-type': 'application/json' },
  })
  const res = await POST(req)
  expect(res.status).toBe(200)
  const rows = await db.select().from(magicLinkTokens).where(eq(magicLinkTokens.contact, 'a@b.com'))
  expect(rows).toHaveLength(1)
  expect(rows[0].intendedName).toBe('Alice')
  expect(rows[0].contactType).toBe('email')
  expect(rows[0].consumedAt).toBeNull()
  expect(rows[0].expiresAt.getTime()).toBeGreaterThan(Date.now())
})

test('rejects invalid contact', async () => {
  const req = new Request('http://test/api/auth/request', {
    method: 'POST',
    body: JSON.stringify({ name: 'NoContact' }),
    headers: { 'content-type': 'application/json' },
  })
  const res = await POST(req)
  expect(res.status).toBe(400)
})
