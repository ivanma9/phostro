import { NextResponse } from 'next/server'
import { db } from '@/db'
import { eventMembers, events } from '@/db/schema'
import { getCurrentUser } from '@/lib/auth/current-user'
import { mintShareLink } from '@/lib/share-links/storage'

export const runtime = 'nodejs'

export async function POST(req: Request) {
  // 1. Auth
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })

  // 2. Validate name
  const body = (await req.json()) as { name?: unknown }
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name || name.length > 100) {
    return NextResponse.json({ error: 'invalid name' }, { status: 400 })
  }

  try {
    // 3a. Insert events row with visibility_mode='personal' and 30-day lifespan.
    //     Pockets don't auto-expire in v0; 30 days is the required non-null placeholder.
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    const [event] = await db
      .insert(events)
      .values({
        hostUserId: user.id,
        name,
        visibilityMode: 'personal',
        lifespanDays: 30,
        expiresAt,
      })
      .returning()

    // 3b. Insert event_members row with role='host'
    await db.insert(eventMembers).values({
      eventId: event.id,
      userId: user.id,
      role: 'host',
    })

    // 3c. Mint share link. Orphan event + member rows are acceptable per plan; the user
    //     retries and a new attempt creates a fresh share link on a new event row.
    //     Share link expiry is decoupled from the pocket's events.expires_at placeholder;
    //     v0 pockets are manual-delete-only.
    let token: string
    try {
      const shareLinkExpiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
      const result = await mintShareLink(event.id, {
        expiresAt: shareLinkExpiresAt,
        maxUploads: null, // unlimited in v0
      })
      token = result.token
    } catch {
      return NextResponse.json({ error: 'share_link_failed' }, { status: 500 })
    }

    // 4. Compute shareUrl
    const shareUrl = `${process.env.APP_URL}/p/${token}`

    // 5. Return
    return NextResponse.json({ pocketId: event.id, shareUrl })
  } catch {
    return NextResponse.json({ error: 'create_failed' }, { status: 500 })
  }
}
