import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { eventMembers, events } from '@/db/schema'

export type JoinResult = 'joined' | 'already_member' | 'not_found'

export async function joinEvent(eventId: string, userId: string): Promise<JoinResult> {
  const [event] = await db.select({ id: events.id }).from(events).where(eq(events.id, eventId))
  if (!event) return 'not_found'

  const [existing] = await db
    .select()
    .from(eventMembers)
    .where(and(eq(eventMembers.eventId, eventId), eq(eventMembers.userId, userId)))
  if (existing) return 'already_member'

  await db.insert(eventMembers).values({ eventId, userId, role: 'attendee' })
  return 'joined'
}
