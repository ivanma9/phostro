// Integration tests for share-link token helpers.
// Placed in tests/ (root) alongside other DB-backed tests (e.g. api/contributor-upload.test.ts)
// rather than tests/integration/ because vitest.config.ts globs tests/**/*.test.ts —
// there is no separate integration/ subdirectory convention in this repo.

import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db'
import { events, shareLinks, users } from '@/db/schema'
import { hashToken } from '@/lib/share-links/token'
import { ShareLinkError, incrementShareLinkUsage, mintShareLink, revokeShareLink, verifyShareLink } from '@/lib/share-links/storage'

// ---- fixtures ---------------------------------------------------------------

async function seedEvent() {
  const [user] = await db
    .insert(users)
    .values({ name: 'Host', contact: 'host@x.com', contactType: 'email' })
    .returning()
  const [event] = await db
    .insert(events)
    .values({
      hostUserId: user.id,
      name: 'Test Event',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    })
    .returning()
  return { user, event }
}

// ---- cleanup ----------------------------------------------------------------

beforeEach(async () => {
  await db.delete(shareLinks)
  await db.delete(events)
  await db.delete(users)
})

// ---- tests ------------------------------------------------------------------

describe('mintShareLink + verifyShareLink (happy path)', () => {
  it('returns eventId and linkId matching the inserted row', async () => {
    const { event } = await seedEvent()
    const { token, linkId } = await mintShareLink(event.id, {
      expiresAt: new Date(Date.now() + 60_000),
    })

    expect(typeof token).toBe('string')
    expect(token).toMatch(/^[a-f0-9]{64}$/)
    expect(typeof linkId).toBe('string')

    const result = await verifyShareLink(token)
    expect(result.eventId).toBe(event.id)
    expect(result.linkId).toBe(linkId)
  })
})

describe('token storage', () => {
  it('stores hash, not plaintext — and the hash equals sha256(token)', async () => {
    const { event } = await seedEvent()
    const { token, linkId } = await mintShareLink(event.id, {
      expiresAt: new Date(Date.now() + 60_000),
    })

    const [row] = await db.select().from(shareLinks).where(eq(shareLinks.id, linkId))
    // stored hash must not equal plaintext
    expect(row.tokenHash).not.toBe(token)
    // stored hash must equal sha256(token)
    expect(row.tokenHash).toBe(await hashToken(token))
  })
})

describe('verifyShareLink — failure modes', () => {
  it("throws code 'invalid' for a token that was never minted", async () => {
    // 64-char hex that does not correspond to any row
    const random = 'a'.repeat(64)
    await expect(verifyShareLink(random)).rejects.toSatisfy(
      (e: unknown) => e instanceof ShareLinkError && e.code === 'invalid',
    )
  })

  it("throws code 'revoked' after revokeShareLink", async () => {
    const { event } = await seedEvent()
    const { token, linkId } = await mintShareLink(event.id, {
      expiresAt: new Date(Date.now() + 60_000),
    })
    await revokeShareLink(linkId)
    await expect(verifyShareLink(token)).rejects.toSatisfy(
      (e: unknown) => e instanceof ShareLinkError && e.code === 'revoked',
    )
  })

  it("throws code 'expired' when expiresAt is in the past", async () => {
    const { event } = await seedEvent()
    const { token } = await mintShareLink(event.id, {
      expiresAt: new Date(Date.now() - 1_000), // 1 second ago
    })
    await expect(verifyShareLink(token)).rejects.toSatisfy(
      (e: unknown) => e instanceof ShareLinkError && e.code === 'expired',
    )
  })

  it("throws code 'exhausted' when uploadCount >= maxUploads", async () => {
    const { event } = await seedEvent()
    const { token, linkId } = await mintShareLink(event.id, {
      expiresAt: new Date(Date.now() + 60_000),
      maxUploads: 1,
    })
    // Manually bump uploadCount to simulate a finalized upload
    await db.update(shareLinks).set({ uploadCount: 1 }).where(eq(shareLinks.id, linkId))

    await expect(verifyShareLink(token)).rejects.toSatisfy(
      (e: unknown) => e instanceof ShareLinkError && e.code === 'exhausted',
    )
  })

  it('does not throw exhausted when maxUploads is null, even with high uploadCount', async () => {
    const { event } = await seedEvent()
    const { token, linkId } = await mintShareLink(event.id, {
      expiresAt: new Date(Date.now() + 60_000),
      maxUploads: null, // unlimited
    })
    await db.update(shareLinks).set({ uploadCount: 999 }).where(eq(shareLinks.id, linkId))

    const result = await verifyShareLink(token)
    expect(result.eventId).toBe(event.id)
    expect(result.maxUploads).toBeNull()
  })
})

describe('revokeShareLink', () => {
  it('is idempotent — revoking twice does not throw', async () => {
    const { event } = await seedEvent()
    const { linkId } = await mintShareLink(event.id, {
      expiresAt: new Date(Date.now() + 60_000),
    })
    await revokeShareLink(linkId)
    // second revoke must not throw
    await expect(revokeShareLink(linkId)).resolves.toBeUndefined()
  })
})

describe('incrementShareLinkUsage', () => {
  it('increments uploadCount by 1 inside a transaction', async () => {
    const { event } = await seedEvent()
    const { linkId } = await mintShareLink(event.id, {
      expiresAt: new Date(Date.now() + 60_000),
      maxUploads: 5,
    })

    await db.transaction(async (tx) => {
      await incrementShareLinkUsage(tx, linkId)
    })

    const [row] = await db.select().from(shareLinks).where(eq(shareLinks.id, linkId))
    expect(row.uploadCount).toBe(1)
  })

  it("throws 'exhausted' when uploadCount already equals maxUploads (boundary)", async () => {
    const { event } = await seedEvent()
    const { linkId } = await mintShareLink(event.id, {
      expiresAt: new Date(Date.now() + 60_000),
      maxUploads: 1,
    })
    // Manually set uploadCount to maxUploads
    await db.update(shareLinks).set({ uploadCount: 1 }).where(eq(shareLinks.id, linkId))

    await expect(
      db.transaction(async (tx) => { await incrementShareLinkUsage(tx, linkId) }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ShareLinkError && e.code === 'exhausted',
    )
  })

  it("throws 'revoked' after revokeShareLink", async () => {
    const { event } = await seedEvent()
    const { linkId } = await mintShareLink(event.id, {
      expiresAt: new Date(Date.now() + 60_000),
    })
    await revokeShareLink(linkId)

    await expect(
      db.transaction(async (tx) => { await incrementShareLinkUsage(tx, linkId) }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ShareLinkError && e.code === 'revoked',
    )
  })

  it("throws 'expired' when expiresAt is in the past", async () => {
    const { event } = await seedEvent()
    const { linkId } = await mintShareLink(event.id, {
      expiresAt: new Date(Date.now() - 1_000),
    })

    await expect(
      db.transaction(async (tx) => { await incrementShareLinkUsage(tx, linkId) }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ShareLinkError && e.code === 'expired',
    )
  })

  it("throws 'invalid' for a random UUID linkId that doesn't exist", async () => {
    const randomId = '00000000-0000-0000-0000-000000000000'

    await expect(
      db.transaction(async (tx) => { await incrementShareLinkUsage(tx, randomId) }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ShareLinkError && e.code === 'invalid',
    )
  })

  it('concurrency: exactly one of two parallel finalizes succeeds with maxUploads:1', async () => {
    const { event } = await seedEvent()
    const { linkId } = await mintShareLink(event.id, {
      expiresAt: new Date(Date.now() + 60_000),
      maxUploads: 1,
    })

    const results = await Promise.allSettled([
      db.transaction(async (tx) => { await incrementShareLinkUsage(tx, linkId) }),
      db.transaction(async (tx) => { await incrementShareLinkUsage(tx, linkId) }),
    ])

    const fulfilled = results.filter(r => r.status === 'fulfilled')
    const rejected = results.filter(r => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'exhausted' })

    const [row] = await db.select().from(shareLinks).where(eq(shareLinks.id, linkId))
    expect(row.uploadCount).toBe(1)
  })

  it('increments up to maxUploads; 4th call throws exhausted (maxUploads:3)', async () => {
    const { event } = await seedEvent()
    const { linkId } = await mintShareLink(event.id, {
      expiresAt: new Date(Date.now() + 60_000),
      maxUploads: 3,
    })

    // All three increments succeed
    for (let i = 0; i < 3; i++) {
      await db.transaction(async (tx) => { await incrementShareLinkUsage(tx, linkId) })
    }

    const [row] = await db.select().from(shareLinks).where(eq(shareLinks.id, linkId))
    expect(row.uploadCount).toBe(3)

    // 4th throws exhausted
    await expect(
      db.transaction(async (tx) => { await incrementShareLinkUsage(tx, linkId) }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ShareLinkError && e.code === 'exhausted',
    )
  })
})
