import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { POST } from '@/app/api/events/[id]/photos/init/route'
import { db } from '@/db'
import { eventMembers, events, photos, users } from '@/db/schema'
import * as currentUser from '@/lib/auth/current-user'

vi.mock('@/lib/photos/r2', () => ({
  createPresignedPutUrl: vi.fn(async (key: string) => `https://fake.r2/${key}?signature=x`),
}))

async function seed(opts: { expired?: boolean } = {}) {
  const [host] = await db
    .insert(users)
    .values({ name: 'Host', contact: 'h@x.com', contactType: 'email' })
    .returning()
  const expiresAt = opts.expired
    ? new Date(Date.now() - 86400 * 1000)
    : new Date(Date.now() + 7 * 86400 * 1000)
  const [event] = await db
    .insert(events)
    .values({ hostUserId: host.id, name: 'E', expiresAt })
    .returning()
  await db.insert(eventMembers).values({ eventId: event.id, userId: host.id, role: 'host' })
  return { host, event }
}

beforeEach(async () => {
  await db.delete(photos)
  await db.delete(eventMembers)
  await db.delete(events)
  await db.delete(users)
  vi.restoreAllMocks()
})

const post = (eventId: string, body: unknown) =>
  POST(
    new Request(`http://t/api/events/${eventId}/photos/init`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: eventId }) },
  )

describe('POST /api/events/:id/photos/init', () => {
  test('happy path inserts photos row and returns presigned URL', async () => {
    const { host, event } = await seed()
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(host)
    const res = await post(event.id, {
      filename: 'IMG_001.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 1_000_000,
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.photoId).toBeTypeOf('string')
    expect(body.putUrl).toContain('events/')
    const [row] = await db.select().from(photos).where(eq(photos.id, body.photoId))
    expect(row.processingState).toBe('pending')
    expect(row.uploaderUserId).toBe(host.id)
    expect(row.eventId).toBe(event.id)
    expect(row.declaredMimeType).toBe('image/jpeg')
    expect(row.declaredSizeBytes).toBe(1_000_000)
    expect(row.originalFilename).toBe('IMG_001.jpg')
    expect(row.pendingKey).toBe(`events/${event.id}/pending/${body.photoId}.bin`)
    expect(row.pendingExpiresAt?.getTime()).toBeGreaterThan(Date.now())
  })

  test('401 when not authenticated', async () => {
    const { event } = await seed()
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(null)
    const res = await post(event.id, { filename: 'a.jpg', mimeType: 'image/jpeg', sizeBytes: 1 })
    expect(res.status).toBe(401)
  })

  test('403 when not a member', async () => {
    const { event } = await seed()
    const [other] = await db
      .insert(users)
      .values({ name: 'O', contact: 'o@x.com', contactType: 'email' })
      .returning()
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(other)
    const res = await post(event.id, { filename: 'a.jpg', mimeType: 'image/jpeg', sizeBytes: 1 })
    expect(res.status).toBe(403)
  })

  test('410 when event is expired', async () => {
    const { host, event } = await seed({ expired: true })
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(host)
    const res = await post(event.id, { filename: 'a.jpg', mimeType: 'image/jpeg', sizeBytes: 1 })
    expect(res.status).toBe(410)
  })

  test('400 for disallowed MIME', async () => {
    const { host, event } = await seed()
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(host)
    const res = await post(event.id, { filename: 'v.mp4', mimeType: 'video/mp4', sizeBytes: 1 })
    expect(res.status).toBe(400)
  })

  test('413 for declared size > 25 MB', async () => {
    const { host, event } = await seed()
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(host)
    const res = await post(event.id, {
      filename: 'big.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 26 * 1024 * 1024,
    })
    expect(res.status).toBe(413)
  })

  test('429 when event cap reached', async () => {
    const { host, event } = await seed()
    // Seed 5000 ready photos.
    const future = new Date(Date.now() + 60_000)
    const rows = Array.from({ length: 5000 }, () => ({
      eventId: event.id,
      uploaderUserId: host.id,
      processingState: 'ready' as const,
      declaredMimeType: 'image/jpeg',
      declaredSizeBytes: 1,
      pendingExpiresAt: future,
    }))
    // Bulk insert in chunks of 500 to keep parameters manageable.
    for (let i = 0; i < rows.length; i += 500) {
      await db.insert(photos).values(rows.slice(i, i + 500))
    }
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(host)
    const res = await post(event.id, { filename: 'a.jpg', mimeType: 'image/jpeg', sizeBytes: 1 })
    expect(res.status).toBe(429)
  })

  test('truncates oversized originalFilename', async () => {
    const { host, event } = await seed()
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(host)
    const res = await post(event.id, {
      filename: `${'x'.repeat(1000)}.jpg`,
      mimeType: 'image/jpeg',
      sizeBytes: 1,
    })
    const body = await res.json()
    const [row] = await db.select().from(photos).where(eq(photos.id, body.photoId))
    expect(row.originalFilename?.length).toBe(255)
  })
})
