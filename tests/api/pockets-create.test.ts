import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { beforeEach, expect, test, vi } from 'vitest'
import { POST } from '@/app/api/pockets/route'
import { db } from '@/db'
import { eventMembers, events, shareLinks, userFaceEmbeddings, users } from '@/db/schema'
import { FACE_SCAN_ANGLES } from '@/lib/auth/face-enrollment'
import * as currentUser from '@/lib/auth/current-user'
import * as shareLinkStorage from '@/lib/share-links/storage'

beforeEach(async () => {
  await db.delete(eventMembers)
  await db.delete(shareLinks)
  await db.delete(events)
  await db.delete(userFaceEmbeddings)
  await db.delete(users)
  vi.restoreAllMocks()
})

async function asUser(name = 'Owner', contact = 'owner@x.com', enrolled = true) {
  const [u] = await db
    .insert(users)
    .values({ name, contact, contactType: 'email' })
    .returning()
  if (enrolled) {
    // Three deterministic 512-d vectors (one per angle) so the user passes the
    // enrolled-3-of-3 gate on /api/pockets POST.
    for (let idx = 0; idx < FACE_SCAN_ANGLES.length; idx++) {
      const angle = FACE_SCAN_ANGLES[idx]
      const vec = Array.from({ length: 512 }, (_, i) => (i + idx + 1) / 1024)
      let sumSq = 0
      for (const v of vec) sumSq += v * v
      const norm = Math.sqrt(sumSq) || 1
      await db.insert(userFaceEmbeddings).values({
        userId: u.id,
        angle,
        embedding: vec.map((v) => v / norm),
        qualityScore: 90,
        yaw: angle === 'left' ? -0.25 : angle === 'right' ? 0.25 : 0,
        previewR2Key: `enrollment/${u.id}/${angle}.jpg`,
      })
    }
  }
  vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(u)
  return u
}

function makeReq(body: unknown) {
  return new Request('http://t/api/pockets', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

// Case 1: 401 unauthenticated
test('returns 401 when not authenticated', async () => {
  vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(null)
  const res = await POST(makeReq({ name: 'My Pocket' }))
  expect(res.status).toBe(401)
})

// Case 2a: 412 when caller has no enrolled face — pocket page is unusable without it
test('returns 412 when user is not enrolled', async () => {
  await asUser('NoFace', 'noface@x.com', false)
  const res = await POST(makeReq({ name: 'My Pocket' }))
  expect(res.status).toBe(412)
  const body = await res.json()
  expect(body.error).toBe('not_enrolled')
  expect(body.remainingAngles).toEqual(['frontal', 'left', 'right'])
})

// Case 2: 400 invalid name
test('returns 400 for empty name', async () => {
  await asUser()
  const res = await POST(makeReq({ name: '' }))
  expect(res.status).toBe(400)
})

test('returns 400 for name too long (>100 chars)', async () => {
  await asUser()
  const res = await POST(makeReq({ name: 'a'.repeat(101) }))
  expect(res.status).toBe(400)
})

test('returns 400 for whitespace-only name', async () => {
  await asUser()
  const res = await POST(makeReq({ name: '   ' }))
  expect(res.status).toBe(400)
})

// Case 3: 200 success with full DB assertions
test('creates pocket with correct DB state and returns pocketId + shareUrl', async () => {
  const u = await asUser()
  const res = await POST(makeReq({ name: "Alice's Pocket" }))
  expect(res.status).toBe(200)

  const body = await res.json()
  const { pocketId, shareUrl } = body
  expect(typeof pocketId).toBe('string')
  expect(typeof shareUrl).toBe('string')

  // events row: visibility_mode === 'personal', host_user_id === user.id
  const [event] = await db.select().from(events).where(eq(events.id, pocketId))
  expect(event).toBeDefined()
  expect(event.visibilityMode).toBe('personal')
  expect(event.hostUserId).toBe(u.id)
  expect(event.name).toBe("Alice's Pocket")
  expect(event.lifespanDays).toBe(30)

  // event_members row: role === 'host'
  const [member] = await db.select().from(eventMembers).where(eq(eventMembers.eventId, pocketId))
  expect(member).toBeDefined()
  expect(member.role).toBe('host')
  expect(member.userId).toBe(u.id)

  // share_links row: event_id === pocketId, revokedAt === null
  const [link] = await db.select().from(shareLinks).where(eq(shareLinks.eventId, pocketId))
  expect(link).toBeDefined()
  expect(link.eventId).toBe(pocketId)
  expect(link.revokedAt).toBeNull()
  expect(link.maxUploads).toBeNull()

  // Share link expiry is decoupled from pocket's 30-day events.expires_at placeholder;
  // it must be at least 6 months in the future.
  const sixMonthsFromNow = new Date(Date.now() + 6 * 30 * 24 * 60 * 60 * 1000)
  expect(link.expiresAt.getTime()).toBeGreaterThan(sixMonthsFromNow.getTime())

  // shareUrl matches APP_URL/p/<64-hex>
  const appUrl = process.env.APP_URL
  const urlPattern = new RegExp(
    `^${appUrl?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/p/[0-9a-f]{64}$`,
  )
  expect(shareUrl).toMatch(urlPattern)

  // tokenHash === sha256(token from shareUrl)
  const token = shareUrl.split('/p/')[1]
  const expectedHash = createHash('sha256').update(token).digest('hex')
  expect(link.tokenHash).toBe(expectedHash)
})

// Case 4: mintShareLink throws → 500 with JSON body { error: 'share_link_failed' }
test('returns 500 with share_link_failed when mintShareLink throws', async () => {
  await asUser()
  vi.spyOn(shareLinkStorage, 'mintShareLink').mockRejectedValue(new Error('DB unavailable'))
  const res = await POST(makeReq({ name: 'Test Pocket' }))
  expect(res.status).toBe(500)
  const body = await res.json()
  expect(body).toEqual({ error: 'share_link_failed' })
})

// Case 5: events insert throws → 500 with JSON body { error: 'create_failed' }
test('returns 500 with create_failed when events insert throws', async () => {
  await asUser()
  vi.spyOn(db, 'insert').mockImplementationOnce(() => {
    throw new Error('DB unavailable')
  })
  const res = await POST(makeReq({ name: 'Test Pocket' }))
  expect(res.status).toBe(500)
  const body = await res.json()
  expect(body).toEqual({ error: 'create_failed' })
})
