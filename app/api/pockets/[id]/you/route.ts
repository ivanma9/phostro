import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { db } from '@/db'
import { events } from '@/db/schema'
import { getCurrentUser } from '@/lib/auth/current-user'
import { getFaceEmbeddings, getFaceEnrollment } from '@/lib/auth/face-enrollment'
import { createPresignedGetUrl } from '@/lib/photos/r2'
import { listYouFeed } from '@/lib/photos/you-feed'

export const runtime = 'nodejs'

const PREVIEW_URL_TTL_SECONDS = 5 * 60

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })

  const [event] = await db.select().from(events).where(eq(events.id, id))
  if (!event) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  if (event.hostUserId !== user.id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const enrollment = await getFaceEnrollment(user.id)
  if (!enrollment.enrolled) {
    return NextResponse.json(
      { error: 'not_enrolled', remainingAngles: enrollment.remainingAngles },
      { status: 412 },
    )
  }

  const ownerEmbeddings = (await getFaceEmbeddings(user.id)).map((e) => e.embedding)
  const feedItems = await listYouFeed(event.id, ownerEmbeddings)

  const photos = await Promise.all(
    feedItems.map(async (item) => ({
      photoId: item.photoId,
      previewUrl: await createPresignedGetUrl(item.r2KeyPreview, PREVIEW_URL_TTL_SECONDS),
      distance: item.distance,
      takenAt: item.takenAt,
    })),
  )

  return NextResponse.json({ photos })
}
