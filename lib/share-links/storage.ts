import { eq, sql } from 'drizzle-orm'
import { db } from '@/db'
import { shareLinks } from '@/db/schema'
import { generateToken, hashToken } from './token'

export class ShareLinkError extends Error {
  code: 'invalid' | 'revoked' | 'expired' | 'exhausted'
  constructor(code: 'invalid' | 'revoked' | 'expired' | 'exhausted', message: string) {
    super(message)
    this.name = 'ShareLinkError'
    this.code = code
  }
}

type TxParam = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** Generates a token, inserts a share_links row, and returns the plaintext token exactly once. */
export async function mintShareLink(
  eventId: string,
  opts: { expiresAt: Date; maxUploads?: number | null },
): Promise<{ token: string; linkId: string }> {
  const token = generateToken()
  const tokenHash = await hashToken(token)

  const [row] = await db
    .insert(shareLinks)
    .values({
      eventId,
      tokenHash,
      expiresAt: opts.expiresAt,
      maxUploads: opts.maxUploads ?? null,
    })
    .returning({ id: shareLinks.id })

  return { token, linkId: row.id }
}

/**
 * Looks up the share link by token hash and validates it is not revoked, expired, or exhausted.
 * Throws `ShareLinkError` with the appropriate code on failure.
 *
 * Non-atomic read — use this at init time for early failure before the R2 upload.
 * The source of truth at finalize time is `incrementShareLinkUsage`.
 */
export async function verifyShareLink(
  token: string,
): Promise<{ eventId: string; linkId: string; uploadCount: number; maxUploads: number | null }> {
  const tokenHash = await hashToken(token)

  const [row] = await db
    .select()
    .from(shareLinks)
    .where(eq(shareLinks.tokenHash, tokenHash))

  if (!row) {
    throw new ShareLinkError('invalid', 'Share link not found')
  }

  if (row.revokedAt !== null) {
    throw new ShareLinkError('revoked', 'Share link has been revoked')
  }

  if (row.expiresAt <= new Date()) {
    throw new ShareLinkError('expired', 'Share link has expired')
  }

  if (row.maxUploads !== null && row.uploadCount >= row.maxUploads) {
    throw new ShareLinkError('exhausted', 'Share link upload limit reached')
  }

  return {
    eventId: row.eventId,
    linkId: row.id,
    uploadCount: row.uploadCount,
    maxUploads: row.maxUploads,
  }
}

/**
 * Atomically increments uploadCount on the share link. Re-validates revoked / expired /
 * exhausted as part of the same UPDATE so concurrent finalizes cannot overshoot maxUploads.
 *
 * MUST be called inside the same transaction as the photo's processing_state -> 'ready'
 * transition (Task 3 finalize). Throws ShareLinkError with the appropriate code if any
 * check fails — caller's transaction will then roll back.
 */
export async function incrementShareLinkUsage(
  tx: TxParam,
  linkId: string,
): Promise<void> {
  const result = await tx.execute(sql`
    UPDATE share_links
    SET upload_count = upload_count + 1
    WHERE id = ${linkId}
      AND revoked_at IS NULL
      AND expires_at > now()
      AND (max_uploads IS NULL OR upload_count < max_uploads)
    RETURNING id
  `)
  if (result.length > 0) return

  // The UPDATE matched zero rows. Determine which precondition failed for a useful error.
  const [row] = await tx.select().from(shareLinks).where(eq(shareLinks.id, linkId))
  if (!row) throw new ShareLinkError('invalid', 'Share link not found')
  if (row.revokedAt !== null) throw new ShareLinkError('revoked', 'Share link revoked')
  if (row.expiresAt <= new Date()) throw new ShareLinkError('expired', 'Share link expired')
  // Only remaining cause: exhausted.
  throw new ShareLinkError('exhausted', 'Share link upload limit reached')
}

/**
 * Sets revokedAt on the given link. Idempotent — revoking an already-revoked or
 * non-existent link is a silent no-op (returns undefined, does not throw).
 * Callers that need to distinguish "found and revoked" from "not found" should
 * query the row separately before calling this function.
 */
export async function revokeShareLink(linkId: string): Promise<void> {
  await db
    .update(shareLinks)
    .set({ revokedAt: new Date() })
    .where(eq(shareLinks.id, linkId))
}
