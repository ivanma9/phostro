import { beforeEach, expect, test, vi } from 'vitest'
import { db } from '@/db'
import { eventMembers, events, photos, users } from '@/db/schema'
import { listMyPhotos } from '@/lib/photos/gallery'

vi.mock('@/lib/photos/r2', () => ({
  createPresignedGetUrl: vi.fn(async (key: string) => `https://fake/${key}?sig=x`),
}))

async function seed() {
  const [u] = await db
    .insert(users)
    .values({ name: 'U', contact: 'u@x.com', contactType: 'email' })
    .returning()
  const [e] = await db
    .insert(events)
    .values({
      hostUserId: u.id,
      name: 'E',
      expiresAt: new Date(Date.now() + 86400 * 1000),
    })
    .returning()
  await db.insert(eventMembers).values({ eventId: e.id, userId: u.id, role: 'host' })
  return { u, e }
}

beforeEach(async () => {
  await db.delete(photos)
  await db.delete(eventMembers)
  await db.delete(events)
  await db.delete(users)
})

test('lists only ready non-deleted photos for the uploader', async () => {
  const { u, e } = await seed()
  await db.insert(photos).values([
    {
      eventId: e.id,
      uploaderUserId: u.id,
      processingState: 'ready',
      r2KeyPreview: 'preview/1',
      declaredMimeType: 'image/jpeg',
      declaredSizeBytes: 1,
    },
    {
      eventId: e.id,
      uploaderUserId: u.id,
      processingState: 'pending',
      r2KeyPreview: null,
      declaredMimeType: 'image/jpeg',
      declaredSizeBytes: 1,
    },
    {
      eventId: e.id,
      uploaderUserId: u.id,
      processingState: 'ready',
      r2KeyPreview: 'preview/2',
      deletedAt: new Date(),
      declaredMimeType: 'image/jpeg',
      declaredSizeBytes: 1,
    },
  ])
  const out = await listMyPhotos(e.id, u.id)
  expect(out).toHaveLength(1)
  expect(out[0].previewUrl).toBe('https://fake/preview/1?sig=x')
})

test('returns empty list for non-uploader', async () => {
  const { e } = await seed()
  const [other] = await db
    .insert(users)
    .values({ name: 'O', contact: 'o@x.com', contactType: 'email' })
    .returning()
  await db.insert(photos).values({
    eventId: e.id,
    uploaderUserId: e.hostUserId,
    processingState: 'ready',
    r2KeyPreview: 'preview/1',
    declaredMimeType: 'image/jpeg',
    declaredSizeBytes: 1,
  })
  expect(await listMyPhotos(e.id, other.id)).toEqual([])
})
