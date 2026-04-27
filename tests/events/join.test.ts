import { and, eq } from 'drizzle-orm'
import { beforeEach, expect, test } from 'vitest'
import { db } from '@/db'
import { eventMembers, events, users } from '@/db/schema'
import { joinEvent } from '@/lib/events/join'

beforeEach(async () => {
  await db.delete(eventMembers)
  await db.delete(events)
  await db.delete(users)
})

async function seed() {
  const [host] = await db
    .insert(users)
    .values({ name: 'Host', contact: 'h@x.com', contactType: 'email' })
    .returning()
  const [attendee] = await db
    .insert(users)
    .values({ name: 'Attendee', contact: 'a@x.com', contactType: 'email' })
    .returning()
  const [event] = await db
    .insert(events)
    .values({
      hostUserId: host.id,
      name: 'Bash',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    })
    .returning()
  return { host, attendee, event }
}

test('returns not_found for unknown event id', async () => {
  await seed()
  const result = await joinEvent(
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-0000-0000-000000000000',
  )
  expect(result).toBe('not_found')
})

test('joined inserts an attendee membership', async () => {
  const { attendee, event } = await seed()
  expect(await joinEvent(event.id, attendee.id)).toBe('joined')
  const [m] = await db
    .select()
    .from(eventMembers)
    .where(and(eq(eventMembers.eventId, event.id), eq(eventMembers.userId, attendee.id)))
  expect(m.role).toBe('attendee')
})

test('already_member when joining twice', async () => {
  const { attendee, event } = await seed()
  await joinEvent(event.id, attendee.id)
  expect(await joinEvent(event.id, attendee.id)).toBe('already_member')
})
