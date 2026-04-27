import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { users } from '@/db/schema'
import { getSession } from './session'

export async function getCurrentUser() {
  const session = await getSession()
  if (!session.userId) return null
  const [u] = await db.select().from(users).where(eq(users.id, session.userId))
  return u ?? null
}
