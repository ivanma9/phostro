import { and, eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { db } from '@/db'
import { eventMembers, events } from '@/db/schema'
import { getCurrentUser } from '@/lib/auth/current-user'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })

  const [event] = await db.select().from(events).where(eq(events.id, id))
  if (!event) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const [membership] = await db
    .select()
    .from(eventMembers)
    .where(and(eq(eventMembers.eventId, id), eq(eventMembers.userId, user.id)))
  if (!membership) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  return NextResponse.json({ event, role: membership.role })
}
