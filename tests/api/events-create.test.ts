import { eq } from 'drizzle-orm'
import { beforeEach, expect, test, vi } from 'vitest'
import { POST } from '@/app/api/events/route'
import { db } from '@/db'
import { eventMembers, events, users } from '@/db/schema'
import * as currentUser from '@/lib/auth/current-user'

beforeEach(async () => {
  await db.delete(eventMembers)
  await db.delete(events)
  await db.delete(users)
  vi.restoreAllMocks()
})

async function asUser(name = 'Host', contact = 'host@x.com') {
  const [u] = await db.insert(users).values({ name, contact, contactType: 'email' }).returning()
  vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(u)
  return u
}

test('creates event with default 7-day lifespan and host membership', async () => {
  const u = await asUser()
  const res = await POST(
    new Request('http://t/api/events', {
      method: 'POST',
      body: JSON.stringify({ name: "Sarah's Birthday" }),
      headers: { 'content-type': 'application/json' },
    }),
  )
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.event.name).toBe("Sarah's Birthday")
  expect(body.event.lifespanDays).toBe(7)
  expect(body.event.visibilityMode).toBe('personal')

  const expiresAt = new Date(body.event.expiresAt)
  const sevenDaysFromNow = Date.now() + 7 * 24 * 60 * 60 * 1000
  expect(Math.abs(expiresAt.getTime() - sevenDaysFromNow)).toBeLessThan(5000)

  const [member] = await db.select().from(eventMembers).where(eq(eventMembers.userId, u.id))
  expect(member.role).toBe('host')
  expect(member.eventId).toBe(body.event.id)
})

test('returns 401 when not authenticated', async () => {
  vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(null)
  const res = await POST(
    new Request('http://t/api/events', {
      method: 'POST',
      body: JSON.stringify({ name: 'Anything' }),
      headers: { 'content-type': 'application/json' },
    }),
  )
  expect(res.status).toBe(401)
})

test('rejects invalid name and lifespan', async () => {
  await asUser()
  const r1 = await POST(
    new Request('http://t/api/events', {
      method: 'POST',
      body: JSON.stringify({ name: '' }),
      headers: { 'content-type': 'application/json' },
    }),
  )
  expect(r1.status).toBe(400)
  const r2 = await POST(
    new Request('http://t/api/events', {
      method: 'POST',
      body: JSON.stringify({ name: 'OK', lifespanDays: 99 }),
      headers: { 'content-type': 'application/json' },
    }),
  )
  expect(r2.status).toBe(400)
})
