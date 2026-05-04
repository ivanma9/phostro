import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { db } from '@/db'
import { photos } from '@/db/schema'

export const runtime = 'nodejs'

/**
 * Debug-only endpoint: returns all photos uploaded via a specific share-link token.
 *
 * Gated by NODE_ENV !== 'production'. Used by pocket-contributor.spec.ts to verify
 * that anonymous uploads produced the expected DB rows (uploaderToken set, uploaderUserId null).
 *
 * GET /api/internal/photos-by-token/[token]
 * Response: { photos: Array<{ id, uploaderToken, uploaderUserId, processingState }> }
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const { token } = await params

  const rows = await db
    .select({
      id: photos.id,
      uploaderToken: photos.uploaderToken,
      uploaderUserId: photos.uploaderUserId,
      processingState: photos.processingState,
    })
    .from(photos)
    .where(eq(photos.uploaderToken, token))

  return NextResponse.json({ photos: rows })
}
