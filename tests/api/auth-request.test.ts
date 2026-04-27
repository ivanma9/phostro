import { eq } from 'drizzle-orm'
import { beforeEach, expect, test } from 'vitest'
import { POST } from '@/app/api/auth/request/route'
import { db } from '@/db'
import { magicLinkTokens } from '@/db/schema'

beforeEach(async () => {
  await db.delete(magicLinkTokens)
})

const post = (body: unknown) =>
  POST(
    new Request('http://test/api/auth/request', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
  )

test('creates a magic link token row', async () => {
  const res = await post({ contact: 'a@b.com', name: 'Alice' })
  expect(res.status).toBe(200)
  const rows = await db.select().from(magicLinkTokens).where(eq(magicLinkTokens.contact, 'a@b.com'))
  expect(rows).toHaveLength(1)
  expect(rows[0].intendedName).toBe('Alice')
  expect(rows[0].contactType).toBe('email')
  expect(rows[0].consumedAt).toBeNull()
  expect(rows[0].intendedRedirect).toBeNull()
  expect(rows[0].expiresAt.getTime()).toBeGreaterThan(Date.now())
})

test('persists safe next= redirect', async () => {
  await post({ contact: 'a@b.com', name: 'A', next: '/events/abc/join' })
  const [row] = await db.select().from(magicLinkTokens)
  expect(row.intendedRedirect).toBe('/events/abc/join')
})

test('drops unsafe next= values', async () => {
  await post({ contact: 'a@b.com', name: 'A', next: '//evil.com' })
  const [row] = await db.select().from(magicLinkTokens)
  expect(row.intendedRedirect).toBeNull()
})

test('caps overlong name to 100 chars', async () => {
  await post({ contact: 'a@b.com', name: 'x'.repeat(500) })
  const [row] = await db.select().from(magicLinkTokens)
  expect(row.intendedName?.length).toBe(100)
})

test('rejects invalid contact', async () => {
  const res = await post({ name: 'NoContact' })
  expect(res.status).toBe(400)
})
