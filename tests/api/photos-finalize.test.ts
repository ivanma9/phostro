import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { POST } from '@/app/api/events/[id]/photos/[photoId]/finalize/route'
import { db } from '@/db'
import { eventMembers, events, photoJobs, photos, users } from '@/db/schema'
import * as currentUser from '@/lib/auth/current-user'

const FIX = join(__dirname, '../fixtures/photos')

const store = new Map<string, Buffer>()

vi.mock('@/lib/photos/r2', () => ({
  createPresignedGetUrl: vi.fn(async (key: string) => `https://fake.r2/${key}?signature=x`),
  headObject: vi.fn(async (key: string) =>
    store.has(key) ? { contentLength: store.get(key)?.length } : null,
  ),
  getObjectBuffer: vi.fn(async (key: string) => {
    const b = store.get(key)
    if (!b) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' })
    return b
  }),
  putObject: vi.fn(async (key: string, body: Buffer) => {
    store.set(key, body)
  }),
  deleteObject: vi.fn(async (key: string) => {
    store.delete(key)
  }),
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
  return { host, event }
}

async function insertPending(eventId: string, uploaderUserId: string, filename = 'a.jpg') {
  const [row] = await db
    .insert(photos)
    .values({
      eventId,
      uploaderUserId,
      processingState: 'pending',
      pendingExpiresAt: new Date(Date.now() + 60_000),
      pendingKey: '',
      declaredMimeType: 'image/jpeg',
      declaredSizeBytes: 1,
      originalFilename: filename,
    })
    .returning()
  const key = `events/${eventId}/pending/${row.id}.bin`
  await db.update(photos).set({ pendingKey: key }).where(eq(photos.id, row.id))
  return { ...row, pendingKey: key }
}

beforeEach(async () => {
  store.clear()
  await db.delete(photoJobs)
  await db.delete(photos)
  await db.delete(eventMembers)
  await db.delete(events)
  await db.delete(users)
  vi.restoreAllMocks()
})

const post = (eventId: string, photoId: string) =>
  POST(
    new Request(`http://t/api/events/${eventId}/photos/${photoId}/finalize`, { method: 'POST' }),
    {
      params: Promise.resolve({ id: eventId, photoId }),
    },
  )

describe('POST /api/events/:id/photos/:photoId/finalize', () => {
  test('happy path: pending → processing → ready', async () => {
    const { host, event } = await seed()
    const row = await insertPending(event.id, host.id)
    store.set(row.pendingKey, readFileSync(join(FIX, 'plain.jpg')))
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(host)

    const res = await post(event.id, row.id)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.photo.processingState).toBe('ready')

    const [final] = await db.select().from(photos).where(eq(photos.id, row.id))
    expect(final.processingState).toBe('ready')
    expect(final.r2KeyOriginal).toBe(`events/${event.id}/original/${row.id}.jpg`)
    expect(final.r2KeyPreview).toBe(`events/${event.id}/preview/${row.id}.jpg`)
    expect(final.width).toBe(800)
    expect(final.height).toBe(600)
    expect(final.uploadedAt).not.toBeNull()
    expect(final.pendingKey).toBeNull()

    expect(store.has(row.pendingKey)).toBe(false)
    expect(store.has(final.r2KeyOriginal ?? '')).toBe(true)
    expect(store.has(final.r2KeyPreview ?? '')).toBe(true)
  })

  test('403 when caller is not the uploader', async () => {
    const { host, event } = await seed()
    const row = await insertPending(event.id, host.id)
    store.set(row.pendingKey, readFileSync(join(FIX, 'plain.jpg')))
    const [stranger] = await db
      .insert(users)
      .values({ name: 'S', contact: 's@x.com', contactType: 'email' })
      .returning()
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(stranger)
    const res = await post(event.id, row.id)
    expect(res.status).toBe(403)
  })

  test('410 when row is expired', async () => {
    const { host, event } = await seed()
    const row = await insertPending(event.id, host.id)
    await db
      .update(photos)
      .set({ pendingExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(photos.id, row.id))
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(host)
    const res = await post(event.id, row.id)
    expect(res.status).toBe(410)
    const [final] = await db.select().from(photos).where(eq(photos.id, row.id))
    expect(final.processingState).toBe('failed')
  })

  test('idempotent: second finalize on a ready row returns 200 with same row', async () => {
    const { host, event } = await seed()
    const row = await insertPending(event.id, host.id)
    store.set(row.pendingKey, readFileSync(join(FIX, 'plain.jpg')))
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(host)
    const r1 = await post(event.id, row.id)
    expect(r1.status).toBe(200)
    const r2 = await post(event.id, row.id)
    expect(r2.status).toBe(200)
    const b2 = await r2.json()
    expect(b2.photo.processingState).toBe('ready')
  })

  test('413 when actual content-length > 25 MB', async () => {
    const { host, event } = await seed()
    const row = await insertPending(event.id, host.id)
    store.set(row.pendingKey, Buffer.alloc(26 * 1024 * 1024))
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(host)
    const res = await post(event.id, row.id)
    expect(res.status).toBe(413)
    const [final] = await db.select().from(photos).where(eq(photos.id, row.id))
    expect(final.processingState).toBe('failed')
    expect(store.has(row.pendingKey)).toBe(false)
  })

  test('410 when pending object missing in R2', async () => {
    const { host, event } = await seed()
    const row = await insertPending(event.id, host.id)
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(host)
    const res = await post(event.id, row.id)
    expect(res.status).toBe(410)
    const [final] = await db.select().from(photos).where(eq(photos.id, row.id))
    expect(final.processingState).toBe('failed')
  })

  test('422 when Sharp fails on garbage bytes', async () => {
    const { host, event } = await seed()
    const row = await insertPending(event.id, host.id)
    store.set(row.pendingKey, Buffer.from('not an image'))
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(host)
    const res = await post(event.id, row.id)
    expect(res.status).toBe(422)
    const [final] = await db.select().from(photos).where(eq(photos.id, row.id))
    expect(final.processingState).toBe('failed')
    expect(store.has(row.pendingKey)).toBe(false)
  })

  test('atomic claim: stale processing row is reclaimed', async () => {
    const { host, event } = await seed()
    const row = await insertPending(event.id, host.id)
    await db
      .update(photos)
      .set({
        processingState: 'processing',
        processingClaimedAt: new Date(Date.now() - 6 * 60 * 1000),
      })
      .where(eq(photos.id, row.id))
    store.set(row.pendingKey, readFileSync(join(FIX, 'plain.jpg')))
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(host)
    const res = await post(event.id, row.id)
    expect(res.status).toBe(200)
  })

  test('409 when concurrent finalize is recently-claimed', async () => {
    const { host, event } = await seed()
    const row = await insertPending(event.id, host.id)
    await db
      .update(photos)
      .set({ processingState: 'processing', processingClaimedAt: new Date() })
      .where(eq(photos.id, row.id))
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(host)
    const res = await post(event.id, row.id)
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.status).toBe('processing')
  })

  test('after successful finalize, a photo_jobs row exists with kind=detect, state=queued', async () => {
    const { host, event } = await seed()
    const row = await insertPending(event.id, host.id)
    store.set(row.pendingKey, readFileSync(join(FIX, 'plain.jpg')))
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(host)

    const res = await post(event.id, row.id)
    expect(res.status).toBe(200)

    const [job] = await db.select().from(photoJobs).where(eq(photoJobs.photoId, row.id))
    expect(job).toBeDefined()
    expect(job.kind).toBe('detect')
    expect(job.state).toBe('queued')
  })

  test('markFailed does not overwrite a row already in ready state', async () => {
    const { host, event } = await seed()
    const row = await insertPending(event.id, host.id)
    // Race scenario: row was successfully transitioned to 'ready' by a concurrent
    // finalize. Then a stale code path tries to mark it as failed (e.g., its TTL
    // check ran before the concurrent finalize completed).
    await db
      .update(photos)
      .set({
        processingState: 'ready',
        r2KeyOriginal: `events/${event.id}/original/${row.id}.jpg`,
        r2KeyPreview: `events/${event.id}/preview/${row.id}.jpg`,
      })
      .where(eq(photos.id, row.id))
    // Now expire the pendingExpiresAt and re-finalize as the same uploader. The
    // TTL check would otherwise fire markFailed; with the state predicate, the
    // UPDATE is a no-op and the route's idempotent path returns the ready row.
    await db
      .update(photos)
      .set({ pendingExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(photos.id, row.id))
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(host)
    const res = await post(event.id, row.id)
    // The TTL check WILL still try to fail it (returning 410), but markFailed's
    // predicate prevents the actual state change. So state stays 'ready'.
    // Note: the route returns 410 because the TTL fired, but the row is preserved.
    // Acceptable: client retries finalize and gets the idempotent 200.
    const [final] = await db.select().from(photos).where(eq(photos.id, row.id))
    expect(final.processingState).toBe('ready')
    expect([200, 410]).toContain(res.status)
  })
})
