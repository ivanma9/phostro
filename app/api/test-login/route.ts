import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { db } from '@/db'
import { userFaceEmbeddings, users } from '@/db/schema'
import { FACE_SCAN_ANGLES } from '@/lib/auth/face-enrollment'
import { getSession } from '@/lib/auth/session'

export async function POST(req: Request) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const body = (await req.json()) as {
    contact?: unknown
    name?: unknown
    enrollFakeFace?: unknown
  }

  const contact = typeof body.contact === 'string' ? body.contact.toLowerCase() : null
  if (!contact?.includes('@')) {
    return NextResponse.json({ error: 'invalid contact' }, { status: 400 })
  }

  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : contact
  const enrollFakeFace = body.enrollFakeFace === true

  let [user] = await db.select().from(users).where(eq(users.contact, contact))
  if (!user) {
    ;[user] = await db
      .insert(users)
      .values({ name, contact, contactType: 'email' })
      .returning()
  }

  if (enrollFakeFace) {
    // Three deterministic 512-d vectors, one per angle. Synthetic vectors here
    // are nearly parallel after L2-norm — a real follow-up enrollment against
    // these baselines WILL trip the detectTooSimilar gate. Treat enrollFakeFace
    // as a mutually exclusive shortcut: in tests + dev, either use it for
    // throughout-the-test enrolled state OR run the real /api/me/face/finalize
    // flow, never both for the same user without first deleting the synthetic
    // rows.
    const existing = await db
      .select({ angle: userFaceEmbeddings.angle })
      .from(userFaceEmbeddings)
      .where(eq(userFaceEmbeddings.userId, user.id))
    if (existing.length < FACE_SCAN_ANGLES.length) {
      for (let idx = 0; idx < FACE_SCAN_ANGLES.length; idx++) {
        const angle = FACE_SCAN_ANGLES[idx]
        const vec = Array.from({ length: 512 }, (_, i) => (i + idx + 1) / 1024)
        // L2-normalize so distance metrics behave like real embeddings.
        let sumSq = 0
        for (const v of vec) sumSq += v * v
        const norm = Math.sqrt(sumSq) || 1
        const embedding = vec.map((v) => v / norm)
        await db
          .insert(userFaceEmbeddings)
          .values({
            userId: user.id,
            angle,
            embedding,
            qualityScore: 90,
            yaw: angle === 'left' ? -0.25 : angle === 'right' ? 0.25 : 0,
            previewR2Key: `enrollment/${user.id}/test-${angle}.jpg`,
          })
          .onConflictDoNothing()
      }
    }
  }

  const session = await getSession()
  session.userId = user.id
  await session.save()

  return NextResponse.json({ user: { id: user.id, name: user.name, contact: user.contact } })
}
