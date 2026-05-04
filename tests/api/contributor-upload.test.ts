import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { POST as initPOST } from '@/app/api/p/[token]/init/route'
import { POST as finalizePOST } from '@/app/api/p/[token]/finalize/[photoId]/route'
import { db } from '@/db'
import { events, photoJobs, photos, shareLinks, users } from '@/db/schema'
import { mintShareLink, revokeShareLink } from '@/lib/share-links/storage'

const FIX = join(__dirname, '../fixtures/photos')

const store = new Map<string, Buffer>()

vi.mock('@/lib/photos/r2', () => ({
  createPresignedPutUrl: vi.fn(async (key: string) => `https://fake.r2/${key}?signature=x`),
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

async function seedEvent() {
  const [host] = await db
    .insert(users)
    .values({ name: 'Host', contact: 'h@contrib.test', contactType: 'email' })
    .returning()
  const [event] = await db
    .insert(events)
    .values({
      hostUserId: host.id,
      name: 'Grad',
      expiresAt: new Date(Date.now() + 7 * 86400 * 1000),
    })
    .returning()
  return { host, event }
}

beforeEach(async () => {
  store.clear()
  await db.delete(photoJobs)
  await db.delete(photos)
  await db.delete(shareLinks)
  await db.delete(events)
  await db.delete(users)
  vi.restoreAllMocks()
})

const callInit = (token: string, body: unknown) =>
  initPOST(
    new Request(`http://t/api/p/${token}/init`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ token }) },
  )

const callFinalize = (token: string, photoId: string) =>
  finalizePOST(new Request(`http://t/api/p/${token}/finalize/${photoId}`, { method: 'POST' }), {
    params: Promise.resolve({ token, photoId }),
  })

// Helper: init + store file in mock R2 + finalize
async function uploadOne(token: string, fileBuffer: Buffer) {
  const initRes = await callInit(token, {
    filename: 'photo.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: fileBuffer.length,
  })
  expect(initRes.status).toBe(200)
  const { photoId, putUrl } = await initRes.json()
  expect(photoId).toBeTypeOf('string')
  expect(putUrl).toBeTruthy()

  // Simulate the PUT by storing in our mock R2 store
  const { pendingKey } = await db
    .select({ pendingKey: photos.pendingKey })
    .from(photos)
    .where(eq(photos.id, photoId))
    .then(([r]) => r)
  store.set(pendingKey!, fileBuffer)

  const finalRes = await callFinalize(token, photoId)
  return { finalRes, photoId }
}

describe('Contributor upload flow', () => {
  test('3 photos via init → PUT → finalize: rows ready, upload_count=3, 3 photo_jobs', async () => {
    const { event } = await seedEvent()
    const { token } = await mintShareLink(event.id, {
      expiresAt: new Date(Date.now() + 86400 * 1000),
    })
    const jpg = readFileSync(join(FIX, 'plain.jpg'))

    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const { finalRes, photoId } = await uploadOne(token, jpg)
      expect(finalRes.status).toBe(200)
      ids.push(photoId)
    }

    // Check all 3 photos rows
    for (const id of ids) {
      const [row] = await db.select().from(photos).where(eq(photos.id, id))
      expect(row.processingState).toBe('ready')
      expect(row.uploaderToken).toBe(token)
      expect(row.uploaderUserId).toBeNull()
    }

    // upload_count === 3
    const [link] = await db.select().from(shareLinks).where(eq(shareLinks.eventId, event.id))
    expect(link.uploadCount).toBe(3)

    // 3 photo_jobs rows
    for (const id of ids) {
      const [job] = await db.select().from(photoJobs).where(eq(photoJobs.photoId, id))
      expect(job).toBeDefined()
      expect(job.kind).toBe('detect')
      expect(job.state).toBe('queued')
    }
  })

  test('double-finalize is idempotent: upload_count stays at 1', async () => {
    const { event } = await seedEvent()
    const { token } = await mintShareLink(event.id, {
      expiresAt: new Date(Date.now() + 86400 * 1000),
    })
    const jpg = readFileSync(join(FIX, 'plain.jpg'))

    const { finalRes, photoId } = await uploadOne(token, jpg)
    expect(finalRes.status).toBe(200)

    // Second finalize on the same photo — hits the ready branch
    const second = await callFinalize(token, photoId)
    expect(second.status).toBe(200)

    const [link] = await db.select().from(shareLinks).where(eq(shareLinks.eventId, event.id))
    expect(link.uploadCount).toBe(1) // NOT 2
  })

  test('init returns 404 for invalid (never-minted) token', async () => {
    // This also covers the "tampered token" case from the plan. The implementation
    // stores token_hash and does a hash lookup — there is no HMAC to verify. A
    // tampered token that is still well-formed (64 hex chars) produces a SHA-256
    // hash that matches no row, which is mechanically identical to a never-minted
    // token. Both paths collapse to ShareLinkError('invalid') → 404.
    const res = await callInit('aaaaaabbbbbbccccccddddddeeeeeeffffffff00000011111122222233333344', {
      filename: 'x.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 1000,
    })
    expect(res.status).toBe(404)
  })

  test('init returns 410 when link is revoked', async () => {
    const { event } = await seedEvent()
    const { token, linkId } = await mintShareLink(event.id, {
      expiresAt: new Date(Date.now() + 86400 * 1000),
    })
    await revokeShareLink(linkId)
    const res = await callInit(token, { filename: 'x.jpg', mimeType: 'image/jpeg', sizeBytes: 1000 })
    expect(res.status).toBe(410)
  })

  test('init returns 410 when link is expired', async () => {
    const { event } = await seedEvent()
    const { token } = await mintShareLink(event.id, {
      expiresAt: new Date(Date.now() - 1000), // already expired
    })
    const res = await callInit(token, { filename: 'x.jpg', mimeType: 'image/jpeg', sizeBytes: 1000 })
    expect(res.status).toBe(410)
  })

  test('init returns 429 when link is over max_uploads', async () => {
    const { event } = await seedEvent()
    const jpg = readFileSync(join(FIX, 'plain.jpg'))
    const { token } = await mintShareLink(event.id, {
      expiresAt: new Date(Date.now() + 86400 * 1000),
      maxUploads: 1,
    })

    // Use up the 1 allowed upload
    const { finalRes } = await uploadOne(token, jpg)
    expect(finalRes.status).toBe(200)

    // Second init: upload_count is now 1 = max_uploads → 429
    const res = await callInit(token, { filename: 'x.jpg', mimeType: 'image/jpeg', sizeBytes: 1000 })
    expect(res.status).toBe(429)
  })

  test('finalize returns 429 when atomic increment trips exhausted', async () => {
    const { event } = await seedEvent()
    const jpg = readFileSync(join(FIX, 'plain.jpg'))
    const { token } = await mintShareLink(event.id, {
      expiresAt: new Date(Date.now() + 86400 * 1000),
      maxUploads: 1,
    })

    // Init two photos (verifyShareLink passes both times since we haven't finalized yet)
    const initRes1 = await callInit(token, { filename: '1.jpg', mimeType: 'image/jpeg', sizeBytes: jpg.length })
    expect(initRes1.status).toBe(200)
    const { photoId: id1 } = await initRes1.json()
    const [r1] = await db.select({ pendingKey: photos.pendingKey }).from(photos).where(eq(photos.id, id1))
    store.set(r1.pendingKey!, jpg)

    const initRes2 = await callInit(token, { filename: '2.jpg', mimeType: 'image/jpeg', sizeBytes: jpg.length })
    expect(initRes2.status).toBe(200)
    const { photoId: id2 } = await initRes2.json()
    const [r2] = await db.select({ pendingKey: photos.pendingKey }).from(photos).where(eq(photos.id, id2))
    store.set(r2.pendingKey!, jpg)

    // Finalize first → succeeds, upload_count becomes 1
    const fin1 = await callFinalize(token, id1)
    expect(fin1.status).toBe(200)

    // Finalize second → atomic increment sees upload_count >= max_uploads → 429
    const fin2 = await callFinalize(token, id2)
    expect(fin2.status).toBe(429)

    // upload_count is still 1, NOT 2
    const [link] = await db.select().from(shareLinks).where(eq(shareLinks.eventId, event.id))
    expect(link.uploadCount).toBe(1)
  })

  test('concurrent contributor finalize: only one wins when max_uploads = 1', async () => {
    const { event } = await seedEvent()
    const jpg = readFileSync(join(FIX, 'plain.jpg'))
    const { token, linkId } = await mintShareLink(event.id, {
      expiresAt: new Date(Date.now() + 60_000),
      maxUploads: 1,
    })

    // Init two photos (verifyShareLink passes both times since upload_count is still 0)
    const initRes1 = await callInit(token, { filename: '1.jpg', mimeType: 'image/jpeg', sizeBytes: jpg.length })
    expect(initRes1.status).toBe(200)
    const { photoId: id1 } = await initRes1.json()
    const [r1] = await db.select({ pendingKey: photos.pendingKey }).from(photos).where(eq(photos.id, id1))
    store.set(r1.pendingKey!, jpg)

    const initRes2 = await callInit(token, { filename: '2.jpg', mimeType: 'image/jpeg', sizeBytes: jpg.length })
    expect(initRes2.status).toBe(200)
    const { photoId: id2 } = await initRes2.json()
    const [r2] = await db.select({ pendingKey: photos.pendingKey }).from(photos).where(eq(photos.id, id2))
    store.set(r2.pendingKey!, jpg)

    // Fire both finalizes concurrently
    const results = await Promise.allSettled([
      callFinalize(token, id1),
      callFinalize(token, id2),
    ])

    // Exactly one 200, exactly one 429
    const statuses = results.map(r =>
      r.status === 'fulfilled' ? r.value.status : 'rejected'
    )
    const ok = statuses.filter(s => s === 200)
    const exhausted = statuses.filter(s => s === 429)
    expect(ok).toHaveLength(1)
    expect(exhausted).toHaveLength(1)

    // upload_count is exactly 1, not 2
    const [link] = await db.select().from(shareLinks).where(eq(shareLinks.id, linkId))
    expect(link.uploadCount).toBe(1)
  })

  // ── Task 10: finalize token-failure paths ──────────────────────────────────

  test('finalize returns 404 for invalid (never-minted) token', async () => {
    // A random 64-hex token that was never inserted produces no matching row.
    // This path is equivalent to a "tampered" token (see rationale in the init
    // test above): hash-lookup finds nothing → ShareLinkError('invalid') → 404.
    const fakeToken = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
    const fakePhotoId = '00000000-0000-0000-0000-000000000000'
    const res = await callFinalize(fakeToken, fakePhotoId)
    expect(res.status).toBe(404)
  })

  test('finalize returns 410 when link is revoked', async () => {
    const { event } = await seedEvent()
    const jpg = readFileSync(join(FIX, 'plain.jpg'))
    const { token, linkId } = await mintShareLink(event.id, {
      expiresAt: new Date(Date.now() + 86400 * 1000),
    })

    // Init a photo so a photoId exists, but do NOT finalize yet
    const initRes = await callInit(token, { filename: 'x.jpg', mimeType: 'image/jpeg', sizeBytes: jpg.length })
    expect(initRes.status).toBe(200)
    const { photoId } = await initRes.json()

    await revokeShareLink(linkId)

    const res = await callFinalize(token, photoId)
    expect(res.status).toBe(410)
  })

  test('finalize returns 410 when link is expired', async () => {
    const { event } = await seedEvent()
    const jpg = readFileSync(join(FIX, 'plain.jpg'))
    const { token } = await mintShareLink(event.id, {
      expiresAt: new Date(Date.now() + 86400 * 1000),
    })

    // Init a photo while the link is still valid
    const initRes = await callInit(token, { filename: 'x.jpg', mimeType: 'image/jpeg', sizeBytes: jpg.length })
    expect(initRes.status).toBe(200)
    const { photoId } = await initRes.json()

    // Backdate expires_at so the link is now expired
    await db
      .update(shareLinks)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(shareLinks.eventId, event.id))

    const res = await callFinalize(token, photoId)
    expect(res.status).toBe(410)
  })

  test('finalize returns 404 for tampered (well-formed but never-minted) token', async () => {
    // Mint a valid link and init a real photo, but call finalize with a
    // DIFFERENT 64-hex token that was never inserted into share_links.
    // Because the implementation uses SHA-256(token) hash lookup (not HMAC
    // verification), any token whose hash matches no row — including a tampered
    // one — is indistinguishable from a never-minted token. Both collapse to
    // ShareLinkError('invalid') → 404.
    const { event } = await seedEvent()
    const jpg = readFileSync(join(FIX, 'plain.jpg'))
    const { token } = await mintShareLink(event.id, {
      expiresAt: new Date(Date.now() + 86400 * 1000),
    })

    const initRes = await callInit(token, { filename: 'x.jpg', mimeType: 'image/jpeg', sizeBytes: jpg.length })
    expect(initRes.status).toBe(200)
    const { photoId } = await initRes.json()

    // A different well-formed 64-hex token — simulates an attacker flipping a byte
    const tamperedToken = 'cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe'
    const res = await callFinalize(tamperedToken, photoId)
    expect(res.status).toBe(404)
  })

  test('contributor photos row never has both uploaderToken and uploaderUserId set', async () => {
    const { event } = await seedEvent()
    const jpg = readFileSync(join(FIX, 'plain.jpg'))
    const { token } = await mintShareLink(event.id, {
      expiresAt: new Date(Date.now() + 86400 * 1000),
    })

    const { finalRes, photoId } = await uploadOne(token, jpg)
    expect(finalRes.status).toBe(200)

    const [row] = await db.select().from(photos).where(eq(photos.id, photoId))
    expect(row.uploaderToken).toBe(token)
    expect(row.uploaderUserId).toBeNull()
    // XOR satisfied: both cannot be set
    expect(row.uploaderToken !== null && row.uploaderUserId !== null).toBe(false)
  })
})
