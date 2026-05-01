import { beforeEach, expect, test } from 'vitest'
import { db } from '@/db'
import { eventMembers, events, photos, users } from '@/db/schema'
import { countActivePhotos } from '@/lib/photos/cap'

beforeEach(async () => {
  await db.delete(photos)
  await db.delete(eventMembers)
  await db.delete(events)
  await db.delete(users)
})

async function seedEvent() {
  const [u] = await db
    .insert(users)
    .values({ name: 'H', contact: 'h@x.com', contactType: 'email' })
    .returning()
  const [e] = await db
    .insert(events)
    .values({
      hostUserId: u.id,
      name: 'E',
      expiresAt: new Date(Date.now() + 7 * 86400 * 1000),
    })
    .returning()
  return { u, e }
}

test('counts only ready/processing rows + non-expired pending', async () => {
  const { u, e } = await seedEvent()
  const future = new Date(Date.now() + 60_000)
  const past = new Date(Date.now() - 60_000)
  await db.insert(photos).values([
    {
      eventId: e.id,
      uploaderUserId: u.id,
      processingState: 'ready',
      declaredMimeType: 'image/jpeg',
      declaredSizeBytes: 1,
    },
    {
      eventId: e.id,
      uploaderUserId: u.id,
      processingState: 'processing',
      declaredMimeType: 'image/jpeg',
      declaredSizeBytes: 1,
    },
    {
      eventId: e.id,
      uploaderUserId: u.id,
      processingState: 'pending',
      pendingExpiresAt: future,
      declaredMimeType: 'image/jpeg',
      declaredSizeBytes: 1,
    },
    {
      eventId: e.id,
      uploaderUserId: u.id,
      processingState: 'pending',
      pendingExpiresAt: past,
      declaredMimeType: 'image/jpeg',
      declaredSizeBytes: 1,
    },
    {
      eventId: e.id,
      uploaderUserId: u.id,
      processingState: 'failed',
      declaredMimeType: 'image/jpeg',
      declaredSizeBytes: 1,
    },
  ])
  expect(await countActivePhotos(e.id)).toBe(3)
})

test('excludes soft-deleted rows', async () => {
  const { u, e } = await seedEvent()
  await db.insert(photos).values({
    eventId: e.id,
    uploaderUserId: u.id,
    processingState: 'ready',
    deletedAt: new Date(),
    declaredMimeType: 'image/jpeg',
    declaredSizeBytes: 1,
  })
  expect(await countActivePhotos(e.id)).toBe(0)
})
