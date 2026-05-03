import { beforeEach, expect, test, vi } from 'vitest'
import { POST } from '@/app/api/pockets/[id]/share-links/route'
import { db } from '@/db'
import { eventMembers, events, shareLinks, users } from '@/db/schema'
import * as currentUser from '@/lib/auth/current-user'

beforeEach(async () => {
  await db.delete(shareLinks)
  await db.delete(eventMembers)
  await db.delete(events)
  await db.delete(users)
  vi.restoreAllMocks()
})

async function seedUser(suffix: string) {
  const [u] = await db
    .insert(users)
    .values({ name: `U-${suffix}`, contact: `psl_${suffix}@x.com`, contactType: 'email' })
    .returning()
  return u
}

async function seedPocket(hostId: string, suffix: string) {
  const [e] = await db
    .insert(events)
    .values({
      hostUserId: hostId,
      name: `Pocket-${suffix}`,
      visibilityMode: 'personal',
      lifespanDays: 30,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    })
    .returning()
  await db.insert(eventMembers).values({ eventId: e.id, userId: hostId, role: 'host' })
  return e
}

function makeReq(id: string) {
  return new Request(`http://t/api/pockets/${id}/share-links`, { method: 'POST' })
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) }
}

// Case 1: 401 unauthenticated
test('returns 401 when not authenticated', async () => {
  vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(null)
  const res = await POST(
    makeReq('00000000-0000-0000-0000-000000000001'),
    makeParams('00000000-0000-0000-0000-000000000001'),
  )
  expect(res.status).toBe(401)
})

// Case 2: 404 nonexistent pocket
test('returns 404 for nonexistent pocket', async () => {
  const u = await seedUser('404')
  vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(u)
  const res = await POST(
    makeReq('00000000-0000-0000-0000-000000000099'),
    makeParams('00000000-0000-0000-0000-000000000099'),
  )
  expect(res.status).toBe(404)
})

// Case 3: 403 not the host
test('returns 403 when caller is not the host', async () => {
  const owner = await seedUser('owner-403')
  const other = await seedUser('other-403')
  const pocket = await seedPocket(owner.id, '403')
  vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(other)
  const res = await POST(makeReq(pocket.id), makeParams(pocket.id))
  expect(res.status).toBe(403)
})

// Case 4: happy path — mints new share link and returns shareUrl
test('mints a new share link and returns shareUrl', async () => {
  const owner = await seedUser('owner-happy')
  const pocket = await seedPocket(owner.id, 'happy')
  vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(owner)
  const res = await POST(makeReq(pocket.id), makeParams(pocket.id))
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(typeof body.shareUrl).toBe('string')
  expect(body.shareUrl).toContain('/p/')
})

// Case 5: minting a second link does NOT revoke the first
test('second mint does not revoke previous share links', async () => {
  const owner = await seedUser('owner-multi')
  const pocket = await seedPocket(owner.id, 'multi')
  vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(owner)

  await POST(makeReq(pocket.id), makeParams(pocket.id))
  await POST(makeReq(pocket.id), makeParams(pocket.id))

  const links = await db
    .select()
    .from(shareLinks)
    .where((await import('drizzle-orm')).eq(shareLinks.eventId, pocket.id))
  expect(links).toHaveLength(2)
  expect(links.every((l) => l.revokedAt === null)).toBe(true)
})
