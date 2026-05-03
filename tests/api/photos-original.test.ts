import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { GET } from '@/app/api/photos/[photoId]/original/route'
import { db } from '@/db'
import { eventMembers, events, photos, shareLinks, users } from '@/db/schema'
import * as currentUser from '@/lib/auth/current-user'

vi.mock('@/lib/photos/r2', () => ({
  createPresignedGetUrl: vi.fn(async (key: string) => `https://fake.r2/${key}?signature=x`),
}))

async function seed() {
  const [host] = await db
    .insert(users)
    .values({ name: 'Host', contact: 'h@x.com', contactType: 'email' })
    .returning()
  const [event] = await db
    .insert(events)
    .values({
      hostUserId: host.id,
      name: 'E',
      expiresAt: new Date(Date.now() + 7 * 86400 * 1000),
    })
    .returning()
  await db.insert(eventMembers).values({ eventId: event.id, userId: host.id, role: 'host' })
  const [photo] = await db
    .insert(photos)
    .values({
      eventId: event.id,
      uploaderUserId: host.id,
      processingState: 'ready',
      r2KeyOriginal: `events/${event.id}/original/x.jpg`,
      r2KeyPreview: `events/${event.id}/preview/x.jpg`,
      declaredMimeType: 'image/jpeg',
      declaredSizeBytes: 1,
    })
    .returning()
  return { host, event, photo }
}

beforeEach(async () => {
  await db.delete(photos)
  await db.delete(shareLinks)
  await db.delete(eventMembers)
  await db.delete(events)
  await db.delete(users)
  vi.restoreAllMocks()
})

const get = (id: string) =>
  GET(new Request(`http://t/api/photos/${id}/original`), {
    params: Promise.resolve({ photoId: id }),
  })

describe('GET /api/photos/:photoId/original', () => {
  test('302 redirect to presigned URL for uploader', async () => {
    const { host, photo } = await seed()
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(host)
    const res = await get(photo.id)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('signature=')
  })

  test('401 when unauthenticated', async () => {
    const { photo } = await seed()
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(null)
    const res = await get(photo.id)
    expect(res.status).toBe(401)
  })

  test('404 when caller is not uploader (no existence oracle)', async () => {
    const { photo } = await seed()
    const [stranger] = await db
      .insert(users)
      .values({ name: 'S', contact: 's@x.com', contactType: 'email' })
      .returning()
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(stranger)
    const res = await get(photo.id)
    expect(res.status).toBe(404)
  })

  test('404 when photo missing', async () => {
    const { host } = await seed()
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(host)
    const res = await get('00000000-0000-0000-0000-000000000000')
    expect(res.status).toBe(404)
  })

  test('404 when photo state is not ready', async () => {
    const { host, photo } = await seed()
    await db
      .update(photos)
      .set({ processingState: 'pending', r2KeyOriginal: null })
      .where(eq(photos.id, photo.id))
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(host)
    const res = await get(photo.id)
    expect(res.status).toBe(404)
  })

  test('host of a personal-mode pocket can fetch original of a contributor-uploaded photo (uploaderUserId IS NULL, uploaderToken IS NOT NULL)', async () => {
    // Seed host and pocket
    const [host] = await db
      .insert(users)
      .values({ name: 'Host', contact: 'host-contrib@x.com', contactType: 'email' })
      .returning()
    const [event] = await db
      .insert(events)
      .values({
        hostUserId: host.id,
        name: 'Personal Pocket',
        visibilityMode: 'personal',
        expiresAt: new Date(Date.now() + 7 * 86400 * 1000),
      })
      .returning()
    await db.insert(eventMembers).values({ eventId: event.id, userId: host.id, role: 'host' })

    // Mint a share link token (plaintext; only the hash would be stored in production)
    const contributorToken = 'tok_abc123'
    const { createHash } = await import('node:crypto')
    const tokenHash = createHash('sha256').update(contributorToken).digest('hex')
    await db.insert(shareLinks).values({
      eventId: event.id,
      tokenHash,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    })

    // Insert a contributor-uploaded photo: uploaderUserId IS NULL, uploaderToken IS NOT NULL
    const [photo] = await db
      .insert(photos)
      .values({
        eventId: event.id,
        uploaderUserId: null,
        uploaderToken: contributorToken,
        processingState: 'ready',
        r2KeyOriginal: `events/${event.id}/original/contrib.jpg`,
        r2KeyPreview: `events/${event.id}/preview/contrib.jpg`,
        declaredMimeType: 'image/jpeg',
        declaredSizeBytes: 2048,
      })
      .returning()

    // Sign in as the host (not the contributor)
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(host)
    const res = await get(photo.id)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('signature=')
  })
})
