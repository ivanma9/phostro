import { NextResponse } from 'next/server'
import { db } from '@/db'
import { eventMembers, events } from '@/db/schema'
import { getCurrentUser } from '@/lib/auth/current-user'

const VISIBILITY_MODES = new Set(['personal', 'open_pool', 'host_only'])

export async function POST(req: Request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })

  const body = (await req.json()) as {
    name?: unknown
    lifespanDays?: unknown
    visibilityMode?: unknown
  }

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name || name.length > 100) {
    return NextResponse.json({ error: 'invalid name' }, { status: 400 })
  }

  const lifespanDays =
    typeof body.lifespanDays === 'number' && Number.isInteger(body.lifespanDays)
      ? body.lifespanDays
      : 7
  if (lifespanDays < 1 || lifespanDays > 30) {
    return NextResponse.json({ error: 'invalid lifespan' }, { status: 400 })
  }

  const visibilityMode = typeof body.visibilityMode === 'string' ? body.visibilityMode : 'personal'
  if (!VISIBILITY_MODES.has(visibilityMode)) {
    return NextResponse.json({ error: 'invalid visibility mode' }, { status: 400 })
  }

  const expiresAt = new Date(Date.now() + lifespanDays * 24 * 60 * 60 * 1000)

  const [event] = await db
    .insert(events)
    .values({
      hostUserId: user.id,
      name,
      visibilityMode: visibilityMode as 'personal' | 'open_pool' | 'host_only',
      lifespanDays,
      expiresAt,
    })
    .returning()

  await db.insert(eventMembers).values({
    eventId: event.id,
    userId: user.id,
    role: 'host',
  })

  return NextResponse.json({ event })
}
