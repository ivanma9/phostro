import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm'
import { db } from '@/db'
import { photos } from '@/db/schema'

export async function countActivePhotos(eventId: string): Promise<number> {
  const [{ c }] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(photos)
    .where(
      and(
        eq(photos.eventId, eventId),
        isNull(photos.deletedAt),
        or(
          inArray(photos.processingState, ['ready', 'processing']),
          and(eq(photos.processingState, 'pending'), gt(photos.pendingExpiresAt, sql`now()`)),
        ),
      ),
    )
  return c
}
