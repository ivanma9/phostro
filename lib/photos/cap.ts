import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm'
import { db } from '@/db'
import { photos } from '@/db/schema'

type TxParam = Parameters<Parameters<typeof db.transaction>[0]>[0]
type DbOrTx = typeof db | TxParam

export async function countActivePhotos(eventId: string, dbOrTx: DbOrTx = db): Promise<number> {
  const [{ c }] = await dbOrTx
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
