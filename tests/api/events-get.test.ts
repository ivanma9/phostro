import { beforeEach, expect, test, vi } from 'vitest'
import { GET } from '@/app/api/events/[id]/route'
import { db } from '@/db'
import { eventMembers, events, users } from '@/db/schema'
import * as currentUser from '@/lib/auth/current-user'

beforeEach(async () => {
  await db.delete(eventMembers)
  await db.delete(events)
  await db.delete(users)
  vi.restoreAllMocks()
})

async function seedEventWithHost() {
  const [host] = await db
    .insert(users)
    .values({ name: 'Host', contact: 'host@x.com', contactType: 'email' })
    .returning()
  const [event] = await db
    .insert(events)
    .values({
      hostUserId: host.id,
      name: 'Bash',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    })
    .returning()
  await db.insert(eventMembers).values({ eventId: event.id, userId: host.id, role: 'host' })
  return { host, event }
}

const makeReq = (id: string) => new Request(`http://t/api/events/${id}`)

test('returns 401 when unauthenticated', async () => {
  const { event } = await seedEventWithHost()
  vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(null)
  const res = await GET(makeReq(event.id), { params: Promise.resolve({ id: event.id }) })
  expect(res.status).toBe(401)
})

test('returns 404 when event does not exist', async () => {
  const { host } = await seedEventWithHost()
  vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(host)
  const fakeId = '00000000-0000-0000-0000-000000000000'
  const res = await GET(makeReq(fakeId), { params: Promise.resolve({ id: fakeId }) })
  expect(res.status).toBe(404)
})

test('returns 403 when caller is not a member', async () => {
  const { event } = await seedEventWithHost()
  const [stranger] = await db
    .insert(users)
    .values({ name: 'Stranger', contact: 's@x.com', contactType: 'email' })
    .returning()
  vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(stranger)
  const res = await GET(makeReq(event.id), { params: Promise.resolve({ id: event.id }) })
  expect(res.status).toBe(403)
})

test('returns event payload with role for member', async () => {
  const { host, event } = await seedEventWithHost()
  vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(host)
  const res = await GET(makeReq(event.id), { params: Promise.resolve({ id: event.id }) })
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.event.id).toBe(event.id)
  expect(body.role).toBe('host')
})
