import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { db } from '@/db'
import { photos } from '@/db/schema'
import { getCurrentUser } from '@/lib/auth/current-user'
import { createPresignedGetUrl } from '@/lib/photos/r2'

export const runtime = 'nodejs'

const ORIGINAL_URL_TTL_SECONDS = 5 * 60

export async function GET(_req: Request, { params }: { params: Promise<{ photoId: string }> }) {
  const { photoId } = await params

  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })

  const [row] = await db.select().from(photos).where(eq(photos.id, photoId))
  // 404 conflates "missing" / "not uploader" / "not ready" — no existence oracle.
  if (
    !row ||
    row.uploaderUserId !== user.id ||
    row.processingState !== 'ready' ||
    row.deletedAt !== null ||
    !row.r2KeyOriginal
  ) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const url = await createPresignedGetUrl(row.r2KeyOriginal, ORIGINAL_URL_TTL_SECONDS)
  return NextResponse.redirect(url, 302)
}
