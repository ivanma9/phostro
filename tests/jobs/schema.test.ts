import { beforeEach, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { eventMembers, events, photos, photoJobs, users } from '@/db/schema'

async function seedFixtures() {
  const [u] = await db
    .insert(users)
    .values({ name: 'U', contact: 'u_jobs@x.com', contactType: 'email' })
    .returning()
  const [e] = await db
    .insert(events)
    .values({
      hostUserId: u.id,
      name: 'E',
      expiresAt: new Date(Date.now() + 86400 * 1000),
    })
    .returning()
  await db.insert(eventMembers).values({ eventId: e.id, userId: u.id, role: 'host' })
  const [p] = await db
    .insert(photos)
    .values({
      eventId: e.id,
      uploaderUserId: u.id,
      declaredMimeType: 'image/jpeg',
      declaredSizeBytes: 1000,
    })
    .returning()
  return { u, e, p }
}

beforeEach(async () => {
  await db.delete(photoJobs)
  await db.delete(photos)
  await db.delete(eventMembers)
  await db.delete(events)
  await db.delete(users)
})

test('photo_jobs_state_check rejects an invalid state value', async () => {
  const { p } = await seedFixtures()
  // Use raw SQL to bypass the TS enum and actually test the DB CHECK constraint.
  await expect(
    db.execute(
      sql`INSERT INTO photo_jobs (photo_id, kind, state) VALUES (${p.id}, 'detect', 'cancelled')`
    )
  ).rejects.toThrow()
})
