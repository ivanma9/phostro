import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { db } from '@/db'
import { events } from '@/db/schema'
import { getCurrentUser } from '@/lib/auth/current-user'
import { mintShareLink } from '@/lib/share-links/storage'

export const runtime = 'nodejs'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })

  const [event] = await db.select().from(events).where(eq(events.id, id))
  if (!event) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  if (event.hostUserId !== user.id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  // Each click mints a NEW share link; existing links are not revoked.
  // Founders can accumulate multiple active links by re-sharing — acceptable in v0.
  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
  const { token } = await mintShareLink(event.id, { expiresAt, maxUploads: null })
  const shareUrl = `${process.env.APP_URL}/p/${token}`

  return NextResponse.json({ shareUrl })
}
